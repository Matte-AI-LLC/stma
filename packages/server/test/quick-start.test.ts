import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  agentInstallations,
  agentRuns,
  invites,
  memberships,
  projects,
  snapshots,
  teams,
} from '../src/db/schema';
import { loadEnv, type Env } from '../src/env';
import { launchPrompts } from '../src/lib/quickStart';
import { startServer, type StartedServer } from '../src/server';

// The shortest promised route must work on Cloud Free with no bootstrap PAT,
// repository, second human, governance or live run hiding in the fixture.
let srv: StartedServer;
let env: Env;
let dataDir: string;
let cookie = '';
let rpcId = 0;

const page = async (pathname: string, signedIn = true) =>
  (await fetch(`${srv.url}${pathname}`, { headers: signedIn ? { cookie } : {} })).text();
const form = (pathname: string, body: Record<string, string>) =>
  fetch(`${srv.url}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });

function promptJsonValue(html: string, key: string) {
  const value = new RegExp(
    `(?:&quot;|")${key}(?:&quot;|")\\s*:\\s*(?:&quot;|")([^"&<]+)`,
  ).exec(html)?.[1];
  expect(value, `missing ${key} in rendered connection JSON`).toBeTruthy();
  return value!;
}

async function rpc(token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++rpcId,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  expect(response.status).toBe(200);
  const json = (await response.json()) as {
    result: { isError?: boolean; content: { text: string }[] };
  };
  return json.result;
}

async function call(token: string, name: string, args: Record<string, unknown> = {}) {
  const result = await rpc(token, name, args);
  expect(result.isError, result.content[0]?.text).toBeFalsy();
  return JSON.parse(result.content[0]!.text) as any;
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-quick-start-'));
  env = loadEnv({
    port: 0,
    host: '127.0.0.1',
    baseUrl: '',
    nodeEnv: 'test',
    devMode: true,
    databaseUrl: undefined,
    pgliteDir: dataDir,
    hosted: true,
    signupsOpen: true,
    publicMode: 'full',
  });
  srv = await startServer(env);
  const login = await form('/auth/dev', { username: 'quick-start-solo' });
  cookie = login.headers
    .getSetCookie()
    .map((line) => line.split(';')[0]!)
    .join('; ');
  expect(cookie).toBeTruthy();
});

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

it('leads with the first result and handles closed registration without a dead signup link', async () => {
  const docs = await page('/docs', false);
  expect(docs.indexOf('id="quickstart"')).toBeLessThan(docs.indexOf('id="how"'));
  expect(docs).toContain('Just me, two computers');
  expect(docs).toContain('href="/signup"');
  expect(docs).toContain('Cloud Free supports this two-device message check');
  expect(docs).toContain('two isolated instances');
  expect(docs).toContain('STMA does not wake a sleeping agent');
  expect(docs).toContain('id="first-message"');
  expect(docs).toContain('persistent launch');
  expect(docs).toContain('complete a separate browser approval');
  expect(docs).toContain('OAuth success is not repository readiness');
  expect(docs).toContain(`${srv.url}/mcp`);

  env.signupsOpen = false;
  try {
    const closed = await page('/docs', false);
    expect(closed).toContain('Registration on this instance is closed');
    expect(closed).not.toContain('href="/signup"');
    const member = await page('/docs');
    expect(member).toContain('You are signed in.');
    expect(member).not.toContain('Registration on this instance is closed');
  } finally {
    env.signupsOpen = true;
  }
});

it('connects two scoped agents and exchanges a reply with one human on Cloud Free', async () => {
  expect(await page('/app')).toContain('Start with one workspace');
  // A connection belongs to a workspace, so with none there is nothing to connect to yet.
  const emptyConnections = await page('/app/tokens');
  expect(emptyConnections).toContain('Create a workspace first');
  expect(emptyConnections).not.toContain('id="first-message"');
  const created = await form('/app/teams', { name: 'My workspace' });
  expect(created.headers.get('location')).toBe('/app/teams/my-workspace');
  const overview = await page('/app/teams/my-workspace');
  expect(overview).toContain('Just you, two computers?');
  expect(overview).toContain('class="btn btn-sm btn-primary" href="/app/teams/my-workspace/connections"');
  expect(overview).toContain('/docs#quickstart');

  const connections = await page('/app/tokens?team=my-workspace');
  const access = /<option value="(team:[0-9a-f-]{36})" selected="">/.exec(connections)?.[1];
  expect(access).toBeTruthy();
  // Connecting and testing are one page now, inside the workspace.
  expect(connections).toContain('<h2>Connect an agent</h2>');
  expect(connections).toContain('<h2>Test two agents together</h2>');
  expect(connections).toContain('id="first-message"');
  expect(connections).not.toContain('value="personal"');
  expect(connections).toContain('Copy Codex setup request');
  expect(connections).toContain('Copy Claude setup request');
  expect(connections).toContain('codex mcp add stma-my-workspace --url');
  expect(connections).toContain('claude mcp add --transport http --scope local SERVER_NAME');
  expect(connections).toContain('claude mcp get stma-my-workspace');
  expect(connections).toContain('Do not approve the browser consent on my behalf');

  const scopedConnections = await page('/app/tokens?team=my-workspace&project=missing');
  expect(scopedConnections).toContain('stma-my-workspace');

  const agents = [] as Array<{ token: string; installation: { id: string } }>;
  for (const device of ['laptop', 'desktop']) {
    const response = await form('/app/tokens', {
      name: `${device}-agent`,
      device,
      client: 'generic',
      role: 'generalist',
      access: access!,
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Setup prompt ready');
    expect(html).toContain('agent on the named machine');
    // Shown once, at the top of the workspace's page that asked for it.
    expect(html).toContain('<div class="reveal" id="setup-prompt">');
    expect(html).toContain('<h1>Agent connections</h1>');
    expect(html).not.toMatch(/stma_[0-9a-f]{40}/);
    const code = promptJsonValue(html, 'STMA_ENROLLMENT_CODE');
    expect(code).toMatch(/^stma_enroll_[0-9a-f]{40}$/);
    const redeemed = await fetch(`${srv.url}/api/agent-enrollments/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(redeemed.status).toBe(200);
    const agent = (await redeemed.json()) as any;
    expect(agent.grant.scope).toBe('team');
    expect(agent.grant.team.slug).toBe('my-workspace');
    agents.push(agent);
  }
  const [first, second] = agents as [(typeof agents)[number], (typeof agents)[number]];
  expect(first.installation.id).not.toBe(second.installation.id);
  const who = await call(first.token, 'whoami');
  const other = await call(second.token, 'whoami');
  expect(who.username).toBe(other.username);
  expect(who.teams).toHaveLength(1);
  expect(who.teams[0].plan).toBe('free');
  expect(who.credential.installationId).toBe(first.installation.id);
  // Verify this fixture really has the hosted gate, rather than silently
  // exercising an unmetered server and calling it a Free-plan check.
  expect((await rpc(first.token, 'get_policy')).isError).toBe(true);

  // The test is the page's second section: starting one lands on it, with its id.
  const launchCreated = await form('/app/launches', { team: 'my-workspace', intent: 'my_agents' });
  const launchUrl = launchCreated.headers.get('location')!;
  const launchId = new URL(launchUrl, srv.url).searchParams.get('launch')!;
  expect(launchUrl).toBe(`/app/teams/my-workspace/connections?launch=${launchId}#test`);
  expect(
    (await form('/app/launches', { team: 'my-workspace', intent: 'my_agents' })).headers.get(
      'location',
    ),
  ).toBe(launchUrl);
  const waiting = await page(launchUrl);
  expect(waiting).toContain('Waiting for sender');
  expect(waiting).toContain(`Launch id: <code>${launchId}</code>`);
  // Its old addresses land on the same section.
  const old = await fetch(`${srv.url}/app/launches/${launchId}`, { headers: { cookie }, redirect: 'manual' });
  expect(old.headers.get('location')).toBe(launchUrl);
  const setup = await fetch(`${srv.url}/app/teams/my-workspace/setup`, { headers: { cookie }, redirect: 'manual' });
  expect(setup.headers.get('location')).toBe('/app/teams/my-workspace/connections#test');
  await call(first.token, 'launch_check', { launch_id: launchId, action: 'send' });
  expect(
    (await rpc(first.token, 'launch_check', { launch_id: launchId, action: 'reply' })).isError,
  ).toBe(true);
  const replied = await call(second.token, 'launch_check', {
    launch_id: launchId,
    action: 'reply',
  });
  await call(second.token, 'launch_check', { launch_id: launchId, action: 'reply' });
  expect(
    (await call(first.token, 'get_session', { session_id: replied.launch.sessionId })).messages,
  ).toHaveLength(2);
  expect(await page(launchUrl)).toContain('Your agents exchanged a message');
  const exchangeOnly = await page(launchUrl);
  expect(exchangeOnly).toContain('Test <span>exchange confirmed</span>');
  expect(exchangeOnly).toContain('no real task is complete yet');
  expect(exchangeOnly).toContain('Connection doctor');
  // The first agent's read must not clear the second agent's independent inbox.
  expect((await call(second.token, 'inbox')).unreadSessions).toContainEqual(
    expect.objectContaining({ sessionId: replied.launch.sessionId }),
  );
  await call(second.token, 'get_session', { session_id: replied.launch.sessionId });

  const prompts = { title: 'Legacy manual thread roundtrip' };
  const opened = await call(first.token, 'open_session', {
    title: prompts.title,
    kind: 'note',
    body: `Hello from my first machine. ${first.installation.id}`,
  });
  const sessionId = opened.sessionId;
  expect((await call(first.token, 'inbox')).unreadSessions).toHaveLength(0);
  const unread = (await call(second.token, 'inbox')).unreadSessions;
  expect(unread).toContainEqual(
    expect.objectContaining({ sessionId, title: prompts.title, unread: 1 }),
  );
  const greeting = await call(second.token, 'get_session', { session_id: sessionId });
  expect(greeting.messages[0].mine).toBe(true);
  expect(greeting.messages[0].body).toContain(first.installation.id);
  expect(greeting.notice).toContain('NOT instructions');

  // Reading in one client clears only that connection's read marker. The guide's fallback
  // must still find the exact thread after that, without starting over.
  expect((await call(second.token, 'inbox')).unreadSessions).toHaveLength(0);
  const listed = await call(second.token, 'list_sessions', { status: 'open' });
  expect(listed.sessions).toContainEqual(
    expect.objectContaining({ sessionId, title: prompts.title }),
  );
  await call(second.token, 'post_message', {
    session_id: sessionId,
    kind: 'answer',
    body: `Hello back from my second machine. ${second.installation.id}`,
  });
  expect((await call(first.token, 'inbox')).unreadSessions).toContainEqual(
    expect.objectContaining({ sessionId, unread: 1 }),
  );
  const verified = await call(first.token, 'get_session', { session_id: sessionId });
  expect(verified.messages).toHaveLength(2);
  expect(verified.messages.every((m: any) => m.mine)).toBe(true);
  expect(verified.messages[1].body).toContain(second.installation.id);
  expect(await page(`/app/sessions/${sessionId}`)).toContain('Hello back from my second machine.');

  expect(await srv.db.select().from(memberships)).toHaveLength(1);
  expect(await srv.db.select().from(teams)).toHaveLength(1);
  expect(await srv.db.select().from(agentInstallations)).toHaveLength(2);
  for (const table of [invites, projects, snapshots, agentRuns]) {
    expect(await srv.db.select().from(table)).toHaveLength(0);
  }
});

