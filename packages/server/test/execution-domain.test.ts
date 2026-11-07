import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import { EXECUTION_PERMISSION_PROFILE, EXECUTION_RUNTIME, type ExecutionClaimDto, type ExecutionResult } from '@bridge/shared';
import { connectDb, type Db } from '../src/db';
import { agentInstallations, agentRuns, debugSessions, executionAttemptGrants, executionAttempts, executionJobs, executionTargets, handoffs, memberships, projects, teams, tokens, users, webSessions, workerInstances, workItems, workLinks } from '../src/db/schema';
import { loadEnv } from '../src/env';
import { createApp } from '../src/app';
import { generatePat } from '../src/auth/pat';
import { writeAssignment } from '../src/domain/assignments';
import { betaLedger } from '../src/domain/betaCohorts';
import { createWork, updateWork } from '../src/domain/work';
import { finishAgentRun, startAgentRun } from '../src/domain/agents';
import { registerFleetTools } from '../src/mcp/fleet';
import { cancelExecution, claimExecution, configureExecutionTarget, dispatchExecution, getExecution, heartbeatExecution, reconcileExecutionCapacity, reportExecutionEvent, setExecutionCapacity, setExecutionDispatchers, setExecutionTargetEnabled } from '../src/domain/execution';
import { agentPrincipal, humanPrincipal, type WorkCommandOutcome, type WorkResult } from '../src/domain/workTypes';
import { randomHex, sha256hex } from '../src/lib/crypto';
import type { AgentGrant } from '../src/lib/grants';
import { guardExecutionHttp, managedResourceRefusal, resolveExecutionCredential, withExecutionRequest } from '../src/lib/executionSecurity';
import { isHosted, isUnmetered, setHosted, setUnmetered, withEntitlements } from '../src/lib/entitlements';
import { setSecurityPrincipal, withSecurityHooks, type CriticalAuditEvent } from '../src/lib/securityHooks';

let db: Db;
let close: () => Promise<void>;
let dir: string;
let userId: string;
let teamId: string;
let projectId: string;
const env = loadEnv({ nodeEnv: 'test', databaseUrl: undefined, hosted: false });
const ok = <T>(value: ExecutionResult<T>): T => { if (value && typeof value === 'object' && 'error' in value) throw new Error(JSON.stringify(value)); return value as T; };
const okWork = (value: WorkResult<WorkCommandOutcome>): WorkCommandOutcome => {
  if ('error' in value) throw new Error(JSON.stringify(value.error));
  return value;
};
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'stma-execution-domain-'));
  ({ db, close } = await connectDb({ ...env, pgliteDir: dir }));
  userId = (await db.insert(users).values({ username: 'execution-owner' }).returning())[0]!.id;
  teamId = (await db.insert(teams).values({ name: 'Execution', slug: 'execution', createdBy: userId }).returning())[0]!.id;
  await db.insert(memberships).values({ teamId, userId, role: 'owner' });
  projectId = (await db.insert(projects).values({ teamId, name: 'api', slug: 'api', repositoryIdentity: 'github.com/acme/api', createdBy: userId }).returning())[0]!.id;
});
afterAll(async () => { await close?.(); if (dir && path.resolve(dir).startsWith(path.resolve(tmpdir()) + path.sep)) rmSync(dir, { recursive: true, force: true }); });

async function assignmentFixture(scope = { teamId, projectId, teamSlug: 'execution', projectSlug: 'api', repositoryIdentity: 'github.com/acme/api' }) {
  const { teamId, projectId, teamSlug, projectSlug, repositoryIdentity } = scope;
  const pat = generatePat();
  const token = (await db.insert(tokens).values({ userId, name: 'worker fixture', tokenHash: pat.hash, prefix: pat.prefix, scope: 'project', teamId, projectId }).returning())[0]!;
  const installation = (await db.insert(agentInstallations).values({ userId, tokenId: token.id, name: randomUUID(), deviceFingerprint: randomUUID(), clientType: 'claude-code' }).returning())[0]!;
  const grant: AgentGrant = { tokenId: token.id, scope: 'project', teamId, teamSlug, teamName: 'Execution', projectId, projectSlug, projectName: 'api', installationId: installation.id,
    installationName: installation.name, deviceLabel: null, companionInstallationId: null, clientType: 'claude-code' };
  const configured = ok(await configureExecutionTarget(db, userId, grant, { checkout_path: `C:/dedicated/${installation.id}`, checkout_fingerprint: sha256hex(installation.id), runtime: EXECUTION_RUNTIME,
    runtime_version: 'fixture', permission_profile: EXECUTION_PERMISSION_PROFILE, max_runtime_seconds: 300, max_turns: 5, dedicated: true }));
  const human = humanPrincipal(userId);
  const { target } = ok(await setExecutionTargetEnabled(db, human, configured.target.id, true));
  const assignment = await db.transaction(tx => writeAssignment(tx as unknown as Db, env, { team: { id: teamId, slug: teamSlug }, project: { id: projectId, name: projectSlug, repositoryIdentity },
    agent: { installationId: installation.id, name: installation.name, ownerId: userId, owner: 'execution-owner', client: 'claude-code', device: null, role: null, projectId, adapters: 0, lastSeenAt: new Date() },
    assignedBy: { id: userId, username: 'execution-owner', tokenId: null, via: null }, task: 'Inspect fixture', brief: 'Read the fixture.', steps: [], branch: null, scope: [] }, { sessionId: randomUUID(), handoffId: randomUUID() }));
  return { pat: pat.token, grant, target, human, assignment: { sessionId: assignment.sessionId, handoffId: assignment.handoffId }, workerId: randomUUID() };
}
type Fixture = Awaited<ReturnType<typeof assignmentFixture>>;
const dispatchInput = (f: Fixture) => ({ target_id: f.target.id, session_id: f.assignment.sessionId, request_id: randomUUID() });
async function fixture() {
  const f = await assignmentFixture();
  return { ...f, job: ok(await dispatchExecution(db, f.human, dispatchInput(f))).job };
}
async function claim(f: Fixture) { return ok(await claimExecution(db, userId, f.grant, { target_id: f.target.id, worker_id: f.workerId })) as ExecutionClaimDto; }
const lease = (f: Fixture, c: ExecutionClaimDto) => ({ target_id: f.target.id, worker_id: f.workerId, attempt_id: c.attempt.id, fence: c.attempt.fence });
async function childGrant(f: Fixture, c: ExecutionClaimDto) {
  const found = await resolveExecutionCredential(db, sha256hex(c.attempt_token));
  expect(found).not.toBeNull();
  return { ...f.grant, execution: found!.execution };
}
const report = (f: Fixture, c: ExecutionClaimDto, state: 'starting'|'running'|'succeeded'|'cancelled'|'needs_input', stopped = false) => reportExecutionEvent(db, userId, f.grant, {
  ...lease(f, c), event_id: randomUUID(), state, provider_session_id: c.attempt.provider_session_id, checkout_fingerprint: f.target.checkout_fingerprint,
  process_stopped: stopped, reason: state === 'needs_input' ? 'permission_required' : state === 'starting' ? 'spawn_intent' : state === 'running' ? 'session_observed' : state === 'cancelled' ? 'cancelled' : 'turn_completed',
});

