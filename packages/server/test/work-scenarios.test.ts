import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, count, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentRuns,
  handoffs,
  projects,
  teams,
  workAcceptances,
  workBlockers,
  workDeliveries,
  workEvents,
  workItems,
  workLinks,
  workRevisions,
} from '../src/db/schema';
import { loadEnv, type Env } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

/**
 * The real-agent acceptance scenarios of Native Work (spec 16.2, A to G),
 * played by scripted agents instead of models. Everything an agent does goes
 * through `/mcp` under its own enrolled, project-scoped credential, and
 * everything a person does goes through the console's own forms, read back out
 * of the HTML and posted the way a browser posts them. The database is read
 * only to check what the doors said against what was written.
 *
 * What a model would add is judgement about what to call next; what this file
 * holds is that the product answers each of those calls in a way that leaves a
 * careful agent nothing to guess: the exact commit is what is accepted, a stale
 * client cannot overwrite, a test of another commit is not evidence for this
 * one, a mutable link is not an exact version, one project's work never shows
 * through another project's credential, a sent assignment is never "running",
 * and a client that knows nothing about work sees the replies it always saw.
 */

let srv: StartedServer;
let env: Env;
let dataDir: string;
let teamId = '';
let deskId = '';
let ledgerId = '';
let leadCookie: Record<string, string> = {};
let bobCookie: Record<string, string> = {};

const TEAM = 'scenario-desk';
const REPO = 'github.com/acme/parcel-desk';
const DESK = `/app/teams/${TEAM}/projects/parcel-desk/work`;
const LEDGER = `/app/teams/${TEAM}/projects/ledger/work`;
const sha = () => randomBytes(20).toString('hex');

type Agent = { name: string; token: string; installationId: string };
const agents: Record<string, Agent> = {};

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

/**
 * What a browser would submit for one form of a page: every named control,
 * checked boxes and radios only, and the selected option (or the first) of a
 * select. A field the page forgot to draw is a field the person cannot send.
 */
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

/** The fields with some replaced (every occurrence of a name), added, or (null) removed. */
function withFields(fields: [string, string][], changes: Record<string, string | null>): [string, string][] {
  const kept = fields.filter(([name]) => !(name in changes));
  return [...kept, ...Object.entries(changes).flatMap(([name, value]) => (value === null ? [] : [[name, value] as [string, string]]))];
}

const valueOf = (fields: [string, string][], name: string) => fields.find(([n]) => n === name)?.[1];

/** The HTML of one card of a page (a `section`, which never nests another), by the id it carries. */
function card(html: string, id: string): string {
  const at = html.indexOf(`<section class="card" id="${id}"`);
  if (at < 0) throw new Error(`no card ${id} on the page`);
  return html.slice(at, html.indexOf('</section>', at));
}

