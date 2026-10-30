import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq, ne, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  agentInstallations,
  agentRuns,
  debugSessions,
  handoffs,
  launchAttempts,
  memberships,
  projects,
  runCheckpoints,
  savingConfirmations,
  teams,
  tokens,
  users,
} from '../src/db/schema';
import {
  ACTIVATION_CHECKPOINT_SCAN,
  ACTIVATION_SMALL_N,
  activationCohorts,
  classifyAccounts,
  excludedWorkspaces,
  repeatUse,
  workspaceActivation,
} from '../src/domain/activation';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

/**
 * The first value path is an operator-side reading of stored rows, so what is
 * tested is how it could mislead: a connection counted as activation, the
 * founder's own demo counted as a customer, two people counted as two
 * customers, a rate printed from three workspaces, a midnight read as a return,
 * and a number that changes when a report is replayed.
 *
 * Rows are written through srv.db where the product writes them in passing; the
 * idempotency case goes through the real tools.
 */

let srv: StartedServer;
let dataDir: string;
const env = { adminUsernames: ['ops'], adminEmails: [] as string[] };
const cookies: Record<string, Record<string, string>> = {};

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const T0 = new Date('2026-10-01T10:00:00.000Z');
const at = (days: number, hours = 0) => new Date(T0.getTime() + days * DAY + hours * HOUR);
const NOW = at(10);

