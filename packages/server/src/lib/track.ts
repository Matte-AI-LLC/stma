import { desc, sql } from 'drizzle-orm';
import { rowsAffected, type Db } from '../db';
import { activity } from '../db/schema';
import { publishChange } from './stream';

/**
 * Hard ceiling on stored feed rows per team. The age purge is the real retention
 * rule; this only stops one runaway team from filling the disk between sweeps —
 * and because it is per team, a busy team evicts only its own history.
 */
export const ACTIVITY_CAP_PER_TEAM = 20_000;

/** Persist one activity-feed event; failures never break the main flow. */
export async function track(
  db: Db,
  event: {
    teamId: string;
    projectId?: string | null;
    userId?: string | null;
    tokenId?: string | null;
    action: string;
    detail?: string | null;
  },
): Promise<void> {
  try {
    await db.insert(activity).values({
      teamId: event.teamId,
      projectId: event.projectId ?? null,
      userId: event.userId ?? null,
      tokenId: event.tokenId ?? null,
      action: event.action,
      detail: event.detail?.slice(0, 300) ?? null,
    });
    // Every meaningful call already writes a feed row, which makes this the one
    // place that knows something a watching page would want to see.
    publishChange(event.teamId, 'activity');
  } catch (err) {
    console.warn('[stma] activity track failed:', err instanceof Error ? err.message : err);
  }
}

/** Keep only the newest `cap` feed rows per team. Returns how many were deleted. */
export async function trimActivity(db: Db, cap = ACTIVITY_CAP_PER_TEAM): Promise<number> {
  const res = await db.execute(sql`
    delete from ${activity} where ${activity.id} in (
      select id from (
        select ${activity.id} as id, row_number() over (
          partition by ${activity.teamId} order by ${desc(activity.createdAt)}
        ) as rn from ${activity}
      ) ranked where ranked.rn > ${cap}
    )
  `);
  return rowsAffected(res);
}
