import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agentInstallations, memberships, projects, teams, tokens } from '../src/db/schema';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

let srv: StartedServer;
let dataDir: string;
let rpcId = 1;

function jar() {
  const cookies = new Map<string, string>();
  return {
    header(): Record<string, string> {
      return cookies.size
        ? { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') }
        : {};
    },
    store(response: Response) {
      for (const line of response.headers.getSetCookie()) {
        const [pair] = line.split(';');
        const separator = pair!.indexOf('=');
        cookies.set(pair!.slice(0, separator), pair!.slice(separator + 1));
      }
    },
  };
}

type CookieJar = ReturnType<typeof jar>;

async function devLogin(username: string) {
  const cookies = jar();
  const response = await fetch(`${srv.url}/auth/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username }),
    redirect: 'manual',
  });
  cookies.store(response);
  expect(response.status).toBe(302);
  return cookies;
}

async function form(cookies: CookieJar, pathname: string, body: Record<string, string>) {
  return fetch(`${srv.url}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...cookies.header() },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });
}

async function callTool(accessToken: string, name: string) {
  const response = await fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId++,
      method: 'tools/call',
      params: { name, arguments: {} },
    }),
  });
  const body = await response.json() as {
    result?: { isError?: boolean; content: Array<{ type: string; text: string }> };
  };
  return { response, body };
}

async function initializeClient(accessToken: string) {
  const response = await fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId++,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'native-oauth-test', version: '1.0.0' },
      },
    }),
  });
  return { response, body: await response.json() as { result?: unknown; error?: unknown } };
}

const verifier = 'correct-horse-battery-staple-codex-oauth-verifier-2026';
const challenge = createHash('sha256').update(verifier).digest('base64url');
const callback = 'http://127.0.0.1:43199/callback';

