import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db';
import {
  agentEvents,
  agentRuns,
  environmentChecks,
  memberships,
  projects,
  savingConfirmations,
  teams,
  users,
} from '../db/schema';

/**
 * What STMA prevented — and how much of that anyone has actually confirmed.
 *
 * The whole design is the gap between those two clauses. A control plane can
 * observe that it warned somebody; it cannot observe whether the warning changed
 * what they did, and the difference between those is the difference between a
 * number a buyer trusts and one they stop reading. So this reports two totals
 * that never merge: what happened, and what a person signed for.
 *
 * Nothing new is written on the hot path. Every event here is already stored —
 * collisions and handoffs as `agent_events` rows, blocked machines as
 * `environment_checks` rows — so the ledger needed a reader and one small table
 * for the answers, not a second copy of the timeline.
 */

export const SAVING_KINDS = ['conflict', 'duplicate', 'preflight', 'handoff'] as const;
export type SavingKind = (typeof SAVING_KINDS)[number];

/** Trail event types that represent an economic moment, mapped to their kind. */
const EVENT_KIND: Record<string, SavingKind> = {
  conflicts_detected: 'conflict',
  duplicates_detected: 'duplicate',
  work_handed_off: 'handoff',
};

/** How many unanswered events one page offers. A queue, not a history. */
export const SAVING_PAGE = 25;

export interface SavingConfirmation {
  helpful: boolean;
  changedBehaviour: boolean;
  minutesSaved: number | null;
  spendStopped: boolean;
  by: string | null;
  at: Date;
}

export interface SavingEvent {
  kind: SavingKind;
  /** The `agent_events` or `environment_checks` row this is about. */
  refId: string;
  runId: string | null;
  at: Date;
  /** One line naming what happened, for somebody being asked months later. */
  what: string;
  where: string | null;
  confirmation: SavingConfirmation | null;
}

const detailOf = (detail: unknown): Record<string, unknown> =>
  detail && typeof detail === 'object' ? (detail as Record<string, unknown>) : {};

function describeEvent(type: string, detail: unknown): string {
  const d = detailOf(detail);
  if (type === 'conflicts_detected') {
    const severity = typeof d.highestSeverity === 'string' ? d.highestSeverity : 'an overlap';
    const n = typeof d.count === 'number' ? d.count : null;
    return `A run was warned it overlapped live work — ${severity}${n ? `, ${n} claims` : ''}.`;
  }
  if (type === 'duplicates_detected') {
    const n = typeof d.count === 'number' ? d.count : null;
    return `A run was told somebody else was already on the same task${n && n > 1 ? ` (${n} of them)` : ''}.`;
  }
  if (type === 'work_handed_off') {
    const reason = typeof d.reason === 'string' ? d.reason : 'other';
    const branch = typeof d.branch === 'string' && d.branch ? ` on ${d.branch}` : '';
    return `Work was handed over${branch} — ${reason}.`;
  }
  return type;
}

/**
 * Economic moments in this team, newest first, each with the answer somebody
 * gave for it or `null` if nobody has been asked yet.
 *
 * Two bounded reads and one join rather than a union view: the two sources have
 * genuinely different shapes, and pretending otherwise in SQL would cost more
 * than merging two short arrays in memory.
 */
