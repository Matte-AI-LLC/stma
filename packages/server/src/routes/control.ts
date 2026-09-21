import { membershipUser } from '../lib/securityHooks';
import {
  finishAgentRunSchema,
  heartbeatAgentRunSchema,
  policyDocumentSchema,
  registerAgentSchema,
  snapshotSchema,
  startAgentRunSchema,
  workClaimSchema,
} from '@bridge/shared';
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod/v3';
import { mcpAuth } from '../auth/pat';
import { agentInstallations, memberships, messages, teams, tokens } from '../db/schema';
import {
  activeRunsForMember,
  claimsForRuns,
  finishAgentRun,
  heartbeatAgentRun,
  registerAgent,
  startAgentRun,
  guardRunWrite,
} from '../domain/agents';
import {
  environmentPreflight,
  preflightSummary,
  recordEnvironmentCheck,
  setEnvironmentBaseline,
} from '../domain/environments';
import { commentOnRunTracker } from '../domain/integrations';
import { effectivePolicy, publishPolicy, recordPolicyReceipt } from '../domain/policies';
import { runStartReadiness } from '../domain/runReadiness';
import { recordPolicyViolation } from '../domain/violations';
import { liveCompanion } from '../domain/companions';
import {
  getOrCreateRunStartKnowledgeContext,
  reportKnowledgeReceipt,
} from '../domain/knowledge';
import { redactSecrets } from '../lib/redact';
import { pendingHandoffs, unreadSessionCount } from '../lib/sessions';
import { track } from '../lib/track';
import {
  guardNamedGrantScope,
  guardRunGrantScope,
} from '../lib/grants';
import type { AppEnv } from '../types';
import { logLine } from '../lib/log';

export const controlRoutes = new Hono<AppEnv>();

controlRoutes.use('/api/agent/*', mcpAuth);
controlRoutes.use('/api/control/*', mcpAuth);

/** Native OAuth adapter identity check; confirms the same one-use setup as MCP whoami. */
controlRoutes.get('/api/agent/identity', async (c) => {
  const grant = c.get('mcpGrant');
  const token = c.get('mcpToken');
  if (!grant.installationId) return c.json({ error: 'installation_required' }, 403);
  if (token?.setupExpiresAt && !token.activatedAt) {
    const activated = await c.get('db').update(tokens).set({ activatedAt: new Date(), lastUsedAt: new Date() })
      .where(and(eq(tokens.id, token.id), isNull(tokens.revokedAt), isNull(tokens.activatedAt), gt(tokens.setupExpiresAt, new Date())))
      .returning({ id: tokens.id });
    if (!activated.length) return c.json({ error: 'setup_expired' }, 403);
    logLine({ evt: 'agent_enrollment', a: 'client_confirmed', installation: grant.installationId, source: 'native_adapter' });
  }
  // The pairing chosen at consent, read back so the CLI can print it: a link
  // the owner cannot see in the terminal that created it is not an explicit one.
  const companion = await liveCompanion(c.get('db'), c.get('mcpUser').id, grant.companionInstallationId);
  c.header('Cache-Control', 'no-store');
  return c.json({ credential: {
    scope: grant.scope, team: grant.teamSlug, project: grant.projectName,
    installationId: grant.installationId, installationName: grant.installationName,
    device: grant.deviceLabel,
    companion: companion
      ? { installationId: companion.installationId, agent: companion.name, device: companion.device }
      : null,
  } });
});

/** First half of a hash, enough to recognise it in a feed line. */
const shortHash = (hash: string | null | undefined): string => hash?.slice(0, 12) ?? 'none';

