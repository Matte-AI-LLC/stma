import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { conflictReport, detectClaimConflicts, type ConflictClaim } from '@bridge/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { teams } from '../src/db/schema';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

/**
 * What two runs on different files may be told, and what they may not.
 *
 * The launch material shows two agents on one parcel app: one changes the ETA
 * calculation, the other the display that shows it. Whether they "collide"
 * depends on whether anyone declared what they share. STMA reads declared
 * claims; it does not infer a dependency from the code. These cases pin both
 * halves so a sentence about shared contracts can be written only as far as
 * the behaviour goes:
 *
 *   - two runs on different files with no declared contract: nothing to say;
 *   - the same contract key declared by both, on different files: critical,
 *     and the run that declared it first keeps the right of way;
 *   - a contract that one run only reads: one step softer, nobody waits;
 *   - key spelling and case do not hide a shared contract;
 *   - what the hook observes in a dirty worktree is always a path claim, so a
 *     contract link exists only when an agent declares one.
 *
 * Public tree: this file reads nothing outside packages/.
 */

const claim = (
  runId: string,
  type: ConflictClaim['resourceType'],
  key: string,
  access: 'read' | 'write' = 'write',
): ConflictClaim => ({
  runId,
  resourceType: type,
  resourceKey: key,
  access,
  owner: 'lead',
  agentName: `agent-${runId}`,
});