function jar() {
  const store = new Map<string, string>();
  return {
    header: (): Record<string, string> =>
      store.size ? { cookie: [...store].map(([k, v]) => `${k}=${v}`).join('; ') } : {},
    store(res: Response) {
      for (const line of res.headers.getSetCookie()) {
        const [kv] = line.split(';');
        const i = kv!.indexOf('=');
        store.set(kv!.slice(0, i), kv!.slice(i + 1));
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

async function login(username: string) {
  const j = jar();
  const res = await form(`${srv.url}/auth/dev`, { username });
  expect(res.status).toBe(302);
  j.store(res);
  cookies[username] = j.header();
}

const get = (who: string, pathname: string) =>
  fetch(`${srv.url}${pathname}`, { headers: cookies[who], redirect: 'manual' });

let seq = 0;
const uniq = (prefix: string) => `${prefix}-${++seq}`;

async function mkUser(username: string, o: Partial<typeof users.$inferInsert> = {}) {
  const [row] = await srv.db.insert(users).values({ username, ...o }).returning();
  return row!;
}

async function mkTeam(createdBy: string, members: Array<{ id: string; role?: string }>, createdAt: Date = T0) {
  const name = uniq('ws');
  const [team] = await srv.db.insert(teams).values({ name, slug: name, createdBy, createdAt, inboundToken: randomUUID() }).returning();
  await srv.db.insert(memberships).values(members.map((m) => ({ teamId: team!.id, userId: m.id, role: m.role ?? 'member' })));
  return team!;
}

async function mkProject(teamId: string) {
  const name = uniq('proj');
  const [p] = await srv.db.insert(projects).values({ teamId, name, slug: name, repositoryIdentity: `github.com/acme/${name}` }).returning();
  return p!;
}

async function mkInstall(userId: string) {
  const [i] = await srv.db
    .insert(agentInstallations)
    .values({ userId, name: uniq('agent'), deviceFingerprint: randomUUID(), createdAt: T0 })
    .returning();
  return i!;
}

async function mkRun(installationId: string, teamId: string, projectId: string | null, startedAt: Date = T0) {
  const [r] = await srv.db
    .insert(agentRuns)
    .values({ installationId, teamId, projectId, status: 'completed', startedAt, endedAt: startedAt })
    .returning();
  return r!;
}

const sha = (n: string) => createHash('sha1').update(n).digest('hex');

async function mkCheckpoint(
  run: typeof agentRuns.$inferSelect,
  o: {
    kind: 'start' | 'delivery' | 'tested';
    commit: string;
    at: Date;
    clean?: boolean;
    tests?: Array<{ name: string; state: string }>;
    requestId?: string;
  },
) {
  await srv.db.insert(runCheckpoints).values({
    runId: run.id,
    teamId: run.teamId,
    projectId: run.projectId,
    installationId: run.installationId,
    kind: o.kind,
    repositoryIdentity: 'github.com/acme/repo',
    commitSha: sha(o.commit),
    worktreeClean: o.clean ?? true,
    tests: o.tests ?? [],
    requestId: o.requestId ?? randomUUID(),
    requestHash: 'h',
    createdAt: o.at,
  });
}

/** A workspace with one participant who has done no work yet. */
async function workspace(name = uniq('pat'), createdAt: Date = T0) {
  const person = await mkUser(name);
  const team = await mkTeam(person.id, [{ id: person.id, role: 'owner' }], createdAt);
  const project = await mkProject(team.id);
  const install = await mkInstall(person.id);
  return { person, team, project, install };
}

/** Real work: a run that started on one commit and delivered another. */
async function realWork(w: Awaited<ReturnType<typeof workspace>>, when: Date, o: { passing?: boolean } = {}) {
  const run = await mkRun(w.install.id, w.team.id, w.project.id, when);
  await mkCheckpoint(run, { kind: 'start', commit: `${run.id}-start`, at: when });
  await mkCheckpoint(run, {
    kind: 'delivery',
    commit: `${run.id}-end`,
    at: new Date(when.getTime() + 60_000),
    clean: o.passing ?? false,
    tests: o.passing ? [{ name: 'npm test', state: 'passed' }] : [],
  });
  return run;
}

const read = async (teamId: string, now = NOW) => (await workspaceActivation(srv.db, env, [teamId], now)).byTeam.get(teamId)!;

async function wipe() {
  await srv.db.update(users).set({ testWorkspaceId: null });
  await srv.db.delete(teams);
  await srv.db.delete(users).where(ne(users.username, 'ops'));
}

const card = (html: string) => /<section class="card" id="first-value-path">[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';

beforeAll(async () => {
  process.env.ADMIN_USERNAMES = 'ops';
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-activation-'));
  srv = await startServer(
    loadEnv({
      port: 0,
      host: '127.0.0.1',
      nodeEnv: 'test',
      devMode: true,
      databaseUrl: undefined,
      pgliteDir: dataDir,
      hosted: true,
      betaUnmetered: true,
    }),
  );
  delete process.env.ADMIN_USERNAMES;
  await login('ops');
}, 120_000);

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// -------------------------------------------------------------- the ladder

describe('the stage ladder', () => {
  it('moves one stage at a time and reads each from the row that shows it', async () => {
    const w = await workspace();
    let reading = await read(w.team.id);
    expect(Object.values(reading.stages).every((stage) => stage.basis === null)).toBe(true);
    expect(Object.values(reading.reached).some(Boolean)).toBe(false);

    // 1 setup started: a connection test a participant opened.
    await srv.db.insert(launchAttempts).values({ userId: w.person.id, teamId: w.team.id, createdAt: at(0, 1) });
    reading = await read(w.team.id);
    expect(reading.stages.setup_started).toMatchObject({ basis: 'observed', at: at(0, 1) });
    expect(reading.reached.setup_started).toBe(true);
    expect(reading.reached.authorised_connection).toBe(false);

    // 2 authorised connection: a workspace credential that was activated.
    await srv.db.insert(tokens).values({
      userId: w.person.id,
      name: 'agent',
      scope: 'team',
      teamId: w.team.id,
      tokenHash: randomUUID(),
      prefix: 'stma_x',
      createdAt: at(0, 2),
      activatedAt: at(0, 3),
    });
    reading = await read(w.team.id);
    expect(reading.stages.authorised_connection).toMatchObject({ basis: 'observed', at: at(0, 3) });
    expect(reading.reached.authorised_connection).toBe(true);
    expect(reading.reached.first_real_work).toBe(false);

    // A chat-only session: a run whose start checkpoint and later report are one commit.
    const chat = await mkRun(w.install.id, w.team.id, w.project.id, at(1));
    await mkCheckpoint(chat, { kind: 'start', commit: 'same', at: at(1) });
    await mkCheckpoint(chat, { kind: 'delivery', commit: 'same', at: at(1, 1), clean: true, tests: [{ name: 't', state: 'passed' }] });
    reading = await read(w.team.id);
    expect(reading.stages.first_real_work.basis).toBeNull();
    expect(reading.diagnostics).toEqual({ participantRuns: 1, changedRuns: 0 });

    // 3 first real work, but dirty and untested: not yet evidence.
    const work = await realWork(w, at(2));
    reading = await read(w.team.id);
    expect(reading.stages.first_real_work).toMatchObject({ basis: 'observed', at: new Date(at(2).getTime() + 60_000) });
    expect(reading.reached.first_real_work).toBe(true);
    expect(reading.stages.usable_evidence.basis).toBeNull();

    // A failing test on a clean checkpoint is not evidence either.
    await mkCheckpoint(work, {
      kind: 'tested',
      commit: 'other',
      at: at(2, 2),
      tests: [{ name: 'a', state: 'passed' }, { name: 'b', state: 'failed' }],
    });
    expect((await read(w.team.id)).stages.usable_evidence.basis).toBeNull();

    // 4 a clean checkpoint with a passing test.
    await realWork(w, at(3), { passing: true });
    reading = await read(w.team.id);
    expect(reading.stages.usable_evidence).toMatchObject({ basis: 'observed', at: new Date(at(3).getTime() + 60_000) });
    expect(reading.reached.usable_evidence).toBe(true);
    expect(reading.reached.human_confirmed).toBe(false);
    expect(reading.reached.repeat_use).toBe(true);
    expect(reading.repeatDays).toEqual(['2026-10-03', '2026-10-04']);
  });

  it('counts a handoff resumed on its checkpoint as usable evidence, and not one that was only offered', async () => {
    const w = await workspace();
    await srv.db.insert(launchAttempts).values({ userId: w.person.id, teamId: w.team.id, createdAt: at(0) });
    await srv.db.insert(tokens).values({
      userId: w.person.id, name: 'a', scope: 'team', teamId: w.team.id, tokenHash: randomUUID(), prefix: 'p', activatedAt: at(0, 1),
    });
    const run = await realWork(w, at(1));
    const [cp] = await srv.db.select().from(runCheckpoints).where(eq(runCheckpoints.runId, run.id)).limit(1);
    const offer = async (resumedAt: Date | null) => {
      const [session] = await srv.db
        .insert(debugSessions)
        .values({ teamId: w.team.id, title: 'handoff', openedBy: w.person.id })
        .returning();
      await srv.db.insert(handoffs).values({
        sessionId: session!.id,
        offeredBy: w.person.id,
        acceptedBy: resumedAt ? w.person.id : null,
        checkpointId: cp!.id,
        resumedAt,
        state: resumedAt ? 'in_progress' : 'offered',
      });
    };
    await offer(null);
    expect((await read(w.team.id)).stages.usable_evidence.basis).toBeNull();
    await offer(at(2));
    const reading = await read(w.team.id);
    expect(reading.stages.usable_evidence).toMatchObject({ basis: 'observed', at: at(2) });
    expect(reading.stages.usable_evidence.source).toContain('resumed');
  });

  it('keeps the person\'s answer in its own lane: helpful alone is not it, the operator\'s answer is not it, and it needs the observed stages first', async () => {
    const w = await workspace();
    const ops = (await srv.db.select().from(users).where(eq(users.username, 'ops')))[0]!;
    await srv.db.insert(savingConfirmations).values([
      { teamId: w.team.id, kind: 'conflict', refId: randomUUID(), confirmedBy: w.person.id, helpful: true, changedBehaviour: false, createdAt: at(1) },
      { teamId: w.team.id, kind: 'conflict', refId: randomUUID(), confirmedBy: ops.id, helpful: true, changedBehaviour: true, createdAt: at(1) },
    ]);
    let reading = await read(w.team.id);
    expect(reading.stages.human_confirmed.basis).toBeNull();

    await srv.db.insert(savingConfirmations).values({
      teamId: w.team.id, kind: 'conflict', refId: randomUUID(), confirmedBy: w.person.id, helpful: true, changedBehaviour: true, createdAt: at(2),
    });
    reading = await read(w.team.id);
    expect(reading.stages.human_confirmed).toMatchObject({ basis: 'observed', at: at(2) });
    // An answer with no connection and no work behind it does not make a workspace "reached" at stage 5.
    expect(reading.reached.human_confirmed).toBe(false);
  });

  it('shows a personal-credential workspace as implied, with no invented timestamp', async () => {
    const w = await workspace();
    await realWork(w, at(1), { passing: true });
    const reading = await read(w.team.id);
    expect(reading.stages.setup_started).toMatchObject({ basis: 'implied', at: null });
    expect(reading.stages.authorised_connection).toMatchObject({ basis: 'implied', at: null });
    expect(reading.stages.setup_started.source).toContain('personal credential');
    expect(reading.reached.usable_evidence).toBe(true);
  });
});

// ---------------------------------------------------- connected is not active

describe('connected is not activation', () => {
  it('counts a connected workspace at stage 2 and not at first work', async () => {
    await wipe();
    const w = await workspace();
    await srv.db.insert(launchAttempts).values({ userId: w.person.id, teamId: w.team.id, createdAt: at(0), firstConnectedAt: at(0, 1) });
    const cohorts = await activationCohorts(srv.db, env, NOW);
    expect(cohorts.total.eligible).toBe(1);
    expect(cohorts.total.stages.authorised_connection).toMatchObject({ reached: 1, of: 1 });
    expect(cohorts.total.stages.first_real_work).toMatchObject({ reached: 0, of: 1 });
    expect(cohorts.total.stages.usable_evidence.reached).toBe(0);
  });
});

// ---------------------------------------------------------------- exclusion

describe('who is not a customer', () => {
  it('leaves the operator, test, review and demo workspaces out of every denominator and counts each reason', async () => {
    await wipe();
    const ops = (await srv.db.select().from(users).where(eq(users.username, 'ops')))[0]!;

    // Operator only.
    const opsTeam = await mkTeam(ops.id, [{ id: ops.id, role: 'owner' }]);
    // A test account whose workspace it is.
    const tester = await mkUser('tester', { isTest: true, email: 'tester@demo.stma.invalid' });
    const testTeam = await mkTeam(tester.id, [{ id: tester.id, role: 'owner' }]);
    await srv.db.update(users).set({ testWorkspaceId: testTeam.id }).where(eq(users.id, tester.id));
    // A reviewer (access lapsed is still a reviewer account).
    const reviewer = await mkUser('claude-reviewer', { reviewAccessUntil: at(-1) });
    const reviewTeam = await mkTeam(reviewer.id, [{ id: reviewer.id, role: 'owner' }]);
    // The demo, built by the operator's button for a real-looking account.
    const demoOwner = await mkUser('demo-owner');
    expect((await form(`${srv.url}/admin/users/${demoOwner.id}/demo-workspace`, {}, cookies.ops)).status).toBe(302);
    const demoTeamId = (await srv.db.select({ id: memberships.teamId }).from(memberships).where(eq(memberships.userId, demoOwner.id)))[0]!.id;
    // A real customer, and a mixed workspace (operator plus one participant).
    const real = await workspace('real-one');
    const mixedPerson = await mkUser('mixed-person');
    const mixed = await mkTeam(mixedPerson.id, [{ id: mixedPerson.id, role: 'owner' }, { id: ops.id }]);

    const exclusions = await excludedWorkspaces(srv.db, env, [opsTeam.id, testTeam.id, reviewTeam.id, demoTeamId, real.team.id, mixed.id]);
    expect(exclusions.get(opsTeam.id)).toBe('operator_only');
    expect(exclusions.get(testTeam.id)).toBe('test_workspace');
    expect(exclusions.get(reviewTeam.id)).toBe('operator_only');
    expect(exclusions.get(demoTeamId)).toBe('demo');
    expect(exclusions.has(real.team.id)).toBe(false);
    expect(exclusions.has(mixed.id)).toBe(false);

    const cohorts = await activationCohorts(srv.db, env, new Date());
    expect(cohorts.total.eligible).toBe(2);
    expect(cohorts.excluded).toEqual({ total: 4, byReason: { test_workspace: 1, demo: 1, operator_only: 2 } });
    expect(cohorts.considered).toBe(6);
  });

  it('ignores what the operator did inside a workspace that has a real participant', async () => {
    const ops = (await srv.db.select().from(users).where(eq(users.username, 'ops')))[0]!;
    const w = await workspace();
    await srv.db.insert(memberships).values({ teamId: w.team.id, userId: ops.id, role: 'member' });
    const opsInstall = await mkInstall(ops.id);
    const opsRun = await mkRun(opsInstall.id, w.team.id, w.project.id, at(1));
    await mkCheckpoint(opsRun, { kind: 'start', commit: 'o-start', at: at(1) });
    await mkCheckpoint(opsRun, { kind: 'delivery', commit: 'o-end', at: at(1, 1), tests: [{ name: 't', state: 'passed' }] });
    await srv.db.insert(launchAttempts).values({ userId: ops.id, teamId: w.team.id, createdAt: at(1), firstConnectedAt: at(1) });
    const [cp] = await srv.db.select().from(runCheckpoints).where(eq(runCheckpoints.runId, opsRun.id)).limit(1);
    const [session] = await srv.db.insert(debugSessions).values({ teamId: w.team.id, title: 'operator handoff', openedBy: ops.id }).returning();
    await srv.db.insert(handoffs).values({ sessionId: session!.id, offeredBy: ops.id, acceptedBy: w.person.id, checkpointId: cp!.id, resumedAt: at(2), state: 'in_progress' });
    const reading = await read(w.team.id);
    expect(Object.values(reading.stages).every((stage) => stage.basis === null)).toBe(true);
    expect(reading.diagnostics.participantRuns).toBe(0);
    expect(reading.participants).toBe(1);
  });

  it('classifies accounts by every rule, the reviewer even after access lapsed', async () => {
    const a = await mkUser(uniq('plain'));
    const b = await mkUser(uniq('t'), { isTest: true });
    const c = await mkUser(uniq('r'), { reviewAccessUntil: at(-3) });
    const d = await mkUser(uniq('e'), { email: 'x@demo.stma.invalid' });
    const e = await mkUser('ops-lookalike', { email: 'ops@example.com' });
    const result = await classifyAccounts(srv.db, env, [a.id, b.id, c.id, d.id, e.id]);
    expect(result.has(a.id)).toBe(false);
    expect(result.get(b.id)).toBe('test');
    expect(result.get(c.id)).toBe('reviewer');
    expect(result.get(d.id)).toBe('test');
    expect(result.has(e.id)).toBe(false);
  });
});

// ------------------------------------------------------------------- units

describe('the unit is the workspace', () => {
  it('counts two members of one workspace once, and one person\'s two workspaces twice with one creator', async () => {
    await wipe();
    const w = await workspace();
    const second = await mkUser(uniq('second'));
    await srv.db.insert(memberships).values({ teamId: w.team.id, userId: second.id, role: 'member' });
    const secondInstall = await mkInstall(second.id);
    await realWork(w, at(1));
    const secondRun = await mkRun(secondInstall.id, w.team.id, w.project.id, at(1, 2));
    await mkCheckpoint(secondRun, { kind: 'start', commit: 's', at: at(1, 2) });
    await mkCheckpoint(secondRun, { kind: 'delivery', commit: 'e', at: at(1, 3) });
    const reading = await read(w.team.id);
    expect(reading.participants).toBe(2);

    // The same person makes two more workspaces.
    await mkTeam(w.person.id, [{ id: w.person.id, role: 'owner' }]);
    await mkTeam(w.person.id, [{ id: w.person.id, role: 'owner' }]);
    const cohorts = await activationCohorts(srv.db, env, NOW);
    expect(cohorts.total.eligible).toBe(3);
    expect(cohorts.total.creators).toBe(1);
    expect(cohorts.total.stages.first_real_work).toMatchObject({ reached: 1, of: 3 });
  });
});

// ------------------------------------------------------ idempotency and time

describe('replays, late reports and the clock', () => {
  it('does not change when the same checkpoint or the same answer arrives again', async () => {
    const w = await workspace();
    const run = await mkRun(w.install.id, w.team.id, w.project.id, at(1));
    const requestId = randomUUID();
    await mkCheckpoint(run, { kind: 'start', commit: 'a', at: at(1) });
    await mkCheckpoint(run, { kind: 'delivery', commit: 'b', at: at(1, 1), clean: true, tests: [{ name: 't', state: 'passed' }], requestId });
    const first = await read(w.team.id);
    // A retried report with the same request id is refused by the unique index.
    await expect(
      mkCheckpoint(run, { kind: 'delivery', commit: 'b', at: at(5), clean: true, tests: [{ name: 't', state: 'passed' }], requestId }),
    ).rejects.toThrow();
    const refId = randomUUID();
    const answer = { teamId: w.team.id, kind: 'conflict', refId, confirmedBy: w.person.id, helpful: true, changedBehaviour: true, createdAt: at(2) };
    await srv.db.insert(savingConfirmations).values(answer);
    await srv.db.insert(savingConfirmations).values({ ...answer, createdAt: at(6) }).onConflictDoNothing();
    const again = await read(w.team.id);
    expect(again.stages.first_real_work).toEqual(first.stages.first_real_work);
    expect(again.stages.human_confirmed.at).toEqual(at(2));
    expect(await read(w.team.id)).toEqual(again);
    expect((await srv.db.select().from(savingConfirmations).where(eq(savingConfirmations.refId, refId))).length).toBe(1);
  });

  it('is unchanged by a report replayed through the real tool with the same request id', async () => {
    const j = jar();
    j.store(await form(`${srv.url}/auth/dev`, { username: 'tool-user' }));
    cookies['tool-user'] = j.header();
    await form(`${srv.url}/app/teams`, { name: 'Tool WS' }, cookies['tool-user']);
    const tokenPage = await fetch(`${srv.url}/app/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...cookies['tool-user'] },
      body: new URLSearchParams({ name: 'tool-machine' }),
    });
    const token = /stma_[0-9a-f]{40}/.exec(await tokenPage.text())?.[0] ?? '';
    expect(token).toBeTruthy();
    let id = 1;
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await fetch(`${srv.url}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } }),
      });
      const json = (await res.json()) as { result?: { content?: Array<{ text: string }> } };
      try {
        return JSON.parse(json.result?.content?.[0]?.text ?? '');
      } catch {
        return null;
      }
    };
    const repo = 'github.com/acme/tool-repo';
    const started = await call('start_run', {
      team: 'tool-ws',
      project: 'tool-repo',
      repository_identity: repo,
      task: 'T-1',
      checkpoint: { request_id: randomUUID(), kind: 'start', repository_identity: repo, commit_sha: sha('start'), worktree_clean: true, tests: [] },
    });
    expect(started?.runId, JSON.stringify(started)).toBeTruthy();
    const delivery = {
      request_id: randomUUID(),
      kind: 'delivery',
      repository_identity: repo,
      commit_sha: sha('delivered'),
      worktree_clean: true,
      tests: [{ name: 'npm test', state: 'passed' }],
    };
    await call('update_run', { run_id: started.runId, checkpoint: delivery });
    const [team] = await srv.db.select().from(teams).where(eq(teams.slug, 'tool-ws'));
    const first = await workspaceActivation(srv.db, env, [team!.id], new Date(Date.now() + HOUR));
    expect(first.byTeam.get(team!.id)!.stages.usable_evidence.basis).toBe('observed');
    await call('update_run', { run_id: started.runId, checkpoint: delivery });
    const second = await workspaceActivation(srv.db, env, [team!.id], new Date(Date.now() + HOUR));
    expect(second.byTeam.get(team!.id)).toEqual(first.byTeam.get(team!.id));
    const rows = await srv.db.select({ n: sql<number>`count(*)::int` }).from(runCheckpoints).where(eq(runCheckpoints.runId, started.runId));
    expect(rows[0]!.n).toBe(2); // the start and the one delivery
  });

  it('judges repeat use on UTC days with a twelve hour gap', () => {
    const iso = (s: string) => new Date(s);
    // A session straddling midnight is two dates and not a return.
    const straddle = repeatUse([iso('2026-10-01T23:50:00Z'), iso('2026-10-02T00:10:00Z')]);
    expect(straddle.days).toEqual(['2026-10-01', '2026-10-02']);
    expect(straddle.at).toBeNull();
    // Twelve hours and twenty minutes later, on the next day: a return.
    expect(repeatUse([iso('2026-10-01T23:50:00Z'), iso('2026-10-02T12:10:00Z')]).at).toEqual(iso('2026-10-02T12:10:00Z'));
    // Exactly twelve hours counts; a minute short does not.
    expect(repeatUse([iso('2026-10-01T20:00:00Z'), iso('2026-10-02T08:00:00Z')]).at).not.toBeNull();
    expect(repeatUse([iso('2026-10-01T20:00:00Z'), iso('2026-10-02T07:59:00Z')]).at).toBeNull();
    // The same day twice, however far apart, is not a return.
    expect(repeatUse([iso('2026-10-01T00:00:00Z'), iso('2026-10-01T23:59:59Z')]).at).toBeNull();
    // 00:00:00Z belongs to the new day.
    expect(repeatUse([iso('2026-10-02T00:00:00.000Z')]).days).toEqual(['2026-10-02']);
    expect(repeatUse([iso('2026-10-01T23:59:59.999Z'), iso('2026-10-02T00:00:00.000Z')]).days).toEqual(['2026-10-01', '2026-10-02']);
    expect(repeatUse([]).at).toBeNull();
  });

  it('reads a straddling session as one day in the stage itself', async () => {
    const w = await workspace();
    await realWork(w, new Date('2026-10-05T23:50:00Z'));
    await realWork(w, new Date('2026-10-06T00:05:00Z'));
    const reading = await read(w.team.id);
    expect(reading.repeatDays).toEqual(['2026-10-05', '2026-10-06']);
    expect(reading.stages.repeat_use.basis).toBeNull();
    await realWork(w, new Date('2026-10-06T12:30:00Z'));
    expect((await read(w.team.id)).stages.repeat_use.basis).toBe('observed');
  });

  it('moves a stage forward when an earlier report arrives late, and never double counts or rewrites earlier stages', async () => {
    const w = await workspace();
    await srv.db.insert(launchAttempts).values({ userId: w.person.id, teamId: w.team.id, createdAt: at(0) });
    await realWork(w, at(5));
    const before = await read(w.team.id);
    expect(before.stages.first_real_work.at).toEqual(new Date(at(5).getTime() + 60_000));
    // A report written afterwards that happened earlier.
    await realWork(w, at(2));
    const after = await read(w.team.id);
    expect(after.stages.first_real_work.at).toEqual(new Date(at(2).getTime() + 60_000));
    expect(after.stages.setup_started).toEqual(before.stages.setup_started);
    expect(after.diagnostics.changedRuns).toBe(2);
    // As of an earlier instant the later rows do not exist yet.
    const early = await read(w.team.id, at(1));
    expect(early.stages.first_real_work.basis).toBeNull();
    expect(await read(w.team.id, at(1))).toEqual(early);
  });

  it('falls back when the participant\'s account is erased, and reads a deleted workspace as gone', async () => {
    await wipe();
    const owner = await mkUser(uniq('owner'));
    const worker = await mkUser(uniq('worker'));
    const team = await mkTeam(owner.id, [{ id: owner.id, role: 'owner' }, { id: worker.id }]);
    const project = await mkProject(team.id);
    const install = await mkInstall(worker.id);
    await srv.db.insert(tokens).values({
      userId: worker.id, name: 'a', scope: 'team', teamId: team.id, tokenHash: randomUUID(), prefix: 'p', createdAt: at(0), activatedAt: at(0, 1),
    });
    await realWork({ person: worker, team, project, install }, at(1), { passing: true });
    let reading = await read(team.id);
    expect(reading.reached.usable_evidence).toBe(true);
    let cohorts = await activationCohorts(srv.db, env, NOW);
    expect(cohorts.total.stages.usable_evidence).toMatchObject({ reached: 1, of: 1 });

    await srv.db.delete(users).where(eq(users.id, worker.id));
    reading = await read(team.id);
    expect(reading.reached.first_real_work).toBe(false);
    expect(reading.reached.setup_started).toBe(false);
    expect(reading.diagnostics.participantRuns).toBe(0);

    // Now the whole workspace.
    const w2 = await workspace();
    await realWork(w2, at(1), { passing: true });
    cohorts = await activationCohorts(srv.db, env, NOW);
    expect(cohorts.total.eligible).toBe(2);
    expect(cohorts.total.stages.first_real_work.reached).toBe(1);
    await srv.db.delete(teams).where(eq(teams.id, w2.team.id));
    cohorts = await activationCohorts(srv.db, env, NOW);
    expect(cohorts.total.eligible).toBe(1);
    expect(cohorts.total.stages.first_real_work.reached).toBe(0);
  });
});

