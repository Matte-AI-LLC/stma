import { ACTIVE_AGENT_RUN_STATUSES } from '@bridge/shared';
import { and, desc, eq, inArray, isNotNull, or } from 'drizzle-orm';
import type { Db } from '../db';
import { agentInstallations, agentRuns, debugSessions, handoffs, projects, workClaims } from '../db/schema';
import { assignableAgents, type AssignableAgent } from './assignments';
import { RELEASED_CLAIM } from './agents';

/**
 * Who has which agent, and what each one is doing.
 *
 * The question the owner could not answer on 2026-09-20 with four agents at
 * work: "I cannot even see what my own agents did." Everything it needs was
 * already stored — identities, runs, the work dispatched to each agent, the
 * ground each run holds — and had no reader that put it beside the agent. This
 * is that reader, and it writes nothing. The workspace page groups it by
 * person; a project's Agents page narrows it to the agents that can work there.
 */
export interface RosterEntry {
  agent: AssignableAgent;
  /** How far the agent's credential reaches: this is what "connected to a project" means. */
  reach: 'project' | 'workspace';
  /** The project its credential is bound to, when it is bound to one. */
  boundProject: { id: string; slug: string; name: string } | null;
  /** Its live run, wherever in the workspace that is. */
  live: {
    runId: string;
    name: string | null;
    status: string;
    branch: string | null;
    project: { id: string; slug: string; name: string } | null;
    lastHeartbeatAt: Date;
    holding: number;
  } | null;
  /** Work dispatched to it, or accepted by it, that is not finished. */
  work: { sessionId: string; title: string; state: string; kind: string; projectId: string | null }[];
  /** The newest run it ended. */
  last: { runId: string; name: string | null; status: string; endedAt: Date | null; project: { slug: string; name: string } | null } | null;
}

const PENDING = ['offered', 'accepted', 'in_progress', 'needs_attention'];
/** Newest ended runs read to find one per agent; bounded, like every list here. */
const ENDED_SCAN = 400;

