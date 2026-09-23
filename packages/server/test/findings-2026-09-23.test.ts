import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { conflictReport, detectClaimConflicts, type ConflictClaim } from '@bridge/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderNews, type NewsHandoff } from '../../cli/src/news';
import { teams } from '../src/db/schema';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

/**
 * What the T3 Mac round of 2026-09-23 found (docs/t3-mac-turu.md, 561bb5e).
 *
 * The agent lab ran twice on the Mac and neither run was green, for reasons
 * that had nothing to do with macOS: three sentences and one rule, each
 * reproduced here without a model.
 *
 *   1. A read against a write was reported as two runs writing the same path,
 *      with the right of way to whoever declared first — so a reviewer that
 *      declared a file read-only was "holding" it against the agent changing it,
 *      and the write guard would have refused that agent's edit.
 *   2. The write guard counted only `planned` rows as an acknowledgment of moved
 *      ground, and an agent that re-declared with `scope_source: "observed"`,
 *      as the refusal told it to, was refused for the rest of the run. And a live
 *      holder was hidden behind "another run finished on this ground".
 *   3. The hook told the receiver of a handoff on `lab/a1` to commit only on the
 *      branch its checkout was already on, and the receiver skipped the handoff
 *      as misrouted.
 */

let srv: StartedServer;
let dataDir: string;
let owner: Record<string, string> = {};
let teamId = '';

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

