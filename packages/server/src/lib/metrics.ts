/**
 * In-process load metrics for the operator console (/admin/ops).
 *
 * Single-instance assumption, exactly like lib/ratelimit: the numbers describe *this*
 * replica since it booted, and they reset on restart. Everything here is fixed-size —
 * a 60-slot minute ring, fixed latency histograms and capped path/tool maps — so
 * neither a traffic spike nor a path-scanning bot can grow the process's memory.
 */

/** Upper bounds (ms) of the latency histogram. Anything slower lands in the last bucket. */
const LATENCY_BUCKETS = [
  1, 2, 5, 10, 25, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 10_000,
  30_000,
] as const;

/** Minute buckets kept for the traffic sparkline. */
export const MINUTES = 60;
/** Distinct templated paths tracked; everything beyond this folds into "(other)". */
export const MAX_PATHS = 200;
/** Distinct MCP tool names tracked; beyond this folds into "(other)". */
export const MAX_TOOLS = 64;
/** Path segments kept when templating; deeper paths are truncated. */
const MAX_SEGMENTS = 8;
const OVERFLOW = '(other)';
const SAMPLE_MS = 5_000;

// ------------------------------------------------------------------ path templating

/**
 * Route shapes whose next segment is an identifier. The key is the shape of the
 * segments *already* templated ('*' for a dynamic one), so nested ids match too.
 * Secret-bearing segments (hook tokens, invite codes) are listed explicitly — the
 * generic rules below are only a cardinality guard, never the privacy guarantee.
 */
const DYNAMIC_AT: Record<string, string> = {
  'app/teams/*': ':slug',
  'app/teams/*/invites/*': ':id',
  'app/teams/*/members/*': ':id',
  'app/sessions/*': ':id',
  'app/tokens/*': ':id',
  'admin/teams/*': ':id',
  'admin/crm/*': ':id',
  'api/agent/runs/*': ':id',
  'api/hooks/announce/*': ':token',
  'api/hooks/github/*': ':token',
  'join/*': ':code',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Generic shape rules for segments no route shape covers. */
function genericSegment(seg: string): { text: string; dynamic: boolean } {
  if (UUID.test(seg)) return { text: ':id', dynamic: true };
  if (/^\d+$/.test(seg)) return { text: ':n', dynamic: true };
  // Random-looking: long enough to be an id/token and mixing digits with letters.
  if (seg.length >= 12 && /\d/.test(seg) && /[a-z]/i.test(seg)) return { text: ':id', dynamic: true };
  return { text: seg.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 32), dynamic: false };
}

/**
 * Collapse a request path to a low-cardinality template, e.g.
 * `/app/sessions/6f0…/messages` → `/app/sessions/:id/messages`.
 */
export function templatePath(path: string): string {
  const segs = path.split('/').filter(Boolean);
  const truncated = segs.length > MAX_SEGMENTS;
  const out: string[] = [];
  const shape: string[] = [];
  for (const seg of segs.slice(0, MAX_SEGMENTS)) {
    const known = DYNAMIC_AT[[...shape, '*'].join('/')];
    if (known) {
      out.push(known);
      shape.push('*');
      continue;
    }
    const g = genericSegment(seg);
    out.push(g.text);
    shape.push(g.dynamic ? '*' : g.text);
  }
  if (truncated) out.push('…');
  return `/${out.join('/')}`;
}

// ------------------------------------------------------------------ store

interface MinuteBucket {
  /** Epoch minute this slot holds; slots older than MINUTES count as empty. */
  minute: number;
  requests: number;
  serverErrors: number;
  clientErrors: number;
  latency: Uint32Array;
}

interface PathStat {
  n: number;
  sum: number;
  max: number;
}

export interface MinuteView {
  at: Date;
  requests: number;
  serverErrors: number;
  clientErrors: number;
}

export interface PathView {
  path: string;
  n: number;
  meanMs: number;
  maxMs: number;
}