async function jsonBody(c: Context<AppEnv>) {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

controlRoutes.post('/api/agent/installations/register', async (c) => {
  const parsed = registerAgentSchema.safeParse(await jsonBody(c));
  if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
  const grant = c.get('mcpGrant');
  if (grant.installationId) {
    const rows = await c
      .get('db')
      .select()
      .from(agentInstallations)
      .where(
        and(
          eq(agentInstallations.id, grant.installationId),
          eq(agentInstallations.userId, c.get('mcpUser').id),
        ),
      )
      .limit(1);
    const installation = rows[0];
    if (!installation || installation.revokedAt) {
      return c.json({ error: 'installation_revoked' }, 409);
    }
    return c.json({ ok: true, installation, bound: true });
  }
  const installation = await registerAgent(c.get('db'), c.get('mcpUser').id, parsed.data);
  if (installation.revokedAt) {
    return c.json(
      {
        error: 'installation_revoked',
        message:
          'This run identity was revoked by its owner. Register a new installation identity before starting work.',
      },
      409,
    );
  }
  return c.json({ ok: true, installation });
});

controlRoutes.post('/api/agent/runs/start', async (c) => {
  const parsed = startAgentRunSchema.safeParse(await jsonBody(c));
  if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
  const grant = c.get('mcpGrant');
  if (grant.installationId && parsed.data.installationId !== grant.installationId) {
    return c.json({ error: 'This credential is bound to another agent installation.' }, 403);
  }
  const scopeError = await guardNamedGrantScope(c.get('db'), grant, {
    team: parsed.data.team,
    project: parsed.data.project,
  });
  if (scopeError) return c.json({ error: scopeError }, 403);
  const result = await startAgentRun(
    c.get('db'),
    c.get('mcpUser').id,
    parsed.data,
    c.get('env').agentClaimLeaseMinutes,
    grant.projectId,
  );
  if ('error' in result) return c.json({ error: result.error }, 400);
  logLine({ evt: 'agent_run', a: 'started', installation: grant.installationId, run: result.run.id, project: result.run.projectId, team: parsed.data.team, replayed: result.replayed, source: 'rest', conflicts: result.conflicts.length, conflictRuns: [...new Set(result.conflicts.map((item) => item.existing.runId))] });
  const readiness = await runStartReadiness(c.get('db'), c.get('mcpUser').id, {
    run: result.run,
    team: parsed.data.team,
    project: parsed.data.project,
    claims: parsed.data.claims,
    replayed: result.replayed,
  });
  const contextQuery = [parsed.data.taskKey, parsed.data.intent]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .slice(0, 200);
  const knowledgeContext = await getOrCreateRunStartKnowledgeContext(
    c.get('db'),
    c.get('mcpUser').id,
    {
      team: parsed.data.team,
      project: parsed.data.project,
      query: contextQuery || undefined,
      maxItems: 10,
      runId: result.run.id,
      checkpointId: result.checkpoint?.checkpoint.id,
    },
    grant,
  );
  // The receipt written here is the server's expectation, not the agent's report —
  // it is drifted by definition until the agent answers, so it stays out of the feed.
  const label = result.run.taskKey ?? result.run.intent ?? result.run.repo ?? 'run';
  if (!result.replayed) {
    void track(c.get('db'), {
      teamId: result.run.teamId,
      projectId: result.run.projectId,
      userId: c.get('mcpUser').id,
      tokenId: c.get('mcpToken')?.id,
      action: 'run_started',
      detail: [
        label,
        result.run.branch,
        result.conflicts.length > 0 ? `${result.conflicts.length} conflicts` : null,
      ]
        .filter(Boolean)
        .join(' · '),
    });
  }
  return c.json({
    ok: true,
    ...result,
    policy: readiness.policy,
    knowledgeContext,
    readiness: {
      advisory: readiness.advisory,
      enforcement: readiness.enforcement,
      needsApproval: readiness.approvals,
      overBudget: readiness.budget.over,
      possibleDuplicates: readiness.duplicates,
      flow: readiness.flow
        ? { id: readiness.flow.flow.id, name: readiness.flow.flow.name }
        : null,
      flowAdvice: readiness.flowWarnings,
    },
  });
});

controlRoutes.post('/api/agent/knowledge/contexts/:id/receipt', async (c) => {
  const parsed = z
    .object({ manifestHash: z.string().regex(/^[a-f0-9]{64}$/i) })
    .safeParse(await jsonBody(c));
  if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
  const result = await reportKnowledgeReceipt(
    c.get('db'),
    c.get('mcpUser').id,
    { contextId: c.req.param('id'), manifestHash: parsed.data.manifestHash },
    c.get('mcpGrant'),
  );
  if ('error' in result) {
    return 'status' in result && result.status === 409
      ? c.json({ ...result }, 409)
      : c.json({ error: result.error }, 404);
  }
  return c.json({ ok: true, ...result });
});

controlRoutes.post('/api/agent/runs/:id/heartbeat', async (c) => {
  const parsed = heartbeatAgentRunSchema.safeParse(await jsonBody(c));
  if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
  const scopeError = await guardRunGrantScope(c.get('db'), c.get('mcpGrant'), c.req.param('id'));
  if (scopeError) return c.json({ error: scopeError }, 403);
  const result = await heartbeatAgentRun(
    c.get('db'),
    c.req.param('id'),
    c.get('mcpUser').id,
    parsed.data.status,
    parsed.data.claims,
    c.get('env').agentClaimLeaseMinutes,
    c.get('env').agentWaitingLeaseMinutes,
    parsed.data.usage,
    parsed.data.claimSource,
    parsed.data.checkpoint,
  );
  if (!result) return c.json({ error: 'unknown_or_inactive_run' }, 404);
  if ('error' in result) return c.json({ error: result.error }, 409);
  logLine({ evt: 'agent_run', a: 'updated', installation: c.get('mcpGrant').installationId, run: c.req.param('id'), source: 'rest', conflicts: result.conflicts.length, conflictRuns: [...new Set(result.conflicts.map((item) => item.existing.runId))] });
  const { scope, ...payload } = result;
  // Only the escalation reaches the feed: a lead wants to know an agent is about
  // to run out, not that it is still at 40%.
  if (result.quota?.escalated && result.quota.state !== 'ok') {
    void track(c.get('db'), {
      teamId: scope.teamId,
      projectId: scope.projectId,
      userId: c.get('mcpUser').id,
      tokenId: c.get('mcpToken')?.id,
      action: 'quota_warning',
      detail: `${scope.taskKey ?? 'run'} · ${result.quota.state} · ${result.quota.usedPct}% used${result.quota.label ? ` (${result.quota.label})` : ''}`,
    });
  }
  return c.json({ ok: true, ...payload });
});

controlRoutes.post('/api/agent/runs/:id/write-guard', async (c) => {
  const parsed = z.object({
    claims: z.array(workClaimSchema.extend({ resourceType: z.literal('path'), access: z.literal('write') })).min(1).max(200),
    repositoryIdentity: z.string().min(1).max(300), worktree: z.string().min(1).max(500),
  }).strict().safeParse(await jsonBody(c));
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  const grant = c.get('mcpGrant');
  const scopeError = await guardRunGrantScope(c.get('db'), grant, c.req.param('id'));
  if (scopeError) return c.json({ error: scopeError }, 403);
  const result = await guardRunWrite(c.get('db'), c.req.param('id'), c.get('mcpUser').id, parsed.data, c.get('env').agentClaimLeaseMinutes);
  if (!result) return c.json({ error: 'unknown_or_inactive_run' }, 404);
  logLine({ evt: 'write_guard', installation: grant.installationId, run: result.runId, allowed: result.allowed, reason: result.reason, conflictRuns: result.conflictRuns });
  return c.json({ ok: true, ...result });
});

/**
 * The local guard stopped an edit because of a `content:` deny rule. What
 * arrives is the rule — which must be one this run's effective policy actually
 * publishes — and the file path. The content stayed on the machine.
 */
controlRoutes.post('/api/agent/runs/:id/policy-violations', async (c) => {
  const parsed = z.object({
    rule: z.string().trim().min(1).max(500),
    // Checkout-relative, forward slashes, no traversal: the shape a claim key has.
    path: z.string().min(1).max(300).regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\r\n]+$/)
      // A backslash is a Windows separator that never belongs in a claim key.
      .refine((value) => !value.includes(String.fromCharCode(92))),
    // `blocked`: the guard stopped an edit. `present`: the end-of-run scan found
    // it in the checkout anyway, which is the half the guard can never see.
    outcome: z.enum(['blocked', 'present']),
  }).strict().safeParse(await jsonBody(c));
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  const grant = c.get('mcpGrant');
  const scopeError = await guardRunGrantScope(c.get('db'), grant, c.req.param('id'));
  if (scopeError) return c.json({ error: scopeError }, 403);
  const result = await recordPolicyViolation(c.get('db'), c.req.param('id'), c.get('mcpUser').id, parsed.data);
  if (!result) return c.json({ error: 'unknown_or_inactive_run' }, 404);
  if ('error' in result) return c.json({ error: result.error }, 409);
  logLine({ evt: 'policy_violation', a: parsed.data.outcome, installation: grant.installationId, run: c.req.param('id'), deduped: result.deduped });
  if (result.recorded) {
    void track(c.get('db'), {
      teamId: result.scope.teamId,
      projectId: result.scope.projectId,
      userId: c.get('mcpUser').id,
      tokenId: c.get('mcpToken')?.id,
      action: 'policy_violation',
      detail: [parsed.data.outcome, result.agentName, parsed.data.path, result.rule].join(' · '),
    });
  }
  return c.json({ ok: true, recorded: result.recorded, deduped: result.deduped });
});

