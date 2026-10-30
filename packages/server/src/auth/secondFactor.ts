/**
 * Authenticator apps: every rule about the second factor a person adds to their
 * own account, in one place.
 *
 * Enrollment is two steps on purpose. `beginEnrollment` writes a pending row
 * whose secret is sealed and grants nothing; only `confirmEnrollment`, given a
 * code the app produced from that secret, turns it on, in the same transaction
 * that writes the recovery codes. Until then sign-in is exactly what it was.
 *
 * Verification has three guards and each is a database fact rather than a
 * process memory, so they hold across replicas and across parallel requests:
 * the per-account throttle (`rate_counters`, spent before a code is checked,
 * so a burst of parallel guesses cannot all read a count below the limit),
 * the replay guard (`last_step` only ever moves forward, by an update that has
 * to win), and single use of a recovery code (`used_at` is set by an update
 * that has to win).
 *
 * Nothing secret is logged here or anywhere a caller can reach: no secret, no
 * URI, no code, no digest. The log carries a closed set of actions.
 */
import { randomInt } from 'node:crypto';
import { and, count, eq, gt, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { Db } from '../db';
import { recoveryCodes, userAuthenticators, users } from '../db/schema';
import { hitCounter, releaseCounterHit, type CounterHit } from '../lib/counters';
import { sha256hex } from '../lib/crypto';
import { logLine } from '../lib/log';
import { authSecretsAvailable, openAuthSecret, sealAuthSecret } from '../lib/secretStore';
import { generateAuthenticatorSecret, matchStep, otpauthUri } from './totp';

/** How long an enrollment waits for its first code before it has to start again. */
export const ENROLLMENT_TTL_MINUTES = 10;
export const RECOVERY_CODE_COUNT = 10;

/** Wrong codes allowed per account in a window, across every challenge and form. */
export const FACTOR_FAIL_MAX = 5;
export const FACTOR_FAIL_WINDOW_MS = 15 * 60_000;
const FAIL_BUCKET = 'authenticator-fail';
const failSubject = (userId: string): string => sha256hex(`authenticator:${userId}`).slice(0, 32);

/** The closed set of actions this module writes to the log. */
export type AuthenticatorAction =
  | 'authenticator_enabled'
  | 'authenticator_disabled'
  | 'recovery_codes_regenerated'
  | 'recovery_code_used'
  | 'authenticator_reset_by_operator'
  | 'authenticator_key_unavailable'
  | 'authenticator_locked';

const log = (action: AuthenticatorAction, username: string | undefined, extra: Record<string, unknown> = {}) =>
  logLine({ evt: 'auth', a: action, u: username, ...extra });

interface Account {
  id: string;
  username: string;
  email?: string | null;
}

// ---------------------------------------------------------------- status

export type AuthenticatorStatus =
  | { state: 'none' }
  | { state: 'pending'; expiresAt: Date }
  | { state: 'active'; enabledAt: Date; recoveryCodesLeft: number };

export async function authenticatorStatus(db: Db, userId: string): Promise<AuthenticatorStatus> {
  const [row] = await db
    .select({ enabledAt: userAuthenticators.enabledAt, pendingExpiresAt: userAuthenticators.pendingExpiresAt })
    .from(userAuthenticators)
    .where(eq(userAuthenticators.userId, userId))
    .limit(1);
  if (row?.enabledAt) {
    return { state: 'active', enabledAt: row.enabledAt, recoveryCodesLeft: await recoveryCodesLeft(db, userId) };
  }
  if (row?.pendingExpiresAt && row.pendingExpiresAt.getTime() > Date.now()) {
    return { state: 'pending', expiresAt: row.pendingExpiresAt };
  }
  return { state: 'none' };
}

/** The one question every sign-in path asks. One indexed read. */
export async function hasActiveAuthenticator(db: Db, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: userAuthenticators.userId })
    .from(userAuthenticators)
    .where(and(eq(userAuthenticators.userId, userId), isNotNull(userAuthenticators.enabledAt)))
    .limit(1);
  return Boolean(row);
}

export async function recoveryCodesLeft(db: Db, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)));
  return row?.n ?? 0;
}

// ---------------------------------------------------------------- throttle

/**
 * Spend an attempt before the code is checked, never after.
 *
 * Reading the counter and recording a failure later is check-then-act: forty
 * guesses sent at once all read a count below five, all get checked, and a
 * right one among them signs in. Spending first means only the first five
 * attempts in a window are ever checked, however many arrive together. An
 * attempt that turns out not to be a guess (a right code, a code already used
 * once, a server that cannot open the secret) gives its hit back, so the
 * counter still counts wrong codes for somebody using the app normally.
 */
