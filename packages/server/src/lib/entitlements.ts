/**
 * What each plan actually buys.
 *
 * Two things were missing before this, and they were different problems. The
 * first was arithmetic: without a call ceiling a single free account could spend
 * 345,600 calls a day inside the per-minute limit — pure database load with no
 * revenue attached and nothing to stop it. The second was that the plan did not
 * reach the product at all. It moved three numbers (members, projects, calls)
 * and left the fleet, governance and evidence halves — the parts the pricing
 * matrix sells — open to everyone. Every plan was the same product.
 *
 * The matrix implemented here is the internal pricing decision (Solo added
 * between Free and Team by the economic analysis). It is a
 * hypothesis until design partners test it, so it lives in one object where a
 * number can be changed in one place rather than being spread across the call
 * sites that enforce it.
 */

/** The fleet half: runs, claims and the conflict radar. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db } from '../db';
export type FleetAccess = 'full' | 'readonly';

export type EntitlementResolver = (
  db: Db,
  team: { id: string; plan: string | null },
  base: PlanLimits,
) => Promise<PlanLimits>;
const entitlementContext = new AsyncLocalStorage<{
  resolver?: EntitlementResolver;
  hosted?: boolean;
  unmetered?: boolean;
}>();
export function withEntitlements<T>(
  resolver: EntitlementResolver | undefined,
  fn: () => T,
  hosted?: boolean,
  unmetered?: boolean,
): T {
  return entitlementContext.run({ resolver, hosted, unmetered }, fn);
}
/** Request-local composition; a failed hosted resolver fails closed, never falls back. */
export async function effectiveLimits(
  db: Db,
  team: { id: string; plan: string | null },
  hosted = isHosted(),
): Promise<PlanLimits> {
  const base = planLimits(team.plan, hosted);
  // The beta skips the hosted resolver too. Its job is to narrow — evaluation
  // expiry, licensed seats — and there is nothing to narrow toward while there
  // is nothing to buy; letting it run would expire a workspace out of features
  // it was never charged for.
  if (isUnmetered()) return base;
  const resolver = entitlementContext.getStore()?.resolver;
  return hosted && resolver ? resolver(db, team, base) : base;
}

export interface PlanLimits {
  /** Composition-specific expiry: read/export/finish/revoke remain available. */
  readOnly?: boolean;
  evaluationEndsAt?: string;
  maxMembers: number;
  maxProjects: number;
  /** Team-wide MCP tool calls per UTC day. */
  maxToolCallsPerDay: number;
  /** Machines one person may keep snapshots for. `null` is unlimited. */
  maxDevicesPerMember: number | null;
  /** Handoffs a team may make per 30 days. `null` is unlimited. */
  maxHandoffsPerMonth: number | null;
  /** Connected source repositories. `null` is unlimited. */
  maxIntegrations: number | null;
  /**
   * Days of activity and agent-event history kept.
   *
   * `null` means age never removes it — the row caps still do, because age alone
   * cannot bound a busy team. This is the one limit customers ask to buy: an
   * outcome history that is swept every 90 days is not a record anyone can plan
   * against.
   */
  retentionDays: number | null;
  /**
   * `readonly` is the teaser, not a broken product: the live map renders and
   * `list_active_agents` answers, so a free team can see what the paid half
   * would be doing, but no run may claim ground. Hiding it entirely would remove
   * the only place the reason to upgrade is visible.
   */
  fleet: FleetAccess;
  /** Publishing policy, receipts and drift, preflight, the governance screen. */
  governance: boolean;
  /** Merge-evidence packs: `get_evidence` and the evidence view. */
  evidence: boolean;
  /**
   * The verified savings ledger.
   *
   * Solo gets it even though Solo has nobody to show it to — for one person
   * paying for themselves, "what did this actually save me" is the renewal
   * decision, and a plan that hides the answer is asking to be cancelled.
   */
  savings: boolean;
}

export const PLANS = {
  free: {
    // Cloud Free is one human evaluating the control plane. Collaboration is
    // what Team sells; agents and machines are not seats.
    maxMembers: 1,
    maxProjects: 10,
    maxToolCallsPerDay: 20_000,
    maxDevicesPerMember: 2,
    // Deliberately a taste rather than nothing. "The limit hit and the work
    // survived" is the most viral minute this product has; closing it entirely
    // cuts the loop that brings the second machine, and opening it entirely
    // removes the reason to pay.
    maxHandoffsPerMonth: 3,
    maxIntegrations: 1,
    retentionDays: 90,
    fleet: 'readonly',
    governance: false,
    evidence: false,
    savings: false,
  },
  solo: {
    // One human is the whole point. A second member is not a bigger Solo, it is
    // a Team — and saying so here is kinder than discovering it at renewal.
    maxMembers: 1,
    maxProjects: 20,
    maxToolCallsPerDay: 50_000,
    maxDevicesPerMember: null,
    maxHandoffsPerMonth: null,
    maxIntegrations: 1,
    retentionDays: 365,
    fleet: 'full',
    // Rules for your own agents is exactly the Solo case: one person, several
    // machines, and no other human to agree with.
    governance: true,
    // Evidence is for showing somebody else. Solo has no somebody else.
    evidence: false,
    savings: true,
  },
  team: {
    // Self-serve Team ends at 50 humans. Larger organizations need the
    // contractual, identity and support controls of Enterprise.
    maxMembers: 50,
    maxProjects: 100,
    maxToolCallsPerDay: 500_000,
    maxDevicesPerMember: null,
    maxHandoffsPerMonth: null,
    maxIntegrations: null,
    retentionDays: null,
    fleet: 'full',
    governance: true,
    evidence: true,
    savings: true,
  },
  enterprise: {
    maxMembers: 1_000,
    maxProjects: 1_000,
    maxToolCallsPerDay: 2_000_000,
    maxDevicesPerMember: null,
    maxHandoffsPerMonth: null,
    maxIntegrations: null,
    retentionDays: null,
    fleet: 'full',
    governance: true,
    evidence: true,
    savings: true,
  },
} as const satisfies Record<string, PlanLimits>;

