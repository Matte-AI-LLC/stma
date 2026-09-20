import { and, desc, eq, gt, isNull, ne, or, sql } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Db } from '../db';
import { users, webSessions } from '../db/schema';
import { isAdminUser } from '../lib/admin';
import { railFor } from '../lib/rail';
import { randomHex, sha256hex } from '../lib/crypto';
import { clientIp } from '../lib/ratelimit';
import type { AppEnv, User } from '../types';
import { authorizeSecurity, setSecurityPrincipal } from '../lib/securityHooks';

const COOKIE_NAME = 'sid';
/** How stale "last seen" may get before a request pays to refresh it. */
const SEEN_EVERY_MS = 5 * 60_000;

/** What the client said it is, kept short enough to render and to store. */
const describeClient = (c: Context<AppEnv>): string | null =>
  c.req.header('user-agent')?.slice(0, 300) ?? null;

export async function createSession(c: Context<AppEnv>, userId: string): Promise<string> {
  const db = c.get('db');
  const env = c.get('env');
  const sid = randomHex(32);
  const expiresAt = new Date(Date.now() + env.sessionTtlDays * 24 * 60 * 60 * 1000);
  await db.insert(webSessions).values({
    id: sid,
    userId,
    expiresAt,
    userAgent: describeClient(c),
    lastIp: clientIp(c),
    lastSeenAt: new Date(),
  });
  setCookie(c, COOKIE_NAME, sid, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: env.baseUrl.startsWith('https://'),
    maxAge: env.sessionTtlDays * 24 * 60 * 60,
  });
  return sid;
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

/** The session this request arrived on, so a list can mark one row "this browser". */
export const currentSessionId = (c: Context<AppEnv>): string | undefined => getCookie(c, COOKIE_NAME);

/**
 * A name for a session that is safe to put in a page.
 *
 * The row's id IS the session secret — it is what the cookie carries — so a
 * list that rendered ids would print every other browser's live credential into
 * the HTML of this one. A digest identifies the row for a revoke form and is
 * worth nothing to anyone who reads it.
 */
export const sessionHandle = (id: string): string => sha256hex(id).slice(0, 16);

export interface BrowserSession {
  /** The digest, not the id. Nothing here may carry the secret. */
  handle: string;
  userAgent: string | null;
  lastIp: string | null;
  lastSeenAt: Date | null;
  createdAt: Date;
  current: boolean;
}

/**
 * Where this person is signed in, newest activity first.
 *
 * Bounded like every other list here: somebody with a hundred rows has a
 * problem the page cannot solve by rendering all hundred, and the count says so.
 */
export const SESSIONS_SHOWN = 20;

export async function sessionsFor(
  db: Db,
  userId: string,
  currentId: string | undefined,
): Promise<BrowserSession[]> {
  const rows = await db
    .select()
    .from(webSessions)
    .where(and(eq(webSessions.userId, userId), gt(webSessions.expiresAt, new Date())))
    // Nulls last, explicitly: rows that predate the column would otherwise sort
    // to the top in Postgres and push the session the person is reading this on
    // to the bottom of their own list.
    .orderBy(sql`${webSessions.lastSeenAt} desc nulls last`, desc(webSessions.createdAt))
    .limit(SESSIONS_SHOWN);
  return rows.map((row) => ({
    handle: sessionHandle(row.id),
    userAgent: row.userAgent,
    lastIp: row.lastIp,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
    current: row.id === currentId,
  }));
}

/**
 * End one session by its handle, and only one of this person's own.
 *
 * The digest is resolved against this user's rows rather than stored, so the
 * secret stays in one column and a handle from somebody else's page matches
 * nothing here.
 */