async function spendFactorAttempt(db: Db, userId: string): Promise<CounterHit> {
  return hitCounter(db, FAIL_BUCKET, failSubject(userId), FACTOR_FAIL_WINDOW_MS, FACTOR_FAIL_MAX);
}

/** The attempt was checked and was wrong: it stays spent, and may be the one that locks. */
function failedAttempt(hit: CounterHit) {
  return { locked: hit.count >= FACTOR_FAIL_MAX, justLocked: hit.count === FACTOR_FAIL_MAX, resetAt: hit.resetAt };
}

/** Shown to the caller; names no account. */
export function factorLockedMessage(resetAt: Date): string {
  return `Too many wrong codes. Try again after ${resetAt.toISOString().slice(11, 16)} UTC.`;
}

// ---------------------------------------------------------------- recovery codes

const RECOVERY_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Ten characters of base32, about 50 bits, written `xxxxx-xxxxx`. */
function newRecoveryCode(): string {
  let out = '';
  for (let i = 0; i < 10; i++) out += RECOVERY_ALPHABET[randomInt(0, RECOVERY_ALPHABET.length)];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

/**
 * Whether input could be a code at all: six digits, or the shape of a recovery
 * code. Anything else is answered as malformed and costs no attempt anywhere.
 */
export function factorInputShape(input: string): 'totp' | 'recovery' | null {
  const token = input.replace(/\s/g, '');
  if (/^\d{6}$/.test(token)) return 'totp';
  return normalizeRecoveryCode(token) ? 'recovery' : null;
}

/** Case, spaces and the dash do not matter; anything else that is not the alphabet does. */
export function normalizeRecoveryCode(input: string): string | null {
  const flat = input.toLowerCase().replace(/[\s-]/g, '');
  return /^[a-z2-7]{10}$/.test(flat) ? flat : null;
}

const recoveryDigest = (userId: string, normalized: string): string => sha256hex(`${userId}:${normalized}`);

function recoveryRows(userId: string, codes: string[]) {
  return codes.map((code) => ({ userId, codeHash: recoveryDigest(userId, normalizeRecoveryCode(code)!) }));
}

// ---------------------------------------------------------------- enrollment

export type BeginEnrollment =
  | { ok: true; secret: string; uri: string; expiresAt: Date }
  | { ok: false; reason: 'no_key' | 'already_active' };

/**
 * Start (or restart) an enrollment. The caller has already re-authenticated
 * the person; this writes the sealed secret and hands it back exactly once.
 * An active authenticator is never overwritten: the upsert only updates a row
 * that is still pending.
 */
export async function beginEnrollment(db: Db, account: Account): Promise<BeginEnrollment> {
  if (!authSecretsAvailable()) return { ok: false, reason: 'no_key' };
  const secret = generateAuthenticatorSecret();
  const secretRef = await sealAuthSecret(secret, account.id);
  const expiresAt = new Date(Date.now() + ENROLLMENT_TTL_MINUTES * 60_000);
  const written = await db
    .insert(userAuthenticators)
    .values({ userId: account.id, secretRef, pendingExpiresAt: expiresAt })
    .onConflictDoUpdate({
      target: userAuthenticators.userId,
      set: { secretRef, pendingExpiresAt: expiresAt, enabledAt: null, lastStep: null, lastUsedAt: null },
      setWhere: isNull(userAuthenticators.enabledAt),
    })
    .returning({ userId: userAuthenticators.userId });
  if (written.length === 0) return { ok: false, reason: 'already_active' };
  return {
    ok: true,
    secret,
    uri: otpauthUri({ label: account.email || account.username, secret }),
    expiresAt,
  };
}

export type ConfirmEnrollment =
  | { ok: true; recoveryCodes: string[] }
  | { ok: false; reason: 'expired' | 'wrong' | 'malformed' | 'key_unavailable' }
  | { ok: false; reason: 'locked'; resetAt: Date; justLocked: boolean };

/**
 * Turn a pending enrollment on with the first code its app produced.
 *
 * The activation is one update that has to find the row still pending and
 * still in date, so a confirmation racing an expiry, a second confirmation or
 * a restarted enrollment cannot both win. The recovery codes and the
 * factor-change time are written in the same transaction, and the codes are
 * returned in plain text this once and never again.
 */
export async function confirmEnrollment(
  db: Db,
  account: Account,
  code: string,
  nowMs: number = Date.now(),
): Promise<ConfirmEnrollment> {
  const token = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(token)) return { ok: false, reason: 'malformed' };
  const [row] = await db
    .select()
    .from(userAuthenticators)
    .where(
      and(
        eq(userAuthenticators.userId, account.id),
        isNull(userAuthenticators.enabledAt),
        gt(userAuthenticators.pendingExpiresAt, new Date(nowMs)),
      ),
    )
    .limit(1);
  if (!row) return { ok: false, reason: 'expired' };
  const attempt = await spendFactorAttempt(db, account.id);
  if (attempt.count > FACTOR_FAIL_MAX) {
    return { ok: false, reason: 'locked', resetAt: attempt.resetAt, justLocked: false };
  }
  let secret: string;
  try {
    secret = await openAuthSecret(row.secretRef, account.id);
  } catch {
    await releaseCounterHit(db, attempt);
    log('authenticator_key_unavailable', account.username);
    return { ok: false, reason: 'key_unavailable' };
  }
  const step = matchStep(secret, token, nowMs);
  if (step === null) {
    const failed = failedAttempt(attempt);
    if (failed.locked) {
      if (failed.justLocked) log('authenticator_locked', account.username);
      return { ok: false, reason: 'locked', resetAt: failed.resetAt, justLocked: failed.justLocked };
    }
    return { ok: false, reason: 'wrong' };
  }
  await releaseCounterHit(db, attempt);
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  const activated = await db.transaction(async (tx) => {
    const now = new Date(nowMs);
    const won = await tx
      .update(userAuthenticators)
      .set({ enabledAt: now, pendingExpiresAt: null, lastStep: step, lastUsedAt: now })
      .where(
        and(
          eq(userAuthenticators.userId, account.id),
          isNull(userAuthenticators.enabledAt),
          eq(userAuthenticators.secretRef, row.secretRef),
          gt(userAuthenticators.pendingExpiresAt, now),
        ),
      )
      .returning({ userId: userAuthenticators.userId });
    if (won.length === 0) return false;
    await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, account.id));
    await tx.insert(recoveryCodes).values(recoveryRows(account.id, codes));
    await tx.update(users).set({ secondFactorChangedAt: now }).where(eq(users.id, account.id));
    return true;
  });
  if (!activated) return { ok: false, reason: 'expired' };
  log('authenticator_enabled', account.username);
  return { ok: true, recoveryCodes: codes };
}

