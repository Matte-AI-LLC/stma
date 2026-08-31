import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { checkChallenge, issueAuthCode } from '../src/auth/codes';
import { connectDb, type Db } from '../src/db';
import { authCodes, users } from '../src/db/schema';
import { loadEnv } from '../src/env';
import { runCleanupOnce } from '../src/lib/cleanup';
import { mailOutbox } from '../src/lib/mailer';
import { startServer, type StartedServer } from '../src/server';

/** Email codes on (memory transport) + ADMIN_EMAILS. */
let srv: StartedServer;
let srvDir: string;
/** Email codes off — sign-in must behave exactly as it did before. */
let plain: StartedServer;
let plainDir: string;
/** Direct database handle (no server) for the time-dependent cases. */
let raw: { db: Db; close: () => Promise<void> };
let rawDir: string;

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
    get(name: string) {
      return cookies.get(name);
    },
  };
}

type Jar = ReturnType<typeof jar>;

/**
 * Each test speaks from its own address so the per-IP /auth/* limiter (30/min)
 * never colours a result — the limiter itself is exercised in e2e.test.ts.
 */
const ip = (n: string) => ({ 'x-forwarded-for': `10.9.0.${n}` });

const post = (
  server: StartedServer,
  url: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
) =>
  fetch(server.url + url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields),
    redirect: 'manual',
  });

const where = (res: Response) => decodeURIComponent(res.headers.get('location') ?? '');

/** The 6 digits from the newest email to this address. */
function codeFor(email: string): string {
  const mail = mailOutbox.latest(email);
  expect(mail, `no mail for ${email}`).toBeTruthy();
  const code = /\b(\d{6})\b/.exec(mail!.text)?.[1];
  expect(code, `no code in "${mail!.text}"`).toBeTruthy();
  return code!;
}

async function signup(server: StartedServer, email: string, password: string, from: string) {
  const j = jar();
  const res = await post(server, '/auth/local/signup', { email, password }, ip(from));
  j.store(res);
  return { jar: j, res };
}

/** Full sign-in: password, then the emailed code. */
async function signIn(email: string, password: string, from: string) {
  const j = jar();
  const first = await post(srv, '/auth/local/login', { email, password }, ip(from));
  j.store(first);
  expect(first.headers.get('location')).toBe('/login/verify?next=%2Fapp');
  const second = await post(
    srv,
    '/auth/local/verify',
    { code: codeFor(email), next: '/app' },
    j.header(ip(from)),
  );
  j.store(second);
  expect(second.headers.get('location')).toBe('/app');
  return j;
}

async function devLogin(server: StartedServer, username: string, from: string) {
  const j = jar();
  const res = await post(server, '/auth/dev', { username }, ip(from));
  j.store(res);
  expect(res.headers.get('location')).toBe('/app');
  return j;
}

beforeAll(async () => {
  process.env.ADMIN_EMAILS = ' Ops@STMA.test , ';
  srvDir = mkdtempSync(path.join(tmpdir(), 'stma-auth2fa-'));
  srv = await startServer(
    loadEnv({
      port: 0,
      host: 'localhost',
      nodeEnv: 'test',
      devMode: true,
      databaseUrl: undefined,
      pgliteDir: srvDir,
      // No API key: the mailer records into the memory outbox the tests read.
      twoFactor: true,
    }),
  );
  delete process.env.ADMIN_EMAILS;

  plainDir = mkdtempSync(path.join(tmpdir(), 'stma-auth-plain-'));
  plain = await startServer(
    loadEnv({
      port: 0,
      host: 'localhost',
      nodeEnv: 'test',
      devMode: true,
      databaseUrl: undefined,
      pgliteDir: plainDir,
      twoFactor: false,
    }),
  );

  rawDir = mkdtempSync(path.join(tmpdir(), 'stma-auth-raw-'));
  raw = await connectDb(
    loadEnv({ port: 0, nodeEnv: 'test', databaseUrl: undefined, pgliteDir: rawDir }),
  );
}, 90_000);