/** One enrolled, client-confirmed agent: the shape `stma connect` leaves behind. */
async function connectAgent(name: string, device: string): Promise<Agent> {
  const html = await (await form(`${srv.url}/app/tokens`, { name, device, access: `team:${teamId}`, client: 'claude-code', role: 'generalist' }, owner)).text();
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

async function api(agent: Agent, route: string, body: unknown) {
  const res = await fetch(`${srv.url}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${agent.token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const path_ = (key: string, access: 'read' | 'write' = 'write') => ({ resourceType: 'path' as const, resourceKey: key, access });

/** A run the way the hook starts one: over REST, with the checkout it guards. */
async function startRun(agent: Agent, task: string, claims: ReturnType<typeof path_>[] = []) {
  const started = await api(agent, '/api/agent/runs/start', {
    requestId: randomUUID(),
    installationId: agent.id,
    team: 'round',
    project: 'parcel-desk',
    repositoryIdentity: REPO,
    worktree: agent.worktree,
    taskKey: task,
    claims,
  });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  return { runId: started.body.run.id as string, conflicts: started.body.conflicts as any[] };
}

/** What the PreToolUse hook asks before an edit. */
const guard = (agent: Agent, runId: string, key: string) =>
  api(agent, `/api/agent/runs/${runId}/write-guard`, { claims: [path_(key)], repositoryIdentity: REPO, worktree: agent.worktree }).then(
    (res) => res.body,
  );

const finish = async (agent: Agent, runId: string) =>
  expect((await api(agent, `/api/agent/runs/${runId}/finish`, { status: 'completed' })).status).toBe(200);

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-t3mac-'));
  srv = await startServer(
    loadEnv({ port: 0, host: '127.0.0.1', nodeEnv: 'test', devMode: true, databaseUrl: undefined, pgliteDir: dataDir }),
  );
  const cookies = jar();
  cookies.store(await form(`${srv.url}/auth/dev`, { username: 'lab-lead' }));
  owner = cookies.header();
  await form(`${srv.url}/app/teams`, { name: 'Round' }, owner);
  const [team] = await srv.db.select().from(teams).where(eq(teams.slug, 'round'));
  teamId = team!.id;
});

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('a read against a write', () => {
  const claim = (runId: string, key: string, access: 'read' | 'write', resourceType: ConflictClaim['resourceType'] = 'path'): ConflictClaim => ({
    runId,
    resourceType,
    resourceKey: key,
    access,
    owner: 'lab-lead',
    agentName: `lab-${runId}`,
  });

  it('is named as a read, one step less severe than the same ground written twice', () => {
    const readWrite = detectClaimConflicts([claim('a1', 'src/carrier.mjs', 'write')], [claim('a2', 'src/carrier.mjs', 'read')]);
    expect(readWrite).toHaveLength(1);
    expect(readWrite[0]!.reason).toBe('One run may read files while the other changes them.');
    expect(readWrite[0]!.severity).toBe('medium');
    // Either side may be the reader: a directory read against one file written.
    const writeRead = detectClaimConflicts([claim('a2', 'test/', 'read')], [claim('b2', 'test/ui.test.mjs', 'write')]);
    expect(writeRead[0]!.reason).toBe('One run may read files while the other changes them.');
    // Two writers are what they always were.
    const twice = detectClaimConflicts([claim('a1', 'src/carrier.mjs', 'write')], [claim('b1', 'src/carrier.mjs', 'write')]);
    expect(twice[0]!.reason).toBe('The runs may write to the same path.');
    expect(twice[0]!.severity).toBe('high');
    // Reading a migration somebody is changing is worth a look, not the red alarm.
    const migration = detectClaimConflicts([claim('a1', 'payments-db', 'read', 'migration')], [claim('b1', 'payments-db', 'write', 'migration')]);
    expect(migration[0]!.severity).toBe('high');
    expect(migration[0]!.reason).toBe('One run reads the migration chain while the other changes it.');
  });

  it('tells each side what it is, and neither side to stop', () => {
    const lease = new Date(Date.now() + 5 * 60_000).toISOString();
    const reviewer = { runId: 'r', owner: 'lab-lead', agentName: 'lab-a2', resourceType: 'path' as const, access: 'read' as const, runState: 'active' as const, leaseEndsAt: lease };
    const builder = { runId: 'w', owner: 'lab-lead', agentName: 'lab-a1', resourceType: 'path' as const, access: 'write' as const, runState: 'waiting' as const, leaseEndsAt: lease };

    // The agent changing the file, which the reviewer declared first.
    const writing = conflictReport([
      { severity: 'medium', rightOfWay: 'yours', current: { resourceKey: 'src/carrier.mjs', access: 'write' }, existing: { ...reviewer, resourceKey: 'src/carrier.mjs' } },
    ]);
    expect(writing.blocked).toBeUndefined();
    expect(writing.holding).toBeUndefined();
    expect(writing.readBy).toContain('src/carrier.mjs');
    expect(writing.readBy).toContain('lab-a2 (lab-lead), working, reading it for about another 5 minutes');
    expect(writing.readBy).toContain('carry on with your change');
    // What the real agent read, and then told its human "a2 holds the write lock".
    expect(writing.readBy).not.toMatch(/leave alone|declared it first|holds it/);

    // The reviewer. The writer being parked on a person is not the reader's problem.
    const reading = conflictReport([
      { severity: 'medium', rightOfWay: 'theirs', current: { resourceKey: 'src/carrier.mjs', access: 'read' }, existing: { ...builder, resourceKey: 'src/carrier.mjs' } },
    ]);
    expect(reading.blocked).toBeUndefined();
    expect(reading.reading).toContain('may change');
    expect(reading.reading).toContain('lab-a1 (lab-lead)');
    expect(reading.reading).toContain('re-read');
    expect(reading.needsAPerson).toBe(false);

    // A claim that says nothing about access is a write, as it always was.
    const older = conflictReport([
      { severity: 'high', rightOfWay: 'theirs', current: { resourceKey: 'a.js' }, existing: { ...builder, resourceKey: 'a.js', runState: 'active' } },
    ]);
    expect(older.blocked).toContain('Another live run overlaps your scope');
  });

  it('does not let a reader that came first refuse the writer, and still tells the reader', async () => {
    const reviewer = await connectAgent('lab-a2', 'device-a');
    const builder = await connectAgent('lab-a1', 'device-a');
    // L1 of the Mac round: a read-only review declared first, the real task after it.
    const review = await startRun(reviewer, 'PD-23 Risk review', [path_('src/carrier.mjs', 'read'), path_('test/', 'read')]);
    const build = await startRun(builder, 'PD-21 ETA priority', [path_('src/carrier.mjs'), path_('test/carrier.test.mjs')]);
    expect(build.conflicts.length).toBeGreaterThan(0);
    for (const conflict of build.conflicts) {
      expect(conflict.rightOfWay).toBe('yours');
      expect(conflict.reason).toBe('One run may read files while the other changes them.');
      expect(conflict.severity).toBe('medium');
    }

    const told = await call('update_run', { run_id: build.runId, scope: [{ type: 'path', key: 'src/carrier.mjs', access: 'write' }] }, builder.token);
    expect(told.isError, told.text).toBe(false);
    expect(told.data.conflicts[0]).toMatchObject({ rightOfWay: 'yours', yourAccess: 'write', theirAccess: 'read' });
    expect(told.data.conflictAdvice).toContain('also being read by lab-a2');
    expect(told.data.conflictAdvice).not.toContain('leave alone');

    // The guard: the edit goes ahead, and the reviewer is not a run "waiting" for it.
    const edit = await guard(builder, build.runId, 'src/carrier.mjs');
    expect(edit).toMatchObject({ allowed: true, reason: 'scope_reserved', conflictAgents: [], waitingAgents: [] });

    const reader = await call('update_run', { run_id: review.runId, scope: [{ type: 'path', key: 'src/carrier.mjs', access: 'read' }] }, reviewer.token);
    expect(reader.isError, reader.text).toBe(false);
    expect(reader.data.conflicts[0]).toMatchObject({ rightOfWay: 'theirs', yourAccess: 'read', theirAccess: 'write' });
    expect(reader.data.conflictAdvice).toContain('may change');
    expect(reader.data.conflictAdvice).not.toContain('leave alone');

    // Two writers keep the rule they had: the later one is refused and told who.
    const late = await connectAgent('lab-b1', 'device-b');
    const second = await startRun(late, 'PD-24 Carrier retries', [path_('src/carrier.mjs')]);
    const refused = await guard(late, second.runId, 'src/carrier.mjs');
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBe('work_conflict');
    expect(refused.conflictAgents.join(' ')).toContain('lab-a1');
    expect(refused.conflictAgents.join(' ')).not.toContain('lab-a2');
    for (const [agent, run] of [[reviewer, review.runId], [builder, build.runId], [late, second.runId]] as const) await finish(agent, run);
  });
});

describe('ground that moved', () => {
  it('is acknowledged by an update_run that restates it, whichever source the agent names', async () => {
    const hooked = await connectAgent('lab-b1-footer', 'device-b');
    const other = await connectAgent('lab-a1-title', 'device-a');
    // A hook-owned run, started before anything moved and holding nothing yet.
    const run = await startRun(hooked, 'PD-26 Footer');
    const done = await startRun(other, 'PD-25 Title', [path_('public/index.html')]);
    await finish(other, done.runId);

    expect(await guard(hooked, run.runId, 'public/index.html')).toMatchObject({ allowed: false, reason: 'stale_ground' });
    // Exactly what the refusal says to do, the way the Mac round's b1 did it.
    const restated = await call(
      'update_run',
      { run_id: run.runId, scope: [{ type: 'path', key: 'public/index.html', access: 'write' }], scope_source: 'observed' },
      hooked.token,
    );
    expect(restated.isError, restated.text).toBe(false);
    // The same reply names what moved: the agent is told as it acknowledges.
    expect(JSON.stringify(restated.data.staleContext)).toContain('public/index.html');
    expect(await guard(hooked, run.runId, 'public/index.html')).toMatchObject({ allowed: true, reason: 'scope_reserved' });
    await finish(hooked, run.runId);
  });

  it('is never acknowledged by the hook reporting the dirty worktree, and an acknowledgment survives it', async () => {
    const hooked = await connectAgent('lab-b2-app', 'device-b');
    const other = await connectAgent('lab-a2-app', 'device-a');
    const run = await startRun(hooked, 'PD-30 Filters');
    expect(await guard(hooked, run.runId, 'public/app.js')).toMatchObject({ allowed: true });
    // The edit happened: the hook reports the file as dirty on its heartbeats.
    const dirty = { claims: [path_('public/app.js')], claimSource: 'observed' };
    expect((await api(hooked, `/api/agent/runs/${run.runId}/heartbeat`, dirty)).status).toBe(200);

    const moved = await startRun(other, 'PD-31 Filters too', [path_('public/app.js')]);
    await finish(other, moved.runId);
    // Heartbeats keep arriving while the agent works. None of them was a person
    // or an agent being told that the ground moved.
    expect((await api(hooked, `/api/agent/runs/${run.runId}/heartbeat`, dirty)).status).toBe(200);
    expect(await guard(hooked, run.runId, 'public/app.js')).toMatchObject({ allowed: false, reason: 'stale_ground' });

    const restated = await call(
      'update_run',
      { run_id: run.runId, scope: [{ type: 'path', key: 'public/app.js', access: 'write' }], scope_source: 'observed' },
      hooked.token,
    );
    expect(restated.isError, restated.text).toBe(false);
    // The next heartbeat reports another dirty file and rewrites every observed
    // row: the acknowledgment is not one of them, so it is still there.
    const elsewhere = { claims: [path_('public/styles.css')], claimSource: 'observed' };
    expect((await api(hooked, `/api/agent/runs/${run.runId}/heartbeat`, elsewhere)).status).toBe(200);
    expect(await guard(hooked, run.runId, 'public/app.js')).toMatchObject({ allowed: true });
    await finish(hooked, run.runId);
  });

  it('names a live holder rather than the ground that moved, when both stand in the way', async () => {
    const hooked = await connectAgent('lab-b1-banner', 'device-b');
    const finisher = await connectAgent('lab-a1-banner', 'device-a');
    const holder = await connectAgent('lab-a2-banner', 'device-a');
    const run = await startRun(hooked, 'PD-40 Banner');
    const moved = await startRun(finisher, 'PD-41 Banner copy', [path_('public/banner.html')]);
    await finish(finisher, moved.runId);
    const holding = await startRun(holder, 'PD-42 Banner colours', [path_('public/banner.html')]);

    const refused = await guard(hooked, run.runId, 'public/banner.html');
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBe('work_conflict');
    expect(refused.conflictAgents.join(' ')).toContain('lab-a2-banner');

    // Once the holder lets go, the moved ground is what is left to report.
    await finish(holder, holding.runId);
    expect(await guard(hooked, run.runId, 'public/banner.html')).toMatchObject({ allowed: false, reason: 'stale_ground' });
    await finish(hooked, run.runId);
  });
});

describe('a handoff on a branch', () => {
  const handoff: NewsHandoff = {
    kind: 'handoff',
    state: 'offered',
    sessionId: '00000000-0000-4000-8000-00000000c3a1',
    team: 'round',
    title: 'Handoff: parcel-desk-agent-lab',
    from: 'lab-lead',
    at: '2026-09-23T14:41:57.000Z',
    assignedTo: { agent: 'lab-b2', device: 'device-b', thisAgent: true },
    resume: { branch: 'lab/a1', steps: ['Show the ETA priority as a badge in the parcel table'], reclaim: null },
  };

  it('says the work continues on that branch and that switching to it is the handoff', () => {
    const text = renderNews([handoff], 0)!;
    expect(text).toContain('work handed over to this agent by name');
    expect(text).toContain('The work continues on `lab/a1`');
    expect(text).toContain('not a new branch');
    expect(text).toContain('commit and push on `lab/a1`');
    expect(text).toContain('never running one copied from the brief');
    expect(text).toContain('unless they object');
    // The sentence the receiver read as "this handoff is not for me".
    expect(text).not.toContain('only on the branch this checkout is already on');
    expect(text).not.toContain('Assigned work:');
  });

  it('keeps the current-branch rule for an assignment and for a handoff with no branch', () => {
    const assignment = renderNews([{ ...handoff, kind: 'assignment', sessionId: '00000000-0000-4000-8000-00000000c3a2', resume: { branch: null, steps: [], reclaim: null } }], 0)!;
    expect(assignment).toContain('only on the branch this checkout is already on');
    expect(assignment).not.toContain('Handed-over work:');

    const intent = renderNews([{ ...handoff, sessionId: '00000000-0000-4000-8000-00000000c3a3', resume: { branch: null, steps: [], reclaim: null } }], 0)!;
    expect(intent).toContain('verify the repository identity and the exact commit in this checkout');
    expect(intent).not.toContain('The work continues on');
  });
});
