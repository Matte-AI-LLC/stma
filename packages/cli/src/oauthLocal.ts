import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteJson, acquireFileLock, normalizeProfileId } from './adapters.js';

/**
 * `stma connect` stores the same bearer the MCP client was given, so the
 * checkout's hooks and its agent are one installation. No refresh grant exists
 * for it: it lives until revoked.
 */
const STATIC_CLIENT = 'terminal-connect';

type SavedOAuth = {
  server: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

const identifier = (value: string) => normalizeProfileId(value);
const baseDirectory = (home: string) => path.join(home, '.stma', 'oauth');
const credentialPath = (id: string, home: string) => path.join(baseDirectory(home), `${identifier(id)}.json`);

// Windows does not expose a trustworthy POSIX mode/uid check through Node's
// stat API. DPAPI binds the stored credential to this Windows user instead.
//
// Both scripts are .NET and language constructs only — no Add-Type, no
// ConvertFrom-Json — for the reason windowsAcl.ts gives: a restrictive execution
// policy can block the module autoloading a cmdlet needs. That is also what lets
// them run WITHOUT `-ExecutionPolicy Bypass`. The flag was never needed for an
// inline -Command, and it is what malware passes: in the first two-device round
// (2026-09-20) Kaspersky System Watcher killed `adapter disconnect` on Windows as
// PDM:Trojan.Win32.Generic — node from the npx cache spawning a hidden PowerShell
// with Bypass to unprotect a secret — before it had revoked anything.
// Two lines on stdin, both base64 so neither can contain a newline: the entropy
// (the credential id) and the data. Base64 out, so console encoding cannot touch it.
const dpapiScript = (operation: 'Protect' | 'Unprotect') => `$ErrorActionPreference = 'Stop'
[void][Reflection.Assembly]::LoadWithPartialName('System.Security')
$entropy = [Convert]::FromBase64String([Console]::In.ReadLine())
$data = [Convert]::FromBase64String([Console]::In.ReadLine())
[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${operation}($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)))`;

function windowsUserData(operation: 'Protect' | 'Unprotect', id: string, data: Buffer): Buffer {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', dpapiScript(operation)], {
    input: `${Buffer.from(id, 'utf8').toString('base64')}\n${data.toString('base64')}\n`,
    encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 65_536,
  });
  if (result.error || result.status !== 0 || !result.stdout) {
    // PowerShell diagnostics may include input data; never include them here.
    throw new Error('Windows user-scope credential protection failed. No credential was exposed.');
  }
  return Buffer.from(result.stdout.trim(), 'base64');
}

function privateDirectory(home: string): void {
  for (const directory of [path.join(home, '.stma'), baseDirectory(home)]) {
    mkdirSync(directory, { mode: 0o700, recursive: true });
    const stat = lstatSync(directory);
    if (process.platform === 'win32') {
      if (!stat.isDirectory()) throw new Error(`OAuth credential directory is not a regular directory: ${directory}`);
      continue;
    }
    // Existing CLI installations may have created ~/.stma as 0755. The
    // credential-bearing oauth child must be 0700; the parent must be owned
    // by this user and not writable by anybody else.
    const unsafeMode = directory === baseDirectory(home) ? (stat.mode & 0o077) : (stat.mode & 0o022);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || unsafeMode) {
      throw new Error(`OAuth credential directory is not private: ${directory}`);
    }
  }
}

function readCredential(id: string, home: string): SavedOAuth {
  privateDirectory(home);
  const file = credentialPath(id, home);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (process.platform !== 'win32' &&
      (stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.nlink !== 1)) || stat.size > 8192) {
      throw new Error('OAuth credential file must be a small, private regular file.');
    }
    const stored = JSON.parse(readFileSync(fd, 'utf8')) as SavedOAuth | { format: string; protected: string };
    const data = process.platform === 'win32' ? (() => {
      if (!('format' in stored) || stored.format !== 'dpapi-current-user-v1' ||
        typeof stored.protected !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(stored.protected)) {
        throw new Error('OAuth credential file is not protected for this Windows user.');
      }
      return JSON.parse(windowsUserData('Unprotect', identifier(id), Buffer.from(stored.protected, 'base64')).toString('utf8')) as SavedOAuth;
    })() : stored as SavedOAuth;
    if (data?.clientId === STATIC_CLIENT && /^stma_[a-f0-9]{40}$/.test(data.accessToken) && data.refreshToken === '') return data;
    if (!data || !/^stma_client_[a-f0-9]{48}$/.test(data.clientId) ||
      !/^stma_[a-f0-9]{40}$/.test(data.accessToken) ||
      !/^stma_refresh_[a-f0-9]{64}$/.test(data.refreshToken) ||
      !Number.isFinite(data.expiresAt)) throw new Error('OAuth credential file is invalid.');
    return data;
  } finally {
    closeSync(fd);
  }
}

