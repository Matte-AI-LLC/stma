import {
  finishAgentRunSchema,
  heartbeatAgentRunSchema,
  policyDocumentSchema,
  registerAgentSchema,
  snapshotSchema,
  startAgentRunSchema,
} from '@bridge/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { mcpAuth } from '../auth/pat';
import { memberships, messages, teams } from '../db/schema';
import {
  activeRunsForMember,
  claimsForRuns,
  finishAgentRun,
  heartbeatAgentRun,
  registerAgent,
  startAgentRun,
} from '../domain/agents';
import {
  environmentPreflight,
  preflightSummary,
  recordEnvironmentCheck,
  setEnvironmentBaseline,
} from '../domain/environments';
import { commentOnRunIssue } from '../domain/integrations';
import { effectivePolicy, publishPolicy, recordPolicyReceipt } from '../domain/policies';
import { redactSecrets } from '../lib/redact';
import { pendingHandoffs, unreadSessionCount } from '../lib/sessions';
import { track } from '../lib/track';
import type { AppEnv } from '../types';

export const controlRoutes = new Hono<AppEnv>();

controlRoutes.use('/api/agent/*', mcpAuth);
controlRoutes.use('/api/control/*', mcpAuth);

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
  const installation = await registerAgent(c.get('db'), c.get('mcpUser').id, parsed.data);
  return c.json({ ok: true, installation });
});

controlRoutes.post('/api/agent/runs/start', async (c) => {
  const parsed = startAgentRunSchema.safeParse(await jsonBody(c));
  if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
  const result = await startAgentRun(
    c.get('db'),
    c.get('mcpUser').id,
    parsed.data,
    c.get('env').agentClaimLeaseMinutes,
  );
  if ('error' in result) return c.json({ error: result.error }, 400);
  const policy = await effectivePolicy(c.get('db'), c.get('mcpUser').id, {
    team: parsed.data.team,
    project: parsed.data.project,
  });
  if (!('error' in policy)) {
    await recordPolicyReceipt(
      c.get('db'),
      c.get('mcpUser').id,
      result.run.id,
      policy.hash,
    );
  }
  // The receipt written here is the server's expectation, not the agent's report —
  // it is drifted by definition until the agent answers, so it stays out of the feed.
  const label = result.run.taskKey ?? result.run.intent ?? result.run.repo ?? 'run';
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
  return c.json({ ok: true, ...result, policy: 'error' in policy ? null : policy });
});

controlRoutes.post('/api/agent/runs/:id/heartbeat', async (c) => {
  const parsed = heartbeatAgentRunSchema.safeParse(await jsonBody(c));
  if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
  const result = await heartbeatAgentRun(
    c.get('db'),
    c.req.param('id'),
    c.get('mcpUser').id,
    parsed.data.status,
    parsed.data.claims,
    c.get('env').agentClaimLeaseMinutes,
    parsed.data.usage,
  );
  if (!result) return c.json({ error: 'unknown_or_inactive_run' }, 404);
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

controlRoutes.post('/api/agent/runs/:id/finish', async (c) => {
  const parsed = finishAgentRunSchema.safeParse(await jsonBody(c));
  if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
  const result = await finishAgentRun(
    c.get('db'),
    c.req.param('id'),
    c.get('mcpUser').id,
    parsed.data.status,
    parsed.data.detail,
  );
  if (!result) return c.json({ error: 'unknown_run' }, 404);
  const { scope, ...payload } = result;
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
  // Same rule the MCP tool follows: a run whose task names a GitHub issue
  // reports back on that issue. The CLI path must not be the quiet one.
  const commented = await commentOnRunIssue(c.get('db'), c.get('env'), {
    teamId: scope.teamId,
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
      ? { issueComment: `${commented.repo}#${commented.issue}` }
      : {}),
  });
});

controlRoutes.get('/api/agent/runs/active', async (c) => {
  const rows = await activeRunsForMember(c.get('db'), c.get('mcpUser').id, c.req.query('team'));
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
  const result = await effectivePolicy(c.get('db'), c.get('mcpUser').id, {
    team,
    project: c.req.query('project'),
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
  const result = await publishPolicy(c.get('db'), c.get('mcpUser').id, parsed.data);
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
  const result = await setEnvironmentBaseline(c.get('db'), c.get('mcpUser').id, parsed.data);
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

  const mine = await db
    .select({ id: teams.id, slug: teams.slug })
    .from(memberships)
    .innerJoin(teams, eq(memberships.teamId, teams.id))
    .where(eq(memberships.userId, user.id));
  const slugById = new Map(mine.map((t) => [t.id, t.slug]));
  const teamIds = mine.map((t) => t.id);

  // Viewer, not just a user id: a brief this very machine wrote must not be
  // read back to it as news.
  const viewer = { userId: user.id, origin: c.get('mcpToken')?.id ?? null };
  const all = await pendingHandoffs(db, teamIds, viewer, NEWS_HANDOFFS);
  // Drop what THIS machine wrote. The inbox keeps those on purpose — an offer
  // nobody took is still open, and on a one-machine account that list is the
  // only place it survives. The hook is different: it speaks unprompted into
  // the context of the agent that just wrote the brief, and telling it about
  // its own handoff on the next prompt is the product talking to itself.
  // `mine` without `here` is the case that matters most: my other machine.
  const waiting = all.filter((h) => !h.here);
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
      sessionId: h.sessionId,
      team: slugById.get(h.teamId) ?? null,
      title: h.title,
      from: h.from,
      mine: h.mine,
      at: h.at.toISOString(),
      resume: resumeBy.get(h.sessionId) ?? null,
    })),
    unreadSessions: await unreadSessionCount(db, teamIds, viewer),
  });
});