controlRoutes.post('/api/agent/runs/:id/finish', async (c) => {
  const parsed = finishAgentRunSchema.safeParse(await jsonBody(c));
  if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
  const scopeError = await guardRunGrantScope(c.get('db'), c.get('mcpGrant'), c.req.param('id'));
  if (scopeError) return c.json({ error: scopeError }, 403);
  const result = await finishAgentRun(
    c.get('db'),
    c.req.param('id'),
    c.get('mcpUser').id,
    parsed.data.status,
    parsed.data.detail,
    parsed.data.checkpoint,
  );
  if (!result) return c.json({ error: 'unknown_run' }, 404);
  if ('error' in result) return c.json({ error: result.error }, 409);
  const { scope, ...payload } = result;
  if (!result.replayed) {
    logLine({ evt: 'agent_run', a: 'finished', installation: c.get('mcpGrant').installationId, run: c.req.param('id'), source: 'rest', status: result.status });
    void track(c.get('db'), {
      teamId: scope.teamId,
      projectId: scope.projectId,
      userId: c.get('mcpUser').id,
      tokenId: c.get('mcpToken')?.id,
      action: 'run_finished',
      detail: [
        result.status,
        scope.taskKey,
        parsed.data.detail ? redactSecrets(parsed.data.detail) : null,
      ]
        .filter(Boolean)
        .join(' · '),
    });
  }
  // Same rule the MCP tool follows: a run whose task names a GitHub issue
  // reports back on that issue. The CLI path must not be the quiet one.
  const commented = result.replayed
    ? { commented: false as const }
    : await commentOnRunTracker(c.get('db'), c.get('env'), {
        teamId: scope.teamId,
        projectId: scope.projectId,
        taskKey: scope.taskKey,
        body: [
          `**${c.get('mcpUser').username}'s agent ${parsed.data.status === 'failed' ? 'stopped work on' : 'finished'} this** via STMA.`,
          parsed.data.detail ? `\n${redactSecrets(parsed.data.detail)}` : '',
        ].join(''),
      });
  return c.json({
    ok: true,
    ...payload,
    ...(commented.commented
      ? {
          trackerComment: commented.label,
          ...(commented.provider === 'github' ? { issueComment: commented.label } : {}),
        }
      : {}),
  });
});

