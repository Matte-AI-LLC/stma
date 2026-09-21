import { count, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { ceilingChanges, teams } from '../db/schema';

/**
 * The record of when a workspace's ceiling moved.
 *
 * An operator's hardest question is a customer saying "this used to work".
 * Before this, a plan switch reached stdout through `logLine({evt:'admin'})`
 * and nothing else, and the Stripe webhook — the writer for every change nobody
 * made by hand — reached the billing log and nothing else either. Neither is
 * queryable, and the container's stdout does not survive a revision.
 *
 * **Every ceiling in this product is a function of two things** — three since
 * operator grants (below) — which is why this module has exactly that many writers. `teams.plan` chooses a row of the matrix
 * in `lib/entitlements`, and that row is where `maxMembers`, `maxProjects`,
 * `maxDevicesPerMember`, handoffs, integrations, retention and the three
 * feature switches all come from. The EE evaluation is the one override: it
 * hands a `free` workspace most of Team for 14 days without touching the
 * column. Licensed seats and `ee_billing_accounts.member_count` are what a
 * workspace is *charged* for, not what it is *allowed*, so they are deliberately
 * absent — if a resolver ever narrows a ceiling by seats, its writer joins here.
 *
 * `setTeamPlan` is the only place `teams.plan` is written, and
 * `admin-history.test.ts` fails the build if that stops being true. A history
 * is worth having only if nothing can move a ceiling around it.
 *
 * The one writer it cannot cover is a migration: `0016` renamed every `pro` row
 * to `team` with no application code running at all. That is a release event
 * rather than an operator one, and the place it belongs is the release notes —
 * but it is worth knowing that a history starting in 2026 has a step in it that
 * this table will never explain.
 */

/**
 * Closed set. A caller must not be able to write a sentence into the operator log.
 *
 * `grant` joined on 2026-09-21: an operator's complimentary plan
 * (`lib/planGrants`) rides beside `teams.plan` the way the evaluation does, so
 * it is a third input to every ceiling and its own writer here — see the note
 * above on why a history is only worth having if nothing moves a ceiling
 * around it.
 */
export const CEILING_FIELDS = ['plan', 'evaluation', 'grant'] as const;
export type CeilingField = (typeof CEILING_FIELDS)[number];

/** Who moved it: an operator at /admin, a Stripe reconciliation, a workspace owner. */
export const CEILING_SOURCES = ['operator', 'billing', 'owner'] as const;
export type CeilingSource = (typeof CEILING_SOURCES)[number];

/**
 * Hard ceiling on stored rows.
 *
 * Deliberately the *only* bound: unlike the activity feed and the run trail,
 * nothing here is swept by age. A plan change is a handful of rows per
 * workspace per year, and the question it answers is asked months later — a
 * history swept at 90 days would be missing exactly the row somebody opens it
 * for. The same reasoning already keeps `agent_runs` off the age sweep.
 */
export const CEILING_CHANGE_CAP = 20_000;

const MAX_DETAIL = 200;

export interface CeilingChangeInput {
  teamId: string;
  teamSlug: string;
  field: CeilingField;
  previous: string | null;
  next: string | null;
  source: CeilingSource;
  /** The exact route or event that carried it, e.g. `POST /admin/teams/:id/plan`. */
  route: string;
  actorId?: string | null;
  actorLabel?: string | null;
  detail?: string | null;
}

/**
 * Append one change. Call it on the same transaction as the mutation.
 *
 * It does **not** swallow a failure the way `track` and `recordErrorEvent` do.
 * Those record that something happened; this records what somebody is now
 * allowed to do, and a ceiling that moved with nothing to account for it is
 * worse than a ceiling that did not move. Inside `setTeamPlan` a failed append
 * therefore takes the plan change with it.
 */
export async function recordCeilingChange(db: Db, input: CeilingChangeInput): Promise<void> {
  await db.insert(ceilingChanges).values({
    teamId: input.teamId,
    teamSlug: input.teamSlug.slice(0, 120),
    field: CEILING_FIELDS.includes(input.field) ? input.field : 'plan',
    previous: input.previous?.slice(0, 120) ?? null,
    next: input.next?.slice(0, 120) ?? null,
    source: CEILING_SOURCES.includes(input.source) ? input.source : 'operator',
    route: input.route.slice(0, 200),
    actorId: input.actorId ?? null,
    actorLabel: input.actorLabel?.slice(0, 120) ?? null,
    detail: input.detail?.slice(0, MAX_DETAIL) ?? null,
  });
}

export interface SetTeamPlanResult {
  team: { id: string; name: string; slug: string };
  previous: string;
  plan: string;
  /** False when the workspace was already on that plan — no row is written. */
  changed: boolean;
}

/**
 * The one writer of `teams.plan`.
 *
 * Serializes on the workspace row, which is the idiom every other ceiling write
 * here already follows, so two writers — an operator at the console and a
 * Stripe webhook arriving at the same second — cannot record a `previous` that
 * was never true. Returns null when the workspace is gone.
 *
 * A no-op change writes nothing: re-saving the same plan is something a console
 * makes very easy to do by accident, and a log of non-events is how a log stops
 * being read.
 */
export async function setTeamPlan(
  db: Db,
  input: {
    teamId: string;
    plan: string;
    source: CeilingSource;
    route: string;
    actorId?: string | null;
    actorLabel?: string | null;
    detail?: string | null;
  },
): Promise<SetTeamPlanResult | null> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select ${teams.id} from ${teams} where ${teams.id} = ${input.teamId} for update`,
    );
    const workspace = (
      await tx
        .select({ id: teams.id, name: teams.name, slug: teams.slug, plan: teams.plan })
        .from(teams)
        .where(eq(teams.id, input.teamId))
        .limit(1)
    )[0];
    if (!workspace) return null;
    const team = { id: workspace.id, name: workspace.name, slug: workspace.slug };
    if (workspace.plan === input.plan) {
      return { team, previous: workspace.plan, plan: input.plan, changed: false };
    }
    await tx.update(teams).set({ plan: input.plan }).where(eq(teams.id, input.teamId));
    await recordCeilingChange(tx as unknown as Db, {
      teamId: workspace.id,
      teamSlug: workspace.slug,
      field: 'plan',
      previous: workspace.plan,
      next: input.plan,
      source: input.source,
      route: input.route,
      actorId: input.actorId,
      actorLabel: input.actorLabel,
      detail: input.detail,
    });
    return { team, previous: workspace.plan, plan: input.plan, changed: true };
  });
}

export interface CeilingChangeRow {
  id: string;
  at: Date;
  teamId: string;
  /** The slug as it read when the change was made. */
  teamSlug: string;
  /** What the workspace is called now, or null once it has been deleted. */
  teamName: string | null;
  field: string;
  previous: string | null;
  next: string | null;
  source: string;
  route: string;
  actorLabel: string | null;
  detail: string | null;
}

/** Newest first, bounded. One workspace when `teamId` is given, the instance otherwise. */
export async function ceilingHistory(
  db: Db,
  opts: { teamId?: string; limit?: number } = {},
): Promise<CeilingChangeRow[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? 25), 200);
  const rows = await db
    .select({
      id: ceilingChanges.id,
      at: ceilingChanges.at,
      teamId: ceilingChanges.teamId,
      teamSlug: ceilingChanges.teamSlug,
      teamName: teams.name,
      field: ceilingChanges.field,
      previous: ceilingChanges.previous,
      next: ceilingChanges.next,
      source: ceilingChanges.source,
      route: ceilingChanges.route,
      actorLabel: ceilingChanges.actorLabel,
      detail: ceilingChanges.detail,
    })
    .from(ceilingChanges)
    .leftJoin(teams, eq(ceilingChanges.teamId, teams.id))
    .where(opts.teamId ? eq(ceilingChanges.teamId, opts.teamId) : undefined)
    .orderBy(desc(ceilingChanges.at))
    .limit(limit);
  return rows;
}

/** Keep only the newest CEILING_CHANGE_CAP rows. Mirrors `trimErrorEvents`. */
export async function trimCeilingChanges(db: Db, cap = CEILING_CHANGE_CAP): Promise<number> {
  const total = (await db.select({ n: count() }).from(ceilingChanges))[0]?.n ?? 0;
  if (total <= cap) return 0;
  await db.execute(
    sql`delete from ${ceilingChanges} where id not in (select id from ${ceilingChanges} order by ${desc(ceilingChanges.at)} limit ${cap})`,
  );
  return total - cap;
}