// ------------------------------------------------------------ cohort shape

describe('cohorts read as counts', () => {
  it('prints "n of m", withholds the rate below five workspaces and says why', async () => {
    await wipe();
    for (let i = 0; i < 3; i += 1) {
      const w = await workspace();
      if (i === 0) await realWork(w, at(1), { passing: true });
    }
    const cohorts = await activationCohorts(srv.db, env, NOW);
    expect(cohorts.total.eligible).toBe(3);
    expect(cohorts.total.smallN).toBe(true);
    expect(ACTIVATION_SMALL_N).toBe(5);
    const page = card(await (await get('ops', '/admin/usage')).text());
    expect(page).toContain('1 of 3');
    expect(page).toContain('too few to read as a rate');
    expect(page).not.toContain('%');
    expect(page).toContain('unknown (not recorded)');
    expect(page).toContain('answered by a person');
    expect(page).toContain('Connected is');
  });

  it('shows the rate once there are five', async () => {
    await wipe();
    for (let i = 0; i < 5; i += 1) {
      const w = await workspace();
      if (i < 2) await realWork(w, at(1), { passing: true });
    }
    const page = card(await (await get('ops', '/admin/usage')).text());
    expect(page).toContain('2 of 5');
    expect(page).toContain('(40%)');
    expect(page).not.toContain('too few to read as a rate');
  });

  it('keeps a workspace out of the repeat-use denominator until its first work is a day old', async () => {
    await wipe();
    const w = await workspace();
    const now = at(3);
    await realWork(w, new Date(now.getTime() - 2 * HOUR), { passing: true });
    const cohorts = await activationCohorts(srv.db, env, now);
    expect(cohorts.total.stages.first_real_work).toMatchObject({ reached: 1, of: 1 });
    expect(cohorts.total.stages.repeat_use).toMatchObject({ reached: 0, of: 0 });
    expect(cohorts.total.notYetObservable).toBe(1);
    const later = await activationCohorts(srv.db, env, new Date(now.getTime() + 2 * DAY));
    expect(later.total.stages.repeat_use).toMatchObject({ reached: 0, of: 1 });
    expect(later.total.notYetObservable).toBe(0);
  });

  it('counts a workspace that already returned on another UTC day, even though its first work is under a day old', async () => {
    await wipe();
    const w = await workspace();
    const now = at(3); // 2026-10-04T10:00Z
    await realWork(w, new Date(now.getTime() - 20 * HOUR), { passing: true }); // 10-03 14:00
    await realWork(w, new Date(now.getTime() - 5 * HOUR), { passing: true }); // 10-04 05:00
    const cohorts = await activationCohorts(srv.db, env, now);
    expect(cohorts.total.stages.repeat_use).toMatchObject({ reached: 1, of: 1 });
    expect(cohorts.total.notYetObservable).toBe(0);
  });

  it('groups by the week of creation (Monday, UTC)', async () => {
    await wipe();
    await workspace(uniq('a'), new Date('2026-10-05T00:00:00Z')); // a Monday
    await workspace(uniq('b'), new Date('2026-10-11T23:59:59Z')); // the Sunday after
    await workspace(uniq('c'), new Date('2026-10-12T00:00:00Z')); // the next Monday
    const cohorts = await activationCohorts(srv.db, env, NOW);
    expect(cohorts.rows.map((row) => [row.weekStart!.toISOString().slice(0, 10), row.eligible])).toEqual([
      ['2026-10-12', 1],
      ['2026-10-05', 2],
    ]);
  });

  it('issues a fixed number of queries whatever the number of workspaces', async () => {
    await wipe();
    const build = async (n: number) => {
      const ids: string[] = [];
      for (let i = 0; i < n; i += 1) {
        const w = await workspace();
        await realWork(w, at(1), { passing: true });
        ids.push(w.team.id);
      }
      return ids;
    };
    const five = await build(5);
    const spy = vi.spyOn(srv.db, 'select');
    await workspaceActivation(srv.db, env, five, NOW);
    const fiveCalls = spy.mock.calls.length;
    spy.mockClear();
    const sixty = [...five, ...(await build(55))];
    spy.mockClear();
    await workspaceActivation(srv.db, env, sixty, NOW);
    const sixtyCalls = spy.mock.calls.length;
    spy.mockRestore();
    expect(fiveCalls).toBeGreaterThan(5);
    expect(sixtyCalls).toBe(fiveCalls);
  }, 120_000);

  it('carries no personal data in what it returns', async () => {
    await wipe();
    const person = await mkUser(uniq('privacy'), { email: 'secret.person@example.org' });
    const team = await mkTeam(person.id, [{ id: person.id, role: 'owner' }]);
    const project = await mkProject(team.id);
    const install = await mkInstall(person.id);
    await realWork({ person, team, project, install }, at(1), { passing: true });
    const out = JSON.stringify({
      cohorts: await activationCohorts(srv.db, env, NOW),
      activation: [...(await workspaceActivation(srv.db, env, [team.id], NOW)).byTeam.values()],
    });
    expect(out).not.toContain('secret.person');
    expect(out).not.toContain(person.username);
    expect(out).not.toMatch(/"(?:email|userAgent|user_agent|ip|lastIp|referrer|referer|username|name)"/i);
  });
});

