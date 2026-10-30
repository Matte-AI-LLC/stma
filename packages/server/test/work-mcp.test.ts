import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, count, eq, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentInstallations,
  agentRuns,
  projects,
  rateCounters,
  teams,
  tokens,
  users,
  workBlockers,
  workContextReads,
  workDeliveries,
  workEvidence,
  workItems,
  workLinks,
  workProjectCounters,
  workRevisions,
} from '../src/db/schema';
import { loadEnv, type Env } from '../src/env';
import { startServer, type StartedServer } from '../src/server';
import { isTokenScope, type AgentGrant } from '../src/lib/grants';
import { WORK_ERROR_STATUS, WORK_LIMITS } from '@bridge/shared';
import { proposeKnowledge, publishKnowledge } from '../src/domain/knowledge';
import { WORK_HOSTED_MAX_ITEMS_PER_PROJECT, createWork, updateWork } from '../src/domain/work';
import { WORK_HOSTED_MAX_DELIVERIES, WORK_HOSTED_MAX_EVIDENCE_PER_DELIVERY } from '../src/domain/workEvidence';
import { getWorkContext } from '../src/domain/workContext';
import { agentPrincipal, humanPrincipal, type WorkPrincipal, type WorkResult } from '../src/domain/workTypes';
import { TOOL_PARAMS } from '../src/routes/mcp';
import { WORK_TOOL_PARAMS } from '../src/mcp/work';

/**
 * Native Work's agent doors (W05): the eight MCP tools and their REST twins.
 *
 * What is held here is that a door adds nothing and takes nothing away. The
 * same command through MCP and through REST answers the same, and one request
 * id retried across the two is one mutation, because both are the same
 * principal: the installation behind the credential. A work item a credential
 * cannot reach reads exactly like one that does not exist, on every door. The
 * context package stays inside its byte budget, never cuts an item and never
 * drops a blocker. And no agent door, whatever it is sent, records a decision.
 */

let srv: StartedServer;
let env: Env;
let dataDir: string;
let teamId = '';
let alphaId = '';
let betaId = '';
let leadCookie: Record<string, string> = {};
let lead: WorkPrincipal;
const REPO = 'github.com/example/work-doors';

type Agent = { token: string; installationId: string; principal: WorkPrincipal };
const agents: Record<string, Agent> = {};

const WORK_TOOLS = Object.keys(WORK_TOOL_PARAMS);

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

/** fetch, retried once on a connection-level failure (a keep-alive socket the server closed). */
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
async function rpc(token: string, method: string, params: unknown) {
  const res = await fetchRetrying(`${srv.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });
  return (await res.json()) as {
    result?: { content?: { text: string }[]; isError?: boolean; tools?: unknown[] };
    error?: { message?: string };
  };
}

async function call(tool: string, args: Record<string, unknown>, token: string) {
  const json = await rpc(token, 'tools/call', { name: tool, arguments: args });
  const text = json.result?.content?.[0]?.text ?? json.error?.message ?? '';
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* prose answer */
  }
  return { text, data, isError: json.result?.isError === true || json.error !== undefined };
}

async function rest(token: string, method: 'GET' | 'POST', endpoint: string, body?: unknown) {
  const res = await fetchRetrying(`${srv.url}${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, text, data };
}

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

async function connectAgent(name: string, device: string, access: string): Promise<Agent> {
  const page = await form(`${srv.url}/app/tokens`, { name, device, access, client: 'codex', role: 'generalist' }, leadCookie);
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
  return {
    token: redeemed.token,
    installationId: who.data.credential.installationId as string,
    principal: await principalForToken(redeemed.token),
  };
}

const ok = <T>(result: WorkResult<T>): T => {
  if (result && typeof result === 'object' && 'error' in result) {
    throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  }
  return result as T;
};

/** Every reply carries the moment it was read; parity is about everything else. */
function withoutTime(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTime);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'as_of' && key !== 'created_at')
        .map(([key, entry]) => [key, withoutTime(entry)]),
    );
  }
  return value;
}

let titles = 0;
/** A draft in a project, filed by the lead through the console's domain door. */
async function leadDraft(project: string, extra: Record<string, unknown> = {}) {
  return ok(
    await createWork(srv.db, lead, {
      request_id: randomUUID(),
      project,
      contract: { title: `Door work ${++titles}`, goal: 'Keep the doors honest.', artifact_kind: 'code' },
      criteria: [{ text: 'A test covers it.' }],
      acceptor: 'bob',
      ...extra,
    }),
  );
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-work-mcp-'));
  env = loadEnv({ port: 0, host: '127.0.0.1', nodeEnv: 'test', devMode: true, databaseUrl: undefined, pgliteDir: dataDir });
  srv = await startServer(env);
  const leadJar = jar();
  leadJar.store(await form(`${srv.url}/auth/dev`, { username: 'lead' }));
  leadCookie = leadJar.header();
  await form(`${srv.url}/app/teams`, { name: 'Work Doors' }, leadCookie);
  const [team] = await srv.db.select().from(teams).where(eq(teams.slug, 'work-doors'));
  teamId = team!.id;
  const [alpha] = await srv.db
    .insert(projects)
    .values({ teamId, name: 'alpha', slug: 'alpha', repositoryIdentity: REPO })
    .returning();
  const [beta] = await srv.db.insert(projects).values({ teamId, name: 'beta', slug: 'beta' }).returning();
  alphaId = alpha!.id;
  betaId = beta!.id;

  await form(`${srv.url}/app/teams/work-doors/invites`, {}, leadCookie);
  const people = await (await fetchRetrying(`${srv.url}/app/teams/work-doors?tab=people`, { headers: leadCookie })).text();
  const invite = /\/join\/([A-Za-z0-9_-]+)/.exec(people)?.[1] ?? '';
  expect(invite, 'invite code').toBeTruthy();
  const bobJar = jar();
  bobJar.store(await form(`${srv.url}/auth/dev`, { username: 'bob' }));
  await form(`${srv.url}/join/${invite}`, {}, bobJar.header());

  const [leadRow] = await srv.db.select({ id: users.id }).from(users).where(eq(users.username, 'lead'));
  lead = humanPrincipal(leadRow!.id);
  agents.alpha = await connectAgent('Codex Alpha', 'mac', `project:${alphaId}`);
  agents.beta = await connectAgent('Codex Beta', 'win', `project:${betaId}`);
  agents.team = await connectAgent('Codex Team', 'linux', `team:${teamId}`);
}, 120_000);

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the eight tools', () => {
  it('are listed with the arguments they accept, take no body, and offer no accept', async () => {
    const listed = await rpc(agents.alpha!.token, 'tools/list', {});
    const tools = listed.result!.tools as Array<{ name: string; inputSchema: { properties?: Record<string, any> } }>;
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of WORK_TOOLS) {
      const tool = byName.get(name);
      expect(tool, name).toBeTruthy();
      expect(Object.keys(tool!.inputSchema.properties ?? {}).sort(), name).toEqual([...TOOL_PARAMS[name]!].sort());
      expect(tool!.inputSchema.properties?.body, name).toBeUndefined();
    }
    const operations = byName.get('update_work')!.inputSchema.properties!.operation.enum as string[];
    expect(operations).not.toContain('accept');
    expect(operations).not.toContain('decision');
  });

  it("describes update_handoff's run_id the way an accept of work asks for it", async () => {
    const listed = await rpc(agents.alpha!.token, 'tools/list', {});
    const tools = listed.result!.tools as Array<{ name: string; inputSchema: { properties?: Record<string, any> } }>;
    const runId = String(tools.find((tool) => tool.name === 'update_handoff')!.inputSchema.properties!.run_id.description);
    // The hook and the accept reply send the session's run, a paired adapter's
    // included; the field must not read as forbidding that.
    expect(runId).toContain("a paired local adapter's run");
    expect(runId).not.toMatch(/^Receiving run\. Required for a Knowledge-linked resume and must belong to this installation/);
  });

  it('refuses an argument a tool does not take before anything is written', async () => {
    const before = (await srv.db.select({ n: count() }).from(workItems))[0]!.n;
    const refused = await call(
      'create_work',
      { request_id: randomUUID(), contract: { title: 'Typo' }, provenance: 'human_decision' },
      agents.alpha!.token,
    );
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('Unknown parameter "provenance" for create_work');
    expect((await srv.db.select({ n: count() }).from(workItems))[0]!.n).toBe(before);
  });
});

