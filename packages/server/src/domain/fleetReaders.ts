import { ACTIVE_AGENT_RUN_STATUSES } from '@bridge/shared';
import { and, desc, eq, gt, inArray, isNull, lt } from 'drizzle-orm';
import type { Db } from '../db';
import {
  agentEvents,
  agentInstallations,
  agentRuns,
  memberships,
  projects,
  teams,
  users,
  workClaims,
} from '../db/schema';
import { membershipUser } from '../lib/securityHooks';
import { companionInstallations } from './companions';

/**
 * What the console reads about the fleet, and no agent ever does.
 *
 * These lived in `domain/agents.ts` until 2026-09-20. That file is on the
 * agents acceptance surface (`acceptance/tiers.json`): a change to it owes a
 * round with real agents, which costs model usage. A filter added to the agent
 * map's history reader therefore owed a lab round that could prove nothing
 * about it — the lab never opens a page. A surface file holds what agents
 * meet: runs, claims, conflicts, stale ground. What only a person's browser
 * reads is here, and `acceptance/owed.test.mjs` keeps MCP and hook code from
 * importing this module, so it cannot quietly become agent-facing.
 *
 * Every reader is bounded and membership-filtered exactly as before the move.
 */
const ACTIVE = [...ACTIVE_AGENT_RUN_STATUSES];

/**
 * Durable installations visible to a member: all of their own registrations,
 * plus installations with run history in a team they currently belong to.
 * Run context is filtered through those memberships, so an agent used in two
 * unrelated teams never leaks the other team's task or project.
 */
export async function installationsForMember(db: Db, userId: string, limit = 200) {
  const own = await db
    .select({ id: agentInstallations.id })
    .from(agentInstallations)
    .where(eq(agentInstallations.userId, userId))
    .orderBy(desc(agentInstallations.lastSeenAt))
    .limit(limit);
  const shared = await db
    .selectDistinct({ id: agentRuns.installationId })
    .from(agentRuns)
    .innerJoin(memberships, eq(agentRuns.teamId, memberships.teamId))
    .where(membershipUser(userId))
    .limit(limit);
  const ids = [
    ...new Set([...own.map((row) => row.id), ...shared.map((row) => row.id)]),
  ].slice(0, limit);
  if (ids.length === 0) return [];

  const installations = await db
    .select({ installation: agentInstallations, owner: users })
    .from(agentInstallations)
    .innerJoin(users, eq(agentInstallations.userId, users.id))
    .where(inArray(agentInstallations.id, ids))
    .orderBy(desc(agentInstallations.lastSeenAt));
  const runRows = await db
    .select({
      run: agentRuns,
      team: teams,
      projectName: projects.name,
    })
    .from(agentRuns)
    .innerJoin(teams, eq(agentRuns.teamId, teams.id))
    .innerJoin(memberships, eq(agentRuns.teamId, memberships.teamId))
    .leftJoin(projects, eq(agentRuns.projectId, projects.id))
    .where(
      and(membershipUser(userId), inArray(agentRuns.installationId, ids)),
    )
    .orderBy(desc(agentRuns.lastHeartbeatAt))
    .limit(limit * 10);

  const latest = new Map<string, (typeof runRows)[number]>();
  const active = new Map<string, (typeof runRows)[number]>();
  for (const row of runRows) {
    if (!latest.has(row.run.installationId)) latest.set(row.run.installationId, row);
    if (
      ACTIVE.includes(row.run.status as (typeof ACTIVE)[number]) &&
      !active.has(row.run.installationId)
    ) {
      active.set(row.run.installationId, row);
    }
  }
  return installations.map((row) => ({
    ...row,
    latestRun: latest.get(row.installation.id) ?? null,
    activeRun: active.get(row.installation.id) ?? null,
  }));
}

/** How far back the agent map remembers an agent that is not working right now. */
export const RECENT_RUN_HOURS = 24;

/** Bounded like the rest of the map: a window onto the last day, not a history page. */
const RECENT_RUNS = 8;

