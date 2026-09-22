/**
 * What the 2026-09-20 authentication audit found, and what was decided.
 *
 * All nine went red the day they were written. Six were defects and were fixed;
 * the other three were product decisions, and each comment says which way it
 * went and why, because the reasoning is the part that rots first. A10 covers
 * the screen those decisions produced.
 *
 * Two of them were settled by making the product honest rather than by changing
 * what it does: a reset still leaves agent credentials alone, and a code still
 * belongs to the browser that asked. What changed is that the pages say so, and
 * that the reset mail now carries a link so the second one stops mattering.
 *
 * The server is configured the way production is: twoFactor on, which is what
 * `RESEND_API_KEY` produces, hosted, `BETA_UNMETERED=1`, https base URL. That
 * matters: several of these paths do not exist at all with two-factor off, and
 * testing them against a dev default would prove nothing about the service real
 * people sign in to.
 *
 * A2 is the one timing-sensitive case. It compares medians rather than single
 * samples and is the only test here that could be noisy on a loaded machine.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { loadEnv } from '../src/env';
import { mailOutbox } from '../src/lib/mailer';
import { startServer, type StartedServer } from '../src/server';

let srv: StartedServer;
let dir: string;

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
    get: (name: string) => cookies.get(name),
  };
}

const ip = (n: string) => ({ 'x-forwarded-for': `10.44.0.${n}` });

const post = (url: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(srv.url + url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields),
    redirect: 'manual',
  });

const where = (res: Response) => decodeURIComponent(res.headers.get('location') ?? '');

function codeFor(email: string): string {
  const mail = mailOutbox.latest(email);
  expect(mail, `no mail for ${email}`).toBeTruthy();
  return /\b(\d{6})\b/.exec(mail!.text)![1]!;
}

async function signup(email: string, password: string, from: string) {
  const j = jar();
  const res = await post('/auth/local/signup', { email, password }, ip(from));
  j.store(res);
  return { jar: j, res };
}

async function signIn(email: string, password: string, from: string) {
  const j = jar();
  const first = await post('/auth/local/login', { email, password }, ip(from));
  j.store(first);
  const second = await post(
    '/auth/local/verify',
    { code: codeFor(email), next: '/app' },
    j.header(ip(from)),
  );
  j.store(second);
  return j;
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'stma-auth-audit-'));
  srv = await startServer(
    loadEnv({
      port: 0,
      host: '127.0.0.1',
      nodeEnv: 'test',
      devMode: false,
      databaseUrl: undefined,
      pgliteDir: dir,
      twoFactor: true,
      betaUnmetered: true,
      hosted: true,
      baseUrl: 'https://stma.ai',
    }),
  );
}, 90_000);

afterAll(async () => {
  await srv?.close();
  mailOutbox.clear();
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ A1
 * routes/api.ts:253 — the second password door.
 * `/api/invites/redeem` verifies a password with no per-account throttle, no
 * second factor and no "somebody is guessing" notice, and does not consume the
 * invite on a wrong guess. Everything auth/attempts.ts exists to stop.
 */
