import { humanMembership } from './seats';
import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  gt,
  gte,
  inArray,
  max,
  sql,
} from 'drizzle-orm';
import type { Db } from '../db';
import {
  activity,
  agentEvents,
  agentRuns,
  debugSessions,
  handoffs,
  launchAttempts,
  memberships,
  snapshots,
  teams,
} from '../db/schema';
import { DAY_MS, readCounters } from './counters';

/**
 * Are people actually using this, and where do they fall off?
 *
 * Two questions the instance could not answer at all before. Both are read from
 * what the app already records — the activity feed is written on every
 * meaningful call and carries (team, human, agent token, when) — so metering
 * needed a reader, not a new write path on the hot road.
 *
 * Every query here is bounded and grouped; none of them scan a team's history.
 * The window is 30 days, comfortably inside ACTIVITY_RETENTION_DAYS (180), so a
 * retention sweep can never quietly shrink the numerator.
 */

const DAY = DAY_MS;

export interface ActiveCounts {
  humans: number;
  agents: number;
  teams: number;
  events: number;
}

async function activeSince(db: Db, since: Date): Promise<ActiveCounts> {
  const rows = await db
    .select({
      humans: countDistinct(activity.userId),
      agents: countDistinct(activity.tokenId),
      teams: countDistinct(activity.teamId),
      events: count(),
    })
    .from(activity)
    .where(gt(activity.createdAt, since));
  return rows[0] ?? { humans: 0, agents: 0, teams: 0, events: 0 };
}

export interface UsageWindows {
  monthly: ActiveCounts;
  weekly: ActiveCounts;
  daily: ActiveCounts;
  /** Weekly ÷ monthly: how much of the base shows up in any given week. */
  stickiness: number | null;
}

export async function usageWindows(db: Db): Promise<UsageWindows> {
  const now = Date.now();
  const monthly = await activeSince(db, new Date(now - 30 * DAY));
  const weekly = await activeSince(db, new Date(now - 7 * DAY));
  const daily = await activeSince(db, new Date(now - DAY));
  return {
    monthly,
    weekly,
    daily,
    stickiness: monthly.humans > 0 ? weekly.humans / monthly.humans : null,
  };
}

/**
 * The funnel, by team rather than by person: STMA only does anything once a
 * second machine shows up, so a team is the unit that either activated or did
 * not. Each step is a bounded count; the drop between two steps is the thing
 * worth reading.
 */
export interface FunnelStep {
  key: string;
  label: string;
  note: string;
  teams: number;
}

/** Teams that have at least one activity row with any of these actions. */
async function teamsWithAction(db: Db, actions: string[]): Promise<number> {
  const rows = await db
    .select({ n: countDistinct(activity.teamId) })
    .from(activity)
    .where(inArray(activity.action, actions));
  return rows[0]?.n ?? 0;
}

/** Workspaces with distinct human/device-label pairs; labels are not hardware attestation. */
async function teamsWithTwoSnapshotters(db: Db): Promise<number> {
  const rows = await db
    .select({ teamId: snapshots.teamId, people: sql<number>`count(distinct (${snapshots.userId}, ${snapshots.deviceLabel}))::int` })
    .from(snapshots)
    .groupBy(snapshots.teamId);
  return rows.filter((r) => r.people > 1).length;
}

export async function activationFunnel(db: Db): Promise<FunnelStep[]> {
  const totalTeams = (await db.select({ n: count() }).from(teams))[0]?.n ?? 0;
  const multiMember = (
    await db
      .select({ teamId: memberships.teamId, n: count() })
      .from(memberships)
      .where(humanMembership())
      .groupBy(memberships.teamId)
  ).filter((r) => r.n > 1).length;

  return [
    { key: 'created', label: 'Team created', note: 'Someone signed up and made a team.', teams: totalTeams },
    { key: 'joined', label: 'Second member', note: 'Multiple humans; optional for solo users with multiple agents.', teams: multiMember },
    { key: 'snapshot', label: 'First snapshot', note: 'An agent connected and pushed a machine.', teams: await teamsWithAction(db, ['push_snapshot']) },
    { key: 'two_sides', label: 'Two snapshot identities', note: 'Distinct human/device-label pairs in retained snapshots; not hardware attestation.', teams: await teamsWithTwoSnapshotters(db) },
    { key: 'compare', label: 'First env diff', note: 'The core promise, exercised once.', teams: await teamsWithAction(db, ['compare_env']) },
    { key: 'session', label: 'First debug session', note: 'A thread was opened; this alone does not prove an exchange.', teams: await teamsWithAction(db, ['open_session']) },
    { key: 'resolved', label: 'First resolution', note: 'A problem was closed with a root cause — value delivered, archive started.', teams: await teamsWithAction(db, ['resolve_session']) },
    { key: 'fleet', label: 'Fleet activated', note: 'A run was started: the paid half is in use.', teams: await teamsWithAction(db, ['run_started']) },
    { key: 'governed', label: 'Policy published', note: 'A lead set rules for the agents. The stickiest step.', teams: await teamsWithAction(db, ['policy_published']) },
  ];
}