let rpcId = 1;
async function call(tool: string, args: Record<string, unknown>, token: string) {
  const res = await fetchRetrying(`${srv.url}/mcp`, {
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
  const text = json.result?.content?.[0]?.text ?? json.error?.message ?? '';
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* prose answer */
  }
  return { text, data, isError: json.result?.isError === true || json.error !== undefined };
}

/** A call the script expects to go through; anything else fails the step with the server's words. */
async function must(tool: string, args: Record<string, unknown>, agent: Agent) {
  const reply = await call(tool, args, agent.token);
  expect(reply.isError, `${agent.name} ${tool}: ${reply.text}`).toBe(false);
  return reply.data;
}

async function connectAgent(name: string, device: string, access: string): Promise<Agent> {
  const html = await (
    await post(`${srv.url}/app/tokens`, { name, device, access, client: 'codex', role: 'generalist' }, leadCookie)
  ).text();
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
  return { name, token: redeemed.token, installationId: who.data.credential.installationId as string };
}

// ---------------------------------------------------------------------------
// What a person does, through the console's forms.
// ---------------------------------------------------------------------------

type Filed = { key: string; id: string; url: string };

/** Each scenario's work, for the scenarios after it that read across them. */
const filed: Record<string, Filed> = {};

/** File native work with the New work form, as the lead, in a project's work section. */
async function fileWork(
  section: string,
  changes: Record<string, string | null>,
  cookie: Record<string, string> = leadCookie,
): Promise<Filed> {
  const html = await page(`${section}/new`, cookie);
  const sent = await post(`${srv.url}${section}`, withFields(formFields(html, 'new'), changes), cookie);
  expect(sent.status, await sent.clone().text()).toBe(303);
  const location = sent.headers.get('location') ?? '';
  const key = /\/work\/(WORK-\d+)\?ok=created$/.exec(location)?.[1];
  expect(key, location).toBeTruthy();
  const projectId = section === LEDGER ? ledgerId : deskId;
  const [row] = await srv.db
    .select({ id: workItems.id })
    .from(workItems)
    .where(and(eq(workItems.projectId, projectId), eq(workItems.displayKey, key!)));
  return { key: key!, id: row!.id, url: `${section}/${key}` };
}

/** Press one command form of the detail page, with whatever the person changed in it. */
async function press(work: Filed, formId: string, changes: Record<string, string | null> = {}, cookie = leadCookie) {
  const html = await page(work.url, cookie);
  const sent = await post(`${srv.url}${work.url}/command`, withFields(formFields(html, formId), changes), cookie);
  expect(sent.status, await sent.clone().text()).toBe(303);
  return sent.headers.get('location') ?? '';
}

const markReady = (work: Filed) => press(work, 'to-ready');
const assignTo = (work: Filed, agent: Agent) => press(work, 'assign', { agent: agent.installationId });

/** The acceptor's decision form, as their page draws it, posted with the decision they chose. */
async function decide(work: Filed, changes: Record<string, string | null>, cookie = bobCookie) {
  const html = await page(work.url, cookie);
  const fields = withFields(formFields(html, 'decision'), changes);
  const sent = await post(`${srv.url}${work.url}/decision`, fields, cookie);
  return { sent, fields, body: sent.status === 303 ? '' : await sent.text() };
}

const workRow = async (id: string) => (await srv.db.select().from(workItems).where(eq(workItems.id, id)))[0]!;
const acceptancesOf = async (id: string) => srv.db.select().from(workAcceptances).where(eq(workAcceptances.workId, id));

// ---------------------------------------------------------------------------
// What an agent does, through its own credential.
// ---------------------------------------------------------------------------

type Taken = { sessionId: string; startWith: Record<string, unknown>; accept: any };

/**
 * An agent takes work assigned to it by name the way the inbox tells it to:
 * find the assignment, read the record STMA wrote with it, accept it. The
 * start call is taken from that record, never assembled by the agent.
 */
async function takeAssignment(agent: Agent, key: string): Promise<Taken> {
  const inbox = await must('inbox', {}, agent);
  const mine = (inbox.pendingHandoffs as any[]).filter((h) => h.forThisAgent && String(h.title).includes(key));
  expect(mine, `${agent.name} sees its assignment of ${key}`).toHaveLength(1);
  const sessionId = mine[0].sessionId as string;
  const session = await must('get_session', { session_id: sessionId }, agent);
  const record = (session.messages as any[]).find((m) => m.resume)?.resume;
  expect(record?.kind).toBe('assignment');
  const accept = await must('update_handoff', { session_id: sessionId, action: 'accept' }, agent);
  return { sessionId, startWith: record.reclaim.arguments as Record<string, unknown>, accept };
}

/** A delivery or tested checkpoint on a run, as update_run records it; its id. */
async function checkpoint(agent: Agent, runId: string, commit: string, kind: 'delivery' | 'tested', tests: unknown[] = []) {
  const reply = await must(
    'update_run',
    {
      run_id: runId,
      checkpoint: { request_id: randomUUID(), kind, repository_identity: `https://${REPO}.git`, commit_sha: commit, worktree_clean: true, tests },
    },
    agent,
  );
  const id = reply.checkpoint?.checkpoint?.id as string | undefined;
  expect(id, JSON.stringify(reply.checkpoint)).toBeTruthy();
  return id!;
}

/** The work as an agent reads it now. */
const readWork = (agent: Agent, workId: string, extra: Record<string, unknown> = {}) =>
  must('get_work', { work_id: workId, ...extra }, agent);

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-work-scenarios-'));
  env = loadEnv({ port: 0, host: '127.0.0.1', nodeEnv: 'test', devMode: true, databaseUrl: undefined, pgliteDir: dataDir });
  srv = await startServer(env);
  const signIn = async (username: string) => {
    const j = jar();
    j.store(await post(`${srv.url}/auth/dev`, { username }));
    return j.header();
  };
  leadCookie = await signIn('lead');
  await post(`${srv.url}/app/teams`, { name: 'Scenario Desk' }, leadCookie);
  const [team] = await srv.db.select().from(teams).where(eq(teams.slug, TEAM));
  teamId = team!.id;
  // One repository project the code scenarios work in, and one plain project
  // whose work the analyst of scenario E must never see.
  const [desk] = await srv.db
    .insert(projects)
    .values({ teamId, name: 'parcel-desk', slug: 'parcel-desk', repositoryIdentity: REPO })
    .returning();
  deskId = desk!.id;
  await post(`${srv.url}/app/projects`, { team: TEAM, project: 'ledger' }, leadCookie);
  const [ledger] = await srv.db.select().from(projects).where(and(eq(projects.teamId, teamId), eq(projects.name, 'ledger')));
  ledgerId = ledger!.id;

  // Bob is the acceptor: a member who did not do the work.
  await post(`${srv.url}/app/teams/${TEAM}/invites`, {}, leadCookie);
  const people = await page(`/app/teams/${TEAM}?tab=people`, leadCookie);
  const invite = /\/join\/([A-Za-z0-9_-]+)/.exec(people)?.[1] ?? '';
  expect(invite, 'invite code').toBeTruthy();
  bobCookie = await signIn('bob');
  await post(`${srv.url}/join/${invite}`, {}, bobCookie);

  const scoped = `project:${deskId}`;
  agents.one = await connectAgent('Codex One', 'mac', scoped);
  agents.two = await connectAgent('Claude Two', 'win', scoped);
  agents.analyst = await connectAgent('Lead Analyst', 'laptop', scoped);
  agents.offline = await connectAgent('Codex Offline', 'shelf', scoped);
  agents.oldLead = await connectAgent('Old Lead', 'old-a', scoped);
  agents.oldWorker = await connectAgent('Old Worker', 'old-b', scoped);
}, 120_000);

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('scenario A: native work, assigned, run, delivered at an exact commit, accepted by a person', () => {
  it('ends accepted, and the acceptance names the delivery and the manifest the acceptor saw', async () => {
    const one = agents.one!;
    const work = await fileWork(DESK, {
      title: 'Print a shipping label',
      goal: 'A paid order prints a shipping label from the order page.',
      artifact_kind: 'code',
      acceptor: 'bob',
      c0_text: 'A label prints for a paid order.',
      c1_text: 'The tests pass on the delivered commit.',
    });
    filed.A = work;
    expect((await workRow(work.id)).state).toBe('draft');
    expect(await markReady(work)).toBe(`${work.url}?ok=ready`);
    // Assigned in the console, bound to the revision the page shows. No hook is
    // paired with the agent, and the band says so rather than claiming a start.
    expect(await assignTo(work, one)).toBe(`${work.url}?ok=assigned_quiet`);
    expect((await workRow(work.id)).state).toBe('ready');

    // The other agent on the project sees the assignment is not its own, and cannot take it.
    const two = agents.two!;
    const elsewhere = ((await must('inbox', {}, two)).pendingHandoffs as any[]).find((h) => String(h.title).includes(work.key));
    expect(elsewhere).toMatchObject({ kind: 'assignment', forThisAgent: false, assignedTo: { agent: 'Codex One' } });
    const grabbed = await call('update_handoff', { session_id: elsewhere.sessionId, action: 'accept' }, two.token);
    expect(grabbed.isError).toBe(true);

    // The agent finds it in its inbox, reads the contract, and accepts.
    const taken = await takeAssignment(one, work.key);
    expect(taken.startWith).toMatchObject({ work_id: work.id, expected_spec_revision: 1, repository_identity: REPO });
    // It has no live run here, so nothing was rotated: it starts one, as the record says.
    expect(taken.accept.run_rotation).toMatchObject({ done: false, reason: 'no_live_run' });
    const contract = await readWork(one, work.id, { view: 'detail', sections: ['criteria'] });
    expect(contract.spec_revision).toBe(1);
    const criteria = (contract.sections.criteria.items as { id: string }[]).map((c) => c.id);
    expect(criteria).toEqual(['c1', 'c2']);

    const base = sha();
    const started = await must('start_run', { request_id: randomUUID(), ...taken.startWith, head_sha: base }, one);
    expect(started.work).toMatchObject({ work_id: work.id, pinned_revision: 1, state: 'in_progress' });
    const runId = started.runId as string;
    expect((await workRow(work.id)).state).toBe('in_progress');
    await must('update_handoff', { session_id: taken.sessionId, action: 'resume' }, one);

    // Its working package names its own run and the assignment it took, counted and listed.
    const working = await must('get_work_context', { work_id: work.id }, one);
    expect(working.incomplete).toBe(false);
    expect(working.content.active).toMatchObject({ sent: 0, taken: 1, runs: 1 });
    expect(working.content.active.linked_runs).toEqual([
      expect.objectContaining({ run_id: runId, status: 'active', agent: 'Codex One', pinned_revision: 1 }),
    ]);
    expect(working.content.active.assignments_taken).toEqual([
      expect.objectContaining({ state: 'in_progress', agent: 'Codex One', pinned_revision: 1 }),
    ]);

    // The work is done at one commit, recorded on the run, delivered with exactly that commit.
    const head = sha();
    const cp = await checkpoint(one, runId, head, 'delivery', [{ name: 'npm test', state: 'passed' }]);
    const before = await readWork(one, work.id);
    const delivered = await must(
      'submit_work',
      {
        request_id: randomUUID(),
        work_id: work.id,
        expected_version: before.version,
        spec_revision: 1,
        run_id: runId,
        artifacts: [{ kind: 'code', repository_identity: `https://${REPO}.git`, commit_sha: head, checkpoint_id: cp, branch: 'label-printer' }],
        evidence: [
          { criterion_id: 'c1', assertion: 'pass', source_kind: 'checkpoint', source_ref: cp, excerpt: 'Printed a label for order 1001.' },
          { criterion_id: 'c2', assertion: 'pass', source_kind: 'agent_report', source_ref: 'npm test', source_version: head },
        ],
      },
      one,
    );
    expect(delivered).toMatchObject({ state: 'in_review', sequence: 1, replayed: false });
    expect(delivered.readiness.ready_for_review).toBe(true);
    const deliveryId = delivered.delivery_id as string;
    // An agent that is on neither the assignment nor a run of this work delivers nothing to it.
    const intruder = await call(
      'submit_work',
      {
        request_id: randomUUID(),
        work_id: work.id,
        expected_version: delivered.version,
        spec_revision: 1,
        artifacts: [{ kind: 'code', repository_identity: REPO, commit_sha: sha() }],
      },
      two.token,
    );
    expect(intruder.isError).toBe(true);
    expect(intruder.data.error.code).toBe('FORBIDDEN');
    expect(await srv.db.select().from(workDeliveries).where(eq(workDeliveries.workId, work.id))).toHaveLength(1);

    // The agent says it is done. That is its word: nothing is accepted by it.
    await must('update_handoff', { session_id: taken.sessionId, action: 'complete' }, one);
    await must('finish_run', { run_id: runId }, one);
    expect((await workRow(work.id)).state).toBe('in_review');
    expect(await acceptancesOf(work.id)).toHaveLength(0);

    // The acceptor decides in the console, bound to the snapshot the page drew.
    const { sent, fields } = await decide(work, { decision: 'accept', reason: 'The label prints and the tests are green.' });
    expect(sent.status).toBe(303);
    expect(sent.headers.get('location')).toBe(`${work.url}?ok=accepted`);
    expect(valueOf(fields, 'delivery_id')).toBe(deliveryId);

    const read = await readWork(one, work.id, { view: 'detail', sections: ['acceptances', 'deliveries'] });
    expect(read.state).toBe('accepted');
    const acceptances = read.sections.acceptances.items as any[];
    expect(acceptances).toHaveLength(1);
    expect(acceptances[0]).toMatchObject({
      decision: 'accept',
      delivery_id: deliveryId,
      evidence_manifest_hash: valueOf(fields, 'evidence_manifest_hash'),
      evidence_epoch: valueOf(fields, 'evidence_epoch'),
      spec_revision: 1,
      actor: 'bob',
      current: true,
    });
    // The stored manifest is about that delivery's exact artifact set, and the delivery is that commit.
    const [acceptance] = await acceptancesOf(work.id);
    const [delivery] = await srv.db.select().from(workDeliveries).where(eq(workDeliveries.id, deliveryId));
    expect(delivery!.artifacts).toEqual([
      { kind: 'code', repository_identity: REPO, commit_sha: head, checkpoint_id: cp, branch: 'label-printer' },
    ]);
    const manifest = acceptance!.evidenceManifest as any;
    expect(manifest.delivery).toMatchObject({ id: deliveryId, sequence: 1, artifact_set_hash: delivery!.artifactSetHash });
    expect(acceptance!.evidenceManifestHash).toBe(valueOf(fields, 'evidence_manifest_hash'));
    expect(manifest.criteria.map((criterion: any) => [criterion.id, criterion.result])).toEqual([
      ['c1', 'pass'],
      ['c2', 'pass'],
    ]);
    expect(delivery!.runId).toBe(runId);
    expect(acceptance!.actorScopeSnapshot).toMatchObject({ self_review: false });

    const html = await page(`${work.url}?ok=accepted`, bobCookie);
    expect(html).toContain('Accepted.');
    expect(html).toContain(head);
  });
});

