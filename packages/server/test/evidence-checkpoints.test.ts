import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { connectDb, type Db } from '../src/db';
import {
  agentInstallations,
  agentRuns,
  memberships,
  projects,
  repositoryBindings,
  runCheckpoints,
  teamIntegrations,
  teams,
  users,
} from '../src/db/schema';
import { evidenceForRun } from '../src/domain/evidence';
import { recordProviderObservation } from '../src/domain/providerEvidence';
import { loadEnv } from '../src/env';

let db: Db;
let close: () => Promise<void>;
let dir: string;
let userId: string;
let teamId: string;
let projectId: string;
let installationId: string;
let bindingId: string;

const sha = (letter: string) => letter.repeat(40);

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'stma-evidence-checkpoints-'));
  ({ db, close } = await connectDb(
    loadEnv({ nodeEnv: 'test', databaseUrl: undefined, pgliteDir: dir }),
  ));
  userId = (await db.insert(users).values({ username: 'checkpoint-owner' }).returning())[0]!.id;
  teamId = (
    await db
      .insert(teams)
      .values({ name: 'Checkpoint evidence', slug: 'checkpoint-evidence', createdBy: userId })
      .returning()
  )[0]!.id;
  await db.insert(memberships).values({ teamId, userId, role: 'owner' });
  projectId = (
    await db
      .insert(projects)
      .values({
        teamId,
        name: 'api',
        slug: 'api',
        repositoryIdentity: 'github.com/acme/api',
        createdBy: userId,
      })
      .returning()
  )[0]!.id;
  installationId = (
    await db
      .insert(agentInstallations)
      .values({
        userId,
        name: 'checkpoint-agent',
        deviceLabel: 'test-device',
        deviceFingerprint: randomUUID(),
      })
      .returning()
  )[0]!.id;
  const connectionId = (
    await db
      .insert(teamIntegrations)
      .values({
        teamId,
        provider: 'github',
        repo: 'acme/api',
        token: 'fixture-only',
        createdBy: userId,
      })
      .returning()
  )[0]!.id;
  bindingId = (
    await db
      .insert(repositoryBindings)
      .values({
        connectionId,
        teamId,
        projectId,
        provider: 'github',
        repositoryId: 'repo-42',
        fullName: 'acme/api',
        verifiedAt: new Date(),
      })
      .returning()
  )[0]!.id;
});

afterAll(async () => {
  await close?.();
  rmSync(dir, { recursive: true, force: true });
});

async function run(headSha: string) {
  return (
    await db
      .insert(agentRuns)
      .values({
        installationId,
        teamId,
        projectId,
        status: 'completed',
        headSha,
        endedAt: new Date(),
      })
      .returning()
  )[0]!;
}

async function checkpoint(
  runId: string,
  kind: 'start' | 'delivery' | 'tested',
  commitSha: string,
  createdAt: Date,
  repositoryIdentity = 'github.com/acme/api',
) {
  return (
    await db
      .insert(runCheckpoints)
      .values({
        runId,
        teamId,
        projectId,
        installationId,
        kind,
        repositoryIdentity,
        commitSha,
        worktreeClean: true,
        tests: [],
        requestId: randomUUID(),
        requestHash: randomUUID(),
        createdAt,
      })
      .returning()
  )[0]!;
}

async function observe(commitSha: string, deliveryId: string, state: 'success' | 'failure') {
  const result = await recordProviderObservation(db, teamId, 'github', {
    bindingId,
    repositoryId: 'repo-42',
    deliveryId,
    subjectId: `workflow:${deliveryId}`,
    commitSha,
    kind: 'workflow',
    state,
    observedAt: new Date(Date.now() - 1_000),
  });
  expect(result).toHaveProperty('recorded', true);
}

const byKey = (pack: Awaited<ReturnType<typeof evidenceForRun>>) => {
  if ('error' in pack) throw new Error(pack.error);
  return Object.fromEntries(pack.checks.map((check) => [check.key, check]));
};

it('does not attach provider success through mutable run head when no checkpoint exists', async () => {
  const commit = sha('a');
  const subject = await run(commit);
  await observe(commit, 'head-only', 'success');

  const pack = await evidenceForRun(db, subject.id, userId);
  if ('error' in pack) throw new Error(pack.error);
  expect(pack.checkpoint).toBeNull();
  expect(pack.providerFacts).toEqual([]);
  expect(pack.providerCoverage).toContain('immutable delivery/test checkpoint is required');
  expect(byKey(pack).outcome).toMatchObject({ state: 'unknown', coverage: 'missing' });
  expect(byKey(pack).outcome.detail).toContain('Provider result is unverified');
});

it('uses the newest delivery/test checkpoint and never carries an older green result forward', async () => {
  const subject = await run(sha('b'));
  const oldDelivery = await checkpoint(
    subject.id,
    'delivery',
    sha('b'),
    new Date(Date.now() - 4_000),
  );
  // A newer start observation is deliberately ineligible as delivery evidence.
  await checkpoint(subject.id, 'start', sha('b'), new Date(Date.now() - 3_000));
  await observe(sha('b'), 'old-green', 'success');

  let pack = await evidenceForRun(db, subject.id, userId);
  if ('error' in pack) throw new Error(pack.error);
  expect(pack.checkpoint?.id).toBe(oldDelivery.id);
  expect(pack.providerFacts).toHaveLength(1);
  expect(byKey(pack).outcome).toMatchObject({ state: 'ok', coverage: 'exact' });

  const current = await checkpoint(
    subject.id,
    'tested',
    sha('c'),
    new Date(Date.now() - 2_000),
  );
  pack = await evidenceForRun(db, subject.id, userId);
  if ('error' in pack) throw new Error(pack.error);
  expect(pack.checkpoint?.id).toBe(current.id);
  expect(pack.providerFacts).toEqual([]);
  expect(byKey(pack).outcome).toMatchObject({ state: 'unknown', coverage: 'missing' });
  expect(byKey(pack).outcome.detail).toContain(sha('c').slice(0, 12));

  await observe(sha('c'), 'current-green', 'success');
  pack = await evidenceForRun(db, subject.id, userId);
  if ('error' in pack) throw new Error(pack.error);
  expect(pack.providerFacts.map((row) => row.fact.commitSha)).toEqual([sha('c')]);
  expect(byKey(pack).outcome).toMatchObject({
    state: 'ok',
    source: 'provider_observation',
    coverage: 'exact',
  });
});

it('fails closed when checkpoint repository identity differs from the project binding', async () => {
  const commit = sha('d');
  const subject = await run(commit);
  await checkpoint(
    subject.id,
    'delivery',
    commit,
    new Date(Date.now() - 2_000),
    'github.com/other/api',
  );
  await observe(commit, 'wrong-repository', 'success');

  const pack = await evidenceForRun(db, subject.id, userId);
  if ('error' in pack) throw new Error(pack.error);
  expect(pack.checkpoint?.repositoryMatchesProject).toBe(false);
  expect(pack.providerFacts).toEqual([]);
  expect(pack.providerCoverage).toContain('does not match');
  expect(byKey(pack).checkpoint).toMatchObject({ state: 'attention' });
  expect(byKey(pack).outcome).toMatchObject({ state: 'unknown' });
});
