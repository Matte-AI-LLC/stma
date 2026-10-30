import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { EXECUTION_CHILD_TOOLS } from '@bridge/shared';
import { executionJobs, handoffs, projects, teams } from '../src/db/schema';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';
import { build } from 'tsup';
import { superviseWorker, type WorkerRequest } from '../../cli/src/worker';
import { launchWorkerRuntime } from '../../cli/src/workerRuntime';
import { canonicalCheckout, checkoutFingerprint, readWorkerJson, signalWorker, type WorkerConfig } from '../../cli/src/workerState';

// The public connector creates work while an outbound-only worker claims it.
// No provider process or optional MCP Tasks/Channels capability is involved.
let srv: StartedServer;
let dataDir: string;
let cookie: Record<string, string>;
let projectId: string;
let lead: string;
let worker: string;
let foreign: string;
let targetId: string;
let sequence = 0;
const fingerprint = createHash('sha256').update('dedicated-fixture-checkout').digest('hex');
const brief = 'Inspect the fixture and report its constraints. This brief stays out of status polling.';

function form(endpoint: string, fields: Record<string, string>, headers = cookie) {
  return fetch(`${srv.url}${endpoint}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields), redirect: 'manual',
  });
}

async function rpc(token: string, method: string, params: unknown = {}) {
  const res = await fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }),
  });
  return { status: res.status, body: await res.json() as any };
}

async function call(token: string, name: string, args: Record<string, unknown>) {
  const { status, body } = await rpc(token, 'tools/call', { name, arguments: args });
  const text = body.result?.content?.[0]?.text ?? body.error?.message ?? '';
  let data: any;
  try { data = JSON.parse(text); } catch { data = null; }
  return { status, data, text, failed: status !== 200 || !!body.result?.isError || !!body.error };
}

async function workerPost(token: string, action: string, body: unknown) {
  const res = await fetch(`${srv.url}/api/agent/worker/${action}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() as any };
}

async function connect(name: string, project: string) {
  const html = await (await form('/app/tokens', {
    name, device: 'fixture', access: `project:${project}`, client: 'claude-code', role: 'generalist',
  })).text();
  const code = /(?:&quot;|")STMA_ENROLLMENT_CODE(?:&quot;|")\s*:\s*(?:&quot;|")([^"&<]+)/.exec(html)?.[1];
  expect(code, html.slice(0, 500)).toMatch(/^stma_enroll_/);
  const response = await fetch(`${srv.url}/api/agent-enrollments/redeem`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
  });
  const { token } = await response.json() as { token: string };
  expect((await call(token, 'whoami', {})).failed).toBe(false);
  return token;
}

async function assignment(task: string, toAgent = 'Managed fixture') {
  const result = await call(lead, 'assign_work', {
    request_id: randomUUID(), to_agent: toAgent, task, brief, project: 'worker-project',
  });
  expect(result.failed, result.text).toBe(false);
  return result.data.sessionId as string;
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-execution-mcp-'));
  srv = await startServer(loadEnv({ port: 0, host: '127.0.0.1', nodeEnv: 'test', devMode: true,
    databaseUrl: undefined, pgliteDir: dataDir }));
  const login = await form('/auth/dev', { username: 'worker-owner' }, {});
  cookie = { cookie: login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ') };
  await form('/app/teams', { name: 'Worker Console' });
  const [team] = await srv.db.select().from(teams).where(eq(teams.slug, 'worker-console'));
  const [project, other] = await srv.db.insert(projects).values([
    { teamId: team!.id, name: 'worker-project', slug: 'worker-project', repositoryIdentity: 'github.com/example/worker-fixture' },
    { teamId: team!.id, name: 'other-project', slug: 'other-project' },
  ]).returning();
  projectId = project!.id;
  lead = await connect('Worker lead', projectId);
  worker = await connect('Managed fixture', projectId);
  foreign = await connect('Other project', other!.id);
  const configured = await workerPost(worker, 'configure', {
    checkout_path: '/dedicated/worker-fixture', checkout_fingerprint: fingerprint,
    runtime: 'claude-print-v1', runtime_version: 'fixture', permission_profile: 'restricted-files-v1',
    max_runtime_seconds: 120, max_turns: 4, dedicated: true,
  });
  expect(configured.status, JSON.stringify(configured.data)).toBe(200);
  targetId = configured.data.target.id;
}, 120_000);

