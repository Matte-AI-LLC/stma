import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentInstallations,
  projects,
  teams,
  tokens,
  users,
  workAcceptances,
  workBlockers,
  workDeliveries,
  workDependencies,
  workEvents,
  workItems,
  workLinks,
} from '../src/db/schema';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';
import { createWork, updateWork } from '../src/domain/work';
import { NOT_BLOCKED, blockedWorkSql, blockingState, dependencySnapshot } from '../src/domain/workGraph';
import { getWork, listWork } from '../src/domain/workRead';
import { agentPrincipal, humanPrincipal, type WorkPrincipal, type WorkResult } from '../src/domain/workTypes';
import { isTokenScope, type AgentGrant } from '../src/lib/grants';

/**
 * Dependencies and blockers on Native Work, through the one command envelope:
 * who may add an edge, how a cycle is refused (concurrently too), when an
 * upstream meets a dependency and when it stops meeting it, how an open blocker
 * is deduplicated and closed, and the one blocker STMA derives on read without
 * storing. Every reading is also checked against `blockedWorkSql`, the list
 * filter's spelling of the same rule.
 *
 * Accepting is a later step's decision path (W04). Until it lands, the rows a
 * decision writes (a delivery, an acceptance carrying the dependency snapshot,
 * the work's state and pointers) are written here directly, where the decision
 * would write them; everything else goes through the product's own doors.
 */

let srv: StartedServer;
let dataDir: string;
let teamId = '';
let alphaId = '';
let betaId = '';
let leadUserId = '';
let leadCookie: Record<string, string> = {};
let lead: WorkPrincipal;
let bob: WorkPrincipal;
let alphaAgent: WorkPrincipal;
let otherAgent: WorkPrincipal;
let otherToken = '';

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

/**
 * fetch, retried once on a connection-level failure. The server and this file
 * share one event loop, and a long stretch of direct database work can leave
 * fetch holding a keep-alive socket the server has just closed, surfaced as
 * ECONNRESET: a property of the runner, not of the route (`governance.test.ts`
 * retries its form posts the same way).
 */
async function fetchRetrying(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (attempt > 0) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

const form = (url: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
  fetchRetrying(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });

let rpcId = 1;
async function call(tool: string, args: Record<string, unknown>, tok: string) {
  const res = await fetchRetrying(`${srv.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${tok}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const json = (await res.json()) as {
    result?: { content?: { text: string }[]; isError?: boolean };
    error?: { message?: string };
  };
  const text = json.result?.content?.[0]?.text ?? json.error?.message ?? '';
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* prose answer */
  }
  return { text, data, isError: json.result?.isError === true || json.error !== undefined };
}

async function connectAgent(cookie: Record<string, string>, name: string, device: string, access: string) {
  const page = await form(`${srv.url}/app/tokens`, { name, device, access, client: 'codex', role: 'generalist' }, cookie);
  const html = await page.text();
  const code = /(?:&quot;|")STMA_ENROLLMENT_CODE(?:&quot;|")\s*:\s*(?:&quot;|")([^"&<]+)/.exec(html)?.[1];
  expect(code, `enrollment code for ${name}`).toMatch(/^stma_enroll_/);
  const redeemed = (await (
    await fetchRetrying(`${srv.url}/api/agent-enrollments/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
  ).json()) as { token: string };
  const who = await call('whoami', {}, redeemed.token);
  expect(who.isError, who.text).toBe(false);
  return redeemed.token;
}

/** The grant `mcpAuth` would attach to this token, read from the same rows. */
async function principalForToken(token: string): Promise<WorkPrincipal> {
  const hash = createHash('sha256').update(token).digest('hex');
  const [row] = await srv.db
    .select({
      token: tokens,
      teamSlug: teams.slug,
      teamName: teams.name,
      projectSlug: projects.slug,
      projectName: projects.name,
      installationId: agentInstallations.id,
      installationName: agentInstallations.name,
      installationDeviceLabel: agentInstallations.deviceLabel,
      installationCompanionOf: agentInstallations.companionOf,
      installationClientType: agentInstallations.clientType,
    })
    .from(tokens)
    .leftJoin(teams, eq(tokens.teamId, teams.id))
    .leftJoin(projects, eq(tokens.projectId, projects.id))
    .leftJoin(agentInstallations, eq(agentInstallations.tokenId, tokens.id))
    .where(eq(tokens.tokenHash, hash))
    .limit(1);
  if (!row || !isTokenScope(row.token.scope)) throw new Error('no such credential');
  const grant: AgentGrant = {
    tokenId: row.token.id,
    scope: row.token.scope,
    teamId: row.token.teamId,
    teamSlug: row.teamSlug,
    teamName: row.teamName,
    projectId: row.token.projectId,
    projectSlug: row.projectSlug,
    projectName: row.projectName,
    installationId: row.installationId,
    installationName: row.installationName,
    deviceLabel: row.installationDeviceLabel,
    companionInstallationId: row.installationCompanionOf ?? null,
    clientType: row.installationClientType ?? null,
  };
  return agentPrincipal(row.token.userId, grant);
}

