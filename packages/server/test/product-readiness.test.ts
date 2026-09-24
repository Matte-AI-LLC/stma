import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { policyDocumentSchema } from '@bridge/shared';
import { connectDb, type Db } from '../src/db';
import {
  agentInstallations,
  agentRuns,
  debugSessions,
  deliverySetups,
  handoffs,
  launchAttempts,
  memberships,
  messages,
  notificationQueue,
  workClaims,
  projects,
  policyBundles,
  providerObservations,
  repositoryBindings,
  teamIntegrations,
  teams,
  tokens,
  users,
} from '../src/db/schema';
import {
  AGENT_ENROLLMENT_TTL_MINUTES,
  createAgentEnrollment,
  redeemAgentEnrollment,
} from '../src/domain/enrollments';
import { launchCheck, transitionHandoff } from '../src/domain/collaboration';
import { exactProviderEvidence, recordProviderObservation } from '../src/domain/providerEvidence';
import {
  githubForTeam,
  integrationFor,
  saveGithubIntegration,
  removeIntegration,
} from '../src/domain/integrations';
import { receiveSetupReceipt } from '../src/domain/setupReceipts';
import { agentSetupManifest, renderAgentSetupMarkdown } from '../src/domain/agentSetup';
import { FLOW_TEMPLATES } from '../src/domain/flowTemplates';
import { publishPolicy } from '../src/domain/policies';
import { loadEnv } from '../src/env';
import { encryptedSecretStore } from '../src/lib/secretStore';
import { setHosted, withEntitlements } from '../src/lib/entitlements';
import { findOrCreateProject } from '../src/lib/projects';
import { withSecurityHooks } from '../src/lib/securityHooks';
import type { AgentGrant } from '../src/lib/grants';
import { pendingHandoffs } from '../src/lib/sessions';
import { createHandoffOnce } from '../src/domain/handoffRequests';
import { finishAgentRun } from '../src/domain/agents';
import { hitCounter, MONTH_MS, readCounter } from '../src/lib/counters';
import { queueHandoffNotification } from '../src/lib/notifications';

let db: Db;
let dir: string;
let close: () => Promise<void>;
let userId: string;
let teamId: string;
let projectId: string;
let a: AgentGrant;
let b: AgentGrant;
let other: AgentGrant;
async function agent(name: string, scopedProject?: string): Promise<AgentGrant> {
  const created = await createAgentEnrollment(db, {
    userId,
    name,
    deviceLabel: name,
    clientType: 'generic',
    scope: scopedProject ? 'project' : 'team',
    teamId,
    projectId: scopedProject,
  });
  const redeemed = await redeemAgentEnrollment(db, created.code);
  if (!redeemed.ok) throw new Error('Enrollment failed');
  return {
    tokenId: redeemed.value.tokenId,
    scope: scopedProject ? 'project' : 'team',
    teamId,
    teamSlug: 'ready-suite',
    teamName: 'Ready suite',
    projectId: scopedProject ?? null,
    projectSlug: null,
    projectName: null,
    installationId: redeemed.value.installation.id,
    installationName: name,
    deviceLabel: name,
    companionInstallationId: null,
    clientType: 'generic',
  };
}
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'stma-ready-contracts-'));
  ({ db, close } = await connectDb(
    loadEnv({ nodeEnv: 'test', databaseUrl: undefined, pgliteDir: dir }),
  ));
  setHosted(false);
  userId = (await db.insert(users).values({ username: 'ready-contract-owner' }).returning())[0]!.id;
  teamId = (
    await db
      .insert(teams)
      .values({ name: 'Ready suite', slug: 'ready-suite', createdBy: userId })
      .returning()
  )[0]!.id;
  await db.insert(memberships).values({ teamId, userId, role: 'owner' });
  projectId = (
    await db
      .insert(projects)
      .values({ teamId, name: 'one', slug: 'one', createdBy: userId })
      .returning()
  )[0]!.id;
  a = await agent('first');
  b = await agent('second');
  other = await agent('third');
});
afterAll(async () => {
  await close?.();
  rmSync(dir, { recursive: true, force: true });
});

