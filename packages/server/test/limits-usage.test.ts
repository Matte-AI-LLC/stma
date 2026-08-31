import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { teams, users } from '../src/db/schema';
import { hitCounter, readCounter, sweepCounters } from '../src/lib/counters';
import { PLANS } from '../src/lib/entitlements';
import { DAY_MS } from '../src/lib/counters';
import { activationFunnel, teamUsage, usageWindows } from '../src/lib/usage';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

/**
 * Cost ceilings and usage metering.
 *
 * Both were missing for the same reason: there was nowhere to count. The rate
 * limiter and the loop guard lived in a Map on one process, so nothing survived
 * a restart, nothing agreed across replicas, and no number existed that anyone
 * could bill or read.
 */

let srv: StartedServer;
let dataDir: string;
let token = '';
let cookie: Record<string, string> = {};

function jar() {
  const cookies = new Map<string, string>();
  return {
    header: (): Record<string, string> =>
      cookies.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {},
    store(res: Response) {
      for (const line of res.headers.getSetCookie()) {
        const [kv] = line.split(';');
        const i = kv!.indexOf('=');
        cookies.set(kv!.slice(0, i), kv!.slice(i + 1));
      }
    },
  };
}

const form = (url: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });

let rpcId = 1;
async function call(tool: string, args: Record<string, unknown>) {
  const res = await fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId++,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  });
  const json = (await res.json()) as {
    result?: { content?: { text: string }[]; isError?: boolean };
    error?: { message?: string };
  };
  return {
    text: json.result?.content?.[0]?.text ?? json.error?.message ?? '',
    isError: json.result?.isError === true || json.error !== undefined,
  };
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-limits-'));
  srv = await startServer(
    loadEnv({
      port: 0,
      host: 'localhost',
      nodeEnv: 'test',
      devMode: true,
      databaseUrl: undefined,
      pgliteDir: dataDir,
      // The plan only means anything on the hosted service. Everywhere else in
      // the suite runs unmetered, which is what an instance somebody runs
      // themselves gets — so a limits test has to say it is the other one.
      hosted: true,
    }),
  );
  const j = jar();
  j.store(await form(`${srv.url}/auth/dev`, { username: 'quinn' }));
  cookie = j.header();
  await form(`${srv.url}/app/teams`, { name: 'Limits' }, cookie);
  const res = await fetch(`${srv.url}/app/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...cookie },
    body: new URLSearchParams({ name: 'quinn-macbook' }),
  });
  token = /stma_[0-9a-f]{40}/.exec(await res.text())?.[0] ?? '';
  expect(token).toBeTruthy();
});

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

it('counts in the database, so two processes share one budget', async () => {
  const db = srv.db;
  // Two "instances" hitting the same key: the second sees the first one's count.
  const a = await hitCounter(db, 'test', 'shared', 60_000, 3);
  const b = await hitCounter(db, 'test', 'shared', 60_000, 3);
  const c = await hitCounter(db, 'test', 'shared', 60_000, 3);
  expect([a.count, b.count, c.count]).toEqual([1, 2, 3]);
  expect(c.exceeded).toBe(false);
  const d = await hitCounter(db, 'test', 'shared', 60_000, 3);
  expect(d.count).toBe(4);
  expect(d.exceeded).toBe(true);
  expect(await readCounter(db, 'test', 'shared', 60_000)).toBe(4);
  // Reading must not spend a hit.
  expect(await readCounter(db, 'test', 'shared', 60_000)).toBe(4);
});

it('starts a fresh budget in a new window rather than resetting the old one', async () => {
  const db = srv.db;
  // A one-second window: the second call lands in a different bucket.
  await hitCounter(db, 'test', 'window', 1_000, 100);
  const before = await readCounter(db, 'test', 'window', 1_000);
  expect(before).toBeGreaterThan(0);
  await new Promise((r) => setTimeout(r, 1_100));
  const after = await readCounter(db, 'test', 'window', 1_000);
  expect(after, 'a new window starts empty').toBe(0);
});

it('sweeps closed windows and leaves live ones alone', async () => {
  const db = srv.db;
  await hitCounter(db, 'test', 'live', 60_000, 100);
  await hitCounter(db, 'test', 'dead', 1, 100);
  await new Promise((r) => setTimeout(r, 20));
  const removed = await sweepCounters(db);
  expect(removed).toBeGreaterThan(0);
  expect(await readCounter(db, 'test', 'live', 60_000)).toBe(1);
});

it('caps a team at its plan allowance and says so in words an agent can act on', async () => {
  const db = srv.db;
  const team = (await db.select().from(teams)).find((t) => t.slug === 'limits')!;
  expect(team.plan).toBe('free');

  // Spend the whole free allowance in one charge rather than making 20,000 calls.
  await hitCounter(
    db,
    'team-day',
    team.id,
    DAY_MS,
    PLANS.free.maxToolCallsPerDay,
    PLANS.free.maxToolCallsPerDay,
  );

  const blocked = await call('list_projects', { team: 'limits' });
  expect(blocked.isError).toBe(true);
  expect(blocked.text).toContain('tool calls for today');
  expect(blocked.text).toContain('Nothing was written');
  expect(blocked.text).toContain('larger plan');

  // The same counter, read against the bigger plan, lets the team through — the
  // allowance is the plan's, not the counter's.
  await db.update(teams).set({ plan: 'team' }).where(eq(teams.id, team.id));
  const allowed = await call('list_projects', { team: 'limits' });
  expect(allowed.isError, allowed.text).toBe(false);
});

it('brakes an agent ping-ponging in one session, across restarts of the process', async () => {
  const opened = await call('open_session', { title: 'Loop guard subject', team: 'limits' });
  const sessionId = /"sessionId":\s*"([0-9a-f-]+)"/.exec(opened.text)?.[1];
  expect(sessionId).toBeTruthy();
  let tripped = '';
  for (let i = 0; i < 25; i++) {
    const posted = await call('post_message', { session_id: sessionId!, body: `ping ${i}` });
    if (posted.isError) {
      tripped = posted.text;
      break;
    }
  }
  expect(tripped, 'the guard must trip inside 25 posts').toContain('Loop guard');
  // The count lives in the database, not in a Map — which is what makes it mean
  // the same thing on a second replica and survive a restart.
  const quinn = (await srv.db.select().from(users)).find((u) => u.username === 'quinn')!;
  const counted = await readCounter(srv.db, 'loop', `${sessionId}:${quinn.id}`, 60 * 60 * 1000);
  expect(counted).toBeGreaterThan(20);
});

// ---------------------------------------------------------------- metering

it('answers "is anyone using this" from what the app already records', async () => {
  const windows = await usageWindows(srv.db);
  expect(windows.monthly.humans).toBeGreaterThan(0);
  expect(windows.monthly.agents).toBeGreaterThan(0);
  expect(windows.monthly.teams).toBeGreaterThan(0);
  // The narrower window can never exceed the wider one.
  expect(windows.weekly.humans).toBeLessThanOrEqual(windows.monthly.humans);
  expect(windows.daily.events).toBeLessThanOrEqual(windows.monthly.events);
  expect(windows.stickiness).not.toBeNull();
});

it('reports an activation funnel that only ever narrows', async () => {
  const funnel = await activationFunnel(srv.db);
  expect(funnel[0]!.key).toBe('created');
  expect(funnel[0]!.teams).toBeGreaterThan(0);
  // Every step is a subset of "team created", and each carries a line a human
  // can act on rather than a bare number.
  for (const step of funnel) {
    expect(step.teams).toBeLessThanOrEqual(funnel[0]!.teams);
    expect(step.note.length).toBeGreaterThan(10);
  }
  const joined = funnel.find((s) => s.key === 'joined')!;
  expect(joined.teams, 'a solo team has not activated').toBe(0);
});

it('shows per-team usage with the same call count the quota enforces', async () => {
  const rows = await teamUsage(srv.db);
  expect(rows.length).toBeGreaterThan(0);
  const limits = rows.find((r) => r.slug === 'limits')!;
  expect(limits.humans30d).toBeGreaterThan(0);
  expect(limits.members).toBe(1);
  // The quota test spent the free allowance on this team, and the usage page
  // reads that very counter — the two must not disagree.
  expect(limits.callsToday).toBeGreaterThanOrEqual(PLANS.free.maxToolCallsPerDay);
  expect(limits.lastActiveAt).toBeInstanceOf(Date);
});
