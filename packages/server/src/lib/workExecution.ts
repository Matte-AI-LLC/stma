import type { ExecutionJobDto } from '@bridge/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { executionJobs, executionTargets } from '../db/schema';
import { getExecution, type ExecutionConsoleDetail } from '../domain/execution';
import { humanPrincipal } from '../domain/workTypes';
import { isCanonicalUuid } from './ids';

export const WORK_EXECUTION_LIMIT = 5;

export interface WorkExecutionRow {
  id: string;
  sessionId: string;
  specRevision: number | null;
  state: ExecutionJobDto['state'];
  target: string;
  runtime: string;
  lastWorkerContact: string | null;
  attemptId: string | null;
  runId: string | null;
  observedStartAt: string | null;
  workerReportedStopped: boolean;
  capacityReconciliation: ExecutionConsoleDetail['capacityReconciliation'];
  checkoutQuarantined: boolean;
  queuedAt: string;
  lastEvent: { reason: string; at: string } | null;
  canCancel: boolean;
}

/** Bounded browser view. The work/project filter narrows candidates; getExecution authorizes each one. */
export async function workExecutions(
  db: Db,
  userId: string,
  scope: { teamId: string; projectId: string; workId: string },
  selectedJobId?: string,
): Promise<{ rows: WorkExecutionRow[]; more: boolean }> {
  // A worker can commit between the job, attempt and event reads. Keep the
  // displayed history internally consistent without blocking those reports.
  return db.transaction(
    tx => readWorkExecutions(tx as unknown as Db, userId, scope, selectedJobId),
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

async function readWorkExecutions(
  db: Db,
  userId: string,
  scope: { teamId: string; projectId: string; workId: string },
  selectedJobId?: string,
): Promise<{ rows: WorkExecutionRow[]; more: boolean }> {
  const selected = isCanonicalUuid(selectedJobId) ? selectedJobId.toLowerCase() : null;
  const candidates = await db.select({ id: executionJobs.id }).from(executionJobs)
    .innerJoin(executionTargets, eq(executionTargets.id, executionJobs.targetId))
    .where(and(eq(executionJobs.workId, scope.workId), eq(executionTargets.projectId, scope.projectId),
      eq(executionTargets.teamId, scope.teamId)))
    .orderBy(sql`${executionJobs.id} = ${selected}::uuid desc nulls last`, desc(executionJobs.createdAt), desc(executionJobs.id))
    .limit(WORK_EXECUTION_LIMIT + 1);

  const rows: WorkExecutionRow[] = [];
  for (const candidate of candidates) {
    const detail = await getExecution(db, humanPrincipal(userId), candidate.id);
    if ('error' in detail || detail.job.work_id !== scope.workId || detail.target.project_id !== scope.projectId ||
        detail.target.team_id !== scope.teamId) continue;
    const last = detail.events[0];
    rows.push({
      id: detail.job.id,
      sessionId: detail.job.session_id,
      specRevision: detail.job.spec_revision,
      state: detail.job.state,
      target: detail.target.installation_name,
      runtime: detail.target.runtime,
      lastWorkerContact: detail.target.last_seen,
      attemptId: detail.attempt?.id ?? null,
      runId: detail.attempt?.run_id ?? null,
      observedStartAt: detail.events.find((event) => event.state === 'running' && event.reason === 'session_observed')?.created_at ?? null,
      workerReportedStopped: detail.attempt?.process_stopped === true,
      capacityReconciliation: detail.capacityReconciliation,
      checkoutQuarantined: detail.target.quarantined,
      queuedAt: detail.job.created_at,
      lastEvent: last ? { reason: last.reason, at: last.created_at } : null,
      canCancel: detail.can_cancel && ['queued', 'leased', 'starting', 'running'].includes(detail.job.state),
    });
  }
  return { rows: rows.slice(0, WORK_EXECUTION_LIMIT), more: rows.length > WORK_EXECUTION_LIMIT };
}
