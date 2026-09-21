import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { planGrants, teams } from '../db/schema';
import { recordCeilingChange } from './ceilings';

/**
 * A plan an operator gives a workspace: a friend, a design partner, a
 * workspace somebody promised something to.
 *
 * Before this, the only operator door onto the matrix was the plan switch,
 * which writes `teams.plan` itself. That works for a contract and is wrong for a
 * gift in three ways, all measured before this module was written. The
 * workspace's own Plan & billing page drew the plan as current **and** an
 * enabled checkout for it beside the label, so a friend could pay for what they
 * had been given — and cancelling that subscription later would let the Stripe
 * webhook set the plan to free, taking the gift with it. `/admin/beta` measured
 * every workspace against free, so a gifted one was reported as losing ceilings
 * it would never lose. And there was no end date: "three months of Team" could
 * only be a note in somebody's head.
 *
 * So a grant **rides beside `teams.plan`, the way the EE evaluation does**, and
 * never writes it. `setTeamPlan` stays the one writer of the column, whatever
 * Stripe or an operator put there is untouched while the grant lasts, and when a
 * dated grant ends the workspace is simply back on its own plan: `ends_at` is
 * compared with the clock on every read, so expiry writes nothing, needs no
 * sweep and cannot be missed. The start row in `ceiling_changes` names the end
 * date, which is how the history accounts for a change nobody makes by hand.
 *
 * **While it lasts it decides, whole.** `effectiveLimits` resolves it before the
 * plan and skips the hosted resolver, whose job is to narrow toward what a
 * workspace is charged for; nothing is charged for a grant. It is honoured
 * exactly where plans are — the hosted service outside the private beta — and
 * by the history sweep always, because retention follows the plan a workspace
 * is on and a grant is that plan.
 */

/** Free is the floor every workspace already has; a grant of it would change nothing. */
export const GRANTABLE_PLANS = ['solo', 'team', 'enterprise'] as const;
export type GrantablePlan = (typeof GRANTABLE_PLANS)[number];

/** The operator's note: long enough for "Ahmet, launch friend, until he ships". */
export const MAX_GRANT_NOTE = 200;

const DAY_MS = 86_400_000;

export interface PlanGrant {
  teamId: string;
  plan: GrantablePlan;
  /** The first instant it no longer applies; null means no end date. */
  endsAt: Date | null;
  note: string | null;
  grantedBy: string | null;
  grantedByLabel: string | null;
  grantedAt: Date;
}

export const isGrantablePlan = (plan: unknown): plan is GrantablePlan =>
  typeof plan === 'string' && (GRANTABLE_PLANS as readonly string[]).includes(plan);

export const isGrantActive = (grant: Pick<PlanGrant, 'endsAt'>, now = new Date()): boolean =>
  grant.endsAt === null || grant.endsAt > now;

/**
 * The last day a grant applies, as the operator typed it.
 *
 * A person writing "through 31 December" means the thirty-first included, so
 * that is stored as the first instant of the first of January and read back as
 * the day before it. One millisecond back is enough and keeps the arithmetic
 * out of every caller.
 */
export function grantLastDay(endsAt: Date): string {
  return new Date(endsAt.getTime() - 1).toISOString().slice(0, 10);
}

/** A last day from the form, as the instant after it. Refuses a malformed or a past one. */
export function endsAtFromLastDay(
  day: string,
  now = new Date(),
): { endsAt: Date } | { error: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { error: 'Choose the last day the plan applies.' };
  const start = new Date(`${day}T00:00:00.000Z`);
  // The round trip is what refuses 2026-02-30, which Date would quietly roll
  // over into March.
  if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== day) {
    return { error: `${day} is not a date.` };
  }
  const endsAt = new Date(start.getTime() + DAY_MS);
  if (endsAt <= now) return { error: `${day} has already passed. Choose today or a later day.` };
  return { endsAt };
}

