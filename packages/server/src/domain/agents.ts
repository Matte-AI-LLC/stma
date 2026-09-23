import { parseContentRules } from '@bridge/shared';
import { membershipUser } from '../lib/securityHooks';
import {
  ACTIVE_AGENT_RUN_STATUSES,
  areAttemptSiblings,
  describeHolder,
  detectClaimConflicts,
  findDuplicates,
  holderNeedsAPerson,
  isReadOverlap,
  issueFromTaskKey,
  quotaStateFor,
  pathClaimsOverlap,
  approvalsNeeded,
  budgetVerdict,
  type AgentClientType,
  type AgentQuota,
  type AgentRole,
  type AgentRunStatus,
  type ClaimConflict,
  type ClaimSource,
  type ConflictClaim,
  type DuplicateFinding,
  type QuotaSource,
  type QuotaState,
  type RunCheckpointInput,
  type WorkClaim,
} from '@bridge/shared';
import { and, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { rowsAffected, type Db } from '../db';
import {
  agentEvents,
  agentInstallations,
  agentRuns,
  memberships,
  projects,
  teams,
  tokens,
  users,
  workClaims,
} from '../db/schema';
import {
  projectSplitWarning,
  resolveProjectForWriteInTransaction,
  canonicalRepositoryIdentity,
} from '../lib/projects';
import { redactSecrets } from '../lib/redact';
import { publishChange } from '../lib/stream';
import { track } from '../lib/track';
import { teamForUser } from './access';
import { effectiveLimits } from '../lib/entitlements';
import { fingerprintJson } from '../lib/canonical';
import { writeRunCheckpoint } from './checkpoints';
import { effectivePolicy } from './policies';

const ACTIVE = [...ACTIVE_AGENT_RUN_STATUSES];

/** Shared across processes/replicas, unlike a JS mutex. Acquire before run locks.
 * Serializes claim publication and evaluation even for credential-bound projects
 * (whose resolver intentionally does not lock/create a workspace project).
 */
async function lockClaimWorkspace(db: Db, teamId: string) {
  await db.execute(sql`select pg_advisory_xact_lock(727273, hashtext(${teamId}))`);
}

async function lockRunClaimWorkspace(db: Db, runId: string, userId: string) {
  const found = await runForOwner(db, runId, userId);
  if (found) await lockClaimWorkspace(db, found.run.teamId);
}

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
    // Revocation is a human control, not a transient registration flag. An
    // agent that can silently clear it by repeating register has not really
    // been revoked. Return the row so callers can explain the state, but do not
    // touch or reactivate it.
    if (existing[0].revokedAt) return existing[0];
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

/** Disable one of the caller's run identities and end the ground it holds. */
export async function revokeAgentInstallation(db: Db, userId: string, installationId: string) {
  return db.transaction(async (tx) => {
    const found = await tx
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
    const installation = found[0];
    if (!installation) return { error: 'That agent installation is not active or not yours.' } as const;
    const affected = await tx
      .select({
        id: agentRuns.id,
        teamId: agentRuns.teamId,
        projectId: agentRuns.projectId,
        taskKey: agentRuns.taskKey,
      })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.installationId, installation.id),
          inArray(agentRuns.status, ACTIVE),
        ),
      );
    const now = new Date();
    await tx
      .update(agentInstallations)
      .set({ revokedAt: now })
      .where(eq(agentInstallations.id, installation.id));
    if (installation.tokenId) {
      // Enrollment credentials and installations are one identity. Disabling
      // either side must not leave a half-live credential that can still post
      // messages while the map claims the agent is gone. Legacy installations
      // have no tokenId and retain the historical independent controls.
      await tx
        .update(tokens)
        .set({ revokedAt: now })
        .where(and(eq(tokens.id, installation.tokenId), eq(tokens.userId, userId)));
    }
    if (affected.length > 0) {
      const runIds = affected.map((run) => run.id);
      await tx
        .update(agentRuns)
        .set({ status: 'stale', endedAt: now, lastHeartbeatAt: now })
        .where(inArray(agentRuns.id, runIds));
      await tx
        .update(workClaims)
        .set({ leaseExpiresAt: now })
        .where(and(inArray(workClaims.runId, runIds), stillHeld));
      await tx.insert(agentEvents).values(
        runIds.map((runId) => ({
          runId,
          type: 'installation_revoked',
          detail: { installation: installation.name },
        })),
      );
    }
    return { installation, affected } as const;
  });
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
    .select({ run: agentRuns, installation: agentInstallations, owner: users, project: projects })
    .from(agentRuns)
    .innerJoin(agentInstallations, eq(agentRuns.installationId, agentInstallations.id))
    .innerJoin(users, eq(agentInstallations.userId, users.id))
    .leftJoin(projects, eq(agentRuns.projectId, projects.id))
    .where(and(eq(agentRuns.id, runId), eq(agentInstallations.userId, userId)))
    .limit(1);
  return rows[0];
}