controlRoutes.get('/api/agent/runs/active', async (c) => {
  const grant = c.get('mcpGrant');
  const requestedTeam = c.req.query('team');
  if (grant.scope !== 'personal' && requestedTeam && requestedTeam !== grant.teamSlug) {
    return c.json({ error: 'This credential cannot access that team.' }, 403);
  }
  const rows = await activeRunsForMember(
    c.get('db'),
    c.get('mcpUser').id,
    requestedTeam ?? (grant.scope !== 'personal' ? grant.teamSlug ?? undefined : undefined),
    grant.scope === 'project' ? grant.projectId ?? undefined : undefined,
  );
  const claims = await claimsForRuns(c.get('db'), rows.map((row) => row.run.id));
  const claimsByRun = new Map<string, typeof claims>();
  for (const claim of claims) {
    const list = claimsByRun.get(claim.runId) ?? [];
    list.push(claim);
    claimsByRun.set(claim.runId, list);
  }
  return c.json({
    runs: rows.map((row) => ({
      ...row.run,
      installation: {
        id: row.installation.id,
        name: row.installation.name,
        clientType: row.installation.clientType,
        clientVersion: row.installation.clientVersion,
      },
      owner: row.owner.username,
      team: row.team.slug,
      project: row.projectName,
      claims: claimsByRun.get(row.run.id) ?? [],
    })),
  });
});

