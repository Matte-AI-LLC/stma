import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentInstallations,
  projects,
  teams,
  tokens,
  users,
  workCommands,
  workCriteria,
  workEvents,
  workItems,
  workRevisions,
} from '../src/db/schema';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';
import { revokeAgentInstallation } from '../src/domain/agents';
import { createWork, updateWork } from '../src/domain/work';
import { getWork, listWork, WORK_UNTRUSTED } from '../src/domain/workRead';
import { agentPrincipal, humanPrincipal, type WorkPrincipal, type WorkResult } from '../src/domain/workTypes';
import { isTokenScope, type AgentGrant } from '../src/lib/grants';

/**
 * The Native Work command envelope and read model, driven through the domain
 * functions with principals built from real rows: people signed in through the
 * browser, and agents enrolled the way a real client connects. What this file
 * holds is the part every door shares, so the MCP tools, the REST routes and
 * the console cannot each have their own idea of a replay, a stale version or
 * who may touch a contract.
 */

let srv: StartedServer;
let dataDir: string;
let teamId = '';
let alphaId = '';
let betaId = '';
let lead: WorkPrincipal;
let bob: WorkPrincipal;
let carol: WorkPrincipal;
let alphaAgent: WorkPrincipal;
let betaAgent: WorkPrincipal;
let leadUserId = '';
let leadCookie: Record<string, string> = {};

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

/**
 * The grant `mcpAuth` would attach to a request carrying this token: the same
 * join, the same fields. Read from the rows rather than assembled by hand, so a
 * scope the server would not grant cannot be tested by accident.
 */
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

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-work-core-'));
  srv = await startServer(
    loadEnv({ port: 0, host: '127.0.0.1', nodeEnv: 'test', devMode: true, databaseUrl: undefined, pgliteDir: dataDir }),
  );
  const leadJar = jar();
  leadJar.store(await form(`${srv.url}/auth/dev`, { username: 'lead' }));
  leadCookie = leadJar.header();
  await form(`${srv.url}/app/teams`, { name: 'Work Core' }, leadCookie);
  const [team] = await srv.db.select().from(teams).where(eq(teams.slug, 'work-core'));
  teamId = team!.id;
  await form(`${srv.url}/app/projects`, { team: 'work-core', project: 'alpha' }, leadCookie);
  await form(`${srv.url}/app/projects`, { team: 'work-core', project: 'beta' }, leadCookie);
  const rows = await srv.db.select().from(projects).where(eq(projects.teamId, teamId));
  alphaId = rows.find((p) => p.name === 'alpha')!.id;
  betaId = rows.find((p) => p.name === 'beta')!.id;

  await form(`${srv.url}/app/teams/work-core/invites`, {}, leadCookie);
  const people = await (await fetchRetrying(`${srv.url}/app/teams/work-core?tab=people`, { headers: leadCookie })).text();
  const invite = /\/join\/([A-Za-z0-9_-]+)/.exec(people)?.[1] ?? '';
  expect(invite, 'invite code').toBeTruthy();
  const bobJar = jar();
  bobJar.store(await form(`${srv.url}/auth/dev`, { username: 'bob' }));
  await form(`${srv.url}/join/${invite}`, {}, bobJar.header());

  // Carol has a workspace of her own and none of this one.
  const carolJar = jar();
  carolJar.store(await form(`${srv.url}/auth/dev`, { username: 'carol' }));
  await form(`${srv.url}/app/teams`, { name: 'Elsewhere' }, carolJar.header());

  leadUserId = await userId('lead');
  lead = humanPrincipal(leadUserId);
  bob = humanPrincipal(await userId('bob'));
  carol = humanPrincipal(await userId('carol'));
  alphaAgent = await principalForToken(await connectAgent(leadCookie, 'codex-alpha', 'mac', `project:${alphaId}`));
  betaAgent = await principalForToken(await connectAgent(leadCookie, 'codex-beta', 'win', `project:${betaId}`));
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
  return (result as { error: { code: string; message: string; fields?: string[]; current_version?: string; next_action?: string } }).error;
};

