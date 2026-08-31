import { ACTIVE_AGENT_RUN_STATUSES } from '@bridge/shared';
import { and, count, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../db';
import {
  agentRuns,
  debugSessions,
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
}

/** How many teams the rail's switcher lists before it defers to /app. */
const RAIL_TEAMS = 8;

export const EMPTY_RAIL: RailCounts = {
  runs: 0,
  sessions: 0,
  drift: 0,
  team: null,
  role: null,
  teams: 0,
  projects: 0,
  list: [],
};

/**
 * Fill in the counts for a response that renders the console outside the GET
 * path. `sessionUser` computes them for page loads only, because a redirecting
 * POST never draws chrome — but a POST that renders one would otherwise show
 * EMPTY_RAIL, which does not read as "not computed", it reads as "you have no
 * team". Any route that answers a POST with a page calls this first.
 */
export async function ensureRail(db: Db, user: { id: string; rail?: RailCounts }): Promise<void> {
  if (!user.rail) user.rail = await railFor(db, user.id);
}

export async function railFor(db: Db, userId: string): Promise<RailCounts> {
  const mine = await db
    .select({ id: teams.id, slug: teams.slug, name: teams.name, role: memberships.role })
    .from(memberships)
    .innerJoin(teams, eq(memberships.teamId, teams.id))
    .where(eq(memberships.userId, userId))
    .orderBy(desc(teams.createdAt));
  if (mine.length === 0) return EMPTY_RAIL;
  const ids = mine.map((t) => t.id);

  const runs = await db
    .select({ n: count() })
    .from(agentRuns)
    .where(
      and(
        inArray(agentRuns.teamId, ids),
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
        inArray(debugSessions.teamId, ids),
        eq(debugSessions.status, 'open'),
        or(
          isNull(messages.authorId),
          ne(messages.authorId, userId),
          isNotNull(messages.tokenId),
        ),
        or(isNull(readState.lastReadAt), gt(messages.createdAt, readState.lastReadAt)),
      ),
    );

  // Runs whose agent reported a policy hash other than the one the server served.
  const drift = await db
    .select({ n: count() })
    .from(policyReceipts)
    .innerJoin(agentRuns, eq(policyReceipts.runId, agentRuns.id))
    .where(and(inArray(agentRuns.teamId, ids), eq(policyReceipts.drift, true)));

  // Projects in the team the rail points at, not across every team: the badge
  // has to agree with the page behind the link, and that page is team-scoped.
  const projects = mine[0]
    ? await db.select({ n: count() }).from(projectsTable).where(eq(projectsTable.teamId, mine[0].id))
    : [];

  return {
    runs: runs[0]?.n ?? 0,
    sessions: Number(unread[0]?.n ?? 0),
    drift: drift[0]?.n ?? 0,
    team: mine[0]?.slug ?? null,
    role: mine[0]?.role ?? null,
    teams: mine.length,
    projects: projects[0]?.n ?? 0,
    // Bounded: somebody in thirty teams gets the newest few and the picker.
    list: mine.slice(0, RAIL_TEAMS).map((t) => ({ slug: t.slug, name: t.name, role: t.role })),
  };
}
