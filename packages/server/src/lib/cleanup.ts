import { and, eq, inArray, lt, notInArray, or, type SQL } from 'drizzle-orm';
import { rowsAffected, type Db } from '../db';
import {
  activity,
  agentEvents,
  agentRuns,
  authCodes,
  debugSessions,
  environmentChecks,
  errorEvents,
  invites,
  notificationQueue,
  snapshots,
  teams,
  webSessions,
} from '../db/schema';
import { PLANS, PLAN_IDS } from './entitlements';
import type { Env } from '../env';
import { markStaleAgentRuns, trimAgentEvents } from '../domain/agents';
import { trimEnvironmentChecks } from '../domain/environments';
import { trimErrorEvents } from './errors';
import { sweepCounters } from './counters';
import { logLine } from './log';
import { flushNotificationsOnce } from './notifications';
import { trimAnnouncements } from './sessions';
import { trimActivity } from './track';

/** Team ids on one of these plans — the subquery a scoped purge deletes through. */
const teamsIn = (db: Db, plans: readonly string[]) =>
  db
    .select({ id: teams.id })
    .from(teams)
    .where(
      // A plan id nobody recognises resolves to `free` everywhere else, so it has
      // to be swept like `free` here too — otherwise a typo in the column buys a
      // team unlimited history.
      plans.includes('free')
        ? (or(inArray(teams.plan, [...plans]), notInArray(teams.plan, [...PLAN_IDS])) as SQL)
        : inArray(teams.plan, [...plans]),
    );

/**
 * How long history is kept, and for whom.
 *
 * Hosted: one entry per distinct finite retention in the plan ladder, each
 * scoped to the plans that carry it; plans promising unlimited history simply
 * do not appear, so nothing deletes their rows by age. Self-host: a single
 * unscoped entry from the environment, which is the behaviour that existed
 * before plans reached this file at all.
 */
