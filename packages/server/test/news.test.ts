import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  dueForCheck,
  handoffKey,
  rememberAnnounced,
  renderNews,
  unseen,
  type News,
} from '../../cli/src/news';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

/**
 * Work reaching the agent without anybody asking.
 *
 * The lifecycle hook fires immediately before the agent reads the human's next
 * message and whatever it prints becomes context — the one moment in a coding
 * agent's loop where an outside system can put something in front of it. This
 * covers the endpoint the hook reads and the rules that keep it from becoming
 * noise on the human's critical path.
 */

let srv: StartedServer;
let dataDir: string;
let alice = '';
let bob = '';

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
  const json = (await res.json()) as { result?: { content?: { text: string }[] } };
  const text = json.result?.content?.[0]?.text ?? '';
  try {
    return { text, data: JSON.parse(text) };
  } catch {
    return { text, data: null };
  }
}

const news = (tok: string) =>
  fetch(`${srv.url}/api/agent/news`, { headers: { authorization: `Bearer ${tok}` } });

async function tokenFor(cookie: Record<string, string>, name: string) {
  const res = await fetch(`${srv.url}/app/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...cookie },
    body: new URLSearchParams({ name }),
  });
  const tok = /stma_[0-9a-f]{40}/.exec(await res.text())?.[0] ?? '';
  expect(tok).toBeTruthy();
  return tok;
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-news-'));
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
  a.store(await form(`${srv.url}/auth/dev`, { username: 'newsy' }));
  await form(`${srv.url}/app/teams`, { name: 'News' }, a.header());
  alice = await tokenFor(a.header(), 'newsy-laptop');
  bob = await tokenFor(a.header(), 'newsy-desktop');
});

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

it('says nothing when nothing is waiting', async () => {
  const res = await news(alice);
  expect(res.status).toBe(200);
  const body = (await res.json()) as News;
  expect(body.pendingHandoffs).toEqual([]);
  expect(body.unreadSessions).toBe(0);
  // Nothing to say means nothing injected — the hook must not print a heading
  // over an empty list on every prompt.
  expect(renderNews(body.pendingHandoffs, body.unreadSessions)).toBeUndefined();
});

it('carries a handoff with the two calls that pick it up', async () => {
  await call(
    'start_run',
    {
      team: 'news',
      project: 'payments',
      task: 'NEWS-1',
      branch: 'feat/news',
      agent: 'laptop-codex',
      scope: [{ type: 'migration', key: 'refunds' }],
    },
    alice,
  );
  const handed = await call(
    'handoff_work',
    {
      branch: 'feat/news',
      summary: 'Out of usage. Ledger done, the read model is not.',
      next_steps: ['Update the read model', 'Add a partial-refund test'],
      reason: 'usage_limit',
      via: 'laptop-codex',
    },
    alice,
  );
  expect(handed.data.sessionId).toBeTruthy();

  // Read from the OTHER machine's token: same person, different origin.
  const body = (await (await news(bob)).json()) as News;
  expect(body.pendingHandoffs).toHaveLength(1);
  const waiting = body.pendingHandoffs[0]!;
  expect(waiting.title).toContain('NEWS-1');
  expect(waiting.resume?.branch).toBe('feat/news');
  expect(waiting.resume?.checkout).toContain('git checkout feat/news');
  expect(waiting.resume?.reclaim?.tool).toBe('start_run');

  const text = renderNews(body.pendingHandoffs, body.unreadSessions)!;
  expect(text).toContain('work is waiting');
  expect(text).toContain('feat/news');
  expect(text).toContain('Update the read model');
  expect(text).toContain('git checkout feat/news');
  expect(text).toContain('start_run');
  // The offer stops at offering. Deciding to move somebody off what they are
  // doing is not the agent's call.
  expect(text).toContain('ask before acting');
  expect(text).toContain('do not check out a branch or start a run unprompted');
});

it('does not read a brief back to the machine that wrote it', async () => {
  // The laptop wrote this handoff. Telling its own agent about it on the next
  // prompt would be the product talking to itself.
  const body = (await (await news(alice)).json()) as News;
  const own = body.pendingHandoffs.find((h) => h.title.includes('NEWS-1'));
  expect(own, 'the writing machine must not be told about its own brief').toBeUndefined();
});

it('announces a handoff once, not on every prompt', () => {
  const handoff = {
    sessionId: 's1',
    team: 'news',
    title: 'Handoff: NEWS-1',
    from: 'newsy',
    at: '2026-08-25T10:00:00.000Z',
    resume: null,
  };
  const payload: News = { checkedAt: '', pendingHandoffs: [handoff], unreadSessions: 0 };
  expect(unseen(payload, {})).toHaveLength(1);
  const state = { announced: rememberAnnounced({}, [handoff]) };
  expect(unseen(payload, state)).toHaveLength(0);
  // A second handoff in the same session is a new event, not a repeat.
  const later = { ...handoff, at: '2026-08-25T12:00:00.000Z' };
  expect(unseen({ ...payload, pendingHandoffs: [later] }, state)).toHaveLength(1);
  expect(handoffKey(handoff)).not.toBe(handoffKey(later));
});

it('keeps the announced list from growing without bound', () => {
  let announced: string[] = [];
  for (let i = 0; i < 120; i++) {
    announced = rememberAnnounced({ announced }, [
      { sessionId: `s${i}`, team: null, title: 't', from: null, at: '2026-08-25', resume: null },
    ]);
  }
  // It lives in .stma/local.json, which is read on every single prompt.
  expect(announced.length).toBeLessThanOrEqual(50);
});

it('asks the server at most once a minute', () => {
  const now = Date.parse('2026-08-25T10:00:00.000Z');
  expect(dueForCheck({}, now)).toBe(true);
  expect(dueForCheck({ lastCheckedAt: '2026-08-25T09:59:30.000Z' }, now)).toBe(false);
  expect(dueForCheck({ lastCheckedAt: '2026-08-25T09:58:00.000Z' }, now)).toBe(true);
  // A corrupt timestamp must not wedge the check off forever.
  expect(dueForCheck({ lastCheckedAt: 'not a date' }, now)).toBe(true);
});

it('needs a token, like every other agent-facing route', async () => {
  expect((await fetch(`${srv.url}/api/agent/news`)).status).toBe(401);
});
