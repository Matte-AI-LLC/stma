import { AsyncLocalStorage } from 'node:async_hooks';
import { EXECUTION_CHILD_TOOLS } from '@bridge/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db';
import { executionAttemptGrants, executionAttempts, executionJobs, executionTargets, knowledgeContexts, runCheckpoints, workDeliveries, workItems, workProjectCounters } from '../db/schema';
import { executionAuthority, executionRefuse, ExecutionRefusal, lockExecutionTarget, type ExecutionAttemptRow, type ExecutionJobRow, type ExecutionTargetRow } from '../domain/execution';
import type { AgentGrant } from './grants';
import { isCanonicalUuid } from './ids';

export interface ExecutionGrant {
  targetId: string; jobId: string; attemptId: string; fence: number; grantVersion: number;
  grantId: string; sessionId: string; workId: string | null; specRevision: number | null;
}
const request = new AsyncLocalStorage<{ grant: AgentGrant; bound?: { target: ExecutionTargetRow; job: ExecutionJobRow; attempt: ExecutionAttemptRow } }>();
export const currentExecutionGrant = () => request.getStore()?.grant;
export const currentExecutionBinding = () => request.getStore()?.bound;

export async function resolveExecutionCredential(db: Db, hash: string) {
  const [row] = await db.select({ secret: executionAttemptGrants, attempt: executionAttempts, job: executionJobs, target: executionTargets })
    .from(executionAttemptGrants).innerJoin(executionAttempts, eq(executionAttempts.id, executionAttemptGrants.attemptId))
    .innerJoin(executionJobs, eq(executionJobs.id, executionAttempts.jobId)).innerJoin(executionTargets, eq(executionTargets.id, executionJobs.targetId))
    .where(eq(executionAttemptGrants.tokenHash, hash));
  if (!row || row.secret.revokedAt || row.secret.expiresAt <= new Date()) return null;
  const execution: ExecutionGrant = { targetId: row.target.id, jobId: row.job.id, attemptId: row.attempt.id, fence: row.attempt.fence,
    grantVersion: row.job.grantVersion, grantId: row.secret.id, sessionId: row.job.sessionId, workId: row.job.workId, specRevision: row.job.specRevision };
  return { parentTokenId: row.secret.parentTokenId, execution };
}
export async function validateExecutionGrant(db: Db, grant: AgentGrant) {
  const e = grant.execution;
  if (!e) executionRefuse('ATTEMPT_REQUIRED', 'Managed execution needs an attempt credential.');
  const target = await lockExecutionTarget(db, e!.targetId);
  const [job] = await db.select().from(executionJobs).where(eq(executionJobs.id, e!.jobId)).for('no key update');
  const [attempt] = await db.select().from(executionAttempts).where(eq(executionAttempts.id, e!.attemptId)).for('no key update');
  const [secret] = await db.select().from(executionAttemptGrants).where(eq(executionAttemptGrants.id, e!.grantId));
  if (!job || !attempt || !secret || secret.revokedAt || secret.expiresAt <= new Date() || attempt.leaseExpiresAt <= new Date() || attempt.deadlineAt <= new Date() ||
      attempt.jobId !== job.id || job.targetId !== target.id || attempt.fence !== e!.fence || job.grantVersion !== e!.grantVersion ||
      secret.parentTokenId !== grant.tokenId || target.installationId !== grant.installationId || !['leased','starting','running'].includes(job.state)) {
    executionRefuse('STALE_ATTEMPT', 'The execution lease or attempt credential is no longer current. Stop this managed session.');
  }
  await executionAuthority(db, target, job!);
  return { target, job: job!, attempt: attempt! };
}
/** Fence spans the complete request, including the existing domain transaction/savepoint. */
export async function withExecutionRequest<T>(db: Db, grant: AgentGrant, fn: (db: Db) => Promise<T>): Promise<T> {
  if (!grant.execution) return request.run({ grant }, () => fn(db));
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const bound = await validateExecutionGrant(tx, grant);
    const value = await request.run({ grant, bound }, () => fn(tx));
    // Final locks: a contract mutation cannot cross the last authorization read
    // and commit. Nothing below takes a non-Work row lock.
    if (bound.job.workId) {
      await tx.select().from(workProjectCounters).where(eq(workProjectCounters.projectId, bound.target.projectId)).for('update');
      await tx.select().from(workItems).where(eq(workItems.id, bound.job.workId)).for('update');
    }
    // An unusually long request must not commit authority after its deadline.
    const [secret] = await tx.select().from(executionAttemptGrants).where(eq(executionAttemptGrants.id, grant.execution!.grantId));
    if (!secret || secret.revokedAt || secret.expiresAt <= new Date()) executionRefuse('STALE_ATTEMPT', 'The attempt expired before this request completed.');
    await executionAuthority(tx, bound.target, bound.job);
    return value;
  });
}