async function workAssignmentFixture() {
  const target = await assignmentFixture();
  const work = okWork(await createWork(db, target.human, {
    request_id: randomUUID(), project: projectId, owner: 'execution-owner', acceptor: 'execution-owner',
    contract: { title: 'Pinned assignment', goal: 'Read the fixture.', artifact_kind: 'code' },
    criteria: [{ text: 'Report the fixture result.' }],
  }));
  const command = { work_id: work.work_id };
  const ready = okWork(await updateWork(db, target.human, {
    ...command, request_id: randomUUID(), expected_version: work.version, operation: 'transition', payload: { to: 'ready' },
  }));
  const assigned = okWork(await updateWork(db, target.human, {
    ...command, request_id: randomUUID(), expected_version: ready.version, operation: 'assign',
    payload: { to_agent: target.target.installation_name, expected_spec_revision: ready.spec_revision },
  }, { env, assignee: target.target.installation_id }));
  const assignment = { sessionId: String(assigned.session_id), handoffId: String(assigned.assignment_id) };
  const correctLink = async (handoffId: string) => okWork(await updateWork(db, target.human, {
    ...command, request_id: randomUUID(), expected_version: assigned.version, operation: 'link',
    payload: { kind: 'assignment', target_id: handoffId, replaces_link_id: assigned.link_id, reason: 'Correct the assignment link.' },
  }));
  return { ...target, assignment, work, correctLink, standaloneAssignmentId: target.assignment.handoffId };
}

it('refuses a reviewed browser dispatch after the assignment is detached from its pinned work', async () => {
  const f = await workAssignmentFixture();
  const sid = randomHex(32);
  await db.insert(webSessions).values({ id: sid, userId, expiresAt: new Date(Date.now() + 3600_000) });
  const app = createApp({ db, env });
  const url = `/app/sessions/${f.assignment.sessionId}/dispatch`;
  const headers = { 'x-forwarded-for': '127.0.0.1', cookie: `sid=${sid}` };
  const review = await app.request(url, { headers });
  expect(review.status).toBe(200);
  const requestId = /name="request_id" value="([^"]+)"/.exec(await review.text())?.[1];
  expect(requestId).toBeTruthy();

  await f.correctLink(f.standaloneAssignmentId);
  const confirmation = await app.request(url, {
    method: 'POST', headers,
    body: new URLSearchParams({ target_id: f.target.id, request_id: requestId!, grant_version: String(f.target.grant_version) }),
  });
  expect(confirmation.status).toBe(409);
  expect((await app.request(url, { headers })).status).toBe(409);
  expect(await db.select().from(executionJobs).where(eq(executionJobs.targetId, f.target.id))).toHaveLength(0);
});

it('cancels a queued dispatch before claim if the pinned assignment link was corrected', async () => {
  const f = await workAssignmentFixture();
  const job = ok(await dispatchExecution(db, f.human, dispatchInput(f))).job;
  expect(job).toMatchObject({ work_id: f.work.work_id, spec_revision: f.work.spec_revision, state: 'queued' });
  await f.correctLink(f.assignment.handoffId);

  expect((await claim(f)).job).toBeNull();
  expect(ok(await getExecution(db, f.human, job.id))).toMatchObject({
    job: { state: 'cancelled' }, attempt: null, events: expect.arrayContaining([expect.objectContaining({ reason: 'contract_changed' })]),
  });
});

it('reviews and explicitly queues a browser dispatch as the human, replays it, and stops after session revocation', async () => {
  const f = await assignmentFixture();
  const other = await assignmentFixture();
  const sid = randomHex(32);
  await db.insert(webSessions).values({ id: sid, userId, expiresAt: new Date(Date.now() + 3600_000) });
  const app = createApp({ db, env });
  const assignmentUrl = `/app/sessions/${f.assignment.sessionId}`;
  const url = `${assignmentUrl}/dispatch`;
  const headers = { 'x-forwarded-for': '127.0.0.1', cookie: `sid=${sid}` };
  expect(await (await app.request(assignmentUrl, { headers })).text()).toContain(url);
  const review = await app.request(url, { headers });
  expect(review.status).toBe(200);
  const html = await review.text();
  for (const value of [f.target.id, f.target.checkout_path, f.target.runtime, f.target.permission_profile, 'Confirm and queue execution']) {
    expect(html).toContain(value);
  }
  expect(html).not.toContain(other.target.id);
  expect(await db.select().from(executionJobs).where(eq(executionJobs.targetId, f.target.id))).toHaveLength(0);
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
  expect(requestId).toBeTruthy();
  const post = (targetId = f.target.id, version = f.target.grant_version) => app.request(url, {
    method: 'POST', headers,
    body: new URLSearchParams({ target_id: targetId, request_id: requestId!, grant_version: String(version) }),
  });
  expect((await post(other.target.id)).status).toBe(404);
  expect((await post(f.target.id, f.target.grant_version - 1)).status).toBe(409);
  const dispatched = await post();
  expect(dispatched.status).toBe(303);
  const location = dispatched.headers.get('location');
  expect(location).toContain('/projects/api/connections?execution=');
  expect((await post()).headers.get('location')).toBe(location);
  const jobs = await db.select().from(executionJobs).where(eq(executionJobs.targetId, f.target.id));
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ principalKind: 'human', principalId: userId, actorTokenId: null, actorSessionProof: sha256hex(sid), state: 'queued', workId: null, specRevision: null });
  expect(JSON.stringify(jobs[0])).not.toContain(sid);
  const attempt = await claim(f);
  expect(attempt.job.id).toBe(jobs[0]!.id);
  await db.delete(webSessions).where(eq(webSessions.id, sid));
  expect(ok(await heartbeatExecution(db, userId, f.grant, lease(f, attempt)))).toMatchObject({ cancel_requested: true });
  expect(await resolveExecutionCredential(db, sha256hex(attempt.attempt_token))).toBeNull();
  expect(ok(await report(f, attempt, 'cancelled', true)).state).toBe('cancelled');
});

