import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';
import { providerObservations, repositoryBindings, teamIntegrations, teams, users } from '../src/db/schema';
import { observeAdoBuild } from '../src/domain/adoEvidence';
import { adoOutbox } from '../src/lib/azureDevops';

let server: StartedServer;
let dir: string;
let teamId: string;
let bindingId: string;
const repositoryId = randomUUID();
const hook = randomUUID();
const env = loadEnv({ nodeEnv: 'test', port: 0, host: '127.0.0.1', databaseUrl: undefined });
const wireBuild = (id: number, overrides: Record<string, unknown> = {}) => ({
  id, repository: { id: repositoryId, type: 'TfsGit' }, sourceVersion: 'c'.repeat(40),
  status: 'completed', result: 'succeeded', lastChangedDate: new Date(Date.now() - 1000).toISOString(),
  ...overrides,
});
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'stma-ado-evidence-'));
  server = await startServer({ ...env, pgliteDir: dir });
  const [user] = await server.db.insert(users).values({ username: 'ado-evidence-owner' }).returning();
  const [team] = await server.db.insert(teams).values({ name: 'ADO evidence', slug: 'ado-evidence', createdBy: user!.id, inboundToken: hook }).returning();
  teamId = team!.id;
  const [connection] = await server.db.insert(teamIntegrations).values({ teamId, provider: 'azure-devops', repo: 'acme/service/api', token: 'fixture-only', createdBy: user!.id }).returning();
  const [binding] = await server.db.insert(repositoryBindings).values({ connectionId: connection!.id, teamId, provider: 'azure-devops', repositoryId, fullName: 'acme/service/api', verifiedAt: new Date() }).returning();
  bindingId = binding!.id;
});
beforeEach(() => adoOutbox.clear());
afterAll(async () => { await server?.close(); rmSync(dir, { recursive: true, force: true }); });

it('reads the exact build, deduplicates it and rejects an older update', async () => {
  adoOutbox.seedBuild(12, wireBuild(12));
  expect(await observeAdoBuild(server.db, env, teamId, bindingId, 12)).toHaveProperty('recorded', true);
  expect(await observeAdoBuild(server.db, env, teamId, bindingId, 12)).toHaveProperty('reason', 'duplicate');
  adoOutbox.seedBuild(12, wireBuild(12, { result: 'failed', lastChangedDate: new Date(Date.now() - 60_000).toISOString() }));
  expect(await observeAdoBuild(server.db, env, teamId, bindingId, 12)).toHaveProperty('reason', 'stale_event');
  const rows = await server.db.select().from(providerObservations).where(eq(providerObservations.subjectId, 'build:12'));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ state: 'success', commitSha: 'c'.repeat(40), attempt: 1 });
  expect(adoOutbox.all().every((call) => call.method === 'GET')).toBe(true);
});

it.each([
  { id: 999 },
  { repository: { id: randomUUID(), type: 'TfsGit' } },
  { repository: { id: repositoryId, type: 'GitHub' } },
  { sourceVersion: undefined },
  { deleted: true },
  { lastChangedDate: 'not-a-date' },
])('refuses incomplete or wrong provider identity %#', async (overrides) => {
  adoOutbox.seedBuild(13, wireBuild(13, overrides));
  expect(await observeAdoBuild(server.db, env, teamId, bindingId, 13)).toHaveProperty('reason', 'provider_identity_mismatch');
});

it.each([
  ['completed', 'partiallySucceeded', 'failure'],
  ['completed', 'failed', 'failure'],
  ['inProgress', 'succeeded', 'unknown'],
  ['completed', 'canceled', 'unknown'],
])('keeps %s/%s as %s', async (status, result, expected) => {
  const id = 100 + adoCase++;
  adoOutbox.seedBuild(id, wireBuild(id, { status, result }));
  expect(await observeAdoBuild(server.db, env, teamId, bindingId, id)).toHaveProperty('recorded', true);
  expect((await server.db.select().from(providerObservations).where(eq(providerObservations.subjectId, `build:${id}`)))[0]!.state).toBe(expected);
});
let adoCase = 0;

it('rejects cross-workspace binding access before making a provider request', async () => {
  expect(await observeAdoBuild(server.db, env, randomUUID(), bindingId, 12)).toHaveProperty('reason', 'repository_not_verified');
  expect(adoOutbox.all()).toHaveLength(0);
});

it('handles the minimal scoped hook and ignores forged payload results and URLs', async () => {
  adoOutbox.seedBuild(25, wireBuild(25, { result: 'failed' }));
  const res = await fetch(`${server.url}/api/hooks/azure-devops/${hook}/${bindingId}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ eventType: 'build.complete', resource: { id: 25, result: 'succeeded', url: 'https://invalid.example/build', sourceVersion: 'a'.repeat(40) } }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toHaveProperty('evidence.recorded', true);
  expect((await server.db.select().from(providerObservations).where(eq(providerObservations.subjectId, 'build:25')))[0]).toMatchObject({ state: 'failure', commitSha: 'c'.repeat(40) });
  expect(adoOutbox.all()[0]?.path).toBe('/acme/service/_apis/build/builds/25?api-version=7.1');
});

it('requests hook retry when provider read-back is unavailable', async () => {
  const res = await fetch(`${server.url}/api/hooks/azure-devops/${hook}/${bindingId}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ eventType: 'build.complete', resource: { id: 26 } }),
  });
  expect(res.status).toBe(503);
  expect(await res.json()).toHaveProperty('evidence.reason', 'provider_unavailable');
});

it.each([null, [], { resource: null }, { eventType: 12 }, { eventType: 'build.complete', resource: { sourceBranch: 1 } }])('rejects malformed hook payload %# without a server error', async (payload) => {
  const res = await fetch(`${server.url}/api/hooks/azure-devops/${hook}/${bindingId}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  expect(res.status).toBe(400);
  expect(adoOutbox.all()).toHaveLength(0);
});