const complete = (title: string, extra: Record<string, unknown> = {}) => ({
  request_id: randomUUID(),
  project: 'alpha',
  contract: { title, goal: 'Print a shipping label from the order page.', artifact_kind: 'code' },
  criteria: [{ text: 'A label prints for a paid order.' }, { id: 'docs', text: 'The help page says how.', evidence_kinds: ['artifact'] }],
  acceptor: 'bob',
  ...extra,
});

const countWork = async () => (await srv.db.select({ id: workItems.id }).from(workItems)).length;

describe('create, read and replay', () => {
  let workId = '';
  const createInput = complete('Add a label printer', { coordination: { priority: 'high', labels: ['ui'] } });

  it('creates a draft with revision 1 and reads it compact and in detail', async () => {
    const created = ok(await createWork(srv.db, lead, createInput));
    workId = created.work_id;
    expect(created).toMatchObject({ key: 'WORK-1', version: '1', spec_revision: 1, state: 'draft', replayed: false });
    expect(created.event_seq).toBe('1');
    expect(created.next_actions).toContain('transition:ready');

    const compact = ok(await getWork(srv.db, lead, workId));
    expect(compact).toMatchObject({
      key: 'WORK-1',
      title: 'Add a label printer',
      owner: 'lead',
      acceptor: 'bob',
      priority: 'high',
      labels: ['ui'],
      project: { id: alphaId, name: 'alpha' },
      untrusted: WORK_UNTRUSTED,
    });
    expect(JSON.stringify(compact)).not.toContain(leadUserId);
    expect((compact as any).readiness.missing_for_ready).toEqual([]);
    expect((compact as any).flags).toEqual({
      blocked: false,
      needs_decision: false,
      stale_evidence: false,
      acceptance_stale: false,
      external_change_pending: false,
      contract_changed: false,
      dependency_changed: false,
    });

    const byKey = ok(await getWork(srv.db, bob, { projectId: alphaId, key: 'work-1' }));
    expect((byKey as any).id).toBe(workId);

    const detail = ok(await getWork(srv.db, lead, workId, { view: 'detail', sections: ['criteria', 'events', 'contract'] }));
    const sections = (detail as any).sections;
    expect(sections.criteria.items.map((c: any) => c.id)).toEqual(['c1', 'docs']);
    expect(sections.criteria.items[1].verification_rule).toEqual({ mode: 'all', selectors: [{ source: 'artifact' }] });
    expect(sections.contract.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sections.events.items).toHaveLength(1);
    expect(sections.events.items[0]).toMatchObject({ seq: '1', version: '1', type: 'work_created' });
    expect(sections.events.items[0].actor).toEqual({ kind: 'human', username: 'lead' });
  });

  it('answers a retry with the same request id with the same work and writes nothing', async () => {
    const before = await countWork();
    const replay = ok(await createWork(srv.db, lead, createInput));
    expect(replay).toMatchObject({ work_id: workId, key: 'WORK-1', version: '1', replayed: true, event_seq: '1' });
    expect(await countWork()).toBe(before);
    const events = await srv.db.select().from(workEvents).where(eq(workEvents.workId, workId));
    expect(events).toHaveLength(1);
  });

  it('refuses the same request id with a different payload and writes nothing', async () => {
    const before = await countWork();
    const reused = refusal(await createWork(srv.db, lead, { ...createInput, contract: { ...createInput.contract, title: 'Other' } }));
    expect(reused.code).toBe('REQUEST_ID_REUSED');
    expect(await countWork()).toBe(before);
  });

  it('makes one work and one event of two concurrent creates with one request id', async () => {
    const input = complete('Concurrent');
    const before = await countWork();
    const [a, b] = await Promise.all([createWork(srv.db, lead, input), createWork(srv.db, lead, input)]);
    const results = [ok(a), ok(b)];
    expect(results[0]!.work_id).toBe(results[1]!.work_id);
    expect(results.filter((r) => r.replayed)).toHaveLength(1);
    expect(await countWork()).toBe(before + 1);
    const events = await srv.db.select().from(workEvents).where(eq(workEvents.workId, results[0]!.work_id));
    expect(events).toHaveLength(1);
  });
});

