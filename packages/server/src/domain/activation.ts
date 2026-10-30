import { and, asc, count, eq, inArray, isNotNull, min, sql } from 'drizzle-orm';
import type { Db } from '../db';
import {
  agentEnrollments,
  agentInstallations,
  agentRuns,
  debugSessions,
  handoffs,
  launchAttempts,
  membershipChanges,
  memberships,
  runCheckpoints,
  savingConfirmations,
  teams,
  tokens,
  users,
} from '../db/schema';
import type { Env } from '../env';
import { isAdminEmail, isAdminUsername } from '../lib/admin';
import { humanMembership } from '../lib/seats';
import { isTestEmail } from '../lib/testAccounts';

/**
 * Activation: how far each workspace has got along the path from "I started
 * setting this up" to "I use it again on another day".
 *
 * The product already measures things, but each measure answers a different
 * question and none of them is a path: `/admin/usage` counts independent
 * actions across every workspace, operator and demo ones included, and a
 * connected agent looks the same there as a delivered result. A pilot is
 * judged on a chain, so this module reads the chain, from rows that already
 * exist, and writes nothing (no schema change, nothing to age out).
 *
 * Six stages, in two lanes that are kept apart on purpose:
 *
 *   observed by STMA   1 setup started, 2 authorised connection, 3 first real
 *                      work, 4 usable handoff or delivery evidence, 6 repeat use
 *   answered by a person   5 "it helped and it changed what I did"
 *
 * A person's answer is not an observation and an observation is not a person's
 * answer, so the answer is never folded into the milestones and never inferred
 * from them (the brief: do not fill unobserved human behaviour with a guess).
 * Connected is not activation: stage 2 says an agent was authorised, stage 3
 * says the repository changed.
 *
 * **The unit is the workspace** (`teams.id`). Two members of one team are one
 * customer. A person who made three trial workspaces is three rows, and the
 * cohort card also prints how many distinct accounts created them so that is
 * visible. Counts are `n of m` over an eligible denominator, never event
 * counts, and a percentage is withheld below `ACTIVATION_SMALL_N` workspaces.
 *
 * **Who is excluded** (`excludedWorkspaces`): the operator's own accounts, test
 * accounts and review-access accounts never make a stage, and a workspace is
 * out of every denominator when it is a test workspace, the demo workspace
 * (marked by the membership row the product writes when an operator builds it)
 * or has no participant at all. A mixed workspace stays in, with the
 * operator's moments ignored, because an operator-prompted use is not the
 * participant's. Exclusions are counted and said on the page.
 *
 * **Stage definitions** are plain readings of stored rows:
 *   1 setup started: a participant opened a connection test, issued a
 *     workspace or project credential, or started an enrollment here. A
 *     personal credential has no workspace until it acts, so a workspace that
 *     reaches stage 3 without any of these reads "implied", with no timestamp.
 *   2 authorised connection: a workspace or project credential was activated,
 *     or a connection test saw its first agent. A participant's agent acting
 *     here with a personal credential reads "implied" for the same reason.
 *   3 first real work: a participant's run in a project reported a delivery or
 *     tested checkpoint on a commit that differs from the commit that run
 *     started on. A hook opens a run on any prompt and closes it on any
 *     session end, so a run's status proves nothing; a changed commit does.
 *     An agent that never reports a checkpoint is invisible here and the page
 *     says so, with the run count beside it.
 *   4 usable evidence: such a checkpoint is clean, has no failed test and at
 *     least one passed test, or a handoff carrying a checkpoint was resumed
 *     (STMA refuses a resume that is not on that commit). Provider observation
 *     is not required: most pilots have none connected, and it stays a
 *     separate fact on the evidence pack.
 *   5 human confirmed: a participant answered a saving confirmation helpful
 *     and changed-my-behaviour. The operator's answer never counts.
 *   6 repeat use: two stage-3 moments (a run's first changed checkpoint, or a
 *     verified resume) on different UTC calendar days at least twelve hours
 *     apart, so a session that straddles midnight is not a return.
 *
 * Retention bounds what a stage can say later: runs, checkpoints, saving
 * confirmations, launches and tokens are never aged out, but enrollments are
 * deleted thirty days after they expire and a resolved session takes its
 * handoffs with it after `SESSION_RETENTION_DAYS`. A past reading can therefore
 * drop after deletions (and after an account erases itself, which cascades its
 * installations, runs and checkpoints), which is the intended behaviour; the
 * pilot sheet's Markdown export is the durable record.
 *
 * Acquisition source is deliberately not recorded anywhere, so every cohort
 * reads "unknown (not recorded)".
 *
 * Console-only: `/admin/usage` and the pilot sheet read it; no tool or hook
 * does (`acceptance/tiers.json`, `consoleOnly`).
 */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** Workspaces read for the cohort card (newest first); one more is asked for. */