const userId = async (username: string) =>
  (await srv.db.select({ id: users.id }).from(users).where(eq(users.username, username)))[0]!.id;

async function join(invite: string, username: string) {
  const person = jar();
  person.store(await form(`${srv.url}/auth/dev`, { username }));
  await form(`${srv.url}/join/${invite}`, {}, person.header());
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-work-graph-'));
  srv = await startServer(
    loadEnv({ port: 0, host: '127.0.0.1', nodeEnv: 'test', devMode: true, databaseUrl: undefined, pgliteDir: dataDir }),
  );
  const leadJar = jar();
  leadJar.store(await form(`${srv.url}/auth/dev`, { username: 'lead' }));
  leadCookie = leadJar.header();
  await form(`${srv.url}/app/teams`, { name: 'Work Graph' }, leadCookie);
  const [team] = await srv.db.select().from(teams).where(eq(teams.slug, 'work-graph'));
  teamId = team!.id;
  await form(`${srv.url}/app/projects`, { team: 'work-graph', project: 'alpha' }, leadCookie);
  await form(`${srv.url}/app/projects`, { team: 'work-graph', project: 'beta' }, leadCookie);
  const rows = await srv.db.select().from(projects).where(eq(projects.teamId, teamId));
  alphaId = rows.find((p) => p.name === 'alpha')!.id;
  betaId = rows.find((p) => p.name === 'beta')!.id;

  await form(`${srv.url}/app/teams/work-graph/invites`, {}, leadCookie);
  const people = await (await fetchRetrying(`${srv.url}/app/teams/work-graph?tab=people`, { headers: leadCookie })).text();
  const invite = /\/join\/([A-Za-z0-9_-]+)/.exec(people)?.[1] ?? '';
  expect(invite, 'invite code').toBeTruthy();
  await join(invite, 'bob');
  await join(invite, 'dana');

  leadUserId = await userId('lead');
  lead = humanPrincipal(leadUserId);
  bob = humanPrincipal(await userId('bob'));
  alphaAgent = await principalForToken(await connectAgent(leadCookie, 'codex-alpha', 'mac', `project:${alphaId}`));
  otherToken = await connectAgent(leadCookie, 'codex-other', 'win', `project:${alphaId}`);
  otherAgent = await principalForToken(otherToken);
});

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const ok = <T>(result: WorkResult<T>): T => {
  if (result && typeof result === 'object' && 'error' in result) {
    throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  }
  return result as T;
};
const refusal = (result: unknown) => {
  expect(result && typeof result === 'object' && 'error' in result, JSON.stringify(result)).toBe(true);
  return (
    result as {
      error: { code: string; message: string; fields?: string[]; next_action?: string; used?: number; limit?: number };
    }
  ).error;
};

/** A complete contract owned by the lead, so it can move to ready; bob accepts unless told otherwise. */
const make = async (title: string, extra: Record<string, unknown> = {}, who: WorkPrincipal = lead) =>
  ok(
    await createWork(srv.db, who, {
      request_id: randomUUID(),
      project: 'alpha',
      contract: { title, goal: `Do ${title}.`, artifact_kind: 'code' },
      criteria: [{ text: `${title} works.` }],
      acceptor: 'bob',
      ...extra,
    }),
  );

const versionOf = async (workId: string) =>
  (await srv.db.select({ version: workItems.version }).from(workItems).where(eq(workItems.id, workId)))[0]!.version.toString();

/** One update at the work's current version. */
async function command(who: WorkPrincipal, workId: string, operation: string, payload: Record<string, unknown>) {
  return updateWork(srv.db, who, {
    request_id: randomUUID(),
    work_id: workId,
    expected_version: await versionOf(workId),
    operation,
    payload,
  } as never);
}

const graphOf = async (workId: string) => (await blockingState(srv.db, [workId])).get(workId) ?? NOT_BLOCKED;

/**
 * The rows a recorded accept decision leaves behind (W04 writes them through
 * its decision path): a delivery, an acceptance that carries the dependency
 * snapshot at that moment and the work's current epoch, and the work pointing
 * at both in `accepted`.
 */