controlRoutes.get('/api/agent/policies/effective', async (c) => {
  const team = c.req.query('team');
  if (!team) return c.json({ error: 'team is required' }, 400);
  const scopeError = await guardNamedGrantScope(c.get('db'), c.get('mcpGrant'), {
    team,
    project: c.req.query('project'),
  });
  if (scopeError) return c.json({ error: scopeError }, 403);
  const result = await effectivePolicy(c.get('db'), c.get('mcpUser').id, {
    team,
    project: c.req.query('project'),
    projectId: c.get('mcpGrant').projectId,
  });
  return 'error' in result ? c.json({ error: result.error }, 404) : c.json(result);
});

const receiptSchema = z.object({
  expectedHash: z.string().length(64),
  reportedHash: z.string().length(64).optional(),
});

controlRoutes.post('/api/agent/runs/:id/policy-receipt', async (c) => {
  const parsed = receiptSchema.safeParse(await jsonBody(c));
  if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
  const scopeError = await guardRunGrantScope(c.get('db'), c.get('mcpGrant'), c.req.param('id'));
  if (scopeError) return c.json({ error: scopeError }, 403);
  const result = await recordPolicyReceipt(
    c.get('db'),
    c.get('mcpUser').id,
    c.req.param('id'),
    parsed.data.expectedHash,
    parsed.data.reportedHash,
  );
  if (!result) return c.json({ error: 'unknown_run' }, 404);
  const { scope, ...receipt } = result;
  // Only a deviation is news. A receipt that matches is the system working.
  if (receipt.drift) {
    void track(c.get('db'), {
      teamId: scope.teamId,
      projectId: scope.projectId,
      userId: c.get('mcpUser').id,
      tokenId: c.get('mcpToken')?.id,
      action: 'policy_drift',
      detail: `${scope.taskKey ?? `run ${receipt.runId.slice(0, 8)}`}: applied ${shortHash(
        receipt.reportedHash,
      )} ≠ expected ${shortHash(receipt.expectedHash)}`,
    });
  }
  return c.json({ ok: true, receipt });
});

const publishPolicySchema = z.object({
  team: z.string().trim().min(1).max(80),
  project: z.string().trim().min(1).max(120).optional(),
  document: policyDocumentSchema,
});

controlRoutes.post('/api/control/policies', async (c) => {
  const parsed = publishPolicySchema.safeParse(await jsonBody(c));
  if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
  const scopeError = await guardNamedGrantScope(c.get('db'), c.get('mcpGrant'), parsed.data);
  if (scopeError) return c.json({ error: scopeError }, 403);
  const grant = c.get('mcpGrant');
  const result = await publishPolicy(c.get('db'), c.get('mcpUser').id, parsed.data, grant.projectId);
  if ('error' in result) return c.json({ error: result.error }, 403);
  void track(c.get('db'), {
    teamId: result.policy.teamId,
    projectId: result.policy.projectId,
    userId: c.get('mcpUser').id,
    tokenId: c.get('mcpToken')?.id,
    action: 'policy_published',
    detail: `${parsed.data.project ?? 'team scope'} v${result.policy.version} · ${shortHash(
      result.policy.hash,
    )}`,
  });
  return c.json({ ok: true, ...result });
});