/** Transaction-only lookup that serializes every lifecycle transition. */
async function runForOwnerLocked(db: Db, runId: string, userId: string) {
  const rows = await db
    .select({ run: agentRuns, installation: agentInstallations, owner: users, project: projects })
    .from(agentRuns)
    .innerJoin(agentInstallations, eq(agentRuns.installationId, agentInstallations.id))
    .innerJoin(users, eq(agentInstallations.userId, users.id))
    .leftJoin(projects, eq(agentRuns.projectId, projects.id))
    .where(and(eq(agentRuns.id, runId), eq(agentInstallations.userId, userId)))
    .for('update', { of: agentRuns });
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
  /** Stable logical operation id used only to recover the same start call. */
  requestId?: string;
  installationId: string;
  team: string;
  project?: string;
  taskKey?: string;
  intent?: string;
  repo?: string;
  repositoryIdentity?: string;
  branch?: string;
  worktree?: string;
  baseSha?: string;
  headSha?: string;
  checkpoint?: RunCheckpointInput & { kind: 'start' };
  claims: WorkClaim[];
  attemptGroup?: string;
}

class StartRunRefused extends Error {}

function startRunRequestHash(input: StartRunInput): string {
  return fingerprintJson({
    team: input.team,
    project: input.project ?? null,
    taskKey: input.taskKey ?? null,
    intent: input.intent ? redactSecrets(input.intent) : null,
    repo: input.repo ?? input.project ?? null,
    repositoryIdentity: input.repositoryIdentity ?? null,
    branch: input.branch ?? null,
    worktree: input.worktree ?? null,
    baseSha: input.baseSha ?? null,
    headSha: input.headSha?.toLowerCase() ?? null,
    checkpoint: input.checkpoint ?? null,
    claims: input.claims,
    attemptGroup: input.attemptGroup ?? null,
  });
}

export async function startAgentRun(
  db: Db,
  userId: string,
  input: StartRunInput,
  claimLeaseMinutes: number,
  fixedProjectId?: string | null,
) {
  // Fail before lazy project creation. The transaction below rechecks and
  // locks the installation; this first read only prevents an invalid identity
  // from leaving a project row behind.
  const existingInstallation = await installationForOwner(
    db,
    input.installationId,
    userId,
  );
  if (!existingInstallation) return { error: 'Unknown or revoked agent installation.' } as const;
  const access = await teamForUser(db, userId, input.team);
  if (!access) return { error: `You are not a member of team "${input.team}".` } as const;
  if ((await effectiveLimits(db, access.team)).fleet !== 'full') return { error: 'Starting new runs requires an active fleet entitlement. Existing work can still be finished or handed off.' } as const;

  const requestHash = input.requestId ? startRunRequestHash(input) : null;
  try {
    return await db.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      await lockClaimWorkspace(tx, access.team.id);
      // One installation is the idempotency namespace. Locking it makes two
      // concurrent retries observe the same committed run instead of racing a
      // unique index and leaking a half-created second run.
      const [installation] = await tx
        .select()
        .from(agentInstallations)
        .where(
          and(
            eq(agentInstallations.id, input.installationId),
            eq(agentInstallations.userId, userId),
            isNull(agentInstallations.revokedAt),
          ),
        )
        .for('update');
      if (!installation) throw new StartRunRefused('Unknown or revoked agent installation.');

      if (input.requestId) {
        const [previous] = await tx
          .select()
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.installationId, installation.id),
              eq(agentRuns.startRequestId, input.requestId),
            ),
          )
          .limit(1);
        if (previous) {
          if (previous.startRequestHash !== requestHash) {
            throw new StartRunRefused(
              // "request id" in words: MCP calls the argument request_id and REST calls it
              // requestId, and the camelCase spelling in an MCP reply sent an agent that
              // copied it to an argument the tool refuses before dispatch.
              'This request id was already used with different arguments. Retry unchanged, or use a new request id for new work.',
            );
          }
          const found = await runForOwner(tx, previous.id, userId);
          if (!found) throw new StartRunRefused('The original run is no longer available.');
          const rows = await tx.select().from(workClaims).where(and(eq(workClaims.runId, previous.id), stillHeld));
          const claims: WorkClaim[] = rows.map((row) => ({
            resourceType: row.resourceType as WorkClaim['resourceType'],
            resourceKey: row.resourceKey,
            access: row.access as WorkClaim['access'],
          }));
          const conflicts = ACTIVE.includes(previous.status as (typeof ACTIVE)[number])
            ? await conflictsForRun(tx, found, previous.id, claims)
            : [];
          const checkpoint = input.checkpoint
            ? await writeRunCheckpoint(
                tx,
                previous,
                found.project?.repositoryIdentity,
                input.checkpoint,
              )
            : undefined;
          if (checkpoint && 'error' in checkpoint) throw new StartRunRefused(checkpoint.error);
          return {
            run: previous,
            conflicts,
            checkpoint,
            projectSplit: undefined,
            replayed: true,
          } as const;
        }
      }

      let projectId: string | null = null;
      // Project creation is part of the logical start. A mismatched retry is
      // rejected above before it can leave a stray project behind.
      let projectSplit: string | undefined;
      if (input.project) {
        const projectResult = await resolveProjectForWriteInTransaction(
          tx,
          access.team,
          input.project,
          userId,
          {
            repositoryIdentity: input.repositoryIdentity ?? input.checkpoint?.repositoryIdentity,
            fixedProjectId,
          },
        );
        if ('error' in projectResult) throw new StartRunRefused(projectResult.error);
        projectId = projectResult.project.id;
        projectSplit = await projectSplitWarning(
          tx,
          access.team,
          projectResult.created,
          projectResult.project.id,
        );
      }

      const [run] = await tx
        .insert(agentRuns)
        .values({
          installationId: installation.id,
          teamId: access.team.id,
          projectId,
          taskKey: input.taskKey ?? null,
          intent: input.intent ? redactSecrets(input.intent) : null,
          repo:
            input.repositoryIdentity ??
            input.checkpoint?.repositoryIdentity ??
            input.repo ??
            input.project ??
            null,
          branch: input.branch ?? null,
          worktree: input.worktree ?? null,
          baseSha: input.baseSha ?? null,
          headSha: input.headSha?.toLowerCase() ?? null,
          startRequestId: input.requestId ?? null,
          startRequestHash: requestHash,
          attemptGroup: input.attemptGroup ?? null,
          status: 'starting',
        })
        .returning();
      if (!run) throw new Error('Run insert did not return a row.');
      await addAgentEvent(tx, run.id, 'run_started', {
        taskKey: run.taskKey,
        repo: run.repo,
        branch: run.branch,
        attemptGroup: run.attemptGroup,
        requestId: input.requestId ?? null,
      });
      const found = await runForOwner(tx, run.id, userId);
      if (!found) throw new Error('Run owner disappeared during start.');
      const checkpoint = input.checkpoint
        ? await writeRunCheckpoint(
            tx,
            run,
            found.project?.repositoryIdentity,
            input.checkpoint,
          )
        : undefined;
      if (checkpoint && 'error' in checkpoint) throw new StartRunRefused(checkpoint.error);
      const conflicts = await replaceRunClaimsForFound(
        tx,
        found,
        input.claims,
        claimLeaseMinutes,
      );
      const now = new Date();
      const [active] = await tx
        .update(agentRuns)
        .set({ status: 'active', lastHeartbeatAt: now })
        .where(and(eq(agentRuns.id, run.id), eq(agentRuns.status, 'starting')))
        .returning();
      if (!active) throw new Error('Run left starting state during its start transaction.');
      return { run: active, conflicts, checkpoint, projectSplit, replayed: false } as const;
    });
  } catch (error) {
    if (error instanceof StartRunRefused) return { error: error.message } as const;
    throw error;
  }
}