it('gives the informed-consent enrollment flow a 30-minute single-use window', async () => {
  const before = Date.now();
  const created = await createAgentEnrollment(db, {
    userId,
    name: 'ttl-contract',
    deviceLabel: 'ttl-contract',
    clientType: 'codex',
    scope: 'team',
    teamId,
  });
  const after = Date.now();
  const expectedTtlMs = AGENT_ENROLLMENT_TTL_MINUTES * 60_000;

  expect(AGENT_ENROLLMENT_TTL_MINUTES).toBe(30);
  expect(created.enrollment.expiresAt.getTime()).toBeGreaterThanOrEqual(before + expectedTtlMs);
  expect(created.enrollment.expiresAt.getTime()).toBeLessThanOrEqual(after + expectedTtlMs);
});

it('rolls back a failed handoff with its quota, run release and queued notification', async () => {
  const [run] = await db
    .insert(agentRuns)
    .values({ teamId, installationId: a.installationId!, status: 'active' })
    .returning();
  const lease = new Date(Date.now() + 60_000);
  await db
    .insert(workClaims)
    .values({
      runId: run!.id,
      resourceType: 'file',
      resourceKey: 'src/a.ts',
      access: 'write',
      leaseExpiresAt: lease,
    });
  const [recipient] = await db.insert(users).values({ username: 'handoff-recipient' }).returning();
  const sessionId = randomUUID();
  const key = randomUUID();
  const env = loadEnv({ nodeEnv: 'test' });
  const attempt = (fail: boolean) =>
    createHandoffOnce(db, userId, a, key, 'a'.repeat(64), async (tx) => {
      await hitCounter(tx, 'handoff-atomic-test', teamId, MONTH_MS, 2);
      await tx
        .insert(debugSessions)
        .values({ id: sessionId, teamId, openedBy: userId, title: 'Atomic handoff' });
      await tx.insert(handoffs).values({ sessionId, offeredBy: userId });
      await tx
        .insert(messages)
        .values({
          sessionId,
          authorId: userId,
          kind: 'handoff',
          body: 'Continue only with human consent.',
        });
      await finishAgentRun(tx, run!.id, userId, 'completed');
      await queueHandoffNotification(tx, env, {
        sessionId,
        teamId,
        recipientId: recipient!.id,
        actorId: userId,
        at: new Date(),
      });
      if (fail) throw new Error('injected persistence failure');
      return { sessionId, response: { sessionId, runFinished: run!.id } };
    });
  await expect(attempt(true)).rejects.toThrow('injected persistence failure');
  expect(await db.select().from(debugSessions).where(eq(debugSessions.id, sessionId))).toHaveLength(
    0,
  );
  expect(
    await db.select().from(notificationQueue).where(eq(notificationQueue.sessionId, sessionId)),
  ).toHaveLength(0);
  expect((await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id)))[0]!.status).toBe(
    'active',
  );
  expect(
    (await db.select().from(workClaims).where(eq(workClaims.runId, run!.id)))[0]!.leaseExpiresAt,
  ).toEqual(lease);
  expect(await readCounter(db, 'handoff-atomic-test', teamId, MONTH_MS)).toBe(0);
  expect(await attempt(false)).toHaveProperty('replayed', false);
  expect(await attempt(false)).toHaveProperty('replayed', true);
  expect(await readCounter(db, 'handoff-atomic-test', teamId, MONTH_MS)).toBe(1);
  expect(
    await db.select().from(notificationQueue).where(eq(notificationQueue.sessionId, sessionId)),
  ).toHaveLength(1);
});

it('does not replay a handoff after scope or membership access is lost', async () => {
  const scoped = await agent('receipt-project-scope', projectId);
  const key = randomUUID();
  const result = await createHandoffOnce(db, userId, scoped, key, 'b'.repeat(64), async (tx) => {
    const [session] = await tx
      .insert(debugSessions)
      .values({ teamId, projectId, openedBy: userId, title: 'Scoped receipt' })
      .returning();
    return { sessionId: session!.id, response: { sessionId: session!.id } };
  });
  expect(result).toHaveProperty('replayed', false);
  const refuseCreate = async () => {
    throw new Error('Replay must not call the writer');
  };
  expect(
    await createHandoffOnce(
      db,
      userId,
      { ...scoped, projectId: randomUUID() },
      key,
      'b'.repeat(64),
      refuseCreate,
    ),
  ).toHaveProperty('error');
  await db.update(tokens).set({ revokedAt: new Date() }).where(eq(tokens.id, scoped.tokenId));
  expect(
    await createHandoffOnce(db, userId, scoped, key, 'b'.repeat(64), refuseCreate),
  ).toHaveProperty('error');
});

