import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { renderNews, type News } from '../../cli/src/news';
import { agentInstallations, agentRuns, debugSessions, projects, teams, workClaims } from '../src/db/schema';
import { loadEnv } from '../src/env';
import { clickupOutbox } from '../src/lib/clickup';
import { githubOutbox } from '../src/lib/github';
import { jiraOutbox } from '../src/lib/jira';
import { startServer, type StartedServer } from '../src/server';

/**
 * A lead dispatching work to agents by name.
 *
 * The 2026-09-17 two-device round began every stage with "go to the other
 * machine and type…", which is the friction the product claims to remove. An
 * assignment is that sentence said once, from anywhere: it names an agent, the
 * agent picks it up from its own inbox, and no other agent can take it — not
 * even a second agent on the same account, which is the common case and the
 * one user-level addressing could never express.
 *
 * Three agents here, two of them called "Codex B" on purpose: the lead's own
 * two machines plus a teammate whose agent has the same name, because the
 * ambiguity is the realistic failure and the name resolution has to refuse it
 * rather than pick one.
 */

let srv: StartedServer;
let dataDir: string;
let leadCookie: Record<string, string> = {};
let bobCookie: Record<string, string> = {};
/** Enrollment-bound credentials, one per agent, plus what whoami said each is. */
let codexA = '';
let codexB = '';
let bobsCodexB = '';
let codexAInstallation = '';
let codexBInstallation = '';
let bobsCodexBInstallation = '';
let teamId = '';

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

const form = (url: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });

