import { randomUUID } from 'node:crypto';
import {
  CODEX_EXECUTION_RUNTIME, CODEX_PERMISSION_PROFILE, EXECUTION_LEASE_SECONDS, EXECUTION_PERMISSION_PROFILE, EXECUTION_RUNTIME,
  executionConfigureSchema, executionDispatchSchema, executionEventSchema,
  type ExecutionAttemptDto, type ExecutionClaimDto, type ExecutionConfigureInput,
  type ExecutionDetailDto, type ExecutionDispatchInput, type ExecutionEventInput,
  type ExecutionHeartbeatDto, type ExecutionJobDto, type ExecutionLeaseInput,
  type ExecutionResult, type ExecutionState, type ExecutionTargetDto,
} from '@bridge/shared';
import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db';
import {
  agentInstallations, agentRuns, debugSessions, executionAttemptGrants, executionAttempts,
  executionEvents, executionJobs, executionTargets, handoffs, memberships, messages,
  projects, teams, tokens, users, webSessions, workerInstances, workItems, workLinks, workProjectCounters,
} from '../db/schema';
import { fingerprintJson } from '../lib/canonical';
import { randomHex, sha256hex } from '../lib/crypto';
import { DAY_MS, hitCounter } from '../lib/counters';
import { effectiveLimits } from '../lib/entitlements';
import type { AgentGrant } from '../lib/grants';
import { isCanonicalUuid } from '../lib/ids';
import { redactSecrets } from '../lib/redact';
import {
  authorizeSecurity, criticalAudit, currentSecurityPrincipal, membershipUser,
  withSecurityPrincipal,
} from '../lib/securityHooks';
import { collaborationAccess } from './collaboration';
import { OPEN_HANDOFF_STATES, workAccess } from './workAccess';
import { principalId, type WorkPrincipal } from './workTypes';