it('A1: the invite door throttles wrong passwords like the sign-in door does', async () => {
  await signup('a1-victim@example.com', 'victimpass123', '18');
  await signup('a1-host@example.com', 'hostpass12345', '18');
  const host = await signIn('a1-host@example.com', 'hostpass12345', '18');
  await fetch(`${srv.url}/app/teams`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...host.header() },
    body: new URLSearchParams({ name: 'A1 Team' }),
    redirect: 'manual',
  });
  await fetch(`${srv.url}/app/teams/a1-team/invites`, {
    method: 'POST',
    headers: host.header(),
    redirect: 'manual',
  });
  const people = await (
    await fetch(`${srv.url}/app/teams/a1-team?tab=people`, { headers: host.header() })
  ).text();
  const invite = /\/join\/([A-Za-z0-9_-]+)/.exec(people)![1]!;

  const guess = (password: string) =>
    fetch(`${srv.url}/api/invites/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ip('19') },
      body: JSON.stringify({ code: invite, email: 'a1-victim@example.com', password }),
    });

  const mailsBefore = mailOutbox.all().length;
  const statuses: number[] = [];
  for (let i = 0; i < 12; i++) statuses.push((await guess(`guess-${i}-xx`)).status);

  // LOGIN_FAIL_MAX is 5. By attempt 12 the address should be refused, and the
  // account holder should have had the failedSignInsEmail exactly once.
  expect(statuses.slice(5).some((s) => s === 429 || s === 403), 'locked out after 5').toBe(true);
  expect(mailOutbox.all().length, 'account holder told').toBeGreaterThan(mailsBefore);
});

/* ------------------------------------------------------------------ A2
 * routes/auth.tsx:422-442 + routes/api.ts:253 — enumeration by timing.
 * scrypt only runs when the row exists, so the response time answers "does this
 * address have an account". Measured ~36ms against ~4ms.
 */
it('A2: the password POST takes similar time whether or not the address exists', async () => {
  await signup('a2-known@example.com', 'timingpass12', '15');
  const sample = async (email: string) => {
    const runs: number[] = [];
    for (let i = 0; i < 8; i++) {
      const t = performance.now();
      await post('/auth/local/login', { email, password: `nope-${i}-guess` }, ip(String(40 + i)));
      runs.push(performance.now() - t);
    }
    runs.sort((a, b) => a - b);
    return runs[Math.floor(runs.length / 2)]!;
  };
  const known = await sample('a2-known@example.com');
  const unknown = await sample('a2-never-existed@example.com');
  // eslint-disable-next-line no-console
  console.log(`A2 median ms — existing ${known.toFixed(1)}, unknown ${unknown.toFixed(1)}`);
  // Fix: hash against a dummy scrypt record when no row is found.
  expect(known).toBeLessThan(unknown * 4);
});

/* ------------------------------------------------------------------ A3
 * routes/auth.tsx:773 — enumeration by Set-Cookie.
 * The body, status and Location of /auth/local/forgot are identical for a known
 * and an unknown address (README calls this out as a guarantee), but the `reset`
 * cookie is set only when the address has an account.
 */
it('A3: /auth/local/forgot answers identically, headers included', async () => {
  await signup('a3-real@example.com', 'realpass12345', '12');
  const hit = await post('/auth/local/forgot', { email: 'a3-real@example.com' }, ip('12'));
  const miss = await post('/auth/local/forgot', { email: 'a3-ghost@example.com' }, ip('12'));

  expect(hit.status).toBe(miss.status);
  expect(where(hit)).toBe(where(miss));
  const cookieOf = (r: Response) => r.headers.getSetCookie().filter((l) => l.startsWith('reset='));
  // Fix: set an opaque `reset` cookie on every answer (a random id that names no
  // row), or carry the pending id somewhere the response does not advertise.
  expect(cookieOf(hit).length, 'known').toBe(cookieOf(miss).length);
});

/* ------------------------------------------------------------------ A4
 * routes/auth.tsx:817-830 — reset does not clear the sign-in lock.
 * clearLoginFailures only runs after a successful password verify (line 443),
 * which the gate at 416 prevents. The most common way to arrive at /forgot is
 * having just failed five sign-ins, so the reset lands the user back in the lock.
 */
it('A4: a completed reset lets the new password straight in', async () => {
  await signup('a4-locked@example.com', 'oldpass123456', '13');
  for (let i = 0; i < 5; i++) {
    await post('/auth/local/login', { email: 'a4-locked@example.com', password: `wrong${i}pw` }, ip('13'));
  }
  const j = jar();
  j.store(await post('/auth/local/forgot', { email: 'a4-locked@example.com' }, ip('13')));
  const done = await post(
    '/auth/local/reset',
    {
      code: codeFor('a4-locked@example.com'),
      new_password: 'brandnewpass1',
      new_password_confirm: 'brandnewpass1',
    },
    j.header(ip('13')),
  );
  expect(where(done), 'reset itself succeeds').toContain('Password updated');

  const after = await post(
    '/auth/local/login',
    { email: 'a4-locked@example.com', password: 'brandnewpass1' },
    ip('13'),
  );
  // Fix: call clearLoginFailures(db, user.email) next to invalidateAllSessions.
  expect(where(after)).not.toContain('Too many sign-in attempts');
  expect(after.headers.get('location')).toBe('/login/verify?next=%2Fapp');
});

/* ------------------------------------------------------------------ A5
 * "Signs you out on every device" was never true: a reset kills web_sessions and
 * nothing else, so agent credentials, installations and hooks keep full MCP
 * access. The decision taken was to make the promise honest rather than to
 * revoke them — a reset is not always a compromise, and killing every
 * teammate's agent because somebody forgot a password is its own outage. What
 * is asserted here is that the page and the behaviour say the same thing, and
 * that the page points at the place where agent access actually ends.
 */
it('A5: the reset page promises exactly what recovery does', async () => {
  await signup('a5-owner@example.com', 'ownerpass1234', '14');
  const j = await signIn('a5-owner@example.com', 'ownerpass1234', '14');
  await fetch(`${srv.url}/app/teams`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...j.header() },
    body: new URLSearchParams({ name: 'A5 Team' }),
    redirect: 'manual',
  });
  const tokRes = await fetch(`${srv.url}/app/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...j.header() },
    body: new URLSearchParams({ name: 'planted-agent' }),
  });
  const token = /stma_[0-9a-f]{40}/.exec(await tokRes.text())![0];
  const whoami = () =>
    fetch(`${srv.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'whoami', arguments: {} },
      }),
    });
  expect((await whoami()).status, 'live before reset').toBe(200);

  const resetPage = await (await fetch(`${srv.url}/reset`)).text();
  expect(resetPage).not.toContain('signs you out on every device');
  expect(resetPage).toContain('signs you out of every browser');
  expect(resetPage).toContain('agent connections keep working');

  const r = jar();
  r.store(await post('/auth/local/forgot', { email: 'a5-owner@example.com' }, ip('14')));
  await post(
    '/auth/local/reset',
    {
      code: codeFor('a5-owner@example.com'),
      new_password: 'recovered1234',
      new_password_confirm: 'recovered1234',
    },
    r.header(ip('14')),
  );
  // Unchanged behaviour, now stated rather than contradicted.
  expect((await whoami()).status, 'agent access survives a reset, as the page says').toBe(200);
  // And the mail that follows names where it does end.
  const told = mailOutbox.latest('a5-owner@example.com')!;
  expect(told.text).toContain('Agent connections are not affected');
  expect(told.text).toContain('/app/tokens');
});

/* ------------------------------------------------------------------ A6
 * A right code in a browser that did not ask.
 *
 * The pending id lives in the `reset` cookie, so opening the mail on a phone and
 * typing the code there was refused as "That code is not right", which is false
 * and sends the person round the loop. The decision taken was to carry the id in
 * a link rather than to look the code up by address: the id is not the secret —
 * the six digits are, and they are in the same message — so the link is exactly
 * as strong as the cookie it stands in for, and it works on the device the mail
 * was actually opened on.
 */
it('A6: the emailed link lets the reset finish on the device that opened it', async () => {
  await signup('a6-two@example.com', 'twopass123456', '16');
  const asking = jar();
  asking.store(await post('/auth/local/forgot', { email: 'a6-two@example.com' }, ip('16')));
  const mail = mailOutbox.latest('a6-two@example.com')!;
  const code = codeFor('a6-two@example.com');

  // Without the link, a fresh browser is still turned away, and the pages say so.
  const cold = await post(
    '/auth/local/reset',
    { code, new_password: 'phonepass1234', new_password_confirm: 'phonepass1234' },
    ip('16'),
  );
  expect(where(cold)).toContain('That code is not right');

  // With it, the phone becomes a browser that asked.
  const link = /https?:\/\/\S+\/reset\?t=[0-9a-f-]{36}/.exec(mail.text)?.[0];
  expect(link, 'the mail carries a link').toBeTruthy();
  const phone = jar();
  const landed = await fetch(`${srv.url}${new URL(link!).pathname}${new URL(link!).search}`, {
    headers: ip('16'),
    redirect: 'manual',
  });
  phone.store(landed);
  // Clean redirect: the id must not linger in the address bar, the referrer or
  // history now that it has become a cookie.
  expect(landed.status).toBe(302);
  expect(landed.headers.get('location')).toBe('/reset');
  expect(phone.get('reset')).toBeTruthy();

  const done = await post(
    '/auth/local/reset',
    { code, new_password: 'phonepass1234', new_password_confirm: 'phonepass1234' },
    phone.header(ip('16')),
  );
  expect(where(done)).toContain('Password updated');
});

/* ------------------------------------------------------------------ A7
 * auth/session.ts:105 — `/^\/(?!\/)/` lets `/\host` through.
 * The WHATWG URL parser, which every browser implements, reads `\` in the
 * authority position as `/`, so `Location: /\evil.example` leaves the origin.
 */
it('A7: sanitizeNext rejects a backslash authority', async () => {
  await signup('a7-redir@example.com', 'redirpass1234', '17');
  const j = jar();
  j.store(
    await post(
      '/auth/local/login',
      { email: 'a7-redir@example.com', password: 'redirpass1234', next: '/\\evil.example' },
      ip('17'),
    ),
  );
  const verified = await post(
    '/auth/local/verify',
    { code: codeFor('a7-redir@example.com'), next: '/\\evil.example' },
    j.header(ip('17')),
  );
  const location = verified.headers.get('location')!;
  expect(new URL(location, 'https://stma.ai').origin, location).toBe('https://stma.ai');
});

/* ------------------------------------------------------------------ A8
 * routes/auth.tsx:769-772 — a mail outage is indistinguishable from success.
 * /auth/local/forgot answers "a 6-digit reset code is on its way" when sendMail
 * failed. Sign-in says so out loud (line 387); reset cannot, because the answer
 * has to stay neutral — so the page has to carry the way out instead, and no
 * auth page prints env.supportEmail at all.
 */
it('A8: the recovery pages carry a way out when no mail arrives', async () => {
  const dir2 = mkdtempSync(path.join(tmpdir(), 'stma-auth-audit-mail-'));
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (String(url).includes('api.resend.com')) throw new Error('simulated provider outage');
    return real(input, init);
  }) as typeof fetch;
  const down = await startServer(
    loadEnv({
      port: 0,
      host: '127.0.0.1',
      nodeEnv: 'test',
      devMode: false,
      databaseUrl: undefined,
      pgliteDir: dir2,
      twoFactor: true,
      hosted: true,
      baseUrl: 'https://stma.ai',
      resendApiKey: 'not-a-real-key',
    }),
  );
  try {
    await fetch(`${down.url}/auth/local/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...ip('30') },
      body: new URLSearchParams({ email: 'a8@example.com', password: 'strandedpw12' }),
      redirect: 'manual',
    });
    const asked = await fetch(`${down.url}/auth/local/forgot`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...ip('30') },
      body: new URLSearchParams({ email: 'a8@example.com' }),
      redirect: 'manual',
    });
    expect(
      decodeURIComponent(asked.headers.get('location') ?? ''),
      'promised a code the provider refused',
    ).toContain('on its way');
    // Fix: print env.supportEmail on /forgot, /reset and /login.
    for (const page of ['/forgot', '/reset', '/login']) {
      expect(await (await fetch(down.url + page)).text(), page).toContain('support@matteai.com');
    }
  } finally {
    globalThis.fetch = real;
    await down.close();
    rmSync(dir2, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ A9
 * routes/auth.tsx:335-356 + routes/dashboard.tsx:3435 — an unproven address.
 * Signup mints a 30-day session without mailing anything, and there is no way
 * for a person to correct their own address afterwards. With twoFactor on, a
 * typo means the next sign-in and every reset go to a mailbox they do not own.
 */
it('A9: an account can prove and correct its own email address', async () => {
  const s = await signup('a9-typo@exmaple.com', 'typopass1234', '11');
  const page = () => fetch(`${srv.url}/app/account`, { headers: s.jar.header() }).then((r) => r.text());

  // Proved from the moment the account exists, and said so on every visit.
  expect(mailOutbox.latest('a9-typo@exmaple.com'), 'a code at signup').toBeTruthy();
  const before = await page();
  expect(before).toContain('not confirmed');

  // Confirming the address on file.
  const verify = /\b(\d{6})\b/.exec(mailOutbox.latest('a9-typo@exmaple.com')!.text)![1]!;
  await post('/app/account/email/verify', { code: verify }, s.jar.header(ip('11')));
  expect(await page()).toContain('confirmed');

  // And correcting it, which is what a typo needs: the code goes to the NEW
  // address, because the point is to prove somebody can read it.
  const asked = await post(
    '/app/account/email/change',
    { email: 'a9-right@example.com', current_password: 'typopass1234' },
    s.jar.header(ip('11')),
  );
  expect(where(asked)).toContain('pending_email=');
  expect(mailOutbox.latest('a9-right@example.com'), 'code to the new address').toBeTruthy();
  // Nothing has moved yet.
  expect(await page()).toContain('a9-typo@exmaple.com');

  const moveCode = /\b(\d{6})\b/.exec(mailOutbox.latest('a9-right@example.com')!.text)![1]!;
  await post(
    '/app/account/email/change/confirm',
    { email: 'a9-right@example.com', code: moveCode },
    s.jar.header(ip('11')),
  );
  const after = await page();
  expect(after).toContain('a9-right@example.com');
  expect(after).toContain('confirmed');
  // The address being left behind is the only warning it will ever get.
  const warned = mailOutbox.latest('a9-typo@exmaple.com')!;
  expect(warned.subject).toContain('email address was changed');
  expect(warned.text).toContain('a9-right@example.com');
});

/* ----------------------------------------------------------------- A10
 * Where this person is signed in, and the ability to end it.
 *
 * "Signed out everywhere" was a claim with no screen behind it. The list must
 * never render a session id: the id IS the cookie value, so a list of ids would
 * print every other browser's live credential into the HTML of this one.
 */
it('A10: sessions are listed by a handle that is not the session secret', async () => {
  await signup('a10-two@example.com', 'sessionpass12', '17');
  const first = await signIn('a10-two@example.com', 'sessionpass12', '17');
  const second = await signIn('a10-two@example.com', 'sessionpass12', '17');

  const page = await (await fetch(`${srv.url}/app/account`, { headers: second.header() })).text();
  expect(page).toContain('Where you are signed in');
  expect(page).toContain('this browser');
  // The cookie value must appear nowhere in the HTML.
  expect(page).not.toContain(first.get('sid')!);
  expect(page).not.toContain(second.get('sid')!);

  const handle = /name="handle" value="([0-9a-f]{16})"/g;
  const handles = [...page.matchAll(handle)].map((m) => m[1]!);
  expect(handles.length, 'both sessions listed').toBeGreaterThanOrEqual(2);

  // Ending the other one leaves this one alone.
  const visit = (j: ReturnType<typeof jar>) =>
    fetch(`${srv.url}/app`, { headers: j.header(), redirect: 'manual' }).then((r) => r.status);
  const mineHandle = createHash('sha256').update(second.get('sid')!).digest('hex').slice(0, 16);
  const other = handles.find((h) => h !== mineHandle)!;
  await post('/app/account/sessions/revoke', { handle: other }, second.header(ip('17')));
  expect(await visit(first), 'the other browser is signed out').toBe(302);
  expect(await visit(second), 'this one is not').toBe(200);

  // And sign out everywhere takes this one with it.
  await post('/app/account/sessions/revoke-all', {}, second.header(ip('17')));
  expect(await visit(second), 'including this one').toBe(302);
});

/* ------------------------------------------------------------------ A11
 * lib/mailer.ts — the second factor was being written to the operator log.
 *
 * Every code email puts its six digits in the subject on purpose: that is what
 * a phone shows in the notification preview, and it is the difference between
 * reading the code and opening the mail. `sendMail` then logged
 * `subject: msg.subject` on every send, so `123456 is your STMA sign-in code`
 * went to stdout — and in production stdout is Log Analytics with thirty-day
 * retention. A second factor anybody with log access can read is not one.
 *
 * Neither existing guard applies: `logLine` redacts by field NAME and
 * `subject` is not a sensitive name, and `redactSecrets` matches token shapes,
 * not six digits of prose. The subject is unchanged, because it is right; the
 * log carries `kind`, which is also the better field to query by since it does
 * not vary per code.
 */
it('A11: a sign-in code never reaches the structured log', async () => {
  await signup('a11@example.com', 'a11password12', '31');
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    await post(
      '/auth/local/login',
      { email: 'a11@example.com', password: 'a11password12' },
      ip('31'),
    );
  } finally {
    spy.mockRestore();
  }

  const code = codeFor('a11@example.com');
  expect(code, 'the code was emailed').toMatch(/^\d{6}$/);
  const logged = lines.join('\n');
  expect(logged, 'a mail line was written at all').toContain('"evt":"mail"');
  expect(logged, 'and it says which mail it was').toContain('"kind":"login_code"');
  // The whole point: the live second factor is not in there.
  expect(logged, 'the code is not in the log').not.toContain(code);
  expect(logged, 'nor the subject that carries it').not.toContain('sign-in code');
});

/* ------------------------------------------------------------------ A12
 * routes/auth.tsx:361 — a claim with one page behind it.
 *
 * Signup mails a confirmation code and deliberately does not block on it, and
 * the whole argument for not blocking is written in that comment: "the console
 * says, on every page, that the address is unconfirmed and how to fix it." It
 * did not. `email_verified_at` was read in exactly one place, `/app/account` —
 * a page nobody has a reason to open until the day they need it, which is the
 * day the typo has already cost them the account. The shell carries it now, at
 * no extra query: the column already arrives with the session's user row.
 */
it('A12: the console says the address is unconfirmed until it is confirmed', async () => {
  const { jar: j } = await signup('a12@example.com', 'a12password12', '32');
  const read = async (url: string) => {
    const res = await fetch(srv.url + url, { headers: j.header(ip('32')), redirect: 'manual' });
    expect(res.status, url).toBe(200);
    return res.text();
  };

  // Not just Account: the pages somebody would actually be on.
  for (const url of ['/app', '/app/tokens', '/app/account']) {
    expect(await read(url), `${url} says so`).toContain('has not been confirmed');
  }

  // And the code mailed at signup actually works.
  const code = codeFor('a12@example.com');
  const done = await post('/app/account/email/verify', { code }, j.header(ip('32')));
  expect(where(done), 'confirmed').toContain('Address confirmed');

  for (const url of ['/app', '/app/tokens', '/app/account']) {
    expect(await read(url), `${url} stops saying so`).not.toContain('has not been confirmed');
  }
});

/* ------------------------------------------------------------------ A13
 * routes/dashboard.tsx — the third and fourth password doors.
 *
 * F0a says the throttle belongs to the password, not to the sign-in form. A1
 * closed `/api/invites/redeem`; these two were still open, and `/app/*` carries
 * no per-IP limit of any kind, so a borrowed session could guess the account's
 * own password without limit. A hit is not more access — the session already
 * had that — it is permanence: change the password and lock the owner out, or
 * move the address every future reset goes to.
 *
 * The same counter as the sign-in form on purpose. Two counters would only mean
 * five guesses at each door.
 */
it('A13: the account password doors enforce the sign-in throttle', async () => {
  await signup('a13@example.com', 'a13password12', '33');
  const j = await signIn('a13@example.com', 'a13password12', '33');
  const change = (current: string) =>
    post(
      '/app/account/password',
      {
        current_password: current,
        new_password: 'newpassword12',
        new_password_confirm: 'newpassword12',
      },
      j.header(ip('33')),
    );

  for (let i = 0; i < 4; i++) {
    expect(where(await change('wrong')), `guess ${i + 1} refused`).toContain(
      'Current password is incorrect',
    );
  }
  expect(where(await change('wrong')), 'the fifth locks it').toContain('Too many sign-in attempts');

  // Enforced even with the right password, or it is not a throttle.
  expect(where(await change('a13password12')), 'including the correct one').toContain(
    'Too many sign-in attempts',
  );

  // One counter, not two: the front door is locked as well.
  const front = await post(
    '/auth/local/login',
    { email: 'a13@example.com', password: 'a13password12' },
    ip('33'),
  );
  expect(where(front), 'the same lock at the sign-in form').toContain('Too many sign-in attempts');

  // And the other door on that page takes the same lock.
  const move = await post(
    '/app/account/email/change',
    { email: 'a13-moved@example.com', current_password: 'a13password12' },
    j.header(ip('33')),
  );
  expect(where(move), 'the address change too').toContain('Too many sign-in attempts');
});