it('serializes launch replay and verifies two authenticated origins, not message IDs', async () => {
  const [launch] = await db.insert(launchAttempts).values({ teamId, userId }).returning();
  await Promise.all([
    launchCheck(db, launch!.id, userId, a, 'send'),
    launchCheck(db, launch!.id, userId, a, 'send'),
  ]);
  expect(await launchCheck(db, launch!.id, userId, a, 'reply')).toHaveProperty('error');
  await Promise.all([
    launchCheck(db, launch!.id, userId, b, 'reply'),
    launchCheck(db, launch!.id, userId, b, 'reply'),
  ]);
  const status = await launchCheck(db, launch!.id, userId, a, 'status');
  expect(status).toHaveProperty('launch.exchangeConfirmedAt');
  if (!('launch' in status) || !status.launch) throw new Error('No launch');
  expect(
    await db.select().from(messages).where(eq(messages.sessionId, status.launch.sessionId!)),
  ).toHaveLength(2);
  expect(await launchCheck(db, launch!.id, userId, other, 'reply')).toHaveProperty('error');
});

it('refuses project-scope mismatch and a revoked sender without minting replacements', async () => {
  const scoped = await agent('project-agent', projectId);
  const [launch] = await db.insert(launchAttempts).values({ teamId, userId }).returning();
  expect(await launchCheck(db, launch!.id, userId, scoped, 'send')).toHaveProperty('error');
  const sender = await agent('revoked-sender');
  await launchCheck(db, launch!.id, userId, sender, 'send');
  await db.update(tokens).set({ revokedAt: new Date() }).where(eq(tokens.id, sender.tokenId));
  expect(await launchCheck(db, launch!.id, userId, b, 'reply')).toHaveProperty('error');
});

it('keeps questions pending, admits exactly one recipient, and requires explicit completion', async () => {
  const [session] = await db
    .insert(debugSessions)
    .values({ teamId, title: 'Actual work', openedBy: userId })
    .returning();
  await db.insert(handoffs).values({ sessionId: session!.id, offeredBy: userId });
  await db.insert(messages).values([
    {
      sessionId: session!.id,
      authorId: userId,
      kind: 'handoff',
      body: 'The work is ready to resume.',
    },
    { sessionId: session!.id, authorId: userId, kind: 'question', body: 'Which branch?' },
  ]);
  expect((await pendingHandoffs(db, [teamId], { userId })).map((r) => r.sessionId)).toContain(
    session!.id,
  );
  expect(await transitionHandoff(db, session!.id, userId, b, 'decline')).toHaveProperty('error');
  const results = await Promise.all([
    transitionHandoff(db, session!.id, userId, b, 'accept'),
    transitionHandoff(db, session!.id, userId, other, 'accept'),
  ]);
  expect(results.filter((r) => 'handoff' in r)).toHaveLength(1);
  const winner = 'handoff' in results[0]! ? b : other;
  expect(await transitionHandoff(db, session!.id, userId, winner, 'complete')).toHaveProperty(
    'error',
  );
  expect(await transitionHandoff(db, session!.id, userId, winner, 'accept')).toHaveProperty(
    'handoff.state',
    'accepted',
  );
  await transitionHandoff(db, session!.id, userId, winner, 'resume');
  expect(await transitionHandoff(db, session!.id, userId, winner, 'complete')).toHaveProperty(
    'handoff.state',
    'completed',
  );
  expect((await pendingHandoffs(db, [teamId], { userId })).map((r) => r.sessionId)).not.toContain(
    session!.id,
  );
});

it('keeps two repository connections and refuses ambiguous selection', async () => {
  for (const repo of ['acme/one', 'acme/two'])
    await saveGithubIntegration(db, {
      teamId,
      userId,
      repo,
      token: `fixture-${repo}`,
      commentOnFinish: false,
    });
  expect(await db.select().from(teamIntegrations)).toHaveLength(2);
  expect(await githubForTeam(db, teamId)).toBeUndefined();
  expect(await integrationFor(db, teamId, 'github', 'acme/one')).toHaveProperty('repo', 'acme/one');
});