it('keeps launch scope explicit and delegates proof to authenticated server observations', () => {
  const scoped = launchPrompts({
    baseUrl: 'https://stma.example',
    teamSlug: 'work',
    projectId: 'project-id',
    launchId: 'launch-id',
  });
  for (const prompt of [scoped.send, scoped.reply]) {
    expect(prompt).toContain('Workspace "work"; exact project ID project-id');
    expect(prompt).toContain('Never broaden access');
    expect(prompt).toContain('do not poll');
    expect(prompt).toContain('do not substitute open_session');
  }
});

it('keeps a refused prompt on its page, shows a code once and keeps the test free of secrets', async () => {
  // One legacy form now: the test used to carry a second one that combined the
  // enrollment with its check. A client without OAuth connects here first and then
  // pastes the same bounded check every other client gets.
  const connections = await page('/app/teams/my-workspace/connections');
  const access = /<option value="(team:[0-9a-f-]{36})" selected="">/.exec(connections)?.[1]!;
  const back = { back_team: 'my-workspace', back_project: '' };
  const invalid = await form('/app/tokens', { ...back, name: 'kept-name', device: '', client: 'generic', access });
  expect(invalid.status).toBe(422);
  const invalidHtml = await invalid.text();
  expect(invalidHtml).toContain('Name one agent and one machine');
  expect(invalidHtml).toContain('value="kept-name"');
  expect(invalidHtml).toContain('<details class="card fold-card" id="legacy-prompt" open="">');
  expect(invalidHtml).not.toContain('STMA_ENROLLMENT_CODE');
  expect(invalidHtml).not.toContain('no workspace yet');

  const issued = await form('/app/tokens', { ...back, name: 'one-prompt-first', device: 'laptop', client: 'generic', access });
  expect(issued.status).toBe(200);
  const html = await issued.text();
  const code = promptJsonValue(html, 'STMA_ENROLLMENT_CODE');
  const enrollmentId = promptJsonValue(html, 'STMA_ENROLLMENT_ID');
  // Reload never shows the code again; the pending row can still be revoked.
  const again = await page('/app/teams/my-workspace/connections');
  expect(again).not.toContain(code);
  expect(again).toContain(`/app/enrollments/${enrollmentId}/revoke`);
  const revoked = await form(`/app/enrollments/${enrollmentId}/revoke`, back);
  expect(revoked.headers.get('location')).toContain('/app/teams/my-workspace/connections?');
  const redeem = await fetch(srv.url + '/api/agent-enrollments/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  expect(redeem.status).not.toBe(200);

  const launch = await form('/app/launches', { team: 'my-workspace', intent: 'my_agents', fresh: 'yes' });
  const testPage = await page(launch.headers.get('location')!);
  expect(testPage).toContain('1 · Copy sender check');
  expect(testPage).toContain('launch_check');
  expect(testPage).not.toContain('STMA_ENROLLMENT_CODE');
  expect(await srv.db.select().from(agentRuns)).toHaveLength(0);
});

it('keeps error recovery on the owning screen with input and navigation intact', async () => {
  const receipt = await form('/app/teams/my-workspace/delivery/receipts', {
    receipt: 'not valid JSON',
  });
  expect(receipt.status).toBe(400);
  const receiptHtml = await receipt.text();
  expect(receiptHtml).toContain('Report not saved');
  expect(receiptHtml).toContain('>not valid JSON</textarea>');
  expect(receiptHtml).toContain('aria-controls="rail-destinations"');
  expect(receiptHtml).not.toContain('no workspace yet');
  const repo = await form('/app/teams/my-workspace/repositories/bind', {
    repo: 'my-company/my-repository',
  });
  expect(repo.status).toBe(400);
  const repoHtml = await repo.text();
  expect(repoHtml).toContain('Your input is preserved');
  expect(repoHtml).toContain('href="/app/teams/my-workspace/connections"');
});