describe('versions and revisions', () => {
  it('refuses a stale expected_version with the current one', async () => {
    const created = ok(await createWork(srv.db, lead, complete('Stale version')));
    ok(
      await updateWork(srv.db, lead, {
        request_id: randomUUID(),
        work_id: created.work_id,
        expected_version: '1',
        operation: 'patch',
        payload: { coordination: { priority: 'low' } },
      }),
    );
    const stale = refusal(
      await updateWork(srv.db, lead, {
        request_id: randomUUID(),
        work_id: created.work_id,
        expected_version: '1',
        operation: 'patch',
        payload: { coordination: { priority: 'urgent' } },
      }),
    );
    expect(stale.code).toBe('VERSION_CONFLICT');
    expect(stale.current_version).toBe('2');
  });

  it('lets exactly one of two concurrent patches on one version win', async () => {
    const created = ok(await createWork(srv.db, lead, complete('Race')));
    const patch = (priority: string, label: string) =>
      updateWork(srv.db, lead, {
        request_id: randomUUID(),
        work_id: created.work_id,
        expected_version: '1',
        operation: 'patch',
        payload: { coordination: { priority, labels: [label] } },
      } as never);
    const [a, b] = await Promise.all([patch('low', 'from-a'), patch('urgent', 'from-b')]);
    const winners = [a, b].filter((r) => !('error' in r));
    const losers = [a, b].filter((r) => 'error' in r);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(refusal(losers[0]).code).toBe('VERSION_CONFLICT');
    const [row] = await srv.db.select().from(workItems).where(eq(workItems.id, created.work_id));
    expect(row!.version).toBe(2n);
    const won = winners[0] === a ? { priority: 'low', label: 'from-a' } : { priority: 'urgent', label: 'from-b' };
    expect(row!.priority).toBe(won.priority);
    expect(row!.labels).toEqual([won.label]);
  });

  it('writes revision 2 for a contract patch and leaves revision 1 untouched', async () => {
    const created = ok(await createWork(srv.db, lead, complete('Revisions')));
    const snapshot = async () =>
      JSON.stringify({
        revision: await srv.db
          .select()
          .from(workRevisions)
          .where(and(eq(workRevisions.workId, created.work_id), eq(workRevisions.revision, 1))),
        criteria: await srv.db
          .select()
          .from(workCriteria)
          .where(and(eq(workCriteria.workId, created.work_id), eq(workCriteria.revision, 1)))
          .orderBy(asc(workCriteria.position)),
      });
    const first = await snapshot();

    const coordination = ok(
      await updateWork(srv.db, lead, {
        request_id: randomUUID(),
        work_id: created.work_id,
        expected_version: '1',
        operation: 'patch',
        payload: { coordination: { due_at: '2026-11-30T12:00:00Z' } },
      }),
    );
    expect(coordination).toMatchObject({ version: '2', spec_revision: 1, revised: false });

    const revised = ok(
      await updateWork(srv.db, lead, {
        request_id: randomUUID(),
        work_id: created.work_id,
        expected_version: '2',
        operation: 'patch',
        payload: {
          contract: { goal: 'Print a label and a packing slip.' },
          criteria: [{ id: 'c1', text: 'A label prints for a paid order.' }, { text: 'A packing slip prints too.' }],
          change_reason: 'The warehouse asked for slips.',
        },
      }),
    );
    expect(revised).toMatchObject({ version: '3', spec_revision: 2, revised: true });
    expect((revised as any).changed).toEqual(expect.arrayContaining(['contract.goal', 'criteria']));
    expect(await snapshot()).toBe(first);

    const detail = ok(await getWork(srv.db, lead, created.work_id, { view: 'detail', sections: ['criteria', 'revisions'] }));
    // `docs` was used in revision 1, so the new criterion is numbered above both used ids.
    expect((detail as any).sections.criteria.items.map((c: any) => c.id)).toEqual(['c1', 'c2']);
    expect((detail as any).changed_criteria).toEqual({ revision: 2, added: ['c2'], changed: [], removed: ['docs'] });
    expect((detail as any).sections.revisions.items.map((r: any) => r.revision)).toEqual([2, 1]);

    const noop = {
      request_id: randomUUID(),
      work_id: created.work_id,
      expected_version: '3',
      operation: 'patch',
      payload: { contract: { goal: 'Print a label and a packing slip.' } },
    };
    const same = ok(await updateWork(srv.db, lead, noop));
    // The same goal again changes nothing: no revision, no event and no version
    // step, so a form open at version 3 elsewhere is still current.
    expect(same).toMatchObject({ version: '3', spec_revision: 2, revised: false, changed: [], event_seq: null });
    expect((await srv.db.select().from(workItems).where(eq(workItems.id, created.work_id)))[0]!.version).toBe(3n);
    // Its retry is answered as it was: no sequence, though the events at version 3
    // (the revision above) have one, which this request never wrote.
    const retried = ok(await updateWork(srv.db, lead, noop));
    expect(retried).toMatchObject({ version: '3', spec_revision: 2, replayed: true, event_seq: null });
  });

  it('refuses duplicate criterion ids naming the wire path', async () => {
    const duplicate = refusal(
      await createWork(srv.db, lead, {
        ...complete('Duplicates'),
        criteria: [{ id: 'a', text: 'one' }, { id: 'a', text: 'two' }],
      }),
    );
    expect(duplicate.code).toBe('INVALID_INPUT');
    expect(duplicate.fields).toEqual(['criteria[1].id']);
    const provider = refusal(
      await createWork(srv.db, lead, {
        ...complete('Provider'),
        criteria: [{ text: 'CI passes', evidence_kinds: ['provider_observation'] }],
      }),
    );
    expect(provider.fields).toEqual(['criteria[0].verification_rule']);
  });

  it('refuses a rule that reads other sources than the evidence kinds the criterion names', async () => {
    const before = await srv.db.select({ id: workItems.id }).from(workItems);
    // Said to ask for a provider observation, while the rule would take the
    // agent's own report as a pass.
    const weaker = refusal(
      await createWork(srv.db, lead, {
        ...complete('Says provider, reads a report'),
        criteria: [
          { text: 'A label prints.' },
          {
            text: 'CI passes',
            evidence_kinds: ['provider_observation'],
            verification_rule: { mode: 'all', selectors: [{ source: 'agent_report' }] },
          },
        ],
      }),
    );
    expect(weaker.code).toBe('INVALID_INPUT');
    expect(weaker.fields).toEqual(['criteria[1].evidence_kinds', 'criteria[1].verification_rule']);
    expect(weaker.message).toContain('provider_observation');
    // The other way round too: the kinds would leave out what the rule asks for.
    const stricter = refusal(
      await createWork(srv.db, lead, {
        ...complete('Says report, reads a person'),
        criteria: [{ text: 'A person read it.', evidence_kinds: ['agent_report'], verification_rule: { selectors: [{ source: 'human_check' }] } }],
      }),
    );
    expect(stricter.fields).toEqual(['criteria[0].evidence_kinds', 'criteria[0].verification_rule']);
    expect(await srv.db.select({ id: workItems.id }).from(workItems)).toHaveLength(before.length);
    // Naming the same sources, in any order and with a source repeated, is the same criterion.
    ok(
      await createWork(srv.db, lead, {
        ...complete('Says both, reads both'),
        criteria: [
          {
            text: 'Either a person looked or the agent reports.',
            evidence_kinds: ['human_check', 'agent_report'],
            verification_rule: { mode: 'any', selectors: [{ source: 'agent_report' }, { source: 'human_check' }, { source: 'agent_report' }] },
          },
        ],
      }),
    );
  });
});

