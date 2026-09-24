import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agentInstallations, oauthRefreshTokens, teams } from '../src/db/schema';
import { assignableAgents } from '../src/domain/assignments';
import { loadEnv } from '../src/env';
import { REFRESH_REPLAY_GRACE_MS } from '../src/routes/oauth';
import { startServer, type StartedServer } from '../src/server';

/**
 * STMA as a Claude connector (2026-09-24). The first connection from claude.ai
 * to production worked end to end and showed what did not fit: the Claude app
 * arrived typed as Claude Code, was asked for a machine and named
 * "claude-code-agent"; `whoami` said "free" beside a console that says Beta; a
 * newcomer from Claude had no workspace and no way to finish; a refresh retried
 * after a lost response would have revoked the connection; and every claude.ai
 * user arrives from one address block, which one per-address ceiling counts
 * together. The server here is the hosted beta, as production is.
 */

let srv: StartedServer;
let dataDir: string;
let rpcId = 1;

const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const LOOPBACK_CALLBACK = 'http://127.0.0.1:43311/callback';
const verifier = 'claude-app-connector-verifier-with-enough-entropy-2026';
const challenge = createHash('sha256').update(verifier).digest('base64url');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

type Jar = { header(): Record<string, string>; store(response: Response): void };

function jar(): Jar {
  const cookies = new Map<string, string>();
  return {
    header: (): Record<string, string> =>
      cookies.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {},
    store(response) {
      for (const line of response.headers.getSetCookie()) {
        const [pair] = line.split(';');
        const at = pair!.indexOf('=');
        cookies.set(pair!.slice(0, at), pair!.slice(at + 1));
      }
    },
  };
}

async function devLogin(username: string): Promise<Jar> {
  const cookies = jar();
  const response = await fetch(`${srv.url}/auth/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username }),
    redirect: 'manual',
  });
  expect(response.status).toBe(302);
  cookies.store(response);
  return cookies;
}

async function form(cookies: Jar, pathname: string, body: Record<string, string>) {
  return fetch(`${srv.url}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...cookies.header() },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });
}

