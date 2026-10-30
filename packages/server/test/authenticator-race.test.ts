/**
 * A first-factor sign-in that races an authenticator being turned on.
 *
 * Enabling an authenticator commits it and then signs every other browser
 * out. A sign-in that asked "does this account have one?" just before that
 * commit, and wrote its session just after the sign-out, would keep a full
 * session with no code behind it. `startSignIn` asks again after writing the
 * session; this file makes the first answer stale on purpose, which a real
 * race does only rarely, and checks that the second one wins.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { hasActiveAuthenticator } from '../src/auth/secondFactor';
import { mfaChallenges, users, webSessions } from '../src/db/schema';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

vi.mock('../src/auth/secondFactor', async (original) => {
  const real = await original<typeof import('../src/auth/secondFactor')>();
  return { ...real, hasActiveAuthenticator: vi.fn(real.hasActiveAuthenticator) };
});

let srv: StartedServer;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'stma-authenticator-race-'));
  srv = await startServer(
    loadEnv({ port: 0, host: '127.0.0.1', nodeEnv: 'test', databaseUrl: undefined, pgliteDir: dir, devMode: true, twoFactor: false }),
  );
}, 120_000);

afterAll(async () => {
  await srv?.close();
  rmSync(dir, { recursive: true, force: true });
});

const devLogin = (username: string) =>
  fetch(`${srv.url}/auth/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '10.78.0.1' },
    body: new URLSearchParams({ username, next: '/app' }),
    redirect: 'manual',
  });

it('takes back a session written after an authenticator was turned on, and asks for the code', async () => {
  expect((await devLogin('race-user')).status).toBe(302);
  const [account] = await srv.db.select().from(users).where(eq(users.username, 'race-user'));
  const sessionsBefore = (await srv.db.select().from(webSessions).where(eq(webSessions.userId, account!.id))).length;
  expect(sessionsBefore).toBe(1);

  // The first read is from before the enrollment committed; the second, made
  // after this sign-in wrote its session, sees it.
  vi.mocked(hasActiveAuthenticator).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const res = await devLogin('race-user');
  expect(res.headers.get('location')).toBe('/login/authenticator');

  const cookies = res.headers.getSetCookie();
  const lastSid = cookies.filter((line) => line.startsWith('sid=')).at(-1);
  expect(lastSid, 'the session cookie is withdrawn').toMatch(/^sid=;|max-age=0/i);
  expect(cookies.some((line) => /^mfa=[0-9a-f-]{36};/i.test(line))).toBe(true);

  const sessionsAfter = await srv.db.select().from(webSessions).where(eq(webSessions.userId, account!.id));
  expect(sessionsAfter).toHaveLength(sessionsBefore);
  const challenges = await srv.db.select().from(mfaChallenges).where(eq(mfaChallenges.userId, account!.id));
  expect(challenges).toHaveLength(1);
  expect(challenges[0]!.method).toBe('dev');
  expect(challenges[0]!.consumedAt).toBeNull();
});

it('writes the session as before when both reads agree there is none', async () => {
  const res = await devLogin('race-plain');
  expect(res.headers.get('location')).toBe('/app');
  const [account] = await srv.db.select().from(users).where(eq(users.username, 'race-plain'));
  expect(await srv.db.select().from(webSessions).where(eq(webSessions.userId, account!.id))).toHaveLength(1);
  expect(await srv.db.select().from(mfaChallenges).where(eq(mfaChallenges.userId, account!.id))).toHaveLength(0);
});
