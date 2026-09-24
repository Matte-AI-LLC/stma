/**
 * Review access (`lib/reviewAccess.ts`): the one account an operator opens for
 * a directory reviewer signs in with its password alone, until a date.
 *
 * Claude's connector directory hands its reviewer a username and a password,
 * and sign-in here mails a code to an inbox the reviewer cannot read. What this
 * suite holds is the shape of the exception: it applies to one account, by an
 * operator's hand, with an end, and nothing else about the account loosens —
 * the throttle, the notice to the address, the address itself, the operator
 * gate. The server is configured the way production is: codes on, hosted,
 * beta, https base URL.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { users } from '../src/db/schema';
import { loadEnv } from '../src/env';
import { isAdminUser } from '../src/lib/admin';
import { mailOutbox } from '../src/lib/mailer';
import {
  REVIEW_ACCESS_MAX_DAYS,
  parseReviewLastDay,
  reviewAccessActive,
  reviewAccessLastDay,
} from '../src/lib/reviewAccess';
import { startServer, type StartedServer } from '../src/server';

let srv: StartedServer;
let dir: string;

type Jar = ReturnType<typeof jar>;

function jar() {
  const cookies = new Map<string, string>();
  return {
    header(extra: Record<string, string> = {}): Record<string, string> {
      return cookies.size
        ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...extra }
        : { ...extra };
    },
    store(res: Response) {
      for (const line of res.headers.getSetCookie()) {
        const [kv] = line.split(';');
        const i = kv!.indexOf('=');
        cookies.set(kv!.slice(0, i), kv!.slice(i + 1));
      }
    },
  };
}

const ip = (n: string) => ({ 'x-forwarded-for': `10.61.0.${n}` });

const post = (url: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(srv.url + url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields),
    redirect: 'manual',
  });

const where = (res: Response) => decodeURIComponent(res.headers.get('location') ?? '');

const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

function codeFor(email: string): string {
  const mail = mailOutbox.latest(email);
  expect(mail, `no mail for ${email}`).toBeTruthy();
  return /\b(\d{6})\b/.exec(mail!.text)![1]!;
}

async function operator(): Promise<Jar> {
  const j = jar();
  const res = await post('/auth/dev', { username: 'ops' });
  expect(res.status).toBe(302);
  j.store(res);
  return j;
}

/** An account made the way a person makes one: signup, then the emailed code. */
async function account(email: string, password: string, from: string, confirm = true) {
  const j = jar();
  const res = await post('/auth/local/signup', { email, password }, ip(from));
  expect(res.status).toBe(302);
  j.store(res);
  if (confirm) {
    const confirmed = await post('/app/account/email/verify', { code: codeFor(email) }, j.header(ip(from)));
    expect(confirmed.status).toBe(302);
  }
  const [row] = await srv.db.select().from(users).where(eq(users.email, email));
  return { id: row!.id, jar: j };
}

const login = (email: string, password: string, from: string) =>
  post('/auth/local/login', { email, password, next: '/app' }, ip(from));

beforeAll(async () => {
  process.env.ADMIN_USERNAMES = 'ops';
  dir = mkdtempSync(path.join(tmpdir(), 'stma-review-access-'));
  srv = await startServer(
    loadEnv({
      port: 0,
      host: '127.0.0.1',
      nodeEnv: 'test',
      devMode: true,
      databaseUrl: undefined,
      pgliteDir: dir,
      twoFactor: true,
      betaUnmetered: true,
      hosted: true,
      baseUrl: 'https://stma.ai',
    }),
  );
  delete process.env.ADMIN_USERNAMES;
}, 90_000);

afterAll(async () => {
  await srv?.close();
  mailOutbox.clear();
  rmSync(dir, { recursive: true, force: true });
});

describe('the last day an operator types', () => {
  it('is a real day, not in the past, and at most the ceiling away', () => {
    const now = new Date('2026-09-24T15:00:00Z');
    const today = parseReviewLastDay('2026-09-24', now);
    expect(today).toEqual({ until: new Date('2026-09-25T00:00:00Z') });
    expect(reviewAccessLastDay(new Date('2026-09-25T00:00:00Z'))).toBe('2026-09-24');
    expect(parseReviewLastDay('2026-11-23', now)).toHaveProperty('until');
    expect(REVIEW_ACCESS_MAX_DAYS).toBe(60);
    expect(parseReviewLastDay('2026-11-24', now)).toHaveProperty('error');
    expect(parseReviewLastDay('2026-09-23', now)).toHaveProperty('error');
    expect(parseReviewLastDay('2026-02-30', now)).toHaveProperty('error');
    expect(parseReviewLastDay('24.09.2026', now)).toHaveProperty('error');
    expect(parseReviewLastDay(undefined, now)).toHaveProperty('error');
  });

  it('never makes an operator, whatever the lists say', () => {
    const env = { adminUsernames: ['listed'], adminEmails: ['listed@example.com'] };
    const listed = { username: 'listed', email: 'listed@example.com', emailVerifiedAt: new Date() };
    expect(isAdminUser(env, listed)).toBe(true);
    expect(isAdminUser(env, { ...listed, reviewAccessUntil: new Date(Date.now() + 60_000) })).toBe(false);
    expect(isAdminUser(env, { ...listed, reviewAccessUntil: new Date(Date.now() - 60_000) })).toBe(true);
    expect(reviewAccessActive({ reviewAccessUntil: null })).toBe(false);
  });
});