async function register(clientName: string, redirectUri: string, forwardedFor?: string) {
  return fetch(`${srv.url}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}) },
    body: JSON.stringify({ client_name: clientName, redirect_uris: [redirectUri] }),
  });
}

function request(clientId: string, redirectUri: string, state: string): Record<string, string> {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    scope: 'stma',
    resource: `${srv.url}/mcp`,
  };
}

async function exchange(clientId: string, redirectUri: string, location: string) {
  const code = new URL(location).searchParams.get('code')!;
  const response = await fetch(`${srv.url}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: `${srv.url}/mcp`,
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { access_token: string; refresh_token: string };
}

async function refresh(clientId: string, refreshToken: string) {
  return fetch(`${srv.url}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
      resource: `${srv.url}/mcp`,
    }),
  });
}

async function rpc(accessToken: string, method: string, params: Record<string, unknown> = {}) {
  const response = await fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, any> };
}

async function initialize(accessToken: string) {
  const answer = await rpc(accessToken, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'claude-connector-test', version: '1.0.0' },
  });
  expect(answer.status).toBe(200);
  return answer;
}

/** The whole claude.ai flow for one signed-in person, as the Claude app runs it. */
async function connectClaudeApp(cookies: Jar, state: string, access = 'personal') {
  const registered = await register('Claude', CLAUDE_CALLBACK);
  expect(registered.status).toBe(201);
  const { client_id: clientId } = (await registered.json()) as { client_id: string };
  const page = await fetch(`${srv.url}/oauth/authorize?${new URLSearchParams(request(clientId, CLAUDE_CALLBACK, state))}`, {
    headers: cookies.header(),
  });
  expect(page.status).toBe(200);
  const html = await page.text();
  const allowed = await form(cookies, '/oauth/authorize', {
    ...request(clientId, CLAUDE_CALLBACK, state),
    decision: 'allow',
    name: 'claude-app',
    access,
  });
  expect(allowed.status).toBe(302);
  const location = allowed.headers.get('location')!;
  expect(location.startsWith(`${CLAUDE_CALLBACK}?`)).toBe(true);
  const token = await exchange(clientId, CLAUDE_CALLBACK, location);
  await initialize(token.access_token);
  return { clientId, html, token };
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-claude-connector-'));
  srv = await startServer(loadEnv({
    port: 0,
    host: '127.0.0.1',
    nodeEnv: 'test',
    devMode: true,
    databaseUrl: undefined,
    pgliteDir: dataDir,
    hosted: true,
    betaUnmetered: true,
    // Cloudflare in front, as production: the client address is the last entry.
    trustedProxyHops: 1,
  }));
}, 120_000);

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the Claude app connects as a console, not an agent', () => {
  it('asks for no machine, defaults to Personal, and is nobody to give work to', async () => {
    const owner = await devLogin('claude-owner');
    expect((await form(owner, '/app/teams', { name: 'Claude Console' })).status).toBe(302);
    const [team] = await srv.db.select().from(teams).where(eq(teams.slug, 'claude-console'));

    const { html, token } = await connectClaudeApp(owner, 'console');
    expect(html).toContain('This is the Claude app');
    expect(html).not.toContain('id="oauth-device"');
    expect(html).toContain('value="claude-app"');
    expect(html).toMatch(/<option value="personal" selected/);
    expect(html).toContain('<code>claude-app</code>');

    const [app] = await srv.db.select().from(agentInstallations).where(eq(agentInstallations.userId, team!.createdBy!));
    expect(app).toMatchObject({ clientType: 'claude-app', deviceLabel: 'claude.ai', name: 'claude-app' });

    // A Claude Code agent of the same person, through its loopback callback, is
    // still somebody to assign work to: the filter is the Claude app, nothing else.
    const registered = await register('Claude Code (stma-console-1a2b)', LOOPBACK_CALLBACK);
    const { client_id: codeClient } = (await registered.json()) as { client_id: string };
    const approved = await form(owner, '/oauth/authorize', {
      ...request(codeClient, LOOPBACK_CALLBACK, 'agent'),
      decision: 'allow',
      name: 'console-agent',
      device: 'desk',
      access: `team:${team!.id}`,
    });
    expect(approved.status).toBe(302);
    const agentToken = await exchange(codeClient, LOOPBACK_CALLBACK, approved.headers.get('location')!);
    await initialize(agentToken.access_token);
    const assignable = (await assignableAgents(srv.db, team!.id)).map((agent) => agent.name);
    expect(assignable).toContain('console-agent');
    expect(assignable).not.toContain('claude-app');

    // What the console prints for the plan, not the stored row.
    const whoami = await rpc(token.access_token, 'tools/call', { name: 'whoami', arguments: {} });
    const identity = JSON.parse(whoami.body.result.content[0].text);
    expect(identity.teams[0]).toMatchObject({ slug: 'claude-console', plan: 'free', planLabel: 'Beta' });
  });

  it('describes every tool with the hints Claude acts on', async () => {
    const owner = await devLogin('claude-hints');
    expect((await form(owner, '/app/teams', { name: 'Claude Hints' })).status).toBe(302);
    const { token } = await connectClaudeApp(owner, 'hints');
    const listed = await rpc(token.access_token, 'tools/list');
    const tools = listed.body.result.tools as Array<{ name: string; title?: string; annotations?: Record<string, unknown> }>;
    expect(tools.length).toBeGreaterThan(30);
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.annotations?.title, tool.name).toBe(tool.title);
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe('boolean');
      expect(typeof tool.annotations?.openWorldHint, tool.name).toBe('boolean');
      if (tool.annotations?.readOnlyHint === false) expect(tool.annotations?.destructiveHint, tool.name).toBe(true);
    }
    const byName = new Map(tools.map((tool) => [tool.name, tool.annotations]));
    expect(byName.get('whoami')).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(byName.get('list_issues')).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(byName.get('assign_work')).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    expect(byName.get('update_run')).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });

    const init = await initialize(token.access_token);
    expect(init.body.result.serverInfo).toMatchObject({ name: 'stma', title: 'STMA' });
    expect(init.body.result.serverInfo.version).not.toBe('0.1.0');
    expect(init.body.result.instructions).not.toMatch(/never look for it on disk|Do not install/);
  });

  it('introduces itself to a coding agent with the paragraph the agent lab measured', async () => {
    const owner = await devLogin('claude-two-readers');
    expect((await form(owner, '/app/teams', { name: 'Two Readers' })).status).toBe(302);
    const app = await connectClaudeApp(owner, 'readers');
    const chat = (await initialize(app.token.access_token)).body.result.instructions as string;

    const registered = await register('Claude Code (stma-parcel-ab12)', LOOPBACK_CALLBACK);
    expect(registered.status).toBe(201);
    const { client_id: clientId } = (await registered.json()) as { client_id: string };
    const allowed = await form(owner, '/oauth/authorize', {
      ...request(clientId, LOOPBACK_CALLBACK, 'agent'),
      decision: 'allow',
      name: 'parcel-agent',
      device: 'desk',
      access: 'personal',
    });
    expect(allowed.status).toBe(302);
    const token = await exchange(clientId, LOOPBACK_CALLBACK, allowed.headers.get('location')!);
    const agent = (await initialize(token.access_token)).body.result.instructions as string;

    // On the descriptive paragraph one of the two T2 runs of 2026-09-24 went red
    // and b2 never closed a run; an agent keeps the paragraph the lab measured.
    expect(agent).toContain('update claims before editing or after waiting, and finish_run when done');
    expect(agent).toContain('never look for it on disk');
    expect(agent).not.toContain('From a chat');
    expect(chat).toContain('From a chat');
    expect(chat).not.toMatch(/never look for it on disk|Do not install/);
  });
});

describe('the guide', () => {
  it('offers the prefilled Add custom connector link for this server, signed out', async () => {
    const html = await (await fetch(`${srv.url}/docs`)).text();
    expect(html).toContain('id="claude-app"');
    expect(html).toContain('href="#claude-app"');
    const link = /href="(https:\/\/claude\.ai\/customize\/connectors\?[^"]+)"/.exec(html)![1]!.replaceAll('&amp;', '&');
    const params = new URL(link).searchParams;
    expect(params.get('modal')).toBe('add-custom-connector');
    expect(params.get('connectorName')).toBe('STMA');
    expect(params.get('connectorUrl')).toMatch(/^https?:\/\/[^/]+\/mcp$/);
  });
});

describe('somebody who signed up on the way from Claude', () => {
  it('makes a first workspace on the consent page and comes back to the same request', async () => {
    const newcomer = await devLogin('claude-newcomer');
    const registered = await register('Claude', CLAUDE_CALLBACK);
    const { client_id: clientId } = (await registered.json()) as { client_id: string };
    const query = new URLSearchParams(request(clientId, CLAUDE_CALLBACK, 'newcomer'));
    const first = await (await fetch(`${srv.url}/oauth/authorize?${query}`, { headers: newcomer.header() })).text();
    expect(first).toContain('Create your first workspace');
    expect(first).toContain('action="/app/teams"');
    const next = /name="next" value="([^"]+)"/.exec(first)![1]!.replaceAll('&amp;', '&');
    expect(next).toBe(`/oauth/authorize?${query}`);

    const made = await form(newcomer, '/app/teams', { name: 'Newcomer Space', next });
    expect(made.status).toBe(302);
    expect(made.headers.get('location')).toBe(next);
    const back = await (await fetch(`${srv.url}${next}`, { headers: newcomer.header() })).text();
    expect(back).not.toContain('Create your first workspace');
    expect(back).toContain('newcomer-space');
    expect(back).not.toMatch(/value="allow" disabled/);
  });

  it('honours no other next address', async () => {
    const other = await devLogin('claude-elsewhere');
    for (const next of ['/admin', 'https://evil.example/oauth/authorize?x=1', '//evil.example/oauth/authorize?x=1']) {
      const made = await form(other, '/app/teams', { name: `Elsewhere ${next.length}`, next });
      expect(made.status).toBe(302);
      expect(made.headers.get('location')).toMatch(/^\/app\/teams\/elsewhere-/);
    }
  });
});

describe('a refresh retried after its answer was lost', () => {
  it('is answered again, and every other repeat is reuse that revokes the connection', async () => {
    const owner = await devLogin('claude-refresh');
    expect((await form(owner, '/app/teams', { name: 'Claude Refresh' })).status).toBe(302);
    const { clientId, token } = await connectClaudeApp(owner, 'refresh');

    const first = await refresh(clientId, token.refresh_token);
    expect(first.status).toBe(200);
    const lost = (await first.json()) as { access_token: string; refresh_token: string };
    const retried = await refresh(clientId, token.refresh_token);
    expect(retried.status).toBe(200);
    const kept = (await retried.json()) as { access_token: string; refresh_token: string };
    expect((await rpc(kept.access_token, 'tools/list')).status).toBe(200);

    // The client kept the retry's answer. Spending it retires the lost one, and
    // presenting that later is reuse: the whole connection goes.
    const moved = await refresh(clientId, kept.refresh_token);
    expect(moved.status).toBe(200);
    const latest = (await moved.json()) as { access_token: string; refresh_token: string };
    const stale = await refresh(clientId, lost.refresh_token);
    expect(stale.status).toBe(400);
    expect((await rpc(latest.access_token, 'tools/list')).status).toBe(401);
  });

  it('is reuse once the window has passed', async () => {
    const owner = await devLogin('claude-late');
    expect((await form(owner, '/app/teams', { name: 'Claude Late' })).status).toBe(302);
    const { clientId, token } = await connectClaudeApp(owner, 'late');
    const first = await refresh(clientId, token.refresh_token);
    const next = (await first.json()) as { access_token: string };
    await srv.db
      .update(oauthRefreshTokens)
      .set({ usedAt: new Date(Date.now() - REFRESH_REPLAY_GRACE_MS - 5_000) })
      .where(eq(oauthRefreshTokens.tokenHash, sha256(token.refresh_token)));
    const late = await refresh(clientId, token.refresh_token);
    expect(late.status).toBe(400);
    expect(await late.json()).toMatchObject({ error: 'invalid_grant' });
    expect((await rpc(next.access_token, 'tools/list')).status).toBe(401);
  });

  it('survives two refreshes racing with the same token', async () => {
    const owner = await devLogin('claude-race');
    expect((await form(owner, '/app/teams', { name: 'Claude Race' })).status).toBe(302);
    const { clientId, token } = await connectClaudeApp(owner, 'race');
    const answers = await Promise.all([refresh(clientId, token.refresh_token), refresh(clientId, token.refresh_token)]);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    const bodies = (await Promise.all(answers.map((answer) => answer.json()))) as Array<{ access_token: string }>;
    const live = await Promise.all(bodies.map((body) => rpc(body.access_token, 'tools/list')));
    expect(live.map((answer) => answer.status).sort()).toEqual([200, 401]);
  });
});

describe("Anthropic's egress block", () => {
  it('shares one address block, so it gets ten times the per-address ceiling on /oauth', async () => {
    const statuses = async (address: string) => {
      const seen: number[] = [];
      for (let i = 0; i < 61; i++) seen.push((await register(`Burst ${i}`, CLAUDE_CALLBACK, address)).status);
      return seen;
    };
    const elsewhere = await statuses('198.51.100.7');
    expect(elsewhere.slice(0, 60).every((status) => status === 201)).toBe(true);
    expect(elsewhere[60]).toBe(429);
    const anthropic = await statuses('160.79.106.160');
    expect(anthropic.every((status) => status === 201)).toBe(true);
  });
});