// ---------------------------------------------------------------- verification

export type FactorCheck =
  | { status: 'ok'; via: 'totp' | 'recovery'; recoveryCodesLeft: number }
  /**
   * Wrong code, a code already used, or an older code after a newer one. The
   * caller shows one sentence for all of them. `guess` is false for a code that
   * matched the secret but was already spent in its window: refused, and not
   * charged to the throttle, because it is not a guess.
   */
  | { status: 'wrong'; guess: boolean }
  /** Neither six digits nor the shape of a recovery code. Costs no attempt. */
  | { status: 'malformed' }
  | { status: 'locked'; resetAt: Date; justLocked: boolean }
  /** The server cannot open the sealed secret. A recovery code still works. */
  | { status: 'key_unavailable' }
  | { status: 'not_enabled' };

/**
 * Check a code from the app or a recovery code for an account with an active
 * authenticator.
 *
 * An attempt is spent on the throttle before the code is checked, and the
 * lock is enforced even when the code would have been right, for the reason
 * the password throttle is: a lock a correct guess walks through is no lock.
 * Input of neither shape costs nothing. A failure of the key is reported as
 * itself and never falls back to anything weaker.
 */
export async function verifySecondFactor(
  db: Db,
  account: Account,
  input: string,
  nowMs: number = Date.now(),
): Promise<FactorCheck> {
  const token = input.replace(/\s/g, '');
  const totp = /^\d{6}$/.test(token);
  const normalized = totp ? null : normalizeRecoveryCode(token);
  if (!totp && !normalized) return { status: 'malformed' };
  const [row] = await db
    .select()
    .from(userAuthenticators)
    .where(and(eq(userAuthenticators.userId, account.id), isNotNull(userAuthenticators.enabledAt)))
    .limit(1);
  if (!row) return { status: 'not_enabled' };

  const attempt = await spendFactorAttempt(db, account.id);
  if (attempt.count > FACTOR_FAIL_MAX) return { status: 'locked', resetAt: attempt.resetAt, justLocked: false };
  const fail = (): FactorCheck => {
    const failed = failedAttempt(attempt);
    if (failed.locked) {
      if (failed.justLocked) log('authenticator_locked', account.username);
      return { status: 'locked', resetAt: failed.resetAt, justLocked: failed.justLocked };
    }
    return { status: 'wrong', guess: true };
  };

  if (totp) {
    let secret: string;
    try {
      secret = await openAuthSecret(row.secretRef, account.id);
    } catch {
      await releaseCounterHit(db, attempt);
      log('authenticator_key_unavailable', account.username);
      return { status: 'key_unavailable' };
    }
    const step = matchStep(secret, token, nowMs);
    if (step === null) return fail();
    // The replay guard. The same code is valid for the whole window, so only
    // this update decides whether it has already been spent: it moves
    // `last_step` forward or it finds nothing to move.
    const won = await db
      .update(userAuthenticators)
      .set({ lastStep: step, lastUsedAt: new Date(nowMs) })
      .where(
        and(
          eq(userAuthenticators.userId, account.id),
          isNotNull(userAuthenticators.enabledAt),
          or(isNull(userAuthenticators.lastStep), lt(userAuthenticators.lastStep, step)),
        ),
      )
      .returning({ userId: userAuthenticators.userId });
    await releaseCounterHit(db, attempt);
    if (won.length === 0) return { status: 'wrong', guess: false };
    return { status: 'ok', via: 'totp', recoveryCodesLeft: await recoveryCodesLeft(db, account.id) };
  }

  const spent = await db
    .update(recoveryCodes)
    .set({ usedAt: new Date(nowMs) })
    .where(
      and(
        eq(recoveryCodes.userId, account.id),
        eq(recoveryCodes.codeHash, recoveryDigest(account.id, normalized!)),
        isNull(recoveryCodes.usedAt),
      ),
    )
    .returning({ id: recoveryCodes.id });
  if (spent.length === 0) return fail();
  await releaseCounterHit(db, attempt);
  await db.update(users).set({ secondFactorChangedAt: new Date(nowMs) }).where(eq(users.id, account.id));
  const left = await recoveryCodesLeft(db, account.id);
  log('recovery_code_used', account.username, { left });
  return { status: 'ok', via: 'recovery', recoveryCodesLeft: left };
}