/** Sequential, durable connection-test cohorts. Real work remains a distinct milestone. */
export async function launchCohorts(db: Db, since = new Date(Date.now() - 30 * DAY)) {
  return db.select({
    intent: launchAttempts.intent,
    opened: count(),
    first: sql<number>`count(*) filter (where ${launchAttempts.firstConnectedAt} is not null)::int`,
    second: sql<number>`count(*) filter (where ${launchAttempts.firstConnectedAt} is not null and ${launchAttempts.secondConnectedAt} >= ${launchAttempts.firstConnectedAt})::int`,
    exchanged: sql<number>`count(*) filter (where ${launchAttempts.exchangeConfirmedAt} >= ${launchAttempts.secondConnectedAt})::int`,
    realResultReported: sql<number>`count(*) filter (where ${launchAttempts.firstRealResultAt} >= ${launchAttempts.exchangeConfirmedAt})::int`,
    meanSecondsToExchange: sql<number | null>`avg(extract(epoch from (${launchAttempts.exchangeConfirmedAt} - ${launchAttempts.createdAt})))`,
  }).from(launchAttempts).where(gt(launchAttempts.createdAt, since)).groupBy(launchAttempts.intent);
}

export interface TeamUsageRow {
  teamId: string;
  slug: string;
  name: string;
  plan: string;
  members: number;
  humans30d: number;
  agents30d: number;
  events30d: number;
  callsToday: number;
  lastActiveAt: Date | null;
}

/**
 * Per-team usage, newest activity first. `callsToday` is read from the quota
 * counter rather than recomputed — it is the same number the limiter enforces,
 * so a team asking "why was I capped" and the operator answering are looking at
 * one figure.
 */
export async function teamUsage(db: Db, limit = 20): Promise<TeamUsageRow[]> {
  const since = new Date(Date.now() - 30 * DAY);
  const agg = await db
    .select({
      teamId: activity.teamId,
      humans: countDistinct(activity.userId),
      agents: countDistinct(activity.tokenId),
      events: count(),
      lastActiveAt: sql<Date>`max(${activity.createdAt})`,
    })
    .from(activity)
    .where(gt(activity.createdAt, since))
    .groupBy(activity.teamId)
    .orderBy(desc(count()))
    .limit(limit);
  if (agg.length === 0) return [];

  const ids = agg.map((a) => a.teamId);
  const teamRows = await db.select().from(teams).where(inArray(teams.id, ids));
  const byId = new Map(teamRows.map((t) => [t.id, t]));
  const memberRows = await db
    .select({ teamId: memberships.teamId, n: count() })
    .from(memberships)
    .where(and(inArray(memberships.teamId, ids), humanMembership()))
    .groupBy(memberships.teamId);
  const members = new Map(memberRows.map((m) => [m.teamId, m.n]));

  // The same key the limiter writes, built by the same function it builds it
  // with — an operator and a capped team must never read different numbers, and
  // a second spelling of the key would report a confident zero instead.
  const calls = await readCounters(db, 'team-day', ids, DAY_MS);

  return agg.flatMap((row) => {
    const team = byId.get(row.teamId);
    if (!team) return [];
    return [
      {
        teamId: row.teamId,
        slug: team.slug,
        name: team.name,
        plan: team.plan,
        members: members.get(row.teamId) ?? 0,
        humans30d: row.humans,
        agents30d: row.agents,
        events30d: row.events,
        callsToday: calls.get(row.teamId) ?? 0,
        lastActiveAt: row.lastActiveAt ? new Date(row.lastActiveAt) : null,
      },
    ];
  });
}

