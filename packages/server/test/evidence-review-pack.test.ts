/**
 * The run review pack (2026-10-22): which run, repository and commit, who said
 * what about it, why a provider line is empty, where the work was handed over,
 * what the receipts are and are not, and a Markdown copy that cannot act in a
 * reviewer's tool. Domain-level, on a bare database, like
 * `evidence-checkpoints.test.ts`: every row is one the product writes.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectDb, type Db } from '../src/db';
import {
  agentInstallations,
  agentRuns,
  debugSessions,
  handoffs,
  knowledgeContexts,
  memberships,
  policyReceipts,
  projects,
  repositoryBindings,
  runCheckpoints,
  teamIntegrations,
  teams,
  users,
} from '../src/db/schema';
import { evidenceForRun, RESUME_RULE } from '../src/domain/evidence';
import {
  evidenceMarkdown,
  evidencePullRequestBlock,
  mdText,
  membersOnly,
  RECEIPT_IS_NOT_APPROVAL,
  type EvidencePack,
} from '../src/domain/evidenceSummary';
import { recordProviderObservation } from '../src/domain/providerEvidence';
import { loadEnv } from '../src/env';

let db: Db;
let close: () => Promise<void>;
let dir: string;
let userId: string;
let teamId: string;
let installationId: string;
let receiverId: string;

const sha = (letter: string) => letter.repeat(40);
const URL_SELF = 'https://stma.example/app/teams/review-pack/runs/x';

interface Project {
  id: string;
  repository: string;
  bindingId: string | null;
  repositoryId: string;
  connectionId: string | null;
}

let counter = 0;
async function project(options: { bound: boolean; lastCheck?: Record<string, unknown> }): Promise<Project> {
  counter += 1;
  const repository = `github.com/acme/repo-${counter}`;
  const [row] = await db
    .insert(projects)
    .values({ teamId, name: `repo-${counter}`, slug: `repo-${counter}`, repositoryIdentity: repository, createdBy: userId })
    .returning();
  if (!options.bound) return { id: row!.id, repository, bindingId: null, repositoryId: '', connectionId: null };
  const [connection] = await db
    .insert(teamIntegrations)
    .values({
      teamId,
      provider: 'github',
      repo: `acme/repo-${counter}`,
      token: 'fixture-only',
      createdBy: userId,
      config: options.lastCheck ? { lastCheck: options.lastCheck } : null,
    })
    .returning();
  const repositoryId = `repo-id-${counter}`;
  const [binding] = await db
    .insert(repositoryBindings)
    .values({
      connectionId: connection!.id,
      teamId,
      projectId: row!.id,
      provider: 'github',
      repositoryId,
      fullName: `acme/repo-${counter}`,
      verifiedAt: new Date(),
    })
    .returning();
  return { id: row!.id, repository, bindingId: binding!.id, repositoryId, connectionId: connection!.id };
}

async function run(p: Project, values: Partial<typeof agentRuns.$inferInsert> = {}) {
  return (
    await db
      .insert(agentRuns)
      .values({ installationId, teamId, projectId: p.id, status: 'completed', endedAt: new Date(), ...values })
      .returning()
  )[0]!;
}

async function checkpoint(
  runId: string,
  p: Project,
  commitSha: string,
  createdAt: Date,
  options: {
    kind?: 'delivery' | 'tested';
    repositoryIdentity?: string;
    tests?: Array<{ name: string; state: 'passed' | 'failed' | 'not_run'; detail?: string }>;
  } = {},
) {
  return (
    await db
      .insert(runCheckpoints)
      .values({
        runId,
        teamId,
        projectId: p.id,
        installationId,
        kind: options.kind ?? 'delivery',
        repositoryIdentity: options.repositoryIdentity ?? p.repository,
        commitSha,
        worktreeClean: true,
        tests: options.tests ?? [],
        requestId: randomUUID(),
        requestHash: randomUUID(),
        createdAt,
      })
      .returning()
  )[0]!;
}

async function observe(p: Project, commitSha: string, state: 'success' | 'failure' = 'success') {
  const deliveryId = randomUUID();
  const result = await recordProviderObservation(db, teamId, 'github', {
    bindingId: p.bindingId!,
    repositoryId: p.repositoryId,
    deliveryId,
    subjectId: `workflow:${deliveryId.slice(0, 8)}`,
    commitSha,
    kind: 'workflow',
    state,
    observedAt: new Date(Date.now() - 1_000),
  });
  expect(result).toHaveProperty('recorded', true);
}

async function pack(runId: string): Promise<EvidencePack> {
  const result = await evidenceForRun(db, runId, userId);
  if ('error' in result) throw new Error(result.error);
  return result;
}

const ago = (ms: number) => new Date(Date.now() - ms);

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'stma-evidence-review-pack-'));
  ({ db, close } = await connectDb(loadEnv({ nodeEnv: 'test', databaseUrl: undefined, pgliteDir: dir })));
  userId = (await db.insert(users).values({ username: 'pack-owner' }).returning())[0]!.id;
  teamId = (
    await db.insert(teams).values({ name: 'Review pack', slug: 'review-pack', createdBy: userId }).returning()
  )[0]!.id;
  await db.insert(memberships).values({ teamId, userId, role: 'owner' });
  installationId = (
    await db
      .insert(agentInstallations)
      .values({ userId, name: 'pack-agent', deviceLabel: 'laptop', deviceFingerprint: randomUUID() })
      .returning()
  )[0]!.id;
  receiverId = (
    await db
      .insert(agentInstallations)
      .values({ userId, name: 'receiving-agent', deviceLabel: 'desktop', deviceFingerprint: randomUUID() })
      .returning()
  )[0]!.id;
});

afterAll(async () => {
  await close?.();
  rmSync(dir, { recursive: true, force: true });
});

describe('why a provider line says what it says', () => {
  it('no_checkpoint: nothing names a commit', async () => {
    const p = await project({ bound: true });
    const subject = await run(p);
    const found = await pack(subject.id);
    expect(found.provider.state).toBe('no_checkpoint');
    expect(found.repository).toEqual({ project: p.repository, checkpoint: null, matches: false });
  });

  it('not_connected: no repository is bound to the project', async () => {
    const p = await project({ bound: false });
    const subject = await run(p);
    await checkpoint(subject.id, p, sha('a'), ago(1_000));
    const found = await pack(subject.id);
    expect(found.provider.state).toBe('not_connected');
    expect(found.provider.detail).toContain('No provider observation of this exact commit.');
    expect(found.provider.detail).toContain('No GitHub or Azure DevOps repository is connected');
    expect(evidenceMarkdown(found)).toContain('No GitHub or Azure DevOps repository is connected');
  });

  it('repository_mismatch: a green for the same commit in the project repository is not attached', async () => {
    const p = await project({ bound: true });
    const subject = await run(p);
    await checkpoint(subject.id, p, sha('b'), ago(1_000), { repositoryIdentity: 'github.com/other/api' });
    await observe(p, sha('b'));
    const found = await pack(subject.id);
    expect(found.provider.state).toBe('repository_mismatch');
    expect(found.providerFacts).toEqual([]);
    expect(found.repository).toEqual({ project: p.repository, checkpoint: 'github.com/other/api', matches: false });
    expect(evidenceMarkdown(found)).toContain('not the project’s repository');
  });

  it('older_commit_only: a result for an earlier commit is named as that commit’s and never carried', async () => {
    const p = await project({ bound: true });
    const subject = await run(p);
    await checkpoint(subject.id, p, sha('c'), ago(5_000));
    await observe(p, sha('c'));
    // A force-push shape: the new delivery commit is unrelated to the old one.
    const newest = await checkpoint(subject.id, p, sha('d'), ago(3_000));
    let found = await pack(subject.id);
    expect(found.checkpoint?.id).toBe(newest.id);
    expect(found.providerFacts).toEqual([]);
    expect(found.provider.state).toBe('older_commit_only');
    expect(found.provider.olderCommits.map((row) => row.commitSha)).toEqual([sha('c')]);
    expect(found.checks.find((check) => check.key === 'outcome')!.state).not.toBe('ok');
    const markdown = evidenceMarkdown(found);
    expect(markdown).toContain('reported on an older commit of this run');
    expect(markdown).toContain(`Older commit \`${sha('c')}\`, not this one`);

    // The provider answers late about the old commit: it stays on the old commit.
    await observe(p, sha('c'));
    found = await pack(subject.id);
    expect(found.providerFacts).toEqual([]);
    expect(found.provider.state).toBe('older_commit_only');
    expect(found.blocking).not.toContain('outcome');

    // And when the provider reports on the new commit, that is what is attached.
    await observe(p, sha('d'));
    found = await pack(subject.id);
    expect(found.provider.state).toBe('observed');
    expect(found.providerFacts.map((row) => row.fact.commitSha)).toEqual([sha('d')]);
    expect(found.provider.olderCommits).toEqual([]);
  });

  it('connection_failing: the stored last check failed, with and without an exact fact', async () => {
    const lastCheck = { ok: false, at: '2026-10-21T10:00:00.000Z', error: 'bad_token' };
    const p = await project({ bound: true, lastCheck });
    const subject = await run(p);
    await checkpoint(subject.id, p, sha('e'), ago(2_000));
    let found = await pack(subject.id);
    expect(found.provider.state).toBe('connection_failing');
    expect(found.provider.detail).toContain('failed its last check at 2026-10-21T10:00:00.000Z (bad_token)');
    expect(found.provider.connections).toEqual([
      { provider: 'github', fullName: expect.stringContaining('acme/repo-'), lastCheck: { ok: false, at: lastCheck.at, error: 'bad_token' } },
    ]);

    // An exact fact still counts, and the failing connection is still named.
    await observe(p, sha('e'));
    found = await pack(subject.id);
    expect(found.provider.state).toBe('observed');
    expect(found.provider.detail).toContain('failed its last check');
    expect(found.providerFacts).toHaveLength(1);
  });

  it('no_observation: connected and healthy, and STMA says it cannot tell pending from never', async () => {
    const p = await project({ bound: true, lastCheck: { ok: true, at: '2026-10-21T10:00:00.000Z' } });
    const subject = await run(p);
    await checkpoint(subject.id, p, sha('f'), ago(2_000));
    const found = await pack(subject.id);
    expect(found.provider.state).toBe('no_observation');
    expect(found.provider.detail).toContain('cannot tell a result still pending from one that will never come');
  });

  it("a newer checkpoint with no tests does not borrow the older checkpoint's passing tests", async () => {
    const p = await project({ bound: false });
    const subject = await run(p);
    await checkpoint(subject.id, p, sha('1'), ago(5_000), {
      kind: 'tested',
      tests: [{ name: 'old suite', state: 'passed' }],
    });
    await checkpoint(subject.id, p, sha('2'), ago(2_000), { kind: 'tested' });
    const found = await pack(subject.id);
    expect(found.checkpoint?.tests).toEqual([]);
    const markdown = evidenceMarkdown(found);
    expect(markdown).not.toContain('old suite');
    expect(markdown).toContain('Tests: none reported with this checkpoint');
  });
});

describe('the handover', () => {
  it("lists this run's handoffs with the receiver and its steps, and nothing else", async () => {
    const p = await project({ bound: false });
    const subject = await run(p);
    const cp = await checkpoint(subject.id, p, sha('3'), ago(10_000));
    const elsewhere = await run(p);
    const otherCp = await checkpoint(elsewhere.id, p, sha('4'), ago(10_000));
    const thread = async (title: string) =>
      (await db.insert(debugSessions).values({ teamId, title, openedBy: userId }).returning())[0]!;
    const resumed = await thread('Finish the label retry');
    await db.insert(handoffs).values({
      sessionId: resumed.id,
      offeredBy: userId,
      kind: 'handoff',
      checkpointId: cp.id,
      installationId: receiverId,
      acceptedBy: userId,
      state: 'resumed',
      acceptedAt: ago(8_000),
      resumedAt: ago(7_000),
    });
    // An assignment carries no checkpoint, and another run's handoff is not this run's.
    await db.insert(handoffs).values({ sessionId: (await thread('An assignment')).id, offeredBy: userId, kind: 'assignment' });
    await db.insert(handoffs).values({ sessionId: (await thread('Not this run')).id, offeredBy: userId, checkpointId: otherCp.id });

    const found = await pack(subject.id);
    expect(found.handovers).toHaveLength(1);
    expect(found.handovers[0]).toMatchObject({
      title: 'Finish the label retry',
      checkpointId: cp.id,
      commitSha: sha('3'),
      receiver: 'receiving-agent',
      state: 'resumed',
      completedAt: null,
      resumeRule: RESUME_RULE,
    });
    expect(found.handovers[0]!.acceptedAt).toBeTruthy();
    expect(found.handovers[0]!.resumedAt).toBeTruthy();
    const markdown = evidenceMarkdown(found);
    expect(markdown).toContain('Receiver: receiving-agent.');
    expect(markdown).toContain('completed not recorded');
    expect(markdown).toContain(RESUME_RULE);
    // A resume can also be proved by a checkpoint the receiving run reported
    // (collaboration.ts, `receiving_run_start`), and the pack does not store
    // which basis applied, so the sentence must not claim the checkout alone.
    expect(RESUME_RULE).toContain('a clean checkpoint its own run reported there');
    expect(RESUME_RULE).toContain('does not record which');
    expect(markdown).not.toContain('An assignment');
    expect(markdown).not.toContain('Not this run');

    const none = await pack(elsewhere.id);
    expect(none.handovers.map((row) => row.title)).toEqual(['Not this run']);
  });
});

describe('the Markdown', () => {
  let found: EvidencePack;
  let versionIds: string[];

  beforeAll(async () => {
    const p = await project({ bound: false });
    const subject = await run(p, { taskKey: 'PD-27', branch: 'pd-27-label-retry' });
    await checkpoint(subject.id, p, sha('5'), ago(2_000), { kind: 'tested', tests: [{ name: 'npm test', state: 'passed', detail: '41 passed' }] });
    await db.insert(policyReceipts).values({ runId: subject.id, expectedHash: '9'.repeat(64), reportedHash: '8'.repeat(64), drift: true });
    versionIds = [randomUUID(), randomUUID()];
    await db.insert(knowledgeContexts).values({
      teamId,
      projectId: p.id,
      runId: subject.id,
      purpose: 'run_start',
      resolverVersion: 'test',
      manifest: { versions: versionIds.map((versionId) => ({ itemId: randomUUID(), versionId })) },
      byteSize: 0,
    });
    found = await pack(subject.id);
  });

  it('names the run, checkpoint, full commit and project repository, in sections by source', async () => {
    const markdown = evidenceMarkdown(found, { url: URL_SELF });
    expect(markdown).toContain(`\`${found.run.id}\``);
    expect(markdown).toContain(`\`${found.checkpoint!.id}\``);
    expect(markdown).toContain(`\`${sha('5')}\``);
    expect(markdown).toContain(`Project repository: \`${found.repository.project}\``);
    const headings = markdown.split('\n').filter((line) => line.startsWith('### '));
    expect(headings).toEqual([
      '### Identity',
      '### Delivered commit',
      '### Reported by the agent',
      '### Observed by STMA',
      '### Observed by the provider',
      '### Handover',
      '### Policy and Knowledge',
      '### Still open',
    ]);
    expect(markdown).toContain('**Delivered commit** (ok, reported by the agent)');
    expect(markdown).toContain('Tests reported by the agent: npm test passed (41 passed)');
    // Full hashes, not twelve characters of them.
    expect(markdown).toContain(`\`${'9'.repeat(64)}\``);
    expect(markdown).toContain(`\`${'8'.repeat(64)}\``);
    for (const id of versionIds) expect(markdown).toContain(`\`${id}\``);
    expect(markdown).toContain(RECEIPT_IS_NOT_APPROVAL);
    expect(markdown).toContain(membersOnly('`review-pack`'));
    expect(markdown).toContain(`Run page: ${URL_SELF}`);
    expect(markdown).toContain('Informational evidence, not authorization to merge or deploy.');
    expect(found.schemaVersion).toBe(2);
    expect(found.policy).toMatchObject({ expectedHash: '9'.repeat(64), reportedHash: '8'.repeat(64), drift: true });
    expect(found.knowledge?.versionIds).toEqual(versionIds);
  });

  it('keeps the short block short, with the commit and who can open the link', () => {
    const block = evidencePullRequestBlock(found, { url: URL_SELF });
    const lines = block.trimEnd().split('\n');
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(block).toContain(`\`${found.checkpoint!.repositoryIdentity}@${sha('5')}\``);
    expect(block).toContain('1 passed, 0 failed, 0 not run');
    expect(block).toContain(membersOnly('`review-pack`'));
    expect(block).toContain(URL_SELF);
  });
});

describe('text somebody else wrote', () => {
  const hostile = '[ok](javascript:alert(1)) <img src=x onerror=1> @acme/all | # Approved https://evil.example www.evil.example';
  const unescaped = (text: string, token: string) =>
    new RegExp(`(?<!\\\\)${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text);

  it('cannot form a link, image, HTML, heading, table cell or mention, and leaks no token', async () => {
    const p = await project({ bound: false });
    const subject = await run(p, {
      taskKey: `${hostile} stma_0123456789abcdef0123456789abcdef01234567`,
      intent: 'deploy with stma_0123456789abcdef0123456789abcdef01234567',
      branch: 'feature/`x`',
    });
    await checkpoint(subject.id, p, sha('6'), ago(2_000), {
      kind: 'tested',
      tests: [
        { name: 'npm test\n# Approved ``` ghp_abcdefghijklmnopqrstuvwxyz0123', state: 'passed' },
      ],
    });
    await db.update(agentInstallations).set({ name: 'evil](https://evil)' }).where(eq(agentInstallations.id, installationId));
    try {
      const found = await pack(subject.id);
      for (const text of [evidenceMarkdown(found, { url: URL_SELF }), evidencePullRequestBlock(found, { url: URL_SELF })]) {
        // No line a person wrote can become a heading: the only ones are STMA's.
        expect(text.split('\n').filter((line) => line.startsWith('#') && !line.startsWith('## STMA evidence') && !line.startsWith('### '))).toEqual([]);
        for (const token of ['[ok]', '](', '<img', '@acme', 'javascript:', '| #']) {
          expect(unescaped(text, token), `${token} survived`).toBe(false);
        }
        expect(text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
        expect(text).not.toContain('stma_0123456789abcdef0123456789abcdef01234567');
        expect(text).not.toContain('https://evil.example');
        // The one live address is STMA's own run page.
        expect(text).toContain(URL_SELF);
      }
      const markdown = evidenceMarkdown(found);
      expect(markdown).toContain('## STMA evidence: \\[ok\\]\\(javascript\\:');
    } finally {
      await db.update(agentInstallations).set({ name: 'pack-agent' }).where(eq(agentInstallations.id, installationId));
    }
  });

  it('mdText keeps ordinary prose readable', () => {
    expect(mdText('PD-27 retry, v2.1 done.')).toBe('PD-27 retry, v2.1 done.');
    expect(mdText('a\n\n  b')).toBe('a b');
    expect(mdText('token: abc123secret')).toContain('[REDACTED]'.replace(/[[\]]/g, (c) => `\\${c}`));
  });
});