export const ACTIVATION_COHORT_MAX = 200;
/** Below this many eligible workspaces a percentage is false precision. */
export const ACTIVATION_SMALL_N = 5;
/** The second use must come at least this long after the first. */
export const REPEAT_GAP_HOURS = 12;
/** Repeat use cannot be judged until the first real work is this old. */
export const REPEAT_OBSERVABLE_AFTER_HOURS = 24;
/** Checkpoint rows read across the workspaces asked about. */
export const ACTIVATION_CHECKPOINT_SCAN = 20_000;

export type StageKey =
  | 'setup_started'
  | 'authorised_connection'
  | 'first_real_work'
  | 'usable_evidence'
  | 'human_confirmed'
  | 'repeat_use';

export interface StageDefinition {
  key: StageKey;
  number: number;
  label: string;
  /** observed by STMA, or answered by a person. */
  kind: 'observed' | 'answered';
  definition: string;
}

export const ACTIVATION_STAGES: StageDefinition[] = [
  {
    key: 'setup_started',
    number: 1,
    label: 'Setup started',
    kind: 'observed',
    definition:
      'A participant opened a connection test, issued a workspace or project credential or started an enrollment here.',
  },
  {
    key: 'authorised_connection',
    number: 2,
    label: 'Authorised connection',
    kind: 'observed',
    definition:
      'A workspace or project credential was activated, or a connection test saw its first agent. Connected is not activation.',
  },
  {
    key: 'first_real_work',
    number: 3,
    label: 'First real work',
    kind: 'observed',
    definition:
      'A participant run in a project reported a delivery or tested checkpoint on a commit different from the one it started on. A chat-only session is not work.',
  },
  {
    key: 'usable_evidence',
    number: 4,
    label: 'Usable handoff or delivery evidence',
    kind: 'observed',
    definition:
      'A clean checkpoint with a passing test and no failing one, or a handoff resumed on its exact commit. The agent\'s report; a provider need not have observed it.',
  },
  {
    key: 'human_confirmed',
    number: 5,
    label: 'Person confirmed it helped',
    kind: 'answered',
    definition:
      'A participant answered a warning "helpful" and "changed what I did". The operator\'s answer never counts, and nothing infers it.',
  },
  {
    key: 'repeat_use',
    number: 6,
    label: 'Repeat use on another day',
    kind: 'observed',
    definition: `Two first-work or verified-resume moments on different UTC days at least ${REPEAT_GAP_HOURS} hours apart. Not judged until the first one is ${REPEAT_OBSERVABLE_AFTER_HOURS} hours old, unless the repeat has already been seen.`,
  },
];

export const STAGE_KEYS = ACTIVATION_STAGES.map((stage) => stage.key);

export type ExclusionReason = 'test_workspace' | 'demo' | 'operator_only';
export const EXCLUSION_LABELS: Record<ExclusionReason, string> = {
  test_workspace: 'test workspace',
  demo: 'demo workspace',
  operator_only: 'no participant (operator, test or review accounts only)',
};

