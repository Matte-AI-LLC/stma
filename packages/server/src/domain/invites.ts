import { humanMembership } from '../lib/seats';
import { and, count, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { invites, memberships, teams, users } from '../db/schema';
import { effectiveLimits } from '../lib/entitlements';
import { appendMembershipChange } from '../lib/memberships';
import { criticalAudit } from '../lib/securityHooks';

type InviteClaimFailure =
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'member_limit'; maxMembers: number; plan: string };

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

      const limit = (await effectiveLimits(tx as unknown as Db, row.team)).maxMembers;
      const memberRows = await tx
        .select({ n: count() })
        .from(memberships)
        .where(and(eq(memberships.teamId, row.team.id), humanMembership()));
      if ((memberRows[0]?.n ?? 0) >= limit) {
        return { ok: false, reason: 'member_limit', maxMembers: limit, plan: row.team.plan } as const;
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
