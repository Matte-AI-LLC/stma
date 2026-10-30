import { and, count, desc, eq, gte, inArray, max, min, or, sql, sum } from 'drizzle-orm';
import type { Db } from '../db';
import {
  agentInstallations,
  agentRuns,
  debugSessions,
  handoffs,
  launchAttempts,
  memberships,
  messages,
  projects,
  runCheckpoints,
  teams,
  tokens,
  users,
  workAcceptances,
  workContextReads,
  workDeliveries,
  workEvidence,
  workExternalRefs,
  workItems,
  workRevisions,
} from '../db/schema';
import type { Env } from '../env';
import { isAdminUser } from '../lib/admin';
import { membershipHistory } from '../lib/memberships';
import {
  ACTIVATION_STAGES,
  EXCLUSION_LABELS,
  excludedWorkspaces,
  workspaceActivation,
  type ExclusionReason,
  type StageDefinition,
  type StageReading,
} from './activation';
import { providerFactsForCheckpoint } from './evidence';
import { providerName } from './evidenceSummary';
import { savingsLedger, type SavingsLedger } from './savings';

/**
 * One pilot workspace, read for the operator's weekly report.
 *
 * A pilot is judged on a chain that runs through one workspace over weeks:
 * connected, a first real result, a second use nobody prompted, four weeks of
 * use, payment, a second person or project. The operator console answered
 * almost none of it per workspace. `/admin/usage` totals the whole instance and
 * computes per-workspace rows only to add them up; `/admin/teams/:id` shows
 * members, projects and connections and nothing that happened. So the weekly
 * page a pilot is supposed to produce needed SQL, which in practice means it
 * would not be written.
 *
 * This is a reader over what is already stored, and it writes nothing. It keeps
 * three boundaries the pilot kit depends on:
 *
 *   - The operator's own hand is marked. A handoff the operator dispatched, or
 *     a run on the operator's agent, is not the participant using the product,
 *     and an "unprompted second use" cannot be read off a list that mixes them.
 *   - A handoff and an assignment are different things: one is work moving
 *     between agents with a commit, the other a lead starting somebody.
 *     `/admin/usage` counted both as handoffs.
 *   - What the database cannot know is listed rather than left out: reminders,
 *     the reviewer's decision, how much re-explaining was needed, support
 *     minutes and money. Those belong in the pilot record, and a sheet that
 *     omitted them silently would read as if they were zero.
 *
 * Read by `/admin` only, so `acceptance/tiers.json` lists it under consoleOnly.
 */

const DAY = 24 * 60 * 60 * 1000;
export const PILOT_DEFAULT_DAYS = 28;
/** A pilot's observation window is weeks, not a history scan; runs and handoffs are never swept. */
export const PILOT_MAX_DAYS = 182;
const WORK_ROWS = 50;
const DELIVERY_ROWS = 25;
const NATIVE_WORK_ROWS = 50;
/** Decisions are read for the window's totals; a pilot of five teams does not reach this. */
const NATIVE_DECISION_SCAN = 500;
const RUN_SCAN = 2000;
const LIVE = ['starting', 'active', 'waiting', 'blocked'];

/**
 * `?since=YYYY-MM-DD` (the pilot's first day), clamped; otherwise the four
 * weeks ending today. Every start is a UTC midnight, so the weekly rows are
 * whole days and only the last one — the week today is in — is partial; a start
 * taken from the clock left a trailing week a few seconds long.
 */
export function pilotWindow(since: string | undefined, now = new Date()): { since: Date; days: number } {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const floor = new Date(today - (PILOT_MAX_DAYS - 1) * DAY);
  const parsed = since && /^\d{4}-\d{2}-\d{2}$/.test(since) ? new Date(`${since}T00:00:00.000Z`) : null;
  const start =
    parsed && !Number.isNaN(parsed.getTime()) && parsed < now
      ? parsed < floor
        ? floor
        : parsed
      : new Date(today - (PILOT_DEFAULT_DAYS - 1) * DAY);
  return { since: start, days: Math.max(1, Math.ceil((now.getTime() - start.getTime()) / DAY)) };
}

export interface PilotWork {
  sessionId: string;
  kind: string;
  title: string;
  createdAt: Date;
  from: string;
  fromOperator: boolean;
  to: string | null;
  state: string;
  acceptedAt: Date | null;
  resumedAt: Date | null;
  completedAt: Date | null;
  /** A code handoff that reached resume: STMA refused every resume not on its commit. */
  verifiedResume: boolean;
  checkpoint: { sha: string; failed: string[]; reported: number } | null;
  /** Messages a person typed in the browser: help the participant or the operator gave. */
  browserReplies: number;
}

export interface PilotDelivery {
  runId: string;
  task: string | null;
  agent: string;
  owner: string;
  operator: boolean;
  kind: string;
  commitSha: string;
  clean: boolean;
  failed: string[];
  passed: number;
  /** "GitHub workflow success", one per current provider subject at this exact commit. */
  provider: string[];
  repositoryMatches: boolean;
  at: Date;
}

/** One Native Work item, as a pilot reads it: what it is, where it stands and what reading it cost. */
export interface PilotWorkItem {
  key: string;
  project: string;
  title: string;
  state: string;
  archived: boolean;
  createdAt: Date;
  /** `person` or `agent`, from the principal that filed it. */
  filedBy: 'person' | 'agent';
  /** Filed by the operator's own account, so not the participant using the product. */
  byOperator: boolean;
  /** `native`, or `external` when a tracker record owns its title and goal. */
  origin: string;
  /** How a GitHub issue is tied to it, when one is. */
  tracker: string | null;
  deliveries: number;
  firstDeliveryAt: Date | null;
  /** The newest recorded decision on it, a person's. */
  decision: {
    decision: string;
    at: Date;
    byOperator: boolean;
    standing: string | null;
    selfReview: boolean;
  } | null;
  /** Reads of its context package in the window, and the bytes they served. */
  contextReads: number;
  contextBytes: number;
}

