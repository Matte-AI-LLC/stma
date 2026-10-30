/**
 * The one way a browser becomes signed in.
 *
 * Every sign-in path (password, emailed code, GitHub, organization SSO, review
 * access, dev login, signup) proves who somebody is in its own way and then
 * calls `startSignIn`. That function asks the one question none of them may
 * skip: does this account have an authenticator app? If not, the session is
 * written as it always was. If it has, no session is written at all: the
 * browser gets an `mfa` cookie naming a challenge row and is sent to the code
 * page, and a session exists only once `completeSecondFactor` has checked the
 * code.
 *
 * The rule is held by a mechanism rather than by memory. `createSession`
 * requires a `SessionFactor`, a branded type only this module can produce, and
 * `authenticator.test.ts` fails if anything outside this file calls it.
 *
 * A pending browser has no `web_sessions` row, so every reader of sessions
 * (the console, OAuth consent, organization proofs) sees it as signed out
 * without having to know this state exists.
 */
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Db } from '../db';
import { mfaChallenges, users } from '../db/schema';
import { logLine } from '../lib/log';
import {
  authenticatorLockedEmail,
  authenticatorNoticeEmail,
  sendMail,
  type AuthenticatorFirstStep,
} from '../lib/mailer';
import { signInCompleted } from '../lib/securityHooks';
import type { AppEnv } from '../types';
import { factorInputShape, factorLockedMessage, hasActiveAuthenticator, verifySecondFactor } from './secondFactor';
import { createSession, invalidateSessionsExcept, sanitizeNext, withdrawNewSession } from './session';

declare const sessionFactor: unique symbol;
/**
 * Whether the session about to be written stands on an authenticator step.
 * Only this module can make one; see the file comment.
 */
export type SessionFactor = { readonly kind: 'none' | 'completed'; readonly [sessionFactor]: true };
const factor = (kind: SessionFactor['kind']) => ({ kind }) as SessionFactor;

/** How the person proved who they are before the authenticator step. Logged, never trusted. */
export type SignInMethod =
  | 'password'
  | 'email_code'
  | 'review'
  | 'test'
  | 'signup'
  | 'github'
  | 'oidc'
  | 'dev';

/**
 * The first step a challenge stood on, for the mail that announces a lock.
 * Every method not named here began with the account's password: the
 * password form, the emailed code that follows it, review access, a test
 * identity and signup. An unknown value is read as the password, which is
 * the wording that asks the most of the reader.
 */
export function firstStepOf(method: string): AuthenticatorFirstStep {
  if (method === 'github') return 'github';
  if (method === 'oidc') return 'organization';
  if (method === 'dev') return 'development';
  return 'password';
}

export const MFA_COOKIE = 'mfa';
export const MFA_CHALLENGE_MINUTES = 10;
/** Wrong codes one challenge takes before it is dead; the account throttle counts across challenges. */
export const MFA_CHALLENGE_ATTEMPTS = 5;
export const AUTHENTICATOR_PAGE = '/login/authenticator';

export type SignInStart =
  | { kind: 'session'; sessionId: string }
  | { kind: 'challenge'; challengeId: string; redirect: string };

/**
 * Write the session, or the challenge that stands in front of one.
 *
 * The check is made twice for an account that has no authenticator: once
 * before the session is written and once after. Enabling one commits the
 * authenticator and then signs every other browser out, so a sign-in that read
 * "none" just before that commit and wrote its session just after the sign-out
 * would otherwise keep a full session with no code behind it. Reading again
 * after the write closes that: either the sign-out deleted the row, or this
 * read sees the authenticator and the row is taken back here and the browser
 * asked for the code like any other.
 */
export async function startSignIn(
  c: Context<AppEnv>,
  userId: string,
  options: { method: SignInMethod; next?: string; sessionDays?: number; db?: Db },
): Promise<SignInStart> {
  const db = options.db ?? c.get('db');
  if (await hasActiveAuthenticator(db, userId)) return startChallenge(c, db, userId, options);
  const sessionId = await createSession(c, userId, factor('none'), { ttlDays: options.sessionDays, db });
  if (await hasActiveAuthenticator(db, userId)) {
    await withdrawNewSession(c, sessionId, db);
    logLine({ evt: 'auth', a: 'mfa_late', m: options.method });
    return startChallenge(c, db, userId, options);
  }
  return { kind: 'session', sessionId };
}