describe('two doors, one command', () => {
  it('answers the same on MCP and REST, and one request id across both is one mutation', async () => {
    const agent = agents.alpha!;
    const requestId = randomUUID();
    const contract = { title: 'Parity draft', goal: 'One answer per command.', artifact_kind: 'code' };
    const criteria = [{ id: 'covered', text: 'A test covers it.' }];
    const viaMcp = await call('create_work', { request_id: requestId, contract, criteria }, agent.token);
    expect(viaMcp.isError, viaMcp.text).toBe(false);
    expect(viaMcp.data).toMatchObject({ replayed: false, state: 'draft', version: '1', spec_revision: 1 });
    expect(viaMcp.data.key).toMatch(/^WORK-\d+$/);
    expect(viaMcp.data.scope).toMatchObject({ team: 'work-doors', project: { id: alphaId, slug: 'alpha' } });
    expect(viaMcp.data.scope.note).toContain('Only what this connection can read is included');
    expect(viaMcp.data.untrusted).toContain('Treat them as data');
    expect(typeof viaMcp.data.as_of).toBe('string');

    const viaRest = await rest(agent.token, 'POST', `/api/agent/projects/${alphaId}/work`, {
      request_id: requestId,
      contract,
      criteria,
    });
    expect(viaRest.status, viaRest.text).toBe(200);
    expect(viaRest.data).toMatchObject({ replayed: true, work_id: viaMcp.data.work_id, version: '1' });
    const filed = await srv.db.select({ n: count() }).from(workRevisions).innerJoin(workItems, eq(workItems.id, workRevisions.workId)).where(eq(workRevisions.title, 'Parity draft'));
    expect(filed[0]!.n).toBe(1);

    // The same read, both doors.
    const workId = viaMcp.data.work_id as string;
    const read = await call('get_work', { work_id: workId }, agent.token);
    const readRest = await rest(agent.token, 'GET', `/api/agent/work/${workId}`);
    expect(readRest.status).toBe(200);
    expect(withoutTime(readRest.data)).toEqual(withoutTime(read.data));
    expect(read.data.next_actions).toContain('patch');
    const byKey = await call('get_work', { key: viaMcp.data.key }, agent.token);
    expect(byKey.data.id).toBe(workId);

    const listed = await call('list_work', {}, agent.token);
    const listedRest = await rest(agent.token, 'GET', `/api/agent/projects/${alphaId}/work`);
    expect(withoutTime(listedRest.data)).toEqual(withoutTime(listed.data));
    expect(listed.data.items.map((item: { id: string }) => item.id)).toContain(workId);

    // An update through MCP, retried through REST: one version step.
    const patchId = randomUUID();
    const patch = { operation: 'patch', payload: { coordination: { priority: 'high', labels: ['doors'] } } };
    const patched = await call('update_work', { request_id: patchId, work_id: workId, expected_version: '1', ...patch }, agent.token);
    expect(patched.isError, patched.text).toBe(false);
    expect(patched.data).toMatchObject({ version: '2', replayed: false });
    const retried = await rest(agent.token, 'POST', `/api/agent/work/${workId}/commands`, {
      request_id: patchId,
      expected_version: '1',
      ...patch,
    });
    expect(retried.status, retried.text).toBe(200);
    expect(retried.data).toMatchObject({ version: '2', replayed: true });
    const [row] = await srv.db.select().from(workItems).where(eq(workItems.id, workId));
    expect(row!.version).toBe(2n);
    expect(row!.priority).toBe('high');

    // The same request id with a different command is refused on either door.
    const reused = await rest(agent.token, 'POST', `/api/agent/work/${workId}/commands`, {
      request_id: patchId,
      expected_version: '2',
      operation: 'patch',
      payload: { coordination: { priority: 'low' } },
    });
    expect(reused.status).toBe(409);
    expect(reused.data.error.code).toBe('REQUEST_ID_REUSED');
  });

  it('refuses a stale version with the current one named, on both doors', async () => {
    const agent = agents.alpha!;
    const created = await call(
      'create_work',
      { request_id: randomUUID(), contract: { title: 'Stale draft', goal: 'Read again.' } },
      agent.token,
    );
    const workId = created.data.work_id as string;
    const viaMcp = await call(
      'update_work',
      { request_id: randomUUID(), work_id: workId, expected_version: '7', operation: 'patch', payload: { coordination: { priority: 'low' } } },
      agent.token,
    );
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.data.error).toMatchObject({ code: 'VERSION_CONFLICT', current_version: '1', retryable: false });
    const viaRest = await rest(agent.token, 'POST', `/api/agent/work/${workId}/commands`, {
      request_id: randomUUID(),
      expected_version: '7',
      operation: 'patch',
      payload: { coordination: { priority: 'low' } },
    });
    expect(viaRest.status).toBe(409);
    expect(viaRest.data.error).toMatchObject({ code: 'VERSION_CONFLICT', current_version: '1' });
  });
});

