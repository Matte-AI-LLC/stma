/**
 * Authenticator apps (RFC 6238 TOTP): enrollment, every sign-in path, recovery
 * codes, the operator reset, and the rule that no path writes a session on its
 * own.
 *
 * The main server is configured the way production is (codes emailed, hosted,
 * https) with dev login and GitHub switched on as well, so one database can
 * show every door asking for the code. A second server has `AUTH_2FA` off,
 * because the authenticator must not depend on it.
 *
 * Codes are computed from absolute time steps. Each use waits out the last
 * three seconds of a step first, so a request never straddles a boundary, and
 * a user never needs more codes than the window around one step allows.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { Secret } from 'otpauth';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  authenticatorResets,
  invites,
  mfaChallenges,
  recoveryCodes,
  userAuthenticators,
  users,
  webSessions,
} from '../src/db/schema';
import { loadEnv } from '../src/env';
import { MALFORMED_FACTOR, WRONG_FACTOR, FACTOR_KEY_UNAVAILABLE, firstStepOf, type SignInMethod } from '../src/auth/signIn';
import { matchStep, totpCode, totpStep } from '../src/auth/totp';
import { verifySecondFactor } from '../src/auth/secondFactor';
import { authenticatorLockedEmail, mailOutbox } from '../src/lib/mailer';
import { openAuthSecret, resealAuthSecret, sealAuthSecret, authSecretsAvailable } from '../src/lib/secretStore';
import { startServer, type StartedServer } from '../src/server';
import { OPERATOR_SIGN_IN_AGAIN } from '../src/routes/admin';

const STEP = 30_000;
const KEY_A = randomBytes(32).toString('hex');
const KEY_B = randomBytes(32).toString('hex');

function useKeys(keys: Record<string, string> | undefined, active = 'k1') {
  vi.stubEnv('STMA_INTEGRATION_KEYS', keys ? JSON.stringify(keys) : '');
  vi.stubEnv('STMA_INTEGRATION_ACTIVE_KEY', keys ? active : '');
}

// ------------------------------------------------------------------ unit

describe('TOTP through otpauth', () => {
  it('reproduces the RFC 6238 Appendix B vectors', () => {
    const seeds = {
      SHA1: '12345678901234567890',
      SHA256: '12345678901234567890123456789012',
      SHA512: '1234567890123456789012345678901234567890123456789012345678901234',
    } as const;
    const vectors: Array<[number, string, string, string]> = [
      [59, '94287082', '46119246', '90693936'],
      [1111111109, '07081804', '68084774', '25091201'],
      [1111111111, '14050471', '67062674', '99943326'],
      [1234567890, '89005924', '91819424', '93441116'],
      [2000000000, '69279037', '90698825', '38618901'],
      [20000000000, '65353130', '77737706', '47863826'],
    ];
    for (const [t, sha1, sha256, sha512] of vectors) {
      const at = t * 1000;
      expect(totpCode(Secret.fromUTF8(seeds.SHA1).base32, at, { algorithm: 'SHA1', digits: 8 })).toBe(sha1);
      expect(totpCode(Secret.fromUTF8(seeds.SHA256).base32, at, { algorithm: 'SHA256', digits: 8 })).toBe(sha256);
      expect(totpCode(Secret.fromUTF8(seeds.SHA512).base32, at, { algorithm: 'SHA512', digits: 8 })).toBe(sha512);
    }
  });

  it('accepts one step either side of now and nothing further, and only six digits', () => {
    const secret = new Secret({ size: 20 }).base32;
    const now = 1_790_000_015_000;
    const step = totpStep(now);
    for (const offset of [-1, 0, 1]) {
      expect(matchStep(secret, totpCode(secret, now + offset * STEP), now)).toBe(step + offset);
    }
    for (const offset of [-2, 2]) {
      expect(matchStep(secret, totpCode(secret, now + offset * STEP), now)).toBeNull();
    }
    const right = totpCode(secret, now);
    expect(matchStep(secret, `${right.slice(0, 5)}x`, now)).toBeNull();
    expect(matchStep(secret, right.slice(0, 5), now)).toBeNull();
    expect(matchStep(secret, `${right}0`, now)).toBeNull();
    expect(matchStep(secret, '', now)).toBeNull();
  });
});

describe('sealing an authenticator secret', () => {
  // The servers below read the same keyring from the environment.
  afterAll(() => useKeys({ k1: KEY_A }));

  it('refuses without a keyring, whatever the plaintext compatibility switch says', async () => {
    useKeys(undefined);
    vi.stubEnv('STMA_INTEGRATION_REQUIRE_ENCRYPTION', '');
    expect(authSecretsAvailable()).toBe(false);
    await expect(sealAuthSecret('JBSWY3DPEHPK3PXP', randomUUID())).rejects.toThrow(/encryption key/);
  });

  it('opens under a rotated keyring, writes on the active key, and is bound to its account', async () => {
    const user = randomUUID();
    useKeys({ k1: KEY_A });
    const old = await sealAuthSecret('JBSWY3DPEHPK3PXP', user);
    expect(old).toMatch(/^enc:v1:k1:/);
    expect(old).not.toContain('JBSWY3DPEHPK3PXP');
    useKeys({ k1: KEY_A, k2: KEY_B }, 'k2');
    expect(await openAuthSecret(old, user)).toBe('JBSWY3DPEHPK3PXP');
    expect(await sealAuthSecret('JBSWY3DPEHPK3PXP', user)).toMatch(/^enc:v1:k2:/);
    await expect(openAuthSecret(old, randomUUID())).rejects.toThrow();
    await expect(openAuthSecret('JBSWY3DPEHPK3PXP', user)).rejects.toThrow(/not sealed/);
  });

  it('moves a secret onto the active key for a rotation, and refuses one it cannot open', async () => {
    const user = randomUUID();
    useKeys({ k1: KEY_A });
    const old = await sealAuthSecret('JBSWY3DPEHPK3PXP', user);
    useKeys({ k1: KEY_A, k2: KEY_B }, 'k2');
    const moved = await resealAuthSecret(old, user);
    expect(moved).toMatch(/^enc:v1:k2:/);
    // The old key can be retired once every row has moved.
    useKeys({ k2: KEY_B }, 'k2');
    expect(await openAuthSecret(moved, user)).toBe('JBSWY3DPEHPK3PXP');
    await expect(resealAuthSecret(old, user)).rejects.toThrow();
    await expect(resealAuthSecret(moved, randomUUID())).rejects.toThrow();
  });
});

// ------------------------------------------------------------------ http

describe('the lock mail names the step that was passed', () => {
  const at = new Date('2026-10-22T14:05:00Z');
  const body = (m: ReturnType<typeof authenticatorLockedEmail>) => [m.subject, m.text, m.html].join('\n');

  it('tells a password sign-in that the password is known, and that a reset does not shorten the wait', () => {
    const m = authenticatorLockedEmail('https://stma.ai', at, 'password');
    expect(m.kind).toBe('authenticator_locked');
    expect(m.text).toContain('after your password was accepted');
    expect(m.text).toContain('change your password now');
    expect(m.text).toContain('changing the password does not shorten the wait');
    expect(m.text).toContain('https://stma.ai/forgot');
    expect(m.text).toContain('14:05 UTC');
  });

  it('sends a GitHub sign-in to GitHub, and never asks for a password change', () => {
    const m = authenticatorLockedEmail('https://stma.ai', at, 'github');
    expect(m.text).toContain('after your GitHub account signed you in');
    expect(m.text).toContain('secure your GitHub account');
    expect(body(m)).not.toMatch(/password/i);
    expect(body(m)).not.toContain('/forgot');
  });

  it('words an organization, a passwordless browser and a browser with a password apart', () => {
    const org = authenticatorLockedEmail('https://stma.ai', at, 'organization');
    expect(org.text).toContain("organization's administrator");
    expect(body(org)).not.toMatch(/password/i);
    const bare = authenticatorLockedEmail('https://stma.ai', at, 'browser');
    expect(bare.text).toContain('a browser already signed in');
    expect(body(bare)).not.toMatch(/password/i);
    const withPassword = authenticatorLockedEmail('https://stma.ai', at, 'browser', { hasPassword: true });
    expect(withPassword.text).toContain('change your password');
    const dev = body(authenticatorLockedEmail('https://stma.ai', at, 'development'));
    expect(dev).not.toContain('change your password');
    expect(dev).not.toContain('/forgot');
  });

  it('maps every sign-in method to the step it began with', () => {
    const steps: Record<SignInMethod, string> = {
      password: 'password',
      email_code: 'password',
      review: 'password',
      test: 'password',
      signup: 'password',
      github: 'github',
      oidc: 'organization',
      dev: 'development',
    };
    for (const [method, step] of Object.entries(steps)) expect(firstStepOf(method)).toBe(step);
  });
});

let srv: StartedServer;
let off: StartedServer;
const dirs: string[] = [];

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
        const name = kv!.slice(0, i);
        const value = kv!.slice(i + 1);
        if (value === '' || /max-age=0/i.test(line)) cookies.delete(name);
        else cookies.set(name, value);
      }
    },
    get: (name: string) => cookies.get(name),
    set: (name: string, value: string) => cookies.set(name, value),
  };
}
type Jar = ReturnType<typeof jar>;

const ip = (n: string) => ({ 'x-forwarded-for': `10.77.0.${n}` });
const where = (res: Response) => decodeURIComponent(res.headers.get('location') ?? '');

function poster(server: () => StartedServer) {
  return (url: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(server().url + url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(fields),
      redirect: 'manual',
    });
}
const post = poster(() => srv);
const postOff = poster(() => off);
const get = (url: string, j?: Jar, server = srv) =>
  fetch(server.url + url, { headers: j?.header() ?? {}, redirect: 'manual' });

/** A code for the step `offset` away from now, never in the last three seconds of a step. */
async function code(secret: string, offset = 0): Promise<string> {
  const into = Date.now() % STEP;
  if (into > STEP - 3000) await new Promise((r) => setTimeout(r, STEP - into + 50));
  return totpCode(secret, Date.now() + offset * STEP);
}