// ---------------------------------------------------------------- economic observation

/**
 * Economic observation is intentionally a read model over retained facts. It
 * does not turn quota, activity volume or an agent's estimate into billing.
 */
export const ECONOMIC_OBSERVATION_DAYS = 30;

export interface EconomicObservation {
  days: number;
  firstRealResults: {
    reports: number;
    teams: number;
    latestAt: Date | null;
  };
  handoffs: {
    offered: number;
    resumed: number;
    completed: number;
    /** Teams with at least two handoffs that reached resume in the window. */
    repeatTeams: number;
    latestAt: Date | null;
  };
  reviewSignals: {
    /** Distinct runs with a retained PR or CI event, never event-row count. */
    runs: number;
    mergedRuns: number;
    ciRuns: number;
    /** Teams with provider signals on at least two distinct runs. */
    repeatTeams: number;
    latestAt: Date | null;
  };
  runCosts: {
    measuredRuns: number;
    measuredCents: number | null;
    estimatedRuns: number;
    estimatedCents: number | null;
    unreportedRuns: number;
  };
}

const REVIEW_SIGNAL_EVENTS = ['pr_opened', 'pr_merged', 'pr_closed', 'ci_completed'];

/**
 * A bounded, content-free pilot view. The window is clamped so an operator
 * cannot accidentally turn this page into an all-history scan.
 *
 * "First real result" is an authenticated lifecycle report. PR/CI rows are
 * provider outcome signals. Neither one is customer acceptance or proof that
 * every required review passed; the UI keeps that boundary visible.
 */
export async function economicObservation(
  db: Db,
  requestedDays = ECONOMIC_OBSERVATION_DAYS,
): Promise<EconomicObservation> {
  const days = Math.max(1, Math.min(90, Math.round(requestedDays)));
  const since = new Date(Date.now() - days * DAY);

  const [firstRows, handoffRows, reviewRows, costRows] = await Promise.all([
    db
      .select({
        reports: count(),
        teams: countDistinct(launchAttempts.teamId),
        latestAt: max(launchAttempts.firstRealResultAt),
      })
      .from(launchAttempts)
      .where(gte(launchAttempts.firstRealResultAt, since)),
    db
      .select({
        teamId: debugSessions.teamId,
        offered: count(),
        resumed: sql<number>`count(*) filter (where ${handoffs.resumedAt} is not null)::int`,
        completed: sql<number>`count(*) filter (where ${handoffs.completedAt} is not null)::int`,
        latestAt: max(handoffs.updatedAt),
      })
      .from(handoffs)
      .innerJoin(debugSessions, eq(handoffs.sessionId, debugSessions.id))
      .where(gte(handoffs.createdAt, since))
      .groupBy(debugSessions.teamId),
    db
      .select({
        teamId: agentRuns.teamId,
        runs: countDistinct(agentEvents.runId),
        mergedRuns: sql<number>`count(distinct ${agentEvents.runId}) filter (where ${agentEvents.type} = 'pr_merged')::int`,
        ciRuns: sql<number>`count(distinct ${agentEvents.runId}) filter (where ${agentEvents.type} = 'ci_completed')::int`,
        latestAt: max(agentEvents.createdAt),
      })
      .from(agentEvents)
      .innerJoin(agentRuns, eq(agentEvents.runId, agentRuns.id))
      .where(
        and(
          gte(agentEvents.createdAt, since),
          inArray(agentEvents.type, REVIEW_SIGNAL_EVENTS),
        ),
      )
      .groupBy(agentRuns.teamId),
    db
      .select({
        measuredRuns: sql<number>`count(*) filter (where ${agentRuns.costCents} is not null and ${agentRuns.costSource} = 'measured')::int`,
        measuredCents: sql<number>`coalesce(sum(${agentRuns.costCents}) filter (where ${agentRuns.costSource} = 'measured'), 0)::int`,
        estimatedRuns: sql<number>`count(*) filter (where ${agentRuns.costCents} is not null and ${agentRuns.costSource} = 'estimate')::int`,
        estimatedCents: sql<number>`coalesce(sum(${agentRuns.costCents}) filter (where ${agentRuns.costSource} = 'estimate'), 0)::int`,
        unreportedRuns: sql<number>`count(*) filter (where ${agentRuns.costCents} is null or ${agentRuns.costSource} is null or ${agentRuns.costSource} not in ('measured', 'estimate'))::int`,
      })
      .from(agentRuns)
      .where(gte(agentRuns.lastHeartbeatAt, since)),
  ]);

  const first = firstRows[0];
  const costs = costRows[0];
  const measuredRuns = Number(costs?.measuredRuns ?? 0);
  const estimatedRuns = Number(costs?.estimatedRuns ?? 0);
  const latest = (dates: Array<Date | null>) => {
    const known = dates.filter((date): date is Date => date instanceof Date);
    return known.length > 0
      ? new Date(Math.max(...known.map((date) => date.getTime())))
      : null;
  };

  return {
    days,
    firstRealResults: {
      reports: Number(first?.reports ?? 0),
      teams: Number(first?.teams ?? 0),
      latestAt: first?.latestAt ? new Date(first.latestAt) : null,
    },
    handoffs: {
      offered: handoffRows.reduce((sum, row) => sum + Number(row.offered), 0),
      resumed: handoffRows.reduce((sum, row) => sum + Number(row.resumed), 0),
      completed: handoffRows.reduce((sum, row) => sum + Number(row.completed), 0),
      repeatTeams: handoffRows.filter((row) => Number(row.resumed) >= 2).length,
      latestAt: latest(handoffRows.map((row) => (row.latestAt ? new Date(row.latestAt) : null))),
    },
    reviewSignals: {
      runs: reviewRows.reduce((sum, row) => sum + Number(row.runs), 0),
      mergedRuns: reviewRows.reduce((sum, row) => sum + Number(row.mergedRuns), 0),
      ciRuns: reviewRows.reduce((sum, row) => sum + Number(row.ciRuns), 0),
      repeatTeams: reviewRows.filter((row) => Number(row.runs) >= 2).length,
      latestAt: latest(reviewRows.map((row) => (row.latestAt ? new Date(row.latestAt) : null))),
    },
    runCosts: {
      measuredRuns,
      measuredCents: measuredRuns > 0 ? Number(costs?.measuredCents ?? 0) : null,
      estimatedRuns,
      estimatedCents: estimatedRuns > 0 ? Number(costs?.estimatedCents ?? 0) : null,
      unreportedRuns: Number(costs?.unreportedRuns ?? 0),
    },
  };
}