/** One phrase, for a band, a history row or a table cell. */
export function describeGrant(grant: Pick<PlanGrant, 'plan' | 'endsAt'>): string {
  return grant.endsAt ? `${grant.plan} through ${grantLastDay(grant.endsAt)}` : `${grant.plan}, no end date`;
}

/** Trimmed, bounded, and null rather than an empty string. Never logged. */
export function normalizeGrantNote(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const note = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_GRANT_NOTE);
  return note.length > 0 ? note : null;
}

const toGrant = (row: typeof planGrants.$inferSelect): PlanGrant | null =>
  // The CHECK constraint already refuses anything else; this is the reader
  // failing closed rather than trusting it, so a row it cannot place grants
  // nothing and the workspace stays on its own plan.
  isGrantablePlan(row.plan)
    ? {
        teamId: row.teamId,
        plan: row.plan,
        endsAt: row.endsAt,
        note: row.note,
        grantedBy: row.grantedBy,
        grantedByLabel: row.grantedByLabel,
        grantedAt: row.grantedAt,
      }
    : null;

/** The grant on record, whether or not it has ended. For the operator's pages. */
export async function planGrantFor(db: Db, teamId: string): Promise<PlanGrant | null> {
  const row = (await db.select().from(planGrants).where(eq(planGrants.teamId, teamId)).limit(1))[0];
  return row ? toGrant(row) : null;
}

/** The grant in force right now, or null. One primary-key read. */
export async function activePlanGrant(
  db: Db,
  teamId: string,
  now = new Date(),
): Promise<PlanGrant | null> {
  const grant = await planGrantFor(db, teamId);
  return grant && isGrantActive(grant, now) ? grant : null;
}

