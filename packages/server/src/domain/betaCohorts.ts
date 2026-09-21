import { and, count, countDistinct, desc, eq, gt, inArray, max } from 'drizzle-orm';
import type { Db } from '../db';
import {
  activity,
  agentRuns,
  environmentBaselines,
  memberships,
  policyBundles,
  projects,
  savingConfirmations,
  snapshots,
  teamIntegrations,
  teams,
  users,
} from '../db/schema';
import { DAY_MS, MONTH_MS, readCounters } from '../lib/counters';
import { DEVICE_WINDOW_DAYS, deviceWindowStart } from '../lib/devices';
import { PLANS, planName, type PlanId, type PlanLimits } from '../lib/entitlements';
import { activePlanGrants } from '../lib/planGrants';
import { humanMembership } from '../lib/seats';

/**
 * Who did we give how much beta to.
 *
 * The private beta lifts every ceiling with one process variable and writes no
 * plan anywhere, which is exactly what makes it safe to switch off — and also
 * what makes the day it is switched off a surprise. `teams.plan` is
 * `NOT NULL DEFAULT 'free'`, so unsetting `BETA_UNMETERED` drops every beta
 * workspace onto the free row of the matrix with nothing to unwind. This module
 * measures the distance each workspace would fall.
 *
 * It composes and derives nothing new. The counts come from the same tables and
 * the same predicates the enforcement sites use — `humanMembership` for seats,
 * `countIntegrations`' table for providers, the rate counters the limiter
 * itself writes for calls and handoffs, read through `readCounters` so the key
 * has one spelling, and snapshots since `deviceWindowStart` for devices, the
 * window `deviceAllowance` counts. An operator and a capped workspace must not
 * be looking at two different numbers.
 *
 * The one thing it does **not** call is `planLimits(...)`. On a beta instance
 * that answers `UNMETERED`, because lifting the ceilings is precisely what the
 * flag does — so the function whose job is to report what a workspace would
 * lose would report that it would lose nothing. The row is read from `PLANS`
 * directly and deliberately.
 *
 * **Which row is the one the workspace lands on** (2026-09-21): an operator's
 * grant if one is running (`lib/planGrants`), otherwise its own `teams.plan`.
 * The first version measured everybody against free, which is true of every
 * workspace nobody gave anything to and false of exactly the ones an operator
 * did — a friend given Team showed up here as losing ceilings it would never
 * lose, on the page read before deciding to end the beta.
 *
 * Console-only: `/admin/beta` is the only reader, which is why it lives here
 * and not beside the enforcement code (`acceptance/tiers.json`, `consoleOnly`).
 */

/**
 * How many workspaces the ledger reads.
 *
 * Bounded like every other operator list. The page says what it left out rather
 * than quietly showing a prefix, and the reader asks for one more row than it
 * returns to know whether there was one — the `size+1` probe `lib/pagination`
 * already uses instead of a COUNT.
 */
export const BETA_LEDGER_MAX = 100;

/** The window everything "since" is measured over, matching `lib/usage`. */
export const BETA_WINDOW_DAYS = 30;

export type CeilingKey =
  | 'members'
  | 'projects'
  | 'calls'
  | 'handoffs'
  | 'integrations'
  | 'devices';

export interface CeilingUse {
  key: CeilingKey;
  /** Column heading and chart glyph, e.g. "Members". */
  label: string;
  /** One word for what the number counts, when the ceiling has a window. */
  per: string;
  used: number;
  /**
   * The row of the plan it lands on — free unless an operator gave it one —
   * which is what this becomes the day the flag is unset. `MAX_SAFE_INTEGER`
   * stands for a ceiling that plan does not have.
   */
  limit: number;
  over: boolean;
}

export type FeatureState =
  /** The plan it lands on carries this, so the flip closes nothing here. */
  | 'kept'
  /** Stored rows show it being used: the flip stops something that is happening. */
  | 'in_use'
  /** Nothing stored says this workspace uses it. */
  | 'no_sign'
  /** Nothing records it at all, so silence here means nothing either way. */
  | 'unrecorded';

