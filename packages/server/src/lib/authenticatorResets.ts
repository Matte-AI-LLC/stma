import { count, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { authenticatorResets } from '../db/schema';

/**
 * The record of operator resets of somebody's authenticator app.
 *
 * A reset is the one way past a person's second factor that does not go
 * through that person: it is the independent recovery the T10 specification
 * asks for, and the specification asks that recovery carry its own authority
 * and its own audit. Until this, its only trace was an `evt=admin` log line,
 * kept for the hosted service's thirty days of logs, and the mail to the
 * account, which answers nothing once the mailbox is the thing in doubt. This
 * table is the answer to "who reset this person's authenticator, when, and
 * why", read on the person's operator page, for as long as the row cap allows.
 *
 * It holds no secret and no code: the subject, the operator, the time and one
 * value from a closed list. The row is written on the transaction that removes
 * the app (`removeAuthenticator`'s `within`), so a reset that happened is a
 * reset that is recorded, and a reset of an account with nothing to remove
 * writes nothing.
 */

/** Closed set, because it reaches an operator record and the log and must never be a sentence somebody typed. */
export const AUTHENTICATOR_RESET_REASONS = ['lost_device', 'lost_recovery_codes', 'compromised'] as const;
export type AuthenticatorResetReason = (typeof AUTHENTICATOR_RESET_REASONS)[number];
export const AUTHENTICATOR_RESET_LABELS: Record<AuthenticatorResetReason, string> = {
  lost_device: 'Lost or replaced phone, no recovery codes',
  lost_recovery_codes: 'Recovery codes lost as well',
  compromised: 'Phone or codes may be in the wrong hands',
};

/**
 * Hard ceiling on stored rows, and the only bound: no age sweep, like
 * `membership_changes`, because the row somebody opens this for is the old one.
 */
export const AUTHENTICATOR_RESET_CAP = 20_000;

export async function recordAuthenticatorReset(
  db: Db,
  input: { subjectId: string; actorId: string; actorLabel: string; reason: AuthenticatorResetReason },
): Promise<void> {
  if (!AUTHENTICATOR_RESET_REASONS.includes(input.reason)) throw new Error('Unknown authenticator reset reason.');
  await db.insert(authenticatorResets).values({
    subjectId: input.subjectId,
    actorId: input.actorId,
    actorLabel: input.actorLabel.slice(0, 120),
    reason: input.reason,
  });
}

export interface AuthenticatorResetRow {
  at: Date;
  actorLabel: string;
  reason: string;
}

/** How a stored reason reads on the page; a value outside the list is shown as it is, never relabelled. */
export const authenticatorResetLabel = (reason: string): string =>
  (AUTHENTICATOR_RESET_LABELS as Record<string, string>)[reason] ?? reason;

/** One person's resets, newest first. */
export async function authenticatorResetsFor(db: Db, subjectId: string, limit = 20): Promise<AuthenticatorResetRow[]> {
  return db
    .select({ at: authenticatorResets.at, actorLabel: authenticatorResets.actorLabel, reason: authenticatorResets.reason })
    .from(authenticatorResets)
    .where(eq(authenticatorResets.subjectId, subjectId))
    .orderBy(desc(authenticatorResets.at))
    .limit(limit);
}

export async function trimAuthenticatorResets(db: Db, cap = AUTHENTICATOR_RESET_CAP): Promise<number> {
  const total = (await db.select({ n: count() }).from(authenticatorResets))[0]?.n ?? 0;
  if (total <= cap) return 0;
  await db.execute(
    sql`delete from ${authenticatorResets} where id not in (select id from ${authenticatorResets} order by ${desc(authenticatorResets.at)} limit ${cap})`,
  );
  return total - cap;
}
