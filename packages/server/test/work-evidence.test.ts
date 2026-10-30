import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activity,
  agentInstallations,
  agentRuns,
  memberships,
  projects,
  providerObservations,
  repositoryBindings,
  runCheckpoints,
  teamIntegrations,
  teams,
  tokens,
  users,
  workAcceptances,
  workCommands,
  workDeliveries,
  workEvents,
  workEvidence,
  workItems,
  workLinks,
} from '../src/db/schema';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';
import { observeAdoBuild } from '../src/domain/adoEvidence';
import { recordProviderObservation } from '../src/domain/providerEvidence';
import { createWork, updateWork } from '../src/domain/work';
import { recordDecision } from '../src/domain/workAcceptance';
import {
  WORK_HOSTED_MAX_DELIVERIES,
  WORK_HOSTED_MAX_EVIDENCE_PER_DELIVERY,
  evidenceState,
  readEvidence,
  recordEvidence,
  submitDelivery,
} from '../src/domain/workEvidence';
import { blockingState } from '../src/domain/workGraph';
import { getWork } from '../src/domain/workRead';
import { agentPrincipal, humanPrincipal, type WorkPrincipal, type WorkResult } from '../src/domain/workTypes';
import { adoOutbox } from '../src/lib/azureDevops';
import * as github from '../src/lib/github';
import { isTokenScope, type AgentGrant } from '../src/lib/grants';

/**
 * Deliveries, evidence, readiness and the decision, driven through the domain
 * functions every door will call, with principals built from real rows: people
 * signed in through the browser and agents enrolled the way a client connects.
 *
 * Runs are linked to work with a direct `work_links` insert: the link
 * operation and the work fields on `start_run` belong to another step, and what
 * this file proves is what a link permits, not how one is made. Provider facts
 * go through `recordProviderObservation`, the function the webhooks call, so
 * the evidence epoch moves exactly as it will in production.
 */

let srv: StartedServer;
let dataDir: string;
let env: ReturnType<typeof loadEnv>;
let teamId = '';
let alphaId = '';
let betaId = '';
let hookToken = '';
let githubBindingId = '';
let lead: WorkPrincipal;
let bob: WorkPrincipal;
let agentA: WorkPrincipal;
let agentB: WorkPrincipal;

const REPO = 'github.com/acme/alpha';
const GITHUB_REPOSITORY_ID = 'gh-alpha-1';
const commit = () => randomBytes(20).toString('hex');

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

/**
 * fetch, retried once on a connection-level failure. The server and this file
 * share one event loop, and a long stretch of direct database work can leave
 * fetch holding a keep-alive socket the server has just closed, surfaced as
 * ECONNRESET: a property of the runner, not of the route (`governance.test.ts`
 * retries its form posts the same way).
 */
async function fetchRetrying(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (attempt > 0) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

const form = (url: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
  fetchRetrying(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });

let rpcId = 1;
async function call(tool: string, args: Record<string, unknown>, tok: string) {
  const res = await fetchRetrying(`${srv.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${tok}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const json = (await res.json()) as {
    result?: { content?: { text: string }[]; isError?: boolean };
    error?: { message?: string };
  };
  const text = json.result?.content?.[0]?.text ?? json.error?.message ?? '';
  return { text, isError: json.result?.isError === true || json.error !== undefined };
}

async function connectAgent(cookie: Record<string, string>, name: string, device: string, access: string) {
  const page = await form(`${srv.url}/app/tokens`, { name, device, access, client: 'codex', role: 'generalist' }, cookie);
  const html = await page.text();
  const code = /(?:&quot;|")STMA_ENROLLMENT_CODE(?:&quot;|")\s*:\s*(?:&quot;|")([^"&<]+)/.exec(html)?.[1];
  expect(code, `enrollment code for ${name}`).toMatch(/^stma_enroll_/);
  const redeemed = (await (
    await fetchRetrying(`${srv.url}/api/agent-enrollments/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
  ).json()) as { token: string };
  const who = await call('whoami', {}, redeemed.token);
  expect(who.isError, who.text).toBe(false);
  return redeemed.token;
}

/** The grant `mcpAuth` would attach to a request carrying this token, read from the rows. */
async function principalForToken(token: string): Promise<WorkPrincipal> {
  const hash = createHash('sha256').update(token).digest('hex');
  const [row] = await srv.db
    .select({
      token: tokens,
      teamSlug: teams.slug,
      teamName: teams.name,
      projectSlug: projects.slug,
      projectName: projects.name,
      installationId: agentInstallations.id,
      installationName: agentInstallations.name,
      installationDeviceLabel: agentInstallations.deviceLabel,
      installationCompanionOf: agentInstallations.companionOf,
      installationClientType: agentInstallations.clientType,
    })
    .from(tokens)
    .leftJoin(teams, eq(tokens.teamId, teams.id))
    .leftJoin(projects, eq(tokens.projectId, projects.id))
    .leftJoin(agentInstallations, eq(agentInstallations.tokenId, tokens.id))
    .where(eq(tokens.tokenHash, hash))
    .limit(1);
  if (!row || !isTokenScope(row.token.scope)) throw new Error('no such credential');
  const grant: AgentGrant = {
    tokenId: row.token.id,
    scope: row.token.scope,
    teamId: row.token.teamId,
    teamSlug: row.teamSlug,
    teamName: row.teamName,
    projectId: row.token.projectId,
    projectSlug: row.projectSlug,
    projectName: row.projectName,
    installationId: row.installationId,
    installationName: row.installationName,
    deviceLabel: row.installationDeviceLabel,
    companionInstallationId: row.installationCompanionOf ?? null,
    clientType: row.installationClientType ?? null,
  };
  return agentPrincipal(row.token.userId, grant);
}

const userId = async (username: string) =>
  (await srv.db.select({ id: users.id }).from(users).where(eq(users.username, username)))[0]!.id;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-work-evidence-'));
  env = loadEnv({ port: 0, host: '127.0.0.1', nodeEnv: 'test', devMode: true, databaseUrl: undefined, pgliteDir: dataDir });
  srv = await startServer(env);
  const leadJar = jar();
  leadJar.store(await form(`${srv.url}/auth/dev`, { username: 'lead' }));
  const leadCookie = leadJar.header();
  await form(`${srv.url}/app/teams`, { name: 'Work Evidence' }, leadCookie);
  const [team] = await srv.db.select().from(teams).where(eq(teams.slug, 'work-evidence'));
  teamId = team!.id;
  hookToken = team!.inboundToken ?? '';
  expect(hookToken, 'the workspace has an inbound hook token').toBeTruthy();
  await form(`${srv.url}/app/projects`, { team: 'work-evidence', project: 'alpha' }, leadCookie);
  await form(`${srv.url}/app/projects`, { team: 'work-evidence', project: 'beta' }, leadCookie);
  const rows = await srv.db.select().from(projects).where(eq(projects.teamId, teamId));
  alphaId = rows.find((p) => p.name === 'alpha')!.id;
  betaId = rows.find((p) => p.name === 'beta')!.id;
  await srv.db.update(projects).set({ repositoryIdentity: REPO }).where(eq(projects.id, alphaId));

  await form(`${srv.url}/app/teams/work-evidence/invites`, {}, leadCookie);
  const people = await (await fetchRetrying(`${srv.url}/app/teams/work-evidence?tab=people`, { headers: leadCookie })).text();
  const invite = /\/join\/([A-Za-z0-9_-]+)/.exec(people)?.[1] ?? '';
  expect(invite, 'invite code').toBeTruthy();
  const bobJar = jar();
  bobJar.store(await form(`${srv.url}/auth/dev`, { username: 'bob' }));
  await form(`${srv.url}/join/${invite}`, {}, bobJar.header());

  lead = humanPrincipal(await userId('lead'));
  bob = humanPrincipal(await userId('bob'));
  agentA = await principalForToken(await connectAgent(leadCookie, 'codex-a', 'mac', `project:${alphaId}`));
  agentB = await principalForToken(await connectAgent(leadCookie, 'codex-b', 'win', `project:${alphaId}`));

  const [connection] = await srv.db
    .insert(teamIntegrations)
    .values({ teamId, provider: 'github', repo: 'acme/alpha', token: 'fixture-only' })
    .returning();
  const [binding] = await srv.db
    .insert(repositoryBindings)
    .values({
      connectionId: connection!.id,
      teamId,
      projectId: alphaId,
      provider: 'github',
      repositoryId: GITHUB_REPOSITORY_ID,
      fullName: 'acme/alpha',
      verifiedAt: new Date(),
    })
    .returning();
  githubBindingId = binding!.id;
});

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const ok = <T>(result: WorkResult<T>): T => {
  if (result && typeof result === 'object' && 'error' in result) {
    throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  }
  return result as T;
};
const refusal = (result: unknown) => {
  expect(result && typeof result === 'object' && 'error' in result, JSON.stringify(result)).toBe(true);
  return (result as { error: { code: string; message: string; fields?: string[]; current_version?: string; used?: number; limit?: number } }).error;
};

const installationOf = (principal: WorkPrincipal) => {
  if (principal.kind !== 'agent' || !principal.installationId) throw new Error('an enrolled agent');
  return principal.installationId;
};

type Criterion = Record<string, unknown>;

/** A ready work item in alpha, owned by lead, accepted by bob unless another acceptor is named. */
async function readyWork(criteria: Criterion[], contract: Record<string, unknown> = {}, acceptor = 'bob') {
  const created = ok(
    await createWork(srv.db, lead, {
      request_id: randomUUID(),
      project: 'alpha',
      contract: { title: 'Print a shipping label', goal: 'A paid order prints a label.', artifact_kind: 'code', ...contract },
      criteria,
      acceptor,
    }),
  );
  const ready = ok(
    await updateWork(srv.db, lead, {
      request_id: randomUUID(),
      work_id: created.work_id,
      expected_version: created.version,
      operation: 'transition',
      payload: { to: 'ready' },
    }),
  );
  return { workId: created.work_id, version: ready.version };
}

/** A live run of this agent in a project, linked to the work when one is named. */
async function run(principal: WorkPrincipal, workId: string | null, projectId = alphaId) {
  const installationId = installationOf(principal);
  const [row] = await srv.db
    .insert(agentRuns)
    .values({ installationId, teamId, projectId, status: 'active', repo: REPO, branch: 'work' })
    .returning();
  if (workId) {
    await srv.db.insert(workLinks).values({
      workId,
      teamId,
      projectId,
      kind: 'run',
      runId: row!.id,
      specRevision: 1,
      createdByKind: 'agent',
      createdById: installationId,
    });
  }
  return row!.id;
}

async function checkpoint(runId: string, sha: string, projectId = alphaId, repositoryIdentity = REPO) {
  const [run] = await srv.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
  const [row] = await srv.db
    .insert(runCheckpoints)
    .values({
      runId,
      teamId,
      projectId,
      installationId: run!.installationId,
      kind: 'delivery',
      repositoryIdentity,
      commitSha: sha,
      worktreeClean: true,
      tests: [],
      requestId: randomUUID(),
      requestHash: randomUUID(),
    })
    .returning();
  return row!.id;
}

const code = (sha: string, extra: Record<string, unknown> = {}) => ({
  kind: 'code',
  repository_identity: 'https://github.com/acme/alpha.git',
  commit_sha: sha,
  ...extra,
});

const submit = (principal: WorkPrincipal, workId: string, version: string, extra: Record<string, unknown> = {}) =>
  submitDelivery(
    srv.db,
    principal,
    { request_id: randomUUID(), work_id: workId, expected_version: version, spec_revision: 1, artifacts: [code(commit())], ...extra },
    { hosted: false },
  );

const report = (
  principal: WorkPrincipal,
  workId: string,
  version: string,
  deliveryId: string,
  extra: Record<string, unknown>,
) =>
  recordEvidence(
    srv.db,
    principal,
    {
      request_id: randomUUID(),
      work_id: workId,
      expected_version: version,
      delivery_id: deliveryId,
      criterion_id: 'c1',
      assertion: 'pass',
      source_kind: 'agent_report',
      source_ref: 'npm test',
      ...extra,
    },
    { hosted: false },
  );

const observe = (
  sha: string,
  fact: {
    subjectId: string;
    name?: string;
    definition?: string;
    state: 'success' | 'failure' | 'unknown';
    attempt?: number;
    observedAt?: Date;
  },
) =>
  recordProviderObservation(srv.db, teamId, 'github', {
    bindingId: githubBindingId,
    repositoryId: GITHUB_REPOSITORY_ID,
    deliveryId: randomUUID(),
    subjectId: fact.subjectId,
    subjectName: fact.name,
    subjectDefinition: fact.definition,
    commitSha: sha,
    kind: 'workflow',
    state: fact.state,
    attempt: fact.attempt ?? 1,
    observedAt: fact.observedAt ?? new Date(Date.now() - 1_000),
  });

/** The evidence a person sees, and a decision bound to exactly that snapshot. */
async function decide(principal: WorkPrincipal, workId: string, decision: 'accept' | 'request_changes', extra: Record<string, unknown> = {}) {
  const seen = ok(await readEvidence(srv.db, principal, workId)) as any;
  return recordDecision(srv.db, principal, workId, {
    request_id: randomUUID(),
    expected_version: seen.version,
    spec_revision: seen.spec_revision,
    delivery_id: seen.delivery_id,
    evidence_epoch: seen.evidence_epoch,
    evidence_manifest_hash: seen.evidence_manifest_hash,
    decision,
    ...extra,
  });
}

const criterionOf = (readiness: any, id: string) => readiness.criteria.find((c: any) => c.id === id);
const readinessOf = async (principal: WorkPrincipal, workId: string) =>
  ((ok(await readEvidence(srv.db, principal, workId)) as any).readiness);
const workRow = async (workId: string) => (await srv.db.select().from(workItems).where(eq(workItems.id, workId)))[0]!;