export async function replaceRunClaims(
  db: Db,
  runId: string,
  userId: string,
  claims: WorkClaim[],
  claimLeaseMinutes: number,
  source: ClaimSource = 'planned',
) {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await lockRunClaimWorkspace(tx, runId, userId);
    const found = await runForOwnerLocked(tx, runId, userId);
    if (!found || !ACTIVE.includes(found.run.status as (typeof ACTIVE)[number])) return [];
    return replaceRunClaimsForFound(tx, found, claims, claimLeaseMinutes, source);
  });
}

type RunOwner = NonNullable<Awaited<ReturnType<typeof runForOwner>>>;

/**
 * Ground a run held for work it has reported complete. The row stays: the agent
 * map draws what an agent touched, and `staleGroundFor` tells the next agent the
 * ground moved. Deleted, as completion first did it (2026-09-19), both went blind
 * the moment the work was done. It is never live again: the lease ended when it
 * was released and no heartbeat renews it, so `lease_expires_at` is when it was let go.
 */
export const RELEASED_CLAIM = 'released';
const stillHeld = ne(workClaims.source, RELEASED_CLAIM);

async function replaceRunClaimsForFound(
  db: Db,
  found: RunOwner,
  claims: WorkClaim[],
  claimLeaseMinutes: number,
  source: ClaimSource = 'planned',
) {
  const runId = found.run.id;
  const uniqueClaims = [
    ...new Map(
      claims.map((claim) => [
        `${claim.resourceType}\0${claim.resourceKey}\0${claim.access}`,
        claim,
      ]),
    ).values(),
  ];
  const leaseExpiresAt = new Date(Date.now() + claimLeaseMinutes * 60_000);
  // Restating scope rewrites the rows, and `created_at` with them: that is how a
  // run acknowledges ground that moved. What must survive the rewrite is when the
  // run FIRST declared each piece and has held it since, because that decides who
  // keeps the right of way. Ground dropped and declared again starts over.
  const before = await db
    .select()
    .from(workClaims)
    .where(and(eq(workClaims.runId, runId), eq(workClaims.source, source)));
  const firstBy = new Map(before.map((row) => [claimDeclarationKey(row), row.firstDeclaredAt ?? row.createdAt]));
  const now = new Date();
  // The caller owns the transaction and the run-row lock. Between delete and
  // insert no other lifecycle transition can expose or revive partial scope.
  await db
    .delete(workClaims)
    .where(and(eq(workClaims.runId, runId), eq(workClaims.source, source)));
  if (uniqueClaims.length > 0) {
    await db.insert(workClaims).values(
      uniqueClaims.map((claim) => ({
        runId,
        resourceType: claim.resourceType,
        resourceKey: claim.resourceKey,
        access: claim.access,
        source,
        leaseExpiresAt,
        firstDeclaredAt: firstBy.get(claimDeclarationKey(claim)) ?? now,
      })),
    );
  }

  // Scope moved, so the agent map is now wrong on every screen showing it.
  publishChange(found.run.teamId, 'claims');
  const allRows = await db.select().from(workClaims).where(and(eq(workClaims.runId, runId), stillHeld));
  const allClaims = [
    ...new Map(
      allRows.map((claim) => [
        `${claim.resourceType}\0${claim.resourceKey}\0${claim.access}`,
        {
          resourceType: claim.resourceType as WorkClaim['resourceType'],
          resourceKey: claim.resourceKey,
          access: claim.access as WorkClaim['access'],
        },
      ]),
    ).values(),
  ];
  return conflictsForRun(db, found, runId, allClaims);
}

