import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { appendCodexEntry, checkCodexEntry, removeCodexEntry } from '../../cli/src/codexConfig';
import { agentEnrollments, agentInstallations, projects, teams } from '../src/db/schema';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

/**
 * `stma connect`: the code is created where the human is already signed in and
 * pasted into a terminal by that human. No model handles it — the 2026-09-07
 * attempt that asked an agent to redeem a code was refused, correctly.
 *
 * What the server owes that flow: a short life for the code, a way to say whose
 * workspace it joins *before* it is spent, and confirmation by the real client's
 * initialize — without loosening the legacy model-run installer, which keeps
 * its explicit whoami.
 */

let srv: StartedServer;
let dataDir: string;
let cookie = '';
let projectId = '';

const form = (pathname: string, body: Record<string, string>, jar = cookie) =>
  fetch(srv.url + pathname, {
    method: 'POST',
    headers: { cookie: jar, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });
const json = (pathname: string, body: unknown, token?: string) =>
  fetch(srv.url + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const initialize = (token: string) =>
  fetch(srv.url + '/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-code', version: 'test' } },
    }),
  });
const codeIn = (html: string) => /stma_enroll_[a-f0-9]{40}/.exec(html)?.[0];

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-terminal-connect-'));
  srv = await startServer(
    loadEnv({ host: '127.0.0.1', port: 0, nodeEnv: 'test', devMode: true, databaseUrl: undefined, pgliteDir: dataDir }),
  );
  const login = await form('/auth/dev', { username: 'terminal-lead' }, '');
  cookie = login.headers.getSetCookie().map((item) => item.split(';')[0]).join('; ');
  expect((await form('/app/teams', { name: 'Terminal Lab' })).status).toBe(302);
  const [team] = await srv.db.select().from(teams).where(eq(teams.slug, 'terminal-lab'));
  const [project] = await srv.db
    .insert(projects)
    .values({ teamId: team!.id, name: 'parcel-desk', slug: 'parcel-desk', repositoryIdentity: 'github.com/example/parcel-desk' })
    .returning();
  projectId = project!.id;
});

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

let code = '';

it('offers the command first, and issues a ten-minute code as a terminal command, not a prompt', async () => {
  const pageHtml = await (await fetch(srv.url + '/app/tokens', { headers: { cookie } })).text();
  expect(pageHtml).toContain('Fastest · one terminal command');
  expect(pageHtml.indexOf('Fastest · one terminal command')).toBeLessThan(pageHtml.indexOf('Any client · OAuth'));

  const issued = await form('/app/tokens', {
    mode: 'terminal', name: 'claude-b1', device: 'windows-desktop', client: 'claude-code', access: `project:${projectId}`,
  });
  const html = await issued.text();
  code = codeIn(html)!;
  expect(code).toBeTruthy();
  expect(html).toContain(`npx -y @matteai/stma connect ${code} --server ${srv.url}`);
  expect(html).toContain('not paste it into the agent');
  // Not the legacy model-run envelope.
  expect(html).not.toContain('Setup prompt ready');
  const [row] = await srv.db.select().from(agentEnrollments).where(eq(agentEnrollments.name, 'claude-b1'));
  const minutes = (row!.expiresAt.getTime() - row!.createdAt.getTime()) / 60_000;
  expect(minutes).toBeGreaterThan(9);
  expect(minutes).toBeLessThan(11);
});

it('refuses a command wider than one project, because the hooks belong to one checkout', async () => {
  const [team] = await srv.db.select().from(teams).where(eq(teams.slug, 'terminal-lab'));
  const refused = await form('/app/tokens', {
    mode: 'terminal', name: 'claude-wide', device: 'windows-desktop', client: 'claude-code', access: `team:${team!.id}`,
  });
  expect(refused.status).toBe(302);
  expect(decodeURIComponent(refused.headers.get('location') ?? '')).toContain('one project');
});

it('says whose workspace a code joins without spending it', async () => {
  for (let i = 0; i < 2; i++) {
    const preview = await json('/api/agent-enrollments/preview', { code });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      endpoint: `${srv.url}/mcp`,
      agent: 'claude-b1',
      device: 'windows-desktop',
      clientType: 'claude-code',
      scope: 'project',
      owner: 'terminal-lead',
      team: { slug: 'terminal-lab' },
      project: { name: 'parcel-desk' },
    });
  }
  expect((await json('/api/agent-enrollments/preview', { code: `stma_enroll_${'0'.repeat(40)}` })).status).toBe(404);
  expect((await json('/api/agent-enrollments/preview', { code: 'nonsense' })).status).toBe(404);
});

