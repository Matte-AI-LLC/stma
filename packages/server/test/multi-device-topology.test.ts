import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { and, desc, eq, gt } from 'drizzle-orm';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';
import { agentEvents, agentRuns, policyReceipts, projects, teams, workClaims, users } from '../src/db/schema';
import { markRead, sessionStats } from '../src/lib/sessions';
import { connectorAsset } from '../src/lib/connectorAsset';
import postgres from 'postgres';
import { memberships } from '../src/db/schema';
import { publishPolicy } from '../src/domain/policies';
import { policyDocumentSchema } from '@bridge/shared';

// Four independent authenticated installations, not four calls with one PAT.
// Optional disposable PG mode starts two HTTP servers with independent DB pools;
// embedded mode proves protocol semantics, never physical-device acceptance.
let a: StartedServer;
let b: StartedServer;
let temporary = '';
let cookie = '';
let teamId = '';
let projectId = '';
let userId = '';
let counter = 0;
const REPO = 'github.com/example/parcel-topology';
type Client = { token: string; id: string; device: string; name: string; worktree: string };
const clients: Client[] = [];
const form = (pathname: string, body: Record<string, string>, jar = cookie) => fetch(a.url + pathname, {
  method: 'POST', headers: { cookie: jar, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), redirect: 'manual',
});
const api = (client: Client, endpoint: string, body: unknown = {}) => fetch((counter++ % 2 ? b : a).url + endpoint, {
  method: 'POST', headers: { authorization: `Bearer ${client.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body),
});
async function tool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const response = await api(client, '/mcp', { jsonrpc: '2.0', id: counter + 1, method: 'tools/call', params: { name, arguments: args } });
  expect(response.status).toBe(200);
  const raw: any = await response.json();
  return { error: raw.result?.isError === true, data: raw.result?.isError ? raw.result.content[0].text : JSON.parse(raw.result.content[0].text) };
}
async function start(client: Client, suffix: string, claims: any[] = []) {
  const response = await api(client, '/api/agent/runs/start', { requestId: randomUUID(), installationId: client.id, team: 'topology-lab', project: 'parcel-topology', repositoryIdentity: REPO, worktree: client.worktree, taskKey: suffix, claims });
  expect(response.status).toBe(200);
  return await response.json() as any;
}
const claim = (file: string) => ({ resourceType: 'path', resourceKey: file, access: 'write' });
async function guard(client: Client, runId: string, file: string) {
  const response = await api(client, `/api/agent/runs/${runId}/write-guard`, { claims: [claim(file)], repositoryIdentity: REPO, worktree: client.worktree });
  expect(response.status).toBe(200);
  return await response.json() as any;
}
async function finish(client: Client, id: string) {
  const response = await api(client, `/api/agent/runs/${id}/finish`, { status: 'completed' });
  expect(response.status).toBe(200);
}

beforeAll(async () => {
  temporary = mkdtempSync(path.join(tmpdir(), 'stma-topology-'));
  const url = process.env.STMA_TOPOLOGY_DATABASE_URL;
  if (url) {
    const parsed = new URL(url);
    if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || !parsed.pathname.startsWith('/stma_topology_')) throw new Error('Topology PG tests require a disposable loopback stma_topology_* database.');
    const probe = postgres(url, { max: 1 });
    try {
      const rows = await probe`select count(*)::int as n from information_schema.tables where table_schema in ('public', 'drizzle')`;
      if (rows[0]?.n !== 0) throw new Error('Topology database must be empty. No existing data was removed.');
    } finally { await probe.end(); }
  }
  const env = loadEnv({ host: '127.0.0.1', port: 0, nodeEnv: 'test', devMode: true, databaseUrl: url, pgliteDir: temporary });
  a = await startServer(env);
  b = url ? await startServer(env) : a;
  const login = await form('/auth/dev', { username: 'topology-owner' }, '');
  cookie = login.headers.getSetCookie().map((item) => item.split(';')[0]).join('; ');
  expect((await form('/app/teams', { name: 'Topology Lab' })).status).toBe(302);
  teamId = (await a.db.select().from(teams).where(eq(teams.slug, 'topology-lab')))[0]!.id;
  userId = (await a.db.select().from(users).where(eq(users.username, 'topology-owner')))[0]!.id;
  const [project] = await a.db.insert(projects).values({ teamId, name: 'parcel-topology', slug: 'parcel-topology', repositoryIdentity: REPO }).returning();
  projectId = project!.id;
  for (const device of ['machine-a', 'machine-b']) for (const vendor of ['claude-code', 'codex']) {
    const name = `${device}-${vendor}`;
    const prompt = await form('/app/tokens', { name, device, client: vendor, role: 'generalist', access: `project:${projectId}` });
    expect(prompt.status).toBe(200);
    const code = /stma_enroll_[a-f0-9]{40}/.exec(await prompt.text())?.[0];
    expect(code).toBeTruthy();
    const response = await fetch(a.url + '/api/agent-enrollments/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, protocolVersion: 2 }) });
    expect(response.status).toBe(200);
    const data: any = await response.json();
    const client = { token: data.token, id: data.installation.id, device, name, worktree: `/work/${device}/${vendor}` };
    clients.push(client);
    const identity = await tool(client, 'whoami');
    expect(identity.error).toBe(false);
    expect(identity.data.credential).toMatchObject({ installationId: client.id, device, scope: 'project', project: 'parcel-topology' });
  }
});
afterAll(async () => { if (b && b !== a) await b.close(); await a?.close(); if (temporary) rmSync(temporary, { recursive: true, force: true }); });

it('keeps two-device/one-agent and two-device/two-agent topology identities distinct', async () => {
  expect(new Set(clients.map((c) => c.id)).size).toBe(4);
  expect(new Set(clients.map((c) => c.device)).size).toBe(2);
  for (const fleet of [[clients[0]!, clients[2]!], clients]) {
    const runs = await Promise.all(fleet.map((c) => start(c, 'same-task', [claim(`shared-${fleet.length}.js`)])));
    expect(new Set(runs.map((r) => r.run.id)).size).toBe(fleet.length);
    // At most one concurrent first publisher can observe an empty scope.
    expect(runs.filter((r) => !r.conflicts.length)).toHaveLength(1);
    const live = await tool(fleet[0]!, 'list_active_agents');
    expect(live.error).toBe(false);
    await Promise.all(runs.map((r, i) => finish(fleet[i]!, r.run.id)));
  }
});

it('serializes simultaneous scope changes, not only starts, across independent connections', async () => {
  const runs = await Promise.all(clients.map((c) => start(c, 'heartbeat-race')));
  const responses = await Promise.all(runs.map((r, i) => api(clients[i]!, `/api/agent/runs/${r.run.id}/heartbeat`, { claims: [claim('race/update.js')] })));
  const replies = await Promise.all(responses.map((r) => r.json() as Promise<any>));
  expect(responses.every((r) => r.status === 200)).toBe(true);
  expect(replies.filter((r) => r.conflicts.length === 0)).toHaveLength(1);
  await Promise.all(runs.map((r, i) => finish(clients[i]!, r.run.id)));
});

it('does not let one agent read a message on behalf of the other three or its human', async () => {
  const sender = clients[0]!;
  const opened = await tool(sender, 'open_session', { title: 'Four independent inboxes', body: 'A non-secret status update.' });
  expect(opened.error).toBe(false);
  const id = opened.data.sessionId;
  const unread = async (index: number) => {
    const result = await tool(clients[index]!, 'list_sessions');
    return result.data.sessions.find((s: any) => s.sessionId === id)?.unread;
  };
  expect(await unread(1)).toBe(1);
  expect((await tool(clients[1]!, 'get_session', { session_id: id })).error).toBe(false);
  expect(await unread(1)).toBe(0);
  expect(await unread(2)).toBe(1);
  expect(await unread(3)).toBe(1);
  expect((await sessionStats(a.db, { userId }, [id])).unread.get(id)).toBe(1);
  await markRead(a.db, userId, id); // The browser has its own cursor too.
  expect(await unread(2)).toBe(1);
  expect((await tool(clients[2]!, 'get_session', { session_id: id })).error).toBe(false);
  expect(await unread(3)).toBe(1);
});

it('rejects cross-agent lifecycle writes despite sharing the same human and project', async () => {
  const run = await start(clients[0]!, 'owned-run');
  for (const endpoint of ['heartbeat', 'finish', 'policy-receipt', 'write-guard']) {
    const body = endpoint === 'write-guard' ? { claims: [claim('owned.js')], repositoryIdentity: REPO, worktree: clients[1]!.worktree } : endpoint === 'policy-receipt' ? { expectedHash: 'a'.repeat(64) } : {};
    expect((await api(clients[1]!, `/api/agent/runs/${run.run.id}/${endpoint}`, body)).status).toBe(403);
  }
  expect((await tool(clients[1]!, 'update_run', { run_id: run.run.id })).error).toBe(true);
  await finish(clients[0]!, run.run.id);
});

it('grants only one simultaneous file reservation and audits denials without claiming local execution', async () => {
  const runs = await Promise.all(clients.map((c) => start(c, 'guard-race')));
  const decisions = await Promise.all(runs.map((r, i) => guard(clients[i]!, r.run.id, 'guard/shared.js')));
  expect(decisions.filter((d) => d.allowed)).toHaveLength(1);
  expect(decisions.filter((d) => !d.allowed).every((d) => d.reason === 'work_conflict')).toBe(true);
  const winner = decisions.findIndex((d) => d.allowed);
  for (let i = 0; i < clients.length; i++) {
    const held = await a.db.select().from(workClaims).where(and(eq(workClaims.runId, runs[i].run.id), gt(workClaims.leaseExpiresAt, new Date())));
    expect(held).toHaveLength(i === winner ? 1 : 0);
    const audit = await a.db.select().from(agentEvents).where(and(eq(agentEvents.runId, runs[i].run.id), eq(agentEvents.type, 'write_guard_decision')));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.detail).toMatchObject({ installationId: clients[i]!.id, allowed: i === winner });
  }
  const wrongCheckout = await api(clients[winner]!, `/api/agent/runs/${runs[winner].run.id}/write-guard`, { claims: [claim('guard/other.js')], repositoryIdentity: 'github.com/unrelated/repo', worktree: clients[winner]!.worktree });
  expect((await wrongCheckout.json() as any).allowed).toBe(false);
  await Promise.all(runs.map((r, i) => finish(clients[i]!, r.run.id)));
});

it('lets the run that was on the ground first keep writing, and makes the later one wait', async () => {
  // Measured in the agent lab, 2026-09-20: a1 held a file, b1 declared it later and
  // stopped as asked, and a1 — told of "a conflict" on its next heartbeat — stopped
  // too, its work done and unreported. The guard was symmetric as well: declaring a
  // file another run was editing refused that run's next edit.
  const file = 'right-of-way/shared.js';
  const scope = (key: string) => [{ type: 'path', key, access: 'write' }];
  const first = await start(clients[0]!, 'right-of-way-first');
  const later = await start(clients[1]!, 'right-of-way-later');
  expect((await guard(clients[0]!, first.run.id, file)).allowed).toBe(true);

  // The later run declares the file the way an agent does, as planned scope.
  const declared = await tool(clients[1]!, 'update_run', { run_id: later.run.id, scope: scope(file) });
  expect(declared.error, JSON.stringify(declared.data)).toBe(false);
  expect(declared.data.conflicts).toHaveLength(1);
  expect(declared.data.conflicts[0]).toMatchObject({ rightOfWay: 'theirs', heldBy: expect.stringContaining(clients[0]!.name) });
  expect(declared.data.conflictAdvice).toContain('Another live run overlaps your scope');
  expect(await guard(clients[1]!, later.run.id, file)).toMatchObject({ allowed: false, reason: 'work_conflict' });

  // Having declared it does not stop the run that was there.
  const stillMine = await guard(clients[0]!, first.run.id, file);
  expect(stillMine).toMatchObject({ allowed: true, conflictRuns: [] });
  expect(stillMine.waitingAgents).toEqual([expect.stringContaining(clients[1]!.name)]);
  // Restating scope rewrites the claim; who was first survives it, and the holder
  // is told to carry on rather than to stop.
  const heard = await tool(clients[0]!, 'update_run', { run_id: first.run.id, scope: scope(file) });
  expect(heard.data.conflicts[0]).toMatchObject({ rightOfWay: 'yours' });
  expect(heard.data.conflictAdvice).toContain('You were first');
  expect(heard.data.conflictAdvice).not.toContain('STOP');
  expect((await guard(clients[0]!, first.run.id, file)).allowed).toBe(true);
  // The lead reads the same fact on the map: red for both, and who yields.
  const map = async (run: string) => (await fetch(`${a.url}/app/agents?run=${run}`, { headers: { cookie } })).text();
  expect(await map(first.run.id)).toContain('declared it first and keeps the right of way');
  expect(await map(later.run.id)).toContain('The other run declared it first');

  // Ground let go and declared again starts over: the other run holds it now.
  expect((await tool(clients[0]!, 'update_run', { run_id: first.run.id, scope: scope('right-of-way/other.js') })).error).toBe(false);
  expect((await guard(clients[1]!, later.run.id, file)).allowed).toBe(true);
  expect(await guard(clients[0]!, first.run.id, file)).toMatchObject({ allowed: false, reason: 'work_conflict' });
  await finish(clients[0]!, first.run.id);
  await finish(clients[1]!, later.run.id);
});

it('says what the run holding the ground is doing and how long it holds it for', async () => {
  // Found in the first two-device round: told only that ground was held, the
  // blocked agent offered to "retry in five minutes" — it had guessed from its
  // own lease. A run that stopped to ask a person keeps its claims for the
  // waiting lease, six times the active one, and retrying is the wrong move
  // anyway: nothing will free that ground until the other human answers.
  const file = 'holder-state/config.ts';
  const scope = (key: string) => [{ type: 'path', key, access: 'write' }];
  const holder = await start(clients[0]!, 'holder-state-holder');
  const blocked = await start(clients[1]!, 'holder-state-blocked');
  expect((await guard(clients[0]!, holder.run.id, file)).allowed).toBe(true);

  // While it is working, the collision reports work in progress and the active lease.
  const working = await tool(clients[1]!, 'update_run', { run_id: blocked.run.id, scope: scope(file) });
  expect(working.data.conflicts[0]).toMatchObject({ theirState: 'active' });
  expect(working.data.conflicts[0].holder).toContain('working');
  expect(new Date(working.data.conflicts[0].theirLeaseEndsAt).getTime()).toBeGreaterThan(Date.now());
  expect(working.data.conflictAdvice).not.toContain('will not free the ground');

  // The holder stops to ask its human. The state travels; so does the longer lease.
  const activeLeaseEnds = new Date(working.data.conflicts[0].theirLeaseEndsAt).getTime();
  expect((await tool(clients[0]!, 'update_run', { run_id: holder.run.id, status: 'waiting', scope: scope(file) })).error).toBe(false);
  const parked = await tool(clients[1]!, 'update_run', { run_id: blocked.run.id, scope: scope(file) });
  expect(parked.data.conflicts[0]).toMatchObject({ theirState: 'waiting' });
  expect(parked.data.conflicts[0].holder).toContain('stopped to ask a person');
  expect(parked.data.conflicts[0].holder).toMatch(/holds it for about another \d+ minutes/);
  expect(new Date(parked.data.conflicts[0].theirLeaseEndsAt).getTime()).toBeGreaterThan(activeLeaseEnds);
  // "Wait for it to finish" is the wrong instruction for a run that is itself waiting.
  expect(parked.data.conflictAdvice).toContain('will not free the ground by itself');

  // The guard the hook reads answers the same, and the map says it in the same words.
  const refused = await guard(clients[1]!, blocked.run.id, file);
  expect(refused).toMatchObject({ allowed: false, reason: 'work_conflict', conflictNeedsAPerson: true });
  expect(refused.conflictAgents[0]).toContain('stopped to ask a person');
  const inspector = await (await fetch(`${a.url}/app/agents?run=${blocked.run.id}`, { headers: { cookie } })).text();
  expect(inspector).toContain('stopped to ask a person');
  expect(inspector).toContain('will not free the ground by itself');

  await finish(clients[0]!, holder.run.id);
  await finish(clients[1]!, blocked.run.id);
});

it('verifies a resume that comes after the first commit by where the receiving run began', async () => {
  // Measured in the agent lab, 2026-09-20: the receiver accepted, built the badge,
  // committed and pushed, and only then called resume. HEAD had moved, so what it
  // observed could never match the handed-over commit again, and the handoff sat in
  // `accepted` with its work done and no way to close it.
  const handedOver = 'c'.repeat(40);
  const source = await start(clients[0]!, 'late-resume-source');
  const offered = await tool(clients[0]!, 'handoff_work', {
    request_id: randomUUID(),
    run_id: source.run.id,
    branch: 'main',
    summary: 'Badge column is sketched; the receiver finishes it.',
    next_steps: ['Add the badge', 'Run the tests'],
    reason: 'end_of_day',
    checkpoint: { request_id: randomUUID(), kind: 'tested', repository_identity: REPO, commit_sha: handedOver, worktree_clean: true, tests: [{ name: 'fixture baseline', state: 'passed' }] },
  });
  expect(offered.error, JSON.stringify(offered.data)).toBe(false);
  const session = offered.data.sessionId as string;
  const begin = (task: string, commit: string) => tool(clients[1]!, 'start_run', {
    request_id: randomUUID(), team: 'topology-lab', project: 'parcel-topology', repository_identity: REPO, task,
    checkpoint: { request_id: randomUUID(), kind: 'start', repository_identity: REPO, commit_sha: commit, worktree_clean: true, tests: [] },
  });
  const receiving = await begin('late-resume-receiver', handedOver);
  expect(receiving.error, JSON.stringify(receiving.data)).toBe(false);
  const accepted = await tool(clients[1]!, 'update_handoff', { session_id: session, action: 'accept' });
  expect(accepted.error, JSON.stringify(accepted.data)).toBe(false);
  // Code arrived, so the reply says when the resume belongs.
  expect(accepted.data.next.when).toBe('before you change anything in the checkout');

  // The receiver commits, then resumes: a clean checkout of the right repository, one commit on.
  const moved = { session_id: session, action: 'resume', repository_identity: REPO, commit_sha: 'a'.repeat(40), worktree_clean: true };
  // A run that began somewhere else proves nothing about this handoff.
  const elsewhere = await begin('late-resume-elsewhere', 'e'.repeat(40));
  const unproven = await tool(clients[1]!, 'update_handoff', { ...moved, run_id: elsewhere.data.runId });
  expect(unproven.error).toBe(true);
  expect(unproven.data).toContain('Resume commit mismatch');
  expect(unproven.data).toContain('send run_id of the run that began there');
  expect((await tool(clients[1]!, 'finish_run', { run_id: elsewhere.data.runId })).error).toBe(false);
  // Neither does another repository or a dirty worktree, whatever the run's start says.
  for (const wrong of [{ repository_identity: 'github.com/unrelated/repo' }, { worktree_clean: false }]) {
    const refused = await tool(clients[1]!, 'update_handoff', { ...moved, ...wrong, run_id: receiving.data.runId });
    expect(refused.error, JSON.stringify(refused.data)).toBe(true);
    expect(refused.data).not.toContain('send run_id of the run that began there');
  }

  const resumed = await tool(clients[1]!, 'update_handoff', { ...moved, run_id: receiving.data.runId });
  expect(resumed.error, JSON.stringify(resumed.data)).toBe(false);
  expect(resumed.data.handoff.state).toBe('in_progress');
  expect(resumed.data.verification).toMatchObject({ verified: true, commitSha: handedOver, basis: 'receiving_run_start' });
  expect((await tool(clients[1]!, 'update_handoff', { session_id: session, action: 'complete' })).error).toBe(false);
  expect((await tool(clients[1]!, 'finish_run', { run_id: receiving.data.runId })).error).toBe(false);
});

it('allows only one of three agents to accept an open handoff, across independent connections', async () => {
  const source = await start(clients[0]!, 'handoff-race');
  const offered = await tool(clients[0]!, 'handoff_work', {
    request_id: randomUUID(),
    run_id: source.run.id,
    branch: 'main',
    summary: 'No source edits; resume from the fixture baseline.',
    next_steps: ['Inspect before editing.'],
    reason: 'end_of_day',
    checkpoint: {
      request_id: randomUUID(),
      kind: 'tested',
      repository_identity: REPO,
      commit_sha: 'd'.repeat(40),
      worktree_clean: true,
      tests: [{ name: 'fixture baseline', state: 'passed' }],
    },
  });
  expect(offered.error).toBe(false);
  const attempts = await Promise.all(clients.slice(1).map((client) => tool(client, 'update_handoff', { session_id: offered.data.sessionId, action: 'accept' })));
  expect(attempts.filter((reply) => !reply.error)).toHaveLength(1);
  const winner = clients[1 + attempts.findIndex((reply) => !reply.error)]!;
  const readback = await tool(clients[0]!, 'get_session', { session_id: offered.data.sessionId });
  expect(readback.data.handoff).toMatchObject({ state: 'accepted', installationId: winner.id });
});

it('rechecks protected paths and cumulative change budgets at the actual write boundary', async () => {
  const publish = async (document: unknown) => {
    const result = await publishPolicy(a.db, userId, { team: 'topology-lab', project: 'parcel-topology', document: policyDocumentSchema.parse(document) });
    expect('error' in result).toBe(false);
    expect('policy' in result && result.policy.projectId).toBe(projectId);
    expect(await a.db.select().from(projects).where(eq(projects.teamId, teamId))).toHaveLength(1);
  };
  const run = await start(clients[0]!, 'policy-at-write');
  try {
    await publish({ protectedPaths: ['db/**'], changeBudget: { maxPaths: 1 } });
    expect((await guard(clients[0]!, run.run.id, 'db/migration.sql')).reason).toBe('owner_approval_required');
    expect((await guard(clients[0]!, run.run.id, 'allowed/first.js')).allowed).toBe(true);
    expect((await guard(clients[0]!, run.run.id, 'allowed/second.js')).reason).toBe('change_budget_exceeded');
  } finally { await finish(clients[0]!, run.run.id); await publish({}); }
});

it('lets a run that waited its turn edit again once it re-declares the ground that moved', async () => {
  // Measured 2026-09-19 in the lead-first lab: B waited for A on one file, A
  // finished, and B was then refused with stale_ground for the rest of its run.
  const first = await start(clients[0]!, 'stale-first');
  expect((await guard(clients[0]!, first.run.id, 'stale/shared.js')).allowed).toBe(true);
  const second = await start(clients[1]!, 'stale-second', [claim('stale/shared.js')]);
  expect((await guard(clients[1]!, second.run.id, 'stale/shared.js')).reason).toBe('work_conflict');
  await finish(clients[0]!, first.run.id);
  // The ground moved after the second run declared it: refused once, by name.
  expect((await guard(clients[1]!, second.run.id, 'stale/shared.js')).reason).toBe('stale_ground');
  // Restating the scope is the acknowledgement; the advisory report on that
  // call still names what moved, and the next write goes through.
  const restated = await api(clients[1]!, `/api/agent/runs/${second.run.id}/heartbeat`, { status: 'active', claims: [claim('stale/shared.js')] });
  expect(restated.status).toBe(200);
  const report: any = await restated.json();
  expect(report.stale?.length ?? 0).toBe(1);
  expect((await guard(clients[1]!, second.run.id, 'stale/shared.js')).allowed).toBe(true);
  await finish(clients[1]!, second.run.id);
});

it('checks a second human, wrong workspace/project and membership removal on the live write gate', async () => {
  const login = await form('/auth/dev', { username: 'topology-colleague' }, '');
  const jar = login.headers.getSetCookie().map((item) => item.split(';')[0]).join('; ');
  const colleagueId = (await a.db.select().from(users).where(eq(users.username, 'topology-colleague')))[0]!.id;
  await a.db.insert(memberships).values({ teamId, userId: colleagueId, role: 'member' });
  const prompt = await form('/app/tokens', { name: 'colleague-machine', device: 'machine-c', client: 'codex', role: 'generalist', access: `project:${projectId}` }, jar);
  const code = /stma_enroll_[a-f0-9]{40}/.exec(await prompt.text())?.[0];
  expect(code).toBeTruthy();
  const response = await fetch(a.url + '/api/agent-enrollments/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, protocolVersion: 2 }) });
  const enrollment: any = await response.json();
  const colleague: Client = { token: enrollment.token, id: enrollment.installation.id, device: 'machine-c', name: 'colleague-machine', worktree: '/work/colleague' };
  expect((await tool(colleague, 'whoami')).error).toBe(false);
  const own = await start(clients[0]!, 'multiuser-owner');
  expect((await guard(clients[0]!, own.run.id, 'multiuser/shared.js')).allowed).toBe(true);
  const peer = await start(colleague, 'multiuser-member');
  expect((await guard(colleague, peer.run.id, 'multiuser/shared.js')).reason).toBe('work_conflict');
  expect((await api(colleague, `/api/agent/runs/${own.run.id}/heartbeat`)).status).toBe(403);
  for (const scope of [{ team: 'unrelated-team', project: 'parcel-topology' }, { team: 'topology-lab', project: 'unrelated-project' }]) {
    expect((await api(colleague, '/api/agent/runs/start', { requestId: randomUUID(), installationId: colleague.id, ...scope, repositoryIdentity: REPO, worktree: colleague.worktree })).status).toBe(403);
  }
  expect((await form(`/app/teams/topology-lab/members/${colleagueId}/remove`, {})).status).toBe(302);
  const rejected = await api(colleague, `/api/agent/runs/${peer.run.id}/write-guard`, { claims: [claim('multiuser/new.js')], repositoryIdentity: REPO, worktree: colleague.worktree });
  expect([401, 403]).toContain(rejected.status);
  expect((await tool(clients[0]!, 'whoami')).error).toBe(false);
  await finish(clients[0]!, own.run.id);
});

it('executes the shipped native runtime in two isolated checkouts, blocks a real pre-tool request and keeps payloads private', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'stma-native-topology-'));
  const dirs: string[] = [];
  const hookOwnedRuns: string[] = [];
  try {
    const artifact = connectorAsset('agent-runtime');
    const response = await fetch(a.url + artifact.path);
    expect(response.status).toBe(200);
    const script = await response.text();
    expect(script).toBe(artifact.source);
    const downloaded = path.join(root, 'downloaded.mjs');
    writeFileSync(downloaded, script);
    const run = (index: number, args: string[], payload?: unknown, offline = false) => new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
      const child = spawn(process.execPath, [downloaded, ...args], {
        cwd: dirs[index], env: { ...process.env, STMA_URL: offline ? 'http://127.0.0.1:1' : a.url, STMA_TOKEN: clients[index]!.token }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject); child.once('close', (code) => resolve({ stdout, stderr, code }));
      child.stdin.end(JSON.stringify(payload ?? {}));
    });
    for (let i = 0; i < 2; i++) {
      dirs.push(mkdtempSync(path.join(root, `checkout-${i}-`)));
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dirs[i], stdio: 'pipe' });
      git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
      git('remote', 'add', 'origin', 'https://' + REPO + '.git');
      writeFileSync(path.join(dirs[i]!, 'native.js'), '// untouched\n');
      git('add', 'native.js'); git('commit', '-m', 'Fixture baseline');
      const installed = await run(i, ['adapter', 'install', '--target', i ? 'codex' : 'claude-code', '--team', 'topology-lab', '--project', 'parcel-topology', '--name', clients[i]!.name, '--profile', 'native', '--policy=false', '--preflight=false', '--write-guard=true', '--pin-runtime', '--apply']);
      expect(installed.code).toBe(0);
      expect(git('status', '--porcelain').toString()).toBe('');
      const started = await run(i, ['adapter', 'hook', '--event', 'start', '--profile', 'native'], { session_id: `session-${i}`, hook_event_name: 'UserPromptSubmit', prompt: 'SECRET-NOT-COLLECTED' });
      expect(started.code).toBe(0); expect(started.stdout).toContain('native tracking owns run');
      expect(started.stdout).not.toContain('SECRET-NOT-COLLECTED');
      // The run the hook owns answers for itself. Before this, every hook-owned
      // run sat on the governance page as `?` — it reads as a run nobody is
      // checking — because only the agent could send update_run { policy_hash }
      // and no agent ever remembered to. `--policy=false` is on: the hash is
      // recomputed from the document run start returned, and nothing was written
      // into the checkout, which the clean `git status` above already asserts.
      const [hooked] = await a.db.select().from(agentRuns)
        .where(eq(agentRuns.installationId, clients[i]!.id)).orderBy(desc(agentRuns.startedAt)).limit(1);
      const [receipt] = await a.db.select().from(policyReceipts).where(eq(policyReceipts.runId, hooked!.id));
      expect(receipt?.reportedHash, 'the hook filed a receipt for its own run').toBeTruthy();
      expect(receipt!.reportedHash).toBe(receipt!.expectedHash);
      expect(receipt!.drift).toBe(false);
      hookOwnedRuns.push(hooked!.id);
      const pinned = readdirSync(path.join(dirs[i]!, '.stma')).find((name) => /^runtime-[a-f0-9]{64}\.mjs$/.test(name));
      expect(pinned).toBeTruthy();
      const version = JSON.parse(readFileSync(new URL('../../cli/package.json', import.meta.url), 'utf8')).version;
      expect(execFileSync(process.execPath, [path.join(dirs[i]!, '.stma', pinned!), '--version'], { cwd: dirs[i], encoding: 'utf8' }).trim()).toBe(`stma ${version}`);
    }
    // And a person reading governance sees it, which is the point: that page
    // said "not reported" about every hook-owned run there had ever been.
    const governance = await (await fetch(`${a.url}/app/teams/topology-lab/governance`, { headers: { cookie } })).text();
    for (const id of hookOwnedRuns) {
      const at = governance.indexOf(`id="receipt-${id}"`);
      expect(at, 'the hook-owned run has a receipt row on the governance page').toBeGreaterThan(-1);
      const row = governance.slice(at, governance.indexOf('</tr>', at));
      expect(row).toContain('match');
      expect(row).not.toContain('not reported');
    }
    // A lead assigns work seconds after this checkout last asked for news, and the
    // human types straight away. Tool-use heartbeats stay at one check a minute; a
    // prompt always asks, or the assignment is announced one sentence too late.
    const assigned = await tool(clients[1]!, 'assign_work', { to_agent: clients[0]!.name, task: 'TOPO-9 Hear it now', brief: 'Nothing to do; this proves when the hook speaks.' });
    expect(assigned.error, JSON.stringify(assigned.data)).toBe(false);
    const quietHeartbeat = await run(0, ['adapter', 'hook', '--event', 'heartbeat', '--profile', 'native'], { session_id: 'session-0', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: path.join(dirs[0]!, 'native.js') } });
    expect(quietHeartbeat.stdout).not.toContain('TOPO-9');
    const nextPrompt = await run(0, ['adapter', 'hook', '--event', 'start', '--profile', 'native'], { session_id: 'session-0', hook_event_name: 'UserPromptSubmit', prompt: 'Devam.' });
    expect(nextPrompt.code, nextPrompt.stderr).toBe(0);
    expect(nextPrompt.stdout).toContain('TOPO-9 Hear it now');
    const payload = (i: number) => ({ session_id: `session-${i}`, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(dirs[i]!, 'native.js'), content: 'SECRET-NOT-COLLECTED' } });
    const first = await run(0, ['adapter', 'hook', '--event', 'guard', '--profile', 'native'], payload(0));
    expect(first.stdout.trim()).toBe('');
    const denied = await run(1, ['adapter', 'hook', '--event', 'guard', '--profile', 'native'], payload(1));
    expect(JSON.parse(denied.stdout).hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    expect(denied.stdout).toContain('work_conflict');
    const offline = await run(0, ['adapter', 'hook', '--event', 'guard', '--profile', 'native'], payload(0), true);
    expect(JSON.parse(offline.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    // A rule a machine can check. The path is this run's own ground, so the
    // server allows it; the shipped runtime then reads the text the edit would
    // add, stops it, and reports the rule and the path — never the text.
    const fontRule = 'content: "Comic Sans" in *.js — not in the design system';
    const teamPolicy = await publishPolicy(a.db, userId, { team: 'topology-lab', document: policyDocumentSchema.parse({ permissions: { deny: [fontRule] } }) });
    expect('error' in teamPolicy).toBe(false);
    const forbidden = await run(0, ['adapter', 'hook', '--event', 'guard', '--profile', 'native'], { session_id: 'session-0', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(dirs[0]!, 'native.js'), content: "body { font-family: 'Comic Sans MS'; } /* SECRET-NOT-COLLECTED */" } });
    const contentDeny = JSON.parse(forbidden.stdout).hookSpecificOutput;
    expect(contentDeny.permissionDecision).toBe('deny');
    expect(contentDeny.permissionDecisionReason).toContain('policy_content_denied');
    expect(contentDeny.permissionDecisionReason).toContain(fontRule);
    expect(forbidden.stdout).not.toContain('SECRET-NOT-COLLECTED');
    const guarded = JSON.parse(readFileSync(path.join(dirs[0]!, '.stma/profiles/native/state.json'), 'utf8'));
    const reported = (await a.db.select().from(agentEvents).where(eq(agentEvents.runId, guarded.currentRunId))).filter((row) => row.type === 'policy_violation');
    expect(reported).toHaveLength(1);
    expect(reported[0]!.detail).toMatchObject({ rule: fontRule, path: 'native.js', outcome: 'blocked', installationId: clients[0]!.id });
    expect(JSON.stringify(reported[0]!.detail)).not.toContain('SECRET');
    // The same file with compliant content still goes through.
    expect((await run(0, ['adapter', 'hook', '--event', 'guard', '--profile', 'native'], payload(0))).stdout.trim()).toBe('');
    // An upgraded CLI reaches a connected checkout by re-pinning, not by consenting again.
    const repinned = await run(0, ['adapter', 'repair', '--profile', 'native', '--pin-runtime', '--apply']);
    expect(repinned.code, repinned.stderr).toBe(0);
    expect(repinned.stdout).toContain('re-pinned');
    expect(readFileSync(path.join(dirs[0]!, '.claude/settings.local.json'), 'utf8')).toMatch(/runtime-[a-f0-9]{64}\.mjs/);
    expect((await run(0, ['adapter', 'hook', '--event', 'guard', '--profile', 'native'], payload(0))).stdout.trim()).toBe('');
    const retained = (directory: string): string => readdirSync(directory, { withFileTypes: true }).map((entry) => entry.isDirectory() ? retained(path.join(directory, entry.name)) : entry.name.endsWith('.json') ? readFileSync(path.join(directory, entry.name), 'utf8') : '').join('\n');
    for (let i = 0; i < 2; i++) {
      const serialized = retained(path.join(dirs[i]!, '.stma'));
      expect(serialized.includes('SECRET-NOT-COLLECTED')).toBe(false);
      expect(serialized.includes(clients[i]!.token)).toBe(false);
    }
    // A hook-owned run is one branch. Switching closes it and starts another on
    // the new branch, so a handoff received on a different branch can be resumed
    // from the commit the work actually began at (measured 2026-09-19).
    const beforeSwitch = JSON.parse(readFileSync(path.join(dirs[0]!, '.stma/profiles/native/state.json'), 'utf8')).currentRunId as string;
    execFileSync('git', ['checkout', '-q', '-b', 'feature/handoff'], { cwd: dirs[0], stdio: 'pipe' });
    const switched = await run(0, ['adapter', 'hook', '--event', 'heartbeat', '--profile', 'native'], { session_id: 'session-0', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: path.join(dirs[0]!, 'native.js') } });
    expect(switched.code, switched.stderr).toBe(0);
    expect(switched.stdout).toContain('switched from branch main to feature/handoff');
    const afterSwitch = JSON.parse(readFileSync(path.join(dirs[0]!, '.stma/profiles/native/state.json'), 'utf8')).currentRunId as string;
    expect(afterSwitch).not.toBe(beforeSwitch);
    expect((await a.db.select().from(agentRuns).where(eq(agentRuns.id, beforeSwitch)))[0]!.status).toBe('completed');
    expect((await a.db.select().from(agentRuns).where(eq(agentRuns.id, afterSwitch)))[0]!.branch).toBe('feature/handoff');
    // Staying on the branch is quiet.
    expect((await run(0, ['adapter', 'hook', '--event', 'heartbeat', '--profile', 'native'], { session_id: 'session-0', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: path.join(dirs[0]!, 'native.js') } })).stdout).not.toContain('switched from branch');
    for (let i = 0; i < 2; i++) {
      const stopped = await run(i, ['adapter', 'hook', '--event', 'heartbeat', '--profile', 'native'], { session_id: `session-${i}`, hook_event_name: 'Stop', tool_response: 'SECRET-NOT-COLLECTED' });
      expect(stopped.code).toBe(0);
      const local = JSON.parse(readFileSync(path.join(dirs[i]!, '.stma/profiles/native/state.json'), 'utf8'));
      const row = (await a.db.select().from(agentRuns).where(eq(agentRuns.id, local.currentRunId)))[0]!;
      expect(row.status).toBe('waiting');
      expect(readFileSync(path.join(dirs[i]!, 'native.js'), 'utf8')).toBe('// untouched\n');
      if (i === 0) {
        // The half a file-tool guard can never see. Nothing here goes through a
        // hooked tool: the content is written straight to disk, the way a shell
        // redirect, an editor, `git apply` or a generator would put it there.
        // Governance could say what was stopped and never what landed, which is
        // the one thing a content rule exists to answer.
        writeFileSync(path.join(dirs[0]!, 'landed.js'), "h1 { font-family: 'Comic Sans MS'; }\n");
        execFileSync('git', ['add', 'landed.js'], { cwd: dirs[0], stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', 'Landed another way'], { cwd: dirs[0], stdio: 'pipe' });
        // An untracked file too, which is where a generator's output usually is.
        writeFileSync(path.join(dirs[0]!, 'generated.js'), "/* Comic Sans, again */\n");
      }
      await run(i, ['adapter', 'hook', '--event', 'finish', '--profile', 'native'], { session_id: `session-${i}`, hook_event_name: 'SessionEnd' });
      expect((await a.db.select().from(agentRuns).where(eq(agentRuns.id, row.id)))[0]!.status).toBe('completed');
      if (i === 0) {
        const landed = (await a.db.select().from(agentEvents).where(eq(agentEvents.runId, row.id)))
          .filter((event) => event.type === 'policy_violation');
        expect(landed.map((event) => (event.detail as { path?: string }).path).sort()).toEqual([
          'generated.js',
          'landed.js',
        ]);
        for (const event of landed) {
          expect(event.detail).toMatchObject({ rule: fontRule, outcome: 'present', installationId: clients[0]!.id });
          // Same boundary as the guard: the rule's published words and a path,
          // never a line of what was written.
          expect(JSON.stringify(event.detail)).not.toContain('font-family');
          expect(JSON.stringify(event.detail)).not.toContain('Comic Sans MS');
        }
        // And a lead reads it on the page, told apart from an edit that was stopped.
        const page = await (await fetch(`${a.url}/app/teams/topology-lab/governance`, { headers: { cookie } })).text();
        expect(page).toContain('in the checkout');
        expect(page).toContain('landed.js');
        expect(page).not.toContain('font-family');
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('allows nonoverlapping files on four installations and revokes exactly one', async () => {
  const runs = await Promise.all(clients.map((c) => start(c, 'isolated-work')));
  const decisions = await Promise.all(runs.map((r, i) => guard(clients[i]!, r.run.id, `isolated/${i}.js`)));
  expect(decisions.every((d) => d.allowed)).toBe(true);
  expect((await api(clients[0]!, '/api/agent-enrollments/self-revoke')).status).toBe(200);
  expect((await api(clients[0]!, '/mcp')).status).toBe(401);
  for (let i = 1; i < clients.length; i++) {
    expect((await tool(clients[i]!, 'whoami')).error).toBe(false);
    expect((await api(clients[i]!, `/api/agent/runs/${runs[i].run.id}/heartbeat`, {})).status).toBe(200);
    await finish(clients[i]!, runs[i].run.id);
  }
  const revoked = (await a.db.select().from(agentRuns).where(eq(agentRuns.id, runs[0].run.id)))[0]!;
  expect(revoked.status).toBe('stale');
});