it('follows a pinned browser dispatch on Work and separates claim, observed start and cancellation', async () => {
  const f = await workAssignmentFixture();
  const foreign = await workAssignmentFixture();
  const foreignJob = ok(await dispatchExecution(db, foreign.human, dispatchInput(foreign))).job;
  const sid = randomHex(32);
  await db.insert(webSessions).values({ id: sid, userId, expiresAt: new Date(Date.now() + 3600_000) });
  const app = createApp({ db, env });
  const headers = { 'x-forwarded-for': '127.0.0.1', cookie: `sid=${sid}` };
  const page = async (href: string) => {
    const response = await app.request(href, { headers });
    expect(response.status).toBe(200);
    return response.text();
  };
  const post = (href: string, body: Record<string, string>) => app.request(href, { method: 'POST', headers, body: new URLSearchParams(body) });
  const workUrl = `/app/teams/execution/projects/api/work/${f.work.key}`;
  const reviewUrl = `/app/sessions/${f.assignment.sessionId}/dispatch`;
  const review = await page(reviewUrl);
  for (const label of ['Queue eligibility', 'Worker readiness', 'Last worker contact never', 'Work contract', f.work.key, 'github.com/acme/api', 'stma worker doctor']) {
    expect(review).toContain(label);
  }
  const requestId = /name="request_id" value="([^"]+)"/.exec(review)?.[1];
  expect(requestId).toBeTruthy();
  const confirm = () => post(reviewUrl, { target_id: f.target.id, request_id: requestId!, grant_version: String(f.target.grant_version) });
  const response = await confirm();
  expect(response.status).toBe(303);
  const [job] = await db.select({ id: executionJobs.id }).from(executionJobs).where(eq(executionJobs.workId, f.work.work_id));
  const jobUrl = `${workUrl}?execution=${job!.id}`;
  expect(response.headers.get('location')).toBe(`${jobUrl}#execution-${job!.id}`);
  expect((await confirm()).headers.get('location')).toBe(response.headers.get('location'));
  const queued = await page(`${workUrl}?execution=${foreignJob.id}`);
  expect(queued).toContain(`id="execution-${job!.id}" data-execution-state="queued"`);
  expect(queued).not.toContain(foreignJob.id);
  expect(queued).not.toContain('Worker observed runtime start');
  expect(queued).toContain('No delivery has been submitted.');

  const attempt = await claim(f);
  expect(await page(jobUrl)).toContain('Claimed by worker');
  ok(await report(f, attempt, 'starting'));
  expect(await page(jobUrl)).not.toContain('Worker observed runtime start');
  ok(await report(f, attempt, 'running'));
  expect(await page(jobUrl)).toContain('Worker observed runtime start');

  const cancelled = await post(`/app/executions/${job!.id}/cancel`, { back_team: 'execution', back_project: 'api', back_execution: job!.id });
  expect(cancelled.status).toBe(302);
  const pending = await page(jobUrl);
  expect(pending).toContain('Waiting for a worker stop report');
  expect(pending).not.toContain('The worker reported the process stopped');
  ok(await report(f, attempt, 'cancelled', true));
  expect(await page(jobUrl)).toContain('The worker reported the process stopped');

  const next = ok(await dispatchExecution(db, f.human, dispatchInput(f))).job;
  const nextAttempt = await claim(f);
  ok(await report(f, nextAttempt, 'needs_input', true));
  const actionUrl = '/app/teams/execution/work';
  const action = (html: string) => /id="needs-your-action"([\s\S]*?)<\/section>/.exec(html)?.[1];
  expect(action(await page(actionUrl))).toContain(`?execution=${next.id}#execution-${next.id}`);
  const newest = ok(await dispatchExecution(db, f.human, dispatchInput(f))).job;
  expect(action(await page(actionUrl))).not.toContain('Check your worker');
  ok(await cancelExecution(db, f.human, newest.id));
  expect(await page(`${workUrl}?execution=${newest.id}`)).toContain('Cancelled before claim. No attempt was created.');

  for (let i = 0; i < 4; i++) {
    const history = ok(await dispatchExecution(db, f.human, dispatchInput(f))).job;
    ok(await cancelExecution(db, f.human, history.id));
  }
  const recent = await page(workUrl);
  expect([...recent.matchAll(/data-execution-state=/g)]).toHaveLength(5);
  expect(recent).not.toContain(job!.id);
  expect(recent).toContain('This list shows up to five executions.');
  expect(await page(jobUrl)).toContain(`id="execution-${job!.id}"`);

  const unresolved = ok(await dispatchExecution(db, f.human, dispatchInput(f))).job;
  const unresolvedAttempt = await claim(f);
  ok(await report(f, unresolvedAttempt, 'cancelled'));
  const uncertainUrl = `${workUrl}?execution=${unresolved.id}`;
  expect(await page(uncertainUrl)).toContain('Process ownership is unresolved');
  ok(await reconcileExecutionCapacity(db, f.human, unresolved.id, {
    requestId: randomUUID(), expectedState: 'dispatch_unknown', expectedGrantVersion: f.target.grant_version,
    verifiedStopped: true, reason: 'Verified this attempt stopped on the worker machine.',
  }));
  const reconciled = await page(uncertainUrl);
  expect(reconciled).toContain('A human recorded verification that the process stopped');
  expect(reconciled).toContain('Verified this attempt stopped on the worker machine.');
  expect(reconciled).toContain('Checkout is currently quarantined');
  expect(reconciled).not.toContain('Process ownership is unresolved');

  const restricted = createApp({ db, env }, { lifecycle: {
    authorize: async (_db, _principal, operation, args) => operation === 'browser' && args?.tool === 'get_execution' ? 'Fixture denies execution reads' : null,
  } });
  const restrictedPage = await restricted.request(jobUrl, { headers });
  expect(restrictedPage.status).toBe(200);
  expect(await restrictedPage.text()).not.toContain(job!.id);
});