describe('scenario B: a second agent with an old version cannot overwrite the first', () => {
  it('is refused with the current version, loses nothing of the first agent, and goes through after reading the difference', async () => {
    const [one, two] = [agents.one!, agents.two!];
    const work = await fileWork(DESK, {
      title: 'Reprint a damaged label',
      goal: 'A packer can reprint the label of an order whose label was damaged.',
      artifact_kind: 'code',
      acceptor: 'bob',
      c0_text: 'A reprint carries the same tracking number.',
    });
    filed.B = work;
    await markReady(work);
    // Both agents are on the work: one to build it, one to test it.
    await assignTo(work, one);
    await assignTo(work, two);
    const takenByOne = await takeAssignment(one, work.key);
    await must('start_run', { request_id: randomUUID(), ...takenByOne.startWith }, one);
    await takeAssignment(two, work.key);

    // Agent two reads the work, and keeps a changes cursor from that moment.
    const seen = await readWork(two, work.id);
    const snapshot = await must('get_work_changes', {}, two);
    const cursor = snapshot.next_cursor as string;
    expect(cursor).toBeTruthy();
    expect((snapshot.upserts as any[]).find((item) => item.id === work.id)).toMatchObject({ version: seen.version });

    // Agent one changes the work first: an agent's change to a contract is a
    // change request, recorded as a blocker on the revision both of them read.
    const firstReason = 'Criterion c1 does not say whether the reprint keeps the label size.';
    const byOne = await must(
      'update_work',
      {
        request_id: randomUUID(),
        work_id: work.id,
        expected_version: seen.version,
        operation: 'set_blocker',
        payload: { kind: 'contract_change_request', reason: firstReason, next_action: 'Bob says which size a reprint uses.' },
      },
      one,
    );
    expect(BigInt(byOne.version)).toBe(BigInt(seen.version) + 1n);
    expect(byOne.spec_revision).toBe(1);

    // Agent two still holds the old version. Whatever it sends, a patch or a
    // change request of its own, it is refused with the version that is current
    // now, and nothing it sent is written.
    const secondReason = 'The reprint flow has no test fixture for a damaged label.';
    const stale = [
      {
        operation: 'set_blocker',
        payload: { kind: 'contract_change_request', reason: secondReason, next_action: 'Add a fixture order with a damaged label.' },
      },
      { operation: 'patch', payload: { contract: { goal: 'Reprint any label.' }, coordination: { priority: 'urgent' } } },
    ];
    for (const command of stale) {
      const refused = await call(
        'update_work',
        { request_id: randomUUID(), work_id: work.id, expected_version: seen.version, ...command },
        two.token,
      );
      expect(refused.isError, command.operation).toBe(true);
      expect(refused.data.error, command.operation).toMatchObject({
        code: 'VERSION_CONFLICT',
        current_version: byOne.version,
        retryable: false,
      });
    }
    const row = await workRow(work.id);
    expect(row.version.toString()).toBe(byOne.version);
    expect(row.specRevision).toBe(1);
    expect(row.priority).toBe('normal');
    const [revision] = await srv.db.select().from(workRevisions).where(and(eq(workRevisions.workId, work.id), eq(workRevisions.revision, 1)));
    expect(revision!.goal).toBe('A packer can reprint the label of an order whose label was damaged.');
    let open = await srv.db.select().from(workBlockers).where(and(eq(workBlockers.workId, work.id), isNull(workBlockers.resolvedAt)));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      kind: 'contract_change_request',
      reason: firstReason,
      createdByKind: 'agent',
      createdById: one.installationId,
    });

    // It reads the difference: the work moved on by agent one's change, which it can see.
    const changes = await must('get_work_changes', { after_cursor: cursor }, two);
    const moved = (changes.upserts as any[]).find((item) => item.id === work.id);
    expect(moved).toMatchObject({ version: byOne.version });
    expect(moved.flags.blocked).toBe(true);
    const now = await readWork(two, work.id);
    expect(now.version).toBe(byOne.version);
    expect((now.open_blockers.items as any[]).map((blocker) => blocker.reason)).toEqual([firstReason]);

    // Its own change, sent again on the version it has now read, goes through beside the first.
    const byTwo = await must(
      'update_work',
      { request_id: randomUUID(), work_id: work.id, expected_version: now.version, ...stale[0]! },
      two,
    );
    expect(BigInt(byTwo.version)).toBe(BigInt(byOne.version) + 1n);
    open = await srv.db.select().from(workBlockers).where(and(eq(workBlockers.workId, work.id), isNull(workBlockers.resolvedAt)));
    expect(open.map((blocker) => blocker.reason).sort()).toEqual([firstReason, secondReason].sort());
    expect((await workRow(work.id)).specRevision).toBe(1);
  });
});