async function acceptDirectly(workId: string): Promise<string> {
  const [work] = await srv.db.select().from(workItems).where(eq(workItems.id, workId));
  const [{ next }] = (await srv.db
    .select({ next: sql<number>`coalesce(max(${workDeliveries.sequence}), 0) + 1` })
    .from(workDeliveries)
    .where(eq(workDeliveries.workId, workId))) as [{ next: number }];
  const [delivery] = await srv.db
    .insert(workDeliveries)
    .values({
      workId,
      specRevision: work!.specRevision,
      sequence: Number(next),
      artifacts: [],
      artifactSetHash: 'test-only',
      submittedByKind: 'human',
      submittedById: leadUserId,
      submittedByUserId: leadUserId,
    })
    .returning();
  const [acceptance] = await srv.db
    .insert(workAcceptances)
    .values({
      workId,
      specRevision: work!.specRevision,
      deliveryId: delivery!.id,
      evidenceManifest: { dependencies: await dependencySnapshot(srv.db, workId) },
      evidenceManifestHash: 'test-only',
      evidenceEpoch: work!.evidenceEpoch,
      decision: 'accept',
      actorUserId: leadUserId,
      actorScopeSnapshot: { test: true },
    })
    .returning();
  await srv.db
    .update(workItems)
    .set({ state: 'accepted', currentDeliveryId: delivery!.id, currentAcceptanceId: acceptance!.id })
    .where(eq(workItems.id, workId));
  return acceptance!.id;
}

/**
 * Every work of a project read both ways: `blockingState(...).blocked` and the
 * list filter's predicate must say the same thing about every row, and the
 * blocked tab must count exactly those rows.
 */
async function expectInStep(projectId = alphaId) {
  const rows = await srv.db
    .select({
      id: workItems.id,
      archived: workItems.archivedAt,
      blocked: sql<boolean>`${blockedWorkSql(workItems.id)}`,
    })
    .from(workItems)
    .where(eq(workItems.projectId, projectId));
  const state = await blockingState(srv.db, rows.map((row) => row.id));
  for (const row of rows) {
    expect(row.blocked, `blockedWorkSql for ${row.id}`).toBe((state.get(row.id) ?? NOT_BLOCKED).blocked);
  }
  const listed = ok(await listWork(srv.db, lead, projectId, { view: 'blocked' }, { limit: 50 })) as {
    items: { id: string; flags: { blocked: boolean } }[];
    counts: Record<string, number>;
  };
  const expected = rows.filter((row) => row.blocked && !row.archived).map((row) => row.id).sort();
  expect(listed.counts.blocked).toBe(expected.length);
  if (expected.length <= 50) expect(listed.items.map((item) => item.id).sort()).toEqual(expected);
  for (const item of listed.items) expect(item.flags.blocked).toBe(true);
}

