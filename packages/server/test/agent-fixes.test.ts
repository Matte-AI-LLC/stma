import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import { TOOL_PARAMS } from '../src/routes/mcp';
import { startServer, type StartedServer } from '../src/server';

/**
 * Defects found by seeding a real instance. They share one shape: a signal
 * disappears and nobody is told. Each test here fails against the old behaviour.
 */

let srv: StartedServer;
let dataDir: string;
let token: string;
let cookie: Record<string, string>;

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

const rpc = (body: unknown, tok = token) =>
  fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${tok}`,
    },
    body: JSON.stringify(body),
  });

let rpcId = 100;
async function call(name: string, args: Record<string, unknown>) {
  const res = await rpc({
    jsonrpc: '2.0',
    id: rpcId++,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const json = (await res.json()) as {
    result?: { content?: { text: string }[]; isError?: boolean };
    error?: { message?: string };
  };
  // Schema rejections come back as a JSON-RPC error envelope rather than a tool
  // result; either way the agent is told, which is what these tests assert.
  return {
    text: json.result?.content?.[0]?.text ?? json.error?.message ?? '',
    isError: json.result?.isError === true || json.error !== undefined,
  };
}

const api = (url: string, body: unknown, tok = token) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-fixes-'));
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

  const j = jar();
  j.store(await form(`${srv.url}/auth/dev`, { username: 'dana' }));
  cookie = j.header();
  await form(`${srv.url}/app/teams`, { name: 'Fixes' }, cookie);
  const tok = await fetch(`${srv.url}/app/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...cookie },
    body: new URLSearchParams({ name: 'dana-macbook' }),
  });
  token = /stma_[0-9a-f]{40}/.exec(await tok.text())?.[0] ?? '';
  expect(token).toBeTruthy();
});

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- unknown args

it('rejects unknown tool arguments instead of silently dropping them', async () => {
  // A misspelling used to return success while the value vanished.
  const typo = await call('push_snapshot', {
    devise: 'macbook',
    snapshot: { os: { platform: 'linux', arch: 'x64' }, runtimes: { node: '22.14.0' } },
  });
  expect(typo.isError).toBe(true);
  expect(typo.text).toContain('"devise"');
  expect(typo.text).toContain('push_snapshot');
  expect(typo.text).toContain('device');
  expect(typo.text).toContain('Nothing was written');

  // A second tool, and a tool that takes no arguments at all.
  const wrongOnSession = await call('open_session', { titel: 'oops' });
  expect(wrongOnSession.isError).toBe(true);
  expect(wrongOnSession.text).toContain('"titel"');
  expect(wrongOnSession.text).toContain('attachments');

  const noArgs = await call('whoami', { team: 'fixes' });
  expect(noArgs.isError).toBe(true);
  expect(noArgs.text).toContain('takes no arguments');

  // Correct arguments still work.
  const ok = await call('whoami', {});
  expect(ok.isError).toBe(false);
  expect(ok.text).toContain('dana');
});

it('keeps the accepted-parameter map in step with the registered tools', async () => {
  // The map is hand-written; this is what stops it drifting from the schemas.
  const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const listed = (await res.json()) as {
    result: { tools: { name: string; inputSchema?: { properties?: Record<string, unknown> } }[] };
  };
  expect(listed.result.tools.length).toBeGreaterThan(0);
  for (const tool of listed.result.tools) {
    const actual = Object.keys(tool.inputSchema?.properties ?? {}).sort();
    const declared = [...(TOOL_PARAMS[tool.name] ?? [])].sort();
    expect(declared, `TOOL_PARAMS is out of date for ${tool.name}`).toEqual(actual);
  }
  expect(Object.keys(TOOL_PARAMS).sort()).toEqual(listed.result.tools.map((t) => t.name).sort());
});

// ---------------------------------------------------------------- attachments

