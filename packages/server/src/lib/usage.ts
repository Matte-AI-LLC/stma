import { and, count, countDistinct, desc, eq, gt, gte, inArray, isNotNull, like, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { activity, memberships, rateCounters, teams, users } from '../db/schema';
import { DAY_MS } from './counters';

/**
 * Are people actually using this, and where do they fall off?
 *
 * Two questions the instance could not answer at all before. Both are read from
 * what the app already records — the activity feed is written on every
 * meaningful call and carries (team, human, agent token, when) — so metering
 * needed a reader, not a new write path on the hot road.
 *
 * Every query here is bounded and grouped; none of them scan a team's history.
 * The window is 30 days, comfortably inside ACTIVITY_RETENTION_DAYS (180), so a
 * retention sweep can never quietly shrink the numerator.
 */

const DAY = DAY_MS;

export interface ActiveCounts {
  humans: number;
  agents: number;
  teams: number;
  events: number;
}

async function activeSince(db: Db, since: Date): Promise<ActiveCounts> {
  const rows = await db
    .select({
      humans: countDistinct(activity.userId),
      agents: countDistinct(activity.tokenId),
      teams: countDistinct(activity.teamId),
      events: count(),
    })
    .from(activity)
    .where(gt(activity.createdAt, since));
  return rows[0] ?? { humans: 0, agents: 0, teams: 0, events: 0 };
}

export interface UsageWindows {
  monthly: ActiveCounts;
  weekly: ActiveCounts;
  daily: ActiveCounts;
  /** Weekly ÷ monthly: how much of the base shows up in any given week. */
  stickiness: number | null;
}

export async function usageWindows(db: Db): Promise<UsageWindows> {
  const now = Date.now();
  const monthly = await activeSince(db, new Date(now - 30 * DAY));
  const weekly = await activeSince(db, new Date(now - 7 * DAY));
  const daily = await activeSince(db, new Date(now - DAY));
  return {
    monthly,
    weekly,
    daily,
    stickiness: monthly.humans > 0 ? weekly.humans / monthly.humans : null,
  };
}

/**
 * The funnel, by team rather than by person: STMA only does anything once a
 * second machine shows up, so a team is the unit that either activated or did
 * not. Each step is a bounded count; the drop between two steps is the thing
 * worth reading.
 */
export interface FunnelStep {
  key: string;
  label: string;
  note: string;
  teams: number;
}

/** Teams that have at least one activity row with any of these actions. */
async function teamsWithAction(db: Db, actions: string[]): Promise<number> {
  const rows = await db
    .select({ n: countDistinct(activity.teamId) })
    .from(activity)
    .where(inArray(activity.action, actions));
  return rows[0]?.n ?? 0;
}

/** Teams whose snapshots came from more than one human — a diff needs two sides. */
async function teamsWithTwoSnapshotters(db: Db): Promise<number> {
  const rows = await db
    .select({ teamId: activity.teamId, people: countDistinct(activity.userId) })
    .from(activity)
    .where(eq(activity.action, 'push_snapshot'))
    .groupBy(activity.teamId);
  return rows.filter((r) => r.people > 1).length;
}

export async function activationFunnel(db: Db): Promise<FunnelStep[]> {
  const totalTeams = (await db.select({ n: count() }).from(teams))[0]?.n ?? 0;
  const multiMember = (
    await db
      .select({ teamId: memberships.teamId, n: count() })
      .from(memberships)
      .groupBy(memberships.teamId)
  ).filter((r) => r.n > 1).length;

  return [
    { key: 'created', label: 'Team created', note: 'Someone signed up and made a team.', teams: totalTeams },
    { key: 'joined', label: 'Second member', note: 'An invite was redeemed. Below this line the product cannot do its job.', teams: multiMember },
    { key: 'snapshot', label: 'First snapshot', note: 'An agent connected and pushed a machine.', teams: await teamsWithAction(db, ['push_snapshot']) },
    { key: 'two_sides', label: 'Two machines', note: 'Two different people pushed — a real diff is now possible.', teams: await teamsWithTwoSnapshotters(db) },
    { key: 'compare', label: 'First env diff', note: 'The core promise, exercised once.', teams: await teamsWithAction(db, ['compare_env']) },
    { key: 'session', label: 'First debug session', note: 'The agents talked to each other.', teams: await teamsWithAction(db, ['open_session']) },
    { key: 'resolved', label: 'First resolution', note: 'A problem was closed with a root cause — value delivered, archive started.', teams: await teamsWithAction(db, ['resolve_session']) },
    { key: 'fleet', label: 'Fleet activated', note: 'A run was started: the paid half is in use.', teams: await teamsWithAction(db, ['run_started']) },
    { key: 'governed', label: 'Policy published', note: 'A lead set rules for the agents. The stickiest step.', teams: await teamsWithAction(db, ['policy_published']) },
  ];
}

export interface TeamUsageRow {
  teamId: string;
  slug: string;
  name: string;
  plan: string;
  members: number;
  humans30d: number;
  agents30d: number;
  events30d: number;
  callsToday: number;
  lastActiveAt: Date | null;
}

/**
 * Per-team usage, newest activity first. `callsToday` is read from the quota
 * counter rather than recomputed — it is the same number the limiter enforces,
 * so a team asking "why was I capped" and the operator answering are looking at
 * one figure.
 */
export async function teamUsage(db: Db, limit = 20): Promise<TeamUsageRow[]> {
  const since = new Date(Date.now() - 30 * DAY);
  const agg = await db
    .select({
      teamId: activity.teamId,
      humans: countDistinct(activity.userId),
      agents: countDistinct(activity.tokenId),
      events: count(),
      lastActiveAt: sql<Date>`max(${activity.createdAt})`,
    })
    .from(activity)
    .where(gt(activity.createdAt, since))
    .groupBy(activity.teamId)
    .orderBy(desc(count()))
    .limit(limit);
  if (agg.length === 0) return [];

  const ids = agg.map((a) => a.teamId);
  const teamRows = await db.select().from(teams).where(inArray(teams.id, ids));
  const byId = new Map(teamRows.map((t) => [t.id, t]));
  const memberRows = await db
    .select({ teamId: memberships.teamId, n: count() })
    .from(memberships)
    .where(inArray(memberships.teamId, ids))
    .groupBy(memberships.teamId);
  const members = new Map(memberRows.map((m) => [m.teamId, m.n]));

  const windowStart = Math.floor(Date.now() / DAY) * DAY;
  const counterRows = await db
    .select({ key: rateCounters.key, count: rateCounters.count })
    .from(rateCounters)
    .where(
      inArray(
        rateCounters.key,
        ids.map((id) => `team-day:${id}:${windowStart}`),
      ),
    );
  const calls = new Map(counterRows.map((r) => [r.key.split(':')[1]!, r.count]));

  return agg.flatMap((row) => {
    const team = byId.get(row.teamId);
    if (!team) return [];
    return [
      {
        teamId: row.teamId,
        slug: team.slug,
        name: team.name,
        plan: team.plan,
        members: members.get(row.teamId) ?? 0,
        humans30d: row.humans,
        agents30d: row.agents,
        events30d: row.events,
        callsToday: calls.get(row.teamId) ?? 0,
        lastActiveAt: row.lastActiveAt ? new Date(row.lastActiveAt) : null,
      },
    ];
  });
}