/** The same for a page listing many workspaces: one query, whatever the count. */
export async function activePlanGrants(
  db: Db,
  teamIds: readonly string[],
  now = new Date(),
): Promise<Map<string, PlanGrant>> {
  if (teamIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(planGrants)
    .where(
      and(
        inArray(planGrants.teamId, [...teamIds]),
        or(isNull(planGrants.endsAt), gt(planGrants.endsAt, now)),
      ),
    );
  const out = new Map<string, PlanGrant>();
  for (const row of rows) {
    const grant = toGrant(row);
    if (grant) out.set(grant.teamId, grant);
  }
  return out;
}

/**
 * The plan a workspace is on for everything that is not a live gate: its grant
 * while one lasts, otherwise its own. What a page quoting the history rule
 * should read, and the same answer the sweep computes in SQL.
 */
export async function grantedOrOwnPlan(
  db: Db,
  team: { id: string; plan: string | null },
): Promise<string | null> {
  return (await activePlanGrant(db, team.id))?.plan ?? team.plan;
}

/**
 * The same question as `grantedOrOwnPlan`, as a SQL expression correlated to
 * `teams`, for a query that groups workspaces by plan without a round trip each.
 */
export const grantedOrOwnPlanSql = sql<string>`coalesce((select ${planGrants.plan} from ${planGrants} where ${planGrants.teamId} = ${teams.id} and (${planGrants.endsAt} is null or ${planGrants.endsAt} > now())), ${teams.plan})`;

export interface GrantWriteResult {
  team: { id: string; name: string; slug: string; plan: string };
  previous: PlanGrant | null;
  grant: PlanGrant | null;
  changed: boolean;
}

const sameInstant = (a: Date | null, b: Date | null) =>
  a === null || b === null ? a === b : a.getTime() === b.getTime();

async function lockTeam(tx: Db, teamId: string) {
  // Every ceiling write serializes on the workspace row, the same lock
  // `setTeamPlan` and the evaluation take, so a grant and a plan switch made in
  // the same second land one after the other with both rows recorded.
  await tx.execute(sql`select ${teams.id} from ${teams} where ${teams.id} = ${teamId} for update`);
  return (
    await tx
      .select({ id: teams.id, name: teams.name, slug: teams.slug, plan: teams.plan })
      .from(teams)
      .where(eq(teams.id, teamId))
      .limit(1)
  )[0];
}

/**
 * Give a plan, or change the one given. The history row is written in the same
 * transaction and a failure to write it takes the grant with it — the rule
 * `recordCeilingChange` already sets for every ceiling.
 *
 * `detail` is composed here from what the database holds, never from the
 * request: the note is the operator's and lives on the grant row only.
 */
export async function setPlanGrant(
  db: Db,
  input: {
    teamId: string;
    plan: GrantablePlan;
    endsAt: Date | null;
    note: string | null;
    actorId: string | null;
    actorLabel: string | null;
    route: string;
  },
): Promise<GrantWriteResult | null> {
  if (!isGrantablePlan(input.plan)) throw new Error(`Not a grantable plan: ${String(input.plan)}`);
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const team = await lockTeam(t, input.teamId);
    if (!team) return null;
    const previous = await planGrantFor(t, input.teamId);
    if (
      previous &&
      isGrantActive(previous) &&
      previous.plan === input.plan &&
      sameInstant(previous.endsAt, input.endsAt) &&
      previous.note === input.note
    ) {
      return { team, previous, grant: previous, changed: false };
    }
    const now = new Date();
    const values = {
      plan: input.plan,
      endsAt: input.endsAt,
      note: input.note,
      grantedBy: input.actorId,
      grantedByLabel: input.actorLabel?.slice(0, 120) ?? null,
      grantedAt: now,
    };
    await t
      .insert(planGrants)
      .values({ teamId: input.teamId, ...values })
      .onConflictDoUpdate({ target: planGrants.teamId, set: values });
    const grant: PlanGrant = { teamId: input.teamId, ...values };
    // A note-only edit changes nothing anybody is allowed to do, so it is not a
    // ceiling change and writes no history row.
    const moved =
      !previous ||
      !isGrantActive(previous) ||
      previous.plan !== input.plan ||
      !sameInstant(previous.endsAt, input.endsAt);
    if (moved) {
      await recordCeilingChange(t, {
        teamId: team.id,
        teamSlug: team.slug,
        field: 'grant',
        previous: previous
          ? isGrantActive(previous)
            ? describeGrant(previous)
            : `ended: ${describeGrant(previous)}`
          : null,
        next: describeGrant(grant),
        source: 'operator',
        route: input.route,
        actorId: input.actorId,
        actorLabel: input.actorLabel,
        detail: input.endsAt
          ? `Complimentary; the workspace returns to its own plan (${team.plan}) on ${input.endsAt.toISOString().slice(0, 10)}, by the clock`
          : `Complimentary with no end date; it replaces the workspace's own plan (${team.plan}) until revoked`,
      });
    }
    return { team, previous, grant, changed: true };
  });
}

/** Take a grant back. The workspace is on its own plan from the next read. */
export async function revokePlanGrant(
  db: Db,
  input: { teamId: string; actorId: string | null; actorLabel: string | null; route: string },
): Promise<GrantWriteResult | null> {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const team = await lockTeam(t, input.teamId);
    if (!team) return null;
    const previous = await planGrantFor(t, input.teamId);
    if (!previous) return { team, previous: null, grant: null, changed: false };
    await t.delete(planGrants).where(eq(planGrants.teamId, input.teamId));
    // Clearing a grant that had already ended moved nothing, so it is not a
    // ceiling change; only taking back a live one is.
    if (isGrantActive(previous)) {
      await recordCeilingChange(t, {
        teamId: team.id,
        teamSlug: team.slug,
        field: 'grant',
        previous: describeGrant(previous),
        next: null,
        source: 'operator',
        route: input.route,
        actorId: input.actorId,
        actorLabel: input.actorLabel,
        detail: `Revoked; the workspace is back on its own plan (${team.plan})`,
      });
    }
    return { team, previous, grant: null, changed: true };
  });
}