it('confirms a terminal connection when the real client initializes, and shares it with the hooks', async () => {
  const redeemed: any = await (await json('/api/agent-enrollments/redeem', { code, protocolVersion: 2, via: 'terminal' })).json();
  expect(redeemed.token).toMatch(/^stma_[a-f0-9]{40}$/);
  // One use: the preview and a second redemption both say so.
  expect((await json('/api/agent-enrollments/preview', { code })).status).toBe(404);
  expect((await json('/api/agent-enrollments/redeem', { code, protocolVersion: 2, via: 'terminal' })).status).toBe(404);

  const [installation] = await srv.db
    .select()
    .from(agentInstallations)
    .where(eq(agentInstallations.id, redeemed.installation.id));
  expect(installation!.capabilities).toContain('terminal-connect');

  // Until the client loads the entry, the hook's routes stay closed.
  const before = await fetch(srv.url + '/api/agent/news', { headers: { authorization: `Bearer ${redeemed.token}` } });
  expect(before.status).toBe(403);
  expect((await initialize(redeemed.token)).status).toBe(200);
  const after = await fetch(srv.url + '/api/agent/news', { headers: { authorization: `Bearer ${redeemed.token}` } });
  expect(after.status).toBe(200);
  const identity: any = await (
    await fetch(srv.url + '/api/agent/identity', { headers: { authorization: `Bearer ${redeemed.token}` } })
  ).json();
  expect(JSON.stringify(identity)).toContain(redeemed.installation.id);
});

it('leaves the legacy model-run installer on its explicit whoami', async () => {
  const issued = await form('/app/tokens', {
    name: 'claude-legacy', device: 'mac', client: 'claude-code', access: `project:${projectId}`,
  });
  const legacyCode = codeIn(await issued.text())!;
  const redeemed: any = await (await json('/api/agent-enrollments/redeem', { code: legacyCode, protocolVersion: 2 })).json();
  expect((await initialize(redeemed.token)).status).toBe(200);
  const still = await fetch(srv.url + '/api/agent/news', { headers: { authorization: `Bearer ${redeemed.token}` } });
  expect(still.status).toBe(403);
});

it('issues a Codex command too, and refuses a client the command cannot configure', async () => {
  const codex = await form('/app/tokens', {
    mode: 'terminal', name: 'codex-b2', device: 'windows-desktop', client: 'codex', access: `project:${projectId}`,
  });
  const html = await codex.text();
  expect(codeIn(html)).toBeTruthy();
  expect(html).toContain('restart');
  expect(html).toContain('Codex');
  const preview: any = await (await json('/api/agent-enrollments/preview', { code: codeIn(html) })).json();
  expect(preview.clientType).toBe('codex');

  const cursor = await form('/app/tokens', {
    mode: 'terminal', name: 'cursor-x', device: 'windows-desktop', client: 'cursor', access: `project:${projectId}`,
  });
  expect(cursor.status).toBe(302);
  expect(decodeURIComponent(cursor.headers.get('location') ?? '')).toContain('Claude Code and Codex');
});

it("appends a Codex entry without touching a byte of the owner's config, and removes only its own", () => {
  const endpoint = 'https://stma.example/mcp';
  const token = `stma_${'a'.repeat(40)}`;
  const existing = [
    '# my settings',
    'model = "gpt-5"',
    '',
    '[mcp_servers.docs]   # keep me',
    'command = "npx"',
    'args = ["-y", "docs-mcp"]',
    '',
  ].join('\n');
  const next = appendCodexEntry(existing, 'stma-parcel-desk-1a2b', endpoint, token);
  expect(next.startsWith(existing)).toBe(true);
  expect(next).toContain('[mcp_servers.stma-parcel-desk-1a2b]');
  expect(next).toContain(`http_headers = { Authorization = "Bearer ${token}" }`);
  // An empty or missing file is a valid start.
  expect(appendCodexEntry('', 'stma-a-0000', endpoint, token)).toContain('url = "https://stma.example/mcp"');

  // Same name, and the same server under another name: Codex loads this file
  // in every checkout, so a second entry is two identities in one session.
  expect(() => checkCodexEntry(next, 'stma-parcel-desk-1a2b', endpoint)).toThrow(/already has an MCP entry/);
  expect(() => checkCodexEntry(next, 'stma-other-9999', endpoint)).toThrow(/two STMA identities/);
  expect(() => checkCodexEntry(next, 'stma-other-9999', 'https://elsewhere.example/mcp')).not.toThrow();
  // Broken TOML is the owner's to fix, never ours to overwrite.
  expect(() => appendCodexEntry('[mcp_servers', 'stma-a-0000', endpoint, token)).toThrow(/could not be parsed/);
  expect(() => appendCodexEntry(existing, 'stma-a-0000', endpoint, 'not-a-token')).toThrow(/Invalid credential/);

  expect(removeCodexEntry(next, 'stma-parcel-desk-1a2b')).toBe(existing);
  expect(removeCodexEntry(next, 'docs')).toBe(next);
});