export function saveCredential(id: string, home: string, data: SavedOAuth): void {
  privateDirectory(home);
  const stored = process.platform === 'win32'
    ? { format: 'dpapi-current-user-v1', protected: windowsUserData('Protect', identifier(id), Buffer.from(JSON.stringify(data), 'utf8')).toString('base64') }
    : data;
  atomicWriteJson(credentialPath(id, home), stored);
}

function serverUrl(raw: string): string {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('STMA origin must be HTTPS, or HTTP loopback for local development.');
  }
  return url.origin;
}

async function jsonRequest(url: string, init: RequestInit): Promise<any> {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`STMA OAuth request failed (HTTP ${response.status}).`);
  return body;
}

export function browserLaunch(platform: NodeJS.Platform, url: string): { command: string; args: string[] } {
  // Do not pass an OAuth URL containing '&' through cmd.exe's command parser.
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return { command, args };
}

function openBrowser(url: string): void {
  const { command, args } = browserLaunch(process.platform, url);
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}

/** Browser approval creates a dedicated, revocable local adapter installation. */
export async function authorizeLocalAdapter(options: {
  server: string; id: string; target: 'claude-code' | 'codex';
  expectedTeam: string; expectedProject: string; home?: string;
}): Promise<{ server: string; id: string; identity: any }> {
  const server = serverUrl(options.server);
  const id = identifier(options.id);
  const home = options.home ?? os.homedir();
  privateDirectory(home);
  if (existsSync(credentialPath(id, home))) throw new Error('A local OAuth credential already exists for this checkout. Inspect or revoke it before a new activation.');
  const callbackServer = createServer();
  await new Promise<void>((resolve, reject) => {
    callbackServer.once('error', reject);
    callbackServer.listen(0, '127.0.0.1', () => resolve());
  });
  try {
    const address = callbackServer.address();
    if (!address || typeof address === 'string') throw new Error('Could not start OAuth loopback callback.');
    const redirectUri = `http://127.0.0.1:${address.port}/callback`;
    const client = await jsonRequest(`${server}/oauth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: `STMA local adapter (${options.target})`, redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
    });
    if (!/^stma_client_[a-f0-9]{48}$/.test(client.client_id)) throw new Error('OAuth registration response is invalid.');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(24).toString('hex');
    const resource = `${server}/mcp`;
    const authorization = new URL(`${server}/oauth/authorize`);
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: client.client_id,
      redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state,
      scope: 'stma offline_access', resource })) authorization.searchParams.set(key, value);
    const callback = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('OAuth approval timed out. No local adapter was installed.')), 300_000);
      callbackServer.on('request', (request, response) => {
        const requestUrl = new URL(request.url ?? '/', redirectUri);
        if (requestUrl.pathname !== '/callback' || request.headers.host !== `127.0.0.1:${address.port}`) {
          response.writeHead(404).end(); return;
        }
        const valid = requestUrl.searchParams.get('state') === state;
        const receivedCode = requestUrl.searchParams.get('code');
        const denied = requestUrl.searchParams.get('error');
        response.writeHead(valid && receivedCode ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        response.end(valid && receivedCode ? 'STMA approval received. Return to your terminal.' : 'Invalid STMA authorization callback.');
        if (valid && receivedCode) { clearTimeout(timer); resolve(receivedCode); }
        else if (valid && denied) { clearTimeout(timer); reject(new Error('STMA browser approval was declined.')); }
      });
    });
    console.log(`Review and approve the local adapter connection in your browser: ${server}`);
    openBrowser(authorization.toString());
    console.log(`If your browser does not open, visit: ${authorization.toString()}`);
    const code = await callback;
    const token = await jsonRequest(`${server}/oauth/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id,
        redirect_uri: redirectUri, code, code_verifier: verifier, resource }),
    });
    const credential: SavedOAuth = { server, clientId: client.client_id, accessToken: token.access_token,
      refreshToken: token.refresh_token, expiresAt: Date.now() + Number(token.expires_in) * 1000 };
    if (!/^stma_[a-f0-9]{40}$/.test(credential.accessToken) || !/^stma_refresh_[a-f0-9]{64}$/.test(credential.refreshToken)) {
      throw new Error('OAuth token response is invalid.');
    }
    // Confirm server-enforced identity before retaining the credential.
    try {
      const identity = await jsonRequest(`${server}/api/agent/identity`, {
        headers: { authorization: `Bearer ${credential.accessToken}` },
      });
      if (!identity?.credential?.installationId ||
        typeof identity.credential.installationName !== 'string' || !identity.credential.installationName.trim() ||
        identity.credential.scope !== 'project' ||
        identity.credential.team !== options.expectedTeam ||
        identity.credential.project !== options.expectedProject) {
        throw new Error('Browser-approved access differs from the requested project.');
      }
      saveCredential(id, home, credential);
      return { server, id, identity };
    } catch (error) {
      const revoked = await fetch(`${server}/oauth/revoke`, { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: credential.refreshToken, client_id: credential.clientId }),
        signal: AbortSignal.timeout(5_000) }).then((response) => response.ok).catch(() => false);
      throw new Error(`Local OAuth setup failed: ${error instanceof Error ? error.message : String(error)}. New credential cleanup: ${revoked ? 'revoked' : 'unconfirmed; revoke it in STMA Agent connections'}.`);
    }
  } finally {
    callbackServer.close();
  }
}

