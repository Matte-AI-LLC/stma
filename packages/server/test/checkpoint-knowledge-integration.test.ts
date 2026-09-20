import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createAgentEnrollment, redeemAgentEnrollment } from '../src/domain/enrollments';
import { evidenceForRun } from '../src/domain/evidence';
import {
  getKnowledgeContext,
  proposeKnowledge,
  publishKnowledge,
  reportKnowledgeReceipt,
} from '../src/domain/knowledge';
import {
  agentRuns,
  handoffs,
  knowledgeContexts,
  knowledgeReceipts,
  memberships,
  projects,
  runCheckpoints,
  teams,
  users,
} from '../src/db/schema';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

const TEAM = 'checkpoint-knowledge';
const PROJECT = 'Payments API';
const REPOSITORY = 'github.com/acme/payments-api';
const SHA = {
  start: 'a'.repeat(40),
  delivery: 'b'.repeat(40),
  tested: 'c'.repeat(40),
  handoffStart: 'd'.repeat(40),
  handoffTested: 'e'.repeat(40),
};

let srv: StartedServer;
let dataDir = '';
let ownerId = '';
let teamId = '';
let projectId = '';
let sourceToken = '';
let sourceTokenId = '';
let sourceInstallationId = '';
let receiverToken = '';
let receiverInstallationId = '';
let knowledgeItemId = '';
let knowledgeV1 = '';
let rpcId = 1;

async function redeemInstallation(name: string, deviceLabel: string) {
  const enrollment = await createAgentEnrollment(srv.db, {
    userId: ownerId,
    name,
    deviceLabel,
    clientType: 'codex',
    scope: 'project',
    teamId,
    projectId,
  });
  const redeemed = await redeemAgentEnrollment(srv.db, enrollment.code);
  if (!redeemed.ok) throw new Error(`Could not redeem ${name}`);
  await call(redeemed.value.token, 'whoami', {});
  return redeemed.value;
}