export type PlanId = keyof typeof PLANS;

/** Order for anything that has to render the ladder, cheapest first. */
export const PLAN_IDS = ['free', 'solo', 'team', 'enterprise'] as const;

/**
 * Everything on, nothing counted.
 *
 * What an instance somebody runs themselves gets. The tier matrix's first column
 * is "self-host, full-featured" and this is that column: the licence already
 * stops a competing hosted service, so the only thing a crippled self-host would
 * achieve is punishing the people reading the licence honestly.
 */
export const UNMETERED: PlanLimits = {
  maxMembers: Number.MAX_SAFE_INTEGER,
  maxProjects: Number.MAX_SAFE_INTEGER,
  maxToolCallsPerDay: Number.MAX_SAFE_INTEGER,
  maxDevicesPerMember: null,
  maxHandoffsPerMonth: null,
  maxIntegrations: null,
  retentionDays: null,
  fleet: 'full',
  governance: true,
  evidence: true,
  savings: true,
};

/**
 * Whether plan limits apply at all, resolved once at boot.
 *
 * A module value rather than a parameter threaded through every signature,
 * because it describes the process and not the request — the same shape as
 * `metrics` and the mail outbox. The alternative was adding a boolean to eight
 * `findOrCreateProject` call sites and the domain functions behind them, none of
 * which have any other reason to know an environment exists.
 *
 * It defaults to **false**, so an instance nobody configured is somebody's own
 * and is unmetered. That is the safe direction: forgetting to set it costs the
 * hosted service revenue, while the opposite mistake locks a self-hoster out of
 * the fleet they were promised.
 */
let hostedInstance = false;

/** Called once from `createApp`. */
export function setHosted(value: boolean): void {
  hostedInstance = value;
}

export function isHosted(): boolean {
  return entitlementContext.getStore()?.hosted ?? hostedInstance;
}

/**
 * The private beta: hosted, but nothing to buy, so nothing to meter.
 *
 * Deliberately separate from `hosted`. Turning hosted off would also take the
 * audit, identity and billing composition with it, and those have to keep
 * behaving the way they will when money is switched on. This lifts the ceilings
 * and leaves everything else standing — and because it writes no plan onto any
 * workspace, unsetting it restores the matrix with nothing to unwind.
 */
let unmeteredInstance = false;

export function setUnmetered(value: boolean): void {
  unmeteredInstance = value;
}

/**
 * Per request first, like `isHosted`. Two instances can share a process — the
 * suite runs a metered and an unmetered server side by side — and a module
 * value alone would hand whichever booted last to both of them.
 */
export function isUnmetered(): boolean {
  return entitlementContext.getStore()?.unmetered ?? unmeteredInstance;
}

/**
 * The limits in force for a team.
 *
 * Pass `hosted` explicitly at the gates, where reading it next to the check is
 * clearer than knowing the module answer; everything else takes the default.
 */
export function planLimits(plan: string | null | undefined, hosted = isHosted()): PlanLimits {
  if (!hosted || isUnmetered()) return UNMETERED;
  return PLANS[(plan as PlanId) ?? 'free'] ?? PLANS.free;
}

/** Human-facing plan name for an error a person or an agent will read. */
export function planName(plan: string | null | undefined): string {
  return (PLAN_IDS as readonly string[]).includes(plan ?? '') ? plan! : 'free';
}

/**
 * What a person is actually using right now, rather than only the persisted
 * Stripe plan. Evaluations deliberately leave `teams.plan` as `free`, so any
 * UI that renders that column directly lies while Team capabilities are active.
 */
export function effectivePlanLabel(
  plan: string | null | undefined,
  limits: Pick<PlanLimits, 'evaluationEndsAt' | 'readOnly'>,
  now = new Date(),
): string {
  // Otherwise every workspace in the beta reads "free" beside a console with
  // every feature switched on, which is the one label that is certainly wrong.
  if (isUnmetered()) return 'Private beta';
  if (!limits.evaluationEndsAt) return planName(plan);
  const endsAt = new Date(limits.evaluationEndsAt);
  if (limits.readOnly || !Number.isFinite(endsAt.getTime()) || endsAt <= now) {
    return 'Team evaluation ended';
  }
  const days = Math.max(1, Math.ceil((endsAt.getTime() - now.getTime()) / 86_400_000));
  return `Team evaluation · ${days} ${days === 1 ? 'day' : 'days'} left`;
}

/** The cheapest plan that carries a feature — what an upgrade message names. */
export function cheapestWith(predicate: (limits: PlanLimits) => boolean): PlanId | null {
  return PLAN_IDS.find((id) => predicate(PLANS[id])) ?? null;
}

/**
 * Per-account ceiling, applied whatever the plan. This is an abuse stop, not a
 * tier: a paid team's headroom comes from its own daily allowance, and no single
 * account should be able to spend a team's whole budget by itself.
 */
export const ACCOUNT_DAILY_CALL_CAP = 50_000;

/** Per-account burst limit, per minute. */
export const ACCOUNT_CALLS_PER_MINUTE = 240;
