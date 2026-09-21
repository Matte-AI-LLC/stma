import { eq, inArray, lt, sql } from 'drizzle-orm';
import { rowsAffected, type Db } from '../db';
import { rateCounters } from '../db/schema';

/**
 * Fixed-window counters that every replica agrees on.
 *
 * One statement per hit — an upsert that returns the new value — so a caller
 * learns its own count without a second read and two instances racing the same
 * key still produce one sequence. The window start is baked into the key, so a
 * new window is a new row rather than a compare-and-reset dance.
 *
 * Rows expire; `sweepCounters` in the retention pass removes them. A missed
 * sweep costs disk, never correctness, because an expired key is simply never
 * read again.
 */
export interface CounterHit {
  /** Value AFTER this hit. */
  count: number;
  /** When the current window ends. */
  resetAt: Date;
  /** True when this hit pushed the counter past `max`. */
  exceeded: boolean;
}

export async function hitCounter(
  db: Db,
  bucket: string,
  subject: string,
  windowMs: number,
  max: number,
  by = 1,
): Promise<CounterHit> {
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const resetAt = new Date(windowStart + windowMs);
  const key = counterKey(bucket, subject, windowMs, now);
  const rows = await db
    .insert(rateCounters)
    .values({ key, count: by, expiresAt: resetAt })
    .onConflictDoUpdate({
      target: rateCounters.key,
      set: { count: sql`${rateCounters.count} + ${by}` },
    })
    .returning({ count: rateCounters.count });
  const count = rows[0]?.count ?? by;
  return { count, resetAt, exceeded: count > max };
}

/**
 * The one spelling of a counter key.
 *
 * Every reader has to rebuild it to find a row, and a reader that builds it a
 * second way silently reports zero for a counter that is being enforced — which
 * is the worst shape a quota display can take, because nothing looks broken.
 */
export function counterKey(bucket: string, subject: string, windowMs: number, now = Date.now()): string {
  return `${bucket}:${subject}:${Math.floor(now / windowMs) * windowMs}`;
}

/** Current value without spending a hit — for showing a quota, not enforcing it. */
export async function readCounter(
  db: Db,
  bucket: string,
  subject: string,
  windowMs: number,
): Promise<number> {
  const rows = await db
    .select({ count: rateCounters.count })
    .from(rateCounters)
    .where(eq(rateCounters.key, counterKey(bucket, subject, windowMs)))
    .limit(1);
  return rows[0]?.count ?? 0;
}

/**
 * The same read for a list of subjects, in one statement.
 *
 * An operator page showing a quota for every workspace would otherwise pay a
 * round trip per row. Subjects that have not been counted in this window are
 * absent from the map rather than zero, so a caller can tell "nothing yet" from
 * "not asked for" if it ever needs to; every caller today reads it as zero.
 */
export async function readCounters(
  db: Db,
  bucket: string,
  subjects: readonly string[],
  windowMs: number,
): Promise<Map<string, number>> {
  if (subjects.length === 0) return new Map();
  const keys = new Map(subjects.map((s) => [counterKey(bucket, s, windowMs), s]));
  const rows = await db
    .select({ key: rateCounters.key, count: rateCounters.count })
    .from(rateCounters)
    .where(inArray(rateCounters.key, [...keys.keys()]));
  return new Map(rows.flatMap((r) => (keys.has(r.key) ? [[keys.get(r.key)!, r.count] as const] : [])));
}

/**
 * Forget one subject's current window.
 *
 * Only for counters where something can happen that makes the count untrue — a
 * successful sign-in ends the run of failures before it. A quota has no such
 * event, which is why nothing else calls this.
 */
export async function clearCounter(
  db: Db,
  bucket: string,
  subject: string,
  windowMs: number,
): Promise<void> {
  await db.delete(rateCounters).where(eq(rateCounters.key, counterKey(bucket, subject, windowMs)));
}

/** Windows that have closed carry no information. */
export async function sweepCounters(db: Db): Promise<number> {
  // rowsAffected, not result.rowCount: the embedded and Postgres drivers report
  // it under different keys, and reading the wrong one made the sweep look like
  // a no-op while it was actually working.
  return rowsAffected(await db.delete(rateCounters).where(lt(rateCounters.expiresAt, new Date())));
}

export const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * A fixed 30 days, not a calendar month.
 *
 * Every window here is `floor(now / windowMs)`, which cannot express "since the
 * 1st" — and a plan allowance that resets on a boundary the user cannot predict
 * is worse than one that resets on a boundary they can be told. Anything shown
 * to a person says 30 days rather than "this month".
 */
export const MONTH_MS = 30 * DAY_MS;