describe('adding and removing dependencies', () => {
  it('refuses a self edge by id and by key', async () => {
    const work = await make('Self');
    const byId = refusal(await command(lead, work.work_id, 'add_dependency', { depends_on: work.work_id }));
    expect(byId.code).toBe('INVALID_INPUT');
    expect(byId.fields).toEqual(['payload.depends_on']);
    const byKey = refusal(await command(lead, work.work_id, 'add_dependency', { depends_on: work.key.toLowerCase() }));
    expect(byKey.code).toBe('INVALID_INPUT');
    expect(await srv.db.select().from(workDependencies).where(eq(workDependencies.workId, work.work_id))).toHaveLength(0);
  });

  it('answers NOT_FOUND to a work of another project, an unknown key and a spelling that is neither', async () => {
    const here = await make('Here');
    const there = ok(
      await createWork(srv.db, lead, {
        request_id: randomUUID(),
        project: 'beta',
        contract: { title: 'There', goal: 'In beta.', artifact_kind: 'code' },
        criteria: [{ text: 'It works.' }],
        acceptor: 'bob',
      }),
    );
    for (const depends_on of [there.work_id, there.work_id.toUpperCase(), 'WORK-9999', 'not a work', randomUUID()]) {
      const refused = refusal(await command(lead, here.work_id, 'add_dependency', { depends_on }));
      expect(refused.code, depends_on).toBe('NOT_FOUND');
      expect(refused.fields).toEqual(['payload.depends_on']);
    }
    // A key always means this project's work: beta's own WORK-1 is not alpha's.
    const alphaFirst = (await srv.db.select().from(workItems).where(and(eq(workItems.projectId, alphaId), eq(workItems.number, 1n))))[0]!;
    const byKey = ok(await command(lead, here.work_id, 'add_dependency', { depends_on: 'WORK-1' }));
    expect((byKey as any).dependency.work_id).toBe(alphaFirst.id);
    expect(refusal(await command(lead, here.work_id, 'remove_dependency', { depends_on: there.work_id })).code).toBe('NOT_FOUND');
  });

  it('defaults the required revision to the upstream one, refuses a higher one and a duplicate, and replays', async () => {
    const upstream = await make('Upstream');
    ok(await command(lead, upstream.work_id, 'patch', { contract: { goal: 'A sharper goal.' } }));
    const downstream = await make('Downstream');

    const tooHigh = refusal(
      await command(lead, downstream.work_id, 'add_dependency', { depends_on: upstream.key, required_spec_revision: 3 }),
    );
    expect(tooHigh.code).toBe('INVALID_INPUT');
    expect(tooHigh.fields).toEqual(['payload.required_spec_revision']);

    const request = {
      request_id: randomUUID(),
      work_id: downstream.work_id,
      expected_version: await versionOf(downstream.work_id),
      operation: 'add_dependency',
      payload: { depends_on: upstream.work_id },
    } as never;
    const added = ok(await updateWork(srv.db, lead, request));
    expect((added as any).dependency).toEqual({
      work_id: upstream.work_id,
      key: upstream.key,
      required_spec_revision: 2,
      met: false,
      why: 'not_accepted',
    });
    const replay = ok(await updateWork(srv.db, lead, request));
    expect(replay).toMatchObject({ replayed: true, version: added.version, result_ref: upstream.work_id });
    const edges = await srv.db.select().from(workDependencies).where(eq(workDependencies.workId, downstream.work_id));
    expect(edges).toEqual([expect.objectContaining({ dependsOnId: upstream.work_id, requiredSpecRevision: 2, createdByKind: 'human' })]);

    const duplicate = refusal(await command(lead, downstream.work_id, 'add_dependency', { depends_on: upstream.key }));
    expect(duplicate.code).toBe('INVALID_INPUT');
    expect(duplicate.next_action).toBeTruthy();

    const [event] = await srv.db
      .select()
      .from(workEvents)
      .where(and(eq(workEvents.workId, downstream.work_id), eq(workEvents.type, 'work_dependency_added')));
    expect(event!.filterBefore).toMatchObject({ blocked: false });
    expect(event!.filterAfter).toMatchObject({ blocked: true });
    expect(event!.payload).toMatchObject({ depends_on: upstream.work_id, depends_on_key: upstream.key, required_spec_revision: 2 });

    ok(await command(lead, downstream.work_id, 'remove_dependency', { depends_on: upstream.key, reason: 'Not needed.' }));
    expect(await srv.db.select().from(workDependencies).where(eq(workDependencies.workId, downstream.work_id))).toHaveLength(0);
    const again = refusal(await command(lead, downstream.work_id, 'remove_dependency', { depends_on: upstream.key }));
    expect(again.code).toBe('NOT_FOUND');
    expect((await graphOf(downstream.work_id)).blocked).toBe(false);
    await expectInStep();
  });

  it('refuses a cycle and names its path by keys', async () => {
    const a = await make('Cycle A');
    const b = await make('Cycle B');
    const c = await make('Cycle C');
    ok(await command(lead, a.work_id, 'add_dependency', { depends_on: b.key }));
    ok(await command(lead, b.work_id, 'add_dependency', { depends_on: c.key }));
    const refused = refusal(await command(lead, c.work_id, 'add_dependency', { depends_on: a.key }));
    expect(refused.code).toBe('INVALID_INPUT');
    expect(refused.fields).toEqual(['payload.depends_on']);
    expect(refused.message).toContain(`${a.key} -> ${b.key} -> ${c.key}`);
    expect(refused.message).toContain('cycle');
    expect(await srv.db.select().from(workDependencies).where(eq(workDependencies.workId, c.work_id))).toHaveLength(0);
  });

  it('lets exactly one of two concurrent opposite edges in', async () => {
    const p = await make('Race P');
    const q = await make('Race Q');
    const [pv, qv] = [await versionOf(p.work_id), await versionOf(q.work_id)];
    const add = (from: string, version: string, to: string) =>
      updateWork(srv.db, lead, {
        request_id: randomUUID(),
        work_id: from,
        expected_version: version,
        operation: 'add_dependency',
        payload: { depends_on: to },
      } as never);
    const results = await Promise.all([add(p.work_id, pv, q.work_id), add(q.work_id, qv, p.work_id)]);
    const won = results.filter((result) => !('error' in (result as object)));
    const lost = results.filter((result) => 'error' in (result as object));
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(refusal(lost[0]).code).toBe('INVALID_INPUT');
    expect(refusal(lost[0]).message).toContain('cycle');
    const edges = await srv.db
      .select()
      .from(workDependencies)
      .where(sql`${workDependencies.workId} in (${p.work_id}, ${q.work_id})`);
    expect(edges).toHaveLength(1);
  });

  it('keeps dependencies to the people with contract authority', async () => {
    // The lead accepts this one, so bob is a member with no authority over it.
    const work = await make('Authority', { acceptor: 'lead' });
    const other = await make('Authority upstream');
    const asBob = refusal(await command(bob, work.work_id, 'add_dependency', { depends_on: other.key }));
    expect(asBob.code).toBe('FORBIDDEN');
    const own = ok(
      await createWork(srv.db, alphaAgent, {
        request_id: randomUUID(),
        project: 'alpha',
        contract: { title: 'Agent draft with a dependency', goal: 'Found while working.' },
      }),
    );
    const asAgent = refusal(await command(alphaAgent, own.work_id, 'add_dependency', { depends_on: other.key }));
    expect(asAgent.code).toBe('FORBIDDEN');
    expect(asAgent.next_action).toContain('blocker');
    // Authority is checked before the reference, so an unknown key tells an outsider nothing.
    expect(refusal(await command(bob, work.work_id, 'add_dependency', { depends_on: 'WORK-9999' })).code).toBe('FORBIDDEN');
  });

  it('counts dependencies against the limit', async () => {
    const work = await make('Many upstreams');
    const upstreams = [];
    for (let i = 0; i < 51; i += 1) upstreams.push(await make(`Limit upstream ${i}`));
    // Fifty edges written directly: the limit is what is under test, not fifty commands.
    await srv.db.insert(workDependencies).values(
      upstreams.slice(0, 50).map((upstream) => ({
        workId: work.work_id,
        dependsOnId: upstream.work_id,
        requiredSpecRevision: 1,
        createdByKind: 'human',
        createdById: leadUserId,
      })),
    );
    const refused = refusal(await command(lead, work.work_id, 'add_dependency', { depends_on: upstreams[50]!.key }));
    expect(refused).toMatchObject({ code: 'LIMIT_EXCEEDED', used: 50, limit: 50 });
    await srv.db.delete(workDependencies).where(eq(workDependencies.workId, work.work_id));
  });
});

