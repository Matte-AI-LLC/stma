import { executionDispatchSchema, type ExecutionJobDto } from '@bridge/shared';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq } from 'drizzle-orm';
import { z } from 'zod/v3';
import type { Db } from '../db';
import { teams } from '../db/schema';
import { cancelExecution, dispatchExecution, getExecution, listExecutionTargets } from '../domain/execution';
import { agentPrincipal } from '../domain/workTypes';
import type { AgentGrant } from '../lib/grants';
import type { Env } from '../env';
import type { User } from '../types';
import { chargeTeamDay } from './shared';

const reply = (value: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

/** Worker claims carry the brief. Status reads carry only bounded coordination metadata. */
function jobSummary(job: ExecutionJobDto) {
  return {
    execution_id: job.id,
    target_id: job.target_id,
    session_id: job.session_id,
    state: job.state,
    work_id: job.work_id,
    spec_revision: job.spec_revision,
    max_runtime_seconds: job.max_runtime_seconds,
    max_turns: job.max_turns,
    created_at: job.created_at,
  };
}

/** Plain tools and status polling work without optional MCP Tasks or Channels. */
export function registerExecutionTools(server: McpServer, db: Db, user: User, grant: AgentGrant, env: Env) {
  const principal = agentPrincipal(user.id, grant);
  async function chargeVisible(teamIds: string[]) {
    for (const id of new Set(teamIds)) {
      const [team] = await db.select().from(teams).where(eq(teams.id, id));
      if (!team) continue;
      const denied = await chargeTeamDay(db, team, env.hosted);
      if (denied) return { error: { code: 'LIMIT_EXCEEDED', message: denied.error, retryable: false } };
    }
    return null;
  }
  server.registerTool('list_execution_targets', {
    title: 'List execution targets',
    description: 'Returns up to 50 visible managed execution targets and their worker readiness. The optional project_id narrows the list. This metadata read does not start a model. An enabled target still needs a live local worker; an offline machine keeps its jobs queued.',
    inputSchema: { project_id: z.string().uuid().optional() },
  }, async ({ project_id }) => {
    const result = await listExecutionTargets(db, principal, project_id);
    if ('error' in result) return reply(result, true);
    const allowance = await chargeVisible(result.targets.slice(0, 50).map((target) => target.team_id));
    if (allowance) return reply(allowance, true);
    return reply({
      targets: result.targets.slice(0, 50).map((target) => ({
        target_id: target.id,
        agent: target.installation_name,
        project_id: target.project_id,
        runtime: target.runtime,
        permission_profile: target.permission_profile,
        readiness: target.readiness,
        reason: target.reason,
        max_runtime_seconds: target.max_runtime_seconds,
        max_turns: target.max_turns,
        last_seen: target.last_seen,
      })),
      truncated: result.targets.length > 50,
      as_of: new Date().toISOString(),
    });
  });
  server.registerTool('dispatch_work', {
    title: 'Dispatch assigned work',
    description: 'Returns a queued execution for an existing assignment session and an explicitly enabled target. The local worker may start Claude and consume the configured API account usage. Repeating the same request_id and payload returns the same job. Assignment alone does not start execution; a queued job is not evidence that a process started.',
    inputSchema: executionDispatchSchema.shape,
  }, async (input) => {
    const result = await dispatchExecution(db, principal, input);
    return 'error' in result ? reply(result, true) : reply({ ...jobSummary(result.job), replayed: result.replayed });
  });
  server.registerTool('get_execution', {
    title: 'Get execution status',
    description: 'Returns one execution state, its current attempt and run link, and optionally its five most recent event summaries. Status reads do not start a model. Runtime completion is worker-reported and is separate from delivery evidence and human acceptance; cancel_requested does not mean the process has stopped.',
    inputSchema: {
      execution_id: z.string().uuid(),
      include_events: z.boolean().optional(),
    },
  }, async ({ execution_id, include_events }) => {
    const result = await getExecution(db, principal, execution_id);
    if ('error' in result) return reply(result, true);
    const allowance = await chargeVisible([result.target.team_id]);
    if (allowance) return reply(allowance, true);
    return reply({
      ...jobSummary(result.job),
      target_readiness: result.target.readiness,
      target_reason: result.target.reason,
      attempt: result.attempt,
      ...(include_events ? { events: result.events.slice(0, 5).map(({ detail: _detail, ...event }) => event) } : {}),
      result_provenance: result.result_provenance,
      acceptance: result.acceptance,
      as_of: new Date().toISOString(),
    });
  });
  server.registerTool('cancel_execution', {
    title: 'Request execution cancellation',
    description: 'Returns the execution state after requesting cancellation and revoking its child grant. The worker handles local stopping; the request itself is not proof that a process stopped. Ambiguous or uncontained stops leave the checkout quarantined. Repeated cancellation is safe and does not start a model.',
    inputSchema: { execution_id: z.string().uuid() },
  }, async ({ execution_id }) => {
    const result = await cancelExecution(db, principal, execution_id);
    return 'error' in result ? reply(result, true) : reply(jobSummary(result.job));
  });
}

export const EXECUTION_TOOL_PARAMS: Record<string, readonly string[]> = {
  list_execution_targets: ['project_id'],
  dispatch_work: ['target_id', 'session_id', 'request_id'],
  get_execution: ['execution_id', 'include_events'],
  cancel_execution: ['execution_id'],
};