describe('lifecycle', () => {
  it('refuses ready with the missing wire fields', async () => {
    const draft = ok(
      await createWork(srv.db, lead, { request_id: randomUUID(), project: 'alpha', contract: { title: 'Thin' } }),
    );
    const refused = refusal(
      await updateWork(srv.db, lead, {
        request_id: randomUUID(),
        work_id: draft.work_id,
        expected_version: '1',
        operation: 'transition',
        payload: { to: 'ready' },
      }),
    );
    expect(refused.code).toBe('CONTRACT_INCOMPLETE');
    expect(refused.fields).toEqual(['acceptor', 'contract.goal', 'criteria', 'contract.artifact_kind']);
  });

  it('refuses a contract change to accepted work without reopen_reason', async () => {
    const created = ok(await createWork(srv.db, lead, complete('Accepted')));
    // No decision path exists in this step, so the state is set where a decision would set it.
    await srv.db.update(workItems).set({ state: 'accepted' }).where(eq(workItems.id, created.work_id));
    const refused = refusal(
      await updateWork(srv.db, lead, {
        request_id: randomUUID(),
        work_id: created.work_id,
        expected_version: '1',
        operation: 'patch',
        payload: { contract: { goal: 'A different goal.' } },
      }),
    );
    expect(refused.code).toBe('INVALID_TRANSITION');
    expect(refused.fields).toEqual(['payload.reopen_reason']);

    const coordination = ok(
      await updateWork(srv.db, lead, {
        request_id: randomUUID(),
        work_id: created.work_id,
        expected_version: '1',
        operation: 'patch',
        payload: { coordination: { labels: ['shipped'] } },
      }),
    );
    expect(coordination.state).toBe('accepted');

    const reopened = ok(
      await updateWork(srv.db, lead, {
        request_id: randomUUID(),
        work_id: created.work_id,
        expected_version: '2',
        operation: 'patch',
        payload: { contract: { goal: 'A different goal.' }, reopen_reason: 'The goal moved.' },
      }),
    );
    expect(reopened).toMatchObject({ state: 'in_progress', spec_revision: 2, version: '3' });
  });

  it('leaves accepted and cancelled work only by reopening it, never by a plain move', async () => {
    const accepted = ok(await createWork(srv.db, lead, complete('Closed for good')));
    await srv.db.update(workItems).set({ state: 'accepted' }).where(eq(workItems.id, accepted.work_id));
    const move = (workId: string, to: string, who = lead) =>
      updateWork(srv.db, who, {
        request_id: randomUUID(),
        work_id: workId,
        expected_version: '1',
        operation: 'transition',
        payload: { to },
      } as never);
    // Neither the owner nor a plain member can take it back without a reason.
    for (const who of [lead, bob]) {
      const refused = refusal(await move(accepted.work_id, 'in_progress', who));
      expect(refused.code).toBe('INVALID_TRANSITION');
      expect(refused.next_action).toBe('Reopen it with a reason first.');
    }
    const [stillAccepted] = await srv.db.select().from(workItems).where(eq(workItems.id, accepted.work_id));
    expect(stillAccepted!.state).toBe('accepted');
    // The hint does not offer what the command refuses; reopen is what is offered.
    const read = ok(await getWork(srv.db, lead, accepted.work_id, {})) as { next_actions: string[] };
    expect(read.next_actions).toContain('reopen');
    expect(read.next_actions.filter((action) => action.startsWith('transition:'))).toEqual([]);

    const cancelled = ok(await createWork(srv.db, lead, complete('Called off')));
    await srv.db.update(workItems).set({ state: 'cancelled' }).where(eq(workItems.id, cancelled.work_id));
    expect(refusal(await move(cancelled.work_id, 'draft')).next_action).toBe('Reopen it with a reason first.');
    const reopened = ok(
      await updateWork(srv.db, lead, {
        request_id: randomUUID(),
        work_id: cancelled.work_id,
        expected_version: '1',
        operation: 'reopen',
        payload: { reason: 'It is needed after all.' },
      }),
    );
    expect(reopened.state).toBe('draft');
  });

  it('moves ready work back to in_progress and refuses archive while it is active', async () => {
    // Lead accepts here too, so bob is a member with no contract authority on it.
    const created = ok(await createWork(srv.db, lead, complete('Archive', { acceptor: 'lead' })));
    const step = async (version: string, operation: string, payload: Record<string, unknown>, who = lead) =>
      updateWork(srv.db, who, { request_id: randomUUID(), work_id: created.work_id, expected_version: version, operation, payload } as never);
    expect(ok(await step('1', 'transition', { to: 'ready' })).state).toBe('ready');
    // A member without contract authority may start it but not cancel it.
    expect(refusal(await step('2', 'transition', { to: 'cancelled', reason: 'no' }, bob)).code).toBe('FORBIDDEN');
    expect(ok(await step('2', 'transition', { to: 'in_progress' }, bob)).state).toBe('in_progress');
    const archive = refusal(await step('3', 'archive', {}));
    expect(archive.code).toBe('INVALID_TRANSITION');
    expect(archive.next_action).toBeTruthy();
    expect(refusal(await step('3', 'transition', { to: 'in_review' })).code).toBe('INVALID_TRANSITION');
    expect(refusal(await step('3', 'transition', { to: 'cancelled' })).fields).toEqual(['payload.reason']);
    expect(ok(await step('3', 'transition', { to: 'cancelled', reason: 'Superseded by WORK-1.' })).state).toBe('cancelled');
    expect(ok(await step('4', 'archive', { reason: 'Tidy.' })).state).toBe('cancelled');
    expect(refusal(await step('5', 'patch', { coordination: { priority: 'low' } })).code).toBe('INVALID_TRANSITION');
    const reopened = ok(await step('5', 'reopen', { reason: 'Needed after all.' }));
    expect(reopened.state).toBe('draft');
    const [row] = await srv.db.select().from(workItems).where(eq(workItems.id, created.work_id));
    expect(row!.archivedAt).toBeNull();
  });
});

