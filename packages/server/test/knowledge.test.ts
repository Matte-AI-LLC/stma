import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { KnowledgeDraftInput } from '@bridge/shared';
import { KNOWLEDGE_CONTEXT_MAX_BYTES, KNOWLEDGE_ITEM_MAX_BYTES } from '@bridge/shared';
import { generatePat } from '../src/auth/pat';
import {
  deleteKnowledgeContent,
  getKnowledge,
  getKnowledgeContext,
  knowledgeForConsole,
  proposeKnowledge,
  publishKnowledge,
  reportKnowledgeReceipt,
  searchKnowledge,
  setKnowledgeLifecycle,
  retainedContextReplayError,
  type KnowledgeAccess,
  type KnowledgeCapacityLimits,
} from '../src/domain/knowledge';
import {
  knowledgeAudienceProjects,
  knowledgeContexts,
  knowledgeItems,
  knowledgeReceipts,
  knowledgeVersions,
  memberships,
  projects,
  teams,
  tokens,
  users,
} from '../src/db/schema';
import { loadEnv } from '../src/env';
import { validateKnowledgeImports, validateNativeKnowledgeBody } from '../src/lib/knowledgeImport';
import { withSecurityHooks } from '../src/lib/securityHooks';
import { startServer, type StartedServer } from '../src/server';

let srv: StartedServer;
let dataDir: string;
let ownerId = '';
let memberId = '';
let outsiderId = '';
let teamId = '';
let otherTeamId = '';
let paymentsId = '';
let storefrontId = '';
let projectPat = '';
let projectTokenId = '';
let projectGrant: KnowledgeAccess;
let ownerCookie: Record<string, string> = {};
let memberCookie: Record<string, string> = {};

it.each(['withdrawn', 'expired', 'audience'])('does not replay cached reference text after it is %s', async (change) => {
  const published = await publish(await draft(`replay-${change}`, `replay-${change} reference`, { audience: { type: 'selected_projects', projects: ['Payments API'] } }));
  const context = await getKnowledgeContext(srv.db, ownerId, { team: 'knowledge-team', project: 'Payments API', query: `replay-${change}`, maxItems: 20 }, projectGrant, { retainResponse: true });
  if ('error' in context) throw Error(context.error);
  const [saved] = await srv.db.select().from(knowledgeContexts).where(eq(knowledgeContexts.id, context.contextId));
  expect(await retainedContextReplayError(srv.db, ownerId, saved!, projectGrant)).toBeNull();
  if (change === 'withdrawn') await setKnowledgeLifecycle(srv.db, ownerId, { team: 'knowledge-team', itemId: published.itemId, state: 'withdrawn', expectedCurrentVersionId: published.versionId });
  if (change === 'expired') await srv.db.update(knowledgeVersions).set({ validUntil: new Date(Date.now() - 1000) }).where(eq(knowledgeVersions.id, published.versionId));
  if (change === 'audience') await srv.db.delete(knowledgeAudienceProjects).where(eq(knowledgeAudienceProjects.versionId, published.versionId));
  expect(await retainedContextReplayError(srv.db, ownerId, saved!, projectGrant)).toContain('Retrieve fresh context');
});

function cookieJar() {
  const cookies = new Map<string, string>();
  return {
    header: (): Record<string, string> =>
      cookies.size ? { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {},
    store(response: Response) {
      for (const line of response.headers.getSetCookie()) {
        const pair = line.split(';')[0]!;
        const split = pair.indexOf('=');
        cookies.set(pair.slice(0, split), pair.slice(split + 1));
      }
    },
  };
}

async function login(username: string) {
  const jar = cookieJar();
  jar.store(
    await fetch(`${srv.url}/auth/dev`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username }),
      redirect: 'manual',
    }),
  );
  return jar.header();
}

async function draft(
  stableKey: string,
  body: string,
  overrides: Partial<KnowledgeDraftInput> = {},
  userId = ownerId,
  grant?: KnowledgeAccess,
) {
  const result = await proposeKnowledge(
    srv.db,
    userId,
    {
      team: 'knowledge-team',
      stableKey,
      kind: 'procedure',
      title: `Title ${stableKey}`,
      body,
      audience: { type: 'workspace_members' },
      source: { type: 'native' },
      ...overrides,
    },
    grant,
  );
  if ('error' in result) throw new Error(result.error);
  return result.draft;
}

async function publish(
  proposed: Awaited<ReturnType<typeof draft>>,
  expectedCurrentVersionId = proposed.expectedCurrentVersionId,
) {
  const result = await publishKnowledge(srv.db, ownerId, {
    team: 'knowledge-team',
    itemId: proposed.itemId,
    draftVersionId: proposed.versionId,
    expectedCurrentVersionId,
  });
  if ('error' in result) throw new Error(result.error);
  return result.published;
}

async function published(
  stableKey: string,
  body: string,
  overrides: Partial<KnowledgeDraftInput> = {},
) {
  return publish(await draft(stableKey, body, overrides));
}

