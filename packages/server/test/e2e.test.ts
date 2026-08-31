import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

let srv: StartedServer;
let dataDir: string;
let hookSrv: Server;
let hookPort: number;
const hookPayloads: string[] = [];

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
  expect(res.headers.get('location')).toBe('/app');
  return j;
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'bridge-test-'));
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
  hookSrv = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      hookPayloads.push(body);
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => hookSrv.listen(0, '127.0.0.1', resolve));
  hookPort = (hookSrv.address() as AddressInfo).port;
});

afterAll(async () => {
  await srv?.close();
  await new Promise<void>((resolve) => hookSrv?.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

it('serves landing page and health check', async () => {
  const home = await fetch(`${srv.url}/`);
  expect(home.status).toBe(200);
  expect(await home.text()).toContain('agent');

  const health = await fetch(`${srv.url}/health`);
  expect(health.status).toBe(200);
  // `version` rides along so a client can tell an old server from a broken one
  // without a second round trip (see test/layers.test.ts).
  expect(await health.json()).toEqual({ ok: true, version: expect.any(String) });

  const docs = await fetch(`${srv.url}/docs`);
  expect(docs.status).toBe(200);
  const docsHtml = await docs.text();
  expect(docsHtml).toContain('How to use STMA');
  expect(docsHtml).toContain('compare_env');
  expect(docsHtml).toContain('/api/invites/redeem');
  expect(docsHtml).toContain('Paste-ready prompts');
  expect(docsHtml).toContain('Sort it out between your two agents');
  // Anonymous visitors get the marketing shell (the page is public and shareable).
  expect(docsHtml).toContain('site-head');
  expect(docsHtml).not.toContain('class="appnav"');
});

it('runs the full flow: login → team → invite → join → token → MCP', async () => {
  const alice = await devLogin('alice');

  // Signed in, /docs keeps the application nav instead of dropping into the
  // marketing shell — otherwise navigating away from the guide is a dead end.
  const docsSignedIn = await fetch(`${srv.url}/docs`, { headers: alice.header() });
  const docsSignedInHtml = await docsSignedIn.text();
  // The chrome is the console rail now; what this asserts is unchanged —
  // navigation must still be on the page.
  expect(docsSignedInHtml).toContain('class="rail"');
  expect(docsSignedInHtml).toContain('href="/app/sessions"');
  expect(docsSignedInHtml).toContain('href="/app/agents"');
  expect(docsSignedInHtml).toContain('How to use STMA');
  expect(docsSignedInHtml).not.toContain('class="site-head"');

  // Alice creates a team
  const createRes = await fetch(`${srv.url}/app/teams`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...alice.header() },
    body: new URLSearchParams({ name: 'Acme Dev' }),
    redirect: 'manual',
  });
  expect(createRes.status).toBe(302);
  const teamPath = createRes.headers.get('location')!;
  expect(teamPath).toBe('/app/teams/acme-dev');

  const teamHtml = await (await fetch(srv.url + teamPath, { headers: alice.header() })).text();
  expect(teamHtml).toContain('alice');
  expect(teamHtml).toContain('owner');

  // Alice creates an invite link
  const invRes = await fetch(`${srv.url}${teamPath}/invites`, {
    method: 'POST',
    headers: alice.header(),
    redirect: 'manual',
  });
  expect(invRes.status).toBe(302);
  const teamHtml2 = await (
    await fetch(`${srv.url}${teamPath}?tab=people`, { headers: alice.header() })
  ).text();
  const code = /\/join\/([A-Za-z0-9_-]+)/.exec(teamHtml2)?.[1];
  expect(code).toBeTruthy();

  // Bob joins via the invite
  const bob = await devLogin('bob');
  const joinPage = await fetch(`${srv.url}/join/${code}`, { headers: bob.header() });
  expect(joinPage.status).toBe(200);
  expect(await joinPage.text()).toContain('Acme Dev');

  const joinRes = await fetch(`${srv.url}/join/${code}`, {
    method: 'POST',
    headers: bob.header(),
    redirect: 'manual',
  });
  expect(joinRes.status).toBe(302);
  const teamHtml3 = await (await fetch(srv.url + teamPath, { headers: bob.header() })).text();
  expect(teamHtml3).toContain('bob');

  // Alice creates a personal access token
  const tokRes = await fetch(`${srv.url}/app/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...alice.header() },
    body: new URLSearchParams({ name: 'cli' }),
  });
  expect(tokRes.status).toBe(200);
  const tokHtml = await tokRes.text();
  const token = /stma_[0-9a-f]{40}/.exec(tokHtml)?.[0];
  expect(token).toBeTruthy();

  // MCP: JSON-RPC over Streamable HTTP (stateless)
  const rpc = (body: unknown, tok: string = token!) =>
    fetch(`${srv.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tok}`,
      },
      body: JSON.stringify(body),
    });

  const initRes = await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'e2e-test', version: '0.0.0' },
    },
  });
  expect(initRes.status).toBe(200);
  const initJson = (await initRes.json()) as any;
  expect(initJson.result.serverInfo.name).toBe('stma');

  const whoRes = await rpc({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'whoami', arguments: {} },
  });
  expect(whoRes.status).toBe(200);
  const whoText = ((await whoRes.json()) as any).result.content[0].text as string;
  expect(whoText).toContain('alice');
  expect(whoText).toContain('acme-dev');

  const tmRes = await rpc({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'list_teammates', arguments: {} },
  });
  const tmText = ((await tmRes.json()) as any).result.content[0].text as string;
  expect(tmText).toContain('bob');
  expect(tmText).toContain('lastSnapshotAt');

  // Bad/revoked tokens are rejected
  const bad = await rpc(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'whoami', arguments: {} } },
    'stma_0000000000000000000000000000000000000000',
  );
  expect(bad.status).toBe(401);

  // Unauthenticated MCP request is rejected
  const noAuth = await fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' }),
  });
  expect(noAuth.status).toBe(401);

  // --- M2: snapshots & environment compare ---

  // Bob needs his own token
  const tokResB = await fetch(`${srv.url}/app/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...bob.header() },
    body: new URLSearchParams({ name: 'cli-bob' }),
  });
  const tokenB = /stma_[0-9a-f]{40}/.exec(await tokResB.text())?.[0];
  expect(tokenB).toBeTruthy();

  const baseSnap = {
    os: { platform: 'linux', arch: 'x64' },
    runtimes: { node: '24.1.0' },
    packageManagers: { npm: '11.0.0' },
    lockfiles: [{ path: 'package-lock.json', hash: 'aaa111' }],
    envVarNames: ['PATH', 'HOME'],
    git: { branch: 'main', sha: 'abc123', dirtyFiles: [] },
    timezone: 'Europe/Istanbul',
  };

  const checklistRes = await rpc({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: { name: 'get_snapshot_checklist', arguments: {} },
  });
  expect(((await checklistRes.json()) as any).result.content[0].text).toContain('push_snapshot');

  const pushA = await rpc({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: { name: 'push_snapshot', arguments: { repo: 'demo', snapshot: baseSnap } },
  });
  const pushAJson = (await pushA.json()) as any;
  expect(pushAJson.result.isError).toBeFalsy();
  expect(pushAJson.result.content[0].text).toContain('Snapshot stored');

  const pushB = await rpc(
    {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: {
        name: 'push_snapshot',
        arguments: {
          repo: 'demo',
          snapshot: {
            ...baseSnap,
            runtimes: { node: '20.11.0' },
            envVarNames: ['PATH', 'HOME', 'NVM_DIR'],
            lockfiles: [{ path: 'package-lock.json', hash: 'bbb222' }],
            git: { branch: 'feature-x', sha: 'def456', dirtyFiles: ['src/app.ts'] },
          },
        },
      },
    },
    tokenB!,
  );
  expect(((await pushB.json()) as any).result.isError).toBeFalsy();

  const getSnap = await rpc({
    jsonrpc: '2.0',
    id: 13,
    method: 'tools/call',
    params: { name: 'get_snapshot', arguments: { username: 'bob' } },
  });
  const getSnapText = ((await getSnap.json()) as any).result.content[0].text as string;
  expect(getSnapText).toContain('20.11.0');

  const cmpRes = await rpc({
    jsonrpc: '2.0',
    id: 14,
    method: 'tools/call',
    params: { name: 'compare_env', arguments: { teammate: 'bob' } },
  });
  const cmpJson = (await cmpRes.json()) as any;
  expect(cmpJson.result.isError).toBeFalsy();
  const cmp = JSON.parse(cmpJson.result.content[0].text as string);
  expect(cmp.identical).toBe(false);
  expect(cmp.totalDifferences).toBeGreaterThanOrEqual(4);
  const summary = (cmp.summary as string[]).join('\n');
  expect(summary).toContain('runtimes.node');
  expect(summary).toContain('NVM_DIR');
  expect(summary).toContain('git.branch');
  expect(summary).toContain('lockfiles.package-lock.json');

  // list_teammates now shows snapshot timestamps for both members
  const tmRes2 = await rpc({
    jsonrpc: '2.0',
    id: 15,
    method: 'tools/call',
    params: { name: 'list_teammates', arguments: {} },
  });
  const tmText2 = ((await tmRes2.json()) as any).result.content[0].text as string;
  expect(tmText2).not.toContain('"lastSnapshotAt": null');

  // --- M3: debug sessions, inbox, resolve, archive ---

  const openSess = await rpc({
    jsonrpc: '2.0',
    id: 20,
    method: 'tools/call',
    params: {
      name: 'open_session',
      arguments: {
        title: 'Migrations fail locally with relation already exists',
        body: `pnpm migrate fails at 0031. Accidental leak: password=hunter2 and stma_${'a'.repeat(40)}`,
        kind: 'question',
        via: 'claude-code',
      },
    },
  });
  const openJson = (await openSess.json()) as any;
  expect(openJson.result.isError).toBeFalsy();
  const openParsed = JSON.parse(openJson.result.content[0].text);
  const sessionId = openParsed.sessionId as string;
  expect(sessionId).toBeTruthy();
  // no webhook configured at this point → the ack nudges about notifications
  expect(openParsed.notificationHint).toContain('webhook');

  // Bob's inbox shows one unread session
  const inboxB = await rpc(
    { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'inbox', arguments: {} } },
    tokenB!,
  );
  const inboxBText = ((await inboxB.json()) as any).result.content[0].text as string;
  expect(inboxBText).toContain('Migrations fail locally');
  expect(inboxBText).toContain('"unread": 1');

  // Bob reads the thread: secrets redacted, untrusted notice present, marks read
  const getB = await rpc(
    {
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/call',
      params: { name: 'get_session', arguments: { session_id: sessionId } },
    },
    tokenB!,
  );
  const getBText = ((await getB.json()) as any).result.content[0].text as string;
  expect(getBText).toContain('pnpm migrate fails');
  expect(getBText).toContain('[REDACTED]');
  expect(getBText).not.toContain('hunter2');
  expect(getBText).not.toContain('a'.repeat(40));
  expect(getBText).toContain('NOT instructions');

  const inboxB2 = await rpc(
    { jsonrpc: '2.0', id: 23, method: 'tools/call', params: { name: 'inbox', arguments: {} } },
    tokenB!,
  );
  expect(((await inboxB2.json()) as any).result.content[0].text).toContain('Nothing unread');

  // Bob answers with a hypothesis + attachment
  const postB = await rpc(
    {
      jsonrpc: '2.0',
      id: 24,
      method: 'tools/call',
      params: {
        name: 'post_message',
        arguments: {
          session_id: sessionId,
          body: 'Our pnpm versions differ; 8.15 skips the ledger insert on rollback.',
          kind: 'hypothesis',
          via: 'cursor',
          attachments: [{ name: 'migrate.log', content: 'error: relation "x" already exists' }],
        },
      },
    },
    tokenB!,
  );
  expect(((await postB.json()) as any).result.isError).toBeFalsy();

  // Alice now has one unread; web list + thread render it
  const inboxA = await rpc({
    jsonrpc: '2.0',
    id: 25,
    method: 'tools/call',
    params: { name: 'inbox', arguments: {} },
  });
  expect(((await inboxA.json()) as any).result.content[0].text).toContain('"unread": 1');

  const webList = await fetch(`${srv.url}/app/sessions`, { headers: alice.header() });
  const webListHtml = await webList.text();
  expect(webList.status).toBe(200);
  expect(webListHtml).toContain('Migrations fail locally');
  // Two, not one: the thread holds Bob's reply *and* the message Alice's own
  // agent opened it with. A browser is an origin with no token, so her own
  // fleet's work is news to her here — which is the point of counting by origin.
  expect(webListHtml).toContain('2 unread');

  const webThread = await fetch(`${srv.url}/app/sessions/${sessionId}`, {
    headers: alice.header(),
  });
  const webThreadHtml = await webThread.text();
  expect(webThread.status).toBe(200);
  expect(webThreadHtml).toContain('pnpm versions differ');
  expect(webThreadHtml).toContain('migrate.log');

  // Alice resolves; the archive search finds it
  const resolveRes = await rpc({
    jsonrpc: '2.0',
    id: 26,
    method: 'tools/call',
    params: {
      name: 'resolve_session',
      arguments: {
        session_id: sessionId,
        root_cause: 'pnpm 8.15 skipped the migration ledger insert on rollback.',
        fix: 'Pin pnpm via the packageManager field; PR #482.',
      },
    },
  });
  expect(((await resolveRes.json()) as any).result.isError).toBeFalsy();

  const searchRes = await rpc({
    jsonrpc: '2.0',
    id: 27,
    method: 'tools/call',
    params: { name: 'search_past_issues', arguments: { query: 'ledger' } },
  });
  expect(((await searchRes.json()) as any).result.content[0].text).toContain(
    'Migrations fail locally',
  );

  // Web flow: create → teammate posts → resolve
  const createWeb = await fetch(`${srv.url}/app/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...alice.header() },
    body: new URLSearchParams({
      team: 'acme-dev',
      title: 'Web-opened session',
      body: 'hello from the web',
    }),
    redirect: 'manual',
  });
  expect(createWeb.status).toBe(302);
  const webSessPath = createWeb.headers.get('location')!;
  expect(webSessPath).toMatch(/^\/app\/sessions\//);

  const postWeb = await fetch(`${srv.url}${webSessPath}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...bob.header() },
    body: new URLSearchParams({ body: 'seen it, checking', kind: 'answer' }),
    redirect: 'manual',
  });
  expect(postWeb.status).toBe(302);

  const resolveWeb = await fetch(`${srv.url}${webSessPath}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...alice.header() },
    body: new URLSearchParams({ root_cause: 'was a stale cache', fix: 'cleared it' }),
    redirect: 'manual',
  });
  expect(resolveWeb.status).toBe(302);
  const webSessHtml = await (
    await fetch(srv.url + webSessPath, { headers: alice.header() })
  ).text();
  expect(webSessHtml).toContain('seen it, checking');
  expect(webSessHtml).toContain('was a stale cache');
  expect(webSessHtml).toContain('Resolved by alice');

  // --- M4: onboard, compare page, webhook, rate limit ---

  // onboard_repo generates rules files
  const onboardRes = await rpc({
    jsonrpc: '2.0',
    id: 30,
    method: 'tools/call',
    params: { name: 'onboard_repo', arguments: { repo: 'demo' } },
  });
  const onboardText = ((await onboardRes.json()) as any).result.content[0].text as string;
  expect(onboardText).toContain('.stma.json');
  expect(onboardText).toContain('.cursor/rules/stma.mdc');
  expect(onboardText).toContain('CLAUDE.md');
  expect(onboardText).toContain('acme-dev');
  expect(onboardText).toContain('inbox');

  // env compare web page (defaults: alice vs bob, both pushed snapshots in M2)
  const cmpPage = await fetch(`${srv.url}/app/teams/acme-dev/compare`, {
    headers: alice.header(),
  });
  const cmpPageHtml = await cmpPage.text();
  expect(cmpPage.status).toBe(200);
  expect(cmpPageHtml).toContain('Compare environments');
  expect(cmpPageHtml).toContain('node');
  expect(cmpPageHtml).toContain('NVM_DIR');
  expect(cmpPageHtml).toContain('differs');

  // team webhook: owner saves it, opening a session pings the receiver
  const setHook = await fetch(`${srv.url}/app/teams/acme-dev/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...alice.header() },
    body: new URLSearchParams({ webhook_url: `http://127.0.0.1:${hookPort}/hook` }),
    redirect: 'manual',
  });
  expect(setHook.status).toBe(302);

  const hookSess = await rpc({
    jsonrpc: '2.0',
    id: 31,
    method: 'tools/call',
    params: {
      name: 'open_session',
      arguments: { title: 'Webhook test session', via: 'claude-code' },
    },
  });
  expect(((await hookSess.json()) as any).result.isError).toBeFalsy();
  for (let i = 0; i < 20 && hookPayloads.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(hookPayloads.join('\n')).toContain('Webhook test session');

  // --- local accounts: signup → app, wrong password rejected, dev-login can't hijack ---

  const signupPage = await fetch(`${srv.url}/signup`);
  expect(signupPage.status).toBe(200);
  expect(await signupPage.text()).toContain('Create your STMA account');

  const carol = jar();
  const signupRes = await fetch(`${srv.url}/auth/local/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'carol@example.com', password: 'supersecret1' }),
    redirect: 'manual',
  });
  carol.store(signupRes);
  expect(signupRes.status).toBe(302);
  expect(signupRes.headers.get('location')).toBe('/app');
  const carolApp = await fetch(`${srv.url}/app`, { headers: carol.header() });
  expect(carolApp.status).toBe(200);
  expect(await carolApp.text()).toContain('carol');

  const badLogin = await fetch(`${srv.url}/auth/local/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'carol@example.com', password: 'wrong-password' }),
    redirect: 'manual',
  });
  expect(badLogin.status).toBe(302);
  expect(badLogin.headers.get('location')).toContain('error=');

  const goodLogin = await fetch(`${srv.url}/auth/local/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'carol@example.com', password: 'supersecret1' }),
    redirect: 'manual',
  });
  expect(goodLogin.status).toBe(302);
  expect(goodLogin.headers.get('location')).toBe('/app');

  const hijack = await fetch(`${srv.url}/auth/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'carol' }),
    redirect: 'manual',
  });
  expect(hijack.headers.get('location')).toContain('error=');

  // --- terminal invite flow: create_invite (MCP) → redeem → new agent online ---

  const cliInvRes = await rpc({
    jsonrpc: '2.0',
    id: 40,
    method: 'tools/call',
    params: { name: 'create_invite', arguments: { max_uses: 5 } },
  });
  const cliInvJson = (await cliInvRes.json()) as any;
  expect(cliInvJson.result.isError).toBeFalsy();
  const cliInv = JSON.parse(cliInvJson.result.content[0].text);
  expect(cliInv.code).toBeTruthy();
  expect(cliInv.teammateInstructions).toContain('/api/invites/redeem');

  const redeem = await fetch(`${srv.url}/api/invites/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: cliInv.code, email: 'dave@example.com', password: 'davepassword1' }),
  });
  expect(redeem.status).toBe(200);
  const redeemJson = (await redeem.json()) as any;
  expect(redeemJson.username).toBe('dave'); // display name derived from the email
  expect(redeemJson.email).toBe('dave@example.com');
  expect(redeemJson.token).toMatch(/^stma_[0-9a-f]{40}$/);
  expect(redeemJson.team.slug).toBe('acme-dev');

  const daveWho = await rpc(
    { jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'whoami', arguments: {} } },
    redeemJson.token,
  );
  const daveWhoText = ((await daveWho.json()) as any).result.content[0].text as string;
  expect(daveWhoText).toContain('dave');
  expect(daveWhoText).toContain('acme-dev');

  const badRedeem = await fetch(`${srv.url}/api/invites/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: cliInv.code, email: 'dave@example.com', password: 'wrongpassword' }),
  });
  expect(badRedeem.status).toBe(401);

  // --- DevOps wave: projects, announce, inbound hooks, loop guard ---

  const lpRes = await rpc({
    jsonrpc: '2.0',
    id: 50,
    method: 'tools/call',
    params: { name: 'list_projects', arguments: {} },
  });
  const lpText = ((await lpRes.json()) as any).result.content[0].text as string;
  expect(lpText).toContain('"demo"');
  expect(lpText).toContain('activeAgents7d');

  const annRes = await rpc({
    jsonrpc: '2.0',
    id: 51,
    method: 'tools/call',
    params: {
      name: 'announce',
      arguments: { body: 'Deployed staging build 42', repo: 'demo', via: 'claude-code' },
    },
  });
  const annJson = (await annRes.json()) as any;
  expect(annJson.result.isError).toBeFalsy();
  const channelId = JSON.parse(annJson.result.content[0].text).channelSessionId as string;
  expect(channelId).toBeTruthy();

  const inboxAfterAnn = await rpc(
    { jsonrpc: '2.0', id: 52, method: 'tools/call', params: { name: 'inbox', arguments: {} } },
    tokenB!,
  );
  expect(((await inboxAfterAnn.json()) as any).result.content[0].text).toContain('Announcements');

  const webList2 = await fetch(`${srv.url}/app/sessions`, { headers: alice.header() });
  expect(await webList2.text()).toContain('Announcements');

  const annResolve = await rpc({
    jsonrpc: '2.0',
    id: 53,
    method: 'tools/call',
    params: {
      name: 'resolve_session',
      arguments: { session_id: channelId, root_cause: 'nope', fix: 'nope' },
    },
  });
  expect(((await annResolve.json()) as any).result.isError).toBe(true);

  const teamHtml4 = await (
    await fetch(`${srv.url}/app/teams/acme-dev?tab=integrations`, { headers: alice.header() })
  ).text();
  const hookTok = /\/api\/hooks\/announce\/([A-Za-z0-9_-]+)/.exec(teamHtml4)?.[1];
  expect(hookTok).toBeTruthy();

  const hookPost = await fetch(`${srv.url}/api/hooks/announce/${hookTok}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'ci pipeline green', repo: 'demo' }),
  });
  expect(hookPost.status).toBe(200);

  const ghPost = await fetch(`${srv.url}/api/hooks/github/${hookTok}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': 'push' },
    body: JSON.stringify({
      ref: 'refs/heads/main',
      pusher: { name: 'alice' },
      repository: { name: 'demo' },
      commits: [{}, {}],
      head_commit: { message: 'feat: new thing\n\ndetails' },
    }),
  });
  expect(ghPost.status).toBe(200);

  const chan = await rpc({
    jsonrpc: '2.0',
    id: 54,
    method: 'tools/call',
    params: { name: 'get_session', arguments: { session_id: channelId } },
  });
  const chanText = ((await chan.json()) as any).result.content[0].text as string;
  expect(chanText).toContain('Deployed staging build 42');
  expect(chanText).toContain('ci pipeline green');
  expect(chanText).toContain('push to main');
  expect(chanText).toContain('2 commits');

  const lgOpen = await rpc({
    jsonrpc: '2.0',
    id: 55,
    method: 'tools/call',
    params: { name: 'open_session', arguments: { title: 'loop guard probe', repo: 'demo' } },
  });
  const lgId = JSON.parse(((await lgOpen.json()) as any).result.content[0].text)
    .sessionId as string;
  let guardTripped = false;
  for (let i = 0; i < 21; i++) {
    const r = await rpc({
      jsonrpc: '2.0',
      id: 100 + i,
      method: 'tools/call',
      params: {
        name: 'post_message',
        arguments: { session_id: lgId, body: `ping ${i}`, kind: 'note' },
      },
    });
    const j = (await r.json()) as any;
    if (j.result.isError) {
      guardTripped = true;
      expect(j.result.content[0].text).toContain('Loop guard');
      break;
    }
  }
  expect(guardTripped).toBe(true);

  // activity page renders the trail
  const actPage = await fetch(`${srv.url}/app/teams/acme-dev/activity`, {
    headers: alice.header(),
  });
  const actHtml = await actPage.text();
  expect(actPage.status).toBe(200);
  expect(actHtml).toContain('push_snapshot');
  expect(actHtml).toContain('announce');

  // --- Local control plane: agent identity, runs, conflicts, policy and env preflight ---

  const control = (endpoint: string, tok: string, body?: unknown) =>
    fetch(`${srv.url}${endpoint}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const agentARes = await control('/api/agent/installations/register', token!, {
    name: 'alice-claude',
    clientType: 'claude-code',
    clientVersion: 'test',
    deviceFingerprint: 'device-alice-0001',
    capabilities: ['wrapper'],
  });
  expect(agentARes.status).toBe(200);
  const agentA = ((await agentARes.json()) as any).installation;

  const agentBRes = await control('/api/agent/installations/register', tokenB!, {
    name: 'bob-codex',
    clientType: 'codex',
    clientVersion: 'test',
    deviceFingerprint: 'device-bob-000001',
    capabilities: ['wrapper'],
  });
  expect(agentBRes.status).toBe(200);
  const agentB = ((await agentBRes.json()) as any).installation;

  const publish = await control('/api/control/policies', token!, {
    team: 'acme-dev',
    project: 'demo',
    document: {
      guidance: ['Keep migrations backwards compatible.'],
      permissions: { deny: ['read secret values'], requireApproval: ['production changes'] },
      requiredChecks: ['npm test'],
      protectedPaths: ['db/migrations/**'],
      environment: { requiredEnvVarNames: ['PATH'], runtimes: { node: '24.1.0' } },
    },
  });
  expect(publish.status).toBe(200);

  const runARes = await control('/api/agent/runs/start', token!, {
    installationId: agentA.id,
    team: 'acme-dev',
    project: 'demo',
    taskKey: 'PAY-142',
    intent: 'Add refunds migration',
    repo: 'demo',
    branch: 'feat/refunds',
    baseSha: 'abc123',
    claims: [
      { resourceType: 'path', resourceKey: 'src/payments/**', access: 'write' },
      { resourceType: 'migration', resourceKey: 'payments-db', access: 'write' },
    ],
  });
  expect(runARes.status).toBe(200);
  const runAJson = (await runARes.json()) as any;
  expect(runAJson.conflicts).toEqual([]);
  expect(runAJson.policy.document.guidance).toContain('Keep migrations backwards compatible.');

  const runBRes = await control('/api/agent/runs/start', tokenB!, {
    installationId: agentB.id,
    team: 'acme-dev',
    project: 'demo',
    taskKey: 'PAY-143',
    intent: 'Change refunds contract',
    repo: 'demo',
    branch: 'feat/refund-contract',
    baseSha: 'abc123',
    claims: [
      { resourceType: 'path', resourceKey: 'src/payments/refund.ts', access: 'write' },
      { resourceType: 'migration', resourceKey: 'payments-db', access: 'write' },
      { resourceType: 'migration', resourceKey: 'payments-db', access: 'write' },
    ],
  });
  expect(runBRes.status).toBe(200);
  const runBJson = (await runBRes.json()) as any;
  expect(runBJson.conflicts.length).toBeGreaterThanOrEqual(2);
  expect(runBJson.conflicts[0].severity).toBe('critical');

  const activeRuns = await control('/api/agent/runs/active?team=acme-dev', token!);
  const activeJson = (await activeRuns.json()) as any;
  expect(activeJson.runs).toHaveLength(2);
  expect(JSON.stringify(activeJson)).toContain('alice-claude');
  expect(JSON.stringify(activeJson)).toContain('bob-codex');
  expect(activeJson.runs.find((run: any) => run.id === runBJson.run.id).claims).toHaveLength(2);

  const agentMap = await fetch(`${srv.url}/app/agents`, { headers: alice.header() });
  const agentMapHtml = await agentMap.text();
  expect(agentMap.status).toBe(200);
  expect(agentMapHtml).toContain('Live agent map');
  expect(agentMapHtml).toContain('alice-claude');
  expect(agentMapHtml).toContain('critical');

  const baseline = await control('/api/control/environment-baselines', token!, {
    team: 'acme-dev',
    project: 'demo',
    snapshot: baseSnap,
  });
  expect(baseline.status).toBe(200);

  const preflight = await control('/api/agent/environment/preflight', tokenB!, {
    team: 'acme-dev',
    project: 'demo',
    runId: runBJson.run.id,
    snapshot: {
      ...baseSnap,
      runtimes: { node: '20.11.0' },
      lockfiles: [{ path: 'package-lock.json', hash: 'different' }],
    },
  });
  const preflightJson = (await preflight.json()) as any;
  expect(preflightJson.status).toBe('critical');
  expect(preflightJson.differences.totalDifferences).toBeGreaterThanOrEqual(2);

  const policyReceipt = await control(
    `/api/agent/runs/${runBJson.run.id}/policy-receipt`,
    tokenB!,
    {
      expectedHash: runBJson.policy.hash,
      reportedHash: runBJson.policy.hash,
    },
  );
  expect(((await policyReceipt.json()) as any).receipt.drift).toBe(false);

  const forgedReceipt = await control(
    `/api/agent/runs/${runBJson.run.id}/policy-receipt`,
    tokenB!,
    {
      expectedHash: '0'.repeat(64),
      reportedHash: '0'.repeat(64),
    },
  );
  const forgedReceiptJson = (await forgedReceipt.json()) as any;
  expect(forgedReceiptJson.receipt.expectedHash).toBe(runBJson.policy.hash);
  expect(forgedReceiptJson.receipt.drift).toBe(true);

  const otherBaseline = await control('/api/control/environment-baselines', token!, {
    team: 'acme-dev',
    project: 'other-project',
    snapshot: baseSnap,
  });
  expect(otherBaseline.status).toBe(200);
  const crossProjectPreflight = await control('/api/agent/environment/preflight', tokenB!, {
    team: 'acme-dev',
    project: 'other-project',
    runId: runBJson.run.id,
    snapshot: baseSnap,
  });
  expect(crossProjectPreflight.status).toBe(400);
  expect(((await crossProjectPreflight.json()) as any).error).toContain('does not belong');

  for (const [runId, tok] of [
    [runAJson.run.id, token!],
    [runBJson.run.id, tokenB!],
  ] as const) {
    const finished = await control(`/api/agent/runs/${runId}/finish`, tok, {
      status: 'completed',
    });
    expect(finished.status).toBe(200);
  }

  const noActiveRuns = await control('/api/agent/runs/active?team=acme-dev', token!);
  expect(((await noActiveRuns.json()) as any).runs).toEqual([]);

  // auth endpoints are rate limited
  let got429 = false;
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${srv.url}/auth/dev`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'x' }),
      redirect: 'manual',
    });
    if (r.status === 429) {
      got429 = true;
      break;
    }
  }
  expect(got429).toBe(true);
});