describe('when a dependency is met', () => {
  it('reads an unmet dependency as blocked until its upstream is accepted, and again once it reopens', async () => {
    const upstream = await make('Met upstream');
    const work = await make('Met downstream');
    ok(await command(lead, work.work_id, 'add_dependency', { depends_on: upstream.key }));
    let graph = await graphOf(work.work_id);
    expect(graph).toMatchObject({ blocked: true, unmetDependencies: 1, openBlockers: 0 });
    expect(graph.unmet).toEqual([
      { work_id: upstream.work_id, key: upstream.key, state: 'draft', spec_revision: 1, required_spec_revision: 1, why: 'not_accepted' },
    ]);
    expect(((ok(await getWork(srv.db, lead, work.work_id)) as any).flags.blocked)).toBe(true);
    await expectInStep();

    await acceptDirectly(upstream.work_id);
    graph = await graphOf(work.work_id);
    expect(graph).toMatchObject({ blocked: false, unmetDependencies: 0 });
    await expectInStep();

    ok(await command(lead, upstream.work_id, 'reopen', { reason: 'A bug turned up.' }));
    graph = await graphOf(work.work_id);
    expect(graph.blocked).toBe(true);
    expect(graph.unmet[0]).toMatchObject({ key: upstream.key, state: 'in_progress', why: 'reopened_since' });
    await expectInStep();

    // Accepted again, and then its evidence moves: the acceptance no longer holds.
    await acceptDirectly(upstream.work_id);
    expect((await graphOf(work.work_id)).blocked).toBe(false);
    await srv.db
      .update(workItems)
      .set({ evidenceEpoch: sql`${workItems.evidenceEpoch} + 1` })
      .where(eq(workItems.id, upstream.work_id));
    graph = await graphOf(work.work_id);
    expect(graph.blocked).toBe(true);
    expect(graph.unmet[0]).toMatchObject({ key: upstream.key, state: 'accepted', why: 'acceptance_stale' });
    await expectInStep();
  });

  it('shows dependency_changed on an accepted downstream when its upstream reopens, and keeps its acceptance', async () => {
    const upstream = await make('Changed upstream');
    const work = await make('Changed middle');
    const tail = await make('Changed tail');
    await acceptDirectly(upstream.work_id);
    ok(await command(lead, work.work_id, 'add_dependency', { depends_on: upstream.key }));
    const snapshot = await dependencySnapshot(srv.db, work.work_id);
    const [upstreamRow] = await srv.db.select().from(workItems).where(eq(workItems.id, upstream.work_id));
    expect(snapshot).toEqual([
      {
        work_id: upstream.work_id,
        key: upstream.key,
        acceptance_id: upstreamRow!.currentAcceptanceId,
        spec_revision: 1,
        required_spec_revision: 1,
      },
    ]);
    const acceptanceId = await acceptDirectly(work.work_id);
    ok(await command(lead, tail.work_id, 'add_dependency', { depends_on: work.key }));
    expect(await graphOf(work.work_id)).toMatchObject({ blocked: false, dependencyChanged: false });
    expect((await graphOf(tail.work_id)).blocked).toBe(false);
    await expectInStep();

    ok(await command(lead, upstream.work_id, 'reopen', { reason: 'Scope grew.' }));
    const middle = await graphOf(work.work_id);
    // Accepted work is closed: it is not blocked, it is told what it was accepted against moved.
    expect(middle).toMatchObject({ blocked: false, dependencyChanged: true });
    const [row] = await srv.db.select().from(workItems).where(eq(workItems.id, work.work_id));
    expect(row).toMatchObject({ state: 'accepted', currentAcceptanceId: acceptanceId });
    expect(await srv.db.select().from(workAcceptances).where(eq(workAcceptances.id, acceptanceId))).toHaveLength(1);
    const tailGraph = await graphOf(tail.work_id);
    expect(tailGraph.blocked).toBe(true);
    expect(tailGraph.unmet).toEqual([expect.objectContaining({ key: work.key, state: 'accepted', why: 'acceptance_stale' })]);
    await expectInStep();

    // Accepted again upstream is a different acceptance from the one the middle was accepted against.
    await acceptDirectly(upstream.work_id);
    expect((await graphOf(work.work_id)).dependencyChanged).toBe(true);
    expect((await graphOf(tail.work_id)).unmet[0]).toMatchObject({ why: 'acceptance_stale' });
    await expectInStep();
  });

  it('carries an unmet dependency down a chain of accepted work', async () => {
    const upstream = await make('Chain top');
    const work = await make('Chain middle');
    const tail = await make('Chain tail');
    await acceptDirectly(upstream.work_id);
    ok(await command(lead, work.work_id, 'add_dependency', { depends_on: upstream.key }));
    await acceptDirectly(work.work_id);
    ok(await command(lead, tail.work_id, 'add_dependency', { depends_on: work.key }));
    expect((await graphOf(tail.work_id)).blocked).toBe(false);

    // The top's evidence moves; its acceptance id does not, so the middle's own snapshot still matches.
    await srv.db
      .update(workItems)
      .set({ evidenceEpoch: sql`${workItems.evidenceEpoch} + 1` })
      .where(eq(workItems.id, upstream.work_id));
    const middle = await graphOf(work.work_id);
    expect(middle).toMatchObject({ blocked: false, dependencyChanged: true });
    expect(middle.unmet[0]).toMatchObject({ key: upstream.key, why: 'acceptance_stale' });
    const tailGraph = await graphOf(tail.work_id);
    expect(tailGraph.blocked).toBe(true);
    expect(tailGraph.unmet).toEqual([expect.objectContaining({ key: work.key, why: 'upstream_unmet' })]);
    await expectInStep();
  });
});

