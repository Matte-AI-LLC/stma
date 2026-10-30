/**
 * Who may read a run's evidence, and through which door (2026-10-22).
 *
 * A hosted Free or Solo workspace used to get the run page, its Markdown and
 * the map's inspector while `get_evidence` refused the same person: one
 * principal, two answers, hidden only because production runs the beta. Basic
 * run evidence is on every plan now, and every door reads one request-local
 * decision (`evidenceAllowed`), so a composition resolver that turns it off
 * closes all of them together. What never moves is the boundary in front of
 * it: membership, a credential's project scope and revocation.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatePat } from '../src/auth/pat';
import type { Db } from '../src/db';
import {
  agentInstallations,
  agentRuns,
  memberships,
  planGrants,
  policyReceipts,
  projects,
  runCheckpoints,
  teams,
  tokens,
  users,
  webSessions,
} from '../src/db/schema';
import { loadEnv } from '../src/env';
import { randomHex } from '../src/lib/crypto';
import { setPlanGrant } from '../src/lib/planGrants';
import { EVIDENCE_NOT_INCLUDED } from '../src/routes/runs';
import { startServer, type StartedServer } from '../src/server';

let metered: StartedServer;
let beta: StartedServer;
let meteredDir: string;
let betaDir: string;
let narrowedTeamId = '';

interface Person {
  id: string;
  username: string;
  cookie: string;
  token: string;
}

async function person(db: Db, username: string): Promise<Person> {
  const [user] = await db.insert(users).values({ username }).returning();
  const sid = randomHex(32);
  await db.insert(webSessions).values({ id: sid, userId: user!.id, expiresAt: new Date(Date.now() + 86_400_000) });
  const pat = generatePat();
  await db.insert(tokens).values({ userId: user!.id, tokenHash: pat.hash, prefix: pat.prefix, name: `${username}-machine` });
  return { id: user!.id, username, cookie: `sid=${sid}`, token: pat.token };
}

interface Workspace {
  id: string;
  slug: string;
  projectId: string;
  runId: string;
}

async function workspace(db: Db, owner: Person, slug: string, plan: string): Promise<Workspace> {
  const [team] = await db.insert(teams).values({ name: slug, slug, createdBy: owner.id, plan }).returning();
  await db.insert(memberships).values({ teamId: team!.id, userId: owner.id, role: 'owner' });
  const [project] = await db
    .insert(projects)
    .values({ teamId: team!.id, name: 'api', slug: 'api', repositoryIdentity: `github.com/${slug}/api`, createdBy: owner.id })
    .returning();
  const runId = await seedRun(db, owner, team!.id, project!.id, `github.com/${slug}/api`);
  return { id: team!.id, slug, projectId: project!.id, runId };
}

async function seedRun(db: Db, owner: Person, teamId: string, projectId: string, repository: string) {
  // Inserted rather than started: start_run is refused on Free, and this is
  // about reading what a run already recorded, whatever plan made it.
  const [installation] = await db
    .insert(agentInstallations)
    .values({ userId: owner.id, name: `agent-${randomHex(3)}`, deviceLabel: 'laptop', deviceFingerprint: randomUUID() })
    .returning();
  const [run] = await db
    .insert(agentRuns)
    .values({
      installationId: installation!.id,
      teamId,
      projectId,
      status: 'completed',
      taskKey: 'EV-1',
      endedAt: new Date(),
      lastHeartbeatAt: new Date(),
    })
    .returning();
  await db.insert(runCheckpoints).values({
    runId: run!.id,
    teamId,
    projectId,
    installationId: installation!.id,
    kind: 'delivery',
    repositoryIdentity: repository,
    commitSha: 'e'.repeat(40),
    worktreeClean: true,
    tests: [{ name: 'npm test', state: 'passed' }],
    requestId: randomUUID(),
    requestHash: randomUUID(),
  });
  await db.insert(policyReceipts).values({ runId: run!.id, expectedHash: 'f'.repeat(64), reportedHash: 'f'.repeat(64) });
  return run!.id;
}

const page = (srv: StartedServer, who: Person, pathname: string) =>
  fetch(`${srv.url}${pathname}`, { headers: { cookie: who.cookie }, redirect: 'manual' });

let rpcId = 1;
async function call(srv: StartedServer, tool: string, args: Record<string, unknown>, token: string) {
  const res = await fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: tool, arguments: args } }),
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

/** Every door, for one person and one run. */
async function doors(srv: StartedServer, who: Person, ws: Workspace) {
  const href = `/app/teams/${ws.slug}/runs/${ws.runId}`;
  const runPage = await page(srv, who, href);
  const markdown = await page(srv, who, `${href}/evidence.md`);
  const map = await (await page(srv, who, `/app/agents?run=${ws.runId}`)).text();
  const mcp = await call(srv, 'get_evidence', { run_id: ws.runId }, who.token);
  return { runPage: runPage.status, runHtml: await runPage.text(), markdown: markdown.status, markdownText: await markdown.text(), map, mcp };
}

