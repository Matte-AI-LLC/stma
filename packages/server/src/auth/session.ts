import { and, eq, gt, isNull, ne, or } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Db } from '../db';
import { users, webSessions } from '../db/schema';
import type { Env } from '../env';
import { isAdminUser } from '../lib/admin';
import { railFor } from '../lib/rail';
import { randomHex } from '../lib/crypto';
import type { AppEnv, User } from '../types';

const COOKIE_NAME = 'sid';

export async function createSession(c: Context<AppEnv>, userId: string): Promise<void> {
  const db = c.get('db');
  const env = c.get('env');
  const sid = randomHex(32);
  const expiresAt = new Date(Date.now() + env.sessionTtlDays * 24 * 60 * 60 * 1000);
  await db.insert(webSessions).values({ id: sid, userId, expiresAt });
  setCookie(c, COOKIE_NAME, sid, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: env.baseUrl.startsWith('https://'),
    maxAge: env.sessionTtlDays * 24 * 60 * 60,
  });
}

/** Sign out every other browser session of this user, keeping the current one. */
export async function invalidateOtherSessions(c: Context<AppEnv>, userId: string): Promise<void> {
  const db = c.get('db');
  const sid = getCookie(c, COOKIE_NAME);
  await db
    .delete(webSessions)
    .where(
      sid
        ? and(eq(webSessions.userId, userId), ne(webSessions.id, sid))
        : eq(webSessions.userId, userId),
    );
}

/**
 * Sign out every browser session of this user, including the current one — the
 * recovery path (password reset) must assume the live session is attacker-held.
 */
export async function invalidateAllSessions(db: Db, userId: string): Promise<void> {
  await db.delete(webSessions).where(eq(webSessions.userId, userId));
}

export async function destroySession(c: Context<AppEnv>): Promise<void> {
  const db = c.get('db');
  const sid = getCookie(c, COOKIE_NAME);
  if (sid) {
    await db.delete(webSessions).where(eq(webSessions.id, sid));
  }
  deleteCookie(c, COOKIE_NAME, { path: '/' });
}

/** Populates `c.var.user` from the session cookie (or null). */
export const sessionUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('user', null);
  const sid = getCookie(c, COOKIE_NAME);
  if (sid) {
    const db = c.get('db');
    const rows = await db
      .select({ user: users })
      .from(webSessions)
      .innerJoin(users, eq(webSessions.userId, users.id))
      .where(and(eq(webSessions.id, sid), gt(webSessions.expiresAt, new Date())))
      .limit(1);
    if (rows[0]) {
      const user: User = rows[0].user;
      user.isAdmin = isAdminUser(c.get('env'), user);
      // Only for pages that draw the rail. An API or MCP request must not pay
      // four counts for chrome it never renders.
      if (c.req.method === 'GET' && !c.req.path.startsWith('/api')) {
        user.rail = await railFor(db, user.id);
      }
      c.set('user', user);
    }
  }
  await next();
};

/** Only allow `next` values that are local absolute paths. */
export function sanitizeNext(next: string | undefined, fallback = '/app'): string {
  if (next && /^\/(?!\/)/.test(next)) return next;
  return fallback;
}

export function loginRedirect(c: Context<AppEnv>): Response {
  const next = encodeURIComponent(c.req.path);
  return c.redirect(`/login?next=${next}`);
}

/**
 * Find a dev-mode user by username or email (never matches GitHub-linked or
 * password-protected accounts — dev login must not be able to hijack a real one).
 */
export async function findDevUser(db: Db, identifier: string) {
  const rows = await db
    .select()
    .from(users)
    .where(
      and(
        or(eq(users.username, identifier), eq(users.email, identifier)),
        isNull(users.githubId),
        isNull(users.passwordHash),
      ),
    )
    .limit(1);
  return rows[0];
}