export async function agentRoster(
  db: Db,
  teamId: string,
  scope: { projectId?: string } = {},
): Promise<RosterEntry[]> {
  const everyone = await assignableAgents(db, teamId);
  // Inside a project: the agents whose credential can work there. One bound to
  // another project cannot, and listing it would offer what the server refuses.
  const agents = scope.projectId
    ? everyone.filter((agent) => agent.projectId === null || agent.projectId === scope.projectId)
    : everyone;
  if (agents.length === 0) return [];
  const ids = agents.map((agent) => agent.installationId);

  const projectRows = await db
    .select({ id: projects.id, slug: projects.slug, name: projects.name })
    .from(projects)
    .where(eq(projects.teamId, teamId));
  const projectById = new Map(projectRows.map((row) => [row.id, row]));
  const named = (id: string | null) => (id ? (projectById.get(id) ?? null) : null);

  const liveRows = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.teamId, teamId),
        inArray(agentRuns.installationId, ids),
        inArray(agentRuns.status, [...ACTIVE_AGENT_RUN_STATUSES]),
      ),
    )
    .orderBy(desc(agentRuns.lastHeartbeatAt));
  // In a project, the run that matters is the one in that project; elsewhere the newest.
  const liveBy = new Map<string, (typeof liveRows)[number]>();
  for (const run of liveRows) {
    const known = liveBy.get(run.installationId);
    if (!known || (scope.projectId && run.projectId === scope.projectId && known.projectId !== scope.projectId)) {
      liveBy.set(run.installationId, run);
    }
  }
  const liveIds = [...liveBy.values()].map((run) => run.id);
  const held = liveIds.length
    ? await db
        .select({ runId: workClaims.runId, source: workClaims.source, leaseExpiresAt: workClaims.leaseExpiresAt })
        .from(workClaims)
        .where(inArray(workClaims.runId, liveIds))
    : [];
  const holding = new Map<string, number>();
  const now = Date.now();
  for (const claim of held) {
    if (claim.source === RELEASED_CLAIM || claim.leaseExpiresAt.getTime() <= now) continue;
    holding.set(claim.runId, (holding.get(claim.runId) ?? 0) + 1);
  }

  const endedRows = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.teamId, teamId),
        inArray(agentRuns.installationId, ids),
        isNotNull(agentRuns.endedAt),
        scope.projectId ? eq(agentRuns.projectId, scope.projectId) : undefined,
      ),
    )
    .orderBy(desc(agentRuns.endedAt))
    .limit(ENDED_SCAN);
  const lastBy = new Map<string, (typeof endedRows)[number]>();
  for (const run of endedRows) if (!lastBy.has(run.installationId)) lastBy.set(run.installationId, run);

  const workRows = await db
    .select({
      sessionId: handoffs.sessionId,
      state: handoffs.state,
      kind: handoffs.kind,
      target: handoffs.targetInstallationId,
      acceptor: handoffs.installationId,
      title: debugSessions.title,
      projectId: debugSessions.projectId,
    })
    .from(handoffs)
    .innerJoin(debugSessions, eq(debugSessions.id, handoffs.sessionId))
    .where(
      and(
        eq(debugSessions.teamId, teamId),
        inArray(handoffs.state, PENDING),
        or(inArray(handoffs.targetInstallationId, ids), inArray(handoffs.installationId, ids)),
        scope.projectId ? eq(debugSessions.projectId, scope.projectId) : undefined,
      ),
    )
    .orderBy(desc(handoffs.updatedAt))
    .limit(200);

  return agents.map((agent) => {
    const live = liveBy.get(agent.installationId);
    const last = lastBy.get(agent.installationId);
    return {
      agent,
      reach: agent.projectId ? 'project' : 'workspace',
      boundProject: named(agent.projectId),
      live: live
        ? {
            runId: live.id,
            name: live.taskKey ?? live.intent,
            status: live.status,
            branch: live.branch,
            project: named(live.projectId),
            lastHeartbeatAt: live.lastHeartbeatAt,
            holding: holding.get(live.id) ?? 0,
          }
        : null,
      work: workRows
        .filter((row) => row.target === agent.installationId || row.acceptor === agent.installationId)
        .map((row) => ({ sessionId: row.sessionId, title: row.title, state: row.state, kind: row.kind, projectId: row.projectId })),
      last: last
        ? {
            runId: last.id,
            name: last.taskKey ?? last.intent,
            status: last.status,
            endedAt: last.endedAt,
            project: named(last.projectId),
          }
        : null,
    };
  });
}

/** A person's page shows a window, not a history: the log is on Activity. */
const PERSON_RUNS = 12;
const PERSON_WORK = 12;

/**
 * The runs one person's agents have here — live first, then the newest ended.
 *
 * `agentRoster` answers "what is this agent doing", one row per agent, which is
 * the question the roster table asks. A person works through several agents and
 * a run is the unit of work, so their page asks the other question: what has run
 * in this workspace under this name. Same tables, same bounds, and every row
 * links to the agent map, which owns a run's detail.
 */
export async function runsForPerson(
  db: Db,
  teamId: string,
  userId: string,
  limit = PERSON_RUNS,
): Promise<
  {
    runId: string;
    name: string | null;
    status: string;
    branch: string | null;
    agent: string | null;
    project: { slug: string; name: string } | null;
    lastHeartbeatAt: Date;
    endedAt: Date | null;
    live: boolean;
  }[]
