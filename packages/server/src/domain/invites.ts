import { humanMembership } from '../lib/seats';
import { and, count, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { invites, memberships, teams, users } from '../db/schema';
import { randomCode } from '../lib/crypto';
import { effectiveLimits, type PlanLimits } from '../lib/entitlements';
import { appendMembershipChange } from '../lib/memberships';
import { criticalAudit } from '../lib/securityHooks';

const DAY = 24 * 60 * 60 * 1000;

/** How long an invitation works, whether it is a link or an email. */
export const INVITE_TTL_DAYS = 7;

/** How many addresses one "Send invitations" may carry. */
export const MAX_INVITE_ADDRESSES = 10;

/**
 * How many people a shared link may let in, as the People tab offers it.
 *
 * A link with no limit is the old shape and stays available, but it is not the
 * default any more: on a paid Team every person who joins is a seat on the
 * owner's bill, and a link pasted into the wrong channel lets in everybody who
 * reads it until it expires.
 */
export const LINK_USES = ['1', '5', '25', 'unlimited'] as const;
export type LinkUses = (typeof LINK_USES)[number];

/** What `randomCode` produces, and nothing a URL could smuggle in beside it. */
const INVITE_CODE_RE = /^[A-Za-z0-9_-]{8,64}$/;

type TeamRow = typeof teams.$inferSelect;

type InviteClaimFailure =
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'member_limit'; maxMembers: number; plan: string; team: TeamRow }
  /** An emailed invitation, opened by an account with another address. */
  | { ok: false; reason: 'wrong_address'; invitedEmail: string; team: TeamRow }
  /** An emailed invitation, opened by the right address before it was confirmed. */
  | { ok: false; reason: 'unconfirmed'; invitedEmail: string; team: TeamRow };

/** An invitation that can still be used, with its workspace; undefined otherwise. */
export async function liveInvite(db: Db, code: string) {
  if (!INVITE_CODE_RE.test(code)) return undefined;
  const rows = await db
    .select({ invite: invites, team: teams })
    .from(invites)
    .innerJoin(teams, eq(invites.teamId, teams.id))
    .where(eq(invites.code, code))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  if (row.invite.expiresAt <= new Date()) return undefined;
  if (row.invite.maxUses != null && row.invite.uses >= row.invite.maxUses) return undefined;
  return row;
}

/**
 * The invitation a sign-in or signup page is on its way to, read from `next`.
 *
 * `/login` and `/signup` carry the join page as `next` and nothing else, so the
 * address never has to travel in a URL to be filled in for somebody: the page
 * that needs it looks the invitation up from its code.
 */
export function inviteCodeFromNext(next: string | undefined): string | undefined {
  const found = /^\/join\/([A-Za-z0-9_-]{8,64})$/.exec(next ?? '');
  return found?.[1];
}

/** The live invitation `next` leads to, if it leads to one. */
export async function invitationFromNext(db: Db, next: string | undefined) {
  const code = inviteCodeFromNext(next);
  return code ? liveInvite(db, code) : undefined;
}

/**
 * How many people a workspace holds against how many its plan allows.
 *
 * Counted with the predicate the claim below enforces, so the People tab can
 * never say there is room where a join would be refused. Unlimited is what the
 * beta, a self-hosted server and Enterprise-sized ceilings look like here.
 */
export async function memberCapacity(
  db: Db,
  team: { id: string; plan: string | null },
  hosted?: boolean,
): Promise<{ humans: number; limit: number; limited: boolean; full: boolean; limits: PlanLimits }> {
  const limits = await effectiveLimits(db, team, hosted);
  const [row] = await db
    .select({ n: count() })
    .from(memberships)
    .where(and(eq(memberships.teamId, team.id), humanMembership()));
  const humans = row?.n ?? 0;
  const limited = limits.maxMembers < Number.MAX_SAFE_INTEGER;
  return { humans, limit: limits.maxMembers, limited, full: limited && humans >= limits.maxMembers, limits };
}

/** A link to share: the role it grants and how many people it may let in. */
export async function createLinkInvite(
  db: Db,
  input: { teamId: string; createdBy: string; role: 'owner' | 'member'; uses: LinkUses },
): Promise<typeof invites.$inferSelect> {
  const [row] = await db
    .insert(invites)
    .values({
      teamId: input.teamId,
      code: randomCode(9),
      createdBy: input.createdBy,
      role: input.role,
      maxUses: input.uses === 'unlimited' ? null : Number(input.uses),
      expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * DAY),
    })
    .returning();
  return row!;
}