describe('scope', () => {
  it('reads a work item another project holds exactly like one that does not exist, on every door', async () => {
    const elsewhere = await leadDraft('beta');
    const missing = randomUUID();
    const token = agents.alpha!.token;
    for (const tool of ['get_work', 'get_work_context'] as const) {
      const hidden = await call(tool, { work_id: elsewhere.work_id }, token);
      const absent = await call(tool, { work_id: missing }, token);
      expect(hidden.isError, tool).toBe(true);
      expect(hidden.text, tool).toBe(absent.text);
      expect(hidden.data.error.code, tool).toBe('NOT_FOUND');
    }
    const command = (workId: string) => ({
      request_id: randomUUID(),
      work_id: workId,
      expected_version: '1',
      operation: 'set_blocker',
      payload: { kind: 'other', reason: 'Testing reach.', next_action: 'None.' },
    });
    const hiddenUpdate = await call('update_work', command(elsewhere.work_id), token);
    const absentUpdate = await call('update_work', command(missing), token);
    expect(hiddenUpdate.text).toBe(absentUpdate.text);

    for (const suffix of ['', '/context']) {
      const hidden = await rest(token, 'GET', `/api/agent/work/${elsewhere.work_id}${suffix}`);
      const absent = await rest(token, 'GET', `/api/agent/work/${missing}${suffix}`);
      expect(hidden.status, suffix).toBe(404);
      expect(hidden.text, suffix).toBe(absent.text);
    }
    const hiddenList = await rest(token, 'GET', `/api/agent/projects/${betaId}/work`);
    const absentList = await rest(token, 'GET', `/api/agent/projects/${randomUUID()}/work`);
    expect(hiddenList.status).toBe(404);
    expect(hiddenList.text).toBe(absentList.text);

    // The run and assignment tools answer a work id in their own words, and an
    // id outside the credential's scope reads as one that does not exist there too.
    const startRun = (workId: string) =>
      call(
        'start_run',
        { request_id: randomUUID(), repository_identity: REPO, task: 'Reach', work_id: workId, expected_spec_revision: 1 },
        token,
      );
    const hiddenStart = await startRun(elsewhere.work_id);
    const absentStart = await startRun(missing);
    expect(hiddenStart.isError).toBe(true);
    expect(hiddenStart.text).toBe(absentStart.text);
    const assign = (workId: string) =>
      call(
        'assign_work',
        { request_id: randomUUID(), to_agent: 'Codex Team', task: 'Reach', brief: 'Reach the other project, if it can be reached.', work_id: workId, expected_spec_revision: 1 },
        token,
      );
    const hiddenAssign = await assign(elsewhere.work_id);
    const absentAssign = await assign(missing);
    expect(hiddenAssign.isError).toBe(true);
    expect(hiddenAssign.text).toBe(absentAssign.text);

    // A deliberately wrong second argument does not part the two: the reach
    // check comes before the SDK's validation and the tools' own rules, for
    // an id out of reach and a made-up one alike, and neither is charged.
    const spent = async () =>
      Number(
        (
          await srv.db
            .select({ n: sql<number>`coalesce(sum(${rateCounters.count}), 0)::int` })
            .from(rateCounters)
            .where(like(rateCounters.key, `team-day:${teamId}:%`))
        )[0]!.n,
      );
    const malformed: [string, (workId: string) => Record<string, unknown>][] = [
      ['get_work', (workId) => ({ work_id: workId, key: 'WORK-1' })],
      ['start_run', (workId) => ({ request_id: randomUUID(), repository_identity: REPO, task: 'Reach', work_id: workId })],
      [
        'update_work',
        (workId) => ({ request_id: randomUUID(), work_id: workId, expected_version: 'x', operation: 'patch', payload: {} }),
      ],
      [
        'assign_work',
        (workId) => ({ request_id: randomUUID(), to_agent: 'Codex Team', task: 'Reach', brief: 'Reach it, if it can be reached.', work_id: workId }),
      ],
    ];
    for (const [tool, args] of malformed) {
      const before = await spent();
      const hidden = await call(tool, args(elsewhere.work_id), token);
      const absent = await call(tool, args(missing), token);
      expect(hidden.isError, tool).toBe(true);
      expect(hidden.text, tool).toBe(absent.text);
      expect(hidden.text, tool).toContain('No work with that id is visible to this principal.');
      expect(await spent(), tool).toBe(before);
    }

    // The project a tool names is checked by the grant before anything is read.
    const otherProject = await call('list_work', { project: 'beta' }, token);
    expect(otherProject.isError).toBe(true);
    expect(otherProject.text).toContain('cannot access project "beta"');
  });

  it('files nothing through REST in a project outside the credential, in the words used for one that does not exist', async () => {
    // A workspace of somebody else's, with a project of its own.
    const outsider = jar();
    outsider.store(await form(`${srv.url}/auth/dev`, { username: 'outsider' }));
    await form(`${srv.url}/app/teams`, { name: 'Other Doors' }, outsider.header());
    await form(`${srv.url}/app/projects`, { team: 'other-doors', project: 'gamma' }, outsider.header());
    const [gamma] = await srv.db.select().from(projects).where(eq(projects.name, 'gamma'));
    expect(gamma, 'the other workspace has its project').toBeTruthy();
    const body = () => ({ request_id: randomUUID(), contract: { title: 'Out of reach', goal: 'Never filed.' } });
    const before = (await srv.db.select({ n: count() }).from(workItems))[0]!.n;

    for (const [token, foreign] of [
      [agents.alpha!.token, betaId],
      [agents.alpha!.token, gamma!.id],
      [agents.team!.token, gamma!.id],
    ] as const) {
      const hidden = await rest(token, 'POST', `/api/agent/projects/${foreign}/work`, body());
      const absent = await rest(token, 'POST', `/api/agent/projects/${randomUUID()}/work`, body());
      expect(hidden.status).toBe(404);
      expect(hidden.text).toBe(absent.text);
    }
    expect((await srv.db.select({ n: count() }).from(workItems))[0]!.n).toBe(before);
    // Nothing was reserved or locked for a project the caller cannot see.
    expect(await srv.db.select().from(workProjectCounters).where(eq(workProjectCounters.projectId, gamma!.id))).toHaveLength(0);
  });

  it('answers a command, a delivery and evidence for a work out of reach as missing, with a request id it already used', async () => {
    const elsewhere = await leadDraft('beta');
    const missing = randomUUID();
    const token = agents.alpha!.token;
    // A request id this credential's own receipt holds: a draft it filed.
    const used = randomUUID();
    const filed = await rest(token, 'POST', `/api/agent/projects/${alphaId}/work`, {
      request_id: used,
      contract: { title: 'Holds the request id', goal: 'A receipt of its own.' },
    });
    expect(filed.status, filed.text).toBe(200);
    for (const [door, body] of [
      ['commands', { request_id: used, expected_version: '1', operation: 'set_blocker', payload: { kind: 'other', reason: 'Reach.', next_action: 'None.' } }],
      ['deliveries', { request_id: used, expected_version: '1', spec_revision: 1, artifacts: [{ kind: 'file', name: 'reach.txt', sha256: 'a'.repeat(64) }] }],
      [
        'evidence',
        { request_id: used, expected_version: '1', delivery_id: randomUUID(), criterion_id: 'c1', assertion: 'pass', source_kind: 'agent_report', source_ref: 'npm test' },
      ],
    ] as const) {
      // Read before the receipt: a reused id answered REQUEST_ID_REUSED for a
      // work that is real, where an id that names nothing answered NOT_FOUND.
      const hidden = await rest(token, 'POST', `/api/agent/work/${elsewhere.work_id}/${door}`, body);
      const absent = await rest(token, 'POST', `/api/agent/work/${missing}/${door}`, body);
      expect(hidden.status, door).toBe(404);
      expect(hidden.text, door).toBe(absent.text);
    }
    expect((await srv.db.select().from(workItems).where(eq(workItems.id, elsewhere.work_id)))[0]!.version).toBe(1n);
  });

  it('refuses a work id in any spelling but the one STMA issues', async () => {
    const draft = await leadDraft('alpha');
    const shouting = draft.work_id.toUpperCase().replace(/-/g, '');
    const refused = await call('get_work', { work_id: shouting }, agents.alpha!.token);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('is not an id STMA issued');
  });

  it('lets a team credential name the project, and a work in it by key', async () => {
    const draft = await leadDraft('beta');
    const byKey = await call('get_work', { project: 'beta', key: draft.key }, agents.team!.token);
    expect(byKey.isError, byKey.text).toBe(false);
    expect(byKey.data).toMatchObject({ id: draft.work_id, project: { id: betaId } });
    const noProject = await call('list_work', {}, agents.team!.token);
    expect(noProject.data.error).toMatchObject({ code: 'INVALID_INPUT', fields: ['project'] });
  });
});