describe('scenario C: "done", with a test of another commit', () => {
  it('refuses the test as evidence for the delivery, counts an older delivery\'s pass as stale, and never accepts the work', async () => {
    const two = agents.two!;
    const work = await fileWork(DESK, {
      title: 'Show the carrier on the label',
      goal: 'The label names the carrier the order ships with.',
      artifact_kind: 'code',
      acceptor: 'bob',
      c0_text: 'The tests pass on the delivered commit.',
    });
    filed.C = work;
    await markReady(work);
    await assignTo(work, two);
    const taken = await takeAssignment(two, work.key);
    const started = await must('start_run', { request_id: randomUUID(), ...taken.startWith }, two);
    const runId = started.runId as string;
    await must('update_handoff', { session_id: taken.sessionId, action: 'resume' }, two);

    // The tests ran green on one commit; the agent then committed again and
    // delivers the newer one, with the old test as its evidence.
    const tested = sha();
    const testedCp = await checkpoint(two, runId, tested, 'tested', [{ name: 'npm test', state: 'passed' }]);
    const head = sha();
    const headCp = await checkpoint(two, runId, head, 'delivery');
    const version = (await readWork(two, work.id)).version as string;
    const deliver = (evidence: unknown[], commit = head, cp = headCp) =>
      call(
        'submit_work',
        {
          request_id: randomUUID(),
          work_id: work.id,
          expected_version: version,
          spec_revision: 1,
          run_id: runId,
          artifacts: [{ kind: 'code', repository_identity: REPO, commit_sha: commit, checkpoint_id: cp }],
          evidence,
        },
        two.token,
      );

    const byCheckpoint = await deliver([{ criterion_id: 'c1', assertion: 'pass', source_kind: 'checkpoint', source_ref: testedCp }]);
    expect(byCheckpoint.isError).toBe(true);
    expect(byCheckpoint.data.error).toMatchObject({ code: 'INVALID_INPUT', fields: ['evidence[0].source_ref'] });
    expect(byCheckpoint.data.error.message).toContain("that checkpoint's commit is not an artifact of this delivery");
    const byVersion = await deliver([
      { criterion_id: 'c1', assertion: 'pass', source_kind: 'agent_report', source_ref: 'npm test', source_version: tested },
    ]);
    expect(byVersion.isError).toBe(true);
    expect(byVersion.data.error).toMatchObject({ code: 'INVALID_INPUT', fields: ['evidence[0].source_version'] });
    // A refused delivery writes nothing at all.
    expect(await srv.db.select().from(workDeliveries).where(eq(workDeliveries.workId, work.id))).toHaveLength(0);
    expect((await workRow(work.id)).state).toBe('in_progress');

    // Delivered at the tested commit with its test, the pass is real for that delivery.
    const first = await deliver(
      [{ criterion_id: 'c1', assertion: 'pass', source_kind: 'checkpoint', source_ref: testedCp }],
      tested,
      testedCp,
    );
    expect(first.isError, first.text).toBe(false);
    expect(first.data.readiness.ready_for_review).toBe(true);

    // Then the newer commit is delivered on top, with the agent's word and no new test.
    const second = await must(
      'submit_work',
      {
        request_id: randomUUID(),
        work_id: work.id,
        expected_version: first.data.version,
        spec_revision: 1,
        run_id: runId,
        artifacts: [{ kind: 'code', repository_identity: REPO, commit_sha: head, checkpoint_id: headCp }],
        note: 'Done. The tests passed.',
      },
      two,
    );
    expect(second).toMatchObject({ sequence: 2, supersedes_delivery_id: first.data.delivery_id });
    expect(second.readiness.ready_for_review).toBe(false);
    const c1 = (second.readiness.criteria as any[]).find((criterion) => criterion.id === 'c1');
    expect(c1).toMatchObject({ result: 'unknown', reasons: ['no_evidence'] });
    // The earlier pass is not this delivery's evidence: the current delivery lists none.
    const evidence = await readWork(two, work.id, { view: 'detail', sections: ['evidence'] });
    expect(evidence.sections.evidence).toMatchObject({ delivery_id: second.delivery_id, items: [] });

    // "Done" is the agent's word, and it changes nothing about acceptance.
    await must('update_handoff', { session_id: taken.sessionId, action: 'complete' }, two);
    await must('finish_run', { run_id: runId, status: 'completed', note: 'All done.' }, two);
    expect((await workRow(work.id)).state).toBe('in_review');
    expect(await acceptancesOf(work.id)).toHaveLength(0);
    // The acceptor sees why, and an accept is refused.
    const html = await page(work.url, bobCookie);
    expect(html).toContain('Not ready');
    const refused = await decide(work, { decision: 'accept', reason: 'The agent said it was done.' });
    expect(refused.sent.status).toBe(422);
    expect(refused.body).toContain('Accepting needs every required criterion to pass');
    expect((await workRow(work.id)).state).toBe('in_review');
    expect((await workRow(work.id)).currentAcceptanceId).toBeNull();
    expect(await acceptancesOf(work.id)).toHaveLength(0);
  });
});