async function authorize(
  cookies: CookieJar,
  clientId: string,
  access: string,
  suffix: string,
) {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: callback,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: `state-${suffix}`,
    scope: 'stma offline_access',
    resource: `${srv.url}/mcp`,
  });
  const page = await fetch(`${srv.url}/oauth/authorize?${query}`, { headers: cookies.header() });
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('Connect this agent to STMA');
  expect(html).toContain('The client stores them');
  expect(html).toContain('does not install local hooks or file guards');
  expect(html).toContain('Client reported by OAuth');
  expect(html).not.toContain('name="agent_client"');
  expect(html).not.toContain('stma_enroll_');

  const approved = await form(cookies, '/oauth/authorize', {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: callback,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: `state-${suffix}`,
    scope: 'stma offline_access',
    resource: `${srv.url}/mcp`,
    decision: 'allow',
    name: `codex-${suffix}`,
    device: `mac-${suffix}`,
    // A forged legacy form value must not relabel the registered OAuth client.
    agent_client: 'claude-code',
    access,
    role: 'generalist',
  });
  expect(approved.status).toBe(302);
  const redirected = new URL(approved.headers.get('location')!);
  expect(`${redirected.origin}${redirected.pathname}`).toBe(callback);
  expect(redirected.searchParams.get('state')).toBe(`state-${suffix}`);
  const code = redirected.searchParams.get('code');
  expect(code).toMatch(/^stma_oauth_code_[a-f0-9]{64}$/);

  const exchanged = await fetch(`${srv.url}/oauth/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://native-client.example',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: code!,
      redirect_uri: callback,
      code_verifier: verifier,
      resource: `${srv.url}/mcp`,
    }),
  });
  expect(exchanged.status).toBe(200);
  const token = await exchanged.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
  };
  expect(token.access_token).toMatch(/^stma_[a-f0-9]{40}$/);
  expect(token.refresh_token).toMatch(/^stma_refresh_[a-f0-9]{64}$/);
  expect(token.expires_in).toBeGreaterThan(3500);
  expect(token.expires_in).toBeLessThanOrEqual(3600);
  expect(token.scope).toBe('stma');
  return token;
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-mcp-oauth-'));
  srv = await startServer(loadEnv({
    port: 0,
    host: '127.0.0.1',
    nodeEnv: 'test',
    devMode: true,
    databaseUrl: undefined,
    pgliteDir: dataDir,
  }));
});

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

it('publishes MCP OAuth discovery and rejects anonymous MCP calls with a resource challenge', async () => {
  const resource = await fetch(`${srv.url}/.well-known/oauth-protected-resource/mcp`);
  expect(resource.status).toBe(200);
  expect(await resource.json()).toMatchObject({
    resource: `${srv.url}/mcp`,
    authorization_servers: [srv.url],
    scopes_supported: ['stma'],
  });

  const authorization = await fetch(`${srv.url}/.well-known/oauth-authorization-server`);
  expect(await authorization.json()).toMatchObject({
    issuer: srv.url,
    authorization_endpoint: `${srv.url}/oauth/authorize`,
    token_endpoint: `${srv.url}/oauth/token`,
    registration_endpoint: `${srv.url}/oauth/register`,
    code_challenge_methods_supported: ['S256'],
  });

  const anonymous = await fetch(`${srv.url}/mcp`, { method: 'POST', body: '{}' });
  expect(anonymous.status).toBe(401);
  expect(anonymous.headers.get('www-authenticate')).toContain(
    `resource_metadata="${srv.url}/.well-known/oauth-protected-resource"`,
  );
});

it('connects with browser consent, project scope, PKCE and rotating tokens; reuse revokes the connection', async () => {
  const owner = await devLogin('oauth-owner');
  expect((await form(owner, '/app/teams', { name: 'OAuth Workspace' })).status).toBe(302);
  expect((await form(owner, '/app/projects', {
    team: 'oauth-workspace',
    project: 'github.com/matte/oauth-fixture',
    return_to: 'projects',
  })).status).toBe(302);
  const [team] = await srv.db.select().from(teams).where(eq(teams.slug, 'oauth-workspace'));
  const [project] = await srv.db.select().from(projects).where(eq(projects.teamId, team!.id));

  const registered = await fetch(`${srv.url}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://native-client.example' },
    body: JSON.stringify({
      client_name: 'Codex test client',
      redirect_uris: [callback],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  expect(registered.status).toBe(201);
  const client = await registered.json() as { client_id: string };
  expect(client.client_id).toMatch(/^stma_client_[a-f0-9]{48}$/);

  const token = await authorize(owner, client.client_id, `project:${project!.id}`, 'project');
  const oauthTokensBeforeInitialize = await srv.db.select().from(tokens).where(eq(tokens.userId, team!.createdBy!));
  const pendingOauthToken = oauthTokensBeforeInitialize.find(
    (row) => row.audience === `${srv.url}/mcp` && row.expiresAt,
  );
  expect(pendingOauthToken?.activatedAt).toBeNull();

  const initialized = await initializeClient(token.access_token);
  expect(initialized.response.status).toBe(200);
  expect(initialized.body.error).toBeUndefined();
  const [activeOauthToken] = await srv.db.select().from(tokens).where(eq(tokens.id, pendingOauthToken!.id));
  expect(activeOauthToken!.activatedAt).toBeInstanceOf(Date);
  expect(activeOauthToken!.lastUsedAt).toBeInstanceOf(Date);

  const who = await callTool(token.access_token, 'whoami');
  expect(who.response.status).toBe(200);
  const identity = JSON.parse(who.body.result!.content[0]!.text);
  expect(identity.credential).toMatchObject({
    scope: 'project',
    team: 'oauth-workspace',
    project: project!.slug,
    installationName: 'codex-project',
    device: 'mac-project',
  });
  const [oauthInstallation] = await srv.db
    .select()
    .from(agentInstallations)
    .where(eq(agentInstallations.tokenId, pendingOauthToken!.id));
  expect(oauthInstallation!.clientType).toBe('codex');
  expect(oauthInstallation!.lastSeenAt).toBeInstanceOf(Date);

  const oauthToken = activeOauthToken!;
  const adapterIdentity = await fetch(`${srv.url}/api/agent/identity`, {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  expect(adapterIdentity.status).toBe(200);
  expect(await adapterIdentity.json()).toMatchObject({ credential: {
    scope: 'project', team: 'oauth-workspace', project: project!.slug,
  } });
  const wrongResource = await fetch(`${srv.url}/api/agent-enrollments/self-revoke`, {
    method: 'POST', headers: { authorization: `Bearer ${token.access_token}` },
  });
  expect(wrongResource.status).toBe(401);
  await srv.db.update(tokens).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(tokens.id, oauthToken!.id));
  const expired = await callTool(token.access_token, 'whoami');
  expect(expired.response.status).toBe(401);
  expect(expired.response.headers.get('www-authenticate')).toContain('error="invalid_token"');

  const refreshed = await fetch(`${srv.url}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.client_id,
      refresh_token: token.refresh_token,
      resource: `${srv.url}/mcp`,
    }),
  });
  expect(refreshed.status).toBe(200);
  const next = await refreshed.json() as { access_token: string; refresh_token: string };
  expect(next.access_token).not.toBe(token.access_token);
  expect(next.refresh_token).not.toBe(token.refresh_token);
  expect((await callTool(token.access_token, 'whoami')).response.status).toBe(401);
  expect((await callTool(next.access_token, 'whoami')).response.status).toBe(200);

  const reused = await fetch(`${srv.url}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.client_id,
      refresh_token: token.refresh_token,
      resource: `${srv.url}/mcp`,
    }),
  });
  expect(reused.status).toBe(400);
  expect(await reused.json()).toMatchObject({ error: 'invalid_grant' });
  expect((await callTool(next.access_token, 'whoami')).response.status).toBe(401);
  const [installation] = await srv.db
    .select()
    .from(agentInstallations)
    .where(eq(agentInstallations.name, 'codex-project'));
  expect(installation!.revokedAt).toBeInstanceOf(Date);
});