export type ExecutionTargetRow = typeof executionTargets.$inferSelect;
export type ExecutionJobRow = typeof executionJobs.$inferSelect;
export type ExecutionAttemptRow = typeof executionAttempts.$inferSelect;
export type ExecutionConsoleDetail = ExecutionDetailDto & {
  capacityReconciliation: (Pick<NonNullable<ExecutionJobRow['capacityReconciliation']>, 'attestedAt' | 'reason'> &
    { actor: { id: string; label: string } }) | null;
};
export const EXECUTION_ACTIVE = ['leased', 'starting', 'running', 'cancel_requested'] as const;
const UNCERTAIN = ['dispatch_unknown', 'lost'];
const OCCUPIED = [...EXECUTION_ACTIVE, ...UNCERTAIN];
const RESERVED = ['queued', ...OCCUPIED];
const END = ['succeeded', 'failed', 'cancelled', 'needs_input'];
export const EXECUTION_POLICY_LIMIT = 1000;
export const EXECUTION_RECONCILIATION_REASON_LIMIT = 500;
export class ExecutionRefusal extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export const executionRefuse = (code: string, message: string): never => { throw new ExecutionRefusal(code, message); };
async function result<T>(fn: () => Promise<T>): Promise<ExecutionResult<T>> {
  try { return await fn(); } catch (error) {
    if (error instanceof ExecutionRefusal) return { error: { code: error.code, message: error.message, retryable: false } };
    throw error;
  }
}
const iso = (date: Date) => date.toISOString();
export function executionJobDto(job: ExecutionJobRow): ExecutionJobDto {
  return { id: job.id, target_id: job.targetId, session_id: job.sessionId, state: job.state as ExecutionState,
    work_id: job.workId, spec_revision: job.specRevision, max_runtime_seconds: job.maxRuntimeSeconds,
    max_turns: job.maxTurns, created_at: iso(job.createdAt), assignment: job.assignment };
}
export function executionAttemptDto(attempt: ExecutionAttemptRow): ExecutionAttemptDto {
  return { id: attempt.id, fence: attempt.fence, lease_expires_at: iso(attempt.leaseExpiresAt),
    provider_session_id: attempt.providerSessionId, run_id: attempt.runId,
    state: attempt.state as ExecutionState, process_stopped: attempt.processStopped };
}
/** Same advisory workspace lock as claims; Work counter/row locks must always come last. */
export async function lockExecutionWorkspace(tx: Db, teamId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(727273, hashtext(${teamId}))`);
}
export async function lockExecutionTarget(tx: Db, id: string): Promise<ExecutionTargetRow> {
  if (!isCanonicalUuid(id)) return executionRefuse('NOT_FOUND', 'No execution target is visible to this principal.');
  const [seen] = await tx.select().from(executionTargets).where(eq(executionTargets.id, id));
  if (!seen) return executionRefuse('NOT_FOUND', 'No execution target is visible to this principal.');
  await lockExecutionWorkspace(tx, seen.teamId);
  const [target] = await tx.select().from(executionTargets).where(eq(executionTargets.id, id)).for('no key update');
  if (!target) return executionRefuse('NOT_FOUND', 'No execution target is visible to this principal.');
  return target;
}
async function access(db: Db, principal: WorkPrincipal, target: ExecutionTargetRow, tool: string) {
  const member = await workAccess(db, principal, target.teamId, target.projectId);
  if (!member) return executionRefuse('NOT_FOUND', 'No execution target is visible to this principal.');
  if (principal.kind === 'agent' && principal.grant.execution) executionRefuse('FORBIDDEN', 'An attempt cannot control execution.');
  const denied = await authorizeSecurity(db, principal.kind === 'agent' ? 'tool' : 'browser', {
    tool, target_id: target.id, project_id: target.projectId, team_id: target.teamId,
  });
  if (denied) executionRefuse('FORBIDDEN', denied);
  return member;
}

const dispatcherAllowed = (target: ExecutionTargetRow, userId: string) =>
  target.dispatcherUserIds === null || target.dispatcherUserIds.includes(userId);

/** Queue admission reserves a slot until the attempt stops or queued work is cancelled. */
async function reservations(db: Db, teamId: string, limit: number) {
  const rows = await db.select({ id: executionJobs.id }).from(executionJobs)
    .innerJoin(executionTargets, eq(executionTargets.id, executionJobs.targetId))
    .where(and(eq(executionTargets.teamId, teamId), inArray(executionJobs.state, RESERVED),
      isNull(executionJobs.capacityReconciliation))).limit(limit);
  return rows.length;
}

async function checkExecutionCapacity(db: Db, team: typeof teams.$inferSelect, admitting: boolean) {
  if (team.executionJobCap === null) return;
  const threshold = team.executionJobCap + (admitting ? 0 : 1);
  if (await reservations(db, team.id, threshold) >= threshold) {
    executionRefuse('CAPACITY_EXCEEDED', 'The workspace has reached its execution job cap.');
  }
}
async function liveTargetCredential(db: Db, target: ExecutionTargetRow) {
  const [row] = await db.select({ installation: agentInstallations, token: tokens }).from(agentInstallations)
    .innerJoin(tokens, eq(tokens.id, agentInstallations.tokenId))
    .where(and(eq(agentInstallations.id, target.installationId), eq(agentInstallations.userId, target.ownerId)));
  if (!row || row.installation.revokedAt || row.token.revokedAt ||
      (row.token.expiresAt && row.token.expiresAt <= new Date()) ||
      row.token.scope !== 'project' || row.token.projectId !== target.projectId ||
      row.token.teamId !== target.teamId || (row.token.setupExpiresAt && !row.token.activatedAt)) {
    executionRefuse('NEEDS_AUTH', 'The dedicated installation needs a current project credential.');
  }
  const [member] = await db.select().from(memberships).where(and(eq(memberships.teamId, target.teamId), eq(memberships.userId, target.ownerId)));
  if (!member) executionRefuse('NEEDS_AUTH', 'The installation owner no longer belongs to this workspace.');
  const denied = await withSecurityPrincipal({ userId: target.ownerId, tokenId: row.token.id, teamId: target.teamId,
    projectId: target.projectId, path: '/mcp', method: 'POST' }, () => authorizeSecurity(db, 'credential'));
  if (denied) executionRefuse('NEEDS_AUTH', denied);
  return row;
}
/** Original dispatch authority is checked again at claim and every child mutation. */
export async function executionAuthority(db: Db, target: ExecutionTargetRow, job: ExecutionJobRow) {
  if (!target.enabled || target.quarantined || target.grantVersion !== job.grantVersion) executionRefuse('REVOKED', 'Execution permission is disabled, changed or quarantined.');
  await liveTargetCredential(db, target);
  const [team] = await db.select().from(teams).where(eq(teams.id, target.teamId));
  const limits = team ? await effectiveLimits(db, team) : null;
  if (!limits || limits.fleet !== 'full' || limits.readOnly) executionRefuse('LIMIT_EXCEEDED', 'Current fleet entitlement no longer permits execution.');
  if (!dispatcherAllowed(target, job.actorUserId)) executionRefuse('REVOKED', 'This dispatcher is no longer allowed on the target.');
  await checkExecutionCapacity(db, team!, false);
  const [member] = await db.select().from(memberships).where(and(eq(memberships.teamId, target.teamId), eq(memberships.userId, job.actorUserId)));
  if (!member) executionRefuse('REVOKED', 'The dispatcher no longer belongs to this workspace.');
  if (job.actorSecurityPrincipal.tokenId) {
    const [token] = await db.select().from(tokens).where(eq(tokens.id, job.actorSecurityPrincipal.tokenId));
    if (!token || token.revokedAt || (token.expiresAt && token.expiresAt <= new Date())) executionRefuse('REVOKED', 'The dispatch credential is no longer current.');
    if (token.scope !== 'personal' && (token.teamId !== target.teamId || (token.scope === 'project' && token.projectId !== target.projectId))) executionRefuse('REVOKED', 'The dispatch credential no longer reaches this project.');
  }
  const security = { ...job.actorSecurityPrincipal };
  if (job.actorSessionProof) {
    // Browser session ids are bearer credentials. Persist only the hash, then
    // resolve the original proof for current session/organization checks.
    const [session] = await db.select({ id: webSessions.id }).from(webSessions).where(and(
      eq(webSessions.userId, job.actorUserId), gt(webSessions.expiresAt, new Date()),
      sql`encode(sha256(convert_to(${webSessions.id}, 'UTF8')), 'hex') = ${job.actorSessionProof}`,
    )).limit(1);
    if (!session) executionRefuse('REVOKED', 'The browser session that dispatched this job has expired or been revoked.');
    security.sessionId = session!.id;
  }
  const scope = { target_id: target.id, project_id: target.projectId, team_id: target.teamId };
  const denied = await withSecurityPrincipal(security, async () =>
    (await authorizeSecurity(db, job.principalKind === 'agent' ? 'credential' : 'browser', scope)) ??
    (job.principalKind === 'agent' ? await authorizeSecurity(db, 'tool', { ...scope, tool: 'dispatch_work' }) : null));
  if (denied) executionRefuse('REVOKED', denied);
  const [offer] = await db.select().from(handoffs).where(eq(handoffs.id, job.handoffId));
  if (!offer || offer.targetInstallationId !== target.installationId || ['cancelled', 'declined'].includes(offer.state)) executionRefuse('REVOKED', 'The assignment was cancelled or is no longer addressed to this installation.');
  const startCall = job.assignment.start_call;
  if (job.workId || hasWorkPin(startCall)) {
    const pin = await currentAssignmentWork(db, target, job.handoffId, startCall);
    if (pin.workId !== job.workId || pin.specRevision !== job.specRevision) assignmentContractChanged();
  }
}
async function targetDto(db: Db, target: ExecutionTargetRow): Promise<ExecutionTargetDto> {
  if (!((target.runtime === EXECUTION_RUNTIME && target.permissionProfile === EXECUTION_PERMISSION_PROFILE) || (target.runtime === CODEX_EXECUTION_RUNTIME && target.permissionProfile === CODEX_PERMISSION_PROFILE))) throw new Error('Execution target has an invalid runtime and profile.');
  const [installation] = await db.select().from(agentInstallations).where(eq(agentInstallations.id, target.installationId));
  const [project] = await db.select().from(projects).where(eq(projects.id, target.projectId));
  const [busy] = await db.select({ id: executionJobs.id }).from(executionJobs).where(and(eq(executionJobs.targetId, target.id), inArray(executionJobs.state, OCCUPIED))).limit(1);
  let readiness: ExecutionTargetDto['readiness'] = target.quarantined ? 'quarantined' : !target.enabled ? 'disabled' : busy ? 'busy' :
    !target.lastSeenAt || Date.now() - target.lastSeenAt.getTime() > EXECUTION_LEASE_SECONDS * 1000 ? 'offline' : 'available';
  if (target.enabled && !target.quarantined) {
    try { await liveTargetCredential(db, target); } catch (error) { if (error instanceof ExecutionRefusal) readiness = 'needs_auth'; else throw error; }
  }
  const reasons = { available: 'Worker is available.', busy: 'A managed attempt still owns this checkout.', offline: 'Worker has not checked in recently; queued work waits.',
    disabled: 'Execution needs explicit permission from the installation owner.', quarantined: 'A previous process may still be running. This checkout cannot start more work.', needs_auth: 'The installation needs current project access.' };
  return { id: target.id, installation_id: target.installationId, installation_name: installation?.name ?? 'Unavailable installation', owner_id: target.ownerId,
    team_id: target.teamId, project_id: target.projectId, project_name: project?.name ?? 'Unavailable project', checkout_path: target.checkoutPath,
    checkout_fingerprint: target.checkoutFingerprint, runtime: target.runtime === CODEX_EXECUTION_RUNTIME ? CODEX_EXECUTION_RUNTIME : EXECUTION_RUNTIME, runtime_version: target.runtimeVersion,
    permission_profile: target.permissionProfile === CODEX_PERMISSION_PROFILE ? CODEX_PERMISSION_PROFILE : EXECUTION_PERMISSION_PROFILE, max_runtime_seconds: target.maxRuntimeSeconds, max_turns: target.maxTurns,
    grant_version: target.grantVersion, enabled: target.enabled, quarantined: target.quarantined, last_seen: target.lastSeenAt ? iso(target.lastSeenAt) : null,
    readiness, reason: reasons[readiness] };
}
export async function listExecutionTargets(db: Db, principal: WorkPrincipal, projectId?: string): Promise<ExecutionResult<{ targets: ExecutionTargetDto[] }>> {
  return result(async () => {
    const rows = await db.select({ target: executionTargets }).from(executionTargets)
      .innerJoin(memberships, eq(memberships.teamId, executionTargets.teamId))
      .where(and(membershipUser(principal.userId), projectId ? eq(executionTargets.projectId, projectId) : undefined))
      .orderBy(desc(executionTargets.createdAt)).limit(100);
    const targets: ExecutionTargetDto[] = [];
    for (const { target } of rows) { try { await access(db, principal, target, 'list_execution_targets'); targets.push(await targetDto(db, target)); } catch (error) { if (!(error instanceof ExecutionRefusal)) throw error; } }
    return { targets };
  });
}
export async function listExecutions(db: Db, principal: WorkPrincipal, projectId?: string, limit = 30): Promise<ExecutionResult<{ jobs: ExecutionJobDto[] }>> {
  return result(async () => {
    const rows = await db.select({ job: executionJobs, target: executionTargets }).from(executionJobs)
      .innerJoin(executionTargets, eq(executionTargets.id, executionJobs.targetId))
      .innerJoin(memberships, eq(memberships.teamId, executionTargets.teamId))
      .where(and(membershipUser(principal.userId), projectId ? eq(executionTargets.projectId, projectId) : undefined))
      .orderBy(desc(executionJobs.createdAt)).limit(Math.min(100, Math.max(1, limit)));
    const jobs: ExecutionJobDto[] = [];
    for (const { job, target } of rows) { try { await access(db, principal, target, 'get_execution'); jobs.push(executionJobDto(job)); } catch (error) { if (!(error instanceof ExecutionRefusal)) throw error; } }
    return { jobs };
  });
}
export async function configureExecutionTarget(db: Db, userId: string, grant: AgentGrant, input: ExecutionConfigureInput): Promise<ExecutionResult<{ target: ExecutionTargetDto }>> {
  return result(async () => {
    const parsed = executionConfigureSchema.safeParse(input);
    if (!parsed.success) executionRefuse('INVALID_INPUT', 'Invalid worker configuration.');
    if (input.runtime === CODEX_EXECUTION_RUNTIME && input.max_turns !== 1) executionRefuse('INVALID_INPUT', 'The Codex read-only worker supports one outer turn.');
    if (grant.execution || !grant.installationId || grant.scope !== 'project' || !grant.projectId || !grant.teamId || grant.companionInstallationId || grant.clientType !== (input.runtime === CODEX_EXECUTION_RUNTIME ? 'codex' : 'claude-code')) executionRefuse('FORBIDDEN', 'Configure a dedicated project-scoped installation matching the runtime.');
    const target = await db.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      await lockExecutionWorkspace(tx, grant.teamId!);
      if (!(await collaborationAccess(tx, userId, grant.teamId!, grant.projectId, grant))) executionRefuse('FORBIDDEN', 'Current project access is required.');
      const [project] = await tx.select().from(projects).where(eq(projects.id, grant.projectId!));
      if (!project?.repositoryIdentity) executionRefuse('REPOSITORY_REQUIRED', 'This runtime requires a project with a bound repository identity.');
      const [installation] = await tx.select().from(agentInstallations).where(eq(agentInstallations.id, grant.installationId!)).for('no key update');
      if (!installation || installation.companionOf) executionRefuse('FORBIDDEN', 'Use an unpaired dedicated installation.');
      const [paired] = await tx.select().from(agentInstallations).where(and(eq(agentInstallations.companionOf, installation.id), isNull(agentInstallations.revokedAt))).limit(1);
      const [run] = await tx.select().from(agentRuns).where(and(eq(agentRuns.installationId, installation.id), inArray(agentRuns.status, ['starting','active','waiting','blocked']))).limit(1);
      if (paired || run) executionRefuse('BUSY', 'This installation already has a paired adapter or live run. Use a dedicated installation.');
      const [previous] = await tx.select().from(executionTargets).where(eq(executionTargets.installationId, installation.id));
      const config = { checkoutPath: input.checkout_path, checkoutFingerprint: input.checkout_fingerprint, runtime: input.runtime, runtimeVersion: input.runtime_version,
        permissionProfile: input.permission_profile, maxRuntimeSeconds: input.max_runtime_seconds, maxTurns: input.max_turns };
      if (previous) {
        if (previous.quarantined) executionRefuse('QUARANTINED', 'An unresolved process still owns this checkout; reconfiguration cannot clear it.');
        const unchanged = Object.entries(config).every(([key, value]) => previous[key as keyof ExecutionTargetRow] === value);
        if (unchanged) return previous;
        const [occupied] = await tx.select().from(executionJobs).where(and(eq(executionJobs.targetId, previous.id), inArray(executionJobs.state, ['queued', ...OCCUPIED]))).limit(1);
        if (previous.enabled || occupied) executionRefuse('BUSY', 'Disable execution and finish queued or active work before changing configuration.');
        if (previous.checkoutFingerprint !== input.checkout_fingerprint) executionRefuse('FORBIDDEN', 'A dedicated installation cannot be moved to another checkout.');
        return (await tx.update(executionTargets).set({ ...config, grantVersion: previous.grantVersion + 1 }).where(eq(executionTargets.id, previous.id)).returning())[0]!;
      }
      const [sameCheckout] = await tx.select().from(executionTargets).where(and(eq(executionTargets.ownerId, userId), eq(executionTargets.checkoutFingerprint, input.checkout_fingerprint)));
      if (sameCheckout) executionRefuse('BUSY', 'This checkout already has a registered execution target.');
      return (await tx.insert(executionTargets).values({ ...config, installationId: installation.id, ownerId: userId, teamId: grant.teamId!, projectId: grant.projectId!, enabled: false }).returning())[0]!;
    });
    return { target: await targetDto(db, target) };
  });
}
async function event(tx: Db, job: ExecutionJobRow, state: string, reason: string, attemptId?: string) {
  await tx.insert(executionEvents).values({ jobId: job.id, attemptId, state, reason, requestHash: fingerprintJson({ state, reason }) });
}
async function revokeAttempt(tx: Db, jobId: string) {
  const attempts = await tx.select().from(executionAttempts).where(eq(executionAttempts.jobId, jobId));
  for (const attempt of attempts) await tx.update(executionAttemptGrants).set({ revokedAt: new Date() }).where(eq(executionAttemptGrants.attemptId, attempt.id));
}
async function requestCancel(tx: Db, job: ExecutionJobRow, reason = 'cancel_requested') {
  if (END.includes(job.state) || ['dispatch_unknown','lost'].includes(job.state)) return job;
  const state = job.state === 'queued' ? 'cancelled' : 'cancel_requested';
  await revokeAttempt(tx, job.id);
  await tx.update(executionAttempts).set({ state }).where(eq(executionAttempts.jobId, job.id));
  const updated = (await tx.update(executionJobs).set({ state, updatedAt: new Date() }).where(eq(executionJobs.id, job.id)).returning())[0]!;
  if (job.state !== state) await event(tx, job, state, reason);
  return updated;
}
export async function setExecutionTargetEnabled(db: Db, principal: WorkPrincipal, targetId: string, enabled: boolean): Promise<ExecutionResult<{ target: ExecutionTargetDto }>> {
  return result(async () => {
    const target = await db.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      const target = await lockExecutionTarget(tx, targetId);
      const membership = await access(tx, principal, target, enabled ? 'enable_execution' : 'disable_execution');
      const workerOwnDisable = !enabled && principal.kind === 'agent' && principal.grant.installationId === target.installationId && !principal.grant.execution;
      if (!workerOwnDisable && (principal.kind !== 'human' || (principal.userId !== target.ownerId && (enabled || membership?.role !== 'owner')))) executionRefuse('FORBIDDEN', enabled ? 'Only the installation owner in the console may enable execution.' : 'Only its owner or a workspace owner may disable execution.');
      if (enabled) { await liveTargetCredential(tx, target); if (target.quarantined) executionRefuse('QUARANTINED', 'An unresolved process still owns this checkout.'); }
      if (target.enabled === enabled) return target;
      const updated = (await tx.update(executionTargets).set({ enabled, grantVersion: target.grantVersion + 1 }).where(eq(executionTargets.id, target.id)).returning())[0]!;
      if (!enabled) {
        const jobs = await tx.select().from(executionJobs).where(and(eq(executionJobs.targetId, target.id), inArray(executionJobs.state, ['queued', ...EXECUTION_ACTIVE])));
        for (const job of jobs) await requestCancel(tx, job);
      }
      await criticalAudit(tx, { teamId: target.teamId, actorId: principal.userId, action: enabled ? 'execution_enabled' : 'execution_disabled', subjectId: target.id });
      return updated;
    });
    return { target: await targetDto(db, target) };
  });
}

async function executionPolicyTeam(db: Db, principal: WorkPrincipal, teamId: string) {
  if (principal.kind !== 'human') return executionRefuse('FORBIDDEN', 'Only a workspace owner in the console may edit execution controls.');
  const [row] = await db.select({ team: teams, role: memberships.role }).from(teams)
    .innerJoin(memberships, eq(memberships.teamId, teams.id))
    .where(and(eq(teams.id, teamId), membershipUser(principal.userId))).limit(1);
  if (!row) return executionRefuse('NOT_FOUND', 'No workspace is visible to this principal.');
  if (row.role !== 'owner') executionRefuse('FORBIDDEN', 'Only a workspace owner may edit execution controls.');
  const denied = await authorizeSecurity(db, 'browser', { team_id: teamId });
  if (denied) executionRefuse('FORBIDDEN', denied);
  const limits = await effectiveLimits(db, row.team);
  if (!limits.executionControls || limits.readOnly || limits.fleet !== 'full') {
    executionRefuse('LIMIT_EXCEEDED', 'Editing workspace execution controls requires the Team fleet entitlement.');
  }
  return row.team;
}

export async function readExecutionControls(db: Db, principal: WorkPrincipal, teamId: string, targetIds: string[]) {
  return result(async () => {
    const team = await executionPolicyTeam(db, principal, teamId);
    const targets = targetIds.length ? await db.select({ id: executionTargets.id, dispatchers: executionTargets.dispatcherUserIds })
      .from(executionTargets).where(and(eq(executionTargets.teamId, teamId), inArray(executionTargets.id, targetIds))) : [];
    // Only a workspace-wide owner sees this roster. The membership filter in
    // executionPolicyTeam excludes restricted organization project roles.
    const members = targets.length ? await db.select({ id: users.id, username: users.username }).from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.teamId, teamId))
      .orderBy(asc(users.username)).limit(EXECUTION_POLICY_LIMIT + 1) : [];
    return { cap: team.executionJobCap, targets, members };
  });
}

export async function setExecutionCapacity(db: Db, principal: WorkPrincipal, teamId: string, cap: number | null): Promise<ExecutionResult<{ cap: number | null }>> {
  return result(() => db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    if (!isCanonicalUuid(teamId)) executionRefuse('NOT_FOUND', 'No workspace is visible to this principal.');
    await lockExecutionWorkspace(tx, teamId);
    const team = await executionPolicyTeam(tx, principal, teamId);
    if (cap !== null && (!Number.isInteger(cap) || cap < 1 || cap > EXECUTION_POLICY_LIMIT)) {
      executionRefuse('INVALID_INPUT', `Enter a cap from 1 to ${EXECUTION_POLICY_LIMIT}, or leave it blank.`);
    }
    if (team.executionJobCap === cap) return { cap };
    if (cap !== null && await reservations(tx, team.id, cap + 1) > cap) {
      executionRefuse('CAPACITY_EXCEEDED', 'The cap is below the number of reserved jobs. Cancel queued jobs or wait for an active job to stop.');
    }
    await tx.update(teams).set({ executionJobCap: cap }).where(eq(teams.id, team.id));
    await criticalAudit(tx, { teamId: team.id, actorId: principal.userId, action: 'execution_capacity_changed', subjectId: team.id });
    return { cap };
  }));
}

export async function setExecutionDispatchers(db: Db, principal: WorkPrincipal, targetId: string, userIds: string[] | null): Promise<ExecutionResult<{ dispatchers: string[] | null }>> {
  return result(() => db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const target = await lockExecutionTarget(tx, targetId);
    await access(tx, principal, target, 'manage_execution_dispatchers');
    await executionPolicyTeam(tx, principal, target.teamId);
    if (userIds !== null && (userIds.length > EXECUTION_POLICY_LIMIT || !userIds.every(isCanonicalUuid))) {
      executionRefuse('INVALID_INPUT', 'Choose current workspace members as dispatchers.');
    }
    const dispatchers = userIds === null ? null : [...new Set(userIds.map(id => id.toLowerCase()))].sort();
    if (dispatchers?.length) {
      const members = await tx.select({ id: memberships.userId }).from(memberships)
        .where(and(eq(memberships.teamId, target.teamId), inArray(memberships.userId, dispatchers)));
      if (members.length !== dispatchers.length) executionRefuse('INVALID_INPUT', 'Choose current workspace members as dispatchers.');
    }
    if (fingerprintJson(target.dispatcherUserIds) === fingerprintJson(dispatchers)) return { dispatchers };
    const [updated] = await tx.update(executionTargets).set({ dispatcherUserIds: dispatchers })
      .where(eq(executionTargets.id, target.id)).returning();
    if (dispatchers !== null) {
      const jobs = await tx.select().from(executionJobs).where(and(eq(executionJobs.targetId, target.id), inArray(executionJobs.state, ['queued', ...EXECUTION_ACTIVE])));
      for (const job of jobs) {
        if (!dispatcherAllowed(updated!, job.actorUserId)) await requestCancel(tx, job, 'dispatcher_revoked');
      }
    }
    await criticalAudit(tx, { teamId: target.teamId, actorId: principal.userId, action: 'execution_dispatchers_changed', subjectId: target.id });
    return { dispatchers };
  }));
}

export async function reconcileExecutionCapacity(db: Db, principal: WorkPrincipal, jobId: string, input: {
  requestId: string;
  expectedState: string;
  expectedGrantVersion: number;
  verifiedStopped: boolean;
  reason: string;
}): Promise<ExecutionResult<{ replayed: boolean }>> {
  return result(() => db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    if (!isCanonicalUuid(jobId)) executionRefuse('NOT_FOUND', 'No execution is visible to this principal.');
    const [seen] = await tx.select({ targetId: executionJobs.targetId }).from(executionJobs).where(eq(executionJobs.id, jobId));
    if (!seen) return executionRefuse('NOT_FOUND', 'No execution is visible to this principal.');
    const target = await lockExecutionTarget(tx, seen.targetId);
    await access(tx, principal, target, 'reconcile_execution_capacity');
    await executionPolicyTeam(tx, principal, target.teamId);
    const reason = input.reason.trim();
    if (!input.verifiedStopped || !isCanonicalUuid(input.requestId) || !reason || reason.length > EXECUTION_RECONCILIATION_REASON_LIMIT) {
      return executionRefuse('INVALID_INPUT', 'Confirm you verified the local process stopped and enter a reason.');
    }
    const [job] = await tx.select().from(executionJobs).where(eq(executionJobs.id, jobId)).for('no key update');
    if (!job) return executionRefuse('NOT_FOUND', 'No execution is visible to this principal.');
    const requestHash = fingerprintJson({
      jobId: job.id, actorUserId: principal.userId, expectedState: input.expectedState, expectedGrantVersion: input.expectedGrantVersion, reason,
    });
    const previous = job.capacityReconciliation;
    if (previous) {
      if (previous.requestId === input.requestId && previous.requestHash === requestHash) return { replayed: true };
      return executionRefuse(previous.requestId === input.requestId ? 'REQUEST_REUSED' : 'ALREADY_RECONCILED', 'The workspace slot already has an owner reconciliation.');
    }
    if (!target.quarantined || target.grantVersion !== input.expectedGrantVersion ||
        job.state !== input.expectedState || !UNCERTAIN.includes(job.state)) {
      return executionRefuse('STALE_EXECUTION', 'Review the current quarantined execution before releasing its workspace slot.');
    }
    await tx.update(executionJobs).set({
      capacityReconciliation: { actorUserId: principal.userId, attestedAt: iso(new Date()), reason: redactSecrets(reason),
        requestId: input.requestId, requestHash },
    }).where(eq(executionJobs.id, job.id));
    await criticalAudit(tx, { teamId: target.teamId, actorId: principal.userId, action: 'execution_capacity_reconciled', subjectId: job.id });
    return { replayed: false };
  }));
}

async function requireDispatchTarget(db: Db, principal: WorkPrincipal, target: ExecutionTargetRow) {
  if (!target.enabled || target.quarantined) executionRefuse('NOT_ENABLED', 'This target is disabled or quarantined. Its owner must explicitly permit execution.');
  if (!dispatcherAllowed(target, principal.userId)) executionRefuse('FORBIDDEN', 'This workspace has restricted who can dispatch to this target.');
  await liveTargetCredential(db, target);
  const [team] = await db.select().from(teams).where(eq(teams.id, target.teamId));
  const limits = team ? await effectiveLimits(db, team) : null;
  if (!limits || limits.fleet !== 'full' || limits.readOnly) return executionRefuse('LIMIT_EXCEEDED', 'Execution requires an active fleet entitlement.');
  await checkExecutionCapacity(db, team!, true);
  return limits;
}

async function readExecutionAssignment(db: Db, sessionId: string, title: string): Promise<ExecutionJobRow['assignment']> {
  const [message] = await db.select().from(messages).where(and(eq(messages.sessionId, sessionId), eq(messages.kind, 'handoff')))
    .orderBy(asc(messages.createdAt)).limit(1);
  const resume = message?.payload as { reclaim?: { arguments?: Record<string, unknown> }; task?: string; branch?: string; repo?: string } | null;
  const startCall = resume?.reclaim?.arguments;
  if (!startCall) return executionRefuse('INVALID_ASSIGNMENT', 'This assignment has no structured start record.');
  return { task: String(resume?.task ?? title), brief: redactSecrets(message?.body ?? '').slice(0, 24000),
    branch: typeof resume?.branch === 'string' ? resume.branch : null, repository_identity: typeof resume?.repo === 'string' ? resume.repo : null,
    start_call: startCall };
}

const hasWorkPin = (startCall: Record<string, unknown>) =>
  startCall.work_id !== undefined || startCall.expected_spec_revision !== undefined;

const assignmentContractChanged = () => executionRefuse('CONTRACT_CHANGED',
  'The pinned work contract changed or the assignment link was corrected. Create a new assignment for the current contract.');

async function currentAssignmentWork(db: Db, target: ExecutionTargetRow, handoffId: string, startCall: Record<string, unknown>) {
  // An after-the-fact link has no revision. A corrected Native Work assignment
  // also cannot become standalone, because its immutable brief still pins Work.
  const [link] = await db.select({ work: workItems, specRevision: workLinks.specRevision }).from(workLinks)
    .innerJoin(workItems, eq(workItems.id, workLinks.workId))
    .where(and(eq(workLinks.handoffId, handoffId), eq(workLinks.kind, 'assignment'), isNull(workLinks.supersededAt),
      eq(workLinks.teamId, target.teamId), eq(workLinks.projectId, target.projectId))).limit(1);
  if (!link && !hasWorkPin(startCall)) return { workId: null, specRevision: null };
  if (!link || link.specRevision === null || link.work.id !== startCall.work_id ||
      link.specRevision !== startCall.expected_spec_revision || link.specRevision !== link.work.specRevision) {
    return assignmentContractChanged();
  }
  if (link.work.archivedAt || ['draft', 'accepted', 'cancelled'].includes(link.work.state)) {
    return executionRefuse('CONTRACT_CHANGED', 'The work is no longer executable.');
  }
  return { workId: link.work.id, specRevision: link.specRevision };
}

async function lockAssignmentWorkProject(db: Db, projectId: string) {
  // All Work writers lock the counter first. Take this after execution locks
  // and before reading the assignment link so a correction cannot cross admission.
  await db.select({ projectId: workProjectCounters.projectId }).from(workProjectCounters)
    .where(eq(workProjectCounters.projectId, projectId)).for('key share');
}

/** Browser review is an advisory read. Dispatch repeats every check under the workspace lock. */
export async function reviewExecutionDispatch(db: Db, principal: WorkPrincipal, sessionId: string): Promise<ExecutionResult<{ target: ExecutionTargetDto }>> {
  return result(async () => {
    if (principal.kind !== 'human' || !isCanonicalUuid(sessionId)) return executionRefuse('NOT_FOUND', 'No open assignment is visible.');
    const [row] = await db.select({ target: executionTargets, handoffId: handoffs.id, title: debugSessions.title }).from(handoffs)
      .innerJoin(debugSessions, eq(debugSessions.id, handoffs.sessionId))
      .innerJoin(executionTargets, and(eq(executionTargets.installationId, handoffs.targetInstallationId),
        eq(executionTargets.projectId, debugSessions.projectId), eq(executionTargets.teamId, debugSessions.teamId)))
      .where(and(eq(handoffs.sessionId, sessionId), eq(handoffs.kind, 'assignment'), inArray(handoffs.state, OPEN_HANDOFF_STATES)));
    if (!row) return executionRefuse('NOT_FOUND', 'This assignment has no matching managed target.');
    await access(db, principal, row.target, 'dispatch_work');
    await requireDispatchTarget(db, principal, row.target);
    const assignment = await readExecutionAssignment(db, sessionId, row.title);
    await currentAssignmentWork(db, row.target, row.handoffId, assignment.start_call);
    return { target: await targetDto(db, row.target) };
  });
}

export async function dispatchExecution(db: Db, principal: WorkPrincipal, input: ExecutionDispatchInput, reviewedGrantVersion?: number): Promise<ExecutionResult<{ job: ExecutionJobDto; replayed: boolean }>> {
  return result(() => db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    if (!executionDispatchSchema.safeParse(input).success) executionRefuse('INVALID_INPUT', 'Dispatch needs an exact target, assignment session and UUID request id.');
    // Serialize one durable principal before the workspace, including cross-project request-id reuse.
    await tx.execute(sql`select pg_advisory_xact_lock(727275, hashtext(${principal.kind + ':' + principalId(principal)}))`);
    const target = await lockExecutionTarget(tx, input.target_id);
    await access(tx, principal, target, 'dispatch_work');
    const [old] = await tx.select().from(executionJobs).where(and(eq(executionJobs.principalKind, principal.kind), eq(executionJobs.principalId, principalId(principal)), eq(executionJobs.requestId, input.request_id)));
    if (old) {
      if (old.targetId !== target.id || old.sessionId !== input.session_id) executionRefuse('REQUEST_REUSED', 'This request id already names another dispatch.');
      return { job: executionJobDto(old), replayed: true };
    }
    if (reviewedGrantVersion !== undefined && reviewedGrantVersion !== target.grantVersion) {
      executionRefuse('TARGET_CHANGED', 'The target configuration or permission changed. Review the current target before dispatching.');
    }
    const limits = await requireDispatchTarget(tx, principal, target);
    const [offer] = await tx.select({ handoff: handoffs, session: debugSessions }).from(handoffs).innerJoin(debugSessions, eq(debugSessions.id, handoffs.sessionId))
      .where(eq(handoffs.sessionId, input.session_id)).for('no key update', { of: handoffs });
    if (!offer || offer.handoff.kind !== 'assignment' || offer.handoff.targetInstallationId !== target.installationId || offer.session.projectId !== target.projectId || offer.session.teamId !== target.teamId || !(OPEN_HANDOFF_STATES as readonly string[]).includes(offer.handoff.state)) executionRefuse('NOT_FOUND', 'No open assignment to this target is visible.');
    const [duplicate] = await tx.select().from(executionJobs).where(and(eq(executionJobs.handoffId, offer.handoff.id), inArray(executionJobs.state, RESERVED))).limit(1);
    if (duplicate) executionRefuse('ALREADY_DISPATCHED', 'This assignment already has a queued, active or unresolved execution.');
    const queued = await tx.select({ id: executionJobs.id }).from(executionJobs).where(and(eq(executionJobs.targetId, target.id), eq(executionJobs.state, 'queued'))).limit(20);
    if (queued.length >= 20) executionRefuse('LIMIT_EXCEEDED', 'This target already has twenty queued jobs.');
    const assignment = await readExecutionAssignment(tx, input.session_id, offer.session.title);
    if (hasWorkPin(assignment.start_call)) await lockAssignmentWorkProject(tx, target.projectId);
    const { workId, specRevision } = await currentAssignmentWork(tx, target, offer.handoff.id, assignment.start_call);
    if (principal.kind === 'agent') {
      const charged = await hitCounter(tx, 'team-day', target.teamId, DAY_MS, limits.maxToolCallsPerDay);
      if (charged.exceeded) executionRefuse('LIMIT_EXCEEDED', 'This workspace has used its daily tool allowance. Nothing was dispatched.');
    }
    const requestHash = fingerprintJson({ target: target.id, session: input.session_id, workId, specRevision, maxRuntimeSeconds: target.maxRuntimeSeconds, maxTurns: target.maxTurns, grantVersion: target.grantVersion });
    const { sessionId, ...security } = currentSecurityPrincipal() ?? { userId: principal.userId, ...(principal.kind === 'agent' ? { tokenId: principal.grant.tokenId, teamId: principal.grant.teamId, projectId: principal.grant.projectId } : {}), path: principal.kind === 'agent' ? '/mcp' : '/app', method: 'POST' };
    const [job] = await tx.insert(executionJobs).values({ targetId: target.id, sessionId: input.session_id, handoffId: offer.handoff.id, workId, specRevision,
      principalKind: principal.kind, principalId: principalId(principal), actorUserId: principal.userId, actorTokenId: principal.kind === 'agent' ? principal.grant.tokenId : null,
      actorSecurityPrincipal: security, actorSessionProof: sessionId ? sha256hex(sessionId) : null,
      requestId: input.request_id, requestHash, grantVersion: target.grantVersion, maxRuntimeSeconds: target.maxRuntimeSeconds, maxTurns: target.maxTurns, assignment }).returning();
    await event(tx, job!, 'queued', 'explicit_dispatch');
    await criticalAudit(tx, { teamId: target.teamId, actorId: principal.userId, action: 'execution_dispatched', subjectId: job!.id });
    return { job: executionJobDto(job!), replayed: false };
  }));
}
export async function getExecution(db: Db, principal: WorkPrincipal, jobId: string): Promise<ExecutionResult<ExecutionConsoleDetail>> {
  return result(async () => {
    if (!isCanonicalUuid(jobId)) executionRefuse('NOT_FOUND', 'No execution is visible to this principal.');
    const [row] = await db.select({ job: executionJobs, target: executionTargets }).from(executionJobs).innerJoin(executionTargets, eq(executionTargets.id, executionJobs.targetId)).where(eq(executionJobs.id, jobId));
    if (!row) executionRefuse('NOT_FOUND', 'No execution is visible to this principal.');
    const member = await access(db, principal, row.target, 'get_execution');
    const [attempt] = await db.select().from(executionAttempts).where(eq(executionAttempts.jobId, jobId));
    const events = await db.select().from(executionEvents).where(eq(executionEvents.jobId, jobId)).orderBy(desc(executionEvents.createdAt)).limit(50);
    const attestation = principal.kind === 'human' ? row.job.capacityReconciliation : null;
    const [actor] = attestation ? await db.select({ username: users.username }).from(users)
      .where(eq(users.id, attestation.actorUserId)) : [];
    return { job: executionJobDto(row.job), target: await targetDto(db, row.target), attempt: attempt ? executionAttemptDto(attempt) : null,
      capacityReconciliation: attestation ? { attestedAt: attestation.attestedAt, reason: attestation.reason,
        actor: { id: attestation.actorUserId,
          label: actor && actor.username !== `deleted-${attestation.actorUserId}` ? actor.username : 'Deleted account' },
      } : null,
      can_cancel: principal.userId === row.job.actorUserId || principal.userId === row.target.ownerId || (principal.kind === 'human' && member?.role === 'owner'),
      events: events.map(e => ({ id: e.id, state: e.state, reason: e.reason, detail: e.detail, created_at: iso(e.createdAt) })), result_provenance: 'worker_reported', acceptance: 'separate' };
  });
}
export async function cancelExecution(db: Db, principal: WorkPrincipal, jobId: string): Promise<ExecutionResult<{ job: ExecutionJobDto }>> {
  return result(() => db.transaction(async transaction => {
    if (!isCanonicalUuid(jobId)) executionRefuse('NOT_FOUND', 'No execution is visible to this principal.');
    const tx = transaction as unknown as Db;
    const [seen] = await tx.select().from(executionJobs).where(eq(executionJobs.id, jobId));
    if (!seen) executionRefuse('NOT_FOUND', 'No execution is visible to this principal.');
    const target = await lockExecutionTarget(tx, seen.targetId);
    const member = await access(tx, principal, target, 'cancel_execution');
    if (principal.userId !== seen.actorUserId && principal.userId !== target.ownerId && (principal.kind !== 'human' || member?.role !== 'owner')) executionRefuse('FORBIDDEN', 'Only the dispatcher, target owner or a workspace owner may cancel this execution.');
    const [job] = await tx.select().from(executionJobs).where(eq(executionJobs.id, jobId)).for('no key update');
    const updated = await requestCancel(tx, job!);
    await criticalAudit(tx, { teamId: target.teamId, actorId: principal.userId, action: 'execution_cancelled', subjectId: jobId });
    return { job: executionJobDto(updated) };
  }));
}
async function workerTarget(tx: Db, userId: string, grant: AgentGrant, targetId: string) {
  const target = await lockExecutionTarget(tx, targetId);
  if (grant.execution || grant.installationId !== target.installationId || userId !== target.ownerId || !(await collaborationAccess(tx, userId, target.teamId, target.projectId, grant))) executionRefuse('FORBIDDEN', 'Only this dedicated installation may operate its worker.');
  return target;
}
export async function claimExecution(db: Db, userId: string, grant: AgentGrant, input: { target_id: string; worker_id: string }): Promise<ExecutionResult<ExecutionClaimDto | { job: null }>> {
  return result(() => db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const target = await workerTarget(tx, userId, grant, input.target_id);
    const [oldWorker] = await tx.select().from(workerInstances).where(eq(workerInstances.id, input.worker_id));
    if (oldWorker && oldWorker.targetId !== target.id) executionRefuse('FORBIDDEN', 'This process identity belongs to another target.');
    await tx.insert(workerInstances).values({ id: input.worker_id, targetId: target.id }).onConflictDoUpdate({ target: workerInstances.id, set: { lastSeenAt: new Date() } });
    await tx.update(executionTargets).set({ lastSeenAt: new Date() }).where(eq(executionTargets.id, target.id));
    const [occupied] = await tx.select({ job: executionJobs, attempt: executionAttempts }).from(executionJobs)
      .leftJoin(executionAttempts, eq(executionAttempts.jobId, executionJobs.id)).where(and(eq(executionJobs.targetId, target.id), inArray(executionJobs.state, OCCUPIED))).limit(1);
    if (occupied) {
      if (occupied.attempt && occupied.attempt.leaseExpiresAt <= new Date() && EXECUTION_ACTIVE.includes(occupied.job.state as typeof EXECUTION_ACTIVE[number])) {
        await tx.update(executionTargets).set({ quarantined: true }).where(eq(executionTargets.id, target.id));
        await tx.update(executionJobs).set({ state: 'lost', updatedAt: new Date() }).where(eq(executionJobs.id, occupied.job.id));
        await tx.update(executionAttempts).set({ state: 'lost' }).where(eq(executionAttempts.id, occupied.attempt.id));
        await revokeAttempt(tx, occupied.job.id); await event(tx, occupied.job, 'lost', 'lease_expired', occupied.attempt.id);
      }
      return { job: null };
    }
    if (!target.enabled || target.quarantined) return { job: null };
    const [job] = await tx.select().from(executionJobs).where(and(eq(executionJobs.targetId, target.id), eq(executionJobs.state, 'queued'))).orderBy(asc(executionJobs.createdAt)).limit(1).for('no key update');
    if (!job) return { job: null };
    if (job.workId || hasWorkPin(job.assignment.start_call)) {
      // The child grant references the worker credential. Establish that FK lock
      // before the Work counter, as Work locks come last.
      await tx.select({ id: tokens.id }).from(tokens).where(eq(tokens.id, grant.tokenId)).for('key share');
      await lockAssignmentWorkProject(tx, target.projectId);
    }
    try { await executionAuthority(tx, target, job); } catch (error) {
      if (!(error instanceof ExecutionRefusal)) throw error;
      await tx.update(executionJobs).set({ state: 'cancelled', updatedAt: new Date() }).where(eq(executionJobs.id, job.id));
      await event(tx, job, 'cancelled', error.code.toLowerCase()); return { job: null };
    }
    const now = Date.now();
    const leaseExpiresAt = new Date(now + EXECUTION_LEASE_SECONDS * 1000);
    const [epoch] = await tx.select({ fence: sql<number>`coalesce(max(${executionAttempts.fence}), 0)` }).from(executionAttempts).innerJoin(executionJobs, eq(executionJobs.id, executionAttempts.jobId)).where(eq(executionJobs.targetId, target.id));
    const [attempt] = await tx.insert(executionAttempts).values({ jobId: job.id, workerId: input.worker_id, fence: Number(epoch?.fence ?? 0) + 1, leaseExpiresAt,
      deadlineAt: new Date(now + job.maxRuntimeSeconds * 1000), providerSessionId: randomUUID() }).returning();
    const secret = 'stma_attempt_' + randomHex(32);
    await tx.insert(executionAttemptGrants).values({ attemptId: attempt!.id, parentTokenId: grant.tokenId, tokenHash: sha256hex(secret), expiresAt: leaseExpiresAt });
    let childToken: string | undefined;
    if (target.runtime === CODEX_EXECUTION_RUNTIME) {
      childToken = 'stma_attempt_' + randomHex(32);
      await tx.insert(executionAttemptGrants).values({ attemptId: attempt!.id, parentTokenId: grant.tokenId, tokenHash: sha256hex(childToken), expiresAt: leaseExpiresAt, purpose: 'readonly_child' });
    }
    const updated = (await tx.update(executionJobs).set({ state: 'leased', updatedAt: new Date() }).where(eq(executionJobs.id, job.id)).returning())[0]!;
    await event(tx, job, 'leased', 'worker_claimed', attempt!.id);
    return { job: executionJobDto(updated), attempt: executionAttemptDto(attempt!), attempt_token: secret, ...(childToken ? { child_token: childToken } : {}) };
  }));
}
async function ownedAttempt(tx: Db, target: ExecutionTargetRow, input: ExecutionLeaseInput) {
  const [row] = await tx.select({ attempt: executionAttempts, job: executionJobs }).from(executionAttempts).innerJoin(executionJobs, eq(executionJobs.id, executionAttempts.jobId))
    .where(eq(executionAttempts.id, input.attempt_id)).for('no key update', { of: executionAttempts });
  if (!row || row.job.targetId !== target.id || row.attempt.workerId !== input.worker_id || row.attempt.fence !== input.fence) executionRefuse('STALE_ATTEMPT', 'This worker does not own the current attempt.');
  return row;
}
export async function heartbeatExecution(db: Db, userId: string, grant: AgentGrant, input: ExecutionLeaseInput): Promise<ExecutionResult<ExecutionHeartbeatDto>> {
  return result(() => db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const target = await workerTarget(tx, userId, grant, input.target_id);
    const { job, attempt } = await ownedAttempt(tx, target, input);
    await tx.update(executionTargets).set({ lastSeenAt: new Date() }).where(eq(executionTargets.id, target.id));
    await tx.update(workerInstances).set({ lastSeenAt: new Date() }).where(eq(workerInstances.id, input.worker_id));
    let stop = job.state === 'cancel_requested' || !EXECUTION_ACTIVE.includes(job.state as typeof EXECUTION_ACTIVE[number]);
    try { await executionAuthority(tx, target, job); } catch (error) { if (!(error instanceof ExecutionRefusal)) throw error; stop = true; }
    if (attempt.leaseExpiresAt <= new Date() || attempt.deadlineAt <= new Date()) stop = true;
    if (stop) {
      const updated = await requestCancel(tx, job);
      return { state: updated.state as ExecutionState, lease_expires_at: iso(attempt.leaseExpiresAt), cancel_requested: true };
    }
    const lease = new Date(Math.min(Date.now() + EXECUTION_LEASE_SECONDS * 1000, attempt.deadlineAt.getTime()));
    await tx.update(executionAttempts).set({ leaseExpiresAt: lease }).where(eq(executionAttempts.id, attempt.id));
    await tx.update(executionAttemptGrants).set({ expiresAt: lease }).where(and(eq(executionAttemptGrants.attemptId, attempt.id), isNull(executionAttemptGrants.revokedAt)));
    return { state: job.state as ExecutionState, lease_expires_at: iso(lease), cancel_requested: false };
  }));
}
export async function reportExecutionEvent(db: Db, userId: string, grant: AgentGrant, input: ExecutionEventInput): Promise<ExecutionResult<{ ok: true; state: ExecutionState }>> {
  return result(() => db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    if (!executionEventSchema.safeParse(input).success) executionRefuse('INVALID_INPUT', 'Invalid worker event.');
    const target = await workerTarget(tx, userId, grant, input.target_id);
    const { job, attempt } = await ownedAttempt(tx, target, input);
    if (input.provider_session_id !== attempt.providerSessionId || input.checkout_fingerprint !== target.checkoutFingerprint) executionRefuse('CORRELATION_MISMATCH', 'This event does not identify the planned session and checkout.');
    const hash = fingerprintJson(input);
    const [previous] = await tx.select().from(executionEvents).where(eq(executionEvents.id, input.event_id));
    if (previous) {
      if (previous.jobId !== job.id || previous.attemptId !== attempt.id || previous.requestHash !== hash) executionRefuse('REQUEST_REUSED', 'This event id already recorded a different event.');
      return { ok: true, state: previous.state as ExecutionState };
    }
    if (END.includes(job.state) || ['dispatch_unknown','lost'].includes(job.state)) executionRefuse('STALE_ATTEMPT', 'This attempt has ended or is quarantined; later events cannot revive it.');
    let authorized = true;
    try { await executionAuthority(tx, target, job); } catch (error) { if (!(error instanceof ExecutionRefusal)) throw error; authorized = false; }
    const expired = attempt.leaseExpiresAt <= new Date() || attempt.deadlineAt <= new Date();
    let state: ExecutionState = input.state;
    const terminal = ['succeeded','failed','cancelled','dispatch_unknown','needs_input'].includes(state);
    if ((!authorized || expired || job.state === 'cancel_requested') && !(terminal && input.process_stopped)) state = 'dispatch_unknown';
    else if (!authorized || expired || job.state === 'cancel_requested') state = 'cancelled';
    if (terminal && !input.process_stopped) state = 'dispatch_unknown';
    if (state === 'starting' && job.state !== 'leased') executionRefuse('INVALID_TRANSITION', 'Only a leased attempt may record spawn intent.');
    if (state === 'running' && job.state !== 'starting') executionRefuse('INVALID_TRANSITION', 'A running observation must follow persisted spawn intent.');
    if (state === 'succeeded' && job.state !== 'running') executionRefuse('INVALID_TRANSITION', 'Completion must follow an observed runtime session.');
    if (state === 'needs_input' && !['leased','starting','running'].includes(job.state)) executionRefuse('INVALID_TRANSITION', 'Input can be needed only by the current attempt.');
    if (state === 'dispatch_unknown') await tx.update(executionTargets).set({ quarantined: true }).where(eq(executionTargets.id, target.id));
    if (END.includes(state) || state === 'dispatch_unknown') await revokeAttempt(tx, job.id);
    await tx.update(executionAttempts).set({ state, processStopped: input.process_stopped }).where(eq(executionAttempts.id, attempt.id));
    await tx.update(executionJobs).set({ state, updatedAt: new Date() }).where(eq(executionJobs.id, job.id));
    await tx.insert(executionEvents).values({ id: input.event_id, jobId: job.id, attemptId: attempt.id, requestHash: hash, state, reason: input.reason, detail: input.detail ? redactSecrets(input.detail) : null });
    return { ok: true, state };
  }));
}
