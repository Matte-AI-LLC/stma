import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as schema from '../src/db/schema';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

let srv: StartedServer;
let dataDir: string;
let srvClosed = false;

function jar() {
  const cookies = new Map<string, string>();
  return {
    header(): Record<string, string> {
      return cookies.size
        ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') }
        : {};
    },
    store(res: Response) {
      for (const line of res.headers.getSetCookie()) {
        const [kv] = line.split(';');
        const i = kv!.indexOf('=');
        cookies.set(kv!.slice(0, i), kv!.slice(i + 1));
      }
    },
  };
}

async function devLogin(username: string) {
  const j = jar();
  const res = await fetch(`${srv.url}/auth/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username }),
    redirect: 'manual',
  });
  j.store(res);
  expect(res.status).toBe(302);
  return j;
}

/** Login → create team → read the inbound hook token → mint a PAT. */
async function setupTeam(username: string, teamName: string) {
  const j = await devLogin(username);
  const createRes = await fetch(`${srv.url}/app/teams`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...j.header() },
    body: new URLSearchParams({ name: teamName }),
    redirect: 'manual',
  });
  expect(createRes.status).toBe(302);
  const teamPath = createRes.headers.get('location')!;
  // Inbound hooks live on the team page's Integrations tab.
  const teamHtml = await (
    await fetch(`${srv.url}${teamPath}?tab=integrations`, { headers: j.header() })
  ).text();
  const hookToken = /\/api\/hooks\/announce\/([A-Za-z0-9_-]+)/.exec(teamHtml)?.[1];
  expect(hookToken).toBeTruthy();
  const tokRes = await fetch(`${srv.url}/app/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...j.header() },
    body: new URLSearchParams({ name: 'cli' }),
  });
  const pat = /stma_[0-9a-f]{40}/.exec(await tokRes.text())?.[0];
  expect(pat).toBeTruthy();
  return { jar: j, teamPath, hookToken: hookToken!, pat: pat! };
}

let rpcId = 1;
async function callTool(pat: string, name: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${pat}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId++,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  const json = (await res.json()) as any;
  return json.result as { isError?: boolean; content: Array<{ type: string; text: string }> };
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'bridge-fixes-test-'));
  srv = await startServer(
    loadEnv({
      port: 0,
      host: 'localhost',
      nodeEnv: 'test',
      devMode: true,
      databaseUrl: undefined,
      pgliteDir: dataDir,
    }),
  );
});