export async function savingEvents(
  db: Db,
  teamId: string,
  limit = SAVING_PAGE,
): Promise<SavingEvent[]> {
  const trail = await db
    .select({
      id: agentEvents.id,
      type: agentEvents.type,
      detail: agentEvents.detail,
      at: agentEvents.createdAt,
      runId: agentRuns.id,
      taskKey: agentRuns.taskKey,
      repo: agentRuns.repo,
    })
    .from(agentEvents)
    .innerJoin(agentRuns, eq(agentEvents.runId, agentRuns.id))
    .where(
      and(eq(agentRuns.teamId, teamId), inArray(agentEvents.type, Object.keys(EVENT_KIND))),
    )
    .orderBy(desc(agentEvents.createdAt))
    .limit(limit);

  const blocked = await db
    .select({
      id: environmentChecks.id,
      at: environmentChecks.createdAt,
      runId: environmentChecks.runId,
      summary: environmentChecks.summary,
      project: projects.name,
    })
    .from(environmentChecks)
    .leftJoin(projects, eq(environmentChecks.projectId, projects.id))
    .where(and(eq(environmentChecks.teamId, teamId), eq(environmentChecks.status, 'critical')))
    .orderBy(desc(environmentChecks.createdAt))
    .limit(limit);

  // One collision is one moment, however many times it was re-detected. The
  // source now records a conflict only when it changes, but rows written before
  // that are still in the table, and a ledger asking somebody to confirm the
  // same overlap thirty times is the inflation this whole page exists to avoid.
  const seenCollision = new Set<string>();
  const deduped = trail.filter((row) => {
    if (row.type !== 'conflicts_detected') return true;
    const d = detailOf(row.detail);
    const key = `${row.runId}|${JSON.stringify(d.otherRunIds ?? [])}|${String(d.highestSeverity)}`;
    if (seenCollision.has(key)) return false;
    seenCollision.add(key);
    return true;
  });

  const events: SavingEvent[] = [
    ...deduped.map((row) => ({
      kind: EVENT_KIND[row.type]!,
      refId: row.id,
      runId: row.runId,
      at: row.at,
      what: describeEvent(row.type, row.detail),
      where: row.taskKey ?? row.repo ?? null,
      confirmation: null,
    })),
    ...blocked.map((row) => ({
      kind: 'preflight' as const,
      refId: row.id,
      runId: row.runId,
      at: row.at,
      what: `A machine was stopped before it started: ${row.summary ?? 'critical environment difference'}.`,
      where: row.project ?? null,
      confirmation: null,
    })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, limit);
  if (events.length === 0) return [];

  const answers = await db
    .select({
      kind: savingConfirmations.kind,
      refId: savingConfirmations.refId,
      helpful: savingConfirmations.helpful,
      changedBehaviour: savingConfirmations.changedBehaviour,
      minutesSaved: savingConfirmations.minutesSaved,
      spendStopped: savingConfirmations.spendStopped,
      at: savingConfirmations.createdAt,
      by: users.username,
    })
    .from(savingConfirmations)
    .leftJoin(users, eq(savingConfirmations.confirmedBy, users.id))
    .where(
      and(
        eq(savingConfirmations.teamId, teamId),
        inArray(
          savingConfirmations.refId,
          events.map((e) => e.refId),
        ),
      ),
    );
  const byRef = new Map(answers.map((a) => [`${a.kind}|${a.refId}`, a]));
  return events.map((e) => {
    const a = byRef.get(`${e.kind}|${e.refId}`);
    return a
      ? {
          ...e,
          confirmation: {
            helpful: a.helpful,
            changedBehaviour: a.changedBehaviour,
            minutesSaved: a.minutesSaved,
            spendStopped: a.spendStopped,
            by: a.by,
            at: a.at,
          },
        }
      : e;
  });
}

export interface SavingsLedger {
  /** Days the window covers. */
  days: number;
  /** What the system observed, per kind. Not a saving — a moment worth asking about. */
  observed: Record<SavingKind, number>;
  observedTotal: number;
  /** Answers given, whatever they said. */
  answered: number;
  /** Answers that said it helped *and* changed what happened. Only these count. */
  confirmed: number;
  /** Answers that said it did not help. Kept and shown, because a ledger that hides them is marketing. */
  rejected: number;
  minutesSaved: number;
  spendStopped: number;
  /** Cents, only when the team has said what an hour is worth. Never guessed. */
  valueCents: number | null;
  hourlyCostCents: number | null;
  /**
   * What agents reported spending, measured figures only — the other side of
   * the ROI sentence. Null when nobody reported, because zero would claim the
   * fleet was free rather than unmeasured.
   */
  measuredSpendCents: number | null;
  measuredSpendRuns: number;
}

const EMPTY: Record<SavingKind, number> = { conflict: 0, duplicate: 0, preflight: 0, handoff: 0 };

export async function savingsLedger(db: Db, teamId: string, days = 30): Promise<SavingsLedger> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Counted per distinct collision, not per detection, for the same reason the
  // list above is deduplicated: a number that grows while nothing happens is a
  // number nobody can defend.
  const trailRows = await db
    .select({
      type: agentEvents.type,
      n: sql<number>`count(distinct coalesce(${agentEvents.detail} ->> 'otherRunIds', ${agentEvents.id}::text) || ${agentEvents.runId}::text)::int`,
    })
    .from(agentEvents)
    .innerJoin(agentRuns, eq(agentEvents.runId, agentRuns.id))
    .where(
      and(
        eq(agentRuns.teamId, teamId),
        gte(agentEvents.createdAt, since),
        inArray(agentEvents.type, Object.keys(EVENT_KIND)),
      ),
    )
    .groupBy(agentEvents.type);

  const blockedRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(environmentChecks)
    .where(
      and(
        eq(environmentChecks.teamId, teamId),
        eq(environmentChecks.status, 'critical'),
        gte(environmentChecks.createdAt, since),
      ),
    );

  const observed = { ...EMPTY };
  for (const row of trailRows) {
    const kind = EVENT_KIND[row.type];
    if (kind) observed[kind] += Number(row.n);
  }
  observed.preflight += Number(blockedRows[0]?.n ?? 0);

  const answers = await db
    .select({
      helpful: savingConfirmations.helpful,
      changedBehaviour: savingConfirmations.changedBehaviour,
      minutesSaved: savingConfirmations.minutesSaved,
      spendStopped: savingConfirmations.spendStopped,
    })
    .from(savingConfirmations)
    .where(
      and(eq(savingConfirmations.teamId, teamId), gte(savingConfirmations.createdAt, since)),
    );

  // "Helpful" alone is not a saving. A warning somebody found interesting and
  // then ignored cost the same as no warning, and counting it is how a ledger
  // starts describing a product nobody recognises.
  const counted = answers.filter((a) => a.helpful && a.changedBehaviour);
  const minutesSaved = counted.reduce((sum, a) => sum + (a.minutesSaved ?? 0), 0);
  const team = (
    await db.select({ cost: teams.hourlyCostCents }).from(teams).where(eq(teams.id, teamId)).limit(1)
  )[0];
  const hourlyCostCents = team?.cost ?? null;

  // Estimates are deliberately absent from this sum — same rule as quota:
  // a figure an agent invented must never harden into a team total.
  const spendRows = await db
    .select({
      total: sql<number>`coalesce(sum(${agentRuns.costCents}), 0)::int`,
      n: sql<number>`count(*)::int`,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.teamId, teamId),
        eq(agentRuns.costSource, 'measured'),
        gte(agentRuns.lastHeartbeatAt, since),
      ),
    );
  const measuredSpendRuns = Number(spendRows[0]?.n ?? 0);

  return {
    days,
    observed,
    observedTotal: Object.values(observed).reduce((a, b) => a + b, 0),
    answered: answers.length,
    confirmed: counted.length,
    rejected: answers.filter((a) => !a.helpful).length,
    minutesSaved,
    spendStopped: counted.filter((a) => a.spendStopped).length,
    // Minutes are the honest unit until somebody supplies the rate. A currency
    // figure derived from a number nobody gave is the first thing a buyer checks
    // and the first thing that discredits the rest.
    valueCents: hourlyCostCents === null ? null : Math.round((minutesSaved * hourlyCostCents) / 60),
    hourlyCostCents,
    measuredSpendCents: measuredSpendRuns > 0 ? Number(spendRows[0]?.total ?? 0) : null,
    measuredSpendRuns,
  };
}