const baselineSchema = z.object({
  team: z.string().trim().min(1).max(80),
  project: z.string().trim().min(1).max(120),
  snapshot: snapshotSchema,
});

controlRoutes.post('/api/control/environment-baselines', async (c) => {
  const parsed = baselineSchema.safeParse(await jsonBody(c));
  if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
  const scopeError = await guardNamedGrantScope(c.get('db'), c.get('mcpGrant'), parsed.data);
  if (scopeError) return c.json({ error: scopeError }, 403);
  const grant = c.get('mcpGrant');
  const result = await setEnvironmentBaseline(
    c.get('db'),
    c.get('mcpUser').id,
    parsed.data,
    grant.projectId,
  );
  if ('error' in result) return c.json({ error: result.error }, 403);
  void track(c.get('db'), {
    teamId: result.baseline.teamId,
    projectId: result.baseline.projectId,
    userId: c.get('mcpUser').id,
    tokenId: c.get('mcpToken')?.id,
    action: 'env_baseline_set',
    detail: `${parsed.data.project} · ${shortHash(result.baseline.fingerprint)}`,
  });
  return c.json({ ok: true, ...result });
});

const preflightSchema = baselineSchema.extend({ runId: z.string().uuid().optional() });

controlRoutes.post('/api/agent/environment/preflight', async (c) => {
  const parsed = preflightSchema.safeParse(await jsonBody(c));
  if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
  const scopeError = await guardNamedGrantScope(c.get('db'), c.get('mcpGrant'), parsed.data);
  if (scopeError) return c.json({ error: scopeError }, 403);
  if (parsed.data.runId) {
    const runScopeError = await guardRunGrantScope(
      c.get('db'),
      c.get('mcpGrant'),
      parsed.data.runId,
    );
    if (runScopeError) return c.json({ error: runScopeError }, 403);
  }
  const result = await environmentPreflight(c.get('db'), c.get('mcpUser').id, parsed.data);
  if ('error' in result) return c.json({ error: result.error }, 400);
  const { scope, ...payload } = result;
  // Every verdict is stored (a machine that passed is evidence too); only a critical
  // one is loud enough for the team feed. Awaited so the trace exists by the time the
  // agent is told — the insert swallows its own failures, so it cannot break this call.
  await recordEnvironmentCheck(c.get('db'), {
    teamId: scope.teamId,
    projectId: scope.projectId,
    userId: c.get('mcpUser').id,
    runId: parsed.data.runId,
    result,
  });
  if (result.status === 'critical') {
    void track(c.get('db'), {
      teamId: scope.teamId,
      projectId: scope.projectId,
      userId: c.get('mcpUser').id,
      tokenId: c.get('mcpToken')?.id,
      action: 'env_preflight_critical',
      detail: `${parsed.data.project}: ${preflightSummary(result)}`,
    });
  }
  return c.json({ ok: true, ...payload });
});

// ---------------------------------------------------------------- news

/**
 * `GET /api/agent/news` — "is anything waiting for me?", in one bounded read.
 *
 * The lifecycle hooks already inject text into the agent's context before it
 * reads the human's next message, but that text only ever carried news the
 * hook's own call produced. A handoff or a reply therefore sat unseen until
 * somebody thought to ask. This is what the hook reads, and `stma watch` polls
 * the same endpoint — one query shape, so a terminal and an agent can never
 * disagree about what is waiting.
 *
 * Deliberately narrow: conflicts are NOT here. `start_run` and the heartbeat
 * already return them at the moment they matter, and a third copy of that rule
 * is exactly how two surfaces start telling different stories.
 *
 * Everything is capped, because this runs on the human's critical path.
 */
const NEWS_HANDOFFS = 5;

