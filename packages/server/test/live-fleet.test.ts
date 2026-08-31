import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

/**
 * The three things the fleet learned after watching what agent development
 * environments made normal:
 *
 *  - a run can say how much of its own vendor allowance is left, and gets told
 *    to hand the work over *before* it stops rather than after;
 *  - fanning one task across several worktrees is a fan-out, not N collisions;
 *  - the console hears about changes instead of reloading on a timer.
 */

let srv: StartedServer;
let dataDir: string;
let alice = '';
let bob = '';
let aliceCookie: Record<string, string> = {};

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
    /* some tools answer in prose */
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
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-live-'));
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
  await form(`${srv.url}/app/teams`, { name: 'Live' }, aliceCookie);
  alice = await tokenFor(aliceCookie, 'alice-macbook');

  await form(`${srv.url}/app/teams/live/invites`, {}, aliceCookie);
  const teamPage = await (await fetch(`${srv.url}/app/teams/live?tab=people`, { headers: aliceCookie })).text();
  const code = /\/join\/([A-Za-z0-9_-]+)/.exec(teamPage)?.[1] ?? '';
  const b = jar();
  b.store(await form(`${srv.url}/auth/dev`, { username: 'bob' }));
  await form(`${srv.url}/join/${code}`, {}, b.header());
  bob = await tokenFor(b.header(), 'bob-desktop');
});

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ------------------------------------------------------------ vendor quota

it('tells a run to hand off before its allowance runs out, not after', async () => {
  const started = await call(
    'start_run',
    {
      team: 'live',
      project: 'payments-api',
      task: 'PAY-9',
      branch: 'feat/quota',
      agent: 'claude-code',
      role: 'implementer',
      scope: [{ type: 'path', key: 'src/pay/quota.ts' }],
    },
    alice,
  );
  expect(started.isError).toBe(false);
  const runId = started.data.runId as string;
  expect(started.data.role).toBe('implementer');
  // The tool has to say the channel exists, or no agent will ever use it.
  expect(started.data.usageHint).toMatch(/usage/i);

  // Plenty left: no advice, nothing on the map. "measured" throughout — this is
  // a client that can actually read its window; the guessing case is its own test.
  const easy = await call(
    'update_run',
    { run_id: runId, usage: { used_pct: 20, source: 'measured' } },
    alice,
  );
  expect(easy.data.quota.state).toBe('ok');
  expect(easy.data.quotaAdvice).toBeUndefined();

  // Into the warning band: plan a handoff.
  const warn = await call(
    'update_run',
    { run_id: runId, usage: { used_pct: 80, label: 'claude 5h window', source: 'measured' } },
    alice,
  );
  expect(warn.data.quota.state).toBe('warning');
  expect(warn.data.quotaAdvice).toMatch(/handoff_work/);
  expect(warn.data.handoffCall.branch).toBe('feat/quota');
  expect(warn.data.handoffCall.reason).toBe('usage_limit');

  // Critical: make one now, and the call is pre-filled with this run.
  const crit = await call(
    'update_run',
    { run_id: runId, usage: { used_pct: 96, source: 'measured' } },
    alice,
  );
  expect(crit.data.quota.state).toBe('critical');
  expect(crit.data.quota.usedPct).toBe(96);
  expect(crit.data.quota.acted).toBe(true);
  expect(crit.data.quotaAdvice).toMatch(/now/i);
  expect(crit.data.handoffCall.run_id).toBe(runId);

  // A teammate's agent can see who is about to stop — and whether the number is
  // something the other client read or something it guessed.
  const seen = await call('list_active_agents', { team: 'live' }, bob);
  const mine = (seen.data.activeRuns as any[]).find((r) => r.runId === runId);
  expect(mine.quota).toEqual({ state: 'critical', usedPct: 96, source: 'measured' });
  expect(mine.role).toBe('implementer');

  // And the map says it in the place a human looks.
  const page = await (await fetch(`${srv.url}/app/agents`, { headers: aliceCookie })).text();
  expect(page).toContain('out of quota');
  expect(page).toContain('96% used');

  // The feed carries the escalation once, not once per heartbeat.
  await call('update_run', { run_id: runId, usage: { used_pct: 97, source: 'measured' } }, alice);
  const feed = await (
    await fetch(`${srv.url}/app/teams/live/activity`, { headers: aliceCookie })
  ).text();
  expect(feed.match(/quota_warning/g)?.length ?? 0).toBe(2); // one warning, one critical
  await call('finish_run', { run_id: runId }, alice);
});

