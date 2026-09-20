import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';
import { invites, memberships, teams, users } from '../src/db/schema';

/**
 * An invite says what its holder joins as.
 *
 * Every invite granted `member` and the only way to make somebody an owner was
 * to add them and then promote them, which is two acts where the team meant
 * one. The role belongs on the link because the person clicking it has no say
 * in which one it is: they cannot choose it, so the page has to tell them, and
 * an owner invitation has to say what ownership actually is rather than print
 * the word.
 */
let srv: StartedServer;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'stma-invite-role-'));
  srv = await startServer(
    loadEnv({ port: 0, host: '127.0.0.1', nodeEnv: 'test', devMode: true, databaseUrl: undefined, pgliteDir: dir }),
  );
});

afterAll(async () => {
  await srv?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function login(username: string) {
  const res = await fetch(`${srv.url}/auth/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username }),
    redirect: 'manual',
  });
  expect(res.status).toBe(302);
  return { cookie: res.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ') };
}

const post = (url: string, body: Record<string, string>, jar: Record<string, string>) =>
  fetch(`${srv.url}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...jar },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });

/** The newest link on the People tab, with what the page says it grants. */
async function newestInvite(jar: Record<string, string>) {
  const page = await (await fetch(`${srv.url}/app/teams/role-lab?tab=people`, { headers: jar })).text();
  const code = /\/join\/([A-Za-z0-9_-]+)/.exec(page)?.[1];
  expect(code, 'the People tab shows the link').toBeTruthy();
  return { code: code!, page };
}

const roleOf = async (username: string) => {
  const [row] = await srv.db
    .select({ role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(teams, eq(teams.id, memberships.teamId))
    .where(and(eq(users.username, username), eq(teams.slug, 'role-lab')));
  return row?.role;
};

it('joins as a member by default, and as an owner when the link says so', async () => {
  const owner = await login('role-owner');
  expect((await post('/app/teams', { name: 'Role Lab' }, owner)).status).toBe(302);

  // Default, and the shape a caller that posts nothing at all still gets: this
  // route took no fields before the column existed and must not start refusing.
  expect((await post('/app/teams/role-lab/invites', {}, owner)).status).toBe(302);
  const asMember = await newestInvite(owner);
  expect(asMember.page).toContain('joins as a member');

  const memberJar = await login('role-joiner');
  const memberPage = await (await fetch(`${srv.url}/join/${asMember.code}`, { headers: memberJar })).text();
  expect(memberPage).toContain('to join as');
  expect(memberPage).toContain('member');
  expect(memberPage).not.toContain('publish the rules every agent');
  expect((await post(`/join/${asMember.code}`, {}, memberJar)).status).toBe(302);
  expect(await roleOf('role-joiner')).toBe('member');

  // And the same link, written to grant ownership.
  expect((await post('/app/teams/role-lab/invites', { role: 'owner' }, owner)).status).toBe(302);
  const asOwner = await newestInvite(owner);
  expect(asOwner.code).not.toBe(asMember.code);
  expect(asOwner.page).toContain('joins as an owner');

  const ownerJar = await login('role-second-owner');
  const ownerPage = await (await fetch(`${srv.url}/join/${asOwner.code}`, { headers: ownerJar })).text();
  // "owner" on its own is a word, not an informed yes: the page says what the
  // authority is before it is accepted.
  expect(ownerPage).toContain('publish the rules every agent on this team is given');
  expect(ownerPage).toContain('remove people');
  expect((await post(`/join/${asOwner.code}`, {}, ownerJar)).status).toBe(302);
  expect(await roleOf('role-second-owner')).toBe('owner');
});

it('says so when an owner link lands on somebody who is already a member', async () => {
  const owner = await login('role-owner');
  expect((await post('/app/teams/role-lab/invites', { role: 'owner' }, owner)).status).toBe(302);
  const link = await newestInvite(owner);

  // role-joiner is already a member from the test above. An invite adds a
  // membership; it does not change one, so this link changes nothing — and
  // redirecting quietly to the team page would let them believe it had.
  const already = await login('role-joiner');
  const res = await post(`/join/${link.code}`, {}, already);
  expect(res.status).toBe(302);
  const where = decodeURIComponent(res.headers.get('location') ?? '');
  expect(where).toContain('already in this team');
  expect(where).toContain('an owner can promote you');
  expect(await roleOf('role-joiner')).toBe('member');

  // And the link is not spent by the attempt.
  const [row] = await srv.db.select({ uses: invites.uses }).from(invites).where(eq(invites.code, link.code));
  expect(row?.uses).toBe(0);
});

it('refuses to read a role from anyone who is not an owner of the team', async () => {
  const stranger = await login('role-stranger');
  // A member cannot reach this handler at all, which is what makes an owner
  // granting one legitimate rather than an escalation.
  expect((await post('/app/teams/role-lab/invites', { role: 'owner' }, stranger)).status).toBe(404);

  // And a value that is not one of the two is the safer one, never an error
  // that leaves somebody guessing which invite they just made.
  const owner = await login('role-owner');
  expect((await post('/app/teams/role-lab/invites', { role: 'superuser' }, owner)).status).toBe(302);
  const made = await newestInvite(owner);
  expect(made.page).toContain('joins as a member');
  const [row] = await srv.db.select({ role: invites.role }).from(invites).where(eq(invites.code, made.code));
  expect(row?.role).toBe('member');
});

it('never lets an agent mint one: the MCP tool has no role to give', async () => {
  const owner = await login('role-owner');
  const page = await (await fetch(`${srv.url}/app/tokens`, { headers: owner })).text();
  const token = /stma_[0-9a-f]{40}/.exec(
    await (
      await post('/app/tokens', { name: 'role-lab-agent' }, owner)
    ).text(),
  )?.[0];
  expect(token, 'a legacy personal credential is enough to call the tool').toBeTruthy();
  expect(page).toBeTruthy();

  const called = await fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      // `role` is not in the tool's schema, and /mcp refuses an unknown
      // argument before dispatch rather than ignoring it.
      params: { name: 'create_invite', arguments: { team: 'role-lab', role: 'owner' } },
    }),
  });
  const raw = (await called.json()) as any;
  expect(raw.result?.isError, 'an unknown argument is refused, not dropped').toBe(true);

  const clean = await fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_invite', arguments: { team: 'role-lab' } } }),
  });
  const made = JSON.parse(((await clean.json()) as any).result.content[0].text);
  const [row] = await srv.db.select({ role: invites.role }).from(invites).where(eq(invites.code, made.code));
  // An owner invitation is an authority grant: a person makes it on a page that
  // says what ownership is, not a model that was asked nicely.
  expect(row?.role).toBe('member');
});
