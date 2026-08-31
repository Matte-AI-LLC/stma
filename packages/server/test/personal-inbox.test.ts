import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

/**
 * One human, two machines — the *inbox* half.
 *
 * `personal-fleet.test.ts` covers the other half: snapshots keyed by
 * (team, user, device), so two of your own machines can be diffed. This file is
 * about which of them gets told when something happens.
 *
 * The 2026-08-25 agent pass measured the gap this file guards: with everything
 * else held still and only the author changed, a teammate's message produced
 * `unread: 1` and the user's own message produced `unread: 0` — so a session
 * opened by your desktop's agent was invisible to your laptop's. The fix is to
 * ask where a message came from rather than who wrote it, and a token is one
 * per machine, so the question is answerable.
 *
 * Its own file because `/auth/*` is IP-limited at 30 requests a minute and the
 * e2e suite already spends that budget.
 */

let srv: StartedServer;
let dataDir: string;
/** Alice's two machines, and a real teammate as the control. */
let desktop = '';
let laptop = '';
let bob = '';
let aliceCookie: Record<string, string> = {};
let bobCookie: Record<string, string> = {};

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
    /* prose answer */
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

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-inbox-'));
  srv = await startServer(
    loadEnv({
      port: 0,
      host: 'localhost',
      nodeEnv: 'test',
      devMode: true,
      databaseUrl: undefined,
      pgliteDir: dataDir,
    }),
  );

  const a = jar();
  a.store(await form(`${srv.url}/auth/dev`, { username: 'alice' }));
  aliceCookie = a.header();
  await form(`${srv.url}/app/teams`, { name: 'Solo' }, aliceCookie);
  desktop = await tokenFor(aliceCookie, 'alice-desktop');
  laptop = await tokenFor(aliceCookie, 'alice-laptop');

  await form(`${srv.url}/app/teams/solo/invites`, {}, aliceCookie);
  const teamPage = await (await fetch(`${srv.url}/app/teams/solo?tab=people`, { headers: aliceCookie })).text();
  const code = /\/join\/([A-Za-z0-9_-]+)/.exec(teamPage)?.[1] ?? '';
  expect(code, 'invite code').toBeTruthy();
  const b = jar();
  b.store(await form(`${srv.url}/auth/dev`, { username: 'bob' }));
  bobCookie = b.header();
  await form(`${srv.url}/join/${code}`, {}, bobCookie);
  bob = await tokenFor(bobCookie, 'bob-desktop');
});

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

it('tells the other machine, not the one that wrote it', async () => {
  const opened = await call(
    'open_session',
    { title: 'Rotate the staging key before Friday', body: 'Starting on this now.', via: 'codex' },
    desktop,
  );
  expect(opened.isError, opened.text).toBe(false);
  const sessionId = opened.data.sessionId as string;

  const here = await call('inbox', {}, desktop);
  expect(
    here.data.unreadSessions.map((s: any) => s.sessionId),
    'the machine that wrote it is not told about it',
  ).not.toContain(sessionId);

  const there = await call('inbox', {}, laptop);
  const seen = there.data.unreadSessions.find((s: any) => s.sessionId === sessionId);
  expect(seen, 'the other machine hears about it').toBeTruthy();
  expect(seen.unread).toBe(1);

  // The control the original measurement lacked: a teammate and another machine
  // of your own now get the same answer, which is the whole point.
  const teammate = await call('inbox', {}, bob);
  expect(teammate.data.unreadSessions.map((s: any) => s.sessionId)).toContain(sessionId);
});

it('counts your own fleet as unread in the browser, and clears it when you read it', async () => {
  const list = await fetch(`${srv.url}/app/sessions`, { headers: aliceCookie });
  const html = await list.text();
  expect(html).toContain('Rotate the staging key');
  // A browser is an origin with no token, so what her own agent wrote is news
  // to her here. Before this it was silently discounted and the page said none.
  expect(html).toContain('1 unread');

  const sessionId = /\/app\/sessions\/([0-9a-f-]{36})/.exec(html)?.[1] ?? '';
  expect(sessionId).toBeTruthy();
  await fetch(`${srv.url}/app/sessions/${sessionId}`, { headers: aliceCookie });
  const after = await (await fetch(`${srv.url}/app/sessions`, { headers: aliceCookie })).text();
  expect(after).not.toContain('1 unread');
});