describe('no agent door records a decision', () => {
  it('has no accept operation, no decision route, and leaves the work where it was', async () => {
    const draft = await leadDraft('alpha');
    const token = agents.alpha!.token;
    for (const operation of ['accept', 'decision']) {
      const viaMcp = await call(
        'update_work',
        { request_id: randomUUID(), work_id: draft.work_id, expected_version: draft.version, operation, payload: {} },
        token,
      );
      expect(viaMcp.isError, operation).toBe(true);
      const viaRest = await rest(token, 'POST', `/api/agent/work/${draft.work_id}/commands`, {
        request_id: randomUUID(),
        expected_version: draft.version,
        operation,
        payload: {},
      });
      expect(viaRest.status, operation).toBe(400);
      expect(viaRest.data.error.code).toBe('INVALID_INPUT');
    }
    const decision = await rest(token, 'POST', `/api/agent/work/${draft.work_id}/decision`, {
      request_id: randomUUID(),
      decision: 'accept',
    });
    expect(decision.status).toBe(404);
    const [row] = await srv.db.select().from(workItems).where(eq(workItems.id, draft.work_id));
    expect(row!.state).toBe('draft');
    expect(row!.version).toBe(1n);
  });

  it('cannot write a provenance through evidence either', async () => {
    const draft = await leadDraft('alpha');
    const spoofed = await call(
      'record_work_evidence',
      {
        request_id: randomUUID(),
        work_id: draft.work_id,
        expected_version: draft.version,
        delivery_id: randomUUID(),
        criterion_id: 'c1',
        assertion: 'pass',
        source_kind: 'agent_report',
        source_ref: 'CI',
        provenance: 'provider_observed',
      },
      agents.alpha!.token,
    );
    expect(spoofed.isError).toBe(true);
    expect(spoofed.text).toContain('Unknown parameter "provenance"');
    const viaRest = await rest(agents.alpha!.token, 'POST', `/api/agent/work/${draft.work_id}/evidence`, {
      request_id: randomUUID(),
      expected_version: draft.version,
      delivery_id: randomUUID(),
      criterion_id: 'c1',
      assertion: 'pass',
      source_kind: 'agent_report',
      source_ref: 'CI',
      provenance: 'provider_observed',
    });
    expect(viaRest.status).toBe(400);
    expect(viaRest.data.error.fields).toContain('input');
  });
});