let owners: Record<string, Person> = {};
let member: Person;
let outsider: Person;
const spaces: Record<string, Workspace> = {};

beforeAll(async () => {
  meteredDir = mkdtempSync(path.join(tmpdir(), 'stma-evidence-access-'));
  betaDir = mkdtempSync(path.join(tmpdir(), 'stma-evidence-access-beta-'));
  const base = { port: 0, host: '127.0.0.1', nodeEnv: 'test' as const, devMode: true, databaseUrl: undefined, hosted: true };
  metered = await startServer(loadEnv({ ...base, pgliteDir: meteredDir }), {
    lifecycle: {
      // A composition that narrows evidence for one workspace, the way an EE
      // resolver narrows an evaluation. No plan in PLANS turns it off any more,
      // so this is the only way to prove the doors close together.
      resolveEntitlements: async (_db, team, limits) =>
        team.id === narrowedTeamId ? { ...limits, evidence: false } : limits,
    },
  });
  beta = await startServer(loadEnv({ ...base, pgliteDir: betaDir, betaUnmetered: true }));

  const db = metered.db;
  member = await person(db, 'ev-member');
  outsider = await person(db, 'ev-outsider');
  const plans: Array<[string, string]> = [
    ['ev-free', 'free'],
    ['ev-solo', 'solo'],
    ['ev-team', 'team'],
    ['ev-enterprise', 'enterprise'],
    ['ev-granted', 'free'],
    ['ev-grant-ended', 'free'],
    ['ev-downgraded', 'team'],
    ['narrowed', 'team'],
  ];
  for (const [slug, plan] of plans) {
    owners[slug] = await person(db, `${slug}-owner`);
    spaces[slug] = await workspace(db, owners[slug]!, slug, plan);
    // One member beside the owner everywhere. Free and Solo hold one human, so
    // on those this models a workspace that was downgraded with two people in it.
    await db.insert(memberships).values({ teamId: spaces[slug]!.id, userId: member.id, role: 'member' });
  }
  narrowedTeamId = spaces.narrowed!.id;
  await setPlanGrant(db, {
    teamId: spaces['ev-granted']!.id,
    plan: 'team',
    endsAt: null,
    note: null,
    actorId: null,
    actorLabel: 'test',
    route: 'test',
  });
  await db.insert(planGrants).values({
    teamId: spaces['ev-grant-ended']!.id,
    plan: 'team',
    endsAt: new Date(Date.now() - 86_400_000),
    grantedByLabel: 'test',
  });
}, 180_000);

afterAll(async () => {
  await metered?.close();
  await beta?.close();
  rmSync(meteredDir, { recursive: true, force: true });
  rmSync(betaDir, { recursive: true, force: true });
});

describe('every plan reads its own runs, and every door agrees', () => {
  for (const slug of ['ev-free', 'ev-solo', 'ev-team', 'ev-enterprise', 'ev-granted', 'ev-grant-ended', 'ev-downgraded']) {
    it(`${slug}: owner and member read it on the page, in Markdown, on the map and over MCP`, async () => {
      const ws = spaces[slug]!;
      for (const who of [owners[slug]!, member]) {
        const seen = await doors(metered, who, ws);
        expect(seen.runPage, `${slug} page for ${who.username}`).toBe(200);
        expect(seen.runHtml).toContain('Observed by the provider');
        expect(seen.markdown).toBe(200);
        expect(seen.markdownText).toContain('### Observed by the provider');
        expect(seen.map).toContain('Merge readiness');
        expect(seen.map).not.toContain(EVIDENCE_NOT_INCLUDED);
        expect(seen.mcp.isError, seen.mcp.text).toBe(false);
        expect(JSON.parse(seen.mcp.text).run.id).toBe(ws.runId);
      }
    });
  }

  it('refuses somebody outside the workspace at every door, whatever the plan', async () => {
    for (const slug of ['ev-free', 'ev-team', 'ev-granted']) {
      const seen = await doors(metered, outsider, spaces[slug]!);
      expect(seen.runPage).toBe(404);
      expect(seen.markdown).toBe(404);
      expect(seen.map).not.toContain('Merge readiness');
      expect(seen.mcp.isError).toBe(true);
      // One sentence for a run that does not exist and one in a workspace this
      // connection cannot read (the T2 batch's RUN_NOT_VISIBLE in mcp/fleet.ts).
      expect(seen.mcp.text).not.toContain('not in one of your teams');
      expect(seen.mcp.text).toContain('No run with this id is visible to this connection');
    }
  });

  it('closes every door together when the composition narrows evidence', async () => {
    const ws = spaces.narrowed!;
    for (const who of [owners.narrowed!, member]) {
      const seen = await doors(metered, who, ws);
      expect(seen.runPage).toBe(402);
      expect(seen.runHtml).toContain(EVIDENCE_NOT_INCLUDED);
      expect(seen.markdown).toBe(402);
      expect(seen.markdownText).toBe(EVIDENCE_NOT_INCLUDED);
      expect(seen.map).toContain(EVIDENCE_NOT_INCLUDED);
      expect(seen.map).not.toContain('Open the run page: evidence that stays');
      expect(seen.mcp.isError).toBe(true);
      // The workspace's own plan row carries evidence, so the composition
      // narrowed it, and every door says the same sentence without naming a
      // plan to buy (`requireFeature`'s `narrowed`, from the T2 batch).
      expect(seen.mcp.text).toContain(EVIDENCE_NOT_INCLUDED);
      expect(seen.mcp.text).not.toContain('plan up');
      expect(seen.runHtml).not.toContain('plan up');
      expect(seen.markdownText).not.toContain('plan up');
    }
    // Somebody outside it still learns nothing, not even that evidence is narrowed.
    expect((await doors(metered, outsider, ws)).runPage).toBe(404);
  });
});