/**
 * What the Native Work records say about a pilot. Counts of rows STMA wrote:
 * a delivery is its submitter's report, a decision is a person's, and the
 * context figures are bytes STMA served, not tokens a model consumed.
 */
export interface PilotNativeWork {
  items: {
    total: number;
    archived: number;
    byState: Record<string, number>;
    createdInWindow: number;
    filedByAgents: number;
    filedByOperator: number;
    withTracker: number;
  };
  deliveriesInWindow: number;
  decisions: {
    accepted: number;
    changesRequested: number;
    ownerOverrides: number;
    selfReviews: number;
    byOperator: number;
  };
  /**
   * Evidence rows recorded in the window, by who stands behind them. Provider
   * observations are read live from the connected repository when readiness is
   * computed and are not copied into the work, so they are not counted here.
   */
  evidence: { agentReported: number; humanDecision: number };
  context: {
    reads: number;
    bytes: number;
    averageBytes: number | null;
    largestBytes: number | null;
    /** Reads that could not fit every item in the budget and answered with a continuation. */
    incomplete: number;
    byAgents: number;
    byPeople: number;
    /** Works accepted whose context was read in the window, and the average bytes read per such work. */
    acceptedWorks: number;
    bytesPerAcceptedWork: number | null;
  };
  rows: PilotWorkItem[];
  rowsTruncated: boolean;
}

export interface PilotWeek {
  from: Date;
  to: Date;
  runs: number;
  operatorRuns: number;
  people: number;
  agents: number;
  handoffs: number;
  assignments: number;
  resumed: number;
  verifiedResumes: number;
  completed: number;
}

/** One stage of the first value path for this workspace, with where it was read from. */
export interface PilotStage extends StageDefinition, StageReading {
  /** Reached once every earlier observed stage is. */
  reached: boolean;
}

export interface PilotActivation {
  /** Why this workspace is left out of every cohort, when it is. */
  excluded: { reason: ExclusionReason; label: string } | null;
  stages: PilotStage[];
  repeatDays: string[];
  participants: number;
  runs: { participant: number; withRepositoryChange: number };
  /** True when more checkpoints existed than were read. */
  truncated: boolean;
}

export interface PilotSheet {
  team: { id: string; name: string; slug: string; createdAt: Date };
  window: { since: Date; until: Date; days: number };
  people: { username: string; role: string; joinedAt: Date; operator: boolean }[];
  connections: {
    name: string;
    client: string;
    device: string | null;
    owner: string;
    operator: boolean;
    createdAt: Date;
    lastUsedAt: Date | null;
    revoked: boolean;
  }[];
  launches: {
    by: string;
    intent: string;
    createdAt: Date;
    firstConnectedAt: Date | null;
    secondConnectedAt: Date | null;
    exchangeConfirmedAt: Date | null;
    firstRealResultAt: Date | null;
  }[];
  work: PilotWork[];
  workTotals: {
    handoffs: number;
    assignments: number;
    byOperator: number;
    resumed: number;
    verifiedResumes: number;
    completed: number;
    cancelledOrDeclined: number;
  };
  deliveries: PilotDelivery[];
  nativeWork: PilotNativeWork;
  warnings: SavingsLedger;
  activation: PilotActivation;
  weeks: PilotWeek[];
  expansion: {
    access: { at: Date; action: string; who: string; role: string | null; source: string }[];
    projects: { name: string; createdAt: Date }[];
  };
  runsScanned: number;
  runsTruncated: boolean;
}

/** Things a pilot is judged on that STMA does not see. Named on the page and in the export. */
export const PILOT_NOT_RECORDED = [
  'Founder reminders, and whether a use was prompted: needed to call a second use unprompted.',
  'Whether a need arose at all: NO_OPPORTUNITY and DID_NOT_RETURN look identical here.',
  "The reviewer's decision and which fact changed it; the evidence pack records no human decision.",
  'How much the receiver had to be told again, and help given outside the product.',
  'Support minutes, by kind.',
  'The commercial offer shown, and whether money was collected (Stripe status is on /admin/billing).',
  'Consent to quote the participant.',
  'Tool retries and re-reads of one work item: a retried request id is one receipt, so a retry is not counted, and every read of a context package is one row whether or not the agent needed it.',
  'Tokens: the context figures are UTF-8 bytes STMA served, not what a model consumed, and a read made by a client outside STMA (a copied export, a pasted answer) is not seen.',
  "Whether a delivery's evidence was right: STMA records the readiness it computed and the decision a person made, not whether the person was correct.",
] as const;

/**
 * The Native Work half of the sheet. Every figure is a count of rows STMA
 * wrote, read in a fixed number of queries whatever the workspace holds.
 *
 * What it keeps apart is the pilot kit's whole point. A delivery is what its
 * submitter said it was. A decision is a person's, and the sheet records the
 * standing it was made under (the acceptor, or an owner overriding) and whether
 * the person who decided was also the one who produced the work. Context bytes
 * are what STMA served to a reader, which is a cost of reading and says nothing
 * about whether the reading helped. `work_context_reads` is trimmed to its newest
 * 50,000 rows for the whole instance, so a long window on a busy server may
 * undercount, and the page says so.
 */