/**
 * A collision, and who keeps the right of way in it.
 *
 * A collision is a fact about two runs and used to be told to both the same way:
 * stop, coordinate. Measured in the agent lab, 2026-09-20: a1 held a file, b1
 * declared it later and stopped as asked — and a1, told of "a conflict" on its
 * next heartbeat, stopped as well, with its work done and unreported. Two agents
 * waiting for each other, and a human needed on both machines. The write guard
 * was symmetric too, so a run could stop another's edits by declaring its file.
 * The run that declared the ground first and has held it since keeps going; the
 * later one waits. Unknown on either side means nobody was provably first, and
 * both are treated as the later one, which is how it always behaved.
 *
 * Between a read and a write the writer has the right of way, whoever declared
 * first, and nobody waits (T3 Mac round, 2026-09-23). Measured: a reviewer
 * declared a file read-only, the agent changing it was told to leave it alone
 * because the reviewer "declared it first", and the guard would have refused
 * that agent's edit with work_conflict. A read holds nothing to protect; the
 * reader is the one whose copy may go stale, and it is told so.
 */
export type RunConflict = ClaimConflict & { rightOfWay: 'yours' | 'theirs' };

/** Overlap between this run's scope and every other live claim in the same project. */
async function conflictsForRun(db: Db, found: RunOwner, runId: string, claims: WorkClaim[]): Promise<RunConflict[]> {
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
  const existing: ConflictClaim[] = [
    ...new Map(
      existingRows
        .filter(
          (row) =>
            !areAttemptSiblings(mine, {
              ownerId: row.owner.id,
              attemptGroup: row.run.attemptGroup,
              taskKey: row.run.taskKey,
              worktree: row.run.worktree,
            }),
        )
        .map((row) => {
          const claim: ConflictClaim = {
            runId: row.run.id,
            owner: row.owner.username,
            agentName: row.installation.name,
            taskKey: row.run.taskKey,
            resourceType: row.claim.resourceType as WorkClaim['resourceType'],
            resourceKey: row.claim.resourceKey,
            access: row.claim.access as WorkClaim['access'],
            // What the holder is doing and until when. A run parked on `waiting`
            // holds its ground for the waiting lease, and without these two the
            // stopped agent can only guess from its own.
            runState: row.run.status as ConflictClaim['runState'],
            leaseEndsAt: row.claim.leaseExpiresAt.toISOString(),
          };
          return [
            `${claim.runId}\0${claim.resourceType}\0${claim.resourceKey}\0${claim.access}`,
            claim,
          ] as const;
        }),
    ).values(),
  ];
  const theirFirst = new Map(
    existingRows.map((row) => [`${row.run.id}\0${claimDeclarationKey(row.claim)}`, row.claim.firstDeclaredAt]),
  );
  const ownRows = await db.select().from(workClaims).where(and(eq(workClaims.runId, runId), stillHeld));
  const myFirst = new Map<string, Date>();
  for (const row of ownRows) {
    if (!row.firstDeclaredAt) continue;
    const key = claimDeclarationKey(row);
    const known = myFirst.get(key);
    if (!known || row.firstDeclaredAt < known) myFirst.set(key, row.firstDeclaredAt);
  }
  const conflicts: RunConflict[] = detectClaimConflicts(current, existing).map((conflict) => {
    if (isReadOverlap(conflict)) {
      return { ...conflict, rightOfWay: conflict.current.access === 'write' ? 'yours' : 'theirs' };
    }
    const mine = myFirst.get(claimDeclarationKey(conflict.current));
    const theirs = theirFirst.get(`${conflict.existing.runId}\0${claimDeclarationKey(conflict.existing)}`);
    return { ...conflict, rightOfWay: mine && theirs && mine < theirs ? 'yours' : 'theirs' };
  });
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
  await db.update(workClaims).set({ leaseExpiresAt }).where(and(eq(workClaims.runId, runId), stillHeld));
  const own = await db.select().from(workClaims).where(and(eq(workClaims.runId, runId), stillHeld));
  const claims: WorkClaim[] = [
    ...new Map(
      own.map((row) => {
        const claim: WorkClaim = {
          resourceType: row.resourceType as WorkClaim['resourceType'],
          resourceKey: row.resourceKey,
          access: row.access as WorkClaim['access'],
        };
        return [`${claim.resourceType}\0${claim.resourceKey}\0${claim.access}`, claim] as const;
      }),
    ).values(),
  ];
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
    .limit(100);
  if (candidates.length === 0) return { linked: false };
  const wanted = input.repoName?.toLowerCase();
  const matching = wanted
      ? candidates.filter(
          (c) =>
            c.run.repo?.toLowerCase() === wanted || (!wanted.includes('/') && c.projectName?.toLowerCase() === wanted),
        )
      : candidates;
  if (matching.length !== 1) return { linked: false };
  const found = matching[0]!;
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
  waitingLeaseMinutes: number,
  usage?: AgentQuota,
  claimSource: ClaimSource = 'planned',
  checkpointInput?: RunCheckpointInput & { kind: 'delivery' | 'tested' },
  /**
   * The agent sent this itself (`update_run`), as opposed to a hook reporting
   * the dirty worktree. Only an explicit restatement can acknowledge moved
   * ground: see `ground_acknowledged` below.
   */
  explicit = false,
) {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await lockRunClaimWorkspace(tx, runId, userId);
    // Finish, handoff and heartbeat all serialize on this row. A heartbeat
    // which began before finish but waited for the lock re-reads the terminal
    // state here and cannot renew either the run or its leases.
    const found = await runForOwnerLocked(tx, runId, userId);
    if (!found || !ACTIVE.includes(found.run.status as (typeof ACTIVE)[number])) return undefined;
    const checkpoint = checkpointInput
      ? await writeRunCheckpoint(
          tx,
          found.run,
          found.project?.repositoryIdentity,
          checkpointInput,
        )
      : undefined;
    if (checkpoint && 'error' in checkpoint) return checkpoint;
    const nextStatus = status ?? (found.run.status as AgentRunStatus);
    const effectiveLeaseMinutes =
      nextStatus === 'waiting' || nextStatus === 'blocked'
        ? Math.max(claimLeaseMinutes, waitingLeaseMinutes)
        : claimLeaseMinutes;
    const now = new Date();
    const [updated] = await tx
      .update(agentRuns)
      .set({ status: nextStatus, lastHeartbeatAt: now })
      .where(and(eq(agentRuns.id, runId), inArray(agentRuns.status, ACTIVE)))
      .returning({ id: agentRuns.id });
    if (!updated) return undefined;
    await tx
      .update(agentInstallations)
      .set({ lastSeenAt: now })
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
        ? await replaceRunClaimsForFound(
            tx,
            found,
            claims,
            effectiveLeaseMinutes,
            claimSource,
          )
        : await renewRunClaims(tx, found, effectiveLeaseMinutes);
    const quota = usage ? await recordRunQuota(tx, found, usage) : undefined;
    const heldRows = await tx.select().from(workClaims).where(and(eq(workClaims.runId, runId), stillHeld));
    const held: WorkClaim[] = heldRows.map((claim) => ({
      resourceType: claim.resourceType as WorkClaim['resourceType'],
      resourceKey: claim.resourceKey,
      access: claim.access as WorkClaim['access'],
    }));
    const stale = await staleGroundFor(tx, found.run, held);
    // The agent restated ground this very reply tells it moved: that is the
    // acknowledgment the write guard waits for, whichever source it named. It
    // used to count only as rewritten `planned` rows, and the refusal says
    // "re-declare your scope with update_run" without naming a source — measured
    // in the T3 Mac round (2026-09-23), an agent re-declared with
    // `scope_source: "observed"` three times and the guard refused it for the
    // rest of the run. An `observed` row cannot carry it instead: the hook
    // rewrites those from the dirty worktree on its own heartbeats, which must
    // never acknowledge anything, and would delete an agent's row the moment
    // another file is dirty. So it is an event of the run, written only here.
    if (explicit && claims && claims.length > 0 && stale.length > 0) {
      const moved = claims.filter((claim) =>
        stale.some(
          (entry) =>
            entry.resourceType === claim.resourceType &&
            entry.resourceKey.toLowerCase() === claim.resourceKey.toLowerCase(),
        ),
      );
      if (moved.length > 0) {
        await addAgentEvent(tx, runId, 'ground_acknowledged', {
          claims: moved.map((claim) => ({
            resourceType: claim.resourceType,
            resourceKey: claim.resourceKey,
            access: claim.access,
          })),
          source: claimSource,
        });
      }
    }
    return {
      runId,
      status: nextStatus,
      leaseMinutes: effectiveLeaseMinutes,
      conflicts,
      quota,
      checkpoint,
      stale,
      // Attribution for the activity feed, same shape finishAgentRun returns.
      scope: {
        teamId: found.run.teamId,
        projectId: found.run.projectId,
        taskKey: found.run.taskKey,
      },
    };
  });
}