it('requires exact callbacks, resource indicators and PKCE; revocation is immediate and idempotent', async () => {
  const owner = await devLogin('oauth-negative-owner');
  expect((await form(owner, '/app/teams', { name: 'OAuth Negative' })).status).toBe(302);
  const [team] = await srv.db.select().from(teams).where(eq(teams.slug, 'oauth-negative'));
  const registration = await fetch(`${srv.url}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: [callback] }),
  });
  const client = await registration.json() as { client_id: string };

  const badRedirect = new URLSearchParams({
    response_type: 'code', client_id: client.client_id,
    redirect_uri: 'http://127.0.0.1:43200/callback',
    code_challenge: challenge, code_challenge_method: 'S256',
    scope: 'stma', resource: `${srv.url}/mcp`,
  });
  expect((await fetch(`${srv.url}/oauth/authorize?${badRedirect}`, { headers: owner.header() })).status).toBe(400);

  const token = await authorize(owner, client.client_id, `team:${team!.id}`, 'revoke');
  const accessLostToken = await authorize(owner, client.client_id, `team:${team!.id}`, 'access-lost');
  const revoked = await fetch(`${srv.url}/oauth/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: token.refresh_token, client_id: client.client_id }),
  });
  expect(revoked.status).toBe(200);
  expect((await callTool(token.access_token, 'whoami')).response.status).toBe(401);
  const again = await fetch(`${srv.url}/oauth/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: token.refresh_token, client_id: client.client_id }),
  });
  expect(again.status).toBe(200);

  await srv.db.delete(memberships).where(eq(memberships.teamId, team!.id));
  const accessLost = await fetch(`${srv.url}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.client_id,
      refresh_token: accessLostToken.refresh_token,
      resource: `${srv.url}/mcp`,
    }),
  });
  expect(accessLost.status).toBe(400);
  expect(await accessLost.json()).toMatchObject({
    error: 'invalid_grant',
    error_description: 'This installation or its approved workspace access is no longer active.',
  });
  const [accessLostInstallation] = await srv.db
    .select()
    .from(agentInstallations)
    .where(eq(agentInstallations.name, 'codex-access-lost'));
  expect(accessLostInstallation!.revokedAt).toBeInstanceOf(Date);
});

it('suggests the checkout as the agent name for a per-checkout Claude Code registration only', async () => {
  const cookies = await devLogin('checkout-namer');
  const page = async (clientName: string) => {
    const registered = await fetch(`${srv.url}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: clientName, redirect_uris: [callback], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
    });
    expect(registered.status).toBe(201);
    const { client_id } = await registered.json() as { client_id: string };
    const query = new URLSearchParams({
      response_type: 'code', client_id, redirect_uri: callback, code_challenge: challenge,
      code_challenge_method: 'S256', state: 'state-name', scope: 'stma', resource: `${srv.url}/mcp`,
    });
    const response = await fetch(`${srv.url}/oauth/authorize?${query}`, { headers: cookies.header() });
    expect(response.status).toBe(200);
    return response.text();
  };
  const checkout = await page('Claude Code (stma-parcel-desk-claude-3f9a)');
  expect(checkout).toContain('id="oauth-agent-name" name="name" value="parcel-desk-claude"');
  expect(checkout).toContain('Suggested from the checkout this Claude Code agent connects from.');
  const legacy = await page('Claude Code (stma-parcel-desk-agent-lab)');
  expect(legacy).toContain('id="oauth-agent-name" name="name" value="claude-code-agent"');
  expect(legacy).not.toContain('Suggested from the checkout');
  // A folder name inside the server name must not relabel the client product.
  const codex = await page('Codex (stma-parcel-desk-claude-3f9a)');
  expect(codex).toContain('id="oauth-agent-name" name="name" value="codex-agent"');
  expect(codex).toContain('<code>codex</code>');
  const claudeInCodexFolder = await page('Claude Code (stma-parcel-desk-codex-3f9a)');
  expect(claudeInCodexFolder).toContain('value="parcel-desk-codex"');
  expect(claudeInCodexFolder).toContain('<code>claude-code</code>');
});
