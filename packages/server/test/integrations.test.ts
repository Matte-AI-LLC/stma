import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadEnv, type Env } from '../src/env';
import { githubOutbox, parseIssueRef } from '../src/lib/github';
import { flushNotificationsOnce } from '../src/lib/notifications';
import { startServer, type StartedServer } from '../src/server';

/**
 * The two outward-facing integrations: a team's GitHub issues, and a person's
 * own chat client.
 *
 * GitHub runs on the memory transport here (NODE_ENV=test, lib/github), so
 * every decision this code makes — when to comment, when to refuse, what a
 * task key has to look like before STMA writes into somebody's tracker — is
 * exercised without a token or a network call. The personal webhook is tested
 * against a real local receiver, because "did the POST actually arrive" is the
 * entire question that feature answers.
 */

let srv: StartedServer;
let env: Env;
let dataDir: string;
let alice = '';
let bob = '';
let aliceCookie: Record<string, string> = {};
let bobCookie: Record<string, string> = {};

/** A local Slack-shaped receiver, so webhook delivery is observed, not assumed. */
let receiver: Server;
let receiverUrl = '';
const received: unknown[] = [];

function jar() {
  const cookies = new Map<string, string>();
  return {
    header: (): Record<string, string> =>
      cookies.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {},
    store(res: Response) {
      for (const line of res.headers.getSetCookie()) {
        const [kv] = line.split(';');
        const i = kv!.indexOf('=');
        cookies.set(kv!.slice(0, i), kv!.slice(i + 1));
      }
    },
  };
}

const form = (url: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });

let rpcId = 1;
async function call(tool: string, args: Record<string, unknown>, tok: string) {
  const res = await fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${tok}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId++,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  });
  const json = (await res.json()) as {
    result?: { content?: { text: string }[]; isError?: boolean };
    error?: { message?: string };
  };
  const text = json.result?.content?.[0]?.text ?? json.error?.message ?? '';
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* prose answers */
  }
  return { text, data, isError: json.result?.isError === true || json.error !== undefined };
}

async function tokenFor(cookie: Record<string, string>, name: string) {
  const res = await fetch(`${srv.url}/app/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...cookie },
    body: new URLSearchParams({ name }),
  });
  const tok = /stma_[0-9a-f]{40}/.exec(await res.text())?.[0] ?? '';
  expect(tok, `token for ${name}`).toBeTruthy();
  return tok;
}

const connectGithub = (extra: Record<string, string> = {}) =>
  form(
    `${srv.url}/app/teams/ship/integrations/github`,
    { action: 'save', repo: 'acme/storefront', token: 'ghp_testtoken', comment_on_finish: 'on', ...extra },
    aliceCookie,
  );

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-integrations-'));
  env = loadEnv({
    port: 0,
    host: 'localhost',
    nodeEnv: 'test',
    devMode: true,
    databaseUrl: undefined,
    pgliteDir: dataDir,
    notifyDebounceSeconds: 0,
  });
  srv = await startServer(env);

  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        received.push(JSON.parse(body));
      } catch {
        received.push(body);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/hook`;

  const a = jar();
  a.store(await form(`${srv.url}/auth/dev`, { username: 'alice' }));
  aliceCookie = a.header();
  await form(`${srv.url}/app/teams`, { name: 'Ship' }, aliceCookie);
  alice = await tokenFor(aliceCookie, 'alice-macbook');

  await form(`${srv.url}/app/teams/ship/invites`, {}, aliceCookie);
  const teamPage = await (await fetch(`${srv.url}/app/teams/ship?tab=people`, { headers: aliceCookie })).text();
  const code = /\/join\/([A-Za-z0-9_-]+)/.exec(teamPage)?.[1] ?? '';
  const b = jar();
  b.store(await form(`${srv.url}/auth/dev`, { username: 'bob' }));
  bobCookie = b.header();
  await form(`${srv.url}/join/${code}`, {}, bobCookie);
  bob = await tokenFor(bobCookie, 'bob-desktop');
});