afterAll(async () => {
  await srv?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

it('lists metadata through an ordinary connector without starting any job', async () => {
  const initialized = await rpc(lead, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'plain-client', version: '1' },
  });
  expect(initialized.status).toBe(200);
  const catalog = await rpc(lead, 'tools/list');
  expect(catalog.body.result.tools).toHaveLength(49);
  const result = await call(lead, 'list_execution_targets', { project_id: projectId });
  expect(result.failed, result.text).toBe(false);
  expect(result.data.targets).toContainEqual(expect.objectContaining({ target_id: targetId, readiness: 'disabled' }));
  expect(result.text).not.toContain('/dedicated/worker-fixture');
  expect(await srv.db.select().from(executionJobs)).toHaveLength(0);
});

it('keeps assignment separate from execution and requires explicit owner activation', async () => {
  const sessionId = await assignment('Inspect first fixture');
  expect(await srv.db.select().from(executionJobs)).toHaveLength(0);
  const denied = await call(lead, 'dispatch_work', { target_id: targetId, session_id: sessionId, request_id: randomUUID() });
  expect(denied.failed, denied.text).toBe(true);
  expect(await srv.db.select().from(executionJobs)).toHaveLength(0);
  const enabled = await form(`/app/execution-targets/${targetId}/enable`, { back_team: 'worker-console', back_project: 'worker-project' });
  expect([302, 303]).toContain(enabled.status);
  const listed = await call(lead, 'list_execution_targets', {});
  expect(listed.data.targets[0].readiness).toBe('offline');
});

it('replays simultaneous dispatch, rejects changed payload, and keeps status compact', async () => {
  const sessionId = await assignment('Inspect queued fixture');
  const input = { target_id: targetId, session_id: sessionId, request_id: randomUUID() };
  const pair = await Promise.all([call(lead, 'dispatch_work', input), call(lead, 'dispatch_work', input)]);
  for (const result of pair) expect(result.failed, result.text).toBe(false);
  expect(pair[0]!.data.execution_id).toBe(pair[1]!.data.execution_id);
  expect(pair.map((result) => result.data.replayed).sort()).toEqual([false, true]);
  const executionId = pair[0]!.data.execution_id;
  const changed = await call(lead, 'dispatch_work', { ...input, session_id: randomUUID() });
  expect(changed.failed, changed.text).toBe(true);
  const status = await call(lead, 'get_execution', { execution_id: executionId });
  expect(status.data).toMatchObject({ execution_id: executionId, state: 'queued', attempt: null, result_provenance: 'worker_reported', acceptance: 'separate' });
  expect(status.text).not.toContain(brief);
  expect(status.text).not.toContain('/dedicated/worker-fixture');
  const hidden = await call(foreign, 'get_execution', { execution_id: executionId });
  expect(hidden.failed).toBe(true);
  expect(hidden.text).not.toContain(sessionId);
  const cancelled = await call(lead, 'cancel_execution', { execution_id: executionId });
  expect(cancelled.data.state).toBe('cancelled');
  expect((await call(lead, 'cancel_execution', { execution_id: executionId })).data.state).toBe('cancelled');
});