/** The newest code mailed to this address for one purpose. */
function emailCodeFor(
  email: string,
  kind: 'login_code' | 'email_verify_code' | 'password_reset_code' | 'password_change_code',
): string {
  const mail = [...mailOutbox.all()].reverse().find((m) => m.to === email && m.kind === kind);
  expect(mail, `no ${kind} mail for ${email}`).toBeTruthy();
  return /\b(\d{6})\b/.exec(mail!.text)![1]!;
}

const kindsFor = (email: string) => mailOutbox.all().filter((m) => m.to === email).map((m) => m.kind);
const sessionsOf = async (server: StartedServer, userId: string) =>
  (await server.db.select().from(webSessions).where(eq(webSessions.userId, userId))).length;
const userId = async (server: StartedServer, email: string) =>
  (await server.db.select().from(users).where(eq(users.email, email)))[0]!.id;

interface Enrolled {
  id: string;
  jar: Jar;
  secret: string;
  uri: string;
  codes: string[];
  enrollHtml: string;
  confirm: Response;
}

/** Signup, then the enrollment a person makes from Account. Spends the step before now. */
async function enroll(
  email: string,
  password: string,
  from: string,
  p = post,
  server = () => srv,
): Promise<Enrolled> {
  const j = jar();
  const signed = await p('/auth/local/signup', { email, password }, ip(from));
  expect(signed.status).toBe(302);
  j.store(signed);
  return enrollJar(j, (await userId(server(), email)), from, { current_password: password }, p);
}

async function enrollJar(
  j: Jar,
  id: string,
  from: string,
  reauth: Record<string, string>,
  p = post,
): Promise<Enrolled> {
  const start = await p('/app/account/security/start', reauth, j.header(ip(from)));
  expect(start.status, await start.clone().text()).toBe(200);
  const enrollHtml = await start.text();
  const secret = /secret=([A-Z2-7]+)/.exec(enrollHtml)![1]!;
  const uri = /href="(otpauth:\/\/[^"]+)"/.exec(enrollHtml)![1]!.replace(/&amp;/g, '&');
  const confirm = await p('/app/account/security/confirm', { code: await code(secret, -1) }, j.header(ip(from)));
  expect(confirm.status).toBe(200);
  const html = await confirm.clone().text();
  const codes = [...new Set([...html.matchAll(/<li>([a-z2-7]{5}-[a-z2-7]{5})<\/li>/g)].map((m) => m[1]!))];
  expect(codes).toHaveLength(10);
  return { id, jar: j, secret, uri, codes, enrollHtml, confirm };
}

/** The password half of a sign-in. Returns the browser, holding only its `mfa` cookie. */
async function passwordStep(email: string, password: string, from: string, p = post) {
  const j = jar();
  const res = await p('/auth/local/login', { email, password, next: '/app' }, ip(from));
  j.store(res);
  return { jar: j, res };
}

const factorStep = (j: Jar, input: string, from: string, p = post) =>
  p('/auth/mfa/verify', { code: input }, j.header(ip(from)));

beforeAll(async () => {
  useKeys({ k1: KEY_A });
  process.env.ADMIN_USERNAMES = 'ops';
  const boot = async (overrides: Parameters<typeof loadEnv>[0]) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stma-authenticator-'));
    dirs.push(dir);
    return startServer(
      loadEnv({ port: 0, host: '127.0.0.1', nodeEnv: 'test', databaseUrl: undefined, pgliteDir: dir, ...overrides }),
    );
  };
  srv = await boot({
    devMode: true,
    twoFactor: true,
    hosted: true,
    betaUnmetered: true,
    baseUrl: 'https://stma.ai',
    github: { clientId: 'gh-client', clientSecret: 'gh-secret' },
  });
  off = await boot({ devMode: false, twoFactor: false });
  delete process.env.ADMIN_USERNAMES;
}, 120_000);