export interface FeatureLoss {
  key: 'fleet' | 'governance' | 'evidence' | 'savings';
  label: string;
  state: FeatureState;
  /** What the state was read from, in words. Never a bare verdict. */
  evidence: string;
}

export interface BetaWorkspace {
  teamId: string;
  slug: string;
  name: string;
  /** Its own `teams.plan`. */
  plan: string;
  /** The row every number here is measured against: a grant's plan, or its own. */
  landsOn: PlanId;
  /** The operator's grant that decides `landsOn`, when there is one running. */
  grant: { plan: string; endsAt: Date | null } | null;
  /** Null when no code was required, '' for a code the operator named nothing. */
  cohort: string | null;
  /** The account that created the workspace, or null for a row that predates it. */
  createdBy: string | null;
  /** When the code was redeemed — the creator's signup. */
  cohortAt: Date | null;
  /** When the workspace itself was made. */
  createdAt: Date;
  lastActiveAt: Date | null;
  events: number;
  ceilings: CeilingUse[];
  features: FeatureLoss[];
  /** Ceilings this workspace is already past. */
  over: CeilingUse[];
  /** Features it is using that the plan it lands on does not carry. */
  losing: FeatureLoss[];
}

export interface BetaLedger {
  workspaces: BetaWorkspace[];
  /** True when the instance has more workspaces than the bound. */
  truncated: boolean;
  windowDays: number;
}

export interface CohortSummary {
  cohort: string | null;
  workspaces: number;
  people: number;
  events: number;
  /** Workspaces past at least one free ceiling. */
  over: number;
  /** Workspaces using at least one feature the free row does not carry. */
  losing: number;
  /** The earliest and latest arrival in this cohort. */
  firstAt: Date | null;
  lastAt: Date | null;
}

const byId = <T,>(rows: Array<{ id: string | null; v: T }>) =>
  new Map(rows.flatMap((r) => (r.id === null ? [] : [[r.id, r.v] as const])));

/**
 * Every workspace, with the distance to the free ceilings.
 *
 * Fixed query count: one bounded read of the workspaces, then one grouped read
 * per fact over exactly those ids. Adding a workspace never adds a round trip.
 */
