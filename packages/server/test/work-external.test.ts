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
  workAcceptances,
  workEvents,
  workExternalRefs,
  workItems,
  workRevisions,
} from '../src/db/schema';
import { loadEnv, type Env } from '../src/env';
import { startServer, type StartedServer } from '../src/server';
import { removeGithubIntegration, saveGithubIntegration } from '../src/domain/integrations';
import { createWork, updateWork } from '../src/domain/work';
import { recordDecision } from '../src/domain/workAcceptance';
import { readEvidence, submitDelivery } from '../src/domain/workEvidence';
import { duplicateRefusal, externalState } from '../src/domain/workExternal';
import { getWork } from '../src/domain/workRead';
import { agentPrincipal, humanPrincipal, type WorkPrincipal, type WorkResult } from '../src/domain/workTypes';
import { githubOutbox, type GithubIssue } from '../src/lib/github';
import { isTokenScope, type AgentGrant } from '../src/lib/grants';

/**
 * GitHub issues as an external reference, a source of truth or a one-time
 * import, driven through the domain functions with principals built from real
 * rows and through the console the way a browser drives it, against the GitHub
 * memory transport. What this file holds: the read happens before the command
 * and is judged inside it, so an older answer never replaces a newer one and an
 * equal update time with other content is a conflict for a person; a field the
 * issue owns cannot be changed here; accepted work is never reopened by a
 * tracker; a removed connection leaves the record readable and unavailable; one
 * issue is tied to one work item per workspace; and nothing is ever written to
 * GitHub, which the last test checks over everything the file did.
 */

let srv: StartedServer;
let env: Env;
let dataDir: string;
let teamId = '';
let alphaId = '';
let betaId = '';
let lead: WorkPrincipal;
let bob: WorkPrincipal;
let alphaAgent: WorkPrincipal;
let betaAgent: WorkPrincipal;
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

/** fetch, retried once on a connection-level failure: the runner shares one event loop with the server. */
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

type Fields = Record<string, string> | [string, string][];

const post = (url: string, fields: Fields, headers: Record<string, string> = {}) =>
  fetchRetrying(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(Array.isArray(fields) ? fields : Object.entries(fields)),
    redirect: 'manual',
  });

const page = async (urlPath: string, cookie: Record<string, string>) =>
  (await fetchRetrying(`${srv.url}${urlPath}`, { headers: cookie, redirect: 'manual' })).text();

const unescapeHtml = (value: string) =>
  value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** What a browser would submit for one form of a page: every named control, checked boxes and selected options only. */
function formFields(html: string, id: string): [string, string][] {
  const at = html.indexOf(`id="${id}"`);
  if (at < 0) throw new Error(`no form ${id} on the page`);
  const open = html.lastIndexOf('<form', at);
  const close = html.indexOf('</form>', at);
  const body = html.slice(open, close);
  const attrs = (tag: string): Record<string, string> =>
    Object.fromEntries([...tag.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map((m) => [m[1]!, unescapeHtml(m[2] ?? '')]));
  const out: [string, string][] = [];
  for (const m of body.matchAll(/<input\b([^>]*)>/g)) {
    const a = attrs(m[1]!);
    if (!a.name) continue;
    if (a.type === 'checkbox' || a.type === 'radio') {
      if ('checked' in a) out.push([a.name, a.value ?? 'on']);
      continue;
    }
    out.push([a.name, a.value ?? '']);
  }
  for (const m of body.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
    const a = attrs(m[1]!);
    if (a.name) out.push([a.name, unescapeHtml(m[2]!)]);
  }
  for (const m of body.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const a = attrs(m[1]!);
    if (!a.name) continue;
    const options = [...m[2]!.matchAll(/<option\b([^>]*)>/g)].map((o) => attrs(o[1]!));
    const chosen = options.find((o) => 'selected' in o) ?? options[0];
    if (chosen) out.push([a.name, chosen.value ?? '']);
  }
  return out;
}

function withFields(fields: [string, string][], changes: Record<string, string | null>): [string, string][] {
  const kept = fields.filter(([name]) => !(name in changes));
  return [...kept, ...Object.entries(changes).flatMap(([name, value]) => (value === null ? [] : [[name, value] as [string, string]]))];
}

let rpcId = 1;
async function whoami(token: string) {
  const res = await fetchRetrying(`${srv.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: 'whoami', arguments: {} } }),
  });
  expect(res.status).toBe(200);
}

async function connectAgent(name: string, device: string, access: string) {
  const html = await (await post(`${srv.url}/app/tokens`, { name, device, access, client: 'codex', role: 'generalist' }, leadCookie)).text();
  const code = /(?:&quot;|")STMA_ENROLLMENT_CODE(?:&quot;|")\s*:\s*(?:&quot;|")([^"&<]+)/.exec(html)?.[1];
  expect(code, `enrollment code for ${name}`).toMatch(/^stma_enroll_/);
  const redeemed = (await (
    await fetchRetrying(`${srv.url}/api/agent-enrollments/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
  ).json()) as { token: string };
  await whoami(redeemed.token);
  return redeemed.token;
}

/** The grant `mcpAuth` would attach to a request carrying this token, read from the rows. */
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

// ---------------------------------------------------------------------------
// What GitHub answers, kept as a map so a test changes one issue and keeps the rest.
// ---------------------------------------------------------------------------

