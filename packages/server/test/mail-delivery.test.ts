/**
 * When mail stops leaving the building, who finds out?
 *
 * Every other subsystem here fails loudly: a thrown error reaches Hono's
 * handler, `recordErrorEvent` persists it and `/admin/ops` lists it. Mail does
 * not throw — `sendMail` returns a result so a provider hiccup never becomes a
 * 500 — which is right, and which meant a provider refusing *every* message
 * left the operator console completely green. The traffic that fails is sign-in
 * codes and password resets, so "quiet evening" and "nobody can get in and
 * nobody can tell us" rendered identically.
 *
 * This is the shape of the failure an operator hits on the first day of real
 * traffic: the API key is valid, the sending domain was never verified, and the
 * provider answers 403 to all of it. The fixture uses Resend's own wording for
 * that case, the way the GitHub and Jira fakes answer in their providers' wire
 * shapes.
 *
 * The stubbed `fetch` only intercepts api.resend.com; everything else, including
 * this file's own requests to the server, goes to the real one. Same idiom as
 * A8 in auth-hardening.test.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { users } from '../src/db/schema';
import { loadEnv } from '../src/env';
import { mailHealth, mailOutbox } from '../src/lib/mailer';
import { startServer, type StartedServer } from '../src/server';

/** Verbatim from Resend when the sending domain has not been verified. */
const UNVERIFIED =
  '{"statusCode":403,"message":"The stma.ai domain is not verified. Please, add and verify your domain on https://resend.com/domains","name":"validation_error"}';

let srv: StartedServer;
let dir: string;
let realFetch: typeof fetch;
/** Flipped mid-file: the admin has to get in before the outage starts. */
let providerRefuses = false;
/** The signed-in operator, established in M1 and read by M2. */
let adminJar: ReturnType<typeof jar>;

const ip = (n: string) => ({ 'x-forwarded-for': `10.77.0.${n}` });

const post = (url: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(srv.url + url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields),
    redirect: 'manual',
  });

const where = (res: Response) => decodeURIComponent(res.headers.get('location') ?? '');

function jar() {
  const cookies = new Map<string, string>();
  return {
    header: (extra: Record<string, string> = {}): Record<string, string> =>
      cookies.size
        ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...extra }
        : { ...extra },
    store(res: Response) {
      for (const line of res.headers.getSetCookie()) {
        const [kv] = line.split(';');
        const i = kv!.indexOf('=');
        cookies.set(kv!.slice(0, i), kv!.slice(i + 1));
      }
    },
  };
}

function codeFor(email: string): string {
  const mail = mailOutbox.latest(email);
  expect(mail, `no mail for ${email}`).toBeTruthy();
  return /\b(\d{6})\b/.exec(mail!.text)![1]!;
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'stma-mail-'));
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (!url.includes('api.resend.com')) return realFetch(input, init);
    return providerRefuses
      ? new Response(UNVERIFIED, { status: 403 })
      : new Response('{"id":"mail_1"}', { status: 200 });
  }) as typeof fetch;
  mailHealth.reset();
  mailOutbox.clear();
  srv = await startServer(
    loadEnv({
      port: 0,
      host: '127.0.0.1',
      nodeEnv: 'test',
      devMode: false,
      databaseUrl: undefined,
      pgliteDir: dir,
      twoFactor: true,
      hosted: true,
      betaUnmetered: true,
      baseUrl: 'https://stma.ai',
      // A real key proves an account, never a verified sending domain. That is
      // the entire gap this file is about.
      resendApiKey: 'not-a-real-key',
      mailFrom: 'STMA <noreply@stma.ai>',
      adminUsernames: ['opsadmin'],
    }),
  );
}, 120_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  await srv?.close();
  mailHealth.reset();
  mailOutbox.clear();
  rmSync(dir, { recursive: true, force: true });
});

it('M1: a refused send stops the sign-in instead of pretending', async () => {
  await post('/auth/local/signup', { email: 'opsadmin@example.com', password: 'opsadminpw12' }, ip('1'));
  await post('/auth/local/signup', { email: 'm1@example.com', password: 'm1password12' }, ip('1'));
  // A signup can no longer take a listed operator name (audit 2026-09-21, F1),
  // so it arrived as `opsadmin-2`. The operator here is an account that held
  // the name before it was listed, which is the one an operator lists.
  await srv.db.update(users).set({ username: 'opsadmin' }).where(eq(users.email, 'opsadmin@example.com'));

  // The admin gets in while the provider is still answering.
  const admin = jar();
  const first = await post(
    '/auth/local/login',
    { email: 'opsadmin@example.com', password: 'opsadminpw12' },
    ip('1'),
  );
  admin.store(first);
  admin.store(
    await post(
      '/auth/local/verify',
      { code: codeFor('opsadmin@example.com'), next: '/app' },
      admin.header(ip('1')),
    ),
  );

  // Now the domain "stops being verified".
  providerRefuses = true;
  const stranded = await post(
    '/auth/local/login',
    { email: 'm1@example.com', password: 'm1password12' },
    ip('1'),
  );
  // Never sign somebody in on a second factor that was not delivered — and say
  // so, because unlike /forgot this answer does not have to stay neutral.
  expect(where(stranded), 'told, not stranded on a code page').toContain('could not email');

  adminJar = admin;
});

it('M2: the operator console names the failure in the provider’s own words', async () => {
  const page = await fetch(`${srv.url}/admin/ops`, { headers: adminJar.header(ip('1')) }).then((r) =>
    r.text(),
  );

  expect(page, 'the card exists').toContain('Mail');
  // The one sentence that turns a silent outage into a five-minute fix.
  expect(page, 'the provider explains itself').toContain('domain is not verified');
  expect(page, 'and which mail it was').toContain('login_code');
  // The From address, because "which domain" is the first question.
  expect(page, 'the sending address').toContain('noreply@stma.ai');
  expect(mailHealth.counts().failed, 'counted').toBeGreaterThan(0);
});

it('M3: the failure record carries no code, only a label', () => {
  const failures = mailHealth.failures();
  expect(failures.length, 'something failed').toBeGreaterThan(0);
  for (const f of failures) {
    // The subject of a code email IS the code; this is rendered on a page and
    // must never carry it. `kind` is the whole label.
    expect(f.kind, 'a stable label').toMatch(/^[a-z_]+$/);
    expect(f.reason, 'no six-digit code in the reason').not.toMatch(/\b\d{6}\b/);
    expect(f.to, 'recipient masked').toContain('•');
  }
});
