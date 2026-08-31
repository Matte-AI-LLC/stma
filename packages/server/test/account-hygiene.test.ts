import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

let srv: StartedServer;
let dataDir: string;

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

const form = (j: ReturnType<typeof jar>) => ({
  'content-type': 'application/x-www-form-urlencoded',
  ...j.header(),
});

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

async function signup(email: string, password: string) {
  const j = jar();
  const res = await fetch(`${srv.url}/auth/local/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, password }),
    redirect: 'manual',
  });
  j.store(res);
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('/app');
  return j;
}

async function login(email: string, password: string) {
  const j = jar();
  const res = await fetch(`${srv.url}/auth/local/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, password }),
    redirect: 'manual',
  });
  j.store(res);
  return { jar: j, res };
}

async function createTeam(j: ReturnType<typeof jar>, name: string) {
  const res = await fetch(`${srv.url}/app/teams`, {
    method: 'POST',
    headers: form(j),
    body: new URLSearchParams({ name }),
    redirect: 'manual',
  });
  expect(res.status).toBe(302);
  return res.headers.get('location')!; // /app/teams/<slug>
}

async function joinTeam(owner: ReturnType<typeof jar>, member: ReturnType<typeof jar>, teamPath: string) {
  const invRes = await fetch(`${srv.url}${teamPath}/invites`, {
    method: 'POST',
    headers: owner.header(),
    redirect: 'manual',
  });
  expect(invRes.status).toBe(302);
  // Invite links live on the team page's People tab.
  const html = await (
    await fetch(`${srv.url}${teamPath}?tab=people`, { headers: owner.header() })
  ).text();
  const code = /\/join\/([A-Za-z0-9_-]+)/.exec(html)?.[1];
  expect(code).toBeTruthy();
  const joinRes = await fetch(`${srv.url}/join/${code}`, {
    method: 'POST',
    headers: member.header(),
    redirect: 'manual',
  });
  expect(joinRes.status).toBe(302);
}

async function createToken(j: ReturnType<typeof jar>, name: string) {
  const res = await fetch(`${srv.url}/app/tokens`, {
    method: 'POST',
    headers: form(j),
    body: new URLSearchParams({ name }),
  });
  expect(res.status).toBe(200);
  const token = /stma_[0-9a-f]{40}/.exec(await res.text())?.[0];
  expect(token).toBeTruthy();
  return token!;
}