async function startChallenge(
  c: Context<AppEnv>,
  db: Db,
  userId: string,
  options: { method: SignInMethod; next?: string; sessionDays?: number },
): Promise<SignInStart> {
  const [row] = await db
    .insert(mfaChallenges)
    .values({
      userId,
      method: options.method,
      next: sanitizeNext(options.next),
      sessionDays: options.sessionDays ?? null,
      expiresAt: new Date(Date.now() + MFA_CHALLENGE_MINUTES * 60_000),
    })
    .returning({ id: mfaChallenges.id });
  setCookie(c, MFA_COOKIE, row!.id, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: c.get('env').baseUrl.startsWith('https://'),
    maxAge: MFA_CHALLENGE_MINUTES * 60,
  });
  logLine({ evt: 'auth', a: 'mfa_challenge', m: options.method });
  return { kind: 'challenge', challengeId: row!.id, redirect: AUTHENTICATOR_PAGE };
}

/** The live challenge this browser is completing, or nothing. Spends nothing. */
export async function pendingSecondFactor(c: Context<AppEnv>) {
  const id = getCookie(c, MFA_COOKIE);
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const [row] = await c
    .get('db')
    .select()
    .from(mfaChallenges)
    .where(
      and(
        eq(mfaChallenges.id, id),
        isNull(mfaChallenges.consumedAt),
        gt(mfaChallenges.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return row && row.attempts < MFA_CHALLENGE_ATTEMPTS ? row : undefined;
}

export function clearSecondFactorCookie(c: Context<AppEnv>): void {
  deleteCookie(c, MFA_COOKIE, { path: '/' });
}

/** Give up a challenge: the cookie goes, and the row can never be completed. */
export async function cancelSecondFactor(c: Context<AppEnv>): Promise<void> {
  const id = getCookie(c, MFA_COOKIE);
  clearSecondFactorCookie(c);
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return;
  await c
    .get('db')
    .update(mfaChallenges)
    .set({ consumedAt: new Date() })
    .where(and(eq(mfaChallenges.id, id), isNull(mfaChallenges.consumedAt)));
}

/**
 * One sentence for "that did not work", whether the challenge exists or not,
 * so the answer to a code says nothing about the account behind the cookie.
 */
export const WRONG_FACTOR =
  'That code did not work. Enter the current 6-digit code from your authenticator app, or one of your recovery codes.';
export const FACTOR_KEY_UNAVAILABLE =
  'This server cannot check authenticator codes right now. Sign in with one of your recovery codes instead.';
export const MALFORMED_FACTOR =
  'Enter the 6-digit code from your authenticator app, or a recovery code like abcde-fghij.';

export type SecondFactorResult =
  | { kind: 'done'; next: string; sessionId: string; via: 'totp' | 'recovery'; recoveryCodesLeft: number }
  /** Ask again on the code page, with this message. */
  | { kind: 'retry'; message: string }
  /** The challenge is gone: start the sign-in again, with this message. */
  | { kind: 'restart'; message: string };

/**
 * Check the code for this browser's challenge and, if it is right, write the
 * session.
 *
 * The session is new: its id is minted here, so nothing a browser held before
 * the step (a fixed cookie, an earlier session) becomes the signed-in one.
 *
 * The challenge is claimed before the code is checked, by an update that has
 * to win: it sets `consumed_at` while the row is unconsumed, in date and under
 * its attempt limit. So one challenge is checking one code at a time, and two
 * submissions racing on it produce one check, not two: the loser is answered
 * as a wrong code and nothing of its input is looked at, which keeps a losing
 * racer from spending a recovery code that then signs nobody in. A wrong code
 * gives the claim back with one more attempt counted; a right one keeps it.
 *
 * A recovery code is a sign that a phone was lost or taken, so signing in with
 * one ends every other session of the account and tells the address.
 */
export async function completeSecondFactor(c: Context<AppEnv>, input: string): Promise<SecondFactorResult> {
  const db = c.get('db');
  const env = c.get('env');
  const id = getCookie(c, MFA_COOKIE);
  const live = await pendingSecondFactor(c);
  // Unknown, expired, used up or never issued: the same words as a wrong code,
  // and the code page then sends the browser back to the start.
  if (!id || !live) return { kind: 'retry', message: WRONG_FACTOR };
  // Input of neither shape is answered before anything is claimed or spent.
  if (!factorInputShape(input)) return { kind: 'retry', message: MALFORMED_FACTOR };
  const [account] = await db
    .select({ id: users.id, username: users.username, email: users.email })
    .from(users)
    .where(eq(users.id, live.userId))
    .limit(1);
  if (!account) return { kind: 'retry', message: WRONG_FACTOR };

  const claimedAt = new Date();
  const claimed = await db
    .update(mfaChallenges)
    .set({ consumedAt: claimedAt })
    .where(
      and(
        eq(mfaChallenges.id, live.id),
        isNull(mfaChallenges.consumedAt),
        gt(mfaChallenges.expiresAt, claimedAt),
        lt(mfaChallenges.attempts, MFA_CHALLENGE_ATTEMPTS),
      ),
    )
    .returning({ id: mfaChallenges.id });
  // Another submission is checking this challenge right now, or it ended a
  // moment ago: the same words as a wrong code, and nothing was looked at.
  if (claimed.length === 0) return { kind: 'retry', message: WRONG_FACTOR };
  /** Give the claim back, counting the attempt when it was a guess. */
  const release = async (counted: boolean) => {
    const [row] = await db
      .update(mfaChallenges)
      .set({
        consumedAt: null,
        ...(counted ? { attempts: sql`${mfaChallenges.attempts} + 1` } : {}),
      })
      .where(and(eq(mfaChallenges.id, live.id), eq(mfaChallenges.consumedAt, claimedAt)))
      .returning({ attempts: mfaChallenges.attempts });
    return row?.attempts;
  };

  const checked = await verifySecondFactor(db, account, input);
  if (checked.status === 'malformed') {
    await release(false);
    return { kind: 'retry', message: MALFORMED_FACTOR };
  }
  if (checked.status === 'key_unavailable') {
    await release(false);
    return { kind: 'retry', message: FACTOR_KEY_UNAVAILABLE };
  }
  if (checked.status === 'not_enabled') {
    // Turned off by an operator while this browser was on the code page. The
    // person signs in again and the path they take decides what comes next.
    // The claim stays: this challenge is over.
    clearSecondFactorCookie(c);
    return { kind: 'restart', message: 'Your sign-in attempt expired. Sign in again.' };
  }
  if (checked.status === 'locked') {
    await release(false);
    if (checked.justLocked && account.email) {
      void sendMail(env, {
        to: account.email,
        ...authenticatorLockedEmail(env.baseUrl, checked.resetAt, firstStepOf(live.method)),
      });
    }
    return { kind: 'retry', message: factorLockedMessage(checked.resetAt) };
  }
  if (checked.status === 'wrong') {
    const attempts = await release(checked.guess);
    logLine({ evt: 'auth', a: 'mfa_wrong', m: live.method });
    if ((attempts ?? MFA_CHALLENGE_ATTEMPTS) >= MFA_CHALLENGE_ATTEMPTS) {
      await cancelSecondFactor(c);
      return { kind: 'restart', message: 'Too many wrong codes. Sign in again.' };
    }
    return { kind: 'retry', message: WRONG_FACTOR };
  }

  // Right. The claim is the consumption; it is never given back.
  clearSecondFactorCookie(c);

  const sessionId = await createSession(c, account.id, factor('completed'), {
    ttlDays: live.sessionDays ?? undefined,
  });
  await signInCompleted(db, { challengeId: live.id, sessionId, userId: account.id });
  logLine({ evt: 'auth', a: 'login', u: account.username, f2: checked.via, m: live.method });

  if (checked.via === 'recovery') {
    await invalidateSessionsExcept(db, account.id, sessionId);
    if (account.email) {
      void sendMail(env, {
        to: account.email,
        ...authenticatorNoticeEmail('recovery_code_used', {
          baseUrl: env.baseUrl,
          supportEmail: env.supportEmail,
          browser: c.req.header('user-agent'),
          codesLeft: checked.recoveryCodesLeft,
        }),
      });
    }
  }
  return {
    kind: 'done',
    next: live.next,
    sessionId,
    via: checked.via,
    recoveryCodesLeft: checked.recoveryCodesLeft,
  };
}