afterAll(async () => {
  await srv?.close();
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

// ------------------------------------------------------------- issue parsing

it('only treats a task key as an issue when it unambiguously is one', () => {
  expect(parseIssueRef('#42', 'acme/store')).toEqual({ repo: 'acme/store', number: 42 });
  expect(parseIssueRef('other/repo#7', 'acme/store')).toEqual({ repo: 'other/repo', number: 7 });
  expect(parseIssueRef('https://github.com/acme/store/issues/9', 'acme/store')).toEqual({
    repo: 'acme/store',
    number: 9,
  });
  // The important negatives: an internal ticket id must never become a comment
  // on a stranger's issue.
  expect(parseIssueRef('421', 'acme/store')).toBeNull();
  expect(parseIssueRef('PAY-421', 'acme/store')).toBeNull();
  expect(parseIssueRef('', 'acme/store')).toBeNull();
  expect(parseIssueRef(null, 'acme/store')).toBeNull();
});

// ------------------------------------------------------------------- github

it('says plainly that no repository is connected, instead of failing', async () => {
  const res = await call('list_issues', { team: 'ship' }, alice);
  expect(res.isError).toBe(true);
  expect(res.text).toContain('no GitHub repository connected');
  // And it points at the page where an owner fixes it.
  expect(res.text).toContain('/app/teams/ship');
});

it('lets an owner connect a repository, and nobody else', async () => {
  const denied = await form(
    `${srv.url}/app/teams/ship/integrations/github`,
    { action: 'save', repo: 'acme/storefront', token: 'ghp_x' },
    bobCookie,
  );
  expect(denied.status).toBe(404);

  const bad = await connectGithub({ repo: 'not-a-repo' });
  expect(bad.headers.get('location')).toContain('error=');

  const ok = await connectGithub();
  expect(ok.headers.get('location')).toContain('ok=');
  const page = await (await fetch(`${srv.url}/app/teams/ship?tab=integrations`, { headers: aliceCookie })).text();
  expect(page).toContain('acme/storefront');
  // The token is write-only: storing it must not put it back on the page.
  expect(page).not.toContain('ghp_testtoken');

  // A member does not even see the card.
  const memberPage = await (await fetch(`${srv.url}/app/teams/ship?tab=integrations`, { headers: bobCookie })).text();
  expect(memberPage).not.toContain('GitHub issues');
});

it('offers open issues as work and starts a run on one', async () => {
  githubOutbox.clear();
  githubOutbox.seedIssues([
    {
      number: 42,
      title: 'Checkout drops the discount code',
      url: 'https://github.com/acme/storefront/issues/42',
      labels: ['bug'],
      updatedAt: '2026-08-24T10:00:00Z',
    },
  ]);

  const listed = await call('list_issues', { team: 'ship' }, alice);
  expect(listed.isError).toBe(false);
  expect(listed.data.repo).toBe('acme/storefront');
  expect(listed.data.issues[0].number).toBe(42);

  const started = await call(
    'start_run',
    { team: 'ship', project: 'storefront', issue: 42, branch: 'fix/discount' },
    alice,
  );
  expect(started.isError).toBe(false);
  // The issue number becomes the task key, and its title becomes the intent —
  // so the map says what the work is, not what the agent called it.
  expect(started.data.task).toBe('#42');
  expect(started.data.issueUrl).toBe('https://github.com/acme/storefront/issues/42');

  const map = await (await fetch(`${srv.url}/app/agents`, { headers: aliceCookie })).text();
  expect(map).toContain('#42');

  // Finishing reports back where the team is watching.
  const finished = await call(
    'finish_run',
    { run_id: started.data.runId, note: 'discount code now survives the redirect' },
    alice,
  );
  expect(finished.data.issueComment).toContain('acme/storefront#42');
  const comments = githubOutbox.comments();
  expect(comments).toHaveLength(1);
  expect(comments[0]!.path).toBe('/repos/acme/storefront/issues/42/comments');
  expect((comments[0]!.body as { body: string }).body).toContain('finished');
  expect((comments[0]!.body as { body: string }).body).toContain('discount code');
});

it('comments the handoff brief onto the issue', async () => {
  githubOutbox.clear();
  githubOutbox.seedIssues([
    {
      number: 43,
      title: 'Cart totals drift on refunds',
      url: 'https://github.com/acme/storefront/issues/43',
      labels: [],
      updatedAt: '2026-08-24T11:00:00Z',
    },
  ]);
  const started = await call(
    'start_run',
    { team: 'ship', project: 'storefront', issue: 43, branch: 'fix/refund-totals' },
    alice,
  );
  const handed = await call(
    'handoff_work',
    {
      branch: 'fix/refund-totals',
      summary: 'Reproduced it: the refund path rounds before tax instead of after.',
      next_steps: ['Move the rounding after tax', 'Add a regression test'],
      reason: 'usage_limit',
      run_id: started.data.runId,
    },
    alice,
  );
  expect(handed.data.issueComment).toContain('acme/storefront#43');
  const body = (githubOutbox.comments()[0]!.body as { body: string }).body;
  expect(body).toContain('Handed off');
  expect(body).toContain('fix/refund-totals');
  expect(body).toContain('Move the rounding after tax');
});

it('never comments when the task is not an issue, or when the team turned it off', async () => {
  githubOutbox.clear();
  const plain = await call(
    'start_run',
    { team: 'ship', project: 'storefront', task: 'PAY-421', branch: 'chore/x' },
    alice,
  );
  await call('finish_run', { run_id: plain.data.runId }, alice);
  expect(githubOutbox.comments()).toHaveLength(0);

  // Commenting off: STMA reads the tracker but does not write to it.
  await connectGithub({ comment_on_finish: '' });
  githubOutbox.seedIssues([
    {
      number: 44,
      title: 'Silent one',
      url: 'https://github.com/acme/storefront/issues/44',
      labels: [],
      updatedAt: '2026-08-24T12:00:00Z',
    },
  ]);
  const quiet = await call('start_run', { team: 'ship', project: 'storefront', issue: 44 }, alice);
  const done = await call('finish_run', { run_id: quiet.data.runId }, alice);
  expect(done.data.issueComment).toBeUndefined();
  expect(githubOutbox.comments()).toHaveLength(0);
  await connectGithub(); // restore for later tests
});

it('turns an opened issue into a team announcement agents can read', async () => {
  const page = await (await fetch(`${srv.url}/app/teams/ship?tab=integrations`, { headers: aliceCookie })).text();
  const hook = /\/api\/hooks\/github\/([A-Za-z0-9_-]+)/.exec(page)?.[1] ?? '';
  expect(hook, 'inbound hook token').toBeTruthy();

  const res = await fetch(`${srv.url}/api/hooks/github/${hook}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': 'issues' },
    body: JSON.stringify({
      action: 'opened',
      issue: { number: 77, title: 'Search returns nothing on empty query', user: { login: 'dana' } },
      repository: { name: 'storefront', full_name: 'acme/storefront' },
      sender: { login: 'dana' },
    }),
  });
  expect(res.status).toBe(200);

  // The inbox lists threads, not bodies — so this is the path an agent really
  // takes: see the channel is unread, then read it.
  const inbox = await call('inbox', {}, bob);
  const channel = (inbox.data.unreadSessions as any[]).find((s) => s.title === 'Announcements');
  expect(channel, 'announcements channel should be unread for bob').toBeTruthy();
  const thread = await call('get_session', { session_id: channel.sessionId }, bob);
  expect(thread.text).toContain('issue #77 opened');
  expect(thread.text).toContain('start_run');

  // Label churn is not news.
  const ignored = await fetch(`${srv.url}/api/hooks/github/${hook}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': 'issues' },
    body: JSON.stringify({ action: 'labeled', issue: { number: 77 }, repository: { name: 'x' } }),
  });
  expect(((await ignored.json()) as { ignored?: string }).ignored).toBe('issues.labeled');
});

// ---------------------------------------------------------- personal webhook

it('proves a personal webhook before trusting it, then delivers to it', async () => {
  received.length = 0;
  const bad = await form(
    `${srv.url}/app/notifications/webhook`,
    { action: 'test', webhook_url: 'not-a-url' },
    bobCookie,
  );
  expect(bad.headers.get('location')).toContain('err=');

  const tested = await form(
    `${srv.url}/app/notifications/webhook`,
    { action: 'test', webhook_url: receiverUrl },
    bobCookie,
  );
  expect(tested.headers.get('location')).toContain('ok=');
  expect(received).toHaveLength(1);
  expect(JSON.stringify(received[0])).toContain('bob');
  // A successful test also saves it — proving a URL and then losing it is a trap.
  const prefsPage = await (
    await fetch(`${srv.url}/app/notifications`, { headers: bobCookie })
  ).text();
  expect(prefsPage).toContain(receiverUrl);

  // Drain whatever this suite queued earlier (bob joining the team), so the
  // next assertion is about the reply and nothing else.
  await flushNotificationsOnce(srv.db, env);
  received.length = 0;

  // Now the real thing: alice's agent replies in a thread bob is part of.
  const opened = await call(
    'open_session',
    { title: 'webhook delivery', body: 'does chat get it too?', team: 'ship' },
    bob,
  );
  const sessionId = opened.data?.sessionId ?? /"sessionId":"([^"]+)"/.exec(opened.text)?.[1];
  expect(sessionId).toBeTruthy();
  const replied = await call(
    'post_message',
    { session_id: sessionId, body: 'yes, it should arrive in chat', kind: 'answer' },
    alice,
  );
  expect(replied.isError, replied.text).toBe(false);

  const delivered = await flushNotificationsOnce(srv.db, env);
  expect(delivered).toBe(1);
  expect(received).toHaveLength(1);
  const line = JSON.stringify(received[0]);
  expect(line).toContain('webhook delivery');
  expect(line).toContain('/app/sessions/');

  // Turning the switch off silences both routes, not just the email.
  await form(`${srv.url}/app/notifications`, { session_resolved: 'on' }, bobCookie);
  received.length = 0;
  await call('post_message', { session_id: sessionId, body: 'and again', kind: 'answer' }, alice);
  expect(await flushNotificationsOnce(srv.db, env)).toBe(0);
  expect(received).toHaveLength(0);

  // Removing it leaves the switches alone.
  const removed = await form(
    `${srv.url}/app/notifications/webhook`,
    { action: 'remove' },
    bobCookie,
  );
  expect(removed.headers.get('location')).toContain('ok=');
  const after = await (await fetch(`${srv.url}/app/notifications`, { headers: bobCookie })).text();
  expect(after).not.toContain(receiverUrl);
});