async function nativeWorkReading(
  db: Db,
  teamId: string,
  since: Date,
  operatorIds: Set<string>,
  isOperator: (ids: string[]) => Promise<void>,
): Promise<PilotNativeWork> {
  const filed = await db
    .select({
      state: workItems.state,
      archived: sql<number>`count(*) filter (where ${workItems.archivedAt} is not null)`.mapWith(Number),
      total: count(),
    })
    .from(workItems)
    .where(eq(workItems.teamId, teamId))
    .groupBy(workItems.state);
  const byState: Record<string, number> = {};
  let archived = 0;
  let total = 0;
  for (const row of filed) {
    byState[row.state] = row.total;
    archived += row.archived;
    total += row.total;
  }

  const createdBy = await db
    .select({ kind: workItems.createdByKind, userId: workItems.createdByUserId, n: count() })
    .from(workItems)
    .where(and(eq(workItems.teamId, teamId), gte(workItems.createdAt, since)))
    .groupBy(workItems.createdByKind, workItems.createdByUserId);
  await isOperator(createdBy.map((row) => row.userId).filter((id): id is string => Boolean(id)));
  const createdInWindow = createdBy.reduce((sum, row) => sum + row.n, 0);
  const filedByAgents = createdBy.filter((row) => row.kind === 'agent').reduce((sum, row) => sum + row.n, 0);
  const filedByOperator = createdBy
    .filter((row) => row.kind === 'human' && row.userId && operatorIds.has(row.userId))
    .reduce((sum, row) => sum + row.n, 0);

  const [withTracker] = await db
    .select({ n: count() })
    .from(workExternalRefs)
    .where(and(eq(workExternalRefs.teamId, teamId), sql`${workExternalRefs.detachedAt} is null`));

  const [delivered] = await db
    .select({ n: count() })
    .from(workDeliveries)
    .innerJoin(workItems, eq(workItems.id, workDeliveries.workId))
    .where(and(eq(workItems.teamId, teamId), gte(workDeliveries.submittedAt, since)));

  const decisionRows = await db
    .select({
      decision: workAcceptances.decision,
      actorUserId: workAcceptances.actorUserId,
      scope: workAcceptances.actorScopeSnapshot,
    })
    .from(workAcceptances)
    .innerJoin(workItems, eq(workItems.id, workAcceptances.workId))
    .where(and(eq(workItems.teamId, teamId), gte(workAcceptances.createdAt, since)))
    .orderBy(desc(workAcceptances.createdAt))
    .limit(NATIVE_DECISION_SCAN);
  await isOperator(decisionRows.map((row) => row.actorUserId).filter((id): id is string => Boolean(id)));
  const standingOf = (scope: unknown): string | null => {
    const standing = scope && typeof scope === 'object' ? (scope as { standing?: unknown }).standing : undefined;
    return typeof standing === 'string' ? standing : null;
  };
  const selfReviewOf = (scope: unknown) =>
    Boolean(scope && typeof scope === 'object' && (scope as { self_review?: unknown }).self_review === true);
  const decisions = {
    accepted: decisionRows.filter((row) => row.decision === 'accept').length,
    changesRequested: decisionRows.filter((row) => row.decision === 'request_changes').length,
    ownerOverrides: decisionRows.filter((row) => standingOf(row.scope) === 'owner_override').length,
    selfReviews: decisionRows.filter((row) => selfReviewOf(row.scope)).length,
    byOperator: decisionRows.filter((row) => row.actorUserId && operatorIds.has(row.actorUserId)).length,
  };

  const evidenceRows = await db
    .select({ provenance: workEvidence.provenance, n: count() })
    .from(workEvidence)
    .innerJoin(workItems, eq(workItems.id, workEvidence.workId))
    .where(and(eq(workItems.teamId, teamId), gte(workEvidence.recordedAt, since)))
    .groupBy(workEvidence.provenance);
  const evidenceCount = (provenance: string) => evidenceRows.find((row) => row.provenance === provenance)?.n ?? 0;

  const readRows = await db
    .select({
      kind: workContextReads.principalKind,
      reads: count(),
      bytes: sum(workContextReads.bytes).mapWith(Number),
      largest: max(workContextReads.bytes),
      incomplete: sql<number>`count(*) filter (where ${workContextReads.incomplete})`.mapWith(Number),
    })
    .from(workContextReads)
    .where(and(eq(workContextReads.teamId, teamId), gte(workContextReads.createdAt, since)))
    .groupBy(workContextReads.principalKind);
  const reads = readRows.reduce((acc, row) => acc + row.reads, 0);
  const bytes = readRows.reduce((acc, row) => acc + (row.bytes ?? 0), 0);
  const perAccepted = await db
    .select({ workId: workContextReads.workId, bytes: sum(workContextReads.bytes).mapWith(Number) })
    .from(workContextReads)
    .innerJoin(workItems, eq(workItems.id, workContextReads.workId))
    .where(
      and(eq(workContextReads.teamId, teamId), gte(workContextReads.createdAt, since), eq(workItems.state, 'accepted')),
    )
    .groupBy(workContextReads.workId);

  // The rows: everything filed in the window plus anything that moved in it.
  const itemRows = await db
    .select({ item: workItems, title: workRevisions.title, project: projects.name })
    .from(workItems)
    .innerJoin(
      workRevisions,
      and(eq(workRevisions.workId, workItems.id), eq(workRevisions.revision, workItems.specRevision)),
    )
    .innerJoin(projects, eq(projects.id, workItems.projectId))
    .where(and(eq(workItems.teamId, teamId), or(gte(workItems.createdAt, since), gte(workItems.updatedAt, since))))
    .orderBy(desc(workItems.updatedAt))
    .limit(NATIVE_WORK_ROWS + 1);
  const rowsTruncated = itemRows.length > NATIVE_WORK_ROWS;
  const shown = itemRows.slice(0, NATIVE_WORK_ROWS);
  const ids = shown.map((row) => row.item.id);
  const [deliveryRows, trackerRows, decidedRows, readByWork] = ids.length
    ? await Promise.all([
        db
          .select({ workId: workDeliveries.workId, n: count(), first: min(workDeliveries.submittedAt) })
          .from(workDeliveries)
          .where(inArray(workDeliveries.workId, ids))
          .groupBy(workDeliveries.workId),
        db
          .select({ workId: workExternalRefs.workId, mode: workExternalRefs.mode })
          .from(workExternalRefs)
          .where(and(inArray(workExternalRefs.workId, ids), sql`${workExternalRefs.detachedAt} is null`)),
        db
          .select({
            workId: workAcceptances.workId,
            decision: workAcceptances.decision,
            actorUserId: workAcceptances.actorUserId,
            scope: workAcceptances.actorScopeSnapshot,
            at: workAcceptances.createdAt,
          })
          .from(workAcceptances)
          .where(inArray(workAcceptances.workId, ids))
          .orderBy(desc(workAcceptances.createdAt))
          .limit(NATIVE_DECISION_SCAN),
        db
          .select({ workId: workContextReads.workId, reads: count(), bytes: sum(workContextReads.bytes).mapWith(Number) })
          .from(workContextReads)
          .where(and(inArray(workContextReads.workId, ids), gte(workContextReads.createdAt, since)))
          .groupBy(workContextReads.workId),
      ])
    : [[], [], [], []];
  await isOperator(decidedRows.map((row) => row.actorUserId).filter((id): id is string => Boolean(id)));
  await isOperator(shown.map((row) => row.item.createdByUserId).filter((id): id is string => Boolean(id)));
  const rows: PilotWorkItem[] = shown.map(({ item, title, project }) => {
    const first = deliveryRows.find((row) => row.workId === item.id);
    const decided = decidedRows.find((row) => row.workId === item.id);
    const read = readByWork.find((row) => row.workId === item.id);
    return {
      key: item.displayKey,
      project,
      title,
      state: item.state,
      archived: item.archivedAt !== null,
      createdAt: item.createdAt,
      filedBy: item.createdByKind === 'agent' ? 'agent' : 'person',
      byOperator: Boolean(item.createdByKind === 'human' && item.createdByUserId && operatorIds.has(item.createdByUserId)),
      origin: item.origin,
      tracker: trackerRows.find((row) => row.workId === item.id)?.mode ?? null,
      deliveries: first?.n ?? 0,
      firstDeliveryAt: first?.first ? new Date(first.first) : null,
      decision: decided
        ? {
            decision: decided.decision,
            at: decided.at,
            byOperator: Boolean(decided.actorUserId && operatorIds.has(decided.actorUserId)),
            standing: standingOf(decided.scope),
            selfReview: selfReviewOf(decided.scope),
          }
        : null,
      contextReads: read?.reads ?? 0,
      contextBytes: read?.bytes ?? 0,
    };
  });

  return {
    items: {
      total,
      archived,
      byState,
      createdInWindow,
      filedByAgents,
      filedByOperator,
      withTracker: withTracker?.n ?? 0,
    },
    deliveriesInWindow: delivered?.n ?? 0,
    decisions,
    evidence: {
      agentReported: evidenceCount('agent_reported'),
      humanDecision: evidenceCount('human_decision'),
    },
    context: {
      reads,
      bytes,
      averageBytes: reads ? Math.round(bytes / reads) : null,
      largestBytes: readRows.length ? Math.max(...readRows.map((row) => Number(row.largest ?? 0))) : null,
      incomplete: readRows.reduce((acc, row) => acc + row.incomplete, 0),
      byAgents: readRows.filter((row) => row.kind === 'agent').reduce((acc, row) => acc + row.reads, 0),
      byPeople: readRows.filter((row) => row.kind === 'human').reduce((acc, row) => acc + row.reads, 0),
      acceptedWorks: perAccepted.length,
      bytesPerAcceptedWork: perAccepted.length
        ? Math.round(perAccepted.reduce((acc, row) => acc + (row.bytes ?? 0), 0) / perAccepted.length)
        : null,
    },
    rows,
    rowsTruncated,
  };
}