const issues = new Map<number, GithubIssue>();
/** An update time, minutes after a fixed instant, in the format GitHub sends. */
const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 10, 0) + minute * 60_000).toISOString().replace('.000Z', 'Z');

function seedIssue(number: number, change: Partial<GithubIssue>) {
  issues.set(number, {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/acme/alpha/issues/${number}`,
    labels: [],
    updatedAt: at(0),
    body: '',
    state: 'open',
    ...issues.get(number),
    ...change,
  });
  githubOutbox.seedIssues([...issues.values()]);
}

const reads = () => githubOutbox.all().filter((call) => call.method === 'GET').length;
const writes = () => githubOutbox.all().filter((call) => call.method !== 'GET');

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-work-external-'));
  env = loadEnv({ port: 0, host: '127.0.0.1', nodeEnv: 'test', devMode: true, databaseUrl: undefined, pgliteDir: dataDir });
  srv = await startServer(env);
  githubOutbox.clear();
  const signIn = async (username: string) => {
    const j = jar();
    j.store(await post(`${srv.url}/auth/dev`, { username }));
    return j.header();
  };
  leadCookie = await signIn('lead');
  await post(`${srv.url}/app/teams`, { name: 'Work External' }, leadCookie);
  const [team] = await srv.db.select().from(teams).where(eq(teams.slug, 'work-external'));
  teamId = team!.id;
  await post(`${srv.url}/app/projects`, { team: 'work-external', project: 'alpha' }, leadCookie);
  await post(`${srv.url}/app/projects`, { team: 'work-external', project: 'beta' }, leadCookie);
  const rows = await srv.db.select().from(projects).where(eq(projects.teamId, teamId));
  alphaId = rows.find((p) => p.name === 'alpha')!.id;
  betaId = rows.find((p) => p.name === 'beta')!.id;

  await post(`${srv.url}/app/teams/work-external/invites`, {}, leadCookie);
  const people = await page('/app/teams/work-external?tab=people', leadCookie);
  const invite = /\/join\/([A-Za-z0-9_-]+)/.exec(people)?.[1] ?? '';
  expect(invite, 'invite code').toBeTruthy();
  await post(`${srv.url}/join/${invite}`, {}, await signIn('bob'));

  lead = humanPrincipal(await userId('lead'));
  bob = humanPrincipal(await userId('bob'));
  alphaAgent = await principalForToken(await connectAgent('codex-alpha', 'mac', `project:${alphaId}`));
  betaAgent = await principalForToken(await connectAgent('codex-beta', 'win', `project:${betaId}`));

  // One repository connected, named like the project, so `#42` in alpha means acme/alpha.
  await saveGithubIntegration(srv.db, {
    teamId,
    userId: await userId('lead'),
    repo: 'acme/alpha',
    token: 'ghp-work-external-fixture',
    commentOnFinish: false,
  });
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
  return (result as { error: { code: string; message: string; fields?: string[]; next_action?: string; retryable: boolean } }).error;
};

const latest = async (id: string) => (await srv.db.select().from(workItems).where(eq(workItems.id, id)))[0]!;
const countWork = async () => (await srv.db.select({ id: workItems.id }).from(workItems)).length;
const refsOf = async (workId: string) =>
  srv.db.select().from(workExternalRefs).where(eq(workExternalRefs.workId, workId)).orderBy(asc(workExternalRefs.createdAt));
const liveRef = async (workId: string) => (await refsOf(workId)).find((ref) => ref.detachedAt === null)!;
const revisionOf = async (workId: string, revision: number) =>
  (await srv.db
    .select()
    .from(workRevisions)
    .where(and(eq(workRevisions.workId, workId), eq(workRevisions.revision, revision))))[0]!;

/** One more command on a work, at whatever version it is now. */
async function command(who: WorkPrincipal, id: string, operation: string, payload: Record<string, unknown>, requestId = randomUUID()) {
  const row = await latest(id);
  return updateWork(
    srv.db,
    who,
    { request_id: requestId, work_id: id, expected_version: row.version.toString(), operation, payload } as never,
    { env },
  );
}

const reconcile = (who: WorkPrincipal, id: string, payload: Record<string, unknown>) =>
  command(who, id, 'reconcile_external', payload);

/** File a draft from an issue, as the lead, in alpha unless said otherwise. */
const fromIssue = (issue: string, mode: string, extra: Record<string, unknown> = {}, requestId = randomUUID()) =>
  createWork(
    srv.db,
    lead,
    { request_id: requestId, project: 'alpha', contract: {}, external: { issue, mode }, ...extra },
    { teamId, env },
  );

/** The work as get_work's detail answers it, with the external section. */
const detail = async (who: WorkPrincipal, id: string) =>
  ok(await getWork(srv.db, who, id, { view: 'detail', sections: ['external', 'contract'] })) as any;

/** A contract a person can accept on a human check against a versioned document. */
const acceptable = {
  contract: { artifact_kind: 'document' },
  criteria: [{ id: 'looked', text: 'A person read the label copy.', evidence_kinds: ['human_check'] }],
  acceptor: 'bob',
};

/** Ready, delivered by a person, accepted by the acceptor on a human check. */
async function acceptIt(id: string) {
  ok(await command(lead, id, 'transition', { to: 'ready' }));
  const row = await latest(id);
  ok(
    await submitDelivery(srv.db, lead, {
      request_id: randomUUID(),
      work_id: id,
      expected_version: row.version.toString(),
      spec_revision: row.specRevision,
      artifacts: [{ kind: 'document', uri: 'https://docs.example/label-copy', version_id: 'v1' }],
    }),
  );
  const seen = ok(await readEvidence(srv.db, bob, id)) as any;
  return ok(
    await recordDecision(srv.db, bob, id, {
      request_id: randomUUID(),
      expected_version: seen.version,
      spec_revision: seen.spec_revision,
      delivery_id: seen.delivery_id,
      evidence_epoch: seen.evidence_epoch,
      evidence_manifest_hash: seen.evidence_manifest_hash,
      decision: 'accept',
      human_checks: [{ criterion_id: 'looked', assertion: 'pass', artifact_ref: 'artifacts[0]', note: 'Read the copy.' }],
    }),
  );
}

describe('tying new work to a GitHub issue', () => {
  it('files a reference from #number, filling only what was not typed, and shows the issue as GitHub said it', async () => {
    seedIssue(1, { title: 'Label printer jams on 4x6', body: 'Steps:\r\nprint a 4x6 label.\r\n', updatedAt: at(1), labels: ['bug'], assignees: ['octo'] });
    const created = ok(await fromIssue('#1', 'reference', { contract: { title: 'Fix the jam' } }));
    const row = await latest(created.work_id);
    expect(row.origin).toBe('native');
    const revision = await revisionOf(created.work_id, 1);
    // Typed title kept; the goal the person left out came from the issue, line breaks plain.
    expect(revision).toMatchObject({ title: 'Fix the jam', goal: 'Steps:\nprint a 4x6 label.', source: 'native' });

    const ref = await liveRef(created.work_id);
    expect(ref).toMatchObject({
      provider: 'github',
      mode: 'reference',
      remoteId: 'acme/alpha#1',
      connectionLocator: 'acme/alpha',
      remoteRevision: at(1),
      remoteUrl: 'https://github.com/acme/alpha/issues/1',
      syncState: 'current',
    });

    const read = await detail(lead, created.work_id);
    expect(read.sections.external.items[0]).toMatchObject({
      mode: 'reference',
      sync_state: 'current',
      connection_available: true,
      owned_fields: [],
      remote: { title: 'Label printer jams on 4x6', body: 'Steps:\nprint a 4x6 label.', state: 'open', labels: ['bug'], assignees: ['octo'] },
      pending: null,
    });
    expect(read.next_actions).toContain('reconcile_external');
    const events = await srv.db.select().from(workEvents).where(eq(workEvents.workId, created.work_id));
    expect(events.map((event) => event.type).sort()).toEqual(['work_created', 'work_external_attached']);
  });

  it('refuses a bare number, a repository with no connection and a pull request, and files nothing', async () => {
    seedIssue(2, { title: 'Bump the printer driver', pullRequest: true, updatedAt: at(2) });
    const before = await countWork();
    const bare = refusal(await fromIssue('2', 'reference'));
    expect(bare).toMatchObject({ code: 'INVALID_INPUT', fields: ['external.issue'] });
    const unconnected = refusal(await fromIssue('other/repo#1', 'reference'));
    expect(unconnected.code).toBe('INVALID_INPUT');
    expect(unconnected.message).toContain('no GitHub connection for other/repo');
    const pull = refusal(await fromIssue('https://github.com/acme/alpha/issues/2', 'reference'));
    expect(pull.code).toBe('INVALID_INPUT');
    expect(pull.message).toContain('pull request');
    expect(pull.fields).toEqual(['external.issue']);
    // A native create still needs its title; only a tracker may supply one.
    const untitled = refusal(await createWork(srv.db, lead, { request_id: randomUUID(), project: 'alpha', contract: {} }, { teamId }));
    expect(untitled.fields).toEqual(['contract.title']);
    expect(await countWork()).toBe(before);
  });

  it('makes the issue the source of truth for the title and goal, and refuses a typed title that says something else', async () => {
    seedIssue(3, { title: 'Print labels from the order page', body: 'A paid order gets a label.', updatedAt: at(3) });
    const contradicted = refusal(await fromIssue('acme/alpha#3', 'external_authoritative', { contract: { title: 'My own title' } }));
    expect(contradicted).toMatchObject({ code: 'FIELD_OWNED_EXTERNALLY', fields: ['contract.title'] });
    expect(contradicted.next_action).toContain('https://github.com/acme/alpha/issues/3');

    const created = ok(await fromIssue('acme/alpha#3', 'external_authoritative', acceptable));
    const row = await latest(created.work_id);
    expect(row.origin).toBe('external');
    expect(await revisionOf(created.work_id, 1)).toMatchObject({
      title: 'Print labels from the order page',
      goal: 'A paid order gets a label.',
      source: 'external',
    });
    const read = await detail(lead, created.work_id);
    expect(read.sections.external.items[0].owned_fields).toEqual(['contract.title', 'contract.goal']);
  });

  it('refuses an agent before reading anything, on create and on an existing work', async () => {
    seedIssue(4, { title: 'Agent-filed issue', body: 'Body.', updatedAt: at(4) });
    const before = reads();
    const filed = refusal(
      await createWork(
        srv.db,
        alphaAgent,
        { request_id: randomUUID(), project: alphaId, contract: {}, external: { issue: '#4', mode: 'reference' } },
        { env },
      ),
    );
    expect(filed).toMatchObject({ code: 'FORBIDDEN', fields: ['external'] });

    const native = ok(
      await createWork(srv.db, lead, { request_id: randomUUID(), project: 'alpha', contract: { title: 'Native draft' } }, { teamId }),
    );
    const attach = refusal(await reconcile(alphaAgent, native.work_id, { action: 'attach', issue: '#4' }));
    expect(attach.code).toBe('FORBIDDEN');
    expect(reads()).toBe(before);
    expect(await refsOf(native.work_id)).toHaveLength(0);
  });

  it('holds the connection it checked until the record naming it is written, so a disconnect cannot come between', async () => {
    seedIssue(5, { title: 'Held connection', body: 'Body.', updatedAt: at(5) });
    const { value, transactions } = await traced(() => fromIssue('#5', 'reference'));
    ok(value);
    const command = transactions.find((statements) => statements.some(insertsRef))!;
    const read = command
      .slice(0, command.findIndex(insertsRef))
      .filter((text) => /from "team_integrations"/.test(text))
      .at(-1);
    // `for key share` is the lock the insert's foreign key check takes: a
    // disconnect's delete waits on it, where an unlocked read let the delete
    // commit first and the insert then failed on the foreign key, a 500.
    expect(read).toMatch(/\bfor key share\b/);
  });
});

const insertsRef = (text: string) => /insert into "work_external_refs"/.test(text);

type PgliteClient = { transaction: (callback: (tx: any) => Promise<unknown>) => Promise<unknown> };

/**
 * Every statement each database transaction ran while `fn` ran, in order (the
 * same trace as work-links). PGlite is one connection, so a lock never waits
 * here; what can be read is which locks a transaction holds when it writes.
 */
async function traced<T>(fn: () => Promise<T>): Promise<{ value: T; transactions: string[][] }> {
  const client = (srv.db as unknown as { $client: PgliteClient }).$client;
  const original = client.transaction;
  const transactions: string[][] = [];
  client.transaction = (callback) =>
    original.call(client, (tx: any) => {
      const statements: string[] = [];
      transactions.push(statements);
      return callback(
        new Proxy(tx, {
          get(target, prop) {
            const value = Reflect.get(target, prop);
            if (prop === 'query' || prop === 'exec') {
              return (text: string, ...rest: unknown[]) => {
                statements.push(text);
                return value.call(target, text, ...rest);
              };
            }
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
      );
    });
  try {
    return { value: await fn(), transactions };
  } finally {
    client.transaction = original;
  }
}

describe('ordering and conflicts', () => {
  let workId = '';

  it('ignores an older update and records a newer one, without touching a reference work', async () => {
    seedIssue(11, { title: 'Version A', body: 'First words.', updatedAt: at(10) });
    workId = ok(await fromIssue('#11', 'reference')).work_id;
    expect((await revisionOf(workId, 1)).title).toBe('Version A');

    // GitHub's API is eventually consistent: an answer older than the one held is stale.
    seedIssue(11, { title: 'Version that came first', updatedAt: at(5) });
    const older = ok(await reconcile(lead, workId, { action: 'refresh', ref_id: (await liveRef(workId)).id })) as any;
    expect(older.external.outcome).toBe('older_ignored');
    expect(await liveRef(workId)).toMatchObject({ remoteRevision: at(10), snapshot: expect.objectContaining({ title: 'Version A' }) });

    seedIssue(11, { title: 'Version B', updatedAt: at(20) });
    const newer = ok(await reconcile(lead, workId, { action: 'refresh', ref_id: (await liveRef(workId)).id })) as any;
    expect(newer.external.outcome).toBe('recorded');
    expect(await liveRef(workId)).toMatchObject({ remoteRevision: at(20), snapshot: expect.objectContaining({ title: 'Version B' }) });
    // A reference shows GitHub beside the work; the work's own contract is STMA's.
    expect((await latest(workId)).specRevision).toBe(1);
  });

  it('leaves the same update time with other content as a conflict, and takes it only when a person names it', async () => {
    seedIssue(11, { title: 'Version C', updatedAt: at(20) });
    const before = await latest(workId);
    const conflict = ok(await reconcile(lead, workId, { action: 'refresh', ref_id: (await liveRef(workId)).id })) as any;
    expect(conflict.external).toMatchObject({ outcome: 'conflict', sync_state: 'conflict', pending: { title: 'Version C', remote_revision: at(20) } });
    expect((await latest(workId)).version).toBe(before.version + 1n);
    const compact = ok(await getWork(srv.db, lead, workId)) as any;
    expect(compact.flags.external_change_pending).toBe(true);
    // Shown is still what was held before the conflict.
    expect((await liveRef(workId)).snapshot).toMatchObject({ title: 'Version B' });

    const wrong = refusal(await reconcile(lead, workId, { action: 'accept_remote', ref_id: (await liveRef(workId)).id, remote_revision: at(19) }));
    expect(wrong).toMatchObject({ code: 'INVALID_INPUT', fields: ['payload.remote_revision'] });
    ok(await reconcile(lead, workId, { action: 'accept_remote', ref_id: (await liveRef(workId)).id, remote_revision: at(20) }));
    expect(await liveRef(workId)).toMatchObject({ syncState: 'current', pendingRevision: null, snapshot: expect.objectContaining({ title: 'Version C' }) });
    expect(((await getWork(srv.db, lead, workId)) as any).flags.external_change_pending).toBe(false);
    expect((await revisionOf(workId, 1)).title).toBe('Version A');
  });
});

describe('field ownership', () => {
  let workId = '';

  it('refuses a local change to a field the issue owns, and lets the same value and every other field through', async () => {
    seedIssue(21, { title: 'Labels print', body: 'Make labels print.', updatedAt: at(30) });
    workId = ok(await fromIssue('#21', 'external_authoritative', acceptable)).work_id;

    const title = refusal(await command(lead, workId, 'patch', { contract: { title: 'Mine now' } }));
    expect(title).toMatchObject({ code: 'FIELD_OWNED_EXTERNALLY', fields: ['contract.title'] });
    expect(title.next_action).toContain('https://github.com/acme/alpha/issues/21');
    const goal = refusal(await command(lead, workId, 'patch', { contract: { goal: 'Other words.' } }));
    expect(goal).toMatchObject({ code: 'FIELD_OWNED_EXTERNALLY', fields: ['contract.goal'] });

    // What the console's contract form sends: every field, the owned ones unchanged.
    const sameValues = ok(
      await command(lead, workId, 'patch', { contract: { title: 'Labels print', goal: 'Make labels print.', non_goals: 'No reprinting.' } }),
    ) as any;
    expect(sameValues).toMatchObject({ revised: true, spec_revision: 2 });
    ok(await command(lead, workId, 'patch', { coordination: { priority: 'high' } }));
  });

  it('follows a newer issue as a new revision, and keeps ready work complete', async () => {
    seedIssue(21, { title: 'Labels print on the Zebra', updatedAt: at(31) });
    const followed = ok(await reconcile(lead, workId, { action: 'refresh', ref_id: (await liveRef(workId)).id })) as any;
    expect(followed.external.outcome).toBe('followed');
    expect(followed.spec_revision).toBe(3);
    expect(await revisionOf(workId, 3)).toMatchObject({ title: 'Labels print on the Zebra', source: 'external', nonGoals: 'No reprinting.' });

    ok(await command(lead, workId, 'transition', { to: 'ready' }));
    const before = await latest(workId);
    seedIssue(21, { body: '', updatedAt: at(32) });
    const incomplete = refusal(await reconcile(lead, workId, { action: 'refresh', ref_id: (await liveRef(workId)).id }));
    expect(incomplete).toMatchObject({ code: 'CONTRACT_INCOMPLETE', fields: ['contract.goal'] });
    expect((await latest(workId)).version).toBe(before.version);
    expect((await liveRef(workId)).remoteRevision).toBe(at(31));
  });

  it('sends a work whose issue has no description to the issue for its goal, not to a field it cannot patch', async () => {
    seedIssue(23, { title: 'Labels need a size', body: '', updatedAt: at(40) });
    const owned = ok(await fromIssue('#23', 'external_authoritative', acceptable)).work_id;
    const refused = refusal(await command(lead, owned, 'transition', { to: 'ready' }));
    expect(refused).toMatchObject({ code: 'CONTRACT_INCOMPLETE', fields: ['contract.goal'] });
    expect(refused.next_action).not.toContain('Patch the missing fields');
    expect(refused.next_action).toContain('GitHub issue acme/alpha#23');
    expect(refused.next_action).toContain('https://github.com/acme/alpha/issues/23');
    expect(refused.next_action).toContain('reconcile_external with action refresh');
    // The goal really is not the person's to patch here.
    expect(refusal(await command(lead, owned, 'patch', { contract: { goal: 'Our words.' } })).code).toBe('FIELD_OWNED_EXTERNALLY');
    // A reference owns nothing, so a missing goal there is patched here as ever.
    seedIssue(24, { title: 'Labels need a colour', body: '', updatedAt: at(41) });
    const referenced = ok(await fromIssue('#24', 'reference', acceptable)).work_id;
    const plain = refusal(await command(lead, referenced, 'transition', { to: 'ready' }));
    expect(plain).toMatchObject({ code: 'CONTRACT_INCOMPLETE', fields: ['contract.goal'] });
    expect(plain.next_action).toBe('Patch the missing fields, then move it to ready.');
  });

  it('gives the title and goal back to STMA when the issue becomes a reference', async () => {
    const converted = ok(await reconcile(lead, workId, { action: 'convert_to_reference', ref_id: (await liveRef(workId)).id })) as any;
    expect(converted.external).toMatchObject({ mode: 'reference', owned_fields: [] });
    expect((await latest(workId)).origin).toBe('native');
    ok(await command(lead, workId, 'patch', { contract: { title: 'Labels print, our words' } }));
  });
});

describe('accepted work', () => {
  it('waits for a person when the issue would change accepted work, and reopens only when told why', async () => {
    seedIssue(31, { title: 'Label copy', body: 'The label says where it goes.', updatedAt: at(40) });
    const workId = ok(await fromIssue('#31', 'external_authoritative', acceptable)).work_id;
    const decided = (await acceptIt(workId)) as any;
    expect(decided.state).toBe('accepted');
    const accepted = await latest(workId);
    const acceptanceId = accepted.currentAcceptanceId!;
    expect(acceptanceId).toBeTruthy();

    seedIssue(31, { title: 'Label copy, in two languages', updatedAt: at(41) });
    const waiting = ok(await reconcile(lead, workId, { action: 'refresh', ref_id: (await liveRef(workId)).id })) as any;
    expect(waiting.external).toMatchObject({ outcome: 'pending', sync_state: 'external_change_pending' });
    let row = await latest(workId);
    expect(row).toMatchObject({ state: 'accepted', currentAcceptanceId: acceptanceId, specRevision: accepted.specRevision });
    expect(((await getWork(srv.db, lead, workId)) as any).flags.external_change_pending).toBe(true);

    // A newer one replaces what was waiting; it is still waiting, and still accepted.
    seedIssue(31, { title: 'Label copy, in three languages', state: 'closed', updatedAt: at(42) });
    ok(await reconcile(lead, workId, { action: 'refresh', ref_id: (await liveRef(workId)).id }));
    row = await latest(workId);
    expect(row.state).toBe('accepted');
    expect((await liveRef(workId)).pendingRevision).toBe(at(42));

    const ref = await liveRef(workId);
    // Taking it reopens accepted work, so the form asks for the reason before it is sent.
    const detail = await page(`/app/teams/work-external/projects/alpha/work/${row.displayKey}`, leadCookie);
    expect(detail).toMatch(/<input[^>]*id="ext-accept-reason"[^>]*\srequired/);
    const noReason = refusal(await reconcile(lead, workId, { action: 'accept_remote', ref_id: ref.id, remote_revision: at(42) }));
    expect(noReason).toMatchObject({ code: 'INVALID_INPUT', fields: ['payload.reason'] });
    expect((await latest(workId)).state).toBe('accepted');

    const taken = ok(
      await reconcile(lead, workId, { action: 'accept_remote', ref_id: ref.id, remote_revision: at(42), reason: 'Marketing asked for three languages.' }),
    ) as any;
    expect(taken.state).toBe('in_progress');
    row = await latest(workId);
    expect(row.currentAcceptanceId).toBeNull();
    expect(await revisionOf(workId, row.specRevision)).toMatchObject({
      title: 'Label copy, in three languages',
      source: 'external',
      changeReason: 'Marketing asked for three languages.',
    });
    // The acceptance is history, not deleted; nothing reached GitHub either way.
    expect(await srv.db.select().from(workAcceptances).where(eq(workAcceptances.id, acceptanceId))).toHaveLength(1);
    expect(writes()).toEqual([]);
  });

  it('treats a closed issue as a fact about GitHub, never as a decision here', async () => {
    seedIssue(41, { title: 'Reprint button', body: 'Add a reprint button.', updatedAt: at(50) });
    const workId = ok(await fromIssue('#41', 'reference')).work_id;
    seedIssue(41, { state: 'closed', updatedAt: at(51) });
    ok(await reconcile(lead, workId, { action: 'refresh', ref_id: (await liveRef(workId)).id }));
    expect((await latest(workId)).state).toBe('draft');
    expect((await detail(lead, workId)).sections.external.items[0].remote.state).toBe('closed');
    expect(writes()).toEqual([]);
  });
});

describe('one issue, one work item, and leaving it', () => {
  it('refuses a second tie to one issue anywhere in the workspace, naming the holder only to someone who can see it', async () => {
    seedIssue(51, { title: 'Carrier rates', body: 'Show carrier rates.', updatedAt: at(60) });
    const holder = ok(await fromIssue('#51', 'reference'));
    const before = await countWork();
    const again = refusal(await fromIssue('https://github.com/acme/alpha/issues/51', 'imported_native'));
    expect(again).toMatchObject({ code: 'INVALID_INPUT', fields: ['external.issue'] });
    expect(again.message).toContain(holder.key);
    expect(await countWork()).toBe(before);

    const inBeta = ok(
      await createWork(srv.db, lead, { request_id: randomUUID(), project: 'beta', contract: { title: 'Rates in beta' } }, { teamId }),
    );
    const attached = refusal(await reconcile(lead, inBeta.work_id, { action: 'attach', issue: 'acme/alpha#51' }));
    expect(attached).toMatchObject({ code: 'INVALID_INPUT', fields: ['payload.issue'] });
    expect(attached.message).toContain(holder.key);

    // A credential scoped to beta cannot open the alpha work that holds it: no key, no next step.
    const hidden = await duplicateRefusal(srv.db, betaAgent, teamId, 'acme/alpha#51', 'payload.issue');
    expect(hidden?.message).not.toContain(holder.key);
    expect(hidden?.next_action).toBeUndefined();
    const named = await duplicateRefusal(srv.db, alphaAgent, teamId, 'acme/alpha#51', 'payload.issue');
    expect(named?.message).toContain(holder.key);
    expect(await refsOf(inBeta.work_id)).toHaveLength(0);
  });

  it('detaches with the history kept: a source of truth needs a reason, nothing is revised, and the issue can be tied again', async () => {
    seedIssue(61, { title: 'Pickup slots', body: 'Offer pickup slots.', updatedAt: at(70) });
    const workId = ok(await fromIssue('#61', 'external_authoritative')).work_id;
    const ref = await liveRef(workId);
    const noReason = refusal(await reconcile(lead, workId, { action: 'detach', ref_id: ref.id }));
    expect(noReason).toMatchObject({ code: 'INVALID_INPUT', fields: ['payload.reason'] });

    const revisionBefore = (await latest(workId)).specRevision;
    ok(await reconcile(lead, workId, { action: 'detach', ref_id: ref.id, reason: 'We plan this in STMA now.' }));
    const row = await latest(workId);
    expect(row).toMatchObject({ origin: 'native', specRevision: revisionBefore });
    expect((await refsOf(workId))[0]).toMatchObject({ syncState: 'detached', pendingRevision: null });
    expect((await refsOf(workId))[0]!.detachedAt).not.toBeNull();
    const detached = (await srv.db.select().from(workEvents).where(eq(workEvents.workId, workId))).find(
      (event) => event.type === 'work_external_detached',
    );
    expect(detached?.payload).toMatchObject({ reason: 'We plan this in STMA now.', mode: 'external_authoritative' });
    // A detached record refreshes nothing; the work's title is STMA's again.
    expect(refusal(await reconcile(lead, workId, { action: 'refresh', ref_id: ref.id })).code).toBe('INVALID_TRANSITION');
    ok(await command(lead, workId, 'patch', { contract: { title: 'Pickup slots, our words' } }));

    ok(await reconcile(lead, workId, { action: 'attach', issue: '#61', mode: 'reference' }));
    expect(await refsOf(workId)).toHaveLength(2);
    // History says what it was; only the live record carries the issue's text.
    const described = (await detail(lead, workId)).sections.external.items as any[];
    expect(described.find((item) => item.detached_at)!.remote).not.toHaveProperty('body');
    expect(described.find((item) => !item.detached_at)!.remote.body).toBe('Offer pickup slots.');
    const twice = refusal(await reconcile(lead, workId, { action: 'attach', issue: '#61' }));
    expect(twice.code).toBe('INVALID_TRANSITION');
  });

  it('copies an imported issue once and never reads it again until it becomes a reference', async () => {
    seedIssue(71, { title: 'Return labels', body: 'Print a return label.', updatedAt: at(80) });
    const workId = ok(await fromIssue('#71', 'imported_native')).work_id;
    expect((await latest(workId)).origin).toBe('native');
    expect(await revisionOf(workId, 1)).toMatchObject({ title: 'Return labels', goal: 'Print a return label.', source: 'external' });
    const ref = await liveRef(workId);
    const before = reads();
    const refused = refusal(await reconcile(lead, workId, { action: 'refresh', ref_id: ref.id }));
    expect(refused.code).toBe('INVALID_TRANSITION');
    expect(reads()).toBe(before);
    ok(await command(lead, workId, 'patch', { contract: { title: 'Return labels, ours' } }));

    ok(await reconcile(lead, workId, { action: 'convert_to_reference', ref_id: ref.id }));
    const refreshed = ok(await reconcile(lead, workId, { action: 'refresh', ref_id: ref.id })) as any;
    expect(refreshed.external.outcome).toBe('unchanged');
  });
});

describe('the console', () => {
  const ALPHA = '/app/teams/work-external/projects/alpha/work';

  it('files from an issue, shows the record as data, and reads and detaches it through the card', async () => {
    seedIssue(81, { title: '<script>alert(1)</script> Paper jam', body: 'Jams on thin paper.', updatedAt: at(90) });
    const blank = await page(`${ALPHA}/new`, leadCookie);
    const filed = await post(
      `${srv.url}${ALPHA}`,
      withFields(formFields(blank, 'import'), { external_issue: '#81', external_mode: 'reference' }),
      leadCookie,
    );
    expect(filed.status).toBe(303);
    const location = filed.headers.get('location') ?? '';
    expect(location).toMatch(/\/work\/WORK-\d+\?ok=created$/);

    const html = await page(location.split('?')[0]!, leadCookie);
    expect(html).toContain('External reference');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; Paper jam');
    expect(html).not.toContain('<script>alert(1)</script>');
    const refreshed = await post(`${srv.url}${location.split('?')[0]}/command`, formFields(html, 'ext-refresh'), leadCookie);
    expect(refreshed.status).toBe(303);
    expect(refreshed.headers.get('location')).toContain('ok=external_unchanged');

    const again = await page(location.split('?')[0]!, leadCookie);
    const detached = await post(`${srv.url}${location.split('?')[0]}/command`, formFields(again, 'ext-detach'), leadCookie);
    expect(detached.headers.get('location')).toContain('ok=external_detached');
  });

  it('ties a draft as the source of truth, locks its title and goal, and refuses a detach without a reason with the form kept', async () => {
    seedIssue(82, { title: 'Weigh parcels', body: 'Read the scale.', updatedAt: at(91) });
    const created = ok(
      await createWork(srv.db, lead, { request_id: randomUUID(), project: 'alpha', contract: { title: 'Scale draft' } }, { teamId }),
    );
    const url = `${ALPHA}/${created.key}`;
    const html = await page(url, leadCookie);
    const tied = await post(
      `${srv.url}${url}/command`,
      withFields(formFields(html, 'ext-attach'), { issue: '#82', mode: 'external_authoritative' }),
      leadCookie,
    );
    expect(tied.headers.get('location')).toContain('ok=external_followed');

    const owned = await page(url, leadCookie);
    expect(owned).toMatch(/id="edit-contract-title"[^>]*readonly|readonly[^>]*id="edit-contract-title"/);
    // The contract form sends the title and goal it shows; repeating them is no change.
    const saved = await post(
      `${srv.url}${url}/command`,
      withFields(formFields(owned, 'edit-contract'), { non_goals: 'No postage.' }),
      leadCookie,
    );
    expect(saved.status).toBe(303);

    const detail = await page(url, leadCookie);
    const refused = await post(`${srv.url}${url}/command`, withFields(formFields(detail, 'ext-detach'), { reason: '' }), leadCookie);
    expect(refused.status).toBe(422);
    const body = await refused.text();
    expect(body).toContain('payload.reason');
    expect(body).toContain('id="ext-detach"');
    expect((await liveRef(created.work_id)).detachedAt).toBeNull();
  });

  it('shows the held title and goal again after a refused contract edit, so the edit can be resent', async () => {
    seedIssue(83, { title: 'Print the manifest', body: 'One page per pallet.', updatedAt: at(92) });
    const created = ok(await fromIssue('#83', 'external_authoritative', acceptable));
    const url = `${ALPHA}/${created.key}`;
    const opened = await page(url, leadCookie);
    const stale = withFields(formFields(opened, 'edit-contract'), { non_goals: 'No reprints.' });
    // Somebody reads GitHub again and the issue had changed: a new revision and version.
    seedIssue(83, { title: 'Print the manifest twice', updatedAt: at(93) });
    ok(await reconcile(lead, created.work_id, { action: 'refresh', ref_id: (await liveRef(created.work_id)).id }));
    const refused = await post(`${srv.url}${url}/command`, stale, leadCookie);
    expect(refused.status).toBe(422);
    const body = await refused.text();
    expect(body).toContain('This work changed since you opened the page');
    const back = formFields(body, 'edit-contract');
    // The field the issue owns shows what is held, not what the stale form carried;
    // what the person typed in the fields they own is kept.
    expect(back.find(([name]) => name === 'title')?.[1]).toBe('Print the manifest twice');
    expect(back.find(([name]) => name === 'non_goals')?.[1]).toBe('No reprints.');
    const resent = await post(`${srv.url}${url}/command`, back, leadCookie);
    expect(resent.status).toBe(303);
  });

  it('asks before a read of GitHub can take work out of review, and says it did', async () => {
    seedIssue(84, { title: 'Weigh pallets', body: 'Read the floor scale.', updatedAt: at(94) });
    const created = ok(await fromIssue('#84', 'external_authoritative', acceptable));
    ok(await command(lead, created.work_id, 'transition', { to: 'ready' }));
    const row = await latest(created.work_id);
    ok(
      await submitDelivery(srv.db, lead, {
        request_id: randomUUID(),
        work_id: created.work_id,
        expected_version: row.version.toString(),
        spec_revision: row.specRevision,
        artifacts: [{ kind: 'document', uri: 'https://docs.example/pallets', version_id: 'v1' }],
      }),
    );
    expect((await latest(created.work_id)).state).toBe('in_review');
    const url = `${ALPHA}/${created.key}`;
    const html = await page(url, leadCookie);
    expect(html).toMatch(/<form[^>]*id="ext-refresh"[^>]*data-confirm="[^"]*in review[^"]*"/);
    seedIssue(84, { title: 'Weigh pallets and parcels', updatedAt: at(95) });
    const refreshed = await post(`${srv.url}${url}/command`, formFields(html, 'ext-refresh'), leadCookie);
    expect(refreshed.status).toBe(303);
    expect(refreshed.headers.get('location')).toContain('ok=external_followed_review');
    expect((await latest(created.work_id)).state).toBe('in_progress');
    const after = await page(refreshed.headers.get('location')!, leadCookie);
    expect(after).toContain('back in progress and the delivery that waited for a decision no longer counts');
  });
});

describe('a removed connection', () => {
  it('keeps the record readable and unavailable, refuses a refresh, and still answers a replay', async () => {
    seedIssue(91, { title: 'Customs forms', body: 'Attach customs forms.', updatedAt: at(100) });
    const requestId = randomUUID();
    const created = ok(await fromIssue('#91', 'reference', {}, requestId));

    await removeGithubIntegration(srv.db, teamId, (await userId('lead')));
    const ref = await liveRef(created.work_id);
    expect(ref.connectionId).toBeNull();
    expect((await externalState(srv.db, [created.work_id])).get(created.work_id)).toEqual({ changePending: false, unavailable: true });
    const read = (await detail(lead, created.work_id)).sections.external.items[0];
    expect(read).toMatchObject({ sync_state: 'unavailable', connection_available: false, remote: { title: 'Customs forms' } });
    expect(read.last_observed_at).toBeTruthy();

    const before = await latest(created.work_id);
    const refresh = refusal(await reconcile(lead, created.work_id, { action: 'refresh', ref_id: ref.id }));
    expect(refresh).toMatchObject({ code: 'SOURCE_UNAVAILABLE', retryable: true });
    expect(refresh.message).toContain('removed');
    expect((await latest(created.work_id)).version).toBe(before.version);

    // A create that already succeeded is answered as the replay it is, whatever happened to GitHub since.
    const replayed = ok(await fromIssue('#91', 'reference', {}, requestId));
    expect(replayed).toMatchObject({ replayed: true, work_id: created.work_id });

    const html = await page(`/app/teams/work-external/projects/alpha/work/${created.key}`, leadCookie);
    expect(html).toContain('was removed');
    expect(html).not.toContain('id="ext-refresh"');
  });

  it('never wrote to GitHub, over everything this file did', () => {
    expect(reads()).toBeGreaterThan(10);
    expect(writes()).toEqual([]);
  });
});