export interface MetricsSnapshot {
  startedAt: Date;
  uptimeMs: number;
  totals: {
    requests: number;
    byClass: { c2xx: number; c3xx: number; c4xx: number; c5xx: number; other: number };
    p50: number | null;
    p95: number | null;
    p99: number | null;
  };
  lastHour: {
    requests: number;
    serverErrors: number;
    clientErrors: number;
    /** 5xx share of requests in the window, 0–100. */
    errorRate: number;
    p95: number | null;
    peak: number;
    minutes: MinuteView[];
  };
  busiestPaths: PathView[];
  slowestPaths: PathView[];
  tools: Array<{ tool: string; n: number }>;
  rateLimited: number;
  loopGuardTrips: number;
  /** Cardinality of the capped maps — the proof that memory stays bounded. */
  trackedPaths: number;
  trackedTools: number;
  eventLoopLagMs: number;
  eventLoopLagMaxMs: number;
  memory: { rss: number; heapUsed: number };
}

function emptyBucket(minute: number): MinuteBucket {
  return {
    minute,
    requests: 0,
    serverErrors: 0,
    clientErrors: 0,
    latency: new Uint32Array(LATENCY_BUCKETS.length),
  };
}

function bucketIndex(ms: number): number {
  for (let i = 0; i < LATENCY_BUCKETS.length; i++) {
    if (ms <= LATENCY_BUCKETS[i]!) return i;
  }
  return LATENCY_BUCKETS.length - 1;
}

function percentile(hist: Uint32Array, p: number): number | null {
  let total = 0;
  for (const v of hist) total += v;
  if (total === 0) return null;
  const target = Math.max(1, Math.ceil((p / 100) * total));
  let seen = 0;
  for (let i = 0; i < hist.length; i++) {
    seen += hist[i]!;
    if (seen >= target) return LATENCY_BUCKETS[i]!;
  }
  return LATENCY_BUCKETS[LATENCY_BUCKETS.length - 1]!;
}

export interface MetricsStore {
  recordRequest(r: { method: string; path: string; status: number; ms: number; tool?: string }): void;
  recordRateLimited(): void;
  recordLoopGuardTrip(): void;
  /** Starts the shared event-loop-lag sampler; the returned stop is reference counted. */
  startSampler(): () => void;
  read(): MetricsSnapshot;
}

/**
 * Build an isolated store. The app uses the `metrics` singleton below; tests build
 * their own so synthetic samples never pollute the live picture.
 */