function retentionGroups(env: Env): Array<[number, readonly string[] | null]> {
  if (!env.hosted) {
    return env.activityRetentionDays > 0 ? [[env.activityRetentionDays, null]] : [];
  }
  const byDays = new Map<number, string[]>();
  for (const id of PLAN_IDS) {
    const days = PLANS[id].retentionDays;
    if (days === null) continue;
    byDays.set(days, [...(byDays.get(days) ?? []), id]);
  }
  return [...byDays];
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SWEEP_INTERVAL = 6 * 60 * 60 * 1000;
const PRESENCE_SWEEP_INTERVAL = 60 * 1000;
const NOTIFY_SWEEP_INTERVAL = 30 * 1000;

export async function runCleanupOnce(db: Db, env: Env): Promise<void> {
  const now = new Date();
  /** Deleted-row tallies for the sweep log line; only non-zero entries are logged. */
  const counts: Record<string, number> = {};
  await db.delete(webSessions).where(lt(webSessions.expiresAt, now));
  // Email codes: an hour past expiry, so the per-user send window (which counts
  // consumed and expired rows alike) is never shortened by the sweep.
  await db.delete(authCodes).where(lt(authCodes.expiresAt, new Date(now.getTime() - HOUR)));
  await db.delete(invites).where(lt(invites.expiresAt, new Date(now.getTime() - 30 * DAY)));
  if (env.snapshotRetentionDays > 0) {
    await db
      .delete(snapshots)
      .where(lt(snapshots.createdAt, new Date(now.getTime() - env.snapshotRetentionDays * DAY)));
  }
  // Resolved sessions, when the operator asked for it (default 0 = keep the archive
  // forever). Their messages and read state go with them: both cascade on
  // session_id, so this one delete is the whole thread's retention rule. Messages
  // are deliberately never purged on their own — they are the archive.
  if (env.sessionRetentionDays > 0) {
    const purged = await db
      .delete(debugSessions)
      .where(
        and(
          eq(debugSessions.status, 'resolved'),
          lt(debugSessions.resolvedAt, new Date(now.getTime() - env.sessionRetentionDays * DAY)),
        ),
      );
    counts.sessions = rowsAffected(purged);
  }
  // The announcements channel is the one message stream nothing else bounds:
  // never resolved, so the session purge above can never reach it.
  counts.announcements = await trimAnnouncements(db, { days: env.activityRetentionDays });
  if (env.errorRetentionDays > 0) {
    await db
      .delete(errorEvents)
      .where(lt(errorEvents.at, new Date(now.getTime() - env.errorRetentionDays * DAY)));
  }
  // Age alone cannot bound an error storm, so the operator log is also row-capped.
  await trimErrorEvents(db);
  // Preflight verdicts describe a machine at a moment, so they age out with the
  // snapshots they compare against — and, like the error log, a burst between
  // sweeps is caught by a row cap (per team, so a busy team evicts only itself).
  if (env.snapshotRetentionDays > 0) {
    await db
      .delete(environmentChecks)
      .where(lt(environmentChecks.createdAt, new Date(now.getTime() - env.snapshotRetentionDays * DAY)));
  }
  await trimEnvironmentChecks(db);
  // The notification outbox. Finished rows outlive the hourly rate cap by a day so
  // an operator can still see what was sent; a pending row that old is stuck, and
  // nobody wants yesterday's "new reply" email anyway.
  await db.delete(notificationQueue).where(lt(notificationQueue.createdAt, new Date(now.getTime() - DAY)));

  // The two "what happened" trails: the human activity feed and the append-only
  // agent run trail the governance page reads. Same knob, because they answer the
  // same question for two audiences. Each also carries a row cap, because age
  // alone cannot bound a burst between two six-hour sweeps.
  //
  // On the hosted service the plan decides, not this knob. That is the point of
  // selling retention at all: an outcome history swept every 90 days is not a
  // record anyone can plan against, and a team that pays for one has been
  // promised the rows will still be there. Everywhere else — self-host, dev —
  // the single environment number is still the whole rule.
  //
  // agent_runs themselves are left alone on purpose everywhere: deleting a run
  // cascades into its policy receipts, which are the drift attestation the
  // governance page is built on. One row per run is a far slower curve than one
  // row per event.
  counts.activity = 0;
  counts.agentEvents = 0;
  for (const [days, scope] of retentionGroups(env)) {
    const cutoff = new Date(now.getTime() - days * DAY);
    counts.activity += rowsAffected(
      await db.delete(activity).where(scope ? and(lt(activity.createdAt, cutoff), inArray(activity.teamId, teamsIn(db, scope))) : lt(activity.createdAt, cutoff)),
    );
    // Trail rows are reached through their run, so an event is judged by its own
    // timestamp — a long-lived run keeps its recent events either way.
    counts.agentEvents += rowsAffected(
      await db.delete(agentEvents).where(
        scope
          ? and(
              lt(agentEvents.createdAt, cutoff),
              inArray(
                agentEvents.runId,
                db.select({ id: agentRuns.id }).from(agentRuns).where(inArray(agentRuns.teamId, teamsIn(db, scope))),
              ),
            )
          : lt(agentEvents.createdAt, cutoff),
      ),
    );
  }
  counts.activityCapped = await trimActivity(db);
  counts.agentEventsCapped = await trimAgentEvents(db);
  // Closed rate-limit and quota windows carry no information. Missing a sweep
  // costs disk, never correctness: an expired key is simply never read again.
  counts.counters = await sweepCounters(db);

  const swept = Object.entries(counts).filter(([, n]) => n > 0);
  if (swept.length > 0) logLine({ evt: 'cleanup', ...Object.fromEntries(swept) });
}

/** Periodic retention sweep. Returns a stop function. */
export function startCleanup(db: Db, env: Env): () => void {
  const run = () =>
    runCleanupOnce(db, env).catch((err) => console.error('[stma] cleanup failed:', err));
  run();
  const timer = setInterval(run, SWEEP_INTERVAL);
  timer.unref?.();
  const presenceRun = () =>
    markStaleAgentRuns(db, env.agentStaleMinutes).catch((err) =>
      console.error('[stma] agent presence sweep failed:', err),
    );
  presenceRun();
  const presenceTimer = setInterval(presenceRun, PRESENCE_SWEEP_INTERVAL);
  presenceTimer.unref?.();
  // Notification delivery. Skipped under NODE_ENV=test so a timer can never race a
  // test that drives flushNotificationsOnce itself.
  const notifyTimer =
    env.nodeEnv === 'test'
      ? undefined
      : setInterval(() => {
          flushNotificationsOnce(db, env).catch((err) =>
            console.error('[stma] notification sweep failed:', err),
          );
        }, NOTIFY_SWEEP_INTERVAL);
  notifyTimer?.unref?.();
  return () => {
    clearInterval(timer);
    clearInterval(presenceTimer);
    if (notifyTimer) clearInterval(notifyTimer);
  };
}