it('atomically reserves capped slots across projects and preserves replays at capacity', async () => {
  const team = (await db.insert(teams).values({ name: 'Cap fixture', slug: 'cap-fixture', createdBy: userId, plan: 'team' }).returning())[0]!;
  await db.insert(memberships).values({ teamId: team.id, userId, role: 'owner' });
  const scopes = await db.insert(projects).values(['a', 'b'].map(slug => ({
    teamId: team.id, slug, name: slug, repositoryIdentity: `github.com/acme/${slug}`,
  }))).returning();
  const fixtures = [];
  for (const project of scopes) fixtures.push(await assignmentFixture({
    teamId: team.id, teamSlug: team.slug, projectId: project.id, projectSlug: project.slug, repositoryIdentity: project.repositoryIdentity!,
  }));
  const human = humanPrincipal(userId);
  const audit: CriticalAuditEvent[] = [];
  const audited = <T>(fn: () => Promise<T>) => withSecurityHooks({ audit: async (_tx, event) => { audit.push(event); } }, fn);
  const metered = <T>(fn: () => Promise<T>) => withEntitlements(undefined, fn, true, false);
  expect(ok(await metered(() => audited(() => setExecutionCapacity(db, human, team.id, 1))))).toEqual({ cap: 1 });
  expect(audit).toEqual([{ teamId: team.id, actorId: userId, action: 'execution_capacity_changed', subjectId: team.id }]);
  const inputs = fixtures.map(dispatchInput);
  const dispatch = (index: number) => metered(() => dispatchExecution(db, human, inputs[index]!));
  const results = await Promise.all([dispatch(0), dispatch(1)]);
  const admittedIndex = results.findIndex(row => !('error' in row));
  expect(admittedIndex).toBeGreaterThanOrEqual(0);
  const deniedIndex = 1 - admittedIndex;
  expect(results[deniedIndex]).toMatchObject({ error: { code: 'CAPACITY_EXCEEDED' } });
  const job = ok(results[admittedIndex]!).job;
  expect(ok(await dispatch(admittedIndex))).toMatchObject({ job: { id: job.id }, replayed: true });
  const active = fixtures[admittedIndex]!;
  const attempt = await claim(active);
  expect(attempt.job.id).toBe(job.id);
  expect(ok(await heartbeatExecution(db, userId, active.grant, lease(active, attempt))).cancel_requested).toBe(false);
  ok(await cancelExecution(db, human, job.id));
  expect(await dispatch(deniedIndex)).toMatchObject({ error: { code: 'CAPACITY_EXCEEDED' } });
  ok(await report(active, attempt, 'cancelled', true));
  const unresolved = ok(await dispatch(deniedIndex)).job;
  const other = fixtures[deniedIndex]!;
  const otherAttempt = await claim(other);
  expect(ok(await report(other, otherAttempt, 'cancelled')).state).toBe('dispatch_unknown');
  const retry = dispatchInput(active);
  expect(await metered(() => dispatchExecution(db, human, retry))).toMatchObject({ error: { code: 'CAPACITY_EXCEEDED' } });

  const member = (await db.insert(users).values({ username: 'cap-member' }).returning())[0]!;
  await db.insert(memberships).values({ teamId: team.id, userId: member.id, role: 'member' });
  const review = { requestId: randomUUID(), expectedState: 'dispatch_unknown', expectedGrantVersion: other.target.grant_version,
    verifiedStopped: true, reason: 'I checked the local process tree after stopping the worker.' };
  const release = (input = review) => metered(() => reconcileExecutionCapacity(db, human, unresolved.id, input));
  expect(await metered(() => reconcileExecutionCapacity(db, humanPrincipal(member.id), unresolved.id, review))).toMatchObject({ error: { code: 'FORBIDDEN' } });
  expect(await release({ ...review, verifiedStopped: false })).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  expect(await release({ ...review, expectedState: 'lost' })).toMatchObject({ error: { code: 'STALE_EXECUTION' } });
  expect(await release({ ...review, expectedGrantVersion: review.expectedGrantVersion - 1 })).toMatchObject({ error: { code: 'STALE_EXECUTION' } });
  await expect(withSecurityHooks({ audit: async () => { throw new Error('audit unavailable'); } }, () => release())).rejects.toThrow('audit unavailable');
  expect(await metered(() => dispatchExecution(db, human, retry))).toMatchObject({ error: { code: 'CAPACITY_EXCEEDED' } });

  const sid = randomHex(32);
  await db.insert(webSessions).values({ id: sid, userId, expiresAt: new Date(Date.now() + 3600_000) });
  const app = createApp({ db, env }, { lifecycle: { audit: async (_tx, event) => { audit.push(event); } } });
  const headers = { 'x-forwarded-for': '127.0.0.1', cookie: `sid=${sid}` };
  const detailUrl = `/app/teams/${team.slug}/projects/${other.target.project_name}/connections?execution=${unresolved.id}`;
  const detail = await app.request(detailUrl, { headers });
  expect(detail.status).toBe(200);
  const html = await detail.text();
  for (const value of [other.target.checkout_path, unresolved.id, 'Execution status unknown', 'Record verification and release slot']) {
    expect(html).toContain(value);
  }
  const reconciled = await app.request(`/app/executions/${unresolved.id}/reconcile-capacity`, {
    method: 'POST', headers,
    body: new URLSearchParams({
      request_id: review.requestId, expected_state: review.expectedState, grant_version: String(review.expectedGrantVersion),
      verified_stopped: 'yes', reason: review.reason, back_team: team.slug, back_project: other.target.project_name, back_execution: unresolved.id,
    }),
  });
  expect(reconciled.status).toBe(302);
  expect(ok(await release()).replayed).toBe(true);
  expect(await release({ ...review, reason: 'A different verification' })).toMatchObject({ error: { code: 'REQUEST_REUSED' } });
  expect(audit).toEqual(expect.arrayContaining([{ teamId: team.id, actorId: userId, action: 'execution_capacity_reconciled', subjectId: unresolved.id }]));
  expect(ok(await getExecution(db, human, unresolved.id))).toMatchObject({
    job: { state: 'dispatch_unknown' }, target: { quarantined: true }, attempt: { process_stopped: false },
    capacityReconciliation: { reason: review.reason, actor: { id: userId, label: 'execution-owner' } },
  });
  expect(await resolveExecutionCredential(db, sha256hex(otherAttempt.attempt_token))).toBeNull();
  expect(ok(await claimExecution(db, userId, other.grant, { target_id: other.target.id, worker_id: other.workerId }))).toEqual({ job: null });
  expect(ok(await metered(() => dispatchExecution(db, human, retry))).job.state).toBe('queued');
  await db.update(teams).set({ plan: 'solo' }).where(eq(teams.id, team.id));
  expect(await metered(() => setExecutionCapacity(db, human, team.id, null))).toMatchObject({ error: { code: 'LIMIT_EXCEEDED' } });
});

it('narrows dispatcher access without granting scope and revokes queued and active jobs', async () => {
  const active = await assignmentFixture();
  const queued = await assignmentFixture();
  const dispatcher = (await db.insert(users).values({ username: 'execution-dispatcher' }).returning())[0]!;
  const outsider = (await db.insert(users).values({ username: 'execution-outsider' }).returning())[0]!;
  await db.insert(memberships).values({ teamId, userId: dispatcher.id, role: 'member' });
  const actor = humanPrincipal(dispatcher.id);
  const leadPat = generatePat();
  const lead = (await db.insert(tokens).values({ userId: dispatcher.id, name: 'lead', scope: 'project', teamId, projectId,
    tokenHash: leadPat.hash, prefix: leadPat.prefix }).returning())[0]!;
  const agent = agentPrincipal(dispatcher.id, { ...active.grant, tokenId: lead.id, installationId: null });
  expect(await setExecutionDispatchers(db, actor, active.target.id, [dispatcher.id])).toMatchObject({ error: { code: 'FORBIDDEN' } });
  expect(await setExecutionDispatchers(db, active.human, active.target.id, [outsider.id])).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  for (const f of [active, queued]) ok(await setExecutionDispatchers(db, f.human, f.target.id, [dispatcher.id]));
  expect(await dispatchExecution(db, active.human, dispatchInput(active))).toMatchObject({ error: { code: 'FORBIDDEN' } });
  const activeJob = ok(await dispatchExecution(db, agent, dispatchInput(active))).job;
  const attempt = await claim(active);
  const queuedJob = ok(await dispatchExecution(db, actor, dispatchInput(queued))).job;
  const audit: CriticalAuditEvent[] = [];
  await withSecurityHooks({ audit: async (_tx, event) => { audit.push(event); } }, async () => {
    for (const f of [active, queued]) ok(await setExecutionDispatchers(db, f.human, f.target.id, []));
  });
  expect(audit.map(row => row.action)).toEqual(['execution_dispatchers_changed', 'execution_dispatchers_changed']);
  expect(await resolveExecutionCredential(db, sha256hex(attempt.attempt_token))).toBeNull();
  expect(ok(await getExecution(db, active.human, activeJob.id))).toMatchObject({
    job: { state: 'cancel_requested' }, events: expect.arrayContaining([expect.objectContaining({ reason: 'dispatcher_revoked' })]),
  });
  expect(ok(await heartbeatExecution(db, userId, active.grant, lease(active, attempt))).cancel_requested).toBe(true);
  expect(ok(await getExecution(db, queued.human, queuedJob.id)).job.state).toBe('cancelled');
  expect(ok(await claimExecution(db, userId, queued.grant, { target_id: queued.target.id, worker_id: queued.workerId }))).toEqual({ job: null });
  expect(await dispatchExecution(db, actor, dispatchInput(queued))).toMatchObject({ error: { code: 'FORBIDDEN' } });
});

