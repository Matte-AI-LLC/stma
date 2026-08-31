import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { desc } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { connectDb } from '../src/db';
import { errorEvents } from '../src/db/schema';
import { loadEnv } from '../src/env';
import { trimErrorEvents } from '../src/lib/errors';
import { MAX_PATHS, MAX_TOOLS, createMetricsStore, templatePath } from '../src/lib/metrics';
import { startServer, type StartedServer } from '../src/server';

let srv: StartedServer;
let dataDir: string;

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

async function devLogin(server: StartedServer, username: string) {
  const j = jar();
  const res = await fetch(`${server.url}/auth/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username }),
    redirect: 'manual',
  });
  j.store(res);
  expect(res.status).toBe(302);
  return j;
}

beforeAll(async () => {
  process.env.ADMIN_USERNAMES = 'ada';
  dataDir = mkdtempSync(path.join(tmpdir(), 'bridge-ops-'));
  srv = await startServer(
    loadEnv({
      port: 0,
      host: 'localhost',
      nodeEnv: 'test',
      devMode: true,
      databaseUrl: undefined,
      pgliteDir: dataDir,
    }),
  );
  delete process.env.ADMIN_USERNAMES;
}, 60_000);

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// Shared across the sequential tests below (same pattern as admin.test.ts).
let ada: ReturnType<typeof jar>;
let mallory: ReturnType<typeof jar>;

/** A fake PAT of exactly the shape lib/redact scrubs. */
const FAKE_PAT = `stma_${'deadbeef'.repeat(5)}`;

it('is a plain 404 for anonymous visitors and signed-in non-admins', async () => {
  expect((await fetch(`${srv.url}/admin/ops`)).status).toBe(404);
  mallory = await devLogin(srv, 'mallory');
  expect((await fetch(`${srv.url}/admin/ops`, { headers: mallory.header() })).status).toBe(404);
});

it('renders the tiles for an admin and counts the requests it has served', async () => {
  ada = await devLogin(srv, 'ada');
  for (const p of ['/app', '/app/sessions', '/app/tokens', '/docs']) {
    expect((await fetch(srv.url + p, { headers: ada.header() })).status).toBe(200);
  }

  const res = await fetch(`${srv.url}/admin/ops`, { headers: ada.header() });
  expect(res.status).toBe(200);
  const html = await res.text();
  for (const label of [
    'Requests (1h)',
    'Error rate (1h)',
    'p95 latency',
    'Uptime',
    'Memory (rss)',
    'Active agent runs',
    'Traffic — last 60 minutes',
    'Status codes',
    'Recent errors',
    'Top error messages (24h)',
    'Slowest endpoints',
    'Busiest endpoints',
    'MCP tool usage',
    'Storage',
  ]) {
    expect(html).toContain(label);
  }
  // The sparkline is 60 plain divs/spans, no chart library.
  expect(html.match(/class="spark-bar/g)?.length).toBe(60);
  expect(html).toContain('data-autorefresh="30"');

  const requests = Number(
    /data-metric="requests-hour"[^>]*>\s*([\d,]+)/.exec(html)?.[1]?.replace(/,/g, '') ?? '0',
  );
  expect(requests).toBeGreaterThan(0);
  // Templated paths, not raw ids.
  expect(html).toContain('/app/sessions');
  // Storage row counts for the main tables.
  for (const table of ['users', 'teams', 'snapshots', 'error_events']) {
    expect(html).toContain(table);
  }
});

it('persists a 500 into the error log and shows it, with secrets redacted', async () => {
  // An id that is not a uuid makes the session lookup throw inside the route —
  // a genuine 500 through app.onError. The id also carries a PAT-shaped secret.
  const boom = await fetch(`${srv.url}/app/sessions/${FAKE_PAT}`, { headers: ada.header() });
  expect(boom.status).toBe(500);

  const html = await (await fetch(`${srv.url}/admin/ops`, { headers: ada.header() })).text();
  expect(html).toContain('data-table="recent-errors"');
  expect(html).toContain('data-table="top-errors"');
  expect(html).toContain('>http<'); // kind pill
  expect(html).toContain('>500<'); // status column
  expect(html).toContain('ada'); // the signed-in user is resolved from the stored id
  // The underlying database error is kept, not just drizzle's "Failed query: …" wrapper.
  expect(html).toContain('invalid input syntax for type uuid');

  // Redaction: neither the message nor the stored path may leak the token.
  expect(html).not.toContain(FAKE_PAT);
  expect(html).toContain('[REDACTED]');
  expect(html).toContain('/app/sessions/[REDACTED]');
  // The 5xx is reflected in the load view too.
  expect(html).toContain('spark-bar bad');
});

it('templates paths so ids and hook tokens never reach the metrics', () => {
  const uuid = '11111111-2222-3333-4444-555555555555';
  expect(templatePath(`/app/sessions/${uuid}/messages`)).toBe('/app/sessions/:id/messages');
  expect(templatePath('/app/teams/growth-lab')).toBe('/app/teams/:slug');
  expect(templatePath(`/app/teams/growth-lab/invites/${uuid}/revoke`)).toBe(
    '/app/teams/:slug/invites/:id/revoke',
  );
  expect(templatePath('/api/hooks/announce/s3cr3tT0ken')).toBe('/api/hooks/announce/:token');
  expect(templatePath('/join/aBcD-1234_xyz')).toBe('/join/:code');
  expect(templatePath('/api/agent/runs/42/heartbeat')).toBe('/api/agent/runs/:id/heartbeat');
  expect(templatePath('/docs')).toBe('/docs');
});

it('caps the error log so the table can never grow unbounded', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-ops-trim-'));
  const { db, close } = await connectDb(
    loadEnv({ port: 0, nodeEnv: 'test', databaseUrl: undefined, pgliteDir: dir }),
  );
  try {
    for (let i = 0; i < 6; i++) {
      await db
        .insert(errorEvents)
        .values({ kind: 'unhandled', message: `boom ${i}`, at: new Date(Date.now() + i * 1000) });
    }
    expect(await trimErrorEvents(db, 10)).toBe(0); // under the cap nothing is touched
    expect(await trimErrorEvents(db, 2)).toBe(4);
    const left = await db
      .select({ message: errorEvents.message })
      .from(errorEvents)
      .orderBy(desc(errorEvents.at));
    expect(left.map((r) => r.message)).toEqual(['boom 5', 'boom 4']); // newest kept
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

it('keeps the metrics store bounded however much traffic it sees', () => {
  const store = createMetricsStore();
  for (let i = 0; i < 5_000; i++) {
    store.recordRequest({
      method: 'GET',
      path: `/scan/${i}/leaf${i % 997}x`,
      status: i % 50 === 0 ? 500 : 200,
      ms: i % 1200,
      tool: `tool_${i}`,
    });
  }
  const snap = store.read();
  expect(snap.totals.requests).toBe(5_000);
  // Fixed-size structures: capped maps, a 60-slot ring, top-N lists.
  expect(snap.trackedPaths).toBeLessThanOrEqual(MAX_PATHS);
  expect(snap.trackedTools).toBeLessThanOrEqual(MAX_TOOLS);
  expect(snap.lastHour.minutes).toHaveLength(60);
  expect(snap.busiestPaths).toHaveLength(10);
  expect(snap.slowestPaths).toHaveLength(10);
  expect(snap.tools.length).toBeLessThanOrEqual(20);
  // Nothing is lost even when paths fold into the overflow bucket.
  expect(snap.busiestPaths.some((p) => p.path === '(other)')).toBe(true);
  expect(snap.totals.byClass.c5xx).toBe(100);
  expect(snap.totals.p95).toBeGreaterThan(0);

  // A second store is independent of the process-wide singleton.
  const fresh = createMetricsStore();
  expect(fresh.read().totals.requests).toBe(0);
  const stop = fresh.startSampler();
  stop();
  stop(); // idempotent — releasing twice must not unbalance the refcount
});
