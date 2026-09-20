import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  agentEvents,
  agentInstallations,
  agentRuns,
  debugSessions,
  handoffs,
  launchAttempts,
  teams,
  users,
} from '../src/db/schema';
import { hitCounter, readCounter, sweepCounters } from '../src/lib/counters';
import { PLANS } from '../src/lib/entitlements';
import { DAY_MS } from '../src/lib/counters';
import {
  activationFunnel,
  calculateContribution,
  ECONOMIC_SOURCE_COVERAGE,
  economicObservation,
  PILOT_OBSERVATION_WEEKS,
  teamUsage,
  usageWindows,
} from '../src/lib/usage';
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
      host: '127.0.0.1',
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

it('reports retained value signals and keeps measured, estimated and missing run cost apart', async () => {
  const db = srv.db;
  const team = (await db.select().from(teams)).find((row) => row.slug === 'limits')!;
  const owner = (await db.select().from(users)).find((row) => row.username === 'quinn')!;
  const [installation] = await db
    .insert(agentInstallations)
    .values({
      userId: owner.id,
      name: 'economics-fixture',
      deviceLabel: 'economics-fixture',
      clientType: 'generic',
      deviceFingerprint: randomUUID(),
    })
    .returning();
  const now = new Date();
  const [measured, estimated, unreported] = await db
    .insert(agentRuns)
    .values([
      {
        teamId: team.id,
        installationId: installation!.id,
        status: 'completed',
        costCents: 125,
        costSource: 'measured',
        endedAt: now,
        lastHeartbeatAt: now,
      },
      {
        teamId: team.id,
        installationId: installation!.id,
        status: 'completed',
        costCents: 475,
        costSource: 'estimate',
        endedAt: now,
        lastHeartbeatAt: now,
      },
      {
        teamId: team.id,
        installationId: installation!.id,
        status: 'completed',
        endedAt: now,
        lastHeartbeatAt: now,
      },
    ])
    .returning();
  await db.insert(agentEvents).values([
    { runId: measured!.id, type: 'pr_opened', createdAt: now },
    // Several events on one run remain one review-signal run.
    { runId: measured!.id, type: 'pr_merged', createdAt: now },
    { runId: measured!.id, type: 'ci_completed', detail: { conclusion: 'success' }, createdAt: now },
    { runId: estimated!.id, type: 'pr_opened', createdAt: now },
  ]);
  await db.insert(launchAttempts).values({
    teamId: team.id,
    userId: owner.id,
    exchangeConfirmedAt: new Date(now.getTime() - 1_000),
    firstRealResultAt: now,
  });
  const sessions = await db
    .insert(debugSessions)
    .values([
      { teamId: team.id, openedBy: owner.id, title: 'Economic handoff one' },
      { teamId: team.id, openedBy: owner.id, title: 'Economic handoff two' },
    ])
    .returning();
  await db.insert(handoffs).values([
    {
      sessionId: sessions[0]!.id,
      offeredBy: owner.id,
      state: 'completed',
      resumedAt: now,
      completedAt: now,
      updatedAt: now,
    },
    {
      sessionId: sessions[1]!.id,
      offeredBy: owner.id,
      state: 'in_progress',
      resumedAt: now,
      updatedAt: now,
    },
  ]);

  const report = await economicObservation(db, 400);
  expect(report.days, 'operator windows are bounded').toBe(90);
  expect(report.firstRealResults).toMatchObject({ reports: 1, teams: 1 });
  expect(report.handoffs).toMatchObject({ offered: 2, resumed: 2, completed: 1, repeatTeams: 1 });
  expect(report.reviewSignals).toMatchObject({ runs: 2, mergedRuns: 1, ciRuns: 1, repeatTeams: 1 });
  expect(report.runCosts).toEqual({
    measuredRuns: 1,
    measuredCents: 125,
    estimatedRuns: 1,
    estimatedCents: 475,
    unreportedRuns: 1,
  });
  expect(report.firstRealResults.latestAt).toBeInstanceOf(Date);
  expect(report.handoffs.latestAt).toBeInstanceOf(Date);
  expect(report.reviewSignals.latestAt).toBeInstanceOf(Date);
  expect(ECONOMIC_SOURCE_COVERAGE.filter((row) => row.status === 'unknown').map((row) => row.key))
    .toEqual(['support', 'direct_service', 'managed_job']);
  expect(PILOT_OBSERVATION_WEEKS.map((row) => row.week)).toEqual([1, 2, 3, 4]);
  expect(unreported!.costCents).toBeNull();
});

const estimated = (cents: number) => ({ cents, source: 'estimated' as const });
const measured = (cents: number) => ({ cents, source: 'measured' as const });
const unknown = () => ({ cents: null, source: 'unknown' as const });