export async function pilotSheet(
  db: Db,
  env: Pick<Env, 'adminUsernames' | 'adminEmails'>,
  teamId: string,
  window: { since: Date; days: number },
  now = new Date(),
): Promise<PilotSheet | null> {
  const [team] = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
  if (!team) return null;
  const since = window.since;

  const memberRows = await db
    .select({ user: users, role: memberships.role, joinedAt: memberships.createdAt })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.teamId, teamId))
    .orderBy(users.username);
  const operatorIds = new Set(
    memberRows.filter((row) => isAdminUser(env, row.user)).map((row) => row.user.id),
  );
  // An operator may act in a workspace without being a member of it (an
  // assignment through /admin, a removed account); ask the users table too.
  const isOperator = async (ids: string[]) => {
    const unknown = [...new Set(ids)].filter((id) => !memberRows.some((row) => row.user.id === id));
    if (unknown.length > 0) {
      const extra = await db.select().from(users).where(inArray(users.id, unknown));
      for (const user of extra) if (isAdminUser(env, user)) operatorIds.add(user.id);
    }
  };

  const connectionRows = await db
    .select({
      name: tokens.name,
      installationName: agentInstallations.name,
      client: agentInstallations.clientType,
      device: agentInstallations.deviceLabel,
      owner: users.username,
      ownerId: users.id,
      createdAt: tokens.createdAt,
      lastUsedAt: tokens.lastUsedAt,
      tokenRevokedAt: tokens.revokedAt,
      installationRevokedAt: agentInstallations.revokedAt,
    })
    .from(tokens)
    .innerJoin(users, eq(users.id, tokens.userId))
    .leftJoin(agentInstallations, eq(agentInstallations.tokenId, tokens.id))
    .where(eq(tokens.teamId, teamId))
    .orderBy(desc(tokens.createdAt))
    .limit(50);

  const launchRows = await db
    .select({ launch: launchAttempts, by: users.username })
    .from(launchAttempts)
    .innerJoin(users, eq(users.id, launchAttempts.userId))
    .where(eq(launchAttempts.teamId, teamId))
    .orderBy(desc(launchAttempts.createdAt))
    .limit(20);

  // Work: everything created in the window, plus anything that moved in it.
  const workRows = await db
    .select({
      offer: handoffs,
      title: debugSessions.title,
      from: users.username,
      checkpointSha: runCheckpoints.commitSha,
      checkpointTests: runCheckpoints.tests,
    })
    .from(handoffs)
    .innerJoin(debugSessions, eq(debugSessions.id, handoffs.sessionId))
    .innerJoin(users, eq(users.id, handoffs.offeredBy))
    .leftJoin(runCheckpoints, eq(runCheckpoints.id, handoffs.checkpointId))
    .where(
      and(
        eq(debugSessions.teamId, teamId),
        or(gte(handoffs.createdAt, since), gte(handoffs.updatedAt, since)),
      ),
    )
    .orderBy(desc(handoffs.createdAt))
    .limit(WORK_ROWS);
  await isOperator(workRows.map((row) => row.offer.offeredBy));
  const targetIds = [
    ...new Set(
      workRows.flatMap((row) => [row.offer.targetInstallationId, row.offer.installationId]).filter((id): id is string => Boolean(id)),
    ),
  ];
  const targets = targetIds.length
    ? await db
        .select({ id: agentInstallations.id, name: agentInstallations.name, device: agentInstallations.deviceLabel })
        .from(agentInstallations)
        .where(inArray(agentInstallations.id, targetIds))
    : [];
  const targetName = new Map(targets.map((row) => [row.id, `${row.name}${row.device ? ` on ${row.device}` : ''}`]));
  const targetUserIds = [...new Set(workRows.map((row) => row.offer.targetUserId).filter((id): id is string => Boolean(id)))];
  const targetUsers = targetUserIds.length
    ? await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, targetUserIds))
    : [];
  const userName = new Map(targetUsers.map((row) => [row.id, row.username]));
  const sessionIds = workRows.map((row) => row.offer.sessionId);
  const browserRows = sessionIds.length
    ? await db
        .select({ sessionId: messages.sessionId })
        .from(messages)
        .where(and(inArray(messages.sessionId, sessionIds), eq(messages.via, 'web')))
    : [];
  const browserReplies = new Map<string, number>();
  for (const row of browserRows) browserReplies.set(row.sessionId, (browserReplies.get(row.sessionId) ?? 0) + 1);

  const work: PilotWork[] = workRows.map((row) => {
    const tests = row.checkpointTests ?? [];
    return {
      sessionId: row.offer.sessionId,
      kind: row.offer.kind,
      title: row.title,
      createdAt: row.offer.createdAt,
      from: row.from,
      fromOperator: operatorIds.has(row.offer.offeredBy),
      to:
        (row.offer.targetInstallationId && targetName.get(row.offer.targetInstallationId)) ??
        (row.offer.installationId && targetName.get(row.offer.installationId)) ??
        (row.offer.targetUserId && userName.get(row.offer.targetUserId)) ??
        null,
      state: row.offer.state,
      acceptedAt: row.offer.acceptedAt,
      resumedAt: row.offer.resumedAt,
      completedAt: row.offer.completedAt,
      verifiedResume: Boolean(row.offer.checkpointId && row.offer.resumedAt),
      checkpoint: row.checkpointSha
        ? {
            sha: row.checkpointSha,
            failed: tests.filter((test) => test.state === 'failed').map((test) => test.name),
            reported: tests.length,
          }
        : null,
      browserReplies: browserReplies.get(row.offer.sessionId) ?? 0,
    };
  });
  const inWindow = work.filter((row) => row.createdAt >= since);

  // Delivery: the newest delivery/tested checkpoint of each run that reported one in the window.
  const checkpointRows = await db
    .select({
      checkpoint: runCheckpoints,
      run: agentRuns,
      agent: agentInstallations.name,
      ownerId: agentInstallations.userId,
      owner: users.username,
      projectRepositoryIdentity: projects.repositoryIdentity,
    })
    .from(runCheckpoints)
    .innerJoin(agentRuns, eq(agentRuns.id, runCheckpoints.runId))
    .innerJoin(agentInstallations, eq(agentInstallations.id, agentRuns.installationId))
    .innerJoin(users, eq(users.id, agentInstallations.userId))
    .leftJoin(projects, eq(projects.id, agentRuns.projectId))
    .where(
      and(
        eq(runCheckpoints.teamId, teamId),
        inArray(runCheckpoints.kind, ['delivery', 'tested']),
        gte(runCheckpoints.createdAt, since),
      ),
    )
    .orderBy(desc(runCheckpoints.createdAt))
    .limit(DELIVERY_ROWS * 4);
  await isOperator(checkpointRows.map((row) => row.ownerId));
  const newestPerRun = new Map<string, (typeof checkpointRows)[number]>();
  for (const row of checkpointRows) if (!newestPerRun.has(row.run.id)) newestPerRun.set(row.run.id, row);
  const deliveries: PilotDelivery[] = [];
  for (const row of [...newestPerRun.values()].slice(0, DELIVERY_ROWS)) {
    const facts = await providerFactsForCheckpoint(db, row.run, row.projectRepositoryIdentity, row.checkpoint);
    deliveries.push({
      runId: row.run.id,
      task: row.run.taskKey ?? row.run.intent,
      agent: row.agent,
      owner: row.owner,
      operator: operatorIds.has(row.ownerId),
      kind: row.checkpoint.kind,
      commitSha: row.checkpoint.commitSha,
      clean: row.checkpoint.worktreeClean,
      failed: row.checkpoint.tests.filter((test) => test.state === 'failed').map((test) => test.name),
      passed: row.checkpoint.tests.filter((test) => test.state === 'passed').length,
      provider: facts.facts.map(
        (fact) => `${providerName(fact.provider)} ${fact.fact.kind === 'pull_request' ? 'pull request' : 'workflow'} ${fact.fact.state}`,
      ),
      repositoryMatches: facts.repositoryMatches,
      at: row.checkpoint.createdAt,
    });
  }

  // The weekly series is read from runs and handoffs, which no sweep removes.
  const runRows = await db
    .select({
      startedAt: agentRuns.startedAt,
      lastHeartbeatAt: agentRuns.lastHeartbeatAt,
      installationId: agentRuns.installationId,
      userId: agentInstallations.userId,
    })
    .from(agentRuns)
    .innerJoin(agentInstallations, eq(agentInstallations.id, agentRuns.installationId))
    .where(and(eq(agentRuns.teamId, teamId), gte(agentRuns.lastHeartbeatAt, since)))
    .orderBy(desc(agentRuns.startedAt))
    .limit(RUN_SCAN + 1);
  const runsTruncated = runRows.length > RUN_SCAN;
  const runs = runRows.slice(0, RUN_SCAN);
  await isOperator(runs.map((row) => row.userId));
  const weeks: PilotWeek[] = [];
  for (let from = since.getTime(); from < now.getTime(); from += 7 * DAY) {
    const to = Math.min(from + 7 * DAY, now.getTime());
    const within = (at: Date | null) => Boolean(at && at.getTime() >= from && at.getTime() < to);
    const started = runs.filter((row) => within(row.startedAt));
    const active = runs.filter(
      (row) => row.startedAt.getTime() < to && row.lastHeartbeatAt.getTime() >= from,
    );
    const participant = active.filter((row) => !operatorIds.has(row.userId));
    weeks.push({
      from: new Date(from),
      to: new Date(to),
      runs: started.filter((row) => !operatorIds.has(row.userId)).length,
      operatorRuns: started.filter((row) => operatorIds.has(row.userId)).length,
      people: new Set(participant.map((row) => row.userId)).size,
      agents: new Set(participant.map((row) => row.installationId)).size,
      handoffs: work.filter((row) => row.kind === 'handoff' && within(row.createdAt)).length,
      assignments: work.filter((row) => row.kind === 'assignment' && within(row.createdAt)).length,
      resumed: work.filter((row) => within(row.resumedAt)).length,
      verifiedResumes: work.filter((row) => row.verifiedResume && within(row.resumedAt)).length,
      completed: work.filter((row) => within(row.completedAt)).length,
    });
  }

  const access = (await membershipHistory(db, { teamId, limit: 200 }))
    .filter((row) => row.at >= since)
    .map((row) => ({
      at: row.at,
      action: row.action,
      who: row.subjectUsername ?? row.subjectLabel ?? 'former account',
      role: row.nextRole ?? row.previousRole ?? null,
      source: row.source,
    }));
  const newProjects = await db
    .select({ name: projects.name, createdAt: projects.createdAt })
    .from(projects)
    .where(and(eq(projects.teamId, teamId), gte(projects.createdAt, since)))
    .orderBy(projects.createdAt);

  const [reading, exclusion] = await Promise.all([
    workspaceActivation(db, env, [teamId], now),
    excludedWorkspaces(db, env, [teamId]),
  ]);
  const path = reading.byTeam.get(teamId)!;
  const excludedReason = exclusion.get(teamId) ?? null;
  const activation: PilotActivation = {
    excluded: excludedReason ? { reason: excludedReason, label: EXCLUSION_LABELS[excludedReason] } : null,
    stages: ACTIVATION_STAGES.map((stage) => ({ ...stage, ...path.stages[stage.key], reached: path.reached[stage.key] })),
    repeatDays: path.repeatDays,
    participants: path.participants,
    runs: { participant: path.diagnostics.participantRuns, withRepositoryChange: path.diagnostics.changedRuns },
    truncated: reading.truncated,
  };

  const nativeWork = await nativeWorkReading(db, teamId, since, operatorIds, isOperator);

  return {
    team: { id: team.id, name: team.name, slug: team.slug, createdAt: team.createdAt },
    window: { since, until: now, days: window.days },
    people: memberRows.map((row) => ({
      username: row.user.username,
      role: row.role,
      joinedAt: row.joinedAt,
      operator: operatorIds.has(row.user.id),
    })),
    connections: connectionRows.map((row) => ({
      name: row.installationName ?? row.name,
      client: row.client ?? 'credential',
      device: row.device,
      owner: row.owner,
      operator: operatorIds.has(row.ownerId),
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      revoked: Boolean(row.tokenRevokedAt || row.installationRevokedAt),
    })),
    launches: launchRows.map((row) => ({
      by: row.by,
      intent: row.launch.intent,
      createdAt: row.launch.createdAt,
      firstConnectedAt: row.launch.firstConnectedAt,
      secondConnectedAt: row.launch.secondConnectedAt,
      exchangeConfirmedAt: row.launch.exchangeConfirmedAt,
      firstRealResultAt: row.launch.firstRealResultAt,
    })),
    work,
    workTotals: {
      handoffs: inWindow.filter((row) => row.kind === 'handoff').length,
      assignments: inWindow.filter((row) => row.kind === 'assignment').length,
      byOperator: inWindow.filter((row) => row.fromOperator).length,
      resumed: work.filter((row) => row.resumedAt && row.resumedAt >= since).length,
      verifiedResumes: work.filter((row) => row.verifiedResume && row.resumedAt! >= since).length,
      completed: work.filter((row) => row.completedAt && row.completedAt >= since).length,
      cancelledOrDeclined: inWindow.filter((row) => row.state === 'cancelled' || row.state === 'declined').length,
    },
    deliveries,
    nativeWork,
    warnings: await savingsLedger(db, teamId, window.days),
    activation,
    weeks,
    expansion: { access, projects: newProjects },
    runsScanned: runs.length,
    runsTruncated,
  };
}