describe('the boundary in front of evidence does not move', () => {
  it('a downgrade removes nothing and opens nothing', async () => {
    const ws = spaces['ev-downgraded']!;
    const counts = async () => ({
      runs: (await metered.db.select({ n: count() }).from(agentRuns).where(eq(agentRuns.teamId, ws.id)))[0]!.n,
      checkpoints: (await metered.db.select({ n: count() }).from(runCheckpoints).where(eq(runCheckpoints.teamId, ws.id)))[0]!.n,
      receipts: (await metered.db.select({ n: count() }).from(policyReceipts).where(eq(policyReceipts.runId, ws.runId)))[0]!.n,
    });
    const before = await counts();
    await metered.db.update(teams).set({ plan: 'free' }).where(eq(teams.id, ws.id));
    for (const who of [owners['ev-downgraded']!, member]) {
      const seen = await doors(metered, who, ws);
      expect(seen.runPage).toBe(200);
      expect(seen.mcp.isError, seen.mcp.text).toBe(false);
    }
    expect((await doors(metered, outsider, ws)).runPage).toBe(404);
    expect(await counts()).toEqual(before);
  });

  it('a removed member loses every door at once', async () => {
    const ws = spaces['ev-solo']!;
    await metered.db
      .delete(memberships)
      .where(and(eq(memberships.teamId, ws.id), eq(memberships.userId, member.id)));
    const seen = await doors(metered, member, ws);
    expect(seen.runPage).toBe(404);
    expect(seen.markdown).toBe(404);
    expect(seen.mcp.isError).toBe(true);
    // The owner keeps reading it.
    expect((await doors(metered, owners['ev-solo']!, ws)).runPage).toBe(200);
  });

  it("a project-scoped credential reads its own project's run and no other", async () => {
    const ws = spaces['ev-team']!;
    const owner = owners['ev-team']!;
    const [other] = await metered.db
      .insert(projects)
      .values({ teamId: ws.id, name: 'web', slug: 'web', repositoryIdentity: 'github.com/ev-team/web', createdBy: owner.id })
      .returning();
    const otherRun = await seedRun(metered.db, owner, ws.id, other!.id, 'github.com/ev-team/web');
    const issued = await fetch(`${metered.url}/app/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: owner.cookie },
      body: new URLSearchParams({
        name: 'api-agent',
        device: 'laptop',
        access: `project:${ws.projectId}`,
        client: 'codex',
        role: 'generalist',
      }),
      redirect: 'manual',
    });
    expect(issued.status).toBe(200);
    const code = /stma_enroll_[0-9a-f]{40}/.exec(await issued.text())?.[0];
    expect(code).toBeTruthy();
    const redeemed = await fetch(`${metered.url}/api/agent-enrollments/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(redeemed.status).toBe(200);
    const scoped = ((await redeemed.json()) as { token: string }).token;
    expect((await call(metered, 'whoami', {}, scoped)).isError).toBe(false);

    const own = await call(metered, 'get_evidence', { run_id: ws.runId }, scoped);
    expect(own.isError, own.text).toBe(false);
    const elsewhere = await call(metered, 'get_evidence', { run_id: otherRun }, scoped);
    expect(elsewhere.isError).toBe(true);
    expect(elsewhere.text).not.toContain('github.com/ev-team/web');
  });
});

describe('the beta', () => {
  it('reads a free workspace on every door, as it always has', async () => {
    const owner = await person(beta.db, 'beta-owner');
    const ws = await workspace(beta.db, owner, 'beta-free', 'free');
    const seen = await doors(beta, owner, ws);
    expect(seen.runPage).toBe(200);
    expect(seen.markdown).toBe(200);
    expect(seen.map).toContain('Merge readiness');
    expect(seen.mcp.isError, seen.mcp.text).toBe(false);
  });
});