export async function betaLedger(db: Db, limit = BETA_LEDGER_MAX): Promise<BetaLedger> {
  const rows = await db
    .select({
      id: teams.id,
      name: teams.name,
      slug: teams.slug,
      plan: teams.plan,
      createdAt: teams.createdAt,
      createdBy: users.username,
      cohort: users.signupCohort,
      cohortAt: users.createdAt,
    })
    .from(teams)
    .leftJoin(users, eq(teams.createdBy, users.id))
    .orderBy(desc(teams.createdAt))
    .limit(limit + 1);
  const shown = rows.slice(0, limit);
  if (shown.length === 0) {
    return { workspaces: [], truncated: false, windowDays: BETA_WINDOW_DAYS };
  }
  const ids = shown.map((r) => r.id);
  const since = new Date(Date.now() - BETA_WINDOW_DAYS * DAY_MS);
  // One more fact, and one more query whatever the count: which of these an
  // operator has given a plan to, which moves the line each one is measured to.
  const grants = await activePlanGrants(db, ids);

  const [
    members,
    projectCounts,
    integrations,
    runs,
    policies,
    baselines,
    savings,
    activityRows,
    deviceRows,
    calls,
    handoffs,
  ] = await Promise.all([
    db
      .select({ id: memberships.teamId, v: count() })
      .from(memberships)
      .where(and(inArray(memberships.teamId, ids), humanMembership()))
      .groupBy(memberships.teamId),
    db
      .select({ id: projects.teamId, v: count() })
      .from(projects)
      .where(inArray(projects.teamId, ids))
      .groupBy(projects.teamId),
    db
      .select({ id: teamIntegrations.teamId, v: count() })
      .from(teamIntegrations)
      .where(inArray(teamIntegrations.teamId, ids))
      .groupBy(teamIntegrations.teamId),
    db
      .select({ id: agentRuns.teamId, v: count() })
      .from(agentRuns)
      .where(and(inArray(agentRuns.teamId, ids), gt(agentRuns.startedAt, since)))
      .groupBy(agentRuns.teamId),
    db
      .select({ id: policyBundles.teamId, v: count() })
      .from(policyBundles)
      .where(inArray(policyBundles.teamId, ids))
      .groupBy(policyBundles.teamId),
    db
      .select({ id: environmentBaselines.teamId, v: count() })
      .from(environmentBaselines)
      .where(inArray(environmentBaselines.teamId, ids))
      .groupBy(environmentBaselines.teamId),
    db
      .select({ id: savingConfirmations.teamId, v: count() })
      .from(savingConfirmations)
      .where(inArray(savingConfirmations.teamId, ids))
      .groupBy(savingConfirmations.teamId),
    db
      .select({ id: activity.teamId, events: count(), last: max(activity.createdAt) })
      .from(activity)
      .where(and(inArray(activity.teamId, ids), gt(activity.createdAt, since)))
      .groupBy(activity.teamId),
    // Per member, because the ceiling is: one row per person who pushed in
    // the window, folded to the busiest below.
    db
      .select({ id: snapshots.teamId, v: countDistinct(snapshots.deviceLabel) })
      .from(snapshots)
      .where(and(inArray(snapshots.teamId, ids), gt(snapshots.createdAt, deviceWindowStart())))
      .groupBy(snapshots.teamId, snapshots.userId),
    // The limiter's own counters, not a recount of the rows behind them.
    readCounters(db, 'team-day', ids, DAY_MS),
    readCounters(db, 'handoff-month', ids, MONTH_MS),
  ]);

  const memberMap = byId(members);
  const projectMap = byId(projectCounts);
  const integrationMap = byId(integrations);
  const runMap = byId(runs);
  const policyMap = byId(policies);
  const baselineMap = byId(baselines);
  const savingMap = byId(savings);
  const eventMap = byId(activityRows.map((r) => ({ id: r.id, v: r.events })));
  const lastMap = byId(activityRows.map((r) => ({ id: r.id, v: r.last })));
  // A workspace is as close to the device ceiling as its busiest member.
  const deviceMap = new Map<string, number>();
  for (const r of deviceRows) deviceMap.set(r.id, Math.max(deviceMap.get(r.id) ?? 0, r.v));

  const workspaces = shown.map((row) => {
    const grant = grants.get(row.id) ?? null;
    // Where it stands the moment the flag is unset. `planName` sends an id
    // nobody recognises to free, the way `planLimits` and the sweep read it.
    const landsOn = (grant?.plan ?? planName(row.plan)) as PlanId;
    const land: PlanLimits = PLANS[landsOn];
    const ceiling = (
      key: CeilingKey,
      label: string,
      per: string,
      used: number,
      limit: number,
    ): CeilingUse => ({ key, label, per, used, limit, over: used > limit });
    const ceilings: CeilingUse[] = [
      ceiling('members', 'Members', 'people', memberMap.get(row.id) ?? 0, land.maxMembers),
      ceiling('projects', 'Projects', 'projects', projectMap.get(row.id) ?? 0, land.maxProjects),
      ceiling('calls', 'Tool calls', 'today', calls.get(row.id) ?? 0, land.maxToolCallsPerDay),
      ceiling(
        'handoffs',
        'Handoffs',
        'per 30 days',
        handoffs.get(row.id) ?? 0,
        // Null on a plan with no such ceiling; the sentinel reads as unlimited
        // (`ceilingText`) and an unlimited ceiling can never be exceeded.
        land.maxHandoffsPerMonth ?? Number.MAX_SAFE_INTEGER,
      ),
      ceiling(
        'integrations',
        'Integrations',
        'connected',
        integrationMap.get(row.id) ?? 0,
        land.maxIntegrations ?? Number.MAX_SAFE_INTEGER,
      ),
      ceiling(
        'devices',
        'Devices',
        `per member in ${DEVICE_WINDOW_DAYS} days`,
        deviceMap.get(row.id) ?? 0,
        land.maxDevicesPerMember ?? Number.MAX_SAFE_INTEGER,
      ),
    ];

    const runCount = runMap.get(row.id) ?? 0;
    // Two separate records of the same entitlement: publishing a policy and
    // recording a baseline are both gated on `governance`, so either one being
    // there means the flip closes something.
    const policyCount = policyMap.get(row.id) ?? 0;
    const baselineCount = baselineMap.get(row.id) ?? 0;
    const savingRows = savingMap.get(row.id) ?? 0;
    const measured: FeatureLoss[] = [
      {
        key: 'fleet',
        label: 'Claiming ground',
        state: runCount > 0 ? 'in_use' : 'no_sign',
        evidence:
          runCount > 0
            ? `${runCount} run${runCount === 1 ? '' : 's'} started in the last ${BETA_WINDOW_DAYS} days; start_run would be refused`
            : `no run started in the last ${BETA_WINDOW_DAYS} days`,
      },
      {
        key: 'governance',
        label: 'Governance',
        state: policyCount + baselineCount > 0 ? 'in_use' : 'no_sign',
        evidence:
          policyCount + baselineCount > 0
            ? `${policyCount} published polic${policyCount === 1 ? 'y' : 'ies'} and ${baselineCount} baseline${baselineCount === 1 ? '' : 's'}; the page, the publish and the baseline writes all close`
            : 'no policy and no baseline recorded',
      },
      {
        key: 'evidence',
        label: 'Evidence packs',
        // Nothing writes a row when an evidence pack is read: `get_evidence`
        // assembles what is already stored and returns it without tracking. So
        // silence here is silence, and reporting it as "not used" would be the
        // one claim this codebase refuses to make everywhere else.
        state: 'unrecorded',
        evidence: 'nothing records an evidence-pack read, so this cannot be answered from stored rows',
      },
      {
        key: 'savings',
        label: 'Savings ledger',
        state: savingRows > 0 ? 'in_use' : 'no_sign',
        evidence:
          savingRows > 0
            ? `${savingRows} confirmed moment${savingRows === 1 ? '' : 's'}; the page closes and the answers stay`
            : 'nobody has confirmed a saving',
      },
    ];

    // A switch the landing plan carries is kept whatever the rows say, and the
    // words say so rather than dropping the evidence: "team carries it" beside
    // "4 runs" is the answer an operator who gave Team wants to read.
    const carries: Record<FeatureLoss['key'], boolean> = {
      fleet: land.fleet === 'full',
      governance: land.governance,
      evidence: land.evidence,
      savings: land.savings,
    };
    const features: FeatureLoss[] = measured.map((f) =>
      carries[f.key] ? { ...f, state: 'kept', evidence: `${landsOn} carries it; ${f.evidence}` } : f,
    );

    return {
      teamId: row.id,
      slug: row.slug,
      name: row.name,
      plan: row.plan,
      landsOn,
      grant: grant ? { plan: grant.plan, endsAt: grant.endsAt } : null,
      cohort: row.cohort ?? null,
      createdBy: row.createdBy ?? null,
      cohortAt: row.cohortAt ?? null,
      createdAt: row.createdAt,
      lastActiveAt: lastMap.get(row.id) ?? null,
      events: eventMap.get(row.id) ?? 0,
      ceilings,
      features,
      over: ceilings.filter((c) => c.over),
      losing: features.filter((f) => f.state === 'in_use'),
    } satisfies BetaWorkspace;
  });

  return { workspaces, truncated: rows.length > limit, windowDays: BETA_WINDOW_DAYS };
}