// ------------------------------------------------- access and the two pages

describe('the operator pages', () => {
  it('404s the cards for anybody who is not an operator', async () => {
    await wipe();
    const w = await workspace();
    await login('somebody');
    expect((await get('somebody', '/admin/usage')).status).toBe(404);
    expect((await get('somebody', `/admin/teams/${w.team.id}/pilot`)).status).toBe(404);
    expect((await get('somebody', `/admin/teams/${w.team.id}/pilot.md`)).status).toBe(404);
  });

  it('shows the card on /admin/usage and the stages on the pilot sheet and its Markdown', async () => {
    await wipe();
    await login('ops');
    const w = await workspace();
    await realWork(w, at(1), { passing: true });
    const usage = await (await get('ops', '/admin/usage')).text();
    expect(usage).toContain('First value path (eligible workspaces)');
    expect(usage).toContain('Includes operator, test and demo workspaces; see First value path for eligible counts.');
    expect(card(usage)).toContain('1 of 1');

    const sheet = await (await get('ops', `/admin/teams/${w.team.id}/pilot?since=2026-09-20`)).text();
    expect(sheet).toContain('First value path');
    expect(sheet).toContain('Connected is not activation');
    expect(sheet).toContain('answered by a person');
    expect(sheet).toContain('implied, no timestamp');

    const markdown = await (await get('ops', `/admin/teams/${w.team.id}/pilot.md?since=2026-09-20`)).text();
    expect(markdown).toContain('## First value path');
    expect(markdown).toContain('Observed by STMA');
    expect(markdown).toContain('Answered by a person');
    expect(markdown.indexOf('## Warnings people answered')).toBeLessThan(markdown.indexOf('## First value path'));
    expect(markdown.indexOf('## First value path')).toBeLessThan(markdown.indexOf('## Weekly'));
    expect(markdown).not.toContain('—');
  });

  it('says on the pilot sheet that the demo workspace is excluded from cohorts', async () => {
    await wipe();
    await login('ops');
    const owner = await mkUser('demo-lead');
    expect((await form(`${srv.url}/admin/users/${owner.id}/demo-workspace`, {}, cookies.ops)).status).toBe(302);
    const teamId = (await srv.db.select({ id: memberships.teamId }).from(memberships).where(eq(memberships.userId, owner.id)))[0]!.id;
    const markdown = await (await get('ops', `/admin/teams/${teamId}/pilot.md`)).text();
    expect(markdown).toContain('This workspace is excluded from cohorts: demo workspace.');
    const cohorts = await activationCohorts(srv.db, env, new Date());
    expect(cohorts.total.eligible).toBe(0);
    expect(cohorts.excluded.byReason.demo).toBe(1);
    const page = card(await (await get('ops', '/admin/usage')).text());
    expect(page).toContain('1 demo workspace');
  }, 120_000);
});

