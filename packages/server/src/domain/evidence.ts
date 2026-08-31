import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import type { Db } from '../db';
import {
  agentEvents,
  agentInstallations,
  agentRuns,
  environmentChecks,
  policyReceipts,
  projects,
  teams,
  users,
  workClaims,
} from '../db/schema';

/**
 * "Why is this change mergeable?" — assembled, not collected.
 *
 * Every part of the answer is already stored: the policy receipt says whether
 * the run applied the rules it was served, preflight says whether its machine
 * could build the project at all, the claims say what ground it took, the
 * events say who it collided with, and the trail says what it did. What did not
 * exist was one place that puts them together and names what is missing.
 *
 * That distinction matters for what this is allowed to say. It reports;
 * it never re-derives. If a run never sent a policy hash, the honest answer is
 * "unconfirmed", not a guess — a merge-readiness report that quietly fills in
 * blanks is worse than no report, because somebody will trust it.
 */

export type EvidenceState = 'ok' | 'attention' | 'unknown';

export interface EvidenceCheck {
  key: string;
  state: EvidenceState;
  detail: string;
}

const TRAIL_LIMIT = 20;

export async function evidenceForRun(db: Db, runId: string, viewerId: string) {
  const rows = await db
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
    .leftJoin(projects, eq(agentRuns.projectId, projects.id))
    .where(eq(agentRuns.id, runId))
    .limit(1);
  const found = rows[0];
  if (!found) return { error: 'Unknown run.' } as const;

  // Membership, not ownership: a teammate's run is exactly what you want an
  // evidence pack for. `viewerId` is checked by the caller against the team.
  void viewerId;

  const claims = await db.select().from(workClaims).where(eq(workClaims.runId, runId));
  const receiptRows = await db
    .select()
    .from(policyReceipts)
    .where(eq(policyReceipts.runId, runId))
    .limit(1);
  const receipt = receiptRows[0];
  const checkRows = await db
    .select()
    .from(environmentChecks)
    .where(eq(environmentChecks.runId, runId))
    .orderBy(desc(environmentChecks.createdAt))
    .limit(1);
  const check = checkRows[0];
  const trail = await db
    .select({ type: agentEvents.type, detail: agentEvents.detail, at: agentEvents.createdAt })
    .from(agentEvents)
    .where(eq(agentEvents.runId, runId))
    .orderBy(desc(agentEvents.createdAt))
    .limit(TRAIL_LIMIT);
  // Overlap is written to the run that DETECTED it, which is whichever one
  // declared its scope second. Reading only this run's own events therefore
  // reports "nobody overlapped you" to the run that was overlapped — the exact
  // kind of confidently wrong line that makes a readiness pack worse than none.
  // So look both ways: what this run saw, and what saw this run.
  const seenByOthers = await db
    .select({ detail: agentEvents.detail })
    .from(agentEvents)
    .innerJoin(agentRuns, eq(agentEvents.runId, agentRuns.id))
    .where(
      and(
        eq(agentEvents.type, 'conflicts_detected'),
        eq(agentRuns.teamId, found.run.teamId),
        found.run.projectId
          ? eq(agentRuns.projectId, found.run.projectId)
          : isNull(agentRuns.projectId),
        gte(agentEvents.createdAt, found.run.startedAt),
      ),
    )
    .limit(200);
  const namedElsewhere = seenByOthers.filter((row) =>
    ((row.detail as { otherRunIds?: string[] } | null)?.otherRunIds ?? []).includes(runId),
  ).length;
  const collisions = trail.filter((event) => event.type === 'conflicts_detected');
  const overlaps = collisions.length + namedElsewhere;

  const checks: EvidenceCheck[] = [
    {
      // Three states, not two, because this codebase already distinguishes a
      // deviation from a silence: start_run writes the hash the server served,
      // and `drift` only becomes true when a run answers with a different one.
      // A receipt nobody answered has drift=false — reading that as "ok" would
      // make the pack claim a rule was followed when nobody said so.
      key: 'policy',
      state: !receipt ? 'unknown' : receipt.drift ? 'attention' : receipt.reportedHash ? 'ok' : 'unknown',
      detail: !receipt
        ? 'No receipt — this run never reported which rules it applied.'
        : receipt.drift
          ? `Applied ${(receipt.reportedHash ?? 'nothing').slice(0, 12)}, the server served ${receipt.expectedHash.slice(0, 12)}.`
          : receipt.reportedHash
            ? `Applied the policy the server served (${receipt.expectedHash.slice(0, 12)}).`
            : `Unconfirmed — the server served ${receipt.expectedHash.slice(0, 12)} and this run never answered.`,
    },
    {
      key: 'environment',
      state: !check ? 'unknown' : check.status === 'ok' ? 'ok' : 'attention',
      detail: !check
        ? 'No preflight — nobody checked this machine against the project baseline.'
        : `${check.status}: ${check.summary}`,
    },
    {
      key: 'collisions',
      state: overlaps === 0 ? 'ok' : 'attention',
      detail:
        overlaps === 0
          ? 'No other live run overlapped this scope while it ran.'
          : `Overlapped another live run ${overlaps} time(s) — see the trail, and the other run's.`,
    },
    {
      key: 'scope',
      state: claims.length === 0 ? 'unknown' : 'ok',
      detail:
        claims.length === 0
          ? 'This run declared no scope, so nobody could be warned about it.'
          : `Declared ${claims.length} claim(s) before starting.`,
    },
    {
      key: 'outcome',
      // The forge's word beats the run's own: a merged PR is the outcome that
      // matters, a failing CI or a closed-unmerged PR is the one to look at,
      // and a run with no webhook wired falls back to what it said about
      // itself. None of this is inferred — it is what pull_request /
      // workflow_run / ADO service hooks reported, or nothing.
      state:
        found.run.ciState === 'failing' || found.run.prState === 'closed'
          ? 'attention'
          : found.run.prState === 'merged'
            ? 'ok'
            : found.run.status === 'completed'
              ? 'ok'
              : found.run.status === 'failed'
                ? 'attention'
                : 'unknown',
      detail: [
        found.run.status === 'completed'
          ? 'Finished and released its scope.'
          : found.run.status === 'failed'
            ? 'Finished as failed.'
            : `Still ${found.run.status} — this pack describes work in progress.`,
        found.run.prState
          ? `PR #${found.run.prNumber} ${found.run.prState}${found.run.prState === 'closed' ? ' without merging' : ''}.`
          : null,
        found.run.ciState ? `CI ${found.run.ciState} on its branch.` : null,
      ]
        .filter(Boolean)
        .join(' '),
    },
  ];

  return {
    run: {
      id: found.run.id,
      // The task key carries the issue when there is one — "#42" is the convention.
      task: found.run.taskKey,
      intent: found.run.intent,
      branch: found.run.branch,
      baseSha: found.run.baseSha,
      status: found.run.status,
      startedAt: found.run.startedAt.toISOString(),
      endedAt: found.run.endedAt?.toISOString() ?? null,
      pr: found.run.prState
        ? { number: found.run.prNumber, url: found.run.prUrl, state: found.run.prState }
        : null,
      ci: found.run.ciState ?? null,
      // Cost rides with its source — a reviewer reading "$4.20 (estimate)"
      // knows exactly how much weight that number can carry.
      cost:
        found.run.costCents !== null
          ? { usd: found.run.costCents / 100, source: found.run.costSource ?? 'estimate' }
          : null,
    },
    who: {
      owner: found.owner.username,
      agent: found.installation.name,
      client: found.installation.clientType,
      team: found.team.slug,
      project: found.projectName ?? found.run.repo ?? null,
    },
    scope: claims.map((claim) => ({
      type: claim.resourceType,
      key: claim.resourceKey,
      access: claim.access,
    })),
    checks,
    trail: trail.map((event) => ({ type: event.type, at: event.at.toISOString() })),
    /** What a reviewer should look at first — nothing more, and never a verdict. */
    blocking: checks.filter((c) => c.state === 'attention').map((c) => c.key),
    unconfirmed: checks.filter((c) => c.state === 'unknown').map((c) => c.key),
  } as const;
}
