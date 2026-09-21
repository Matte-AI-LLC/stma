import { and, count, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { membershipChanges, memberships, teams, users } from '../db/schema';

/**
 * The record of who gained or lost access to a workspace.
 *
 * `lib/ceilings` answers "what is this workspace allowed"; this answers "who is
 * in it". The card that asked for both separated them as *moving* a ceiling and
 * *spending* one, and the split survives here for a reason that is about the
 * questions rather than the taxonomy: a plan change is a handful of rows per
 * workspace per year and is read months later; membership churn is routine, and
 * routing it into the same table would bury the rows somebody opens that one for.
 *
 * **What the inventory actually found**, because the list this started from was
 * not quite right and the difference is the point:
 *
 * - The team activity feed already carried the three *console* membership
 *   events — leave, role change, remove — for both the workspace's own page and
 *   `/admin`. They were not unrecorded; they were recorded for the wrong reader.
 *   The feed is swept by age (by plan, hosted), capped per team, and deleted
 *   with the workspace.
 * - Three writes left **nothing at all**: creating a workspace (the creator's
 *   own owner row), deleting an account (every membership it holds, across
 *   workspaces that go on existing), and EE's `deactivateMember` (every
 *   membership in every workspace of an organization, reachable
 *   non-interactively from SCIM and leaving one `ee_org_events` row naming a
 *   member id and nothing else).
 * - The hourly-cost route is on neither side of the card. `teams.hourly_cost_cents`
 *   is the rate the savings ledger multiplies minutes by; it gates nothing,
 *   meters nothing and removes nobody. It is not recorded here. It *is* now
 *   tracked to the team feed, whose readers are the people the number is for and
 *   who could previously watch every money figure on their own page change with
 *   nothing to say why.
 *
 * Deleting a workspace is the one removal this cannot record: `membership_changes`
 * cascades with `teams`, so the rows would be deleted by the transaction that
 * wrote them. Writing them anyway would be a lie in the code. The workspace's
 * absence is the answer to why nobody is in it, and `/admin` says so on the page.
 */

/** Closed set. A caller must not be able to write a sentence into the operator log. */
export const MEMBERSHIP_ACTIONS = ['added', 'role_changed', 'removed'] as const;
export type MembershipAction = (typeof MEMBERSHIP_ACTIONS)[number];

/**
 * Which door it came through.
 *
 * `self` is the person acting on their own membership (leaving a workspace,
 * deleting their account); `owner` is a workspace owner acting on somebody
 * else's; `operator` is `/admin`; `invite` is a redemption; `identity` is EE's
 * organization administration, including SCIM, which has no human actor at all.
 */
export const MEMBERSHIP_SOURCES = ['self', 'owner', 'operator', 'invite', 'identity'] as const;
export type MembershipSource = (typeof MEMBERSHIP_SOURCES)[number];

/**
 * Hard ceiling on stored rows, and the only bound — no age sweep, same as
 * `ceiling_changes`. "Why can this person not get in any more" is asked long
 * after the fact, and a history swept at 90 days would be missing exactly the
 * row it is opened for. Higher than the ceiling cap because membership churn is
 * genuinely more frequent.
 */
export const MEMBERSHIP_CHANGE_CAP = 50_000;

const MAX_DETAIL = 200;

export interface MembershipChangeInput {
  teamId: string;
  teamSlug: string;
  action: MembershipAction;
  subjectId: string | null;
  /**
   * Their username as it read then. Pass null deliberately — the account-deletion
   * path does, because writing the name into an operator record would undo the
   * scrub the person asked for, and the row still answers the question the
   * operator has ("this workspace lost a member, here is when and why").
   */
  subjectLabel: string | null;
  previousRole: string | null;
  nextRole: string | null;
  source: MembershipSource;
  /** The exact route or event that carried it, e.g. `POST /admin/users/:id/memberships`. */
  route: string;
  actorId?: string | null;
  actorLabel?: string | null;
  leftOwnerless?: boolean;
  /** Shared by every row of one act that spanned several workspaces. */
  groupId?: string | null;
  detail?: string | null;
}

/**
 * Append one change, letting a failure through.
 *
 * Use this where the mutation is already inside a transaction and the record
 * belongs to it: invite redemption, `/admin`'s add, EE's `assignWorkspace` and
 * `deactivateMember`. Each of those already sits beside a `criticalAudit` or
 * `orgAudit` append that takes the mutation down with it if it fails, so this
 * one matching is consistency rather than a new rule — and a swallowed error
 * there would be worse than useless anyway, because PostgreSQL aborts the whole
 * transaction on the first failed statement, so catching one would turn a lost
 * row into a write that silently stopped half way.
 */
export async function appendMembershipChange(
  db: Db,
  input: MembershipChangeInput,
): Promise<void> {
  await db.insert(membershipChanges).values({
    teamId: input.teamId,
    teamSlug: input.teamSlug.slice(0, 120),
    action: MEMBERSHIP_ACTIONS.includes(input.action) ? input.action : 'removed',
    subjectId: input.subjectId ?? null,
    subjectLabel: input.subjectLabel?.slice(0, 120) ?? null,
    previousRole: input.previousRole?.slice(0, 40) ?? null,
    nextRole: input.nextRole?.slice(0, 40) ?? null,
    source: MEMBERSHIP_SOURCES.includes(input.source) ? input.source : 'operator',
    actorId: input.actorId ?? null,
    actorLabel: input.actorLabel?.slice(0, 120) ?? null,
    route: input.route.slice(0, 200),
    leftOwnerless: input.leftOwnerless ?? false,
    groupId: input.groupId ?? null,
    detail: input.detail?.slice(0, MAX_DETAIL) ?? null,
  });
}

/**
 * Append one change beside a mutation that has already happened.
 *
 * Unlike `recordCeilingChange` this does **not** take the write down with it
 * when it fails, and the asymmetry is deliberate. A ceiling that moved with
 * nothing to account for it can be corrected by moving it back; a membership
 * write rolled back because its *record* failed is an access change that
 * silently did not happen — a member still in the workspace their owner removed
 * them from. The safer failure is the unrecorded removal, so a failed append is
 * logged and swallowed, exactly like `track`. Every caller of this one is
 * outside a transaction for the reason in `appendMembershipChange`.
 */
export async function recordMembershipChange(
  db: Db,
  input: MembershipChangeInput,
): Promise<void> {
  try {
    await appendMembershipChange(db, input);
  } catch (err) {
    console.warn(
      '[stma] membership change record failed:',
      err instanceof Error ? err.message : err,
    );
  }
}

/** Append several rows of one act. Same swallow-and-log contract. */
export async function recordMembershipChanges(
  db: Db,
  rows: MembershipChangeInput[],
): Promise<void> {
  for (const row of rows) await recordMembershipChange(db, row);
}

/**
 * Does this workspace still have an owner?
 *
 * Asked *after* a removal, which is what makes it the honest answer rather than
 * a prediction. The core console and `/admin` refuse to take a last owner in
 * advance, so they cannot create the state; EE's organization deprovisioning
 * deliberately does not refuse (see `deactivateMember`) and is the reason the
 * column exists. Every removal asks anyway — a member leaving a workspace that
 * was already left ownerless is a true `true`, and the column must mean the
 * same thing whichever route wrote the row.
 */
export async function hasNoOwner(db: Db, teamId: string): Promise<boolean> {
  const rows = await db
    .select({ n: count() })
    .from(memberships)
    .where(and(eq(memberships.teamId, teamId), eq(memberships.role, 'owner')));
  return (rows[0]?.n ?? 0) === 0;
}

export interface MembershipChangeRow {
  id: string;
  at: Date;
  teamId: string;
  /** The slug as it read when the change was made. */
  teamSlug: string;
  /** What the workspace is called now. */
  teamName: string | null;
  action: string;
  subjectId: string | null;
  subjectLabel: string | null;
  /** Their username now — differs from `subjectLabel` after a rename or a scrub. */
  subjectUsername: string | null;
  previousRole: string | null;
  nextRole: string | null;
  source: string;
  actorLabel: string | null;
  route: string;
  leftOwnerless: boolean;
  groupId: string | null;
  detail: string | null;
}

/**
 * Newest first, bounded. One workspace with `teamId`, one person with
 * `subjectId`, one act with `groupId`, the whole instance with none of them.
 */
export async function membershipHistory(
  db: Db,
  opts: { teamId?: string; subjectId?: string; groupId?: string; limit?: number } = {},
): Promise<MembershipChangeRow[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? 25), 200);
  const filters = [
    opts.teamId ? eq(membershipChanges.teamId, opts.teamId) : undefined,
    opts.subjectId ? eq(membershipChanges.subjectId, opts.subjectId) : undefined,
    opts.groupId ? eq(membershipChanges.groupId, opts.groupId) : undefined,
  ].filter(Boolean);
  return db
    .select({
      id: membershipChanges.id,
      at: membershipChanges.at,
      teamId: membershipChanges.teamId,
      teamSlug: membershipChanges.teamSlug,
      teamName: teams.name,
      action: membershipChanges.action,
      subjectId: membershipChanges.subjectId,
      subjectLabel: membershipChanges.subjectLabel,
      subjectUsername: users.username,
      previousRole: membershipChanges.previousRole,
      nextRole: membershipChanges.nextRole,
      source: membershipChanges.source,
      actorLabel: membershipChanges.actorLabel,
      route: membershipChanges.route,
      leftOwnerless: membershipChanges.leftOwnerless,
      groupId: membershipChanges.groupId,
      detail: membershipChanges.detail,
    })
    .from(membershipChanges)
    .leftJoin(teams, eq(membershipChanges.teamId, teams.id))
    .leftJoin(users, eq(membershipChanges.subjectId, users.id))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(membershipChanges.at))
    .limit(limit);
}

/** Keep only the newest `cap` rows. Mirrors `trimCeilingChanges`. */
export async function trimMembershipChanges(
  db: Db,
  cap = MEMBERSHIP_CHANGE_CAP,
): Promise<number> {
  const total = (await db.select({ n: count() }).from(membershipChanges))[0]?.n ?? 0;
  if (total <= cap) return 0;
  await db.execute(
    sql`delete from ${membershipChanges} where id not in (select id from ${membershipChanges} order by ${desc(membershipChanges.at)} limit ${cap})`,
  );
  return total - cap;
}