it('hands over a runbook with no code in it', async () => {
  const done = await call(
    'handoff_work',
    {
      summary: 'Decided the OIDC cutover order. No code yet — this is the plan to carry out.',
      next_steps: [
        'Cut a v* tag and watch deploy-azure pass through the production environment',
        'Delete the AZURE_CREDENTIALS repository secret',
        'Delete the client secret on the stma-github-deploy app',
      ],
      reason: 'end_of_day',
      via: 'claude-code',
    },
    desktop,
  );
  expect(done.isError, done.text).toBe(false);
  expect(done.data.branch, 'a brief carries no branch').toBeNull();
  expect(done.data.steps).toBe(3);
  // Nothing was claimed, so there is nothing to re-claim: a start_run call with
  // only a team name in it is noise, not a handoff.
  expect(done.data.pickUpWith).toBeNull();

  const thread = await call('get_session', { session_id: done.data.sessionId }, laptop);
  const brief = thread.data.messages.find((m: any) => m.kind === 'handoff');
  expect(brief.resume.steps).toHaveLength(3);
  expect(brief.resume.checkout, 'nothing to check out').toBeNull();
  expect(brief.resume.reclaim, 'nothing to re-claim').toBeNull();
  expect(brief.body).toContain('No branch — this is a brief, not code.');
  expect(thread.data.notice).toContain('steps it left');
});

it('offers the brief to the other machine and says which one wrote it', async () => {
  const there = await call('inbox', {}, laptop);
  const waiting = there.data.pendingHandoffs.find((h: any) => h.title.includes('OIDC cutover'));
  expect(waiting, 'the laptop sees work waiting').toBeTruthy();
  expect(waiting.yours, 'written by her own account').toBe(true);
  expect(waiting.fromThisMachine, 'but not by this machine').toBe(false);
  expect(waiting.steps).toBe(3);
  expect(waiting.branch).toBeNull();

  // The machine that wrote it still sees it — an offer nobody took is still
  // open, and on a one-machine account this is the only place it survives — but
  // it is labelled, because "yours to finish" and "somebody is waiting" differ.
  const here = await call('inbox', {}, desktop);
  const own = here.data.pendingHandoffs.find((h: any) => h.title.includes('OIDC cutover'));
  expect(own.fromThisMachine).toBe(true);

  // Taking it clears the queue for everyone, with no state column to disagree.
  await call(
    'post_message',
    { session_id: waiting.sessionId, body: 'Picking this up on the laptop.', via: 'claude-code' },
    laptop,
  );
  for (const [who, tok] of [
    ['laptop', laptop],
    ['desktop', desktop],
  ] as const) {
    const after = await call('inbox', {}, tok);
    expect(
      after.data.pendingHandoffs.map((h: any) => h.title),
      `${who} no longer sees it queued`,
    ).not.toContain(waiting.title);
  }
});

/**
 * Kept last on purpose: it gives Bob a second team, which changes the answer
 * every other test in this file depends on.
 */
it('names the failure instead of handing the argument back', async () => {
  const wrong = await call('announce', { body: 'Staging is back up.', team: 'nope' }, desktop);
  expect(wrong.isError).toBe(true);
  expect(wrong.text).toContain('not a member of a team called "nope"');
  expect(wrong.text).toContain('solo');
  // The old wording told a caller that had just sent `team` to send `team`, and
  // an agent reads that literally and retries with the same value.
  expect(wrong.text).not.toContain('Specify the team parameter');

  await form(`${srv.url}/app/teams`, { name: 'Second' }, bobCookie);
  const ambiguous = await call('announce', { body: 'Staging is back up.' }, bob);
  expect(ambiguous.isError).toBe(true);
  expect(ambiguous.text).toContain('name one with the team parameter');
  expect(ambiguous.text).toContain('solo');
  expect(ambiguous.text).toContain('second');
});