export type AccountExclusion = 'operator' | 'test' | 'reviewer';

/** The route the product writes when an operator builds the demo workspace. */
export const DEMO_ROUTE = 'POST /admin/users/:id/demo-workspace';

export interface StageReading {
  at: Date | null;
  /** Null when the stage was not reached; "implied" never carries a timestamp. */
  basis: 'observed' | 'implied' | null;
  source: string;
}

export interface WorkspaceActivation {
  teamId: string;
  stages: Record<StageKey, StageReading>;
  /** Which stages count as reached once the ladder is applied. */
  reached: Record<StageKey, boolean>;
  /** Distinct UTC dates of first-work or verified-resume moments, ascending. */
  repeatDays: string[];
  participants: number;
  diagnostics: {
    /** Participant runs, with or without a repository change: a run is not work. */
    participantRuns: number;
    /** Runs whose checkpoints show the repository changed. */
    changedRuns: number;
  };
}

const none = (): StageReading => ({ at: null, basis: null, source: 'not observed' });

/** One account judged for exclusion; operator wins nothing over test or reviewer here, all three are out. */
export function accountExclusion(
  env: Pick<Env, 'adminUsernames' | 'adminEmails'>,
  user: {
    username: string;
    email?: string | null;
    emailVerifiedAt?: Date | null;
    isTest?: boolean;
    reviewAccessUntil?: Date | null;
  },
): AccountExclusion | null {
  if (user.isTest || isTestEmail(user.email)) return 'test';
  if (user.reviewAccessUntil) return 'reviewer';
  // `isAdminUser` answers no for the first two, so ask the lists directly.
  if (isAdminUsername(env, user.username) || (user.emailVerifiedAt && isAdminEmail(env, user.email))) {
    return 'operator';
  }
  return null;
}

/** Excluded accounts among these ids. Absent from the map means a participant. */
export async function classifyAccounts(
  db: Db,
  env: Pick<Env, 'adminUsernames' | 'adminEmails'>,
  userIds: string[],
): Promise<Map<string, AccountExclusion>> {
  const out = new Map<string, AccountExclusion>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      emailVerifiedAt: users.emailVerifiedAt,
      isTest: users.isTest,
      reviewAccessUntil: users.reviewAccessUntil,
    })
    .from(users)
    .where(inArray(users.id, ids));
  for (const row of rows) {
    const reason = accountExclusion(env, row);
    if (reason) out.set(row.id, reason);
  }
  return out;
}

/**
 * Workspaces that are not customers. Absent from the map means eligible.
 *
 * Test beats demo beats operator-only when more than one applies. The demo is
 * recognised by the membership row the product itself writes when an operator
 * builds it (never age-swept, deleted with the workspace), not by its name,
 * which any customer could choose. A demo built before that table existed, or
 * one whose rows were erased, is caught by the other two rules when its owner
 * is a test account or nobody real is left, and the page says the marker is
 * the limit.
 */