it('lets only one worker claim and refuses a second dispatch for the active assignment', async () => {
  const f = await fixture();
  const claims = await Promise.all([claim(f), claimExecution(db, userId, f.grant, { target_id: f.target.id, worker_id: randomUUID() })]);
  expect(claims.filter(c => 'job' in c && c.job !== null)).toHaveLength(1);
  const again = await dispatchExecution(db, f.human, { target_id: f.target.id, session_id: f.assignment.sessionId, request_id: randomUUID() });
  expect(again).toMatchObject({ error: { code: 'ALREADY_DISPATCHED' } });
});

it('uses one run for MCP and hook start and refuses broad credentials on that run and session', async () => {
  const f = await fixture(); const c = await claim(f); const grant = await childGrant(f, c);
  const input = { installationId: f.grant.installationId!, team: 'execution', project: 'api', repositoryIdentity: 'github.com/acme/api', claims: [] };
  const first = await withExecutionRequest(db, grant, tx => startAgentRun(tx, userId, input, 15, projectId, grant));
  expect(first).not.toHaveProperty('error');
  const second = await withExecutionRequest(db, grant, tx => startAgentRun(tx, userId, { ...input, requestId: randomUUID(), intent: 'An attempted second run' }, 15, projectId, grant));
  expect((second as any).run.id).toBe((first as any).run.id);
  expect((await db.select().from(agentRuns).where(eq(agentRuns.installationId, f.grant.installationId!)))).toHaveLength(1);
  expect(await managedResourceRefusal(db, f.grant, { runId: (first as any).run.id })).toBeTruthy();
  expect(await managedResourceRefusal(db, { ...f.grant, installationId: null, scope: 'personal' }, { sessionId: f.assignment.sessionId })).toBeTruthy();
  expect(await guardExecutionHttp(db, f.grant, '/mcp', 'POST', null)).toContain('worker-only');
  expect(await guardExecutionHttp(db, grant, '/api/agent/worker/claim', 'POST', null)).toContain('cannot operate');
  expect(await guardExecutionHttp(db, grant, `/api/agent/runs/${randomUUID()}/heartbeat`, 'POST', {})).toContain('own bound run');
  await withExecutionRequest(db, grant, tx => finishAgentRun(tx, (first as any).run.id, userId, 'completed'));
  const app = createApp({ db, env });
  const closedRun=(await db.select().from(agentRuns).where(eq(agentRuns.id,(first as any).run.id)))[0]!;
  const heartbeat = await app.request(`/api/agent/runs/${closedRun.id}/heartbeat`, { method:'POST',headers:{'x-forwarded-for':'127.0.0.1',authorization:`Bearer ${c.attempt_token}`,'content-type':'application/json'},body:JSON.stringify({status:'active'}) });
  expect(heartbeat.status).toBe(200);
  expect(await heartbeat.json()).toEqual({ok:true,closed:true,runId:closedRun.id,status:'completed'});
  expect((await db.select().from(agentRuns).where(eq(agentRuns.id,closedRun.id)))[0]).toEqual(closedRun);
  const foreign = await app.request(`/api/agent/runs/${randomUUID()}/heartbeat`, { method:'POST',headers:{'x-forwarded-for':'127.0.0.1',authorization:`Bearer ${c.attempt_token}`,'content-type':'application/json'},body:'{}' });
  expect(foreign.status).toBe(403);
  const stopped = await app.request(`/api/agent/runs/${(first as any).run.id}/finish`, { method: 'POST', headers: { 'x-forwarded-for':'127.0.0.1', authorization:`Bearer ${c.attempt_token}`, 'content-type':'application/json' }, body:JSON.stringify({status:'completed'}) });
  expect(stopped.status).toBe(200);
  expect(await stopped.json()).toMatchObject({ok:true,runId:(first as any).run.id,status:'completed',replayed:true});
});

it('fences both real HTTP MCP and hook mutation when lease expires; never claims again', async () => {
  const f = await fixture(); const c = await claim(f);
  await db.update(executionAttempts).set({ leaseExpiresAt: new Date(0) }).where(eq(executionAttempts.id, c.attempt.id));
  const app = createApp({ db, env });
  const hook = await app.request('/api/agent/runs/start', { method: 'POST', headers: { 'x-forwarded-for': '127.0.0.1', authorization: `Bearer ${c.attempt_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ installationId: f.grant.installationId, team: 'execution', project: 'api', claims: [] }) });
  expect(hook.status).toBe(403);
  const mcp = await app.request('/mcp', { method: 'POST', headers: { 'x-forwarded-for': '127.0.0.1', authorization: `Bearer ${c.attempt_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'start_run', arguments: {} } }) });
  expect(mcp.status).toBe(403);
  expect(ok(await claimExecution(db, userId, f.grant, { target_id: f.target.id, worker_id: randomUUID() }))).toEqual({ job: null });
  const detail = ok(await getExecution(db, f.human, f.job.id));
  expect(detail.job.state).toBe('lost'); expect(detail.target.quarantined).toBe(true);
  expect(await resolveExecutionCredential(db, sha256hex(c.attempt_token))).toBeNull();
});

it('cancellation revokes child immediately, distinguishes requested and confirmed, and is idempotent', async () => {
  const f = await fixture(); const c = await claim(f);
  ok(await report(f, c, 'starting')); ok(await report(f, c, 'running'));
  expect(ok(await cancelExecution(db, f.human, f.job.id)).job.state).toBe('cancel_requested');
  expect(ok(await cancelExecution(db, f.human, f.job.id)).job.state).toBe('cancel_requested');
  expect(await resolveExecutionCredential(db, sha256hex(c.attempt_token))).toBeNull();
  expect(ok(await heartbeatExecution(db, userId, f.grant, lease(f,c))).cancel_requested).toBe(true);
  expect(ok(await report(f,c,'cancelled',true)).state).toBe('cancelled');
  expect((await report(f,c,'succeeded',true))).toMatchObject({ error: { code: 'STALE_ATTEMPT' } });
});

it('quarantines ambiguous termination and refuses reconfiguration or re-enable', async () => {
  const f = await fixture(); const c = await claim(f);
  ok(await report(f,c,'starting')); ok(await cancelExecution(db,f.human,f.job.id));
  expect(ok(await report(f,c,'cancelled',false)).state).toBe('dispatch_unknown');
  ok(await setExecutionTargetEnabled(db,f.human,f.target.id,false));
  expect(await setExecutionTargetEnabled(db,f.human,f.target.id,true)).toMatchObject({ error: { code: 'QUARANTINED' } });
  expect(ok(await claimExecution(db,userId,f.grant,{target_id:f.target.id,worker_id:randomUUID()}))).toEqual({job:null});
});

it('a proven stopped needs-input attempt releases occupancy but never retains child authority', async () => {
  const f = await fixture(); const c = await claim(f);
  expect(ok(await report(f,c,'needs_input',true)).state).toBe('needs_input');
  expect(await resolveExecutionCredential(db,sha256hex(c.attempt_token))).toBeNull();
  const again = ok(await dispatchExecution(db,f.human,{target_id:f.target.id,session_id:f.assignment.sessionId,request_id:randomUUID()}));
  const next = await claim(f);
  expect(next.job.id).toBe(again.job.id); expect(next.attempt.id).not.toBe(c.attempt.id);
  expect(ok(await getExecution(db,f.human,f.job.id)).target.quarantined).toBe(false);
});