export async function revokeSession(db: Db, userId: string, handle: string): Promise<boolean> {
  const rows = await db
    .select({ id: webSessions.id })
    .from(webSessions)
    .where(eq(webSessions.userId, userId));
  const match = rows.find((row) => sessionHandle(row.id) === handle);
  if (!match) return false;
  await db.delete(webSessions).where(eq(webSessions.id, match.id));
  return true;
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
      .select({ user: users, lastSeenAt: webSessions.lastSeenAt })
      .from(webSessions)
      .innerJoin(users, eq(webSessions.userId, users.id))
      .where(and(eq(webSessions.id, sid), gt(webSessions.expiresAt, new Date())))
      .limit(1);
    if (rows[0]) {
      const user: User = rows[0].user;
      // "Last seen" has to be roughly true to be worth reading, and a write on
      // every request would make every page load pay for a column nobody reads
      // most of the time. Once every SEEN_EVERY_MS is close enough to tell a
      // live session from one somebody left open in March.
      const seen = rows[0].lastSeenAt?.getTime() ?? 0;
      if (Date.now() - seen > SEEN_EVERY_MS) {
        void db
          .update(webSessions)
          .set({ lastSeenAt: new Date(), lastIp: clientIp(c) })
          .where(eq(webSessions.id, sid))
          .catch(() => {});
      }
      setSecurityPrincipal({ userId: user.id, sessionId: sid, path: c.req.path, method: c.req.method });
      const denied = await authorizeSecurity(db, 'browser');
      if (denied) return c.text(denied, 403);
      user.isAdmin = isAdminUser(c.get('env'), user);
      user.organizationSecurity = c.get('capabilities').organizationSecurity;
      // Only where there is a confirmation mechanism at all: without email codes
      // nothing ever sets `email_verified_at`, and a permanent warning about a
      // state the server cannot leave is noise, not a notice.
      user.addressUnconfirmed =
        c.get('env').twoFactor && Boolean(user.email) && !user.emailVerifiedAt;
      // Only for pages that draw the rail. An API or MCP request must not pay
      // four counts for chrome it never renders.
      if (c.req.method === 'GET' && !c.req.path.startsWith('/api')) {
        // A team page is authoritative about the rail's current team. Without
        // this hint, a multi-team user always saw their newest team in the rail
        // and every scoped link quietly jumped away from the page they were on.
        // The same for the project: the console has a workspace scope and a
        // project scope, and the address says which one the page is in — in its
        // path, or as the `team` / `project` filter of a list page that lives
        // outside the workspace path (agent map, sessions, work, connections).
        const inPath = /^\/app\/teams\/([^/]+)(?:\/projects\/([^/]+))?/.exec(c.req.path);
        const decode = (value: string | undefined) => {
          try { return value ? decodeURIComponent(value) : undefined; } catch { return undefined; }
        };
        const scoped = decode(inPath?.[1]) ?? (c.req.query('team')?.trim() || undefined);
        const project = decode(inPath?.[2]) ?? (c.req.query('project')?.trim() || undefined);
        user.rail = await railFor(db, user.id, scoped, project);
      }
      c.set('user', user);
    }
  }
  await next();
};

/**
 * Only allow `next` values that are local absolute paths.
 *
 * "Starts with one slash and not two" is not the same test as "stays on this
 * origin", because the URL parser browsers implement reads a backslash in the
 * authority position as a slash: `/\evil.example` resolves to
 * `https://evil.example/`. That is the ideal shape for "your STMA session
 * expired, sign in again", since the link it sits in really does begin with
 * this site's address. Asking the parser is the check; the regex was a
 * description of one.
 */
export function sanitizeNext(next: string | undefined, fallback = '/app'): string {
  if (!next || !next.startsWith('/')) return fallback;
  try {
    // Any host in `next` wins over this base, so an unchanged origin is proof
    // there was none. `http://x.invalid` is unreachable by construction.
    const probe = new URL(next, 'http://x.invalid');
    if (probe.origin !== 'http://x.invalid') return fallback;
    return `${probe.pathname}${probe.search}${probe.hash}`;
  } catch {
    return fallback;
  }
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