describe('scenario D: a report that is not code, delivered as a link', () => {
  it('reads a mutable link as unversioned and refuses to accept it, and accepts the same report with a digest', async () => {
    const two = agents.two!;
    const work = await fileWork(DESK, {
      title: 'Write the Q3 carrier cost report',
      goal: 'A report comparing what each carrier cost per parcel in Q3.',
      artifact_kind: 'research',
      acceptor: 'bob',
      c0_text: 'The report is delivered as one exact version.',
      c0_kind: 'artifact',
    });
    filed.D = work;
    await markReady(work);
    await assignTo(work, two);
    const taken = await takeAssignment(two, work.key);
    await must('update_handoff', { session_id: taken.sessionId, action: 'resume' }, two);

    const uri = 'https://docs.example.com/reports/q3-carrier-costs';
    const linked = await must(
      'submit_work',
      {
        request_id: randomUUID(),
        work_id: work.id,
        expected_version: (await readWork(two, work.id)).version,
        spec_revision: 1,
        artifacts: [{ kind: 'document', uri }],
        evidence: [{ criterion_id: 'c1', assertion: 'pass', source_kind: 'artifact', source_ref: 'artifacts[0]' }],
      },
      two,
    );
    expect(linked.state).toBe('in_review');
    expect(linked.readiness.ready_for_review).toBe(false);
    const unversioned = (linked.readiness.criteria as any[]).find((criterion) => criterion.id === 'c1');
    expect(unversioned).toMatchObject({ result: 'unknown', reasons: ['unversioned'] });
    // The context an agent reads says the same of the artifact itself.
    const context = await must('get_work_context', { work_id: work.id, sections: ['active'] }, two);
    expect(context.content.active.delivery_artifacts).toEqual([{ index: 0, version: 'unversioned', kind: 'document', uri }]);

    // The acceptor is shown the link as unversioned and cannot accept it.
    let html = await page(work.url, bobCookie);
    expect(html).toContain('unversioned');
    const refused = await decide(work, { decision: 'accept', reason: 'I read the report.' });
    expect(refused.sent.status).toBe(422);
    expect(refused.body).toContain('Accepting needs every required criterion to pass');
    expect((await workRow(work.id)).state).toBe('in_review');
    expect(await acceptancesOf(work.id)).toHaveLength(0);

    // The same report, delivered again with the version the document store gave
    // it and its digest, is an exact version, and the criterion can pass.
    const digest = randomBytes(32).toString('hex');
    const exact = await must(
      'submit_work',
      {
        request_id: randomUUID(),
        work_id: work.id,
        expected_version: linked.version,
        spec_revision: 1,
        artifacts: [{ kind: 'document', uri, version_id: 'v7', sha256: digest }],
        evidence: [{ criterion_id: 'c1', assertion: 'pass', source_kind: 'artifact', source_ref: 'artifacts[0]', source_version: digest }],
      },
      two,
    );
    expect(exact.readiness.ready_for_review).toBe(true);
    expect((exact.readiness.criteria as any[]).find((criterion) => criterion.id === 'c1')).toMatchObject({ result: 'pass' });

    html = await page(work.url, bobCookie);
    expect(html).toContain('Ready for review');
    const accepted = await decide(work, { decision: 'accept', reason: 'Read version v7 of the report.' });
    expect(accepted.sent.status, accepted.body).toBe(303);
    expect(accepted.sent.headers.get('location')).toBe(`${work.url}?ok=accepted`);
    const row = await workRow(work.id);
    expect(row.state).toBe('accepted');
    // Accepted is the exact version: the decision pins the delivery and its
    // artifact set, and that delivery carries the digest and the version id.
    const [acceptance] = await acceptancesOf(work.id);
    expect(acceptance).toMatchObject({ decision: 'accept', deliveryId: exact.delivery_id });
    const [delivery] = await srv.db.select().from(workDeliveries).where(eq(workDeliveries.id, exact.delivery_id));
    expect(delivery!.artifacts).toEqual([{ kind: 'document', uri, version_id: 'v7', sha256: digest }]);
    expect((acceptance!.evidenceManifest as any).delivery).toMatchObject({
      id: exact.delivery_id,
      sequence: 2,
      artifact_set_hash: delivery!.artifactSetHash,
    });
  });
});