it('worker event replay is exact, a foreign planned session cannot report running, and success does not accept work', async () => {
  const f = await fixture(); const c = await claim(f);
  const event = { ...lease(f,c), event_id: randomUUID(), state:'starting' as const, provider_session_id:c.attempt.provider_session_id, checkout_fingerprint:f.target.checkout_fingerprint, process_stopped:false, reason:'spawn_intent' as const };
  expect(ok(await reportExecutionEvent(db,userId,f.grant,event)).state).toBe('starting');
  expect(ok(await reportExecutionEvent(db,userId,f.grant,event)).state).toBe('starting');
  expect(await reportExecutionEvent(db,userId,f.grant,{...event,detail:'different'})).toMatchObject({error:{code:'REQUEST_REUSED'}});
  expect(await reportExecutionEvent(db,userId,f.grant,{...event,event_id:randomUUID(),state:'running',provider_session_id:randomUUID()})).toMatchObject({error:{code:'CORRELATION_MISMATCH'}});
  ok(await report(f,c,'running')); ok(await report(f,c,'succeeded',true));
  expect(ok(await getExecution(db,f.human,f.job.id))).toMatchObject({ job:{state:'succeeded'}, acceptance:'separate',result_provenance:'worker_reported' });
});

it('revoked installation and changed entitlements stop queued work before claim', async () => {
  const revoked = await fixture();
  await db.update(tokens).set({ revokedAt:new Date() }).where(eq(tokens.id,revoked.grant.tokenId));
  expect(await claimExecution(db,userId,revoked.grant,{target_id:revoked.target.id,worker_id:revoked.workerId})).toMatchObject({error:{code:'FORBIDDEN'}});
  const downgraded = await fixture();
  const response = await withEntitlements(async (_db,_team,base)=>({...base,fleet:'readonly'}),()=>claimExecution(db,userId,downgraded.grant,{target_id:downgraded.target.id,worker_id:downgraded.workerId}),true,false);
  expect(ok(response)).toEqual({job:null});
  expect(ok(await getExecution(db,downgraded.human,downgraded.job.id)).job.state).toBe('cancelled');
});

it('uses real metered plans for dispatch and safely stops an active attempt after downgrade', async () => {
  const f = await fixture();
  ok(await cancelExecution(db, f.human, f.job.id));
  const [original] = await db.select({ plan: teams.plan }).from(teams).where(eq(teams.id, teamId));
  const metered = <T>(fn: () => Promise<T>) => withEntitlements(undefined, fn, true, false);
  const setPlan = (plan: 'free' | 'solo' | 'team') => db.update(teams).set({ plan }).where(eq(teams.id, teamId));
  const dispatch = () => dispatchExecution(db, f.human, { target_id: f.target.id, session_id: f.assignment.sessionId, request_id: randomUUID() });
  try {
    await setPlan('free');
    expect(await metered(dispatch)).toMatchObject({ error: { code: 'LIMIT_EXCEEDED' } });
    expect(ok(await metered(() => getExecution(db, f.human, f.job.id))).job.state).toBe('cancelled');

    await setPlan('solo');
    const solo = ok(await metered(dispatch));
    expect(solo.job.state).toBe('queued');
    ok(await metered(() => cancelExecution(db, f.human, solo.job.id)));

    await setPlan('team');
    const team = ok(await metered(dispatch));
    const c = ok(await metered(() => claimExecution(db, userId, f.grant, { target_id: f.target.id, worker_id: f.workerId }))) as ExecutionClaimDto;
    expect(c.job.id).toBe(team.job.id);
    ok(await metered(() => report(f, c, 'starting')));
    ok(await metered(() => report(f, c, 'running')));

    await setPlan('free');
    expect(ok(await metered(() => heartbeatExecution(db, userId, f.grant, lease(f, c)))).cancel_requested).toBe(true);
    expect(await resolveExecutionCredential(db, sha256hex(c.attempt_token))).toBeNull();
    expect(ok(await metered(() => report(f, c, 'cancelled', true))).state).toBe('cancelled');
    expect(ok(await metered(() => getExecution(db, f.human, team.job.id))).job.state).toBe('cancelled');
  } finally {
    await db.update(teams).set({ plan: original!.plan }).where(eq(teams.id, teamId));
  }
});

it('reports enabled worker and queued execution exposure in the beta landing-plan ledger', async () => {
  const [original] = await db.select({ plan: teams.plan }).from(teams).where(eq(teams.id, teamId));
  const fleet = async () => (await betaLedger(db)).workspaces.find(row => row.teamId === teamId)!.features.find(feature => feature.key === 'fleet')!;
  const counts = (text: string) => {
    const match = /(?:^|; )(\d+) enabled worker targets? and (\d+) queued jobs?/.exec(text);
    if (!match) throw new Error('Worker exposure counts were not reported');
    return [Number(match[1]), Number(match[2])];
  };
  try {
    await db.update(teams).set({ plan: 'free' }).where(eq(teams.id, teamId));
    const before = counts((await fleet()).evidence);
    const f = await fixture();
    const observed = await fleet();
    expect(observed.state).toBe('in_use');
    expect(counts(observed.evidence)).toEqual([before[0]! + 1, before[1]! + 1]);
    expect(observed.evidence).toContain('queued work cannot be claimed');
    ok(await cancelExecution(db, f.human, f.job.id));
    await db.update(executionTargets).set({ enabled: false }).where(eq(executionTargets.id, f.target.id));
    expect(counts((await fleet()).evidence)).toEqual(before);
    await db.update(teams).set({ plan: 'team' }).where(eq(teams.id, teamId));
    expect((await fleet()).state).toBe('kept');
  } finally {
    await db.update(teams).set({ plan: original!.plan }).where(eq(teams.id, teamId));
  }
});