describe('the context package', () => {
  /** A work item with more to say than a small budget holds. */
  async function heavyWork() {
    const longGoal = `Rework the parcel label flow. ${'Every step is spelled out here at length. '.repeat(60)}`.trim();
    const paths = Array.from({ length: 40 }, (_, index) => `src/parcels/labels/printer-${index}/a-rather-long-module-path.ts`);
    const created = ok(
      await createWork(srv.db, lead, {
        request_id: randomUUID(),
        project: 'alpha',
        contract: { title: 'Heavy work', goal: longGoal, non_goals: 'No new printers.', artifact_kind: 'code', scope: { paths } },
        criteria: Array.from({ length: 8 }, (_, index) => ({ text: `Criterion ${index}: ${'a careful sentence. '.repeat(10)}` })),
        acceptor: 'bob',
      }),
    );
    const reason = `The label printer vendor has not answered. ${'They were asked twice. '.repeat(20)}`.trim();
    const blocked = ok(
      await updateWork(srv.db, lead, {
        request_id: randomUUID(),
        work_id: created.work_id,
        expected_version: created.version,
        operation: 'set_blocker',
        payload: { kind: 'external', reason, next_action: 'Wait for the vendor.' },
      }),
    );
    return { id: created.work_id, version: blocked.version, longGoal, paths, reason };
  }

  /** Read every page; return the pages and the content merged the way the units were built. */
  async function readAll(token: string, workId: string, args: Record<string, unknown>) {
    const pages: any[] = [];
    let continuation: string | undefined;
    for (let guard = 0; guard < 40; guard++) {
      const page = await call('get_work_context', { work_id: workId, ...args, ...(continuation ? { continuation } : {}) }, token);
      expect(page.isError, page.text).toBe(false);
      pages.push(page);
      continuation = page.data.continuation ?? undefined;
      if (!continuation) break;
    }
    const merged: Record<string, any> = {};
    for (const page of pages) {
      for (const [section, value] of Object.entries(page.data.content as Record<string, Record<string, unknown>>)) {
        const into = (merged[section] ??= {});
        for (const [key, entry] of Object.entries(value)) {
          if (Array.isArray(entry)) into[key] = [...(into[key] ?? []), ...entry];
          else if (entry && typeof entry === 'object' && !Array.isArray(entry) && into[key] && typeof into[key] === 'object') {
            for (const [inner, list] of Object.entries(entry as Record<string, unknown>)) {
              into[key][inner] = Array.isArray(list) ? [...(into[key][inner] ?? []), ...list] : list;
            }
          } else into[key] = entry;
        }
      }
    }
    return { pages, merged };
  }

  it('stays inside the budget, counts its own bytes, and never cuts an item', async () => {
    const heavy = await heavyWork();
    const token = agents.alpha!.token;
    const { pages, merged } = await readAll(token, heavy.id, { max_bytes: 4096 });
    expect(pages.length).toBeGreaterThan(2);
    for (const page of pages) {
      expect(Buffer.byteLength(page.text, 'utf8')).toBe(page.data.bytes);
      expect(page.data.bytes).toBeLessThanOrEqual(4096);
      expect(page.data.estimated_tokens).toBe(Math.ceil(page.data.bytes / 4));
      expect(page.data.estimate_method).toBe('utf8_bytes_div_4');
      expect(page.data.manifest).toMatchObject({ work_id: heavy.id, version: heavy.version, spec_revision: 1 });
      expect(page.data.manifest.content_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(page.data.scope.project.id).toBe(alphaId);
    }
    expect(pages[0].data.incomplete).toBe(true);
    expect(pages[0].data.omitted_sections.length).toBeGreaterThan(0);
    expect(pages.at(-1).data.incomplete).toBe(false);
    // Whole items: the goal and every path arrive exactly as stored, once each.
    expect(merged.contract.goal).toBe(heavy.longGoal);
    expect(merged.contract.scope.paths).toEqual(heavy.paths);
    expect(merged.criteria.items).toHaveLength(8);
    expect(merged.criteria.items[0].text).toMatch(/^Criterion 0: /);
    // The blocker carries its whole reason, not the graph's shortened one.
    expect(merged.blockers.open).toHaveLength(1);
    expect(merged.blockers.open[0].reason).toBe(heavy.reason);
    // The first page says there is a blocker whatever else fits on it.
    expect(pages[0].data.content.scope).toMatchObject({ blocked: true, open_blockers: 1 });
    // Each read is measured.
    const [reads] = await srv.db.select({ n: count() }).from(workContextReads).where(eq(workContextReads.workId, heavy.id));
    expect(reads!.n).toBe(pages.length);
  });

  it('says how much room an item that does not fit needs, stays inside the budget saying it, and moves on with that much', async () => {
    // A goal at the limit in a script of three UTF-8 bytes a character: one
    // item of 12,000 bytes, which no 4 KiB page can carry beside the fixed part.
    const goal = '漢'.repeat(WORK_LIMITS.goalChars);
    const wide = await leadDraft('alpha', { contract: { title: 'A goal wider than a page', goal, artifact_kind: 'code' } });
    const token = agents.alpha!.token;
    const first = await call('get_work_context', { work_id: wide.work_id, max_bytes: 4096 }, token);
    expect(first.isError, first.text).toBe(false);
    expect(first.data.incomplete).toBe(true);
    const stuck = await call('get_work_context', { work_id: wide.work_id, max_bytes: 4096, continuation: first.data.continuation }, token);
    expect(stuck.isError, stuck.text).toBe(false);
    // An empty page that says so: nothing in it, the same place to come back
    // to, and the two fields that explain it still inside the budget.
    expect(stuck.data.page).toMatchObject({ position: first.data.page.position + first.data.page.items, items: 0 });
    expect(stuck.data.content).toEqual({});
    expect(stuck.data.incomplete).toBe(true);
    expect(stuck.data.continuation).toBeTruthy();
    expect(stuck.data.next_item_bytes).toBeGreaterThan(4096);
    expect(Buffer.byteLength(stuck.text, 'utf8')).toBe(stuck.data.bytes);
    expect(stuck.data.bytes).toBeLessThanOrEqual(4096);
    const needed = Number(/max_bytes of at least (\d+)/.exec(stuck.data.next_action)?.[1]);
    expect(needed).toBeGreaterThan(stuck.data.next_item_bytes);
    // Asked again with exactly that much, the reader gets the item: never the same empty page.
    const moved = await call('get_work_context', { work_id: wide.work_id, max_bytes: needed, continuation: stuck.data.continuation }, token);
    expect(moved.isError, moved.text).toBe(false);
    expect(moved.data.page.items).toBeGreaterThanOrEqual(1);
    expect(moved.data.content.contract.goal).toBe(goal);
    expect(moved.data.bytes).toBeLessThanOrEqual(needed);
    expect(moved.data.next_action).toBeUndefined();
  });

  it('sends nothing over the budget when the fixed part leaves no room to say what does not fit', async () => {
    const goal = '漢'.repeat(WORK_LIMITS.goalChars);
    const wide = await leadDraft('alpha', { contract: { title: 'A fixed part near the budget', goal, artifact_kind: 'code' } });
    const token = agents.alpha!.token;
    const ask = (max: number, continuation?: string) =>
      call('get_work_context', { work_id: wide.work_id, max_bytes: max, ...(continuation ? { continuation } : {}) }, token);
    const first = await ask(4096);
    const continuation = first.data.continuation as string;
    const stuck = await ask(4096, continuation);
    expect(stuck.data.page.items).toBe(0);
    // The two fields that say what does not fit, as they sit in the reply.
    const notice =
      Buffer.byteLength(JSON.stringify({ next_item_bytes: stuck.data.next_item_bytes, next_action: stuck.data.next_action }), 'utf8') - 1;
    const [row] = await srv.db.select().from(projects).where(eq(projects.id, alphaId));
    const name = row!.name;
    // The project's name is in the fixed part (the scope and the grant's
    // label), so a longer one grows it without touching the page's items.
    const rename = (extra: number) => srv.db.update(projects).set({ name: `${name}${'x'.repeat(extra)}` }).where(eq(projects.id, alphaId));
    try {
      await rename(100);
      const grown = await ask(4096, continuation);
      const perChar = (grown.data.bytes - stuck.data.bytes) / 100;
      expect(perChar).toBeGreaterThan(0);
      // Room for the fixed part, and half the sentence about the next item short.
      const extra = Math.floor((4096 - (stuck.data.bytes - notice) - Math.floor(notice / 2)) / perChar);
      for (const grow of [extra, extra + notice]) {
        await rename(grow);
        const squeezed = await ask(4096, continuation);
        expect(Buffer.byteLength(squeezed.text, 'utf8'), `grown by ${grow}`).toBeLessThanOrEqual(4096);
        expect(squeezed.data.error).toMatchObject({ code: 'INVALID_INPUT', fields: ['max_bytes'] });
        const room = Number(/max_bytes of at least (\d+)/.exec(squeezed.data.error.next_action)?.[1]);
        expect(room).toBeGreaterThan(4096);
        // Asked again with that much and the same continuation, the reader moves on.
        const moved = await ask(room, continuation);
        expect(moved.isError, moved.text).toBe(false);
        expect(moved.data.page.items).toBeGreaterThanOrEqual(1);
        expect(moved.data.content.contract.goal).toBe(goal);
        expect(moved.data.bytes).toBeLessThanOrEqual(room);
      }
    } finally {
      await srv.db.update(projects).set({ name }).where(eq(projects.id, alphaId));
    }
  });

  it('keeps scope and blockers whatever sections are asked for, and fits the default budget', async () => {
    const heavy = await heavyWork();
    const narrow = await call('get_work_context', { work_id: heavy.id, sections: ['active'] }, agents.alpha!.token);
    expect(narrow.isError, narrow.text).toBe(false);
    expect(narrow.data.manifest.sections).toEqual(['scope', 'blockers', 'active']);
    expect(narrow.data.content.blockers.open[0].reason).toBe(heavy.reason);
    expect(narrow.data.content.contract).toBeUndefined();
    expect(narrow.data.bytes).toBeLessThanOrEqual(12 * 1024);
  });

  it('starts again, and says so, when the work moved under a continuation', async () => {
    const heavy = await heavyWork();
    const token = agents.alpha!.token;
    const first = await call('get_work_context', { work_id: heavy.id, max_bytes: 4096 }, token);
    expect(first.data.continuation).toBeTruthy();
    ok(
      await updateWork(srv.db, lead, {
        request_id: randomUUID(),
        work_id: heavy.id,
        expected_version: heavy.version,
        operation: 'patch',
        payload: { coordination: { priority: 'urgent' } },
      }),
    );
    const next = await call('get_work_context', { work_id: heavy.id, max_bytes: 4096, continuation: first.data.continuation }, token);
    expect(next.data.restarted).toContain('fresh first page');
    expect(next.data.page.position).toBe(0);
    const foreign = await call('get_work_context', { work_id: (await leadDraft('alpha')).work_id, continuation: first.data.continuation }, token);
    expect(foreign.data.error).toMatchObject({ code: 'INVALID_INPUT', fields: ['continuation'] });
  });

  it('carries a continuation past a heartbeat of the run doing the work, and still shows the heartbeat', async () => {
    const heavy = await heavyWork();
    const token = agents.alpha!.token;
    // Ready, and taken: a run of the reading agent is linked to it, which is
    // the package an agent reads about its own work.
    ok(
      await updateWork(srv.db, lead, {
        request_id: randomUUID(),
        work_id: heavy.id,
        expected_version: heavy.version,
        operation: 'resolve_blocker',
        payload: { blocker_id: (await srv.db.select().from(workBlockers).where(eq(workBlockers.workId, heavy.id)))[0]!.id, reason: 'The vendor answered.' },
      }),
    );
    const row = (await srv.db.select().from(workItems).where(eq(workItems.id, heavy.id)))[0]!;
    ok(
      await updateWork(srv.db, lead, {
        request_id: randomUUID(),
        work_id: heavy.id,
        expected_version: row.version.toString(),
        operation: 'transition',
        payload: { to: 'ready' },
      }),
    );
    const started = await call(
      'start_run',
      { request_id: randomUUID(), repository_identity: REPO, task: 'CTX-1', work_id: heavy.id, expected_spec_revision: 1 },
      token,
    );
    expect(started.isError, started.text).toBe(false);
    const runId = started.data.runId as string;
    try {
      const first = await call('get_work_context', { work_id: heavy.id, max_bytes: 4096 }, token);
      expect(first.data.continuation).toBeTruthy();
      // The agent's hook beats on its next tool call, between the two pages.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const beat = await call('update_run', { run_id: runId, status: 'active' }, token);
      expect(beat.isError, beat.text).toBe(false);
      const next = await call('get_work_context', { work_id: heavy.id, max_bytes: 4096, continuation: first.data.continuation }, token);
      expect(next.isError, next.text).toBe(false);
      expect(next.data.restarted).toBeUndefined();
      expect(next.data.page.position).toBe(first.data.page.position + first.data.page.items);
      expect(next.data.manifest.content_hash).toBe(first.data.manifest.content_hash);
      // The run itself, read whole, carries the heartbeat as it is now.
      const active = await call('get_work_context', { work_id: heavy.id, sections: ['active'] }, token);
      const [linked] = active.data.content.active.linked_runs;
      expect(linked).toMatchObject({ run_id: runId });
      const [run] = await srv.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
      expect(linked.last_heartbeat_at).toBe(run!.lastHeartbeatAt!.toISOString());
    } finally {
      await call('finish_run', { run_id: runId }, token);
    }
  });

  it('answers the same through REST, and refuses a budget outside 4 to 32 KiB', async () => {
    const heavy = await heavyWork();
    const token = agents.alpha!.token;
    const viaMcp = await call('get_work_context', { work_id: heavy.id, max_bytes: 8192 }, token);
    const viaRest = await rest(token, 'GET', `/api/agent/work/${heavy.id}/context?max_bytes=8192`);
    expect(viaRest.status).toBe(200);
    expect(withoutTime(viaRest.data)).toEqual(withoutTime(viaMcp.data));
    expect(Buffer.byteLength(viaRest.text, 'utf8')).toBe(viaRest.data.bytes);
    const tooSmall = await rest(token, 'GET', `/api/agent/work/${heavy.id}/context?max_bytes=1000`);
    expect(tooSmall.status).toBe(400);
    expect(tooSmall.data.error).toMatchObject({ code: 'INVALID_INPUT', fields: ['max_bytes'] });
    const direct = await getWorkContext(srv.db, agents.alpha!.principal, heavy.id, { maxBytes: 40_000 });
    expect((direct as { error?: { code?: string } }).error?.code).toBe('INVALID_INPUT');
  });

  it('names a Knowledge pointer only as far as this principal may read it', async () => {
    const created = ok(
      await createWork(srv.db, lead, {
        request_id: randomUUID(),
        project: 'alpha',
        contract: {
          title: 'Pointers',
          goal: 'Read the runbook.',
          artifact_kind: 'document',
          context_refs: [
            { kind: 'knowledge', key: 'runbooks/nobody-wrote-this' },
            { kind: 'document', uri: 'https://docs.example.com/runbook', version: 'v3' },
            { kind: 'policy' },
          ],
        },
        criteria: [{ text: 'Done.' }],
      }),
    );
    const context = await call('get_work_context', { work_id: created.work_id }, agents.alpha!.token);
    expect(context.data.content.sources.knowledge).toEqual([
      { key: 'runbooks/nobody-wrote-this', readable: false, current_version_id: null },
    ]);
    expect(context.data.content.sources.documents[0]).toMatchObject({ uri: 'https://docs.example.com/runbook', version: 'v3' });
    expect(context.data.manifest.knowledge_version_ids).toEqual([]);
    expect(context.data.manifest.policy).toMatchObject({ hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it('names a readable Knowledge record as current, one this credential may not read as unreadable, and says whether a pinned version is current', async () => {
    const leadId = (lead as { userId: string }).userId;
    const publish = async (stableKey: string, body: string, audience: Record<string, unknown>) => {
      const proposed = await proposeKnowledge(srv.db, leadId, {
        team: 'work-doors',
        stableKey,
        kind: 'procedure',
        title: `Title ${stableKey}`,
        body,
        audience,
        source: { type: 'native' },
      } as never);
      if ('error' in proposed) throw new Error(String(proposed.error));
      const published = await publishKnowledge(srv.db, leadId, {
        team: 'work-doors',
        itemId: proposed.draft.itemId,
        draftVersionId: proposed.draft.versionId,
        expectedCurrentVersionId: proposed.draft.expectedCurrentVersionId,
      });
      if ('error' in published) throw new Error(String(published.error));
      return published.published;
    };
    const shared = await publish('runbooks/labels', 'How labels print.', { type: 'selected_projects', projects: ['alpha'] });
    const betaOnly = await publish('runbooks/beta-only', 'Only for beta.', { type: 'selected_projects', projects: ['beta'] });
    const everyone = await publish('runbooks/everyone', 'For the whole workspace.', { type: 'workspace_members' });
    const pinnedFirst = await publish('runbooks/pinned', 'The first word on it.', { type: 'selected_projects', projects: ['alpha'] });
    const pinnedNow = await publish('runbooks/pinned', 'The word on it now.', { type: 'selected_projects', projects: ['alpha'] });
    expect(pinnedNow.versionId).not.toBe(pinnedFirst.versionId);

    const created = ok(
      await createWork(srv.db, lead, {
        request_id: randomUUID(),
        project: 'alpha',
        contract: {
          title: 'Pointers that resolve',
          goal: 'Read the runbooks.',
          artifact_kind: 'document',
          context_refs: [
            { kind: 'knowledge', key: 'runbooks/labels' },
            { kind: 'knowledge', key: 'runbooks/beta-only' },
            { kind: 'knowledge', key: 'runbooks/everyone' },
            { kind: 'knowledge', key: 'runbooks/pinned', version_id: pinnedFirst.versionId },
          ],
        },
        criteria: [{ text: 'Done.' }],
      }),
    );
    const context = await call('get_work_context', { work_id: created.work_id }, agents.alpha!.token);
    expect(context.isError, context.text).toBe(false);
    const pointers = context.data.content.sources.knowledge as Record<string, unknown>[];
    const of = (key: string) => pointers.find((pointer) => pointer.key === key);
    expect(of('runbooks/labels')).toEqual({ key: 'runbooks/labels', readable: true, current_version_id: shared.versionId });
    // Addressed to another project: this alpha credential is never told it is current.
    expect(of('runbooks/beta-only')).toEqual({ key: 'runbooks/beta-only', readable: false, current_version_id: null });
    // A project credential is narrower than its owner: a workspace-wide record is
    // not served to it, so it is not named as current to it either.
    expect(of('runbooks/everyone')).toEqual({ key: 'runbooks/everyone', readable: false, current_version_id: null });
    expect(of('runbooks/pinned')).toEqual({
      key: 'runbooks/pinned',
      readable: true,
      current_version_id: pinnedNow.versionId,
      pinned_version_id: pinnedFirst.versionId,
      pinned_is_current: false,
    });
    const versions = context.data.manifest.knowledge_version_ids as string[];
    expect(versions).toEqual(expect.arrayContaining([shared.versionId, pinnedNow.versionId]));
    expect(versions).not.toContain(betaOnly.versionId);
    expect(versions).not.toContain(everyone.versionId);
    // A team credential reads the workspace-wide record, and not the one addressed to beta.
    const asTeam = await call('get_work_context', { work_id: created.work_id }, agents.team!.token);
    const teamPointers = asTeam.data.content.sources.knowledge as Record<string, unknown>[];
    expect(teamPointers.find((pointer) => pointer.key === 'runbooks/everyone')).toEqual({
      key: 'runbooks/everyone',
      readable: true,
      current_version_id: everyone.versionId,
    });
    expect(teamPointers.find((pointer) => pointer.key === 'runbooks/beta-only')).toMatchObject({ readable: false });
    // The beta credential reads the record addressed to it.
    const asBeta = await call('get_work_context', { work_id: (await leadDraft('beta', {
      contract: { title: 'Beta pointer', goal: 'Read it.', artifact_kind: 'document', context_refs: [{ kind: 'knowledge', key: 'runbooks/beta-only' }] },
    })).work_id }, agents.beta!.token);
    expect(asBeta.data.content.sources.knowledge).toEqual([
      { key: 'runbooks/beta-only', readable: true, current_version_id: betaOnly.versionId },
    ]);
  });
});

describe('the daily allowance', () => {
  it('is charged to the workspace a work item lives in, like every other tool', async () => {
    const draft = await leadDraft('alpha');
    const spent = async () =>
      Number(
        (
          await srv.db
            .select({ n: sql<number>`coalesce(sum(${rateCounters.count}), 0)::int` })
            .from(rateCounters)
            .where(like(rateCounters.key, `team-day:${teamId}:%`))
        )[0]!.n,
      );
    const before = await spent();
    await call('get_work', { work_id: draft.work_id }, agents.alpha!.token);
    expect(await spent()).toBe(before + 1);
  });
});

// Keep the imports honest: the installation row is what the receipt is keyed on.
it('keys every agent receipt on the installation, so REST and MCP share one', async () => {
  const [installation] = await srv.db
    .select({ id: agentInstallations.id })
    .from(agentInstallations)
    .where(and(eq(agentInstallations.name, 'Codex Alpha')));
  expect(installation!.id).toBe(agents.alpha!.installationId);
});

describe('the hosted guardrails, through the doors', () => {
  // A hosted server of its own: the doors pass `env.hosted` to the domain, so
  // only a hosted server shows that they do. The helpers above read `srv` and
  // `leadCookie`, so this block points them at it and puts them back after.
  let saved: { srv: StartedServer; leadCookie: Record<string, string> };
  let hostedDir = '';
  let hostedTeam = '';
  let hostedAlpha = '';
  let hostedBeta = '';
  let hostedLead: WorkPrincipal;
  let agent: Agent;

  beforeAll(async () => {
    saved = { srv, leadCookie };
    hostedDir = mkdtempSync(path.join(tmpdir(), 'stma-work-mcp-hosted-'));
    srv = await startServer(
      loadEnv({
        port: 0,
        host: '127.0.0.1',
        nodeEnv: 'test',
        devMode: true,
        databaseUrl: undefined,
        pgliteDir: hostedDir,
        hosted: true,
        // Plans out of the way: what is measured is the engineering guardrail,
        // which a hosted server applies whatever a workspace pays.
        betaUnmetered: true,
      }),
    );
    const leadJar = jar();
    leadJar.store(await form(`${srv.url}/auth/dev`, { username: 'lead' }));
    leadCookie = leadJar.header();
    await form(`${srv.url}/app/teams`, { name: 'Hosted Doors' }, leadCookie);
    const [team] = await srv.db.select().from(teams).where(eq(teams.slug, 'hosted-doors'));
    hostedTeam = team!.id;
    const [alpha] = await srv.db.insert(projects).values({ teamId: hostedTeam, name: 'alpha', slug: 'alpha' }).returning();
    const [beta] = await srv.db.insert(projects).values({ teamId: hostedTeam, name: 'beta', slug: 'beta' }).returning();
    hostedAlpha = alpha!.id;
    hostedBeta = beta!.id;
    const [leadRow] = await srv.db.select({ id: users.id }).from(users).where(eq(users.username, 'lead'));
    hostedLead = humanPrincipal(leadRow!.id);
    agent = await connectAgent('Codex Hosted', 'cloud', `team:${hostedTeam}`);
  }, 120_000);

  afterAll(async () => {
    await srv?.close();
    srv = saved.srv;
    leadCookie = saved.leadCookie;
    rmSync(hostedDir, { recursive: true, force: true });
  });

  it('files the 5,000th work item of a project and refuses the next on MCP and REST, with the numbers', async () => {
    const leadId = (hostedLead as { userId: string }).userId;
    await srv.db.insert(workProjectCounters).values({ projectId: hostedAlpha, teamId: hostedTeam, nextWorkNumber: 5_000n });
    const filler = Array.from({ length: WORK_HOSTED_MAX_ITEMS_PER_PROJECT - 1 }, (_, index) => ({
      teamId: hostedTeam,
      projectId: hostedAlpha,
      number: BigInt(index + 1),
      displayKey: `WORK-${index + 1}`,
      createdByKind: 'human',
      createdById: leadId,
      createdByUserId: leadId,
    }));
    for (let at = 0; at < filler.length; at += 1_000) await srv.db.insert(workItems).values(filler.slice(at, at + 1_000));
    const create = () => ({ request_id: randomUUID(), project: 'alpha', contract: { title: 'One more', goal: 'Right at the line.' } });

    const last = await call('create_work', create(), agent.token);
    expect(last.isError, last.text).toBe(false);
    expect(last.data.key).toBe(`WORK-${WORK_HOSTED_MAX_ITEMS_PER_PROJECT}`);
    const limit = { code: 'LIMIT_EXCEEDED', used: WORK_HOSTED_MAX_ITEMS_PER_PROJECT, limit: WORK_HOSTED_MAX_ITEMS_PER_PROJECT };
    const overMcp = await call('create_work', create(), agent.token);
    expect(overMcp.isError).toBe(true);
    expect(overMcp.data.error).toMatchObject(limit);
    const overRest = await rest(agent.token, 'POST', `/api/agent/projects/${hostedAlpha}/work`, {
      request_id: randomUUID(),
      contract: { title: 'One more', goal: 'Past the line.' },
    });
    expect(overRest.status).toBe(WORK_ERROR_STATUS.LIMIT_EXCEEDED);
    expect(overRest.data.error).toMatchObject(limit);
    expect((await srv.db.select({ n: count() }).from(workItems).where(eq(workItems.projectId, hostedAlpha)))[0]!.n).toBe(
      WORK_HOSTED_MAX_ITEMS_PER_PROJECT,
    );
  });

  it('refuses the 201st delivery of a work and the 501st evidence row of a delivery on the agent doors', async () => {
    const created = ok(
      await createWork(srv.db, hostedLead, {
        request_id: randomUUID(),
        project: 'beta',
        contract: { title: 'Many deliveries', goal: 'Deliver often.', artifact_kind: 'document' },
        criteria: [{ text: 'It is there.' }],
        acceptor: 'lead',
      }),
    );
    const ready = ok(
      await updateWork(srv.db, hostedLead, {
        request_id: randomUUID(),
        work_id: created.work_id,
        expected_version: created.version,
        operation: 'transition',
        payload: { to: 'ready' },
      }),
    );
    // The agent is linked to the work through a run of its own.
    const [run] = await srv.db
      .insert(agentRuns)
      .values({ installationId: agent.installationId, teamId: hostedTeam, projectId: hostedBeta, status: 'active' })
      .returning();
    await srv.db.insert(workLinks).values({
      workId: created.work_id,
      teamId: hostedTeam,
      projectId: hostedBeta,
      kind: 'run',
      runId: run!.id,
      specRevision: 1,
      createdByKind: 'agent',
      createdById: agent.installationId,
    });
    await srv.db.insert(workDeliveries).values(
      Array.from({ length: WORK_HOSTED_MAX_DELIVERIES - 1 }, (_, index) => ({
        workId: created.work_id,
        specRevision: 1,
        sequence: 1_000 + index,
        artifacts: [],
        artifactSetHash: 'filler',
        submittedByKind: 'agent',
        submittedById: agent.installationId,
      })),
    );
    const submit = (version: string) => ({
      request_id: randomUUID(),
      work_id: created.work_id,
      expected_version: version,
      spec_revision: 1,
      artifacts: [{ kind: 'file', name: 'report.txt', sha256: 'b'.repeat(64) }],
    });
    const lastDelivery = await call('submit_work', submit(ready.version), agent.token);
    expect(lastDelivery.isError, lastDelivery.text).toBe(false);
    const overDeliveries = await call('submit_work', submit(lastDelivery.data.version), agent.token);
    expect(overDeliveries.data.error).toMatchObject({
      code: 'LIMIT_EXCEEDED',
      used: WORK_HOSTED_MAX_DELIVERIES,
      limit: WORK_HOSTED_MAX_DELIVERIES,
    });

    await srv.db.insert(workEvidence).values(
      Array.from({ length: WORK_HOSTED_MAX_EVIDENCE_PER_DELIVERY }, () => ({
        workId: created.work_id,
        deliveryId: lastDelivery.data.delivery_id as string,
        criterionId: 'c1',
        specRevision: 1,
        sourceKind: 'agent_report',
        sourceRef: 'filler',
        assertion: 'pass',
        provenance: 'agent_reported',
        reportedByKind: 'agent',
        reportedById: agent.installationId,
      })),
    );
    const evidence = {
      request_id: randomUUID(),
      work_id: created.work_id,
      expected_version: lastDelivery.data.version,
      delivery_id: lastDelivery.data.delivery_id,
      criterion_id: 'c1',
      assertion: 'pass',
      source_kind: 'agent_report',
      source_ref: 'npm test',
    };
    const overEvidence = await call('record_work_evidence', evidence, agent.token);
    expect(overEvidence.data.error).toMatchObject({
      code: 'LIMIT_EXCEEDED',
      used: WORK_HOSTED_MAX_EVIDENCE_PER_DELIVERY,
      limit: WORK_HOSTED_MAX_EVIDENCE_PER_DELIVERY,
    });
    const overRest = await rest(agent.token, 'POST', `/api/agent/work/${created.work_id}/evidence`, { ...evidence, request_id: randomUUID() });
    expect(overRest.status).toBe(WORK_ERROR_STATUS.LIMIT_EXCEEDED);
  });
});