/**
 * The same rows folded by cohort — the shape of the owner's actual question.
 *
 * Derived from the ledger rather than queried again, so a cohort's count and
 * the workspaces listed under it cannot disagree. Cohorts are ordered by their
 * first arrival, with accounts that came through no code last: the waves read
 * in the order they were sent, and the pre-beta remainder is the tail.
 */
export function cohortSummaries(ledger: BetaLedger): CohortSummary[] {
  // People are counted as a set while folding — one person can create several
  // workspaces in one wave, and a cohort's "people" is how many humans it let
  // in, not how many rows they left behind.
  type Fold = Omit<CohortSummary, 'people'> & { people: Set<string> };
  const groups = new Map<string, Fold>();
  for (const workspace of ledger.workspaces) {
    // `null` and `''` are different answers, and a Map key has to keep them
    // apart: one means nobody was asked for a code, the other means a code
    // matched that the operator named nothing. Every cohort key carries a `c`
    // prefix, so the bare word cannot be one, whatever an operator types.
    const key = workspace.cohort === null ? 'none' : `c${workspace.cohort}`;
    const group: Fold = groups.get(key) ?? {
      cohort: workspace.cohort,
      workspaces: 0,
      people: new Set<string>(),
      events: 0,
      over: 0,
      losing: 0,
      firstAt: null,
      lastAt: null,
    };
    group.workspaces += 1;
    if (workspace.createdBy) group.people.add(workspace.createdBy);
    group.events += workspace.events;
    if (workspace.over.length > 0) group.over += 1;
    if (workspace.losing.length > 0) group.losing += 1;
    const at = workspace.cohortAt ?? workspace.createdAt;
    if (!group.firstAt || at < group.firstAt) group.firstAt = at;
    if (!group.lastAt || at > group.lastAt) group.lastAt = at;
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(({ people, ...rest }) => ({ ...rest, people: people.size }))
    .sort((a, b) => {
      if ((a.cohort === null) !== (b.cohort === null)) return a.cohort === null ? 1 : -1;
      return (a.firstAt?.getTime() ?? 0) - (b.firstAt?.getTime() ?? 0);
    });
}

/**
 * One letter per ceiling.
 *
 * Here rather than in the drawing because the table prints the same letters in
 * its summary line, and two spellings of a key somebody reads off a legend is
 * how a chart and the row under it start naming different things.
 */
export const CEILING_MARK: Record<CeilingKey, string> = {
  members: 'M',
  projects: 'P',
  calls: 'C',
  handoffs: 'H',
  integrations: 'I',
  devices: 'D',
};

/**
 * What a ceiling reads as, in one phrase: `2 / 1`.
 *
 * Its two spaces are non-breaking, measured on the page: in a narrow column
 * `61,000 / 20,000` broke after the slash and read as two separate numbers,
 * which is how a fraction stops meaning anything. Nothing here is wide enough
 * to need the break.
 *
 * An unlimited ceiling never reaches this — nothing on the free row is
 * unlimited — but the sentinel would print as a sixteen-digit number if one
 * ever did, so it is named rather than formatted.
 */
export function ceilingText(use: CeilingUse): string {
  const limit =
    use.limit === Number.MAX_SAFE_INTEGER ? 'unlimited' : use.limit.toLocaleString('en-US');
  return `${use.used.toLocaleString('en-US')} / ${limit}`;
}

/**
 * Every ceiling on one line, for a reader who wants the numbers, not the
 * picture. A narrow column wraps at the separators and never inside a ceiling.
 */
export function ceilingSummary(ceilings: CeilingUse[]): string {
  return ceilings.map((use) => `${CEILING_MARK[use.key]} ${ceilingText(use)}`).join(' · ');
}

/** How far past the ceiling, as a multiple. 1 is exactly on the line. */
export function ceilingRatio(use: CeilingUse): number {
  if (use.limit <= 0 || use.limit === Number.MAX_SAFE_INTEGER) return 0;
  return use.used / use.limit;
}

/**
 * Which workspaces the chart draws: the closest to the line first.
 *
 * Sorted by the worst single ceiling rather than by a sum, because the day the
 * flag is unset a workspace is broken by its worst one and a total would let
 * five comfortable numbers hide the sixth.
 */
export function nearestTheLine(workspaces: BetaWorkspace[], max: number): BetaWorkspace[] {
  const worst = (w: BetaWorkspace) => Math.max(0, ...w.ceilings.map(ceilingRatio));
  return [...workspaces]
    .sort((a, b) => worst(b) - worst(a) || b.losing.length - a.losing.length)
    .slice(0, max);
}