it('lets humans cancel or decline their own offers without impersonating the receiving agent', async () => {
  const [session] = await db
    .insert(debugSessions)
    .values({ teamId, title: 'Human-controlled offer', openedBy: userId })
    .returning();
  await db
    .insert(handoffs)
    .values({ sessionId: session!.id, offeredBy: userId, targetUserId: userId });
  for (const action of ['accept', 'resume', 'complete'] as const)
    expect(await transitionHandoff(db, session!.id, userId, undefined, action)).toHaveProperty(
      'error',
    );
  expect(await transitionHandoff(db, session!.id, userId, undefined, 'decline')).toHaveProperty(
    'handoff.state',
    'declined',
  );
  expect(await transitionHandoff(db, session!.id, userId, undefined, 'cancel')).toHaveProperty(
    'handoff.state',
    'cancelled',
  );
});

it('records exact provider identity, rejects replay, stale attempts and wrong repositories', async () => {
  const connection = (await integrationFor(db, teamId, 'github', 'acme/one'))!;
  const [binding] = await db
    .insert(repositoryBindings)
    .values({
      teamId,
      projectId,
      connectionId: connection.id,
      provider: 'github',
      repositoryId: '42',
      fullName: 'acme/one',
      verifiedAt: new Date(),
    })
    .returning();
  const event = {
    repositoryId: '42',
    deliveryId: 'delivery-one',
    subjectId: 'workflow:1',
    commitSha: 'a'.repeat(40),
    kind: 'workflow',
    state: 'success',
    attempt: 2,
    observedAt: new Date(),
  };
  expect(await recordProviderObservation(db, teamId, 'github', event)).toHaveProperty(
    'recorded',
    true,
  );
  expect(await recordProviderObservation(db, teamId, 'github', event)).toHaveProperty(
    'reason',
    'duplicate',
  );
  expect(
    await recordProviderObservation(db, teamId, 'github', {
      ...event,
      attempt: 1,
      deliveryId: 'old',
    }),
  ).toHaveProperty('reason', 'stale_event');
  expect(
    await recordProviderObservation(db, teamId, 'github', { ...event, repositoryId: '43' }),
  ).toHaveProperty('reason', 'repository_not_verified');
  expect(
    await db
      .select()
      .from(providerObservations)
      .where(eq(providerObservations.bindingId, binding!.id)),
  ).toHaveLength(1);
  expect(await githubForTeam(db, teamId, projectId)).toHaveProperty('repo', 'acme/one');
});

it('does not relabel provider evidence when a repository binding changes projects', async () => {
  const [binding] = await db
    .select()
    .from(repositoryBindings)
    .where(eq(repositoryBindings.repositoryId, '42'));
  const [nextProject] = await db
    .insert(projects)
    .values({ teamId, name: 'new-evidence-scope', slug: 'new-evidence-scope' })
    .returning();
  expect(await exactProviderEvidence(db, teamId, projectId, 'a'.repeat(40))).toHaveLength(1);
  await db
    .update(repositoryBindings)
    .set({ projectId: nextProject!.id })
    .where(eq(repositoryBindings.id, binding!.id));
  expect(await exactProviderEvidence(db, teamId, nextProject!.id, 'a'.repeat(40))).toHaveLength(0);
  expect(
    (
      await db
        .select()
        .from(providerObservations)
        .where(eq(providerObservations.bindingId, binding!.id))
    )[0]!.projectId,
  ).toBe(projectId);
  await recordProviderObservation(db, teamId, 'github', {
    repositoryId: '42',
    deliveryId: 'after-rebinding',
    subjectId: 'workflow:2',
    commitSha: 'b'.repeat(40),
    kind: 'workflow',
    state: 'success',
    observedAt: new Date(),
  });
  expect(await exactProviderEvidence(db, teamId, nextProject!.id, 'b'.repeat(40))).toHaveLength(1);
  await db
    .update(repositoryBindings)
    .set({ projectId })
    .where(eq(repositoryBindings.id, binding!.id));
  await db.delete(projects).where(eq(projects.id, nextProject!.id));
});