describe('scenario E: an analyst scoped to one project', () => {
  const SECRET = 'Ledger confidential';

  it('reads no count, key or title of the other project through list_work, get_work, get_work_changes or get_work_context', async () => {
    const analyst = agents.analyst!;
    const deskCount = async () =>
      Number((await srv.db.select({ n: count() }).from(workItems).where(eq(workItems.projectId, deskId)))[0]!.n);
    const mine = await deskCount();
    expect(mine).toBeGreaterThan(0);

    // A changes cursor taken before the other project gets busy.
    const before = await must('get_work_changes', {}, analyst);
    const listedBefore = await must('list_work', {}, analyst);

    // The other project gets more work than this one has, so its keys run past
    // every key here, and some of it moves through its lifecycle.
    const ledger: Filed[] = [];
    for (let n = 0; n < mine + 2; n++) {
      ledger.push(
        await fileWork(LEDGER, {
          title: `${SECRET} audit ${n + 1}`,
          goal: `${SECRET}: reconcile the carrier invoices of month ${n + 1}.`,
          artifact_kind: 'analysis',
          acceptor: 'bob',
          c0_text: `${SECRET} criterion ${n + 1}.`,
        }),
      );
    }
    await markReady(ledger[0]!);
    await markReady(ledger[1]!);
    await press(ledger[1]!, 'set-blocker', { kind: 'access', reason: `${SECRET} vault is locked.`, next_action: 'Ask finance.' });
    const ledgerIds = ledger.map((work) => work.id);
    const onlyThere = ledger.at(-1)!.key;
    expect(Number(/\d+$/.exec(onlyThere)![0])).toBeGreaterThan(mine);

    const leaks = (reply: { text: string }, where: string) => {
      expect(reply.text, where).not.toContain(SECRET);
      for (const id of ledgerIds) expect(reply.text, where).not.toContain(id);
      expect(reply.text, where).not.toContain(ledgerId);
    };

    // The list and its per-view counts are this project's alone, before and after.
    const listed = await call('list_work', {}, analyst.token);
    leaks(listed, 'list_work');
    expect(listed.data.counts).toEqual(listedBefore.counts);
    expect(listed.data.counts.all).toBe(mine);
    for (const view of ['ready', 'blocked', 'needs_decision', 'in_progress'] as const) {
      const one = await call('list_work', { view }, analyst.token);
      leaks(one, `list_work ${view}`);
      expect(one.data.counts).toEqual(listedBefore.counts);
    }

    // The changes since the cursor: nothing happened here, so nothing is said,
    // and the sequence did not move for what happened elsewhere.
    const delta = await call('get_work_changes', { after_cursor: before.next_cursor }, analyst.token);
    leaks(delta, 'get_work_changes delta');
    expect(delta.data).toMatchObject({ upserts: [], tombstones: [], has_more: false });
    expect(delta.data.as_of_seq).toBe(before.as_of_seq);
    const fresh = await call('get_work_changes', {}, analyst.token);
    leaks(fresh, 'get_work_changes snapshot');
    expect(fresh.data.upserts).toHaveLength(mine);

    // A work id of the other project reads exactly like one that was never issued.
    const absent = randomUUID();
    for (const tool of ['get_work', 'get_work_context'] as const) {
      const missing = await call(tool, { work_id: absent }, analyst.token);
      for (const id of ledgerIds.slice(0, 3)) {
        const hidden = await call(tool, { work_id: id }, analyst.token);
        expect(hidden.isError, tool).toBe(true);
        expect(hidden.text, tool).toBe(missing.text.replace(absent, id));
        leaks(hidden, tool);
      }
    }
    // A key that exists only over there reads like a key that exists nowhere.
    const byKey = await call('get_work', { key: onlyThere }, analyst.token);
    const noKey = await call('get_work', { key: 'WORK-999' }, analyst.token);
    expect(byKey.isError).toBe(true);
    expect(byKey.text).toBe(noKey.text.replace('WORK-999', onlyThere));
    leaks(byKey, 'get_work by key');
    // Naming the other project is refused without a word about what is in it.
    for (const tool of ['list_work', 'get_work_changes'] as const) {
      const named = await call(tool, { project: 'ledger' }, analyst.token);
      expect(named.isError, tool).toBe(true);
      leaks(named, `${tool} project`);
    }

    // The working package of this project's work, whole, names nothing of the
    // other. The one read is scenario B's work, made to wait on scenario C's
    // (in review, so not met) on top of its two change requests: the shape of
    // "which dependency stopped this work?", with every section full.
    const [held, upstream] = [filed.B!, filed.C!];
    expect(await press(held, 'add-dependency', { depends_on: upstream.key })).toBe(`${held.url}?ok=dependency_added`);
    for (const deskWork of [held.id, ...(listed.data.items as { id: string }[]).map((item) => item.id)]) {
      const context = await call('get_work_context', { work_id: deskWork, max_bytes: 32 * 1024 }, analyst.token);
      expect(context.isError, context.text).toBe(false);
      leaks(context, 'get_work_context');
      const detail = await call(
        'get_work',
        { work_id: deskWork, view: 'detail', sections: ['links', 'dependencies', 'events', 'blockers'] },
        analyst.token,
      );
      expect(detail.isError, detail.text).toBe(false);
      leaks(detail, 'get_work detail');
    }
    const waiting = await must('get_work_context', { work_id: held.id }, analyst);
    expect(waiting.content.blockers).toMatchObject({ blocked: true, open_blockers: 2, unmet_dependencies: 1 });
    expect(waiting.content.blockers.open).toHaveLength(2);
    expect(waiting.content.blockers.unmet).toEqual([expect.objectContaining({ key: upstream.key, state: 'in_review' })]);

    // The control: the same records through a workspace owner's eyes do hold the other project.
    expect(await page(LEDGER, leadCookie)).toContain(SECRET);
  });
});