describe('an account with review access', () => {
  it('signs in with its password alone, and the address is told each time', async () => {
    const email = 'reviewer@example.com';
    const { id } = await account(email, 'reviewpass123', '1');
    const before = await login(email, 'reviewpass123', '1');
    expect(where(before)).toContain('/login/verify');

    const ops = await operator();
    const on = await post(`/admin/users/${id}/review-access`, { last_day: day(10) }, ops.header());
    expect(on.status).toBe(302);
    expect(where(on)).toContain(`without an emailed code through ${day(10)}`);
    const page = await (await fetch(`${srv.url}/admin/users/${id}`, { headers: ops.header() })).text();
    expect(page).toContain(`on through ${day(10)} (UTC)`);

    mailOutbox.clear();
    const res = await login(email, 'reviewpass123', '1');
    expect(res.status).toBe(302);
    expect(where(res)).toBe('/app');
    const session = res.headers.getSetCookie().find((line) => line.startsWith('sid='));
    expect(session).toMatch(/Max-Age=86400/);
    expect(mailOutbox.latest(email)?.kind).toBe('review_sign_in');
    expect(mailOutbox.latest(email)?.text).toContain(day(10));
    const signedIn = jar();
    signedIn.store(res);
    expect((await fetch(`${srv.url}/app/account`, { headers: signedIn.header(), redirect: 'manual' })).status).toBe(200);
  });

  it('still answers a wrong password and still locks after five', async () => {
    const email = 'reviewer-lock@example.com';
    const { id } = await account(email, 'lockpass12345', '2');
    const ops = await operator();
    expect((await post(`/admin/users/${id}/review-access`, { last_day: day(5) }, ops.header())).status).toBe(302);
    for (let i = 0; i < 5; i++) {
      expect(where(await login(email, 'wrong-password', '2'))).toContain('/login?error=');
    }
    // The right password is refused too while the lock holds: a throttle a
    // correct guess walks through is not a throttle, for this door as well.
    const locked = await login(email, 'lockpass12345', '2');
    expect(where(locked)).toContain('Too many');
    expect(locked.headers.getSetCookie().some((line) => line.startsWith('sid='))).toBe(false);
  });

  it('keeps its address and cannot delete itself while it runs', async () => {
    const email = 'reviewer-keep@example.com';
    const { id } = await account(email, 'keeppass12345', '3');
    const ops = await operator();
    expect((await post(`/admin/users/${id}/review-access`, { last_day: day(3) }, ops.header())).status).toBe(302);
    const signedIn = jar();
    signedIn.store(await login(email, 'keeppass12345', '3'));

    const change = await post(
      '/app/account/email/change',
      { email: 'somebody-else@example.com', current_password: 'keeppass12345' },
      signedIn.header(ip('3')),
    );
    expect(where(change)).toContain('keeps its address');
    expect(mailOutbox.latest('somebody-else@example.com')).toBeUndefined();
    const deleted = await post('/app/account/delete', { confirm: 'reviewer-keep' }, signedIn.header(ip('3')));
    expect(where(deleted)).toContain('cannot be deleted');
    const [row] = await srv.db.select().from(users).where(eq(users.id, id));
    expect(row?.email).toBe(email);
  });

  it('lapses by the clock, and turning it off signs every browser out', async () => {
    const email = 'reviewer-end@example.com';
    const { id } = await account(email, 'endpass123456', '4');
    const ops = await operator();
    expect((await post(`/admin/users/${id}/review-access`, { last_day: day(2) }, ops.header())).status).toBe(302);
    const signedIn = jar();
    signedIn.store(await login(email, 'endpass123456', '4'));

    const off = await post(`/admin/users/${id}/review-access/off`, {}, ops.header());
    expect(where(off)).toContain('every browser was signed out');
    const after = await fetch(`${srv.url}/app/account`, { headers: signedIn.header(), redirect: 'manual' });
    expect(after.status).toBe(302);
    expect(where(await login(email, 'endpass123456', '4'))).toContain('/login/verify');

    // Nothing sweeps it: the date alone decides.
    await srv.db.update(users).set({ reviewAccessUntil: new Date(Date.now() - 1000) }).where(eq(users.id, id));
    expect(where(await login(email, 'endpass123456', '4'))).toContain('/login/verify');
  });
});

describe('who can be given it, and by whom', () => {
  it('is refused for an operator, an unconfirmed address and a day out of range', async () => {
    const ops = await operator();
    const [opsRow] = await srv.db.select().from(users).where(eq(users.username, 'ops'));
    const self = await post(`/admin/users/${opsRow!.id}/review-access`, { last_day: day(3) }, ops.header());
    expect(where(self)).toContain('An operator account cannot have review access');

    const unconfirmed = await account('reviewer-unconfirmed@example.com', 'unconfpass123', '5', false);
    const refused = await post(`/admin/users/${unconfirmed.id}/review-access`, { last_day: day(3) }, ops.header());
    expect(where(refused)).toContain("Confirm the account's address first");

    const confirmed = await account('reviewer-range@example.com', 'rangepass1234', '6');
    const far = await post(`/admin/users/${confirmed.id}/review-access`, { last_day: day(REVIEW_ACCESS_MAX_DAYS + 2) }, ops.header());
    expect(where(far)).toContain(`at most ${REVIEW_ACCESS_MAX_DAYS} days`);
    const past = await post(`/admin/users/${confirmed.id}/review-access`, { last_day: day(-2) }, ops.header());
    expect(where(past)).toContain('already ended');
    const [row] = await srv.db.select().from(users).where(eq(users.id, confirmed.id));
    expect(row?.reviewAccessUntil).toBeNull();
  });

  it('is not a door for anybody but an operator', async () => {
    const member = await account('reviewer-self@example.com', 'selfpass12345', '7');
    const res = await post(`/admin/users/${member.id}/review-access`, { last_day: day(3) }, member.jar.header(ip('7')));
    expect(res.status).toBe(404);
    const [row] = await srv.db.select().from(users).where(eq(users.id, member.id));
    expect(row?.reviewAccessUntil).toBeNull();
  });
});