export const ECONOMIC_SOURCE_COVERAGE = [
  {
    key: 'first_result',
    label: 'First real result',
    status: 'retained',
    source: 'Authenticated handoff completion report',
    boundary: 'Not provider verification or customer acceptance.',
  },
  {
    key: 'repeat_handoff',
    label: 'Repeat handoff',
    status: 'retained',
    source: 'Distinct handoffs that reached resume',
    boundary: 'Counts workflows, not hours saved.',
  },
  {
    key: 'repeat_review',
    label: 'Repeat review signal',
    status: 'retained',
    source: 'Distinct runs with retained PR or CI events',
    boundary: 'A provider signal is not proof that required review passed.',
  },
  {
    key: 'run_cost',
    label: 'Agent run cost',
    status: 'partial',
    source: 'Agent-reported cost with measured / estimate label',
    boundary: 'Measured means the client read a source; it is not audited billing.',
  },
  {
    key: 'support',
    label: 'Support time by workspace / project',
    status: 'unknown',
    source: 'No retained source',
    boundary: 'Do not infer it from activity or message volume.',
  },
  {
    key: 'direct_service',
    label: 'Attributed direct service expense',
    status: 'unknown',
    source: 'No retained source',
    boundary: 'Shared infrastructure is not allocated to a customer here.',
  },
  {
    key: 'managed_job',
    label: 'Optional managed-job expense',
    status: 'unknown',
    source: 'No managed-job cost source',
    boundary: 'No job, expense or credit consumption is invented.',
  },
] as const;

export const PILOT_OBSERVATION_WEEKS = [
  {
    week: 1,
    focus: 'Baseline and first value',
    observe:
      'Record onboarding/support minutes, first real-result provenance and every known cash or expense source.',
  },
  {
    week: 2,
    focus: 'Natural repeat',
    observe:
      'Look for a second real handoff or review signal without a founder reminder; keep non-use and support interventions.',
  },
  {
    week: 3,
    focus: 'Heavy case and source quality',
    observe:
      'Inspect the heaviest cases, measured versus estimated run cost, and direct or managed-job expense only when sourced.',
  },
  {
    week: 4,
    focus: 'Repeat and contribution review',
    observe:
      'Check week-four repeat, payment intent and contribution with cash, consumption and fixed company costs kept separate.',
  },
] as const;

