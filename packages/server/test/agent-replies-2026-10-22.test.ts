/**
 * The agent-facing sentences several branches deferred to one change that owes
 * an agent-lab round (2026-10-22), because `mcp/**`, `routes/mcp.ts` and
 * `domain/collaboration.ts` are on the T2 surface.
 *
 * - `get_evidence` reads membership before the run, and a run that does not
 *   exist and a run in somebody else's workspace get one sentence.
 * - A feature the workspace's own plan row carries, narrowed on the way by a
 *   composition resolver, is refused without naming a plan: "included from the
 *   X plan up" is untrue for a workspace that may already be on a bigger one.
 * - `get_policy` and `start_run` say where a published content rule is
 *   enforced. An agent in the 2026-10-21 lab believed nothing stops one and
 *   refused the edit its human asked it to try, so the guard never ran.
 * - `launch_check` names the page a launch now comes from.
 *
 * The introductions' checkpoint sentence is held in `claude-connector.test.ts`
 * beside the rest of both paragraphs.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatePat } from '../src/auth/pat';
import type { Db } from '../src/db';
import { agentInstallations, agentRuns, memberships, projects, teams, tokens, users, webSessions } from '../src/db/schema';
import { loadEnv } from '../src/env';
import { randomHex } from '../src/lib/crypto';
import { EVIDENCE_NOT_INCLUDED } from '../src/lib/entitlements';
import { startServer, type StartedServer } from '../src/server';

const FONT_RULE = 'content: "Comic Sans" in public/** — not in the design system';

interface Person {
  id: string;
  cookie: string;
  token: string;
}

async function person(db: Db, username: string): Promise<Person> {
  const [user] = await db.insert(users).values({ username }).returning();
  const sid = randomHex(32);
  await db.insert(webSessions).values({ id: sid, userId: user!.id, expiresAt: new Date(Date.now() + 86_400_000) });
  const pat = generatePat();
  await db.insert(tokens).values({ userId: user!.id, tokenHash: pat.hash, prefix: pat.prefix, name: `${username}-machine` });
  return { id: user!.id, cookie: `sid=${sid}`, token: pat.token };
}

async function workspace(db: Db, owner: Person, slug: string, plan = 'free') {
  const [team] = await db.insert(teams).values({ name: slug, slug, createdBy: owner.id, plan }).returning();
  await db.insert(memberships).values({ teamId: team!.id, userId: owner.id, role: 'owner' });
  const repositoryIdentity = `github.com/${slug}/parcel-desk`;
  const [project] = await db
    .insert(projects)
    .values({ teamId: team!.id, name: 'parcel-desk', slug: 'parcel-desk', repositoryIdentity, createdBy: owner.id })
    .returning();
  // Inserted rather than started: this is about reading what a run recorded,
  // whatever plan made it, and start_run is refused on a metered Free plan.
  const [installation] = await db
    .insert(agentInstallations)
    .values({ userId: owner.id, name: `agent-${randomHex(3)}`, deviceLabel: 'laptop', deviceFingerprint: randomUUID() })
    .returning();
  const [run] = await db
    .insert(agentRuns)
    .values({ installationId: installation!.id, teamId: team!.id, projectId: project!.id, status: 'completed', endedAt: new Date() })
    .returning();
  return { id: team!.id, slug, repositoryIdentity, runId: run!.id };
}

let rpcId = 1;
async function call(srv: StartedServer, token: string, tool: string, args: Record<string, unknown>) {
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

const form = (srv: StartedServer, who: Person, pathname: string, body: Record<string, string>) =>
  fetch(srv.url + pathname, {
    method: 'POST',
    headers: { cookie: who.cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });

const base = { port: 0, host: '127.0.0.1', nodeEnv: 'test' as const, devMode: true, databaseUrl: undefined };

describe('a self-hosted server', () => {
  let srv: StartedServer;
  let dir: string;
  let owner: Person;
  let outsider: Person;
  let mine: Awaited<ReturnType<typeof workspace>>;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'stma-agent-replies-'));
    srv = await startServer(loadEnv({ ...base, pgliteDir: dir }));
    owner = await person(srv.db, 'replies-owner');
    outsider = await person(srv.db, 'replies-outsider');
    mine = await workspace(srv.db, owner, 'replies-lab');
    await workspace(srv.db, outsider, 'replies-elsewhere');
  });

  afterAll(async () => {
    await srv?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers a run nobody has and a run in another workspace with one sentence', async () => {
    const theirs = await call(srv, outsider.token, 'get_evidence', { run_id: mine.runId });
    const nobodys = await call(srv, outsider.token, 'get_evidence', { run_id: randomUUID() });
    expect(theirs.isError).toBe(true);
    expect(nobodys.isError).toBe(true);
    expect(theirs.text).toBe(nobodys.text);
    expect(theirs.text).toContain('No run with this id is visible to this connection');
    expect(theirs.text).not.toMatch(/Unknown run|not in one of your teams/);
    // Nothing about the run reaches the caller.
    expect(theirs.text).not.toContain(mine.slug);

    const own = await call(srv, owner.token, 'get_evidence', { run_id: mine.runId });
    expect(own.isError, own.text).toBe(false);
    expect(JSON.parse(own.text).run.id).toBe(mine.runId);
  });

  it('says where a published content rule is enforced, and says nothing when there is none', async () => {
    const before = JSON.parse((await call(srv, owner.token, 'get_policy', { team: mine.slug })).text);
    expect(before.contentRules).toBeUndefined();

    const published = await form(srv, owner, `/app/teams/${mine.slug}/policy`, {
      scope: 'team',
      deny: `read secret values\n${FONT_RULE}`,
    });
    expect(published.status).toBe(302);

    const policy = await call(srv, owner.token, 'get_policy', { team: mine.slug });
    expect(policy.isError, policy.text).toBe(false);
    const read = JSON.parse(policy.text);
    expect(read.document.permissions.deny).toContain(FONT_RULE);
    expect(read.contentRules).toContain('In a checkout where STMA hooks run, the file-tool guard stops an edit');
    // Both halves, because outside the hooks the rule is only a rule.
    expect(read.contentRules).toContain('A shell command, or an agent without the hooks, is not stopped');

    const started = await call(srv, owner.token, 'start_run', {
      request_id: randomUUID(),
      team: mine.slug,
      project: 'parcel-desk',
      repository_identity: mine.repositoryIdentity,
      task: 'PD-29 Headings',
    });
    expect(started.isError, started.text).toBe(false);
    expect(JSON.parse(started.text).policy.contentRules).toBe(read.contentRules);
  });

  it('names the Agent connections page when a launch id is not visible', async () => {
    const refused = await call(srv, owner.token, 'launch_check', { launch_id: randomUUID(), action: 'status' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Test section of a workspace's Agent connections page");
    expect(refused.text).not.toContain('Connect & test');
  });
});

describe('a hosted server whose composition narrows a workspace', () => {
  let srv: StartedServer;
  let dir: string;
  let narrowedId = '';
  let owner: Person;
  let narrowed: Awaited<ReturnType<typeof workspace>>;
  let free: Awaited<ReturnType<typeof workspace>>;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'stma-agent-replies-hosted-'));
    srv = await startServer(loadEnv({ ...base, pgliteDir: dir, hosted: true }), {
      lifecycle: {
        // The way an EE resolver narrows an evaluation: below the workspace's own row.
        resolveEntitlements: async (_db, team, limits) =>
          team.id === narrowedId ? { ...limits, evidence: false, governance: false } : limits,
      },
    });
    owner = await person(srv.db, 'narrow-owner');
    narrowed = await workspace(srv.db, owner, 'narrow-team', 'team');
    narrowedId = narrowed.id;
    free = await workspace(srv.db, owner, 'narrow-free', 'free');
  });

  afterAll(async () => {
    await srv?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses evidence with the shared sentence and names no plan', async () => {
    const refused = await call(srv, owner.token, 'get_evidence', { run_id: narrowed.runId });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(EVIDENCE_NOT_INCLUDED);
    expect(refused.text).not.toMatch(/plan up|team plan that/);
  });

  it('names no plan for any feature the workspace row already carries', async () => {
    const refused = await call(srv, owner.token, 'get_policy', { team: narrowed.slug });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('Policy is not included in the plan this workspace is on right now.');
    expect(refused.text).not.toMatch(/plan up/);
  });

  it('still names the cheapest plan with the feature when the workspace row lacks it', async () => {
    const refused = await call(srv, owner.token, 'get_policy', { team: free.slug });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('It is included from the solo plan up.');
  });
});