export function createMetricsStore(): MetricsStore {
  const startedAt = new Date();
  const ring: MinuteBucket[] = Array.from({ length: MINUTES }, () => emptyBucket(-1));
  const totalLatency = new Uint32Array(LATENCY_BUCKETS.length);
  const byClass = { c2xx: 0, c3xx: 0, c4xx: 0, c5xx: 0, other: 0 };
  const paths = new Map<string, PathStat>();
  const tools = new Map<string, number>();
  let requests = 0;
  let rateLimited = 0;
  let loopGuardTrips = 0;
  let eventLoopLagMs = 0;
  let eventLoopLagMaxMs = 0;
  let samplerTimer: ReturnType<typeof setInterval> | null = null;
  let samplerRefs = 0;

  /** The slot for an epoch minute, recycled (never grown) when the minute rolls over. */
  const slotFor = (minute: number): MinuteBucket => {
    const i = ((minute % MINUTES) + MINUTES) % MINUTES;
    let slot = ring[i]!;
    if (slot.minute !== minute) {
      slot = emptyBucket(minute);
      ring[i] = slot;
    }
    return slot;
  };

  /**
   * Cap-aware map access: past the cap everything folds into a single "(other)" key.
   * One slot is reserved for that key, so the map never holds more than `cap` entries.
   */
  const keyWithin = <T>(map: Map<string, T>, key: string, cap: number): string =>
    map.has(key) || map.size < cap - 1 ? key : OVERFLOW;

  return {
    recordRequest({ path, status, ms, tool }) {
      const now = Date.now();
      const duration = Math.max(0, Math.round(ms));
      requests += 1;
      const cls =
        status >= 500 ? 'c5xx' : status >= 400 ? 'c4xx' : status >= 300 ? 'c3xx' : status >= 200 ? 'c2xx' : 'other';
      byClass[cls] += 1;
      const li = bucketIndex(duration);
      totalLatency[li] += 1;

      const slot = slotFor(Math.floor(now / 60_000));
      slot.requests += 1;
      slot.latency[li] += 1;
      if (status >= 500) slot.serverErrors += 1;
      else if (status >= 400) slot.clientErrors += 1;

      const pathKey = keyWithin(paths, templatePath(path), MAX_PATHS);
      const stat = paths.get(pathKey) ?? { n: 0, sum: 0, max: 0 };
      stat.n += 1;
      stat.sum += duration;
      if (duration > stat.max) stat.max = duration;
      paths.set(pathKey, stat);

      if (tool) {
        const toolKey = keyWithin(tools, tool.slice(0, 60), MAX_TOOLS);
        tools.set(toolKey, (tools.get(toolKey) ?? 0) + 1);
      }
    },

    recordRateLimited() {
      rateLimited += 1;
    },

    recordLoopGuardTrip() {
      loopGuardTrips += 1;
    },

    startSampler() {
      samplerRefs += 1;
      if (!samplerTimer) {
        let last = Date.now();
        samplerTimer = setInterval(() => {
          const now = Date.now();
          eventLoopLagMs = Math.max(0, now - last - SAMPLE_MS);
          if (eventLoopLagMs > eventLoopLagMaxMs) eventLoopLagMaxMs = eventLoopLagMs;
          last = now;
        }, SAMPLE_MS);
        // Never keep the process (or a test run) alive for a metrics sample.
        samplerTimer.unref?.();
      }
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        samplerRefs -= 1;
        if (samplerRefs <= 0 && samplerTimer) {
          clearInterval(samplerTimer);
          samplerTimer = null;
          samplerRefs = 0;
        }
      };
    },

    read() {
      const nowMinute = Math.floor(Date.now() / 60_000);
      const oldest = nowMinute - (MINUTES - 1);
      const hourLatency = new Uint32Array(LATENCY_BUCKETS.length);
      const minutes: MinuteView[] = [];
      let hourRequests = 0;
      let hourServerErrors = 0;
      let hourClientErrors = 0;
      let peak = 0;
      for (let m = oldest; m <= nowMinute; m++) {
        const slot = ring[((m % MINUTES) + MINUTES) % MINUTES]!;
        const live = slot.minute === m;
        const view: MinuteView = {
          at: new Date(m * 60_000),
          requests: live ? slot.requests : 0,
          serverErrors: live ? slot.serverErrors : 0,
          clientErrors: live ? slot.clientErrors : 0,
        };
        if (live) {
          hourRequests += slot.requests;
          hourServerErrors += slot.serverErrors;
          hourClientErrors += slot.clientErrors;
          for (let i = 0; i < hourLatency.length; i++) hourLatency[i] += slot.latency[i]!;
        }
        if (view.requests > peak) peak = view.requests;
        minutes.push(view);
      }

      const views: PathView[] = [...paths].map(([path, s]) => ({
        path,
        n: s.n,
        meanMs: Math.round(s.sum / s.n),
        maxMs: s.max,
      }));

      return {
        startedAt,
        uptimeMs: Date.now() - startedAt.getTime(),
        totals: {
          requests,
          byClass: { ...byClass },
          p50: percentile(totalLatency, 50),
          p95: percentile(totalLatency, 95),
          p99: percentile(totalLatency, 99),
        },
        lastHour: {
          requests: hourRequests,
          serverErrors: hourServerErrors,
          clientErrors: hourClientErrors,
          errorRate: hourRequests === 0 ? 0 : (hourServerErrors / hourRequests) * 100,
          p95: percentile(hourLatency, 95),
          peak,
          minutes,
        },
        busiestPaths: [...views].sort((a, b) => b.n - a.n || a.path.localeCompare(b.path)).slice(0, 10),
        slowestPaths: [...views]
          .sort((a, b) => b.meanMs - a.meanMs || b.maxMs - a.maxMs)
          .slice(0, 10),
        tools: [...tools]
          .map(([tool, n]) => ({ tool, n }))
          .sort((a, b) => b.n - a.n || a.tool.localeCompare(b.tool))
          .slice(0, 20),
        rateLimited,
        loopGuardTrips,
        trackedPaths: paths.size,
        trackedTools: tools.size,
        eventLoopLagMs,
        eventLoopLagMaxMs,
        memory: (() => {
          const m = process.memoryUsage();
          return { rss: m.rss, heapUsed: m.heapUsed };
        })(),
      };
    },
  };
}

/** Process-wide store used by the app. */
export const metrics = createMetricsStore();