// ---------------------------------------------------------------- changes

/**
 * Replace every recovery code with ten new ones. The old set stops working in
 * the same transaction, whether or not any were used.
 */
export async function regenerateRecoveryCodes(db: Db, account: Account): Promise<string[] | null> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  const done = await db.transaction(async (tx) => {
    // Serialize with a disable or a reset of the same account, so a new set is
    // never written beside an authenticator that has just gone.
    const [row] = await tx
      .select({ userId: userAuthenticators.userId })
      .from(userAuthenticators)
      .where(and(eq(userAuthenticators.userId, account.id), isNotNull(userAuthenticators.enabledAt)))
      .limit(1)
      .for('update');
    if (!row) return false;
    await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, account.id));
    await tx.insert(recoveryCodes).values(recoveryRows(account.id, codes));
    return true;
  });
  if (!done) return null;
  log('recovery_codes_regenerated', account.username);
  return codes;
}

/**
 * Remove the authenticator and its recovery codes: the person turning it off,
 * an operator resetting it, or the account being deleted. Sessions are the
 * caller's to end, because each path ends a different set. `within` runs on the
 * same transaction when an active app was removed, which is how an operator
 * reset is recorded (`lib/authenticatorResets`): if the record cannot be
 * written, the app stays.
 */
export async function removeAuthenticator(
  db: Db,
  account: Account,
  by: 'self' | 'operator' | 'account_deleted',
  within?: (tx: Db) => Promise<void>,
): Promise<boolean> {
  const removed = await db.transaction(async (tx) => {
    const gone = await tx
      .delete(userAuthenticators)
      .where(eq(userAuthenticators.userId, account.id))
      .returning({ enabledAt: userAuthenticators.enabledAt });
    await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, account.id));
    const wasActive = gone.some((row) => row.enabledAt !== null);
    if (wasActive) {
      await tx.update(users).set({ secondFactorChangedAt: new Date() }).where(eq(users.id, account.id));
      await within?.(tx as unknown as Db);
    }
    return wasActive;
  });
  if (removed && by !== 'account_deleted') {
    log(by === 'operator' ? 'authenticator_reset_by_operator' : 'authenticator_disabled', account.username);
  }
  return removed;
}