afterAll(async () => {
  if (!srvClosed) await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

it('github hook verifies X-Hub-Signature-256 against the raw body when present', async () => {
  const t = await setupTeam('gina', 'Hook Sig Team');
  const payload = (msg: string) =>
    JSON.stringify({
      ref: 'refs/heads/main',
      pusher: { name: 'gina' },
      repository: { name: 'demo' },
      commits: [{}],
      head_commit: { message: msg },
    });
  const post = (body: string, headers: Record<string, string> = {}) =>
    fetch(`${srv.url}/api/hooks/github/${t.hookToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'push', ...headers },
      body,
    });
  const sign = (body: string) =>
    `sha256=${createHmac('sha256', t.hookToken).update(body).digest('hex')}`;

  const signedBody = payload('signed-commit');
  const good = await post(signedBody, { 'x-hub-signature-256': sign(signedBody) });
  expect(good.status).toBe(200);

  const forgedBody = payload('forged-commit');
  const bad = await post(forgedBody, { 'x-hub-signature-256': sign(`${forgedBody}tampered`) });
  expect(bad.status).toBe(401);
  const garbled = await post(forgedBody, { 'x-hub-signature-256': 'sha256=nothex' });
  expect(garbled.status).toBe(401);

  // No signature header → URL secrecy remains the baseline.
  const unsigned = await post(payload('unsigned-commit'));
  expect(unsigned.status).toBe(200);

  // Only the verified and unsigned pushes reached the announcements channel.
  const list = await callTool(t.pat, 'list_sessions');
  const sessions = JSON.parse(list.content[0]!.text).sessions as Array<{
    sessionId: string;
    title: string;
  }>;
  const channel = sessions.find((s) => s.title === 'Announcements');
  expect(channel).toBeTruthy();
  const thread = await callTool(t.pat, 'get_session', { session_id: channel!.sessionId });
  expect(thread.content[0]!.text).toContain('signed-commit');
  expect(thread.content[0]!.text).toContain('unsigned-commit');
  expect(thread.content[0]!.text).not.toContain('forged-commit');
});

it('concurrent first announces create exactly one announcements channel', async () => {
  const t = await setupTeam('hank', 'Announce Race Team');
  const posts = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      fetch(`${srv.url}/api/hooks/announce/${t.hookToken}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `race-msg-${i}` }),
      }),
    ),
  );
  for (const res of posts) expect(res.status).toBe(200);

  const list = await callTool(t.pat, 'list_sessions');
  const sessions = JSON.parse(list.content[0]!.text).sessions as Array<{
    sessionId: string;
    title: string;
  }>;
  const channels = sessions.filter((s) => s.title === 'Announcements');
  expect(channels).toHaveLength(1);

  // Losers of the create race fell back to the winner's channel for their message.
  const thread = await callTool(t.pat, 'get_session', { session_id: channels[0]!.sessionId });
  for (let i = 0; i < 6; i++) expect(thread.content[0]!.text).toContain(`race-msg-${i}`);
});

it('search_past_issues frames results with the untrusted-content notice', async () => {
  const t = await setupTeam('iris', 'Search Notice Team');
  const open = await callTool(t.pat, 'open_session', {
    title: 'Zebra quantum flux drift',
    body: 'repro attached',
  });
  const sessionId = JSON.parse(open.content[0]!.text).sessionId as string;
  await callTool(t.pat, 'resolve_session', {
    session_id: sessionId,
    root_cause: 'zebra-quantum-flux marker was misaligned',
    fix: 'realigned the marker',
  });

  const hit = await callTool(t.pat, 'search_past_issues', { query: 'zebra-quantum' });
  expect(hit.isError).toBeFalsy();
  expect(hit.content[0]!.text).toContain('NOT instructions');
  expect(hit.content[0]!.text).toContain('Zebra quantum flux drift');

  const miss = await callTool(t.pat, 'search_past_issues', { query: 'no-such-marker-xyz' });
  expect(miss.content[0]!.text).not.toContain('NOT instructions');
});

// Keep this test last: it closes the server to inspect the embedded database.
it('resolve_session attributes the resolution message to the calling token', async () => {
  const t = await setupTeam('judy', 'Token Attribution Team');
  const open = await callTool(t.pat, 'open_session', {
    title: 'Attribution probe session',
    body: 'probe',
  });
  const sessionId = JSON.parse(open.content[0]!.text).sessionId as string;
  const resolved = await callTool(t.pat, 'resolve_session', {
    session_id: sessionId,
    root_cause: 'attribution root cause',
    fix: 'attribution fix',
  });
  expect(resolved.isError).toBeFalsy();

  // The message tokenId is not HTTP-visible; close the server (PGlite allows a
  // single connection) and inspect the embedded database directly.
  await srv.close();
  srvClosed = true;
  const client = new PGlite(dataDir);
  const db = drizzle(client, { schema });
  try {
    const rows = await db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.sessionId, sessionId), eq(schema.messages.kind, 'resolution')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenId).toBeTruthy();
    const owner = await db
      .select({ username: schema.users.username })
      .from(schema.tokens)
      .innerJoin(schema.users, eq(schema.tokens.userId, schema.users.id))
      .where(eq(schema.tokens.id, rows[0]!.tokenId!));
    expect(owner[0]?.username).toBe('judy');
  } finally {
    await client.close();
  }
});