describe('agents and visibility', () => {
  it('lets an agent file a draft and edit only its own draft', async () => {
    const own = ok(
      await createWork(srv.db, alphaAgent, {
        request_id: randomUUID(),
        project: 'alpha',
        contract: { title: 'Agent idea', goal: 'Found while working.' },
      }),
    );
    expect(own.state).toBe('draft');
    const [row] = await srv.db.select().from(workItems).where(eq(workItems.id, own.work_id));
    expect(row).toMatchObject({ createdByKind: 'agent', ownerUserId: null, createdByUserId: leadUserId });
    expect(row!.createdById).toBe((alphaAgent as { installationId: string }).installationId);

    const edited = ok(
      await updateWork(srv.db, alphaAgent, {
        request_id: randomUUID(),
        work_id: own.work_id,
        expected_version: '1',
        operation: 'patch',
        payload: { contract: { artifact_kind: 'code' }, criteria: [{ text: 'Works.' }], owner: 'lead', acceptor: 'bob' },
      }),
    );
    expect(edited).toMatchObject({ spec_revision: 2, version: '2' });

    const ready = refusal(
      await updateWork(srv.db, alphaAgent, {
        request_id: randomUUID(),
        work_id: own.work_id,
        expected_version: '2',
        operation: 'transition',
        payload: { to: 'ready' },
      }),
    );
    expect(ready.code).toBe('FORBIDDEN');

    const human = ok(await createWork(srv.db, lead, complete('Human draft')));
    const patched = refusal(
      await updateWork(srv.db, alphaAgent, {
        request_id: randomUUID(),
        work_id: human.work_id,
        expected_version: '1',
        operation: 'patch',
        payload: { coordination: { priority: 'urgent' } },
      }),
    );
    expect(patched.code).toBe('FORBIDDEN');
    expect(patched.next_action).toContain('contract_change_request');
  });

  it('answers NOT_FOUND to another workspace and to an agent scoped to another project', async () => {
    const created = ok(await createWork(srv.db, lead, complete('Private')));
    expect(refusal(await getWork(srv.db, carol, created.work_id)).code).toBe('NOT_FOUND');
    expect(refusal(await getWork(srv.db, betaAgent, created.work_id)).code).toBe('NOT_FOUND');
    expect(ok(await getWork(srv.db, alphaAgent, created.work_id))).toBeTruthy();
    for (const who of [carol, betaAgent]) {
      const refused = refusal(
        await updateWork(srv.db, who, {
          request_id: randomUUID(),
          work_id: created.work_id,
          expected_version: '1',
          operation: 'patch',
          payload: { coordination: { priority: 'low' } },
        }),
      );
      expect(refused.code).toBe('NOT_FOUND');
      expect(refused.current_version).toBeUndefined();
    }
    expect(refusal(await createWork(srv.db, betaAgent, complete('Out of scope'))).code).toBe('NOT_FOUND');
    expect(refusal(await listWork(srv.db, carol, alphaId)).code).toBe('NOT_FOUND');
  });

  it('refuses a replay once the agent credential is revoked', async () => {
    const revocable = await principalForToken(
      await connectAgent(leadCookie, 'codex-revoked', 'linux', `project:${alphaId}`),
    );
    const input = { request_id: randomUUID(), project: 'alpha', contract: { title: 'Before revoke' } };
    const first = ok(await createWork(srv.db, revocable, input));
    expect(ok(await createWork(srv.db, revocable, input))).toMatchObject({ work_id: first.work_id, replayed: true });
    await revokeAgentInstallation(srv.db, leadUserId, (revocable as { installationId: string }).installationId);
    expect(refusal(await createWork(srv.db, revocable, input)).code).toBe('NOT_FOUND');
    expect(refusal(await getWork(srv.db, revocable, first.work_id)).code).toBe('NOT_FOUND');
  });
});