afterAll(async () => {
  await srv?.close();
  await off?.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  mailOutbox.clear();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('enrollment', () => {
  it('needs the current password, counted against the sign-in throttle', async () => {
    const j = jar();
    j.store(await post('/auth/local/signup', { email: 'enr-pw@example.com', password: 'enrollpass123' }, ip('1')));
    const wrong = await post('/app/account/security/start', { current_password: 'not-it-at-all' }, j.header(ip('1')));
    expect(where(wrong)).toContain('Current password is incorrect');
    expect(where(wrong)).toContain('#security');
    // The shared counter: four more wrong passwords here lock the sign-in form.
    for (let i = 0; i < 4; i++) {
      await post('/app/account/security/start', { current_password: `nope-${i}-xx` }, j.header(ip('1')));
    }
    const login = await post('/auth/local/login', { email: 'enr-pw@example.com', password: 'enrollpass123' }, ip('2'));
    expect(where(login)).toContain('Too many sign-in attempts');
    const id = await userId(srv, 'enr-pw@example.com');
    expect((await srv.db.select().from(userAuthenticators).where(eq(userAuthenticators.userId, id))).length).toBe(0);
  });

  it('turns nothing on until a valid code, expires, and ends the other sessions when it does', async () => {
    const email = 'enr-flow@example.com';
    const j = jar();
    j.store(await post('/auth/local/signup', { email, password: 'enrollflow123' }, ip('3')));
    const other = (await passwordStep(email, 'enrollflow123', '4')).jar;
    other.store(await post('/auth/local/verify', { code: emailCodeFor(email, 'login_code'), next: '/app' }, other.header(ip('4'))));
    expect((await get('/app', other)).status).toBe(200);
    const id = await userId(srv, email);

    const start = await post('/app/account/security/start', { current_password: 'enrollflow123' }, j.header(ip('3')));
    const html = await start.text();
    const secret = /secret=([A-Z2-7]+)/.exec(html)![1]!;
    expect(html).toContain('<svg');

    const wrong = await post('/app/account/security/confirm', { code: '000000' }, j.header(ip('3')));
    expect(wrong.status).toBe(422);
    const wrongHtml = await wrong.text();
    expect(wrongHtml).not.toContain(secret);
    const [pending] = await srv.db.select().from(userAuthenticators).where(eq(userAuthenticators.userId, id));
    expect(pending!.enabledAt).toBeNull();
    expect(pending!.secretRef).toMatch(/^enc:v1:k1:/);
    expect(pending!.secretRef).not.toContain(secret);

    // Expired: a right code no longer turns it on.
    await srv.db
      .update(userAuthenticators)
      .set({ pendingExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(userAuthenticators.userId, id));
    const late = await post('/app/account/security/confirm', { code: await code(secret) }, j.header(ip('3')));
    expect(where(late)).toContain('expired');
    expect((await srv.db.select().from(userAuthenticators).where(eq(userAuthenticators.userId, id)))[0]!.enabledAt).toBeNull();

    const fresh = await enrollJar(j, id, '3', { current_password: 'enrollflow123' });
    expect(fresh.confirm.headers.get('cache-control')).toContain('no-store');
    const [row] = await srv.db.select().from(userAuthenticators).where(eq(userAuthenticators.userId, id));
    expect(row!.enabledAt).not.toBeNull();
    const [mine] = await srv.db
      .select()
      .from(webSessions)
      .where(eq(webSessions.id, j.get('sid')!));
    expect(mine!.mfaAt).not.toBeNull();
    expect(await sessionsOf(srv, id)).toBe(1);
    expect(where(await get('/app', other))).toContain('/login');
    expect(kindsFor(email)).toContain('authenticator_enabled');
    expect((await srv.db.select().from(users).where(eq(users.id, id)))[0]!.secondFactorChangedAt).not.toBeNull();
  });

  it('refuses an account with no password whose sign-in is older than ten minutes, and takes a fresh one', async () => {
    const j = jar();
    j.store(await post('/auth/dev', { username: 'dev-stale' }, ip('5')));
    await srv.db
      .update(webSessions)
      .set({ createdAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(webSessions.id, j.get('sid')!));
    const stale = await post('/app/account/security/start', {}, j.header(ip('5')));
    expect(where(stale)).toContain('Sign in again');
    await srv.db
      .update(webSessions)
      .set({ createdAt: new Date() })
      .where(eq(webSessions.id, j.get('sid')!));
    const ok = await post('/app/account/security/start', {}, j.header(ip('5')));
    expect(ok.status).toBe(200);
  });

  it('is not offered, and cannot start, without an encryption key', async () => {
    const j = jar();
    j.store(await post('/auth/local/signup', { email: 'enr-nokey@example.com', password: 'nokeypass123' }, ip('6')));
    useKeys(undefined);
    try {
      const page = await (await get('/app/account', j)).text();
      expect(page).toContain('cannot store authenticator secrets');
      const start = await post('/app/account/security/start', { current_password: 'nokeypass123' }, j.header(ip('6')));
      expect(where(start)).toContain('need an encryption key');
    } finally {
      useKeys({ k1: KEY_A });
    }
  });
});

describe('signing in with an authenticator', () => {
  it('stops at a challenge that is nobody\'s session, then writes a new one', async () => {
    const email = 'si-basic@example.com';
    const e = await enroll(email, 'signinpass123', '10');
    await post('/app/account/sessions/revoke-all', {}, e.jar.header(ip('10')));
    expect(await sessionsOf(srv, e.id)).toBe(0);
    const before = kindsFor(email).filter((k) => k === 'login_code').length;

    const { jar: j, res } = await passwordStep(email, 'signinpass123', '11');
    expect(where(res)).toBe('/login/authenticator');
    expect(j.get('mfa')).toBeTruthy();
    expect(j.get('sid')).toBeUndefined();
    // No emailed code beside the authenticator, and no session row at all.
    expect(kindsFor(email).filter((k) => k === 'login_code').length).toBe(before);
    expect(await sessionsOf(srv, e.id)).toBe(0);

    // With only the challenge cookie, every door reads the browser as signed out.
    expect(where(await get('/app', j))).toContain('/login');
    expect((await post('/oauth/authorize', { decision: 'allow' }, j.header(ip('11')))).status).toBe(401);
    expect(where(await post('/app/tokens', { name: 'x' }, j.header(ip('11'))))).toContain('/login');
    const mcp = await fetch(`${srv.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...j.header() },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(mcp.status).toBe(401);

    const page = await get('/login/authenticator', j);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).not.toContain(email);
    expect(html).not.toContain('si-basic');

    const done = await factorStep(j, await code(e.secret), '11');
    expect(where(done)).toBe('/app');
    j.store(done);
    const sid = j.get('sid')!;
    expect(sid).toBeTruthy();
    expect(sid).not.toBe(e.jar.get('sid'));
    expect(j.get('mfa')).toBeUndefined();
    const [row] = await srv.db.select().from(webSessions).where(eq(webSessions.id, sid));
    expect(row!.mfaAt).not.toBeNull();
    expect((await get('/app', j)).status).toBe(200);
  });

  const attemptFor = (email: string, password: string, from: string) => async (input: string) => {
    const { jar: j } = await passwordStep(email, password, from);
    return where(await factorStep(j, input, from));
  };

  it('refuses wrong, expired and future codes, and a malformed one costs nothing', async () => {
    const email = 'si-wrong@example.com';
    const e = await enroll(email, 'wrongpass1234', '12');
    const attempt = attemptFor(email, 'wrongpass1234', '13');
    expect(await attempt('123456')).toContain(WRONG_FACTOR);
    expect(await attempt(await code(e.secret, -3))).toContain(WRONG_FACTOR);
    expect(await attempt(await code(e.secret, 3))).toContain(WRONG_FACTOR);
    expect(await attempt('12345')).toContain(MALFORMED_FACTOR);
    expect(await attempt('not a code at all')).toContain(MALFORMED_FACTOR);
    // Three failures so far: the malformed entries spent none, so a right code still works.
    expect(await attempt(await code(e.secret, 0))).toBe('/app');
  });

  it('refuses a code twice, and an older step after a newer one', async () => {
    const email = 'si-replay@example.com';
    const e = await enroll(email, 'replaypass123', '9');
    const attempt = attemptFor(email, 'replaypass123', '8');
    const newer = await code(e.secret, 1);
    const older = await code(e.secret, 0);
    expect(await attempt(newer)).toBe('/app');
    expect(await attempt(older)).toContain(WRONG_FACTOR);
    expect(await attempt(newer)).toContain(WRONG_FACTOR);
  });

  it('lets one code win when two challenges race with it', async () => {
    const email = 'si-race@example.com';
    const e = await enroll(email, 'racepass12345', '14');
    const a = (await passwordStep(email, 'racepass12345', '15')).jar;
    const b = (await passwordStep(email, 'racepass12345', '16')).jar;
    const shared = await code(e.secret, 0);
    const results = await Promise.all([factorStep(a, shared, '15'), factorStep(b, shared, '16')]);
    const won = results.filter((r) => where(r) === '/app');
    expect(won).toHaveLength(1);
    expect(results.filter((r) => where(r).includes(WRONG_FACTOR))).toHaveLength(1);
  });

  it('locks the account after five wrong codes across challenges, a right code included, and tells the address', async () => {
    const email = 'si-lock@example.com';
    const e = await enroll(email, 'lockpass12345', '17');
    const first = (await passwordStep(email, 'lockpass12345', '18')).jar;
    for (let i = 0; i < 3; i++) expect(where(await factorStep(first, '111111', '18'))).toContain(WRONG_FACTOR);
    const second = (await passwordStep(email, 'lockpass12345', '19')).jar;
    await factorStep(second, '222222', '19');
    const fifth = await factorStep(second, '333333', '19');
    expect(where(fifth)).toContain('Too many wrong codes');
    // Its own mail, not the password one: it says the password is known, and
    // that a reset does not reopen the code step.
    expect(kindsFor(email)).not.toContain('failed_sign_ins');
    const locked = [...mailOutbox.all()].reverse().find((m) => m.to === email && m.kind === 'authenticator_locked');
    expect(locked?.text).toContain('after your password was accepted');
    expect(locked?.text).toContain('changing the password does not shorten the wait');
    expect(locked?.text).not.toMatch(/wait and try again, or reset your password/);
    const right = await factorStep(second, await code(e.secret, 0), '19');
    expect(where(right)).toContain('Too many wrong codes');
    expect(right.headers.getSetCookie().some((c) => c.startsWith('sid='))).toBe(false);
  });

  it('checks at most five codes per window however many arrive at once', async () => {
    const email = 'si-burst@example.com';
    const e = await enroll(email, 'burstpass1234', '60');
    const [account] = await srv.db.select().from(users).where(eq(users.id, e.id));
    const right = await code(e.secret, 0);
    const wrongs = Array.from({ length: 24 }, (_, i) => String(100_000 + i * 7919)).filter(
      (w) => matchStep(e.secret, w, Date.now()) === null,
    );
    const results = await Promise.all([
      ...wrongs.map((w) => verifySecondFactor(srv.db, account!, w)),
      verifySecondFactor(srv.db, account!, right),
    ]);
    // A code was looked at when it came back right, wrong, or as the one that
    // locked. Reading the counter first and charging it afterwards let every
    // one of these through to the secret.
    const looked = results.filter(
      (r) => r.status === 'ok' || r.status === 'wrong' || (r.status === 'locked' && r.justLocked),
    );
    expect(looked.length).toBeLessThanOrEqual(5);
    expect(results.filter((r) => r.status === 'locked').length).toBeGreaterThanOrEqual(wrongs.length - 4);
    // And once locked, a right code is refused too.
    const after = await verifySecondFactor(srv.db, account!, totpCode(e.secret, Date.now() + STEP));
    expect(after.status).toBe('locked');
  });

  it('refuses a code already spent in its window without charging it to the lock', async () => {
    const email = 'si-reused@example.com';
    const e = await enroll(email, 'reusedpass123', '61');
    const [account] = await srv.db.select().from(users).where(eq(users.id, e.id));
    const now = await code(e.secret, 0);
    const next = totpCode(e.secret, Date.now() + STEP);
    expect((await verifySecondFactor(srv.db, account!, next)).status).toBe('ok');
    for (let i = 0; i < 7; i++) {
      expect(await verifySecondFactor(srv.db, account!, next)).toEqual({ status: 'wrong', guess: false });
      expect(await verifySecondFactor(srv.db, account!, now)).toEqual({ status: 'wrong', guess: false });
    }
    // Fourteen refusals and no lock: the next wrong guess is the first one counted.
    expect(await verifySecondFactor(srv.db, account!, '000000')).toEqual({ status: 'wrong', guess: true });
  });

  it('checks one code at a time per challenge, so a losing racer spends no recovery code', async () => {
    const email = 'si-one-claim@example.com';
    const e = await enroll(email, 'oneclaimpass1', '62');
    const { jar: j } = await passwordStep(email, 'oneclaimpass1', '63');
    const results = await Promise.all([factorStep(j, await code(e.secret, 0), '63'), factorStep(j, e.codes[0]!, '63')]);
    const places = results.map(where);
    const viaTotp = places.filter((p) => p === '/app').length;
    const viaRecovery = places.filter((p) => p.startsWith('/app/account?ok=')).length;
    expect(viaTotp + viaRecovery).toBe(1);
    const used = await srv.db
      .select()
      .from(recoveryCodes)
      .where(and(eq(recoveryCodes.userId, e.id), isNotNull(recoveryCodes.usedAt)));
    expect(used).toHaveLength(viaRecovery);
  });

  it('refuses a right code on a challenge that expired or ran out of attempts', async () => {
    const email = 'si-dead-challenge@example.com';
    const e = await enroll(email, 'deadchallenge1', '64');
    await post('/app/account/sessions/revoke-all', {}, e.jar.header(ip('64')));
    const expired = (await passwordStep(email, 'deadchallenge1', '65')).jar;
    await srv.db
      .update(mfaChallenges)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(mfaChallenges.id, expired.get('mfa')!));
    const late = await factorStep(expired, await code(e.secret, 0), '65');
    expect(where(late)).toContain(WRONG_FACTOR);
    expect(late.headers.getSetCookie().some((c) => c.startsWith('sid='))).toBe(false);
    const spent = (await passwordStep(email, 'deadchallenge1', '66')).jar;
    await srv.db.update(mfaChallenges).set({ attempts: 5 }).where(eq(mfaChallenges.id, spent.get('mfa')!));
    const used = await factorStep(spent, await code(e.secret, 0), '66');
    expect(where(used)).toContain(WRONG_FACTOR);
    expect(await sessionsOf(srv, e.id)).toBe(0);
    // Neither refusal spent the code: a live challenge still takes it.
    const live = (await passwordStep(email, 'deadchallenge1', '67')).jar;
    expect(where(await factorStep(live, await code(e.secret, 0), '67'))).toBe('/app');
  });

  it('ends a sign-in waiting at the code step on sign-out everywhere, a password change, a reset and a recovery sign-in', async () => {
    const email = 'si-pending@example.com';
    const e = await enroll(email, 'pendingpass12', '68');
    const refusedWith = async (held: Jar, from: string) => {
      const res = await factorStep(held, await code(e.secret, 1), from);
      expect(where(res)).toContain(WRONG_FACTOR);
      expect(res.headers.getSetCookie().some((c) => c.startsWith('sid='))).toBe(false);
    };

    const beforeRevoke = (await passwordStep(email, 'pendingpass12', '69')).jar;
    await post('/app/account/sessions/revoke-all', {}, e.jar.header(ip('68')));
    await refusedWith(beforeRevoke, '69');

    const signedIn = (await passwordStep(email, 'pendingpass12', '70')).jar;
    signedIn.store(await factorStep(signedIn, await code(e.secret, 0), '70'));
    expect((await get('/app', signedIn)).status).toBe(200);
    const beforeChange = (await passwordStep(email, 'pendingpass12', '71')).jar;
    await post('/app/account/password/code', {}, signedIn.header(ip('70')));
    const changed = await post(
      '/app/account/password',
      {
        current_password: 'pendingpass12',
        new_password: 'pendingpass34',
        new_password_confirm: 'pendingpass34',
        code: emailCodeFor(email, 'password_change_code'),
      },
      signedIn.header(ip('70')),
    );
    expect(where(changed)).toContain('Password updated');
    await refusedWith(beforeChange, '71');

    const beforeReset = (await passwordStep(email, 'pendingpass34', '72')).jar;
    const r = jar();
    r.store(await post('/auth/local/forgot', { email }, ip('73')));
    const reset = await post(
      '/auth/local/reset',
      { code: emailCodeFor(email, 'password_reset_code'), new_password: 'pendingpass56', new_password_confirm: 'pendingpass56' },
      r.header(ip('73')),
    );
    expect(where(reset)).toContain('Password updated');
    await refusedWith(beforeReset, '72');

    const beforeRecovery = (await passwordStep(email, 'pendingpass56', '74')).jar;
    const recovering = (await passwordStep(email, 'pendingpass56', '75')).jar;
    expect(where(await factorStep(recovering, e.codes[0]!, '75'))).toContain('/app/account?ok=');
    await refusedWith(beforeRecovery, '74');
  });

  it('asks for the authenticator when it was added while an emailed sign-in code was on its way', async () => {
    const email = 'si-midflight@example.com';
    const j = jar();
    j.store(await post('/auth/local/signup', { email, password: 'midflight1234' }, ip('76')));
    const id = await userId(srv, email);
    const { jar: pending, res } = await passwordStep(email, 'midflight1234', '77');
    expect(where(res)).toContain('/login/verify');
    const loginCode = emailCodeFor(email, 'login_code');
    const e = await enrollJar(j, id, '76', { current_password: 'midflight1234' });
    const verified = await post('/auth/local/verify', { code: loginCode, next: '/app' }, pending.header(ip('77')));
    expect(where(verified)).toBe('/login/authenticator');
    pending.store(verified);
    expect(pending.get('sid')).toBeUndefined();
    expect(pending.get('mfa')).toBeTruthy();
    expect(where(await factorStep(pending, await code(e.secret, 0), '77'))).toBe('/app');
  });

  it('answers an unknown challenge exactly as it answers a wrong code', async () => {
    const email = 'si-oracle@example.com';
    await enroll(email, 'oraclepass123', '20');
    const real = (await passwordStep(email, 'oraclepass123', '21')).jar;
    const wrong = await factorStep(real, '444444', '21');
    const ghost = jar();
    ghost.set('mfa', randomUUID());
    const unknown = await factorStep(ghost, '444444', '22');
    expect(unknown.status).toBe(wrong.status);
    expect(where(unknown)).toBe(where(wrong));
  });

  it('signs in once per recovery code, ends the other sessions and mails the address', async () => {
    const email = 'si-recovery@example.com';
    const e = await enroll(email, 'recoverpass12', '23');
    const a = (await passwordStep(email, 'recoverpass12', '24')).jar;
    const b = (await passwordStep(email, 'recoverpass12', '25')).jar;
    const spent = e.codes[0]!.toUpperCase().replace('-', ' ');
    const race = await Promise.all([factorStep(a, spent, '24'), factorStep(b, spent, '25')]);
    const ok = race.filter((r) => where(r).startsWith('/app/account?ok='));
    expect(ok).toHaveLength(1);
    expect(where(ok[0]!)).toContain('9 recovery codes left');
    expect(where(ok[0]!)).toContain('#security');
    expect(kindsFor(email)).toContain('recovery_code_used');
    expect(await sessionsOf(srv, e.id)).toBe(1);
    expect(where(await get('/app', e.jar))).toContain('/login');
    const left = await srv.db
      .select()
      .from(recoveryCodes)
      .where(and(eq(recoveryCodes.userId, e.id), isNull(recoveryCodes.usedAt)));
    expect(left).toHaveLength(9);
  });

  it('replaces every recovery code on regeneration, which needs the password and a code', async () => {
    const email = 'si-regen@example.com';
    const e = await enroll(email, 'regenpass1234', '26');
    const noCode = await post('/app/account/security/recovery-codes', { current_password: 'regenpass1234', code: '' }, e.jar.header(ip('26')));
    expect(where(noCode)).toContain('error=');
    const regen = await post(
      '/app/account/security/recovery-codes',
      { current_password: 'regenpass1234', code: await code(e.secret, 0) },
      e.jar.header(ip('26')),
    );
    expect(regen.status).toBe(200);
    const fresh = [...(await regen.text()).matchAll(/<li>([a-z2-7]{5}-[a-z2-7]{5})<\/li>/g)].map((m) => m[1]!);
    expect(fresh).toHaveLength(10);
    expect(kindsFor(email)).toContain('recovery_codes_regenerated');
    // A recovery code works there too. Spending one moves the account's
    // second-factor change time, and the browser that spent it still stands
    // on the factor afterwards rather than reading as older than its own act.
    const byRecovery = await post(
      '/app/account/security/recovery-codes',
      { current_password: 'regenpass1234', code: fresh[9]! },
      e.jar.header(ip('26')),
    );
    expect(byRecovery.status).toBe(200);
    const newest = [...(await byRecovery.text()).matchAll(/<li>([a-z2-7]{5}-[a-z2-7]{5})<\/li>/g)].map((m) => m[1]!);
    const [account] = await srv.db.select().from(users).where(eq(users.id, e.id));
    const [mine] = await srv.db.select().from(webSessions).where(eq(webSessions.id, e.jar.get('sid')!));
    expect(mine!.mfaAt!.getTime()).toBeGreaterThanOrEqual(account!.secondFactorChangedAt!.getTime());
    const old = (await passwordStep(email, 'regenpass1234', '27')).jar;
    expect(where(await factorStep(old, e.codes[1]!, '27'))).toContain(WRONG_FACTOR);
    expect(where(await factorStep(old, fresh[0]!, '27'))).toContain(WRONG_FACTOR);
    expect(where(await factorStep(old, newest[0]!, '27'))).toContain('/app/account?ok=');
  });

  it('treats a recovery code spent on Account as it treats one spent signing in', async () => {
    const email = 'acct-recovery@example.com';
    const e = await enroll(email, 'acctrecover12', '78');
    const other = (await passwordStep(email, 'acctrecover12', '79')).jar;
    other.store(await factorStep(other, await code(e.secret, 0), '79'));
    expect((await get('/app', other)).status).toBe(200);
    const regen = await post(
      '/app/account/security/recovery-codes',
      { current_password: 'acctrecover12', code: e.codes[3]! },
      e.jar.header(ip('78')),
    );
    expect(regen.status).toBe(200);
    expect(where(await get('/app', other))).toContain('/login');
    expect((await get('/app', e.jar)).status).toBe(200);
    const notice = [...mailOutbox.all()].reverse().find((m) => m.to === email && m.kind === 'recovery_code_used');
    expect(notice?.subject).toBe('A recovery code was used on your STMA account');
    expect(notice?.text).toContain('Account page');
  });

  it('turns off with the password and a code, and sign-in is emailed codes again', async () => {
    const email = 'si-disable@example.com';
    const e = await enroll(email, 'disablepass12', '28');
    const without = await post('/app/account/security/disable', { current_password: 'disablepass12', code: '555555' }, e.jar.header(ip('28')));
    expect(where(without)).toContain(WRONG_FACTOR);
    const done = await post(
      '/app/account/security/disable',
      { current_password: 'disablepass12', code: e.codes[0]! },
      e.jar.header(ip('28')),
    );
    expect(where(done)).toContain('authenticator app is off');
    expect(kindsFor(email)).toContain('authenticator_disabled');
    expect(await srv.db.select().from(userAuthenticators).where(eq(userAuthenticators.userId, e.id))).toHaveLength(0);
    expect(await srv.db.select().from(recoveryCodes).where(eq(recoveryCodes.userId, e.id))).toHaveLength(0);
    const [mine] = await srv.db.select().from(webSessions).where(eq(webSessions.id, e.jar.get('sid')!));
    expect(mine!.mfaAt).toBeNull();
    const { jar: j, res } = await passwordStep(email, 'disablepass12', '29');
    expect(where(res)).toContain('/login/verify');
    const verified = await post('/auth/local/verify', { code: emailCodeFor(email, 'login_code'), next: '/app' }, j.header(ip('29')));
    expect(where(verified)).toBe('/app');
  });

  it('is still asked for after a password reset by email', async () => {
    const email = 'si-reset@example.com';
    const e = await enroll(email, 'resetpass1234', '30');
    const j = jar();
    j.store(await post('/auth/local/forgot', { email }, ip('30')));
    const reset = await post(
      '/auth/local/reset',
      { code: emailCodeFor(email, 'password_reset_code'), new_password: 'brandnewpass1', new_password_confirm: 'brandnewpass1' },
      j.header(ip('30')),
    );
    expect(where(reset)).toContain('Password updated');
    expect(await srv.db.select().from(userAuthenticators).where(eq(userAuthenticators.userId, e.id))).toHaveLength(1);
    const { res } = await passwordStep(email, 'brandnewpass1', '31');
    expect(where(res)).toBe('/login/authenticator');
  });

  it('is asked for under review access, which skips only the emailed code', async () => {
    const email = 'si-review@example.com';
    const e = await enroll(email, 'reviewpass123', '32');
    await post('/app/account/email/verify', { code: emailCodeFor(email, 'email_verify_code') }, e.jar.header(ip('32')));
    const ops = jar();
    ops.store(await post('/auth/dev', { username: 'ops' }, ip('33')));
    const lastDay = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const on = await post(`/admin/users/${e.id}/review-access`, { last_day: lastDay }, ops.header(ip('33')));
    expect(where(on)).toContain('ok=');
    const before = kindsFor(email).filter((k) => k === 'review_sign_in').length;
    const { jar: j, res } = await passwordStep(email, 'reviewpass123', '34');
    expect(where(res)).toBe('/login/authenticator');
    expect(j.get('sid')).toBeUndefined();
    expect(kindsFor(email).filter((k) => k === 'review_sign_in').length).toBe(before);
    const [challenge] = await srv.db.select().from(mfaChallenges).where(eq(mfaChallenges.id, j.get('mfa')!));
    expect(challenge!.sessionDays).toBe(1);
    // Whoever holds a reviewer's password does not get to change the second factor.
    const off = await post('/app/account/security/disable', { current_password: 'reviewpass123', code: e.codes[0]! }, e.jar.header(ip('32')));
    expect(where(off)).toContain('cannot add or remove an authenticator app');
    expect(await srv.db.select().from(userAuthenticators).where(eq(userAuthenticators.userId, e.id))).toHaveLength(1);
  });

  it('is asked for after dev login', async () => {
    const j = jar();
    j.store(await post('/auth/dev', { username: 'dev-totp' }, ip('35')));
    const id = (await srv.db.select().from(users).where(eq(users.username, 'dev-totp')))[0]!.id;
    await enrollJar(j, id, '35', {});
    const again = await post('/auth/dev', { username: 'dev-totp', next: '/app' }, ip('36'));
    expect(where(again)).toBe('/login/authenticator');
    expect(again.headers.getSetCookie().some((c) => c.startsWith('sid='))).toBe(false);
  });

  it('is asked for after GitHub', async () => {
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('https://github.com/login/oauth/access_token')) return Response.json({ access_token: 'gho_test' });
      if (url === 'https://api.github.com/user') {
        return Response.json({ id: 424242, login: 'octo-totp', name: null, avatar_url: null, email: null });
      }
      if (url === 'https://api.github.com/user/emails') {
        return Response.json([{ email: 'octo-totp@example.com', primary: true, verified: true }]);
      }
      return real(input, init);
    });
    try {
      const github = async () => {
        const j = jar();
        const begin = await get('/auth/github?next=/app');
        j.store(begin);
        const state = new URL(begin.headers.get('location')!).searchParams.get('state')!;
        const back = await get(`/auth/github/callback?state=${state}&code=gh-code`, j);
        j.store(back);
        return { j, back };
      };
      const first = await github();
      expect(where(first.back)).toBe('/app');
      const id = await userId(srv, 'octo-totp@example.com');
      await enrollJar(first.j, id, '37', {});
      const second = await github();
      expect(where(second.back)).toBe('/login/authenticator');
      expect(second.j.get('sid')).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('is asked for when AUTH_2FA is off', async () => {
    const email = 'off-totp@example.com';
    const e = await enroll(email, 'offpassword12', '38', postOff, () => off);
    await postOff('/app/account/sessions/revoke-all', {}, e.jar.header(ip('38')));
    const { jar: j, res } = await passwordStep(email, 'offpassword12', '39', postOff);
    expect(where(res)).toBe('/login/authenticator');
    expect(await sessionsOf(off, e.id)).toBe(0);
    const done = await factorStep(j, await code(e.secret, 0), '39', postOff);
    expect(where(done)).toBe('/app');
    // An account without one still signs in with its password alone, as before.
    await postOff('/auth/local/signup', { email: 'off-plain@example.com', password: 'plainpass1234' }, ip('40'));
    const plain = await passwordStep('off-plain@example.com', 'plainpass1234', '40', postOff);
    expect(where(plain.res)).toBe('/app');
    expect(plain.jar.get('sid')).toBeTruthy();
    expect(plain.jar.get('mfa')).toBeUndefined();
  });

  it('falls back to recovery codes, never to email or password, when the key is gone', async () => {
    const email = 'si-nokey@example.com';
    const e = await enroll(email, 'keylesspass12', '41');
    useKeys(undefined);
    try {
      const { jar: j, res } = await passwordStep(email, 'keylesspass12', '42');
      expect(where(res)).toBe('/login/authenticator');
      const before = kindsFor(email).filter((k) => k === 'login_code').length;
      const refused = await factorStep(j, await code(e.secret, 0), '42');
      expect(where(refused)).toContain(FACTOR_KEY_UNAVAILABLE);
      expect(kindsFor(email).filter((k) => k === 'login_code').length).toBe(before);
      const page = await (await get('/app/account', e.jar)).text();
      expect(page).toContain('Your recovery codes still work');
      expect(where(await factorStep(j, e.codes[4]!, '42'))).toContain('/app/account?ok=');
    } finally {
      useKeys({ k1: KEY_A });
    }
  });
});

describe('the doors that are not a browser sign-in', () => {
  it('refuses a terminal invitation for an account with an authenticator, consuming nothing', async () => {
    const email = 'inv-totp@example.com';
    await enroll(email, 'invitepass123', '43');
    const host = jar();
    host.store(await post('/auth/local/signup', { email: 'inv-host@example.com', password: 'hostpass12345' }, ip('44')));
    await post('/app/teams', { name: 'TOTP Invite' }, host.header(ip('44')));
    await post('/app/teams/totp-invite/invites', {}, host.header(ip('44')));
    const people = await (await get('/app/teams/totp-invite?tab=people', host)).text();
    const invite = /\/join\/([A-Za-z0-9_-]+)/.exec(people)![1]!;
    const res = await fetch(`${srv.url}/api/invites/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ip('45') },
      body: JSON.stringify({ code: invite, email, password: 'invitepass123' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.error)).toContain('authenticator app');
    expect(JSON.stringify(body)).not.toMatch(/stma_/);
    const [row] = await srv.db.select().from(invites).where(eq(invites.code, invite));
    expect(row!.uses).toBe(0);
  });

  it('lets only an operator reset it, with a typed confirmation, ending every session', async () => {
    const email = 'op-reset@example.com';
    const e = await enroll(email, 'opresetpass12', '46');
    const stranger = jar();
    stranger.store(await post('/auth/local/signup', { email: 'op-stranger@example.com', password: 'strangerpass1' }, ip('47')));
    const denied = await post(
      `/admin/users/${e.id}/authenticator/reset`,
      { reason: 'lost_device', confirm: 'op-reset' },
      stranger.header(ip('47')),
    );
    expect(denied.status).toBe(404);

    const ops = jar();
    ops.store(await post('/auth/dev', { username: 'ops' }, ip('48')));
    const account = (await srv.db.select().from(users).where(eq(users.id, e.id)))[0]!;
    const page = await (await get(`/admin/users/${e.id}`, ops)).text();
    expect(page).toContain('recovery codes left');
    expect(page).not.toContain(e.secret);
    const typo = await post(
      `/admin/users/${e.id}/authenticator/reset`,
      { reason: 'lost_device', confirm: 'someone-else' },
      ops.header(ip('48')),
    );
    expect(where(typo)).toContain('Type the username');
    const noReason = await post(
      `/admin/users/${e.id}/authenticator/reset`,
      { reason: 'because', confirm: account.username },
      ops.header(ip('48')),
    );
    expect(where(noReason)).toContain('Choose why');
    expect(await srv.db.select().from(userAuthenticators).where(eq(userAuthenticators.userId, e.id))).toHaveLength(1);

    const reset = await post(
      `/admin/users/${e.id}/authenticator/reset`,
      { reason: 'lost_device', confirm: account.username },
      ops.header(ip('48')),
    );
    expect(where(reset)).toContain('ok=');
    expect(await srv.db.select().from(userAuthenticators).where(eq(userAuthenticators.userId, e.id))).toHaveLength(0);
    expect(await srv.db.select().from(recoveryCodes).where(eq(recoveryCodes.userId, e.id))).toHaveLength(0);
    expect(await sessionsOf(srv, e.id)).toBe(0);
    expect(kindsFor(email)).toContain('authenticator_reset_by_operator');
    const { res } = await passwordStep(email, 'opresetpass12', '49');
    expect(where(res)).toContain('/login/verify');
  });

  it("records every operator reset durably, and asks for the operator's own recent sign-in", async () => {
    const email = 'op-record@example.com';
    const e = await enroll(email, 'oprecordpass12', '50');
    const account = (await srv.db.select().from(users).where(eq(users.id, e.id)))[0]!;
    const resetsOf = () => srv.db.select().from(authenticatorResets).where(eq(authenticatorResets.subjectId, e.id));
    // An operator cookie older than ten minutes is refused, and nothing moves.
    const old = jar();
    old.store(await post('/auth/dev', { username: 'ops' }, ip('51')));
    await srv.db
      .update(webSessions)
      .set({ createdAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(webSessions.id, old.get('sid')!));
    const stale = await post(
      `/admin/users/${e.id}/authenticator/reset`,
      { reason: 'compromised', confirm: account.username },
      old.header(ip('51')),
    );
    expect(where(stale)).toContain(OPERATOR_SIGN_IN_AGAIN);
    expect(await srv.db.select().from(userAuthenticators).where(eq(userAuthenticators.userId, e.id))).toHaveLength(1);
    expect(await resetsOf()).toHaveLength(0);
    expect(kindsFor(email)).not.toContain('authenticator_reset_by_operator');

    // Signed in again, the reset goes through and its row is written with it.
    const ops = jar();
    ops.store(await post('/auth/dev', { username: 'ops' }, ip('52')));
    const [operator] = await srv.db.select().from(users).where(eq(users.username, 'ops'));
    const reset = await post(
      `/admin/users/${e.id}/authenticator/reset`,
      { reason: 'compromised', confirm: account.username },
      ops.header(ip('52')),
    );
    expect(where(reset)).toContain('ok=');
    const recorded = await resetsOf();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ actorId: operator!.id, actorLabel: 'ops', reason: 'compromised' });
    expect(JSON.stringify(recorded)).not.toContain(e.secret);
    const page = await (await get(`/admin/users/${e.id}`, ops)).text();
    expect(page).toContain('Reset history');
    expect(page).toContain('by ops: Phone or codes may be in the wrong hands');

    // Nothing to remove is nothing to record.
    const again = await post(
      `/admin/users/${e.id}/authenticator/reset`,
      { reason: 'lost_device', confirm: account.username },
      ops.header(ip('52')),
    );
    expect(where(again)).toContain('has no authenticator app on');
    expect(await resetsOf()).toHaveLength(1);
  });

  it('has one writer of the reset record', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry)) files.push(full);
      }
    };
    walk(path.join(root, 'packages/server/src'));
    // The public tree has no ee/, the same as the one-door scan below.
    if (existsSync(path.join(root, 'ee/src'))) walk(path.join(root, 'ee/src'));
    const writers = files
      .filter((file) => /insert\(authenticatorResets\)|insert into authenticator_resets/i.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file).split(path.sep).join('/'));
    expect(writers).toEqual(['packages/server/src/lib/authenticatorResets.ts']);
  });
});