const day = (at: Date | null | undefined) => (at ? at.toISOString().slice(0, 10) : '-');
const stamp = (at: Date | null | undefined) => (at ? at.toISOString().slice(0, 16).replace('T', ' ') : '-');
const cell = (value: string | null | undefined) => (value ?? '-').replace(/\|/g, '/').replace(/\s+/g, ' ').trim() || '-';

/** Whole hours from a work item being filed to its first delivery, or null. */
export const hoursToFirstDelivery = (row: Pick<PilotWorkItem, 'createdAt' | 'firstDeliveryAt'>): number | null =>
  row.firstDeliveryAt ? Math.max(0, Math.round((row.firstDeliveryAt.getTime() - row.createdAt.getTime()) / 3_600_000)) : null;

const bytesLabel = (value: number | null) =>
  value === null ? '-' : value >= 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${value} B`;

/** What a decision row says about who made it and under what standing, in words. */
export const decisionLabel = (decision: NonNullable<PilotWorkItem['decision']>): string =>
  `${decision.decision === 'accept' ? 'accepted' : 'changes requested'} ${stamp(decision.at)}${
    decision.byOperator ? ' (operator)' : ''
  }${decision.standing === 'owner_override' ? ', owner override' : ''}${decision.selfReview ? ', the reviewer also produced the work' : ''}`;

/**
 * The Native Work part of the report, as Markdown lines. Counts of rows STMA
 * wrote, with the half it cannot know named in the closing list of the sheet.
 */
function nativeWorkMarkdown(native: PilotNativeWork): string[] {
  const out: string[] = [];
  const items = native.items;
  const states = Object.entries(items.byState)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([state, n]) => `${n} ${state.replace('_', ' ')}`);
  out.push('## Native Work');
  out.push(
    `${items.total} work item(s) in the workspace${items.archived ? ` (${items.archived} archived)` : ''}${states.length ? `: ${states.join(', ')}` : ''}. ${items.createdInWindow} filed in the window, ${items.filedByAgents} of them by an agent and ${items.filedByOperator} by the operator; ${items.withTracker} tied to a GitHub issue now.`,
  );
  const d = native.decisions;
  out.push(
    `In the window: ${native.deliveriesInWindow} delivery(ies) (each is its submitter's report); ${d.accepted} accepted and ${d.changesRequested} sent back by a person (${d.ownerOverrides} by an owner overriding the acceptor, ${d.selfReviews} where the reviewer also produced the work, ${d.byOperator} by the operator). Evidence rows recorded: ${native.evidence.agentReported} reported by an agent and ${native.evidence.humanDecision} from a person's check inside a decision (a provider's observation is read from the repository when readiness is computed and is not copied into the work, so it is not counted here).`,
  );
  const c = native.context;
  out.push(
    `Context served: ${c.reads} read(s), ${bytesLabel(c.bytes)} in all (${bytesLabel(c.averageBytes)} on average, ${bytesLabel(c.largestBytes)} the largest), ${c.byAgents} by agents and ${c.byPeople} by people, ${c.incomplete} that did not fit the budget and ended with a continuation. ${c.acceptedWorks ? `${c.acceptedWorks} accepted work item(s) were read, ${bytesLabel(c.bytesPerAcceptedWork)} each on average.` : 'No accepted work item was read in the window.'} Bytes are what STMA served, not tokens a model used; the instance keeps only its newest 50,000 reads, so a long window on a busy server may undercount.`,
  );
  out.push('');
  if (native.rows.length > 0) {
    out.push('| Filed | Key | Title | Project | State | Filed by | Origin | Deliveries | First delivery | Decision | Context |');
    out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const row of native.rows) {
      const hours = hoursToFirstDelivery(row);
      out.push(
        `| ${stamp(row.createdAt)} | ${row.key} | ${cell(row.title)} | ${cell(row.project)} | ${row.state.replace('_', ' ')}${row.archived ? ' (archived)' : ''} | ${row.filedBy}${row.byOperator ? ' (operator)' : ''} | ${row.origin}${row.tracker ? `, GitHub ${row.tracker.replace('_', ' ')}` : ''} | ${row.deliveries} | ${row.firstDeliveryAt ? `${stamp(row.firstDeliveryAt)} (${hours} h after filing)` : '-'} | ${row.decision ? decisionLabel(row.decision) : '-'} | ${row.contextReads} read(s), ${bytesLabel(row.contextBytes)} |`,
      );
    }
    if (native.rowsTruncated) out.push('Only the most recently changed work items are listed.');
    out.push('');
  } else {
    out.push('- No work item was filed or changed in the window.');
    out.push('');
  }
  return out;
}

