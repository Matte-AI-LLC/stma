import { membershipUser } from '../lib/securityHooks';
import {
  finishAgentRunSchema,
  heartbeatAgentRunSchema,
  policyDocumentSchema,
  registerAgentSchema,
  snapshotSchema,
  startAgentRunSchema,
  workClaimSchema,
  WORK_ERROR_STATUS,
} from '@bridge/shared';
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod/v3';
import { mcpAuth } from '../auth/pat';
import { agentInstallations, agentRuns, memberships, messages, projects, teams, tokens, workItems } from '../db/schema';
import { currentExecutionBinding } from '../lib/executionSecurity';
import { isCanonicalUuid } from '../lib/ids';
import {
  activeRunsForMember,
  claimsForRuns,
  finishAgentRun,
  heartbeatAgentRun,
  registerAgent,
  startAgentRun,
  guardRunWrite,
  isRunRotated,
  type RunRotated,
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
import { activeRunLink, endedRunCarry, linkCarriesOn, runContractChanged, runWorkReply, runWorkStatus } from '../domain/workLinks';
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

/**
 * A run a controlled rotation closed, answered with its successor: `code` is
 * the word a hook matches on and `rotatedTo` the run it adopts, so a runtime
 * that knows rotations moves its session onto the successor and starts
 * nothing. The status is the 404 every closed run gets; `error` opens with the
 * same word and names the run to use, for the agent that reads it. Only a
 * caller that says it adopts is answered this way (`forRotated` below): a
 * runtime pinned before rotations existed forgets a run on a 404 and starts
 * another beside the successor, and on a 409 it kept heartbeating a dead run.
 */
const rotatedReply = (c: Context<AppEnv>, result: RunRotated) =>
  c.json({ error: result.error, code: result.code, rotatedTo: result.rotatedTo }, 404);

/**
 * The header a runtime that adopts a rotated run sends with every hook call
 * (`packages/cli`, `apiRequest`). Only such a runtime is told "rotated, use
 * the successor" with the 404 above.
 */
export const ADOPTS_ROTATION_HEADER = 'x-stma-run-rotation';

/**
 * A runtime pinned before rotations existed never adopts: told 404, it forgets
 * the run, starts a fresh unlinked one on its next event, and its file guard
 * then refuses the agent's own edits, because the successor it never heard of
 * holds the session's ground and has the right of way (two live runs, which
 * spec 5.3 forbids). For a caller that does not say it adopts, a hook call on
 * a rotated run is therefore answered for the successor, as the current
 * runtime would have made it after adopting: the same owner, project and
 * checkout, the scope guard asked again for the successor. That keeps one live
 * run for the session until the checkout is re-pinned. The agent itself is
 * told which run to use by the accept reply and by every MCP tool.
 */
async function forRotated<T>(
  c: Context<AppEnv>,
  runId: string,
  first: T,
  again: (runId: string) => Promise<T>,
): Promise<{ runId: string; result: T } | { refused: Response }> {
  if (!isRunRotated(first) || c.req.header(ADOPTS_ROTATION_HEADER) === 'adopt') return { runId, result: first };
  // `rotatedTo` is already the newest run of the chain, however long the
  // session made it. It can itself be rotated only by an accept that landed
  // between that read and this call, which is followed too: answering such a
  // caller 404 is what makes it start a second run.
  let current = runId;
  let result: T = first;
  for (let hop = 0; hop < 3 && isRunRotated(result); hop++) {
    const successor = result.rotatedTo;
    const scopeError = await guardRunGrantScope(c.get('db'), c.get('mcpGrant'), successor);
    if (scopeError) return { refused: c.json({ error: scopeError }, 403) };
    current = successor;
    result = await again(successor);
  }
  return { runId: current, result };
}

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
    grant,
  );
  if ('error' in result) {
    // A Work refusal keeps its own status and says its code; every other
    // refusal answers exactly as it did before Native Work.
    return 'code' in result && result.code
      ? c.json({ error: result.error, code: result.code }, WORK_ERROR_STATUS[result.code] as 400)
      : c.json({ error: result.error }, 400);
  }
  logLine({ evt: 'agent_run', a: 'started', installation: grant.installationId, run: result.run.id, project: result.run.projectId, team: parsed.data.team, replayed: result.replayed, source: 'rest', conflicts: result.conflicts.length, conflictRuns: [...new Set(result.conflicts.map((item) => item.existing.runId))] });
  // A run started for a work item that named no project starts in the work's
  // own, so the flow and the Knowledge below are read for that one, as the MCP
  // door reads them: one start must not answer differently through two doors.
  const runProject =
    parsed.data.project ??
    (parsed.data.workId && result.run.projectId
      ? (await c.get('db').select({ name: projects.name }).from(projects).where(eq(projects.id, result.run.projectId)).limit(1))[0]
          ?.name
      : undefined);
  const readiness = await runStartReadiness(c.get('db'), c.get('mcpUser').id, {
    run: result.run,
    team: parsed.data.team,
    project: runProject,
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
      project: runProject,
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
  const beat = (runId: string) =>
    heartbeatAgentRun(
      c.get('db'),
      runId,
      c.get('mcpUser').id,
      parsed.data.status,
      parsed.data.claims,
      c.get('env').agentClaimLeaseMinutes,
      c.get('env').agentWaitingLeaseMinutes,
      parsed.data.usage,
      parsed.data.claimSource,
      parsed.data.checkpoint,
    );
  const followed = await forRotated(c, c.req.param('id'), await beat(c.req.param('id')), beat);
  if ('refused' in followed) return followed.refused;
  const { result, runId } = followed;
  if (!result) {
    // A live attempt may observe its exact run after finish_run closed it. This
    // is read-only closure proof for PostToolUse; it cannot revive a run, adopt
    // a successor, or turn an unrelated missing/expired run into success.
    const binding = currentExecutionBinding();
    if (c.get('mcpGrant').execution && binding?.attempt.runId === runId && c.req.param('id') === runId) {
      const [closed] = await c.get('db').select({ status: agentRuns.status }).from(agentRuns)
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.installationId, binding.target.installationId)));
      if (closed?.status === 'completed' || closed?.status === 'failed') {
        return c.json({ ok: true, closed: true, runId, status: closed.status });
      }
    }
    // A run of this person that ended linked to work still open (the presence
    // sweep marks a run stale while its human is away) says which work it
    // carried, as a finish does: the hook forgets the run on this 404 and
    // starts the next one for the same work, or the work is left with no live
    // run and its agent is told nothing. Every other 404 reads as it did.
    const carried = await endedRunCarry(c.get('db'), runId, c.get('mcpUser').id);
    return c.json(carried ? { error: 'unknown_or_inactive_run', work: runWorkReply(carried) } : { error: 'unknown_or_inactive_run' }, 404);
  }
  if (isRunRotated(result)) return rotatedReply(c, result);
  if ('error' in result) return c.json({ error: result.error }, 409);
  logLine({ evt: 'agent_run', a: 'updated', installation: c.get('mcpGrant').installationId, run: runId, source: 'rest', conflicts: result.conflicts.length, conflictRuns: [...new Set(result.conflicts.map((item) => item.existing.runId))] });
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
  // The hook's heartbeat is how a hooked agent hears that the contract moved
  // under its run, as `update_run` tells an agent that heartbeats itself.
  const contractChanged = await runContractChanged(c.get('db'), runId);
  const workStatus = await runWorkStatus(c.get('db'), runId);
  return c.json({ ok: true, ...payload, ...(contractChanged ? { contract_changed: contractChanged } : {}), ...(workStatus ? { work_status: workStatus } : {}) });
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
  const guard = (runId: string) =>
    guardRunWrite(c.get('db'), runId, c.get('mcpUser').id, parsed.data, c.get('env').agentClaimLeaseMinutes);
  const asked = c.req.param('id');
  const followed = await forRotated(c, asked, await guard(asked), guard);
  if ('refused' in followed) return followed.refused;
  const { result } = followed;
  if (!result) return c.json({ error: 'unknown_or_inactive_run' }, 404);
  if (isRunRotated(result)) return rotatedReply(c, result);
  logLine({ evt: 'write_guard', installation: grant.installationId, run: result.runId, allowed: result.allowed, reason: result.reason, conflictRuns: result.conflictRuns });
  // Answered for the successor, the reply still names the run it was asked
  // about. Every runtime pinned before rotations takes an allowed edit only
  // when the reply's `runId` is the run in its own state, and refuses it as
  // `unverified_guard_response` otherwise: told the successor's id it stopped
  // every guarded edit of the session that had just taken the work. The
  // ground was reserved on the successor all the same, and the log says so.
  return c.json({ ok: true, ...result, runId: asked });
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
  // Followed like a heartbeat: a runtime pinned before rotations reports its
  // end-of-run content scan on the run it started, and the content landed in
  // the checkout the successor now holds, so that is where it is recorded.
  const record = (runId: string) => recordPolicyViolation(c.get('db'), runId, c.get('mcpUser').id, parsed.data);
  const followed = await forRotated(c, c.req.param('id'), await record(c.req.param('id')), record);
  if ('refused' in followed) return followed.refused;
  const { result, runId } = followed;
  if (!result) return c.json({ error: 'unknown_or_inactive_run' }, 404);
  if (isRunRotated(result)) return rotatedReply(c, result);
  if ('error' in result) return c.json({ error: result.error }, 409);
  logLine({ evt: 'policy_violation', a: parsed.data.outcome, installation: grant.installationId, run: runId, deduped: result.deduped });
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
  const finish = (runId: string) =>
    finishAgentRun(
      c.get('db'),
      runId,
      c.get('mcpUser').id,
      parsed.data.status,
      parsed.data.detail,
      parsed.data.checkpoint,
      'rest',
    );
  const followed = await forRotated(c, c.req.param('id'), await finish(c.req.param('id')), finish);
  if ('refused' in followed) return followed.refused;
  const { result, runId } = followed;
  if (!result) {
    const carried = await endedRunCarry(c.get('db'), runId, c.get('mcpUser').id);
    return c.json(carried ? { error: 'unknown_run', work: runWorkReply(carried) } : { error: 'unknown_run' }, 404);
  }
  if (isRunRotated(result)) return rotatedReply(c, result);
  if ('error' in result) return c.json({ error: result.error }, 409);
  const { scope, ...payload } = result;
  if (!result.replayed) {
    logLine({ evt: 'agent_run', a: 'finished', installation: c.get('mcpGrant').installationId, run: runId, source: 'rest', status: result.status });
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
  const commented = result.replayed || c.get('mcpGrant').execution
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
  // The work the finished run was linked to, said only for a linked run whose
  // work still takes a run: a hook that closes its run on a branch switch
  // starts the next one for the same work at the same revision, or the work is
  // left with no live run. Accepted, cancelled or archived work is not named:
  // the start would be refused, and the hook would report closed work as an
  // incident. A replay is answered only for a run this route closed (a lost
  // answer to the hook's own close): one the agent ended with finish_run or
  // handoff_work, which is the replay the hook's branch switch meets after
  // it, ended the work's run on purpose, and carrying it on told the agent
  // that had just handed the work over to keep working on it.
  const linked = result.replayed
    ? await endedRunCarry(c.get('db'), runId, c.get('mcpUser').id)
    : await activeRunLink(c.get('db'), runId);
  const link = linked && linkCarriesOn(linked) ? linked : undefined;
  return c.json({
    ok: true,
    ...payload,
    ...(commented.commented
      ? {
          trackerComment: commented.label,
          ...(commented.provider === 'github' ? { issueComment: commented.label } : {}),
        }
      : {}),
    ...(link ? { work: runWorkReply(link) } : {}),
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
  // Followed like a heartbeat: a runtime pinned before rotations files the
  // receipt of a newly applied policy on the run it started, and the policy
  // is applied in the checkout the successor now holds.
  const record = (runId: string) =>
    recordPolicyReceipt(c.get('db'), c.get('mcpUser').id, runId, parsed.data.expectedHash, parsed.data.reportedHash);
  const followed = await forRotated(c, c.req.param('id'), await record(c.req.param('id')), record);
  if ('refused' in followed) return followed.refused;
  const { result } = followed;
  if (!result) return c.json({ error: 'unknown_run' }, 404);
  if (isRunRotated(result)) return rotatedReply(c, result);
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
  // Followed like a heartbeat: a runtime pinned before rotations runs its
  // preflight on the run it started for every prompt of the session, and the
  // checkout it describes is the one the successor now holds. A runtime that
  // adopts is told the run moved, and adopts before it asks again.
  const check = (runId: string | undefined) =>
    environmentPreflight(c.get('db'), c.get('mcpUser').id, { ...parsed.data, runId });
  const asked = parsed.data.runId;
  const first = await check(asked);
  const followed = asked ? await forRotated(c, asked, first, check) : { runId: asked, result: first };
  if ('refused' in followed) return followed.refused;
  const { result, runId } = followed;
  if (isRunRotated(result)) return rotatedReply(c, result);
  if ('error' in result) return c.json({ error: result.error }, 400);
  const { scope, ...payload } = result;
  // Every verdict is stored (a machine that passed is evidence too); only a critical
  // one is loud enough for the team feed. Awaited so the trace exists by the time the
  // agent is told — the insert swallows its own failures, so it cannot break this call.
  await recordEnvironmentCheck(c.get('db'), {
    teamId: scope.teamId,
    projectId: scope.projectId,
    userId: c.get('mcpUser').id,
    runId,
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
  // An assignment made from a work item carries the revision it was pinned to,
  // stored when it was made. The contract may have moved since, and an agent
  // already working on it is told so where it is announced (spec 4.2): the
  // revision the work is at now rides beside the stored one.
  const pinnedWork = new Map<string, { specRevision: number; state: string; archived: boolean } | undefined>();
  for (const row of payloads) {
    const work = (row.payload as { work?: { id?: unknown } } | null)?.work;
    if (typeof work?.id === 'string' && isCanonicalUuid(work.id)) pinnedWork.set(work.id.toLowerCase(), undefined);
  }
  if (pinnedWork.size) {
    for (const row of await db
      .select({ id: workItems.id, specRevision: workItems.specRevision, state: workItems.state, archivedAt: workItems.archivedAt })
      .from(workItems)
      .where(inArray(workItems.id, [...pinnedWork.keys()]))) {
      pinnedWork.set(row.id, { specRevision: row.specRevision, state: row.state, archived: Boolean(row.archivedAt) });
    }
  }
  const withCurrentRevision = (payload: unknown) => {
    const work = (payload as { work?: { id?: unknown } } | null)?.work;
    const current = typeof work?.id === 'string' ? pinnedWork.get(work.id.toLowerCase()) : undefined;
    return current ? { ...(payload as object), work: { ...work, currentSpecRevision: current.specRevision, currentState: current.state, archived: current.archived } } : payload;
  };
  const resumeBy = new Map(payloads.map((row) => [row.sessionId, withCurrentRevision(row.payload)]));

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