it('calculates the small pilot case without inventing a managed-usage line', () => {
  const result = calculateContribution({
    cash: { subscriptionCollected: estimated(1_900), managedUsageCollected: estimated(0) },
    coreSubscriptionRevenue: estimated(1_900),
    consumption: {
      includedManagedUsageValue: estimated(0),
      purchasedManagedUsageRevenue: estimated(0),
    },
    expenses: [
      { id: 'small-direct', lane: 'core', kind: 'direct_service', amount: estimated(300) },
      {
        id: 'small-support',
        lane: 'core',
        kind: 'support',
        minutes: { value: 10, source: 'estimated' },
        hourlyCostCents: estimated(6_000),
      },
    ],
  });
  expect(result.cash.totalCollected).toEqual(estimated(1_900));
  expect(result.core.contribution).toEqual(estimated(600));
  expect(result.managed.contribution).toEqual(estimated(0));
  expect(result.totalContribution).toEqual(estimated(600));

  const lowerPrice = calculateContribution({
    cash: { subscriptionCollected: estimated(900), managedUsageCollected: estimated(0) },
    coreSubscriptionRevenue: estimated(900),
    consumption: {
      includedManagedUsageValue: estimated(0),
      purchasedManagedUsageRevenue: estimated(0),
    },
    expenses: [
      { id: 'small-low-direct', lane: 'core', kind: 'direct_service', amount: estimated(300) },
      {
        id: 'small-low-support',
        lane: 'core',
        kind: 'support',
        minutes: { value: 10, source: 'estimated' },
        hourlyCostCents: estimated(6_000),
      },
    ],
  });
  expect(lowerPrice.totalContribution).toEqual(estimated(-400));
});

it('calculates the heavy pilot case with cash and included consumption kept separate', () => {
  const result = calculateContribution({
    cash: {
      subscriptionCollected: estimated(4_900),
      managedUsageCollected: estimated(2_000),
    },
    coreSubscriptionRevenue: estimated(4_900),
    consumption: {
      includedManagedUsageValue: estimated(500),
      purchasedManagedUsageRevenue: estimated(2_000),
    },
    expenses: [
      { id: 'heavy-services', lane: 'core', kind: 'direct_service', amount: estimated(300) },
      { id: 'heavy-core-collection', lane: 'core', kind: 'collection', amount: estimated(190) },
      {
        id: 'heavy-support',
        lane: 'core',
        kind: 'support',
        minutes: { value: 10, source: 'estimated' },
        hourlyCostCents: estimated(6_000),
      },
      // Allocate the provider invoice once: the cost behind included usage
      // belongs to core; only purchased consumption belongs to managed.
      { id: 'heavy-included-jobs', lane: 'core', kind: 'managed_job', amount: estimated(100) },
      { id: 'heavy-managed-collection', lane: 'managed', kind: 'collection', amount: estimated(77) },
      { id: 'heavy-purchased-jobs', lane: 'managed', kind: 'managed_job', amount: estimated(400) },
    ],
  });

  expect(result.cash.totalCollected).toEqual(estimated(6_900));
  expect(result.consumption.totalManagedUsageValue).toEqual(estimated(2_500));
  // The included $5 remains consumption. It is not added to $49 + $20 revenue.
  expect(result.core.revenue.cents! + result.managed.revenue.cents!).toBe(6_900);
  expect(result.core.contribution).toEqual(estimated(3_310));
  expect(result.managed.contribution).toEqual(estimated(1_523));
  expect(result.totalContribution).toEqual(estimated(4_833));
});

it('refuses a shared expense twice and keeps missing cost inputs unknown', () => {
  const base = {
    cash: { subscriptionCollected: measured(1_900), managedUsageCollected: measured(0) },
    coreSubscriptionRevenue: measured(1_900),
    consumption: {
      includedManagedUsageValue: measured(0),
      purchasedManagedUsageRevenue: measured(0),
    },
  };
  expect(() =>
    calculateContribution({
      ...base,
      expenses: [
        { id: 'shared-bill', lane: 'core', kind: 'direct_service', amount: measured(300) },
        { id: 'shared-bill', lane: 'managed', kind: 'managed_job', amount: measured(300) },
      ],
    }),
  ).toThrow('allocated more than once');

  const result = calculateContribution({
    ...base,
    expenses: [
      { id: 'support-time', lane: 'core', kind: 'support', minutes: { value: null, source: 'unknown' }, hourlyCostCents: unknown() },
      { id: 'direct-service', lane: 'core', kind: 'direct_service', amount: unknown() },
      { id: 'optional-managed-job', lane: 'managed', kind: 'managed_job', amount: unknown() },
    ],
  });
  expect(result.core.contribution).toEqual(unknown());
  expect(result.managed.contribution).toEqual(unknown());
  expect(result.totalContribution).toEqual(unknown());
  expect(result.unknownExpenseIds).toEqual([
    'support-time',
    'direct-service',
    'optional-managed-job',
  ]);
});
