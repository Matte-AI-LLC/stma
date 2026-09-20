import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asc, count, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db';
import { ceilingChanges, loadSamples, teams } from '../src/db/schema';
import { loadEnv } from '../src/env';
import {
  CEILING_FIELDS,
  CEILING_SOURCES,
  ceilingHistory,
  setTeamPlan,
  trimCeilingChanges,
} from '../src/lib/ceilings';
import { runCleanupOnce } from '../src/lib/cleanup';
import {
  INSTANCE_ID,
  LOAD_BUCKET_MS,
  flushLoadSamplesOnce,
  readLoadHistory,
  slicePercentiles,
  trimLoadSamples,
} from '../src/lib/loadHistory';
import { LATENCY_BUCKETS, createMetricsStore, percentileFrom, type LoadBucket } from '../src/lib/metrics';
import { startServer, type StartedServer } from '../src/server';

/**
 * The operator console's two "what happened" records: persisted load rollups
 * and the history of workspace ceilings.
 *
 * Both are bounded tables written by something other than a request, so the
 * tests that matter most here are the sweep and the bound rather than the
 * happy read.
 */

let srv: StartedServer;
let db: Db;
let dataDir: string;

const DAY = 24 * 60 * 60 * 1000;

function jar() {
  const cookies = new Map<string, string>();
  return {
    header(): Record<string, string> {
      return cookies.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {};
    },
    store(res: Response) {
      for (const line of res.headers.getSetCookie()) {
        const [kv] = line.split(';');
        const i = kv!.indexOf('=');
        cookies.set(kv!.slice(0, i), kv!.slice(i + 1));
      }
    },
  };
}