export async function excludedWorkspaces(
  db: Db,
  env: Pick<Env, 'adminUsernames' | 'adminEmails'>,
  teamIds: string[],
): Promise<Map<string, ExclusionReason>> {
  const out = new Map<string, ExclusionReason>();
  if (teamIds.length === 0) return out;
  const [testTargets, demoRows, people, creators] = await Promise.all([
    db.select({ teamId: users.testWorkspaceId }).from(users).where(inArray(users.testWorkspaceId, teamIds)),
    db
      .select({ teamId: membershipChanges.teamId })
      .from(membershipChanges)
      .where(and(inArray(membershipChanges.teamId, teamIds), eq(membershipChanges.route, DEMO_ROUTE))),
    db
      .select({
        teamId: memberships.teamId,
        username: users.username,
        email: users.email,
        emailVerifiedAt: users.emailVerifiedAt,
        isTest: users.isTest,
        reviewAccessUntil: users.reviewAccessUntil,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(inArray(memberships.teamId, teamIds), humanMembership())),
    db
      .select({ id: teams.id, isTest: users.isTest })
      .from(teams)
      .leftJoin(users, eq(users.id, teams.createdBy))
      .where(inArray(teams.id, teamIds)),
  ]);
  const test = new Set(testTargets.map((row) => row.teamId).filter((id): id is string => Boolean(id)));
  for (const creator of creators) if (creator.isTest) test.add(creator.id);
  const demo = new Set(demoRows.map((row) => row.teamId));
  const hasParticipant = new Set(
    people.filter((person) => accountExclusion(env, person) === null).map((person) => person.teamId),
  );
  for (const id of teamIds) {
    if (test.has(id)) out.set(id, 'test_workspace');
    else if (demo.has(id)) out.set(id, 'demo');
    else if (!hasParticipant.has(id)) out.set(id, 'operator_only');
  }
  return out;
}

const dateKey = (at: Date) => at.toISOString().slice(0, 10);

/**
 * Whether the moments contain a repeat: two on different UTC days at least
 * `REPEAT_GAP_HOURS` apart. Checking each moment against the earliest is
 * enough, because the earliest has the widest gap to any later one and shares
 * a day with all of them only when nothing between could differ.
 */
export function repeatUse(moments: Date[]): { at: Date | null; days: string[] } {
  const sorted = [...moments].sort((a, b) => a.getTime() - b.getTime());
  const days = [...new Set(sorted.map(dateKey))];
  const first = sorted[0];
  if (!first) return { at: null, days };
  const later = sorted.find(
    (moment) => dateKey(moment) !== dateKey(first) && moment.getTime() - first.getTime() >= REPEAT_GAP_HOURS * HOUR,
  );
  return { at: later ?? null, days };
}

/** Apply the ladder: a stage counts once every earlier observed stage does. */
function applyLadder(stages: Record<StageKey, StageReading>): Record<StageKey, boolean> {
  const has = (key: StageKey) => stages[key].basis !== null;
  const s1 = has('setup_started');
  const s2 = s1 && has('authorised_connection');
  const s3 = s2 && has('first_real_work');
  const s4 = s3 && has('usable_evidence');
  return {
    setup_started: s1,
    authorised_connection: s2,
    first_real_work: s3,
    usable_evidence: s4,
    human_confirmed: s4 && has('human_confirmed'),
    repeat_use: s4 && has('repeat_use'),
  };
}

const earliest = (...values: Array<Date | null | undefined>): Date | null => {
  let best: Date | null = null;
  for (const value of values) if (value && (!best || value < best)) best = value;
  return best;
};

const passedClean = (row: { worktreeClean: boolean; tests: Array<{ state: string }> }) =>
  row.worktreeClean &&
  row.tests.some((test) => test.state === 'passed') &&
  !row.tests.some((test) => test.state === 'failed');

/**
 * Stage readings for these workspaces, as of `now`.
 *
 * A fixed number of queries whatever the count: one grouped read per source over
 * exactly these ids, then one read of the accounts that appear in them. Rows
 * stamped after `now` are ignored, so a reading made at a given instant gives
 * the same answer however late a report arrives afterwards.
 */
export async function workspaceActivation(
  db: Db,
  env: Pick<Env, 'adminUsernames' | 'adminEmails'>,
  teamIds: string[],
  now: Date = new Date(),
): Promise<{ byTeam: Map<string, WorkspaceActivation>; truncated: boolean }> {
  const byTeam = new Map<string, WorkspaceActivation>();
  if (teamIds.length === 0) return { byTeam, truncated: false };
  const ids = [...new Set(teamIds)];

  const [launches, credentials, enrollments, runGroups, checkpointRows, startRows, resumed, confirmations, members] =
    await Promise.all([
      db
        .select({
          teamId: launchAttempts.teamId,
          userId: launchAttempts.userId,
          opened: min(launchAttempts.createdAt),
          firstConnected: min(launchAttempts.firstConnectedAt),
        })
        .from(launchAttempts)
        .where(inArray(launchAttempts.teamId, ids))
        .groupBy(launchAttempts.teamId, launchAttempts.userId),
      db
        .select({
          teamId: tokens.teamId,
          userId: tokens.userId,
          issued: min(tokens.createdAt),
          activated: min(tokens.activatedAt),
        })
        .from(tokens)
        .where(and(inArray(tokens.teamId, ids), isNotNull(tokens.teamId)))
        .groupBy(tokens.teamId, tokens.userId),
      db
        .select({
          teamId: agentEnrollments.teamId,
          userId: agentEnrollments.userId,
          started: min(agentEnrollments.createdAt),
        })
        .from(agentEnrollments)
        .where(and(inArray(agentEnrollments.teamId, ids), isNotNull(agentEnrollments.teamId)))
        .groupBy(agentEnrollments.teamId, agentEnrollments.userId),
      db
        .select({
          teamId: agentRuns.teamId,
          userId: agentInstallations.userId,
          runs: count(),
        })
        .from(agentRuns)
        .innerJoin(agentInstallations, eq(agentInstallations.id, agentRuns.installationId))
        .where(inArray(agentRuns.teamId, ids))
        .groupBy(agentRuns.teamId, agentInstallations.userId),
      db
        .select({
          teamId: runCheckpoints.teamId,
          runId: runCheckpoints.runId,
          userId: agentInstallations.userId,
          commitSha: runCheckpoints.commitSha,
          worktreeClean: runCheckpoints.worktreeClean,
          tests: runCheckpoints.tests,
          createdAt: runCheckpoints.createdAt,
        })
        .from(runCheckpoints)
        .innerJoin(agentRuns, eq(agentRuns.id, runCheckpoints.runId))
        .innerJoin(agentInstallations, eq(agentInstallations.id, agentRuns.installationId))
        .where(
          and(
            inArray(runCheckpoints.teamId, ids),
            inArray(runCheckpoints.kind, ['delivery', 'tested']),
            isNotNull(agentRuns.projectId),
          ),
        )
        .orderBy(asc(runCheckpoints.createdAt))
        .limit(ACTIVATION_CHECKPOINT_SCAN + 1),
      db
        .select({ runId: runCheckpoints.runId, commitSha: runCheckpoints.commitSha })
        .from(runCheckpoints)
        .where(and(inArray(runCheckpoints.teamId, ids), eq(runCheckpoints.kind, 'start')))
        .orderBy(asc(runCheckpoints.createdAt))
        .limit(ACTIVATION_CHECKPOINT_SCAN + 1),
      db
        .select({
          teamId: debugSessions.teamId,
          offeredBy: handoffs.offeredBy,
          acceptedBy: handoffs.acceptedBy,
          resumedAt: handoffs.resumedAt,
        })
        .from(handoffs)
        .innerJoin(debugSessions, eq(debugSessions.id, handoffs.sessionId))
        .where(
          and(
            inArray(debugSessions.teamId, ids),
            eq(handoffs.kind, 'handoff'),
            isNotNull(handoffs.checkpointId),
            isNotNull(handoffs.resumedAt),
          ),
        ),
      db
        .select({
          teamId: savingConfirmations.teamId,
          userId: savingConfirmations.confirmedBy,
          at: min(savingConfirmations.createdAt),
        })
        .from(savingConfirmations)
        .where(
          and(
            inArray(savingConfirmations.teamId, ids),
            eq(savingConfirmations.helpful, true),
            eq(savingConfirmations.changedBehaviour, true),
          ),
        )
        .groupBy(savingConfirmations.teamId, savingConfirmations.confirmedBy),
      db
        .select({ teamId: memberships.teamId, userId: memberships.userId })
        .from(memberships)
        .where(and(inArray(memberships.teamId, ids), humanMembership())),
    ]);
  const startsTruncated = startRows.length > ACTIVATION_CHECKPOINT_SCAN;
  const truncated = checkpointRows.length > ACTIVATION_CHECKPOINT_SCAN || startsTruncated;

  const actors = new Set<string>();
  for (const row of [...launches, ...credentials, ...enrollments, ...runGroups, ...checkpointRows, ...members]) {
    if (row.userId) actors.add(row.userId);
  }
  for (const row of resumed) {
    actors.add(row.offeredBy);
    if (row.acceptedBy) actors.add(row.acceptedBy);
  }
  for (const row of confirmations) if (row.userId) actors.add(row.userId);
  const excluded = await classifyAccounts(db, env, [...actors]);
  const participant = (userId: string | null | undefined): userId is string =>
    Boolean(userId) && !excluded.has(userId!);
  const asOf = (at: Date | null | undefined): Date | null => (at && at.getTime() <= now.getTime() ? at : null);

  // Each run's own starting commit: the first start checkpoint it reported.
  const startCommit = new Map<string, string>();
  for (const row of startRows) if (!startCommit.has(row.runId)) startCommit.set(row.runId, row.commitSha);

  for (const teamId of ids) {
    const direct = {
      launchOpened: null as Date | null,
      launchConnected: null as Date | null,
      credentialIssued: null as Date | null,
      credentialActivated: null as Date | null,
      enrollment: null as Date | null,
    };
    for (const row of launches) {
      if (row.teamId !== teamId || !participant(row.userId)) continue;
      direct.launchOpened = earliest(direct.launchOpened, asOf(row.opened));
      direct.launchConnected = earliest(direct.launchConnected, asOf(row.firstConnected));
    }
    for (const row of credentials) {
      if (row.teamId !== teamId || !participant(row.userId)) continue;
      direct.credentialIssued = earliest(direct.credentialIssued, asOf(row.issued));
      direct.credentialActivated = earliest(direct.credentialActivated, asOf(row.activated));
    }
    for (const row of enrollments) {
      if (row.teamId !== teamId || !participant(row.userId)) continue;
      direct.enrollment = earliest(direct.enrollment, asOf(row.started));
    }
    const participantRuns = runGroups
      .filter((row) => row.teamId === teamId && participant(row.userId))
      .reduce((sum, row) => sum + Number(row.runs), 0);

    // Real work: per run, the first checkpoint on a commit the run did not start on.
    const changedByRun = new Map<string, { at: Date; usable: Date | null }>();
    for (const row of checkpointRows) {
      if (row.teamId !== teamId || !participant(row.userId)) continue;
      const at = asOf(row.createdAt);
      if (!at) continue;
      const start = startCommit.get(row.runId);
      if (start !== undefined && start === row.commitSha) continue;
      // The start checkpoints are read oldest first under a cap. When that cap
      // cut them off, a missing start is unknown and not "no start": counting it
      // would let a chat-only run pass as a repository change.
      if (start === undefined && startsTruncated) continue;
      const known = changedByRun.get(row.runId) ?? { at, usable: null };
      if (at < known.at) known.at = at;
      if (passedClean(row) && (!known.usable || at < known.usable)) known.usable = at;
      changedByRun.set(row.runId, known);
    }
    const resumes = resumed
      .filter(
        (row) =>
          row.teamId === teamId &&
          participant(row.offeredBy) &&
          (row.acceptedBy === null || participant(row.acceptedBy)) &&
          asOf(row.resumedAt),
      )
      .map((row) => row.resumedAt!);
    const firstWork = earliest(...[...changedByRun.values()].map((value) => value.at));
    const firstUsableCheckpoint = earliest(...[...changedByRun.values()].map((value) => value.usable));
    const firstResume = earliest(...resumes);
    const usable = earliest(firstUsableCheckpoint, firstResume);
    const confirmed = earliest(
      ...confirmations
        .filter((row) => row.teamId === teamId && participant(row.userId))
        .map((row) => asOf(row.at)),
    );
    const moments = [...[...changedByRun.values()].map((value) => value.at), ...resumes];
    const repeat = repeatUse(moments);

    const s1 = earliest(direct.launchOpened, direct.credentialIssued, direct.enrollment);
    const s2 = earliest(direct.credentialActivated, direct.launchConnected);
    const stages: Record<StageKey, StageReading> = {
      setup_started: s1
        ? { at: s1, basis: 'observed', source: 'a connection test, credential or enrollment issued here' }
        : none(),
      authorised_connection: s2
        ? { at: s2, basis: 'observed', source: 'a workspace credential activated or a test saw its first agent' }
        : none(),
      first_real_work: firstWork
        ? { at: firstWork, basis: 'observed', source: 'a delivery or tested checkpoint on a changed commit' }
        : none(),
      usable_evidence: usable
        ? {
            at: usable,
            basis: 'observed',
            source: firstResume && usable.getTime() === firstResume.getTime()
              ? 'a handoff resumed on its checkpoint commit'
              : 'a clean checkpoint with a passing test and no failing one',
          }
        : none(),
      human_confirmed: confirmed
        ? { at: confirmed, basis: 'observed', source: 'a participant answered helpful and changed what they did' }
        : none(),
      repeat_use: repeat.at
        ? { at: repeat.at, basis: 'observed', source: 'a second first-work or verified-resume moment on another UTC day' }
        : none(),
    };
    // A personal credential belongs to no workspace until it acts in one. When
    // the workspace has work but nothing tying a credential to it, the earlier
    // stages are implied by that work and carry no timestamp.
    const laterObserved = stages.first_real_work.basis !== null || participantRuns > 0;
    if (laterObserved && stages.setup_started.basis === null) {
      stages.setup_started = {
        at: null,
        basis: 'implied',
        source: 'a participant\'s agent ran here with a personal credential, which names no workspace',
      };
    }
    if (laterObserved && stages.authorised_connection.basis === null) {
      stages.authorised_connection = {
        at: null,
        basis: 'implied',
        source: 'a participant\'s agent ran here with a personal credential, which names no workspace',
      };
    }
    byTeam.set(teamId, {
      teamId,
      stages,
      reached: applyLadder(stages),
      repeatDays: repeat.days,
      participants: new Set(members.filter((row) => row.teamId === teamId && participant(row.userId)).map((row) => row.userId)).size,
      diagnostics: { participantRuns, changedRuns: changedByRun.size },
    });
  }
  return { byTeam, truncated };
}

// ---------------------------------------------------------------- cohorts

export interface StageCount {
  /** Workspaces that reached the stage (observed or implied). */
  reached: number;
  observed: number;
  implied: number;
  /** Workspaces this stage can be judged for. Repeat use leaves out the too-young. */
  of: number;
}

export interface CohortRow {
  /** Monday 00:00 UTC of the week the workspaces were created. */
  weekStart: Date | null;
  eligible: number;
  /** Distinct accounts that created the eligible workspaces. */
  creators: number;
  /** Fewer eligible workspaces than `ACTIVATION_SMALL_N`: print counts, not rates. */
  smallN: boolean;
  stages: Record<StageKey, StageCount>;
  /** Reached first work less than a day ago, so repeat use cannot be judged yet. */
  notYetObservable: number;
}

export interface ActivationCohorts {
  rows: CohortRow[];
  total: CohortRow;
  /** Workspaces read (newest first) and how many were left out of every denominator. */
  considered: number;
  excluded: { total: number; byReason: Record<ExclusionReason, number> };
  /** True when the instance has more workspaces than the cohort bound. */
  truncated: boolean;
  checkpointsTruncated: boolean;
  acquisition: 'unknown (not recorded)';
  at: Date;
}

const weekStartOf = (at: Date): Date => {
  const midnight = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  const sinceMonday = (new Date(midnight).getUTCDay() + 6) % 7;
  return new Date(midnight - sinceMonday * DAY);
};

const emptyCounts = (): Record<StageKey, StageCount> =>
  Object.fromEntries(STAGE_KEYS.map((key) => [key, { reached: 0, observed: 0, implied: 0, of: 0 }])) as Record<
    StageKey,
    StageCount
  >;

/** The eligible workspaces of the newest `ACTIVATION_COHORT_MAX`, by week of creation. */
export async function activationCohorts(
  db: Db,
  env: Pick<Env, 'adminUsernames' | 'adminEmails'>,
  now: Date = new Date(),
): Promise<ActivationCohorts> {
  const found = await db
    .select({ id: teams.id, createdAt: teams.createdAt, createdBy: teams.createdBy })
    .from(teams)
    .orderBy(sql`${teams.createdAt} desc`)
    .limit(ACTIVATION_COHORT_MAX + 1);
  const truncated = found.length > ACTIVATION_COHORT_MAX;
  const considered = found.slice(0, ACTIVATION_COHORT_MAX);
  const ids = considered.map((row) => row.id);
  const [out, activation] = await Promise.all([
    excludedWorkspaces(db, env, ids),
    workspaceActivation(db, env, ids, now),
  ]);
  const byReason: Record<ExclusionReason, number> = { test_workspace: 0, demo: 0, operator_only: 0 };
  for (const reason of out.values()) byReason[reason] += 1;

  const buckets = new Map<number, { row: CohortRow; creators: Set<string> }>();
  const all = { row: blankRow(null), creators: new Set<string>() };
  const bucketFor = (createdAt: Date) => {
    const start = weekStartOf(createdAt);
    let bucket = buckets.get(start.getTime());
    if (!bucket) {
      bucket = { row: blankRow(start), creators: new Set() };
      buckets.set(start.getTime(), bucket);
    }
    return bucket;
  };
  for (const workspace of considered) {
    if (out.has(workspace.id)) continue;
    const reading = activation.byTeam.get(workspace.id);
    if (!reading) continue;
    for (const bucket of [bucketFor(workspace.createdAt), all]) {
      bucket.row.eligible += 1;
      if (workspace.createdBy) bucket.creators.add(workspace.createdBy);
      for (const key of STAGE_KEYS) {
        const count = bucket.row.stages[key];
        // Too young to judge only while repeat use has not been seen: a workspace
        // that already returned on another day is observed, whatever its age.
        const young =
          key === 'repeat_use' &&
          !reading.reached.repeat_use &&
          reading.reached.first_real_work &&
          reading.stages.first_real_work.at !== null &&
          now.getTime() - reading.stages.first_real_work.at.getTime() < REPEAT_OBSERVABLE_AFTER_HOURS * HOUR;
        if (young) {
          bucket.row.notYetObservable += 1;
          continue;
        }
        // Repeat use is judged only for workspaces that did real work at all.
        if (key === 'repeat_use' && !reading.reached.first_real_work) continue;
        count.of += 1;
        if (reading.reached[key]) {
          count.reached += 1;
          if (reading.stages[key].basis === 'implied') count.implied += 1;
          else count.observed += 1;
        }
      }
    }
  }
  const finish = (bucket: { row: CohortRow; creators: Set<string> }) => {
    bucket.row.creators = bucket.creators.size;
    bucket.row.smallN = bucket.row.eligible < ACTIVATION_SMALL_N;
    return bucket.row;
  };
  const rows = [...buckets.entries()].sort((a, b) => b[0] - a[0]).map(([, bucket]) => finish(bucket));
  return {
    rows,
    total: finish(all),
    considered: considered.length,
    excluded: { total: out.size, byReason },
    truncated,
    checkpointsTruncated: activation.truncated,
    acquisition: 'unknown (not recorded)',
    at: now,
  };
}

function blankRow(weekStart: Date | null): CohortRow {
  return { weekStart, eligible: 0, creators: 0, smallN: true, stages: emptyCounts(), notYetObservable: 0 };
}