describe('declared claims, without a server', () => {
  it('finds nothing between two runs on different files that declare no contract', () => {
    const eta = [claim('a1', 'path', 'src/eta.mjs')];
    const display = [claim('b1', 'path', 'src/display.mjs')];
    expect(detectClaimConflicts(display, eta)).toEqual([]);
    expect(detectClaimConflicts(eta, display)).toEqual([]);
    // A contract on one side and a file on the other is not an overlap either:
    // the types differ, and STMA never guesses that a file implements a contract.
    expect(detectClaimConflicts([claim('b1', 'path', 'eta-api')], [claim('a1', 'contract', 'eta-api')])).toEqual([]);
    expect(detectClaimConflicts([claim('b1', 'path', 'src/eta-api.mjs')], [claim('a1', 'contract', 'eta-api')])).toEqual([]);
  });

  it('calls the same contract on different files critical, with the contract sentence', () => {
    const first = [claim('a1', 'path', 'src/eta.mjs'), claim('a1', 'contract', 'eta-api')];
    const second = [claim('b1', 'path', 'src/display.mjs'), claim('b1', 'contract', 'eta-api')];
    const found = detectClaimConflicts(second, first);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      severity: 'critical',
      reason: 'Both runs may change the same shared contract.',
    });
    expect(found[0]!.current.resourceType).toBe('contract');
    expect(found[0]!.existing.runId).toBe('a1');
    // The paths never joined in: only the declared contract did.
    expect(found.some((conflict) => conflict.current.resourceType === 'path')).toBe(false);
  });

  it('tells the run that came second to stop, and the run that came first to carry on', () => {
    const lease = new Date(Date.now() + 5 * 60_000).toISOString();
    const holder = { ...claim('a1', 'contract', 'eta-api'), runState: 'active' as const, leaseEndsAt: lease };
    const waits = conflictReport([
      { severity: 'critical', rightOfWay: 'theirs', current: { resourceKey: 'eta-api', access: 'write' }, existing: holder },
    ]);
    expect(waits.blocked).toContain('STOP and tell your human before writing');
    expect(waits.blocked).toContain('migration or contract');
    expect(waits.blocked).toContain('eta-api');
    expect(waits.blocked).toContain('agent-a1');
    expect(waits.holding).toBeUndefined();

    const first = conflictReport([
      { severity: 'critical', rightOfWay: 'yours', current: { resourceKey: 'eta-api', access: 'write' }, existing: { ...holder, runId: 'b1' } },
    ]);
    expect(first.blocked).toBeUndefined();
    expect(first.holding).toContain('You were first');
    expect(first.holding).toContain('eta-api');
  });

  it('is one step softer when one run only reads the contract, and nobody waits', () => {
    const reading = detectClaimConflicts([claim('b1', 'contract', 'eta-api', 'read')], [claim('a1', 'contract', 'eta-api', 'write')]);
    expect(reading).toHaveLength(1);
    expect(reading[0]).toMatchObject({
      severity: 'high',
      reason: 'One run reads the shared contract while the other changes it.',
    });
    // Whoever came first, the writer carries on and the reader is told to re-read.
    const reader = conflictReport([
      { severity: 'high', rightOfWay: 'theirs', current: { resourceKey: 'eta-api', access: 'read' }, existing: { ...claim('a1', 'contract', 'eta-api', 'write'), runState: 'active' } },
    ]);
    expect(reader.blocked).toBeUndefined();
    expect(reader.reading).toContain('re-read');
    const writer = conflictReport([
      { severity: 'high', rightOfWay: 'yours', current: { resourceKey: 'eta-api', access: 'write' }, existing: { ...claim('b1', 'contract', 'eta-api', 'read'), runState: 'active' } },
    ]);
    expect(writer.blocked).toBeUndefined();
    expect(writer.holding).toBeUndefined();
    expect(writer.readBy).toContain('carry on with your change');
    // Two readers never collide.
    expect(detectClaimConflicts([claim('b1', 'contract', 'eta-api', 'read')], [claim('a1', 'contract', 'eta-api', 'read')])).toEqual([]);
  });

  it('does not let spelling, case or a trailing slash hide a shared contract', () => {
    for (const spelled of ['ETA-API', ' eta-api ', './eta-api', 'eta-api/', 'Eta-Api']) {
      const found = detectClaimConflicts([claim('b1', 'contract', spelled)], [claim('a1', 'contract', 'eta-api')]);
      expect(found, `"${spelled}" is the same contract`).toHaveLength(1);
    }
    // A different key is a different contract, not a prefix match.
    expect(detectClaimConflicts([claim('b1', 'contract', 'eta-api-v2')], [claim('a1', 'contract', 'eta-api')])).toEqual([]);
    expect(detectClaimConflicts([claim('b1', 'contract', 'eta')], [claim('a1', 'contract', 'eta-api')])).toEqual([]);
  });

  it('only ever observes paths in a dirty worktree, so a contract exists only when an agent declares one', () => {
    const source = (file: string) => readFileSync(path.resolve(__dirname, '../../cli/src', file), 'utf8');
    const index = source('index.ts');
    // Both places the hook turns `git status` into claims build path claims.
    const fromDirtyFiles = [...index.matchAll(/dirtyFiles\(\)\.map\(\(file\) => \(\{\s*resourceType: '([a-z]+)'/g)].map((m) => m[1]);
    expect(fromDirtyFiles.length).toBeGreaterThanOrEqual(2);
    expect(new Set(fromDirtyFiles)).toEqual(new Set(['path']));
    // The file guard builds its claim from the file an edit names.
    expect(source('fileGuard.ts')).toMatch(/resourceType: 'path', resourceKey, access: 'write'/);
    // And no client source writes a contract claim by itself.
    for (const file of ['index.ts', 'fileGuard.ts', 'news.ts', 'adapters.ts']) {
      expect(source(file), `${file} must not invent a contract claim`).not.toMatch(/resourceType: 'contract'/);
    }
  });
});

describe('the same claims through the server', () => {
  let srv: StartedServer;
  let dataDir: string;
  let owner: Record<string, string> = {};
  let teamId = '';
  let rpcId = 1;

  const jar = () => {
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
  };

  const form = (url: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(body),
      redirect: 'manual',
    });

  async function call(tool: string, args: Record<string, unknown>, token: string) {
    const res = await fetch(`${srv.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: tool, arguments: args } }),
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
      /* a refusal answers in prose */
    }
    return { text, data, isError: json.result?.isError === true || json.error !== undefined };
  }

  interface Agent {
    name: string;
    token: string;
    id: string;
    worktree: string;
  }

  async function connectAgent(name: string): Promise<Agent> {
    const html = await (
      await form(`${srv.url}/app/tokens`, { name, device: 'mac', access: `team:${teamId}`, client: 'claude-code', role: 'generalist' }, owner)
    ).text();
    const code = /(?:&quot;|")STMA_ENROLLMENT_CODE(?:&quot;|")\s*:\s*(?:&quot;|")([^"&<]+)/.exec(html)?.[1];
    expect(code, `enrollment code for ${name}`).toMatch(/^stma_enroll_/);
    const redeemed = (await (
      await fetch(`${srv.url}/api/agent-enrollments/redeem`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      })
    ).json()) as { token: string; installation: { id: string } };
    const who = await call('whoami', {}, redeemed.token);
    expect(who.isError, who.text).toBe(false);
    return { name, token: redeemed.token, id: redeemed.installation.id, worktree: `/work/${name}` };
  }

  const REPO = 'https://github.com/acme/parcel-desk.git';

  async function api(agent: Agent, method: 'GET' | 'POST', route: string, body?: unknown) {
    const res = await fetch(`${srv.url}${route}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${agent.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  const file = (key: string) => ({ resourceType: 'path' as const, resourceKey: key, access: 'write' as const });
  const contract = (key: string, access: 'read' | 'write' = 'write') => ({ resourceType: 'contract' as const, resourceKey: key, access });

  async function startRun(agent: Agent, task: string, claims: Array<ReturnType<typeof file> | ReturnType<typeof contract>>) {
    const started = await api(agent, 'POST', '/api/agent/runs/start', {
      requestId: randomUUID(),
      installationId: agent.id,
      team: 'parcel',
      project: 'parcel-desk',
      repositoryIdentity: REPO,
      worktree: agent.worktree,
      taskKey: task,
      claims,
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    return { runId: started.body.run.id as string, conflicts: started.body.conflicts as any[] };
  }

  const guard = (agent: Agent, runId: string, key: string) =>
    api(agent, 'POST', `/api/agent/runs/${runId}/write-guard`, { claims: [file(key)], repositoryIdentity: REPO, worktree: agent.worktree }).then((res) => res.body);

  const finish = async (agent: Agent, runId: string) =>
    expect((await api(agent, 'POST', `/api/agent/runs/${runId}/finish`, { status: 'completed' })).status).toBe(200);

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'stma-scenario-claims-'));
    srv = await startServer(
      loadEnv({ port: 0, host: '127.0.0.1', nodeEnv: 'test', devMode: true, databaseUrl: undefined, pgliteDir: dataDir }),
    );
    const cookies = jar();
    cookies.store(await form(`${srv.url}/auth/dev`, { username: 'lead' }));
    owner = cookies.header();
    await form(`${srv.url}/app/teams`, { name: 'Parcel' }, owner);
    const [team] = await srv.db.select().from(teams).where(eq(teams.slug, 'parcel'));
    teamId = team!.id;
  });

  afterAll(async () => {
    await srv?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('says nothing to two runs on different files, and warns the second run that declared a shared contract', async () => {
    const eta = await connectAgent('eta-agent');
    const display = await connectAgent('display-agent');

    const first = await startRun(eta, 'PD-ETA', [file('src/eta.mjs')]);
    // Different file, no contract anywhere: no collision to report.
    const second = await startRun(display, 'PD-DISPLAY', [file('src/display.mjs')]);
    expect(first.conflicts).toEqual([]);
    expect(second.conflicts).toEqual([]);

    // The ETA agent declares the contract it is about to change.
    const declared = await api(eta, 'POST', `/api/agent/runs/${first.runId}/heartbeat`, {
      claims: [file('src/eta.mjs'), contract('eta-api')],
      claimSource: 'planned',
    });
    expect(declared.status).toBe(200);
    expect(declared.body.conflicts ?? []).toEqual([]);

    // The display agent declares the same contract in a different spelling.
    const warned = await api(display, 'POST', `/api/agent/runs/${second.runId}/heartbeat`, {
      claims: [file('src/display.mjs'), contract('ETA-API')],
      claimSource: 'planned',
    });
    expect(warned.status).toBe(200);
    const shared = (warned.body.conflicts as any[]).filter((conflict) => conflict.current.resourceType === 'contract');
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({
      severity: 'critical',
      reason: 'Both runs may change the same shared contract.',
      rightOfWay: 'theirs',
    });
    expect((warned.body.conflicts as any[]).some((conflict) => conflict.current.resourceType === 'path')).toBe(false);

    // The first declarer is told it keeps the right of way, and is not asked to stop.
    const told = await call('update_run', { run_id: first.runId, scope: [{ type: 'path', key: 'src/eta.mjs', access: 'write' }, { type: 'contract', key: 'eta-api', access: 'write' }] }, eta.token);
    expect(told.isError, told.text).toBe(false);
    const mine = (told.data.conflicts as any[]).find((conflict) => conflict.yours === 'contract:eta-api');
    expect(mine, JSON.stringify(told.data.conflicts)).toMatchObject({ severity: 'critical', rightOfWay: 'yours', heldBy: 'lead (display-agent)' });
    expect(told.data.conflictAdvice).toContain('You were first');
    expect(told.data.conflictAdvice).not.toContain('STOP');

    // A warning, not a lock: the second run's edit of its own file is still allowed,
    // because the guard judges the file an edit names and the contract is not a file.
    expect(await guard(display, second.runId, 'src/display.mjs')).toMatchObject({ allowed: true, reason: 'scope_reserved' });
    // The file the first run holds is still protected: that is the path rule, unchanged.
    expect(await guard(display, second.runId, 'src/eta.mjs')).toMatchObject({ allowed: false, reason: 'work_conflict' });

    await finish(eta, first.runId);
    await finish(display, second.runId);
  });

  it('keeps dirty files the hook reports as path claims, and invents no contract', async () => {
    const hooked = await connectAgent('hooked-agent');
    const run = await startRun(hooked, 'PD-HOOK', []);
    const observed = await api(hooked, 'POST', `/api/agent/runs/${run.runId}/heartbeat`, {
      claims: [file('src/eta.mjs'), file('src/display.mjs'), file('docs/eta-api.md')],
      claimSource: 'observed',
    });
    expect(observed.status).toBe(200);
    const active = await api(hooked, 'GET', '/api/agent/runs/active?team=parcel');
    expect(active.status).toBe(200);
    const mine = (active.body.runs as any[]).find((entry) => entry.run?.id === run.runId || entry.id === run.runId);
    expect(mine, JSON.stringify(active.body).slice(0, 400)).toBeTruthy();
    const types = new Set((mine.claims as Array<{ resourceType: string }>).map((entry) => entry.resourceType));
    expect([...types]).toEqual(['path']);
    await finish(hooked, run.runId);
  });
});
