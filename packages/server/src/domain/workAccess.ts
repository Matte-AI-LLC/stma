import { and, eq, inArray, isNull, notInArray, or } from 'drizzle-orm';
import type { Db } from '../db';
import { agentInstallations, agentRuns, handoffs, memberships, workLinks } from '../db/schema';
import { authorizeSecurity, currentSecurityPrincipal, membershipUser } from '../lib/securityHooks';
import { collaborationAccess } from './collaboration';
import { adapterListeningFor } from './companions';
import { principalId, type WorkAccess, type WorkItemRow, type WorkPrincipal } from './workTypes';

/**
 * Can this principal see work in this project at all, and as what.
 *
 * The person's membership is read through `membershipUser`, so a composition's
 * filter (an organization-managed workspace) applies here exactly as it does on
 * every aggregate read. An agent additionally needs a grant that covers the
 * project and a credential and installation that are still live: a receipt or a
 * remembered id is never authority. Null means the caller answers NOT_FOUND,
 * never FORBIDDEN, because an id the caller cannot see does not exist for them.
 */
export async function workAccess(
  db: Db,
  principal: WorkPrincipal,
  teamId: string,
  projectId: string,
): Promise<WorkAccess | null> {
  // Analyst requests deliberately admit a restricted workspace membership;
  // recheck the exact project before any Work domain read or mutation.
  if (principal.kind === 'human' && /^\/app\/teams\/[^/]+\/projects\/[^/]+\/analyst(?:\/|$)/.test(currentSecurityPrincipal()?.path ?? '') &&
      await authorizeSecurity(db, 'project_read', { team_id: teamId, project_id: projectId, user_id: principal.userId })) return null;
  if (principal.kind === 'agent') {
    if (!(await collaborationAccess(db, principal.userId, teamId, projectId, principal.grant))) return null;
  }
  const [member] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.teamId, teamId), membershipUser(principal.userId)))
    .limit(1);
  if (!member) return null;
  return { role: member.role === 'owner' ? 'owner' : 'member' };
}

/**
 * The work's owner, its acceptor, or a workspace owner: the people who may
 * change what the work *is*. Never an agent, not even one acting for one of
 * those people: an agent asks for a contract change with a blocker instead.
 */
export function hasContractAuthority(principal: WorkPrincipal, access: WorkAccess, work: WorkItemRow): boolean {
  if (principal.kind !== 'human') return false;
  return (
    access.role === 'owner' || work.ownerUserId === principal.userId || work.acceptorUserId === principal.userId
  );
}

/** Did this principal create the work. Kind and durable id both, so a person and an agent never alias. */
export function createdWork(principal: WorkPrincipal, work: WorkItemRow): boolean {
  return work.createdByKind === principal.kind && work.createdById === principalId(principal);
}

/**
 * An agent's own draft, while it is still a draft: the one place an agent may
 * write a contract. Once a person has moved it on, it is the person's.
 */
export function isOwnDraft(principal: WorkPrincipal, work: WorkItemRow): boolean {
  return principal.kind === 'agent' && work.state === 'draft' && createdWork(principal, work);
}

/** Handoff states in which an assignment or handoff is still somebody's open work. */
export const OPEN_HANDOFF_STATES = ['offered', 'accepted', 'in_progress', 'needs_attention'] as const;
const CLOSED_HANDOFF_STATES = ['cancelled', 'declined'];

/**
 * Is this agent linked to the work: the named target (or the taker) of an
 * assignment or handoff filed against it, or the owner of a run linked to it,
 * a run its paired local adapter started included (the `actionableRuns` edge).
 *
 * Read from the rows themselves rather than from whatever step will write the
 * links, so it answers the same question whoever wrote them. Superseded links
 * and cancelled or declined handoffs link nobody. A legacy credential with no
 * installation is never linked: nothing can name it.
 */
export async function agentLinkedToWork(db: Db, workId: string, principal: WorkPrincipal): Promise<boolean> {
  if (principal.kind !== 'agent' || !principal.installationId) return false;
  const installationId = principal.installationId;

  const [byHandoff] = await db
    .select({ id: workLinks.id })
    .from(workLinks)
    .innerJoin(handoffs, eq(handoffs.id, workLinks.handoffId))
    .where(
      and(
        eq(workLinks.workId, workId),
        isNull(workLinks.supersededAt),
        inArray(workLinks.kind, ['assignment', 'handoff']),
        notInArray(handoffs.state, CLOSED_HANDOFF_STATES),
        or(eq(handoffs.targetInstallationId, installationId), eq(handoffs.installationId, installationId)),
      ),
    )
    .limit(1);
  if (byHandoff) return true;

  const [byRun] = await db
    .select({ id: workLinks.id })
    .from(workLinks)
    .innerJoin(agentRuns, eq(agentRuns.id, workLinks.runId))
    .innerJoin(agentInstallations, eq(agentInstallations.id, agentRuns.installationId))
    .where(
      and(
        eq(workLinks.workId, workId),
        isNull(workLinks.supersededAt),
        eq(workLinks.kind, 'run'),
        eq(agentInstallations.userId, principal.userId),
        or(eq(agentRuns.installationId, installationId), adapterListeningFor(installationId)),
      ),
    )
    .limit(1);
  return Boolean(byRun);
}

/**
 * May this agent report on the work (set a blocker, submit, record evidence):
 * it created the work or it is linked to it. A person's standing is their
 * membership, so this answers true for any human principal.
 */
export async function agentMayReport(db: Db, principal: WorkPrincipal, work: WorkItemRow): Promise<boolean> {
  if (principal.kind === 'human') return true;
  return createdWork(principal, work) || (await agentLinkedToWork(db, work.id, principal));
}