let rpcId = 1;
async function call(tool: string, args: Record<string, unknown>, tok: string) {
  const res = await fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${tok}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId++,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
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

const news = async (tok: string) =>
  (await fetch(`${srv.url}/api/agent/news`, { headers: { authorization: `Bearer ${tok}` } })).json() as Promise<News>;

/** One enrolled, client-confirmed agent: the shape every real connection has. */
async function connectAgent(
  cookie: Record<string, string>,
  teamId: string,
  name: string,
  device: string,
  access = `team:${teamId}`,
) {
  const page = await form(
    `${srv.url}/app/tokens`,
    { name, device, access, client: 'codex', role: 'generalist' },
    cookie,
  );
  const html = await page.text();
  const code = /(?:&quot;|")STMA_ENROLLMENT_CODE(?:&quot;|")\s*:\s*(?:&quot;|")([^"&<]+)/.exec(html)?.[1];
  expect(code, `enrollment code for ${name}`).toMatch(/^stma_enroll_/);
  const redeemed = (await (
    await fetch(`${srv.url}/api/agent-enrollments/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
  ).json()) as { token: string };
  expect(redeemed.token).toMatch(/^stma_/);
  // Bootstrap authority becomes a working credential only once the client
  // confirms it loaded the tools — exactly as a real client would.
  const who = await call('whoami', {}, redeemed.token);
  expect(who.isError, who.text).toBe(false);
  return { token: redeemed.token, installationId: who.data.credential.installationId as string };
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-assign-'));
  srv = await startServer(
    loadEnv({
      port: 0,
      host: '127.0.0.1',
      nodeEnv: 'test',
      devMode: true,
      databaseUrl: undefined,
      pgliteDir: dataDir,
      // So the ClickUp half of the ticket field can be exercised here: its
      // connection is a browser OAuth flow, not a pasted token.
      clickup: { clientId: 'clickup-client-assign', clientSecret: 'clickup-secret-assign' },
    }),
  );

  const lead = jar();
  lead.store(await form(`${srv.url}/auth/dev`, { username: 'lead' }));
  leadCookie = lead.header();
  await form(`${srv.url}/app/teams`, { name: 'Parcel Desk' }, leadCookie);
  const [team] = await srv.db.select().from(teams).where(eq(teams.slug, 'parcel-desk'));
  expect(team).toBeTruthy();

  await form(`${srv.url}/app/teams/parcel-desk/invites`, {}, leadCookie);
  const people = await (
    await fetch(`${srv.url}/app/teams/parcel-desk?tab=people`, { headers: leadCookie })
  ).text();
  const invite = /\/join\/([A-Za-z0-9_-]+)/.exec(people)?.[1] ?? '';
  expect(invite, 'invite code').toBeTruthy();
  const bob = jar();
  bob.store(await form(`${srv.url}/auth/dev`, { username: 'bob' }));
  bobCookie = bob.header();
  await form(`${srv.url}/join/${invite}`, {}, bobCookie);

  teamId = team!.id;
  const a = await connectAgent(leadCookie, team!.id, 'codex-a', 'mac');
  codexA = a.token;
  codexAInstallation = a.installationId;
  const b = await connectAgent(leadCookie, team!.id, 'Codex B', 'win');
  codexB = b.token;
  codexBInstallation = b.installationId;
  const bobs = await connectAgent(bobCookie, team!.id, 'Codex B', 'linux');
  bobsCodexB = bobs.token;
  bobsCodexBInstallation = bobs.installationId;
});

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

it('lists every connected agent under its owner, by the name assign_work takes', async () => {
  const { data, isError, text } = await call('list_teammates', { team: 'parcel-desk' }, codexA);
  expect(isError, text).toBe(false);
  const lead = data.members.find((m: any) => m.username === 'lead');
  const bob = data.members.find((m: any) => m.username === 'bob');
  expect(lead.agents.map((a: any) => a.agent).sort()).toEqual(['Codex B', 'codex-a']);
  expect(lead.agents.find((a: any) => a.agent === 'Codex B').device).toBe('win');
  expect(bob.agents.map((a: any) => a.agent)).toEqual(['Codex B']);
  expect(data.hint).toContain('assign_work');
});

const brief =
  'Add a Clear filters button next to the destination and status filters.\nKeep the change to the UI and its tests; the backend is somebody else\'s.';
let sessionId = '';
const requestId = randomUUID();

it('refuses an ambiguous name and resolves it once the owner is named', async () => {
  const ambiguous = await call(
    'assign_work',
    { to_agent: 'codex b', task: 'PD-7 Clear filters', brief, team: 'parcel-desk', project: 'parcel-desk-api' },
    codexA,
  );
  expect(ambiguous.isError).toBe(true);
  expect(ambiguous.text).toContain('names 2 agents');
  expect(ambiguous.text).toContain('"to"');

  const assigned = await call(
    'assign_work',
    {
      request_id: requestId,
      to_agent: 'codex b',
      to: 'lead',
      task: 'PD-7 Clear filters',
      brief,
      next_steps: ['Run the UI tests', 'Commit and push on the current branch'],
      team: 'parcel-desk',
      project: 'parcel-desk-api',
      via: 'claude-code',
    },
    codexA,
  );
  expect(assigned.isError, assigned.text).toBe(false);
  expect(assigned.data.assignedTo).toEqual({ agent: 'Codex B', device: 'win', owner: 'lead' });
  expect(assigned.data.project).toBe('parcel-desk-api');
  expect(assigned.data.steps).toBe(2);
  const start = JSON.parse(assigned.data.startWith);
  expect(start).toMatchObject({
    team: 'parcel-desk',
    project: 'parcel-desk-api',
    task: 'PD-7 Clear filters',
    agent: 'Codex B',
  });
  expect(start.intent).toBe('Add a Clear filters button next to the destination and status filters.');
  sessionId = assigned.data.sessionId;

  // Same request_id, same arguments: the original, not a second assignment.
  const again = await call(
    'assign_work',
    {
      request_id: requestId,
      to_agent: 'codex b',
      to: 'lead',
      task: 'PD-7 Clear filters',
      brief,
      next_steps: ['Run the UI tests', 'Commit and push on the current branch'],
      team: 'parcel-desk',
      project: 'parcel-desk-api',
      via: 'claude-code',
    },
    codexA,
  );
  expect(again.data.replayed).toBe(true);
  expect(again.data.sessionId).toBe(sessionId);
});

it('shows the assignment as the named agent\'s own, and as somebody else\'s to every other agent', async () => {
  const mine = await call('inbox', { team: 'parcel-desk' }, codexB);
  expect(mine.data.pendingHandoffs).toHaveLength(1);
  expect(mine.data.pendingHandoffs[0]).toMatchObject({
    kind: 'assignment',
    assignedTo: { agent: 'Codex B', device: 'win' },
    forThisAgent: true,
    yours: true,
    fromThisMachine: false,
    steps: 2,
  });
  expect(mine.data.hint).toContain('assigned to this agent by name');

  // The lead's other agent wrote it: its own dispatch, not work waiting for it.
  const sender = await call('inbox', { team: 'parcel-desk' }, codexA);
  expect(sender.data.pendingHandoffs[0]).toMatchObject({ forThisAgent: false, fromThisMachine: true });
  expect(sender.data.hint).not.toContain('assigned to this agent by name');

  // Bob's agent has the same name and is not the one named.
  const bob = await call('inbox', { team: 'parcel-desk' }, bobsCodexB);
  expect(bob.data.pendingHandoffs[0]).toMatchObject({ forThisAgent: false, yours: false });
});

it('reaches only the named agent through the news endpoint and the prompt hook', async () => {
  const forB = await news(codexB);
  expect(forB.pendingHandoffs).toHaveLength(1);
  const waiting = forB.pendingHandoffs[0]!;
  expect(waiting.kind).toBe('assignment');
  expect(waiting.assignedTo).toEqual({ agent: 'Codex B', device: 'win', thisAgent: true });
  expect(waiting.resume?.reclaim?.tool).toBe('start_run');
  expect(waiting.resume?.reclaim?.arguments).toMatchObject({ project: 'parcel-desk-api' });

  // Not news to the sender's machine, and not news to a same-named stranger.
  expect((await news(codexA)).pendingHandoffs).toHaveLength(0);
  expect((await news(bobsCodexB)).pendingHandoffs).toHaveLength(0);

  const hook = renderNews(forB.pendingHandoffs, forB.unreadSessions)!;
  // A checkout can load a second STMA entry with another identity (a user-scope one
  // for another server, measured 2026-09-19); the hook names its own server first.
  const named = renderNews(forB.pendingHandoffs, forB.unreadSessions, 'stma-b1-50a2')!;
  expect(named.startsWith('STMA — the calls below belong to the MCP server named "stma-b1-50a2".')).toBe(true);
  expect(named).toContain('do not use it for them');
  expect(hook).not.toContain('MCP server named');
  expect(hook).toContain('work assigned to this agent by name');
  expect(hook).toContain('PD-7 Clear filters');
  expect(hook).toContain('update_handoff');
  expect(hook).toContain('start_run');
  expect(hook).toContain('unless they object');
  // The brief is work, not an unread reply. While it counted as one, "ask before
  // acting — do not start a run unprompted" followed the instruction to accept,
  // and in the two-device round of 2026-09-19 a careful agent asked its human first.
  expect(forB.unreadSessions).toBe(0);
  expect(hook).not.toContain('ask before acting');
  expect(hook).not.toContain('unread replies');
  // The whole lifecycle, once: told only to accept, agents completed work they had
  // never resumed and were refused.
  expect(hook).toContain('"resume" when you begin and "complete" when the work is done');

  // Something else really is waiting: it comes after the assignment's closing and
  // says it is separate, instead of forbidding the run the assignment just asked for.
  const busy = renderNews(forB.pendingHandoffs, 3)!;
  expect(busy.indexOf('unless they object')).toBeLessThan(busy.indexOf('3 debug sessions have unread replies'));
  expect(busy).toContain('separate from the assigned work and does not hold it up');
  expect(busy).not.toContain('start a run unprompted');
});

it('lets only the named installation accept, resume and complete it', async () => {
  const wrongMachine = await call('update_handoff', { session_id: sessionId, action: 'accept' }, codexA);
  expect(wrongMachine.isError).toBe(true);
  expect(wrongMachine.text).toContain('assigned by name to Codex B on win');

  const stranger = await call('update_handoff', { session_id: sessionId, action: 'accept' }, bobsCodexB);
  expect(stranger.isError).toBe(true);

  const read = await call('get_session', { session_id: sessionId }, codexB);
  expect(read.data.handoff.state).toBe('offered');
  expect(read.data.messages[0].resume.kind).toBe('assignment');
  expect(read.data.messages[0].resume.assignedTo.agent).toBe('Codex B');
  expect(read.data.messages[0].body).toContain('**Assigned to Codex B**');

  // Out of order, the refusal names the call that is missing. Measured 2026-09-19:
  // every one of four real agents was refused at least once in this lifecycle, and
  // across the agent lab's runs 48 of 188 update_handoff calls failed.
  const tooEarly = await call('update_handoff', { session_id: sessionId, action: 'resume' }, codexB);
  expect(tooEarly.isError).toBe(true);
  expect(tooEarly.text).toContain('Cannot resume an offered handoff. Send action "accept" first');

  const accepted = await call('update_handoff', { session_id: sessionId, action: 'accept' }, codexB);
  expect(accepted.isError, accepted.text).toBe(false);
  expect(accepted.data.handoff.state).toBe('accepted');
  // The reply is the instruction: the exact next call, and that an assignment needs nothing more.
  expect(accepted.data.next.call).toEqual({ tool: 'update_handoff', arguments: { session_id: sessionId, action: 'resume' } });
  expect(accepted.data.next.alsoSend).toEqual([]);
  expect(accepted.data.next.then).toContain('Complete is refused before resume');

  const skipped = await call('update_handoff', { session_id: sessionId, action: 'complete' }, codexB);
  expect(skipped.isError).toBe(true);
  expect(skipped.text).toContain('Cannot complete an accepted handoff. It is accepted but not resumed: send action "resume" first');

  // No source checkpoint to verify against — and the answer says why. Two of the
  // three repository fields is what agents sent, because the old description named
  // two; with nothing to verify that is a note, not a refusal.
  const resumed = await call(
    'update_handoff',
    { session_id: sessionId, action: 'resume', repository_identity: 'github.com/parcel/desk-api', worktree_clean: true },
    codexB,
  );
  expect(resumed.isError, resumed.text).toBe(false);
  expect(resumed.data.verification.verified).toBe(false);
  expect(resumed.data.verification.reason).toContain('Assignment');
  expect(resumed.data.verificationNote).toContain('Nothing was verified: commit_sha was not sent');
  expect(resumed.data.verificationNote).toContain('carries no code to verify');
  expect(resumed.data.next.call.arguments).toEqual({ session_id: sessionId, action: 'complete' });

  const done = await call('update_handoff', { session_id: sessionId, action: 'complete' }, codexB);
  expect(done.isError, done.text).toBe(false);
  expect(done.data.handoff.state).toBe('completed');
  expect((await news(codexB)).pendingHandoffs).toHaveLength(0);
});

it('names what exists when the agent does not, and refuses a credential step', async () => {
  const nobody = await call(
    'assign_work',
    { to_agent: 'nobody', task: 'PD-9 Anything', brief: 'Nothing that matters here.', team: 'parcel-desk' },
    codexA,
  );
  expect(nobody.isError).toBe(true);
  expect(nobody.text).toContain('No agent called "nobody"');
  expect(nobody.text).toContain('Connected agents:');
  expect(nobody.text).toContain('codex-a (lead)');

  const unsafe = await call(
    'assign_work',
    {
      to_agent: 'codex-a',
      task: 'PD-10 Sandbox check',
      brief: 'Verify the carrier sandbox from your machine.',
      next_steps: ['Copy the .env from the source machine and use it locally'],
      team: 'parcel-desk',
    },
    codexB,
  );
  expect(unsafe.isError).toBe(true);
  expect(unsafe.text).toContain('credential');
});

it('creates the same record from the project page, and shows who it names', async () => {
  const page = await (
    await fetch(`${srv.url}/app/teams/parcel-desk/projects/parcel-desk-api`, { headers: leadCookie })
  ).text();
  expect(page).toContain('Assign work');
  expect(page).toContain('id="assign-work"');
  expect(page).toContain(`value="${codexBInstallation}"`);

  const tooShort = await form(
    `${srv.url}/app/teams/parcel-desk/projects/parcel-desk-api/assign`,
    { agent: codexBInstallation, task: 'x', brief: 'A brief that is long enough to pass.', steps: '', branch: '' },
    leadCookie,
  );
  expect(tooShort.status).toBe(302);
  expect(tooShort.headers.get('location')).toContain('assign_error=');

  const created = await form(
    `${srv.url}/app/teams/parcel-desk/projects/parcel-desk-api/assign`,
    {
      agent: codexBInstallation,
      task: 'PD-8 Carrier ETA priority',
      brief: 'Give late parcels priority high based on the carrier ETA result.',
      steps: 'Run the backend tests\nCommit and push on the current branch',
      branch: '',
    },
    leadCookie,
  );
  expect(created.status).toBe(302);
  // Back on the project, not inside the thread: the lead is dispatching, and the
  // thread lives under another part of the console with no way back.
  const location = created.headers.get('location') ?? '';
  const assigned = /^\/app\/teams\/parcel-desk\/projects\/parcel-desk-api\?assigned=([0-9a-f-]{36})#assigned-work$/.exec(location)?.[1];
  expect(assigned, location).toBeTruthy();
  const landed = await (await fetch(`${srv.url}${location.split('#')[0]}`, { headers: leadCookie })).text();
  expect(landed).toContain('went to <b>Codex B on win</b>');
  expect(landed).toContain('Assign another');
  expect(landed).toContain(`href="/app/sessions/${assigned}"`);

  const thread = await (await fetch(`${srv.url}/app/sessions/${assigned}`, { headers: leadCookie })).text();
  expect(thread).toContain('Assigned by name to');
  expect(thread).toContain('Codex B');
  // And the way back to where it was dispatched from.
  expect(thread).toContain('href="/app/teams/parcel-desk/projects/parcel-desk-api#assigned-work"');
  const ledger = await (await fetch(`${srv.url}/app/handoffs`, { headers: leadCookie })).text();
  expect(ledger).toContain('assigned to Codex B');

  // And the agent sees it exactly as it sees one made over MCP.
  const forB = await news(codexB);
  expect(forB.pendingHandoffs.map((h) => h.title)).toEqual(['Assignment: PD-8 Carrier ETA priority']);
  expect(forB.pendingHandoffs[0]!.assignedTo?.thisAgent).toBe(true);
  expect(forB.pendingHandoffs[0]!.resume?.steps).toEqual([
    'Run the backend tests',
    'Commit and push on the current branch',
  ]);
});

// ------------------------------------------------------- dispatching a ticket

/**
 * A lead assigning a Jira issue without retyping it.
 *
 * `start_run` already reads a ticket-shaped task key, and lets a tracker failure
 * pass in silence, because a run must never die because Jira blinked. Here the
 * opposite is right: somebody typed that key into a form and is waiting to see
 * the issue's own words, so a failure is said out loud rather than quietly
 * producing an assignment that names a ticket nobody read.
 */
it('pulls a Jira issue into an assignment, and says so when it cannot', async () => {
  jiraOutbox.clear();
  const connected = await form(
    `${srv.url}/app/teams/parcel-desk/integrations/jira`,
    {
      action: 'save',
      site: 'matteai.atlassian.net',
      email: 'lead@example.dev',
      token: 'ATATT-parcel-desk',
    },
    leadCookie,
  );
  expect(connected.headers.get('location') ?? '', 'jira connect').toContain('verified');

  // The field appears only for a workspace that has a site to read.
  const page = await (
    await fetch(`${srv.url}/app/teams/parcel-desk/projects/parcel-desk-api`, { headers: leadCookie })
  ).text();
  expect(page).toContain('name="ticket"');
  expect(page).toContain('for="assign-ticket">Ticket');
  // Only the trackers this project actually has are named in the help.
  expect(page).toContain('PROJ-42. STMA reads it');

  // Nothing typed but the key: the task becomes the key and the brief becomes
  // the issue's summary, with the link the receiving agent can open.
  const created = await form(
    `${srv.url}/app/teams/parcel-desk/projects/parcel-desk-api/assign`,
    { agent: bobsCodexBInstallation, ticket: 'pd-42', task: '', brief: '', steps: '', branch: '' },
    leadCookie,
  );
  expect(created.status, created.headers.get('location') ?? '').toBe(302);
  const session = /assigned=([0-9a-f-]{36})/.exec(created.headers.get('location') ?? '')?.[1];
  expect(session).toBeTruthy();
  expect(jiraOutbox.all().some((c) => c.path.includes('/issue/PD-42'))).toBe(true);

  const thread = await (await fetch(`${srv.url}/app/sessions/${session}`, { headers: leadCookie })).text();
  expect(thread).toContain('Seeded summary for PD-42');
  expect(thread).toContain('https://matteai.atlassian.net/browse/PD-42');
  // Lower case in, upper case out: one spelling reaches the run and the ledger.
  expect(thread).toContain('PD-42');
  expect(thread).not.toContain('pd-42');

  // A brief the lead did write keeps its first line, because that line is what
  // becomes the run intent.
  const withBrief = await form(
    `${srv.url}/app/teams/parcel-desk/projects/parcel-desk-api/assign`,
    {
      agent: bobsCodexBInstallation,
      ticket: 'PD-43',
      task: '',
      brief: 'Do the smallest version of this first.',
      steps: '',
      branch: '',
    },
    leadCookie,
  );
  const second = /assigned=([0-9a-f-]{36})/.exec(withBrief.headers.get('location') ?? '')?.[1];
  const secondThread = await (
    await fetch(`${srv.url}/app/sessions/${second}`, { headers: leadCookie })
  ).text();
  expect(secondThread.indexOf('Do the smallest version')).toBeLessThan(
    secondThread.indexOf('Seeded summary for PD-43'),
  );

  // A key that is not one is refused by shape, before any request goes out.
  const before = jiraOutbox.all().length;
  const nonsense = await form(
    `${srv.url}/app/teams/parcel-desk/projects/parcel-desk-api/assign`,
    { agent: bobsCodexBInstallation, ticket: 'not a key', task: '', brief: '', steps: '', branch: '' },
    leadCookie,
  );
  // The refusal names the shapes that would have worked here, which is the
  // only version of it a person can act on.
  const saidNonsense = decodeURIComponent(nonsense.headers.get('location') ?? '');
  expect(saidNonsense).toContain('is not a ticket this workspace can read');
  expect(saidNonsense).toContain('PROJ-42');
  expect(jiraOutbox.all().length).toBe(before);

  // And a tracker that refuses is named, rather than passing in silence the way
  // start_run deliberately does.
  jiraOutbox.seedAuthFailure(true);
  const refused = await form(
    `${srv.url}/app/teams/parcel-desk/projects/parcel-desk-api/assign`,
    { agent: bobsCodexBInstallation, ticket: 'PD-44', task: '', brief: '', steps: '', branch: '' },
    leadCookie,
  );
  const said = decodeURIComponent(refused.headers.get('location') ?? '');
  expect(said).toContain('Could not read PD-44');
  expect(said).toContain('assign_error=');
  jiraOutbox.clear();

  // Nothing was dispatched by either refusal.
  const forBob = await news(bobsCodexB);
  expect(forBob.pendingHandoffs.some((h) => h.title.includes('PD-44'))).toBe(false);
  expect(forBob.pendingHandoffs.some((h) => h.title.includes('not a key'))).toBe(false);
});

/**
 * The same field, for the other two trackers.
 *
 * Which one a person meant is read off the shape they typed, not from a picker:
 * a GitHub reference carries a `#` or a github.com URL, a Jira key is
 * `PROJ-42`, and ClickUp is its own link. The lead pastes what their team
 * already says out loud, and the form does not ask them to classify it first.
 */
it('reads a GitHub issue or a ClickUp task into an assignment from the same field', async () => {
  githubOutbox.clear();
  githubOutbox.seedIssues([
    {
      number: 91,
      title: 'Carrier webhook retries forever',
      url: 'https://github.com/parcel/desk/issues/91',
      labels: ['bug'],
      updatedAt: '2026-09-19T09:00:00.000Z',
    },
  ]);
  expect(
    (await form(
      `${srv.url}/app/teams/parcel-desk/integrations/github`,
      { action: 'save', repo: 'parcel/desk', token: 'ghp-parcel-desk', comment_on_finish: '' },
      leadCookie,
    )).headers.get('location') ?? '',
  ).toContain('ok=');

  // The help now names both connected trackers, so a person reading the field
  // knows which spellings will work before typing one.
  const withBoth = await (
    await fetch(`${srv.url}/app/teams/parcel-desk/projects/parcel-desk-api`, { headers: leadCookie })
  ).text();
  expect(withBoth).toContain('PROJ-42, #42 or owner/repo#42');

  // A bare #91 resolves against the connected repository, and the task key that
  // reaches the ledger names the repository too: a number on its own says
  // nothing next to another project's work.
  const fromGithub = await form(
    `${srv.url}/app/teams/parcel-desk/projects/parcel-desk-api/assign`,
    { agent: bobsCodexBInstallation, ticket: '#91', task: '', brief: '', steps: '', branch: '' },
    leadCookie,
  );
  expect(fromGithub.status, fromGithub.headers.get('location') ?? '').toBe(302);
  const ghSession = /assigned=([0-9a-f-]{36})/.exec(fromGithub.headers.get('location') ?? '')?.[1];
  const ghThread = await (await fetch(`${srv.url}/app/sessions/${ghSession}`, { headers: leadCookie })).text();
  expect(ghThread).toContain('Carrier webhook retries forever');
  expect(ghThread).toContain('https://github.com/parcel/desk/issues/91');
  expect(ghThread).toContain('parcel/desk#91');

  // An issue the repository does not have is said out loud, not passed over.
  const missing = await form(
    `${srv.url}/app/teams/parcel-desk/projects/parcel-desk-api/assign`,
    { agent: bobsCodexBInstallation, ticket: 'parcel/desk#404', task: '', brief: '', steps: '', branch: '' },
    leadCookie,
  );
  expect(decodeURIComponent(missing.headers.get('location') ?? '')).toContain('Could not read parcel/desk#404');

  // ---- ClickUp, whose connection is a browser OAuth flow rather than a token.
  clickupOutbox.clear();
  clickupOutbox.seed({
    tasks: [
      {
        id: 'cu-parcel-7',
        customId: 'PD-207',
        name: 'Split the label printer queue',
        url: 'https://app.clickup.com/t/cu-parcel-7',
        status: 'in progress',
        updatedAt: '2026-09-19T10:00:00.000Z',
      },
    ],
  });
  const start = await fetch(`${srv.url}/app/teams/parcel-desk/integrations/clickup/start`, {
    headers: leadCookie,
    redirect: 'manual',
  });
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get('location')!);
  const connectCookie = start.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ');
  const callback = await fetch(
    `${srv.url}/auth/clickup/callback?state=${encodeURIComponent(authorize.searchParams.get('state')!)}&code=one-use-code`,
    { headers: { cookie: `${leadCookie.cookie}; ${connectCookie}` }, redirect: 'manual' },
  );
  expect(callback.headers.get('location')).toContain('Connected');
  const integrations = await (
    await fetch(`${srv.url}/app/teams/parcel-desk?tab=integrations`, { headers: leadCookie })
  ).text();
  const projectId = /option value="([a-f0-9-]+)">parcel-desk-api<\/option>/.exec(integrations)?.[1];
  expect(projectId, 'the project is offered for a List mapping').toBeTruthy();
  expect(
    (await form(
      `${srv.url}/app/teams/parcel-desk/integrations/clickup/binding`,
      { project_id: projectId!, list_id: '2200', comment_on_finish: '' },
      leadCookie,
    )).headers.get('location') ?? '',
  ).toContain('ok=');

  const fromClickup = await form(
    `${srv.url}/app/teams/parcel-desk/projects/parcel-desk-api/assign`,
    {
      agent: bobsCodexBInstallation,
      ticket: 'https://app.clickup.com/t/cu-parcel-7',
      task: '',
      brief: '',
      steps: '',
      branch: '',
    },
    leadCookie,
  );
  expect(fromClickup.status, fromClickup.headers.get('location') ?? '').toBe(302);
  const cuSession = /assigned=([0-9a-f-]{36})/.exec(fromClickup.headers.get('location') ?? '')?.[1];
  const cuThread = await (await fetch(`${srv.url}/app/sessions/${cuSession}`, { headers: leadCookie })).text();
  expect(cuThread).toContain('Split the label printer queue');
  expect(cuThread).toContain('https://app.clickup.com/t/cu-parcel-7');
  // The workspace's own custom id, not the opaque one, because that is what the
  // people in that workspace say to each other.
  expect(cuThread).toContain('PD-207');

  // STMA reads only the List mapped to this project, and the refusal names it
  // rather than leaving somebody to guess why a real task could not be read.
  clickupOutbox.seed({ taskListId: '9999' });
  const elsewhere = await form(
    `${srv.url}/app/teams/parcel-desk/projects/parcel-desk-api/assign`,
    {
      agent: bobsCodexBInstallation,
      ticket: 'clickup:cu-parcel-7',
      task: '',
      brief: '',
      steps: '',
      branch: '',
    },
    leadCookie,
  );
  const saidElsewhere = decodeURIComponent(elsewhere.headers.get('location') ?? '');
  expect(saidElsewhere).toContain('is not in Engineering');
  clickupOutbox.seed({ taskListId: '2200' });

  // Nothing was dispatched by either refusal.
  const forBob = await news(bobsCodexB);
  expect(forBob.pendingHandoffs.some((h) => h.title.includes('404'))).toBe(false);
});

// --------------------------------------------- picking one instead of pasting

/**
 * Picking a ticket instead of going to find its key.
 *
 * Pasting already worked, which is exactly the half that was missing: the lead
 * still had to leave STMA, find the ticket and come back with its reference.
 * The picker is a link, like every other selection in this console, and it ends
 * in the same place a paste does — `readNamedTicket` reads the reference again
 * when the form is submitted, so there is one path from a reference to a task
 * and a brief rather than a second one behind a list.
 *
 * GitHub and ClickUp only. Jira keeps the paste field and says why: Atlassian
 * moved issue search to `/rest/api/3/search/jql`, nothing here has exercised
 * that endpoint against a real site, and a guessed call would fail on a lead's
 * critical path rather than in a test.
 */
it('offers a connected tracker’s open tickets, and only fetches when asked', async () => {
  const projectUrl = `${srv.url}/app/teams/parcel-desk/projects/parcel-desk-api`;
  const read = async (query = '') =>
    (await fetch(`${projectUrl}${query}`, { headers: leadCookie })).text();

  githubOutbox.clear();
  // More than the picker draws, so the bound is a real one rather than a number
  // that happens to be larger than the fixture.
  githubOutbox.seedIssues(
    Array.from({ length: 26 }, (_, i) => ({
      number: 200 + i,
      title: `Open issue ${200 + i}`,
      url: `https://github.com/parcel/desk/issues/${200 + i}`,
      labels: i === 0 ? ['bug'] : [],
      updatedAt: new Date(Date.UTC(2026, 8, 19, 9, 0, 0) - i * 3600_000).toISOString(),
    })),
  );

  // Drawing the page reads the connections and fetches no ticket: a tracker
  // being slow must not make the project page slow.
  const quiet = githubOutbox.all().length;
  const plain = await read();
  expect(githubOutbox.all().length, 'the plain page asks GitHub nothing').toBe(quiet);
  expect(plain).toContain('Browse GitHub');
  expect(plain).toContain('Browse ClickUp');
  // Jira is connected here and is deliberately not offered; the page says so
  // rather than leaving a missing button to be wondered about.
  expect(plain).not.toContain('Browse Jira');
  expect(plain).toContain('Jira cannot be browsed or searched here yet');
  // Nothing is listed until somebody clicks, and the dialog stays closed.
  expect(plain).not.toContain('class="tickets"');
  expect(plain).not.toContain('data-auto-open');

  // ?pick= is the click. Now it fetches, once.
  const list = await read('?pick=github');
  expect(githubOutbox.all().length, 'the list is one request').toBe(quiet + 1);
  expect(list).toContain('class="tickets"');
  expect(list).toContain('Open issue 200');
  expect(list).toContain('parcel/desk#200');
  // Bounded: the twentieth is drawn, the twenty-first is not, and the list says
  // so rather than quietly stopping.
  expect(list).toContain('Open issue 219');
  expect(list).not.toContain('Open issue 220');
  expect(list).toContain('The 20 most recently updated open');
  // Open, so the person who clicked does not have to find the dialog again —
  // and with script it becomes a modal like every other dialog here.
  expect(list).toContain('data-auto-open');
  expect(/<dialog id="assign-work"[^>]*\sopen/.test(list)).toBe(true);

  // Choosing one is a link too, so it survives a refresh and can be pasted.
  const chosen = await read('?pick=github&ticket=parcel%2Fdesk%23207');
  expect(chosen).toContain('value="parcel/desk#207"');
  expect(chosen).toContain('aria-current="true"');
  expect(chosen).toContain('chosen');

  // And the reference the picker produced is one the paste path already reads:
  // the same field, the same handler, the same brief.
  const created = await form(
    `${srv.url}/app/teams/parcel-desk/projects/parcel-desk-api/assign`,
    {
      agent: bobsCodexBInstallation,
      ticket: 'parcel/desk#207',
      task: '',
      brief: '',
      steps: '',
      branch: '',
    },
    leadCookie,
  );
  expect(created.status, created.headers.get('location') ?? '').toBe(302);
  const session = /assigned=([0-9a-f-]{36})/.exec(created.headers.get('location') ?? '')?.[1];
  const thread = await (await fetch(`${srv.url}/app/sessions/${session}`, { headers: leadCookie })).text();
  expect(thread).toContain('Open issue 207');
  expect(thread).toContain('https://github.com/parcel/desk/issues/207');
  expect(thread).toContain('parcel/desk#207');

  // A tracker that refuses is named, the way the paste path names one. An empty
  // list and no explanation would read as "nothing open here".
  githubOutbox.seedAuthFailure(true);
  const broken = await read('?pick=github');
  expect(broken).toContain('Could not read open issues from parcel/desk');
  expect(broken).toContain('bad_token');
  expect(broken).not.toContain('class="tickets"');
  githubOutbox.seedAuthFailure(false);

  // Jira cannot be picked even by hand: an address naming it lists nothing
  // rather than reaching for an endpoint this codebase has never measured.
  const jiraCalls = jiraOutbox.all().length;
  const jiraPick = await read('?pick=jira');
  expect(jiraOutbox.all().length).toBe(jiraCalls);
  expect(jiraPick).not.toContain('class="tickets"');
  expect(jiraPick).toContain('Jira cannot be browsed or searched here yet');

  // ---- ClickUp, whose reference is the native id rather than the custom one.
  // Both id spaces are readable now (`isClickupCustomTaskId` picks the query),
  // so this is a choice about what to *store*: ClickUp guarantees the native id,
  // while a custom prefix is a per-space setting an administrator can change,
  // and a task key is read back long after it was written.
  const cuList = await read('?pick=clickup');
  expect(cuList).toContain('Split the label printer queue');
  expect(cuList).toContain('clickup%3Acu-parcel-7');
  expect(cuList).toContain('PD-207');

  const fromPick = await form(
    `${srv.url}/app/teams/parcel-desk/projects/parcel-desk-api/assign`,
    { agent: bobsCodexBInstallation, ticket: 'clickup:cu-parcel-7', task: '', brief: '', steps: '', branch: '' },
    leadCookie,
  );
  const cuSession = /assigned=([0-9a-f-]{36})/.exec(fromPick.headers.get('location') ?? '')?.[1];
  const cuThread = await (await fetch(`${srv.url}/app/sessions/${cuSession}`, { headers: leadCookie })).text();
  expect(cuThread).toContain('Split the label printer queue');
  // The custom id is what the brief says, because that is what the people in
  // that workspace call it...
  expect(cuThread).toContain('PD-207');
  // ...and the task the assignment records is the routable reference, which is
  // the half that used to be missing: `commentOnRunTracker` selects ClickUp on
  // the `clickup:` prefix and on nothing else, so an assignment carrying only
  // `PD-207` produced a run whose finish commented nowhere — on the one path
  // where the lead had proved which tracker they meant.
  expect(cuThread).toContain('clickup:cu-parcel-7');

  // A refusal brings the reference back with it. Picking a ticket and then
  // naming no agent used to cost the pick as well as the answer.
  const refused = await form(
    `${srv.url}/app/teams/parcel-desk/projects/parcel-desk-api/assign`,
    { agent: '', ticket: 'parcel/desk#207', task: '', brief: '', steps: '', branch: '' },
    leadCookie,
  );
  const where = refused.headers.get('location') ?? '';
  expect(decodeURIComponent(where)).toContain('Choose an agent');
  expect(decodeURIComponent(where)).toContain('ticket=parcel/desk#207');
  const back = await (await fetch(`${srv.url}${where}`, { headers: leadCookie })).text();
  expect(back).toContain('value="parcel/desk#207"');
  // And the reason is inside the dialog, because the modal covers the band.
  expect(back).toContain('banner banner-error');
  githubOutbox.clear();
});

// ------------------------------------------------------- typing, not scrolling

/**
 * Finding the ticket by typing a few words.
 *
 * Browsing closed the common case — the ticket the lead wants is one of the few
 * that are open — and left the other one wide open: bounded to twenty rows, a
 * workspace with two hundred open tickets shows exactly the twenty nobody is
 * looking for. Search is the rest of it, and it is the same link-shaped
 * selection as everything else here (`?pick=<tracker>&q=<words>`), reached by a
 * GET form of its own inside the dialog. Its controls sit beside the list
 * through the `form` attribute rather than inside that form, because assigning
 * is a POST, forms do not nest, and a submit button borrowing the assignment
 * form would carry a `maxlength=8000` brief through Node's 16 KiB header cap.
 *
 * **The two trackers reach different distances and the page says which.**
 * GitHub has a search endpoint, so GitHub searches the whole repository.
 * ClickUp's v2 API has no text parameter for tasks anywhere, so STMA reads a
 * bounded window of the mapped List and matches it in its own process — a real
 * limit, said in words rather than left for somebody whose ticket is the three
 * hundred and first. Jira is neither: nothing here has ever called
 * `/rest/api/3/search/jql` against a real site, so it is named on the page with
 * the reason instead of being guessed at on a lead's critical path.
 */
it('searches a connected tracker, and says how far the search reached', async () => {
  const projectUrl = `${srv.url}/app/teams/parcel-desk/projects/parcel-desk-api`;
  const read = async (query = '') =>
    (await fetch(`${projectUrl}${query}`, { headers: leadCookie })).text();
  /** What the transport was last asked, decoded the way the provider reads it. */
  const lastGithub = () => decodeURIComponent(githubOutbox.all().at(-1)?.path ?? '');

  githubOutbox.clear();
  githubOutbox.seedIssues([
    {
      number: 301,
      title: 'Label printer queue jams under load',
      url: 'https://github.com/parcel/desk/issues/301',
      labels: ['bug'],
      updatedAt: '2026-09-19T10:00:00.000Z',
    },
    {
      number: 302,
      title: 'Second label printer for the night shift',
      url: 'https://github.com/parcel/desk/issues/302',
      labels: [],
      updatedAt: '2026-09-19T09:00:00.000Z',
    },
    {
      number: 303,
      title: 'Courier handover receipts are unreadable',
      url: 'https://github.com/parcel/desk/issues/303',
      labels: [],
      updatedAt: '2026-09-19T08:00:00.000Z',
    },
  ]);

  // The box is on the page before anything is typed, and drawing it asks no
  // tracker anything: the page reads the connections and fetches on the search.
  const quiet = githubOutbox.all().length;
  const plain = await read();
  expect(githubOutbox.all().length, 'the plain page asks GitHub nothing').toBe(quiet);
  expect(plain).toContain('id="ticket-search"');
  expect(plain).toContain('form="ticket-search"');
  expect(plain).toContain('Search tickets');
  // Two pickable trackers here, so the box has to say which one it asks.
  expect(plain).toContain('aria-label="Tracker to search"');

  // Typing is one request, and it is GitHub's own search rather than a page of
  // the newest issues filtered afterwards: that is what reaches past the bound.
  const hits = await read('?pick=github&q=label+printer');
  expect(githubOutbox.all().length, 'a search is one request').toBe(quiet + 1);
  expect(lastGithub()).toContain('/search/issues');
  // The qualifiers are STMA's and cannot be typed over: this repository, issues
  // (an agent handed a pull request tries to "implement" a review), open only.
  expect(lastGithub()).toContain('q=repo:parcel/desk is:issue is:open label printer');
  expect(hits).toContain('Label printer queue jams under load');
  expect(hits).toContain('Second label printer for the night shift');
  expect(hits).not.toContain('Courier handover receipts');
  // What was searched, said where the list ends. GitHub looked at everything.
  expect(hits).toContain('GitHub searched every open issue in parcel/desk');
  // And the box keeps the words, so a refresh or the back button lands on the
  // same list rather than on an empty search.
  expect(hits).toContain('value="label printer"');

  // A search box, not a query language. GitHub reads `:` as a qualifier
  // separator and a leading `-` as NOT, so a lead typing either would get a 422
  // or a silently different search; the punctuation is dropped here instead.
  await read('?pick=github&q=printer%3A');
  expect(lastGithub()).toContain('q=repo:parcel/desk is:issue is:open printer&');
  await read('?pick=github&q=-queue%20printer');
  expect(lastGithub()).toContain('q=repo:parcel/desk is:issue is:open queue printer&');

  // Choosing a result is a link like every other selection here, and it carries
  // the search: picking one used to be the moment you lost the list.
  const chosen = await read('?pick=github&q=label+printer&ticket=parcel%2Fdesk%23302');
  expect(chosen).toContain('value="parcel/desk#302"');
  expect(chosen).toContain('aria-current="true"');
  expect(chosen).toContain('q=label%20printer');

  // And that reference is the one a paste produces, through the same reader:
  // there is no second way to build an assignment from a picked ticket.
  const created = await form(
    `${srv.url}/app/teams/parcel-desk/projects/parcel-desk-api/assign`,
    { agent: bobsCodexBInstallation, ticket: 'parcel/desk#302', task: '', brief: '', steps: '', branch: '' },
    leadCookie,
  );
  const session = /assigned=([0-9a-f-]{36})/.exec(created.headers.get('location') ?? '')?.[1];
  const thread = await (await fetch(`${srv.url}/app/sessions/${session}`, { headers: leadCookie })).text();
  expect(thread).toContain('Second label printer for the night shift');
  expect(thread).toContain('parcel/desk#302');

  // Nothing matched is a different answer from nothing open, and a person acts
  // differently on each: try other words, versus there is no work here.
  const none = await read('?pick=github&q=forklift');
  expect(none).toContain('matches');
  expect(none).toContain('Try fewer words');
  expect(none).not.toContain('class="tickets"');
  expect(none).not.toContain('right now. Paste a reference above');

  // A tracker that refuses is named where its rows would have been — an empty
  // list with no explanation reads as "nothing matched".
  githubOutbox.seedAuthFailure(true);
  const broken = await read('?pick=github&q=label');
  expect(broken).toContain('Could not search open issues in parcel/desk');
  expect(broken).toContain('bad_token');
  expect(broken).not.toContain('class="tickets"');
  githubOutbox.seedAuthFailure(false);

  // Jira cannot be searched even by an address naming it: nothing here has
  // measured that endpoint, so no call is made and the page says why.
  const jiraCalls = jiraOutbox.all().length;
  const jiraSearch = await read('?pick=jira&q=label');
  expect(jiraOutbox.all().length, 'no Jira call is invented').toBe(jiraCalls);
  expect(jiraSearch).not.toContain('class="tickets"');
  expect(jiraSearch).toContain('Jira cannot be browsed or searched here yet');

  // ---- ClickUp, which has no task search at all, so STMA reads and matches.
  // A hundred and fifty tasks: the one being looked for is past ClickUp's fixed
  // hundred-row page, which is the whole reason this pages rather than reading
  // the first page and calling it the list.
  const tasks = Array.from({ length: 150 }, (_, i) => ({
    id: `cu-bulk-${i}`,
    customId: `PD-${500 + i}`,
    name: i === 120 ? 'Reprint the courier manifest' : `Routine sweep ${i}`,
    url: `https://app.clickup.com/t/cu-bulk-${i}`,
    status: 'open',
    updatedAt: '2026-09-19T10:00:00.000Z',
  }));
  clickupOutbox.clear();
  clickupOutbox.seed({ tasks, taskListId: '2200' });

  const cuBefore = clickupOutbox.all().length;
  const cuHits = await read('?pick=clickup&q=courier+manifest');
  const cuPaths = clickupOutbox.all().slice(cuBefore).map((call) => call.path);
  // Two pages, then it stops: ClickUp said `last_page` on the second. A loop
  // that always made three calls would spend a request nobody asked for.
  expect(cuPaths.length, 'it pages, and stops where ClickUp says the list ends').toBe(2);
  expect(cuPaths[0]).toContain('page=0');
  expect(cuPaths[1]).toContain('page=1');
  expect(cuHits).toContain('Reprint the courier manifest');
  expect(cuHits).not.toContain('Routine sweep 0<');
  // The reference is the native id, as a browse or a paste produces.
  expect(cuHits).toContain('clickup%3Acu-bulk-120');
  // ...and the key beside it is what the people in that workspace say out loud.
  expect(cuHits).toContain('PD-620');
  // The bound is ClickUp's limitation named, not a number left to be inferred.
  expect(cuHits).toContain('API cannot search tasks');
  expect(cuHits).toContain('300 most recently updated open tasks in Engineering');

  // The key is searchable too: it is what somebody half-remembers.
  const byKey = await read('?pick=clickup&q=PD-620');
  expect(byKey).toContain('Reprint the courier manifest');

  // Bounded at the rows drawn, however many match: a hundred and forty-nine do
  // here, and the twentieth is the last one on the page.
  const many = await read('?pick=clickup&q=routine');
  expect(many).toContain('Routine sweep 19<');
  expect(many).not.toContain('Routine sweep 20<');

  // Browse is still the other question, and it clears the search rather than
  // filtering what it shows.
  const browse = await read('?pick=clickup');
  expect(browse).toContain('most recently updated open tasks in Engineering');
  expect(browse).not.toContain('API cannot search tasks');

  clickupOutbox.seedFailure('authorization_failed');
  const cuBroken = await read('?pick=clickup&q=courier');
  expect(cuBroken).toContain('Could not search Engineering in ClickUp');
  expect(cuBroken).toContain('authorization_failed');
  expect(cuBroken).not.toContain('class="tickets"');
  clickupOutbox.seedFailure(null);

  // Put the fixture back the way the suite found it.
  clickupOutbox.clear();
  clickupOutbox.seed({
    tasks: [
      {
        id: 'cu-parcel-7',
        customId: 'PD-207',
        name: 'Split the label printer queue',
        url: 'https://app.clickup.com/t/cu-parcel-7',
        status: 'in progress',
        updatedAt: '2026-09-19T10:00:00.000Z',
      },
    ],
    taskListId: '2200',
  });
  githubOutbox.clear();
});

// ------------------------------------------------- the adapter beside the agent

/**
 * A hooked checkout holds two installations: the agent's MCP connection and the
 * local adapter `stma adapter activate` authorized for itself. Until they were
 * paired nothing on the server connected them, and three things followed — the
 * hook never heard work assigned to the agent beside it, the adapter was offered
 * as somebody to assign work to, and a stopped edit named the adapter rather
 * than the agent the lead had given the task to (2026-09-19).
 *
 * The adapters here are activated the way the CLI does it: dynamic client
 * registration under the first-party name, browser consent, PKCE exchange, then
 * the identity call that confirms the installation.
 */

const WEB_REPO = 'github.com/example/parcel-desk-web';
const FONT_RULE = 'content: "Comic Sans" in public/** — not in the design system';
const verifier = 'lead-first-adapter-pairing-verifier-0123456789-abcdefghij';
const challenge = createHash('sha256').update(verifier).digest('base64url');
const callback = 'http://127.0.0.1:43211/callback';

let webProjectId = '';
let apiProjectId = '';
let claudeApiInstallation = '';
let adapter = { token: '', installationId: '' };
let strayAdapter = { token: '', installationId: '' };

async function oauthClient(clientName: string) {
  const registered = (await (
    await fetch(`${srv.url}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [callback],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    })
  ).json()) as { client_id: string };
  expect(registered.client_id).toMatch(/^stma_client_/);
  return registered.client_id;
}

const oauthFields = (clientId: string, state: string) => ({
  response_type: 'code',
  client_id: clientId,
  redirect_uri: callback,
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state,
  scope: 'stma offline_access',
  resource: `${srv.url}/mcp`,
});

const consentHtml = async (cookie: Record<string, string>, clientId: string, state: string) =>
  (
    await fetch(`${srv.url}/oauth/authorize?${new URLSearchParams(oauthFields(clientId, state))}`, {
      headers: cookie,
    })
  ).text();

const approve = (
  cookie: Record<string, string>,
  clientId: string,
  state: string,
  fields: Record<string, string>,
) =>
  form(
    `${srv.url}/oauth/authorize`,
    { ...oauthFields(clientId, state), decision: 'allow', role: 'generalist', ...fields },
    cookie,
  );

/** Consent through to a confirmed installation — everything `adapter activate` does over HTTP. */
async function activate(
  cookie: Record<string, string>,
  clientName: string,
  fields: Record<string, string>,
) {
  const clientId = await oauthClient(clientName);
  const approved = await approve(cookie, clientId, `state-${fields.name}`, fields);
  expect(approved.status, await approved.clone().text()).toBe(302);
  const code = new URL(approved.headers.get('location')!).searchParams.get('code');
  expect(code).toMatch(/^stma_oauth_code_/);
  const exchanged = (await (
    await fetch(`${srv.url}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code: code!,
        redirect_uri: callback,
        code_verifier: verifier,
        resource: `${srv.url}/mcp`,
      }),
    })
  ).json()) as { access_token: string };
  expect(exchanged.access_token).toMatch(/^stma_/);
  const identity = (await (
    await fetch(`${srv.url}/api/agent/identity`, {
      headers: { authorization: `Bearer ${exchanged.access_token}` },
    })
  ).json()) as { credential: { installationId: string; companion: unknown } };
  return {
    token: exchanged.access_token,
    installationId: identity.credential.installationId,
    identity: identity.credential,
  };
}

