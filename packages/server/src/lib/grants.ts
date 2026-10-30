import { and, eq } from 'drizzle-orm';
import { isCanonicalUuid } from './ids';
import type { Db } from '../db';
import { agentRuns, debugSessions, executionJobs, executionTargets, projects, workItems } from '../db/schema';
import { projectForTeam } from '../domain/access';
import { adapterListensFor } from '../domain/companions';
import { authorizeSecurity } from './securityHooks';
import { guardExecutionTool, managedResourceRefusal, type ExecutionGrant } from './executionSecurity';

export const TOKEN_SCOPES = ['personal', 'team', 'project'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/** The server-resolved authority attached to one PAT-authenticated request. */
export interface AgentGrant {
  execution?: ExecutionGrant;
  tokenId: string;
  scope: TokenScope;
  teamId: string | null;
  teamSlug: string | null;
  teamName: string | null;
  projectId: string | null;
  projectSlug: string | null;
  projectName: string | null;
  installationId: string | null;
  installationName: string | null;
  deviceLabel: string | null;
  /**
   * The agent this installation listens for, when it is a paired local adapter
   * (`domain/companions.ts`). It decides what the hook is told, and no guard in
   * this file reads it: the run edge below asks the question from the other
   * end, starting at the installation that owns the run, so an adapter can
   * never use its own pairing to reach the agent's runs.
   */
  companionInstallationId: string | null;
  /**
   * The installation's client type (`claude-code`, `codex`, `claude-app`, …),
   * null for a legacy token with no installation. Authority never reads it:
   * it decides which introduction the MCP server gives (`serverInstructions`).
   */
  clientType: string | null;
}

export function isTokenScope(value: string): value is TokenScope {
  return (TOKEN_SCOPES as readonly string[]).includes(value);
}

export function grantLabel(grant: Pick<AgentGrant, 'scope' | 'teamSlug' | 'projectName'>): string {
  if (grant.scope === 'personal') return 'Personal · all current memberships';
  if (grant.scope === 'project') {
    return `${grant.teamSlug ?? 'missing team'} / ${grant.projectName ?? 'missing project'}`;
  }
  return `${grant.teamSlug ?? 'missing team'} · team`;
}

export function grantAllowsTeam(grant: AgentGrant, teamId: string | null | undefined): boolean {
  return grant.scope === 'personal' || (Boolean(teamId) && grant.teamId === teamId);
}

export function grantAllowsProject(
  grant: AgentGrant,
  teamId: string | null | undefined,
  projectId: string | null | undefined,
): boolean {
  if (!grantAllowsTeam(grant, teamId)) return false;
  return grant.scope !== 'project' || (Boolean(projectId) && grant.projectId === projectId);
}

/**
 * An id this guard does not check is an id it refuses. It used to skip any
 * value that did not look canonical and let the tool query with it, and the
 * database read `{…}` or a dash-less id as the same row (`lib/ids.ts`).
 */
const idError = (field: string, value: unknown) =>
  `${field} "${String(value).slice(0, 80)}" is not an id STMA issued. Nothing was read or written.`;

const scopeError = (grant: AgentGrant, attempted: string) =>
  `This credential is ${grantLabel(grant)} scoped and cannot access ${attempted}. ` +
  'Nothing was written. Ask your human to create a separate connection with the required scope.';

/**
 * A run inside this credential's own scope that belongs to somebody else's
 * installation. Its own sentence, because the agent most likely to be standing
 * here was *told* to reuse this run by the prompt hook beside it, and "create a
 * separate connection with the required scope" is the wrong way out of that:
 * the way out is the pairing (`domain/companions.ts`), which the owner sets in
 * the browser. It names no installation: a refusal is not the place to hand out
 * a name, and the caller that may read one can already see it on the agent map.
 */
const unownedRunError = (grant: AgentGrant, runId: string) =>
  `This credential cannot access run "${runId}": it belongs to another agent connection. ` +
  'Nothing was written. If the local adapter in this checkout started that run, ask your human ' +
  'to pair that adapter with this agent on Agent connections — a paired agent may update, finish ' +
  'and hand off its adapter\'s run. Otherwise start_run and use the run id it returns.';

/**
 * A work item outside this credential's scope, or one that does not exist, in
 * the exact words the tool answers for a work id that does not exist. Not the
 * scope sentence: naming the scope would tell the caller the id is real, and a
 * Work id that is real somewhere it cannot read must read as one that is real
 * nowhere. The run and assignment tools answer a missing work in their own
 * text; the Work tools in their JSON error. `work-mcp.test.ts` holds each
 * spelling to its tool.
 */
const WORK_NOT_VISIBLE = 'No work with that id is visible to this principal.';
function workNotVisible(tool: string): string {
  if (tool === 'start_run') return `NOT_FOUND: ${WORK_NOT_VISIBLE}`;
  if (tool === 'assign_work') return `NOT_FOUND: ${WORK_NOT_VISIBLE} Nothing was written.`;
  return JSON.stringify({ error: { code: 'NOT_FOUND', message: WORK_NOT_VISIBLE, retryable: false } });
}

async function matchesGrantedProject(db: Db, grant: AgentGrant, value: unknown): Promise<boolean> {
  if (grant.scope !== 'project' || typeof value !== 'string' || !grant.teamId) return true;
  const found = await projectForTeam(db, grant.teamId, value);
  return found?.id === grant.projectId;
}

/**
 * Fail-closed scope check at the one MCP boundary every tool call crosses.
 *
 * It also fills omitted team/project arguments from the credential. That makes
 * a scoped prompt lower-friction without turning its metadata into mere advice:
 * explicit conflicting arguments are refused before the SDK dispatches them.
 */
export async function guardMcpToolCall(
  db: Db,
  grant: AgentGrant,
  tool: string,
  args: Record<string, unknown>,
  accepted: readonly string[],
): Promise<string | null> {
  const denied = await authorizeSecurity(db, 'tool', { ...args, tool });
  if (denied) return denied;
  // Preserve the boundary's existing malformed-id contract before execution
  // fencing resolves any indirect resource or reports an authority mismatch.
  for (const field of ['session_id', 'run_id', 'work_id', 'project_id', 'target_id', 'execution_id'] as const) {
    if (args[field] !== undefined && !isCanonicalUuid(args[field])) return idError(field, args[field]);
  }
  const executionDenied = await guardExecutionTool(db, grant, tool, args);
  if (executionDenied) return executionDenied;
  for (const field of ['project_id', 'target_id', 'execution_id'] as const) {
    const value = args[field];
    if (value === undefined) continue;
    if (!isCanonicalUuid(value)) return idError(field, value);
    const row = field === 'project_id'
      ? (await db.select({ teamId: projects.teamId, projectId: projects.id }).from(projects).where(eq(projects.id, value)))[0]
      : field === 'target_id'
      ? (await db.select({ teamId: executionTargets.teamId, projectId: executionTargets.projectId }).from(executionTargets).where(eq(executionTargets.id, value)))[0]
      : (await db.select({ teamId: executionTargets.teamId, projectId: executionTargets.projectId }).from(executionJobs).innerJoin(executionTargets, eq(executionTargets.id, executionJobs.targetId)).where(eq(executionJobs.id, value)))[0];
    if (!row || !grantAllowsProject(grant, row.teamId, row.projectId)) return 'No execution resource is visible to this credential.';
  }
  if (grant.scope !== 'personal') {
    if (!grant.teamId || !grant.teamSlug) return scopeError(grant, 'any team');

    if (accepted.includes('team')) {
      if (typeof args.team === 'string' && args.team !== grant.teamSlug) {
        return scopeError(grant, `team "${args.team}"`);
      }
      if (args.team === undefined) args.team = grant.teamSlug;
    }

    if (grant.scope === 'project') {
      if (!grant.projectId || !grant.projectName) return scopeError(grant, 'any project');
      for (const field of ['project', 'repo'] as const) {
        if (!accepted.includes(field)) continue;
        if (args[field] !== undefined && !(await matchesGrantedProject(db, grant, args[field]))) {
          return scopeError(grant, `${field} "${String(args[field])}"`);
        }
        if (args[field] === undefined) args[field] = grant.projectName;
      }
      // Membership is a team administration act, not a project act. Owners can
      // still use a team-scoped or deliberately personal credential for it.
      if (tool === 'create_invite') return scopeError(grant, 'team invitations');
    }
  }

  const installationId = args.installation_id;
  if (
    grant.installationId &&
    typeof installationId === 'string' &&
    installationId !== grant.installationId
  ) {
    return scopeError(grant, `agent installation "${installationId}"`);
  }

  const sessionId = args.session_id;
  if (sessionId !== undefined && !isCanonicalUuid(sessionId)) return idError('session_id', sessionId);
  if (typeof sessionId === 'string') {
    const rows = await db
      .select({
        teamId: debugSessions.teamId,
        projectId: debugSessions.projectId,
        kind: debugSessions.kind,
      })
      .from(debugSessions)
      .where(eq(debugSessions.id, sessionId))
      .limit(1);
    const row = rows[0];
    if (
      row &&
      (!grantAllowsTeam(grant, row.teamId) ||
        (grant.scope === 'project' &&
          row.kind !== 'announcements' &&
          row.projectId !== grant.projectId))
    ) {
      return scopeError(grant, `session "${sessionId}"`);
    }
  }

  const runId = args.run_id;
  if (runId !== undefined && !isCanonicalUuid(runId)) return idError('run_id', runId);
  if (typeof runId === 'string') {
    const requiresOwnedRun = ['update_run', 'finish_run', 'handoff_work', 'check_environment'].includes(tool);
    const rows = await db
      .select({
        teamId: agentRuns.teamId,
        projectId: agentRuns.projectId,
        installationId: agentRuns.installationId,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);
    const row = rows[0];
    if (row) {
      // Scope first and unconditionally: the pairing edge below never crosses a
      // team or a project, because by then this has already held.
      if (!grantAllowsProject(grant, row.teamId, row.projectId)) return scopeError(grant, `run "${runId}"`);
      if (
        requiresOwnedRun &&
        grant.installationId &&
        row.installationId !== grant.installationId &&
        !(await adapterListensFor(db, row.installationId, grant.installationId))
      ) {
        return unownedRunError(grant, runId);
      }
    }
  }

  // A work item is read like a run: only the canonical spelling, and only
  // inside the credential's team and project. For a scoped credential a work
  // that does not exist is refused here too, in the same words: this runs
  // before the SDK validates the arguments and before the tool's own checks,
  // so an id out of reach answered here and a made-up one left to the tool
  // would part on any wrong second argument (`key` beside `work_id`, a missing
  // `expected_spec_revision`, a malformed version), and the one that charges
  // the day's allowance would part from the one that does not. A personal
  // credential reaches every workspace of its person, so it sends both to the
  // tool, which validates first and judges access after, the same for both.
  const workId = args.work_id;
  if (workId !== undefined && !isCanonicalUuid(workId)) return idError('work_id', workId);
  if (typeof workId === 'string' && grant.scope !== 'personal') {
    const [row] = await db
      .select({ teamId: workItems.teamId, projectId: workItems.projectId })
      .from(workItems)
      .where(eq(workItems.id, workId.toLowerCase()))
      .limit(1);
    if (!row || !grantAllowsProject(grant, row.teamId, row.projectId)) return workNotVisible(tool);
  }

  return null;
}

/** Resolve and verify explicit team/project names used by the REST control API. */
export async function guardNamedGrantScope(
  db: Db,
  grant: AgentGrant,
  input: { team: string; project?: string },
): Promise<string | null> {
  if (grant.scope === 'personal') return null;
  if (input.team !== grant.teamSlug) return scopeError(grant, `team "${input.team}"`);
  if (grant.scope !== 'project') return null;
  if (!input.project) return scopeError(grant, 'team-wide project scope');
  return (await matchesGrantedProject(db, grant, input.project))
    ? null
    : scopeError(grant, `project "${input.project}"`);
}

/** Verify a REST operation that addresses an existing run by id. */
export async function guardRunGrantScope(
  db: Db,
  grant: AgentGrant,
  runId: string,
): Promise<string | null> {
  if (!isCanonicalUuid(runId)) return idError('run', runId);
  const executionDenied = await managedResourceRefusal(db, grant, { runId });
  if (executionDenied) return executionDenied;
  if (grant.scope === 'personal' && !grant.installationId) return null;
  const rows = await db
    .select({
      teamId: agentRuns.teamId,
      projectId: agentRuns.projectId,
      installationId: agentRuns.installationId,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (!grantAllowsProject(grant, row.teamId, row.projectId)) {
    return scopeError(grant, `run "${runId}"`);
  }
  if (
    grant.installationId &&
    row.installationId !== grant.installationId &&
    // The same edge as the MCP guard, from the same function: these two doors
    // onto one question must not start answering it differently.
    !(await adapterListensFor(db, row.installationId, grant.installationId))
  ) {
    return unownedRunError(grant, runId);
  }
  return null;
}
