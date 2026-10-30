/**
 * An OAuth MCP client for suites that need a real connection rather than rows.
 *
 * Not a `*.test.ts` file, so vitest never collects it. It does what Claude
 * Code, Codex or the Claude app do against `/oauth` and `/mcp`: register a
 * public client, show the consent page to a signed-in person, post their
 * decision, exchange the code with PKCE and send the first `initialize`, which
 * is the request that confirms a connection.
 */
import { createHash } from 'node:crypto';
import { expect } from 'vitest';

export const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
export const LOOPBACK_CALLBACK = 'http://127.0.0.1:43311/callback';

const verifier = 'connection-state-verifier-with-enough-entropy-2026-10';
const challenge = createHash('sha256').update(verifier).digest('base64url');

export type Jar = { header(): Record<string, string>; store(response: Response): void };

export function jar(): Jar {
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

export async function devLogin(url: string, username: string): Promise<Jar> {
  const cookies = jar();
  const response = await fetch(`${url}/auth/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username }),
    redirect: 'manual',
  });
  expect(response.status).toBe(302);
  cookies.store(response);
  return cookies;
}

export const postForm = (url: string, cookies: Jar, pathname: string, body: Record<string, string>) =>
  fetch(`${url}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...cookies.header() },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });

export const getPage = (url: string, cookies: Jar, pathname: string) =>
  fetch(`${url}${pathname}`, { headers: cookies.header(), redirect: 'manual' });

export const pageText = async (url: string, cookies: Jar, pathname: string) =>
  (await fetch(`${url}${pathname}`, { headers: cookies.header() })).text();

export function authorizeParams(url: string, clientId: string, redirectUri: string, state: string) {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    scope: 'stma',
    resource: `${url}/mcp`,
  };
}

export async function registerClient(url: string, clientName: string, redirectUri: string) {
  const response = await fetch(`${url}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: clientName, redirect_uris: [redirectUri] }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

export async function rpc(url: string, accessToken: string, method: string, params: Record<string, unknown> = {}, id = 1) {
  const response = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, any> };
}

export interface ConnectedClient {
  clientId: string;
  consentHtml: string;
  accessToken: string;
  refreshToken: string;
}

/**
 * The whole flow for one signed-in person. `fields` are the consent form's own
 * (name, device, access, companion); `initialize: false` stops before the first
 * MCP request, which leaves the connection awaiting its client.
 */
export async function connectOAuth(
  url: string,
  cookies: Jar,
  options: {
    clientName: string;
    callback: string;
    state: string;
    fields: Record<string, string>;
    initialize?: boolean;
  },
): Promise<ConnectedClient> {
  const clientId = await registerClient(url, options.clientName, options.callback);
  const params = authorizeParams(url, clientId, options.callback, options.state);
  const page = await fetch(`${url}/oauth/authorize?${new URLSearchParams(params)}`, { headers: cookies.header() });
  expect(page.status).toBe(200);
  const consentHtml = await page.text();
  const allowed = await postForm(url, cookies, '/oauth/authorize', { ...params, decision: 'allow', ...options.fields });
  expect(allowed.status).toBe(302);
  const location = allowed.headers.get('location')!;
  expect(location.startsWith(`${options.callback}?`)).toBe(true);
  const exchanged = await fetch(`${url}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: new URL(location).searchParams.get('code')!,
      redirect_uri: options.callback,
      code_verifier: verifier,
      resource: `${url}/mcp`,
    }),
  });
  expect(exchanged.status).toBe(200);
  const token = (await exchanged.json()) as { access_token: string; refresh_token: string };
  if (options.initialize !== false) {
    const init = await rpc(url, token.access_token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'connection-state-test', version: '1.0.0' },
    });
    expect(init.status).toBe(200);
  }
  return { clientId, consentHtml, accessToken: token.access_token, refreshToken: token.refresh_token };
}
