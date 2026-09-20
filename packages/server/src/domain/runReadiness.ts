import {
  approvalsNeeded,
  budgetVerdict,
  flowAdvice,
  type WorkClaim,
} from '@bridge/shared';
import type { Db } from '../db';
import type { agentRuns } from '../db/schema';
import { activeFlowFor, parseFlowDocument } from './delivery';
import { addAgentEvent, duplicateWork } from './agents';
import { effectivePolicy, recordPolicyReceipt } from './policies';

type Run = typeof agentRuns.$inferSelect;

/**
 * One transport-neutral answer for the risks visible at run start.
 *
 * Claims remain advisory: this result explains what the team decided and what
 * overlaps, but it does not pretend the server can stop a local editor. MCP,
 * control/CLI and native hooks all consume this same shape.
 */
export async function runStartReadiness(
  db: Db,
  userId: string,
  input: {
    run: Run;
    team: string;
    project?: string;
    claims: WorkClaim[];
    replayed: boolean;
  },
) {
  const policyResult = await effectivePolicy(db, userId, {
    team: input.team,
    project: input.project,
    projectId: input.run.projectId,
  });
  const policy = 'error' in policyResult ? null : policyResult;
  const approvals = policy ? approvalsNeeded(policy.document, input.claims) : [];
  const budget = policy ? budgetVerdict(policy.document, input.claims) : { over: [] };
  const duplicates = await duplicateWork(db, userId, input.run, {
    taskKey: input.run.taskKey,
    intent: input.run.intent,
  });
  if (!input.replayed && duplicates.length > 0) {
    await addAgentEvent(db, input.run.id, 'duplicates_detected', {
      count: duplicates.length,
      taskKey: input.run.taskKey,
      others: duplicates.slice(0, 3).map((duplicate) => duplicate.owner),
    });
  }
  if (!input.replayed && policy) {
    await recordPolicyReceipt(db, userId, input.run.id, policy.hash);
  }
  const flow = await activeFlowFor(db, input.run.teamId, input.project);
  const flowWarnings = flow
    ? flowAdvice(parseFlowDocument(flow.flow.document), {
        taskKey: input.run.taskKey ?? undefined,
        branch: input.run.branch ?? undefined,
      })
    : [];
  return {
    advisory: true as const,
    enforcement:
      'STMA records and reports this result. Local writes stop only when the connected client and its human act on it.',
    policy,
    policyError: 'error' in policyResult ? policyResult.error : null,
    approvals,
    budget,
    duplicates,
    flow,
    flowWarnings,
  };
}