describe('blockers', () => {
  const blocker = (extra: Record<string, unknown> = {}) => ({
    kind: 'environment',
    reason: 'The staging database is down.',
    next_action: 'Wait for the database to come back.',
    ...extra,
  });

  it('dedupes an open blocker by source_ref and keeps resolved ones as history', async () => {
    const work = await make('Dedupe');
    const first = ok(await command(lead, work.work_id, 'set_blocker', blocker({ source_ref: 'probe:staging-db', owner: 'bob' })));
    expect(first).toMatchObject({ deduplicated: false });
    const again = ok(await command(lead, work.work_id, 'set_blocker', blocker({ source_ref: 'probe:staging-db', reason: 'Still down.' })));
    expect(again).toMatchObject({ deduplicated: true, blocker_id: (first as any).blocker_id });
    const otherKind = ok(await command(lead, work.work_id, 'set_blocker', blocker({ kind: 'external', source_ref: 'probe:staging-db' })));
    expect((otherKind as any).blocker_id).not.toBe((first as any).blocker_id);
    const manual = ok(await command(lead, work.work_id, 'set_blocker', blocker()));
    const manualAgain = ok(await command(lead, work.work_id, 'set_blocker', blocker()));
    expect((manualAgain as any).blocker_id).not.toBe((manual as any).blocker_id);

    const graph = await graphOf(work.work_id);
    expect(graph).toMatchObject({ blocked: true, openBlockers: 4 });
    expect(graph.blockers[0]).toMatchObject({
      id: (first as any).blocker_id,
      kind: 'environment',
      reason: 'The staging database is down.',
      owner: 'bob',
      derived: false,
    });

    ok(await command(lead, work.work_id, 'resolve_blocker', { blocker_id: (first as any).blocker_id, reason: 'Back up.' }));
    const raisedAgain = ok(await command(lead, work.work_id, 'set_blocker', blocker({ source_ref: 'probe:staging-db' })));
    expect(raisedAgain).toMatchObject({ deduplicated: false });
    expect((raisedAgain as any).blocker_id).not.toBe((first as any).blocker_id);
    const rows = await srv.db
      .select()
      .from(workBlockers)
      .where(and(eq(workBlockers.workId, work.work_id), eq(workBlockers.sourceRef, 'probe:staging-db'), eq(workBlockers.kind, 'environment')));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.resolvedAt)).toMatchObject({ resolutionReason: 'Back up.', resolvedByKind: 'human' });

    const types = (await srv.db.select({ type: workEvents.type, payload: workEvents.payload }).from(workEvents).where(eq(workEvents.workId, work.work_id))).map(
      (event) => event.type,
    );
    expect(types.filter((type) => type === 'work_blocker_set')).toHaveLength(6);
    expect(types.filter((type) => type === 'work_blocker_resolved')).toHaveLength(1);
    await expectInStep();
  });

  it('needs a reason to resolve, resolves once, and only for those who may', async () => {
    const work = await make('Resolve', { acceptor: 'lead' });
    const set = ok(await command(lead, work.work_id, 'set_blocker', blocker({ owner: 'dana' })));
    const id = (set as any).blocker_id as string;
    const noReason = refusal(await command(lead, work.work_id, 'resolve_blocker', { blocker_id: id }));
    expect(noReason.code).toBe('INVALID_INPUT');
    expect(noReason.fields).toEqual(['payload.reason']);
    expect(refusal(await command(lead, work.work_id, 'resolve_blocker', { blocker_id: id, reason: '   ' })).code).toBe(
      'INVALID_INPUT',
    );
    // Bob neither raised it, nor owns it, nor has authority over the work.
    expect(refusal(await command(bob, work.work_id, 'resolve_blocker', { blocker_id: id, reason: 'Fixed.' })).code).toBe(
      'FORBIDDEN',
    );
    // A blocker of another work is not found here.
    const elsewhere = await make('Resolve elsewhere');
    const foreign = ok(await command(lead, elsewhere.work_id, 'set_blocker', blocker()));
    expect(
      refusal(await command(lead, work.work_id, 'resolve_blocker', { blocker_id: (foreign as any).blocker_id, reason: 'x' })).code,
    ).toBe('NOT_FOUND');

    // Its owner may close it.
    const dana = humanPrincipal(await userId('dana'));
    ok(await command(dana, work.work_id, 'resolve_blocker', { blocker_id: id, reason: 'Fixed the database.' }));
    const twice = refusal(await command(lead, work.work_id, 'resolve_blocker', { blocker_id: id, reason: 'Again.' }));
    expect(twice.code).toBe('INVALID_TRANSITION');

    // A member who raised one may close their own.
    const bobs = ok(await command(bob, work.work_id, 'set_blocker', blocker({ kind: 'decision' })));
    ok(await command(bob, work.work_id, 'resolve_blocker', { blocker_id: (bobs as any).blocker_id, reason: 'Decided.' }));
    expect((await graphOf(work.work_id)).blocked).toBe(false);
  });

  it('lets an agent set a blocker only on work it filed or is linked to', async () => {
    const own = ok(
      await createWork(srv.db, alphaAgent, {
        request_id: randomUUID(),
        project: 'alpha',
        contract: { title: 'Agent filed', goal: 'Found while working.' },
      }),
    );
    ok(await command(alphaAgent, own.work_id, 'set_blocker', blocker({ kind: 'contract_change_request' })));
    expect(refusal(await command(otherAgent, own.work_id, 'set_blocker', blocker())).code).toBe('FORBIDDEN');

    const leads = await make('Lead filed');
    const unlinked = refusal(await command(otherAgent, leads.work_id, 'set_blocker', blocker()));
    expect(unlinked.code).toBe('FORBIDDEN');
    expect(await srv.db.select().from(workBlockers).where(eq(workBlockers.workId, leads.work_id))).toHaveLength(0);

    // A run of the other agent, linked to the work the way the link step would link it.
    const started = await call(
      'start_run',
      { team: 'work-graph', project: 'alpha', task: 'GRAPH-1', agent: 'codex-other', scope: [{ type: 'path', key: 'src/label.ts' }] },
      otherToken,
    );
    expect(started.data?.runId, started.text).toBeTruthy();
    await srv.db.insert(workLinks).values({
      workId: leads.work_id,
      teamId,
      projectId: alphaId,
      kind: 'run',
      runId: started.data.runId,
      specRevision: null,
      createdByKind: 'human',
      createdById: leadUserId,
    });
    const linked = ok(await command(otherAgent, leads.work_id, 'set_blocker', blocker({ kind: 'access' })));
    const leadBlocker = ok(await command(lead, leads.work_id, 'set_blocker', blocker()));
    expect(
      refusal(
        await command(otherAgent, leads.work_id, 'resolve_blocker', { blocker_id: (leadBlocker as any).blocker_id, reason: 'x' }),
      ).code,
    ).toBe('FORBIDDEN');
    ok(await command(otherAgent, leads.work_id, 'resolve_blocker', { blocker_id: (linked as any).blocker_id, reason: 'Access granted.' }));
    const [row] = await srv.db.select().from(workBlockers).where(eq(workBlockers.id, (linked as any).blocker_id));
    expect(row).toMatchObject({
      createdByKind: 'agent',
      createdById: (otherAgent as { installationId: string }).installationId,
      resolvedByKind: 'agent',
    });
  });

  it('refuses blockers on closed work, acceptor_unavailable by hand, an unknown owner and past the limit', async () => {
    const work = await make('Closed blockers', { acceptor: 'lead' });
    expect(refusal(await command(lead, work.work_id, 'set_blocker', blocker({ kind: 'acceptor_unavailable' }))).fields).toEqual([
      'payload.kind',
    ]);
    expect(refusal(await command(lead, work.work_id, 'set_blocker', blocker({ owner: 'nobody' }))).fields).toEqual(['payload.owner']);

    await srv.db.insert(workBlockers).values(
      Array.from({ length: 50 }, (_, i) => ({
        workId: work.work_id,
        kind: 'other',
        reason: `Reason ${i}`,
        nextAction: 'Wait.',
        createdByKind: 'human',
        createdById: leadUserId,
      })),
    );
    expect(refusal(await command(lead, work.work_id, 'set_blocker', blocker()))).toMatchObject({
      code: 'LIMIT_EXCEEDED',
      used: 50,
      limit: 50,
    });
    await srv.db.update(workBlockers).set({ resolvedAt: new Date(), resolutionReason: 'Tidy.' }).where(eq(workBlockers.workId, work.work_id));

    ok(await command(lead, work.work_id, 'transition', { to: 'cancelled', reason: 'Not needed.' }));
    const closed = refusal(await command(lead, work.work_id, 'set_blocker', blocker()));
    expect(closed.code).toBe('INVALID_TRANSITION');
    expect(closed.next_action).toContain('Reopen');
    expect(refusal(await command(lead, work.work_id, 'add_dependency', { depends_on: 'WORK-1' })).code).toBe('INVALID_TRANSITION');
    await expectInStep();
  });
});