afterAll(async () => {
  await srv?.close();
  await plain?.close();
  await raw?.close();
  mailOutbox.clear();
  rmSync(srvDir, { recursive: true, force: true });
  rmSync(plainDir, { recursive: true, force: true });
  rmSync(rawDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ identity

it('signs up with an email, derives the username and rejects a duplicate address', async () => {
  const page = await (await fetch(`${srv.url}/signup`)).text();
  expect(page).toContain('name="email"');
  expect(page).not.toContain('name="username"');

  const ada = await signup(srv, ' Ada.Lovelace@Example.com ', 'firstpass123', '11');
  expect(ada.res.status).toBe(302);
  expect(ada.res.headers.get('location')).toBe('/app');
  const app = await fetch(`${srv.url}/app`, { headers: ada.jar.header() });
  expect(app.status).toBe(200);
  // Display name comes from the local part; the address is stored normalized.
  expect(await app.text()).toContain('ada-lovelace');

  // Same address in another casing is the same account.
  const again = await signup(srv, 'ADA.LOVELACE@example.com', 'otherpass123', '11');
  expect(where(again.res)).toContain('already exists');
  expect(again.jar.get('sid')).toBeUndefined();

  // A different address whose local part collides gets a suffixed display name.
  const other = await signup(srv, 'ada.lovelace@other.test', 'thirdpass123', '11');
  const otherApp = await (await fetch(`${srv.url}/app`, { headers: other.jar.header() })).text();
  expect(otherApp).toContain('ada-lovelace-2');

  const bad = await post(srv, '/auth/local/signup', { email: 'nope', password: 'password123' }, ip('11'));
  expect(where(bad)).toContain('valid email address');
});

// --------------------------------------------------------------- sign-in 2FA

it('holds the session until the emailed code is verified', async () => {
  await signup(srv, 'grace@example.com', 'gracepass123', '12');
  const j = jar();

  const wrongPassword = await post(
    srv,
    '/auth/local/login',
    { email: 'grace@example.com', password: 'nope-nope-nope' },
    ip('12'),
  );
  expect(where(wrongPassword)).toContain('Invalid email or password.');

  const login = await post(
    srv,
    '/auth/local/login',
    { email: 'grace@example.com', password: 'gracepass123' },
    ip('12'),
  );
  j.store(login);
  expect(login.headers.get('location')).toBe('/login/verify?next=%2Fapp');
  // A pending challenge is not a session.
  expect(j.get('sid')).toBeUndefined();
  expect(j.get('pending')).toBeTruthy();
  const blocked = await fetch(`${srv.url}/app`, { headers: j.header(), redirect: 'manual' });
  expect(blocked.status).toBe(302);
  expect(blocked.headers.get('location')).toContain('/login');

  const mail = mailOutbox.latest('grace@example.com')!;
  expect(mail.subject).toContain('sign-in code');
  expect(mail.text).toContain('10 minutes');
  expect(mail.text).toContain('did not request this');

  // The code page says nothing about which account is waiting.
  const verifyPage = await (
    await fetch(`${srv.url}/login/verify`, { headers: j.header() })
  ).text();
  expect(verifyPage).toContain('Check your email');
  expect(verifyPage).not.toContain('grace@example.com');

  const code = codeFor('grace@example.com');
  const wrong = await post(
    srv,
    '/auth/local/verify',
    { code: '000000' === code ? '111111' : '000000', next: '/app' },
    j.header(ip('12')),
  );
  expect(where(wrong)).toContain('not right');
  expect(where(wrong)).toContain('4 attempts left');

  const ok = await post(srv, '/auth/local/verify', { code, next: '/app' }, j.header(ip('12')));
  j.store(ok);
  expect(ok.headers.get('location')).toBe('/app');
  expect((await fetch(`${srv.url}/app`, { headers: j.header() })).status).toBe(200);

  // Single use: the same code cannot mint a second session.
  const replay = jar();
  const relogin = await post(
    srv,
    '/auth/local/login',
    { email: 'grace@example.com', password: 'gracepass123' },
    ip('12'),
  );
  replay.store(relogin);
  const pendingCookie = replay.get('pending')!;
  const fresh = codeFor('grace@example.com');
  const first = await post(
    srv,
    '/auth/local/verify',
    { code: fresh, next: '/app' },
    replay.header(ip('12')),
  );
  replay.store(first);
  expect(first.headers.get('location')).toBe('/app');
  const reused = await post(
    srv,
    '/auth/local/verify',
    { code: fresh, next: '/app' },
    { cookie: `pending=${pendingCookie}`, ...ip('12') },
  );
  expect(where(reused)).toContain('/login');
});

it('kills a code after five wrong attempts', async () => {
  await signup(srv, 'linus@example.com', 'linuspass123', '13');
  const j = jar();
  const login = await post(
    srv,
    '/auth/local/login',
    { email: 'linus@example.com', password: 'linuspass123' },
    ip('13'),
  );
  j.store(login);
  const real = codeFor('linus@example.com');
  const wrong = real === '424242' ? '242424' : '424242';

  for (let i = 0; i < 4; i++) {
    const res = await post(srv, '/auth/local/verify', { code: wrong }, j.header(ip('13')));
    expect(where(res)).toContain('/login/verify');
  }
  const dead = await post(srv, '/auth/local/verify', { code: wrong }, j.header(ip('13')));
  j.store(dead);
  expect(where(dead)).toContain('Too many wrong codes');

  // Even the correct code is worthless now, and no session was created.
  const late = await post(srv, '/auth/local/verify', { code: real }, j.header(ip('13')));
  expect(where(late)).toContain('/login');
  expect(j.get('sid')).toBeUndefined();
});

it('allows three code sends per user, then refuses', async () => {
  await signup(srv, 'hopper@example.com', 'hopperpass1', '14');
  const j = jar();
  const login = await post(
    srv,
    '/auth/local/login',
    { email: 'hopper@example.com', password: 'hopperpass1' },
    ip('14'),
  );
  j.store(login); // send 1

  for (const n of [2, 3]) {
    const resend = await post(srv, '/auth/local/resend', {}, j.header(ip('14')));
    j.store(resend);
    expect(resend.headers.get('location'), `send ${n}`).toContain('/login/verify');
  }
  const limited = await post(srv, '/auth/local/resend', {}, j.header(ip('14')));
  expect(where(limited)).toContain('/login');
  expect(where(limited)).toContain('Too many sign-in codes');

  // The newest code still works — the limit gates sending, not verifying.
  const ok = await post(
    srv,
    '/auth/local/verify',
    { code: codeFor('hopper@example.com') },
    j.header(ip('14')),
  );
  j.store(ok);
  expect(ok.headers.get('location')).toBe('/app');
});

it('rejects an expired code and sweeps it up later', async () => {
  const inserted = await raw.db
    .insert(users)
    .values({ username: 'expired-user', email: 'expired@example.com' })
    .returning();
  const userId = inserted[0]!.id;
  const issued = await issueAuthCode(raw.db, userId, 'login');
  expect(issued.ok).toBe(true);
  if (!issued.ok) return;

  await raw.db
    .update(authCodes)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(authCodes.id, issued.id));
  expect((await checkChallenge(raw.db, issued.id, 'login', issued.code)).status).toBe('gone');

  // Retention keeps the row until well past expiry (the send window outlives it).
  await runCleanupOnce(raw.db, loadEnv({ nodeEnv: 'test', databaseUrl: undefined }));
  expect(await raw.db.select().from(authCodes).where(eq(authCodes.id, issued.id))).toHaveLength(1);
  await raw.db
    .update(authCodes)
    .set({ expiresAt: new Date(Date.now() - 3 * 60 * 60 * 1000) })
    .where(eq(authCodes.id, issued.id));
  await runCleanupOnce(raw.db, loadEnv({ nodeEnv: 'test', databaseUrl: undefined }));
  expect(await raw.db.select().from(authCodes).where(eq(authCodes.id, issued.id))).toHaveLength(0);
});

it('signs in directly when email codes are disabled', async () => {
  mailOutbox.clear();
  const account = await signup(plain, 'turing@example.com', 'turingpass1', '15');
  expect(account.res.headers.get('location')).toBe('/app');

  const j = jar();
  const login = await post(
    plain,
    '/auth/local/login',
    { email: 'turing@example.com', password: 'turingpass1' },
    ip('15'),
  );
  j.store(login);
  expect(login.headers.get('location')).toBe('/app');
  expect(j.get('sid')).toBeTruthy();
  expect((await fetch(`${plain.url}/app`, { headers: j.header() })).status).toBe(200);
  expect(mailOutbox.latest('turing@example.com')).toBeUndefined();

  // …and the account card asks for no code either.
  const card = await (await fetch(`${plain.url}/app/account`, { headers: j.header() })).text();
  expect(card).toContain('Change password');
  expect(card).not.toContain('Email me a confirmation code');
});

// -------------------------------------------------------------- password change

it('requires an emailed code to change the password and signs other sessions out', async () => {
  await signup(srv, 'edsger@example.com', 'edsgerpass1', '16');
  const a = await signIn('edsger@example.com', 'edsgerpass1', '16');
  const b = await signIn('edsger@example.com', 'edsgerpass1', '16'); // second browser

  const card = await (await fetch(`${srv.url}/app/account`, { headers: a.header() })).text();
  expect(card).toContain('Email me a confirmation code');
  expect(card).toContain('name="code"');

  const change = (fields: Record<string, string>) =>
    post(
      srv,
      '/app/account/password',
      {
        current_password: 'edsgerpass1',
        new_password: 'edsgerpass2',
        new_password_confirm: 'edsgerpass2',
        ...fields,
      },
      a.header(),
    );

  expect(where(await change({}))).toContain('6-digit code');
  expect(
    where(
      await post(
        srv,
        '/app/account/password',
        {
          current_password: 'wrong-current',
          new_password: 'edsgerpass2',
          new_password_confirm: 'edsgerpass2',
          code: '123456',
        },
        a.header(),
      ),
    ),
  ).toContain('Current password is incorrect');

  const sent = await post(srv, '/app/account/password/code', {}, a.header());
  expect(where(sent)).toContain('ok=');
  const mail = mailOutbox.latest('edsger@example.com')!;
  expect(mail.subject).toContain('password change');
  const code = codeFor('edsger@example.com');

  expect(where(await change({ code: code === '999999' ? '888888' : '999999' }))).toContain(
    'not right',
  );
  const done = await change({ code });
  expect(where(done)).toContain('ok=');
  expect(where(done)).toContain('Other browser sessions were signed out');

  // Notification email, other session gone, old password dead.
  expect(mailOutbox.latest('edsger@example.com')!.subject).toBe('Your STMA password was changed');
  expect((await fetch(`${srv.url}/app`, { headers: a.header() })).status).toBe(200);
  const other = await fetch(`${srv.url}/app`, { headers: b.header(), redirect: 'manual' });
  expect(other.status).toBe(302);
  expect(other.headers.get('location')).toContain('/login');

  const stale = await post(
    srv,
    '/auth/local/login',
    { email: 'edsger@example.com', password: 'edsgerpass1' },
    ip('16'),
  );
  expect(where(stale)).toContain('Invalid email or password.');
  // The code is spent: a second change needs a fresh one.
  expect(
    where(
      await post(
        srv,
        '/app/account/password',
        {
          current_password: 'edsgerpass2',
          new_password: 'edsgerpass3',
          new_password_confirm: 'edsgerpass3',
          code,
        },
        a.header(),
      ),
    ),
  ).toContain('expired or was already used');
});

// ---------------------------------------------------------------- onboarding

it('redeems an invite with an email and issues a token', async () => {
  const owner = await devLogin(plain, 'invite-owner', '17');
  const teamRes = await post(plain, '/app/teams', { name: 'Redeem Co' }, owner.header());
  const teamPath = teamRes.headers.get('location')!;
  await fetch(`${plain.url}${teamPath}/invites`, {
    method: 'POST',
    headers: owner.header(),
    redirect: 'manual',
  });
  const teamHtml = await (
    await fetch(`${plain.url}${teamPath}?tab=people`, { headers: owner.header() })
  ).text();
  const code = /\/join\/([A-Za-z0-9_-]+)/.exec(teamHtml)?.[1];
  expect(code).toBeTruthy();

  const redeem = async (body: Record<string, string>) =>
    fetch(`${plain.url}/api/invites/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ip('17') },
      body: JSON.stringify(body),
    });

  const bad = await redeem({ code: code!, email: 'not-an-email', password: 'joinpass123' });
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as any).error).toContain('valid address');

  const res = await redeem({ code: code!, email: 'Mary.Jones@Example.com', password: 'joinpass123' });
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.email).toBe('mary.jones@example.com');
  expect(body.username).toBe('mary-jones');
  expect(body.token).toMatch(/^stma_[0-9a-f]{40}$/);

  // Same address again = same account, password checked.
  const wrong = await redeem({ code: code!, email: 'mary.jones@example.com', password: 'nope12345' });
  expect(wrong.status).toBe(401);
  const repeat = await redeem({ code: code!, email: 'mary.jones@example.com', password: 'joinpass123' });
  expect(repeat.status).toBe(200);
  expect(((await repeat.json()) as any).username).toBe('mary-jones');
});

// --------------------------------------------------------------------- admin

it('grants /admin through ADMIN_EMAILS and keeps everyone else on 404', async () => {
  // ' Ops@STMA.test ' matches ops@stma.test — trimmed and case-insensitive.
  await signup(srv, 'ops@stma.test', 'opspassword1', '18');
  const ops = await signIn('ops@stma.test', 'opspassword1', '18');
  expect((await fetch(`${srv.url}/admin`, { headers: ops.header() })).status).toBe(200);
  expect((await fetch(`${srv.url}/admin/users`, { headers: ops.header() })).status).toBe(200);

  const mallory = await devLogin(srv, 'mallory', '18');
  for (const p of ['/admin', '/admin/users']) {
    expect((await fetch(srv.url + p, { headers: mallory.header() })).status).toBe(404);
  }
  // …including the write route.
  const denied = await post(
    srv,
    '/admin/users/00000000-0000-0000-0000-000000000000/email',
    { email: 'x@example.com' },
    mallory.header(),
  );
  expect(denied.status).toBe(404);

  // The plain server has no operator list at all.
  expect((await fetch(`${plain.url}/admin`)).status).toBe(404);
});

it('lets an operator set a missing email and refuses a duplicate', async () => {
  const ops = await signIn('ops@stma.test', 'opspassword1', '19');
  await devLogin(srv, 'legacy-user', '19'); // an account from before email login

  const html = await (await fetch(`${srv.url}/admin/users`, { headers: ops.header() })).text();
  const id = new RegExp(
    '<td class="name">legacy-user</td>[\\s\\S]{0,400}?/admin/users/([0-9a-f-]{36})/email',
  ).exec(html)?.[1];
  expect(id).toBeTruthy();

  const dupe = await post(
    srv,
    `/admin/users/${id}/email`,
    { email: 'Grace@example.com' },
    ops.header(),
  );
  expect(where(dupe)).toContain('Another account already uses that email');

  const invalid = await post(srv, `/admin/users/${id}/email`, { email: 'oops' }, ops.header());
  expect(where(invalid)).toContain('valid email');

  const set = await post(
    srv,
    `/admin/users/${id}/email`,
    { email: '  Legacy@Example.com ' },
    ops.header(),
  );
  expect(where(set)).toContain('ok=');
  const after = await (await fetch(`${srv.url}/admin/users`, { headers: ops.header() })).text();
  expect(after).toContain('legacy@example.com');
});

// -------------------------------------------------------------- password reset

it('resets a forgotten password and kills every existing session', async () => {
  await signup(srv, 'ken@example.com', 'kenpass12345', '21');
  const a = await signIn('ken@example.com', 'kenpass12345', '21');
  const b = await signIn('ken@example.com', 'kenpass12345', '21');
  expect((await fetch(`${srv.url}/app`, { headers: a.header() })).status).toBe(200);

  const loginPage = await (await fetch(`${srv.url}/login`)).text();
  expect(loginPage).toContain('/forgot');
  expect(await (await fetch(`${srv.url}/forgot`)).text()).toContain('Reset your password');

  const j = jar();
  const asked = await post(srv, '/auth/local/forgot', { email: 'KEN@example.com' }, ip('21'));
  j.store(asked);
  expect(asked.headers.get('location')).toContain('/reset?ok=');
  expect(where(asked)).toContain('If that address has an account');
  const mail = mailOutbox.latest('ken@example.com')!;
  expect(mail.subject).toContain('password reset code');
  const code = codeFor('ken@example.com');

  // A password typo must not spend an attempt on the code.
  const mismatch = await post(
    srv,
    '/auth/local/reset',
    { code, new_password: 'newkenpass1', new_password_confirm: 'newkenpass2' },
    j.header(ip('21')),
  );
  expect(where(mismatch)).toContain('do not match');
  const short = await post(
    srv,
    '/auth/local/reset',
    { code, new_password: 'short', new_password_confirm: 'short' },
    j.header(ip('21')),
  );
  expect(where(short)).toContain('8-128');

  const wrong = await post(
    srv,
    '/auth/local/reset',
    {
      code: code === '654321' ? '123456' : '654321',
      new_password: 'newkenpass1',
      new_password_confirm: 'newkenpass1',
    },
    j.header(ip('21')),
  );
  expect(where(wrong)).toContain('4 attempts left');

  const done = await post(
    srv,
    '/auth/local/reset',
    { code, new_password: 'newkenpass1', new_password_confirm: 'newkenpass1' },
    j.header(ip('21')),
  );
  expect(where(done)).toContain('/login?ok=');
  expect(where(done)).toContain('sign in with your new password');
  expect(mailOutbox.latest('ken@example.com')!.subject).toBe('Your STMA password was changed');

  // Both pre-existing sessions are dead — including the one that asked.
  for (const stale of [a, b]) {
    const res = await fetch(`${srv.url}/app`, { headers: stale.header(), redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/login');
  }
  // The code is spent.
  const replay = await post(
    srv,
    '/auth/local/reset',
    { code, new_password: 'newkenpass9', new_password_confirm: 'newkenpass9' },
    j.header(ip('21')),
  );
  expect(where(replay)).toContain('/forgot');

  const old = await post(
    srv,
    '/auth/local/login',
    { email: 'ken@example.com', password: 'kenpass12345' },
    ip('21'),
  );
  expect(where(old)).toContain('Invalid email or password.');
  const back = await signIn('ken@example.com', 'newkenpass1', '21');
  expect((await fetch(`${srv.url}/app`, { headers: back.header() })).status).toBe(200);
});

it('answers identically for an unknown address and sends nothing', async () => {
  const before = mailOutbox.all().length;
  const res = await post(srv, '/auth/local/forgot', { email: 'nobody@example.com' }, ip('22'));
  expect(res.headers.get('location')).toContain('/reset?ok=');
  expect(where(res)).toContain('If that address has an account');
  expect(res.headers.getSetCookie().some((line) => line.startsWith('reset='))).toBe(false);
  expect(mailOutbox.all().length).toBe(before);
  expect(mailOutbox.latest('nobody@example.com')).toBeUndefined();

  // A dev account (no password) is equally silent, and equally indistinguishable.
  await devLogin(srv, 'no-password-user', '22');
  const same = await post(
    srv,
    '/auth/local/forgot',
    { email: 'no-password-user' },
    ip('22'),
  );
  expect(where(same)).toContain('valid email address'); // not an address at all
  expect(mailOutbox.all().length).toBe(before);

  // The page is a plain 404 where the instance cannot send email.
  expect((await fetch(`${plain.url}/forgot`)).status).toBe(404);
  expect(
    (await post(plain, '/auth/local/forgot', { email: 'turing@example.com' }, ip('22'))).status,
  ).toBe(404);
  expect(await (await fetch(`${plain.url}/login`)).text()).not.toContain('/forgot');
});

it('caps reset attempts and reset sends', async () => {
  await signup(srv, 'dennis@example.com', 'dennispass12', '23');
  const j = jar();
  const asked = await post(srv, '/auth/local/forgot', { email: 'dennis@example.com' }, ip('23'));
  j.store(asked); // send 1
  const real = codeFor('dennis@example.com');
  const wrong = real === '111111' ? '222222' : '111111';
  const attempt = (code: string) =>
    post(
      srv,
      '/auth/local/reset',
      { code, new_password: 'dennispass34', new_password_confirm: 'dennispass34' },
      j.header(ip('23')),
    );

  for (let i = 0; i < 4; i++) expect(where(await attempt(wrong))).toContain('/reset');
  expect(where(await attempt(wrong))).toContain('/forgot'); // fifth kills it
  expect(where(await attempt(real))).toContain('/forgot'); // even the real one
  // The password never changed.
  const stillOld = await post(
    srv,
    '/auth/local/login',
    { email: 'dennis@example.com', password: 'dennispass12' },
    ip('23'),
  );
  expect(stillOld.headers.get('location')).toBe('/login/verify?next=%2Fapp');

  // Sends: three per user per window, then silence behind the same answer.
  const codes = new Set([real]);
  for (const n of [2, 3]) {
    const res = await post(srv, '/auth/local/forgot', { email: 'dennis@example.com' }, ip('23'));
    expect(res.headers.get('location'), `send ${n}`).toContain('/reset?ok=');
    codes.add(codeFor('dennis@example.com'));
  }
  const lastCode = codeFor('dennis@example.com');
  const mails = mailOutbox.all().filter((m) => m.to === 'dennis@example.com').length;
  const limited = await post(srv, '/auth/local/forgot', { email: 'dennis@example.com' }, ip('23'));
  expect(where(limited)).toContain('If that address has an account'); // same answer
  expect(mailOutbox.all().filter((m) => m.to === 'dennis@example.com').length).toBe(mails);
  expect(codeFor('dennis@example.com')).toBe(lastCode); // no new code minted
});

// ----------------------------------------------------------------- access log

it('masks inbound hook tokens in the access log', async () => {
  const secret = 'sekrit-token-9f8e7d6c5b4a';
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    await fetch(`${plain.url}/api/hooks/announce/${secret}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ip('20') },
      body: JSON.stringify({ text: 'ci is green' }),
    });
    await fetch(`${plain.url}/api/hooks/github/${secret}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ip('20') },
      body: JSON.stringify({}),
    });
  } finally {
    spy.mockRestore();
  }

  const http = lines.filter((l) => l.includes('"evt":"http"'));
  expect(http.length).toBeGreaterThanOrEqual(2);
  expect(lines.join('\n')).not.toContain(secret);
  expect(http.some((l) => l.includes('"p":"/api/hooks/announce/:token"'))).toBe(true);
  expect(http.some((l) => l.includes('"p":"/api/hooks/github/:token"'))).toBe(true);
});