const installation = async (id: string) =>
  (await srv.db.select().from(agentInstallations).where(eq(agentInstallations.id, id)))[0]!;

it('asks a local adapter which agent it listens for, and no other client', async () => {
  const [api] = await srv.db.select().from(projects).where(eq(projects.name, 'parcel-desk-api'));
  apiProjectId = api!.id;
  // Created the way an owner creates a project before connecting a scoped
  // adapter — from its repository, so it is repository-bound — and assigned to
  // by the display name the console shows. That pairing is what used to fork.
  const created = await form(
    `${srv.url}/app/projects`,
    { team: 'parcel-desk', project: `https://${WEB_REPO}.git` },
    leadCookie,
  );
  expect(new URL(created.headers.get('location')!, srv.url).searchParams.get('ok')).toContain('Project created');
  const [web] = await srv.db.select().from(projects).where(eq(projects.repositoryIdentity, WEB_REPO));
  expect(web).toMatchObject({ name: 'parcel-desk-web', slug: 'parcel-desk-web' });
  webProjectId = web!.id;
  // An agent of the lead's that can only reach the *other* project.
  claudeApiInstallation = (
    await connectAgent(leadCookie, teamId, 'claude-api', 'win', `project:${apiProjectId}`)
  ).installationId;

  // And one whose client never loaded it: redeemed, never confirmed. It is not
  // revoked, and once its setup window lapses it can never accept anything.
  const prompt = await form(
    `${srv.url}/app/tokens`,
    { name: 'never-loaded', device: 'win', access: `team:${teamId}`, client: 'codex', role: 'generalist' },
    leadCookie,
  );
  const unconfirmed = (await (
    await fetch(`${srv.url}/api/agent-enrollments/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: /stma_enroll_[a-f0-9]{40}/.exec(await prompt.text())![0] }),
    })
  ).json()) as { installation: { id: string } };

  const clientId = await oauthClient('STMA local adapter (codex)');
  const page = await consentHtml(leadCookie, clientId, 'look');
  expect(page).toContain('Listens for');
  expect(page).not.toContain(unconfirmed.installation.id);
  // Its default name is what "via its adapter …" will show a lead.
  expect(page).toContain('value="codex-local-adapter"');
  expect(page).toContain('Choose the agent that works in this checkout');
  expect(page).toContain('Nobody — install the hooks without pairing');
  expect(page).toContain(`value="${codexBInstallation}"`);
  expect(page).toContain(`value="${codexAInstallation}"`);
  // Same owner only: a teammate's agent with the same name is never offered.
  expect(page).not.toContain(bobsCodexBInstallation);
  // The screen says what this client is going to do, not what an MCP client does.
  expect(page).toContain('local adapter for one checkout');
  expect(page).not.toContain('does not install local hooks or file guards');

  // An agent is nobody's ears, so its consent has no such question.
  const agentPage = await consentHtml(leadCookie, await oauthClient('Codex'), 'agent');
  expect(agentPage).not.toContain('Listens for');
  expect(agentPage).toContain('does not install local hooks or file guards');
});

it('answers a pairing that cannot hold on the consent form instead of a dead end', async () => {
  const clientId = await oauthClient('STMA local adapter (codex)');
  const fields = { name: 'lead-codex-local', device: 'win', access: `project:${webProjectId}` };

  const stranger = await approve(leadCookie, clientId, 'refused', { ...fields, companion: bobsCodexBInstallation });
  expect(stranger.status).toBe(400);
  const strangerPage = await stranger.text();
  expect(strangerPage).toContain('Choose one of your own connected agents');
  // What was typed is still in the form, so the fix is one select away.
  expect(strangerPage).toContain('value="lead-codex-local"');

  const unreachable = await approve(leadCookie, clientId, 'refused', { ...fields, companion: claudeApiInstallation });
  expect(unreachable.status).toBe(400);
  expect(await unreachable.text()).toContain('cannot reach the project this adapter works in');

  const nonsense = await approve(leadCookie, clientId, 'refused', { ...fields, companion: 'codex b' });
  expect(nonsense.status).toBe(400);
});

it('pairs the adapter at consent, marks it as an adapter, and tells the CLI', async () => {
  const paired = await activate(leadCookie, 'STMA local adapter (codex)', {
    name: 'lead-codex-local',
    device: 'win',
    access: `project:${webProjectId}`,
    companion: codexBInstallation,
  });
  adapter = { token: paired.token, installationId: paired.installationId };
  expect(paired.identity.companion).toEqual({
    installationId: codexBInstallation,
    agent: 'Codex B',
    device: 'win',
  });
  const row = await installation(adapter.installationId);
  expect(row.companionOf).toBe(codexBInstallation);
  expect(row.capabilities).toContain('local-adapter');

  // Hooks without pairing is a choice the screen offers, and it stays a choice.
  const stray = await activate(leadCookie, 'STMA local adapter (claude-code)', {
    name: 'lead-claude-local',
    device: 'win',
    access: `project:${webProjectId}`,
    companion: 'none',
  });
  strayAdapter = { token: stray.token, installationId: stray.installationId };
  expect(stray.identity.companion).toBeNull();
  expect((await installation(strayAdapter.installationId)).capabilities).toContain('local-adapter');

  // A forged field on an agent's own consent must not turn it into somebody's ears.
  const forged = await activate(leadCookie, 'Codex', {
    name: 'codex-web',
    device: 'win',
    access: `project:${webProjectId}`,
    companion: codexBInstallation,
  });
  const forgedRow = await installation(forged.installationId);
  expect(forgedRow.companionOf).toBeNull();
  expect(forgedRow.capabilities).not.toContain('local-adapter');
});

let webSession = '';

it('tells the paired hook about work assigned to the agent beside it, and only that hook', async () => {
  const assigned = await call(
    'assign_work',
    {
      to_agent: 'codex b',
      to: 'lead',
      task: 'PD-12 Headings',
      brief: 'Set the dashboard headings in the design system typeface.\nTouch public/ only.',
      next_steps: ['Run the UI tests'],
      team: 'parcel-desk',
      project: 'parcel-desk-web',
    },
    codexA,
  );
  expect(assigned.isError, assigned.text).toBe(false);
  webSession = assigned.data.sessionId;
  // Filed under the repository-bound project the adapter was connected to, not a
  // new name-only sibling beside it that no hook listens in (2026-09-19).
  const [filed] = await srv.db.select().from(debugSessions).where(eq(debugSessions.id, webSession));
  expect(filed!.projectId).toBe(webProjectId);
  expect(await srv.db.select().from(projects).where(eq(projects.name, 'parcel-desk-web'))).toHaveLength(1);
  expect(assigned.data.projectNote).toBeUndefined();
  // And the start_run it pre-fills lands in the same project from any checkout.
  expect(JSON.parse(assigned.data.startWith)).toMatchObject({
    project: 'parcel-desk-web',
    repository_identity: WEB_REPO,
  });
  // The lead is told the truth about the other machine: nobody has to touch it.
  expect(assigned.data.hookWillAnnounce).toBe(true);
  expect(assigned.data.hint).toContain('local adapter is paired');
  expect(assigned.data.hint).not.toContain('read your STMA inbox');

  const heard = await news(adapter.token);
  expect(heard.pendingHandoffs.map((h) => h.title)).toEqual(['Assignment: PD-12 Headings']);
  expect(heard.pendingHandoffs[0]!.assignedTo).toEqual({ agent: 'Codex B', device: 'win', thisAgent: true });
  expect((heard as News & { listeningFor?: unknown }).listeningFor).toEqual({ agent: 'Codex B', device: 'win' });
  const hook = renderNews(heard.pendingHandoffs, heard.unreadSessions)!;
  expect(hook).toContain('work assigned to this agent by name');
  expect(hook).toContain('PD-12 Headings');
  expect(hook).toContain('unless they object');

  // An adapter nobody paired sits in the same project and is told nothing.
  expect((await news(strayAdapter.token)).pendingHandoffs).toHaveLength(0);

  // A lead with no adapter on the other side is still told to say the sentence.
  const unpaired = await call(
    'assign_work',
    {
      to_agent: 'codex-a',
      task: 'PD-13 Footer',
      brief: 'Tidy the footer links in public/.',
      team: 'parcel-desk',
      project: 'parcel-desk-web',
    },
    codexB,
  );
  expect(unpaired.data.hookWillAnnounce).toBe(false);
  expect(unpaired.data.hint).toContain('read your STMA inbox');
});

it('does not read the agent its own brief back through the hook beside it', async () => {
  // Codex B leaves a runbook for the team. Its adapter speaks into Codex B's
  // context, so announcing this there would be the product talking to itself.
  const left = await call(
    'handoff_work',
    {
      summary: 'Decided the typeface order for the dashboard. No code yet — this is the plan.',
      next_steps: ['Apply it to public/styles.css'],
      reason: 'end_of_day',
      team: 'parcel-desk',
      project: 'parcel-desk-web',
    },
    codexB,
  );
  expect(left.isError, left.text).toBe(false);
  // No run, only a display name: still the existing project, not a new sibling.
  const [filed] = await srv.db.select().from(debugSessions).where(eq(debugSessions.id, left.data.sessionId));
  expect(filed!.projectId).toBe(webProjectId);
  const titles = async (tok: string) => (await news(tok)).pendingHandoffs.map((h) => h.sessionId);
  expect(await titles(adapter.token)).not.toContain(left.data.sessionId);
  // The unpaired adapter has no such seat, and still hears it as somebody's offer.
  expect(await titles(strayAdapter.token)).toContain(left.data.sessionId);
});

it('counts unread as the agent that reads, because an adapter never opens a thread', async () => {
  // The brief waiting for Codex B is work, not a reply: nothing is unread yet.
  expect((await news(adapter.token)).unreadSessions).toBe(0);
  // A teammate's question to the project is news to every agent in it.
  const asked = await call(
    'open_session',
    // Named by its repository: a session is evidence-grade, so a bare display name
    // would file it under a name-only sibling instead of the project the adapters sit in.
    { title: 'Footer build fails on Windows', body: 'npm run build stops at the footer partial.', team: 'parcel-desk', repo: WEB_REPO },
    codexA,
  );
  expect(asked.isError, asked.text).toBe(false);
  const before = await news(adapter.token);
  expect(before.unreadSessions).toBe(1);
  expect((await news(strayAdapter.token)).unreadSessions).toBe(1);
  // Codex B reads it; asked as itself, the adapter's cursor would never move and
  // the thread would stay unread forever.
  await call('get_session', { session_id: asked.data.sessionId }, codexB);
  expect((await news(adapter.token)).unreadSessions).toBe(0);
  expect((await news(strayAdapter.token)).unreadSessions).toBe(1);
});

it('keeps work dispatched to one agent out of every other agent\'s unread count', async () => {
  // Measured in the two-device round, 2026-09-19: four freshly connected agents
  // each opened with "7 debug sessions have unread replies" — old assignments to
  // other agents — and the count grew with every task the lead handed out.
  const writerBefore = (await news(codexA)).unreadSessions;
  const strayBefore = (await news(strayAdapter.token)).unreadSessions;
  const said = await call('post_message', { session_id: webSession, body: 'Footer links: docs, status, contact.' }, codexA);
  expect(said.isError, said.text).toBe(false);
  // The agent the work names hears the reply, through the adapter beside it too.
  expect((await news(adapter.token)).unreadSessions).toBe(1);
  expect((await news(codexB)).unreadSessions).toBe(1);
  // An adapter that sits beside nobody does not, and neither does whoever wrote it.
  expect((await news(strayAdapter.token)).unreadSessions).toBe(strayBefore);
  expect((await news(codexA)).unreadSessions).toBe(writerBefore);
  const inbox = await call('inbox', { team: 'parcel-desk' }, codexB);
  expect(inbox.data.unreadSessions.map((s: any) => s.sessionId)).toContain(webSession);
  await call('get_session', { session_id: webSession }, codexB);
  expect((await news(adapter.token)).unreadSessions).toBe(0);
});

it('hears, and nothing more: the adapter cannot accept what it announces', async () => {
  const taken = await call('update_handoff', { session_id: webSession, action: 'accept' }, adapter.token);
  expect(taken.isError).toBe(true);
  expect(taken.text).toContain('assigned by name to Codex B on win');

  const accepted = await call('update_handoff', { session_id: webSession, action: 'accept' }, codexB);
  expect(accepted.isError, accepted.text).toBe(false);
});

it('never offers an adapter as somebody to assign work to, and says which agent has one', async () => {
  const { data } = await call('list_teammates', { team: 'parcel-desk' }, codexA);
  const lead = data.members.find((m: any) => m.username === 'lead');
  const names = lead.agents.map((a: any) => a.agent);
  expect(names).not.toContain('lead-codex-local');
  // Paired or not, an adapter cannot call update_handoff — so neither is listed.
  expect(names).not.toContain('lead-claude-local');
  expect(lead.agents.find((a: any) => a.agent === 'Codex B').adapterPaired).toBe(true);
  expect(lead.agents.find((a: any) => a.agent === 'codex-a').adapterPaired).toBeUndefined();

  const byName = await call(
    'assign_work',
    { to_agent: 'lead-codex-local', task: 'PD-14 Anything', brief: 'This can never be accepted.', team: 'parcel-desk' },
    codexA,
  );
  expect(byName.isError).toBe(true);
  expect(byName.text).toContain('No agent called "lead-codex-local"');

  const page = await (
    await fetch(`${srv.url}/app/teams/parcel-desk/projects/parcel-desk-web`, { headers: leadCookie })
  ).text();
  expect(page).toContain(`value="${codexBInstallation}"`);
  expect(page).toContain('adapter paired');
  expect(page).not.toContain(`value="${adapter.installationId}"`);
  expect(page).not.toContain(`value="${strayAdapter.installationId}"`);
  // The form holds the same line as the select.
  const forced = await form(
    `${srv.url}/app/teams/parcel-desk/projects/parcel-desk-web/assign`,
    { agent: adapter.installationId, task: 'PD-14 Anything', brief: 'This can never be accepted.', steps: '', branch: '' },
    leadCookie,
  );
  expect(decodeURIComponent(forced.headers.get('location') ?? '')).toContain('Choose an agent that is connected');
});

let adapterRun = '';

it('files a stopped edit under the agent the lead knows, and keeps who reported it in view', async () => {
  const published = await form(
    `${srv.url}/app/teams/parcel-desk/policy`,
    { scope: 'team', guidance: 'Typography follows the design system.', deny: FONT_RULE },
    leadCookie,
  );
  expect(decodeURIComponent(published.headers.get('location') ?? '')).toContain('Published');

  const api = (endpoint: string, body: unknown) =>
    fetch(`${srv.url}${endpoint}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adapter.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  // The hook starts the run, so the run belongs to the adapter's installation.
  const started: any = await (
    await api('/api/agent/runs/start', {
      requestId: randomUUID(),
      installationId: adapter.installationId,
      team: 'parcel-desk',
      project: 'parcel-desk-web',
      repositoryIdentity: WEB_REPO,
      worktree: '/work/win/parcel-desk-web',
      taskKey: 'PD-12 Headings',
    })
  ).json();
  adapterRun = started.run.id;
  const reported = await api(`/api/agent/runs/${adapterRun}/policy-violations`, {
    rule: FONT_RULE,
    path: 'public/styles.css',
    outcome: 'blocked',
  });
  expect(await reported.json()).toMatchObject({ recorded: true });

  const governance = await (
    await fetch(`${srv.url}/app/teams/parcel-desk/governance`, { headers: leadCookie })
  ).text();
  const card = governance.slice(
    governance.indexOf('id="policy-violations"'),
    governance.indexOf('id="run-timeline"'),
  );
  expect(card).toContain('<b>Codex B</b>');
  expect(card).toContain('via its adapter lead-codex-local');
  expect(card).not.toContain('<b>lead-codex-local</b>');
  // The run timeline names the same agent the same way.
  expect(governance.slice(governance.indexOf('id="run-timeline"'))).toContain(
    'via its adapter lead-codex-local',
  );

  const activity = await (
    await fetch(`${srv.url}/app/teams/parcel-desk/activity`, { headers: leadCookie })
  ).text();
  expect(activity).toContain('Codex B (via its adapter lead-codex-local)');

  // The decision of 2026-09-21: the agent an adapter listens for may act on
  // that adapter's run. The hook tells it to reuse this run_id, and until now
  // the product refused the instruction the product had just given.
  const reused = await call('update_run', { run_id: adapterRun, status: 'active' }, codexB);
  expect(reused.isError, reused.text).toBe(false);
  const finishing = await call('update_run', { run_id: adapterRun, scope: [{ type: 'path', key: 'public/styles.css', access: 'write' }] }, codexB);
  expect(finishing.isError, finishing.text).toBe(false);

  // And nobody else. Another agent of the same owner, in the same workspace,
  // that this adapter does not listen for is refused — and told the way out.
  const sibling = await call('update_run', { run_id: adapterRun, status: 'active' }, codexA);
  expect(sibling.isError).toBe(true);
  expect(sibling.text).toContain(`cannot access run "${adapterRun}"`);
  expect(sibling.text).toContain('ask your human to pair that adapter with this agent');
  // Nor another person's agent in the same workspace: a pairing is one owner's.
  const stranger = await call('finish_run', { run_id: adapterRun }, bobsCodexB);
  expect(stranger.isError).toBe(true);
  expect(stranger.text).toContain(`cannot access run "${adapterRun}"`);

  // The tool that decides which run a call means reads the same pairing, or the
  // guard would allow a run_id that handoff_work then calls "not one of yours".
  const named = await call('handoff_work', { run_id: adapterRun, branch: 'lab/b2', summary: 'Not this time.', reason: 'other', team: 'parcel-desk', project: 'parcel-desk-web' }, codexB);
  expect(named.isError).toBe(true);
  expect(named.text).not.toContain('not one of your active runs');
  // Refused for the reason it should be — no delivery checkpoint, and the run
  // keeps its claims — not for whose run it is.
  expect(named.text).toContain('A branch handoff requires an immutable delivery/tested checkpoint');

  // An omitted run_id still stands only for a run this agent started itself:
  // one Codex identity can be paired with an adapter in every checkout, so
  // "your newest live run" would quietly mean another checkout's. It is told
  // which run the hooks own rather than told to start one.
  const guessed = await call('update_run', { status: 'active' }, codexB);
  expect(guessed.isError).toBe(true);
  expect(guessed.text).toContain(`hooks own a live run here — ${adapterRun}`);
  expect(guessed.text).not.toContain('Call start_run first');

  // One-way, which is the half worth proving: the adapter listens for Codex B
  // and still cannot touch Codex B's own run. `companion_of` lives on the
  // adapter and points at the agent, so there is no query that reads it back.
  const own = await call('start_run', { request_id: randomUUID(), team: 'parcel-desk', project: 'parcel-desk-web', repository_identity: WEB_REPO, task: 'PD-13 Agent-owned' }, codexB);
  expect(own.isError, own.text).toBe(false);
  const reached = await api(`/api/agent/runs/${own.data.runId}/heartbeat`, { status: 'active' });
  expect(reached.status).toBe(403);
  expect((await reached.json()).error).toContain(`cannot access run "${own.data.runId}"`);
  expect((await call('finish_run', { run_id: own.data.runId }, codexB)).isError).toBe(false);
});

it('pairs an already-installed adapter from Agent connections, under the same rules', async () => {
  const pairUrl = (id: string) => `${srv.url}/app/installations/${id}/companion`;
  const location = (res: Response) =>
    decodeURIComponent(res.headers.get('location') ?? '').replaceAll('+', ' ');

  const page = await (await fetch(`${srv.url}/app/tokens`, { headers: leadCookie })).text();
  expect(page).toContain('Local adapter · listens for');
  expect(page).toContain(`action="/app/installations/${adapter.installationId}/companion"`);
  expect(page).toContain(`<option value="${codexBInstallation}" selected`);
  expect(page).toContain('Adapter paired: lead-codex-local');
  // The unpaired one says what that costs, and offers only agents it can reach.
  expect(page).toContain('Not paired: its hook is not told about work assigned to the agent beside it');
  expect(page).not.toContain(`<option value="${claudeApiInstallation}"`);
  // An agent's row carries no pairing control of its own.
  expect(page).not.toContain(`action="/app/installations/${codexBInstallation}/companion"`);

  const unpaired = await form(pairUrl(adapter.installationId), { companion: 'none' }, leadCookie);
  expect(location(unpaired)).toContain('is no longer paired');
  expect((await installation(adapter.installationId)).companionOf).toBeNull();
  // The run edge is read per call against the current row, so unpairing takes
  // it back at once — even from a run this agent was updating a moment ago.
  const lost = await call('update_run', { run_id: adapterRun, status: 'active' }, codexB);
  expect(lost.isError).toBe(true);
  expect(lost.text).toContain(`cannot access run "${adapterRun}"`);
  // And the run keeps every record it had: who reported it does not move.
  expect((await srv.db.select().from(agentRuns).where(eq(agentRuns.id, adapterRun)))[0]!.installationId)
    .toBe(adapter.installationId);
  // Still an adapter: unpairing does not put it back in the picker.
  const { data } = await call('list_teammates', { team: 'parcel-desk' }, codexA);
  expect(
    data.members.find((m: any) => m.username === 'lead').agents.map((a: any) => a.agent),
  ).not.toContain('lead-codex-local');

  // The adapter activated without a pairing is paired now, with no re-activation.
  const repaired = await form(pairUrl(strayAdapter.installationId), { companion: codexBInstallation }, leadCookie);
  expect(location(repaired)).toContain('lead-claude-local now listens for Codex B');
  expect((await installation(strayAdapter.installationId)).companionOf).toBe(codexBInstallation);
  await call(
    'assign_work',
    {
      to_agent: 'codex b',
      to: 'lead',
      task: 'PD-15 Buttons',
      brief: 'Align the primary buttons in public/.',
      team: 'parcel-desk',
      project: 'parcel-desk-web',
    },
    codexA,
  );
  const assignments = async (tok: string) =>
    (await news(tok)).pendingHandoffs.filter((h) => h.kind === 'assignment').map((h) => h.title);
  expect(await assignments(strayAdapter.token)).toContain('Assignment: PD-15 Buttons');
  expect(await assignments(adapter.token)).toHaveLength(0);
  // Codex B is paired again, with a different adapter — so it hears assignments
  // here and still cannot touch the first adapter's run. The edge is that one
  // pairing, never "an adapter of mine started it".
  const elsewhere = await call('update_run', { run_id: adapterRun, status: 'active' }, codexB);
  expect(elsewhere.isError).toBe(true);
  expect(elsewhere.text).toContain(`cannot access run "${adapterRun}"`);

  // Same owner only, reachable only, adapters only — and never somebody else's adapter.
  const refused = async (id: string, companion: string, cookie = leadCookie) =>
    location(await form(pairUrl(id), { companion }, cookie));
  expect(await refused(adapter.installationId, bobsCodexBInstallation)).toContain(
    'Choose one of your own connected agents',
  );
  expect(await refused(adapter.installationId, claudeApiInstallation)).toContain('cannot reach the project');
  expect(await refused(adapter.installationId, strayAdapter.installationId)).toContain(
    'Choose one of your own connected agents',
  );
  expect(await refused(codexAInstallation, codexBInstallation)).toContain('Only a local adapter can be paired');
  expect(await refused(adapter.installationId, bobsCodexBInstallation, bobCookie)).toContain(
    'not one of your live agent connections',
  );
  expect((await installation(adapter.installationId)).companionOf).toBeNull();
  expect((await installation(codexAInstallation)).companionOf).toBeNull();
});

it('marks adapters activated before pairing existed, from the OAuth client they were issued to', async () => {
  // What such a row looks like: an installation like any other, no marker.
  await srv.db
    .update(agentInstallations)
    .set({ capabilities: ['mcp', 'scoped-enrollment', 'oauth'] })
    .where(eq(agentInstallations.id, adapter.installationId));
  const page = await (await fetch(`${srv.url}/app/tokens`, { headers: leadCookie })).text();
  expect(page).not.toContain(`action="/app/installations/${adapter.installationId}/companion"`);

  // The migration's own statement, not a copy of it.
  const migration = readFileSync(path.join(__dirname, '..', 'drizzle', '0041_companions.sql'), 'utf8');
  const backfill = migration.split('--> statement-breakpoint').at(-1)!;
  expect(backfill).toContain('UPDATE "agent_installations"');
  await srv.db.execute(sql.raw(backfill));

  expect((await installation(adapter.installationId)).capabilities).toContain('local-adapter');
  // An agent that also signed in over OAuth is not an adapter, and stays an agent.
  const [codexWeb] = await srv.db
    .select()
    .from(agentInstallations)
    .where(eq(agentInstallations.name, 'codex-web'));
  expect(codexWeb!.capabilities).not.toContain('local-adapter');
  expect((await installation(codexBInstallation)).capabilities).not.toContain('local-adapter');
  // Running it again adds nothing: a retried migration must not double the marker.
  await srv.db.execute(sql.raw(backfill));
  expect(
    ((await installation(adapter.installationId)).capabilities as string[]).filter(
      (capability) => capability === 'local-adapter',
    ),
  ).toHaveLength(1);
});

// ------------------------------------------------ the project an assignment names

/**
 * A lead names a project the way the console shows it. Until 2026-09-19 a bare
 * name only ever matched a project with no recorded repository, so
 * "parcel-desk-web" filed the assignment under a new `parcel-desk-web-legacy`
 * beside the repository-bound project — where neither the agent's start_run nor
 * the hook in its checkout ever looked. Stage still holds siblings like that, so
 * one is planted here exactly as the bug left it.
 */

let legacyWebId = '';

it('files work named by display name, repository or id under the one project, beside a legacy sibling', async () => {
  const [legacy] = await srv.db
    .insert(projects)
    .values({ teamId, name: 'parcel-desk-web', slug: 'parcel-desk-web-legacy' })
    .returning();
  legacyWebId = legacy!.id;
  const count = async () => (await srv.db.select().from(projects).where(eq(projects.teamId, teamId))).length;
  const before = await count();

  for (const spelling of ['parcel-desk-web', 'git@github.com:Example/parcel-desk-web.git', webProjectId]) {
    const assigned = await call(
      'assign_work',
      {
        to_agent: 'codex b',
        to: 'lead',
        task: 'PD-16 Spacing',
        brief: 'Even out the card spacing in public/.',
        team: 'parcel-desk',
        project: spelling,
      },
      codexA,
    );
    expect(assigned.isError, assigned.text).toBe(false);
    const [filed] = await srv.db
      .select()
      .from(debugSessions)
      .where(eq(debugSessions.id, assigned.data.sessionId));
    expect(filed!.projectId, spelling).toBe(webProjectId);
    expect(assigned.data.projectNote).toBeUndefined();
    // Codex B's adapter — paired from Agent connections above — works in that project.
    expect(assigned.data.hookWillAnnounce, spelling).toBe(true);
  }
  expect(await count()).toBe(before);
  expect((await news(strayAdapter.token)).pendingHandoffs.map((h) => h.title)).toContain(
    'Assignment: PD-16 Spacing',
  );
});

it('says when a name creates a project, and when the paired hook will not hear it', async () => {
  const typo = await call(
    'assign_work',
    {
      to_agent: 'codex b',
      to: 'lead',
      task: 'PD-17 Offline list',
      brief: 'Cache the parcel list for offline use.',
      team: 'parcel-desk',
      project: 'parcel-desk-mobile',
    },
    codexA,
  );
  expect(typo.isError, typo.text).toBe(false);
  expect(typo.data.projectNote).toContain('created "parcel-desk-mobile"');
  // Named once, though the bound project and its planted sibling share the name.
  expect(typo.data.projectNote.match(/"parcel-desk-web"/g)).toHaveLength(1);
  // A pairing is not a promise about every project: the adapter hears its own.
  expect(typo.data.hookWillAnnounce).toBe(false);
  expect(typo.data.hint).toContain('hears only assignments in its own project');
  expect(typo.data.hint).toContain('in "parcel-desk-mobile"');
  expect(typo.data.hint).toContain('read your STMA inbox');

  const nowhere = await call(
    'assign_work',
    {
      to_agent: 'codex b',
      to: 'lead',
      task: 'PD-18 No project',
      brief: 'A task that names no project at all.',
      team: 'parcel-desk',
    },
    codexA,
  );
  expect(nowhere.isError, nowhere.text).toBe(false);
  expect(nowhere.data.project).toBeNull();
  expect(nowhere.data.hookWillAnnounce).toBe(false);
  expect(nowhere.data.hint).toContain('in no project');

  // Exactly what those answers said: the hook is silent, the agent's inbox is not.
  const heard = (await news(strayAdapter.token)).pendingHandoffs.map((h) => h.title);
  expect(heard).not.toContain('Assignment: PD-17 Offline list');
  expect(heard).not.toContain('Assignment: PD-18 No project');
  const waiting = (await news(codexB)).pendingHandoffs.map((h) => h.title);
  expect(waiting).toContain('Assignment: PD-17 Offline list');
  expect(waiting).toContain('Assignment: PD-18 No project');
});

it('opens a project page by its slug, and files its assignment under the project on screen', async () => {
  const page = async (slug: string) => {
    const res = await fetch(`${srv.url}/app/teams/parcel-desk/projects/${slug}`, { headers: leadCookie });
    return { status: res.status, html: await res.text() };
  };
  const option = (html: string, id: string) =>
    new RegExp(`<option value="${id}"[^>]*>([^<]*)</option>`).exec(html)?.[1] ?? '';

  // The list links by slug. Looked up by name, both of these used to be a 404.
  const legacy = await page('parcel-desk-web-legacy');
  expect(legacy.status).toBe(200);
  expect(legacy.html).toContain('action="/app/teams/parcel-desk/projects/parcel-desk-web-legacy/assign"');
  const bound = await page('parcel-desk-web');
  expect(bound.html).toContain('action="/app/teams/parcel-desk/projects/parcel-desk-web/assign"');
  // "Adapter paired" on a page means a hook that hears work filed on that page.
  expect(option(bound.html, codexBInstallation)).toContain('adapter paired');
  expect(option(legacy.html, codexBInstallation)).not.toContain('adapter paired');

  for (const [slug, id] of [
    ['parcel-desk-web', webProjectId],
    ['parcel-desk-web-legacy', legacyWebId],
  ] as const) {
    const created = await form(
      `${srv.url}/app/teams/parcel-desk/projects/${slug}/assign`,
      {
        agent: codexBInstallation,
        task: `PD-19 From ${slug}`,
        brief: 'Filed from the page the lead is looking at.',
        steps: '',
        branch: '',
      },
      leadCookie,
    );
    const sessionId = /[?&]assigned=([0-9a-f-]{36})/.exec(created.headers.get('location') ?? '')?.[1];
    expect(sessionId, slug).toBeTruthy();
    const [filed] = await srv.db.select().from(debugSessions).where(eq(debugSessions.id, sessionId!));
    expect(filed!.projectId, slug).toBe(id);
  }

  // A project whose name is not its slug has a page too.
  await form(`${srv.url}/app/projects`, { team: 'parcel-desk', project: 'Parcel Ops' }, leadCookie);
  const ops = await page('parcel-ops');
  expect(ops.status).toBe(200);
  expect(ops.html).toContain('Parcel Ops');
});

it('hands work to a named agent, not a person: only that agent hears it, only it can take it', async () => {
  // Measured 2026-09-19: an agent told to hand its branch to lead-b2-l101 found
  // that handoff_work took a username, and left the work open to the team.
  const handed = await call('handoff_work', {
    request_id: randomUUID(),
    summary: 'Runbook for the next agent: show the ETA priority as a badge in the parcel table.',
    next_steps: ['Read the project context from STMA first', 'Add the badge to the parcel row', 'Run the tests'],
    to_agent: 'codex b',
    to: 'lead',
    team: 'parcel-desk',
  }, codexA);
  expect(handed.isError, handed.text).toBe(false);
  expect(handed.data.assignedTo).toEqual({ agent: 'Codex B', device: 'win' });
  expect(handed.data.hint).toContain('Only Codex B on win can accept this');
  const handoffSession = handed.data.sessionId as string;

  const forB = await news(codexB);
  const mine = forB.pendingHandoffs.find((h) => h.sessionId === handoffSession)!;
  expect(mine.kind).toBe('handoff');
  expect(mine.assignedTo).toEqual({ agent: 'Codex B', device: 'win', thisAgent: true });
  expect((await news(codexA)).pendingHandoffs.some((h) => h.sessionId === handoffSession)).toBe(false);
  expect((await news(bobsCodexB)).pendingHandoffs.some((h) => h.sessionId === handoffSession)).toBe(false);
  const hook = renderNews([mine], 0)!;
  expect(hook).toContain('work handed over to this agent by name');
  expect(hook).toContain('verify the repository identity and the exact commit');
  expect(hook).toContain('unless they object');
  expect(hook).not.toContain('ask before acting');

  const wrong = await call('update_handoff', { session_id: handoffSession, action: 'accept' }, bobsCodexB);
  expect(wrong.isError).toBe(true);
  const accepted = await call('update_handoff', { session_id: handoffSession, action: 'accept' }, codexB);
  expect(accepted.isError, accepted.text).toBe(false);
  // No branch, so nothing to verify: resume records that and the work proceeds.
  const resumed = await call('update_handoff', { session_id: handoffSession, action: 'resume' }, codexB);
  expect(resumed.isError, resumed.text).toBe(false);
  const done = await call('update_handoff', { session_id: handoffSession, action: 'complete' }, codexB);
  expect(done.isError, done.text).toBe(false);

  // An unknown agent is refused with the names that exist, like assign_work.
  const nobody = await call('handoff_work', { request_id: randomUUID(), summary: 'Anything at all, really.', to_agent: 'Codex Z', team: 'parcel-desk' }, codexA);
  expect(nobody.isError).toBe(true);
  expect(nobody.text).toContain('Codex B');
});

it('frees the ground when the agent that held it reports the work complete', async () => {
  // Measured in the agent lab, 2026-09-19: lab-b1 finished a footer in
  // public/index.html and its session stayed open, so its claim lived on for the
  // waiting lease. lab-b2, handed work touching the same file, was stopped by a
  // collision with nothing behind it and had to ask a human on that machine.
  const ground = [{ type: 'path', key: 'public/footer.html', access: 'write' }];
  const assigned = await call('assign_work', { request_id: randomUUID(), to_agent: 'codex b', to: 'lead', task: 'PD-40 Footer line', brief, team: 'parcel-desk', project: 'parcel-desk-api' }, codexA);
  expect(assigned.isError, assigned.text).toBe(false);
  const session = assigned.data.sessionId as string;
  const holder = await call('start_run', { request_id: randomUUID(), team: 'parcel-desk', project: 'parcel-desk-api', task: 'PD-40', scope: ground }, codexB);
  expect(holder.isError, holder.text).toBe(false);
  for (const action of ['accept', 'resume']) {
    expect((await call('update_handoff', { session_id: session, action }, codexB)).isError).toBe(false);
  }

  // While the work is live, a second agent on the same file is told who holds it.
  const early = await call('start_run', { request_id: randomUUID(), team: 'parcel-desk', project: 'parcel-desk-api', task: 'PD-41', scope: ground }, codexA);
  expect(early.data.conflicts).toHaveLength(1);
  expect((await call('finish_run', { run_id: early.data.runId }, codexA)).isError).toBe(false);

  // Somebody else's agent, at work elsewhere in the project since before the footer was done.
  const witness = await call('start_run', { request_id: randomUUID(), team: 'parcel-desk', project: 'parcel-desk-api', task: 'PD-43', scope: [{ type: 'path', key: 'public/header.html', access: 'write' }] }, bobsCodexB);
  expect(witness.isError, witness.text).toBe(false);

  const done = await call('update_handoff', { session_id: session, action: 'complete' }, codexB);
  expect(done.isError, done.text).toBe(false);
  expect(done.data.groundReleased).toEqual({ runId: holder.data.runId, claims: 1 });

  // Let go, not forgotten. Deleted, as completion first did it, the agent map could
  // not draw what the agent had touched and nobody was told the ground had moved.
  const kept = await srv.db.select().from(workClaims).where(eq(workClaims.runId, holder.data.runId));
  expect(kept.map((row) => [row.resourceKey, row.source])).toEqual([['public/footer.html', 'released']]);
  expect(kept[0]!.leaseExpiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  // A heartbeat keeps a live run's claims alive; it must not bring this one back.
  expect((await call('update_run', { run_id: holder.data.runId, status: 'active' }, codexB)).isError).toBe(false);

  // The run that did the work is still live, so no finished run says the ground
  // moved: the completion does. The witness began before it and declares the file now.
  const moved = await call('update_run', { run_id: witness.data.runId, scope: ground }, bobsCodexB);
  expect(moved.isError, moved.text).toBe(false);
  expect(moved.data.conflicts).toEqual([]);
  expect(moved.data.staleContext.moved).toEqual([
    expect.objectContaining({ resource: 'path:public/footer.html', agent: 'Codex B', by: 'lead' }),
  ]);
  expect((await call('finish_run', { run_id: witness.data.runId }, bobsCodexB)).isError).toBe(false);

  // The same file is free the moment the work is reported complete; the run that
  // did it is still live, and holds ground again as soon as it declares some.
  const late = await call('start_run', { request_id: randomUUID(), team: 'parcel-desk', project: 'parcel-desk-api', task: 'PD-42', scope: ground }, codexA);
  expect(late.data.conflicts).toEqual([]);
  expect((await call('finish_run', { run_id: late.data.runId }, codexA)).isError).toBe(false);
  const again = await call('update_run', { run_id: holder.data.runId, scope: [{ type: 'path', key: 'public/next.html', access: 'write' }] }, codexB);
  expect(again.isError, again.text).toBe(false);

  // Reporting it twice frees nothing twice and breaks nothing.
  const replay = await call('update_handoff', { session_id: session, action: 'complete' }, codexB);
  expect(replay.isError, replay.text).toBe(false);
  expect(replay.data.groundReleased).toBeUndefined();
  expect((await call('finish_run', { run_id: holder.data.runId }, codexB)).isError).toBe(false);
});

it('gives a run nobody named the name of the work its agent takes', async () => {
  // Measured in the two-device round, 2026-09-19: the hook opens the run and knows
  // no task, so the lead's agent map showed four rows reading "untitled run".
  const nameOf = async (runId: string) =>
    (await srv.db.select({ intent: agentRuns.intent, taskKey: agentRuns.taskKey }).from(agentRuns).where(eq(agentRuns.id, runId)))[0]!;
  const assign = async (task: string) =>
    (await call('assign_work', { request_id: randomUUID(), to_agent: 'codex b', to: 'lead', task, brief, team: 'parcel-desk', project: 'parcel-desk-api' }, codexA)).data.sessionId as string;

  const hookRun = await call('start_run', { request_id: randomUUID(), team: 'parcel-desk', project: 'parcel-desk-api' }, codexB);
  expect(hookRun.isError, hookRun.text).toBe(false);
  expect(await nameOf(hookRun.data.runId)).toEqual({ intent: null, taskKey: null });

  const first = await assign('PD-50 Page title');
  expect((await call('update_handoff', { session_id: first, action: 'accept' }, codexB)).isError).toBe(false);
  expect((await nameOf(hookRun.data.runId)).intent).toBe('PD-50 Page title');
  const map = await (await fetch(`${srv.url}/app/agents`, { headers: leadCookie })).text();
  expect(map).toContain('PD-50 Page title');
  for (const action of ['resume', 'complete']) {
    expect((await call('update_handoff', { session_id: first, action }, codexB)).isError).toBe(false);
  }

  // The session goes on and so does its run: the next work renames it.
  const second = await assign('PD-51 Footer line');
  expect((await call('update_handoff', { session_id: second, action: 'accept' }, codexB)).isError).toBe(false);
  expect((await nameOf(hookRun.data.runId)).intent).toBe('PD-51 Footer line');

  expect((await call('finish_run', { run_id: hookRun.data.runId }, codexB)).isError).toBe(false);

  // A name the agent declared is the agent's: taking work does not overwrite it.
  const declared = await call('start_run', { request_id: randomUUID(), team: 'parcel-desk', project: 'parcel-desk-api', intent: 'Footer, then the header' }, codexB);
  expect(declared.isError, declared.text).toBe(false);
  const third = await assign('PD-52 Header');
  expect((await call('update_handoff', { session_id: third, action: 'accept' }, codexB)).isError).toBe(false);
  expect((await nameOf(declared.data.runId)).intent).toBe('Footer, then the header');
  expect((await call('finish_run', { run_id: declared.data.runId }, codexB)).isError).toBe(false);
});

it('keeps what just happened on the agent map, faded: ground let go and agents that stopped', async () => {
  // Asked for in the two-device round, 2026-09-19: the map showed four agents and
  // an empty right-hand side, because completed work had let its ground go and
  // presence remembers nothing. An agent whose session closed left the page.
  const map = async (query = '') => (await fetch(`${srv.url}/app/agents${query}`, { headers: leadCookie })).text();
  const session = (await call('assign_work', { request_id: randomUUID(), to_agent: 'codex b', to: 'lead', task: 'PD-60 Map page', brief, team: 'parcel-desk', project: 'parcel-desk-api' }, codexA)).data.sessionId as string;
  const run = await call('start_run', { request_id: randomUUID(), team: 'parcel-desk', project: 'parcel-desk-api' }, codexB);
  expect(run.isError, run.text).toBe(false);
  const runId = run.data.runId as string;
  for (const action of ['accept', 'resume']) {
    expect((await call('update_handoff', { session_id: session, action }, codexB)).isError).toBe(false);
  }
  expect((await call('update_run', { run_id: runId, scope: [{ type: 'path', key: 'public/map.html', access: 'write' }] }, codexB)).isError).toBe(false);

  const working = await map(`?run=${runId}`);
  expect(working).toContain('PD-60 Map page');
  // Held now, so drawn as held: nothing about this file is "earlier" yet.
  const earlier = 'PATH · EARLIER</text><text class="sg-label" x="0" y="10">public/map.html';
  expect(working).not.toContain(earlier);
  expect(working).not.toContain('Held earlier');

  expect((await call('update_handoff', { session_id: session, action: 'complete' }, codexB)).isError).toBe(false);
  const done = await map(`?run=${runId}`);
  // Still live, holding nothing — and the picture says where it was.
  expect(done).toContain('sg-link past');
  expect(done).toContain(earlier);
  expect(done).toContain('Held earlier');
  // Remembered ground is never contested and never counts as a holder.
  expect(done).not.toContain('sg-box hot');

  expect((await call('finish_run', { run_id: runId }, codexB)).isError).toBe(false);
  const stopped = await map();
  expect(stopped).toContain('Not working right now');
  expect(stopped).toContain('lrow grid-runs ended');
  expect(stopped).toContain('held path:public/map.html');
  expect(stopped).toMatch(/class="sg-node( off)? ended"/);
  // It can still be opened, and says what it is.
  const opened = await map(`?run=${runId}`);
  expect(opened).toContain('This run ended');
  expect(opened).toContain('Held earlier');
  // The critical filter is about now: nothing remembered is drawn under it.
  expect(await map('?only=critical')).not.toMatch(/sg-node( off)? ended/);
});

it('cancels from the project page, says so there, and stops calling finished work an open session', async () => {
  // Measured in the two-device round, 2026-09-19: PD-22 went to the wrong agent.
  // Cancel worked, but the thread stayed "open" on the project page and nothing
  // said the assignment was gone, so the lead reported that cancelling had failed.
  const projectPage = async (query = '') =>
    (await fetch(`${srv.url}/app/teams/parcel-desk/projects/parcel-desk-api${query}`, { headers: leadCookie })).text();
  const openSessions = (html: string) => Number(/(\d+) open sessions/.exec(html)?.[1]);
  const before = openSessions(await projectPage());

  const created = await form(
    `${srv.url}/app/teams/parcel-desk/projects/parcel-desk-api/assign`,
    { agent: codexBInstallation, task: 'PD-22 Clear filters', brief: 'Meant for another agent; the lead picked the wrong name.', steps: '', branch: '' },
    leadCookie,
  );
  const session = /[?&]assigned=([0-9a-f-]{36})/.exec(created.headers.get('location') ?? '')?.[1];
  expect(session).toBeTruthy();
  expect((await news(codexB)).pendingHandoffs.some((h) => h.sessionId === session)).toBe(true);

  const listed = await projectPage();
  expect(listed).toContain('Assigned work');
  expect(listed).toContain('waiting for the agent');
  expect(listed).toContain(`action="/app/sessions/${session}/handoff/cancel"`);
  // Dispatched work is not a debug thread: assigning opened no "open session".
  expect(openSessions(listed)).toBe(before);

  const cancelled = await form(`${srv.url}/app/sessions/${session}/handoff/cancel`, { return_to: 'project' }, leadCookie);
  expect(cancelled.status).toBe(303);
  expect(cancelled.headers.get('location')).toBe(`/app/teams/parcel-desk/projects/parcel-desk-api?cancelled=${session}#assigned-work`);
  const after = await projectPage(`?cancelled=${session}`);
  expect(after).toContain('is cancelled: <b>Codex B on win</b> will not be told');
  expect(after).not.toContain(`action="/app/sessions/${session}/handoff/cancel"`);
  expect(openSessions(after)).toBe(before);
  expect((await news(codexB)).pendingHandoffs.some((h) => h.sessionId === session)).toBe(false);

  // Cancelled from the thread itself, the thread says so and offers the way back.
  const again = await form(
    `${srv.url}/app/teams/parcel-desk/projects/parcel-desk-api/assign`,
    { agent: codexBInstallation, task: 'PD-22 Clear filters again', brief: 'Cancelled from inside the thread this time.', steps: '', branch: '' },
    leadCookie,
  );
  const second = /[?&]assigned=([0-9a-f-]{36})/.exec(again.headers.get('location') ?? '')?.[1];
  const fromThread = await form(`${srv.url}/app/sessions/${second}/handoff/cancel`, {}, leadCookie);
  expect(fromThread.headers.get('location')).toBe(`/app/sessions/${second}?handoff=cancelled`);
  const thread = await (await fetch(`${srv.url}/app/sessions/${second}?handoff=cancelled`, { headers: leadCookie })).text();
  expect(thread).toContain('This assignment is cancelled');
  expect(thread).toContain('Back to parcel-desk-api');
  expect(thread).toContain('assignment cancelled');
});

it('shows a project its agents, and a workspace who has which agent and what each is doing', async () => {
  // The owner, 2026-09-20: "projeye giriyorum, orada çalışan agentları görmek
  // istiyorum, ancak yok" — Connect agent walked into personal settings — and "ben
  // burada tek kendi agentlarımın bile ne yaptığını göremiyorum".
  const page = async (p: string, cookie = leadCookie) => fetch(`${srv.url}${p}`, { headers: cookie });
  const lit = (html: string) =>
    [...html.matchAll(/class="rail-link active"[^>]*>([^<]*)/g)].map((m) => m[1]!.trim());

  await connectAgent(leadCookie, teamId, 'Api Only', 'mac', `project:${apiProjectId}`);
  await connectAgent(leadCookie, teamId, 'Web Only', 'mac', `project:${webProjectId}`);
  const run = await call('start_run', { request_id: randomUUID(), team: 'parcel-desk', project: 'parcel-desk-api', task: 'PD-70 Roster', scope: [{ type: 'path', key: 'src/roster.ts', access: 'write' }] }, codexB);
  expect(run.isError, run.text).toBe(false);
  const given = await call('assign_work', { request_id: randomUUID(), to_agent: 'codex-a', task: 'PD-71 Waiting', brief, team: 'parcel-desk', project: 'parcel-desk-api' }, codexB);
  expect(given.isError, given.text).toBe(false);

  const inProject = await (await page('/app/teams/parcel-desk/projects/parcel-desk-api/agents')).text();
  expect(lit(inProject)).toEqual(['Agents']);
  const row = (html: string, agent: string) => new RegExp(`<tr><td><div class="name">${agent}</div>.*?</tr>`, 's').exec(html)?.[0] ?? '';
  // Bound to this project, and says so; an agent bound to another project cannot work here.
  expect(row(inProject, 'Api Only')).toContain('this project');
  expect(row(inProject, 'Web Only')).toBe('');
  // An agent of the workspace, at work here, with what it holds.
  expect(row(inProject, 'Codex B')).toContain('workspace-wide');
  expect(row(inProject, 'Codex B')).toContain('PD-70 Roster');
  expect(row(inProject, 'Codex B')).toContain('holding 1');
  // Work given to an agent stands beside it, with where it stands.
  // Beside an agent the kind is plain, so the thread's "Assignment: " prefix is dropped.
  expect(row(inProject, 'codex-a')).toContain('>PD-71 Waiting</a>');
  expect(row(inProject, 'codex-a')).toContain('waiting for the agent');
  // A local adapter is a checkout's ears, not an agent.
  expect(inProject).not.toContain('<div class="name">lead-codex-local</div>');

  // Connecting starts here and comes back here.
  const connect = '/app/tokens?team=parcel-desk&amp;project=parcel-desk-api';
  expect(inProject).toContain(`href="${connect}"`);
  const connections = await (await page('/app/tokens?team=parcel-desk&project=parcel-desk-api')).text();
  expect(lit(connections)).toEqual(['Agents']);
  expect(connections).toContain('Back to parcel-desk-api agents');
  expect(connections).toContain('<a href="/app/teams/parcel-desk/projects/parcel-desk-api/agents">Agents</a>');

  // The workspace groups the same rows by person, and every name opens that person.
  const people = await (await page('/app/teams/parcel-desk/agents')).text();
  expect(lit(people)).toEqual(['People and agents']);
  expect(people).toContain('<a href="/app/teams/parcel-desk/people/lead">lead</a>');
  expect(people).toContain('<a href="/app/teams/parcel-desk/people/bob">bob</a>');
  expect(people).toContain('href="/app/teams/parcel-desk/people/lead">Everything lead did');
  expect(row(people, 'Web Only')).toContain('parcel-desk-web');
  expect(row(people, 'Codex B')).toContain('PD-70 Roster');

  // Somebody outside the workspace is told nothing, not even that it exists.
  const outsider = jar();
  outsider.store(await form(`${srv.url}/auth/dev`, { username: 'outsider' }));
  expect((await page('/app/teams/parcel-desk/agents', outsider.header())).status).toBe(404);
  expect((await page('/app/teams/parcel-desk/projects/parcel-desk-api/agents', outsider.header())).status).toBe(404);
  expect((await call('finish_run', { run_id: run.data.runId }, codexB)).isError).toBe(false);
});

it('keeps a connection started inside a project inside it, whether it is issued or refused', async () => {
  // Phase 4 of the console plan: every action returns where it started. Connecting
  // opened in the project's scope (phase 2) and then lost it at the two moments that
  // matter: the page that shows the command fell back to the workspace, and a
  // refused request landed on the account's list with the project gone.
  const lit = (html: string) =>
    [...html.matchAll(/class="rail-link active"[^>]*>([^<]*)/g)].map((m) => m[1]!.trim());
  const scope = { filter_team: 'parcel-desk', filter_project: apiProjectId };

  const issued = await form(
    `${srv.url}/app/tokens`,
    { ...scope, name: 'Scoped Connect', device: 'mac', access: `project:${apiProjectId}`, client: 'codex', role: 'generalist' },
    leadCookie,
  );
  expect(issued.status).toBe(200);
  const page = await issued.text();
  expect(page).toContain('stma_enroll_');
  // The command is shown once, on a page that is still the project's.
  expect(lit(page)).toEqual(['Agents']);
  expect(page).toContain('Back to parcel-desk-api agents');
  expect(page).toContain('<a href="/app/teams/parcel-desk/projects/parcel-desk-api/agents">Agents</a>');

  // A refusal comes back to the same scope, one corrected field away from a command.
  const refused = await form(
    `${srv.url}/app/tokens`,
    { ...scope, name: '', device: 'mac', access: `project:${apiProjectId}`, client: 'codex', role: 'generalist' },
    leadCookie,
  );
  expect(refused.status).toBe(302);
  const where = new URL(refused.headers.get('location') ?? '', srv.url);
  expect(where.pathname).toBe('/app/tokens');
  expect(where.searchParams.get('team')).toBe('parcel-desk');
  expect(where.searchParams.get('project')).toBe(apiProjectId);
  expect(where.searchParams.get('error')).toContain('Name one agent');
  const back = await (await fetch(where, { headers: leadCookie })).text();
  expect(lit(back)).toEqual(['Agents']);
  expect(back).toContain('Back to parcel-desk-api agents');

  // Opened from the account, a refusal stays at the account: there is no scope to keep.
  const plain = await form(`${srv.url}/app/tokens`, { name: '', device: 'mac', access: `team:${teamId}` }, leadCookie);
  const plainWhere = new URL(plain.headers.get('location') ?? '', srv.url);
  expect(plainWhere.searchParams.get('team')).toBeNull();
  expect(plainWhere.searchParams.get('project')).toBeNull();
});

it('creates the connect command on a project Agents page, and refuses there too', async () => {
  // Phase 2 left "connect the agent for this project" as a link to the account's
  // Agent connections page: the person left the project to fill in a form and
  // read a command. The form is on the page now, and so is its answer.
  const agentsPage = `${srv.url}/app/teams/parcel-desk/projects/parcel-desk-api/agents`;
  const lit = (html: string) =>
    [...html.matchAll(/class="rail-link active"[^>]*>([^<]*)/g)].map((m) => m[1]!.trim());

  const empty = await (await fetch(agentsPage, { headers: leadCookie })).text();
  // One component with /app/tokens, so the form is the same form; only the
  // project differs, and here the address already decided it.
  expect(empty).toContain('action="/app/teams/parcel-desk/projects/parcel-desk-api/agents/connect"');
  expect(empty).toContain('Create connect command');
  expect(empty).toContain('project only — parcel-desk-api');
  // No access picker: the project is the address, not a field a browser can move.
  expect(empty).not.toContain('id="pc-access"');
  expect(empty).toContain('href="#connect-agent"');

  const issued = await form(
    `${agentsPage}/connect`,
    { mode: 'terminal', name: 'In Place', device: 'mac-mini', client: 'claude-code' },
    leadCookie,
  );
  expect(issued.status).toBe(200);
  const shown = await issued.text();
  // The one-time command, in the same shape /app/tokens shows it, on this page.
  expect(shown).toContain('npx -y @matteai/stma connect stma_enroll_');
  expect(shown).toContain('Run this in a terminal, inside the checkout');
  expect(shown).toContain('<b>In Place</b>');
  expect(shown).toContain('<b>parcel-desk / parcel-desk-api</b>');
  // Still the project's page: the rail, the trail and the roster are all here.
  expect(lit(shown)).toEqual(['Agents']);
  expect(shown).toContain('<h1>Agents</h1>');

  // A refusal comes back here too, with what was typed still in it.
  const refused = await form(
    `${agentsPage}/connect`,
    { mode: 'terminal', name: '', device: 'mac-mini', client: 'codex' },
    leadCookie,
  );
  expect(refused.status).toBe(422);
  const again = await refused.text();
  expect(again).toContain('Name one agent and one machine');
  expect(again).toContain('value="mac-mini"');
  expect(again).toContain('<option value="codex" selected="">');
  expect(again).not.toContain('stma_enroll_');
  expect(lit(again)).toEqual(['Agents']);

  // A client whose hooks this command cannot write is answered, not silently downgraded.
  const wrongClient = await form(
    `${agentsPage}/connect`,
    { mode: 'terminal', name: 'Cursor Here', device: 'mac-mini', client: 'cursor' },
    leadCookie,
  );
  expect(wrongClient.status).toBe(422);
  expect(await wrongClient.text()).toContain('supports Claude Code and Codex');

  // A stranger cannot post it, and is told nothing about the project either.
  const outsider = jar();
  outsider.store(await form(`${srv.url}/auth/dev`, { username: 'stranger-connect' }));
  const denied = await form(
    `${agentsPage}/connect`,
    { mode: 'terminal', name: 'Sneaky', device: 'mac-mini', client: 'codex' },
    outsider.header(),
  );
  expect(denied.status).toBe(404);
});

it('gives a person their own page: their agents, runs, work and trail', async () => {
  // The workspace roster linked a name to Activity with ?actor=, which is a log
  // and says nothing about their agents, their runs or the work they dispatched.
  const personPage = async (name: string, cookie = leadCookie, query = '') =>
    fetch(`${srv.url}/app/teams/parcel-desk/people/${name}${query}`, { headers: cookie });
  const lit = (html: string) =>
    [...html.matchAll(/class="rail-link active"[^>]*>([^<]*)/g)].map((m) => m[1]!.trim());

  const run = await call(
    'start_run',
    {
      request_id: randomUUID(),
      team: 'parcel-desk',
      project: 'parcel-desk-api',
      task: 'PD-90 Person page',
      scope: [{ type: 'path', key: 'src/person.ts', access: 'write' }],
    },
    codexB,
  );
  expect(run.isError, run.text).toBe(false);
  const sent = await call(
    'assign_work',
    { request_id: randomUUID(), to_agent: 'codex-a', task: 'PD-91 For the page', brief, team: 'parcel-desk', project: 'parcel-desk-api' },
    codexB,
  );
  expect(sent.isError, sent.text).toBe(false);

  const page = await (await personPage('lead')).text();
  expect(lit(page)).toEqual(['People and agents']);
  expect(page).toContain('<h1>lead</h1>');
  expect(page).toContain('owner in Parcel Desk since');
  // Their agents, from the roster reader the other two pages use.
  expect(page).toContain('<div class="card-title">Agents</div>');
  expect(page).toContain('<div class="name">Codex B</div>');
  // Their runs, live first, each linking to the map that owns a run's detail.
  expect(page).toContain('<div class="card-title">Runs</div>');
  expect(page).toContain('PD-90 Person page');
  expect(page).toContain(`href="/app/agents?run=${run.data.runId}&amp;team=parcel-desk&amp;project=parcel-desk-api"`);
  // Work, with which direction it went.
  expect(page).toContain('<div class="card-title">Work</div>');
  expect(page).toContain('PD-91 For the page');
  expect(page).toContain('assigned to codex-a');
  // The trail, read through Activity's own reader, with the way to the full log.
  expect(page).toContain('<div class="card-title">Trail</div>');
  expect(page).toContain('href="/app/teams/parcel-desk/activity?actor=lead"');
  expect(page).toContain('run_started');
  // Every card carries the page that owns it.
  expect(page).toContain('href="/app/handoffs?team=parcel-desk"');
  expect(page).toContain('href="/app/teams/parcel-desk/agents"');

  // The receiving side is listed on the receiver's page, as given rather than sent.
  const bobs = await (await personPage('bob')).text();
  expect(bobs).toContain('<h1>bob</h1>');
  expect(bobs).toContain('member in Parcel Desk since');

  // Any member may read it about another member; that is the boundary the team
  // directory and the agent map already draw.
  expect((await personPage('lead', bobCookie)).status).toBe(200);
  // Somebody outside the workspace, a member of no workspace, and a name that is
  // not a member here are all the same 404.
  const outsider = jar();
  outsider.store(await form(`${srv.url}/auth/dev`, { username: 'stranger-person' }));
  expect((await personPage('lead', outsider.header())).status).toBe(404);
  expect((await personPage('stranger-person')).status).toBe(404);
  expect((await personPage('nobody-at-all')).status).toBe(404);

  expect((await call('finish_run', { run_id: run.data.runId }, codexB)).isError).toBe(false);
});
