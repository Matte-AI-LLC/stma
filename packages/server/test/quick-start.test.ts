import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  agentInstallations,
  agentEnrollments,
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
  const emptyConnections = await page('/app/tokens');
  expect(emptyConnections).toContain('Create or join a team first');
  expect(emptyConnections).not.toContain('id="first-message"');
  const created = await form('/app/teams', { name: 'My workspace' });
  expect(created.headers.get('location')).toBe('/app/teams/my-workspace');
  const overview = await page('/app/teams/my-workspace');
  expect(overview).toContain('Just you, two computers?');
  expect(overview).toContain('class="btn btn-sm btn-primary" href="/app/tokens?team=my-workspace"');
  expect(overview).toContain('/docs#quickstart');

  const connections = await page('/app/tokens?team=my-workspace');
  const access = /<option value="(team:[0-9a-f-]{36})" selected="">/.exec(connections)?.[1];
  expect(access).toBeTruthy();
  expect(connections).toContain('Personal includes every membership this account can reach');
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
    expect(html).toContain(
      '<details class="card card-pad" open=""><summary class="card-title">Legacy setup prompt (compatibility)',
    );
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

  const launchCreated = await form('/app/launches', { team: 'my-workspace', intent: 'my_agents' });
  const launchUrl = launchCreated.headers.get('location')!;
  const launchId = launchUrl.split('/').at(-1)!;
  expect(
    (await form('/app/launches', { team: 'my-workspace', intent: 'my_agents' })).headers.get(
      'location',
    ),
  ).toBe(launchUrl);
  expect(await page(launchUrl)).toContain('Waiting for sender');
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
  expect(exchangeOnly).toContain('Exchange confirmed · real task pending');
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

it('launches with two combined prompts, preserves form recovery and never replays a displayed secret', async () => {
  const launch = await form('/app/launches', {
    team: 'my-workspace',
    intent: 'my_agents',
    fresh: 'yes',
  });
  const url = launch.headers.get('location')!;
  const id = url.split('/').at(-1)!;
  const invalid = await form(url + '/enroll', { name: 'kept-name', device: '', client: 'generic' });
  const invalidHtml = await invalid.text();
  expect(invalidHtml).toContain('Your input is preserved');
  expect(invalidHtml).toContain('value="kept-name"');
  expect(invalidHtml).not.toContain('STMA_ENROLLMENT_CODE');
  const first = await form(url + '/enroll', {
    name: 'one-prompt-first',
    device: 'laptop',
    client: 'generic',
  });
  const html = await first.text();
  const firstCode = promptJsonValue(html, 'STMA_ENROLLMENT_CODE');
  const enrollmentId = promptJsonValue(html, 'STMA_ENROLLMENT_ID');
  expect(html).toContain('Connect &amp; test');
  expect(html).not.toContain('no workspace yet');
  expect(html).toContain('launch_check');
  expect(html).toContain('only additional authorized write');
  expect(await page(url + '?enrollment=' + enrollmentId)).not.toContain(firstCode);
  const replacement = await form(url + '/enroll', {
    name: 'one-prompt-first',
    device: 'laptop',
    client: 'generic',
    replace: enrollmentId,
  });
  const replacementCode = promptJsonValue(
    await replacement.text(),
    'STMA_ENROLLMENT_CODE',
  );
  expect(replacementCode).not.toBe(firstCode);
  expect(
    (await srv.db.select().from(agentEnrollments).where(eq(agentEnrollments.id, enrollmentId)))[0]!
      .revokedAt,
  ).not.toBeNull();
  const redeem = (code: string) =>
    fetch(srv.url + '/api/agent-enrollments/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
  expect((await redeem(firstCode)).status).not.toBe(200);
  const sender = (await (await redeem(replacementCode)).json()) as any;
  expect(sender.grant.scope).toBe('team');
  expect(sender.installation.role).toBe('generalist');
  await call(sender.token, 'whoami', {});
  await call(sender.token, 'launch_check', { launch_id: id, action: 'send' });
  expect(await page(url)).toContain('Connect another agent');
  const second = await form(url + '/enroll', {
    name: 'one-prompt-second',
    device: 'desktop',
    client: 'generic',
  });
  const secondHtml = await second.text();
  expect(secondHtml).toContain('&quot;action&quot;:&quot;reply&quot;');
  const receiver = (await (
    await redeem(promptJsonValue(secondHtml, 'STMA_ENROLLMENT_CODE'))
  ).json()) as any;
  expect(receiver.installation.role).toBe('generalist');
  await call(receiver.token, 'whoami', {});
  await call(receiver.token, 'launch_check', { launch_id: id, action: 'reply' });
  expect(await page(url)).toContain('Your agents exchanged a message');
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
  expect(repoHtml).toContain('Connect &amp; test');
});