controlRoutes.get('/api/agent/news', async (c) => {
  const db = c.get('db');
  const user = c.get('mcpUser');
  const grant = c.get('mcpGrant');

  const mine = await db
    .select({ id: teams.id, slug: teams.slug })
    .from(memberships)
    .innerJoin(teams, eq(memberships.teamId, teams.id))
    .where(
      and(
        membershipUser(user.id),
        grant.scope !== 'personal' && grant.teamId
          ? eq(memberships.teamId, grant.teamId)
          : undefined,
      ),
    );
  const slugById = new Map(mine.map((t) => [t.id, t.slug]));
  const teamIds = mine.map((t) => t.id);

  // A paired local adapter asks on behalf of the agent beside it. The hook's
  // output lands in that agent's context, so work assigned to it by name is
  // exactly what this call exists to deliver — and before the pairing existed
  // the adapter, asking as itself, was told nothing (2026-09-19).
  const listening = await liveCompanion(db, user.id, grant.companionInstallationId);

  // Viewer, not just a user id: a brief this very machine wrote must not be
  // read back to it as news. The installation is what an assignment names.
  const viewer = {
    userId: user.id,
    origin: c.get('mcpToken')?.id ?? null,
    installationId: grant.installationId,
    listensFor: listening
      ? { installationId: listening.installationId, origin: listening.tokenId }
      : null,
  };
  // Unread is a question about a reader, and an adapter never reads a thread:
  // its cursor would never move and every open session would stay unread
  // forever. The agent it listens for is the one whose reading counts.
  const reader = listening?.tokenId
    ? { userId: user.id, origin: listening.tokenId, installationId: listening.installationId }
    : viewer;
  const all = await pendingHandoffs(
    db,
    teamIds,
    viewer,
    NEWS_HANDOFFS,
    grant.scope === 'project' ? grant.projectId ?? undefined : undefined,
  );
  // Drop what THIS machine wrote. The inbox keeps those on purpose — an offer
  // nobody took is still open, and on a one-machine account that list is the
  // only place it survives. The hook is different: it speaks unprompted into
  // the context of the agent that just wrote the brief, and telling it about
  // its own handoff on the next prompt is the product talking to itself.
  // `mine` without `here` is the case that matters most: my other machine.
  // An assignment is narrower still: it names one agent, and telling every
  // other agent on the account about it would put "Codex B, take this" in
  // front of Codex A. The inbox keeps the whole queue; news is what is waiting
  // for *this* agent.
  const waiting = all.filter((h) => !h.here && (!h.assignedTo || h.forThisAgent));
  // The resume block is the structured half of a handoff: the branch to check
  // out and the exact start_run that re-claims the same ground. The hook offers
  // those verbatim; it must never parse them back out of the prose.
  const payloads =
    waiting.length > 0
      ? await db
          .select({ sessionId: messages.sessionId, payload: messages.payload })
          .from(messages)
          .where(
            and(
              inArray(
                messages.sessionId,
                waiting.map((h) => h.sessionId),
              ),
              eq(messages.kind, 'handoff'),
            ),
          )
      : [];
  const resumeBy = new Map(payloads.map((row) => [row.sessionId, row.payload]));

  return c.json({
    checkedAt: new Date().toISOString(),
    pendingHandoffs: waiting.map((h) => ({
      state: h.state,
      legacy: h.legacy,
      kind: h.kind,
      sessionId: h.sessionId,
      team: slugById.get(h.teamId) ?? null,
      title: h.title,
      from: h.from,
      mine: h.mine,
      assignedTo: h.assignedTo
        ? { agent: h.assignedTo.name, device: h.assignedTo.device, thisAgent: h.forThisAgent }
        : null,
      at: h.at.toISOString(),
      resume: resumeBy.get(h.sessionId) ?? null,
    })),
    unreadSessions: await unreadSessionCount(
      db,
      teamIds,
      reader,
      grant.scope === 'project' ? grant.projectId ?? undefined : undefined,
    ),
    // Present only for a paired adapter, so `stma watch` and a person reading
    // the response can see whose news this is.
    ...(listening ? { listeningFor: { agent: listening.name, device: listening.device } } : {}),
  });
});