describe('receipts and events', () => {
  it('leaves no receipt for a refused command, so the corrected retry succeeds', async () => {
    const requestId = randomUUID();
    const refused = refusal(await createWork(srv.db, lead, { ...complete('Retry'), request_id: requestId, acceptor: 'nobody' }));
    expect(refused.code).toBe('INVALID_INPUT');
    expect(refused.fields).toEqual(['acceptor']);
    const receipts = await srv.db.select().from(workCommands).where(eq(workCommands.requestId, requestId));
    expect(receipts).toHaveLength(0);
    const retried = ok(await createWork(srv.db, lead, { ...complete('Retry'), request_id: requestId }));
    expect(retried.replayed).toBe(false);
  });

  it('writes events in a strictly increasing project order with filter fields', async () => {
    const events = await srv.db
      .select()
      .from(workEvents)
      .where(eq(workEvents.projectId, alphaId))
      .orderBy(asc(workEvents.projectSeq));
    expect(events.length).toBeGreaterThan(10);
    events.forEach((event, i) => {
      if (i > 0) expect(event.projectSeq).toBeGreaterThan(events[i - 1]!.projectSeq);
      expect(event.filterAfter).toMatchObject({ state: expect.any(String), archived: expect.any(Boolean) });
      if (event.type === 'work_created') expect(event.filterBefore).toBeNull();
      else expect(event.filterBefore).toMatchObject({ state: expect.any(String) });
    });
    const transitioned = events.find((event) => event.type === 'work_state_changed' && (event.payload as any).to === 'in_progress');
    expect(transitioned!.filterBefore).toMatchObject({ state: 'ready' });
    expect(transitioned!.filterAfter).toMatchObject({ state: 'in_progress' });
  });

  it('lists a project newest change first, pages by cursor and counts each view', async () => {
    const first = ok(await listWork(srv.db, lead, alphaId, {}, { limit: 3 })) as any;
    expect(first.items).toHaveLength(3);
    expect(first.untrusted).toBe(WORK_UNTRUSTED);
    expect(first.counts.all).toBeGreaterThan(3);
    const seen = new Set(first.items.map((item: any) => item.id));
    let cursor = first.next_cursor;
    while (cursor) {
      const next = ok(await listWork(srv.db, lead, alphaId, {}, { limit: 3, cursor })) as any;
      for (const item of next.items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
      cursor = next.next_cursor;
    }
    expect(seen.size).toBe(first.counts.all);
    const mine = ok(await listWork(srv.db, bob, alphaId, { view: 'mine' })) as any;
    expect(mine.items.length).toBe(mine.counts.mine);
    expect(mine.items.every((item: any) => item.acceptor === 'bob' || item.owner === 'bob')).toBe(true);
    const agentMine = ok(await listWork(srv.db, alphaAgent, alphaId, { view: 'mine' })) as any;
    expect(agentMine.items.map((item: any) => item.title)).toEqual(['Agent idea']);
    expect(refusal(await listWork(srv.db, lead, alphaId, {}, { cursor: 'nonsense' })).code).toBe('INVALID_INPUT');
  });
});

describe('the compact view', () => {
  it('trims a long goal and caps the blockers and the unmet dependencies at five, saying more exist', async () => {
    const goal = 'A paid order prints a shipping label from the order page. '.repeat(20).trim();
    expect(goal.length).toBeGreaterThan(600);
    const created = ok(
      await createWork(srv.db, lead, complete('Bounded on read', { contract: { title: 'Bounded on read', goal, artifact_kind: 'code' } })),
    );
    let version = created.version;
    const step = async (operation: string, payload: Record<string, unknown>) => {
      const done = ok(
        await updateWork(srv.db, lead, { request_id: randomUUID(), work_id: created.work_id, expected_version: version, operation, payload } as never),
      );
      version = done.version;
    };
    const reason = `The label printer vendor has not answered. ${'They were asked again. '.repeat(15)}`.trim();
    const nextAction = `Wait for the vendor. ${'Then ask once more. '.repeat(15)}`.trim();
    for (let index = 0; index < 6; index++) {
      await step('set_blocker', { kind: 'external', reason: `${index}: ${reason}`, next_action: nextAction });
    }
    for (let index = 0; index < 6; index++) {
      const upstream = ok(await createWork(srv.db, lead, complete(`Upstream ${index}`)));
      await step('add_dependency', { depends_on: upstream.work_id });
    }

    const compact = ok(await getWork(srv.db, lead, created.work_id)) as any;
    // The goal is cut at 600 characters and says so; the start is the goal's own.
    expect(compact.goal_truncated).toBe(true);
    expect(compact.goal).toBe(`${goal.slice(0, 600)}…`);
    // Five blockers, each in short form, and a flag for the sixth.
    expect(compact.open_blockers.items).toHaveLength(5);
    expect(compact.open_blockers.more).toBe(true);
    for (const blocker of compact.open_blockers.items) {
      expect(blocker.reason.length).toBeLessThanOrEqual(201);
      expect(blocker.reason.endsWith('…')).toBe(true);
      expect(blocker.next_action.length).toBeLessThanOrEqual(201);
    }
    expect(compact.unmet_dependencies.items).toHaveLength(5);
    expect(compact.unmet_dependencies.more).toBe(true);
    // The detail view still has every one of them.
    const detail = ok(await getWork(srv.db, lead, created.work_id, { view: 'detail', sections: ['blockers', 'dependencies'] })) as any;
    expect(detail.sections.blockers.items).toHaveLength(6);
    expect(detail.sections.blockers.items.map((item: any) => item.reason)).toContain(`5: ${reason}`);
    expect(detail.sections.dependencies.depends_on).toHaveLength(6);

    // A short goal and a single blocker carry neither flag.
    const plain = ok(await createWork(srv.db, lead, complete('Plain read')));
    ok(
      await updateWork(srv.db, lead, {
        request_id: randomUUID(),
        work_id: plain.work_id,
        expected_version: plain.version,
        operation: 'set_blocker',
        payload: { kind: 'external', reason: 'Waiting.', next_action: 'Ask.' },
      }),
    );
    const short = ok(await getWork(srv.db, lead, plain.work_id)) as any;
    expect(short.goal_truncated).toBe(false);
    expect(short.open_blockers).toMatchObject({ more: false });
    expect(short.open_blockers.items).toHaveLength(1);
    expect(short.unmet_dependencies).toEqual({ items: [], more: false });
  });
});