const CHILD_TOOLS = new Set<string>(EXECUTION_CHILD_TOOLS);
const MUTATIONS = new Set(['start_run','update_run','finish_run','update_handoff','post_message','record_delivery_receipt','submit_work','record_work_evidence','update_work',
  'handoff_work','resolve_session','push_snapshot','report_knowledge_receipt','check_environment']);
const refusal = 'This operation needs the current attempt credential for this managed run or assignment.';

async function guardAttemptEvidence(db: Db, grant: AgentGrant, tool: string, body: Record<string, unknown>): Promise<string | null> {
  if (tool === 'submit_work') {
    if (grant.execution && typeof body.run_id !== 'string') return 'A managed delivery must name this attempt’s bound run.';
    if (typeof body.run_id === 'string') {
      const denied = await managedResourceRefusal(db, grant, { runId: body.run_id });
      if (denied) return denied;
    }
    if (Array.isArray(body.artifacts)) for (const artifact of body.artifacts) {
      if (!artifact || typeof artifact !== 'object' || typeof artifact.checkpoint_id !== 'string') continue;
      if (!isCanonicalUuid(artifact.checkpoint_id)) return 'A checkpoint id must be a canonical STMA UUID.';
      const [checkpoint] = await db.select({ runId: runCheckpoints.runId }).from(runCheckpoints).where(eq(runCheckpoints.id, artifact.checkpoint_id));
      if (checkpoint) { const denied = await managedResourceRefusal(db, grant, { runId: checkpoint.runId }); if (denied) return denied; }
      else if (grant.execution) return 'A managed delivery checkpoint must belong to this attempt’s run.';
    }
  }
  if (tool === 'record_work_evidence' && grant.execution) {
    if (!isCanonicalUuid(body.delivery_id)) return 'Name the delivery produced by this attempt.';
    const [delivery] = await db.select({ runId: workDeliveries.runId, workId: workDeliveries.workId }).from(workDeliveries).where(eq(workDeliveries.id, body.delivery_id));
    if (!delivery?.runId || delivery.workId !== grant.execution.workId) return 'This attempt can report only on its own delivery.';
    return managedResourceRefusal(db, grant, { runId: delivery.runId });
  }
  return null;
}