describe('acceptor_unavailable', () => {
  it('derives a blocker once the acceptor leaves the workspace, and reading writes nothing', async () => {
    const work = await make('Acceptor leaves', { acceptor: 'dana' });
    ok(await command(lead, work.work_id, 'transition', { to: 'ready' }));
    expect((await graphOf(work.work_id)).blocked).toBe(false);

    const danaId = await userId('dana');
    const removed = await form(`${srv.url}/app/teams/work-graph/members/${danaId}/remove`, {}, leadCookie);
    expect(removed.status).toBe(302);

    const eventsBefore = (await srv.db.select().from(workEvents).where(eq(workEvents.workId, work.work_id))).length;
    const graph = await graphOf(work.work_id);
    expect(graph).toMatchObject({ blocked: true, acceptorUnavailable: true, openBlockers: 1, unmetDependencies: 0 });
    expect(graph.blockers).toEqual([
      expect.objectContaining({ id: null, kind: 'acceptor_unavailable', owner: 'lead', created_at: null, derived: true }),
    ]);
    const read = ok(await getWork(srv.db, lead, work.work_id)) as any;
    expect(read.flags.blocked).toBe(true);
    // The compact reading says why: the derived blocker is listed with the stored ones.
    expect(read.open_blockers.items).toEqual([
      expect.objectContaining({ id: null, kind: 'acceptor_unavailable', owner: 'lead', derived: true }),
    ]);
    expect(await srv.db.select().from(workBlockers).where(eq(workBlockers.workId, work.work_id))).toHaveLength(0);
    expect((await srv.db.select().from(workEvents).where(eq(workEvents.workId, work.work_id))).length).toBe(eventsBefore);
    await expectInStep();

    // Naming a member as acceptor clears it, and the change is recorded on the event.
    ok(await command(lead, work.work_id, 'patch', { acceptor: 'bob' }));
    expect(await graphOf(work.work_id)).toMatchObject({ blocked: false, acceptorUnavailable: false, openBlockers: 0 });
    const [last] = await srv.db
      .select()
      .from(workEvents)
      .where(eq(workEvents.workId, work.work_id))
      .orderBy(sql`${workEvents.projectSeq} desc`)
      .limit(1);
    expect(last!.filterBefore).toMatchObject({ blocked: true });
    expect(last!.filterAfter).toMatchObject({ blocked: false });
    await expectInStep();
  });

  it('does not derive it for a draft with no acceptor yet', async () => {
    const draft = ok(
      await createWork(srv.db, lead, { request_id: randomUUID(), project: 'alpha', contract: { title: 'No acceptor yet' } }),
    );
    expect(await graphOf(draft.work_id)).toMatchObject({ blocked: false, acceptorUnavailable: false });
    expect(await srv.db.select().from(workBlockers).where(and(eq(workBlockers.workId, draft.work_id), isNull(workBlockers.resolvedAt)))).toHaveLength(0);
  });
});

describe('another project', () => {
  it('keeps the filter and the state in step there too', async () => {
    await expectInStep(betaId);
  });
});
