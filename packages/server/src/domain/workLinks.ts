import { randomUUID } from 'node:crypto';
import { ACTIVE_AGENT_RUN_STATUSES, areAttemptSiblings, type WorkClaim, type WorkCommandOf, type WorkErrorCode, type WorkLinkKind } from '@bridge/shared';
import { and, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import type { Db } from '../db';
import {
  agentEvents,
  agentInstallations,
  agentRuns,
  debugSessions,
  handoffs,
  knowledgeAudienceProjects,
  knowledgeItems,
  knowledgeVersions,
  projects,
  teams,
  users,
  workItems,
  workLinks,
} from '../db/schema';
import type { Env } from '../env';
import { isCanonicalUuid } from '../lib/ids';
import { logLine } from '../lib/log';
import {
  announceAssignment,
  assignableAgents,
  assignmentStepRefusal,
  handoffAllowance,
  resolveAssignee,
  writeAssignment,
  type AssignmentCreated,
  type AssignmentDraft,
} from './assignments';
import { adapterListeningFor, adapterListensFor, agentListenedForBy, agentsHeardIn } from './companions';
import { loadRevision, type RevisionContent } from './workRevisions';
import {
  principalId,
  refuse,
  wireBigint,
  type WorkEventDraft,
  type WorkItemRow,
  type WorkOpContext,
  type WorkOpResult,
  type WorkPrincipal,
  type WorkRefusalError,
} from './workTypes';

/**
 * What a work item is executed through: runs, assignments, handoffs, and the
 * Knowledge it leans on (W03).
 *
 * The rule every function here keeps is that a link is history. A run's link
 * says which contract it was started on and is never edited; a wrong one is
 * superseded by a correcting row, and both stay readable. Only the Work flows
 * (an assignment made from the work, a run started for it, a controlled
 * rotation) write the revision a target was bound to; a link made after the
 * fact writes none, because nobody can say which contract the target was
 * working to before it was linked (`legacy_unversioned`).
 *
 * Every function that writes runs inside a Work transaction: either the
 * command envelope (`runWorkCommand`) or another domain's transaction through
 * `mutateWorkInTransaction`, which takes the Work locks last. Nothing here
 * locks a run, an installation, a token, a team or the claim workspace. The
 * rows written here do name runs, installations and tokens, and each such
 * foreign key takes `key share` on the row it names, which is why a caller
 * holding one of those rows while it waits for a Work lock holds it `for no key
 * update` (see the header of `work.ts`).
 */

const NOT_IN_REACH = (kind: string) => `No ${kind} with that id is in this work's project and reachable by this principal.`;

/** Which column holds a link's target. */
const targetOf = (link: typeof workLinks.$inferSelect): string =>
  (link.runId ?? link.handoffId ?? link.knowledgeItemId)!;

/** The wire form of a refusal, as one line: what the run and handoff tools answer with. */
export function workRefusalText(error: WorkRefusalError): string {
  return `${error.code}: ${error.message}${error.next_action ? ` ${error.next_action}` : ''}`;
}

/**
 * Work that can be executed now. A draft is not ready to be worked on; an
 * accepted or cancelled one is closed, and only reopening it (a person's
 * decision, with a reason) makes it work again.
 */
export function assertExecutable(work: WorkItemRow, act: string): void {
  if (work.archivedAt) {
    throw refuse('INVALID_TRANSITION', `${work.displayKey} is archived; ${act} needs open work.`, {
      next_action: 'Whoever owns the work reopens it with a reason first.',
    });
  }
  if (work.state === 'draft') {
    throw refuse('CONTRACT_INCOMPLETE', `${work.displayKey} is still a draft; ${act} needs ready work.`, {
      next_action: 'Move it to ready first.',
    });
  }
  if (work.state === 'accepted' || work.state === 'cancelled') {
    throw refuse('INVALID_TRANSITION', `${work.displayKey} is ${work.state}; ${act} needs open work.`, {
      next_action: 'Whoever owns the work reopens it with a reason first.',
    });
  }
}

/**
 * The revision the caller read is the one in force, or the act is refused. A
 * contract that changed between reading and acting is the race this exists to
 * stop: a run started on the old one would be judged against the new one.
 */
export function assertRevision(work: WorkItemRow, expected: number, act: string, field: string): void {
  if (expected === work.specRevision) return;
  throw refuse(
    'CONTRACT_CHANGED',
    `${work.displayKey} is at contract revision ${work.specRevision}; this ${act} expected revision ${expected}.`,
    {
      fields: [field],
      current_version: wireBigint(work.version),
      next_action: `Read the work again and ${act === 'run start' ? 'start' : 'assign'} it on revision ${work.specRevision}.`,
    },
  );
}

function commandParts(ctx: WorkOpContext) {
  if (!ctx.principal || !ctx.access || !ctx.work) throw new Error('A Work link needs a principal and its work.');
  return { principal: ctx.principal, access: ctx.access, work: ctx.work };
}

// ---------------------------------------------------------------------------
// Reach: is the target in the work's project, and may this principal name it.
// ---------------------------------------------------------------------------

/**
 * May this agent act on the run: its own, or one a local adapter paired with it
 * owns. The `actionableRuns` edge of `mcp/fleet.ts`, read the same way, so an
 * agent can link exactly the runs it can already heartbeat and finish. A legacy
 * credential with no installation stands for every run of its person.
 */
async function agentMayUseRun(
  db: Db,
  principal: Extract<WorkPrincipal, { kind: 'agent' }>,
  run: { installationId: string; ownerId: string },
): Promise<boolean> {
  if (run.ownerId !== principal.userId) return false;
  if (!principal.installationId) return true;
  if (run.installationId === principal.installationId) return true;
  return adapterListensFor(db, run.installationId, principal.installationId);
}

/**
 * The id a link stores for this target, after proving the target is in the
 * work's team and project and that this principal may name it. Anything else
 * is NOT_FOUND, exactly like an id that does not exist.
 *
 * An assignment or handoff may be named by its lifecycle id or by its thread's
 * session id: a person reading a thread has the second, an agent that made the
 * assignment was answered with both.
 */
async function targetInReach(
  db: Db,
  ctx: WorkOpContext,
  principal: WorkPrincipal,
  kind: WorkLinkKind,
  targetId: string,
): Promise<string> {
  const id = targetId.toLowerCase();
  if (kind === 'run') {
    const [run] = await db
      .select({
        id: agentRuns.id,
        teamId: agentRuns.teamId,
        projectId: agentRuns.projectId,
        installationId: agentRuns.installationId,
        ownerId: agentInstallations.userId,
      })
      .from(agentRuns)
      .innerJoin(agentInstallations, eq(agentInstallations.id, agentRuns.installationId))
      .where(eq(agentRuns.id, id))
      .limit(1);
    if (!run || run.teamId !== ctx.teamId || run.projectId !== ctx.projectId) {
      throw refuse('NOT_FOUND', NOT_IN_REACH('run'), { fields: ['payload.target_id'] });
    }
    if (principal.kind === 'agent' && !(await agentMayUseRun(db, principal, run))) {
      throw refuse('FORBIDDEN', 'An agent may link only its own runs, or a run of the local adapter paired with it.');
    }
    return run.id;
  }
  if (kind === 'assignment' || kind === 'handoff') {
    const handoffKind = kind === 'assignment' ? 'assignment' : 'handoff';
    const [row] = await db
      .select({ id: handoffs.id, teamId: debugSessions.teamId, projectId: debugSessions.projectId })
      .from(handoffs)
      .innerJoin(debugSessions, eq(debugSessions.id, handoffs.sessionId))
      .where(and(eq(handoffs.kind, handoffKind), or(eq(handoffs.id, id), eq(handoffs.sessionId, id))))
      .limit(1);
    if (!row || row.teamId !== ctx.teamId || row.projectId !== ctx.projectId) {
      throw refuse('NOT_FOUND', NOT_IN_REACH(kind), { fields: ['payload.target_id'] });
    }
    return row.id;
  }
  // Knowledge reaches the project when its current published version is for
  // the whole workspace or names this project: the audience rule search and
  // context reads apply, so a link can never point at a record nobody working
  // here would be served.
  const [item] = await db
    .select({ id: knowledgeItems.id })
    .from(knowledgeItems)
    .innerJoin(knowledgeVersions, eq(knowledgeVersions.id, knowledgeItems.currentVersionId))
    .where(
      and(
        eq(knowledgeItems.id, id),
        eq(knowledgeItems.teamId, ctx.teamId),
        eq(knowledgeItems.state, 'active'),
        eq(knowledgeVersions.status, 'published'),
        or(
          eq(knowledgeVersions.audienceType, 'workspace_members'),
          sql`exists (
            select 1 from ${knowledgeAudienceProjects}
            where ${knowledgeAudienceProjects.versionId} = ${knowledgeVersions.id}
              and ${knowledgeAudienceProjects.teamId} = ${ctx.teamId}
              and ${knowledgeAudienceProjects.projectId} = ${ctx.projectId}
          )`,
        ),
      ),
    )
    .limit(1);
  if (!item) throw refuse('NOT_FOUND', NOT_IN_REACH('Knowledge record'), { fields: ['payload.target_id'] });
  return item.id;
}

const targetColumns = (kind: WorkLinkKind, id: string) =>
  kind === 'run'
    ? { runId: id }
    : kind === 'knowledge'
      ? { knowledgeItemId: id }
      : { handoffId: id };

/**
 * A run, an assignment or a handoff belongs to one work at a time (the active
 * partial unique indexes say so too); this answers before the index would, and
 * names the work that already holds it. Knowledge is reference and may serve
 * many works, so only a second link to the same work is refused.
 */
async function assertNotLinked(
  db: Db,
  workId: string,
  kind: WorkLinkKind,
  targetId: string,
  replacing: string | null,
): Promise<void> {
  const column = kind === 'run' ? workLinks.runId : kind === 'knowledge' ? workLinks.knowledgeItemId : workLinks.handoffId;
  const rows = await db
    .select({ id: workLinks.id, workId: workLinks.workId, key: workItems.displayKey })
    .from(workLinks)
    .innerJoin(workItems, eq(workItems.id, workLinks.workId))
    .where(and(eq(column, targetId), isNull(workLinks.supersededAt)));
  const holding = rows.filter((row) => row.id !== replacing && (kind !== 'knowledge' || row.workId === workId));
  const held = holding[0];
  if (!held) return;
  if (held.workId === workId) {
    throw refuse('INVALID_INPUT', `That ${kind} is already linked to this work.`, { fields: ['payload.target_id'] });
  }
  throw refuse(
    'INVALID_INPUT',
    `That ${kind} is already linked to ${held.key}. A ${kind} belongs to one work at a time; correct the earlier link with replaces_link_id.`,
    { fields: ['payload.target_id'] },
  );
}

// ---------------------------------------------------------------------------
// The `link` operation.
// ---------------------------------------------------------------------------

/**
 * Link a run, an assignment, a handoff or a Knowledge record to the work after
 * the fact, or correct an earlier link. A person may link anything in the
 * project; an agent only its own runs. Nothing is pinned (`legacy_unversioned`):
 * the revision a target was working to is known only when a Work flow created it.
 *
 * A correction supersedes the earlier row and names why; it never edits or
 * deletes it, and it needs the old target to be in reach as well as the new
 * one. The earlier link may be on another work of the same project, which is
 * the usual mistake ("this run was for WORK-7, not WORK-6"); that work is
 * locked and told too.
 */
export async function linkTarget(
  tx: Db,
  ctx: WorkOpContext,
  p: WorkCommandOf<'link'>['payload'],
): Promise<WorkOpResult> {
  const { principal, work } = commandParts(ctx);
  if (work.archivedAt) {
    throw refuse('INVALID_TRANSITION', 'Archived work is read-only.', { next_action: 'Reopen it with a reason first.' });
  }
  if (work.state === 'accepted' || work.state === 'cancelled') {
    throw refuse('INVALID_TRANSITION', `${work.displayKey} is ${work.state}; nothing new is linked to closed work.`, {
      next_action: 'Reopen it with a reason first.',
    });
  }
  if (principal.kind === 'agent' && p.kind !== 'run') {
    throw refuse(
      'FORBIDDEN',
      'An agent may link only its own runs. Assignments, handoffs and Knowledge are linked by a person.',
    );
  }
  const targetId = await targetInReach(tx, ctx, principal, p.kind, p.target_id);

  let replaced: typeof workLinks.$inferSelect | undefined;
  if (p.replaces_link_id) {
    if (!p.reason) {
      throw refuse('INVALID_INPUT', 'A correction needs a reason: say why the earlier link was wrong.', {
        fields: ['payload.reason'],
      });
    }
    [replaced] = await tx
      .select()
      .from(workLinks)
      .where(eq(workLinks.id, p.replaces_link_id.toLowerCase()))
      .limit(1);
    if (!replaced || replaced.teamId !== ctx.teamId || replaced.projectId !== ctx.projectId) {
      throw refuse('NOT_FOUND', 'No link with that id is in this work\'s project.', {
        fields: ['payload.replaces_link_id'],
      });
    }
    if (replaced.supersededAt) {
      throw refuse('INVALID_INPUT', 'That link was already superseded; correct the link that replaced it.', {
        fields: ['payload.replaces_link_id'],
      });
    }
    if (principal.kind === 'agent' && replaced.kind !== 'run') {
      throw refuse('FORBIDDEN', 'An agent may correct only the link of one of its own runs.');
    }
    // Same project only, so this lock is taken under the counter like the others.
    if (replaced.workId !== work.id) {
      const from = await ctx.lockWork(replaced.workId);
      if (from.archivedAt) {
        throw refuse('INVALID_TRANSITION', `The earlier link is on ${from.displayKey}, which is archived and read-only.`, {
          next_action: `Reopen ${from.displayKey} with a reason first.`,
        });
      }
    }
    await targetInReach(tx, ctx, principal, replaced.kind as WorkLinkKind, targetOf(replaced));
  }
  await assertNotLinked(tx, work.id, p.kind, targetId, replaced?.id ?? null);

  const linkId = randomUUID();
  if (replaced) {
    // Superseded first and pointed at its replacement after: the active-target
    // unique indexes would otherwise refuse the new row for the same run.
    await tx
      .update(workLinks)
      .set({ supersededAt: ctx.now, correctionReason: p.reason ?? null })
      .where(eq(workLinks.id, replaced.id));
  }
  await tx.insert(workLinks).values({
    id: linkId,
    workId: work.id,
    teamId: ctx.teamId,
    projectId: ctx.projectId,
    kind: p.kind,
    ...targetColumns(p.kind, targetId),
    specRevision: null,
    createdByKind: principal.kind,
    createdById: principalId(principal),
    createdAt: ctx.now,
  });
  if (replaced) {
    await tx.update(workLinks).set({ supersededByLinkId: linkId }).where(eq(workLinks.id, replaced.id));
  }

  const events: WorkEventDraft[] = [
    {
      workId: work.id,
      type: 'work_linked',
      payload: {
        link_id: linkId,
        kind: p.kind,
        target_id: targetId,
        // Named apart from `spec_revision`, which the envelope stamps with the
        // work's own revision on every event.
        pinned_revision: null,
        ...(replaced ? { replaces_link_id: replaced.id, reason: p.reason } : {}),
      },
    },
  ];
  if (replaced && replaced.workId !== work.id) {
    events.push({
      workId: replaced.workId,
      type: 'work_link_superseded',
      payload: { link_id: replaced.id, superseded_by_link_id: linkId, moved_to: work.displayKey, reason: p.reason },
    });
  }
  return {
    events,
    resultRef: linkId,
    response: {
      link_id: linkId,
      kind: p.kind,
      target_id: targetId,
      pinned_revision: null,
      ...(replaced ? { superseded_link_id: replaced.id } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Assigning work to a named agent.
// ---------------------------------------------------------------------------

/**
 * The task line an assignment of this work carries: its key, and only its key.
 * The task is the thread's title, which is the subject of the email the agent's
 * owner is sent, the line in the activity feed, the team webhook's message and
 * the run task of the start_run it pre-fills. The work's title is somebody's
 * text, often an agent's own draft, and none of those may carry it as if STMA
 * wrote it; the agent reads the title with get_work, beside the sentence that
 * says it is data.
 */
export const workTask = (work: WorkItemRow): string => work.displayKey;

const BRIEF_MAX = 8000;

/**
 * The read that answers a work's contract and its criteria. A compact get_work
 * carries the goal cut short and the criteria only as counts, so an agent told
 * to read the criteria with it found no criterion id to report evidence against.
 */
export const workContractRead = (work: Pick<WorkItemRow, 'id'>) => ({
  work_id: work.id,
  view: 'detail',
  sections: ['contract', 'criteria'],
});

/**
 * The brief an assignment carries when the person did not write one: the goal,
 * the criteria the delivery will be judged against, and which contract revision
 * that was. The goal and criteria are somebody's words and stay data; the last
 * line is STMA's own and names nothing but the key, the number and the read.
 */
export function workBrief(work: WorkItemRow, revision: RevisionContent): string {
  const tail = `Work item ${work.displayKey}, contract revision ${work.specRevision}. Read its contract and criteria with get_work ${JSON.stringify(workContractRead(work))} before you start; it is what the work is accepted against.`;
  const lines = [revision.goal.trim(), '', 'Acceptance criteria:'];
  let used = lines.join('\n').length + tail.length + 2;
  let shown = 0;
  for (const criterion of revision.criteria) {
    const line = `- [${criterion.id}] ${criterion.text}${criterion.required ? '' : ' (optional)'}`;
    if (used + line.length + 1 > BRIEF_MAX - 80) break;
    lines.push(line);
    used += line.length + 1;
    shown++;
  }
  if (shown < revision.criteria.length) {
    lines.push(`- ${revision.criteria.length - shown} more in the contract.`);
  }
  lines.push('', tail);
  return lines.join('\n').slice(0, BRIEF_MAX);
}

export interface WorkAssignment {
  created: AssignmentCreated;
  draft: AssignmentDraft;
  linkId: string;
  hookWillAnnounce: boolean;
  events: WorkEventDraft[];
}

/**
 * The part both doors share once the draft exists: the work is executable on
 * the revision the caller read, the handoff allowance is charged, the
 * assignment rows are written and the link pins the revision. Called with the
 * Work locks already held (`runWorkCommand` for the `assign` operation,
 * `mutateWorkInTransaction` inside `assign_work`), so the allowance counter and
 * the assignment rows come after them in both: the same order on every path,
 * which is what keeps the two from deadlocking on each other.
 */
export async function assignWorkInTransaction(
  tx: Db,
  ctx: WorkOpContext,
  input: {
    env: Env;
    team: typeof teams.$inferSelect;
    draft: Omit<AssignmentDraft, 'work'>;
    expectedSpecRevision: number;
    revisionField: string;
  },
): Promise<WorkAssignment> {
  const { principal, work } = commandParts(ctx);
  assertExecutable(work, 'an assignment');
  assertRevision(work, input.expectedSpecRevision, 'assignment', input.revisionField);
  const allowance = await handoffAllowance(tx, input.env, input.team);
  if ('error' in allowance) throw refuse('LIMIT_EXCEEDED', allowance.error);

  const draft: AssignmentDraft = {
    ...input.draft,
    work: { id: work.id, key: work.displayKey, specRevision: work.specRevision },
  };
  const ids = { sessionId: randomUUID(), handoffId: randomUUID() };
  const created = await writeAssignment(tx, input.env, draft, ids);
  const linkId = randomUUID();
  await tx.insert(workLinks).values({
    id: linkId,
    workId: work.id,
    teamId: ctx.teamId,
    projectId: ctx.projectId,
    kind: 'assignment',
    handoffId: ids.handoffId,
    specRevision: work.specRevision,
    createdByKind: principal.kind,
    createdById: principalId(principal),
    createdAt: ctx.now,
  });
  const installationId = draft.agent.installationId;
  const hookWillAnnounce = (await agentsHeardIn(tx, [installationId], ctx.teamId, ctx.projectId)).has(installationId);
  return {
    created,
    draft,
    linkId,
    hookWillAnnounce,
    events: [
      {
        workId: work.id,
        type: 'work_assigned',
        payload: {
          link_id: linkId,
          assignment_id: ids.handoffId,
          session_id: ids.sessionId,
          // The installation by id: its name is somebody's text.
          installation_id: installationId,
          pinned_revision: work.specRevision,
          execution_requested: false,
        },
      },
    ],
  };
}

/**
 * Announce after commit, best effort, exactly as `assign_work` does: a failed
 * webhook or feed line never undoes an assignment that was made.
 */
export function announceWorkAssignment(env: Env, team: typeof teams.$inferSelect, assigned: WorkAssignment) {
  return async (db: Db) => {
    try {
      await announceAssignment(db, env, team, assigned.draft, assigned.created);
    } catch {
      logLine({ evt: 'handoff', a: 'external_notification_failed' });
    }
  };
}

/**
 * The `assign` operation: assign the work to one named agent, pinned to the
 * contract revision the caller read. It creates an assignment and nothing else:
 * `execution_requested` is false, because editing a work record never starts a
 * worker anywhere. The task is the work's key (`workTask`); the brief is the
 * person's, or the contract's goal and criteria when they wrote none.
 */
export async function assignWork(
  tx: Db,
  ctx: WorkOpContext,
  p: WorkCommandOf<'assign'>['payload'],
  picked: { installationId?: string } = {},
): Promise<WorkOpResult> {
  const { principal, work } = commandParts(ctx);
  const env = ctx.env;
  if (!env) throw new Error('The assign operation needs the server environment; pass options.env to updateWork.');
  assertExecutable(work, 'an assignment');
  assertRevision(work, p.expected_spec_revision, 'assignment', 'payload.expected_spec_revision');
  const steps = p.next_steps ?? [];
  const stepRefusal = assignmentStepRefusal(steps);
  if (stepRefusal) throw refuse('INVALID_INPUT', stepRefusal, { fields: ['payload.next_steps'] });

  const [team] = await tx.select().from(teams).where(eq(teams.id, ctx.teamId)).limit(1);
  const [project] = await tx.select().from(projects).where(eq(projects.id, ctx.projectId)).limit(1);
  const [actor] = await tx.select({ username: users.username }).from(users).where(eq(users.id, principal.userId)).limit(1);
  if (!team || !project || !actor) throw refuse('NOT_FOUND', 'No work with that id is visible to this principal.');

  // A pick from the console's list is that installation, looked up among the
  // assignable ones by id; a name from an agent or the API is resolved as
  // `assign_work` resolves it.
  const assignee = picked.installationId
    ? await pickedAssignee(tx, ctx.teamId, picked.installationId)
    : await resolveAssignee(tx, ctx.teamId, p.to_agent, { owner: p.to, device: p.device });
  if ('error' in assignee) throw refuse('INVALID_INPUT', assignee.error, { fields: ['payload.to_agent'] });
  if (assignee.agent.projectId && assignee.agent.projectId !== project.id) {
    throw refuse(
      'INVALID_INPUT',
      `${assignee.agent.name} is connected to one project only, and it is not "${project.name}". Assign it to an agent that can work in this project, or ask ${assignee.agent.owner} to connect the agent to it.`,
      { fields: ['payload.to_agent'] },
    );
  }
  const revision = await loadRevision(tx, work.id, work.specRevision);
  if (!revision) throw new Error(`Work ${work.id} has no revision ${work.specRevision}.`);

  const scope: WorkClaim[] = (p.scope ?? []).map((claim) => ({
    resourceType: claim.type,
    resourceKey: claim.key,
    access: claim.access,
  }));
  const assigned = await assignWorkInTransaction(tx, ctx, {
    env,
    team,
    draft: {
      team: { id: team.id, slug: team.slug },
      project: { id: project.id, name: project.name, repositoryIdentity: project.repositoryIdentity },
      agent: assignee.agent,
      assignedBy: {
        id: principal.userId,
        username: actor.username,
        tokenId: principal.kind === 'agent' ? principal.tokenId : null,
        via: null,
      },
      task: workTask(work),
      brief: p.brief?.trim() ? p.brief : workBrief(work, revision),
      steps,
      branch: p.branch ?? null,
      scope,
    },
    expectedSpecRevision: p.expected_spec_revision,
    revisionField: 'payload.expected_spec_revision',
  });
  return {
    events: assigned.events,
    resultRef: assigned.created.handoffId,
    response: {
      execution_requested: false,
      assignment_id: assigned.created.handoffId,
      session_id: assigned.created.sessionId,
      link_id: assigned.linkId,
      pinned_revision: work.specRevision,
      assigned_to: {
        agent: assignee.agent.name,
        device: assignee.agent.device,
        owner: assignee.agent.owner,
      },
      hook_will_announce: assigned.hookWillAnnounce,
      start_with: assigned.created.startCall,
    },
    afterCommit: announceWorkAssignment(env, team, assigned),
  };
}

/** The assignable agent with this installation id, or why it is not one. */
async function pickedAssignee(tx: Db, teamId: string, installationId: string) {
  const agent = (await assignableAgents(tx, teamId)).find((candidate) => candidate.installationId === installationId);
  return agent
    ? { agent }
    : { error: 'That agent is no longer connected to this workspace, so nothing was assigned. Choose an agent that is.' };
}

// ---------------------------------------------------------------------------
// Runs: linking a run that starts for the work, and reading what is linked.
// ---------------------------------------------------------------------------

/** The work a run start or an assignment names, read without a lock to find its scope. */
export async function workScopeOf(
  db: Db,
  workId: string,
): Promise<{ id: string; teamId: string; projectId: string } | undefined> {
  const [row] = await db
    .select({ id: workItems.id, teamId: workItems.teamId, projectId: workItems.projectId })
    .from(workItems)
    .where(eq(workItems.id, workId.toLowerCase()))
    .limit(1);
  return row;
}

/**
 * Link a run that has just come into existence to the work, pinned to the
 * revision it was started on, inside the transaction that created it. Handed to
 * `mutateWorkInTransaction`, so these are the last locks that transaction takes.
 * A run started for ready work moves it to in progress: that is how work starts
 * when an agent starts it (an agent cannot move work by hand).
 */
export function linkRunToWork(input: {
  runId: string;
  runProjectId: string | null;
  expectedSpecRevision: number;
  via: 'run_start' | 'run_rotation';
  rotatedFrom?: string;
}) {
  return async (tx: Db, ctx: WorkOpContext): Promise<WorkOpResult> => {
    const { principal, work } = commandParts(ctx);
    if (input.runProjectId !== ctx.projectId) {
      throw refuse(
        'INVALID_INPUT',
        `${work.displayKey} is in another project than this run. Start the run in the work's own project.`,
        { fields: ['work_id'] },
      );
    }
    assertExecutable(work, input.via === 'run_start' ? 'a run' : 'a rotated run');
    assertRevision(work, input.expectedSpecRevision, 'run start', 'expected_spec_revision');
    // A rotation keeps the rule too: it is the path built to keep it. Its reach
    // is the agent that accepted, whose own runs and whose adapters' runs are
    // all "this agent", whichever of them the rotated run belonged to.
    await assertNoSecondRun(
      tx,
      work,
      input.runId,
      input.via === 'run_rotation' && principal.kind === 'agent' ? principal.grant.installationId : null,
    );
    const linkId = randomUUID();
    await tx.insert(workLinks).values({
      id: linkId,
      workId: work.id,
      teamId: ctx.teamId,
      projectId: ctx.projectId,
      kind: 'run',
      runId: input.runId,
      specRevision: work.specRevision,
      createdByKind: principal.kind,
      createdById: principalId(principal),
      createdAt: ctx.now,
    });
    const events: WorkEventDraft[] = [
      {
        workId: work.id,
        type: 'work_linked',
        payload: {
          link_id: linkId,
          kind: 'run',
          target_id: input.runId,
          pinned_revision: work.specRevision,
          via: input.via,
          ...(input.rotatedFrom ? { rotated_from: input.rotatedFrom } : {}),
        },
      },
    ];
    let state = work.state;
    if (work.state === 'ready') {
      await tx.update(workItems).set({ state: 'in_progress' }).where(eq(workItems.id, work.id));
      state = 'in_progress';
      events.push({
        workId: work.id,
        type: 'work_state_changed',
        payload: { from: 'ready', to: 'in_progress', via: input.via },
      });
    }
    return {
      events,
      resultRef: linkId,
      response: { link_id: linkId, state, pinned_revision: work.specRevision },
    };
  };
}

/**
 * A run start for work this agent already has a live run linked to is refused:
 * that run is the work's, and a second one beside it is the state a controlled
 * rotation exists to prevent (spec 5.3). It happens when an accept rotated the
 * agent's run and the agent then follows an assignment's start step anyway;
 * the second run would collide with the first and tell the agent the first, its
 * own, has the right of way. "This agent" is the run's installation and any
 * local adapter listening for it, or, when the run is an adapter's, the agent
 * it listens for and every adapter of that agent: the reach a rotation itself has; a rotation
 * names the agent that accepted (`agent`), because the run it rotated may be
 * that agent's adapter's. Parallel attempts opted into with one attempt group
 * in two worktrees stay allowed. Read under the Work lock, so it writes and
 * locks nothing.
 */
async function assertNoSecondRun(tx: Db, work: WorkItemRow, runId: string, agent: string | null = null): Promise<void> {
  const [started] = await tx
    .select({ installationId: agentRuns.installationId, attemptGroup: agentRuns.attemptGroup, worktree: agentRuns.worktree })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  if (!started) return;
  // A start from a local adapter (the hook's carried start) is the agent's
  // start too: counted with the adapter's own runs only, it linked a second
  // run beside the one the agent started for the same work in the same
  // checkout, and the file guard then refused the agent's own edits.
  const reach = agent ?? (await agentListenedForBy(tx, started.installationId)) ?? started.installationId;
  const live = await liveRunOfAgentForWork(tx, work.id, reach, [runId], started);
  if (!live) return;
  throw refuse('INVALID_TRANSITION', `Run ${live.id} of this agent is already linked to ${work.displayKey}; nothing was started.`, {
    fields: ['work_id'],
    next_action: `Send run_id ${live.id} in every call for this work; do not start another run.`,
  });
}

/**
 * A live run of this agent (its own installation, or a local adapter listening
 * for it) linked to the work, other than the runs named in `except`, or
 * undefined. One counts beside `beside` (the run about to be linked) unless the
 * two are parallel attempts opted into with one attempt group in two worktrees.
 * Read-only: the start's and the rotation's answer to "does this agent already
 * have a run for this work", asked where the claim workspace lock already
 * serializes the two against each other.
 */
export async function liveRunOfAgentForWork(
  tx: Db,
  workId: string,
  installationId: string,
  except: readonly string[],
  beside: { attemptGroup: string | null; worktree: string | null } = { attemptGroup: null, worktree: null },
): Promise<{ id: string } | undefined> {
  const others = await tx
    .select({ id: agentRuns.id, attemptGroup: agentRuns.attemptGroup, worktree: agentRuns.worktree })
    .from(workLinks)
    .innerJoin(agentRuns, eq(agentRuns.id, workLinks.runId))
    .innerJoin(agentInstallations, eq(agentInstallations.id, agentRuns.installationId))
    .where(
      and(
        eq(workLinks.workId, workId),
        eq(workLinks.kind, 'run'),
        isNull(workLinks.supersededAt),
        inArray(agentRuns.status, ['starting', 'active', 'waiting', 'blocked']),
        except.length ? notInArray(agentRuns.id, [...except]) : undefined,
        or(eq(agentRuns.installationId, installationId), adapterListeningFor(installationId)),
      ),
    )
    .limit(10);
  const owner = { ownerId: 'self', attemptGroup: beside.attemptGroup, worktree: beside.worktree };
  const live = others.find((other) => !areAttemptSiblings(owner, { ownerId: 'self', attemptGroup: other.attemptGroup, worktree: other.worktree }));
  return live ? { id: live.id } : undefined;
}

/** What a run is linked to now, if anything: the reply to a start replay and the rotation's question. */
export async function activeRunLink(db: Db, runId: string) {
  const [row] = await db
    .select({
      linkId: workLinks.id,
      workId: workLinks.workId,
      specRevision: workLinks.specRevision,
      key: workItems.displayKey,
      state: workItems.state,
      currentRevision: workItems.specRevision,
      version: workItems.version,
      archivedAt: workItems.archivedAt,
    })
    .from(workLinks)
    .innerJoin(workItems, eq(workItems.id, workLinks.workId))
    .where(and(eq(workLinks.runId, runId), isNull(workLinks.supersededAt)))
    .limit(1);
  return row;
}

/**
 * Whether the work a run that ended was linked to still takes a run, so the
 * hook starts the next one for it. Accepted, cancelled and archived work does
 * not: a start for it is refused, and the hook would then tell the agent that
 * finished work had lost its run and to stop and ask its human about nothing.
 */
export const linkCarriesOn = (link: NonNullable<Awaited<ReturnType<typeof activeRunLink>>>): boolean =>
  link.archivedAt === null && (link.state === 'ready' || link.state === 'in_progress');

/** A lifecycle change stops automatic execution without closing the agent's run or assignment. */
export function workStatusWarning(link: Pick<NonNullable<Awaited<ReturnType<typeof activeRunLink>>>, 'workId' | 'key' | 'state' | 'archivedAt'>) {
  if (!link.archivedAt && (link.state === 'ready' || link.state === 'in_progress')) return undefined;
  const detail = link.archivedAt
    ? 'is archived. Stop work on this assignment; the owner must reopen the work before execution continues.'
    : link.state === 'in_review'
      ? 'has a delivery waiting for the acceptor\'s decision. Do not resume execution or submit another delivery just because this assignment is still open.'
      : link.state === 'draft'
        ? 'is a draft. Wait for the owner to make it ready before taking or continuing this assignment.'
        : `is ${link.state}. Stop work on this assignment; the owner must reopen the work before execution continues.`;
  return {
    work_id: link.workId,
    key: link.key,
    state: link.state,
    archived: Boolean(link.archivedAt),
    next_action: `${link.key} ${detail} Read its current status with get_work {"work_id":"${link.workId}"}.`,
  };
}

export function handoffWorkStatus(found: NonNullable<Awaited<ReturnType<typeof workOfHandoff>>>) {
  return workStatusWarning({ workId: found.work.id, key: found.work.displayKey, state: found.work.state, archivedAt: found.work.archivedAt });
}

export async function runWorkStatus(db: Db, runId: string) {
  const link = await activeRunLink(db, runId);
  return link ? workStatusWarning(link) : undefined;
}

/**
 * The work a run of this person that is no longer live was linked to, when that
 * work still takes a run: what the REST heartbeat names beside its 404, so a
 * hook whose run went stale while its human was away starts the next one for
 * the same work instead of one linked to nothing. Only the run's own person is
 * told, and only about a run that has ended; somebody else's run, or one still
 * live, is answered as it always was.
 *
 * Only a run that ended without anybody choosing it carries on: one the
 * presence sweep marked stale, or one the hook closed itself through the REST
 * finish (a branch switch whose answer was lost). A run the agent ended over
 * MCP, with `finish_run` or `handoff_work`, ended the work's run on purpose:
 * carried, the hook started a new run for work the agent had just handed to
 * somebody else and told it to go on with it.
 */
export async function endedRunCarry(db: Db, runId: string, userId: string) {
  if (!isCanonicalUuid(runId)) return undefined;
  const id = runId.toLowerCase();
  const [run] = await db
    .select({ status: agentRuns.status })
    .from(agentRuns)
    .innerJoin(agentInstallations, eq(agentInstallations.id, agentRuns.installationId))
    .where(and(eq(agentRuns.id, id), eq(agentInstallations.userId, userId)))
    .limit(1);
  if (!run || (ACTIVE_AGENT_RUN_STATUSES as readonly string[]).includes(run.status)) return undefined;
  if (run.status !== 'stale' && !(await finishedByHook(db, id))) return undefined;
  const link = await activeRunLink(db, id);
  return link && linkCarriesOn(link) ? link : undefined;
}

/** The run's finish came through the REST run route, never `finish_run` or `handoff_work` (`finishAgentRun`'s `source`). */
async function finishedByHook(db: Db, runId: string): Promise<boolean> {
  const finishes = await db
    .select({ detail: agentEvents.detail })
    .from(agentEvents)
    .where(and(eq(agentEvents.runId, runId), eq(agentEvents.type, 'run_finished')))
    .limit(5);
  return finishes.some((row) => (row.detail as { source?: unknown } | null)?.source === 'rest');
}

/**
 * The warning spec 4.2 owes a run working to an old contract: its link is
 * pinned to a revision the work has moved past. Read on every heartbeat rather
 * than stored, so it stands exactly while it is true; a patch only named the
 * run to the person who made it, and the agent learned of the change from the
 * CONTRACT_CHANGED that refused its delivery an hour later. Only for work that
 * still takes a delivery.
 */
export function contractChangedWarning(
  link: NonNullable<Awaited<ReturnType<typeof activeRunLink>>>,
  working = 'this run was',
) {
  if (link.specRevision === null || link.specRevision >= link.currentRevision || !linkCarriesOn(link)) return undefined;
  return {
    work_id: link.workId,
    key: link.key,
    pinned_revision: link.specRevision,
    spec_revision: link.currentRevision,
    next_action: `The contract of ${link.key} moved from revision ${link.specRevision} to ${link.currentRevision} while ${working} working to it. Read it again with get_work {"work_id":"${link.workId}"} and tell your human before you go on: work done to revision ${link.specRevision} is not delivered as revision ${link.currentRevision} without them.`,
  };
}

/**
 * The same warning for an assignment or handoff taken on an older revision:
 * its accept and resume refuse a moved contract, but work already in progress
 * is told only here and in the hook's announcement.
 */
export function handoffContractChanged(found: NonNullable<Awaited<ReturnType<typeof workOfHandoff>>>) {
  const { link, work } = found;
  return contractChangedWarning(
    {
      linkId: link.id,
      workId: work.id,
      specRevision: link.specRevision,
      key: work.displayKey,
      state: work.state,
      currentRevision: work.specRevision,
      version: work.version,
      archivedAt: work.archivedAt,
    },
    `the ${link.kind === 'assignment' ? 'assignment' : 'handoff'} was`,
  );
}

/** `contractChangedWarning` for a run, or undefined when it is linked to nothing. */
export async function runContractChanged(db: Db, runId: string) {
  const link = await activeRunLink(db, runId);
  return link ? contractChangedWarning(link) : undefined;
}

/** The `work` block of a run start reply. */
export function runWorkReply(link: NonNullable<Awaited<ReturnType<typeof activeRunLink>>>) {
  return {
    work_id: link.workId,
    key: link.key,
    link_id: link.linkId,
    pinned_revision: link.specRevision,
    spec_revision: link.currentRevision,
    state: link.state,
    version: wireBigint(link.version),
  };
}

// ---------------------------------------------------------------------------
// Handoffs and assignments that carry work.
// ---------------------------------------------------------------------------

/** The work an assignment or handoff is filed against, with the revision it was pinned to. */
export async function workOfHandoff(db: Db, handoffId: string) {
  const [row] = await db
    .select({ link: workLinks, work: workItems })
    .from(workLinks)
    .innerJoin(workItems, eq(workItems.id, workLinks.workId))
    .where(
      and(
        eq(workLinks.handoffId, handoffId),
        isNull(workLinks.supersededAt),
        inArray(workLinks.kind, ['assignment', 'handoff']),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Why an agent may not take or begin this work now, or null. Read inside the
 * handoff's own transaction and without a Work lock: it reads two rows and
 * writes nothing, so it takes no lock that a Work transaction could wait on.
 *
 * A contract that moved since the assignment was made is refused on accept and
 * on resume both: the agent would otherwise do the old work and be judged
 * against the new contract. Closed or drafted work is refused for the reason
 * `assertExecutable` gives everywhere else.
 */
export function handoffWorkRefusal(
  found: NonNullable<Awaited<ReturnType<typeof workOfHandoff>>>,
  kind: string,
): { error: string; code: WorkErrorCode } | null {
  const { link, work } = found;
  const named = kind === 'assignment' ? 'assignment' : 'handoff';
  try {
    assertExecutable(work, `taking this ${named}`);
  } catch (error) {
    const refusal = (error as { error?: WorkRefusalError }).error;
    if (!refusal) throw error;
    return { error: `${workRefusalText(refusal)} Tell your human; do not start it.`, code: refusal.code };
  }
  if (link.specRevision !== null && link.specRevision !== work.specRevision) {
    return {
      code: 'CONTRACT_CHANGED',
      error: `CONTRACT_CHANGED: this ${named} was made for ${work.displayKey} at contract revision ${link.specRevision}, and the contract is now at revision ${work.specRevision}. Do not start it on the old contract: ask whoever sent it to cancel this ${named} and assign the work again at revision ${work.specRevision}.`,
    };
  }
  return null;
}