// Last on purpose: it writes twenty thousand rows, and a socket left idle that long
// would otherwise be reset under the next test's first request.
describe('a bounded scan fails closed', () => {
  it('does not let a truncated start-checkpoint scan turn a chat-only run into work', async () => {
    await wipe();
    const filler = await workspace(uniq('filler'));
    const fillerRun = await mkRun(filler.install.id, filler.team.id, filler.project.id, T0);
    const rows = Array.from({ length: ACTIVATION_CHECKPOINT_SCAN + 1 }, (_, i) => ({
      runId: fillerRun.id,
      teamId: filler.team.id,
      projectId: filler.project.id,
      installationId: filler.install.id,
      kind: 'start' as const,
      repositoryIdentity: 'github.com/acme/repo',
      commitSha: sha('filler'),
      worktreeClean: true,
      tests: [],
      requestId: randomUUID(),
      requestHash: 'h',
      createdAt: new Date(T0.getTime() + i),
    }));
    for (let i = 0; i < rows.length; i += 2000) await srv.db.insert(runCheckpoints).values(rows.slice(i, i + 2000));
    // The chat-only run: it delivers the very commit it started on, but its start
    // checkpoint is newer than the 20,000th and so is never read.
    const w = await workspace(uniq('chat'));
    const run = await mkRun(w.install.id, w.team.id, w.project.id, at(1));
    await mkCheckpoint(run, { kind: 'start', commit: 'same', at: at(1) });
    await mkCheckpoint(run, { kind: 'delivery', commit: 'same', at: at(1, 1) });
    const result = await workspaceActivation(srv.db, env, [w.team.id, filler.team.id], NOW);
    expect(result.truncated).toBe(true);
    expect(result.byTeam.get(w.team.id)!.reached.first_real_work).toBe(false);
  }, 120_000);
});