/**
 * The sheet as Markdown, for the weekly one-page report. The report adds what
 * only people know; this is the half the database can answer, with the other
 * half named at the end rather than implied.
 */
export function pilotSheetMarkdown(sheet: PilotSheet, plan: string): string {
  const out: string[] = [];
  const liveRuns = sheet.weeks.reduce((sum, week) => sum + week.runs, 0);
  out.push(`# Pilot sheet: ${sheet.team.name} (${sheet.team.slug})`);
  out.push('');
  out.push(
    `Window ${day(sheet.window.since)} → ${day(sheet.window.until)} (${sheet.window.days} days) · plan ${plan} · workspace created ${day(sheet.team.createdAt)}`,
  );
  out.push('');
  out.push('## People and connections');
  for (const person of sheet.people)
    out.push(`- ${person.username}: ${person.role}, joined ${day(person.joinedAt)}${person.operator ? ' · **operator**' : ''}`);
  for (const connection of sheet.connections)
    out.push(
      `- Agent ${cell(connection.name)} (${cell(connection.client)}${connection.device ? `, ${cell(connection.device)}` : ''}) for ${connection.owner}${connection.operator ? ' (operator)' : ''}, connected ${day(connection.createdAt)}, last used ${day(connection.lastUsedAt)}${connection.revoked ? ', revoked' : ''}`,
    );
  for (const launch of sheet.launches)
    out.push(
      `- Connection test by ${launch.by} (${launch.intent}): opened ${day(launch.createdAt)}, second agent ${day(launch.secondConnectedAt)}, exchange ${day(launch.exchangeConfirmedAt)}, first real result ${day(launch.firstRealResultAt)}`,
    );
  out.push('');
  out.push('## Work handed over and assigned');
  const t = sheet.workTotals;
  out.push(
    `In the window: ${t.handoffs} handoff(s), ${t.assignments} assignment(s) (${t.byOperator} dispatched by the operator); ${t.resumed} resumed, ${t.verifiedResumes} of them on the handed-over commit; ${t.completed} reported complete; ${t.cancelledOrDeclined} cancelled or declined.`,
  );
  out.push('');
  if (sheet.work.length > 0) {
    out.push('| Created | Kind | Title | From | To | Commit | State | Resumed | Completed | Browser replies |');
    out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const row of sheet.work)
      out.push(
        `| ${stamp(row.createdAt)} | ${row.kind} | ${cell(row.title)} | ${cell(row.from)}${row.fromOperator ? ' (operator)' : ''} | ${cell(row.to)} | ${row.checkpoint ? `${row.checkpoint.sha.slice(0, 12)}${row.checkpoint.failed.length ? ` (failing: ${cell(row.checkpoint.failed.join(', '))})` : ''}` : '-'} | ${row.state} | ${row.resumedAt ? `${stamp(row.resumedAt)}${row.verifiedResume ? ' ✓ commit' : ''}` : '-'} | ${stamp(row.completedAt)} | ${row.browserReplies} |`,
      );
    out.push('');
  }
  out.push('## Deliveries');
  if (sheet.deliveries.length === 0) out.push('- No delivery or tested checkpoint was reported in the window.');
  for (const row of sheet.deliveries)
    out.push(
      `- ${stamp(row.at)} · ${cell(row.task ?? 'untitled run')} · ${row.agent} for ${row.owner}${row.operator ? ' (operator)' : ''} · ${row.kind} ${row.commitSha.slice(0, 12)}${row.clean ? '' : ' (dirty)'} · tests: ${row.failed.length ? `failing ${cell(row.failed.join(', '))}` : `${row.passed} passed`} (agent's report) · provider: ${row.provider.length ? row.provider.join(', ') : row.repositoryMatches ? 'no observation of this commit' : 'repository does not match the project'}`,
    );
  out.push('');
  out.push(...nativeWorkMarkdown(sheet.nativeWork));
  out.push('## Warnings people answered');
  const w = sheet.warnings;
  out.push(
    `${w.observedTotal} moment(s) observed; ${w.answered} answered, ${w.confirmed} helpful and changed behaviour, ${w.rejected} not helpful; ${w.minutesSaved} minute(s) reported saved by those who confirmed.`,
  );
  out.push('');
  out.push('## First value path');
  out.push(
    'Connected is not activation: stage 2 says an agent was authorised, stage 3 says the repository changed. Each stage is read from stored rows, as of the export; a stage can read lower later if the rows behind it are deleted.',
  );
  if (sheet.activation.excluded)
    out.push(`This workspace is excluded from cohorts: ${sheet.activation.excluded.label}.`);
  out.push('');
  const stageLine = (stage: PilotStage) =>
    `- ${stage.number}. ${stage.label}: ${
      stage.basis === 'observed'
        ? `${stamp(stage.at)} (observed: ${stage.source})`
        : stage.basis === 'implied'
          ? `implied, no timestamp (${stage.source})`
          : 'not observed'
    }`;
  out.push('Observed by STMA');
  for (const stage of sheet.activation.stages.filter((entry) => entry.kind === 'observed')) out.push(stageLine(stage));
  out.push('');
  out.push('Answered by a person');
  for (const stage of sheet.activation.stages.filter((entry) => entry.kind === 'answered')) out.push(stageLine(stage));
  out.push('');
  out.push(
    `Days with first-work or verified-resume moments (UTC): ${sheet.activation.repeatDays.length ? sheet.activation.repeatDays.join(', ') : 'none'}. Participant runs: ${sheet.activation.runs.participant}, of which ${sheet.activation.runs.withRepositoryChange} reported a repository change. An agent that reports no checkpoint is not seen as work here.${sheet.activation.truncated ? ' Only part of the checkpoint history was read.' : ''}`,
  );
  out.push('');
  out.push('## Weekly');
  out.push('| Week | Runs (participants) | Runs (operator) | People | Agents | Handoffs | Assignments | Resumed (on commit) | Completed |');
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const week of sheet.weeks)
    out.push(
      `| ${day(week.from)} | ${week.runs} | ${week.operatorRuns} | ${week.people} | ${week.agents} | ${week.handoffs} | ${week.assignments} | ${week.resumed} (${week.verifiedResumes}) | ${week.completed} |`,
    );
  if (sheet.runsTruncated) out.push(`Only the newest ${sheet.runsScanned} runs were read; older weeks may be undercounted.`);
  out.push('');
  out.push('## New people and projects');
  if (sheet.expansion.access.length === 0 && sheet.expansion.projects.length === 0)
    out.push('- None in the window.');
  for (const row of sheet.expansion.access)
    out.push(`- ${day(row.at)} · ${row.action} · ${row.who}${row.role ? ` (${row.role})` : ''} · ${row.source}`);
  for (const row of sheet.expansion.projects) out.push(`- ${day(row.createdAt)} · project ${cell(row.name)} created`);
  out.push('');
  out.push('## Not recorded here: write these in the pilot record');
  for (const item of PILOT_NOT_RECORDED) out.push(`- ${item}`);
  out.push('');
  out.push(
    `_Runs, handoffs and checkpoints are never swept; "complete" is the agent's report and provider lines are the provider's observation at the exact commit. ${liveRuns} participant run(s) started in the window._`,
  );
  return `${out.join('\n')}\n`;
}