/**
 * One invitation per address, for this workspace.
 *
 * An address that already has one waiting gets that one back, renewed for
 * another week and carrying the role asked for now, rather than a second: the
 * pending list is the owner's record of who has been asked, and two rows for
 * one person would make it lie about how many people that is. The code stays,
 * so the link in the first email keeps working.
 */
export async function issueEmailInvites(
  db: Db,
  input: { teamId: string; createdBy: string; role: 'owner' | 'member'; emails: readonly string[] },
): Promise<{ invite: typeof invites.$inferSelect; renewed: boolean }[]> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_DAYS * DAY);
  const issued: { invite: typeof invites.$inferSelect; renewed: boolean }[] = [];
  for (const email of input.emails) {
    const [waiting] = await db
      .select({ id: invites.id })
      .from(invites)
      .where(
        and(
          eq(invites.teamId, input.teamId),
          eq(invites.email, email),
          gt(invites.expiresAt, now),
          eq(invites.uses, 0),
        ),
      )
      .limit(1);
    if (waiting) {
      const [renewed] = await db
        .update(invites)
        .set({ role: input.role, createdBy: input.createdBy, expiresAt })
        .where(eq(invites.id, waiting.id))
        .returning();
      if (renewed) {
        issued.push({ invite: renewed, renewed: true });
        continue;
      }
    }
    const [created] = await db
      .insert(invites)
      .values({
        teamId: input.teamId,
        code: randomCode(9),
        createdBy: input.createdBy,
        role: input.role,
        email,
        maxUses: 1,
        expiresAt,
      })
      .returning();
    issued.push({ invite: created!, renewed: false });
  }
  return issued;
}

type InviteClaimSuccess = {
  ok: true;
  invite: typeof invites.$inferSelect;
  team: typeof teams.$inferSelect;
  /** False means the user was already a member; the invite was not consumed. */
  joined: boolean;
  userId: string;
};

type InviteClaimIdentity =
  | { code: string; userId: string }
  | {
      code: string;
      newUser: { username: string; email: string; passwordHash: string };
    };

/** Used only to force rollback when an invite expires at the final conditional update. */
class InviteClaimExpired extends Error {}

/**
 * Atomically turn an invite into membership.
 *
 * The team row is the mutex shared by browser and terminal redemption. That
 * serializes both the plan member count and max-use counter, while the final
 * conditional update protects the expiry/use limit even if another writer did
 * not take the lock.
 */