let rpcId = 1;
async function callTool(token: string, name: string, args: Record<string, unknown>) {
  const response = await fetch(`${srv.url}/mcp`, {
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
      params: { name, arguments: args },
    }),
  });
  const payload = (await response.json()) as {
    result?: { isError?: boolean; content?: Array<{ text: string }> };
    error?: { message?: string };
    hint?: string;
  };
  const text = payload.result?.content?.[0]?.text ?? payload.error?.message ?? payload.hint ?? '';
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return {
    status: response.status,
    isError: !response.ok || payload.result?.isError === true || Boolean(payload.error),
    text,
    data: data as any,
  };
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-knowledge-'));
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

  const createdUsers = await srv.db
    .insert(users)
    .values([
      { username: 'knowledge-owner' },
      { username: 'knowledge-member' },
      { username: 'knowledge-outsider' },
    ])
    .returning();
  ownerId = createdUsers[0]!.id;
  memberId = createdUsers[1]!.id;
  outsiderId = createdUsers[2]!.id;
  const createdTeams = await srv.db
    .insert(teams)
    .values([
      { name: 'Knowledge Team', slug: 'knowledge-team', createdBy: ownerId },
      { name: 'Other Team', slug: 'other-team', createdBy: outsiderId },
    ])
    .returning();
  teamId = createdTeams[0]!.id;
  otherTeamId = createdTeams[1]!.id;
  await srv.db.insert(memberships).values([
    { teamId, userId: ownerId, role: 'owner' },
    { teamId, userId: memberId, role: 'member' },
    { teamId: otherTeamId, userId: outsiderId, role: 'owner' },
  ]);
  const createdProjects = await srv.db
    .insert(projects)
    .values([
      { teamId, name: 'Payments API', slug: 'payments-api', createdBy: ownerId },
      { teamId, name: 'Storefront', slug: 'storefront', createdBy: ownerId },
    ])
    .returning();
  paymentsId = createdProjects[0]!.id;
  storefrontId = createdProjects[1]!.id;

  const pat = generatePat();
  projectPat = pat.token;
  projectTokenId = (
    await srv.db
      .insert(tokens)
      .values({
        userId: memberId,
        name: 'payments-agent',
        scope: 'project',
        teamId,
        projectId: paymentsId,
        tokenHash: pat.hash,
        prefix: pat.prefix,
      })
      .returning({ id: tokens.id })
  )[0]!.id;
  projectGrant = {
    tokenId: projectTokenId,
    scope: 'project',
    teamId,
    projectId: paymentsId,
    installationId: null,
  };
  ownerCookie = await login('knowledge-owner');
  memberCookie = await login('knowledge-member');
});

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Knowledge Hub lifecycle and immutable publication', () => {
  it('keeps drafts private, lets only an owner publish, and gives one concurrent publisher the CAS', async () => {
    const proposed = await draft('cas-lifecycle', 'draft-one unique-cas-body', {}, memberId);

    const hidden = await searchKnowledge(srv.db, ownerId, {
      team: 'knowledge-team',
      query: 'unique-cas-body',
      page: 1,
      pageSize: 10,
    });
    expect('error' in hidden ? hidden.error : hidden.total).toBe(0);

    const memberPublish = await publishKnowledge(srv.db, memberId, {
      team: 'knowledge-team',
      itemId: proposed.itemId,
      draftVersionId: proposed.versionId,
      expectedCurrentVersionId: null,
    });
    expect('error' in memberPublish && memberPublish.error).toContain('owner');

    const attempts = await Promise.all([
      publishKnowledge(srv.db, ownerId, {
        team: 'knowledge-team',
        itemId: proposed.itemId,
        draftVersionId: proposed.versionId,
        expectedCurrentVersionId: null,
      }),
      publishKnowledge(srv.db, ownerId, {
        team: 'knowledge-team',
        itemId: proposed.itemId,
        draftVersionId: proposed.versionId,
        expectedCurrentVersionId: null,
      }),
    ]);
    expect(attempts.filter((attempt) => !('error' in attempt))).toHaveLength(1);
    expect(attempts.filter((attempt) => 'error' in attempt)).toHaveLength(1);
    const first = attempts.find((attempt) => !('error' in attempt));
    if (!first || 'error' in first) throw new Error('No publish won the CAS');

    const afterFirst = await srv.db
      .select()
      .from(knowledgeVersions)
      .where(eq(knowledgeVersions.itemId, proposed.itemId));
    expect(afterFirst.map((row) => row.status).sort()).toEqual(['draft', 'published']);
    expect(afterFirst.find((row) => row.id === proposed.versionId)?.body).toBe('draft-one unique-cas-body');

    const secondDraft = await draft(
      'cas-lifecycle',
      'draft-two unique-cas-body',
      { expectedDraftVersionId: null },
    );
    const second = await publish(secondDraft, first.published.versionId);
    expect(second.version).toBe(2);
    expect(second.supersedesVersionId).toBe(first.published.versionId);

    const versions = await srv.db
      .select()
      .from(knowledgeVersions)
      .where(eq(knowledgeVersions.itemId, proposed.itemId));
    expect(versions).toHaveLength(4);
    expect(versions.find((row) => row.id === first.published.versionId)?.body).toBe(
      'draft-one unique-cas-body',
    );
    expect(versions.find((row) => row.id === proposed.versionId)?.status).toBe('draft');

    const staleLifecycle = await setKnowledgeLifecycle(srv.db, ownerId, {
      team: 'knowledge-team',
      itemId: proposed.itemId,
      expectedCurrentVersionId: first.published.versionId,
      state: 'archived',
    });
    expect('error' in staleLifecycle && staleLifecycle.error).toContain('conflict');

    const archived = await setKnowledgeLifecycle(srv.db, ownerId, {
      team: 'knowledge-team',
      itemId: proposed.itemId,
      expectedCurrentVersionId: second.versionId,
      state: 'archived',
    });
    expect('error' in archived ? archived.error : archived.item.state).toBe('archived');
    const notCurrent = await getKnowledge(srv.db, ownerId, {
      team: 'knowledge-team',
      id: proposed.itemId,
    });
    expect('error' in notCurrent && notCurrent.error).toContain('No current knowledge');

    const thirdDraft = await draft('cas-lifecycle', 'draft-three unique-cas-body');
    const third = await publish(thirdDraft, second.versionId);
    const withdrawn = await setKnowledgeLifecycle(srv.db, ownerId, {
      team: 'knowledge-team',
      itemId: proposed.itemId,
      expectedCurrentVersionId: third.versionId,
      state: 'withdrawn',
    });
    expect('error' in withdrawn ? withdrawn.error : withdrawn.item.state).toBe('withdrawn');
    const hiddenAgain = await searchKnowledge(srv.db, ownerId, {
      team: 'knowledge-team',
      query: 'unique-cas-body',
      page: 1,
      pageSize: 10,
    });
    expect('error' in hiddenAgain ? hiddenAgain.error : hiddenAgain.total).toBe(0);
  });

  it('excludes expired current publications without rewriting their immutable version', async () => {
    const future = new Date(Date.now() + 60_000);
    const record = await published('expiring-current', 'expiry-marker', {
      validUntil: future.toISOString(),
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(future.getTime() + 1));
      const result = await searchKnowledge(srv.db, ownerId, {
        team: 'knowledge-team',
        query: 'expiry-marker',
        page: 1,
        pageSize: 10,
      });
      expect('error' in result ? result.error : result.total).toBe(0);
      const stored = await srv.db
        .select({ validUntil: knowledgeVersions.validUntil })
        .from(knowledgeVersions)
        .where(eq(knowledgeVersions.id, record.versionId));
      expect(stored[0]!.validUntil?.toISOString()).toBe(future.toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it('labels undated freshness as unknown and distinguishes current from review-due', async () => {
    await published('freshness-unknown', 'freshness-marker unknown');
    await published('freshness-current', 'freshness-marker current', {
      reviewAfter: new Date(Date.now() + 60_000).toISOString(),
    });
    await published('freshness-review-due', 'freshness-marker due', {
      reviewAfter: new Date(Date.now() - 60_000).toISOString(),
    });
    const result = await searchKnowledge(srv.db, ownerId, {
      team: 'knowledge-team',
      query: 'freshness-marker',
      page: 1,
      pageSize: 20,
    });
    if ('error' in result) throw new Error(result.error);
    expect(Object.fromEntries(result.results.map((row) => [row.key, row.freshness]))).toEqual({
      'freshness-current': 'current',
      'freshness-review-due': 'review_due',
      'freshness-unknown': 'unknown',
    });
  });

  it('writes critical knowledge audit events in the mutation transaction', async () => {
    const proposed = await draft('audit-rollback', 'audit-marker');
    await expect(
      withSecurityHooks(
        {
          audit: async (_db, event) => {
            if (event.action === 'knowledge_published') throw new Error('knowledge-audit-unavailable');
          },
        },
        () =>
          publishKnowledge(srv.db, ownerId, {
            team: 'knowledge-team',
            itemId: proposed.itemId,
            draftVersionId: proposed.versionId,
            expectedCurrentVersionId: null,
          }),
      ),
    ).rejects.toThrow('knowledge-audit-unavailable');
    const [rolledBack] = await srv.db
      .select()
      .from(knowledgeItems)
      .where(eq(knowledgeItems.id, proposed.itemId));
    expect(rolledBack!.currentVersionId).toBeNull();
    expect(
      await srv.db
        .select()
        .from(knowledgeVersions)
        .where(eq(knowledgeVersions.itemId, proposed.itemId)),
    ).toHaveLength(1);

    const actions: string[] = [];
    const publishedResult = await withSecurityHooks(
      { audit: async (_db, event) => void actions.push(event.action) },
      () =>
        publishKnowledge(srv.db, ownerId, {
          team: 'knowledge-team',
          itemId: proposed.itemId,
          draftVersionId: proposed.versionId,
          expectedCurrentVersionId: null,
        }),
    );
    if ('error' in publishedResult) throw new Error(publishedResult.error);
    const lifecycle = await withSecurityHooks(
      { audit: async (_db, event) => void actions.push(event.action) },
      () =>
        setKnowledgeLifecycle(srv.db, ownerId, {
          team: 'knowledge-team',
          itemId: proposed.itemId,
          expectedCurrentVersionId: publishedResult.published.versionId,
          state: 'withdrawn',
        }),
    );
    if ('error' in lifecycle) throw new Error(lifecycle.error);
    expect(actions).toEqual(['knowledge_published', 'knowledge_withdrawn']);
  });

  it('surfaces a scope conflict instead of silently replacing an overlapping stable key', async () => {
    const workspace = await published('scope-conflict', 'workspace-wide reference');
    const projectDraft = await draft('scope-conflict', 'narrow project reference', {
      audience: { type: 'selected_projects', projects: ['payments-api'] },
      expectedDraftVersionId: null,
    });
    const conflict = await publishKnowledge(srv.db, ownerId, {
      team: 'knowledge-team',
      itemId: projectDraft.itemId,
      draftVersionId: projectDraft.versionId,
      expectedCurrentVersionId: workspace.versionId,
    });
    expect('error' in conflict && conflict.error).toContain('scope conflict');
    expect('conflict' in conflict && conflict.conflict).toMatchObject({
      currentVersionId: workspace.versionId,
      draftVersionId: projectDraft.versionId,
      currentAudience: { type: 'workspace_members' },
      draftAudience: { type: 'selected_projects', projectIds: [paymentsId] },
    });
    const [unchanged] = await srv.db
      .select()
      .from(knowledgeItems)
      .where(eq(knowledgeItems.id, projectDraft.itemId));
    expect(unchanged!.currentVersionId).toBe(workspace.versionId);
    const [persistentConflict] = await srv.db
      .select()
      .from(knowledgeVersions)
      .where(eq(knowledgeVersions.id, projectDraft.versionId));
    expect(persistentConflict).toMatchObject({
      conflictsWithVersionId: workspace.versionId,
      conflictResolvedAt: null,
    });

    const withdrawn = await setKnowledgeLifecycle(srv.db, ownerId, {
      team: 'knowledge-team',
      itemId: projectDraft.itemId,
      expectedCurrentVersionId: workspace.versionId,
      state: 'withdrawn',
    });
    if ('error' in withdrawn) throw new Error(withdrawn.error);
    const resolved = await publish(projectDraft, workspace.versionId);
    expect(resolved.supersedesVersionId).toBe(workspace.versionId);
    const [resolvedConflict] = await srv.db
      .select()
      .from(knowledgeVersions)
      .where(eq(knowledgeVersions.id, projectDraft.versionId));
    expect(resolvedConflict!.conflictResolvedAt).toBeInstanceOf(Date);
  });

  it('canonicalizes complete source provenance and exposes bounded owner history/diff', async () => {
    const firstDraft = await draft('source-history', 'line one\nold line', {
      source: {
        type: 'import',
        path: 'docs/runbook.md',
        repository: 'git@GitHub.com:Acme/Payments-API.git',
        commit: 'a'.repeat(40),
        symlink: false,
      },
    });
    const first = await publish(firstDraft);
    const secondDraft = await draft('source-history', 'line one\nnew line', {
      source: {
        type: 'import',
        path: 'docs/runbook.md',
        repository: 'https://github.com/acme/payments-api.git',
        commit: 'b'.repeat(40),
        symlink: false,
      },
    });
    await publish(secondDraft, first.versionId);

    const model = await knowledgeForConsole(srv.db, ownerId, 'knowledge-team');
    if ('error' in model) throw new Error(model.error);
    const item = model.items.find((candidate) => candidate.item.stableKey === 'source-history');
    expect(item?.history.map((version) => version.availability)).toContain('superseded');
    expect(item?.history[0]?.source).toMatchObject({
      repository: 'github.com/acme/payments-api',
      commit: 'b'.repeat(40),
    });
    expect(item?.history[0]?.source.checkedAt).toBeTruthy();
    expect(item?.history[0]?.source.changedAt).toBeTruthy();
    expect(item?.history[0]?.source.reviewedAt).toBeTruthy();
    expect(item?.history[0]?.diff.added).toContain('new line');
    expect(item?.history[0]?.diff.removed).toContain('old line');

    const historical = await getKnowledge(srv.db, memberId, {
      team: 'knowledge-team',
      id: first.versionId,
    });
    expect('error' in historical ? historical.error : historical.knowledge.availability).toBe(
      'superseded',
    );

    const invalidSources: unknown[] = [
      { type: 'import', path: 'docs/a.md', repository: 'owner/repo' },
      {
        type: 'import',
        path: 'docs/a.md',
        repository: 'https://secret@github.com/owner/repo.git',
        commit: 'c'.repeat(40),
      },
      { type: 'import', path: 'docs/a.md', repository: 'owner/repo', commit: 'short' },
    ];
    for (const [index, source] of invalidSources.entries()) {
      const rejected = await proposeKnowledge(srv.db, ownerId, {
        team: 'knowledge-team',
        stableKey: `rejected-source-${index}`,
        kind: 'reference',
        title: 'Rejected source',
        body: 'safe source body',
        audience: { type: 'workspace_members' },
        source: source as KnowledgeDraftInput['source'],
      });
      expect(rejected).toHaveProperty('error');
    }
  });

  it('erases content transactionally while preserving contentless tombstone hashes', async () => {
    const proposed = await draft('delete-content', 'sensitive-delete-marker');
    const publishedVersion = await publish(proposed);
    const context = await getKnowledgeContext(
      srv.db,
      ownerId,
      { team: 'knowledge-team', query: 'sensitive-delete-marker', maxItems: 5 },
      undefined,
      { purpose: 'handoff_resume', retainResponse: true },
    );
    if ('error' in context) throw new Error(context.error);
    const [before] = await srv.db
      .select()
      .from(knowledgeItems)
      .where(eq(knowledgeItems.id, proposed.itemId));

    const outsiderDelete = await deleteKnowledgeContent(srv.db, outsiderId, {
      team: 'other-team',
      itemId: proposed.itemId,
      expectedGeneration: before!.generation,
    });
    expect(outsiderDelete).toHaveProperty('error');

    await expect(
      withSecurityHooks(
        {
          audit: async (_db, event) => {
            if (event.action === 'knowledge_deleted') throw new Error('delete-audit-unavailable');
          },
        },
        () =>
          deleteKnowledgeContent(srv.db, ownerId, {
            team: 'knowledge-team',
            itemId: proposed.itemId,
            expectedGeneration: before!.generation,
          }),
      ),
    ).rejects.toThrow('delete-audit-unavailable');
    expect(
      (
        await srv.db
          .select({ body: knowledgeVersions.body })
          .from(knowledgeVersions)
          .where(eq(knowledgeVersions.id, publishedVersion.versionId))
      )[0]?.body,
    ).toBe('sensitive-delete-marker');

    const actions: string[] = [];
    const erased = await withSecurityHooks(
      { audit: async (_db, event) => void actions.push(event.action) },
      () =>
        deleteKnowledgeContent(srv.db, ownerId, {
          team: 'knowledge-team',
          itemId: proposed.itemId,
          expectedGeneration: before!.generation,
        }),
    );
    if ('error' in erased) throw new Error(erased.error);
    if (!('tombstone' in erased) || !erased.tombstone) throw new Error('Expected a new tombstone.');
    expect(actions).toEqual(['knowledge_deleted']);
    expect(erased.tombstone.hashes).toContain(publishedVersion.hash);
    expect(erased.tombstone.scrubbedResponseContexts).toBe(1);
    const storedVersions = await srv.db
      .select()
      .from(knowledgeVersions)
      .where(eq(knowledgeVersions.itemId, proposed.itemId));
    expect(storedVersions.every((version) => version.body === '' && version.sourceUri === null)).toBe(true);
    expect(storedVersions.map((version) => version.bodyHash)).toContain(publishedVersion.hash);
    expect(
      await srv.db
        .select()
        .from(knowledgeAudienceProjects)
        .where(eq(knowledgeAudienceProjects.versionId, publishedVersion.versionId)),
    ).toHaveLength(0);
    const [storedContext] = await srv.db
      .select()
      .from(knowledgeContexts)
      .where(eq(knowledgeContexts.id, context.contextId));
    expect(storedContext!.response).toBeNull();
    expect(storedContext!.manifest).toEqual(context.manifest);
    const hidden = await searchKnowledge(srv.db, ownerId, {
      team: 'knowledge-team',
      query: 'sensitive-delete-marker',
      page: 1,
      pageSize: 10,
    });
    expect('error' in hidden ? hidden.error : hidden.total).toBe(0);
  });
});

describe('hosted Knowledge Hub capacity guardrails', () => {
  const roomy: KnowledgeCapacityLimits = {
    contentBytes: 1_000_000,
    draftRecords: 100,
    publishedRecords: 100,
    versions: 100,
  };

  async function capacityTeam(slug: string) {
    const [team] = await srv.db
      .insert(teams)
      .values({ name: slug, slug, createdBy: ownerId })
      .returning();
    await srv.db.insert(memberships).values({ teamId: team!.id, userId: ownerId, role: 'owner' });
    return team!;
  }

  const input = (team: string, stableKey: string, body = 'capacity body') => ({
    team,
    stableKey,
    kind: 'reference' as const,
    title: stableKey,
    body,
    audience: { type: 'workspace_members' as const },
    source: { type: 'native' as const },
  });

  it('enforces bytes, draft heads, published heads and immutable versions separately', async () => {
    const bytesTeam = await capacityTeam('knowledge-cap-bytes');
    const bytes = await proposeKnowledge(
      srv.db,
      ownerId,
      input(bytesTeam.slug, 'too-many-bytes', 'four'),
      undefined,
      { ...roomy, contentBytes: 3 },
    );
    expect('error' in bytes && bytes.error).toContain('contentBytes');
    if (!('error' in bytes) || !('capacity' in bytes) || !bytes.capacity) {
      throw new Error('Expected a hosted byte-capacity refusal.');
    }
    expect(bytes.capacity.after.contentBytes).toBe(4);
    expect(
      await srv.db.select().from(knowledgeItems).where(eq(knowledgeItems.teamId, bytesTeam.id)),
    ).toHaveLength(0);

    const draftsTeam = await capacityTeam('knowledge-cap-drafts');
    const draftLimits = { ...roomy, draftRecords: 1 };
    const firstDraft = await proposeKnowledge(
      srv.db,
      ownerId,
      input(draftsTeam.slug, 'draft-one'),
      undefined,
      draftLimits,
    );
    if ('error' in firstDraft) throw new Error(firstDraft.error);
    const secondDraft = await proposeKnowledge(
      srv.db,
      ownerId,
      input(draftsTeam.slug, 'draft-two'),
      undefined,
      draftLimits,
    );
    expect('error' in secondDraft && secondDraft.error).toContain('draftRecords');

    const versionsTeam = await capacityTeam('knowledge-cap-versions');
    const versionLimits = { ...roomy, versions: 1 };
    const firstVersion = await proposeKnowledge(
      srv.db,
      ownerId,
      input(versionsTeam.slug, 'versioned'),
      undefined,
      versionLimits,
    );
    if ('error' in firstVersion) throw new Error(firstVersion.error);
    const replacedVersion = await proposeKnowledge(
      srv.db,
      ownerId,
      {
        ...input(versionsTeam.slug, 'versioned', 'second body'),
        expectedDraftVersionId: firstVersion.draft.versionId,
      },
      undefined,
      versionLimits,
    );
    expect('error' in replacedVersion && replacedVersion.error).toContain('versions');

    const publishedTeam = await capacityTeam('knowledge-cap-published');
    const publishedLimits = { ...roomy, publishedRecords: 1 };
    const firstPublicationDraft = await proposeKnowledge(
      srv.db,
      ownerId,
      input(publishedTeam.slug, 'published-one'),
      undefined,
      publishedLimits,
    );
    if ('error' in firstPublicationDraft) throw new Error(firstPublicationDraft.error);
    const firstPublication = await publishKnowledge(
      srv.db,
      ownerId,
      {
        team: publishedTeam.slug,
        itemId: firstPublicationDraft.draft.itemId,
        draftVersionId: firstPublicationDraft.draft.versionId,
        expectedCurrentVersionId: null,
      },
      publishedLimits,
    );
    if ('error' in firstPublication) throw new Error(firstPublication.error);
    const secondPublicationDraft = await proposeKnowledge(
      srv.db,
      ownerId,
      input(publishedTeam.slug, 'published-two'),
      undefined,
      publishedLimits,
    );
    if ('error' in secondPublicationDraft) throw new Error(secondPublicationDraft.error);
    const secondPublication = await publishKnowledge(
      srv.db,
      ownerId,
      {
        team: publishedTeam.slug,
        itemId: secondPublicationDraft.draft.itemId,
        draftVersionId: secondPublicationDraft.draft.versionId,
        expectedCurrentVersionId: null,
      },
      publishedLimits,
    );
    expect('error' in secondPublication && secondPublication.error).toContain('publishedRecords');
    if (
      !('error' in secondPublication) ||
      !('capacity' in secondPublication) ||
      !secondPublication.capacity
    ) {
      throw new Error('Expected a hosted publication-capacity refusal.');
    }
    expect(secondPublication.capacity.used.publishedRecords).toBe(1);
  });

  it('reclaims active hosted corpus capacity only after explicit owner content erasure', async () => {
    const team = await capacityTeam('knowledge-cap-delete');
    const limits = { ...roomy, versions: 2 };
    const firstDraft = await proposeKnowledge(
      srv.db,
      ownerId,
      input(team.slug, 'erase-me', 'old corpus bytes'),
      undefined,
      limits,
    );
    if ('error' in firstDraft) throw new Error(firstDraft.error);
    const firstPublished = await publishKnowledge(
      srv.db,
      ownerId,
      {
        team: team.slug,
        itemId: firstDraft.draft.itemId,
        draftVersionId: firstDraft.draft.versionId,
        expectedCurrentVersionId: null,
      },
      limits,
    );
    if ('error' in firstPublished) throw new Error(firstPublished.error);
    const blocked = await proposeKnowledge(
      srv.db,
      ownerId,
      input(team.slug, 'blocked-before-delete'),
      undefined,
      limits,
    );
    expect('error' in blocked && blocked.error).toContain('versions');
    const [item] = await srv.db
      .select()
      .from(knowledgeItems)
      .where(eq(knowledgeItems.id, firstDraft.draft.itemId));
    const erased = await deleteKnowledgeContent(srv.db, ownerId, {
      team: team.slug,
      itemId: item!.id,
      expectedGeneration: item!.generation,
    });
    if ('error' in erased) throw new Error(erased.error);
    const after = await proposeKnowledge(
      srv.db,
      ownerId,
      input(team.slug, 'allowed-after-delete'),
      undefined,
      { ...limits, versions: 1 },
    );
    expect(after).not.toHaveProperty('error');
  });
});

describe('Knowledge Hub ACL and deterministic retrieval', () => {
  it('SQL-scopes results, count, snippets and direct ids; a project token never inherits workspace audience', async () => {
    const workspace = await published('acl-workspace', 'acl-scope common workspace-only');
    const payments = await published('acl-payments', 'acl-scope payments-secret', {
      audience: { type: 'selected_projects', projects: ['payments-api'] },
    });
    await published('acl-storefront', 'acl-scope storefront-secret', {
      audience: { type: 'selected_projects', projects: ['storefront'] },
    });

    const human = await searchKnowledge(srv.db, memberId, {
      team: 'knowledge-team',
      project: 'payments-api',
      query: 'acl-scope',
      page: 1,
      pageSize: 20,
    });
    if ('error' in human) throw new Error(human.error);
    expect(human.total).toBe(2);
    expect(human.results.map((result) => result.key).sort()).toEqual(['acl-payments', 'acl-workspace']);
    expect(human.results.map((result) => result.snippet).join(' ')).not.toContain('storefront-secret');

    const agent = await searchKnowledge(
      srv.db,
      memberId,
      {
        team: 'knowledge-team',
        project: 'payments-api',
        query: 'acl-scope',
        page: 1,
        pageSize: 20,
      },
      projectGrant,
    );
    if ('error' in agent) throw new Error(agent.error);
    expect(agent.total).toBe(1);
    expect(agent.results[0]!.key).toBe('acl-payments');
    expect(agent.results[0]!.snippet).toContain('payments-secret');
    expect(agent.results[0]!.snippet).not.toContain('workspace-only');

    const forbiddenWorkspace = await getKnowledge(
      srv.db,
      memberId,
      { team: 'knowledge-team', project: 'payments-api', id: workspace.itemId },
      projectGrant,
    );
    expect('error' in forbiddenWorkspace && forbiddenWorkspace.error).toBe(
      'No current knowledge with that id or key in this scope.',
    );
    const forbiddenOtherProject = await getKnowledge(
      srv.db,
      memberId,
      { team: 'knowledge-team', project: 'payments-api', id: 'acl-storefront' },
      projectGrant,
    );
    expect('error' in forbiddenOtherProject && forbiddenOtherProject.error).toBe(
      'No current knowledge with that id or key in this scope.',
    );

    const outsider = await searchKnowledge(srv.db, outsiderId, {
      team: 'knowledge-team',
      project: 'payments-api',
      query: 'payments-secret',
      page: 1,
      pageSize: 20,
    });
    expect('error' in outsider && outsider.error).not.toContain(payments.versionId);
  });

  it('escapes LIKE wildcards and pages a stable lexical order with a shared total', async () => {
    await published('literal-wildcard', 'only-this q%_z literal');
    await published('literal-control', 'plain control text');
    const literal = await searchKnowledge(srv.db, ownerId, {
      team: 'knowledge-team',
      query: 'q%_z',
      page: 1,
      pageSize: 20,
    });
    if ('error' in literal) throw new Error(literal.error);
    expect(literal.total).toBe(1);
    expect(literal.results[0]!.key).toBe('literal-wildcard');

    await published('page-a', 'page-needle');
    await published('page-b', 'page-needle');
    await published('page-c', 'page-needle');
    const page1 = await searchKnowledge(srv.db, ownerId, {
      team: 'knowledge-team',
      query: 'page-needle',
      page: 1,
      pageSize: 2,
    });
    const page2 = await searchKnowledge(srv.db, ownerId, {
      team: 'knowledge-team',
      query: 'page-needle',
      page: 2,
      pageSize: 2,
    });
    if ('error' in page1 || 'error' in page2) throw new Error('Paged search failed');
    expect(page1.total).toBe(3);
    expect(page2.total).toBe(3);
    expect(page1.results).toHaveLength(2);
    expect(page2.results).toHaveLength(1);
    expect(new Set([...page1.results, ...page2.results].map((result) => result.key))).toEqual(
      new Set(['page-a', 'page-b', 'page-c']),
    );
  });

  it('rejects an audience project that does not exist instead of creating it', async () => {
    const before = await srv.db.select().from(projects).where(eq(projects.teamId, teamId));
    const result = await proposeKnowledge(srv.db, ownerId, {
      team: 'knowledge-team',
      stableKey: 'missing-target',
      kind: 'decision',
      title: 'Missing target',
      body: 'must not be stored',
      audience: { type: 'selected_projects', projects: ['does-not-exist'] },
      source: { type: 'native' },
    });
    expect('error' in result && result.error).toContain('does not exist');
    const after = await srv.db.select().from(projects).where(eq(projects.teamId, teamId));
    expect(after).toHaveLength(before.length);
  });
});

describe('bounded context and delivery evidence', () => {
  it('caps UTF-8 output at 8 KiB, marks truncation and separates served from client-reported evidence', async () => {
    await published('context-large-a', `context-budget ${'é'.repeat(8_000)}`);
    await published('context-large-b', `context-budget ${'z'.repeat(8_000)}`);
    const result = await getKnowledgeContext(srv.db, ownerId, {
      team: 'knowledge-team',
      query: 'context-budget',
      maxItems: 20,
    });
    if ('error' in result) throw new Error(result.error);
    expect(result.byteSize).toBeLessThanOrEqual(KNOWLEDGE_CONTEXT_MAX_BYTES);
    expect(new TextEncoder().encode(result.context).byteLength).toBe(result.byteSize);
    expect(result.truncated).toBe(true);
    expect(result.context).toContain('[truncated]');
    expect(result.omittedCount).toBe(2);
    expect(result.sources).toHaveLength(0);
    expect(result.manifest).toMatchObject({
      byteSize: result.byteSize,
      truncated: true,
      omittedCount: 2,
      versions: [],
    });
    expect(result.manifest.contextHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.completeness).toContain('search_knowledge/get_knowledge');
    expect(result.evidence.clientReportedAt).toBeNull();
    expect(result.evidence.compliance).toBeNull();

    const contexts = await srv.db
      .select()
      .from(knowledgeContexts)
      .where(eq(knowledgeContexts.id, result.contextId));
    const receipts = await srv.db
      .select()
      .from(knowledgeReceipts)
      .where(eq(knowledgeReceipts.contextId, result.contextId));
    expect(contexts[0]!.byteSize).toBe(result.byteSize);
    expect(contexts[0]!.truncated).toBe(true);
    expect(contexts[0]!.purpose).toBe('retrieval');
    expect(contexts[0]!.response).toBeNull();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.servedAt).toBeInstanceOf(Date);
    expect(receipts[0]!.reportedAt).toBeNull();
    expect(receipts[0]!.reportedManifestHash).toBeNull();
  });

  it('retains the first client report and refuses manifest mismatch without overwrite', async () => {
    const context = await getKnowledgeContext(srv.db, ownerId, {
      team: 'knowledge-team',
      query: 'no-record-for-receipt-mismatch',
      maxItems: 1,
    });
    if ('error' in context) throw new Error(context.error);
    const wrongHash = '0'.repeat(64);
    const mismatch = await reportKnowledgeReceipt(srv.db, ownerId, {
      contextId: context.contextId,
      manifestHash: wrongHash,
    });
    expect(mismatch).toMatchObject({
      status: 409,
      matches: false,
      replayed: false,
      reportedManifestHash: wrongHash,
      compliance: null,
    });
    expect('error' in mismatch && mismatch.error).toContain('mismatch');
    if (!('clientReportedAt' in mismatch)) throw new Error('Expected mismatch evidence.');

    const correction = await reportKnowledgeReceipt(srv.db, ownerId, {
      contextId: context.contextId,
      manifestHash: context.manifestHash,
    });
    expect('error' in correction && correction.error).toContain('immutable first report');
    expect(correction).toMatchObject({
      status: 409,
      matches: false,
      reportedManifestHash: wrongHash,
      replayed: true,
    });
    const [stored] = await srv.db
      .select()
      .from(knowledgeReceipts)
      .where(eq(knowledgeReceipts.contextId, context.contextId));
    expect(stored!.reportedManifestHash).toBe(wrongHash);
    expect(stored!.reportedAt?.toISOString()).toBe(mismatch.clientReportedAt);
  });
});

describe('strict import boundary', () => {
  it('accepts only selected UTF-8 text and never interprets a path or URL', () => {
    const valid = validateKnowledgeImports([
      { path: 'docs/runbook.md', content: new TextEncoder().encode('# Refunds\nReview first.'), mediaType: 'text/markdown' },
    ]);
    expect('error' in valid ? valid.error : valid.files[0]!.preview).toContain('Refunds');

    for (const invalid of [
      { path: '../secret.txt', content: 'safe' },
      { path: '/etc/passwd.txt', content: 'safe' },
      { path: 'https://example.com/notes.md', content: 'safe' },
      { path: 'notes.md', content: 'safe', symlink: true },
      { path: 'image.png', content: 'safe', mediaType: 'image/png' },
      { path: 'binary.txt', content: 'zero\0byte' },
      { path: 'secret.txt', content: 'api_key=abcdefghijklmnop' },
      { path: 'bad.txt', content: new Uint8Array([0xc3, 0x28]) },
    ]) {
      expect(validateKnowledgeImports([invalid])).toHaveProperty('error');
    }

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      expect(validateKnowledgeImports([{ path: 'https://invalid.test/a.md', content: 'safe' }])).toHaveProperty(
        'error',
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('enforces per-item, file-count and aggregate byte caps before storage', () => {
    expect(validateNativeKnowledgeBody('a'.repeat(KNOWLEDGE_ITEM_MAX_BYTES))).not.toHaveProperty('error');
    expect(validateNativeKnowledgeBody('a'.repeat(KNOWLEDGE_ITEM_MAX_BYTES + 1))).toHaveProperty('error');
    expect(validateNativeKnowledgeBody('é'.repeat(KNOWLEDGE_ITEM_MAX_BYTES / 2 + 1))).toHaveProperty('error');
    expect(
      validateKnowledgeImports(
        Array.from({ length: 21 }, (_, index) => ({ path: `file-${index}.txt`, content: 'x' })),
      ),
    ).toHaveProperty('error');
    expect(
      validateKnowledgeImports(
        Array.from({ length: 17 }, (_, index) => ({
          path: `large-${index}.txt`,
          content: 'x'.repeat(KNOWLEDGE_ITEM_MAX_BYTES),
        })),
      ),
    ).toHaveProperty('error');
  });
});

describe('MCP and browser surfaces', () => {
  it('registers the five additive names and enforces the project credential end to end', async () => {
    const listResponse = await fetch(`${srv.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${projectPat}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/list', params: {} }),
    });
    const list = (await listResponse.json()) as { result: { tools: Array<{ name: string }> } };
    const names = list.result.tools.map((tool) => tool.name);
    expect(names.filter((name) => name.includes('knowledge')).sort()).toEqual([
      'get_knowledge',
      'get_knowledge_context',
      'propose_knowledge',
      'report_knowledge_receipt',
      'search_knowledge',
    ]);

    const search = await callTool(projectPat, 'search_knowledge', { query: 'acl-scope' });
    expect(search.isError, search.text).toBe(false);
    expect(search.data.total).toBe(1);
    expect(search.data.results[0].key).toBe('acl-payments');

    const workspace = await callTool(projectPat, 'get_knowledge', { id: 'acl-workspace' });
    expect(workspace.isError).toBe(true);
    expect(workspace.text).toContain('No current knowledge');

    const wrongProposal = await callTool(projectPat, 'propose_knowledge', {
      stable_key: 'project-agent-wrong',
      kind: 'reference',
      title: 'Wrong audience',
      body: 'should stay absent',
      audience: 'workspace_members',
      source_type: 'native',
    });
    expect(wrongProposal.isError).toBe(true);
    expect(wrongProposal.text).toContain('exact project audience');

    const proposal = await callTool(projectPat, 'propose_knowledge', {
      stable_key: 'project-agent-draft',
      kind: 'reference',
      title: 'Agent proposal',
      body: 'review me before publication',
      audience: 'selected_projects',
      projects: ['payments-api'],
      source_type: 'native',
    });
    expect(proposal.isError, proposal.text).toBe(false);
    expect(proposal.data.published).toBe(false);
    const hidden = await callTool(projectPat, 'search_knowledge', { query: 'review me' });
    expect(hidden.data.total).toBe(0);
  });

  it('renders knowledge as escaped text and never exposes management heads to a member', async () => {
    const attack = `<script>globalThis.knowledgePwned=true</script></pre><img src=x onerror=alert(1)>`;
    await published('xss-reference', attack, {
      audience: { type: 'selected_projects', projects: ['storefront'] },
    });

    const ownerPage = await fetch(`${srv.url}/app/teams/knowledge-team/knowledge`, {
      headers: ownerCookie,
    });
    const ownerHtml = await ownerPage.text();
    expect(ownerPage.status).toBe(200);
    expect(ownerHtml).toContain('&lt;script&gt;globalThis.knowledgePwned=true&lt;/script&gt;');
    expect(ownerHtml).not.toContain('<script>globalThis.knowledgePwned=true</script>');
    expect(ownerHtml).not.toContain('</pre><img src=x onerror=alert(1)>');

    const memberPage = await fetch(`${srv.url}/app/teams/knowledge-team/knowledge`, {
      headers: memberCookie,
    });
    const memberHtml = await memberPage.text();
    expect(memberPage.status).toBe(200);
    expect(memberHtml).not.toContain('globalThis.knowledgePwned');
    expect(memberHtml).not.toContain('xss-reference');
    expect(memberHtml).toContain('Members can search current published knowledge');
  });

  it('lists inside a project what applies there, and says where each record comes from', async () => {
    // The owner, 2026-09-20: is Knowledge a workspace thing or a project thing?
    // Both, by audience; inside a project the page shows what reaches that project
    // and labels which records are everybody's and which are addressed to it.
    await published('scope-everyone', 'applies in every project');
    await published('scope-payments', 'addressed to payments', {
      audience: { type: 'selected_projects', projects: ['payments-api'] },
    });
    await published('scope-both', 'addressed to two projects', {
      audience: { type: 'selected_projects', projects: ['payments-api', 'storefront'] },
    });
    await published('scope-storefront', 'addressed to storefront', {
      audience: { type: 'selected_projects', projects: ['storefront'] },
    });
    const get = async (p: string, cookie = ownerCookie) => (await fetch(`${srv.url}${p}`, { headers: cookie })).text();
    const record = (html: string, key: string) => {
      const at = html.indexOf(`Title ${key}</div>`);
      return at < 0 ? '' : html.slice(at, html.indexOf('</section>', at));
    };

    const inProject = await get('/app/teams/knowledge-team/knowledge?project=payments-api');
    expect(inProject).toContain('Knowledge in Payments API');
    expect(inProject).toContain('<a href="/app/teams/knowledge-team/projects/payments-api">Payments API</a>');
    expect(record(inProject, 'scope-everyone')).toContain('from the workspace');
    expect(record(inProject, 'scope-payments')).toContain('this project only');
    expect(record(inProject, 'scope-both')).toContain('this and 1 other project');
    // Addressed elsewhere: counted, with the way to the full list, never listed here.
    expect(record(inProject, 'scope-storefront')).toBe('');
    expect(inProject).toContain('id="knowledge-elsewhere"');
    expect(inProject).toContain('addressed to other projects only');
    // A record added from here starts addressed to this project and comes back here.
    expect(inProject).toContain('Add for Payments API only');
    expect(inProject).toContain('name="scope_project" value="payments-api"');
    expect(inProject).toMatch(/<option value="selected_projects" selected[^>]*>Selected projects only/);
    expect(inProject).toContain('id="kh-projects" name="projects" value="payments-api"');

    // The workspace page lists everything and says who each record applies to.
    const workspace = await get('/app/teams/knowledge-team/knowledge');
    expect(record(workspace, 'scope-everyone')).toContain('every project');
    expect(record(workspace, 'scope-storefront')).toContain('only:');
    expect(record(workspace, 'scope-storefront')).toContain('href="/app/teams/knowledge-team/projects/storefront/knowledge"');
    expect(workspace).not.toContain('id="knowledge-elsewhere"');

    // A write made inside the project returns inside it.
    const saved = await fetch(`${srv.url}/app/teams/knowledge-team/knowledge/drafts`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...ownerCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        scope_project: 'payments-api',
        stable_key: 'scope-return',
        title: 'Scope return',
        kind: 'reference',
        body: 'a draft saved from inside the project',
        audience: 'selected_projects',
        projects: 'payments-api',
        source_type: 'native',
      }),
    });
    expect(saved.status).toBe(302);
    const where = decodeURIComponent(saved.headers.get('location') ?? '');
    // The write returns to the page it was made on, at that page's own address.
    expect(where).toContain('/app/teams/knowledge-team/projects/payments-api/knowledge?');
    expect(where).toContain('notice=Draft saved');
  });

  it('revoked project credentials cannot call a knowledge tool', async () => {
    await srv.db.update(tokens).set({ revokedAt: new Date() }).where(eq(tokens.id, projectTokenId));
    const result = await callTool(projectPat, 'search_knowledge', { query: 'acl-scope' });
    expect(result.status).toBe(401);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('revoked');
  });
});

it('keeps the normalized project audience rows tenant-aligned', async () => {
  const rows = await srv.db
    .select({ itemTeam: knowledgeItems.teamId, versionTeam: knowledgeVersions.teamId })
    .from(knowledgeItems)
    .innerJoin(knowledgeVersions, eq(knowledgeItems.currentVersionId, knowledgeVersions.id))
    .where(and(eq(knowledgeItems.teamId, teamId), eq(knowledgeVersions.audienceType, 'selected_projects')));
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((row) => row.itemTeam === row.versionTeam && row.itemTeam === teamId)).toBe(true);
  expect(storefrontId).not.toBe(paymentsId);
});

/**
 * The other half of the navigation contract's "no stale values": what you typed
 * is not lost either. The policy editor learned this on 2026-09-20; these two
 * forms still threw the work away, and the usual refusal is one unknown project
 * name at the end of a body somebody spent ten minutes writing.
 */
it('hands a refused knowledge draft back with everything still in it', async () => {
  const body = 'The refund reference lives in the ledger service, not in payments.';
  const refused = await fetch(`${srv.url}/app/teams/knowledge-team/knowledge/drafts`, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...ownerCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      scope_project: 'payments-api',
      stable_key: 'kept-on-refusal',
      title: 'Kept on refusal',
      kind: 'reference',
      body,
      audience: 'selected_projects',
      // The refusal: this project does not exist in this workspace.
      projects: 'no-such-project',
      conflict_reason: 'a reason worth not retyping',
    }),
  });
  // The page, not a redirect to an empty one, and not a 200 either: the address
  // did not change and the write did not happen.
  expect(refused.status).toBe(422);
  const page = await refused.text();
  expect(page).toContain(body);
  expect(page).toContain('value="kept-on-refusal"');
  expect(page).toContain('value="Kept on refusal"');
  expect(page).toContain('value="no-such-project"');
  expect(page).toContain('a reason worth not retyping');
  // And it re-renders in the scope the form was posted for, which a POST has no
  // query string of its own to come back to.
  expect(page).toContain('Add for Payments API only');
  // And with the scope it draws the chrome of that scope. A POST never computes
  // the rail on its own, so the page that answered a refused draft used to sit
  // under a rail that said "no workspace yet" beside the workspace's records.
  expect(page).toContain('class="rail-group">Payments API</span>');
  expect(page).toContain('href="/app/teams/knowledge-team/projects/payments-api/knowledge"');
  // A successful write returns to the page it was made on, in that page's address.
  const published = await fetch(`${srv.url}/app/teams/knowledge-team/knowledge/drafts`, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...ownerCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      scope_project: 'payments-api',
      stable_key: 'returns-to-the-project',
      title: 'Returns to the project',
      kind: 'reference',
      body: 'A record written from inside a project.',
      audience: 'workspace_members',
    }),
  });
  expect(published.status).toBe(302);
  expect(published.headers.get('location')).toMatch(
    /^\/app\/teams\/knowledge-team\/projects\/payments-api\/knowledge\?notice=/,
  );
  // Nothing was written.
  const after = await fetch(`${srv.url}/app/teams/knowledge-team/knowledge`, { headers: ownerCookie });
  expect(await after.text()).not.toContain('kept-on-refusal');
});

it('keeps the fields of a refused import and says the file has to be picked again', async () => {
  const upload = new FormData();
  upload.set('scope_project', 'payments-api');
  upload.set('stable_key', 'import-kept');
  upload.set('title', 'Import kept');
  upload.set('kind', 'reference');
  upload.set('audience', 'selected_projects');
  upload.set('projects', 'no-such-project');
  upload.set('repository', 'github.com/example/ledger');
  upload.set('commit', 'a'.repeat(40));
  upload.set('file', new File(['# Ledger notes\n'], 'notes.md', { type: 'text/markdown' }));
  const refused = await fetch(`${srv.url}/app/teams/knowledge-team/knowledge/imports`, {
    method: 'POST',
    redirect: 'manual',
    headers: ownerCookie,
    body: upload,
  });
  expect(refused.status).toBe(422);
  const page = await refused.text();
  expect(page).toContain('value="import-kept"');
  expect(page).toContain('value="github.com/example/ledger"');
  expect(page).toContain(`value="${'a'.repeat(40)}"`);
  // A browser will not let a page refill a file input, so the page says so
  // rather than leaving somebody to wonder why one box emptied itself.
  expect(page).toContain('the file has to be chosen again');
});