describe('scenario F: assigned to an agent whose client is closed', () => {
  it('reads as sent and assigned, and nothing says it is running or started', async () => {
    const offline = agents.offline!;
    const work = await fileWork(DESK, {
      title: 'Archive old shipping labels',
      goal: 'Labels older than a year move to cold storage.',
      artifact_kind: 'code',
      acceptor: 'bob',
      c0_text: 'No label younger than a year is moved.',
    });
    await markReady(work);
    const before = (await workRow(work.id)).version;
    expect(await assignTo(work, offline)).toBe(`${work.url}?ok=assigned_quiet`);

    // The records: one assignment, sent, taken by nobody; the work is still ready.
    const row = await workRow(work.id);
    expect(row.state).toBe('ready');
    expect(row.version).toBe(before + 1n);
    const sent = await srv.db
      .select()
      .from(handoffs)
      .where(eq(handoffs.targetInstallationId, offline.installationId));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'assignment', state: 'offered', installationId: null, acceptedAt: null, resumedAt: null });
    expect(await srv.db.select().from(agentRuns).where(eq(agentRuns.installationId, offline.installationId))).toHaveLength(0);
    const events = await srv.db.select().from(workEvents).where(eq(workEvents.workId, work.id));
    const assigned = events.filter((event) => event.type === 'work_assigned');
    expect(assigned).toHaveLength(1);
    expect(assigned[0]!.payload).toMatchObject({ execution_requested: false, installation_id: offline.installationId });
    expect(events.filter((event) => event.type === 'work_state_changed').map((event) => (event.payload as any).to)).toEqual(['ready']);

    // The list row and the detail page say sent, not accepted, and never running or started.
    const list = await page(DESK, leadCookie);
    const at = list.indexOf(work.key);
    const rowHtml = list.slice(at, list.indexOf('</tr>', at));
    expect(rowHtml).toContain('sent to Codex Offline, not accepted');
    expect(rowHtml).not.toMatch(/\brunning\b|\bstarted\b/i);
    expect(list).not.toMatch(/\brunning\b/i);
    const execution = card(await page(work.url, leadCookie), 'execution');
    expect(execution).toContain('Sent to Codex Offline, not accepted yet.');
    expect(execution).not.toMatch(/\brunning\b|\bstarted\b|recorded as active/i);

    // The agent doors say the same in their own fields.
    const analyst = agents.analyst!;
    const read = await readWork(analyst, work.id);
    expect(read.state).toBe('ready');
    const context = await must('get_work_context', { work_id: work.id, sections: ['active'] }, analyst);
    expect(context.incomplete).toBe(false);
    const active = context.content.active;
    expect(active).toMatchObject({ sent: 1, taken: 0, runs: 0 });
    expect(active.assignments_sent).toHaveLength(1);
    expect(active.assignments_sent[0]).toMatchObject({
      kind: 'assignment',
      state: 'offered',
      agent: 'Codex Offline',
      pinned_revision: 1,
      accepted_at: null,
      started_at: null,
    });
    expect(active.linked_runs).toBeUndefined();
    const inProgress = await must('list_work', { view: 'in_progress' }, analyst);
    expect((inProgress.items as { id: string }[]).map((item) => item.id)).not.toContain(work.id);
  });
});

