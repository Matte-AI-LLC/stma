import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { projects, teams } from '../src/db/schema';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

/**
 * Agent connections is one page, inside a workspace (2026-09-27, the owner's
 * word). There were two connect screens, and the first lived outside every
 * workspace: it offered all of them in one picker and a connection reaching all
 * of them. What that decision promises, held here:
 *
 * - the workspace's rail has one way in, the account's has none;
 * - the page offers this workspace and its projects, never another, never Personal;
 * - inside a project the same page keeps every choice on that project;
 * - the old addresses still lead somewhere true: one workspace is the answer,
 *   several are a choice, none is the way to make one;
 * - a connection that reaches every workspace (the older kind) is still listed,
 *   and revocable, wherever it can work.
 */

let srv: StartedServer;
let dataDir: string;
let cookie = '';
let alphaProject = '';
let betaProject = '';

const form = (pathname: string, body: Record<string, string>, jar = cookie) =>
  fetch(srv.url + pathname, {
    method: 'POST',
    headers: { cookie: jar, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });
const get = (pathname: string, jar = cookie) => fetch(srv.url + pathname, { headers: { cookie: jar }, redirect: 'manual' });
const html = async (pathname: string, jar = cookie) => (await fetch(srv.url + pathname, { headers: { cookie: jar } })).text();
const lit = (page: string) => [...page.matchAll(/class="rail-link active"[^>]*>([^<]*)/g)].map((m) => m[1]!.trim());
const railLinks = (page: string) => [...page.matchAll(/class="rail-link[^"]*" href="([^"]*)">([^<]*)/g)].map((m) => m[2]!.trim());

async function signIn(username: string) {
  const login = await form('/auth/dev', { username }, '');
  return login.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ');
}

async function project(slug: string, name: string) {
  const [team] = await srv.db.select().from(teams).where(eq(teams.slug, slug));
  const [row] = await srv.db
    .insert(projects)
    .values({ teamId: team!.id, name, slug: name, repositoryIdentity: `github.com/example/${name}` })
    .returning();
  return row!.id;
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-connections-page-'));
  srv = await startServer(
    loadEnv({ host: '127.0.0.1', port: 0, nodeEnv: 'test', devMode: true, databaseUrl: undefined, pgliteDir: dataDir }),
  );
  cookie = await signIn('connections-lead');
});

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

it('says a connection needs a workspace before there is one', async () => {
  const page = await html('/app/tokens');
  expect(page).toContain('Create a workspace first');
  expect(page).not.toContain('Create connect command');
  expect(page).not.toContain('Legacy setup prompt');
});

it('puts one Agent connections page in the workspace, and none in the account', async () => {
  expect((await form('/app/teams', { name: 'Alpha Works' })).status).toBe(302);
  alphaProject = await project('alpha-works', 'alpha-api');

  // One workspace: the old address is the door to it.
  const door = await get('/app/tokens');
  expect(door.status).toBe(303);
  expect(door.headers.get('location')).toBe('/app/teams/alpha-works/connections');

  const page = await html('/app/teams/alpha-works/connections');
  expect(lit(page)).toEqual(['Agent connections']);
  const links = railLinks(page);
  expect(links.filter((label) => label === 'Agent connections')).toHaveLength(1);
  expect(links).not.toContain('Connect & test');
  expect(links).not.toContain('Connect &amp; test');
  // Three sections, in the order a person needs them.
  const order = ['<h2>Connect an agent</h2>', '<h2>Test two agents together</h2>', '<h2>Your connections here</h2>'];
  const at = order.map((heading) => page.indexOf(heading));
  expect(at.every((index) => index > 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
  // Only this workspace and its projects, and nothing that reaches every workspace.
  expect(page).toContain(`value="project:${alphaProject}"`);
  expect(page).not.toContain('value="personal"');
  // The account's own menu no longer carries a connections page of its own.
  const account = await html('/app/account');
  expect(railLinks(account)).not.toContain('My agent connections');
  expect(account).not.toContain('My agent connections');
});

it('asks which workspace when there are several, and never mixes their projects', async () => {
  expect((await form('/app/teams', { name: 'Beta Works' })).status).toBe(302);
  betaProject = await project('beta-works', 'beta-api');

  const chooser = await get('/app/tokens');
  expect(chooser.status).toBe(200);
  const page = await chooser.text();
  expect(page).toContain('href="/app/teams/alpha-works/connections"');
  expect(page).toContain('href="/app/teams/beta-works/connections"');
  expect(page).not.toContain('Create connect command');
  // A filter from an old link still names the workspace it meant.
  expect((await get('/app/tokens?team=beta-works')).headers.get('location')).toBe('/app/teams/beta-works/connections');

  const alpha = await html('/app/teams/alpha-works/connections');
  expect(alpha).toContain(`value="project:${alphaProject}"`);
  expect(alpha).not.toContain(`value="project:${betaProject}"`);
});

it('keeps every choice on the project when the page is opened inside it', async () => {
  const inside = '/app/teams/alpha-works/projects/alpha-api/connections';
  // The workspace page with a project filter is the project's own page.
  expect((await get(`/app/teams/alpha-works/connections?project=${alphaProject}`)).headers.get('location')).toBe(inside);
  expect((await get('/app/tokens?team=alpha-works&project=alpha-api')).headers.get('location')).toBe(inside);

  const page = await html(inside);
  expect(lit(page)).toEqual(['Agents']);
  expect(page).toContain('Back to alpha-api agents');
  expect(page).toContain(`<input type="hidden" name="access" value="project:${alphaProject}"/>`);
  expect(page).toContain('stma adapter activate --target codex');
  // The legacy prompt offers this project or the whole workspace, nothing further.
  expect(page.match(/<option value="(?:team|project):/g)).toHaveLength(2);

  // A test started here is this project's, and reading it anywhere else leads back here.
  const started = await form('/app/launches', { team: 'alpha-works', project: 'alpha-api', intent: 'my_agents' });
  const where = started.headers.get('location')!;
  const launch = new URL(where, srv.url).searchParams.get('launch')!;
  expect(where).toBe(`${inside}?launch=${launch}#test`);
  const elsewhere = await get(`/app/teams/alpha-works/connections?launch=${launch}`);
  expect(elsewhere.status).toBe(303);
  expect(elsewhere.headers.get('location')).toBe(`${inside}?launch=${launch}#test`);
  // The workspace's own page is not showing somebody else's scope's test.
  expect(await html('/app/teams/alpha-works/connections')).toContain('Test <span>not started</span>');
});

it('lists an older connection that reaches every workspace wherever it works, and revokes it from there', async () => {
  const legacy = await form('/app/tokens', { name: 'old-laptop' });
  expect(legacy.status).toBe(200);
  const shown = await legacy.text();
  expect(shown).toMatch(/stma_[0-9a-f]{40}/);
  const id = /\/app\/tokens\/([0-9a-f-]{36})\/revoke/.exec(shown)?.[1];
  expect(id).toBeTruthy();

  for (const slug of ['alpha-works', 'beta-works']) {
    const page = await html(`/app/teams/${slug}/connections`);
    expect(page).toContain('old-laptop');
    expect(page).toContain('Every workspace you are in');
  }
  const chooser = await html('/app/tokens');
  expect(chooser).toContain('1 older connection of yours reaches every workspace you are in');

  const revoked = await form(`/app/tokens/${id}/revoke`, { back_team: 'beta-works', back_project: '' });
  expect(revoked.headers.get('location')).toMatch(/^\/app\/teams\/beta-works\/connections\?ok=/);
});

it('tells somebody outside a workspace nothing about it', async () => {
  const stranger = await signIn('connections-stranger');
  expect((await get('/app/teams/alpha-works/connections', stranger)).status).toBe(404);
  expect((await get('/app/teams/alpha-works/projects/alpha-api/connections', stranger)).status).toBe(404);
  expect((await get('/app/teams/alpha-works/setup', stranger)).status).toBe(404);
  const denied = await form(
    '/app/tokens',
    { mode: 'terminal', name: 'sneaky', device: 'mac', client: 'codex', access: `project:${alphaProject}` },
    stranger,
  );
  expect(await denied.text()).not.toMatch(/stma_enroll_[0-9a-f]{40}/);
});