async function rest(token: string, endpoint: string, body: unknown) {
  const response = await fetch(`${srv.url}${endpoint}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { response, data: (await response.json()) as any };
}

async function call(token: string, tool: string, args: Record<string, unknown>) {
  const response = await fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId++,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  });
  const payload = (await response.json()) as {
    result?: { content?: Array<{ text: string }>; isError?: boolean };
    error?: { message?: string };
  };
  const text = payload.result?.content?.[0]?.text ?? payload.error?.message ?? '';
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    // Error responses may intentionally be plain prose.
  }
  return {
    data,
    text,
    isError: payload.result?.isError === true || payload.error !== undefined,
  };
}

function checkpoint(
  kind: 'start' | 'delivery' | 'tested',
  commitSha: string,
  requestId = randomUUID(),
  repositoryIdentity = REPOSITORY,
) {
  return {
    requestId,
    kind,
    repositoryIdentity,
    commitSha,
    worktreeClean: true,
    tests:
      kind === 'tested'
        ? [{ name: 'focused integration', state: 'passed' as const }]
        : [],
  };
}

async function publishVersion(body: string, expectedCurrentVersionId: string | null) {
  const proposed = await proposeKnowledge(srv.db, ownerId, {
    team: TEAM,
    stableKey: 'kh3-resume-marker',
    kind: 'procedure',
    title: 'KH3 resume marker',
    body,
    audience: { type: 'selected_projects', projects: [PROJECT] },
    source: {
      type: 'import',
      path: 'docs/knowledge/refund.md',
      repository: REPOSITORY,
      commit: expectedCurrentVersionId ? 'b'.repeat(40) : 'a'.repeat(40),
      symlink: false,
    },
    expectedDraftVersionId: null,
  });
  if ('error' in proposed) throw new Error(proposed.error);
  const published = await publishKnowledge(srv.db, ownerId, {
    team: TEAM,
    itemId: proposed.draft.itemId,
    draftVersionId: proposed.draft.versionId,
    expectedCurrentVersionId,
  });
  if ('error' in published) throw new Error(published.error);
  return published.published;
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-checkpoint-knowledge-'));
  srv = await startServer(
    loadEnv({
      port: 0,
      host: '127.0.0.1',
      nodeEnv: 'test',
      devMode: true,
      databaseUrl: undefined,
      pgliteDir: dataDir,
    }),
  );

  ownerId = (
    await srv.db.insert(users).values({ username: 'checkpoint-knowledge-owner' }).returning()
  )[0]!.id;
  teamId = (
    await srv.db
      .insert(teams)
      .values({ name: 'Checkpoint Knowledge', slug: TEAM, createdBy: ownerId })
      .returning()
  )[0]!.id;
  await srv.db.insert(memberships).values({ teamId, userId: ownerId, role: 'owner' });
  projectId = (
    await srv.db
      .insert(projects)
      .values({
        teamId,
        name: PROJECT,
        slug: 'payments-api',
        repositoryIdentity: REPOSITORY,
        createdBy: ownerId,
      })
      .returning()
  )[0]!.id;

  const firstKnowledge = await publishVersion(
    'kh3-resume-marker version one: review the exact checkpoint before continuing.',
    null,
  );
  knowledgeItemId = firstKnowledge.itemId;
  knowledgeV1 = firstKnowledge.versionId;

  const source = await redeemInstallation('source-agent', 'source-device');
  sourceToken = source.token;
  sourceTokenId = source.tokenId;
  sourceInstallationId = source.installation.id;
  const receiver = await redeemInstallation('receiver-agent', 'receiver-device');
  receiverToken = receiver.token;
  receiverInstallationId = receiver.installation.id;
});

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

it('writes REST lifecycle checkpoints idempotently and rolls a mismatched start back', async () => {
  const refusedRunRequest = randomUUID();
  const refusedCheckpointRequest = randomUUID();
  const refused = await rest(sourceToken, '/api/agent/runs/start', {
    requestId: refusedRunRequest,
    installationId: sourceInstallationId,
    team: TEAM,
    project: PROJECT,
    repositoryIdentity: REPOSITORY,
    intent: 'mismatched checkpoint must not leave a partial run',
    checkpoint: checkpoint(
      'start',
      SHA.start,
      refusedCheckpointRequest,
      'github.com/other/payments-api',
    ),
    claims: [],
  });
  expect(refused.response.status).toBe(400);
  expect(refused.data.error).toContain('does not match');
  expect(
    await srv.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.startRequestId, refusedRunRequest)),
  ).toEqual([]);
  expect(
    await srv.db
      .select()
      .from(runCheckpoints)
      .where(eq(runCheckpoints.requestId, refusedCheckpointRequest)),
  ).toEqual([]);

  const runRequestId = randomUUID();
  const startCheckpoint = checkpoint('start', SHA.start);
  const startBody = {
    requestId: runRequestId,
    installationId: sourceInstallationId,
    team: TEAM,
    project: PROJECT,
    repositoryIdentity: REPOSITORY,
    taskKey: 'KH3-LIFECYCLE',
    intent: 'record each lifecycle checkpoint once',
    checkpoint: startCheckpoint,
    claims: [{ resourceType: 'path', resourceKey: 'src/lifecycle.ts', access: 'write' }],
  };
  const first = await rest(sourceToken, '/api/agent/runs/start', startBody);
  const replay = await rest(sourceToken, '/api/agent/runs/start', startBody);
  expect(first.response.status).toBe(200);
  expect(replay.response.status).toBe(200);
  expect(first.data.replayed).toBe(false);
  expect(replay.data.replayed).toBe(true);
  expect(replay.data.run.id).toBe(first.data.run.id);
  expect(replay.data.checkpoint.checkpoint.id).toBe(first.data.checkpoint.checkpoint.id);
  expect(replay.data.checkpoint.replayed).toBe(true);
  expect(replay.data.knowledgeContext).toEqual(first.data.knowledgeContext);
  expect(
    await srv.db
      .select()
      .from(knowledgeContexts)
      .where(eq(knowledgeContexts.runId, first.data.run.id)),
  ).toHaveLength(1);

  const deliveryCheckpoint = checkpoint('delivery', SHA.delivery);
  const heartbeat = await rest(
    sourceToken,
    `/api/agent/runs/${first.data.run.id}/heartbeat`,
    { status: 'active', checkpoint: deliveryCheckpoint },
  );
  expect(heartbeat.response.status).toBe(200);
  expect(heartbeat.data.checkpoint).toMatchObject({
    replayed: false,
    checkpoint: { kind: 'delivery', commitSha: SHA.delivery },
  });

  const finishCheckpoint = checkpoint('tested', SHA.tested);
  const finished = await rest(
    sourceToken,
    `/api/agent/runs/${first.data.run.id}/finish`,
    { status: 'completed', detail: 'verified locally', checkpoint: finishCheckpoint },
  );
  const finishReplay = await rest(
    sourceToken,
    `/api/agent/runs/${first.data.run.id}/finish`,
    { status: 'completed', detail: 'verified locally', checkpoint: finishCheckpoint },
  );
  expect(finished.response.status).toBe(200);
  expect(finished.data).toMatchObject({
    status: 'completed',
    replayed: false,
    checkpoint: {
      replayed: false,
      checkpoint: { kind: 'tested', commitSha: SHA.tested },
    },
  });
  expect(finishReplay.response.status).toBe(200);
  expect(finishReplay.data).toMatchObject({
    replayed: true,
    checkpoint: {
      replayed: true,
      checkpoint: { id: finished.data.checkpoint.checkpoint.id },
    },
  });

  const runs = await srv.db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.installationId, sourceInstallationId),
        eq(agentRuns.startRequestId, runRequestId),
      ),
    );
  const checkpoints = await srv.db
    .select()
    .from(runCheckpoints)
    .where(eq(runCheckpoints.runId, first.data.run.id));
  expect(runs).toHaveLength(1);
  expect(checkpoints.map((row) => row.kind).sort()).toEqual(['delivery', 'start', 'tested']);
  expect(new Set(checkpoints.map((row) => row.requestId)).size).toBe(3);
});

it('carries checkpoint and Knowledge context through handoff, then requires exact safe resume', async () => {
  const started = await rest(sourceToken, '/api/agent/runs/start', {
    requestId: randomUUID(),
    installationId: sourceInstallationId,
    team: TEAM,
    project: PROJECT,
    repositoryIdentity: REPOSITORY,
    intent: 'kh3-resume-marker',
    branch: 'feat/checkpoint-knowledge',
    checkpoint: checkpoint('start', SHA.handoffStart),
    claims: [{ resourceType: 'path', resourceKey: 'docs/knowledge', access: 'write' }],
  });
  expect(started.response.status).toBe(200);
  expect(started.data.knowledgeContext.manifest).toMatchObject({
    runId: started.data.run.id,
    checkpointId: started.data.checkpoint.checkpoint.id,
    versions: [{ itemId: knowledgeItemId, versionId: knowledgeV1, reason: 'planned_path_match' }],
  });

  const contextId = started.data.knowledgeContext.contextId as string;
  const [storedContext] = await srv.db
    .select()
    .from(knowledgeContexts)
    .where(eq(knowledgeContexts.id, contextId));
  const [servedReceipt] = await srv.db
    .select()
    .from(knowledgeReceipts)
    .where(eq(knowledgeReceipts.contextId, contextId));
  expect(storedContext).toMatchObject({
    runId: started.data.run.id,
    checkpointId: started.data.checkpoint.checkpoint.id,
    purpose: 'run_start',
  });
  expect(storedContext!.response).toEqual(started.data.knowledgeContext);
  expect(servedReceipt).toMatchObject({
    tokenId: sourceTokenId,
    installationId: sourceInstallationId,
    runId: started.data.run.id,
    reportedAt: null,
    reportedManifestHash: null,
  });
  expect(servedReceipt!.servedAt).toBeInstanceOf(Date);
  expect(started.data.knowledgeContext.evidence).toEqual({
    servedAt: servedReceipt!.servedAt.toISOString(),
    clientReportedAt: null,
    compliance: null,
  });
  let evidence = await evidenceForRun(srv.db, started.data.run.id, ownerId);
  if ('error' in evidence) throw new Error(evidence.error);
  expect(evidence.knowledge).toMatchObject({
    contextId,
    clientReportedAt: null,
    matches: null,
    stale: false,
    compliance: null,
  });
  expect(evidence.checks.find((check) => check.key === 'knowledge')).toMatchObject({
    state: 'unknown',
    source: 'client_report',
  });

  const reported = await rest(
    sourceToken,
    `/api/agent/knowledge/contexts/${contextId}/receipt`,
    { manifestHash: started.data.knowledgeContext.manifestHash },
  );
  expect(reported.response.status).toBe(200);
  expect(reported.data).toMatchObject({
    contextId,
    matches: true,
    compliance: null,
    provenance: 'client_report',
  });
  const [clientReceipt] = await srv.db
    .select()
    .from(knowledgeReceipts)
    .where(eq(knowledgeReceipts.contextId, contextId));
  expect(clientReceipt!.servedAt.toISOString()).toBe(reported.data.servedAt);
  expect(clientReceipt!.reportedAt).toBeInstanceOf(Date);
  expect(clientReceipt!.reportedManifestHash).toBe(
    started.data.knowledgeContext.manifestHash,
  );
  evidence = await evidenceForRun(srv.db, started.data.run.id, ownerId);
  if ('error' in evidence) throw new Error(evidence.error);
  expect(evidence.knowledge).toMatchObject({ matches: true, stale: false, compliance: null });
  expect(evidence.checks.find((check) => check.key === 'knowledge')).toMatchObject({ state: 'ok' });
  const reportReplay = await rest(
    sourceToken,
    `/api/agent/knowledge/contexts/${contextId}/receipt`,
    { manifestHash: started.data.knowledgeContext.manifestHash },
  );
  expect(reportReplay.response.status).toBe(200);
  expect(reportReplay.data).toMatchObject({
    matches: true,
    replayed: true,
    clientReportedAt: reported.data.clientReportedAt,
  });

  const handoffCheckpoint = checkpoint('tested', SHA.handoffTested);
  const heartbeat = await rest(
    sourceToken,
    `/api/agent/runs/${started.data.run.id}/heartbeat`,
    { checkpoint: handoffCheckpoint },
  );
  expect(heartbeat.response.status).toBe(200);
  const checkpointId = heartbeat.data.checkpoint.checkpoint.id as string;

  const handed = await call(sourceToken, 'handoff_work', {
    request_id: randomUUID(),
    run_id: started.data.run.id,
    branch: 'feat/checkpoint-knowledge',
    summary: 'Checkpoint and Knowledge context are ready for the next enrolled agent.',
    next_steps: ['Re-read the current Knowledge context before changing the repository.'],
    reason: 'end_of_day',
  });
  expect(handed.isError, handed.text).toBe(false);
  expect(handed.data.checkpoint).toMatchObject({
    id: checkpointId,
    kind: 'tested',
    repositoryIdentity: REPOSITORY,
    commitSha: SHA.handoffTested,
  });
  expect(handed.data.knowledgeContext).toMatchObject({ id: contextId });

  const [offer] = await srv.db
    .select()
    .from(handoffs)
    .where(eq(handoffs.sessionId, handed.data.sessionId));
  expect(offer).toMatchObject({
    checkpointId,
    knowledgeContextId: contextId,
    state: 'offered',
  });
  const thread = await call(receiverToken, 'get_session', {
    session_id: handed.data.sessionId,
  });
  expect(thread.isError, thread.text).toBe(false);
  const handoffMessage = thread.data.messages.find(
    (message: any) => message.kind === 'handoff',
  );
  expect(handoffMessage.resume).toMatchObject({
    checkpoint: { id: checkpointId, commitSha: SHA.handoffTested },
    knowledgeContext: { id: contextId },
    reclaim: {
      arguments: { repository_identity: REPOSITORY },
    },
  });

  const secondKnowledge = await publishVersion(
    'kh3-resume-marker version two: the current procedure changed after handoff.',
    knowledgeV1,
  );
  evidence = await evidenceForRun(srv.db, started.data.run.id, ownerId);
  if ('error' in evidence) throw new Error(evidence.error);
  expect(evidence.knowledge).toMatchObject({ matches: true, stale: true, compliance: null });
  expect(evidence.checks.find((check) => check.key === 'knowledge')).toMatchObject({
    state: 'attention',
  });
  const accepted = await call(receiverToken, 'update_handoff', {
    session_id: handed.data.sessionId,
    action: 'accept',
  });
  expect(accepted.isError, accepted.text).toBe(false);
  expect(accepted.data.handoff).toMatchObject({
    state: 'accepted',
    installationId: receiverInstallationId,
  });
  const receivingStarted = await call(receiverToken, 'start_run', {
    request_id: randomUUID(),
    team: TEAM,
    project: PROJECT,
    repository_identity: REPOSITORY,
    task: 'KH3-RECEIVE',
    intent: 'Resume the Knowledge-linked handoff from its exact checkpoint.',
    checkpoint: {
      request_id: randomUUID(),
      kind: 'start',
      repository_identity: REPOSITORY,
      commit_sha: SHA.handoffTested,
      worktree_clean: true,
      tests: [],
    },
  });
  expect(receivingStarted.isError, receivingStarted.text).toBe(false);
  const receivingRunId = receivingStarted.data.runId as string;
  const receivingCheckpointId = receivingStarted.data.checkpoint.checkpoint.id as string;

  // A run that began on some other commit. A moved HEAD is provable from where the
  // receiving run began (see the topology suite); this one began elsewhere, so an
  // observed commit that does not match is still refused.
  const elsewhere = await call(receiverToken, 'start_run', {
    request_id: randomUUID(),
    team: TEAM,
    project: PROJECT,
    repository_identity: REPOSITORY,
    task: 'KH3-ELSEWHERE',
    intent: 'A run that did not begin on the handed-over commit.',
    checkpoint: {
      request_id: randomUUID(),
      kind: 'start',
      repository_identity: REPOSITORY,
      commit_sha: '9'.repeat(40),
      worktree_clean: true,
      tests: [],
    },
  });
  expect(elsewhere.isError, elsewhere.text).toBe(false);
  const refusedReports = [
    await call(receiverToken, 'update_handoff', {
      session_id: handed.data.sessionId,
      action: 'resume',
      run_id: receivingRunId,
    }),
    await call(receiverToken, 'update_handoff', {
      session_id: handed.data.sessionId,
      action: 'resume',
      run_id: receivingRunId,
      repository_identity: 'github.com/other/payments-api',
      commit_sha: SHA.handoffTested,
      worktree_clean: true,
    }),
    await call(receiverToken, 'update_handoff', {
      session_id: handed.data.sessionId,
      action: 'resume',
      run_id: elsewhere.data.runId,
      repository_identity: REPOSITORY,
      commit_sha: 'f'.repeat(40),
      worktree_clean: true,
    }),
    await call(receiverToken, 'update_handoff', {
      session_id: handed.data.sessionId,
      action: 'resume',
      run_id: receivingRunId,
      repository_identity: REPOSITORY,
      commit_sha: SHA.handoffTested,
      worktree_clean: false,
    }),
  ];
  expect(refusedReports.every((result) => result.isError)).toBe(true);
  expect(refusedReports.map((result) => result.text).join('\n')).toContain(
    'Report repository_identity',
  );
  expect(refusedReports.map((result) => result.text).join('\n')).toContain(
    'repository mismatch',
  );
  expect(refusedReports.map((result) => result.text).join('\n')).toContain('commit mismatch');
  expect((await call(receiverToken, 'finish_run', { run_id: elsewhere.data.runId })).isError).toBe(false);
  expect(refusedReports.map((result) => result.text).join('\n')).toContain('clean checkout');
  // Two of the three fields is what real agents send. Where code arrived it is
  // still refused, and the refusal names the field that was missing.
  const partialReport = await call(receiverToken, 'update_handoff', {
    session_id: handed.data.sessionId,
    action: 'resume',
    run_id: receivingRunId,
    repository_identity: REPOSITORY,
    worktree_clean: true,
  });
  expect(partialReport.isError).toBe(true);
  expect(partialReport.text).toContain('Report repository_identity, commit_sha and worktree_clean before resuming');
  expect(partialReport.text).toContain('commit_sha was missing');
  expect(partialReport.text).toContain('git rev-parse HEAD');
  const noReceivingRun = await call(receiverToken, 'update_handoff', {
    session_id: handed.data.sessionId,
    action: 'resume',
    repository_identity: REPOSITORY,
    commit_sha: SHA.handoffTested,
    worktree_clean: true,
  });
  expect(noReceivingRun.isError).toBe(true);
  expect(noReceivingRun.text).toContain('receiving run');
  const wrongInstallationRun = await call(receiverToken, 'update_handoff', {
    session_id: handed.data.sessionId,
    action: 'resume',
    run_id: started.data.run.id,
    repository_identity: REPOSITORY,
    commit_sha: SHA.handoffTested,
    worktree_clean: true,
  });
  expect(wrongInstallationRun.isError).toBe(true);
  expect(wrongInstallationRun.text).toContain('owned by this installation');
  expect(
    (
      await srv.db
        .select({ state: handoffs.state })
        .from(handoffs)
        .where(eq(handoffs.id, offer!.id))
    )[0]?.state,
  ).toBe('accepted');

  const resumed = await call(receiverToken, 'update_handoff', {
    session_id: handed.data.sessionId,
    action: 'resume',
    run_id: receivingRunId,
    repository_identity: REPOSITORY,
    commit_sha: SHA.handoffTested,
    worktree_clean: true,
  });
  expect(resumed.isError, resumed.text).toBe(false);
  expect(resumed.data.verification).toEqual({
    verified: true,
    checkpointId,
    repositoryIdentity: REPOSITORY,
    commitSha: SHA.handoffTested,
    basis: 'observed_checkout',
  });
  expect(resumed.data.knowledgeUpdate).toMatchObject({
    changed: true,
    previous: { id: contextId },
    current: {
      evidence: { clientReportedAt: null, compliance: null },
      manifest: {
        versions: [{ itemId: knowledgeItemId, versionId: secondKnowledge.versionId }],
      },
    },
  });
  expect(resumed.data.knowledgeUpdate.current.manifest.versions).not.toContainEqual(
    expect.objectContaining({ versionId: knowledgeV1 }),
  );
  await srv.db
    .update(agentRuns)
    .set({ status: 'completed', endedAt: new Date() })
    .where(eq(agentRuns.id, receivingRunId));
  const resumeReplay = await call(receiverToken, 'update_handoff', {
    session_id: handed.data.sessionId,
    action: 'resume',
    run_id: receivingRunId,
    repository_identity: REPOSITORY,
    commit_sha: SHA.handoffTested,
    worktree_clean: true,
  });
  expect(resumeReplay.isError, resumeReplay.text).toBe(false);
  expect(resumeReplay.data.knowledgeUpdate).toEqual(resumed.data.knowledgeUpdate);
  const [receiverContext] = await srv.db
    .select()
    .from(knowledgeContexts)
    .where(eq(knowledgeContexts.id, resumed.data.knowledgeUpdate.current.contextId));
  expect(receiverContext).toMatchObject({
    runId: receivingRunId,
    checkpointId: receivingCheckpointId,
    purpose: 'handoff_resume',
  });
  expect(
    (
      await srv.db
        .select({
          state: handoffs.state,
          resumedKnowledgeContextId: handoffs.resumedKnowledgeContextId,
        })
        .from(handoffs)
        .where(eq(handoffs.id, offer!.id))
    )[0],
  ).toEqual({
    state: 'in_progress',
    resumedKnowledgeContextId: resumed.data.knowledgeUpdate.current.contextId,
  });

  const mismatchContext = await getKnowledgeContext(srv.db, ownerId, {
    team: TEAM,
    project: PROJECT,
    query: 'kh3-resume-marker',
    maxItems: 2,
    runId: started.data.run.id,
    checkpointId,
  });
  if ('error' in mismatchContext) throw new Error(mismatchContext.error);
  const mismatch = await reportKnowledgeReceipt(srv.db, ownerId, {
    contextId: mismatchContext.contextId,
    manifestHash: '0'.repeat(64),
  });
  expect(mismatch).toMatchObject({ status: 409, matches: false });
  evidence = await evidenceForRun(srv.db, started.data.run.id, ownerId);
  if ('error' in evidence) throw new Error(evidence.error);
  expect(evidence.knowledge).toMatchObject({ matches: false, compliance: null });
  expect(evidence.checks.find((check) => check.key === 'knowledge')).toMatchObject({
    state: 'attention',
  });
});