export async function claimInviteMembership(
  db: Db,
  input: InviteClaimIdentity,
): Promise<InviteClaimFailure | InviteClaimSuccess> {
  try {
    return await db.transaction(async (tx) => {
      const initial = await tx
        .select({ teamId: invites.teamId })
        .from(invites)
        .where(eq(invites.code, input.code))
        .limit(1);
      if (!initial[0]) return { ok: false, reason: 'invalid' } as const;

      await tx.execute(
        sql`select ${teams.id} from ${teams} where ${teams.id} = ${initial[0].teamId} for update`,
      );

      // Re-read after acquiring the lock: a request that waited must not make
      // its decision from the max-use value it saw before the wait.
      const rows = await tx
        .select({ invite: invites, team: teams })
        .from(invites)
        .innerJoin(teams, eq(invites.teamId, teams.id))
        .where(eq(invites.code, input.code))
        .limit(1);
      const row = rows[0];
      const now = new Date();
      if (
        !row ||
        row.invite.expiresAt <= now ||
        (row.invite.maxUses != null && row.invite.uses >= row.invite.maxUses)
      ) {
        return { ok: false, reason: 'invalid' } as const;
      }

      if ('userId' in input) {
        const existing = await tx
          .select({ userId: memberships.userId })
          .from(memberships)
          .where(and(eq(memberships.teamId, row.team.id), eq(memberships.userId, input.userId)))
          .limit(1);
        if (existing[0]) {
          return { ok: true, ...row, joined: false, userId: input.userId } as const;
        }
      }

      // An emailed invitation is for the address it was sent to, and only once
      // that address is proved. Matching the address alone would not be enough:
      // the owner can copy the link from the People tab, and anybody can sign up
      // with an address they cannot read. Accepting deliberately does not count
      // as proving it either, which is the same trap the 2026-09-21 audit closed
      // for `ADMIN_EMAILS` — a confirmed address is what several doors trust.
      if (row.invite.email) {
        const holder =
          'userId' in input
            ? (
                await tx
                  .select({ email: users.email, confirmedAt: users.emailVerifiedAt })
                  .from(users)
                  .where(eq(users.id, input.userId))
                  .limit(1)
              )[0]
            : { email: input.newUser.email, confirmedAt: null };
        if ((holder?.email ?? '').trim().toLowerCase() !== row.invite.email) {
          return { ok: false, reason: 'wrong_address', invitedEmail: row.invite.email, team: row.team } as const;
        }
        if (!holder?.confirmedAt) {
          return { ok: false, reason: 'unconfirmed', invitedEmail: row.invite.email, team: row.team } as const;
        }
      }

      const limit = (await effectiveLimits(tx as unknown as Db, row.team)).maxMembers;
      const memberRows = await tx
        .select({ n: count() })
        .from(memberships)
        .where(and(eq(memberships.teamId, row.team.id), humanMembership()));
      if ((memberRows[0]?.n ?? 0) >= limit) {
        return {
          ok: false,
          reason: 'member_limit',
          maxMembers: limit,
          plan: row.team.plan,
          team: row.team,
        } as const;
      }

      // Terminal onboarding creates the user inside this transaction. A lost
      // max-use/member-limit race therefore cannot expose or leave an account
      // that never joined a team.
      const joining = 'userId' in input
        ? (
            await tx
              .select({ id: users.id, username: users.username })
              .from(users)
              .where(eq(users.id, input.userId))
              .limit(1)
          )[0] ?? { id: input.userId, username: null }
        : (
            await tx
              .insert(users)
              .values(input.newUser)
              .returning({ id: users.id, username: users.username })
          )[0]!;
      const userId = joining.id;

      const inserted = await tx
        .insert(memberships)
        // The role the invite was written to grant. An invite from before the
        // column reads as `member`, which is what every one of them meant.
        //
        // The audit action deliberately stays `membership_joined` whatever the
        // role: EE refuses that exact string for an organization-managed
        // workspace, so every invite is already closed there, and decorating
        // the action would open the door this column could otherwise widen.
        .values({ teamId: row.team.id, userId, role: row.invite.role })
        .onConflictDoNothing()
        .returning({ userId: memberships.userId });
      if (!inserted[0]) return { ok: true, ...row, joined: false, userId } as const;

      const consumed = await tx
        .update(invites)
        .set({ uses: sql`${invites.uses} + 1` })
        .where(
          and(
            eq(invites.id, row.invite.id),
            gt(invites.expiresAt, now),
            or(isNull(invites.maxUses), lt(invites.uses, invites.maxUses)),
          ),
        )
        .returning({ id: invites.id });
      if (!consumed[0]) throw new InviteClaimExpired();
      await criticalAudit(tx as unknown as Db, { teamId: row.team.id, actorId: userId, action: 'membership_joined', subjectId: row.invite.id });
      // On the transaction, beside `criticalAudit`, because this whole claim is
      // one atomic act and a row saying somebody joined a workspace they did
      // not is worse than no row. The actor is the joiner: an invite is the one
      // door where nobody on the other side pressed anything at this moment.
      await appendMembershipChange(tx as unknown as Db, {
        teamId: row.team.id,
        teamSlug: row.team.slug,
        action: 'added',
        subjectId: userId,
        subjectLabel: joining.username,
        previousRole: null,
        nextRole: row.invite.role,
        source: 'invite',
        route: 'invite redeemed',
        actorId: userId,
        actorLabel: joining.username,
        // Never any part of the code: it is the credential, an invite with uses
        // left is still live after this row is written, and half of one is a
        // real reduction of the guessing space. Which invite it was is already
        // the `criticalAudit` row's subject.
        detail: 'joined by invitation',
      });

      return {
        ok: true,
        team: row.team,
        invite: { ...row.invite, uses: row.invite.uses + 1 },
        joined: true,
        userId,
      } as const;
    });
  } catch (error) {
    if (error instanceof InviteClaimExpired) return { ok: false, reason: 'invalid' };
    throw error;
  }
}