export async function managedResourceRefusal(db: Db, grant: AgentGrant | undefined, input: { runId?: string; sessionId?: string; installationId?: string }): Promise<string | null> {
  if (Object.values(input).some(value => value !== undefined && !isCanonicalUuid(value))) return 'Resource ids must be canonical STMA UUIDs.';
  if (grant?.execution) {
    const binding = currentExecutionBinding();
    const e = grant.execution;
    let runId = binding?.attempt.runId;
    if (runId === undefined) runId = (await db.select({ runId: executionAttempts.runId }).from(executionAttempts).where(eq(executionAttempts.id, e.attemptId)))[0]?.runId;
    if (input.sessionId !== undefined && input.sessionId !== e.sessionId) return 'This attempt can access only its assigned session.';
    if (input.runId !== undefined && input.runId !== runId) return 'This attempt can access only its own bound run.';
    if (input.installationId !== undefined && input.installationId !== grant.installationId) return refusal;
    return null;
  }
  if (input.installationId) {
    const [target] = await db.select({ id: executionTargets.id }).from(executionTargets).where(eq(executionTargets.installationId, input.installationId));
    if (target) return refusal;
  }
  if (input.runId) {
    const [attempt] = await db.select({ id: executionAttempts.id }).from(executionAttempts).where(eq(executionAttempts.runId, input.runId));
    if (attempt) return refusal;
  }
  if (input.sessionId) {
    const [job] = await db.select({ id: executionJobs.id }).from(executionJobs).where(eq(executionJobs.sessionId, input.sessionId)).limit(1);
    if (job) return refusal;
  }
  return null;
}
export async function guardExecutionTool(db: Db, grant: AgentGrant, tool: string, args: Record<string, unknown>) {
  const evidenceDenied = await guardAttemptEvidence(db, grant, tool, args);
  if (evidenceDenied) return evidenceDenied;
  if (tool === 'report_knowledge_receipt' && !grant.execution && isCanonicalUuid(args.context_id)) {
    const [context] = await db.select({ runId: knowledgeContexts.runId }).from(knowledgeContexts).where(eq(knowledgeContexts.id, args.context_id));
    if (context?.runId) { const denied = await managedResourceRefusal(db, grant, { runId: context.runId }); if (denied) return denied; }
  }
  if (!grant.execution) {
    if (!MUTATIONS.has(tool)) return null;
    return managedResourceRefusal(db, grant, { runId: typeof args.run_id === 'string' ? args.run_id : undefined,
      sessionId: typeof args.session_id === 'string' ? args.session_id : undefined });
  }
  if (!CHILD_TOOLS.has(tool)) return 'This tool is outside the execution attempt capability.';
  if (args.checkpoint_id !== undefined) {
    if (!isCanonicalUuid(args.checkpoint_id)) return 'Name a checkpoint from this attempt’s bound run.';
    const [checkpoint] = await db.select({ runId: runCheckpoints.runId }).from(runCheckpoints).where(eq(runCheckpoints.id, args.checkpoint_id));
    if (!checkpoint) return 'Name a checkpoint from this attempt’s bound run.';
    const denied = await managedResourceRefusal(db, grant, { runId: checkpoint.runId });
    if (denied) return denied;
  }
  if (tool === 'update_work' && !['set_blocker','resolve_blocker'].includes(String(args.operation))) return 'A managed attempt may report blockers, not change a work contract.';
  const e = grant.execution;
  if (args.work_id !== undefined && args.work_id !== e.workId) return 'This attempt can access only its pinned work item.';
  if (['get_work','get_work_context','submit_work','record_work_evidence','update_work'].includes(tool) && (!e.workId || args.work_id !== e.workId)) return 'Name this attempt’s pinned work id.';
  if (['get_session','post_message','update_handoff','record_delivery_receipt'].includes(tool) && args.session_id !== e.sessionId) return 'Name this attempt’s assigned session id.';
  if (tool === 'update_handoff' && !['accept','resume','complete','needs_attention'].includes(String(args.action))) return 'A managed attempt cannot reassign or cancel work.';
  if (tool === 'update_handoff') {
    const runId = currentExecutionBinding()?.attempt.runId;
    if (!runId) return 'Start this attempt’s run before accepting or updating its assignment.';
    if (args.run_id === undefined) args.run_id = runId;
  }
  if (tool === 'start_run') {
    if (args.issue !== undefined || args.clickup_task !== undefined) return 'Managed starts use their assigned task, without provider lookups.';
    if (args.work_id !== undefined && args.work_id !== e.workId) return 'This attempt is pinned to another work item.';
    args.request_id = e.attemptId;
    if (e.workId) { args.work_id = e.workId; args.expected_spec_revision = e.specRevision; }
  }
  if (['update_run','finish_run','get_evidence','check_environment'].includes(tool) && typeof args.run_id !== 'string') return 'Name this attempt’s bound run id.';
  if (tool === 'get_knowledge_context' && args.run_id === undefined) {
    const runId = currentExecutionBinding()?.attempt.runId;
    if (!runId) return 'Start this attempt’s run before reading its Knowledge context.';
    args.run_id = runId;
  }
  if (tool === 'report_knowledge_receipt') {
    if (!isCanonicalUuid(args.context_id)) return 'Name this attempt’s Knowledge context.';
    const [context] = await db.select({ runId: knowledgeContexts.runId }).from(knowledgeContexts).where(eq(knowledgeContexts.id, args.context_id));
    if (!context?.runId) return 'This attempt may acknowledge only its run’s Knowledge context.';
    const denied = await managedResourceRefusal(db, grant, { runId: context.runId });
    if (denied) return denied;
  }
  return managedResourceRefusal(db, grant, { runId: typeof args.run_id === 'string' ? args.run_id : undefined,
    sessionId: typeof args.session_id === 'string' ? args.session_id : undefined });
}
/** One REST gate covers hook mutations and rejects any future route by default. */
export async function guardExecutionHttp(db: Db, grant: AgentGrant, path: string, method: string, body: Record<string, unknown> | null): Promise<string | null> {
  if (!grant.execution) {
    if (grant.installationId) {
      const [target] = await db.select({ id: executionTargets.id }).from(executionTargets).where(eq(executionTargets.installationId, grant.installationId));
      if (target && !path.startsWith('/api/agent/worker/') && path !== '/api/agent/identity' && path !== '/api/agent-enrollments/self-revoke') return 'This dedicated credential is worker-only. Child work requires a short-lived attempt credential.';
    }
    if (method !== 'GET') {
      const runId = /^\/api\/agent\/runs\/([0-9a-f-]{36})\//.exec(path)?.[1];
      if (runId) return managedResourceRefusal(db, grant, { runId });
      if (path === '/api/agent/runs/start' && typeof body?.installationId === 'string') return managedResourceRefusal(db, grant, { installationId: body.installationId });
      if (/^\/api\/agent\/work\/[0-9a-f-]{36}\/deliveries$/.test(path)) return guardAttemptEvidence(db, grant, 'submit_work', body ?? {});
      const receipt = /^\/api\/agent\/knowledge\/contexts\/([0-9a-f-]{36})\/receipt$/.exec(path);
      if (receipt && isCanonicalUuid(receipt[1])) {
        const [context] = await db.select({ runId: knowledgeContexts.runId }).from(knowledgeContexts).where(eq(knowledgeContexts.id, receipt[1]));
        if (context?.runId) return managedResourceRefusal(db, grant, { runId: context.runId });
      }
    }
    return null;
  }
  if (path === '/mcp') return null;
  const e = grant.execution;
  if (path.startsWith('/api/agent/worker/') || path === '/api/agent-enrollments/self-revoke') return 'An attempt cannot operate or revoke its parent worker.';
  if (['/api/agent/identity','/api/agent/runs/start','/api/agent/policies/effective','/api/agent/environment/preflight'].includes(path)) return null;
  const run = /^\/api\/agent\/runs\/([0-9a-f-]{36})\/(heartbeat|finish|write-guard|policy-receipt|policy-violations)$/.exec(path);
  if (run) return managedResourceRefusal(db, grant, { runId: run[1] });
  const work = /^\/api\/agent\/work\/([0-9a-f-]{36})(?:\/(context|deliveries|evidence))?$/.exec(path);
  if (work && work[1] === e.workId && (method === 'GET' || ['deliveries','evidence'].includes(work[2] ?? ''))) {
    if (body?.work_id !== undefined && body.work_id !== e.workId) return 'The body names another work item.';
    if (method !== 'GET') return guardAttemptEvidence(db, grant, work[2] === 'deliveries' ? 'submit_work' : 'record_work_evidence', body ?? {});
    return null;
  }
  const receipt = /^\/api\/agent\/knowledge\/contexts\/([0-9a-f-]{36})\/receipt$/.exec(path);
  if (receipt) {
    const [context] = await db.select({ runId: knowledgeContexts.runId }).from(knowledgeContexts).where(eq(knowledgeContexts.id, receipt[1]!));
    if (context?.runId) return managedResourceRefusal(db, grant, { runId: context.runId });
  }
  return 'This REST operation is outside the execution attempt capability.';
}

/** Bind before the start domain takes Work locks; replays use exactly this run. */
export async function bindExecutionRun(db: Db, runId: string) {
  const state = request.getStore();
  if (!state?.grant.execution || !state.bound) return;
  const attempt = state.bound.attempt;
  if (attempt.runId && attempt.runId !== runId) executionRefuse('SECOND_RUN', 'This attempt already owns a run.');
  await db.update(executionAttempts).set({ runId }).where(and(eq(executionAttempts.id, attempt.id), isNull(executionAttempts.runId)));
  attempt.runId = runId;
}
export { ExecutionRefusal };