// --------------------------------------------------------- parallel attempts

it('treats one person\'s parallel attempts as a fan-out, not a collision', async () => {
  const attempt = (n: number) =>
    call(
      'start_run',
      {
        team: 'live',
        project: 'storefront',
        task: 'SHOP-3',
        branch: `try/${n}`,
        worktree: `/tmp/shop-${n}`,
        attempt_group: 'SHOP-3-fanout',
        agent: `claude-code-${n}`,
        scope: [{ type: 'path', key: 'src/cart/checkout.ts' }],
      },
      alice,
    );

  const first = await attempt(1);
  expect(first.data.conflicts).toHaveLength(0);
  const second = await attempt(2);
  // Same file, same task, same person, on purpose: not a collision.
  expect(second.data.conflicts).toHaveLength(0);
  expect(second.data.attemptGroup).toBe('SHOP-3-fanout');
  const third = await attempt(3);
  expect(third.data.conflicts).toHaveLength(0);

  // Somebody else touching that file is still a collision — the rule narrows
  // the radar, it does not switch it off.
  const other = await call(
    'start_run',
    {
      team: 'live',
      project: 'storefront',
      task: 'SHOP-9',
      agent: 'bob-cursor',
      scope: [{ type: 'path', key: 'src/cart/checkout.ts' }],
    },
    bob,
  );
  expect((other.data.conflicts as any[]).length).toBeGreaterThan(0);

  const page = await (await fetch(`${srv.url}/app/agents`, { headers: aliceCookie })).text();
  expect(page).toContain('attempt 1 of 3');
  expect(page).toContain('attempt 3 of 3');

  for (const run of [first, second, third]) {
    await call('finish_run', { run_id: run.data.runId }, alice);
  }
  await call('finish_run', { run_id: other.data.runId }, bob);
});

it('still warns when one person runs two agents in the SAME worktree', async () => {
  const one = await call(
    'start_run',
    {
      team: 'live',
      project: 'storefront',
      task: 'SHOP-7',
      worktree: '/tmp/shop-main',
      agent: 'a1',
      scope: [{ type: 'migration', key: 'orders-table' }],
    },
    alice,
  );
  const two = await call(
    'start_run',
    {
      team: 'live',
      project: 'storefront',
      task: 'SHOP-7',
      worktree: '/tmp/shop-main',
      agent: 'a2',
      scope: [{ type: 'migration', key: 'orders-table' }],
    },
    alice,
  );
  expect((two.data.conflicts as any[]).length).toBeGreaterThan(0);
  expect(two.data.conflicts[0].severity).toBe('critical');
  await call('finish_run', { run_id: one.data.runId }, alice);
  await call('finish_run', { run_id: two.data.runId }, alice);
});

// ------------------------------------------------------------- live channel

it('pushes a change down the live stream instead of waiting for the next poll', async () => {
  const controller = new AbortController();
  const res = await fetch(`${srv.url}/app/stream`, {
    headers: { accept: 'text/event-stream', ...aliceCookie },
    signal: controller.signal,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const readUntil = async (marker: string, budgetMs = 8000) => {
    const deadline = Date.now() + budgetMs;
    let buffer = '';
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes(marker)) return buffer;
    }
    return buffer;
  };

  expect(await readUntil('event: ready')).toContain('event: ready');

  // Something a teammate's agent does, on a team this browser belongs to.
  const run = await call(
    'start_run',
    { team: 'live', project: 'payments-api', task: 'PAY-live', agent: 'bob-cursor' },
    bob,
  );
  const pushed = await readUntil('event: change');
  expect(pushed).toContain('event: change');
  expect(pushed).toMatch(/"kinds":\[[^\]]*"(activity|claims|run)"/);

  controller.abort();
  await reader.cancel().catch(() => {});
  await call('finish_run', { run_id: run.data.runId }, bob);
});

it('refuses the live stream to a signed-out browser', async () => {
  const res = await fetch(`${srv.url}/app/stream`, { headers: { accept: 'text/event-stream' } });
  expect(res.status).toBe(401);
  await res.text();
});