// ---------------------------------------------------------------- pure contribution model

export type EconomicSource = 'measured' | 'estimated' | 'unknown';

export interface EconomicAmount {
  /** Integer cents; null is mandatory when the source is unknown. */
  cents: number | null;
  source: EconomicSource;
}

export interface EconomicQuantity {
  value: number | null;
  source: EconomicSource;
}

export type ContributionLane = 'core' | 'managed';
export type ExpenseKind = 'direct_service' | 'collection' | 'support' | 'managed_job';

export type ContributionExpense =
  | {
      /** Stable identity: one expense may be allocated to one lane only. */
      id: string;
      lane: ContributionLane;
      kind: Exclude<ExpenseKind, 'support'>;
      amount: EconomicAmount;
    }
  | {
      id: string;
      lane: ContributionLane;
      kind: 'support';
      minutes: EconomicQuantity;
      hourlyCostCents: EconomicAmount;
    };

export interface ContributionInput {
  /** Cash movement is reported, but is not automatically treated as delivered revenue. */
  cash: {
    subscriptionCollected: EconomicAmount;
    managedUsageCollected: EconomicAmount;
  };
  /** Current-period subscription revenue supplied by the pilot owner. */
  coreSubscriptionRevenue: EconomicAmount;
  consumption: {
    /** Included allowance is consumption only and can never be added to revenue. */
    includedManagedUsageValue: EconomicAmount;
    /** Purchased usage actually consumed, on its attributable revenue basis. */
    purchasedManagedUsageRevenue: EconomicAmount;
  };
  /** Shared/fixed company costs stay outside this customer contribution calculation. */
  expenses: ContributionExpense[];
}

export interface ContributionResult {
  cash: {
    subscriptionCollected: EconomicAmount;
    managedUsageCollected: EconomicAmount;
    totalCollected: EconomicAmount;
  };
  consumption: {
    includedManagedUsageValue: EconomicAmount;
    purchasedManagedUsageRevenue: EconomicAmount;
    totalManagedUsageValue: EconomicAmount;
  };
  core: {
    revenue: EconomicAmount;
    expenses: EconomicAmount;
    contribution: EconomicAmount;
  };
  managed: {
    revenue: EconomicAmount;
    expenses: EconomicAmount;
    contribution: EconomicAmount;
  };
  totalContribution: EconomicAmount;
  /** Unknown cost inputs are named rather than silently treated as zero. */
  unknownExpenseIds: string[];
}

function assertAmount(label: string, amount: EconomicAmount): void {
  if (amount.source === 'unknown') {
    if (amount.cents !== null) throw new Error(`${label}: unknown amounts must use null cents.`);
    return;
  }
  if (
    amount.cents === null ||
    !Number.isSafeInteger(amount.cents) ||
    amount.cents < 0
  )
    throw new Error(`${label}: known money must be non-negative integer cents.`);
}

function assertQuantity(label: string, quantity: EconomicQuantity): void {
  if (quantity.source === 'unknown') {
    if (quantity.value !== null) throw new Error(`${label}: unknown quantities must use null.`);
    return;
  }
  if (quantity.value === null || !Number.isFinite(quantity.value) || quantity.value < 0)
    throw new Error(`${label}: known quantities must be finite and non-negative.`);
}

function combinedSource(sources: EconomicSource[]): EconomicSource {
  if (sources.includes('unknown')) return 'unknown';
  return sources.includes('estimated') ? 'estimated' : 'measured';
}

function sumAmounts(amounts: EconomicAmount[]): EconomicAmount {
  amounts.forEach((amount, i) => assertAmount(`amount ${i + 1}`, amount));
  const source = combinedSource(amounts.map((amount) => amount.source));
  return {
    cents:
      source === 'unknown'
        ? null
        : amounts.reduce((sum, amount) => sum + (amount.cents ?? 0), 0),
    source,
  };
}