/** A synchronous, opt-in file-tool gate. This is not an OS/file-system mutex:
 * only a client executing its installed pre-tool hook can enforce the answer.
 * A denied contender does not acquire the contested scope or evict its owner.
 */
export async function guardRunWrite(
  db: Db, runId: string, userId: string,
  input: { claims: WorkClaim[]; repositoryIdentity: string; worktree: string },
  claimLeaseMinutes: number,
) {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await lockRunClaimWorkspace(tx, runId, userId);
    const found = await runForOwnerLocked(tx, runId, userId);
    if (!found || found.installation.revokedAt || !ACTIVE.includes(found.run.status as (typeof ACTIVE)[number])) return undefined;
    const [team] = await tx.select().from(teams).where(eq(teams.id, found.run.teamId));
    if (!team) return undefined;
    let reason: string | undefined;
    const identity = canonicalRepositoryIdentity(input.repositoryIdentity);
    if (!identity || identity !== found.project?.repositoryIdentity || input.worktree !== found.run.worktree) reason = 'checkout_mismatch';
    const policy = await effectivePolicy(tx, userId, { team: team.slug, project: found.project?.name, projectId: found.run.projectId });
    if ('error' in policy || policy.projectId !== found.run.projectId) reason = 'policy_unavailable';
    const held = await tx.select().from(workClaims).where(and(eq(workClaims.runId, runId), eq(workClaims.source, 'planned')));
    const claims: WorkClaim[] = [...new Map([...held.map((c) => ({ resourceType: c.resourceType as WorkClaim['resourceType'], resourceKey: c.resourceKey, access: c.access as WorkClaim['access'] })), ...input.claims]
      .map((c) => [`${c.resourceType}\0${c.resourceKey}\0${c.access}`, c] as const)).values()];
    if (claims.length > 200) reason = 'scope_capacity';
    if (!('error' in policy)) {
      if (input.claims.some((c) => c.access === 'write' && c.resourceType === 'path' && policy.document.protectedPaths.some((p) => pathClaimsOverlap(c.resourceKey, p))) || approvalsNeeded(policy.document, input.claims).length) reason = 'owner_approval_required';
      if (budgetVerdict(policy.document, claims).over.length) reason = 'change_budget_exceeded';
    }
    const conflicts = await conflictsForRun(tx, found, runId, input.claims);
    // Only ground somebody else held first stops an edit. A run that declares a
    // file another run is already working in is told to wait; it must not be able
    // to stop that run's edits by doing so. A read stops nothing and waits for
    // nothing, whoever declared it first (see RunConflict).
    const blocking = conflicts.filter((conflict) => conflict.rightOfWay === 'theirs' && !isReadOverlap(conflict));
    const waiting = conflicts.filter((conflict) => conflict.rightOfWay === 'yours' && !isReadOverlap(conflict));
    // Ground that moved before this run last declared the claim was acknowledged
    // by that declaration; the guard refuses only what the agent has not been
    // told about yet (or was told about and has not re-declared since). A
    // declaration is a rewritten `planned` row or an explicit update_run that
    // restated the moved ground under either source (`ground_acknowledged`).
    const declaredAt = new Map(held.map((c) => [claimDeclarationKey(c), c.createdAt]));
    const acknowledged = await tx
      .select({ detail: agentEvents.detail, createdAt: agentEvents.createdAt })
      .from(agentEvents)
      .where(and(eq(agentEvents.runId, runId), eq(agentEvents.type, 'ground_acknowledged')))
      .orderBy(desc(agentEvents.createdAt))
      .limit(50);
    for (const ack of acknowledged) {
      const restated = (ack.detail as { claims?: WorkClaim[] } | null)?.claims;
      for (const claim of Array.isArray(restated) ? restated : []) {
        const key = claimDeclarationKey(claim);
        const known = declaredAt.get(key);
        if (!known || ack.createdAt > known) declaredAt.set(key, ack.createdAt);
      }
    }
    const stale = await staleGroundFor(tx, found.run, input.claims, declaredAt);
    if (stale.length) reason = 'stale_ground';
    // A live holder outranks ground that moved: it is the one fact the agent can
    // act on now (name who holds it, or wait for them), and once it lets go the
    // moved ground is reported on the next try. It used to be the other way
    // round, and an agent stopped by a live holder was told only that "another
    // run finished on this ground", so it could not say who it was waiting for
    // (T3 Mac round, 2026-09-23).
    if (blocking.length) reason = 'work_conflict';
    const allowed = !reason;
    if (allowed) await replaceRunClaimsForFound(tx, found, claims, claimLeaseMinutes);
    await addAgentEvent(tx, runId, 'write_guard_decision', {
      allowed, reason: reason ?? 'scope_reserved', installationId: found.installation.id,
      claimCount: input.claims.length, otherRunIds: [...new Set(blocking.map((c) => c.existing.runId))],
      waitingRunIds: [...new Set(waiting.map((c) => c.existing.runId))],
    });
    return { allowed, reason: reason ?? 'scope_reserved', runId,
      conflictRuns: [...new Set(blocking.map((c) => c.existing.runId))],
      // Who holds the ground, so the stopped agent can tell its human a name
      // rather than a run id (measured 2026-09-19: "the hook did not say"), what
      // that run is doing and when its hold lapses — one describeHolder, so this
      // reply, the map and the hook cannot tell three different stories.
      conflictAgents: [...new Set(blocking.map((c) => describeHolder(c.existing)))],
      // Whether the holder is parked on a person. Waiting out a run that is
      // itself waiting for somebody is how two agents wait for each other.
      conflictNeedsAPerson: blocking.some((c) => holderNeedsAPerson(c.existing.runState)),
      // Runs that declared this ground after this one and are waiting for it.
      waitingAgents: [...new Set(waiting.map((c) => describeHolder(c.existing)))],
      coverage: 'installed_file_tool_hook_only',
      policyHash: 'error' in policy ? null : policy.hash,
      // The published `content:` deny lines, verbatim. The path is clear by the
      // time this is read; the local guard checks the text the edit would add
      // against these and never sends that text anywhere.
      contentRules:
        'error' in policy
          ? []
          : parseContentRules(policy.document.permissions.deny).map((rule) => rule.rule),
    };
  });
}