describe('submitting a delivery', () => {
  it('refuses a wrong commit, a wrong repository, a checkpoint from another project and an unlinked run, and writes nothing', async () => {
    const { workId, version } = await readyWork([{ text: 'A label prints.' }]);
    const runId = await run(agentA, workId);
    const sha = commit();
    const cp = await checkpoint(runId, sha);

    const wrongSha = refusal(await submit(agentA, workId, version, { artifacts: [code(commit(), { checkpoint_id: cp })] }));
    expect(wrongSha.code).toBe('INVALID_INPUT');
    expect(wrongSha.fields).toEqual(['artifacts[0].commit_sha']);

    const wrongRepo = refusal(
      await submit(agentA, workId, version, { artifacts: [code(sha, { repository_identity: 'github.com/acme/other' })] }),
    );
    expect(wrongRepo.code).toBe('INVALID_INPUT');
    expect(wrongRepo.fields).toEqual(['artifacts[0].repository_identity']);

    const elsewhere = await checkpoint(await run(agentA, null, betaId), sha, betaId);
    const otherProject = refusal(await submit(agentA, workId, version, { artifacts: [code(sha, { checkpoint_id: elsewhere })] }));
    expect(otherProject.fields).toEqual(['artifacts[0].checkpoint_id']);

    const unlinkedRun = await run(agentA, null);
    const notLinked = refusal(await submit(agentA, workId, version, { run_id: unlinkedRun }));
    expect(notLinked.code).toBe('INVALID_INPUT');
    expect(notLinked.fields).toEqual(['run_id']);

    const stranger = refusal(await submit(agentB, workId, version));
    expect(stranger.code).toBe('FORBIDDEN');

    const oldContract = refusal(await submit(agentA, workId, version, { spec_revision: 2 }));
    expect(oldContract.code).toBe('CONTRACT_CHANGED');

    expect(await srv.db.select().from(workDeliveries).where(eq(workDeliveries.workId, workId))).toHaveLength(0);
    expect((await workRow(workId)).version.toString()).toBe(version);
    // A refused command leaves no receipt: the same request id stays free.
    const receipts = await srv.db.select().from(workCommands).where(eq(workCommands.workId, workId));
    expect(receipts.map((r) => r.operation).sort()).toEqual(['create', 'transition']);
  });

  it('puts ready work in review through in progress, keeps a replay to one delivery, and lets a later one supersede it', async () => {
    const { workId, version } = await readyWork([{ text: 'A label prints.' }]);
    const runId = await run(agentA, workId);
    const sha = commit();
    const cp = await checkpoint(runId, sha);
    const input = {
      request_id: randomUUID(),
      work_id: workId,
      expected_version: version,
      spec_revision: 1,
      run_id: runId,
      artifacts: [code(sha.toUpperCase(), { checkpoint_id: cp, branch: 'label-printer' })],
      evidence: [{ criterion_id: 'c1', assertion: 'pass', source_kind: 'checkpoint', source_ref: cp }],
    };
    const first = ok(await submitDelivery(srv.db, agentA, input, { hosted: false })) as any;
    expect(first).toMatchObject({ state: 'in_review', sequence: 1, evidence_epoch: '1', replayed: false });
    expect(first.readiness.ready_for_review).toBe(true);

    const [delivery] = await srv.db.select().from(workDeliveries).where(eq(workDeliveries.workId, workId));
    expect(delivery!.artifacts).toEqual([
      { kind: 'code', repository_identity: REPO, commit_sha: sha, checkpoint_id: cp, branch: 'label-printer' },
    ]);
    expect(delivery!.runId).toBe(runId);
    const [evidence] = await srv.db.select().from(workEvidence).where(eq(workEvidence.deliveryId, delivery!.id));
    expect(evidence).toMatchObject({ provenance: 'agent_reported', reportedByKind: 'agent', reportedById: installationOf(agentA) });

    const events = await srv.db.select().from(workEvents).where(and(eq(workEvents.workId, workId), eq(workEvents.type, 'work_delivered')));
    expect(events[0]!.payload).toMatchObject({ state: { from: 'ready', to: 'in_review', through: 'in_progress' }, sequence: 1 });

    const replay = ok(await submitDelivery(srv.db, agentA, input, { hosted: false }));
    expect(replay).toMatchObject({ replayed: true, result_ref: delivery!.id });
    expect(await srv.db.select().from(workDeliveries).where(eq(workDeliveries.workId, workId))).toHaveLength(1);

    const second = ok(await submit(agentA, workId, first.version)) as any;
    expect(second).toMatchObject({ sequence: 2, supersedes_delivery_id: delivery!.id, evidence_epoch: '2' });
    // Evidence does not move to another artifact set by itself.
    expect(criterionOf(second.readiness, 'c1')).toMatchObject({ result: 'unknown', reasons: ['no_evidence'] });
    const manifest = ((ok(await readEvidence(srv.db, bob, workId)) as any).manifest);
    expect(manifest.criteria[0].older_deliveries).toBe(1);
  });
});

describe('evidence and its provenance', () => {
  it('never lets a caller choose provenance or a provider source', async () => {
    const { workId, version } = await readyWork([
      { text: 'CI passes.', evidence_kinds: ['provider_observation'], verification_rule: { mode: 'all', selectors: [{ source: 'provider_observation', provider: 'github', subject: 'ci' }] } },
    ]);
    await run(agentA, workId);
    const spoofedInline = refusal(
      await submit(agentA, workId, version, {
        evidence: [{ criterion_id: 'c1', assertion: 'pass', source_kind: 'agent_report', source_ref: 'ci', provenance: 'provider_observed' }],
      }),
    );
    expect(spoofedInline.code).toBe('INVALID_INPUT');

    const delivered = ok(await submit(agentA, workId, version)) as any;
    const spoofed = refusal(await report(agentA, workId, delivered.version, delivered.delivery_id, { provenance: 'provider_observed' }));
    expect(spoofed.code).toBe('INVALID_INPUT');
    const providerShaped = refusal(await report(agentA, workId, delivered.version, delivered.delivery_id, { source_kind: 'provider_observation' }));
    expect(providerShaped.code).toBe('INVALID_INPUT');
    const person = refusal(await report(bob, workId, delivered.version, delivered.delivery_id, {}));
    expect(person.code).toBe('FORBIDDEN');

    // An agent's claim that CI passed lands as its own report and satisfies nothing provider-shaped.
    const claimed = ok(await report(agentA, workId, delivered.version, delivered.delivery_id, { source_ref: 'ci said green' })) as any;
    expect(claimed.provenance).toBe('agent_reported');
    expect(claimed.criterion).toMatchObject({ result: 'unknown', reasons: ['not_observed'] });
    const rows = await srv.db.select().from(workEvidence).where(eq(workEvidence.workId, workId));
    expect(rows.map((row) => row.provenance)).toEqual(['agent_reported']);
  });

  it('refuses evidence for a superseded delivery and lets a reporter supersede only its own row', async () => {
    const { workId, version } = await readyWork([{ text: 'A label prints.' }, { id: 'docs', text: 'The help says how.' }]);
    await run(agentA, workId);
    await run(agentB, workId);
    const first = ok(await submit(agentA, workId, version)) as any;
    const second = ok(await submit(agentA, workId, first.version)) as any;
    const stale = refusal(await report(agentA, workId, second.version, first.delivery_id, {}));
    expect(stale.code).toBe('EVIDENCE_STALE');
    expect(stale.fields).toEqual(['delivery_id']);

    const failed = ok(await report(agentA, workId, second.version, second.delivery_id, { assertion: 'fail' })) as any;
    expect(failed.criterion.result).toBe('fail');
    const notMine = refusal(
      await report(agentB, workId, failed.version, second.delivery_id, { supersedes_id: failed.evidence_id }),
    );
    expect(notMine.fields).toEqual(['supersedes_id']);
    const otherCriterion = refusal(
      await report(agentA, workId, failed.version, second.delivery_id, { criterion_id: 'docs', supersedes_id: failed.evidence_id }),
    );
    expect(otherCriterion.fields).toEqual(['supersedes_id']);
    const corrected = ok(
      await report(agentA, workId, failed.version, second.delivery_id, { supersedes_id: failed.evidence_id }),
    ) as any;
    expect(corrected.criterion.result).toBe('pass');
    expect(corrected.evidence_epoch).toBe('4');
    // Superseded, never deleted.
    expect(await srv.db.select().from(workEvidence).where(eq(workEvidence.deliveryId, second.delivery_id))).toHaveLength(2);
  });

  it('refuses evidence and deliveries past the hosted guardrails with the numbers', async () => {
    const { workId, version } = await readyWork([{ text: 'A label prints.' }]);
    await run(agentA, workId);
    const delivered = ok(await submit(agentA, workId, version)) as any;
    const filler = Array.from({ length: WORK_HOSTED_MAX_EVIDENCE_PER_DELIVERY }, () => ({
      workId,
      deliveryId: delivered.delivery_id,
      criterionId: 'c1',
      specRevision: 1,
      sourceKind: 'agent_report',
      sourceRef: 'filler',
      assertion: 'pass',
      provenance: 'agent_reported',
      reportedByKind: 'agent',
      reportedById: installationOf(agentA),
    }));
    await srv.db.insert(workEvidence).values(filler);
    const capped = refusal(
      await recordEvidence(
        srv.db,
        agentA,
        {
          request_id: randomUUID(),
          work_id: workId,
          expected_version: delivered.version,
          delivery_id: delivered.delivery_id,
          criterion_id: 'c1',
          assertion: 'pass',
          source_kind: 'agent_report',
          source_ref: 'npm test',
        },
        { hosted: true },
      ),
    );
    expect(capped).toMatchObject({ code: 'LIMIT_EXCEEDED', used: WORK_HOSTED_MAX_EVIDENCE_PER_DELIVERY, limit: WORK_HOSTED_MAX_EVIDENCE_PER_DELIVERY });

    const earlier = Array.from({ length: WORK_HOSTED_MAX_DELIVERIES - 1 }, (_, index) => ({
      workId,
      specRevision: 1,
      sequence: 100 + index,
      artifacts: [],
      artifactSetHash: 'x',
      submittedByKind: 'agent',
      submittedById: installationOf(agentA),
    }));
    await srv.db.insert(workDeliveries).values(earlier);
    const tooMany = refusal(
      await submitDelivery(
        srv.db,
        agentA,
        { request_id: randomUUID(), work_id: workId, expected_version: delivered.version, spec_revision: 1, artifacts: [code(commit())] },
        { hosted: true },
      ),
    );
    expect(tooMany).toMatchObject({ code: 'LIMIT_EXCEEDED', used: WORK_HOSTED_MAX_DELIVERIES, limit: WORK_HOSTED_MAX_DELIVERIES });
    // Self-hosted instances never apply the guardrail.
    expect(
      ok(
        await submitDelivery(
          srv.db,
          agentA,
          { request_id: randomUUID(), work_id: workId, expected_version: delivered.version, spec_revision: 1, artifacts: [code(commit())] },
          { hosted: false },
        ),
      ),
    ).toMatchObject({ sequence: 100 + WORK_HOSTED_MAX_DELIVERIES - 1 });
  });
});

describe('readiness', () => {
  it('keeps an unversioned document failure visible beside a later artifact pass', async () => {
    const { workId, version } = await readyWork([{ text: 'Every artifact works.', evidence_kinds: ['artifact'] }]);
    await run(agentA, workId);
    const sha = commit();
    const uri = 'https://docs.example.com/mutable-runbook';
    const delivered = ok(await submit(agentA, workId, version, { artifacts: [code(sha), { kind: 'document', uri }] })) as any;
    const failed = ok(await report(agentA, workId, delivered.version, delivered.delivery_id, {
      assertion: 'fail', source_kind: 'artifact', source_ref: uri,
    })) as any;
    const passed = ok(await report(agentA, workId, failed.version, delivered.delivery_id, {
      source_kind: 'artifact', source_ref: sha,
    })) as any;
    expect(passed.criterion.result).toBe('fail');
    expect((await readinessOf(bob, workId)).ready_for_review).toBe(false);
    expect(refusal(await decide(bob, workId, 'accept')).fields).toContain('criteria.c1');
    const replaced = ok(await report(agentA, workId, passed.version, delivered.delivery_id, {
      source_kind: 'artifact', source_ref: sha, supersedes_id: failed.evidence_id,
    })) as any;
    expect(replaced.criterion.result).toBe('pass');
  });

  it('reads an unversioned document as unknown and a versioned one as evidence', async () => {
    const { workId, version } = await readyWork([{ text: 'The runbook covers it.', evidence_kinds: ['artifact'] }], {
      artifact_kind: 'document',
    });
    await run(agentA, workId);
    const uri = 'https://docs.example.com/runbook';
    const loose = ok(
      await submit(agentA, workId, version, {
        artifacts: [{ kind: 'document', uri }],
        evidence: [{ criterion_id: 'c1', assertion: 'pass', source_kind: 'artifact', source_ref: uri }],
      }),
    ) as any;
    expect(criterionOf(loose.readiness, 'c1')).toMatchObject({ result: 'unknown', reasons: ['unversioned'] });
    const pinned = ok(
      await submit(agentA, workId, loose.version, {
        artifacts: [{ kind: 'document', uri, version_id: 'v7' }],
        evidence: [{ criterion_id: 'c1', assertion: 'pass', source_kind: 'artifact', source_ref: uri }],
      }),
    ) as any;
    expect(criterionOf(pinned.readiness, 'c1').result).toBe('pass');
    const nowhere = refusal(
      await submit(agentA, workId, pinned.version, {
        artifacts: [{ kind: 'document', uri, version_id: 'v8' }],
        evidence: [{ criterion_id: 'c1', assertion: 'pass', source_kind: 'artifact', source_ref: 'https://docs.example.com/other' }],
      }),
    );
    expect(nowhere.fields).toEqual(['evidence[0].source_ref']);
  });

  it('fails an any-rule on a current failure, and lets a rerun supersede it', async () => {
    const rule = {
      mode: 'any',
      selectors: [{ source: 'agent_report' }, { source: 'provider_observation', provider: 'github', subject: 'ci' }],
    };
    const { workId, version } = await readyWork([
      { text: 'CI passes, or the agent ran it.', evidence_kinds: ['agent_report', 'provider_observation'], verification_rule: rule },
    ]);
    await run(agentA, workId);
    const sha = commit();
    const delivered = ok(
      await submit(agentA, workId, version, {
        artifacts: [code(sha)],
        evidence: [{ criterion_id: 'c1', assertion: 'pass', source_kind: 'agent_report', source_ref: 'npm test' }],
      }),
    ) as any;
    expect(criterionOf(delivered.readiness, 'c1').result).toBe('pass');

    expect(await observe(sha, { subjectId: 'workflow:900', name: 'ci', state: 'failure' })).toHaveProperty('recorded', true);
    let readiness = await readinessOf(bob, workId);
    expect(criterionOf(readiness, 'c1').result).toBe('fail');
    expect(readiness.ready_for_review).toBe(false);

    await observe(sha, { subjectId: 'workflow:900', name: 'ci', state: 'success', attempt: 2 });
    readiness = await readinessOf(bob, workId);
    expect(criterionOf(readiness, 'c1').result).toBe('pass');
    const provider = criterionOf(readiness, 'c1').selectors[1];
    expect(provider.result).toBe('pass');
    expect(provider.observation_ids).toHaveLength(1);
    // Two facts moved the epoch twice; the trail says so.
    expect((await workRow(workId)).evidenceEpoch).toBe(3n);
    const observed = await srv.db
      .select()
      .from(workEvents)
      .where(and(eq(workEvents.workId, workId), eq(workEvents.type, 'evidence_observed')));
    expect(observed).toHaveLength(2);
    expect(observed[0]!.actorKind).toBe('system');
  });

  it('reads two runs of one workflow that tie and disagree as inconclusive, and an unbound provider as unavailable', async () => {
    const { workId, version } = await readyWork([
      {
        text: 'CI passes.',
        evidence_kinds: ['provider_observation'],
        verification_rule: { mode: 'all', selectors: [{ source: 'provider_observation', provider: 'github', subject: 'ci' }] },
      },
      {
        id: 'pipeline',
        text: 'The pipeline passes.',
        evidence_kinds: ['provider_observation'],
        verification_rule: { mode: 'all', selectors: [{ source: 'provider_observation', provider: 'azure-devops', subject: 'deploy' }] },
      },
    ]);
    await run(agentA, workId);
    const sha = commit();
    ok(await submit(agentA, workId, version, { artifacts: [code(sha)] }));
    const at = new Date(Date.now() - 5_000);
    await observe(sha, { subjectId: 'workflow:910', name: 'ci', state: 'success', observedAt: at });
    await observe(sha, { subjectId: 'workflow:911', name: 'ci', state: 'failure', observedAt: at });
    const readiness = await readinessOf(bob, workId);
    expect(criterionOf(readiness, 'c1')).toMatchObject({ result: 'inconclusive', reasons: ['conflicting_observations'] });
    const pipeline = criterionOf(readiness, 'pipeline');
    expect(pipeline).toMatchObject({ result: 'unknown', reasons: ['no_verified_binding'] });
    expect(pipeline.selectors[0]).toMatchObject({ result: 'unavailable' });
    expect(pipeline.selectors[0].detail).toContain('not a pass');
  });

  it('reads evidence older than the criterion allows as stale', async () => {
    const { workId, version } = await readyWork([
      { text: 'Smoke test is recent.', verification_rule: { mode: 'all', selectors: [{ source: 'agent_report' }], max_age_seconds: 3600 } },
    ]);
    await run(agentA, workId);
    const delivered = ok(
      await submit(agentA, workId, version, {
        evidence: [
          {
            criterion_id: 'c1',
            assertion: 'pass',
            source_kind: 'agent_report',
            source_ref: 'smoke',
            observed_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
          },
        ],
      }),
    ) as any;
    expect(criterionOf(delivered.readiness, 'c1')).toMatchObject({ result: 'stale', reasons: ['older_than_max_age'] });
    const future = refusal(
      await report(agentA, workId, delivered.version, delivered.delivery_id, {
        observed_at: new Date(Date.now() + 3600_000).toISOString(),
      }),
    );
    expect(future.fields).toEqual(['observed_at']);
  });
});

