import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { notificationQueue, users } from '../src/db/schema';
import { loadEnv, type Env } from '../src/env';
import { mailOutbox } from '../src/lib/mailer';
import { flushNotificationsOnce } from '../src/lib/notifications';
import { startServer, type StartedServer } from '../src/server';

/**
 * Notifications v1: the email that tells a human their teammate's agent answered.
 *
 * The instance has no mail provider, so the mailer records into its in-memory
 * outbox — exactly what a self-host without RESEND_API_KEY does, and what these
 * tests read. Delivery is driven by calling the sweep directly: the timer in
 * lib/cleanup is disabled under NODE_ENV=test so it can never race these.
 */
let srv: StartedServer;
let env: Env;
let dataDir: string;
let teamPath: string;
let joinCode: string;

const ADA = 'ada@example.com';
const BOB = 'bob@example.com';
const CLEO = 'cleo@example.com';
const ERIN = 'erin@example.com';
const BASE = 'https://stma.test';

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
type Jar = ReturnType<typeof jar>;

const post = (url: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(srv.url + url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields),
    redirect: 'manual',
  });

/** Local signup — email codes are off here, so this hands back a live session. */
async function signup(email: string, password: string): Promise<Jar> {
  const j = jar();
  const res = await post('/auth/local/signup', { email, password });
  expect(res.headers.get('location'), `signup ${email}`).toBe('/app');
  j.store(res);
  return j;
}

async function devLogin(username: string): Promise<Jar> {
  const j = jar();
  const res = await post('/auth/dev', { username });
  expect(res.headers.get('location')).toBe('/app');
  j.store(res);
  return j;
}

async function join(j: Jar): Promise<void> {
  const res = await post(`/join/${joinCode}`, {}, j.header());
  expect(res.status).toBe(302);
}

