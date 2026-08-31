import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

/**
 * What a run is told before it touches anything, and after the ground moves.
 *
 * Five checks that all answer the same question from different angles: is it
 * still safe to keep going? They are asserted end to end because each one is
 * assembled from data several tables away, and a rule that is right in
 * isolation can still never reach the agent.
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
  const json = (await res.json()) as {
    result?: { content?: { text: string }[]; isError?: boolean };
    error?: { message?: string };
  };
  const text = json.result?.content?.[0]?.text ?? json.error?.message ?? '';
  const isError = json.result?.isError === true || json.error !== undefined;
  try {
    return { text, isError, data: JSON.parse(text) };
  } catch {
    return { text, isError, data: null };
  }
}

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
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-ready-'));
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
  a.store(await form(`${srv.url}/auth/dev`, { username: 'ready' }));
  await form(`${srv.url}/app/teams`, { name: 'Ready' }, a.header());
  alice = await tokenFor(a.header(), 'ready-a');
  bob = await tokenFor(a.header(), 'ready-b');
});

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const control = (endpoint: string, body: unknown, tok: string) =>
  fetch(`${srv.url}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    body: JSON.stringify(body),
  });

it('tells a run when its team wants a person on this ground', async () => {
  const published = await control(
    '/api/control/policies',
    {
      team: 'ready',
      document: {
        autonomy: { requireApprovalFor: ['migration'] },
        changeBudget: { maxScopeItems: 2, maxPaths: 1 },
      },
    },
    alice,
  );
  expect(published.status, await published.clone().text()).toBe(200);

  const started = await call(
    'start_run',
    {
      team: 'ready',
      project: 'payments',
      task: 'RDY-1',
      branch: 'feat/rdy',
      agent: 'a-codex',
      scope: [
        { type: 'migration', key: 'refunds-ledger' },
        { type: 'path', key: 'src/a.ts' },
        { type: 'path', key: 'src/b.ts' },
      ],
    },
    alice,
  );
  expect(started.isError, started.text).toBe(false);

  // Gated ground, named.
  expect(started.data.needsApproval.claims).toEqual([
    { resourceType: 'migration', resourceKey: 'refunds-ledger' },
  ]);
  expect(started.data.needsApproval.advice).toContain('get your human to confirm');

  // And the change is bigger than the team said one change should be.
  expect(started.data.overBudget.limits).toEqual([
    { limit: 'scope', declared: 3, budget: 2 },
    { limit: 'paths', declared: 2, budget: 1 },
  ]);
  expect(started.data.overBudget.advice).toContain('Split it');
});

it('says nothing about approval or budget when the team set none', async () => {
  const started = await call(
    'start_run',
    { team: 'ready', project: 'quiet', task: 'RDY-Q', agent: 'a-codex', scope: [{ type: 'path', key: 'x.ts' }] },
    bob,
  );
  expect(started.isError, started.text).toBe(false);
  // Team policy applies to every project, so the migration gate is not in play
  // here — but the budget is, and one path claim is inside it.
  expect(started.data.needsApproval).toBeUndefined();
  expect(started.data.overBudget).toBeUndefined();
  await call('finish_run', { run_id: started.data.runId }, bob);
});

it('warns the second agent that somebody is already on this issue', async () => {
  const started = await call(
    'start_run',
    { team: 'ready', project: 'payments', task: 'RDY-1', branch: 'feat/rdy-2', agent: 'b-claude' },
    bob,
  );
  expect(started.isError, started.text).toBe(false);
  const dupes = started.data.possibleDuplicates;
  expect(dupes, 'the same task key is already running').toBeTruthy();
  expect(dupes.runs[0].reason).toBe('same task key');
  expect(dupes.runs[0].owner).toBe('ready');
  expect(dupes.advice).toContain('before you start');
  await call('finish_run', { run_id: started.data.runId }, bob);
});

it('tells a run when ground it still holds moved after it started', async () => {
  // A holds a file and keeps working.
  const a = await call(
    'start_run',
    {
      team: 'ready',
      project: 'stale',
      task: 'STALE-A',
      agent: 'a-codex',
      scope: [{ type: 'path', key: 'src/payments/refund.ts' }],
    },
    alice,
  );
  expect(a.isError, a.text).toBe(false);

  // Nothing has moved yet.
  const quiet = await call('update_run', { run_id: a.data.runId }, alice);
  expect(quiet.data.staleContext).toBeUndefined();

  // B changes the same file and finishes. While B ran this was a conflict; the
  // moment B finishes the conflict disappears and the change stays.
  const b = await call(
    'start_run',
    {
      team: 'ready',
      project: 'stale',
      task: 'STALE-B',
      agent: 'b-claude',
      scope: [{ type: 'path', key: 'src/payments/refund.ts' }],
    },
    bob,
  );
  expect(b.isError, b.text).toBe(false);
  await call('finish_run', { run_id: b.data.runId }, bob);

  // A's next heartbeat is told the ground moved — which the conflict radar
  // cannot say, because it only ever compares runs that are both live.
  const beat = await call('update_run', { run_id: a.data.runId }, alice);
  expect(beat.data.conflicts, 'B is finished, so it is not a conflict any more').toEqual([]);
  expect(beat.data.staleContext, 'but its change is still under A').toBeTruthy();
  expect(beat.data.staleContext.moved[0].resource).toBe('path:src/payments/refund.ts');
  expect(beat.data.staleContext.moved[0].task).toBe('STALE-B');
  expect(beat.data.staleContext.advice).toContain('Re-read those files');
});

it('assembles the evidence pack from what was recorded, and names what was not', async () => {
  const started = await call(
    'start_run',
    {
      team: 'ready',
      project: 'evidence',
      task: 'EV-1',
      branch: 'feat/ev',
      agent: 'a-codex',
      scope: [{ type: 'path', key: 'src/ev.ts' }],
    },
    alice,
  );
  expect(started.isError, started.text).toBe(false);

  const pack = await call('get_evidence', { run_id: started.data.runId }, alice);
  expect(pack.isError, pack.text).toBe(false);
  expect(pack.data.who.owner).toBe('ready');
  expect(pack.data.run.task).toBe('EV-1');
  expect(pack.data.scope).toEqual([{ type: 'path', key: 'src/ev.ts', access: 'write' }]);

  const byKey = Object.fromEntries(pack.data.checks.map((c: any) => [c.key, c]));
  // The receipt start_run wrote is the server's expectation, not the agent's
  // answer. Unconfirmed is its own state: reading it as ok would claim a rule
  // was followed that nobody said they followed.
  expect(byKey.policy.state).toBe('unknown');
  expect(byKey.policy.detail).toContain('never answered');
  // Nobody preflighted this machine, and the pack says so rather than passing it.
  expect(byKey.environment.state).toBe('unknown');
  expect(byKey.environment.detail).toContain('No preflight');
  expect(byKey.scope.state).toBe('ok');
  expect(byKey.collisions.state).toBe('ok');
  // Still running, so the outcome is not a verdict yet.
  expect(byKey.outcome.state).toBe('unknown');
  expect(pack.data.unconfirmed).toEqual(expect.arrayContaining(['policy', 'environment', 'outcome']));
  expect(pack.data.hint).toContain('Unconfirmed is not the same as fine');

  // Confirm the policy and finish; the same pack now reads differently.
  const policy = await call('get_policy', { team: 'ready', project: 'evidence' }, alice);
  await call('update_run', { run_id: started.data.runId, policy_hash: policy.data.hash }, alice);
  await call('finish_run', { run_id: started.data.runId, status: 'completed' }, alice);

  const after = await call('get_evidence', { run_id: started.data.runId }, alice);
  const now = Object.fromEntries(after.data.checks.map((c: any) => [c.key, c]));
  expect(now.policy.state).toBe('ok');
  expect(now.outcome.state).toBe('ok');
  expect(after.data.blocking).not.toContain('policy');
});

it('keeps an evidence pack inside the team it belongs to', async () => {
  const outsiderJar = jar();
  outsiderJar.store(await form(`${srv.url}/auth/dev`, { username: 'outsider' }));
  const outsider = await tokenFor(outsiderJar.header(), 'outsider-machine');
  const mine = await call(
    'start_run',
    { team: 'ready', project: 'evidence', task: 'EV-2', agent: 'a-codex' },
    alice,
  );
  const pack = await call('get_evidence', { run_id: mine.data.runId }, outsider);
  expect(pack.isError).toBe(true);
  await call('finish_run', { run_id: mine.data.runId }, alice);
});

it('reports an overlap to the run that was overlapped, not just the one that saw it', async () => {
  // Overlap is recorded against whichever run declares its scope second. Reading
  // only a run's own events told the *overlapped* run that nobody had touched
  // its ground — a readiness pack that is confidently wrong is worse than none.
  const first = await call(
    'start_run',
    {
      team: 'ready',
      project: 'both-ways',
      task: 'BW-1',
      agent: 'a-codex',
      scope: [{ type: 'path', key: 'src/shared.ts' }],
    },
    alice,
  );
  const second = await call(
    'start_run',
    {
      team: 'ready',
      project: 'both-ways',
      task: 'BW-2',
      agent: 'b-claude',
      scope: [{ type: 'path', key: 'src/shared.ts' }],
    },
    bob,
  );
  expect(second.data.conflicts.length, 'the second run is the one that sees it').toBeGreaterThan(0);

  for (const run of [first.data.runId, second.data.runId]) {
    const pack = await call('get_evidence', { run_id: run }, alice);
    const collisions = pack.data.checks.find((c: any) => c.key === 'collisions');
    expect(collisions.state, `run ${run} must know it was overlapped`).toBe('attention');
  }

  await call('finish_run', { run_id: first.data.runId }, alice);
  await call('finish_run', { run_id: second.data.runId }, bob);
});