> {
  const rows = await db
    .select({
      run: agentRuns,
      agent: agentInstallations.name,
      projectSlug: projects.slug,
      projectName: projects.name,
    })
    .from(agentRuns)
    .innerJoin(agentInstallations, eq(agentInstallations.id, agentRuns.installationId))
    .leftJoin(projects, eq(projects.id, agentRuns.projectId))
    .where(and(eq(agentRuns.teamId, teamId), eq(agentInstallations.userId, userId)))
    .orderBy(desc(agentRuns.lastHeartbeatAt))
    .limit(limit * 4);
  // A live run has heartbeated within the lease, so the clock already puts it
  // near the top; this makes that a guarantee rather than an assumption, because
  // what is running now is the thing somebody came here to see.
  const live = (status: string) => (ACTIVE_AGENT_RUN_STATUSES as readonly string[]).includes(status);
  return rows
    .sort((a, b) => Number(live(b.run.status)) - Number(live(a.run.status)))
    .slice(0, limit)
    .map((row) => ({
      runId: row.run.id,
      name: row.run.taskKey ?? row.run.intent,
      status: row.run.status,
      branch: row.run.branch,
      agent: row.agent,
      project: row.projectSlug ? { slug: row.projectSlug, name: row.projectName! } : null,
      lastHeartbeatAt: row.run.lastHeartbeatAt,
      endedAt: row.run.endedAt,
      live: live(row.run.status),
    }));
}

/**
 * Work this person dispatched, was given, or accepted — in this workspace.
 *
 * Four columns can name them and all four are asked, because "what has this
 * person been doing" is not answered by one of them: a lead who only ever
 * assigns would show an empty card if the query looked at the receiving end,
 * and an agent's owner would show one if it looked at `offered_by`. The row
 * says which it was, so the two are never conflated.
 */
export async function workForPerson(
  db: Db,
  teamId: string,
  userId: string,
  installationIds: string[],
  limit = PERSON_WORK,
): Promise<
  {
    sessionId: string;
    title: string;
    kind: string;
    state: string;
    side: 'sent' | 'received';
    agent: string | null;
    project: string | null;
    updatedAt: Date;
  }[]
> {
  const mine = installationIds.length ? inArray(handoffs.targetInstallationId, installationIds) : undefined;
  const accepted = installationIds.length ? inArray(handoffs.installationId, installationIds) : undefined;
  const rows = await db
    .select({
      offer: handoffs,
      title: debugSessions.title,
      projectName: projects.name,
      agent: agentInstallations.name,
    })
    .from(handoffs)
    .innerJoin(debugSessions, eq(debugSessions.id, handoffs.sessionId))
    .leftJoin(projects, eq(projects.id, debugSessions.projectId))
    .leftJoin(agentInstallations, eq(agentInstallations.id, handoffs.targetInstallationId))
    .where(
      and(
        eq(debugSessions.teamId, teamId),
        or(
          eq(handoffs.offeredBy, userId),
          eq(handoffs.targetUserId, userId),
          eq(handoffs.acceptedBy, userId),
          mine,
          accepted,
        ),
      ),
    )
    .orderBy(desc(handoffs.updatedAt))
    .limit(limit);
  return rows.map((row) => ({
    sessionId: row.offer.sessionId,
    title: row.title,
    kind: row.offer.kind,
    state: row.offer.state,
    // Dispatched by them is "sent" even when they later accepted it themselves:
    // it is their own machine's work, and the page says so rather than listing
    // one brief twice.
    side: row.offer.offeredBy === userId ? 'sent' : 'received',
    agent: row.agent,
    project: row.projectName,
    updatedAt: row.offer.updatedAt,
  }));
}

/** The roster grouped by the person who owns each agent, people with live work first. */
export function rosterByPerson(entries: RosterEntry[]) {
  const people = new Map<string, { owner: string; entries: RosterEntry[] }>();
  for (const entry of entries) {
    const person = people.get(entry.agent.ownerId) ?? { owner: entry.agent.owner, entries: [] };
    person.entries.push(entry);
    people.set(entry.agent.ownerId, person);
  }
  return [...people.values()].sort(
    (a, b) =>
      Number(b.entries.some((entry) => entry.live)) - Number(a.entries.some((entry) => entry.live)) ||
      a.owner.localeCompare(b.owner),
  );
}