/** Derived contributions may be negative; source/unknown rules still apply. */
function sumContributions(amounts: EconomicAmount[]): EconomicAmount {
  for (const [i, amount] of amounts.entries()) {
    if (amount.source === 'unknown') {
      if (amount.cents !== null)
        throw new Error(`contribution ${i + 1}: unknown amounts must use null cents.`);
    } else if (amount.cents === null || !Number.isSafeInteger(amount.cents)) {
      throw new Error(`contribution ${i + 1}: known contribution must use integer cents.`);
    }
  }
  const source = combinedSource(amounts.map((amount) => amount.source));
  return {
    cents:
      source === 'unknown'
        ? null
        : amounts.reduce((sum, amount) => sum + (amount.cents ?? 0), 0),
    source,
  };
}

function subtractAmount(revenue: EconomicAmount, expense: EconomicAmount): EconomicAmount {
  assertAmount('revenue', revenue);
  assertAmount('expense', expense);
  const source = combinedSource([revenue.source, expense.source]);
  return {
    cents: source === 'unknown' ? null : revenue.cents! - expense.cents!,
    source,
  };
}

function expenseAmount(expense: ContributionExpense): EconomicAmount {
  if (expense.kind !== 'support') {
    assertAmount(`expense ${expense.id}`, expense.amount);
    return expense.amount;
  }
  assertQuantity(`support minutes ${expense.id}`, expense.minutes);
  assertAmount(`support hourly cost ${expense.id}`, expense.hourlyCostCents);
  const source = combinedSource([expense.minutes.source, expense.hourlyCostCents.source]);
  return {
    cents:
      source === 'unknown'
        ? null
        : Math.round((expense.minutes.value! * expense.hourlyCostCents.cents!) / 60),
    source,
  };
}

/**
 * Operational contribution math for a pilot; this is not an accounting
 * policy. Cash and consumed service stay visible as different facts. Included
 * usage is never revenue, and duplicate expense identities are refused so one
 * shared bill cannot be subtracted from both lanes.
 */
export function calculateContribution(input: ContributionInput): ContributionResult {
  const baseAmounts = [
    input.cash.subscriptionCollected,
    input.cash.managedUsageCollected,
    input.coreSubscriptionRevenue,
    input.consumption.includedManagedUsageValue,
    input.consumption.purchasedManagedUsageRevenue,
  ];
  baseAmounts.forEach((amount, i) => assertAmount(`input ${i + 1}`, amount));

  const seen = new Set<string>();
  for (const expense of input.expenses) {
    if (!expense.id.trim()) throw new Error('Expense identity cannot be empty.');
    if (seen.has(expense.id)) throw new Error(`Expense ${expense.id} was allocated more than once.`);
    seen.add(expense.id);
  }
  const withAmounts = input.expenses.map((expense) => ({
    expense,
    amount: expenseAmount(expense),
  }));
  const laneExpenses = (lane: ContributionLane) =>
    sumAmounts(
      withAmounts
        .filter((row) => row.expense.lane === lane)
        .map((row) => row.amount),
    );

  const coreExpenses = laneExpenses('core');
  const managedExpenses = laneExpenses('managed');
  const coreContribution = subtractAmount(input.coreSubscriptionRevenue, coreExpenses);
  // Only purchased usage that was consumed belongs in this revenue lane. The
  // included allowance remains visible above but is deliberately not added.
  const managedRevenue = input.consumption.purchasedManagedUsageRevenue;
  const managedContribution = subtractAmount(managedRevenue, managedExpenses);

  return {
    cash: {
      ...input.cash,
      totalCollected: sumAmounts([
        input.cash.subscriptionCollected,
        input.cash.managedUsageCollected,
      ]),
    },
    consumption: {
      ...input.consumption,
      totalManagedUsageValue: sumAmounts([
        input.consumption.includedManagedUsageValue,
        input.consumption.purchasedManagedUsageRevenue,
      ]),
    },
    core: {
      revenue: input.coreSubscriptionRevenue,
      expenses: coreExpenses,
      contribution: coreContribution,
    },
    managed: {
      revenue: managedRevenue,
      expenses: managedExpenses,
      contribution: managedContribution,
    },
    totalContribution: sumContributions([coreContribution, managedContribution]),
    unknownExpenseIds: withAmounts
      .filter((row) => row.amount.source === 'unknown')
      .map((row) => row.expense.id),
  };
}