/**
 * The newest ended run of each agent that has no live one, within the last day.
 *
 * The map is presence, and presence alone made it forget: the moment a session
 * closed its agent left the page, and with it any sign of what it had just done
 * (asked for in the two-device round, 2026-09-19). Same row shape as
 * `activeRunsForMember`, so the page draws both with one renderer — faded.
 */
export async function recentRunsForMember(
  db: Db,
  userId: string,
  liveInstallationIds: string[],
  teamSlug?: string,
  projectId?: string,
) {
  const since = new Date(Date.now() - RECENT_RUN_HOURS * 3_600_000);
  const rows = await db
    .select({
      run: agentRuns,
      installation: agentInstallations,
      owner: users,
      team: teams,
      projectName: projects.name,
    })
    .from(agentRuns)
    .innerJoin(agentInstallations, eq(agentRuns.installationId, agentInstallations.id))
    .innerJoin(users, eq(agentInstallations.userId, users.id))
    .innerJoin(teams, eq(agentRuns.teamId, teams.id))
    .innerJoin(memberships, eq(memberships.teamId, teams.id))
    .leftJoin(projects, eq(agentRuns.projectId, projects.id))
    .where(
      and(
        membershipUser(userId),
        inArray(agentRuns.status, ['completed', 'failed', 'stale']),
        gt(agentRuns.endedAt, since),
        isNull(agentInstallations.revokedAt),
        teamSlug ? eq(teams.slug, teamSlug) : undefined,
        projectId ? eq(agentRuns.projectId, projectId) : undefined,
      ),
    )
    .orderBy(desc(agentRuns.endedAt))
    .limit(RECENT_RUNS * 6);
  const seen = new Set(liveInstallationIds);
  const newest: typeof rows = [];
  for (const row of rows) {
    if (seen.has(row.installation.id)) continue;
    seen.add(row.installation.id);
    newest.push(row);
    if (newest.length === RECENT_RUNS) break;
  }
  return newest;
}

/**
 * Ground these runs held and no longer hold: what completed work let go of, and
 * everything an ended run had. `lease_expires_at` is when it stopped being held.
 */
export async function pastGroundForRuns(db: Db, runIds: string[]) {
  if (runIds.length === 0) return [];
  return db
    .select()
    .from(workClaims)
    .where(and(inArray(workClaims.runId, runIds), lt(workClaims.leaseExpiresAt, new Date())))
    .orderBy(desc(workClaims.leaseExpiresAt))
    .limit(200);
}

/**
 * The append-only run trail for one team, newest first. Bounded by `limit` and by
 * the team filter — the timeline on the governance page is a window, not a scan.
 *
 * A hooked checkout's runs belong to its local adapter. `companionName` is the
 * agent that adapter is paired with now, so the timeline can name the agent a
 * lead knows and still say the adapter reported it.
 */
export async function recentAgentEvents(db: Db, teamId: string, limit = 50, projectId?: string) {
  return db
    .select({
      event: agentEvents,
      run: agentRuns,
      agentName: agentInstallations.name,
      companionName: companionInstallations.name,
      owner: users.username,
      projectName: projects.name,
    })
    .from(agentEvents)
    .innerJoin(agentRuns, eq(agentEvents.runId, agentRuns.id))
    .innerJoin(agentInstallations, eq(agentRuns.installationId, agentInstallations.id))
    .leftJoin(companionInstallations, eq(companionInstallations.id, agentInstallations.companionOf))
    .innerJoin(users, eq(agentInstallations.userId, users.id))
    .leftJoin(projects, eq(agentRuns.projectId, projects.id))
    .where(
      and(
        eq(agentRuns.teamId, teamId),
        projectId ? eq(agentRuns.projectId, projectId) : undefined,
      ),
    )
    .orderBy(desc(agentEvents.createdAt))
    .limit(limit);
}

/** The append-only trail of ONE run, newest first — what the inspector shows. */
export async function eventsForRun(db: Db, runId: string, limit = 12) {
  return db
    .select({ type: agentEvents.type, detail: agentEvents.detail, at: agentEvents.createdAt })
    .from(agentEvents)
    .where(eq(agentEvents.runId, runId))
    .orderBy(desc(agentEvents.createdAt))
    .limit(limit);
}