describe('a form posted from another site', () => {
  const foreign = (headers: Record<string, string>) => ({ ...headers, origin: 'https://untrusted.example' });
  const authenticatorOf = async (id: string) =>
    (await srv.db.select().from(userAuthenticators).where(eq(userAuthenticators.userId, id)))[0];
  const recoveryOf = async (id: string) =>
    (await srv.db.select().from(recoveryCodes).where(eq(recoveryCodes.userId, id)))
      .map((r) => `${r.codeHash}:${r.usedAt?.toISOString() ?? ''}`)
      .sort();

  it('cannot finish or give up a sign-in waiting at the code step', async () => {
    const email = 'xo-challenge@example.com';
    const e = await enroll(email, 'xochallenge12', '91');
    const { jar: j } = await passwordStep(email, 'xochallenge12', '91');
    const challengeId = j.get('mfa')!;
    const verify = await post('/auth/mfa/verify', { code: await code(e.secret, 0) }, foreign(j.header(ip('91'))));
    expect(verify.status).toBe(403);
    expect(verify.headers.getSetCookie().some((c) => c.startsWith('sid='))).toBe(false);
    const cancel = await post('/auth/mfa/cancel', {}, foreign(j.header(ip('91'))));
    expect(cancel.status).toBe(403);
    const [row] = await srv.db.select().from(mfaChallenges).where(eq(mfaChallenges.id, challengeId));
    expect(row!.consumedAt).toBeNull();
    expect(row!.attempts).toBe(0);
    // The same browser, from this site, still completes it.
    expect(where(await factorStep(j, await code(e.secret, 0), '91'))).toBe('/app');
  });

  it('cannot start or confirm an enrollment', async () => {
    const email = 'xo-enroll@example.com';
    const j = jar();
    j.store(await post('/auth/local/signup', { email, password: 'xoenrollpass1' }, ip('92')));
    const id = await userId(srv, email);
    const start = await post('/app/account/security/start', { current_password: 'xoenrollpass1' }, foreign(j.header(ip('92'))));
    expect(start.status).toBe(403);
    expect(await authenticatorOf(id)).toBeUndefined();
    const begun = await post('/app/account/security/start', { current_password: 'xoenrollpass1' }, j.header(ip('92')));
    const secret = /secret=([A-Z2-7]+)/.exec(await begun.text())![1]!;
    const confirm = await post('/app/account/security/confirm', { code: await code(secret, 0) }, foreign(j.header(ip('92'))));
    expect(confirm.status).toBe(403);
    expect((await authenticatorOf(id))!.enabledAt).toBeNull();
    expect(await recoveryOf(id)).toHaveLength(0);
  });

  it('cannot replace the recovery codes or turn the app off', async () => {
    const email = 'xo-manage@example.com';
    const e = await enroll(email, 'xomanagepass1', '93');
    const before = await recoveryOf(e.id);
    const regen = await post(
      '/app/account/security/recovery-codes',
      { current_password: 'xomanagepass1', code: await code(e.secret, 0) },
      foreign(e.jar.header(ip('93'))),
    );
    expect(regen.status).toBe(403);
    expect(await recoveryOf(e.id)).toEqual(before);
    const disable = await post(
      '/app/account/security/disable',
      { current_password: 'xomanagepass1', code: await code(e.secret, 0) },
      foreign(e.jar.header(ip('93'))),
    );
    expect(disable.status).toBe(403);
    expect((await authenticatorOf(e.id))!.enabledAt).not.toBeNull();
    expect(await recoveryOf(e.id)).toEqual(before);
    expect(kindsFor(email)).not.toContain('authenticator_disabled');
  });

  it('cannot run an operator reset', async () => {
    const email = 'xo-reset@example.com';
    const e = await enroll(email, 'xoresetpass12', '94');
    const ops = jar();
    ops.store(await post('/auth/dev', { username: 'ops' }, ip('95')));
    const account = (await srv.db.select().from(users).where(eq(users.id, e.id)))[0]!;
    const sessions = await sessionsOf(srv, e.id);
    const reset = await post(
      `/admin/users/${e.id}/authenticator/reset`,
      { reason: 'lost_device', confirm: account.username },
      foreign(ops.header(ip('95'))),
    );
    expect(reset.status).toBe(403);
    expect((await authenticatorOf(e.id))!.enabledAt).not.toBeNull();
    expect(await sessionsOf(srv, e.id)).toBe(sessions);
    expect(kindsFor(email)).not.toContain('authenticator_reset_by_operator');
  });
});

