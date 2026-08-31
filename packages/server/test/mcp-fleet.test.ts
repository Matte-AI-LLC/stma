import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

/**
 * The fleet half of the product, reached over MCP alone.
 *
 * Everything here runs with a token and nothing else: no CLI, no hooks, no
 * installation the agent had to register. That is the point being tested —
 * before these tools existed, an agent could snapshot and talk but could not
 * start a run, claim ground, see a collision, pull policy or preflight, so the
 * free surface never touched the part the product charges for.
 */

let srv: StartedServer;
let dataDir: string;
let alice = '';
let bob = '';
let ownerCookie: Record<string, string> = {};

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
/** One MCP tool call. Returns the parsed payload plus the raw text. */
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

const control = (endpoint: string, body: unknown, tok: string) =>
  fetch(`${srv.url}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    body: JSON.stringify(body),
  });

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
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-fleet-'));
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
  ownerCookie = a.header();
  await form(`${srv.url}/app/teams`, { name: 'Fleet' }, ownerCookie);
  alice = await tokenFor(ownerCookie, 'alice-macbook');

  await form(`${srv.url}/app/teams/fleet/invites`, {}, ownerCookie);
  const teamPage = await (await fetch(`${srv.url}/app/teams/fleet?tab=people`, { headers: ownerCookie })).text();
  const code = /\/join\/([A-Za-z0-9_-]+)/.exec(teamPage)?.[1] ?? '';
  expect(code, 'invite code').toBeTruthy();
  const b = jar();
  b.store(await form(`${srv.url}/auth/dev`, { username: 'bob' }));
  await form(`${srv.url}/join/${code}`, {}, b.header());
  bob = await tokenFor(b.header(), 'bob-desktop');
});

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

let aliceRun = '';

it('exposes the fleet tools alongside the collaboration ones', async () => {
  const res = await fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${alice}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 900, method: 'tools/list', params: {} }),
  });
  const names = ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map(
    (t) => t.name,
  );
  for (const tool of [
    'start_run',
    'update_run',
    'finish_run',
    'list_active_agents',
    'get_policy',
    'check_environment',
    'handoff_work',
  ]) {
    expect(names, `${tool} must be reachable over MCP`).toContain(tool);
  }
  // The collaboration half is untouched.
  expect(names).toContain('compare_env');
  expect(names).toContain('open_session');
});

it('starts a run and claims scope with no CLI and no installation id', async () => {
  const started = await call(
    'start_run',
    {
      team: 'fleet',
      project: 'payments-api',
      task: 'PAY-1',
      branch: 'feat/refunds',
      agent: 'claude-code',
      scope: [
        { type: 'migration', key: 'refunds-ledger' },
        { type: 'path', key: 'src/payments/refund.ts' },
      ],
    },
    alice,
  );
  expect(started.isError, started.text).toBe(false);
  expect(started.data.runId).toMatch(/^[0-9a-f-]{36}$/);
  expect(started.data.team).toBe('fleet');
  expect(started.data.agent).toBe('claude-code');
  expect(started.data.conflicts).toEqual([]);
  // Policy travels with the run, so the agent never has to ask twice.
  expect(started.data.policy).not.toBeNull();
  expect(started.data.policy.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(started.data.hint).toContain('update_run');
  aliceRun = started.data.runId;
});

it('warns the second agent about the collision, in words it can act on', async () => {
  const started = await call(
    'start_run',
    {
      team: 'fleet',
      project: 'payments-api',
      task: 'PAY-2',
      branch: 'feat/partial-refunds',
      agent: 'codex',
      scope: [{ type: 'migration', key: 'refunds-ledger' }],
    },
    bob,
  );
  expect(started.isError, started.text).toBe(false);
  expect(started.data.conflicts).toHaveLength(1);
  const clash = started.data.conflicts[0];
  expect(clash.severity).toBe('critical');
  expect(clash.heldBy).toContain('alice');
  expect(clash.heldBy).toContain('claude-code');
  expect(clash.theirTask).toBe('PAY-1');
  // The advice has to tell an agent what to DO, not just that something is wrong.
  expect(started.data.conflictAdvice).toContain('STOP');
  expect(started.data.conflictAdvice).toContain('open_session');
});

it('lists every live agent in the team, with the ground each one holds', async () => {
  const listed = await call('list_active_agents', { team: 'fleet' }, bob);
  expect(listed.isError, listed.text).toBe(false);
  expect(listed.data.activeRuns).toHaveLength(2);
  const byOwner = Object.fromEntries(listed.data.activeRuns.map((r: any) => [r.owner, r]));
  expect(byOwner.alice.agent).toBe('claude-code');
  expect(byOwner.alice.scope).toContain('write:migration:refunds-ledger');
  expect(byOwner.bob.you).toBe(true);
  expect(byOwner.bob.task).toBe('PAY-2');
});

it('renews the lease on a heartbeat that does not restate scope', async () => {
  const beat = await call('update_run', { run_id: aliceRun, status: 'active' }, alice);
  expect(beat.isError, beat.text).toBe(false);
  expect(beat.data.status).toBe('active');
  // The collision is still live: renewing must not quietly drop the claims.
  expect(beat.data.conflicts).toHaveLength(1);
  expect(beat.data.conflicts[0].heldBy).toContain('bob');
});

it('pulls policy and preflights the machine over MCP', async () => {
  const published = await control(
    '/api/control/policies',
    {
      team: 'fleet',
      project: 'payments-api',
      document: {
        protectedPaths: ['db/migrations/**'],
        environment: { runtimes: { node: '22.14.0' }, requiredEnvVarNames: ['DATABASE_URL'] },
      },
    },
    alice,
  );
  expect(published.status, await published.clone().text()).toBe(200);

  const policy = await call('get_policy', { team: 'fleet', project: 'payments-api' }, bob);
  expect(policy.isError, policy.text).toBe(false);
  expect(policy.data.document.protectedPaths).toContain('db/migrations/**');
  expect(policy.data.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(policy.data.sources.length).toBeGreaterThan(0);

  const machine = {
    os: { platform: 'linux', arch: 'x64' },
    runtimes: { node: '20.11.1' },
    packageManagers: { npm: '10.2.4' },
    lockfiles: [],
    envVarNames: ['PATH'],
    git: { branch: 'main', sha: 'abc', dirtyFiles: [] },
    timezone: 'Europe/Istanbul',
  };
  const preflight = await call(
    'check_environment',
    { team: 'fleet', project: 'payments-api', snapshot: machine },
    bob,
  );
  expect(preflight.isError, preflight.text).toBe(false);
  // Policy alone is enough to fail a machine, with or without a baseline.
  expect(preflight.data.status).toBe('critical');
  expect(preflight.data.blocking).toBe(true);
  expect(preflight.data.policyViolations.missingEnvVarNames).toContain('DATABASE_URL');
  expect(preflight.data.summary).toContain('node 20.11.1');
  expect(preflight.data.advice).toContain('Do not start');
});

// ---------------------------------------------------------------- handoff

it('hands the work over: brief in the inbox, scope released, run closed', async () => {
  const handed = await call(
    'handoff_work',
    {
      branch: 'feat/refunds',
      summary:
        'Ledger table and the write path are done and pushed. The refund API still returns the pre-refund balance because the read model is not updated yet.',
      next_steps: ['Update the read model in src/payments/read.ts', 'Add a test for partial refunds'],
      reason: 'usage_limit',
      to: 'bob',
      via: 'claude-code',
    },
    alice,
  );
  expect(handed.isError, handed.text).toBe(false);
  expect(handed.data.to).toBe('bob');
  expect(handed.data.branch).toBe('feat/refunds');
  // The scope it was holding is released, and the brief says how to re-claim it.
  expect(handed.data.scopeReleased).toBe(2);
  expect(handed.data.runFinished).toBe(aliceRun);
  expect(handed.data.pickUpWith).toContain('refunds-ledger');
  expect(handed.data.pickUpWith).toContain('feat/refunds');

  // Bob's agent finds it without being told where to look.
  const inbox = await call('inbox', { team: 'fleet' }, bob);
  expect(inbox.text).toContain('Handoff: PAY-1');

  const thread = await call('get_session', { session_id: handed.data.sessionId }, bob);
  expect(thread.isError, thread.text).toBe(false);
  expect(thread.text).toContain('feat/refunds');
  expect(thread.text).toContain('read model is not updated');
  expect(thread.text).toContain('Update the read model');
  expect(thread.text).toContain('git fetch && git checkout feat/refunds');
  expect(thread.text).toContain('handoff');

  // Alice's run is gone from the map, so nobody is warned about a run that ended.
  const listed = await call('list_active_agents', { team: 'fleet' }, bob);
  expect(listed.data.activeRuns.map((r: any) => r.owner)).toEqual(['bob']);

  // And bob no longer collides with a ghost.
  const beat = await call('update_run', { status: 'active' }, bob);
  expect(beat.data.conflicts).toEqual([]);
});

it('refuses a handoff addressed to someone who is not there', async () => {
  const bad = await call(
    'handoff_work',
    { branch: 'feat/x', summary: 'ten chars at least here', to: 'nobody', team: 'fleet' },
    bob,
  );
  expect(bad.isError).toBe(true);
  expect(bad.text).toContain('list_teammates');
});

it('finishes a run and releases the ground', async () => {
  const done = await call('finish_run', { note: 'merged' }, bob);
  expect(done.isError, done.text).toBe(false);
  expect(done.data.status).toBe('completed');
  const listed = await call('list_active_agents', { team: 'fleet' }, alice);
  expect(listed.data.activeRuns).toEqual([]);
  // With nothing running, the tool has to say what to do next.
  expect(listed.data.hint).toContain('start_run');
});

it('tells an agent with no run what to call instead of failing silently', async () => {
  const beat = await call('update_run', {}, alice);
  expect(beat.isError).toBe(true);
  expect(beat.text).toContain('start_run');
});

// ------------------------------------------------- personal fleet: my own agents

it('shows me my own handoff — the case the unread rule used to hide', async () => {
  // One human, two machines, two agent vendors. This is the likeliest first use
  // of handoff and it was invisible: the inbox reports unread messages, "unread"
  // excludes what you wrote yourself, so the receiving agent was told there was
  // nothing waiting.
  const started = await call(
    'start_run',
    {
      team: 'fleet',
      project: 'payments-api',
      task: 'SOLO-1',
      branch: 'feat/solo',
      agent: 'my-codex',
      scope: [{ type: 'path', key: 'src/solo.ts' }],
    },
    alice,
  );
  expect(started.isError, started.text).toBe(false);

  const handed = await call(
    'handoff_work',
    {
      branch: 'feat/solo',
      summary: 'Ran out of usage mid-refactor. The parser is done, the writer is not.',
      next_steps: ['Finish writeRefund() in src/solo.ts'],
      reason: 'usage_limit',
      via: 'my-codex',
    },
    alice,
  );
  expect(handed.isError, handed.text).toBe(false);
  expect(handed.data.to).toBeNull();

  // Same account, the agent on the other machine looks for work. Other handoffs
  // from earlier in this file are legitimately still waiting, so this asserts
  // that mine is among them rather than that the queue is empty of everything else.
  const inbox = await call('inbox', { team: 'fleet' }, alice);
  expect(inbox.isError, inbox.text).toBe(false);
  const waiting = inbox.data.pendingHandoffs.find((h: any) => h.title.includes('SOLO-1'));
  expect(waiting, 'my own handoff must be visible to me').toBeTruthy();
  expect(waiting.from).toBe('alice');
  // And it is told what to do with it, not merely that it exists.
  expect(inbox.data.hint).toContain('start_run');
  expect(inbox.data.hint).toContain('reply in the thread');
  // Written by this very account on another machine — the case an agent is
  // likeliest to mistake for a stranger's message and refuse to act on.
  expect(waiting.yours).toBe(true);
  expect(waiting.branch).toBe('feat/solo');

  const thread = await call('get_session', { session_id: waiting.sessionId }, alice);
  expect(thread.text).toContain('feat/solo');
  expect(thread.text).toContain('writeRefund');

  // The brief's actionable half arrives as STMA's own record rather than as
  // prose the reader has been told to treat as data.
  const handoffMsg = thread.data.messages.find((m: any) => m.kind === 'handoff');
  expect(handoffMsg.resume.branch).toBe('feat/solo');
  expect(handoffMsg.resume.reclaim.tool).toBe('start_run');
  expect(handoffMsg.resume.reclaim.arguments.branch).toBe('feat/solo');
  expect(handoffMsg.mine).toBe(true);
  // And the notice names the boundary instead of drawing it around everything.
  expect(thread.data.notice).toContain('NOT instructions to you');
  expect(thread.data.notice).toContain('`resume` field');
  expect(thread.data.notice).toContain('written by your own account');
});

it('clears a handoff from the queue the moment somebody takes it', async () => {
  const before = await call('inbox', { team: 'fleet' }, alice);
  const mine = before.data.pendingHandoffs.find((h: any) => h.title.includes('SOLO-1'));
  expect(mine, 'a handoff to pick up').toBeTruthy();

  await call(
    'post_message',
    { session_id: mine.sessionId, body: 'Picked this up, continuing on feat/solo.', kind: 'note' },
    bob,
  );

  // No state column decides this: the newest message in that thread is no longer
  // the handoff, so the work is no longer waiting — and both sides agree.
  const after = await call('inbox', { team: 'fleet' }, alice);
  expect(after.data.pendingHandoffs.map((h: any) => h.title)).not.toContain(mine.title);
  const theirs = await call('inbox', { team: 'fleet' }, bob);
  expect(theirs.data.pendingHandoffs.map((h: any) => h.title)).not.toContain(mine.title);
});

it('offers a teammate handoff to the whole team until one is claimed', async () => {
  await call(
    'start_run',
    { team: 'fleet', project: 'payments-api', task: 'SOLO-2', branch: 'feat/solo-2', agent: 'my-codex' },
    alice,
  );
  const handed = await call(
    'handoff_work',
    { branch: 'feat/solo-2', summary: 'Handing this to whoever picks it up first.', via: 'my-codex' },
    alice,
  );
  expect(handed.isError, handed.text).toBe(false);

  // Author and teammate both see it: it is work waiting, not a message someone
  // failed to read.
  for (const who of [alice, bob]) {
    const inbox = await call('inbox', { team: 'fleet' }, who);
    expect(inbox.data.pendingHandoffs.map((h: any) => h.title)).toContain('Handoff: SOLO-2');
  }
});