/**
 * Completed work holds no ground.
 *
 * A guarded Stop leaves a run waiting with its claims for the waiting lease, so
 * a human can approve something without the agent losing its place. That is
 * right while work is in progress and wrong once the agent has reported the
 * work complete: the session stays open, the claim lives on for half an hour,
 * and the next agent sent to the same file is stopped by a collision with
 * nothing behind it (measured in the agent lab, 2026-09-19). The run stays
 * live — presence is true, the session is open — and the write guard declares
 * ground again on its next edit.
 *
 * Only when the installation has exactly one live run in that project, or names
 * the run: a personal token can serve several checkouts, and with more than one
 * live run there is no telling which of them did the work.
 */
export async function releaseGroundAfterCompletion(
  db: Db,
  userId: string,
  scope: { installationId: string; teamId: string; projectId: string | null; runId?: string },
  sessionId: string,
): Promise<{ runId: string; claims: number } | undefined> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await lockClaimWorkspace(tx, scope.teamId);
    const candidates = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .innerJoin(agentInstallations, eq(agentRuns.installationId, agentInstallations.id))
      .where(
        and(
          eq(agentRuns.installationId, scope.installationId),
          eq(agentInstallations.userId, userId),
          eq(agentRuns.teamId, scope.teamId),
          scope.projectId ? eq(agentRuns.projectId, scope.projectId) : isNull(agentRuns.projectId),
          inArray(agentRuns.status, ACTIVE),
          scope.runId ? eq(agentRuns.id, scope.runId) : undefined,
        ),
      );
    if (candidates.length !== 1) return undefined;
    const found = await runForOwnerLocked(tx, candidates[0]!.id, userId);
    if (!found || !ACTIVE.includes(found.run.status as (typeof ACTIVE)[number])) return undefined;
    const held = await tx.select().from(workClaims).where(and(eq(workClaims.runId, found.run.id), stillHeld));
    if (held.length === 0) return undefined;
    // The same ground released twice in one run keeps the later moment: the
    // unique index includes the source, so the earlier record makes way first.
    const earlier = await tx.select().from(workClaims).where(and(eq(workClaims.runId, found.run.id), eq(workClaims.source, RELEASED_CLAIM)));
    const again = earlier.filter((old) => held.some((row) => row.resourceType === old.resourceType && row.resourceKey === old.resourceKey && row.access === old.access));
    if (again.length > 0) await tx.delete(workClaims).where(inArray(workClaims.id, again.map((row) => row.id)));
    // Two sources can hold one resource (planned and observed); one record of it is enough.
    const keep = new Map(held.map((row) => [`${row.resourceType}\0${row.resourceKey}\0${row.access}`, row.id]));
    const spare = held.filter((row) => keep.get(`${row.resourceType}\0${row.resourceKey}\0${row.access}`) !== row.id);
    if (spare.length > 0) await tx.delete(workClaims).where(inArray(workClaims.id, spare.map((row) => row.id)));
    await tx
      .update(workClaims)
      .set({ source: RELEASED_CLAIM, leaseExpiresAt: new Date() })
      .where(inArray(workClaims.id, [...keep.values()]));
    await addAgentEvent(tx, found.run.id, 'claims_released', {
      reason: 'work_completed', sessionId, count: held.length, installationId: scope.installationId,
    });
    publishChange(found.run.teamId, 'claims');
    return { runId: found.run.id, claims: held.length };
  });
}