async function devLogin(username: string) {
  const j = jar();
  const res = await fetch(`${srv.url}/auth/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username }),
    redirect: 'manual',
  });
  j.store(res);
  expect(res.status).toBe(302);
  return j;
}

const form = (fields: Record<string, string>, cookies: Record<string, string>) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...cookies },
  body: new URLSearchParams(fields),
  redirect: 'manual' as const,
});

/** A latency histogram from `{bucketIndex: count}`. */
const hist = (at: Record<number, number>): number[] =>
  Array.from({ length: LATENCY_BUCKETS.length }, (_, i) => at[i] ?? 0);

const bucketOf = (over: Partial<LoadBucket> = {}): LoadBucket => ({
  minutes: 5,
  requests: 0,
  redirects: 0,
  clientErrors: 0,
  serverErrors: 0,
  rateLimited: 0,
  latency: hist({}),
  loopLagMaxMs: 0,
  rssMb: 0,
  ...over,
});

/** A metrics store that answers with exactly the buckets a test names. */
const stubStore = (byStart: Map<number, LoadBucket>) => ({
  bucket: (fromMs: number) => byStart.get(fromMs) ?? bucketOf({ minutes: 0 }),
});

beforeAll(async () => {
  process.env.ADMIN_USERNAMES = 'ada';
  dataDir = mkdtempSync(path.join(tmpdir(), 'bridge-history-'));
  srv = await startServer(
    loadEnv({
      port: 0,
      host: '127.0.0.1',
      nodeEnv: 'test',
      devMode: true,
      hosted: true,
      databaseUrl: undefined,
      pgliteDir: dataDir,
    }),
  );
  db = srv.db;
  delete process.env.ADMIN_USERNAMES;
}, 60_000);

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// --------------------------------------------------------------- load history

describe('load history', () => {
  it('pins the latency buckets the stored histograms are read against', () => {
    // A row on disk means whatever this array meant when it was written.
    // Changing it re-labels every bucket already stored, so it is a schema
    // change with a data migration, not a tuning knob — hence a test.
    expect([...LATENCY_BUCKETS]).toEqual([
      1, 2, 5, 10, 25, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 10_000,
      30_000,
    ]);
  });

  it('writes closed buckets, skips ones it cannot prove, and repeats without double counting', async () => {
    const now = Math.floor(Date.now() / LOAD_BUCKET_MS) * LOAD_BUCKET_MS;
    const older = now - 3 * LOAD_BUCKET_MS;
    const newer = now - 2 * LOAD_BUCKET_MS;
    // The bucket between them is deliberately absent from the store: the ring
    // has no live minute for it, so the process was not running and the record
    // must have a hole rather than a row of zeroes.
    const store = stubStore(
      new Map([
        [older, bucketOf({ requests: 30, serverErrors: 1, latency: hist({ 3: 30 }) })],
        [newer, bucketOf({ requests: 12, minutes: 2, latency: hist({ 3: 12 }) })],
      ]),
    );

    const first = await flushLoadSamplesOnce(db, { store, now });
    expect(first.written).toBe(2);
    expect(first.newest).toBe(newer);

    // Replay with no memo at all: the composite key makes it a no-op, which is
    // what makes a flush that ran twice indistinguishable from one that ran once.
    const replay = await flushLoadSamplesOnce(db, { store, now });
    expect(replay.written).toBe(0);
    expect(replay.newest).toBe(newer);
    const rows = await db.select().from(loadSamples).orderBy(asc(loadSamples.bucketAt));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.bucketAt.getTime())).toEqual([older, newer]);
    expect(rows[0]!.requests).toBe(30);
    expect(rows[0]!.instance).toBe(INSTANCE_ID);
    expect(rows[1]!.minutes).toBe(2); // a partial bucket says so

    // The memo skips what it already wrote rather than re-issuing the insert.
    const memoed = await flushLoadSamplesOnce(db, { store, now, after: newer });
    expect(memoed.written).toBe(0);
  });

  it('recomputes a percentile from the summed histograms instead of averaging them', async () => {
    // 980 fast requests in one bucket, 20 slow ones in the next. The honest p95
    // is 10 ms, because 98% of the traffic was fast. Averaging the two buckets'
    // own p95s would have answered 505 ms — fifty times worse than the truth,
    // and confidently.
    const fast = hist({ 3: 980 }); // ≤10 ms
    const slow = hist({ 13: 20 }); // ≤1000 ms
    expect(percentileFrom(fast, 95)).toBe(10);
    expect(percentileFrom(slow, 95)).toBe(1000);
    const meanOfPercentiles = (10 + 1000) / 2;

    await db.delete(loadSamples);
    const now = new Date();
    const base = Math.floor(now.getTime() / LOAD_BUCKET_MS) * LOAD_BUCKET_MS;
    await db.insert(loadSamples).values([
      {
        instance: 'i1',
        bucketAt: new Date(base - 2 * LOAD_BUCKET_MS),
        minutes: 5,
        requests: 980,
        latency: fast,
      },
      {
        instance: 'i1',
        bucketAt: new Date(base - LOAD_BUCKET_MS),
        minutes: 5,
        requests: 20,
        latency: slow,
      },
    ]);

    const history = await readLoadHistory(db, '24h', now);
    expect(history.totals.requests).toBe(1000);
    expect(slicePercentiles(history.totals).p95).toBe(10);
    expect(slicePercentiles(history.totals).p95).not.toBe(meanOfPercentiles);
    // p99 lands in the slow tail, which a mean would also have missed.
    expect(slicePercentiles(history.totals).p99).toBe(1000);
  });

  it('sums across instances and counts gaps only from the oldest row it holds', async () => {
    await db.delete(loadSamples);
    const now = new Date();
    const base = Math.floor(now.getTime() / LOAD_BUCKET_MS) * LOAD_BUCKET_MS;
    // Two processes reported the same bucket — a restart, or the second replica
    // this app is not running yet. Counts add; the reader must not pick one.
    await db.insert(loadSamples).values([
      { instance: 'a', bucketAt: new Date(base - LOAD_BUCKET_MS), minutes: 3, requests: 7, latency: hist({ 2: 7 }) },
      { instance: 'b', bucketAt: new Date(base - LOAD_BUCKET_MS), minutes: 2, requests: 5, latency: hist({ 2: 5 }) },
      // Four buckets earlier, so three buckets in between have no row at all.
      { instance: 'a', bucketAt: new Date(base - 5 * LOAD_BUCKET_MS), minutes: 5, requests: 1, latency: hist({ 2: 1 }) },
    ]);

    const history = await readLoadHistory(db, '24h', now);
    expect(history.totals.requests).toBe(13);
    expect(history.totals.instances).toBe(2);
    expect(history.totals.buckets).toBe(3);
    expect(history.oldest?.getTime()).toBe(base - 5 * LOAD_BUCKET_MS);
    // Five buckets between the oldest row and now, three of them empty. The 23
    // hours before the oldest row are NOT downtime — there was simply no record
    // yet, and an instance whose history starts today must not report a month of it.
    expect(history.gaps).toBe(3);
  });

  it('ages out old rollups and is capped whatever the age sweep leaves', async () => {
    await db.delete(loadSamples);
    const base = Math.floor(Date.now() / LOAD_BUCKET_MS) * LOAD_BUCKET_MS;
    await db.insert(loadSamples).values([
      { instance: 'a', bucketAt: new Date(base - 40 * DAY), minutes: 5, requests: 1, latency: hist({}) },
      { instance: 'a', bucketAt: new Date(base - 31 * DAY), minutes: 5, requests: 1, latency: hist({}) },
      { instance: 'a', bucketAt: new Date(base - 29 * DAY), minutes: 5, requests: 1, latency: hist({}) },
      { instance: 'a', bucketAt: new Date(base - LOAD_BUCKET_MS), minutes: 5, requests: 1, latency: hist({}) },
    ]);

    await runCleanupOnce(
      db,
      loadEnv({ nodeEnv: 'test', databaseUrl: undefined, loadRetentionDays: 30 }),
    );

    const left = await db.select().from(loadSamples).orderBy(asc(loadSamples.bucketAt));
    expect(left).toHaveLength(2);
    expect(left[0]!.bucketAt.getTime()).toBe(base - 29 * DAY); // the boundary is the cutoff

    // The cap is the second bound, for a writer that one day runs in more than
    // one process: age alone cannot stop 288 rows a day becoming 288 × N.
    await db.insert(loadSamples).values(
      Array.from({ length: 8 }, (_, i) => ({
        instance: 'cap',
        bucketAt: new Date(base - (i + 2) * LOAD_BUCKET_MS),
        minutes: 5,
        requests: i,
        latency: hist({}),
      })),
    );
    expect(await trimLoadSamples(db, 100)).toBe(0); // under the cap nothing is touched
    expect(await trimLoadSamples(db, 3)).toBe(7);
    const kept = await db.select().from(loadSamples).orderBy(desc(loadSamples.bucketAt));
    expect(kept).toHaveLength(3);
    // Newest kept, oldest gone.
    expect(kept[0]!.bucketAt.getTime()).toBe(base - LOAD_BUCKET_MS);
  });

  it('rolls the real ring up into a bucket without any drain state', () => {
    const store = createMetricsStore();
    for (let i = 0; i < 9; i++) {
      store.recordRequest({ method: 'GET', path: '/app', status: i === 0 ? 503 : 200, ms: 7 });
    }
    store.recordRequest({ method: 'GET', path: '/app', status: 302, ms: 3 });
    store.recordRateLimited();
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    const rolled = store.bucket(minute, minute + 60_000);
    expect(rolled.minutes).toBe(1);
    expect(rolled.requests).toBe(10);
    expect(rolled.serverErrors).toBe(1);
    expect(rolled.redirects).toBe(1);
    expect(rolled.rateLimited).toBe(1);
    // Asking twice answers the same, which is why a missed or repeated flush
    // cannot change the row.
    expect(store.bucket(minute, minute + 60_000)).toEqual(rolled);
    // A window the ring never held is empty rather than a fabricated zero row.
    expect(store.bucket(minute - 500 * 60_000, minute - 499 * 60_000).minutes).toBe(0);
  });
});

// ------------------------------------------------------------ ceiling changes

describe('ceiling history', () => {
  let ada: ReturnType<typeof jar>;
  let teamId: string;

  it('is a plain 404 for everyone but an operator', async () => {
    const mallory = await devLogin('mallory');
    for (const p of ['/admin', '/admin/ops', '/admin/ops?history=7d', '/admin/teams']) {
      expect((await fetch(srv.url + p, { headers: mallory.header() })).status).toBe(404);
      expect((await fetch(srv.url + p)).status).toBe(404);
    }
  });

  it('records an operator plan switch and shows it on both pages', async () => {
    ada = await devLogin('ada');
    expect((await fetch(`${srv.url}/app/teams`, form({ name: 'Ceiling Lab' }, ada.header()))).status).toBe(302);
    const listHtml = await (await fetch(`${srv.url}/admin/teams`, { headers: ada.header() })).text();
    teamId = /\/admin\/teams\/([0-9a-f-]{36})\/plan/.exec(listHtml)?.[1] ?? '';
    expect(teamId).toBeTruthy();

    const res = await fetch(`${srv.url}/admin/teams/${teamId}/plan`, form({ plan: 'team' }, ada.header()));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('ok=');
    expect(decodeURIComponent(res.headers.get('location')!)).toContain('from free to the team plan');

    const rows = await ceilingHistory(db, { teamId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      field: 'plan',
      previous: 'free',
      next: 'team',
      source: 'operator',
      route: 'POST /admin/teams/:id/plan',
      actorLabel: 'ada',
      teamSlug: 'ceiling-lab',
    });

    const detail = await (await fetch(`${srv.url}/admin/teams/${teamId}`, { headers: ada.header() })).text();
    expect(detail).toContain('Ceiling history');
    expect(detail).toContain('data-table="ceiling-history"');
    expect(detail).toContain('free → team');
    expect(detail).toContain('hosted and metered');

    const overview = await (await fetch(`${srv.url}/admin`, { headers: ada.header() })).text();
    expect(overview).toContain('Recent ceiling changes');
    expect(overview).toContain('free → team');
    expect(overview).toContain('Ceiling Lab');
  });

  it('writes nothing when the plan did not actually move', async () => {
    const before = (await db.select({ n: count() }).from(ceilingChanges))[0]!.n;
    const res = await fetch(`${srv.url}/admin/teams/${teamId}/plan`, form({ plan: 'team' }, ada.header()));
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get('location')!)).toContain('was already on the team plan');
    expect((await db.select({ n: count() }).from(ceilingChanges))[0]!.n).toBe(before);
  });

  it('refuses an unknown plan and a workspace that does not exist', async () => {
    const before = (await db.select({ n: count() }).from(ceilingChanges))[0]!.n;
    const bad = await fetch(`${srv.url}/admin/teams/${teamId}/plan`, form({ plan: 'platinum' }, ada.header()));
    expect(bad.headers.get('location')).toContain('error=');
    const missing = await setTeamPlan(db, {
      teamId: '11111111-2222-3333-4444-555555555555',
      plan: 'solo',
      source: 'operator',
      route: 'test',
    });
    expect(missing).toBeNull();
    expect((await db.select({ n: count() }).from(ceilingChanges))[0]!.n).toBe(before);
    const still = (await db.select({ plan: teams.plan }).from(teams).where(eq(teams.id, teamId)))[0];
    expect(still!.plan).toBe('team');
  });

  it('is capped, and deliberately never swept by age', async () => {
    const old = new Date(Date.now() - 900 * DAY);
    await db.insert(ceilingChanges).values({
      teamId,
      teamSlug: 'ceiling-lab',
      field: 'plan',
      previous: 'free',
      next: 'solo',
      source: 'operator',
      route: 'test',
      at: old,
    });
    await runCleanupOnce(db, loadEnv({ nodeEnv: 'test', databaseUrl: undefined, activityRetentionDays: 1 }));
    // Two and a half years old and the retention sweep leaves it: the row an
    // operator opens this table for is the old one.
    const survived = await db
      .select({ at: ceilingChanges.at })
      .from(ceilingChanges)
      .where(eq(ceilingChanges.teamId, teamId));
    expect(survived.some((r) => Math.abs(r.at.getTime() - old.getTime()) < 1000)).toBe(true);

    for (let i = 0; i < 6; i++) {
      await db.insert(ceilingChanges).values({
        teamId,
        teamSlug: 'ceiling-lab',
        field: 'plan',
        previous: 'free',
        next: 'team',
        source: 'operator',
        route: 'test',
        at: new Date(Date.now() + i * 1000),
      });
    }
    expect(await trimCeilingChanges(db, 1000)).toBe(0);
    const total = (await db.select({ n: count() }).from(ceilingChanges))[0]!.n;
    expect(await trimCeilingChanges(db, 2)).toBe(total - 2);
    expect((await db.select({ n: count() }).from(ceilingChanges))[0]!.n).toBe(2);
  });

  it('draws the record beside the live numbers on /admin/ops, and says which is which', async () => {
    await db.delete(loadSamples);
    const base = Math.floor(Date.now() / LOAD_BUCKET_MS) * LOAD_BUCKET_MS;
    await db.insert(loadSamples).values([
      {
        instance: 'ops',
        bucketAt: new Date(base - LOAD_BUCKET_MS),
        minutes: 5,
        requests: 4242,
        clientErrors: 7,
        serverErrors: 3,
        rateLimited: 2,
        latency: hist({ 7: 4242 }), // ≤100 ms
        rssMb: 311,
        loopLagMaxMs: 19,
      },
    ]);

    const html = await (await fetch(`${srv.url}/admin/ops`, { headers: ada.header() })).text();
    expect(html).toContain('data-card="load-history"');
    expect(html).toContain('data-table="load-history"');
    expect(html).toContain('Load history — the record');
    expect(html).toContain('4,242');
    expect(html).toContain('311 MB');
    expect(html).toContain('≤100 ms'); // recomputed from the stored histogram
    // The boundary between "this process" and "the record" is on the page, not
    // left for the reader to guess.
    expect(html).toContain('Traffic — last 60 minutes (this process)');
    expect(html).toContain('Status codes (this process)');
    expect(html).toContain('never averaged');
    // Every window is a link, and a window nobody offered falls back rather than 404s.
    for (const key of ['24h', '7d', '30d']) expect(html).toContain(`/admin/ops?history=${key}`);
    const wide = await fetch(`${srv.url}/admin/ops?history=30d`, { headers: ada.header() });
    expect(wide.status).toBe(200);
    expect(await wide.text()).toContain('4,242');
    const nonsense = await fetch(`${srv.url}/admin/ops?history=forever`, { headers: ada.header() });
    expect(nonsense.status).toBe(200);
    expect(await nonsense.text()).toContain('data-card="load-history"');
  });

  it('goes with the workspace it describes', async () => {
    await db.insert(ceilingChanges).values({
      teamId,
      teamSlug: 'ceiling-lab',
      field: 'plan',
      previous: 'team',
      next: 'free',
      source: 'billing',
      route: 'stripe:subscription_sync',
    });
    await db.delete(teams).where(eq(teams.id, teamId));
    expect((await db.select({ n: count() }).from(ceilingChanges))[0]!.n).toBe(0);
  });
});

// ------------------------------------------------------------- the mechanism

/**
 * The history is worth having only if nothing can move a ceiling around it.
 *
 * `teams.plan` is the whole ladder — every member, project, device, handoff,
 * integration, retention and feature limit is a lookup on it — so a second
 * writer would be a change nobody could account for afterwards. The Stripe
 * reconciliation was exactly that until this change: a plan moving with no
 * operator anywhere near it.
 *
 * `ee/` is scanned when present and simply absent from the public tree, which
 * is why this test walks the directory instead of importing anything from it.
 */
describe('nothing but lib/ceilings writes teams.plan', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const roots = [
    path.join(here, '..', 'src'),
    path.join(here, '..', '..', '..', 'ee', 'src'),
  ].filter((dir) => existsSync(dir));

  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sources(full);
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    });

  it('finds the plan column written in exactly one file', () => {
    expect(roots.length).toBeGreaterThan(0);
    // Both spellings a writer could use: the query builder, and raw SQL through
    // `db.execute`. An INSERT is deliberately not matched — a workspace created
    // on a plan is not a ceiling that moved — and neither is `drizzle/`, where a
    // migration like 0016's `pro` → `team` rename moves every row at once
    // without any application code running. That one is a release event, and the
    // place to record it is the release notes.
    const writes = [/\.update\(\s*teams\s*\)[\s\S]{0,300}?\bplan\b/, /update\s+teams\s+set[\s\S]{0,200}?\bplan\b/i];
    const writers = roots
      .flatMap(sources)
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return writes.some((re) => re.test(source));
      })
      .map((file) => path.basename(file));
    expect(writers).toEqual(['ceilings.ts']);
  });

  it('keeps the closed sets closed', () => {
    // A `field` or `source` a caller could choose would let it write sentences
    // into the operator log, which is the thing a log must not be.
    expect([...CEILING_FIELDS]).toEqual(['plan', 'evaluation']);
    expect([...CEILING_SOURCES]).toEqual(['operator', 'billing', 'owner']);
  });
});