describe('scenario G: a client that knows nothing about work', () => {
  /** Every key anywhere in a reply, so a work field nested anywhere would show. */
  const allKeys = (value: unknown, out = new Set<string>()): Set<string> => {
    if (Array.isArray(value)) value.forEach((entry) => allKeys(entry, out));
    else if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        out.add(key);
        allKeys(entry, out);
      }
    }
    return out;
  };
  const WORK_FIELDS = ['work', 'work_id', 'run_rotation', 'execution_requested', 'link_id', 'pinned_revision', 'expected_spec_revision'];
  const plain = (reply: unknown, where: string) => {
    const keys = allKeys(reply);
    for (const field of WORK_FIELDS) expect(keys.has(field), `${where} carries ${field}`).toBe(false);
  };
  const keysOf = (reply: Record<string, unknown>) => Object.keys(reply).sort();

  it('completes an assignment and a handoff round, and every reply has the keys it had before work existed', async () => {
    const [lead, worker] = [agents.oldLead!, agents.oldWorker!];
    const assigned = await must(
      'assign_work',
      {
        request_id: randomUUID(),
        to_agent: 'Old Worker',
        task: 'PD-12 Footer',
        brief: 'Add the support address to the label footer.',
        project: 'parcel-desk',
      },
      lead,
    );
    plain(assigned, 'assign_work');
    expect(keysOf(assigned)).toEqual(
      ['sessionId', 'handoffId', 'team', 'project', 'assignedTo', 'branch', 'steps', 'scope', 'startWith', 'hookWillAnnounce', 'hint', 'replayed'].sort(),
    );

    const inbox = await must('inbox', {}, worker);
    plain(inbox, 'inbox');
    const session = await must('get_session', { session_id: assigned.sessionId }, worker);
    plain(session, 'get_session');

    const accepted = await must('update_handoff', { session_id: assigned.sessionId, action: 'accept' }, worker);
    plain(accepted, 'accept');
    expect(keysOf(accepted)).toEqual(G_KEYS.assignmentAccept);

    const started = await must(
      'start_run',
      { request_id: randomUUID(), ...JSON.parse(assigned.startWith), head_sha: sha() },
      worker,
    );
    plain(started, 'start_run');
    expect(keysOf(started)).toEqual(G_KEYS.startRun);
    const runId = started.runId as string;

    const resumed = await must('update_handoff', { session_id: assigned.sessionId, action: 'resume' }, worker);
    plain(resumed, 'resume');
    expect(keysOf(resumed)).toEqual(G_KEYS.assignmentResume);

    const head = sha();
    const updated = await must(
      'update_run',
      {
        run_id: runId,
        checkpoint: { request_id: randomUUID(), kind: 'delivery', repository_identity: REPO, commit_sha: head, worktree_clean: true, tests: [{ name: 'npm test', state: 'passed' }] },
      },
      worker,
    );
    plain(updated, 'update_run');
    expect(keysOf(updated)).toEqual(G_KEYS.updateRun);

    const completed = await must('update_handoff', { session_id: assigned.sessionId, action: 'complete' }, worker);
    plain(completed, 'complete');
    expect(keysOf(completed)).toEqual(G_KEYS.assignmentComplete);

    // The worker hands the branch back to the lead's agent by name.
    const handed = await must(
      'handoff_work',
      {
        request_id: randomUUID(),
        branch: 'pd-12-footer',
        summary: 'The footer carries the support address; the label tests pass.',
        next_steps: ['Review the footer on a printed label.'],
        reason: 'end_of_day',
        to_agent: 'Old Lead',
        run_id: runId,
      },
      worker,
    );
    plain(handed, 'handoff_work');
    expect(keysOf(handed)).toEqual(G_KEYS.handoffWork);

    const back = await must('update_handoff', { session_id: handed.sessionId, action: 'accept' }, lead);
    plain(back, 'handoff accept');
    expect(keysOf(back)).toEqual(G_KEYS.handoffAccept);
    // The handoff carries the run's Knowledge context, so its resume names a
    // receiving run that began at the handed-over commit, as it always has.
    const receiving = await must(
      'start_run',
      {
        request_id: randomUUID(),
        project: 'parcel-desk',
        repository_identity: REPO,
        task: 'PD-12 Footer',
        branch: 'pd-12-footer',
        checkpoint: { request_id: randomUUID(), kind: 'start', repository_identity: REPO, commit_sha: head, worktree_clean: true },
      },
      lead,
    );
    plain(receiving, 'receiving start_run');
    expect(keysOf(receiving)).toEqual(G_KEYS.startRun);
    const resumedBack = await must(
      'update_handoff',
      { session_id: handed.sessionId, action: 'resume', run_id: receiving.runId, repository_identity: REPO, commit_sha: head, worktree_clean: true },
      lead,
    );
    plain(resumedBack, 'handoff resume');
    expect(keysOf(resumedBack)).toEqual(G_KEYS.handoffResume);
    expect(resumedBack.verification).toMatchObject({ verified: true, commitSha: head });
    // The lifecycle row itself is the one an old client always read.
    for (const reply of [accepted, resumed, completed, back, resumedBack]) {
      expect(keysOf(reply.handoff)).toEqual(HANDOFF_ROW_KEYS);
    }
    const done = await must('update_handoff', { session_id: handed.sessionId, action: 'complete' }, lead);
    plain(done, 'handoff complete');
    expect(keysOf(done)).toEqual(G_KEYS.handoffComplete);

    // None of it touched a work item: no link names the assignment, the handoff or the run.
    for (const target of [eq(workLinks.handoffId, assigned.handoffId), eq(workLinks.runId, runId)]) {
      expect(await srv.db.select().from(workLinks).where(target)).toHaveLength(0);
    }
    const [offer] = await srv.db.select().from(handoffs).where(eq(handoffs.sessionId, handed.sessionId));
    expect(await srv.db.select().from(workLinks).where(eq(workLinks.handoffId, offer!.id))).toHaveLength(0);
  });
});

/**
 * The top-level keys each reply of scenario G had before Native Work existed,
 * read by running the same round against the commit Native Work branched from
 * (4b06a82), where every nested key of every reply was also the same. A key
 * added here is a change an old client sees.
 */
const G_KEYS: Record<string, string[]> = {
  assignmentAccept: ['handoff', 'next', 'provenance', 'safety'],
  startRun: [
    'advisory',
    'agent',
    'attemptGroup',
    'checkpoint',
    'conflicts',
    'enforcement',
    'hint',
    'issueUrl',
    'knowledgeContext',
    'leaseMinutes',
    'policy',
    'policyHint',
    'project',
    'replayed',
    'role',
    'runId',
    'task',
    'team',
    'usageHint',
    'waitingLeaseMinutes',
  ],
  assignmentResume: ['handoff', 'knowledgeUpdate', 'next', 'provenance', 'safety', 'verification'],
  updateRun: ['checkpoint', 'conflicts', 'leaseMinutes', 'runId', 'status'],
  assignmentComplete: ['handoff', 'provenance', 'safety'],
  handoffWork: [
    'assignedTo',
    'branch',
    'checkpoint',
    'externalNotifications',
    'hint',
    'knowledgeContext',
    'pickUpWith',
    'replayed',
    'runFinished',
    'scopeReleased',
    'sessionId',
    'steps',
    'team',
    'to',
  ],
  handoffAccept: ['handoff', 'next', 'provenance', 'safety'],
  handoffResume: ['handoff', 'knowledgeUpdate', 'next', 'provenance', 'safety', 'verification'],
  handoffComplete: ['handoff', 'provenance', 'safety'],
};

/** The handoff row every update_handoff reply carries, as it was before Native Work. */
const HANDOFF_ROW_KEYS = [
  'acceptedAt',
  'acceptedBy',
  'checkpointId',
  'completedAt',
  'createdAt',
  'id',
  'installationId',
  'kind',
  'knowledgeContextId',
  'offeredBy',
  'resumedAt',
  'resumedKnowledgeContextId',
  'sessionId',
  'state',
  'targetInstallationId',
  'targetUserId',
  'updatedAt',
];