const rpc = (body: unknown, tok: string) =>
  fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${tok}`,
    },
    body: JSON.stringify(body),
  });

let rpcId = 1;
async function callTool(tok: string, name: string, args: Record<string, unknown> = {}) {
  const res = await rpc(
    { jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } },
    tok,
  );
  return { status: res.status, json: (await res.json()) as any };
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-hygiene-'));
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
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

it('changes the password, rejects a wrong current password, and signs out other sessions', async () => {
  const a = await signup('pat-user@example.com', 'firstpass123');
  const b = (await login('pat-user@example.com', 'firstpass123')).jar; // second browser session

  // Both controls live on /app/account now — the tokens page is machines, and a
  // page about machines is not where somebody looks for their own password.
  const accountHtml = await (await fetch(`${srv.url}/app/account`, { headers: a.header() })).text();
  expect(accountHtml).toContain('Change password');
  const tokensHtml = await (await fetch(`${srv.url}/app/tokens`, { headers: a.header() })).text();
  expect(tokensHtml).not.toContain('Change password');
  // …and it still says where they went, rather than dropping them silently.
  expect(tokensHtml).toContain('/app/account');
  const devUser = await devLogin('nopass-dev');
  const devAccountHtml = await (
    await fetch(`${srv.url}/app/account`, { headers: devUser.header() })
  ).text();
  expect(devAccountHtml).not.toContain('Change password');
  expect(devAccountHtml).toContain('Delete account'); // danger zone is for everyone

  // Wrong current password
  const wrong = await fetch(`${srv.url}/app/account/password`, {
    method: 'POST',
    headers: form(a),
    body: new URLSearchParams({
      current_password: 'not-the-password',
      new_password: 'secondpass456',
      new_password_confirm: 'secondpass456',
    }),
    redirect: 'manual',
  });
  expect(wrong.status).toBe(302);
  expect(wrong.headers.get('location')).toContain('error=');
  expect(decodeURIComponent(wrong.headers.get('location')!)).toContain(
    'Current password is incorrect',
  );

  // Too-short new password
  const short = await fetch(`${srv.url}/app/account/password`, {
    method: 'POST',
    headers: form(a),
    body: new URLSearchParams({
      current_password: 'firstpass123',
      new_password: 'short',
      new_password_confirm: 'short',
    }),
    redirect: 'manual',
  });
  expect(decodeURIComponent(short.headers.get('location')!)).toContain('8-128');

  // Happy path
  const ok = await fetch(`${srv.url}/app/account/password`, {
    method: 'POST',
    headers: form(a),
    body: new URLSearchParams({
      current_password: 'firstpass123',
      new_password: 'secondpass456',
      new_password_confirm: 'secondpass456',
    }),
    redirect: 'manual',
  });
  expect(ok.status).toBe(302);
  expect(ok.headers.get('location')).toContain('ok=');

  // Current session survives; the other one was signed out.
  expect((await fetch(`${srv.url}/app`, { headers: a.header() })).status).toBe(200);
  const bApp = await fetch(`${srv.url}/app`, { headers: b.header(), redirect: 'manual' });
  expect(bApp.status).toBe(302);
  expect(bApp.headers.get('location')).toContain('/login');

  // Old password no longer works, the new one does.
  const oldLogin = (await login('pat-user@example.com', 'firstpass123')).res;
  expect(oldLogin.headers.get('location')).toContain('error=');
  const newLogin = (await login('pat-user@example.com', 'secondpass456')).res;
  expect(newLogin.headers.get('location')).toBe('/app');
});

it('lets a member leave a team, blocks the sole owner, and tracks the event', async () => {
  const owner = await devLogin('lt-owner');
  const member = await devLogin('lt-member');
  const teamPath = await createTeam(owner, 'Leave Co');
  await joinTeam(owner, member, teamPath);

  // Sole owner cannot leave.
  const ownerLeave = await fetch(`${srv.url}${teamPath}/leave`, {
    method: 'POST',
    headers: owner.header(),
    redirect: 'manual',
  });
  expect(ownerLeave.status).toBe(302);
  expect(decodeURIComponent(ownerLeave.headers.get('location')!)).toContain('only owner');
  expect((await fetch(srv.url + teamPath, { headers: owner.header() })).status).toBe(200);

  // Member leaves.
  const leave = await fetch(`${srv.url}${teamPath}/leave`, {
    method: 'POST',
    headers: member.header(),
    redirect: 'manual',
  });
  expect(leave.status).toBe(302);
  expect(leave.headers.get('location')).toContain('/app?ok=');

  // Team page now 404s for them; the owner no longer sees them as a member.
  expect((await fetch(srv.url + teamPath, { headers: member.header() })).status).toBe(404);
  const ownerView = await (
    await fetch(`${srv.url}${teamPath}?tab=people`, { headers: owner.header() })
  ).text();
  expect(ownerView).not.toContain('lt-member');

  const activityHtml = await (
    await fetch(`${srv.url}${teamPath}/activity`, { headers: owner.header() })
  ).text();
  expect(activityHtml).toContain('member_left');
});

it('lets an owner remove a member; non-owners get 403', async () => {
  const owner = await devLogin('rm-owner');
  const member = await devLogin('rm-member');
  const other = await devLogin('rm-other');
  const teamPath = await createTeam(owner, 'Remove Co');
  await joinTeam(owner, member, teamPath);
  await joinTeam(owner, other, teamPath);

  // The owner's People tab shows a remove action for the member; extract its URL.
  const ownerHtml = await (
    await fetch(`${srv.url}${teamPath}?tab=people`, { headers: owner.header() })
  ).text();
  const removeUrl = new RegExp(
    `${teamPath.replaceAll('/', '\\/')}\\/members\\/([0-9a-f-]{36})\\/remove`,
  ).exec(ownerHtml)?.[0];
  expect(removeUrl).toBeTruthy();

  // A plain member cannot remove anyone.
  const forbidden = await fetch(`${srv.url}${removeUrl}`, {
    method: 'POST',
    headers: other.header(),
    redirect: 'manual',
  });
  expect(forbidden.status).toBe(403);

  // Members see no remove actions on their own view.
  const memberHtml = await (
    await fetch(`${srv.url}${teamPath}?tab=people`, { headers: member.header() })
  ).text();
  expect(memberHtml).not.toContain('/members/');

  // Owner removes the first joined member.
  const removed = await fetch(`${srv.url}${removeUrl}`, {
    method: 'POST',
    headers: owner.header(),
    redirect: 'manual',
  });
  expect(removed.status).toBe(302);
  expect(removed.headers.get('location')).toContain('ok=');

  expect((await fetch(srv.url + teamPath, { headers: member.header() })).status).toBe(404);
  const ownerView = await (
    await fetch(`${srv.url}${teamPath}?tab=people`, { headers: owner.header() })
  ).text();
  expect(ownerView).not.toContain('rm-member<');
  expect(ownerView).toContain('rm-other');

  const activityHtml = await (
    await fetch(`${srv.url}${teamPath}/activity`, { headers: owner.header() })
  ).text();
  expect(activityHtml).toContain('member_removed');
});

it('deletes a team with all its content; pages and snapshots become inaccessible', async () => {
  const owner = await devLogin('del-owner');
  const teamPath = await createTeam(owner, 'Wipe Co');
  const token = await createToken(owner, 'wipe-cli');

  await rpc(
    {
      jsonrpc: '2.0',
      id: rpcId++,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'hygiene-test', version: '0.0.0' },
      },
    },
    token,
  );
  const push = await callTool(token, 'push_snapshot', {
    repo: 'wipe-repo',
    snapshot: {
      os: { platform: 'linux', arch: 'x64' },
      runtimes: { node: '24.1.0' },
      packageManagers: { npm: '11.0.0' },
      lockfiles: [{ path: 'package-lock.json', hash: 'aaa111' }],
      envVarNames: ['PATH'],
      git: { branch: 'main', sha: 'abc123', dirtyFiles: [] },
      timezone: 'Europe/Istanbul',
    },
  });
  expect(push.json.result.isError).toBeFalsy();

  // A web-opened debug session
  const slug = teamPath.split('/').pop()!;
  const createSess = await fetch(`${srv.url}/app/sessions`, {
    method: 'POST',
    headers: form(owner),
    body: new URLSearchParams({ team: slug, title: 'Doomed session', body: 'will be wiped' }),
    redirect: 'manual',
  });
  expect(createSess.status).toBe(302);
  const sessPath = createSess.headers.get('location')!;
  expect((await fetch(srv.url + sessPath, { headers: owner.header() })).status).toBe(200);

  // A non-owner member cannot delete the team.
  const bystander = await devLogin('del-member');
  await joinTeam(owner, bystander, teamPath);
  const forbidden = await fetch(`${srv.url}${teamPath}/delete`, {
    method: 'POST',
    headers: bystander.header(),
    redirect: 'manual',
  });
  expect(forbidden.status).toBe(403);

  // Owner deletes the team.
  const del = await fetch(`${srv.url}${teamPath}/delete`, {
    method: 'POST',
    headers: owner.header(),
    redirect: 'manual',
  });
  expect(del.status).toBe(302);
  expect(del.headers.get('location')).toContain('/app?ok=');

  expect((await fetch(srv.url + teamPath, { headers: owner.header() })).status).toBe(404);
  expect((await fetch(srv.url + sessPath, { headers: owner.header() })).status).toBe(404);
  expect((await fetch(srv.url + sessPath, { headers: bystander.header() })).status).toBe(404);

  // The snapshot is gone with the team: the MCP tool no longer finds a team.
  const snap = await callTool(token, 'get_snapshot', { username: 'del-owner' });
  expect(snap.json.result.isError).toBe(true);
  expect(snap.json.result.content[0].text).toContain('not a member of any team');

  // The personal token itself still authenticates (user-owned, untouched).
  const who = await callTool(token, 'whoami', {});
  expect(who.status).toBe(200);
  expect(who.json.result.content[0].text).toContain('del-owner');
});

it('blocks account deletion for a sole owner, then deletes (scrubs) after the blocker is gone', async () => {
  const hostOwner = await devLogin('host-owner');
  const hostTeamPath = await createTeam(hostOwner, 'Host Co');

  const doomed = await signup('doomed-user@example.com', 'doomedpass1');
  await joinTeam(hostOwner, doomed, hostTeamPath); // plain member elsewhere
  const soloTeamPath = await createTeam(doomed, 'Solo Co'); // sole owner here
  const doomedToken = await createToken(doomed, 'doomed-cli');

  // Leave a trace in Host Co so we can verify attribution survives.
  const createSess = await fetch(`${srv.url}/app/sessions`, {
    method: 'POST',
    headers: form(doomed),
    body: new URLSearchParams({
      team: hostTeamPath.split('/').pop()!,
      title: 'Trace session',
      body: 'posted by doomed-user',
    }),
    redirect: 'manual',
  });
  const tracePath = createSess.headers.get('location')!;

  // Blocked: sole owner of Solo Co.
  const blocked = await fetch(`${srv.url}/app/account/delete`, {
    method: 'POST',
    headers: doomed.header(),
    redirect: 'manual',
  });
  expect(blocked.status).toBe(302);
  const blockedMsg = decodeURIComponent(blocked.headers.get('location')!);
  expect(blockedMsg).toContain('error=');
  expect(blockedMsg).toContain('Solo Co');
  expect(blockedMsg).not.toContain('Host Co');

  // Resolve the blocker: delete Solo Co, then leave Host Co.
  const delTeam = await fetch(`${srv.url}${soloTeamPath}/delete`, {
    method: 'POST',
    headers: doomed.header(),
    redirect: 'manual',
  });
  expect(delTeam.status).toBe(302);
  const leave = await fetch(`${srv.url}${hostTeamPath}/leave`, {
    method: 'POST',
    headers: doomed.header(),
    redirect: 'manual',
  });
  expect(leave.status).toBe(302);
  expect(leave.headers.get('location')).toContain('/app?ok=');

  // Now the account can be deleted.
  const del = await fetch(`${srv.url}/app/account/delete`, {
    method: 'POST',
    headers: doomed.header(),
    redirect: 'manual',
  });
  expect(del.status).toBe(302);
  expect(del.headers.get('location')).toBe('/');

  // Signed out everywhere; password sign-in is gone.
  const appAfter = await fetch(`${srv.url}/app`, { headers: doomed.header(), redirect: 'manual' });
  expect(appAfter.status).toBe(302);
  const reLogin = (await login('doomed-user@example.com', 'doomedpass1')).res;
  expect(reLogin.headers.get('location')).toContain('error=');

  // Personal tokens are revoked.
  const who = await rpc(
    { jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: 'whoami', arguments: {} } },
    doomedToken,
  );
  expect(who.status).toBe(401);

  // Authored content stays, attributed to the scrubbed identity.
  const traceHtml = await (
    await fetch(srv.url + tracePath, { headers: hostOwner.header() })
  ).text();
  expect(traceHtml).toContain('posted by doomed-user'); // message body kept
  expect(traceHtml).toContain('opened by deleted-'); // attribution scrubbed
  expect(traceHtml).not.toContain('>doomed-user<'); // no author element shows the old name
});