/**
 * A run the hook opened has no name: the hook knows a session began, not what
 * for. In the two-device round of 2026-09-19 the lead's agent map showed four
 * rows reading "untitled run". When the agent takes work that has a name, its
 * run takes that name.
 *
 * Never over a name somebody gave: a task key, or an intent the agent declared,
 * stays. A name this function set earlier does make way, because a hook-owned
 * run lives as long as its session and outlives the assignments done in it.
 * Same reach as `releaseGroundAfterCompletion`: the installation's one live run
 * in the project, or the run it names.
 */
export async function nameRunForWork(
  db: Db,
  userId: string,
  scope: { installationId: string; teamId: string; projectId: string | null; runId?: string },
  work: { sessionId: string; title: string },
): Promise<{ runId: string; name: string } | undefined> {
  const name = work.title.replace(/^(Assignment|Handoff):\s*/i, '').trim().slice(0, 200);
  if (!name) return undefined;
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const candidates = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .innerJoin(agentInstallations, eq(agentRuns.installationId, agentInstallations.id))
      .where(
        and(
          eq(agentRuns.installationId, scope.installationId),
          eq(agentInstallations.userId, userId),
          eq(agentRuns.teamId, scope.teamId),
          scope.projectId ? eq(agentRuns.projectId, scope.projectId) : isNull(agentRuns.projectId),
          inArray(agentRuns.status, ACTIVE),
          scope.runId ? eq(agentRuns.id, scope.runId) : undefined,
        ),
      );
    if (candidates.length !== 1) return undefined;
    const found = await runForOwnerLocked(tx, candidates[0]!.id, userId);
    if (!found || !ACTIVE.includes(found.run.status as (typeof ACTIVE)[number]) || found.run.taskKey) return undefined;
    if (found.run.intent === name) return undefined;
    if (found.run.intent) {
      const [named] = await tx
        .select({ detail: agentEvents.detail })
        .from(agentEvents)
        .where(and(eq(agentEvents.runId, found.run.id), eq(agentEvents.type, 'run_named')))
        .orderBy(desc(agentEvents.createdAt))
        .limit(1);
      if ((named?.detail as { name?: string } | null)?.name !== found.run.intent) return undefined;
    }
    await tx.update(agentRuns).set({ intent: name }).where(eq(agentRuns.id, found.run.id));
    await addAgentEvent(tx, found.run.id, 'run_named', { name, sessionId: work.sessionId });
    publishChange(found.run.teamId, 'run');
    return { runId: found.run.id, name };
  });
}

