import type { Db } from '../db';
import { clearCounter, hitCounter, readCounter } from '../lib/counters';
import { sha256hex } from '../lib/crypto';

/**
 * Per-account sign-in throttling.
 *
 * `/auth/*` was rate limited by IP at 30 requests a minute and nothing else, so
 * seven wrong passwords against one account produced the same answer as one, at
 * the same speed, with nobody told. Guessing was cheap for anybody willing to
 * spread the attempts, and the account holder never found out it had happened.
 *
 * Keyed on the address the caller typed, hashed — the counter table is swept by
 * retention and has no business holding email addresses, and hashing also means
 * an address that has no account is counted exactly like one that does, so the
 * throttle cannot be used to ask whether an account exists.
 *
 * The window is fixed, like every other counter here: the lock lifts at the end
 * of the window rather than N minutes after the last attempt. That is the
 * property that keeps this from being a way to hold somebody out of their own
 * account indefinitely — an attacker who keeps guessing does not keep extending
 * the lock, they just keep failing inside it.
 */
export const LOGIN_FAIL_WINDOW_MS = 15 * 60_000;
/** Wrong passwords allowed in a window before the address is made to wait. */
export const LOGIN_FAIL_MAX = 5;

const BUCKET = 'login-fail';
const subject = (email: string): string => sha256hex(email.trim().toLowerCase()).slice(0, 32);

export interface LoginGate {
  locked: boolean;
  /** When the current window ends, which is when the lock lifts. */
  resetAt: Date;
}

/** Is this address being made to wait? Reads the counter, does not spend one. */
export async function loginGate(db: Db, email: string): Promise<LoginGate> {
  const count = await readCounter(db, BUCKET, subject(email), LOGIN_FAIL_WINDOW_MS);
  const windowStart = Math.floor(Date.now() / LOGIN_FAIL_WINDOW_MS) * LOGIN_FAIL_WINDOW_MS;
  return { locked: count >= LOGIN_FAIL_MAX, resetAt: new Date(windowStart + LOGIN_FAIL_WINDOW_MS) };
}

export interface LoginFailure extends LoginGate {
  attempts: number;
  /** True on the attempt that crossed the line — the one worth an email. */
  justLocked: boolean;
}

export async function recordLoginFailure(db: Db, email: string): Promise<LoginFailure> {
  const hit = await hitCounter(
    db,
    BUCKET,
    subject(email),
    LOGIN_FAIL_WINDOW_MS,
    LOGIN_FAIL_MAX - 1,
  );
  return {
    attempts: hit.count,
    resetAt: hit.resetAt,
    locked: hit.count >= LOGIN_FAIL_MAX,
    // Exactly once per window: a run of failures is one event to be told about,
    // not one email per guess.
    justLocked: hit.count === LOGIN_FAIL_MAX,
  };
}

/** A successful sign-in ends the run of failures that preceded it. */
export async function clearLoginFailures(db: Db, email: string): Promise<void> {
  await clearCounter(db, BUCKET, subject(email), LOGIN_FAIL_WINDOW_MS);
}

/** Shown to the caller. Says nothing about whether the address has an account. */
export function lockedMessage(resetAt: Date): string {
  return `Too many sign-in attempts for this email address. Try again after ${resetAt
    .toISOString()
    .slice(11, 16)} UTC.`;
}
