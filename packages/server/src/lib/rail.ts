import { membershipUser } from './securityHooks';
import { ACTIVE_AGENT_RUN_STATUSES } from '@bridge/shared';
import { and, count, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { projectForTeam } from '../domain/access';
import {
  agentRuns,
  debugSessions,
  handoffs,
  memberships,
  messages,
  policyReceipts,
  projects as projectsTable,
  readState,
  teams,
} from '../db/schema';

/**
 * The numbers on the navigation rail.
 *
 * A badge that appears on some pages and not others reads as broken, so these
 * are computed once per signed-in page render rather than by whichever route
 * happens to have the data in hand. Four bounded counts against indexed
 * predicates; nothing here scans a team's history.
 *
 * They are also the console's claim about itself: the rail says three runs and
 * one drift, and the pages behind those links must agree.
 */
export interface RailCounts {
  runs: number;
  sessions: number;
  drift: number;
  /** Team the rail's team-scoped links point at: the only one, or the newest. */
  team: string | null;
  /** Your role in that team — the rail is also where you check your own authority. */
  role: string | null;
  teams: number;
  /** Projects in the rail's team — the badge on the new Projects destination. */
  projects: number;
  /**
   * The teams the switcher offers, newest first and bounded.
   *
   * Free, in query terms: `railFor` already reads every membership to work out
   * which team the rail points at. A switcher that has to ask a second question
   * to draw itself would be a switcher that appears late.
   */
  list: { slug: string; name: string; role: string }[];
  /**
   * The project the page is inside, when it is inside one. The console has two
   * scopes below the account, workspace and project, and the rail lists the
   * sections of whichever one the page belongs to. Null means workspace scope.
   */
  project: { id: string; slug: string; name: string } | null;
  /**
   * Which of the three scopes the page is in. `account` is a page about the person
   * rather than about a workspace — the workspace list, their account, their own
   * connections, the guide — and there the rail lists workspaces, not the sections
   * of whichever workspace happens to be newest. `team` is still filled in that
   * case: it is the workspace a bare link would open, never a claim about the page.
   */
  scope: 'account' | 'workspace' | 'project';
  /** The projects the scope bar's picker offers: the current one, then the newest, bounded. */
  projectList: { slug: string; name: string }[];
}

/** How many teams the rail's switcher lists before it defers to /app. */
const RAIL_TEAMS = 8;
/** How many projects the scope bar's picker lists before it defers to the Projects page. */
const RAIL_PROJECTS = 12;

/** What is going on in one workspace, for the list of all of them. */
export interface WorkspaceCounters {
  runs: number;
  unread: number;
  work: number;
}

/**
 * The counters beside each workspace on "All workspaces".
 *
 * The rail used to offer an agent map, a work list and a sessions list "across
 * workspaces": every workspace poured into one ledger, which answered "is
 * anything happening anywhere" and made every row ambiguous about where. The
 * list of workspaces answers the same question without the mixing — a number
 * per workspace, each a link into that workspace's own page. Same predicates as
 * the rail's badges (live runs; open sessions holding something this browser
 * has not read), grouped by team; work is a dispatched handoff nobody finished.
 * The caller passes teams it has already membership-checked.
 */
export async function workspaceCounters(db: Db, userId: string, teamIds: string[]) {
  const out = new Map<string, WorkspaceCounters>();
  if (teamIds.length === 0) return out;
  const at = (teamId: string) => {
    let row = out.get(teamId);
    if (!row) out.set(teamId, (row = { runs: 0, unread: 0, work: 0 }));
    return row;
  };
  const runs = await db
    .select({ teamId: agentRuns.teamId, n: count() })
    .from(agentRuns)
    .where(and(inArray(agentRuns.teamId, teamIds), inArray(agentRuns.status, [...ACTIVE_AGENT_RUN_STATUSES])))
    .groupBy(agentRuns.teamId);
  for (const row of runs) at(row.teamId).runs = Number(row.n);
  const unread = await db
    .select({ teamId: debugSessions.teamId, n: sql<number>`count(distinct ${debugSessions.id})` })
    .from(debugSessions)
    .innerJoin(messages, eq(messages.sessionId, debugSessions.id))
    .leftJoin(readState, and(eq(readState.sessionId, debugSessions.id), eq(readState.userId, userId)))
    .where(
      and(
        inArray(debugSessions.teamId, teamIds),
        eq(debugSessions.status, 'open'),
        or(isNull(messages.authorId), ne(messages.authorId, userId), isNotNull(messages.tokenId)),
        or(isNull(readState.lastReadAt), gt(messages.createdAt, readState.lastReadAt)),
      ),
    )
    .groupBy(debugSessions.teamId);
  for (const row of unread) at(row.teamId).unread = Number(row.n);
  const work = await db
    .select({ teamId: debugSessions.teamId, n: count() })
    .from(handoffs)
    // A handoff has no team of its own: it belongs to the workspace of the thread that carries it.
    .innerJoin(debugSessions, eq(handoffs.sessionId, debugSessions.id))
    .where(and(inArray(debugSessions.teamId, teamIds), inArray(handoffs.state, ['offered', 'accepted', 'in_progress', 'needs_attention'])))
    .groupBy(debugSessions.teamId);
  for (const row of work) at(row.teamId).work = Number(row.n);
  return out;
}

export const EMPTY_RAIL: RailCounts = {
  runs: 0,
  sessions: 0,
  drift: 0,
  team: null,
  role: null,
  teams: 0,
  projects: 0,
  list: [],
  project: null,
  projectList: [],
  scope: 'account',
};

/**
 * Fill in the counts for a response that renders the console outside the GET
 * path. `sessionUser` computes them for page loads only, because a redirecting
 * POST never draws chrome — but a POST that renders one would otherwise show
 * EMPTY_RAIL, which does not read as "not computed", it reads as "you have no
 * team". Any route that answers a POST with a page calls this first.
 */
export async function ensureRail(
  db: Db,
  user: { id: string; rail?: RailCounts },
  preferredTeamSlug?: string,
  preferredProject?: string | null,
): Promise<void> {
  // A page whose address names neither its workspace nor its project (a thread,
  // say) knows both once it has loaded its record, and says so here: otherwise
  // the scope bar would show whichever workspace is newest.
  const wrongTeam = Boolean(preferredTeamSlug) && user.rail?.team !== preferredTeamSlug;
  const wrongProject =
    preferredProject !== undefined &&
    (user.rail?.project?.slug ?? null) !== (preferredProject ?? null) &&
    (user.rail?.project?.id ?? null) !== (preferredProject ?? null);
  if (!user.rail || wrongTeam || wrongProject) {
    user.rail = await railFor(db, user.id, preferredTeamSlug ?? user.rail?.team ?? undefined, preferredProject ?? undefined);
  }
}

export async function railFor(
  db: Db,
  userId: string,
  preferredTeamSlug?: string,
  preferredProject?: string,
): Promise<RailCounts> {
  const mine = await db
    .select({ id: teams.id, slug: teams.slug, name: teams.name, role: memberships.role })
    .from(memberships)
    .innerJoin(teams, eq(memberships.teamId, teams.id))
    .where(membershipUser(userId))
    .orderBy(desc(teams.createdAt));
  if (mine.length === 0) return EMPTY_RAIL;
  const named = mine.find((team) => team.slug === preferredTeamSlug);
  const current = named ?? mine[0]!;
  const ids = mine.map((t) => t.id);
  // Keep the current team visible even when a user has more memberships than
  // the bounded switcher can render.
  const ordered = [current, ...mine.filter((team) => team.id !== current.id)];
  // Only within the current workspace: a project named in the address of another
  // workspace is not a scope, it is a mistake, and the rail stays at workspace level.
  const inside = preferredProject ? await projectForTeam(db, current.id, preferredProject) : undefined;
  const project = named && inside ? { id: inside.id, slug: inside.slug, name: inside.name } : null;
  const scope: RailCounts['scope'] = project ? 'project' : named ? 'workspace' : 'account';

  const runs = await db
    .select({ n: count() })
    .from(agentRuns)
    .where(
      and(
        scope === 'account' ? inArray(agentRuns.teamId, ids) : eq(agentRuns.teamId, current.id),
        project ? eq(agentRuns.projectId, project.id) : undefined,
        inArray(agentRuns.status, [...ACTIVE_AGENT_RUN_STATUSES]),
      ),
    );

  // Open sessions in my teams holding a message I have not read and did not
  // write *here*. A browser is an origin with no token, so a message one of my
  // own agents posted from one of my own machines counts — I have not read it,
  // and it is the surface where I would find out.
  const unread = await db
    .select({ n: sql<number>`count(distinct ${debugSessions.id})` })
    .from(debugSessions)
    .innerJoin(messages, eq(messages.sessionId, debugSessions.id))
    .leftJoin(
      readState,
      and(eq(readState.sessionId, debugSessions.id), eq(readState.userId, userId)),
    )
    .where(
      and(
        scope === 'account' ? inArray(debugSessions.teamId, ids) : eq(debugSessions.teamId, current.id),
        project ? eq(debugSessions.projectId, project.id) : undefined,
        eq(debugSessions.status, 'open'),
        or(
          isNull(messages.authorId),
          ne(messages.authorId, userId),
          isNotNull(messages.tokenId),
        ),
        or(isNull(readState.lastReadAt), gt(messages.createdAt, readState.lastReadAt)),
      ),
    );

  // Runs in the current team whose agent reported a policy hash other than the
  // one the server served. Governance is team-scoped, so its badge must count
  // the same scope as the page behind it.
  const drift = await db
    .select({ n: count() })
    .from(policyReceipts)
    .innerJoin(agentRuns, eq(policyReceipts.runId, agentRuns.id))
    .where(and(eq(agentRuns.teamId, current.id), eq(policyReceipts.drift, true)));

  // Projects in the team the rail points at, not across every team: the badge
  // has to agree with the page behind the link, and that page is team-scoped.
  const projects = await db
    .select({ n: count() })
    .from(projectsTable)
    .where(eq(projectsTable.teamId, current.id));
  // The picker's list: the project the page is inside first, then the newest.
  const newest = await db
    .select({ id: projectsTable.id, slug: projectsTable.slug, name: projectsTable.name })
    .from(projectsTable)
    .where(eq(projectsTable.teamId, current.id))
    .orderBy(desc(projectsTable.createdAt))
    .limit(RAIL_PROJECTS);
  const projectList = [
    ...(project ? [{ slug: project.slug, name: project.name }] : []),
    ...newest.filter((row) => row.slug !== project?.slug).map((row) => ({ slug: row.slug, name: row.name })),
  ].slice(0, RAIL_PROJECTS);

  return {
    runs: runs[0]?.n ?? 0,
    sessions: Number(unread[0]?.n ?? 0),
    drift: drift[0]?.n ?? 0,
    team: current.slug,
    role: current.role,
    teams: mine.length,
    projects: projects[0]?.n ?? 0,
    // Bounded: somebody in thirty teams gets the newest few and the picker.
    list: ordered.slice(0, RAIL_TEAMS).map((t) => ({ slug: t.slug, name: t.name, role: t.role })),
    project,
    projectList,
    scope,
  };
}
