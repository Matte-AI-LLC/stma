import { randomBytes } from 'node:crypto';
import { count, desc, gte, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { loadSamples } from '../db/schema';
import type { Env } from '../env';
import { LATENCY_BUCKETS, metrics, percentileFrom, type MetricsStore } from './metrics';

/**
 * The persisted half of the load picture.
 *
 * `lib/metrics` is a ring in this process's memory: it answers "what is
 * happening" and forgets everything on restart. This module turns closed
 * five-minute windows of that ring into rows, so `/admin/ops` can also answer
 * "what happened" — including on the days nobody was watching. The reasoning
 * behind the bucket size and the stored histogram is on `loadSamples` in
 * `db/schema`; the rules that keep it bounded are here.
 */

/** Bucket width. Five minutes — see the schema comment for the arithmetic. */
export const LOAD_BUCKET_MS = 5 * 60_000;

/**
 * Hard ceiling on stored rows, the same belt-and-braces `error_events` wears:
 * age alone cannot bound a table whose writer is a timer that might one day run
 * in more than one process. 20,000 buckets is about 69 days of one replica, or
 * 34 of two — comfortably past the 30-day default so the age sweep is normally
 * the thing that removes a row and the cap is the thing that catches a surprise.
 */
export const LOAD_SAMPLE_CAP = 20_000;

/**
 * Buckets one page load may read. 30 days of a single replica is 8,640, so the
 * widest window fits with room for a second one; past this the page says the
 * window was truncated rather than quietly drawing a shorter history as if it
 * were the whole record.
 */
export const LOAD_HISTORY_MAX_ROWS = 10_000;

/** How far back a flush will look. The ring holds 60 minutes; stay clear of its edge. */
const LOOKBACK_BUCKETS = 10;
const FLUSH_INTERVAL = 60_000;

/**
 * This process, for as long as it lives.
 *
 * Not the hostname (in a container that is an id nobody can look up anyway) and
 * not the pid (two containers collide): a fresh random id per boot, which makes
 * a restart visible in the history as a bucket reported by two instances
 * instead of needing a second table to record one.
 */
export const INSTANCE_ID = randomBytes(6).toString('hex');

export interface LoadSlice {
  /** Start of the slice, UTC. */
  at: Date;
  requests: number;
  redirects: number;
  clientErrors: number;
  serverErrors: number;
  rateLimited: number;
  /** Summed element-wise across every bucket in the slice — the only way p95 rolls up. */
  latency: number[];
  loopLagMaxMs: number;
  rssMb: number;
  /** Minutes of load actually observed inside the slice. */
  minutes: number;
  /** Five-minute buckets the record holds for it. */
  buckets: number;
  /**
   * Buckets that should exist by now. Equal to `buckets` when nothing was
   * missed; lower than the slice's full width for the slice we are inside,
   * which is still filling rather than incomplete.
   */
  expected: number;
  /** Distinct processes that reported into it; >1 means a restart or a second replica. */
  instances: number;
  /** Busiest single bucket, as requests per minute. */
  peakPerMinute: number;
}

/**
 * Every window divides into 24, 28 or 30 slices, so the chart is always bounded
 * and a bar is always wide enough to aim at. `slice` is what one bar is, in the
 * words a screen reader should say.
 */
export const LOAD_WINDOWS = {
  '24h': { label: '24 hours', slice: 'hour', ms: 24 * 3_600_000, sliceMs: 3_600_000 },
  '7d': { label: '7 days', slice: 'six hours', ms: 7 * 24 * 3_600_000, sliceMs: 6 * 3_600_000 },
  '30d': { label: '30 days', slice: 'day', ms: 30 * 24 * 3_600_000, sliceMs: 24 * 3_600_000 },
} as const;
export type LoadWindowKey = keyof typeof LOAD_WINDOWS;
export const LOAD_WINDOW_KEYS = Object.keys(LOAD_WINDOWS) as LoadWindowKey[];
export const loadWindowKey = (value: string | undefined): LoadWindowKey =>
  (LOAD_WINDOW_KEYS as string[]).includes(value ?? '') ? (value as LoadWindowKey) : '24h';

export interface LoadHistory {
  window: LoadWindowKey;
  from: Date;
  to: Date;
  /** Oldest first, at most 30 — every window divides into 24, 28 or 30 slices. */
  slices: LoadSlice[];
  totals: LoadSlice;
  /** Oldest bucket the record holds inside the window; null when it holds none. */
  oldest: Date | null;
  /** Buckets read. */
  rows: number;
  /** True when the read hit LOAD_HISTORY_MAX_ROWS and the window is not whole. */
  truncated: boolean;
  /**
   * Buckets with no row at all, counted only from `oldest` forward: before the
   * first row there is nothing to be missing, and an instance whose history
   * starts today must not report thirty days of downtime.
   */
  gaps: number;
}

const emptySlice = (at: Date): LoadSlice => ({
  at,
  requests: 0,
  redirects: 0,
  clientErrors: 0,
  serverErrors: 0,
  rateLimited: 0,
  latency: Array.from({ length: LATENCY_BUCKETS.length }, () => 0),
  loopLagMaxMs: 0,
  rssMb: 0,
  minutes: 0,
  buckets: 0,
  expected: 0,
  instances: 0,
  peakPerMinute: 0,
});

/** p50/p95/p99 of a slice, recomputed from its summed histogram. */
export const slicePercentiles = (slice: LoadSlice) => ({
  p50: percentileFrom(slice.latency, 50),
  p95: percentileFrom(slice.latency, 95),
  p99: percentileFrom(slice.latency, 99),
});

/** 5xx share of requests, 0–100. */
export const sliceErrorRate = (slice: LoadSlice): number =>
  slice.requests === 0 ? 0 : (slice.serverErrors / slice.requests) * 100;

// ------------------------------------------------------------------ writing

/**
 * Write every closed bucket this process can still prove, newest last.
 *
 * There is no drain state anywhere: the ring is asked for a named window, so a
 * flush that ran late, ran twice or never ran at all produces the same row, and
 * the composite key makes a repeat a no-op rather than a double count. `after`
 * is only an optimisation — the caller's memo of the newest bucket it already
 * wrote — so losing it costs a few conflicting inserts, never a wrong number.
 *
 * A bucket the ring has no live minute for is skipped rather than written as
 * zero. That is what makes a hole in the history mean "this process was not
 * running" instead of "nobody called us": the sampler stamps the current minute
 * every five seconds, so an idle but live process still reports.
 */
export async function flushLoadSamplesOnce(
  db: Db,
  opts: { store?: Pick<MetricsStore, 'bucket'>; now?: number; after?: number } = {},
): Promise<{ written: number; newest: number }> {
  const store = opts.store ?? metrics;
  const now = opts.now ?? Date.now();
  const after = opts.after ?? 0;
  const current = Math.floor(now / LOAD_BUCKET_MS) * LOAD_BUCKET_MS;
  let written = 0;
  let newest = after;
  for (let i = LOOKBACK_BUCKETS; i >= 1; i--) {
    const start = current - i * LOAD_BUCKET_MS;
    if (start <= after) continue;
    const rolled = store.bucket(start, start + LOAD_BUCKET_MS);
    if (rolled.minutes === 0) continue;
    const inserted = await db
      .insert(loadSamples)
      .values({
        instance: INSTANCE_ID,
        bucketAt: new Date(start),
        minutes: rolled.minutes,
        requests: rolled.requests,
        redirects: rolled.redirects,
        clientErrors: rolled.clientErrors,
        serverErrors: rolled.serverErrors,
        rateLimited: rolled.rateLimited,
        latency: rolled.latency,
        loopLagMaxMs: rolled.loopLagMaxMs,
        rssMb: rolled.rssMb,
      })
      .onConflictDoNothing()
      .returning({ bucketAt: loadSamples.bucketAt });
    // `written` counts rows that are new, not statements issued, so a caller
    // that lost its memo can tell "the flush ran twice" from "the flush wrote
    // the same bucket twice" — which cannot happen.
    if (inserted.length > 0) written += 1;
    newest = start;
  }
  return { written, newest };
}

/**
 * Keep only the newest LOAD_SAMPLE_CAP buckets.
 *
 * Cuts on `bucket_at` rather than a surrogate id, because the table has none: a
 * row is identified by which process reported which window, and an id nothing
 * references would cost 16 bytes on every one of them. The second count is
 * exact where `total - cap` would not be — two instances sharing the boundary
 * bucket are both kept.
 */
export async function trimLoadSamples(db: Db, cap = LOAD_SAMPLE_CAP): Promise<number> {
  const keep = Math.max(1, cap);
  const total = (await db.select({ n: count() }).from(loadSamples))[0]?.n ?? 0;
  if (total <= keep) return 0;
  // `offset keep - 1` is the oldest row worth keeping, and the cut is strictly
  // older than it — so two instances that both reported the boundary bucket are
  // both kept rather than one of them being dropped by row order.
  await db.execute(
    sql`delete from ${loadSamples} where ${loadSamples.bucketAt} < (select ${loadSamples.bucketAt} from ${loadSamples} order by ${desc(loadSamples.bucketAt)} limit 1 offset ${keep - 1})`,
  );
  const left = (await db.select({ n: count() }).from(loadSamples))[0]?.n ?? 0;
  return total - left;
}

/**
 * Flush on a timer. Returns a stop function.
 *
 * Skipped under `NODE_ENV=test` for the reason the notification sweep is: a
 * background timer must never race a test that drives the flush itself.
 */
export function startLoadHistory(db: Db, env: Env): () => void {
  if (env.nodeEnv === 'test') return () => {};
  let after = 0;
  const tick = () => {
    flushLoadSamplesOnce(db, { after })
      .then((result) => {
        after = Math.max(after, result.newest);
      })
      .catch((err) => console.error('[stma] load history flush failed:', err));
  };
  const timer = setInterval(tick, FLUSH_INTERVAL);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ------------------------------------------------------------------ reading

/**
 * The record over a bounded window, rolled into at most thirty slices.
 *
 * Counts sum, histograms sum element-wise and peaks take a max, so the same
 * function is correct for one replica, for two, and across a restart — which is
 * the property that made a stored histogram worth the column.
 */
export async function readLoadHistory(
  db: Db,
  window: LoadWindowKey = '24h',
  now = new Date(),
): Promise<LoadHistory> {
  const spec = LOAD_WINDOWS[window];
  // Slices are clock-aligned — a clock hour, a six-hour mark, a UTC day — so a
  // label means what it says. Aligning to the five-minute bucket instead would
  // have produced rows headed "14:23", and over a week an unqualified hour
  // appears seven times, which is the confusion this whole card exists to
  // remove. The newest slice is the one we are inside, still filling up.
  const sliceCount = Math.round(spec.ms / spec.sliceMs);
  const newestSliceAt = Math.floor(now.getTime() / spec.sliceMs) * spec.sliceMs;
  const from = new Date(newestSliceAt - (sliceCount - 1) * spec.sliceMs);
  const to = new Date(newestSliceAt + spec.sliceMs);
  /** The newest bucket that could have been written; the one after it is in progress. */
  const nowBucket = Math.floor(now.getTime() / LOAD_BUCKET_MS) * LOAD_BUCKET_MS;
  const rows = await db
    .select()
    .from(loadSamples)
    .where(gte(loadSamples.bucketAt, from))
    .orderBy(desc(loadSamples.bucketAt))
    .limit(LOAD_HISTORY_MAX_ROWS);

  const fullSlice = Math.round(spec.sliceMs / LOAD_BUCKET_MS);
  const slices: LoadSlice[] = Array.from({ length: sliceCount }, (_, i) => {
    const at = new Date(from.getTime() + i * spec.sliceMs);
    const slice = emptySlice(at);
    slice.expected = Math.min(
      fullSlice,
      Math.max(0, Math.floor((nowBucket - at.getTime()) / LOAD_BUCKET_MS)),
    );
    return slice;
  });
  const totals = emptySlice(from);
  const seen = new Map<number, Set<string>>();
  const totalInstances = new Set<string>();
  const bucketsWithRows = new Set<number>();
  let oldest: number | null = null;

  for (const row of rows) {
    const at = row.bucketAt.getTime();
    if (at >= to.getTime()) continue;
    oldest = oldest === null ? at : Math.min(oldest, at);
    bucketsWithRows.add(at);
    const index = Math.floor((at - from.getTime()) / spec.sliceMs);
    const slice = slices[index];
    if (!slice) continue;
    const latency = Array.isArray(row.latency) ? row.latency : [];
    for (const target of [slice, totals]) {
      target.requests += row.requests;
      target.redirects += row.redirects;
      target.clientErrors += row.clientErrors;
      target.serverErrors += row.serverErrors;
      target.rateLimited += row.rateLimited;
      target.minutes += row.minutes;
      target.buckets += 1;
      for (let i = 0; i < target.latency.length; i++) target.latency[i]! += latency[i] ?? 0;
      if (row.loopLagMaxMs > target.loopLagMaxMs) target.loopLagMaxMs = row.loopLagMaxMs;
      if (row.rssMb > target.rssMb) target.rssMb = row.rssMb;
    }
    // Requests per minute, so a partial bucket is not read as a quiet one.
    const perMinute = row.minutes > 0 ? row.requests / row.minutes : 0;
    if (perMinute > slice.peakPerMinute) slice.peakPerMinute = perMinute;
    if (perMinute > totals.peakPerMinute) totals.peakPerMinute = perMinute;
    const at5 = seen.get(index) ?? new Set<string>();
    at5.add(row.instance);
    seen.set(index, at5);
    totalInstances.add(row.instance);
  }
  for (const [index, set] of seen) slices[index]!.instances = set.size;
  totals.instances = totalInstances.size;
  // Across the whole window, including the slice still filling. Counting it per
  // row would only have restated `buckets` under another name.
  totals.expected = slices.reduce((n, s) => n + s.expected, 0);

  const expected = oldest === null ? 0 : Math.round((nowBucket - oldest) / LOAD_BUCKET_MS);
  return {
    window,
    from,
    to,
    slices,
    totals,
    oldest: oldest === null ? null : new Date(oldest),
    rows: rows.length,
    truncated: rows.length >= LOAD_HISTORY_MAX_ROWS,
    gaps: Math.max(0, expected - bucketsWithRows.size),
  };
}
