import { and, eq } from 'drizzle-orm';
import type { Db } from '../db';
import { agentRuns, debugSessions, projects } from '../db/schema';
import { projectForTeam } from '../domain/access';
import { adapterListensFor } from '../domain/companions';
import { authorizeSecurity } from './securityHooks';

export const TOKEN_SCOPES = ['personal', 'team', 'project'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/** The server-resolved authority attached to one PAT-authenticated request. */
export interface AgentGrant {
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (typeof sessionId === 'string' && UUID_RE.test(sessionId)) {
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
  if (typeof runId === 'string' && UUID_RE.test(runId)) {
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
  if (grant.scope === 'personal' && !grant.installationId) return null;
  if (!UUID_RE.test(runId)) return null;
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