it('stores attachments passed to open_session, redacted', async () => {
  const opened = await call('open_session', {
    title: 'Checkout returns 502 after deploy',
    repo: 'payments-api',
    body: 'Fails only against staging. Log attached.',
    kind: 'question',
    attachments: [
      { name: 'checkout.log', content: 'POST /pay 502\nauthorization: Bearer stma_deadbeef' },
    ],
  });
  expect(opened.isError).toBe(false);
  const sessionId = /"sessionId":\s*"([0-9a-f-]+)"/.exec(opened.text)?.[1];
  expect(sessionId).toBeTruthy();

  const thread = await call('get_session', { session_id: sessionId! });
  expect(thread.text).toContain('checkout.log');
  expect(thread.text).toContain('POST /pay 502');
  // The same redaction post_message applies.
  expect(thread.text).not.toContain('a1b2c3d4a1b2c3d4');

  const tooMany = await call('open_session', {
    title: 'Too many attachments to accept',
    attachments: Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.log`, content: 'x' })),
  });
  expect(tooMany.isError).toBe(true);
});

// ---------------------------------------------------------------- claim leases

it('a heartbeat without claims keeps the collision on the map', async () => {
  const install = await api(`${srv.url}/api/agent/installations/register`, {
    name: 'dana-claude',
    clientType: 'claude-code',
    deviceFingerprint: 'fixes-device-1',
  });
  expect(install.status).toBe(200);
  const installationId = ((await install.json()) as { installation: { id: string } }).installation
    .id;

  const started = await api(`${srv.url}/api/agent/runs/start`, {
    installationId,
    team: 'fixes',
    project: 'payments-api',
    taskKey: 'PAY-900',
    claims: [{ resourceType: 'migration', resourceKey: 'payments-db', access: 'write' }],
  });
  expect(started.status).toBe(200);
  const runId = ((await started.json()) as { run: { id: string } }).run.id;

  const leaseOf = async () => {
    const active = await fetch(`${srv.url}/api/agent/runs/active`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const payload = (await active.json()) as {
      runs: { id: string; claims?: { resourceKey: string; leaseExpiresAt: string }[] }[];
    };
    const run = payload.runs.find((r) => r.id === runId);
    expect(run, 'the run should be listed as active').toBeTruthy();
    const claim = run!.claims?.find((c) => c.resourceKey === 'payments-db');
    expect(claim, 'the run should hold its migration claim').toBeTruthy();
    return Date.parse(claim!.leaseExpiresAt);
  };

  const before = await leaseOf();
  // Wait past the clock's resolution so a renewal is unambiguous.
  await new Promise((r) => setTimeout(r, 1_100));

  // A well-behaved agent that does not restate its scope. This used to refresh
  // the run while leaving the lease to expire, so the collision silently left
  // the map while both agents were still writing the same migration.
  const beat = await api(`${srv.url}/api/agent/runs/${runId}/heartbeat`, { status: 'active' });
  expect(beat.status).toBe(200);

  const after = await leaseOf();
  expect(after, 'a heartbeat must extend the leases the run already holds').toBeGreaterThan(before);

  const map = await fetch(`${srv.url}/app/agents`, { headers: cookie });
  expect(await map.text()).toContain('payments-db');
});

// ---------------------------------------------------------------- preflight

it('preflight only escalates lockfiles the baseline actually records', async () => {
  const baseline = {
    os: { platform: 'linux', arch: 'x64' },
    runtimes: { node: '22.14.0' },
    packageManagers: { npm: '11.0.0' },
    lockfiles: [{ path: 'package-lock.json', hash: 'aaaa1111' }],
    envVarNames: ['DATABASE_URL'],
    git: { branch: 'main', sha: 'fixes-base', dirtyFiles: [] },
    timezone: 'Europe/Istanbul',
  };
  const set = await api(`${srv.url}/api/control/environment-baselines`, {
    team: 'fixes',
    project: 'payments-api',
    snapshot: baseline,
  });
  expect(set.status).toBe(200);

  // A lockfile the baseline never listed: worth showing, not worth an alarm.
  const extra = await api(`${srv.url}/api/agent/environment/preflight`, {
    team: 'fixes',
    project: 'payments-api',
    snapshot: {
      ...baseline,
      lockfiles: [
        { path: 'package-lock.json', hash: 'aaaa1111' },
        { path: 'examples/demo/package-lock.json', hash: 'bbbb2222' },
      ],
    },
  });
  expect(extra.status).toBe(200);
  const extraBody = (await extra.json()) as { status: string };
  expect(extraBody.status, 'an unlisted lockfile must not read critical').not.toBe('critical');

  // A lockfile the baseline does record, with a different hash: still critical.
  const changed = await api(`${srv.url}/api/agent/environment/preflight`, {
    team: 'fixes',
    project: 'payments-api',
    snapshot: { ...baseline, lockfiles: [{ path: 'package-lock.json', hash: 'cccc3333' }] },
  });
  const changedBody = (await changed.json()) as { status: string };
  expect(changedBody.status).toBe('critical');

  // And one the baseline records but the machine is missing.
  const missing = await api(`${srv.url}/api/agent/environment/preflight`, {
    team: 'fixes',
    project: 'payments-api',
    snapshot: { ...baseline, lockfiles: [] },
  });
  const missingBody = (await missing.json()) as { status: string };
  expect(missingBody.status).toBe('critical');
});

// ------------------------------------------------- second round: same defects,
// reached through other paths (found by probing a running instance)

it('a JSON-RPC batch cannot walk past the unknown-argument guard', async () => {
  const res = await rpc([
    {
      jsonrpc: '2.0',
      id: 900,
      method: 'tools/call',
      params: {
        name: 'push_snapshot',
        arguments: {
          devise: 'macbook',
          snapshot: { os: { platform: 'linux', arch: 'x64' }, runtimes: { node: '22.14.0' } },
        },
      },
    },
  ]);
  const json = (await res.json()) as
    | { result?: { content?: { text: string }[]; isError?: boolean } }[]
    | { result?: { content?: { text: string }[]; isError?: boolean } };
  const first = Array.isArray(json) ? json[0] : json;
  expect(first?.result?.isError).toBe(true);
  expect(first?.result?.content?.[0]?.text).toContain('"devise"');
});

it('refuses a batch big enough to dodge the per-request rate limit', async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({
    jsonrpc: '2.0',
    id: 1000 + i,
    method: 'tools/call',
    params: { name: 'whoami', arguments: {} },
  }));
  const res = await rpc(many);
  expect(res.status).toBe(400);
  expect(JSON.stringify(await res.json())).toContain('Batch too large');
});

it('opens a session carrying only an attachment', async () => {
  // An agent that leads with a stack trace and no prose used to get "ok" and an
  // empty thread.
  const opened = await call('open_session', {
    title: 'Migration fails with no message',
    attachments: [{ name: 'stack.txt', content: 'psql: relation ledger does not exist' }],
  });
  expect(opened.isError).toBe(false);
  const sessionId = /"sessionId":\s*"([0-9a-f-]+)"/.exec(opened.text)?.[1];
  const thread = await call('get_session', { session_id: sessionId! });
  expect(thread.text).toContain('stack.txt');
  expect(thread.text).toContain('relation ledger does not exist');
});

it('an empty claims array does not wipe the run scope', async () => {
  const install = await api(`${srv.url}/api/agent/installations/register`, {
    name: 'dana-empty-claims',
    clientType: 'claude-code',
    deviceFingerprint: 'fixes-device-empty',
  });
  const installationId = ((await install.json()) as { installation: { id: string } }).installation
    .id;
  const started = await api(`${srv.url}/api/agent/runs/start`, {
    installationId,
    team: 'fixes',
    project: 'payments-api',
    taskKey: 'PAY-901',
    claims: [{ resourceType: 'contract', resourceKey: 'payments-openapi', access: 'write' }],
  });
  const runId = ((await started.json()) as { run: { id: string } }).run.id;

  // The native hook reports the dirty worktree, which empties as soon as the
  // agent commits — that must not read as "I released everything".
  const beat = await api(`${srv.url}/api/agent/runs/${runId}/heartbeat`, {
    status: 'active',
    claims: [],
  });
  expect(beat.status).toBe(200);

  const active = await fetch(`${srv.url}/api/agent/runs/active`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const runs = ((await active.json()) as { runs: { id: string; claims?: unknown[] }[] }).runs;
  const mine = runs.find((r) => r.id === runId);
  expect(mine?.claims?.length, 'the run must still hold its contract claim').toBe(1);
});

it('keeps one repo from evicting another on the same machine', async () => {
  const snapshot = (node: string) => ({
    os: { platform: 'linux', arch: 'x64' },
    runtimes: { node },
  });
  await call('push_snapshot', { repo: 'infra', device: 'shared-laptop', snapshot: snapshot('1.0.0') });
  // Push past the per-device retention window using a different repo.
  for (let i = 0; i < 21; i++) {
    await call('push_snapshot', {
      repo: 'web',
      device: 'shared-laptop',
      snapshot: snapshot(`2.0.${i}`),
    });
  }
  const infra = await call('get_snapshot', { repo: 'infra', device: 'shared-laptop' });
  expect(infra.isError, 'the quiet repo must survive a busy one').toBe(false);
  expect(infra.text).toContain('1.0.0');
});

it('returns the newest messages and says so when it truncates', async () => {
  const opened = await call('open_session', { title: 'Long thread', body: 'first' });
  const sessionId = /"sessionId":\s*"([0-9a-f-]+)"/.exec(opened.text)?.[1]!;
  // Posted through the web composer: the MCP loop guard deliberately caps an
  // agent at 20 messages an hour, which is far below the window under test.
  for (let i = 0; i < 205; i++) {
    await form(`${srv.url}/app/sessions/${sessionId}/messages`, { body: `m${String(i).padStart(3, '0')}` }, cookie);
  }
  const thread = await call('get_session', { session_id: sessionId });
  // Taking the oldest window made the newest messages unreachable through the
  // tool while clearing the unread flag that hinted they existed.
  expect(thread.text).toContain('m204');
  expect(thread.text).toContain('most recent messages');
});

it('rejects unknown sections inside a snapshot instead of dropping them', async () => {
  const res = await call('push_snapshot', {
    repo: 'infra',
    device: 'strict-check',
    snapshot: {
      os: { platform: 'linux', arch: 'x64' },
      runtimes: { node: '22.14.0' },
      dockerImages: { redis: '7.2' },
    },
  });
  expect(res.isError).toBe(true);
});

it('keeps names that share a prefix in separate projects', async () => {
  // Non-Latin names used to collapse onto one fallback slug, merging unrelated
  // repositories into a single project.
  const a = await call('push_snapshot', {
    repo: 'проект-альфа',
    device: 'slug-check',
    snapshot: { os: { platform: 'linux', arch: 'x64' }, runtimes: { node: '22.0.0' } },
  });
  const b = await call('push_snapshot', {
    repo: '日本語リポ',
    device: 'slug-check',
    snapshot: { os: { platform: 'linux', arch: 'x64' }, runtimes: { node: '22.0.0' } },
  });
  expect(a.isError).toBe(false);
  expect(b.isError).toBe(false);

  const projects = await call('list_projects', {});
  const slugs = [...projects.text.matchAll(/"slug":\s*"([^"]+)"/g)].map((m) => m[1]);
  expect(new Set(slugs).size, 'each repository needs its own project').toBe(slugs.length);
  expect(projects.text).toContain('проект-альфа');
  expect(projects.text).toContain('日本語リポ');
});

it('refuses a snapshot that lists the same lockfile twice', async () => {
  const res = await call('push_snapshot', {
    device: 'dupe-lock',
    snapshot: {
      os: { platform: 'linux', arch: 'x64' },
      lockfiles: [
        { path: 'package-lock.json', hash: 'aaa' },
        { path: 'package-lock.json', hash: 'bbb' },
      ],
    },
  });
  expect(res.isError).toBe(true);
});

it('treats search wildcards as literal characters', async () => {
  const opened = await call('open_session', { title: 'Migrations stall on deploy', body: 'x' });
  const sessionId = /"sessionId":\s*"([0-9a-f-]+)"/.exec(opened.text)?.[1]!;
  await call('resolve_session', {
    session_id: sessionId,
    root_cause: 'A stale advisory lock held the migration channel',
    fix: 'Released the lock and re-ran the migration',
  });
  const literal = await call('search_past_issues', { query: '_igration' });
  // Before escaping, _ matched any character and this found the session.
  expect(literal.text).not.toContain('Migrations stall on deploy');
  const real = await call('search_past_issues', { query: 'igration' });
  expect(real.text).toContain('Migrations stall on deploy');
});