export async function finishAgentRun(
  db: Db,
  runId: string,
  userId: string,
  status: Extract<AgentRunStatus, 'completed' | 'failed'>,
  detail?: string,
  checkpointInput?: RunCheckpointInput & { kind: 'delivery' | 'tested' },
) {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const found = await runForOwnerLocked(tx, runId, userId);
    if (!found) return undefined;
    const checkpoint = checkpointInput
      ? await writeRunCheckpoint(
          tx,
          found.run,
          found.project?.repositoryIdentity,
          checkpointInput,
        )
      : undefined;
    if (checkpoint && 'error' in checkpoint) return checkpoint;
    if (found.run.status === 'completed' || found.run.status === 'failed') {
      return {
        runId,
        status: found.run.status as 'completed' | 'failed',
        endedAt: (found.run.endedAt ?? found.run.lastHeartbeatAt).toISOString(),
        replayed: true,
        checkpoint,
        scope: {
          teamId: found.run.teamId,
          projectId: found.run.projectId,
          taskKey: found.run.taskKey,
        },
      };
    }
    if (!ACTIVE.includes(found.run.status as (typeof ACTIVE)[number])) return undefined;
    const now = new Date();
    const [updated] = await tx
      .update(agentRuns)
      .set({ status, endedAt: now, lastHeartbeatAt: now })
      .where(and(eq(agentRuns.id, runId), inArray(agentRuns.status, ACTIVE)))
      .returning({ id: agentRuns.id });
    if (!updated) return undefined;
    await tx.update(workClaims).set({ leaseExpiresAt: now }).where(and(eq(workClaims.runId, runId), stillHeld));
    await addAgentEvent(tx, runId, 'run_finished', {
      status,
      detail: detail ? redactSecrets(detail) : undefined,
    });
    return {
      runId,
      status,
      endedAt: now.toISOString(),
      replayed: false,
      checkpoint,
      // Attribution for the activity feed; the route strips it from the agent's payload.
      scope: {
        teamId: found.run.teamId,
        projectId: found.run.projectId,
        taskKey: found.run.taskKey,
      },
    };
  });
}

export async function markStaleAgentRuns(
  db: Db,
  staleMinutes: number,
  waitingStaleMinutes = staleMinutes,
): Promise<number> {
  const now = new Date();
  const rows = await db
    .update(agentRuns)
    .set({ status: 'stale', endedAt: now })
    .where(
      or(
        and(
          inArray(agentRuns.status, ['starting', 'active']),
          lt(agentRuns.lastHeartbeatAt, new Date(now.getTime() - staleMinutes * 60_000)),
        ),
        and(
          inArray(agentRuns.status, ['waiting', 'blocked']),
          lt(
            agentRuns.lastHeartbeatAt,
            new Date(now.getTime() - waitingStaleMinutes * 60_000),
          ),
        ),
      ),
    )
    .returning({ id: agentRuns.id });
  return rows.length;
}

export async function activeRunsForMember(
  db: Db,
  userId: string,
  teamSlug?: string,
  projectId?: string,
) {
  const conditions = [membershipUser(userId), inArray(agentRuns.status, ACTIVE)];
  if (teamSlug) conditions.push(eq(teams.slug, teamSlug));
  if (projectId) conditions.push(eq(agentRuns.projectId, projectId));
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
export const claimDeclarationKey = (claim: { resourceType: string; resourceKey: string; access?: string }) =>
  `${claim.resourceType}|${claim.resourceKey.toLowerCase()}|${claim.access ?? 'write'}`;

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
/**
 * `declaredAt`, when given, is when this run last (re)declared each claim. A
 * finished run that moved the ground *before* that declaration is not news:
 * the agent was told, re-read, and declared its scope again. Without it the
 * ground stayed stale for the rest of the run, and the write guard kept the
 * agent that had waited its turn from ever editing (measured 2026-09-19).
 * The advisory report on update_run deliberately does not pass it: the call
 * that restates scope must still say what moved.
 */
export async function staleGroundFor(
  db: Db,
  run: { id: string; teamId: string; projectId: string | null; startedAt: Date },
  claims: readonly WorkClaim[],
  declaredAt?: ReadonlyMap<string, Date>,
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
        // Finished, and finished *after* this run began reading the world — or
        // still live, with work it reported complete since then: a hook-owned run
        // outlives the assignments done in it, and the ground moved at completion.
        or(
          and(inArray(agentRuns.status, ['completed', 'failed']), gt(agentRuns.endedAt, since)),
          and(eq(workClaims.source, RELEASED_CLAIM), gt(workClaims.leaseExpiresAt, since)),
        ),
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
  // When each piece of ground moved: at release for completed work, else when the run ended.
  const movedKey = (runId: string, type: string, key: string) => `${runId}|${type}|${key.toLowerCase()}`;
  const movedAt = new Map(
    rows.map((row) => [
      movedKey(row.claim.runId, row.claim.resourceType, row.claim.resourceKey),
      row.claim.source === RELEASED_CLAIM ? row.claim.leaseExpiresAt : row.endedAt,
    ]),
  );

  // Reuse the overlap rule rather than writing a second one — "same ground" has
  // to mean the same thing here as it does on the conflict radar.
  const seen = new Set<string>();
  const out: StaleGround[] = [];
  for (const overlap of detectClaimConflicts(mine, theirs.filter((c) => c.access === 'write'))) {
    const key = `${overlap.current.resourceType}|${overlap.current.resourceKey.toLowerCase()}|${overlap.existing.runId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ended = movedAt.get(movedKey(overlap.existing.runId, overlap.existing.resourceType, overlap.existing.resourceKey));
    const declared = declaredAt?.get(claimDeclarationKey(overlap.current));
    if (ended && declared && declared > ended) continue;
    out.push({
      resourceType: overlap.current.resourceType,
      resourceKey: overlap.current.resourceKey,
      by: overlap.existing.owner,
      agentName: overlap.existing.agentName,
      taskKey: overlap.existing.taskKey ?? null,
      at: ended ?? new Date(),
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