export interface ConfirmInput {
  kind: SavingKind;
  refId: string;
  runId?: string | null;
  helpful: boolean;
  changedBehaviour: boolean;
  minutesSaved?: number | null;
  spendStopped?: boolean;
  note?: string | null;
}

/**
 * Record one answer, replacing any earlier one for the same event.
 *
 * Upsert rather than insert because the page can be visited twice, and a ledger
 * that grows every time somebody refreshes it is worse than one nobody fills in.
 */
export async function confirmSaving(
  db: Db,
  userId: string,
  teamId: string,
  input: ConfirmInput,
): Promise<{ ok: true } | { error: string }> {
  const member = await db
    .select({ id: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.teamId, teamId), eq(memberships.userId, userId)))
    .limit(1);
  if (!member[0]) return { error: 'You are not a member of that team.' };
  const minutes =
    input.minutesSaved === null || input.minutesSaved === undefined
      ? null
      : Math.max(0, Math.min(24 * 60, Math.round(input.minutesSaved)));
  await db
    .insert(savingConfirmations)
    .values({
      teamId,
      kind: input.kind,
      refId: input.refId,
      runId: input.runId ?? null,
      confirmedBy: userId,
      helpful: input.helpful,
      changedBehaviour: input.changedBehaviour,
      minutesSaved: minutes,
      spendStopped: input.spendStopped ?? false,
      note: input.note?.slice(0, 500) ?? null,
    })
    .onConflictDoUpdate({
      target: [savingConfirmations.kind, savingConfirmations.refId],
      set: {
        helpful: input.helpful,
        changedBehaviour: input.changedBehaviour,
        minutesSaved: minutes,
        spendStopped: input.spendStopped ?? false,
        note: input.note?.slice(0, 500) ?? null,
        confirmedBy: userId,
        createdAt: new Date(),
      },
    });
  return { ok: true };
}
