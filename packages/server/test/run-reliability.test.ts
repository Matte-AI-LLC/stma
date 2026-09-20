import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';
import { agentEvents, agentRuns, workClaims } from '../src/db/schema';
import { markStaleAgentRuns } from '../src/domain/agents';

let srv: StartedServer;
let dataDir = '';
let token = '';
let installationId = '';

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

const api = (endpoint: string, body: unknown) =>
  fetch(`${srv.url}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-run-reliability-'));
  srv = await startServer(
    loadEnv({
      port: 0,
      host: '127.0.0.1',
      nodeEnv: 'test',
      devMode: true,
      databaseUrl: undefined,
      pgliteDir: dataDir,
    }),
  );
  const browser = jar();
  browser.store(await form(`${srv.url}/auth/dev`, { username: 'retry-owner' }));
  await form(`${srv.url}/app/teams`, { name: 'Retry Lab' }, browser.header());
  const created = await fetch(`${srv.url}/app/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...browser.header() },
    body: new URLSearchParams({ name: 'retry-client' }),
  });
  token = /stma_[0-9a-f]{40}/.exec(await created.text())?.[0] ?? '';
  expect(token).toBeTruthy();
  const registered = await api('/api/agent/installations/register', {
    name: 'retry-client',
    clientType: 'codex',
    deviceFingerprint: 'run-reliability-device',
    capabilities: ['lifecycle'],
  });
  expect(registered.status).toBe(200);
  installationId = ((await registered.json()) as any).installation.id;
});

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function startBody(requestId: string, taskKey = 'REL-1') {
  return {
    requestId,
    installationId,
    team: 'retry-lab',
    project: 'acme/reliability',
    taskKey,
    intent: 'Make run lifecycle retries deterministic.',
    worktree: '/worktrees/reliability-a',
    claims: [{ resourceType: 'migration', resourceKey: '0030-lifecycle', access: 'write' }],
  };
}

it('returns one run for lost-response and concurrent retries', async () => {
  const requestId = randomUUID();
  const first = await api('/api/agent/runs/start', startBody(requestId));
  expect(first.status).toBe(200);
  const one = (await first.json()) as any;
  expect(one.replayed).toBe(false);

  const replay = await api('/api/agent/runs/start', startBody(requestId));
  expect(replay.status).toBe(200);
  const two = (await replay.json()) as any;
  expect(two.run.id).toBe(one.run.id);
  expect(two.replayed).toBe(true);

  const changed = await api('/api/agent/runs/start', startBody(requestId, 'REL-CHANGED'));
  expect(changed.status).toBe(400);
  expect(((await changed.json()) as any).error).toContain('different arguments');

  const concurrentId = randomUUID();
  const responses = await Promise.all(
    Array.from({ length: 4 }, () => api('/api/agent/runs/start', startBody(concurrentId, 'REL-2'))),
  );
  expect(responses.every((response) => response.status === 200)).toBe(true);
  const payloads = await Promise.all(responses.map((response) => response.json() as Promise<any>));
  expect(new Set(payloads.map((payload) => payload.run.id)).size).toBe(1);
  expect(payloads.filter((payload) => payload.replayed === false)).toHaveLength(1);

  const rows = await srv.db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.installationId, installationId),
        eq(agentRuns.startRequestId, concurrentId),
      ),
    );
  expect(rows).toHaveLength(1);
});