export async function localOAuthConnection(id: string, expectedServer?: string, home = os.homedir()): Promise<{ server: string; token: string }> {
  const current = readCredential(id, home);
  const server = serverUrl(current.server);
  if (expectedServer && serverUrl(expectedServer) !== server) throw new Error('OAuth server override mismatch.');
  if (current.clientId === STATIC_CLIENT) return { server, token: current.accessToken };
  if (current.expiresAt > Date.now() + 60_000) return { server, token: current.accessToken };
  const lock = credentialPath(id, home) + '.lock';
  const release = acquireFileLock(lock, 10_000);
  if (!release) throw new Error('OAuth refresh is already in progress.');
  try {
    const latest = readCredential(id, home);
    if (latest.expiresAt > Date.now() + 60_000) return { server, token: latest.accessToken };
    const token = await jsonRequest(`${server}/oauth/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: latest.clientId,
        refresh_token: latest.refreshToken, resource: `${server}/mcp` }),
    });
    const updated: SavedOAuth = { ...latest, accessToken: token.access_token,
      refreshToken: token.refresh_token, expiresAt: Date.now() + Number(token.expires_in) * 1000 };
    if (!/^stma_[a-f0-9]{40}$/.test(updated.accessToken) || !/^stma_refresh_[a-f0-9]{64}$/.test(updated.refreshToken)) {
      throw new Error('OAuth refresh response is invalid.');
    }
    saveCredential(id, home, updated);
    return { server, token: updated.accessToken };
  } finally { release(); }
}

/** The bearer `stma connect` redeemed, kept private for this checkout's hooks. */
export function saveTerminalCredential(id: string, server: string, token: string, home = os.homedir()): void {
  saveCredential(id, home, { server: serverUrl(server), clientId: STATIC_CLIENT, accessToken: token,
    refreshToken: '', expiresAt: Number.MAX_SAFE_INTEGER });
}

/**
 * Revoke the shared installation through its own bearer, then forget it.
 * `reason` is what the server records: the same route serves a failed setup and
 * a person disconnecting on purpose, and saying which is why the operator's log
 * stopped reporting an installer failure every time somebody tidied up.
 */
export async function revokeTerminalCredential(
  id: string,
  home = os.homedir(),
  reason: 'setup_failed' | 'disconnected' = 'disconnected',
): Promise<boolean> {
  const current = readCredential(id, home);
  try {
    const response = await fetch(`${serverUrl(current.server)}/api/agent-enrollments/self-revoke`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
      headers: { authorization: `Bearer ${current.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    if (!response.ok && response.status !== 401) return false;
    unlinkSync(credentialPath(id, home));
    return true;
  } catch { return false; }
}

export const isTerminalCredential = (id: string, home = os.homedir()): boolean => {
  try { return readCredential(id, home).clientId === STATIC_CLIENT; } catch { return false; }
};

/**
 * Hands the adapter's refresh grant back. Used when setup fails after the
 * browser minted the credential, and again by `adapter disconnect`. This is the
 * OAuth revocation endpoint, which logs a neutral `token_revoked` either way,
 * so unlike the terminal path it never needed a reason to stop misreporting.
 */
export async function revokeLocalAdapterCredential(id: string, home = os.homedir()): Promise<boolean> {
  const current = readCredential(id, home);
  try {
    const response = await fetch(`${serverUrl(current.server)}/oauth/revoke`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: current.refreshToken, client_id: current.clientId }),
    });
    if (!response.ok) return false;
    unlinkSync(credentialPath(id, home));
    return true;
  } catch { return false; }
}