it('keeps Native Work readable through REST and MCP after a metered Team downgrade', async () => {
  const f = await fixture();
  const [original] = await db.select({ plan: teams.plan }).from(teams).where(eq(teams.id, teamId));
  const previousHosted = isHosted();
  const previousUnmetered = isUnmetered();
  let server: ReturnType<typeof serve> | undefined;
  try {
    // A dedicated worker token is deliberately worker-only; use a normal agent
    // installation for the ordinary Work REST and MCP doors.
    const normalPat = generatePat();
    const [normalToken] = await db.insert(tokens).values({ userId, name: 'ordinary reader', tokenHash: normalPat.hash, prefix: normalPat.prefix, scope: 'project', teamId, projectId }).returning();
    await db.insert(agentInstallations).values({ userId, tokenId: normalToken!.id, name: randomUUID(), deviceFingerprint: randomUUID(), clientType: 'claude-code' });
    await db.update(teams).set({ plan: 'team' }).where(eq(teams.id, teamId));
    const created = await withEntitlements(undefined, () => createWork(db, f.human, {
      request_id: randomUUID(), project: projectId,
      contract: { title: 'Downgrade work', goal: 'Keep existing work readable.', artifact_kind: 'code' },
    }), true, false);
    if ('error' in created) throw new Error(JSON.stringify(created.error));
    const meteredEnv = loadEnv({ nodeEnv: 'test', databaseUrl: undefined, hosted: true, betaUnmetered: false });
    const app = createApp({ db, env: meteredEnv });
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise<void>(resolve => server!.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback server did not bind');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const plan of ['team', 'free'] as const) {
      await db.update(teams).set({ plan }).where(eq(teams.id, teamId));
      const headers = { authorization: `Bearer ${normalPat.token}`, 'x-forwarded-for': '127.0.0.1' };
      const rest = await fetch(`${origin}/api/agent/work/${created.work_id}`, { headers });
      expect(rest.status).toBe(200);
      expect(JSON.stringify(await rest.json())).toContain('Downgrade work');
      const mcp = await fetch(`${origin}/mcp`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_work', arguments: { work_id: created.work_id } } }) });
      expect(mcp.status).toBe(200);
      const answer = await mcp.json() as { result?: { isError?: boolean; content?: { text: string }[] } };
      expect(answer.result?.isError).not.toBe(true);
      expect(answer.result?.content?.[0]?.text).toContain('Downgrade work');
    }
  } finally {
    try {
      if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
      await db.update(teams).set({ plan: original!.plan }).where(eq(teams.id, teamId));
    } finally {
      setHosted(previousHosted);
      setUnmetered(previousUnmetered);
    }
  }
});

it('withholds the managed MCP response when authority fails at commit', async () => {
  const f = await fixture();
  const attempt = await claim(f);
  const { agentReadState } = await import('../src/db/schema');
  let checks = 0;
  let stagedCursor = false;
  const app = createApp({ db, env }, { lifecycle: {
    async authorize(_tx, _principal, operation, args) {
      if (operation === 'browser' && args?.target_id === f.target.id && ++checks === 2) {
        stagedCursor = (await _tx.select().from(agentReadState).where(eq(agentReadState.sessionId, f.assignment.sessionId))).length === 1;
        return 'Fixture role expired before commit.';
      }
      return null;
    },
  } });
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback server did not bind.');
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${attempt.attempt_token}`, 'content-type': 'application/json',
        accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'get_session', arguments: { session_id: f.assignment.sessionId } } }),
    });
    const body = await response.text();
    expect(checks).toBe(2);
    expect(stagedCursor).toBe(true);
    expect(response.status).toBe(403);
    expect(body).toContain('Fixture role expired before commit.');
    expect(body).not.toContain('Inspect fixture');
    expect(await db.select().from(agentReadState).where(eq(agentReadState.sessionId, f.assignment.sessionId))).toHaveLength(0);
    const accepted = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${attempt.attempt_token}`, 'content-type': 'application/json',
        accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'get_session', arguments: { session_id: f.assignment.sessionId } } }),
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toContain('Inspect fixture');
    expect(await db.select().from(agentReadState).where(eq(agentReadState.sessionId, f.assignment.sessionId))).toHaveLength(1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

it('rechecks the composition for dispatch and current attempt rather than trusting a stored role', async () => {
  const f = await fixture(); const c = await claim(f); const grant = await childGrant(f,c);
  let denied = false;
  await withSecurityHooks({ authorize: async () => denied ? 'SSO or role was revoked' : null }, async () => {
    setSecurityPrincipal({userId,tokenId:f.grant.tokenId,teamId,projectId,path:'/mcp',method:'POST'});
    await withExecutionRequest(db,grant,async()=>undefined);
    denied = true;
    await expect(withExecutionRequest(db,grant,async()=>{throw new Error('must not reach mutation');})).rejects.toThrow('SSO or role was revoked');
  });
});

it('refuses the old pinned Native Work contract after its revision changes', async () => {
  const f = await workAssignmentFixture();
  ok(await dispatchExecution(db, f.human, dispatchInput(f)));
  const c = await claim(f); const grant = await childGrant(f,c);
  await db.update(workItems).set({specRevision:2}).where(eq(workItems.id,f.work.work_id));
  await expect(withExecutionRequest(db,grant,async()=>undefined)).rejects.toThrow('contract changed');
});

it('fences an already claimed attempt and requests a stop after its assignment is corrected', async () => {
  const f = await workAssignmentFixture();
  const job = ok(await dispatchExecution(db, f.human, dispatchInput(f))).job;
  const attempt = await claim(f);
  expect(attempt.job).toMatchObject({ id: job.id, work_id: f.work.work_id, spec_revision: f.work.spec_revision, state: 'leased' });
  const grant = await childGrant(f, attempt);
  ok(await report(f, attempt, 'starting'));
  ok(await report(f, attempt, 'running'));
  await f.correctLink(f.assignment.handoffId);

  await expect(withExecutionRequest(db, grant, async () => {
    throw new Error('must not reach the managed operation');
  })).rejects.toThrow('assignment link was corrected');
  expect(ok(await heartbeatExecution(db, userId, f.grant, lease(f, attempt)))).toMatchObject({ state: 'cancel_requested' });
  expect(await resolveExecutionCredential(db, sha256hex(attempt.attempt_token))).toBeNull();
  expect(ok(await getExecution(db, f.human, attempt.job.id)).attempt?.process_stopped).toBe(false);
});

it('rejects HTTP delivery attribution to a previous run of the same installation and work', async () => {
  const f = await workAssignmentFixture();
  ok(await dispatchExecution(db, f.human, dispatchInput(f)));
  const c = await claim(f);
  const workId = f.work.work_id;
  const [previous,current] = await db.insert(agentRuns).values([
    {installationId:f.grant.installationId!,teamId,projectId,status:'completed'},
    {installationId:f.grant.installationId!,teamId,projectId,status:'active'},
  ]).returning();
  for (const run of [previous!,current!]) await db.insert(workLinks).values({workId,teamId,projectId,kind:'run',runId:run.id,specRevision:1,createdByKind:'agent',createdById:f.grant.installationId!});
  await db.update(executionAttempts).set({runId:current!.id}).where(eq(executionAttempts.id,c.attempt.id));
  const app = createApp({db,env});
  const res = await app.request(`/api/agent/work/${workId}/deliveries`, {method:'POST',headers:{'x-forwarded-for':'127.0.0.1',authorization:`Bearer ${c.attempt_token}`,'content-type':'application/json'},
    body:JSON.stringify({work_id:workId,run_id:previous!.id,request_id:randomUUID(),expected_version:'1',spec_revision:1,artifacts:[]})});
  expect(res.status).toBe(403);
  expect((await res.json() as any).error).toContain('own bound run');
  const mismatch = await app.request(`/api/agent/work/${workId}/deliveries`, {method:'POST',headers:{'x-forwarded-for':'127.0.0.1',authorization:`Bearer ${c.attempt_token}`,'content-type':'application/json'},
    body:JSON.stringify({work_id:randomUUID(),run_id:current!.id})});
  expect(mismatch.status).toBe(403);
  expect((await mismatch.json() as any).error).toContain('another work');
});

it('meters agent dispatch in the domain while empty worker polling remains free', async () => {
  const f = await fixture();
  ok(await cancelExecution(db,f.human,f.job.id));
  const pat=generatePat();
  const lead=(await db.insert(tokens).values({userId,name:'lead',scope:'project',teamId,projectId,tokenHash:pat.hash,prefix:pat.prefix}).returning())[0]!;
  const principal=agentPrincipal(userId,{...f.grant,tokenId:lead.id,installationId:null});
  const denied=await withEntitlements(async(_db,_team,base)=>({...base,fleet:'full',maxToolCallsPerDay:0}),()=>dispatchExecution(db,principal,{target_id:f.target.id,session_id:f.assignment.sessionId,request_id:randomUUID()}),true,false);
  expect(denied).toMatchObject({error:{code:'LIMIT_EXCEEDED'}});
  expect(await withEntitlements(async(_db,_team,base)=>({...base,maxToolCallsPerDay:0}),()=>claimExecution(db,userId,f.grant,{target_id:f.target.id,worker_id:f.workerId}),true,false)).toEqual({job:null});
  expect(await db.select().from(executionJobs).where(eq(executionJobs.targetId,f.target.id))).toHaveLength(1);
});

it('rolls back a child mutation if authority expires before the request can commit', async()=>{
  const f=await fixture(); const c=await claim(f); const grant=await childGrant(f,c);
  await expect(withExecutionRequest(db,grant,async tx=>{
    await tx.update(executionTargets).set({runtimeVersion:'must roll back'}).where(eq(executionTargets.id,f.target.id));
    await tx.update(executionAttemptGrants).set({expiresAt:new Date(0)}).where(eq(executionAttemptGrants.attemptId,c.attempt.id));
  })).rejects.toThrow('expired before this request completed');
  expect((await db.select().from(executionTargets).where(eq(executionTargets.id,f.target.id)))[0]!.runtimeVersion).toBe('fixture');
});

it('an omitted MCP run id cannot select a managed run through a broad personal token',async()=>{
  const f=await fixture(); const c=await claim(f); const grant=await childGrant(f,c);
  const first=await withExecutionRequest(db,grant,tx=>startAgentRun(tx,userId,{installationId:f.grant.installationId!,team:'execution',project:'api',repositoryIdentity:'github.com/acme/api',claims:[]},15,projectId,grant));
  const pat=generatePat(); const token=(await db.insert(tokens).values({userId,name:'broad fixture',tokenHash:pat.hash,prefix:pat.prefix}).returning())[0]!;
  const callbacks=new Map<string,(args:any)=>Promise<any>>();
  registerFleetTools({registerTool:(name:string,_schema:unknown,callback:any)=>callbacks.set(name,callback)} as any,db,(await db.select().from(users).where(eq(users.id,userId)))[0]!,env,token,
    {...f.grant,tokenId:token.id,scope:'personal',installationId:null,teamId:null,projectId:null});
  await callbacks.get('finish_run')!({});
  expect((await db.select().from(agentRuns).where(eq(agentRuns.id,(first as any).run.id)))[0]!.status).toBe('active');
});

it('preserves pinned references on direct deletion while parent cascades remove the whole execution graph',async()=>{
  const constraints = await db.execute(sql`select conname, condeferrable, condeferred from pg_constraint where conname in ('execution_jobs_work_id_work_items_id_fk','execution_attempts_run_id_agent_runs_id_fk','execution_attempts_worker_id_worker_instances_id_fk')`);
  const constraintRows = Array.isArray(constraints) ? constraints : (constraints as unknown as {rows: Record<string,unknown>[]}).rows;
  expect(constraintRows).toHaveLength(3);
  for(const constraint of constraintRows) { expect(constraint.condeferrable).toBe(true); expect(constraint.condeferred).toBe(true); }
  for (const parent of ['target','project','team','user'] as const) {
    const id=randomUUID();
    const person=(await db.insert(users).values({username:`cascade-${id}`}).returning())[0]!;
    const team=(await db.insert(teams).values({slug:id,name:'Cascade',createdBy:userId}).returning())[0]!;
    const project=(await db.insert(projects).values({teamId:team.id,slug:'cascade',name:'Cascade',createdBy:userId}).returning())[0]!;
    const pat=generatePat();
    const token=(await db.insert(tokens).values({userId:person.id,name:'cascade',scope:'project',teamId:team.id,projectId:project.id,tokenHash:pat.hash,prefix:pat.prefix}).returning())[0]!;
    const installation=(await db.insert(agentInstallations).values({userId:person.id,tokenId:token.id,name:'cascade',deviceFingerprint:id}).returning())[0]!;
    const run=(await db.insert(agentRuns).values({installationId:installation.id,teamId:team.id,projectId:project.id,status:'active'}).returning())[0]!;
    const work=(await db.insert(workItems).values({teamId:team.id,projectId:project.id,number:1n,displayKey:'WORK-1',state:'ready',createdByKind:'human',createdById:userId}).returning())[0]!;
    const session=(await db.insert(debugSessions).values({teamId:team.id,projectId:project.id,title:'Cascade assignment',openedBy:userId}).returning())[0]!;
    const handoff=(await db.insert(handoffs).values({sessionId:session.id,offeredBy:userId,targetUserId:person.id,targetInstallationId:installation.id,kind:'assignment'}).returning())[0]!;
    const target=(await db.insert(executionTargets).values({installationId:installation.id,ownerId:person.id,teamId:team.id,projectId:project.id,checkoutPath:`C:/fixture/${id}`,checkoutFingerprint:sha256hex(id),runtime:EXECUTION_RUNTIME,runtimeVersion:'fixture',permissionProfile:EXECUTION_PERMISSION_PROFILE,maxRuntimeSeconds:300,maxTurns:5,enabled:true}).returning())[0]!;
    const workerId=randomUUID(); await db.insert(workerInstances).values({id:workerId,targetId:target.id});
    const job=(await db.insert(executionJobs).values({targetId:target.id,sessionId:session.id,handoffId:handoff.id,workId:work.id,specRevision:1,principalKind:'human',principalId:userId,actorUserId:userId,actorSecurityPrincipal:{userId,path:'/app',method:'POST'},requestId:randomUUID(),requestHash:sha256hex(id),grantVersion:1,maxRuntimeSeconds:300,maxTurns:5,state:'running',assignment:{task:'Cascade',brief:'Fixture',branch:null,repository_identity:null,start_call:{}}}).returning())[0]!;
    const attempt=(await db.insert(executionAttempts).values({jobId:job.id,workerId,fence:1,state:'running',leaseExpiresAt:new Date(Date.now()+60000),deadlineAt:new Date(Date.now()+300000),providerSessionId:randomUUID(),runId:run.id}).returning())[0]!;
    await db.insert(executionAttemptGrants).values({attemptId:attempt.id,parentTokenId:token.id,tokenHash:sha256hex(randomUUID()),expiresAt:new Date(Date.now()+60000)});
    await expect(db.delete(agentRuns).where(eq(agentRuns.id,run.id))).rejects.toThrow();
    await expect(db.delete(workItems).where(eq(workItems.id,work.id))).rejects.toThrow();
    if(parent==='target') await db.delete(executionTargets).where(eq(executionTargets.id,target.id));
    if(parent==='project') await db.delete(projects).where(eq(projects.id,project.id));
    if(parent==='team') await db.delete(teams).where(eq(teams.id,team.id));
    if(parent==='user') await db.delete(users).where(eq(users.id,person.id));
    expect(await db.select().from(executionAttempts).where(eq(executionAttempts.id,attempt.id))).toEqual([]);
    expect(await db.select().from(executionJobs).where(eq(executionJobs.id,job.id))).toEqual([]);
    expect(await db.select().from(workerInstances).where(eq(workerInstances.id,workerId))).toEqual([]);
  }
});