it('binds receipts to immutable scope and mode, never promotes reports to verification', async () => {
  const flow = FLOW_TEMPLATES[0]!.document;
  const context = {
    name: 'Receipt test',
    team: 'ready-suite',
    templateKey: 'test',
    provider: 'github-actions' as const,
    mode: 'plan-only' as const,
  };
  const manifest = agentSetupManifest(flow, context);
  await db.insert(deliverySetups).values({ id: manifest.setupId, teamId, manifest });
  const receipt = {
    schemaVersion: 2,
    setupId: manifest.setupId,
    flowHash: manifest.flowHash,
    policyHash: null,
    status: 'planned',
    commitSha: null,
    repositoryId: null,
    repositoryWrites: false,
    providerWrites: false,
  };
  expect(await receiveSetupReceipt(db, userId, receipt, a)).toHaveProperty(
    'verification',
    'unverified',
  );
  expect(
    await receiveSetupReceipt(db, userId, { ...receipt, repositoryWrites: true }, a),
  ).toHaveProperty('error');
  expect(
    await receiveSetupReceipt(db, userId, { ...receipt, flowHash: 'a'.repeat(64) }, a),
  ).toHaveProperty('error');
  expect(
    await receiveSetupReceipt(db, userId, receipt, { ...a, scope: 'project', projectId }),
  ).toHaveProperty('error');
  expect(renderAgentSetupMarkdown(flow, context)).toContain(manifest.setupId);
});

it('authenticates ciphertext and context and supports old-key reads during rotation', async () => {
  const oldKey = randomBytes(32).toString('hex'),
    nextKey = randomBytes(32).toString('hex');
  const original = encryptedSecretStore({ old: oldKey }, 'old');
  const ciphertext = await original.seal('fixture-only', `${teamId}:github:acme/one`);
  expect(ciphertext).not.toContain('fixture-only');
  const rotated = encryptedSecretStore({ old: oldKey, next: nextKey }, 'next');
  expect(await rotated.open(ciphertext, `${teamId}:github:acme/one`)).toBe('fixture-only');
  await expect(rotated.open(ciphertext, `${teamId}:github:acme/two`)).rejects.toThrow();
  await expect(
    encryptedSecretStore({ next: nextKey }, 'next').open(ciphertext, `${teamId}:github:acme/one`),
  ).rejects.toThrow();
});

it('rolls back a policy publication if its critical audit write fails', async () => {
  const before = await db.select().from(policyBundles).where(eq(policyBundles.teamId, teamId));
  await expect(
    withSecurityHooks(
      {
        audit: async () => {
          throw new Error('audit-unavailable');
        },
      },
      () =>
        publishPolicy(db, userId, {
          team: 'ready-suite',
          document: policyDocumentSchema.parse({}),
        }),
    ),
  ).rejects.toThrow('audit-unavailable');
  expect(
    await db.select().from(policyBundles).where(eq(policyBundles.teamId, teamId)),
  ).toHaveLength(before.length);
});

it('serializes policy versions for concurrent publications', async () => {
  const results = await Promise.all(
    [1, 2].map(() =>
      publishPolicy(db, userId, { team: 'ready-suite', document: policyDocumentSchema.parse({}) }),
    ),
  );
  const versions = results.map((r) => ('policy' in r ? r.policy.version : null));
  expect(versions).not.toContain(null);
  expect(new Set(versions).size).toBe(2);
});

it('keeps the project ceiling when two agents create different projects concurrently', async () => {
  const [team] = await db.select().from(teams).where(eq(teams.id, teamId));
  setHosted(true);
  try {
    const results = await withEntitlements(
      async (_db, _team, base) => ({ ...base, maxProjects: 2 }),
      () =>
        Promise.all([
          findOrCreateProject(db, team!, 'limit-race-a', userId),
          findOrCreateProject(db, team!, 'limit-race-b', userId),
        ]),
    );
    expect(results.filter((r) => 'project' in r)).toHaveLength(1);
    expect(await db.select().from(projects).where(eq(projects.teamId, teamId))).toHaveLength(2);
  } finally {
    setHosted(false);
  }
});

it('disconnects an exact connection without requiring its decryption key', async () => {
  await db.insert(teamIntegrations).values({
    teamId,
    provider: 'github',
    repo: 'acme/lost-key',
    token: 'enc:v1:missing:invalid:invalid:invalid',
    createdBy: userId,
  });
  await removeIntegration(db, teamId, 'github', 'acme/lost-key');
  expect(
    (await db.select().from(teamIntegrations)).some((row) => row.repo === 'acme/lost-key'),
  ).toBe(false);
});

it("does not inherit another server composition's hosted mode", async () => {
  const [team] = await db.select().from(teams).where(eq(teams.id, teamId));
  const { effectiveLimits } = await import('../src/lib/entitlements');
  setHosted(false);
  const limits = await withEntitlements(
    async (_db, _team, base) => ({ ...base, maxProjects: 1 }),
    () => effectiveLimits(db, team!),
    true,
  );
  expect(limits.maxProjects).toBe(1);
  expect(limits.fleet).toBe('readonly');
});