it('keeps waiting claims alive for a human response without keeping abandoned active work', async () => {
  const activeResponse = await api(
    '/api/agent/runs/start',
    startBody(randomUUID(), 'REL-ACTIVE-STALE'),
  );
  const waitingResponse = await api(
    '/api/agent/runs/start',
    startBody(randomUUID(), 'REL-WAITING-HUMAN'),
  );
  const activeId = ((await activeResponse.json()) as any).run.id as string;
  const waitingId = ((await waitingResponse.json()) as any).run.id as string;

  const waitingBeat = await api(`/api/agent/runs/${waitingId}/heartbeat`, {
    status: 'waiting',
  });
  expect(waitingBeat.status).toBe(200);
  expect((await waitingBeat.json()) as any).toMatchObject({
    status: 'waiting',
    leaseMinutes: 30,
  });
  const [waitingClaim] = await srv.db
    .select()
    .from(workClaims)
    .where(eq(workClaims.runId, waitingId));
  expect(waitingClaim!.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);

  const fourMinutesAgo = new Date(Date.now() - 4 * 60_000);
  await srv.db
    .update(agentRuns)
    .set({ lastHeartbeatAt: fourMinutesAgo })
    .where(eq(agentRuns.id, activeId));
  await srv.db
    .update(agentRuns)
    .set({ lastHeartbeatAt: fourMinutesAgo })
    .where(eq(agentRuns.id, waitingId));

  await markStaleAgentRuns(srv.db, 3, 30);
  const [activeAfterShortWindow] = await srv.db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, activeId));
  const [waitingAfterShortWindow] = await srv.db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, waitingId));
  expect(activeAfterShortWindow!.status).toBe('stale');
  expect(waitingAfterShortWindow!.status).toBe('waiting');

  await srv.db
    .update(agentRuns)
    .set({ lastHeartbeatAt: new Date(Date.now() - 31 * 60_000) })
    .where(eq(agentRuns.id, waitingId));
  await markStaleAgentRuns(srv.db, 3, 30);
  const [waitingAfterHumanWindow] = await srv.db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, waitingId));
  expect(waitingAfterHumanWindow!.status).toBe('stale');
});

it('serializes heartbeat and finish so terminal work and leases cannot revive', async () => {
  for (let n = 0; n < 6; n += 1) {
    const started = await api(
      '/api/agent/runs/start',
      startBody(randomUUID(), `REL-RACE-${n}`),
    );
    const runId = ((await started.json()) as any).run.id as string;
    const [heartbeat, finish] = await Promise.all([
      api(`/api/agent/runs/${runId}/heartbeat`, {
        status: 'active',
        claims: [
          { resourceType: 'migration', resourceKey: '0030-lifecycle', access: 'write' },
        ],
      }),
      api(`/api/agent/runs/${runId}/finish`, { status: 'completed', detail: 'done' }),
    ]);
    expect([200, 404]).toContain(heartbeat.status);
    expect(finish.status).toBe(200);

    const [run] = await srv.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(run?.status).toBe('completed');
    expect(run?.endedAt).toBeInstanceOf(Date);
    const claims = await srv.db.select().from(workClaims).where(eq(workClaims.runId, runId));
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((claim) => claim.leaseExpiresAt.getTime() <= Date.now())).toBe(true);

    const late = await api(`/api/agent/runs/${runId}/heartbeat`, { status: 'active' });
    expect(late.status).toBe(404);
    const replayedFinish = await api(`/api/agent/runs/${runId}/finish`, {
      status: 'completed',
      detail: 'same retry',
    });
    expect(replayedFinish.status).toBe(200);
    expect(((await replayedFinish.json()) as any).replayed).toBe(true);
    const events = await srv.db
      .select()
      .from(agentEvents)
      .where(and(eq(agentEvents.runId, runId), eq(agentEvents.type, 'run_finished')));
    expect(events).toHaveLength(1);
  }
});

it('keeps planned and observed scope separate and returns common readiness', async () => {
  const requestId = randomUUID();
  const started = await api('/api/agent/runs/start', {
    requestId,
    installationId,
    team: 'retry-lab',
    project: 'acme/scope-source',
    taskKey: 'REL-SCOPE',
    claims: [{ resourceType: 'path', resourceKey: 'src/planned.ts', access: 'write' }],
  });
  expect(started.status).toBe(200);
  const body = (await started.json()) as any;
  expect(body.readiness).toMatchObject({ advisory: true });
  expect(body.readiness.enforcement).toContain('Local writes stop only');

  const heartbeat = await api(`/api/agent/runs/${body.run.id}/heartbeat`, {
    status: 'active',
    claimSource: 'observed',
    claims: [{ resourceType: 'path', resourceKey: 'src/observed.ts', access: 'write' }],
  });
  expect(heartbeat.status).toBe(200);
  expect((await heartbeat.json()) as any).toHaveProperty('stale');

  const claims = await srv.db
    .select()
    .from(workClaims)
    .where(eq(workClaims.runId, body.run.id));
  expect(
    claims.map((claim) => `${claim.source}:${claim.resourceKey}`).sort(),
  ).toEqual(['observed:src/observed.ts', 'planned:src/planned.ts']);
});
