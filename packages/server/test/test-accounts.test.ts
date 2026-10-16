/** Mailbox-free identities are an operator-created, bounded exception, not a signup bypass. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { agentEnrollments, agentInstallations, invites, memberships, oauthClients, oauthRefreshTokens, projects, teams, tokens, users } from '../src/db/schema';
import { createAgentEnrollment, redeemAgentEnrollment } from '../src/domain/enrollments';
import { claimInviteMembership } from '../src/domain/invites';
import { loadEnv } from '../src/env';
import { isAdminUser } from '../src/lib/admin';
import { randomHex, sha256hex } from '../src/lib/crypto';
import { mailOutbox, sendMail } from '../src/lib/mailer';
import { testAccountAvailable } from '../src/lib/testAccounts';
import { SecurityRefusal } from '../src/lib/securityHooks';
import { startServer, type StartedServer } from '../src/server';

let srv: StartedServer;
let dir: string;
let operatorCookie: string;
let refuseAudit = false;
const env = () => loadEnv({ port: 0, host: '127.0.0.1', nodeEnv: 'test', devMode: true, databaseUrl: undefined, pgliteDir: dir, twoFactor: true, hosted: true, betaUnmetered: true, baseUrl: 'https://stma.ai' });
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const where = (res: Response) => decodeURIComponent(res.headers.get('location') ?? '');
const cookie = (res: Response) => res.headers.getSetCookie().map(line => line.split(';')[0]).join('; ');
const post = (url: string, fields: Record<string, string>, sid = '', extra: Record<string, string> = {}) => fetch(srv.url + url, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: sid, ...extra },
  body: new URLSearchParams(fields), redirect: 'manual',
});
const get = (url: string, sid = '') => fetch(srv.url + url, { headers: { cookie: sid }, redirect: 'manual' });
const login = (email: string, password: string, from = '1') => post('/auth/local/login', { email, password, next: '/app' }, '', { 'x-forwarded-for': `10.77.0.${from}` });

async function create(name: string) {
  const res = await post('/admin/test-accounts', { name, display_name: 'Demo Showcase', last_day: day(7) }, operatorCookie);
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toContain('no-store');
  const html = await res.text();
  const password = /id="test-account-password">([a-f0-9]{40})</.exec(html)?.[1];
  expect(password).toBeTruthy();
  const [account] = await srv.db.select().from(users).where(eq(users.username, `demo-${name}`));
  expect(account).toBeTruthy();
  return { ...account!, password: password! };
}

async function connection(account: Awaited<ReturnType<typeof create>>) {
  const pending = await createAgentEnrollment(srv.db, { userId: account.id, name: 'Demo agent', deviceLabel: 'demo-mac', clientType: 'generic', scope: 'team', teamId: account.testWorkspaceId! });
  const result = await redeemAgentEnrollment(srv.db, pending.code);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('enrollment was refused');
  return result.value;
}

async function mcp(token: string) {
  return fetch(srv.url + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }) });
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'stma-test-accounts-'));
  process.env.ADMIN_USERNAMES = 'ops,demo-reserved';
  srv = await startServer(env(), { lifecycle: { audit: async (_db, event) => {
    if (refuseAudit && event.action.startsWith('test_account_')) throw new SecurityRefusal('Test audit refused');
  } } });
  delete process.env.ADMIN_USERNAMES;
  const res = await post('/auth/dev', { username: 'ops' });
  expect(res.status).toBe(302);
  operatorCookie = cookie(res);
}, 90_000);

afterAll(async () => {
  await srv?.close();
  mailOutbox.clear();
  rmSync(dir, { recursive: true, force: true });
});

it('creates a distinct unverified identity with one empty workspace and a one-time password', async () => {
  mailOutbox.clear();
  const account = await create('recording');
  expect(account.isTest).toBe(true);
  expect(account.email).toBe('demo-recording@demo.stma.invalid');
  expect(account.emailVerifiedAt).toBeNull();
  expect(account.githubId).toBeNull();
  expect(account.passwordHash).not.toContain(account.password);
  const joined = await srv.db.select().from(memberships).where(eq(memberships.userId, account.id));
  expect(joined).toMatchObject([{ teamId: account.testWorkspaceId, role: 'owner' }]);
  expect(await srv.db.select().from(projects).where(eq(projects.teamId, account.testWorkspaceId!))).toHaveLength(0);
  expect(mailOutbox.latest(account.email!)).toBeUndefined();
  const res = await login(account.email!, account.password);
  expect(where(res)).toBe('/app');
  expect(res.headers.getSetCookie().join(' ')).toContain('Max-Age=86400');
  const page = await (await get('/app/account', cookie(res))).text();
  expect(page).toContain('Test account');
  expect(page).toContain(`through ${day(7)} (UTC)`);
  expect(page).toContain('synthetic sign-in address, not a mailbox');
  expect(page).not.toContain('action="/app/account/email/change"');
  expect(await (await get(`/admin/users/${account.id}`, operatorCookie)).text()).not.toContain(account.password);
});

it('cannot be created by a visitor or ordinary user, nor through ordinary signup', async () => {
  expect((await post('/admin/test-accounts', { name: 'intruder', last_day: day(1) })).status).toBe(404);
  const ordinary = await post('/auth/dev', { username: 'ordinary' });
  expect((await post('/admin/test-accounts', { name: 'intruder', last_day: day(1) }, cookie(ordinary))).status).toBe(404);
  expect(where(await post('/auth/local/signup', { email: 'new@demo.stma.invalid', password: 'unusedPassword123' }))).toContain('created by an operator');
  expect(await srv.db.select().from(users).where(eq(users.email, 'new@demo.stma.invalid'))).toHaveLength(0);
  expect((await post('/admin/test-accounts', { name: 'cross-origin', last_day: day(1) }, operatorCookie, { origin: 'https://untrusted.example' })).status).toBe(403);
});

it('keeps test identity details on Account and operator pages, not the working console', async () => {
  const account = await create('quiet-console');
  const sid = cookie(await login(account.email!, account.password));
  const [workspace] = await srv.db.select().from(teams).where(eq(teams.id, account.testWorkspaceId!));
  expect(workspace).toBeTruthy();
  for (const path of [
    '/app',
    `/app/teams/${workspace!.slug}`,
    `/app/agents?team=${workspace!.slug}`,
    `/app/teams/${workspace!.slug}/connections`,
    '/app/notifications',
  ]) {
    const res = await get(path, sid);
    expect(res.status, path).toBe(200);
    const page = await res.text();
    expect(page, path).not.toContain('>Test account<');
    expect(page, path).not.toContain('Password-only access through');
    expect(page, path).not.toContain('Use synthetic data only.');
  }
  const settings = await (await get('/app/account', sid)).text();
  expect(settings).toContain('<div class="card-title">Test account</div>');
  expect(settings).toContain(`through ${day(7)} (UTC)`);
  expect(settings).toContain('Use synthetic data only.');
  expect(settings).toContain('synthetic sign-in address, not a mailbox');
  const operator = await (await get(`/admin/users/${account.id}`, operatorCookie)).text();
  expect(operator).toContain('Test account · no mailbox');
  expect(operator).toContain(`through ${day(7)} UTC`);
  expect(operator).toContain('Disable test account');
  const [unchanged] = await srv.db.select().from(users).where(eq(users.id, account.id));
  expect(unchanged!.isTest).toBe(true);
  expect(unchanged!.emailVerifiedAt).toBeNull();
  expect(unchanged!.testWorkspaceId).toBe(account.testWorkspaceId);
  expect(unchanged!.reviewAccessUntil).toEqual(account.reviewAccessUntil);
});

it('rolls back account/workspace creation and credential changes when the audit refuses', async () => {
  const account = await create('atomic');
  const sid = cookie(await login(account.email!, account.password, '9'));
  const active = await connection(account);
  const before = await srv.db.select().from(teams);
  refuseAudit = true;
  try {
    expect(where(await post('/admin/test-accounts', { name: 'rolled-back', last_day: day(1) }, operatorCookie))).toContain('Test audit refused');
    expect(await srv.db.select().from(users).where(eq(users.username, 'demo-rolled-back'))).toHaveLength(0);
    expect(await srv.db.select().from(teams)).toHaveLength(before.length);
    expect(where(await post(`/admin/users/${account.id}/test-access`, { action: 'disable' }, operatorCookie))).toContain('Test audit refused');
    expect((await get('/app/account', sid)).status).toBe(200);
    expect((await mcp(active.token)).status).toBe(200);
  } finally { refuseAudit = false; }
});

it('lets the operator name the person, workspace and project independently without reconnecting', async () => {
  const account = await create('presentation');
  const sid = cookie(await login(account.email!, account.password, '10'));
  const active = await connection(account);
  const [workspace] = await srv.db.select().from(teams).where(eq(teams.id, account.testWorkspaceId!));
  const [project] = await srv.db.insert(projects).values({ teamId: workspace!.id, name: 'parcel-desk-demo', slug: 'parcel-desk-demo', repositoryIdentity: 'github.com/example/parcel-desk' }).returning();
  const fields = { username: 'alex-morgan', display_name: 'Alex Morgan', workspace_name: 'Northstar', [`project_name_${project!.id}`]: 'Parcel Desk', email: 'ignored@example.com', is_test: 'false' };
  const response = await post(`/admin/users/${account.id}/test-presentation`, fields, operatorCookie);
  expect(where(response)).toContain('ok=Names saved');
  const { password: _password, ...stored } = account;
  const [after] = await srv.db.select().from(users).where(eq(users.id, account.id));
  expect(after).toEqual({ ...stored, username: 'alex-morgan', displayName: 'Alex Morgan' });
  expect(await srv.db.select().from(teams).where(eq(teams.id, workspace!.id))).toEqual([{ ...workspace!, name: 'Northstar' }]);
  expect(await srv.db.select().from(projects).where(eq(projects.id, project!.id))).toEqual([{ ...project!, name: 'Parcel Desk' }]);
  const page = await (await get(`/app/teams/${workspace!.slug}/projects/${project!.slug}`, sid)).text();
  expect(page).toContain('Alex Morgan');
  expect(page).toContain('owner · Northstar');
  expect(page).toContain('Parcel Desk');
  expect(page).not.toContain('>Test account<');
  expect(page).not.toContain('>demo-presentation<');
  expect((await get('/app/account', sid)).status).toBe(200);
  expect((await mcp(active.token)).status).toBe(200);
  expect(where(await login(account.email!, account.password, '10'))).toBe('/app');
  expect(await testAccountAvailable(srv.db, after!)).toBe(true);
  const operator = await (await get(`/admin/users/${account.id}`, operatorCookie)).text();
  expect(operator).toContain('Save presentation names');
  expect(operator).toContain(`name="project_name_${project!.id}"`);
});

it('keeps presentation changes operator-only, same-origin and limited to test identities', async () => {
  const account = await create('presentation-gate');
  const sid = cookie(await login(account.email!, account.password, '11'));
  const ordinary = await post('/auth/dev', { username: 'ordinary-presentation' });
  const fields = { username: 'new-person', display_name: 'New Person', workspace_name: 'New Workspace' };
  const route = `/admin/users/${account.id}/test-presentation`;
  for (const session of ['', sid, cookie(ordinary)]) expect((await post(route, fields, session)).status).toBe(404);
  expect((await post(route, fields, operatorCookie, { origin: 'https://untrusted.example' })).status).toBe(403);
  const [normal] = await srv.db.select().from(users).where(eq(users.username, 'ordinary-presentation'));
  expect((await post(`/admin/users/${normal!.id}/test-presentation`, fields, operatorCookie)).status).toBe(404);
  expect((await post('/admin/users/not-an-id/test-presentation', fields, operatorCookie)).status).toBe(404);
  expect((await srv.db.select().from(users).where(eq(users.id, account.id)))[0]!.username).toBe(account.username);
});

it('rejects reserved, duplicate, malformed and foreign presentation names atomically', async () => {
  const account = await create('presentation-validation');
  const [workspace] = await srv.db.select().from(teams).where(eq(teams.id, account.testWorkspaceId!));
  const [foreign] = await srv.db.insert(teams).values({ name: 'Other', slug: 'presentation-other' }).returning();
  const [foreignProject] = await srv.db.insert(projects).values({ teamId: foreign!.id, name: 'Other project', slug: 'other-project' }).returning();
  await post('/auth/dev', { username: 'TakenName' });
  const route = `/admin/users/${account.id}/test-presentation`;
  const fields = { username: 'presentation-person', display_name: 'Person', workspace_name: 'Company' };
  for (const invalid of [
    { username: 'ops' }, { username: 'TAKENNAME' }, { username: '../invalid' },
    { display_name: '' }, { workspace_name: 'x'.repeat(81) }, { display_name: 'line\nbreak' },
    { [`project_name_${foreignProject!.id}`]: 'Hijacked' },
  ]) expect(where(await post(route, { ...fields, ...invalid }, operatorCookie))).toContain('error=');
  expect((await srv.db.select().from(users).where(eq(users.id, account.id)))[0]!.username).toBe(account.username);
  expect((await srv.db.select().from(teams).where(eq(teams.id, workspace!.id)))[0]).toEqual(workspace);
  expect((await srv.db.select().from(projects).where(eq(projects.id, foreignProject!.id)))[0]).toEqual(foreignProject);
});

it('rolls back all presentation names if the critical audit refuses', async () => {
  const account = await create('presentation-atomic');
  const [workspace] = await srv.db.select().from(teams).where(eq(teams.id, account.testWorkspaceId!));
  const [project] = await srv.db.insert(projects).values({ teamId: workspace!.id, name: 'Before', slug: 'before' }).returning();
  refuseAudit = true;
  try {
    const fields = { username: 'after-person', display_name: 'After Person', workspace_name: 'After Workspace', [`project_name_${project!.id}`]: 'After project' };
    expect(where(await post(`/admin/users/${account.id}/test-presentation`, fields, operatorCookie))).toContain('Test audit refused');
  } finally { refuseAudit = false; }
  expect((await srv.db.select().from(users).where(eq(users.id, account.id)))[0]!.username).toBe(account.username);
  expect((await srv.db.select().from(teams).where(eq(teams.id, workspace!.id)))[0]).toEqual(workspace);
  expect((await srv.db.select().from(projects).where(eq(projects.id, project!.id)))[0]).toEqual(project);
});

it('validates the expiry, reserved names and duplicates without leaving partial workspaces', async () => {
  for (const [name, last_day] of [['../bad', day(1)], ['far-future', day(62)], ['bad-date', '2026-02-30'], ['reserved', day(1)]]) {
    expect(where(await post('/admin/test-accounts', { name: name!, last_day: last_day! }, operatorCookie))).toContain('error=');
  }
  await create('duplicate');
  const before = await srv.db.select().from(teams);
  expect(where(await post('/admin/test-accounts', { name: 'duplicate', last_day: day(1) }, operatorCookie))).toContain('already exists');
  expect(await srv.db.select().from(teams)).toHaveLength(before.length);
});

it('never becomes an operator, even after expiry and even if an operator list names it', async () => {
  const account = await create('not-admin');
  const allow = { adminUsernames: [account.username], adminEmails: [account.email!] };
  for (const reviewAccessUntil of [account.reviewAccessUntil, new Date(0), null]) {
    expect(isAdminUser(allow, { ...account, emailVerifiedAt: new Date(), reviewAccessUntil })).toBe(false);
  }
  const res = await login(account.email!, account.password);
  expect((await get('/admin/users', cookie(res))).status).toBe(404);
});

it('keeps password throttling and suppresses all mail to the synthetic address', async () => {
  const account = await create('throttled');
  mailOutbox.clear();
  for (let i = 0; i < 5; i++) expect(where(await login(account.email!, 'incorrect-password', '2'))).toContain('/login?error=');
  expect(where(await login(account.email!, account.password, '2'))).toContain('Too many');
  await post('/auth/local/forgot', { email: account.email! });
  const sent = await sendMail(env(), { to: account.email!, kind: 'login_code', subject: 'No real mailbox', text: 'No delivery', html: '<p>No delivery</p>' });
  expect(sent).toMatchObject({ ok: true, transport: 'suppressed' });
  expect(mailOutbox.latest(account.email!)).toBeUndefined();
});

it('locks identity changes, recovery and alternate review-access controls', async () => {
  const account = await create('locked-fields');
  const sid = cookie(await login(account.email!, account.password, '3'));
  for (const route of ['email/change', 'email/verify', 'email/resend', 'password', 'password/verify', 'delete']) {
    expect(where(await post(`/app/account/${route}`, { email: 'other@example.com', password: 'differentPassword', current_password: account.password }, sid))).toContain('managed by an operator');
  }
  expect(where(await post(`/admin/users/${account.id}/email`, { email: 'other@example.com' }, operatorCookie))).toContain('managed by an operator');
  for (const route of ['review-access', 'review-access/off']) {
    expect(where(await post(`/admin/users/${account.id}/${route}`, { last_day: day(2) }, operatorCookie))).toContain('Test account controls');
  }
  const [after] = await srv.db.select().from(users).where(eq(users.id, account.id));
  expect(after!.email).toBe(account.email);
  expect(after!.passwordHash).toBe(account.passwordHash);
  expect(after!.emailVerifiedAt).toBeNull();
});

it('rejects new workspaces, foreign invites and operator membership additions', async () => {
  const account = await create('isolated');
  const sid = cookie(await login(account.email!, account.password, '4'));
  expect(where(await post('/app/teams', { name: 'Escaped', slug: 'escaped' }, sid))).toContain('isolated workspace');
  const [foreign] = await srv.db.insert(teams).values({ name: 'Other workspace', slug: 'other-workspace' }).returning();
  const [invite] = await srv.db.insert(invites).values({ teamId: foreign!.id, createdBy: account.id, code: 'foreign-invite-code', expiresAt: new Date(Date.now() + 3600000) }).returning();
  expect(await claimInviteMembership(srv.db, { code: invite!.code, userId: account.id })).toEqual({ ok: false, reason: 'invalid' });
  expect(where(await post(`/admin/users/${account.id}/memberships`, { team_id: foreign!.id, role: 'owner' }, operatorCookie))).toContain('confined');
  expect(await srv.db.select().from(memberships).where(and(eq(memberships.userId, account.id), eq(memberships.teamId, foreign!.id)))).toHaveLength(0);
});

it('fails closed if another writer creates a foreign membership', async () => {
  const account = await create('foreign-writer');
  const sid = cookie(await login(account.email!, account.password, '5'));
  const active = await connection(account);
  expect((await mcp(active.token)).status).toBe(200);
  const [foreign] = await srv.db.insert(teams).values({ name: 'External writer', slug: 'external-writer' }).returning();
  await srv.db.insert(memberships).values({ userId: account.id, teamId: foreign!.id, role: 'member' });
  expect(await testAccountAvailable(srv.db, account)).toBe(false);
  expect((await get('/app/account', sid)).status).toBe(302);
  expect((await mcp(active.token)).status).toBe(401);
  expect(where(await login(account.email!, account.password, '5'))).toContain('expired or disabled');
});

it('expiry immediately closes browser sessions, MCP, new enrollment redemption and OAuth refresh', async () => {
  const account = await create('expires');
  const sid = cookie(await login(account.email!, account.password, '6'));
  const active = await connection(account);
  expect(active.credentialExpiresAt?.getTime()).toBe(account.reviewAccessUntil!.getTime());
  const pending = await createAgentEnrollment(srv.db, { userId: account.id, name: 'Pending', deviceLabel: 'other-mac', clientType: 'generic', scope: 'team', teamId: account.testWorkspaceId! });
  const clientId = `stma_client_${randomHex(24)}`;
  const refresh = `stma_refresh_${randomHex(32)}`;
  await srv.db.insert(oauthClients).values({ id: clientId, clientName: 'Test client', redirectUris: ['http://127.0.0.1:43199/callback'] });
  await srv.db.insert(oauthRefreshTokens).values({ tokenId: active.tokenId, tokenHash: sha256hex(refresh), clientId, resource: 'https://stma.ai/mcp', scope: 'stma' });
  const beforeExpiry = await post('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: refresh, resource: 'https://stma.ai/mcp' });
  expect(beforeExpiry.status).toBe(200);
  const fresh = await beforeExpiry.json() as { access_token: string; refresh_token: string };
  await srv.db.update(users).set({ reviewAccessUntil: new Date(Date.now() - 1000) }).where(eq(users.id, account.id));
  expect((await get('/app/account', sid)).status).toBe(302);
  expect((await mcp(fresh.access_token)).status).toBe(401);
  expect(await redeemAgentEnrollment(srv.db, pending.code)).toEqual({ ok: false });
  const refreshed = await post('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: fresh.refresh_token, resource: 'https://stma.ai/mcp' });
  expect(refreshed.status).toBe(400);
  expect(await refreshed.json()).toMatchObject({ error: 'invalid_grant' });
});

it.each(['renew', 'disable', 'rotate'])('%s revokes every old session, token and pending connection, without removing the test marker', async (action) => {
  const account = await create(`control-${action}`);
  const sid = cookie(await login(account.email!, account.password, '7'));
  const active = await connection(account);
  const pending = await createAgentEnrollment(srv.db, { userId: account.id, name: 'Not yet connected', deviceLabel: 'later-mac', clientType: 'generic', scope: 'team', teamId: account.testWorkspaceId! });
  const res = await post(`/admin/users/${account.id}/test-access`, { action, last_day: day(8) }, operatorCookie);
  expect(res.status).toBe(action === 'rotate' ? 200 : 302);
  expect((await get('/app/account', sid)).status).toBe(302);
  expect((await mcp(active.token)).status).toBe(401);
  expect(await redeemAgentEnrollment(srv.db, pending.code)).toEqual({ ok: false });
  const [after] = await srv.db.select().from(users).where(eq(users.id, account.id));
  expect(after!.isTest).toBe(true);
  expect((await srv.db.select().from(tokens).where(eq(tokens.id, active.tokenId)))[0]!.revokedAt).toBeTruthy();
  expect((await srv.db.select().from(agentInstallations).where(eq(agentInstallations.id, active.installation.id)))[0]!.revokedAt).toBeTruthy();
  expect((await srv.db.select().from(agentEnrollments).where(eq(agentEnrollments.id, pending.enrollment.id)))[0]!.revokedAt).toBeTruthy();
  if (action === 'rotate') {
    const password = /id="test-account-password">([a-f0-9]{40})</.exec(await res.text())![1]!;
    expect(where(await login(account.email!, account.password, '7'))).toContain('error=');
    expect(where(await login(account.email!, password, '7'))).toBe('/app');
  } else if (action === 'disable') {
    expect(after!.reviewAccessUntil).toBeNull();
    expect(where(await login(account.email!, account.password, '7'))).toContain('expired or disabled');
    await post(`/admin/users/${account.id}/test-access`, { action: 'renew', last_day: day(1) }, operatorCookie);
    expect(where(await login(account.email!, account.password, '7'))).toBe('/app');
    expect((await mcp(active.token)).status).toBe(401);
  } else {
    expect(where(await login(account.email!, account.password, '7'))).toBe('/app');
  }
});

it('disables an identity whose dedicated workspace has been deleted', async () => {
  const account = await create('workspace-gone');
  await srv.db.delete(teams).where(eq(teams.id, account.testWorkspaceId!));
  expect(where(await login(account.email!, account.password, '8'))).toContain('expired or disabled');
});

it('caps the cookie at the remaining test lifetime using a valid integer Max-Age', async () => {
  const account = await create('short-session');
  await srv.db.update(users).set({ reviewAccessUntil: new Date(Date.now() + 120500) }).where(eq(users.id, account.id));
  const res = await login(account.email!, account.password, '10');
  expect(where(res)).toBe('/app');
  const age = /Max-Age=(\d+);/.exec(res.headers.getSetCookie().join(';'))?.[1];
  expect(Number(age)).toBeGreaterThan(0);
  expect(Number(age)).toBeLessThanOrEqual(120);
});
