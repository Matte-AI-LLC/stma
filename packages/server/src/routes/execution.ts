import { executionClaimSchema, executionConfigureSchema, executionEventSchema, executionLeaseSchema, type ExecutionResult } from '@bridge/shared';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z } from 'zod/v3';
import { mcpAuth } from '../auth/pat';
import { claimExecution, configureExecutionTarget, heartbeatExecution, listExecutionTargets, reportExecutionEvent, setExecutionTargetEnabled } from '../domain/execution';
import { agentPrincipal } from '../domain/workTypes';
import type { AppEnv } from '../types';

export const executionRoutes = new Hono<AppEnv>();
const authenticated: MiddlewareHandler<AppEnv> = async (c, next) => c.get('mcpGrant') ? next() : mcpAuth(c, next);
executionRoutes.use('/api/agent/worker/*', authenticated);
function reply<T>(c: Context<AppEnv>, value: ExecutionResult<T>) {
  c.header('Cache-Control', 'no-store');
  if (value && typeof value === 'object' && 'error' in value) {
    const error = (value as { error: { code: string } }).error;
    return c.json(value as object, error.code === 'NOT_FOUND' ? 404 : error.code === 'INVALID_INPUT' ? 400 : ['FORBIDDEN', 'NEEDS_AUTH', 'REVOKED'].includes(error.code) ? 403 : 409);
  }
  return c.json(value as object);
}
executionRoutes.post('/api/agent/worker/configure', async c => {
  const parsed = executionConfigureSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'INVALID_INPUT', message: 'Invalid worker configuration.', retryable: false } }, 400);
  return reply(c, await configureExecutionTarget(c.get('db'), c.get('mcpUser').id, c.get('mcpGrant'), parsed.data));
});
executionRoutes.get('/api/agent/worker/status', async c => {
  const grant = c.get('mcpGrant');
  const found = await listExecutionTargets(c.get('db'), agentPrincipal(c.get('mcpUser').id, grant), grant.projectId ?? undefined);
  if ('error' in found) return reply(c, found);
  return reply(c, { targets: found.targets.filter(t => t.installation_id === grant.installationId) });
});
executionRoutes.post('/api/agent/worker/claim', async c => {
  const parsed = executionClaimSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'INVALID_INPUT', message: 'Invalid worker identity.', retryable: false } }, 400);
  return reply(c, await claimExecution(c.get('db'), c.get('mcpUser').id, c.get('mcpGrant'), parsed.data));
});
executionRoutes.post('/api/agent/worker/heartbeat', async c => {
  const parsed = executionLeaseSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'INVALID_INPUT', message: 'Invalid attempt lease.', retryable: false } }, 400);
  return reply(c, await heartbeatExecution(c.get('db'), c.get('mcpUser').id, c.get('mcpGrant'), parsed.data));
});
executionRoutes.post('/api/agent/worker/event', async c => {
  const parsed = executionEventSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'INVALID_INPUT', message: 'Invalid worker event.', retryable: false } }, 400);
  return reply(c, await reportExecutionEvent(c.get('db'), c.get('mcpUser').id, c.get('mcpGrant'), parsed.data));
});
executionRoutes.post('/api/agent/worker/disable', async c => {
  const parsed = z.object({ target_id: z.string().uuid() }).strict().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'INVALID_INPUT', message: 'Name one execution target.', retryable: false } }, 400);
  return reply(c, await setExecutionTargetEnabled(c.get('db'), agentPrincipal(c.get('mcpUser').id, c.get('mcpGrant')), parsed.data.target_id, false));
});