describe('decisions', () => {
  /** A work in review whose one criterion the agent reported as passing. */
  async function inReview(criteria: Criterion[] = [{ text: 'A label prints.' }], contract: Record<string, unknown> = {}) {
    const { workId, version } = await readyWork(criteria, contract);
    await run(agentA, workId);
    const sha = commit();
    const delivered = ok(
      await submit(agentA, workId, version, {
        artifacts: [code(sha)],
        evidence: [{ criterion_id: 'c1', assertion: 'pass', source_kind: 'agent_report', source_ref: 'npm test' }],
      }),
    ) as any;
    return { workId, sha, delivered };
  }

  it('is refused to every agent principal and leaves no receipt', async () => {
    const { workId } = await inReview();
    const seen = ok(await readEvidence(srv.db, agentA, workId)) as any;
    expect(seen.may_decide).toBe(false);
    const before = (await srv.db.select().from(workCommands).where(eq(workCommands.workId, workId))).length;
    const attempt = refusal(
      await recordDecision(srv.db, agentA, workId, {
        request_id: randomUUID(),
        expected_version: seen.version,
        spec_revision: seen.spec_revision,
        delivery_id: seen.delivery_id,
        evidence_epoch: seen.evidence_epoch,
        evidence_manifest_hash: seen.evidence_manifest_hash,
        decision: 'accept',
      }),
    );
    expect(attempt.code).toBe('FORBIDDEN');
    expect((await srv.db.select().from(workCommands).where(eq(workCommands.workId, workId))).length).toBe(before);
    expect((await workRow(workId)).state).toBe('in_review');
  });

  it('refuses to accept over an unknown or a failing criterion, and records a change request', async () => {
    const { workId, delivered } = await inReview([{ text: 'A label prints.' }, { id: 'docs', text: 'The help says how.' }]);
    ok(await report(agentA, workId, delivered.version, delivered.delivery_id, { assertion: 'fail', source_ref: 'npm test' }));
    const blocked = refusal(await decide(bob, workId, 'accept'));
    expect(blocked.code).toBe('INVALID_TRANSITION');
    expect(blocked.fields).toEqual(['criteria.c1', 'criteria.docs']);

    expect(refusal(await decide(bob, workId, 'request_changes', { criteria: ['c1'] })).fields).toEqual(['reason']);
    expect(refusal(await decide(bob, workId, 'request_changes', { reason: 'The label is blank.' })).fields).toEqual(['criteria']);
    const changes = ok(await decide(bob, workId, 'request_changes', { reason: 'The label is blank.', criteria: ['c1', 'c1'] })) as any;
    expect(changes).toMatchObject({ state: 'in_progress', decision: 'request_changes', standing: 'acceptor' });
    const [row] = await srv.db.select().from(workAcceptances).where(eq(workAcceptances.workId, workId));
    expect(row).toMatchObject({ decision: 'request_changes', criteria: ['c1'], reason: 'The label is blank.' });
    expect((await workRow(workId)).currentAcceptanceId).toBeNull();
  });

  it('makes a delivery stale when a criterion changes, and refuses a decision on it', async () => {
    const { workId, delivered } = await inReview();
    const before = ok(await readEvidence(srv.db, bob, workId)) as any;
    expect(before.readiness.ready_for_review).toBe(true);
    ok(
      await updateWork(srv.db, lead, {
        request_id: randomUUID(),
        work_id: workId,
        expected_version: delivered.version,
        operation: 'patch',
        payload: { criteria: [{ id: 'c1', text: 'A label prints in under two seconds.' }] },
      }),
    );
    const after = ok(await readEvidence(srv.db, bob, workId)) as any;
    expect(after.state).toBe('in_progress');
    expect(criterionOf(after.readiness, 'c1')).toMatchObject({ result: 'stale', reasons: ['delivery_for_older_revision'] });
    const compact = ok(await getWork(srv.db, bob, workId)) as any;
    expect(compact.flags.stale_evidence).toBe(true);

    const onOld = refusal(
      await recordDecision(srv.db, bob, workId, {
        request_id: randomUUID(),
        expected_version: before.version,
        spec_revision: before.spec_revision,
        delivery_id: before.delivery_id,
        evidence_epoch: before.evidence_epoch,
        evidence_manifest_hash: before.evidence_manifest_hash,
        decision: 'accept',
      }),
    );
    expect(onOld.code).toBe('VERSION_CONFLICT');
    expect(onOld.fields).toContain('spec_revision');
    expect(refusal(await decide(bob, workId, 'accept')).code).toBe('INVALID_TRANSITION');
  });

  it('never calls accepted work stale only because a time limit ran out after the decision', async () => {
    const { workId } = await inReview([
      { text: 'Smoke test is recent.', verification_rule: { mode: 'all', selectors: [{ source: 'agent_report' }], max_age_seconds: 3600 } },
    ]);
    ok(await decide(bob, workId, 'accept'));
    expect((await workRow(workId)).state).toBe('accepted');
    // Two hours on, and nothing else happened: the pass the decision was made
    // on is older than the criterion allows, which reopens nothing, and the
    // work takes no new delivery, so none is asked for.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(Date.now() + 2 * 3600_000));
      expect((await evidenceState(srv.db, [workId])).get(workId)).toMatchObject({ staleEvidence: false, acceptanceStale: false });
      expect((ok(await getWork(srv.db, bob, workId)) as any).flags).toMatchObject({ stale_evidence: false, acceptance_stale: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets exactly one of two concurrent decisions on one snapshot win', async () => {
    const { workId } = await inReview();
    const seen = ok(await readEvidence(srv.db, bob, workId)) as any;
    const snapshot = {
      expected_version: seen.version,
      spec_revision: seen.spec_revision,
      delivery_id: seen.delivery_id,
      evidence_epoch: seen.evidence_epoch,
      evidence_manifest_hash: seen.evidence_manifest_hash,
    };
    const [a, b] = await Promise.all([
      recordDecision(srv.db, bob, workId, { ...snapshot, request_id: randomUUID(), decision: 'accept' }),
      recordDecision(srv.db, bob, workId, {
        ...snapshot,
        request_id: randomUUID(),
        decision: 'request_changes',
        reason: 'Not yet.',
        criteria: ['c1'],
      }),
    ]);
    const outcomes = [a, b].map((result) => ('error' in (result as object) ? 'refused' : 'decided'));
    expect(outcomes.sort()).toEqual(['decided', 'refused']);
    expect(await srv.db.select().from(workAcceptances).where(eq(workAcceptances.workId, workId))).toHaveLength(1);
  });

  it('refuses a decision once a provider fact lands, and refuses a snapshot whose manifest does not match', async () => {
    const { workId, sha } = await inReview([
      { text: 'A label prints.' },
      {
        id: 'ci',
        text: 'CI passes.',
        evidence_kinds: ['provider_observation'],
        verification_rule: { mode: 'all', selectors: [{ source: 'provider_observation', provider: 'github', subject: 'ci' }] },
      },
    ]);
    await observe(sha, { subjectId: 'workflow:920', name: 'ci', state: 'success', observedAt: new Date(Date.now() - 10_000) });
    const seen = ok(await readEvidence(srv.db, bob, workId)) as any;
    expect(seen.readiness.ready_for_review).toBe(true);
    const snapshot = {
      expected_version: seen.version,
      spec_revision: seen.spec_revision,
      delivery_id: seen.delivery_id,
      evidence_epoch: seen.evidence_epoch,
      evidence_manifest_hash: seen.evidence_manifest_hash,
      decision: 'accept',
    };
    const wrongHash = refusal(
      await recordDecision(srv.db, bob, workId, { ...snapshot, request_id: randomUUID(), evidence_manifest_hash: 'f'.repeat(64) }),
    );
    expect(wrongHash).toMatchObject({ code: 'EVIDENCE_STALE', fields: ['evidence_manifest_hash'] });

    await observe(sha, { subjectId: 'workflow:921', name: 'ci', state: 'failure', observedAt: new Date(Date.now() - 1_000) });
    const late = refusal(await recordDecision(srv.db, bob, workId, { ...snapshot, request_id: randomUUID() }));
    expect(late.code).toBe('VERSION_CONFLICT');
    expect(late.fields).toContain('evidence_epoch');
    const reread = refusal(await decide(bob, workId, 'accept'));
    expect(reread.fields).toEqual(['criteria.ci']);
    expect(await srv.db.select().from(workAcceptances).where(eq(workAcceptances.workId, workId))).toHaveLength(0);
  });

  it('keeps a decision taken before the same run attempt is seen again under another delivery id', async () => {
    const { workId, sha } = await inReview([
      { text: 'A label prints.' },
      {
        id: 'ci',
        text: 'CI passes.',
        evidence_kinds: ['provider_observation'],
        verification_rule: { mode: 'all', selectors: [{ source: 'provider_observation', provider: 'github', subject: 'ci' }] },
      },
    ]);
    const observedAt = new Date(Date.now() - 10_000);
    const fact = { subjectId: 'workflow:991', name: 'ci', state: 'success' as const, observedAt };
    // The webhook first, under GitHub's delivery GUID.
    expect(await observe(sha, fact)).toHaveProperty('recorded', true);
    const seen = ok(await readEvidence(srv.db, bob, workId)) as any;
    expect(seen.readiness.ready_for_review).toBe(true);
    const before = await workRow(workId);
    // Then the read-back door: the same attempt and updated_at, a new delivery id.
    expect(await observe(sha, fact)).toMatchObject({ recorded: false, reason: 'duplicate' });
    const after = await workRow(workId);
    expect(after.evidenceEpoch).toBe(before.evidenceEpoch);
    expect(after.version).toBe(before.version);
    const rows = await srv.db
      .select()
      .from(providerObservations)
      .where(and(eq(providerObservations.subjectId, 'workflow:991'), eq(providerObservations.commitSha, sha)));
    expect(rows).toHaveLength(1);
    const decided = ok(
      await recordDecision(srv.db, bob, workId, {
        request_id: randomUUID(),
        expected_version: seen.version,
        spec_revision: seen.spec_revision,
        delivery_id: seen.delivery_id,
        evidence_epoch: seen.evidence_epoch,
        evidence_manifest_hash: seen.evidence_manifest_hash,
        decision: 'accept',
      }),
    ) as any;
    expect(decided.state).toBe('accepted');
  });

  it('keeps an acceptance whole when a later failure makes it stale, says so once, and ignores a workflow no criterion reads', async () => {
    const { workId, sha } = await inReview([
      { text: 'A label prints.' },
      {
        id: 'ci',
        text: 'CI passes.',
        evidence_kinds: ['provider_observation'],
        verification_rule: { mode: 'all', selectors: [{ source: 'provider_observation', provider: 'github', subject: 'ci' }] },
      },
    ]);
    await observe(sha, { subjectId: 'workflow:929', name: 'ci', state: 'success', observedAt: new Date(Date.now() - 10_000) });
    const accepted = ok(await decide(bob, workId, 'accept')) as any;
    expect(accepted).toMatchObject({ state: 'accepted', decision: 'accept', self_review: false });
    const [acceptance] = await srv.db.select().from(workAcceptances).where(eq(workAcceptances.workId, workId));
    expect(acceptance!.evidenceManifestHash).toBe(accepted.evidence_manifest_hash);
    expect((acceptance!.evidenceManifest as any).dependencies).toEqual([]);
    expect((ok(await getWork(srv.db, bob, workId)) as any).flags.acceptance_stale).toBe(false);

    // A workflow no criterion names changes nothing the decision rests on: no
    // epoch, no version, no event, and the acceptance still holds.
    const quiet = await workRow(workId);
    const eventsBefore = (await srv.db.select().from(workEvents).where(eq(workEvents.workId, workId))).length;
    await observe(sha, { subjectId: 'workflow:931', name: 'lint', state: 'failure' });
    const unmoved = await workRow(workId);
    expect(unmoved.evidenceEpoch).toBe(quiet.evidenceEpoch);
    expect(unmoved.version).toBe(quiet.version);
    expect((await srv.db.select().from(workEvents).where(eq(workEvents.workId, workId))).length).toBe(eventsBefore);
    expect((ok(await getWork(srv.db, bob, workId)) as any).flags.acceptance_stale).toBe(false);

    await observe(sha, { subjectId: 'workflow:930', name: 'ci', state: 'failure' });
    await observe(sha, { subjectId: 'workflow:932', name: 'ci', state: 'failure' });
    const row = await workRow(workId);
    expect(row.state).toBe('accepted');
    expect(row.currentAcceptanceId).toBe(acceptance!.id);
    const [kept] = await srv.db.select().from(workAcceptances).where(eq(workAcceptances.id, acceptance!.id));
    expect(kept).toEqual(acceptance);
    expect((ok(await getWork(srv.db, bob, workId)) as any).flags.acceptance_stale).toBe(true);
    expect((await evidenceState(srv.db, [workId])).get(workId)?.acceptanceStale).toBe(true);
    const stale = await srv.db
      .select()
      .from(workEvents)
      .where(and(eq(workEvents.workId, workId), eq(workEvents.type, 'acceptance_stale')));
    expect(stale).toHaveLength(1);
    expect(stale[0]!.payload).toMatchObject({ acceptance_id: acceptance!.id });
    const feed = await srv.db.select().from(activity).where(and(eq(activity.teamId, teamId), eq(activity.action, 'work_acceptance_stale')));
    expect(feed.map((line) => line.detail)).toContain(row.displayKey);
  });

  it('labels a self review, and refuses it when the contract asks for an independent acceptor', async () => {
    for (const independent of [true, false]) {
      const { workId, version } = await readyWork([{ text: 'A label prints.' }], {
        acceptance_policy: { require_independent_acceptor: independent },
      });
      // Bob is the acceptor and delivers it himself, from the console.
      const delivered = ok(await submit(bob, workId, version)) as any;
      await run(agentA, workId);
      ok(
        await recordEvidence(
          srv.db,
          agentA,
          {
            request_id: randomUUID(),
            work_id: workId,
            expected_version: delivered.version,
            delivery_id: delivered.delivery_id,
            criterion_id: 'c1',
            assertion: 'pass',
            source_kind: 'agent_report',
            source_ref: 'npm test',
          },
          { hosted: false },
        ),
      );
      const result = await decide(bob, workId, 'accept');
      if (independent) {
        expect(refusal(result).code).toBe('FORBIDDEN');
      } else {
        expect(ok(result)).toMatchObject({ state: 'accepted', self_review: true });
        const [row] = await srv.db.select().from(workAcceptances).where(eq(workAcceptances.workId, workId));
        expect(row!.actorScopeSnapshot).toMatchObject({ standing: 'acceptor', self_review: true });
      }
    }
  });

  it('lets a workspace owner decide instead of the acceptor only with a reason', async () => {
    const { workId } = await inReview();
    expect(refusal(await decide(lead, workId, 'accept')).fields).toEqual(['reason']);
    const decided = ok(await decide(lead, workId, 'accept', { reason: 'Bob is away; I checked the label.' })) as any;
    expect(decided).toMatchObject({ state: 'accepted', standing: 'owner_override' });
  });

  it('records human checks against an exact artifact and accepts on them', async () => {
    const { workId, sha } = await inReview([
      { text: 'A label prints.' },
      { id: 'looked', text: 'The label looks right.', evidence_kinds: ['human_check'] },
    ]);
    const missing = refusal(await decide(bob, workId, 'accept'));
    expect(missing.fields).toEqual(['criteria.looked']);
    const vague = refusal(
      await decide(bob, workId, 'accept', {
        human_checks: [{ criterion_id: 'looked', assertion: 'pass', artifact_ref: 'the branch', note: 'Looked fine.' }],
      }),
    );
    expect(vague.fields).toEqual(['human_checks[0].artifact_ref']);
    const wrongKind = refusal(
      await decide(bob, workId, 'accept', {
        human_checks: [{ criterion_id: 'c1', assertion: 'pass', artifact_ref: sha, note: 'Printed one.' }],
      }),
    );
    expect(wrongKind.fields).toEqual(['human_checks[0].criterion_id']);

    const epochBefore = (await workRow(workId)).evidenceEpoch;
    const accepted = ok(
      await decide(bob, workId, 'accept', {
        human_checks: [{ criterion_id: 'looked', assertion: 'pass', artifact_ref: sha, note: 'Printed one on the Zebra.' }],
      }),
    ) as any;
    expect(accepted.state).toBe('accepted');
    const row = await workRow(workId);
    expect(row.evidenceEpoch).toBe(epochBefore + 1n);
    const [acceptance] = await srv.db.select().from(workAcceptances).where(eq(workAcceptances.id, row.currentAcceptanceId!));
    expect(acceptance!.evidenceEpoch).toBe(row.evidenceEpoch);
    const human = await srv.db
      .select()
      .from(workEvidence)
      .where(and(eq(workEvidence.workId, workId), eq(workEvidence.provenance, 'human_decision')));
    expect(human).toHaveLength(1);
    expect(human[0]).toMatchObject({ reportedByKind: 'human', sourceVersion: sha, criterionId: 'looked' });
    // Accepted on exactly what was stored: a fresh read agrees it is current.
    expect((await evidenceState(srv.db, [workId])).get(workId)?.acceptanceStale).toBe(false);
  });
});

describe('provider subject names', () => {
  beforeEach(() => adoOutbox.clear());

  it('stores the workflow name from the GitHub webhook and matches a criterion by it', async () => {
    const { workId, version } = await readyWork([
      {
        text: 'Build passes.',
        evidence_kinds: ['provider_observation'],
        verification_rule: { mode: 'all', selectors: [{ source: 'provider_observation', provider: 'github', subject: 'Build and test' }] },
      },
    ]);
    await run(agentA, workId);
    const sha = commit();
    ok(await submit(agentA, workId, version, { artifacts: [code(sha)] }));
    const body = JSON.stringify({
      action: 'completed',
      workflow_run: {
        id: 4242,
        name: 'Build\u0000 and test',
        head_branch: 'label-printer',
        head_sha: sha,
        conclusion: 'success',
        run_attempt: 1,
        updated_at: new Date(Date.now() - 2_000).toISOString(),
      },
      repository: { id: GITHUB_REPOSITORY_ID, name: 'alpha', full_name: 'acme/alpha' },
    });
    const res = await fetchRetrying(`${srv.url}/api/hooks/github/${hookToken}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'workflow_run',
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': `sha256=${createHmac('sha256', hookToken).update(body).digest('hex')}`,
      },
      body,
    });
    expect(res.status).toBe(200);
    const [fact] = await srv.db.select().from(providerObservations).where(eq(providerObservations.subjectId, 'workflow:4242'));
    expect(fact).toMatchObject({ subjectName: 'Build  and test', commitSha: sha });
    // The stored name had a control character replaced, so it is not the criterion's subject.
    expect(criterionOf(await readinessOf(bob, workId), 'c1').result).toBe('unknown');

    await observe(sha, { subjectId: 'workflow:4243', name: 'Build and test', state: 'success' });
    expect(criterionOf(await readinessOf(bob, workId), 'c1').result).toBe('pass');
  });

  it('stores the pipeline name of an Azure DevOps build', async () => {
    const repositoryId = randomUUID();
    const [connection] = await srv.db
      .insert(teamIntegrations)
      .values({ teamId, provider: 'azure-devops', repo: 'acme/service/api', token: 'fixture-only' })
      .returning();
    const [binding] = await srv.db
      .insert(repositoryBindings)
      .values({
        connectionId: connection!.id,
        teamId,
        provider: 'azure-devops',
        repositoryId,
        fullName: 'acme/service/api',
        verifiedAt: new Date(),
      })
      .returning();
    const build = (id: number, definition: unknown) => ({
      id,
      repository: { id: repositoryId, type: 'TfsGit' },
      sourceVersion: commit(),
      status: 'completed',
      result: 'succeeded',
      lastChangedDate: new Date(Date.now() - 1_000).toISOString(),
      definition,
    });
    adoOutbox.seedBuild(71, build(71, { id: 3, name: 'deploy-staging' }));
    expect(await observeAdoBuild(srv.db, env, teamId, binding!.id, 71)).toHaveProperty('recorded', true);
    adoOutbox.seedBuild(72, build(72, 'not an object'));
    expect(await observeAdoBuild(srv.db, env, teamId, binding!.id, 72)).toHaveProperty('recorded', true);
    const facts = await srv.db.select().from(providerObservations).where(eq(providerObservations.bindingId, binding!.id));
    const byId = Object.fromEntries(facts.map((fact) => [fact.subjectId, fact.subjectName]));
    expect(byId).toEqual({ 'build:71': 'deploy-staging', 'build:72': null });
  });
});

describe('every completed run of a workflow', () => {
  const ciCriterion = {
    text: 'CI passes.',
    evidence_kinds: ['provider_observation'],
    verification_rule: { mode: 'all', selectors: [{ source: 'provider_observation', provider: 'github', subject: 'CI' }] },
  };
  /** A signed GitHub `workflow_run` webhook, as GitHub sends one. */
  const webhook = async (run: Record<string, unknown>) => {
    const body = JSON.stringify({
      action: 'completed',
      workflow_run: { name: 'CI', head_branch: 'label-printer', ...run },
      repository: { id: GITHUB_REPOSITORY_ID, name: 'alpha', full_name: 'acme/alpha' },
    });
    const res = await fetchRetrying(`${srv.url}/api/hooks/github/${hookToken}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'workflow_run',
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': `sha256=${createHmac('sha256', hookToken).update(body).digest('hex')}`,
      },
      body,
    });
    expect(res.status).toBe(200);
  };

  it('lets a rerun that timed out replace the pass of the attempt before it, through the webhook', async () => {
    const { workId, version } = await readyWork([ciCriterion]);
    await run(agentA, workId);
    const sha = commit();
    ok(await submit(agentA, workId, version, { artifacts: [code(sha)] }));
    await webhook({ id: 7770, workflow_id: 41, head_sha: sha, conclusion: 'success', run_attempt: 1, updated_at: new Date(Date.now() - 10_000).toISOString() });
    expect(criterionOf(await readinessOf(bob, workId), 'c1').result).toBe('pass');
    // The rerun is the run's current attempt: GitHub shows the check failed,
    // so the attempt that passed before it decides nothing any more.
    for (const [attempt, conclusion] of [[2, 'timed_out'], [3, 'cancelled'], [4, 'startup_failure']] as const) {
      await webhook({ id: 7770, workflow_id: 41, head_sha: sha, conclusion, run_attempt: attempt, updated_at: new Date(Date.now() - 9_000 + attempt * 1_000).toISOString() });
      const readiness = await readinessOf(bob, workId);
      expect(criterionOf(readiness, 'c1'), conclusion).toMatchObject({ result: 'unknown', reasons: ['provider_state_unknown'] });
      expect(readiness.ready_for_review).toBe(false);
    }
    const facts = await srv.db.select().from(providerObservations).where(eq(providerObservations.subjectId, 'workflow:7770'));
    expect(facts.map((fact) => [fact.attempt, fact.state]).sort()).toEqual([
      [1, 'success'],
      [2, 'unknown'],
      [3, 'unknown'],
      [4, 'unknown'],
    ]);
    expect(new Set(facts.map((fact) => fact.subjectDefinition))).toEqual(new Set(['41']));
  });

  it('never lets one workflow called CI cover the current failure of another workflow called CI', async () => {
    const { workId, version } = await readyWork([ciCriterion]);
    await run(agentA, workId);
    const sha = commit();
    ok(await submit(agentA, workId, version, { artifacts: [code(sha)] }));
    const at = (ms: number) => new Date(Date.now() - ms);
    // ci.yml fails, then ci-docs.yml, a different workflow with the same name, passes.
    await observe(sha, { subjectId: 'workflow:8801', name: 'CI', definition: '501', state: 'failure', observedAt: at(20_000) });
    await observe(sha, { subjectId: 'workflow:8802', name: 'CI', definition: '502', state: 'success', observedAt: at(18_000) });
    let readiness = await readinessOf(bob, workId);
    expect(criterionOf(readiness, 'c1').result).toBe('fail');
    expect(criterionOf(readiness, 'c1').selectors[0].observation_ids).toHaveLength(2);
    // A later run of the failing workflow itself passing is what supersedes its failure.
    await observe(sha, { subjectId: 'workflow:8803', name: 'CI', definition: '501', state: 'success', observedAt: at(16_000) });
    readiness = await readinessOf(bob, workId);
    expect(criterionOf(readiness, 'c1').result).toBe('pass');
    expect(readiness.ready_for_review).toBe(true);
  });
});

describe('decisions and dependencies together', () => {
  const ciCriteria: Criterion[] = [
    { text: 'A label prints.' },
    {
      id: 'ci',
      text: 'CI passes.',
      evidence_kinds: ['provider_observation'],
      verification_rule: { mode: 'all', selectors: [{ source: 'provider_observation', provider: 'github', subject: 'ci' }] },
    },
  ];
  const graphOf = async (workId: string) => (await blockingState(srv.db, [workId])).get(workId)!;

  it('meets a dependency with a real acceptance, stores the snapshot, and unmeets it when a fact the upstream relied on fails', async () => {
    const upstream = await readyWork(ciCriteria);
    const downstream = await readyWork([{ text: 'The label lists the order.' }]);
    const added = ok(
      await updateWork(srv.db, lead, {
        request_id: randomUUID(),
        work_id: downstream.workId,
        expected_version: downstream.version,
        operation: 'add_dependency',
        payload: { depends_on: upstream.workId },
      }),
    );
    expect((await graphOf(downstream.workId)).unmet).toEqual([expect.objectContaining({ work_id: upstream.workId, why: 'not_accepted' })]);
    const compact = ok(await getWork(srv.db, lead, downstream.workId)) as any;
    expect(compact.flags.blocked).toBe(true);
    expect(compact.unmet_dependencies.items).toEqual([expect.objectContaining({ work_id: upstream.workId, why: 'not_accepted' })]);
    // A blocked work cannot be accepted, whatever its own evidence says.
    await run(agentB, downstream.workId);
    ok(
      await submit(agentB, downstream.workId, added.version, {
        evidence: [{ criterion_id: 'c1', assertion: 'pass', source_kind: 'agent_report', source_ref: 'npm test' }],
      }),
    );
    expect(refusal(await decide(bob, downstream.workId, 'accept')).fields).toEqual([`dependencies.${(await workRow(upstream.workId)).displayKey}`]);

    // The upstream accepted through the decision itself, on a passing check.
    await run(agentA, upstream.workId);
    const sha = commit();
    ok(
      await submit(agentA, upstream.workId, upstream.version, {
        artifacts: [code(sha)],
        evidence: [{ criterion_id: 'c1', assertion: 'pass', source_kind: 'agent_report', source_ref: 'npm test' }],
      }),
    );
    await observe(sha, { subjectId: 'workflow:960', name: 'ci', state: 'success', observedAt: new Date(Date.now() - 10_000) });
    const upstreamAccepted = ok(await decide(bob, upstream.workId, 'accept')) as any;
    expect(await graphOf(downstream.workId)).toMatchObject({ blocked: false, unmetDependencies: 0 });

    // The downstream's acceptance carries the snapshot the graph compares against.
    const downstreamAccepted = ok(await decide(bob, downstream.workId, 'accept')) as any;
    const [stored] = await srv.db.select().from(workAcceptances).where(eq(workAcceptances.id, downstreamAccepted.acceptance_id));
    expect((stored!.evidenceManifest as any).dependencies).toEqual([
      expect.objectContaining({ work_id: upstream.workId, acceptance_id: upstreamAccepted.acceptance_id, spec_revision: 1 }),
    ]);
    expect(await graphOf(downstream.workId)).toMatchObject({ blocked: false, dependencyChanged: false });

    // A workflow no criterion reads leaves the upstream's acceptance, and so the edge, as they were.
    await observe(sha, { subjectId: 'workflow:961', name: 'nightly', state: 'failure' });
    expect((await graphOf(downstream.workId)).dependencyChanged).toBe(false);

    // The check the upstream was accepted on fails: its acceptance is stale, the
    // edge no longer holds, and the accepted downstream is told, not reopened.
    await observe(sha, { subjectId: 'workflow:962', name: 'ci', state: 'failure' });
    expect((await evidenceState(srv.db, [upstream.workId])).get(upstream.workId)?.acceptanceStale).toBe(true);
    const after = await graphOf(downstream.workId);
    expect(after).toMatchObject({ blocked: false, dependencyChanged: true });
    expect(after.unmet).toEqual([expect.objectContaining({ work_id: upstream.workId, state: 'accepted', why: 'acceptance_stale' })]);
    expect((await workRow(downstream.workId)).currentAcceptanceId).toBe(downstreamAccepted.acceptance_id);
    const read = ok(await getWork(srv.db, lead, downstream.workId, { view: 'detail', sections: ['dependencies'] })) as any;
    expect(read.flags.dependency_changed).toBe(true);
    expect(read.sections.dependencies.depends_on).toEqual([
      expect.objectContaining({ id: upstream.workId, met: false, why: 'acceptance_stale' }),
    ]);
  });
});

describe('an accepted downstream whose upstream changed', () => {
  it('says the upstream changed and not that its own evidence moved', async () => {
    const reported = [{ text: 'A label prints.' }];
    const upstream = await readyWork(reported);
    const downstream = await readyWork([{ text: 'The label lists the order.' }]);
    ok(
      await updateWork(srv.db, lead, {
        request_id: randomUUID(),
        work_id: downstream.workId,
        expected_version: downstream.version,
        operation: 'add_dependency',
        payload: { depends_on: upstream.workId },
      }),
    );
    for (const [work, agent] of [[upstream.workId, agentA], [downstream.workId, agentB]] as const) {
      await run(agent, work);
      ok(
        await submit(agent, work, (await workRow(work)).version.toString(), {
          evidence: [{ criterion_id: 'c1', assertion: 'pass', source_kind: 'agent_report', source_ref: 'npm test' }],
        }),
      );
      ok(await decide(bob, work, 'accept'));
    }
    const before = (await workRow(downstream.workId)).evidenceEpoch;
    expect((await evidenceState(srv.db, [downstream.workId])).get(downstream.workId)?.acceptanceStale).toBe(false);

    // The owner reopens the upstream to fix a typo in its goal.
    ok(
      await updateWork(srv.db, lead, {
        request_id: randomUUID(),
        work_id: upstream.workId,
        expected_version: (await workRow(upstream.workId)).version.toString(),
        operation: 'reopen',
        payload: { reason: 'A typo in the goal.' },
      }),
    );
    // Nothing about the downstream's delivery or its evidence moved, and the
    // page says what did: the upstream it was accepted against.
    expect((await workRow(downstream.workId)).evidenceEpoch).toBe(before);
    expect((await evidenceState(srv.db, [downstream.workId])).get(downstream.workId)?.acceptanceStale).toBe(false);
    const read = ok(await getWork(srv.db, lead, downstream.workId)) as any;
    expect(read.flags).toMatchObject({ acceptance_stale: false, dependency_changed: true });
    expect((await blockingState(srv.db, [downstream.workId])).get(downstream.workId)).toMatchObject({ dependencyChanged: true });
  });
});

type PgliteClient = { transaction: (callback: (tx: any) => Promise<unknown>) => Promise<unknown> };

/**
 * Every statement each database transaction ran while `fn` ran, the server's
 * included. `beforeWorkLock` runs once, inside the transaction, just before it
 * takes its first Work lock: the moment another request's commit can land
 * between what a transaction chose without locks and what it then locks.
 * PGlite is one connection, so this is how that interleaving is made certain.
 */
async function traced<T>(
  fn: () => Promise<T>,
  beforeWorkLock?: (query: (text: string, params: unknown[]) => Promise<unknown>) => Promise<void>,
): Promise<{ value: T; transactions: string[][] }> {
  const client = (srv.db as unknown as { $client: PgliteClient }).$client;
  const original = client.transaction;
  const transactions: string[][] = [];
  let pending = beforeWorkLock;
  client.transaction = (callback) =>
    original.call(client, (tx: any) => {
      const statements: string[] = [];
      transactions.push(statements);
      return callback(
        new Proxy(tx, {
          get(target, prop) {
            const value = Reflect.get(target, prop);
            if (prop === 'query' || prop === 'exec') {
              return async (text: string, ...rest: unknown[]) => {
                if (pending && /insert into "work_project_counters"/.test(text)) {
                  const run = pending;
                  pending = undefined;
                  await run((sqlText, params) => target.query(sqlText, params));
                }
                statements.push(text);
                return value.call(target, text, ...rest);
              };
            }
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
      );
    });
  try {
    return { value: await fn(), transactions };
  } finally {
    client.transaction = original;
  }
}

const providerCriterion = (subject: string) => ({
  id: subject,
  text: `${subject} passes.`,
  evidence_kinds: ['provider_observation'],
  verification_rule: { mode: 'all', selectors: [{ source: 'provider_observation', provider: 'github', subject }] },
});

describe('a provider fact under the Work lock', () => {
  it('moves no epoch for a fact about a delivery the work stopped holding before the lock', async () => {
    const { workId, version } = await readyWork([providerCriterion('ci')]);
    await run(agentA, workId);
    const first = commit();
    const d1 = ok(await submit(agentA, workId, version, { artifacts: [code(first)] })) as any;
    const d2 = ok(await submit(agentA, workId, d1.version, { artifacts: [code(commit())] })) as any;
    // As it was before the second delivery committed: the fact's transaction
    // finds the work through the first one, and the second commits after that
    // and before the fact takes its Work lock.
    await srv.db.update(workItems).set({ currentDeliveryId: d1.delivery_id }).where(eq(workItems.id, workId));
    const before = await workRow(workId);
    const { value } = await traced(
      () => observe(first, { subjectId: 'workflow:950', name: 'ci', state: 'failure' }),
      async (query) => {
        await query('update work_items set current_delivery_id = $1 where id = $2', [d2.delivery_id, workId]);
      },
    );
    expect(value).toHaveProperty('recorded', true);
    const after = await workRow(workId);
    expect(after.currentDeliveryId).toBe(d2.delivery_id);
    expect(after.evidenceEpoch).toBe(before.evidenceEpoch);
    expect(after.version).toBe(before.version);
    const observed = await srv.db
      .select()
      .from(workEvents)
      .where(and(eq(workEvents.workId, workId), eq(workEvents.type, 'evidence_observed')));
    expect(observed).toHaveLength(0);
  });

  it('holds the repository binding for no key update when the fact reaches a Work lock', async () => {
    const { workId, version } = await readyWork([providerCriterion('ci')]);
    await run(agentA, workId);
    const sha = commit();
    ok(await submit(agentA, workId, version, { artifacts: [code(sha)] }));
    const { transactions } = await traced(() => observe(sha, { subjectId: 'workflow:951', name: 'ci', state: 'success' }));
    const isWorkLock = (text: string) => /from "work_project_counters"/.test(text) && /\bfor update\b/.test(text);
    const reached = transactions.filter((statements) => statements.some(isWorkLock));
    expect(reached).toHaveLength(1);
    const statements = reached[0]!;
    const held = statements.slice(0, statements.findIndex(isWorkLock)).filter((text) => /\bfor (no key )?update\b/.test(text));
    expect(held.some((text) => /from "repository_bindings"/.test(text) && /for no key update/.test(text))).toBe(true);
    expect(held.filter((text) => /\bfor update\b/.test(text))).toEqual([]);
  });

  it('reads a provider criterion as unknown, never a pass, when the facts on one work are more than one read holds', async () => {
    const { workId, version } = await readyWork([providerCriterion('build')]);
    await run(agentA, workId);
    const busy = commit();
    ok(await submit(agentA, workId, version, { artifacts: [code(busy)] }));
    const other = await readyWork([providerCriterion('build')]);
    await run(agentA, other.workId);
    const quiet = commit();
    ok(await submit(agentA, other.workId, other.version, { artifacts: [code(quiet)] }));

    const now = Date.now();
    const fact = (sha: string, extra: Record<string, unknown>) => ({
      bindingId: githubBindingId,
      projectId: alphaId,
      deliveryId: randomUUID(),
      subjectId: `workflow:${randomUUID()}`,
      subjectName: 'lint',
      commitSha: sha,
      kind: 'workflow',
      state: 'success',
      attempt: 1,
      observedAt: new Date(now - 120_000),
      ...extra,
    });
    // A busy commit: thousands of runs of another workflow, older than the build's.
    const noise = Array.from({ length: 2_001 }, () => fact(busy, {}));
    for (let at = 0; at < noise.length; at += 500) await srv.db.insert(providerObservations).values(noise.slice(at, at + 500));
    // The build: attempt 1 passed, attempt 2 failed, with ids that put the
    // failure last and the pass first in any order by id.
    await srv.db.insert(providerObservations).values([
      fact(busy, {
        id: '00000000-0000-4000-8000-000000000001',
        subjectId: 'workflow:build-1',
        subjectName: 'build',
        attempt: 1,
        state: 'success',
        observedAt: new Date(now - 60_000),
      }),
      fact(busy, {
        id: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
        subjectId: 'workflow:build-1',
        subjectName: 'build',
        attempt: 2,
        state: 'failure',
        observedAt: new Date(now - 30_000),
      }),
      fact(quiet, { subjectId: 'workflow:build-2', subjectName: 'build', state: 'failure', observedAt: new Date(now - 30_000) }),
    ]);

    const readiness = await readinessOf(bob, workId);
    expect(criterionOf(readiness, 'build')).toMatchObject({ result: 'unknown', reasons: ['observations_truncated'] });
    // Read in one batch, the busy commit pushes nothing of the other work's out.
    const batch = await evidenceState(srv.db, [workId, other.workId]);
    expect(batch.get(workId)!.criteria).toMatchObject({ pass: 0, unknown: 1 });
    expect(batch.get(other.workId)!.criteria).toMatchObject({ fail: 1 });
  });

  it.each(['required pass', 'optional unknown', 'any pass'])('invalidates an accepted %s when a new failing observation exceeds the provider scan', async (acceptedResult) => {
    const criterion = {
      ...providerCriterion('build'),
      required: acceptedResult !== 'optional unknown',
      ...(acceptedResult === 'any pass' ? {
        evidence_kinds: ['provider_observation', 'agent_report'],
        verification_rule: {
          mode: 'any', selectors: [{ source: 'provider_observation', provider: 'github', subject: 'build' }, { source: 'agent_report' }],
        },
      } : {}),
    };
    const { workId, version } = await readyWork([criterion]);
    const downstream = await readyWork([{ text: 'The accepted build is available.' }]);
    ok(await updateWork(srv.db, lead, {
      request_id: randomUUID(), work_id: downstream.workId, expected_version: downstream.version,
      operation: 'add_dependency', payload: { depends_on: workId },
    }));
    const sha = commit();
    await run(agentA, workId);
    ok(await submit(agentA, workId, version, {
      artifacts: [code(sha)],
      ...(acceptedResult === 'any pass' ? { evidence: [{ criterion_id: 'build', assertion: 'pass', source_kind: 'agent_report', source_ref: 'npm test' }] } : {}),
    }));
    await observe(sha, { subjectId: 'workflow:scan-build', name: 'build', state: acceptedResult === 'required pass' ? 'success' : 'unknown', observedAt: new Date(Date.now() - 20_000) });
    ok(await decide(bob, workId, 'accept'));
    const accepted = await workRow(workId);
    expect((await blockingState(srv.db, [downstream.workId])).get(downstream.workId)!.blocked).toBe(false);
    const noise = Array.from({ length: 2_001 }, () => ({
      bindingId: githubBindingId, projectId: alphaId, deliveryId: randomUUID(),
      subjectId: `workflow:${randomUUID()}`, subjectName: 'lint', commitSha: sha,
      kind: 'workflow', state: 'success', attempt: 1, observedAt: new Date(Date.now() - 120_000),
    }));
    for (let at = 0; at < noise.length; at += 500) await srv.db.insert(providerObservations).values(noise.slice(at, at + 500));
    await observe(sha, { subjectId: 'workflow:scan-build', name: 'build', state: 'failure', attempt: 2 });
    const reading = criterionOf(await readinessOf(bob, workId), 'build');
    expect(reading.result).toBe(acceptedResult === 'any pass' ? 'pass' : 'unknown');
    expect(reading.selectors[0]).toMatchObject({ result: 'unknown', reason: 'observations_truncated' });
    expect((await workRow(workId)).evidenceEpoch).toBe(accepted.evidenceEpoch + 1n);
    expect((await evidenceState(srv.db, [workId])).get(workId)!.acceptanceStale).toBe(true);
    expect((await blockingState(srv.db, [downstream.workId])).get(downstream.workId)!.blocked).toBe(true);
  });

  it('moves the accepted epoch when a new failure is invisible in an already truncated manifest', async () => {
    const { workId, version } = await readyWork([{ ...providerCriterion('build'), required: false }]);
    const downstream = await readyWork([{ text: 'The accepted build is available.' }]);
    ok(await updateWork(srv.db, lead, {
      request_id: randomUUID(), work_id: downstream.workId, expected_version: downstream.version,
      operation: 'add_dependency', payload: { depends_on: workId },
    }));
    const sha = commit();
    ok(await submit(lead, workId, version, { artifacts: [code(sha)] }));
    const now = Date.now();
    const observations = Array.from({ length: 2_001 }, (_, index) => ({
      bindingId: githubBindingId, projectId: alphaId, deliveryId: randomUUID(),
      subjectId: `workflow:scan-cover-${String(index).padStart(4, '0')}`, subjectName: 'build',
      commitSha: sha, kind: 'workflow', state: 'success', attempt: 1,
      observedAt: new Date(now - (index + 1) * 1000),
    }));
    for (let at = 0; at < observations.length; at += 500) await srv.db.insert(providerObservations).values(observations.slice(at, at + 500));
    ok(await decide(bob, workId, 'accept'));
    const accepted = await workRow(workId);
    const before = ok(await readEvidence(srv.db, bob, workId)) as any;
    expect(before.manifest.provider_subjects.more).toBe(1950);
    expect((await evidenceState(srv.db, [workId])).get(workId)!.acceptanceStale).toBe(false);
    expect((await blockingState(srv.db, [downstream.workId])).get(downstream.workId)!.blocked).toBe(false);
    // The newest failure displaces a late-sorting observation from the scan.
    // Both the first 50 manifest subjects and its omitted count stay identical.
    await observe(sha, { subjectId: 'workflow:zz-scan-new', name: 'build', state: 'failure', observedAt: new Date(now) });
    const after = ok(await readEvidence(srv.db, bob, workId)) as any;
    expect(after.manifest.provider_subjects).toEqual(before.manifest.provider_subjects);
    expect(after.manifest.criteria).toEqual(before.manifest.criteria);
    expect((await workRow(workId)).evidenceEpoch).toBe(accepted.evidenceEpoch + 1n);
    expect((await evidenceState(srv.db, [workId])).get(workId)!.acceptanceStale).toBe(true);
    expect((await blockingState(srv.db, [downstream.workId])).get(downstream.workId)!.blocked).toBe(true);
  });
});

describe('versions the evidence names', () => {
  it('refuses a human check against a document delivered without a version, and records the version of one with', async () => {
    const { workId, version } = await readyWork([{ id: 'read', text: 'The report reads right.', evidence_kinds: ['human_check'] }], {
      artifact_kind: 'document',
    });
    await run(agentA, workId);
    const uri = 'https://docs.example.com/report';
    ok(await submit(agentA, workId, version, { artifacts: [{ kind: 'document', uri }] }));
    const check = { criterion_id: 'read', assertion: 'pass', artifact_ref: uri, note: 'Read it through.' };
    const loose = refusal(await decide(bob, workId, 'accept', { human_checks: [check] }));
    expect(loose.code).toBe('INVALID_INPUT');
    expect(loose.fields).toEqual(['human_checks[0].artifact_ref']);
    expect(await srv.db.select().from(workAcceptances).where(eq(workAcceptances.workId, workId))).toHaveLength(0);
    expect(
      await srv.db.select().from(workEvidence).where(and(eq(workEvidence.workId, workId), eq(workEvidence.provenance, 'human_decision'))),
    ).toHaveLength(0);
    expect((await workRow(workId)).state).toBe('in_review');

    const row = await workRow(workId);
    ok(await submit(agentA, workId, row.version.toString(), { artifacts: [{ kind: 'document', uri, version_id: 'r2' }] }));
    expect(ok(await decide(bob, workId, 'accept', { human_checks: [check] }))).toMatchObject({ state: 'accepted' });
    const [human] = await srv.db
      .select()
      .from(workEvidence)
      .where(and(eq(workEvidence.workId, workId), eq(workEvidence.provenance, 'human_decision')));
    expect(human!.sourceVersion).toBe('r2');
  });

  it('refuses evidence that names a version the delivery does not carry', async () => {
    const doc = await readyWork([{ text: 'The runbook covers it.', evidence_kinds: ['artifact'] }], { artifact_kind: 'document' });
    await run(agentA, doc.workId);
    const uri = 'https://docs.example.com/runbook-v';
    const delivered = ok(await submit(agentA, doc.workId, doc.version, { artifacts: [{ kind: 'document', uri, version_id: 'v7' }] })) as any;
    const older = refusal(
      await report(agentA, doc.workId, delivered.version, delivered.delivery_id, {
        source_kind: 'artifact',
        source_ref: uri,
        source_version: 'v3',
      }),
    );
    expect(older.code).toBe('INVALID_INPUT');
    expect(older.fields).toEqual(['source_version']);
    const same = ok(
      await report(agentA, doc.workId, delivered.version, delivered.delivery_id, {
        source_kind: 'artifact',
        source_ref: uri,
        source_version: 'v7',
      }),
    ) as any;
    expect(same.criterion.result).toBe('pass');

    const { workId, version } = await readyWork([{ text: 'A label prints.' }]);
    const runId = await run(agentA, workId);
    const sha = commit();
    const cp = await checkpoint(runId, sha);
    const delivery = ok(await submit(agentA, workId, version, { artifacts: [code(sha, { checkpoint_id: cp })] })) as any;
    const earlier = commit();
    const byIndex = refusal(
      await report(agentA, workId, delivery.version, delivery.delivery_id, {
        source_kind: 'artifact',
        source_ref: 'artifacts[0]',
        source_version: earlier,
      }),
    );
    expect(byIndex.fields).toEqual(['source_version']);
    const byCheckpoint = refusal(
      await report(agentA, workId, delivery.version, delivery.delivery_id, {
        source_kind: 'checkpoint',
        source_ref: cp,
        source_version: earlier,
      }),
    );
    expect(byCheckpoint.fields).toEqual(['source_version']);
    ok(
      await report(agentA, workId, delivery.version, delivery.delivery_id, {
        source_kind: 'checkpoint',
        source_ref: cp,
        source_version: sha.toUpperCase(),
      }),
    );
    const rows = await srv.db.select().from(workEvidence).where(eq(workEvidence.deliveryId, delivery.delivery_id));
    expect(rows.map((row) => row.sourceVersion)).toEqual([sha]);
  });
});

describe('who did the work', () => {
  it('keeps a person whose run was linked to the work an executor after that link is corrected away', async () => {
    const { workId, version } = await readyWork([{ text: 'A label prints.' }], {
      acceptance_policy: { require_independent_acceptor: true },
    });
    // Bob, the acceptor, has an agent whose run was started for this work.
    const [installation] = await srv.db
      .insert(agentInstallations)
      .values({ userId: (bob as { userId: string }).userId, name: 'bob-agent', deviceFingerprint: 'bob-fixture' })
      .returning();
    const [bobsRun] = await srv.db
      .insert(agentRuns)
      .values({ installationId: installation!.id, teamId, projectId: alphaId, status: 'active', repo: REPO, branch: 'work' })
      .returning();
    const [link] = await srv.db
      .insert(workLinks)
      .values({
        workId,
        teamId,
        projectId: alphaId,
        kind: 'run',
        runId: bobsRun!.id,
        specRevision: 1,
        createdByKind: 'agent',
        createdById: installation!.id,
      })
      .returning();
    await run(agentA, workId);
    ok(
      await submit(agentA, workId, version, {
        evidence: [{ criterion_id: 'c1', assertion: 'pass', source_kind: 'agent_report', source_ref: 'npm test' }],
      }),
    );
    expect(refusal(await decide(bob, workId, 'accept')).code).toBe('FORBIDDEN');

    // Bob files his run under another work: any member may correct a link,
    // and the correction moves nothing a decision is bound to.
    const elsewhere = ok(
      await createWork(srv.db, bob, {
        request_id: randomUUID(),
        project: 'alpha',
        contract: { title: 'Somewhere else', goal: 'Not this one.' },
      }),
    );
    ok(
      await updateWork(srv.db, bob, {
        request_id: randomUUID(),
        work_id: elsewhere.work_id,
        expected_version: elsewhere.version,
        operation: 'link',
        payload: { kind: 'run', target_id: bobsRun!.id, replaces_link_id: link!.id, reason: 'Wrong work.' },
      }),
    );
    expect(refusal(await decide(bob, workId, 'accept')).code).toBe('FORBIDDEN');
    expect(await srv.db.select().from(workAcceptances).where(eq(workAcceptances.workId, workId))).toHaveLength(0);
  });
});

describe('a provider fact and the workspace row', () => {
  it('locks the workspace before the binding, the order a rebind and a disconnect take them in', async () => {
    const { workId, version } = await readyWork([providerCriterion('ci')]);
    await run(agentA, workId);
    const sha = commit();
    ok(await submit(agentA, workId, version, { artifacts: [code(sha)] }));
    const { transactions } = await traced(() => observe(sha, { subjectId: 'workflow:952', name: 'ci', state: 'success' }));
    const isWorkLock = (text: string) => /from "work_project_counters"/.test(text) && /\bfor update\b/.test(text);
    const reached = transactions.filter((statements) => statements.some(isWorkLock));
    expect(reached).toHaveLength(1);
    const statements = reached[0]!;
    const workspaceAt = statements.findIndex((text) => /from "teams"/.test(text) && /for key share/.test(text));
    const bindingAt = statements.findIndex((text) => /from "repository_bindings"/.test(text) && /for no key update/.test(text));
    // The Work side inserts events naming the workspace, a key share on its row:
    // taken after the binding, it waited on a rebind holding the workspace and
    // waiting for the binding.
    expect(workspaceAt).toBeGreaterThanOrEqual(0);
    expect(bindingAt).toBeGreaterThan(workspaceAt);
  });
});

describe('a current fail and a later pass', () => {
  it('keeps a reported fail standing when another agent reports a pass without superseding it', async () => {
    const { workId, version } = await readyWork([{ text: 'A label prints.' }]);
    await run(agentA, workId);
    await run(agentB, workId);
    const delivered = ok(await submit(agentA, workId, version)) as any;
    const failed = ok(
      await report(agentA, workId, delivered.version, delivered.delivery_id, { assertion: 'fail', source_ref: 'integration tests' }),
    ) as any;
    const passed = ok(await report(agentB, workId, failed.version, delivered.delivery_id, { assertion: 'pass', source_ref: 'lint' })) as any;
    expect(passed.criterion.result).toBe('fail');
    expect(passed.ready_for_review).toBe(false);
    expect(criterionOf(await readinessOf(lead, workId), 'c1').selectors[0]).toMatchObject({
      result: 'fail',
      evidence_ids: [failed.evidence_id],
    });
    expect(refusal(await decide(bob, workId, 'accept')).fields).toEqual(['criteria.c1']);
    // The reporter that fixed it replaces its own row; only then the criterion passes.
    const fixed = ok(await report(agentA, workId, passed.version, delivered.delivery_id, { supersedes_id: failed.evidence_id })) as any;
    expect(fixed.criterion.result).toBe('pass');
  });

  it("keeps a connection's own fail standing when it reports a pass without naming it, as the guide says", async () => {
    const { workId, version } = await readyWork([{ text: 'A label prints.' }]);
    await run(agentA, workId);
    const delivered = ok(await submit(agentA, workId, version)) as any;
    const failed = ok(await report(agentA, workId, delivered.version, delivered.delivery_id, { assertion: 'fail' })) as any;
    const again = ok(await report(agentA, workId, failed.version, delivered.delivery_id, { assertion: 'pass' })) as any;
    expect(again.criterion.result).toBe('fail');
    // The guide's tool reference says what the code does: only a named row is replaced.
    const guide = await (await fetchRetrying(`${srv.url}/docs`)).text();
    const row = /<tr id="tool-record_work_evidence">[\s\S]*?<\/tr>/.exec(guide)?.[0] ?? '';
    expect(row).toContain('<code>supersedes_id</code>');
    expect(row).toContain('a current fail in any of them decides the criterion');
    expect(row).not.toContain('A later report supersedes an earlier one of the same connection');
  });

  it('reads an artifact rule the same way', async () => {
    const { workId, version } = await readyWork([{ text: 'The build is attached.', evidence_kinds: ['artifact'] }]);
    await run(agentA, workId);
    await run(agentB, workId);
    const delivered = ok(await submit(agentA, workId, version)) as any;
    const about = { source_kind: 'artifact', source_ref: 'artifacts[0]' };
    const failed = ok(await report(agentA, workId, delivered.version, delivered.delivery_id, { ...about, assertion: 'fail' })) as any;
    const passed = ok(await report(agentB, workId, failed.version, delivered.delivery_id, { ...about, assertion: 'pass' })) as any;
    expect(passed.criterion.result).toBe('fail');
    expect(passed.ready_for_review).toBe(false);
  });
});

describe('the version a plain report names', () => {
  it('refuses another commit, and records the delivered one as the delivery labels it', async () => {
    const { workId, version } = await readyWork([{ text: 'A label prints.' }]);
    await run(agentA, workId);
    const sha = commit();
    const delivered = ok(await submit(agentA, workId, version, { artifacts: [code(sha)] })) as any;
    const older = refusal(await report(agentA, workId, delivered.version, delivered.delivery_id, { source_version: commit() }));
    expect(older).toMatchObject({ code: 'INVALID_INPUT', fields: ['source_version'] });
    expect(await srv.db.select().from(workEvidence).where(eq(workEvidence.deliveryId, delivered.delivery_id))).toHaveLength(0);
    const same = ok(
      await report(agentA, workId, delivered.version, delivered.delivery_id, { source_version: sha.toUpperCase() }),
    ) as any;
    expect(same.criterion.result).toBe('pass');
    const [row] = await srv.db.select().from(workEvidence).where(eq(workEvidence.id, same.evidence_id));
    expect(row!.sourceVersion).toBe(sha);
  });
});

describe('a source that is gone', () => {
  it('lists evidence validity independently from assertions across detail pages', async () => {
    const { workId, version } = await readyWork([{
      text: 'Smoke test is recent.',
      verification_rule: { mode: 'all', selectors: [{ source: 'agent_report' }], max_age_seconds: 3600 },
    }]);
    const runId = await run(agentA, workId);
    const sha = commit();
    const cp = await checkpoint(runId, sha);
    const delivered = ok(await submit(agentA, workId, version, { artifacts: [code(sha)] })) as any;
    const old = ok(await report(agentA, workId, delivered.version, delivered.delivery_id, {})) as any;
    const replacement = ok(await report(agentA, workId, old.version, delivered.delivery_id, {
      assertion: 'fail', supersedes_id: old.evidence_id,
    })) as any;
    const aged = ok(await report(agentA, workId, replacement.version, delivered.delivery_id, {
      observed_at: new Date(Date.now() - 7_200_000).toISOString(),
    })) as any;
    const missing = ok(await report(agentA, workId, aged.version, delivered.delivery_id, {
      source_kind: 'checkpoint', source_ref: cp,
    })) as any;
    const withdrawn = ok(await report(agentA, workId, missing.version, delivered.delivery_id, {})) as any;
    await srv.db.delete(runCheckpoints).where(eq(runCheckpoints.id, cp));
    await srv.db.update(workEvidence).set({ withdrawnAt: new Date() }).where(eq(workEvidence.id, withdrawn.evidence_id));
    const expected = new Map([
      [old.evidence_id, 'superseded'], [replacement.evidence_id, 'current'],
      [aged.evidence_id, 'stale'], [missing.evidence_id, 'unavailable'], [withdrawn.evidence_id, 'withdrawn'],
    ]);
    const found = new Map<string, string>();
    let cursor: string | undefined;
    do {
      const detail = ok(await getWork(srv.db, lead, workId, {
        view: 'detail', sections: ['evidence'], sectionLimit: 1, cursors: cursor ? { evidence: cursor } : undefined,
      })) as any;
      const section = detail.sections.evidence;
      for (const item of section.items) {
        expect(item.validity).toBe(expected.get(item.id));
        expect(item.provenance).toBe('agent_reported');
        expect(item.assertion).toBe(item.id === replacement.evidence_id ? 'fail' : 'pass');
        found.set(item.id, item.validity);
      }
      cursor = section.next_cursor ?? undefined;
    } while (cursor);
    expect(found).toEqual(expected);
    const seen = ok(await readEvidence(srv.db, lead, workId)) as any;
    const manifestRows = seen.manifest.criteria.find((criterion: any) => criterion.id === 'c1').evidence;
    for (const item of manifestRows) expect(item.validity).toBe(expected.get(item.id));
  });

  it('reads evidence whose checkpoint was deleted as unavailable, never a pass', async () => {
    const { workId, version } = await readyWork([{ text: 'A label prints.' }]);
    const runId = await run(agentA, workId);
    const sha = commit();
    const cp = await checkpoint(runId, sha);
    const delivered = ok(await submit(agentA, workId, version, { artifacts: [code(sha)] })) as any;
    const reported = ok(
      await report(agentA, workId, delivered.version, delivered.delivery_id, { source_kind: 'checkpoint', source_ref: cp }),
    ) as any;
    expect(reported.criterion.result).toBe('pass');
    // The checkpoint goes with its run, as it does when the reporter's account is erased.
    await srv.db.delete(runCheckpoints).where(eq(runCheckpoints.id, cp));
    const read = criterionOf(await readinessOf(lead, workId), 'c1');
    expect(read.result).toBe('unknown');
    expect(read.selectors[0]).toMatchObject({ result: 'unavailable', reason: 'source_deleted' });
    expect(read.selectors[0].detail).toContain('no longer exists');
    const seen = ok(await readEvidence(srv.db, lead, workId)) as any;
    expect(seen.readiness.ready_for_review).toBe(false);
    const listed = seen.manifest.criteria.find((criterion: any) => criterion.id === 'c1').evidence;
    expect(listed).toEqual([expect.objectContaining({ id: reported.evidence_id, validity: 'unavailable' })]);
  });
});

describe('an accepted upstream whose evidence moved with no epoch', () => {
  const graphOf = async (workId: string) => (await blockingState(srv.db, [workId])).get(workId)!;

  /** An upstream accepted on a passing CI fact, and a downstream that depends on it and is met. */
  async function acceptedPair(subjectId: string) {
    const upstream = await readyWork([providerCriterion('ci')]);
    const downstream = await readyWork([{ text: 'The label lists the order.' }]);
    ok(
      await updateWork(srv.db, lead, {
        request_id: randomUUID(),
        work_id: downstream.workId,
        expected_version: downstream.version,
        operation: 'add_dependency',
        payload: { depends_on: upstream.workId },
      }),
    );
    const runId = await run(agentA, upstream.workId);
    const sha = commit();
    ok(await submit(agentA, upstream.workId, upstream.version, { artifacts: [code(sha)] }));
    await observe(sha, { subjectId, name: 'ci', state: 'success', observedAt: new Date(Date.now() - 10_000) });
    ok(await decide(bob, upstream.workId, 'accept'));
    expect(await graphOf(downstream.workId)).toMatchObject({ blocked: false, unmetDependencies: 0 });
    return { upstream: upstream.workId, downstream: downstream.workId, sha, runId };
  }

  it('unmeets the edge when the repository the acceptance read is no longer verified', async () => {
    const pair = await acceptedPair('workflow:970');
    await srv.db.update(repositoryBindings).set({ verifiedAt: null }).where(eq(repositoryBindings.id, githubBindingId));
    try {
      expect((await evidenceState(srv.db, [pair.upstream])).get(pair.upstream)?.acceptanceStale).toBe(true);
      const after = await graphOf(pair.downstream);
      expect(after.blocked).toBe(true);
      expect(after.unmet).toEqual([expect.objectContaining({ work_id: pair.upstream, state: 'accepted', why: 'acceptance_stale' })]);
    } finally {
      await srv.db.update(repositoryBindings).set({ verifiedAt: new Date() }).where(eq(repositoryBindings.id, githubBindingId));
    }
    expect(await graphOf(pair.downstream)).toMatchObject({ blocked: false, unmetDependencies: 0 });
  });

  it('moves the epoch of an archived accepted upstream, so a failing fact unmeets the edge', async () => {
    const pair = await acceptedPair('workflow:971');
    await srv.db.update(agentRuns).set({ status: 'completed', endedAt: new Date() }).where(eq(agentRuns.id, pair.runId));
    const row = await workRow(pair.upstream);
    ok(
      await updateWork(srv.db, lead, {
        request_id: randomUUID(),
        work_id: pair.upstream,
        expected_version: row.version.toString(),
        operation: 'archive',
        payload: {},
      }),
    );
    const before = await workRow(pair.upstream);
    await observe(pair.sha, { subjectId: 'workflow:972', name: 'ci', state: 'failure' });
    expect((await workRow(pair.upstream)).evidenceEpoch).toBe(before.evidenceEpoch + 1n);
    expect((await evidenceState(srv.db, [pair.upstream])).get(pair.upstream)?.acceptanceStale).toBe(true);
    expect((await graphOf(pair.downstream)).unmet).toEqual([
      expect.objectContaining({ work_id: pair.upstream, why: 'acceptance_stale' }),
    ]);
  });
});

describe('a decision on what was shown', () => {
  it('refuses an acceptor removed from the workspace, and writes nothing', async () => {
    await form(`${srv.url}/auth/dev`, { username: 'carol' });
    const carolId = await userId('carol');
    await srv.db.insert(memberships).values({ teamId, userId: carolId, role: 'member' });
    const carol = humanPrincipal(carolId);
    const { workId, version } = await readyWork([{ text: 'A label prints.' }], {}, 'carol');
    await run(agentA, workId);
    ok(
      await submit(agentA, workId, version, {
        evidence: [{ criterion_id: 'c1', assertion: 'pass', source_kind: 'agent_report', source_ref: 'npm test' }],
      }),
    );
    const seen = ok(await readEvidence(srv.db, carol, workId)) as any;
    expect(seen.may_decide).toBe(true);
    // Removed while the page with the decision form is still open.
    await srv.db.delete(memberships).where(and(eq(memberships.teamId, teamId), eq(memberships.userId, carolId)));
    const refused = refusal(
      await recordDecision(srv.db, carol, workId, {
        request_id: randomUUID(),
        expected_version: seen.version,
        spec_revision: seen.spec_revision,
        delivery_id: seen.delivery_id,
        evidence_epoch: seen.evidence_epoch,
        evidence_manifest_hash: seen.evidence_manifest_hash,
        decision: 'accept',
      }),
    );
    expect(refused.code).toBe('NOT_FOUND');
    expect(await srv.db.select().from(workAcceptances).where(eq(workAcceptances.workId, workId))).toHaveLength(0);
    expect(await srv.db.select().from(workCommands).where(eq(workCommands.principalId, carolId))).toHaveLength(0);
    expect((await workRow(workId)).state).toBe('in_review');
  });

  it('refuses a decision on a delivery a newer one replaced, naming the delivery as what moved', async () => {
    const { workId, version } = await readyWork([{ text: 'A label prints.' }]);
    await run(agentA, workId);
    const passing = [{ criterion_id: 'c1', assertion: 'pass', source_kind: 'agent_report', source_ref: 'npm test' }];
    const first = ok(await submit(agentA, workId, version, { evidence: passing })) as any;
    const seen = ok(await readEvidence(srv.db, bob, workId)) as any;
    ok(await submit(agentA, workId, first.version, { evidence: passing }));
    const snapshot = (from: any, extra: Record<string, unknown> = {}) => ({
      request_id: randomUUID(),
      expected_version: from.version,
      spec_revision: from.spec_revision,
      delivery_id: from.delivery_id,
      evidence_epoch: from.evidence_epoch,
      evidence_manifest_hash: from.evidence_manifest_hash,
      decision: 'accept' as const,
      ...extra,
    });
    // The form as it was drawn: the version moved, and the delivery is named as what moved.
    const stale = refusal(await recordDecision(srv.db, bob, workId, snapshot(seen)));
    expect(stale.code).toBe('VERSION_CONFLICT');
    expect(stale.fields).toEqual(expect.arrayContaining(['delivery_id']));
    expect(stale.message).toContain('delivery_id');
    // The current version with the delivery it replaced: refused on the delivery itself.
    const now = ok(await readEvidence(srv.db, bob, workId)) as any;
    const replaced = refusal(await recordDecision(srv.db, bob, workId, snapshot(now, { delivery_id: first.delivery_id })));
    expect(replaced.code).toBe('EVIDENCE_STALE');
    expect(replaced.fields).toEqual(['delivery_id']);
    expect(await srv.db.select().from(workAcceptances).where(eq(workAcceptances.workId, workId))).toHaveLength(0);
  });
});

describe('provider facts and the acceptance they read', () => {
  const graphOf = async (workId: string) => (await blockingState(srv.db, [workId])).get(workId)!;
  const ago = (ms: number) => new Date(Date.now() - ms);
  const staleEvents = async (workId: string) =>
    srv.db.select().from(workEvents).where(and(eq(workEvents.workId, workId), eq(workEvents.type, 'acceptance_stale')));

  it('keeps the last completed GitHub attempt during a readback of an unfinished rerun', async () => {
    const { workId, version } = await readyWork([providerCriterion('ci')]);
    const sha = commit();
    ok(await submit(lead, workId, version, { artifacts: [code(sha)] }));
    await observe(sha, { subjectId: 'workflow:9901', name: 'ci', state: 'success', observedAt: ago(20_000) });
    ok(await decide(bob, workId, 'accept'));
    const before = await workRow(workId);
    const cookie = jar();
    cookie.store(await form(`${srv.url}/auth/dev`, { username: 'lead' }));
    const readback = vi.spyOn(github, 'readGithubWorkflow');
    try {
      for (const status of ['queued', 'in_progress']) {
        readback.mockResolvedValue({ ok: true, value: {
          id: 9901, name: 'ci', head_sha: sha, run_attempt: 2, updated_at: ago(10_000).toISOString(),
          status, conclusion: null, repository: { id: GITHUB_REPOSITORY_ID as unknown as number },
        } } as any);
        const response = await form(`${srv.url}/app/teams/work-evidence/repositories/verify`, {
          binding: githubBindingId, run: '9901',
        }, cookie.header());
        expect(response.status).toBe(409);
        expect(await response.text()).toContain('not completed');
        expect(criterionOf(await readinessOf(bob, workId), 'ci').result).toBe('pass');
        expect((await workRow(workId)).evidenceEpoch).toBe(before.evidenceEpoch);
        expect(await staleEvents(workId)).toHaveLength(0);
      }
    } finally {
      readback.mockRestore();
    }
    await observe(sha, { subjectId: 'workflow:9901', name: 'ci', state: 'success', attempt: 2, observedAt: ago(5_000) });
    expect((await evidenceState(srv.db, [workId])).get(workId)?.acceptanceStale).toBe(false);
    await observe(sha, { subjectId: 'workflow:9901', name: 'ci', state: 'failure', attempt: 3, observedAt: ago(1_000) });
    expect((await evidenceState(srv.db, [workId])).get(workId)?.acceptanceStale).toBe(true);
  });

  it('keeps an acceptance standing on an unknown completed result and stales it on a real failure', async () => {
    const { workId, version } = await readyWork([providerCriterion('ci')]);
    const sha = commit();
    ok(await submit(lead, workId, version, { artifacts: [code(sha)] }));
    await observe(sha, { subjectId: 'workflow:9902', name: 'ci', state: 'success', observedAt: ago(20_000) });
    ok(await decide(bob, workId, 'accept'));
    const before = await workRow(workId);
    await observe(sha, { subjectId: 'workflow:9902', name: 'ci', state: 'unknown', attempt: 2, observedAt: ago(10_000) });
    expect(criterionOf(await readinessOf(bob, workId), 'ci').result).toBe('unknown');
    expect((await workRow(workId)).evidenceEpoch).toBe(before.evidenceEpoch);
    expect((await evidenceState(srv.db, [workId])).get(workId)?.acceptanceStale).toBe(false);
    expect(await staleEvents(workId)).toHaveLength(0);
    await observe(sha, { subjectId: 'workflow:9902', name: 'ci', state: 'failure', attempt: 3, observedAt: ago(5_000) });
    expect((await evidenceState(srv.db, [workId])).get(workId)?.acceptanceStale).toBe(true);
    expect(await staleEvents(workId)).toHaveLength(1);
  });

  it('stales an acceptance when a tied completed observation contains a real failure', async () => {
    const { workId, version } = await readyWork([providerCriterion('ci')]);
    const sha = commit();
    ok(await submit(lead, workId, version, { artifacts: [code(sha)] }));
    await observe(sha, { subjectId: 'workflow:9903', name: 'ci', state: 'success', observedAt: ago(20_000) });
    ok(await decide(bob, workId, 'accept'));
    const at = ago(5_000);
    await observe(sha, { subjectId: 'workflow:9904', name: 'ci', state: 'success', observedAt: at });
    await observe(sha, { subjectId: 'workflow:9905', name: 'ci', state: 'failure', observedAt: at });
    expect(criterionOf(await readinessOf(bob, workId), 'ci').result).toBe('inconclusive');
    expect((await evidenceState(srv.db, [workId])).get(workId)?.acceptanceStale).toBe(true);
    expect(await staleEvents(workId)).toHaveLength(1);
  });

  it('does not stale on an unknown result beside an already accepted failure', async () => {
    const { workId, version } = await readyWork([{ ...providerCriterion('ci'), required: false }]);
    const sha = commit();
    ok(await submit(lead, workId, version, { artifacts: [code(sha)] }));
    const at = ago(20_000);
    await observe(sha, { subjectId: 'workflow:accepted-tie-pass', name: 'ci', definition: 'A', state: 'success', observedAt: at });
    await observe(sha, { subjectId: 'workflow:accepted-tie-fail', name: 'ci', definition: 'A', state: 'failure', observedAt: at });
    expect(criterionOf(await readinessOf(bob, workId), 'ci').result).toBe('inconclusive');
    ok(await decide(bob, workId, 'accept'));
    const accepted = await workRow(workId);
    await observe(sha, { subjectId: 'workflow:unrelated-unknown', name: 'ci', definition: 'B', state: 'unknown', observedAt: ago(10_000) });
    expect(criterionOf(await readinessOf(bob, workId), 'ci').result).toBe('unknown');
    expect((await workRow(workId)).evidenceEpoch).toBe(accepted.evidenceEpoch);
    expect((await evidenceState(srv.db, [workId])).get(workId)!.acceptanceStale).toBe(false);
    expect(await staleEvents(workId)).toHaveLength(0);
    // A later readback gets its own observation row, but the failing run and
    // attempt are the ones the acceptor already saw in the original tie.
    expect(await observe(sha, {
      subjectId: 'workflow:accepted-tie-fail', name: 'ci', definition: 'A', state: 'failure', observedAt: ago(8_000),
    })).toHaveProperty('recorded', true);
    expect(criterionOf(await readinessOf(bob, workId), 'ci').result).toBe('fail');
    expect((await workRow(workId)).evidenceEpoch).toBe(accepted.evidenceEpoch);
    expect((await evidenceState(srv.db, [workId])).get(workId)!.acceptanceStale).toBe(false);
    await observe(sha, { subjectId: 'workflow:accepted-tie-fail', name: 'ci', definition: 'A', state: 'failure', attempt: 2, observedAt: ago(5_000) });
    expect((await evidenceState(srv.db, [workId])).get(workId)!.acceptanceStale).toBe(true);
  });

  it('leaves an acceptance standing when the check it was accepted on passes again, and stales it on a failure', async () => {
    const upstream = await readyWork([{ text: 'A label prints.' }, providerCriterion('ci')]);
    const downstream = await readyWork([{ text: 'The label lists the order.' }]);
    ok(
      await updateWork(srv.db, lead, {
        request_id: randomUUID(),
        work_id: downstream.workId,
        expected_version: downstream.version,
        operation: 'add_dependency',
        payload: { depends_on: upstream.workId },
      }),
    );
    await run(agentA, upstream.workId);
    const sha = commit();
    ok(
      await submit(agentA, upstream.workId, upstream.version, {
        artifacts: [code(sha)],
        evidence: [{ criterion_id: 'c1', assertion: 'pass', source_kind: 'agent_report', source_ref: 'npm test' }],
      }),
    );
    await observe(sha, { subjectId: 'workflow:101', name: 'ci', state: 'success', observedAt: ago(40_000) });
    ok(await decide(bob, upstream.workId, 'accept'));
    expect(await graphOf(downstream.workId)).toMatchObject({ blocked: false, unmetDependencies: 0 });
    const accepted = await workRow(upstream.workId);

    // A second run of the same workflow on the same commit (a pull_request
    // trigger beside push, somebody pressing Run workflow) and a rerun of it
    // both pass: they agree with what was accepted and move nothing.
    await observe(sha, { subjectId: 'workflow:102', name: 'ci', state: 'success', observedAt: ago(30_000) });
    await observe(sha, { subjectId: 'workflow:102', name: 'ci', state: 'success', attempt: 2, observedAt: ago(20_000) });
    const after = await workRow(upstream.workId);
    expect(after.evidenceEpoch).toBe(accepted.evidenceEpoch);
    expect(after.version).toBe(accepted.version);
    expect((await evidenceState(srv.db, [upstream.workId])).get(upstream.workId)?.acceptanceStale).toBe(false);
    expect(await graphOf(downstream.workId)).toMatchObject({ blocked: false, unmetDependencies: 0, dependencyChanged: false });
    expect(await staleEvents(upstream.workId)).toHaveLength(0);

    // A run that fails is a new negative observation: the acceptance is stale,
    // and so is every edge that leaned on it.
    await observe(sha, { subjectId: 'workflow:103', name: 'ci', state: 'failure', observedAt: ago(10_000) });
    expect((await workRow(upstream.workId)).evidenceEpoch).toBe(accepted.evidenceEpoch + 1n);
    expect((await evidenceState(srv.db, [upstream.workId])).get(upstream.workId)?.acceptanceStale).toBe(true);
    expect((await graphOf(downstream.workId)).unmet).toEqual([
      expect.objectContaining({ work_id: upstream.workId, why: 'acceptance_stale' }),
    ]);
    expect(await staleEvents(upstream.workId)).toHaveLength(1);
  });

  it('reads a provider fact only through a binding of the repository the commit was delivered in, never a fork holding it', async () => {
    const [gamma] = await srv.db
      .insert(projects)
      .values({ teamId, name: 'gamma', slug: 'gamma', repositoryIdentity: 'github.com/acme/gamma' })
      .returning();
    const [connection] = await srv.db
      .select({ id: teamIntegrations.id })
      .from(teamIntegrations)
      .where(and(eq(teamIntegrations.teamId, teamId), eq(teamIntegrations.provider, 'github')));
    const bind = async (repositoryId: string, fullName: string) =>
      (
        await srv.db
          .insert(repositoryBindings)
          .values({ connectionId: connection!.id, teamId, projectId: gamma!.id, provider: 'github', repositoryId, fullName, verifiedAt: new Date() })
          .returning()
      )[0]!;
    const own = await bind('gh-gamma', 'acme/gamma');
    const fork = await bind('gh-gamma-fork', 'acme/gamma-fork');
    const created = ok(
      await createWork(srv.db, lead, {
        request_id: randomUUID(),
        project: 'gamma',
        contract: { title: 'Print from gamma', goal: 'A paid order prints a label.', artifact_kind: 'code' },
        criteria: [providerCriterion('ci')],
        acceptor: 'bob',
      }),
    );
    const ready = ok(
      await updateWork(srv.db, lead, {
        request_id: randomUUID(),
        work_id: created.work_id,
        expected_version: created.version,
        operation: 'transition',
        payload: { to: 'ready' },
      }),
    );
    const sha = commit();
    ok(
      await submit(lead, created.work_id, ready.version, {
        artifacts: [code(sha, { repository_identity: 'https://github.com/acme/gamma.git' })],
      }),
    );
    const factOn = (binding: typeof own, state: 'success' | 'failure', subjectId: string) =>
      recordProviderObservation(srv.db, teamId, 'github', {
        bindingId: binding.id,
        repositoryId: binding.repositoryId,
        deliveryId: randomUUID(),
        subjectId,
        subjectName: 'ci',
        commitSha: sha,
        kind: 'workflow',
        state,
        attempt: 1,
        observedAt: ago(5_000),
      });
    const delivered = await workRow(created.work_id);

    // The fork shares the history and its ci passed on the delivered commit:
    // not a check of the delivery, so nothing passes and no epoch moves.
    expect(await factOn(fork, 'success', 'workflow:fork-1')).toHaveProperty('recorded', true);
    expect(criterionOf(await readinessOf(lead, created.work_id), 'ci')).toMatchObject({ result: 'unknown', reasons: ['not_observed'] });
    expect((await workRow(created.work_id)).evidenceEpoch).toBe(delivered.evidenceEpoch);
    const seen = ok(await readEvidence(srv.db, lead, created.work_id)) as any;
    expect(seen.manifest.provider_subjects.items).toEqual([]);

    // The delivered repository's own run is the check.
    expect(await factOn(own, 'failure', 'workflow:own-1')).toHaveProperty('recorded', true);
    expect(criterionOf(await readinessOf(lead, created.work_id), 'ci')).toMatchObject({ result: 'fail' });
    expect((await workRow(created.work_id)).evidenceEpoch).toBe(delivered.evidenceEpoch + 1n);

    // With only the fork verified, the check cannot be observed on the delivered repository, and says why.
    await srv.db.update(repositoryBindings).set({ verifiedAt: null }).where(eq(repositoryBindings.id, own.id));
    expect(criterionOf(await readinessOf(lead, created.work_id), 'ci')).toMatchObject({
      result: 'unknown',
      reasons: ['repository_not_bound'],
    });
  });

  it('moves the epoch of every work a fact is about, however many current deliveries carry the commit', async () => {
    const sha = commit();
    const ids: string[] = [];
    // One past the 50 a single fact used to reach.
    for (let index = 0; index < 51; index++) {
      const { workId, version } = await readyWork([providerCriterion('ci')]);
      ok(await submit(lead, workId, version, { artifacts: [code(sha)] }));
      ids.push(workId);
    }
    const before = new Map((await srv.db.select().from(workItems).where(inArray(workItems.id, ids))).map((row) => [row.id, row.evidenceEpoch]));
    await observe(sha, { subjectId: 'workflow:5100', name: 'ci', state: 'failure' });
    const after = await srv.db.select().from(workItems).where(inArray(workItems.id, ids));
    expect(after.filter((row) => row.evidenceEpoch !== before.get(row.id)! + 1n).map((row) => row.displayKey)).toEqual([]);
    const observed = await srv.db
      .select({ workId: workEvents.workId })
      .from(workEvents)
      .where(and(inArray(workEvents.workId, ids), eq(workEvents.type, 'evidence_observed')));
    expect(new Set(observed.map((row) => row.workId)).size).toBe(ids.length);
  }, 180_000);

  it('clears the acceptance when accepted work is reopened, by a reopen and by a contract change, and keeps the decision in the history', async () => {
    for (const door of ['reopen', 'patch'] as const) {
      const { workId, version } = await readyWork([{ text: 'A label prints.' }]);
      await run(agentA, workId);
      ok(
        await submit(agentA, workId, version, {
          evidence: [{ criterion_id: 'c1', assertion: 'pass', source_kind: 'agent_report', source_ref: 'npm test' }],
        }),
      );
      const accepted = ok(await decide(bob, workId, 'accept')) as any;
      const before = await workRow(workId);
      expect(before.currentAcceptanceId, door).toBe(accepted.acceptance_id);
      ok(
        await updateWork(srv.db, lead, {
          request_id: randomUUID(),
          work_id: workId,
          expected_version: before.version.toString(),
          ...(door === 'reopen'
            ? { operation: 'reopen', payload: { reason: 'The label is wrong after all.' } }
            : {
                operation: 'patch',
                payload: { contract: { goal: 'A paid order prints a label with the return address.' }, reopen_reason: 'The return address was missed.' },
              }),
        }),
      );
      const after = await workRow(workId);
      expect(after.state, door).toBe('in_progress');
      expect(after.currentAcceptanceId, door).toBeNull();
      // Nothing reads the old decision as this work's: not the flag, not the
      // evidence a person sees, not the detail view.
      expect((await evidenceState(srv.db, [workId])).get(workId)?.acceptanceStale, door).toBe(false);
      expect((ok(await readEvidence(srv.db, lead, workId)) as any).acceptance, door).toBeNull();
      const detail = ok(await getWork(srv.db, lead, workId, { view: 'detail', sections: ['acceptances'] })) as any;
      expect(detail.sections.acceptances.items, door).toEqual([expect.objectContaining({ id: accepted.acceptance_id, current: false })]);
      expect(await srv.db.select().from(workAcceptances).where(eq(workAcceptances.workId, workId)), door).toHaveLength(1);
    }
  });
});