describe('what never leaves the page', () => {
  it('keeps the secret, the URI, every code and every recovery code out of logs, mail and operator pages', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    const email = 'sweep@example.com';
    const used: string[] = [];
    let enrolled: Enrolled | undefined;
    const r = jar();
    try {
      const e = await enroll(email, 'sweeppass1234', '50');
      enrolled = e;
      await post('/app/teams', { name: 'Sweep Space' }, e.jar.header(ip('50')));
      const { jar: j } = await passwordStep(email, 'sweeppass1234', '51');
      const c0 = await code(e.secret, 0);
      used.push(c0);
      await factorStep(j, c0, '51');
      r.store(await post('/auth/local/login', { email, password: 'sweeppass1234' }, ip('52')));
      r.store(await factorStep(r, e.codes[2]!, '52'));
    } finally {
      spy.mockRestore();
    }
    const e = enrolled!;
    const ops = jar();
    ops.store(await post('/auth/dev', { username: 'ops' }, ip('53')));
    const opsPage = await (await get('/admin/ops', ops)).text();
    const csvRes = await get('/app/teams/sweep-space/activity.csv', r);
    expect(csvRes.status).toBe(200);
    const csv = await csvRes.text();
    const mail = mailOutbox
      .all()
      .map((m) => `${m.subject}\n${m.text}\n${m.html}`)
      .join('\n');
    const haystacks = { log: lines.join('\n'), mail, opsPage, csv };
    expect(haystacks.log).toContain('authenticator_enabled');
    const secrets = [e.secret, e.uri, encodeURIComponent(e.uri), ...e.codes, ...e.codes.map((c) => c.replace('-', ''))];
    for (const [name, text] of Object.entries(haystacks)) {
      for (const secret of secrets) {
        expect(text.includes(secret), `${name} carries a secret`).toBe(false);
      }
      // A six-digit code as a word of its own, not as part of a timestamp.
      for (const digits of used) expect(new RegExp(`(^|\\D)${digits}(\\D|$)`).test(text), `${name} carries a code`).toBe(false);
    }
    // The code page and the codes page are never stored by a browser.
    expect(e.confirm.headers.get('cache-control')).toContain('no-store');
  });
});

describe('the one door', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const roots = ['../src', '../../../ee/src'].map((p) => path.resolve(here, p));
  const files = (dir: string): string[] => {
    try {
      return readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);
        return statSync(full).isDirectory() ? files(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
      });
    } catch {
      return [];
    }
  };
  const all = roots.flatMap(files);

  it('writes browser sessions only through auth/signIn.ts', () => {
    expect(all.length).toBeGreaterThan(50);
    const callers = all.filter((file) => /\bcreateSession\s*\(/.test(readFileSync(file, 'utf8')));
    const rel = callers.map((f) => path.relative(path.resolve(here, '..'), f).replace(/\\/g, '/')).sort();
    expect(rel).toEqual(['src/auth/session.ts', 'src/auth/signIn.ts']);
    const definition = readFileSync(path.resolve(here, '../src/auth/session.ts'), 'utf8');
    expect(definition.match(/\bcreateSession\s*\(/g)).toHaveLength(1);
    const inserters = all.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return /insert\(\s*webSessions\s*\)/.test(text) || /into\s+web_sessions/i.test(text);
    });
    expect(inserters.map((f) => path.basename(f))).toEqual(['session.ts']);
  });
});

