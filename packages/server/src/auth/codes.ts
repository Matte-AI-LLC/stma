/**
 * Email one-time codes — the sign-in second factor, the password-change
 * confirmation and the forgotten-password reset.
 *
 * The pending sign-in challenge is the `auth_codes` row itself: the browser only
 * carries the row's random uuid in a short-lived httpOnly cookie, so expiry,
 * attempt counting and single use stay authoritative on the server and a stolen
 * cookie is worthless without the emailed code. (A signed cookie carrying the
 * user id would need a new signing secret and could not be revoked mid-flight.)
 */
import { randomInt } from 'node:crypto';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Db } from '../db';
import { authCodes } from '../db/schema';
import { sha256hex } from '../lib/crypto';
import type { AppEnv } from '../types';

export const AUTH_CODE_PURPOSES = ['login', 'password_change', 'password_reset'] as const;
export type AuthCodePurpose = (typeof AUTH_CODE_PURPOSES)[number];

/** How long an emailed code stays usable. */
export const CODE_TTL_MINUTES = 10;
/** Wrong guesses allowed per code; the code dies at this many. */
export const MAX_CODE_ATTEMPTS = 5;
/** Codes a user may have emailed per purpose within SEND_WINDOW_MINUTES. */
export const MAX_SENDS_PER_WINDOW = 3;
export const SEND_WINDOW_MINUTES = 15;

const MINUTE = 60 * 1000;

export type IssuedCode =
  | { ok: true; id: string; code: string; expiresAt: Date }
  | { ok: false; reason: 'rate_limited' };

/**
 * Mint a fresh code, retiring any earlier unused one for the same purpose so only
 * the newest email works. Enforces the per-user send limit.
 */
export async function issueAuthCode(
  db: Db,
  userId: string,
  purpose: AuthCodePurpose,
): Promise<IssuedCode> {
  const now = Date.now();
  const recent = await db
    .select({ id: authCodes.id })
    .from(authCodes)
    .where(
      and(
        eq(authCodes.userId, userId),
        eq(authCodes.purpose, purpose),
        gt(authCodes.createdAt, new Date(now - SEND_WINDOW_MINUTES * MINUTE)),
      ),
    )
    .limit(MAX_SENDS_PER_WINDOW);
  if (recent.length >= MAX_SENDS_PER_WINDOW) return { ok: false, reason: 'rate_limited' };

  await db
    .update(authCodes)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(authCodes.userId, userId),
        eq(authCodes.purpose, purpose),
        isNull(authCodes.consumedAt),
      ),
    );

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const expiresAt = new Date(now + CODE_TTL_MINUTES * MINUTE);
  const inserted = await db
    .insert(authCodes)
    .values({ userId, purpose, codeHash: sha256hex(code), expiresAt })
    .returning({ id: authCodes.id });
  return { ok: true, id: inserted[0]!.id, code, expiresAt };
}

export type CodeCheck =
  /** Correct code; the row is now consumed. */
  | { status: 'ok'; userId: string }
  /** No pending challenge, or it was already used / expired / burned through. */
  | { status: 'gone' }
  /** Wrong code, more attempts left. */
  | { status: 'invalid'; attemptsLeft: number }
  /** Wrong code and the challenge is now dead. */
  | { status: 'exhausted' };

async function check(
  db: Db,
  row: typeof authCodes.$inferSelect | undefined,
  code: string,
): Promise<CodeCheck> {
  if (!row || row.consumedAt || row.expiresAt.getTime() <= Date.now()) return { status: 'gone' };
  if (row.attempts >= MAX_CODE_ATTEMPTS) return { status: 'gone' };
  if (sha256hex(code) === row.codeHash) {
    // Single use: only the update that actually flips consumed_at wins, so two
    // parallel submissions of the same code cannot both create a session.
    const won = await db
      .update(authCodes)
      .set({ consumedAt: new Date() })
      .where(and(eq(authCodes.id, row.id), isNull(authCodes.consumedAt)))
      .returning({ id: authCodes.id });
    return won.length > 0 ? { status: 'ok', userId: row.userId } : { status: 'gone' };
  }
  const bumped = await db
    .update(authCodes)
    .set({ attempts: sql`${authCodes.attempts} + 1` })
    .where(eq(authCodes.id, row.id))
    .returning({ attempts: authCodes.attempts });
  const attempts = bumped[0]?.attempts ?? row.attempts + 1;
  if (attempts >= MAX_CODE_ATTEMPTS) {
    await db.update(authCodes).set({ consumedAt: new Date() }).where(eq(authCodes.id, row.id));
    return { status: 'exhausted' };
  }
  return { status: 'invalid', attemptsLeft: MAX_CODE_ATTEMPTS - attempts };
}

/** Verify the code of one specific pending challenge (sign-in and reset). */
export async function checkChallenge(
  db: Db,
  id: string,
  purpose: AuthCodePurpose,
  code: string,
): Promise<CodeCheck> {
  const rows = await db
    .select()
    .from(authCodes)
    .where(and(eq(authCodes.id, id), eq(authCodes.purpose, purpose)))
    .limit(1);
  return check(db, rows[0], code);
}

/** Verify the newest live code a signed-in user holds for a purpose. */
export async function checkUserCode(
  db: Db,
  userId: string,
  purpose: AuthCodePurpose,
  code: string,
): Promise<CodeCheck> {
  const rows = await db
    .select()
    .from(authCodes)
    .where(and(eq(authCodes.userId, userId), eq(authCodes.purpose, purpose)))
    .orderBy(desc(authCodes.createdAt))
    .limit(1);
  return check(db, rows[0], code);
}

/** The user a pending challenge belongs to, without spending an attempt. */
export async function pendingChallengeUser(
  db: Db,
  id: string,
  purpose: AuthCodePurpose,
): Promise<string | undefined> {
  const rows = await db
    .select({
      userId: authCodes.userId,
      expiresAt: authCodes.expiresAt,
      consumedAt: authCodes.consumedAt,
    })
    .from(authCodes)
    .where(and(eq(authCodes.id, id), eq(authCodes.purpose, purpose)))
    .limit(1);
  const row = rows[0];
  if (!row || row.consumedAt || row.expiresAt.getTime() <= Date.now()) return undefined;
  return row.userId;
}

// ------------------------------------------------------------------- cookie

/** Sign-in and password reset are separate flows, so they never share a cookie. */
export type ChallengeKind = 'login' | 'reset';
const COOKIE_NAME: Record<ChallengeKind, string> = { login: 'pending', reset: 'reset' };

export function setPendingChallenge(c: Context<AppEnv>, kind: ChallengeKind, id: string): void {
  setCookie(c, COOKIE_NAME[kind], id, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: c.get('env').baseUrl.startsWith('https://'),
    maxAge: (CODE_TTL_MINUTES + SEND_WINDOW_MINUTES) * 60,
  });
}

export const readPendingChallenge = (c: Context<AppEnv>, kind: ChallengeKind): string | undefined =>
  getCookie(c, COOKIE_NAME[kind]);

export function clearPendingChallenge(c: Context<AppEnv>, kind: ChallengeKind): void {
  deleteCookie(c, COOKIE_NAME[kind], { path: '/' });
}