it('does not confuse a lease, runtime completion, and acceptance', async () => {
  const sessionId = await assignment('Inspect active fixture');
  const queued = await call(lead, 'dispatch_work', { target_id: targetId, session_id: sessionId, request_id: randomUUID() });
  expect(queued.failed, queued.text).toBe(false);
  const workerId = randomUUID();
  const claimed = await workerPost(worker, 'claim', { target_id: targetId, worker_id: workerId });
  expect(claimed.status, JSON.stringify(claimed.data)).toBe(200);
  const { job, attempt, attempt_token: child } = claimed.data;
  expect(job.state).toBe('leased');
  expect(child).toBeTruthy();
  const childCatalog = await rpc(child, 'tools/list');
  expect(childCatalog.status).toBe(200);
  expect(childCatalog.body.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([...EXECUTION_CHILD_TOOLS].sort());
  const forbidden = await call(child, 'list_execution_targets', {});
  expect(forbidden.failed, forbidden.text).toBe(true);
  const lease = { target_id: targetId, worker_id: workerId, attempt_id: attempt.id, fence: attempt.fence };
  expect((await workerPost(child, 'claim', { target_id: targetId, worker_id: workerId })).status).not.toBe(200);
  const rejectedParent = await call(worker, 'start_run', { task: 'Bypass attempt', intent: 'Wrong credential', project: 'worker-project' });
  expect(rejectedParent.failed, rejectedParent.text).toBe(true);
  const event = { ...lease, provider_session_id: attempt.provider_session_id, checkout_fingerprint: fingerprint };
  for (const [state, reason] of [['starting', 'spawn_intent'], ['running', 'session_observed']] as const) {
    const sent = await workerPost(worker, 'event', { ...event, event_id: randomUUID(), state, reason, process_stopped: false });
    expect(sent.status, JSON.stringify(sent.data)).toBe(200);
  }
  const cancelled = await call(lead, 'cancel_execution', { execution_id: job.id });
  expect(cancelled.data.state).toBe('cancel_requested');
  const heartbeat = await workerPost(worker, 'heartbeat', lease);
  expect(heartbeat.data.cancel_requested).toBe(true);
  const stale = await call(child, 'post_message', { session_id: sessionId, body: 'Late write after cancellation.' });
  expect(stale.failed, stale.text).toBe(true);
  const unknown = await workerPost(worker, 'event', { ...event, event_id: randomUUID(), state: 'dispatch_unknown', reason: 'cancelled', process_stopped: false });
  expect(unknown.status, JSON.stringify(unknown.data)).toBe(200);
  const status = await call(lead, 'get_execution', { execution_id: job.id, include_events: true });
  expect(status.data).toMatchObject({ state: 'dispatch_unknown', target_readiness: 'quarantined', acceptance: 'separate' });
  expect(status.data.events.length).toBeLessThanOrEqual(5);
  const noRestart = await workerPost(worker, 'claim', { target_id: targetId, worker_id: randomUUID() });
  expect(noRestart.data.job ?? null).toBeNull();
});

it('refuses unknown command fields instead of turning task text into a command', async () => {
  const rejected = await call(lead, 'dispatch_work', {
    target_id: targetId, session_id: randomUUID(), request_id: randomUUID(), command: 'unexpected executable',
  });
  expect(rejected.failed).toBe(true);
  expect(rejected.text).toContain('Unknown parameter');
});

it.each(['offered', 'accepted', 'in_progress'] as const)('runs prompt-provided lifecycle calls and real packaged hooks from a %s assignment', async (initialState) => {
  const harness = mkdtempSync(path.join(tmpdir(), 'stma-worker-http-'));
  try {
    const checkoutPath = path.join(harness, 'checkout');
    const stateDirectory = path.join(harness, 'state');
    const bundleDirectory = path.join(harness, 'bundle');
    for (const directory of [checkoutPath, stateDirectory, bundleDirectory]) mkdirSync(directory, { mode: 0o700 });
    const checkout = canonicalCheckout(checkoutPath);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: checkout, windowsHide: true, stdio: 'pipe' });
    git('init', '-b', 'main');
    git('remote', 'add', 'origin', 'https://github.com/example/worker-fixture.git');
    writeFileSync(path.join(checkout, 'README.md'), 'Dedicated fixture.\n');
    git('add', 'README.md');
    git('-c', 'user.name=Worker Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture');
    await build({
      entry: [fileURLToPath(new URL('../../cli/src/index.ts', import.meta.url)).replaceAll('\\', '/')], outDir: bundleDirectory,
      format: ['esm'], platform: 'node', target: 'node20', bundle: true, splitting: false,
      config: false, silent: true, noExternal: [/^@bridge\//, 'zod', 'smol-toml'],
      define: { STMA_BUNDLED_VERSION: JSON.stringify('fixture') },
    });
    const runtimeEntry = path.join(bundleDirectory, 'index.js');
    // A package-independent .mjs proves the hook can run after the CLI is pinned privately.
    const pinnedEntry = path.join(stateDirectory, 'runtime.mjs');
    writeFileSync(pinnedEntry, readFileSync(runtimeEntry), { mode: 0o600 });
    const workerName = `Real hook fixture ${initialState}`;
    const token = await connect(workerName, projectId);
    const sessionId = await assignment('Exercise real hooks', workerName);
    // Existing lifecycle state is created through the agent's ordinary connection
    // before it becomes dedicated. Redispatch must not replay an illegal accept.
    if (initialState !== 'offered') {
      const accepted = await call(token, 'update_handoff', { session_id: sessionId, action: 'accept' });
      expect(accepted.failed, accepted.text).toBe(false);
    }
    if (initialState === 'in_progress') {
      const resumed = await call(token, 'update_handoff', { session_id: sessionId, action: 'resume' });
      expect(resumed.failed, resumed.text).toBe(false);
    }
    const configured = await workerPost(token, 'configure', {
      checkout_path: checkout, checkout_fingerprint: checkoutFingerprint(checkout), runtime: 'claude-print-v1',
      runtime_version: 'fixture', permission_profile: 'restricted-files-v1', max_runtime_seconds: 120, max_turns: 4, dedicated: true,
    });
    expect(configured.status, JSON.stringify(configured.data)).toBe(200);
    const target = configured.data.target.id;
    await form(`/app/execution-targets/${target}/enable`, { back_team: 'worker-console', back_project: 'worker-project' });
    const queued = await call(lead, 'dispatch_work', { target_id: target, session_id: sessionId, request_id: randomUUID() });
    expect(queued.failed, queued.text).toBe(false);
    const fake = path.join(harness, 'fake-provider.cjs');
    // The model is substituted, not the STMA transport, CLI hook code, Git preflight or child process.
    writeFileSync(fake, `
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
let prompt = ''; process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', async () => {
  const context = JSON.parse(fs.readFileSync(process.env.STMA_WORKER_CONTEXT, 'utf8'));
  const entry = ${JSON.stringify(pinnedEntry)};
  function hook(event, extra = {}) {
    const reply = cp.spawnSync(process.execPath, [entry, 'worker', 'hook', '--event', event], {
      cwd: process.cwd(), env: process.env, windowsHide: true, encoding: 'utf8', timeout: 20000,
      input: JSON.stringify({ session_id: context.sessionId, cwd: process.cwd(), ...extra }),
    });
    if (reply.status !== 0 || reply.stdout.includes('"permissionDecision":"deny"')) throw new Error(event + ': ' + reply.stderr + reply.stdout);
  }
  try {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: context.sessionId, cwd: process.cwd(), mcp_servers: [{ name: 'stma_worker', status: 'connected' }] }));
    hook('start');
    const state = JSON.parse(fs.readFileSync(path.join(path.dirname(process.env.STMA_WORKER_CONTEXT), 'hook-state.json'), 'utf8'));
    let id = 0;
    async function call(name, args) {
      const response = await fetch(context.server + '/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + context.token, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
      const body = await response.json(); if (response.status !== 200 || body.error || body.result?.isError) throw new Error(JSON.stringify(body));
      return JSON.parse(body.result.content[0].text);
    }
    const lifecycleLine = prompt.split('\\n').find(line => line.startsWith('Assignment lifecycle: '));
    if (!lifecycleLine) throw new Error('Managed prompt omitted assignment lifecycle');
    const lifecycle = JSON.parse(lifecycleLine.slice('Assignment lifecycle: '.length));
    for (const action of ['accept', 'resume', 'complete']) {
      const args = lifecycle[action].arguments;
      if (args.session_id !== ${JSON.stringify(sessionId)} || args.session_id === context.sessionId || args.action !== action || Object.keys(args).length !== 2) throw new Error('Prompt did not provide minimal bound assignment calls');
    }
    const inspected = await call(lifecycle.inspect.tool, lifecycle.inspect.arguments);
    if (inspected.handoff?.state !== ${JSON.stringify(initialState)}) throw new Error('Session did not expose the expected existing lifecycle state');
    if (inspected.handoff.state === 'offered') await call(lifecycle.accept.tool, lifecycle.accept.arguments);
    if (['offered', 'accepted', 'needs_attention'].includes(inspected.handoff.state)) await call(lifecycle.resume.tool, lifecycle.resume.arguments);
    else if (inspected.handoff.state !== 'in_progress') throw new Error('Assignment cannot be continued');
    hook('guard', { tool_name: 'Write', tool_input: { file_path: path.join(process.cwd(), 'analysis.txt'), content: 'Fixture analysis.\\n' } });
    fs.writeFileSync('analysis.txt', 'Fixture analysis.\\n');
    hook('heartbeat');
    await call('post_message', { session_id: ${JSON.stringify(sessionId)}, body: 'Fixture analysis is ready for human review.' });
    await call(lifecycle.complete.tool, lifecycle.complete.arguments);
    await call('finish_run', { run_id: state.runId, status: 'completed' });
    hook('heartbeat', { tool_name: 'mcp__stma_worker__finish_run' });
    hook('finish');
    console.log(JSON.stringify({ type: 'result', subtype: 'success', permission_denials: [] }));
  } catch (error) {
    fs.writeFileSync(${JSON.stringify(path.join(harness, 'failure.txt'))}, String(error));
    console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true })); process.exitCode = 1;
  }
});
`);
    const config: WorkerConfig = {
      schema: 1, checkout, fingerprint: checkoutFingerprint(checkout), targetId: target, installationId: configured.data.target.installation_id, server: srv.url,
      executable: process.execPath, runtimeVersion: 'fixture', apiKeyEnv: 'FIXTURE_KEY', hookRuntime: pinnedEntry,
      maxRuntimeSeconds: 120, maxTurns: 4,
    };
    const request: WorkerRequest = async <T>(endpoint: string, body?: unknown) => {
      const response = await workerPost(token, endpoint.split('/').at(-1)!, body);
      if (response.status !== 200) throw new Error(JSON.stringify(response.data));
      if (endpoint.endsWith('/event') && ['succeeded', 'failed', 'needs_input'].includes((body as any)?.state)) signalWorker(stateDirectory, 'stop');
      return response.data as T;
    };
    const fakeSpawn = ((executable: string, args: string[], options: any) => spawn(executable, [fake, ...args], options)) as typeof spawn;
    await superviseWorker(config, stateDirectory, {
      request, apiKey: 'synthetic-provider', verifyAuth: () => {},
      launch: (input, observe) => launchWorkerRuntime(input, observe, fakeSpawn),
    });
    const failure = existsSync(path.join(harness, 'failure.txt')) ? readFileSync(path.join(harness, 'failure.txt'), 'utf8') : '';
    const status = await call(lead, 'get_execution', { execution_id: queued.data.execution_id, include_events: true });
    expect(status.data.state, failure || JSON.stringify(status.data)).toBe('succeeded');
    expect(status.data.attempt.run_id).toBeTruthy();
    expect(status.data.acceptance).toBe('separate');
    const evidence = await call(lead, 'get_evidence', { run_id: status.data.attempt.run_id });
    expect(evidence.failed, evidence.text).toBe(false);
    expect(readFileSync(path.join(checkout, 'analysis.txt'), 'utf8')).toBe('Fixture analysis.\n');
    expect(readWorkerJson<any>(path.join(stateDirectory, 'journal.json')).phase).toBe('terminal');
    expect(existsSync(path.join(stateDirectory, 'owner.lock'))).toBe(false);
    const [offer] = await srv.db.select().from(handoffs).where(eq(handoffs.sessionId, sessionId));
    expect(offer).toMatchObject({ state: 'completed' });
    expect(offer!.acceptedAt).toBeTruthy(); expect(offer!.resumedAt).toBeTruthy(); expect(offer!.completedAt).toBeTruthy();
  } finally {
    rmSync(harness, { recursive: true, force: true });
  }
}, 60_000);
