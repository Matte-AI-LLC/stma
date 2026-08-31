import {
  ACTIVE_AGENT_RUN_STATUSES,
  areAttemptSiblings,
  detectClaimConflicts,
  findDuplicates,
  issueFromTaskKey,
  quotaStateFor,
  type AgentClientType,
  type AgentQuota,
  type AgentRole,
  type AgentRunStatus,
  type ConflictClaim,
  type DuplicateFinding,
  type QuotaSource,
  type QuotaState,
  type WorkClaim,
} from '@bridge/shared';
import { and, desc, eq, gt, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { rowsAffected, type Db } from '../db';
import {
  agentEvents,
  agentInstallations,
  agentRuns,
  memberships,
  projects,
  teams,
  users,
  workClaims,
} from '../db/schema';
import { findOrCreateProject, projectSplitWarning } from '../lib/projects';
import { redactSecrets } from '../lib/redact';
import { publishChange } from '../lib/stream';
import { track } from '../lib/track';
import { teamForUser } from './access';

const ACTIVE = [...ACTIVE_AGENT_RUN_STATUSES];

export interface RegisterAgentInput {
  name: string;
  clientType: AgentClientType;
  clientVersion?: string;
  deviceFingerprint: string;
  capabilities: string[];
  role?: AgentRole;
}

export async function registerAgent(db: Db, userId: string, input: RegisterAgentInput) {
  const existing = await db
    .select()
    .from(agentInstallations)
    .where(
      and(
        eq(agentInstallations.userId, userId),
        eq(agentInstallations.deviceFingerprint, input.deviceFingerprint),
        eq(agentInstallations.name, input.name),
      ),
    )
    .limit(1);
  if (existing[0]) {
    const rows = await db
      .update(agentInstallations)
      .set({
        clientType: input.clientType,
        clientVersion: input.clientVersion ?? null,
        capabilities: input.capabilities,
        // A re-registration that says nothing about the role keeps the one it has:
        // the MCP path registers on every call and would otherwise erase a role
        // set once from the CLI.
        ...(input.role ? { role: input.role } : {}),
        lastSeenAt: new Date(),
        revokedAt: null,
      })
      .where(eq(agentInstallations.id, existing[0].id))
      .returning();
    return rows[0]!;
  }
  const rows = await db
    .insert(agentInstallations)
    .values({
      userId,
      name: input.name,
      clientType: input.clientType,
      clientVersion: input.clientVersion ?? null,
      role: input.role ?? null,
      deviceFingerprint: input.deviceFingerprint,
      capabilities: input.capabilities,
    })
    .returning();
  return rows[0]!;
}

export async function installationForOwner(db: Db, installationId: string, userId: string) {
  const rows = await db
    .select()
    .from(agentInstallations)
    .where(
      and(
        eq(agentInstallations.id, installationId),
        eq(agentInstallations.userId, userId),
        isNull(agentInstallations.revokedAt),
      ),
    )
    .limit(1);
  return rows[0];
}

export async function runForOwner(db: Db, runId: string, userId: string) {
  const rows = await db
    .select({ run: agentRuns, installation: agentInstallations, owner: users })
    .from(agentRuns)
    .innerJoin(agentInstallations, eq(agentRuns.installationId, agentInstallations.id))
    .innerJoin(users, eq(agentInstallations.userId, users.id))
    .where(and(eq(agentRuns.id, runId), eq(agentInstallations.userId, userId)))
    .limit(1);
  return rows[0];
}

export async function addAgentEvent(
  db: Db,
  runId: string,
  type: string,
  detail?: Record<string, unknown>,
) {
  await db.insert(agentEvents).values({ runId, type, detail: detail ?? null });
}

export interface StartRunInput {
  installationId: string;
  team: string;
  project?: string;
  taskKey?: string;
  intent?: string;
  repo?: string;
  branch?: string;
  worktree?: string;
  baseSha?: string;
  claims: WorkClaim[];
  attemptGroup?: string;
}

export async function startAgentRun(
  db: Db,
  userId: string,
  input: StartRunInput,
  claimLeaseMinutes: number,
) {
  const installation = await installationForOwner(db, input.installationId, userId);
  if (!installation) return { error: 'Unknown or revoked agent installation.' } as const;
  const access = await teamForUser(db, userId, input.team);
  if (!access) return { error: `You are not a member of team "${input.team}".` } as const;

  let projectId: string | null = null;
  // Whether this run just forked the team's conflict radar by inventing a new
  // project name for a repository somebody else already registered.
  let projectSplit: string | undefined;
  if (input.project) {
    const result = await findOrCreateProject(db, access.team, input.project, userId);
    if ('error' in result) return { error: result.error } as const;
    projectId = result.project.id;
    projectSplit = await projectSplitWarning(db, access.team, result.created, result.project.id);
  }

  const rows = await db
    .insert(agentRuns)
    .values({
      installationId: installation.id,
      teamId: access.team.id,
      projectId,
      taskKey: input.taskKey ?? null,
      intent: input.intent ? redactSecrets(input.intent) : null,
      repo: input.repo ?? input.project ?? null,
      branch: input.branch ?? null,
      worktree: input.worktree ?? null,
      baseSha: input.baseSha ?? null,
      attemptGroup: input.attemptGroup ?? null,
      status: 'starting',
    })
    .returning();
  const run = rows[0]!;
  await addAgentEvent(db, run.id, 'run_started', {
    taskKey: run.taskKey,
    repo: run.repo,
    branch: run.branch,
    attemptGroup: run.attemptGroup,
  });
  const conflicts = await replaceRunClaims(db, run.id, userId, input.claims, claimLeaseMinutes);
  await db
    .update(agentRuns)
    .set({ status: 'active', lastHeartbeatAt: new Date() })
    .where(eq(agentRuns.id, run.id));
  return { run: { ...run, status: 'active' as const }, conflicts, projectSplit } as const;
}

export async function replaceRunClaims(
  db: Db,
  runId: string,
  userId: string,
  claims: WorkClaim[],
  claimLeaseMinutes: number,
) {
  const found = await runForOwner(db, runId, userId);
  if (!found) return [];
  const uniqueClaims = [
    ...new Map(
      claims.map((claim) => [
        `${claim.resourceType}\0${claim.resourceKey}\0${claim.access}`,
        claim,
      ]),
    ).values(),
  ];
  const leaseExpiresAt = new Date(Date.now() + claimLeaseMinutes * 60_000);
  // One transaction: between the delete and the insert this run holds nothing,
  // and a peer scanning in that window would be told the coast is clear.
  await db.transaction(async (tx) => {
    await tx.delete(workClaims).where(eq(workClaims.runId, runId));
    if (uniqueClaims.length > 0) {
      await tx.insert(workClaims).values(
        uniqueClaims.map((claim) => ({
          runId,
          resourceType: claim.resourceType,
          resourceKey: claim.resourceKey,
          access: claim.access,
          leaseExpiresAt,
        })),
      );
    }
  });

  // Scope moved, so the agent map is now wrong on every screen showing it.
  publishChange(found.run.teamId, 'claims');
  return conflictsForRun(db, found, runId, uniqueClaims);
}

type RunOwner = NonNullable<Awaited<ReturnType<typeof runForOwner>>>;

/** Overlap between this run's scope and every other live claim in the same project. */
async function conflictsForRun(db: Db, found: RunOwner, runId: string, claims: WorkClaim[]) {
  const existingRows = await db
    .select({
      claim: workClaims,
      run: agentRuns,
      installation: agentInstallations,
      owner: users,
    })
    .from(workClaims)
    .innerJoin(agentRuns, eq(workClaims.runId, agentRuns.id))
    .innerJoin(agentInstallations, eq(agentRuns.installationId, agentInstallations.id))
    .innerJoin(users, eq(agentInstallations.userId, users.id))
    .where(
      and(
        ne(agentRuns.id, runId),
        eq(agentRuns.teamId, found.run.teamId),
        inArray(agentRuns.status, ACTIVE),
        gt(workClaims.leaseExpiresAt, new Date()),
        found.run.projectId
          ? eq(agentRuns.projectId, found.run.projectId)
          : isNull(agentRuns.projectId),
      ),
    );

  const current: ConflictClaim[] = claims.map((claim) => ({
    ...claim,
    runId,
    owner: found.owner.username,
    agentName: found.installation.name,
    taskKey: found.run.taskKey,
  }));
  // A parallel attempt at the same task is not a collision — see areAttemptSiblings.
  const mine = {
    ownerId: found.owner.id,
    attemptGroup: found.run.attemptGroup,
    taskKey: found.run.taskKey,
    worktree: found.run.worktree,
  };
  const existing: ConflictClaim[] = existingRows
    .filter(
      (row) =>
        !areAttemptSiblings(mine, {
          ownerId: row.owner.id,
          attemptGroup: row.run.attemptGroup,
          taskKey: row.run.taskKey,
          worktree: row.run.worktree,
        }),
    )
    .map((row) => ({
      runId: row.run.id,
      owner: row.owner.username,
      agentName: row.installation.name,
      taskKey: row.run.taskKey,
      resourceType: row.claim.resourceType as WorkClaim['resourceType'],
      resourceKey: row.claim.resourceKey,
      access: row.claim.access as WorkClaim['access'],
    }));
  const conflicts = detectClaimConflicts(current, existing);
  if (conflicts.length > 0) {
    // Only when the collision is new or has changed. This function runs on every
    // heartbeat that restates scope, and one unchanged overlap held for half an
    // hour was writing a row a minute: the run timeline filled with the same
    // sentence, the evidence pack reported "overlapped another live run 33
    // time(s)" about a single collision, and the savings ledger offered thirty
    // copies of one moment to confirm. Same rule the quota escalation already
    // follows — a state worth recording is a state that changed.
    const others = [...new Set(conflicts.map((c) => c.existing.runId))].sort();
    const severity = conflicts[0]?.severity;
    const previous = await db
      .select({ detail: agentEvents.detail })
      .from(agentEvents)
      .where(and(eq(agentEvents.runId, runId), eq(agentEvents.type, 'conflicts_detected')))
      .orderBy(desc(agentEvents.createdAt))
      .limit(1);
    const before = previous[0]?.detail as
      | { highestSeverity?: string; otherRunIds?: string[] }
      | undefined;
    const unchanged =
      before !== undefined &&
      before.highestSeverity === severity &&
      JSON.stringify([...(before.otherRunIds ?? [])].sort()) === JSON.stringify(others);
    if (!unchanged) {
      await addAgentEvent(db, runId, 'conflicts_detected', {
        count: conflicts.length,
        highestSeverity: severity,
        otherRunIds: others,
      });
    }
  }
  return conflicts;
}

/**
 * Extend the leases this run already holds. Called by a heartbeat that does not
 * restate its scope: the run is alive, so the claims it declared are alive.
 */
export async function renewRunClaims(db: Db, found: RunOwner, claimLeaseMinutes: number) {
  const runId = found.run.id;
  const leaseExpiresAt = new Date(Date.now() + claimLeaseMinutes * 60_000);
  await db.update(workClaims).set({ leaseExpiresAt }).where(eq(workClaims.runId, runId));
  const own = await db.select().from(workClaims).where(eq(workClaims.runId, runId));
  const claims: WorkClaim[] = own.map((row) => ({
    resourceType: row.resourceType as WorkClaim['resourceType'],
    resourceKey: row.resourceKey,
    access: row.access as WorkClaim['access'],
  }));
  if (claims.length === 0) return [];
  return conflictsForRun(db, found, runId, claims);
}

export interface RunQuotaResult {
  state: QuotaState;
  usedPct: number;
  /** Whether the client read this figure or guessed it. Only "measured" escalates. */
  source: QuotaSource;
  resetsAt: string | null;
  label: string | null;
  /** True the first time this run crosses into warning, and again into critical. */
  escalated: boolean;
  advice?: string;
  /** The handoff_work arguments this run should use if it stops here. */
  handoff?: Record<string, unknown>;
}

/**
 * Record the vendor allowance a run reports about itself.
 *
 * The product's headline promise is that no vendor limit stops the work, but
 * until now the only way to keep that promise was for a human to notice the
 * limit coming and ask for a handoff. The client is the only thing that knows
 * how much of its window is gone, so it reports it here and gets told — while
 * it still has room to act — to hand the work over rather than stop inside it.
 */
export async function recordRunQuota(
  db: Db,
  found: RunOwner,
  quota: AgentQuota,
): Promise<RunQuotaResult> {
  const usedPct = Math.round(quota.usedPct);
  const state = quotaStateFor(usedPct);
  const source = quota.source;
  const measured = source === 'measured';
  const previous = (found.run.quotaState as QuotaState | null) ?? 'ok';
  const rank: Record<QuotaState, number> = { ok: 0, warning: 1, critical: 2 };
  // An estimate is recorded and shown, never escalated: the trail, the feed and
  // the red band on the map are the team's record of fact, and a guess is not
  // one. The agent still gets advice — softer, and named as its own estimate.
  const escalated = measured && rank[state] > rank[previous];
  const resetsAt = quota.resetsAt ? new Date(quota.resetsAt) : null;

  await db
    .update(agentRuns)
    .set({
      quotaPct: usedPct,
      // quotaState is the state STMA is ACTING on, so only a measured figure
      // advances it. Letting a guess set it meant the guess quietly spent the
      // escalation: the same percentage, read for real a minute later, then
      // looked like "no change" and never reached the team.
      ...(measured ? { quotaState: state } : {}),
      quotaResetsAt: resetsAt,
      quotaLabel: quota.label ?? null,
      quotaSource: source,
    })
    .where(eq(agentRuns.id, found.run.id));

  // Only escalations reach the trail. A run that heartbeats every minute at 91%
  // would otherwise write the same line sixty times an hour and bury everything
  // else in the timeline.
  if (escalated) {
    await addAgentEvent(db, found.run.id, 'quota_warning', {
      state,
      usedPct,
      label: quota.label ?? null,
      resetsAt: resetsAt?.toISOString() ?? null,
    });
    publishChange(found.run.teamId, 'quota');
  }

  const branch = found.run.branch;
  const handoff =
    state === 'ok'
      ? undefined
      : {
          branch: branch ?? '<push your branch first, then name it here>',
          summary: '<what is done, what state the code is in, what you learned>',
          next_steps: ['<what the next agent should do first>'],
          reason: 'usage_limit',
          run_id: found.run.id,
        };
  const named = quota.label ? ` (${quota.label})` : '';
  const measuredAdvice =
    state === 'critical'
      ? `You have used ${usedPct}% of your allowance${named}. Push your branch and call handoff_work now — a handoff written while you can still think is worth more than one your human reconstructs after you stop.`
      : state === 'warning'
        ? `You have used ${usedPct}% of your allowance${named}. Finish the step you are on, then decide: either land it, or hand it over with handoff_work while there is room to write a proper brief.`
        : undefined;
  // An estimate gets told, plainly, that it is an estimate — so the agent can
  // go and read the real figure instead of acting on its own guess.
  const estimateAdvice =
    state === 'ok'
      ? undefined
      : `You reported ${usedPct}%${named} as an estimate, so STMA has recorded it but has not told the team you are running out. If you can read the real figure, send it again with source "measured" and STMA will act on it. If you cannot, treat ${usedPct}% as your own judgement: hand off with handoff_work when you decide the room is gone, not because this number crossed a line.`;

  return {
    state,
    usedPct,
    source,
    resetsAt: resetsAt?.toISOString() ?? null,
    label: quota.label ?? null,
    escalated,
    advice: measured ? measuredAdvice : estimateAdvice,
    handoff,
  };
}

/**
 * What the forge said became of a run's branch — the webhook side of "the
 * change merged". Matching is by branch within the team (the join key runs
 * already carry); a repository name narrows it when the team has several
 * projects. Finished runs still match: the merge usually lands after
 * finish_run, and the whole point is attributing the outcome to the run.
 *
 * Events are written on *change only* — the same rule collisions and quota
 * follow — so a re-delivered webhook or a CI matrix re-reporting one verdict
 * cannot bury the trail.
 */
export async function recordRunOutcome(
  db: Db,
  teamId: string,
  input: {
    branch: string;
    repoName?: string;
    pr?: { number: number; url: string; state: 'open' | 'merged' | 'closed'; title?: string };
    ci?: { conclusion: 'success' | 'failure'; workflow?: string };
  },
): Promise<{ linked: boolean; runId?: string; event?: string }> {
  const branch = input.branch.trim();
  if (!branch) return { linked: false };
  const candidates = await db
    .select({ run: agentRuns, projectName: projects.name })
    .from(agentRuns)
    .leftJoin(projects, eq(agentRuns.projectId, projects.id))
    .where(and(eq(agentRuns.teamId, teamId), eq(agentRuns.branch, branch)))
    .orderBy(
      // A live run over a finished one, then the most recently touched.
      sql`case when ${agentRuns.status} in ('starting','active','waiting','blocked') then 0 else 1 end`,
      desc(agentRuns.lastHeartbeatAt),
    )
    .limit(5);
  if (candidates.length === 0) return { linked: false };
  const wanted = input.repoName?.toLowerCase();
  const found =
    (wanted
      ? candidates.find(
          (c) =>
            c.projectName?.toLowerCase() === wanted || c.run.repo?.toLowerCase().includes(wanted),
        )
      : undefined) ?? candidates[0]!;
  const run = found.run;

  if (input.pr) {
    const { number, url, state, title } = input.pr;
    if (run.prState === state && run.prNumber === number) {
      return { linked: true, runId: run.id };
    }
    await db
      .update(agentRuns)
      .set({ prNumber: number, prUrl: url, prState: state })
      .where(eq(agentRuns.id, run.id));
    const event = state === 'merged' ? 'pr_merged' : state === 'closed' ? 'pr_closed' : 'pr_opened';
    await addAgentEvent(db, run.id, event, {
      number,
      url,
      title: title?.slice(0, 140) ?? null,
    });
    if (state === 'merged') {
      // "The change merged" is the line the whole trail exists to earn — the
      // one control-plane outcome a lead acts on, so it reaches the feed.
      void track(db, {
        teamId,
        projectId: run.projectId,
        action: 'run_merged',
        detail: [run.taskKey ?? run.intent?.slice(0, 60), `PR #${number}`, input.repoName]
          .filter(Boolean)
          .join(' · '),
      });
    }
    publishChange(teamId, 'run');
    return { linked: true, runId: run.id, event };
  }

  if (input.ci) {
    const state = input.ci.conclusion === 'success' ? 'passing' : 'failing';
    if (run.ciState === state) return { linked: true, runId: run.id };
    await db.update(agentRuns).set({ ciState: state }).where(eq(agentRuns.id, run.id));
    await addAgentEvent(db, run.id, 'ci_completed', {
      conclusion: input.ci.conclusion,
      workflow: input.ci.workflow?.slice(0, 120) ?? null,
    });
    publishChange(teamId, 'run');
    return { linked: true, runId: run.id, event: 'ci_completed' };
  }

  return { linked: true, runId: run.id };
}

/**
 * What this run says it has spent so far. Bookkeeping, not an escalation —
 * there is no threshold to cross and no advice to give, so unlike quota it
 * writes no event; the number simply becomes part of the run's record, with
 * its source, and only measured figures are ever summed anywhere.
 */
export async function recordRunCost(
  db: Db,
  found: RunOwner,
  cost: { usd: number; source: 'measured' | 'estimate' },
): Promise<void> {
  const cents = Math.round(cost.usd * 100);
  if (!Number.isFinite(cents) || cents < 0) return;
  await db
    .update(agentRuns)
    .set({ costCents: cents, costSource: cost.source })
    .where(eq(agentRuns.id, found.run.id));
}

export async function heartbeatAgentRun(
  db: Db,
  runId: string,
  userId: string,
  status: Extract<AgentRunStatus, 'active' | 'waiting' | 'blocked'> | undefined,
  claims: WorkClaim[] | undefined,
  claimLeaseMinutes: number,
  usage?: AgentQuota,
) {
  const found = await runForOwner(db, runId, userId);
  if (!found || !ACTIVE.includes(found.run.status as (typeof ACTIVE)[number])) return undefined;
  const nextStatus = status ?? (found.run.status as AgentRunStatus);
  await db
    .update(agentRuns)
    .set({ status: nextStatus, lastHeartbeatAt: new Date() })
    .where(eq(agentRuns.id, runId));
  await db
    .update(agentInstallations)
    .set({ lastSeenAt: new Date() })
    .where(eq(agentInstallations.id, found.installation.id));
  // A heartbeat means the run is alive, so its scope is alive too. Renewing only
  // when the caller resends `claims` let a well-behaved agent keep the run active
  // while its leases quietly expired — the collision vanished from the agent map
  // while both agents were still writing the same migration.
  // An empty array is not a release. The native hook sends the worktree's dirty
  // files, so the moment an agent commits its work the list is empty — treating
  // that as "I hold nothing" dropped the run off the conflict radar while it was
  // still holding those files. Scope is released by finishing the run.
  const conflicts =
    claims && claims.length > 0
      ? await replaceRunClaims(db, runId, userId, claims, claimLeaseMinutes)
      : await renewRunClaims(db, found, claimLeaseMinutes);
  const quota = usage ? await recordRunQuota(db, found, usage) : undefined;
  return {
    runId,
    status: nextStatus,
    conflicts,
    quota,
    // Attribution for the activity feed, same shape finishAgentRun returns.
    scope: {
      teamId: found.run.teamId,
      projectId: found.run.projectId,
      taskKey: found.run.taskKey,
    },
  };
}

export async function finishAgentRun(
  db: Db,
  runId: string,
  userId: string,
  status: Extract<AgentRunStatus, 'completed' | 'failed'>,
  detail?: string,
) {
  const found = await runForOwner(db, runId, userId);
  if (!found) return undefined;
  const now = new Date();
  await db
    .update(agentRuns)
    .set({ status, endedAt: now, lastHeartbeatAt: now })
    .where(eq(agentRuns.id, runId));
  await db.update(workClaims).set({ leaseExpiresAt: now }).where(eq(workClaims.runId, runId));
  await addAgentEvent(db, runId, 'run_finished', {
    status,
    detail: detail ? redactSecrets(detail) : undefined,
  });
  return {
    runId,
    status,
    endedAt: now.toISOString(),
    // Attribution for the activity feed; the route strips it from the agent's payload.
    scope: { teamId: found.run.teamId, projectId: found.run.projectId, taskKey: found.run.taskKey },
  };
}

export async function markStaleAgentRuns(db: Db, staleMinutes: number): Promise<number> {
  const now = new Date();
  const rows = await db
    .update(agentRuns)
    .set({ status: 'stale', endedAt: now })
    .where(
      and(
        inArray(agentRuns.status, ACTIVE),
        lt(agentRuns.lastHeartbeatAt, new Date(now.getTime() - staleMinutes * 60_000)),
      ),
    )
    .returning({ id: agentRuns.id });
  return rows.length;
}

export async function activeRunsForMember(db: Db, userId: string, teamSlug?: string) {
  const conditions = [eq(memberships.userId, userId), inArray(agentRuns.status, ACTIVE)];
  if (teamSlug) conditions.push(eq(teams.slug, teamSlug));
  return db
    .select({
      run: agentRuns,
      installation: agentInstallations,
      owner: users,
      team: teams,
      projectName: projects.name,
    })
    .from(agentRuns)
    .innerJoin(agentInstallations, eq(agentRuns.installationId, agentInstallations.id))
    .innerJoin(users, eq(agentInstallations.userId, users.id))
    .innerJoin(teams, eq(agentRuns.teamId, teams.id))
    .innerJoin(memberships, eq(memberships.teamId, teams.id))
    .leftJoin(projects, eq(agentRuns.projectId, projects.id))
    .where(and(...conditions))
    .orderBy(desc(agentRuns.lastHeartbeatAt));
}

/**
 * The append-only run trail for one team, newest first. Bounded by `limit` and by
 * the team filter — the timeline on the governance page is a window, not a scan.
 */
export async function recentAgentEvents(db: Db, teamId: string, limit = 50, projectId?: string) {
  return db
    .select({
      event: agentEvents,
      run: agentRuns,
      agentName: agentInstallations.name,
      owner: users.username,
      projectName: projects.name,
    })
    .from(agentEvents)
    .innerJoin(agentRuns, eq(agentEvents.runId, agentRuns.id))
    .innerJoin(agentInstallations, eq(agentRuns.installationId, agentInstallations.id))
    .innerJoin(users, eq(agentInstallations.userId, users.id))
    .leftJoin(projects, eq(agentRuns.projectId, projects.id))
    .where(
      and(
        eq(agentRuns.teamId, teamId),
        projectId ? eq(agentRuns.projectId, projectId) : undefined,
      ),
    )
    .orderBy(desc(agentEvents.createdAt))
    .limit(limit);
}

/**
 * Hard ceiling on trail rows kept per run. The age purge is the retention rule;
 * this bounds the other failure mode — one run stuck in a loop emitting events
 * between sweeps. Per run, so a chatty run truncates only its own trail.
 */
export const AGENT_EVENT_CAP_PER_RUN = 500;

/** Keep only the newest `cap` events per run. Returns how many were deleted. */
export async function trimAgentEvents(db: Db, cap = AGENT_EVENT_CAP_PER_RUN): Promise<number> {
  const res = await db.execute(sql`
    delete from ${agentEvents} where ${agentEvents.id} in (
      select id from (
        select ${agentEvents.id} as id, row_number() over (
          partition by ${agentEvents.runId} order by ${desc(agentEvents.createdAt)}
        ) as rn from ${agentEvents}
      ) ranked where ranked.rn > ${cap}
    )
  `);
  return rowsAffected(res);
}

export async function claimsForRuns(db: Db, runIds: string[]) {
  if (runIds.length === 0) return [];
  return db
    .select()
    .from(workClaims)
    .where(and(inArray(workClaims.runId, runIds), gt(workClaims.leaseExpiresAt, new Date())));
}

/** The append-only trail of ONE run, newest first — what the inspector shows. */
export async function eventsForRun(db: Db, runId: string, limit = 12) {
  return db
    .select({ type: agentEvents.type, detail: agentEvents.detail, at: agentEvents.createdAt })
    .from(agentEvents)
    .where(eq(agentEvents.runId, runId))
    .orderBy(desc(agentEvents.createdAt))
    .limit(limit);
}

export interface StaleGround {
  /** The claim this run still holds, whose ground moved under it. */
  resourceType: string;
  resourceKey: string;
  /** Who moved it, and when. */
  by: string;
  agentName: string;
  taskKey: string | null;
  at: Date;
}

/** How far back to look for finished runs — a week-old merge is not news. */
const STALE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Ground that moved under a run after it started.
 *
 * The failure this catches is the one teams actually report: an agent reads the
 * code, plans against it, and twenty minutes later somebody else finishes a
 * change to the same file. Git will merge both cleanly — the text does not
 * collide — but the assumption the plan rested on is no longer true, and
 * nothing in the toolchain says so.
 *
 * Conflict detection cannot see this, because it compares runs that are *both*
 * live. By the time the other one finishes it leaves the radar, taking the
 * warning with it. So this asks the opposite question: since I started, who
 * finished on ground I am still holding?
 *
 * Computed, never stored. Staleness is a relationship between two runs and a
 * clock; a column would only be a cached answer waiting to go wrong.
 */
export async function staleGroundFor(
  db: Db,
  run: { id: string; teamId: string; projectId: string | null; startedAt: Date },
  claims: readonly WorkClaim[],
): Promise<StaleGround[]> {
  if (claims.length === 0) return [];
  const since = new Date(Math.max(run.startedAt.getTime(), Date.now() - STALE_WINDOW_MS));
  const rows = await db
    .select({
      claim: workClaims,
      endedAt: agentRuns.endedAt,
      taskKey: agentRuns.taskKey,
      owner: users.username,
      agentName: agentInstallations.name,
    })
    .from(workClaims)
    .innerJoin(agentRuns, eq(workClaims.runId, agentRuns.id))
    .innerJoin(agentInstallations, eq(agentRuns.installationId, agentInstallations.id))
    .innerJoin(users, eq(agentInstallations.userId, users.id))
    .where(
      and(
        ne(agentRuns.id, run.id),
        eq(agentRuns.teamId, run.teamId),
        run.projectId ? eq(agentRuns.projectId, run.projectId) : isNull(agentRuns.projectId),
        // Finished, and finished *after* this run began reading the world.
        inArray(agentRuns.status, ['completed', 'failed']),
        gt(agentRuns.endedAt, since),
      ),
    )
    .limit(200);

  const mine: ConflictClaim[] = claims.map((claim) => ({
    ...claim,
    runId: run.id,
    owner: '',
    agentName: '',
  }));
  const theirs: ConflictClaim[] = rows.map((row) => ({
    runId: row.claim.runId,
    owner: row.owner,
    agentName: row.agentName,
    taskKey: row.taskKey,
    resourceType: row.claim.resourceType as WorkClaim['resourceType'],
    resourceKey: row.claim.resourceKey,
    // A finished run's read is not a change; only writes move the ground.
    access: row.claim.access as WorkClaim['access'],
  }));
  const endedBy = new Map(rows.map((row) => [row.claim.runId, row.endedAt]));

  // Reuse the overlap rule rather than writing a second one — "same ground" has
  // to mean the same thing here as it does on the conflict radar.
  const seen = new Set<string>();
  const out: StaleGround[] = [];
  for (const overlap of detectClaimConflicts(mine, theirs.filter((c) => c.access === 'write'))) {
    const key = `${overlap.current.resourceType}|${overlap.current.resourceKey.toLowerCase()}|${overlap.existing.runId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      resourceType: overlap.current.resourceType,
      resourceKey: overlap.current.resourceKey,
      by: overlap.existing.owner,
      agentName: overlap.existing.agentName,
      taskKey: overlap.existing.taskKey ?? null,
      at: endedBy.get(overlap.existing.runId) ?? new Date(),
    });
  }
  return out;
}

/** How many live runs one duplicate check will look at. */
const DUPLICATE_SCAN = 50;

/**
 * Live runs that look like the same job as this one.
 *
 * Cheap on purpose: the same issue and the same task key are facts, and word
 * overlap catches two people describing one piece of work differently. No
 * embeddings — being wrong here costs one sentence in a reply, while staying
 * silent costs two agents building the same thing twice.
 *
 * Attempt siblings are excluded: deliberately racing two attempts at one task
 * is a pattern this product supports, not a mistake to warn about.
 */
export async function duplicateWork(
  db: Db,
  userId: string,
  run: { id: string; teamId: string; projectId: string | null; taskKey: string | null; attemptGroup: string | null; worktree: string | null },
  mine: { taskKey: string | null; intent: string | null },
): Promise<DuplicateFinding[]> {
  const rows = await db
    .select({
      run: agentRuns,
      owner: users,
      agentName: agentInstallations.name,
    })
    .from(agentRuns)
    .innerJoin(agentInstallations, eq(agentRuns.installationId, agentInstallations.id))
    .innerJoin(users, eq(agentInstallations.userId, users.id))
    .where(
      and(
        ne(agentRuns.id, run.id),
        eq(agentRuns.teamId, run.teamId),
        run.projectId ? eq(agentRuns.projectId, run.projectId) : isNull(agentRuns.projectId),
        inArray(agentRuns.status, ACTIVE),
      ),
    )
    .orderBy(desc(agentRuns.lastHeartbeatAt))
    .limit(DUPLICATE_SCAN);

  const candidates = rows
    .filter(
      (row) =>
        !areAttemptSiblings(
          {
            ownerId: userId,
            taskKey: run.taskKey,
            attemptGroup: run.attemptGroup,
            worktree: run.worktree,
          },
          {
            ownerId: row.owner.id,
            taskKey: row.run.taskKey,
            attemptGroup: row.run.attemptGroup,
            worktree: row.run.worktree,
          },
        ),
    )
    .map((row) => ({
      runId: row.run.id,
      owner: row.owner.username,
      agentName: row.agentName,
      taskKey: row.run.taskKey,
      issue: issueFromTaskKey(row.run.taskKey),
      intent: row.run.intent,
    }));

  return findDuplicates(
    { taskKey: mine.taskKey, issue: issueFromTaskKey(mine.taskKey), intent: mine.intent },
    candidates,
  );
}