async function mintToken(j: Jar, name: string): Promise<string> {
  const res = await fetch(`${srv.url}/app/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...j.header() },
    body: new URLSearchParams({ name }),
  });
  const pat = /stma_[0-9a-f]{40}/.exec(await res.text())?.[0];
  expect(pat).toBeTruthy();
  return pat!;
}

let rpcId = 1;
async function callTool(pat: string, name: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${pat}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  const json = (await res.json()) as any;
  const result = json.result as { isError?: boolean; content: Array<{ text: string }> };
  expect(result.isError, result.content?.[0]?.text).toBeFalsy();
  return JSON.parse(result.content[0]!.text) as any;
}

const openSession = async (pat: string, title: string, body: string): Promise<string> =>
  (await callTool(pat, 'open_session', { title, body })).sessionId;

const reply = (pat: string, sessionId: string, body: string, kind = 'answer') =>
  callTool(pat, 'post_message', { session_id: sessionId, body, kind });

/** Deliver everything due. `over` swaps in a different cap for the cap test. */
const flush = (over: Partial<Env> = {}, now?: Date) =>
  flushNotificationsOnce(srv.db, { ...env, ...over }, now);

const inbox = (email: string) => mailOutbox.all().filter((m) => m.to === email);

async function queueRowsFor(email: string) {
  const found = await srv.db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  return srv.db.select().from(notificationQueue).where(eq(notificationQueue.userId, found[0]!.id));
}

let ada: Jar;
let bob: Jar;
let adaPat: string;
let bobPat: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-notify-'));
  env = loadEnv({
    port: 0,
    host: 'localhost',
    nodeEnv: 'test',
    devMode: true,
    databaseUrl: undefined,
    pgliteDir: dataDir,
    twoFactor: false,
    baseUrl: BASE,
    // No debounce: the queue is due the moment it is written, and the tests
    // decide when it is swept.
    notifyDebounceSeconds: 0,
    notifyMaxPerHour: 20,
  });
  srv = await startServer(env);

  ada = await signup(ADA, 'adapassword1');
  const team = await post('/app/teams', { name: 'Notify Co' }, ada.header());
  teamPath = team.headers.get('location')!;
  await fetch(`${srv.url}${teamPath}/invites`, {
    method: 'POST',
    headers: ada.header(),
    redirect: 'manual',
  });
  const html = await (
    await fetch(`${srv.url}${teamPath}?tab=people`, { headers: ada.header() })
  ).text();
  joinCode = /\/join\/([A-Za-z0-9_-]+)/.exec(html)![1]!;

  bob = await signup(BOB, 'bobpassword12');
  await join(bob);
  adaPat = await mintToken(ada, 'ada-laptop');
  bobPat = await mintToken(bob, 'bob-laptop');
}, 90_000);

afterAll(async () => {
  await srv?.close();
  mailOutbox.clear();
  rmSync(dataDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ the basics

it('welcomes a new member and links them to the team', async () => {
  expect(await flush()).toBe(1);
  const mail = inbox(BOB).at(-1)!;
  expect(mail.subject).toContain('Notify Co');
  expect(mail.text).toContain(`${BASE}/app/teams/`);
  expect(mail.text).toContain(`${BASE}/app/notifications`);
  // Creating your own team is not something you need told.
  expect(inbox(ADA)).toHaveLength(0);
});

it("emails the opener when a teammate's agent replies, with a link to the thread", async () => {
  const sid = await openSession(adaPat, 'migrations fail locally', 'drizzle-kit exits 1 on push');
  await reply(bobPat, sid, 'your pg is 14, mine is 16 — check the compose file');

  expect(await flush()).toBe(1);
  const mail = inbox(ADA).at(-1)!;
  expect(mail.to).toBe(ADA);
  expect(mail.subject).toBe('New reply in "migrations fail locally"');
  expect(mail.text).toContain('bob');
  expect(mail.text).toContain(`${BASE}/app/sessions/${sid}`);
  expect(mail.text).toContain(`${BASE}/app/notifications`);
  // Peer text is quoted, attributed and framed as data — never as an instruction,
  // and never in the subject line where it could impersonate the product.
  expect(mail.text).toContain('check the compose file');
  expect(mail.text).toContain('not a request from STMA');
  expect(mail.subject).not.toContain('compose');
  // The one who posted hears nothing.
  expect(inbox(BOB)).toHaveLength(1);
});

it('never emails you about your own message', async () => {
  const sid = await openSession(adaPat, 'own actions stay quiet', 'first');
  const before = inbox(ADA).length;
  await reply(adaPat, sid, 'talking to myself');
  expect(await flush()).toBe(0);
  expect(inbox(ADA)).toHaveLength(before);
  expect(await queueRowsFor(ADA)).toHaveLength(before); // nothing was even queued
});

it('stays quiet when the thread has already been read', async () => {
  const sid = await openSession(adaPat, 'read before the sweep', 'anyone seen this?');
  const before = inbox(ADA).length;
  await reply(bobPat, sid, 'yes, it is the node version');
  // Ada opens the thread in the browser before the sweep runs.
  expect((await fetch(`${srv.url}/app/sessions/${sid}`, { headers: ada.header() })).status).toBe(200);

  expect(await flush()).toBe(0);
  expect(inbox(ADA)).toHaveLength(before);
  const row = (await queueRowsFor(ADA)).find((r) => r.sessionId === sid)!;
  expect(row.status).toBe('skipped');
  expect(row.reason).toBe('read');
});

// -------------------------------------------------------------------- volume

it('folds a burst in one thread into a single email', async () => {
  const sid = await openSession(adaPat, 'chatty thread', 'starting');
  const before = inbox(ADA).length;
  for (const line of ['looking', 'reproduced it', 'it is the lockfile']) {
    await reply(bobPat, sid, line);
  }
  // One pending row for the three messages — that is the coalescing.
  const pending = (await queueRowsFor(ADA)).filter((r) => r.sessionId === sid);
  expect(pending).toHaveLength(1);
  expect(pending[0]!.status).toBe('pending');

  // Nothing leaves before the debounce deadline.
  expect(await flush({}, new Date(Date.now() - 60_000))).toBe(0);

  expect(await flush()).toBe(1);
  expect(inbox(ADA)).toHaveLength(before + 1);
  const mail = inbox(ADA).at(-1)!;
  expect(mail.subject).toBe('3 new messages in "chatty thread"');
  expect(mail.text).toContain('it is the lockfile');
});

it('caps how many notifications one person can get in an hour', async () => {
  const erin = await signup(ERIN, 'erinpassword1');
  await join(erin);
  const erinPat = await mintToken(erin, 'erin-laptop');
  const before = inbox(ERIN).length;

  // Three separate things now want to reach Erin: the welcome, and a reply in
  // each of two threads. Three different coalescing keys, so three queue rows.
  const first = await openSession(erinPat, 'erin thread one', 'help');
  const second = await openSession(erinPat, 'erin thread two', 'help again');
  await reply(adaPat, first, 'try clearing the cache');
  await reply(adaPat, second, 'same answer, different day');
  expect((await queueRowsFor(ERIN)).filter((r) => r.status === 'pending')).toHaveLength(3);

  expect(await flush({ notifyMaxPerHour: 1 })).toBe(1);
  expect(inbox(ERIN)).toHaveLength(before + 1);
  const capped = (await queueRowsFor(ERIN)).filter((r) => r.reason === 'rate_capped');
  expect(capped).toHaveLength(2);
  // Capped notifications are dropped, not deferred: raising the cap later must
  // not release an hour-old backlog into the mailbox.
  expect(await flush()).toBe(0);
  expect(inbox(ERIN)).toHaveLength(before + 1);
});

// --------------------------------------------------------------- preferences

it('renders the current preferences and honours them', async () => {
  const cleo = await signup(CLEO, 'cleopassword1');
  await join(cleo);
  const cleoPat = await mintToken(cleo, 'cleo-laptop');

  const page = await (await fetch(`${srv.url}/app/notifications`, { headers: cleo.header() })).text();
  expect(page).toContain('Notifications');
  expect(page).toContain(CLEO);
  // Defaults: the three useful classes on, the broadcast one off.
  const box = (name: string) => new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(page)![0];
  expect(box('session_reply')).toContain('checked');
  expect(box('session_resolved')).toContain('checked');
  expect(box('team_joined')).toContain('checked');
  expect(box('announcements')).not.toContain('checked');
  // …and this instance admits it cannot send anything.
  expect(page).toContain('RESEND_API_KEY');

  // Cleo keeps resolutions only.
  const saved = await post('/app/notifications', { session_resolved: 'on' }, cleo.header());
  expect(saved.headers.get('location')).toContain('ok=');
  const after = await (await fetch(`${srv.url}/app/notifications`, { headers: cleo.header() })).text();
  const boxAfter = (name: string) => new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(after)![0];
  expect(boxAfter('session_reply')).not.toContain('checked');
  expect(boxAfter('session_resolved')).toContain('checked');

  const sid = await openSession(cleoPat, 'cleo wants quiet', 'why is the build red?');
  const before = inbox(CLEO).length;
  await reply(adaPat, sid, 'stale node_modules');
  expect(await flush()).toBe(0);
  expect(inbox(CLEO)).toHaveLength(before);
  // A switch that is off costs nothing: the reply was never even queued.
  expect((await queueRowsFor(CLEO)).some((r) => r.sessionId === sid)).toBe(false);
  // Her welcome email was queued before she changed her mind, and the sweep
  // re-reads the preferences rather than trusting the queue.
  expect((await queueRowsFor(CLEO)).some((r) => r.kind === 'team_joined' && r.reason === 'pref_off')).toBe(true);

  // The switch she kept still works.
  await callTool(adaPat, 'resolve_session', {
    session_id: sid,
    root_cause: 'node_modules from another branch',
    fix: 'rm -rf node_modules && npm ci',
  });
  expect(await flush()).toBe(1);
  expect(inbox(CLEO).at(-1)!.subject).toBe('Resolved: "cleo wants quiet"');
});

it('tells the other participants when a thread is resolved', async () => {
  const sid = await openSession(adaPat, 'resolution reaches the room', 'stuck on the seed script');
  await reply(bobPat, sid, 'I hit that last week');
  await flush(); // clear the reply notification so the resolution stands alone
  const before = inbox(BOB).length;

  await callTool(adaPat, 'resolve_session', {
    session_id: sid,
    root_cause: 'the seed script assumed a fresh database',
    fix: 'drop and recreate before seeding',
  });
  expect(await flush()).toBe(1);
  const mail = inbox(BOB).at(-1)!;
  expect(inbox(BOB)).toHaveLength(before + 1);
  expect(mail.subject).toBe('Resolved: "resolution reaches the room"');
  expect(mail.text).toContain('the seed script assumed a fresh database');
  expect(mail.text).toContain(`${BASE}/app/sessions/${sid}`);
});

it('skips an account with nowhere to send, without failing the sweep', async () => {
  const ghost = await devLogin('ghost'); // dev login: a user, but no address
  await join(ghost);
  const ghostPat = await mintToken(ghost, 'ghost-laptop');
  const sid = await openSession(ghostPat, 'nowhere to send', 'does this explode?');
  const mailsBefore = mailOutbox.all().length;
  await reply(adaPat, sid, 'it should not');

  // Ada is not in this thread, so this sweep delivers nothing at all.
  expect(await flush()).toBe(0);
  expect(mailOutbox.all()).toHaveLength(mailsBefore);
  const rows = await srv.db
    .select()
    .from(notificationQueue)
    .where(eq(notificationQueue.sessionId, sid));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe('skipped');
  // No address AND no personal webhook — the account has no destination at all.
  expect(rows[0]!.reason).toBe('no_destination');
});

// ------------------------------------------------------------- announcements

it('leaves announcements alone unless someone opts in', async () => {
  const before = inbox(BOB).length;
  await callTool(adaPat, 'announce', { body: 'main is rebased, re-pull before you push' });
  expect(await flush()).toBe(0);
  expect(inbox(BOB)).toHaveLength(before);

  const opted = await post(
    '/app/notifications',
    { session_reply: 'on', session_resolved: 'on', team_joined: 'on', announcements: 'on' },
    bob.header(),
  );
  expect(opted.headers.get('location')).toContain('ok=');
  await callTool(adaPat, 'announce', { body: 'deploy window is 16:00 UTC' });
  expect(await flush()).toBe(1);
  const mail = inbox(BOB).at(-1)!;
  expect(mail.subject).toContain('Announcement in Notify Co');
  expect(mail.text).toContain('deploy window is 16:00 UTC');
});
