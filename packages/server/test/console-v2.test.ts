import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { memberships, teams, users } from '../src/db/schema';
import { loadEnv } from '../src/env';
import { helpSections } from '../src/routes/help';
import { startServer, type StartedServer } from '../src/server';

/**
 * The v2 console: what moved, and what it must still be able to answer.
 *
 * The redesign was mostly information architecture — a project became a place,
 * an account became a page, a team page became four tabs — and that kind of
 * change breaks quietly: nothing errors, the thing you were looking for is
 * simply not on the page any more. So these assert reachability and content
 * rather than markup, and they name the rules the layout is not allowed to
 * break: a project page must agree with the agent map about a collision, and
 * the account controls must be somewhere a person can actually get to.
 */

let srv: StartedServer;
let dataDir: string;
let cookie = '';
let token = '';

const form = (url: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });

const page = async (p: string) => {
  const res = await fetch(`${srv.url}${p}`, { headers: { cookie } });
  return { status: res.status, html: await res.text() };
};

let rpcId = 1;
async function call(tool: string, args: Record<string, unknown>, tok = token) {
  const res = await fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${tok}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId++,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  });
  const json = (await res.json()) as { result?: { content?: { text: string }[]; isError?: boolean } };
  return { text: json.result?.content?.[0]?.text ?? '', isError: json.result?.isError === true };
}

async function tokenFor(name: string): Promise<string> {
  const res = await fetch(`${srv.url}/app/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ name }),
  });
  return /stma_[0-9a-f]{40}/.exec(await res.text())?.[0] ?? '';
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-v2-'));
  srv = await startServer(
    loadEnv({
      port: 0,
      host: '127.0.0.1',
      nodeEnv: 'test',
      devMode: true,
      databaseUrl: undefined,
      pgliteDir: dataDir,
    }),
  );
  const login = await form(`${srv.url}/auth/dev`, { username: 'v2-owner' });
  cookie = login.headers
    .getSetCookie()
    .map((line) => line.split(';')[0]!)
    .join('; ');
  await form(`${srv.url}/app/teams`, { name: 'V2 Team' }, { cookie });
  token = await tokenFor('v2-machine');
  expect(token).toBeTruthy();
});

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

it('creates a project before enrollment and still discovers projects from agent runs', async () => {
  const empty = await page('/app/teams/v2-team/projects');
  expect(empty.status).toBe(200);
  expect(empty.html).toContain('New project');
  expect(empty.html).toContain('name="project"');

  const manual = await form(
    `${srv.url}/app/projects`,
    {
      team: 'v2-team',
      project: 'https://github.com/acme/manual-api.git',
      return_to: 'projects',
    },
    { cookie },
  );
  expect(manual.status).toBe(302);
  expect(manual.headers.get('location')).toContain('/app/teams/v2-team/projects?');
  expect(manual.headers.get('location')).toContain('project=manual-api');

  const manualList = await page('/app/teams/v2-team/projects');
  expect(manualList.html).toContain('/app/teams/v2-team/projects/manual-api');

  const picker = await page('/app/tokens?team=v2-team');
  expect(picker.html).toContain('New project');
  const fromConnections = await form(
    `${srv.url}/app/projects`,
    {
      team: 'v2-team',
      project: 'parcel-desk-agent-lab',
      return_to: 'tokens',
    },
    { cookie },
  );
  expect(fromConnections.status).toBe(302);
  const connectionLocation = fromConnections.headers.get('location') ?? '';
  expect(connectionLocation).toContain('/app/tokens?');
  expect(connectionLocation).toContain('team=v2-team');
  expect(connectionLocation).toContain('project=parcel-desk-agent-lab');
  const selected = await page(connectionLocation);
  expect(selected.html).toMatch(
    /<option value="project:[0-9a-f-]{36}" selected="">Project only — parcel-desk-agent-lab<\/option>/,
  );

  // Agent discovery remains valid and uses the same resolver as manual creation.
  const started = await call('start_run', {
    team: 'v2-team',
    project: 'payments-api',
    task: 'PAY-1',
    intent: 'Refund idempotency',
    branch: 'feat/pay-1',
    scope: [{ type: 'path', key: 'src/payments', access: 'write' }],
  });
  expect(started.isError, started.text).toBe(false);

  const list = await page('/app/teams/v2-team/projects');
  expect(list.html).toContain('payments-api');
  expect(list.html).toContain('/app/teams/v2-team/projects/payments-api');

  const detail = await page('/app/teams/v2-team/projects/payments-api');
  expect(detail.status).toBe(200);
  // The five answers the page exists to put together.
  expect(detail.html).toContain('Active runs');
  expect(detail.html).toContain('Open sessions');
  // Policy, Knowledge and Delivery share one card, named for the rail group that
  // leads to them; with nothing published it says so for each rather than going quiet.
  expect(detail.html).toContain('Rules in effect here');
  expect(detail.html).toContain('No policy rule is in force for payments-api');
  expect(detail.html).toContain('no record reaches this project yet');
  expect(detail.html).toContain('no flow published');
  expect(detail.html).toContain('Environment');
  expect(detail.html).toContain('PAY-1');
  // …each next to the page that owns it, rather than replacing it, and each at
  // that page's address inside this project.
  expect(detail.html).toContain('/app/agents');
  expect(detail.html).toContain('/app/teams/v2-team/projects/payments-api/governance');
  const sessionHref = /href="(\/app\/sessions\?new=1&amp;team=v2-team&amp;project=([0-9a-f-]{36}))"/.exec(
    detail.html,
  );
  expect(sessionHref).toBeTruthy();
  const sessionForm = await page(sessionHref![1]!.replaceAll('&amp;', '&'));
  expect(sessionForm.html).toContain('data-auto-open="t"');
  expect(sessionForm.html).toContain('data-session-project="true"');
  expect(sessionForm.html).toContain('data-team="v2-team"');
  expect(sessionForm.html).toContain(
    `<option value="${sessionHref![2]}" data-team="v2-team" selected="">`,
  );

  const opened = await form(
    `${srv.url}/app/sessions`,
    {
      team: 'v2-team',
      project: sessionHref![2]!,
      title: 'Project-prefilled session',
      body: 'The project context came from its own page.',
    },
    { cookie },
  );
  expect(opened.status).toBe(302);
  expect(opened.headers.get('location')).toMatch(/^\/app\/sessions\/[0-9a-f-]{36}$/);
  expect((await page('/app/teams/v2-team/projects/payments-api')).html).toContain(
    'Project-prefilled session',
  );

  const invalid = await form(
    `${srv.url}/app/sessions`,
    {
      team: 'v2-team',
      project: '00000000-0000-4000-8000-000000000000',
      title: 'Typo must not create a project',
    },
    { cookie },
  );
  expect(decodeURIComponent(invalid.headers.get('location') ?? '')).toContain(
    'Pick an existing project',
  );

  // A project nobody has named is not a page.
  expect((await page('/app/teams/v2-team/projects/nope-api')).status).toBe(404);
});

it('keeps manual project creation owner-only in projects and Agent connections', async () => {
  const login = await form(`${srv.url}/auth/dev`, { username: 'v2-member' });
  const memberCookie = login.headers
    .getSetCookie()
    .map((line) => line.split(';')[0]!)
    .join('; ');
  const [member] = await srv.db.select().from(users).where(eq(users.username, 'v2-member')).limit(1);
  const [team] = await srv.db.select().from(teams).where(eq(teams.slug, 'v2-team')).limit(1);
  await srv.db.insert(memberships).values({
    teamId: team!.id,
    userId: member!.id,
    role: 'member',
  });

  const projectsPage = await fetch(`${srv.url}/app/teams/v2-team/projects`, {
    headers: { cookie: memberCookie },
  });
  expect(await projectsPage.text()).not.toContain('>New project</summary>');
  const connectionsPage = await fetch(`${srv.url}/app/tokens?team=v2-team`, {
    headers: { cookie: memberCookie },
  });
  expect(await connectionsPage.text()).not.toContain('>New project</summary>');
  const denied = await form(
    `${srv.url}/app/projects`,
    { team: 'v2-team', project: 'member-created', return_to: 'projects' },
    { cookie: memberCookie },
  );
  expect(denied.status).toBe(404);
});

it('agrees with the agent map about a collision, because it asks the same question', async () => {
  // Two runs on one migration is the critical case — the same rule the map and
  // the tools apply, imported rather than re-derived here.
  const held = await call('update_run', {
    status: 'active',
    scope: [
      { type: 'path', key: 'src/payments', access: 'write' },
      { type: 'migration', key: 'payments-db', access: 'write' },
    ],
  });
  expect(held.isError, held.text).toBe(false);

  const second = await tokenFor('v2-other-machine');
  const clash = await call(
    'start_run',
    {
      team: 'v2-team',
      project: 'payments-api',
      task: 'PAY-2',
      branch: 'fix/pay-2',
      scope: [{ type: 'migration', key: 'payments-db', access: 'write' }],
    },
    second,
  );
  expect(clash.isError, clash.text).toBe(false);
  expect(clash.text).toContain('critical');

  const detail = await page('/app/teams/v2-team/projects/payments-api');
  // The band the map raises for a critical overlap, on the project's own page.
  expect(detail.html).toContain('critical');
  expect(detail.html).toContain('Claims are advisory');
  expect(detail.html).toContain('>conflicts detected</span>');
  expect(detail.html).not.toContain('>conflicts_detected</');
  const map = await page('/app/agents');
  expect(map.html).toContain('critical');
});

it('makes every step of the way to a page a way back, and keeps the map readable on a wide screen', async () => {
  // Reported by the owner after the first two-device round, 2026-09-20: the line
  // above every title named the places ("/ across workspaces / agent map") and led
  // to none of them; and the agent map shrank as the screen grew.
  const project = await page('/app/teams/v2-team/projects/manual-api');
  expect(project.status).toBe(200);
  const trail = /<nav class="crumb" aria-label="Breadcrumb">(.*?)<\/nav>/s.exec(project.html)?.[1] ?? '';
  expect(trail).toContain('<a href="/app/teams/v2-team">');
  expect(trail).toContain('<a href="/app/teams/v2-team/projects">Projects</a>');
  // The page itself is the last step: named, marked current, not a link to itself.
  expect(trail).toMatch(/<span aria-current="page">manual-api<\/span>$/);

  const map = await page('/app/agents');
  expect(map.html).toContain('<a href="/app">All workspaces</a>');
  expect(map.html).not.toContain('/ across workspaces / agent map');

  // Savings left the rail on the owner's call; the page still answers its address.
  expect(map.html).not.toContain('/app/teams/v2-team/savings');
  expect((await page('/app/teams/v2-team/savings')).status).toBe(200);

  // A height cap on a scaled drawing makes it SMALLER as the column gets wider.
  const { css } = await import('../src/ui/styles');
  const graph = /\.sg \{([^}]*)\}/.exec(css)?.[1] ?? '';
  expect(graph).toContain('max-width');
  expect(graph).not.toContain('max-height');
});

it('draws the rail of the scope the page is in: account, workspace or project', async () => {
  // The owner's verdict, 2026-09-20: "Current workspace", "Manage workspace" and
  // "Across workspaces" mixed where you are with what you can do, the agent map
  // poured every workspace into one ledger, and a project had no sections of its
  // own, so everything about it was reached by leaving it.
  const lit = (html: string) =>
    [...html.matchAll(/class="rail-link active"[^>]*>([^<]*)/g)].map((m) => m[1]!.trim());

  // Inside a project the rail is that project's, and its first line is the way out.
  const project = await page('/app/teams/v2-team/projects/payments-api');
  expect(project.html).toContain('<a class="rail-link rail-up" href="/app/teams/v2-team/projects">');
  expect(project.html).toContain('class="rail-group">payments-api</span>');
  expect(project.html).toContain('class="rail-group later">Rules in effect here</span>');
  expect(lit(project.html)).toEqual(['Overview']);
  // Sections of a project are addressed under it; the agent map is not one of its
  // sections and keeps the filter form.
  expect(project.html).toContain('href="/app/agents?team=v2-team&amp;project=payments-api"');
  expect(project.html).toContain('href="/app/teams/v2-team/projects/payments-api/work"');
  expect(project.html).toContain('href="/app/teams/v2-team/projects/payments-api/governance"');
  expect(project.html).not.toContain('class="rail-group">Workspace</span>');
  // The scope bar names both, and marks the project as the scope you are in.
  expect(project.html).toMatch(/class="scope-at in"[^>]*>\s*payments-api/);

  // A workspace page filtered to a project is inside that project too: the rail,
  // the trail and the content all say the same thing.
  const governance = await page('/app/teams/v2-team/governance?project=payments-api');
  expect(lit(governance.html)).toEqual(['Governance']);
  expect(governance.html).toContain('class="rail-group">payments-api</span>');
  const trail = /<nav class="crumb" aria-label="Breadcrumb">(.*?)<\/nav>/s.exec(governance.html)?.[1] ?? '';
  expect(trail).toContain('<a href="/app/teams/v2-team/projects/payments-api">payments-api</a>');
  expect(trail).toMatch(/<span aria-current="page">Governance<\/span>$/);
  // Without the filter it is a workspace page again.
  const everyProject = await page('/app/teams/v2-team/governance');
  expect(everyProject.html).toContain('class="rail-group">Workspace</span>');
  expect(everyProject.html).toContain('class="rail-group later">Rules set here</span>');
  // The pair has to read as one sentence, because it is the inheritance rule the
  // whole console is built on: set at the workspace, in effect in the project. It
  // said "Rules for every project", which is what the console does NOT do —
  // Governance takes project additions, Knowledge takes a project audience, and a
  // project can replace the Delivery flow outright.
  expect(everyProject.html).not.toContain('Rules for every project');
  // A place and what is happening in it are two groups, not one list of nine.
  expect(everyProject.html).toContain('class="rail-group later">What is happening</span>');
  const railOf = (html: string) =>
    /<div class="rail-nav" id="rail-destinations">(.*?)<\/div>/s.exec(html)?.[1] ?? '';
  const wsRail = railOf(everyProject.html);
  expect(wsRail.indexOf('Agent map')).toBeGreaterThan(wsRail.indexOf('What is happening'));
  expect(wsRail.indexOf('Knowledge')).toBeGreaterThan(wsRail.indexOf('Rules set here'));

  // A baseline is an observation of a machine, not a rule anybody published:
  // activeBaselines joins projects on a NOT NULL column, so there is no
  // workspace-wide baseline and nothing inherits. It sits with what is happening
  // at both levels, and the two rails no longer disagree about it.
  const projectRail = railOf(project.html);
  expect(projectRail.indexOf('Environments')).toBeLessThan(projectRail.indexOf('Rules in effect here'));
  expect(wsRail.indexOf('Environments')).toBeLessThan(wsRail.indexOf('Rules set here'));

  // The map has a scope as well. payments-api has two live runs; manual-api none.
  const workspaceMap = await page('/app/agents?team=v2-team');
  expect(lit(workspaceMap.html)).toEqual(['Agent map']);
  expect(workspaceMap.html).toContain('PAY-2');
  const projectMap = await page('/app/agents?team=v2-team&project=payments-api');
  expect(lit(projectMap.html)).toEqual(['Agents']);
  expect(projectMap.html).toContain('PAY-2');
  // Links inside the map keep the scope they were opened in.
  expect(projectMap.html).toMatch(/href="\/app\/agents\?run=[0-9a-f-]{36}&amp;team=v2-team&amp;project=payments-api"/);
  const quiet = await page('/app/agents?team=v2-team&project=manual-api');
  expect(quiet.html).not.toContain('PAY-2');
  expect(quiet.html).toMatch(/<span aria-current="page">Agents<\/span>/);
  // The badge counts what the link opens: two runs in the project, none in the other.
  expect(projectMap.html).toMatch(/Agents<span class="rail-badge">2<\/span>/);
  expect(quiet.html).not.toMatch(/Agents<span class="rail-badge">/);

  // Work and Sessions take the same scope.
  const work = await page('/app/handoffs?team=v2-team&project=payments-api');
  expect(lit(work.html)).toEqual(['Work']);
  expect(work.html).toContain('<a href="/app/teams/v2-team/projects/payments-api">payments-api</a>');
  const sessions = await page('/app/sessions?team=v2-team&project=payments-api');
  expect(lit(sessions.html)).toEqual(['Sessions']);
  expect(sessions.html).toContain('<a href="/app/teams/v2-team/projects/payments-api">payments-api</a>');

  // A project of another workspace is not a scope: the rail stays at workspace level.
  const stray = await page('/app/agents?team=v2-team&project=no-such-project');
  expect(stray.html).toContain('class="rail-group">Workspace</span>');
});

it('puts a project in the address of its own sections, and keeps the filter form answering', async () => {
  // The console draws three scopes and a scope bar; the address said two, and the
  // one it left out was the one you had just clicked into. Every section of a
  // project is addressed under it now. The `?project=` filter it replaces is in
  // browser tabs and in messages, so it answers exactly as before — it is not
  // redirected away, because a redirect is how a link somebody sent last week
  // quietly stops meaning what it said.
  const under = '/app/teams/v2-team/projects/payments-api';
  const sections: [string, string, string][] = [
    ['governance', '/app/teams/v2-team/governance?project=payments-api', 'Governance'],
    ['knowledge', '/app/teams/v2-team/knowledge?project=payments-api', 'Knowledge'],
    ['delivery', '/app/teams/v2-team/delivery?project=payments-api', 'Delivery'],
    ['environments', '/app/teams/v2-team/compare?project=payments-api', 'Environments'],
    ['activity', '/app/teams/v2-team/activity?project=payments-api', 'Activity'],
    ['work', '/app/handoffs?team=v2-team&project=payments-api', 'Work'],
    ['sessions', '/app/sessions?team=v2-team&project=payments-api', 'Sessions'],
    ['agents', '/app/teams/v2-team/projects/payments-api/agents', 'Agents'],
  ];
  const lit = (html: string) =>
    [...html.matchAll(/class="rail-link active"[^>]*>([^<]*)/g)].map((m) => m[1]!.trim());
  for (const [section, filtered, label] of sections) {
    const hierarchical = await page(`${under}/${section}`);
    expect(hierarchical.status, section).toBe(200);
    // Same scope, same rail entry lit, and the trail walks through the project.
    expect(lit(hierarchical.html), section).toEqual([label]);
    expect(hierarchical.html, section).toContain(`<a href="${under}">payments-api</a>`);
    const old = await page(filtered);
    expect(old.status, filtered).toBe(200);
    expect(lit(old.html), filtered).toEqual([label]);
    expect(old.html, filtered).toContain(`<a href="${under}">payments-api</a>`);
  }

  // In the path the project is the page's identity, so a spelling that names none
  // is a wrong address — the same 404 `/projects/<name>` itself answers. As a
  // filter it stayed a filter, and governance says so rather than pretending.
  for (const section of ['governance', 'knowledge', 'delivery', 'environments', 'activity', 'work', 'sessions']) {
    expect((await page(`/app/teams/v2-team/projects/no-such-project/${section}`)).status, section).toBe(404);
  }
  const filteredMiss = await page('/app/teams/v2-team/governance?project=no-such-project');
  expect(filteredMiss.status).toBe(200);
  expect(filteredMiss.html).toContain('No project called');
  // A project of another workspace resolves the same way: `projectForTeam` only
  // ever looks inside the workspace in the address, so it is simply not found.
  // The export sits beside a project's log, so it has the project's address too.
  expect((await page('/app/teams/v2-team/projects/payments-api/activity.csv')).status).toBe(200);
  expect((await page('/app/teams/v2-team/projects/no-such-project/activity.csv')).status).toBe(404);

  // The forms that pick a project write a query string — that is all a GET form
  // can write — so they stay on the workspace address, and every link is the path.
  const governance = await page(`${under}/governance`);
  expect(governance.html).toContain('action="/app/teams/v2-team/governance"');
  const activity = await page(`${under}/activity`);
  expect(activity.html).toContain('action="/app/teams/v2-team/activity"');
  expect(activity.html).toContain(`href="${under}/activity.csv`);
});

it('answers "is anything happening anywhere" from the list of workspaces, not from a ledger that mixes them', async () => {
  // Phase 4 of the console plan. The account rail offered an agent map, work and
  // sessions "across workspaces": every workspace in one ledger, every row
  // ambiguous about where. The list of workspaces carries a number per workspace
  // instead, each a link into that workspace's own page.
  const home = await page('/app');
  expect(home.html).not.toContain('Across workspaces');
  const accountRail = /<div class="rail-nav"[^>]*>(.*?)<\/div><div class="rail-foot">/s.exec(home.html)?.[1] ?? '';
  expect(accountRail).toContain('All workspaces');
  expect(accountRail).not.toContain('href="/app/agents"');
  expect(accountRail).not.toContain('href="/app/sessions"');
  expect(accountRail).not.toContain('href="/app/handoffs"');
  for (const column of ['Working now', 'Work open', 'Unread']) expect(home.html).toContain(`>${column}</th>`);
  // v2-team has live runs from the tests above: the number is a link into its own map.
  const row = /<tr><td><div class="cellrow">(?:(?!<\/tr>).)*?\/app\/teams\/v2-team"(?:(?!<\/tr>).)*<\/tr>/s.exec(home.html)?.[0] ?? '';
  expect(row).toMatch(/<a href="\/app\/agents\?team=v2-team">[1-9]\d*<\/a>/);
  // A quiet counter is a plain zero, not a link to an empty page.
  expect(row).toContain('<span class="muted">0</span>');
  // The addresses still answer: links in mail and in people's bookmarks point at them.
  for (const old of ['/app/agents', '/app/sessions', '/app/handoffs']) expect((await page(old)).status).toBe(200);
});

it('says a result once, keeps text and fields readable on a wide screen, and gives the map its width back', async () => {
  const { clientJs } = await import('../src/ui/client');
  // The parameter that carried a result band leaves the address once the page drew
  // it, so a refresh or a pasted link does not announce it again. Signed-in pages only.
  expect(clientJs).toContain('history.replaceState');
  for (const key of ['ok', 'error', 'notice', 'assigned', 'cancelled', 'assign_error', 'handoff']) {
    expect(clientJs).toContain(`'${key}'`);
  }
  expect(clientJs).toContain("path.indexOf('/app') === 0");
  // Selection and filters are address state and must survive it.
  for (const kept of ["'run'", "'scope'", "'project'", "'team'", "'tab'", "'flow'", "'q'"]) {
    expect(/var once = \[([^\]]*)\]/.exec(clientJs)?.[1] ?? '').not.toContain(kept);
  }

  const { css } = await import('../src/ui/styles');
  // Measured at 1920 and 2560 on 2026-09-20: inputs 1607px wide and 200-character
  // lines on seven pages. Prose keeps a measure and a field a width.
  expect(css).toMatch(/--measure:\s*\d+ch/);
  expect(css).toMatch(/--field-max:\s*\d+px/);
  expect(css).toMatch(/input\.in, textarea\.in, select\.in \{ max-width: var\(--field-max\); \}/);
  expect(css).toMatch(/\.cpad p,[^{]*\{ max-width: var\(--measure\); \}/);
  // The graph is capped in width, so past that the ledger stands beside it.
  expect(css).toMatch(/@media \(min-width: 2300px\) \{\s*\.map-split \{ display: grid;/);
  const map = await page('/app/agents?team=v2-team');
  expect(map.html).toContain('class="map-split"');
});

it('puts the password and the danger zone on a page reached from your own name', async () => {
  const account = await page('/app/account');
  expect(account.status).toBe(200);
  expect(account.html).toContain('Delete account');

  // The rail's identity block is the way in — an account is not a place the
  // fleet lives, so it has no rail entry of its own.
  const anyPage = await page('/app/agents');
  expect(anyPage.html).toContain('href="/app/account"');

  // And the tokens page says where they went rather than dropping them.
  const tokens = await page('/app/tokens');
  expect(tokens.html).toContain('/app/account');
  expect(tokens.html).toContain('/app/notifications');
  expect(tokens.html).not.toContain('Change password');
  // It gained the column that answers "which machine is this token?".
  expect(tokens.html).toContain('Machine it reports as');
});

it('splits the team page into tabs, and keeps the tab in the URL', async () => {
  const overview = await page('/app/teams/v2-team');
  expect(overview.html).toContain('Observed workspace activity');
  expect(overview.html).toContain('2 agents active (7d)');
  expect(overview.html).not.toContain('<h3>Connect your agent</h3>');
  expect(overview.html).toContain('?tab=people');
  // Members and invites are one tab away, not three screens down the scroll.
  expect(overview.html).not.toContain('Invite links');

  const people = await page('/app/teams/v2-team?tab=people');
  expect(people.html).toContain('Invite links');
  expect(people.html).toContain('Members');

  const integrations = await page('/app/teams/v2-team?tab=integrations');
  expect(integrations.html).toContain('Inbound hooks');

  const settings = await page('/app/teams/v2-team?tab=settings');
  expect(settings.html).toContain('Danger zone');

  // An unknown tab is the overview rather than an error: the tab is a view, and
  // a typo in a pasted link should still show somebody their team.
  const nonsense = await page('/app/teams/v2-team?tab=zzz');
  expect(nonsense.status).toBe(200);
  expect(nonsense.html).toContain('Observed workspace activity');

  const map = await page('/app/agents');
  expect(map.html).toContain('active projects <b>1</b>');
});

it('offers the workspace switcher only when there is somewhere to switch to', async () => {
  const one = await page('/app/teams/v2-team');
  // One workspace: a link to it, not a control that cannot do anything.
  expect(one.html).toContain('<a class="scope-at" href="/app/teams/v2-team" title="This workspace">');
  expect(one.html).not.toContain('title="Switch workspace"');

  await form(`${srv.url}/app/teams`, { name: 'Second Team' }, { cookie });
  const two = await page('/app/teams/v2-team');
  expect(two.html).toContain('title="Switch workspace"');
  expect(two.html).toContain('All workspaces');
  expect(two.html).toContain('Second Team');

  // A scoped route, not membership creation order, owns the rail context: the
  // newest workspace is Second Team, and this page is still about the first.
  const firstTeam = await page('/app/teams/v2-team');
  expect(firstTeam.html).toContain('class="rail-group">Workspace</span>');
  // The rail lists this scope's sections and nothing that pours every workspace together.
  expect(firstTeam.html).not.toContain('Across workspaces');
  expect(firstTeam.html).toContain('href="/app/agents?team=v2-team"');
  expect(firstTeam.html).toContain(
    'class="rail-link active" href="/app/teams/v2-team">Overview</a>',
  );
  expect(firstTeam.html).toContain('href="/app/teams/v2-team/projects"');
  expect(firstTeam.html).toContain('href="/app/teams/v2-team/governance"');
  expect(firstTeam.html).not.toContain('href="/app/teams/second-team/projects"');

  const secondTeam = await page('/app/teams/second-team');
  expect(secondTeam.html).toContain('href="/app/teams/second-team/projects"');
  expect(secondTeam.html).toContain('href="/app/teams/second-team/delivery"');
});

it('shows a stranger the documentation and an honest sentence, not a product page', async () => {
  // The pre-launch face of the hosted service. `SITE_MODE=teaser` is a claim
  // about who the marketing is for; it must not become a second product.
  const dir = mkdtempSync(path.join(tmpdir(), 'stma-teaser-'));
  const teaser = await startServer(
    loadEnv({
      port: 0,
      host: '127.0.0.1',
      nodeEnv: 'test',
      devMode: true,
      databaseUrl: undefined,
      pgliteDir: dir,
      publicMode: 'teaser',
      signupsOpen: false,
    }),
  );
  try {
    const landing = await (await fetch(`${teaser.url}/`)).text();
    // Signups are closed on this instance, so the page must not offer a door
    // that is not there — no access-code call to action without codes set.
    expect(landing).toContain('private beta');
    expect(landing).not.toContain('I have an access code');
    // A "coming soon" page with nothing to do is a page nobody returns to: the
    // packages are real, public and need no invite.
    expect(landing).toContain('npx @matteai/stma serve');
    expect(landing).toContain('/docs');
    expect(landing).not.toContain('Let your agents compare notes');

    // A stranger gets the MCP half; the console sections describe a product they
    // cannot reach yet, and a table of contents may not point at a section that
    // is not there.
    const docs = await (await fetch(`${teaser.url}/docs`)).text();
    expect(docs).toContain('Tool reference');
    expect(docs).toContain('Paste-ready prompts');
    expect(docs).not.toContain('The console (for humans)');
    expect(docs).not.toContain('href="#dashboard"');

    // Help is public on the same rule the legal pages are: a person who cannot
    // sign in cannot read a page behind the login, and that person is exactly
    // the one this page exists for. Its sign-in half is therefore always there.
    const help = await fetch(`${teaser.url}/help`);
    expect(help.status, '/help must answer a stranger').toBe(200);
    const helpHtml = await help.text();
    expect(helpHtml).toContain('That access code is not valid');
    expect(helpHtml).toContain('Too many sign-in attempts for this email address');
    // A stranger has no account, so no enrollment code and no running agent:
    // every section about connecting and running agents is console content and
    // follows the same rule as the guide's, index and contents included.
    for (const gated of ['connect', 'working', 'coordinate', 'refusals', 'environments', 'integrations', 'limits']) {
      expect(helpHtml, `#${gated} is console content`).not.toContain(`id="${gated}"`);
      expect(helpHtml, `#${gated} must not be in the index`).not.toContain(`href="#${gated}"`);
    }
    expect(helpHtml).not.toContain('stma adapter repair --pin-runtime --apply');
    // What is left still has to be worth reading on its own, and the index at
    // the top is how somebody gets to it.
    expect(helpHtml).toContain('class="helpidx"');
    expect(helpHtml).toContain('href="#signin"');
    expect(helpHtml).toContain('id="selfhost"');
    expect(helpHtml).toContain('id="expected"');

    // An invited member sees the whole thing on the same instance — this is not
    // a reduced build.
    const login = await fetch(`${teaser.url}/auth/dev`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'invited' }),
      redirect: 'manual',
    });
    const cookies = login.headers
      .getSetCookie()
      .map((line) => line.split(';')[0]!)
      .join('; ');
    const member = await (await fetch(`${teaser.url}/docs`, { headers: { cookie: cookies } })).text();
    expect(member).toContain('The console (for humans)');
    expect((await fetch(`${teaser.url}/app`, { headers: { cookie: cookies } })).status).toBe(200);
    const memberHelp = await (
      await fetch(`${teaser.url}/help`, { headers: { cookie: cookies } })
    ).text();
    expect(memberHelp).toContain('id="connect"');
    expect(memberHelp).toContain('id="working"');
    expect(memberHelp).toContain('id="coordinate"');
    expect(memberHelp).toContain('id="refusals"');
    expect(memberHelp).toContain('id="environments"');
    expect(memberHelp).toContain('id="integrations"');
    expect(memberHelp).toContain('stma adapter repair --pin-runtime --apply');
    // Plan ceilings exist only where plans decide something. This instance is
    // not the hosted service, so the section is not a door it has.
    expect(memberHelp).not.toContain('id="limits"');
    expect(memberHelp).not.toContain('Device limit reached');
  } finally {
    await teaser.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('names the walls people actually hit, in the words the product prints', async () => {
  // The value of this page is entirely in whether somebody can find their own
  // error on it, so it quotes the strings verbatim. Each of these was hit by a
  // real person or a real agent in this repository's own rounds; if one ever
  // stops matching what the product says, the page has drifted into a FAQ.
  const res = await fetch(`${srv.url}/help`);
  expect(res.status, '/help must be readable with no account').toBe(200);
  const html = await res.text();
  for (const printed of [
    'That access code is not valid',
    'Too many sign-in codes were requested',
    'invite code is invalid, expired or used up',
    'Run this in a regular interactive terminal',
    'This checkout already has local profile',
    'Not confirmed yet',
    'work_conflict',
    'stale_ground',
    'unknown_or_inactive_run',
    'PostgreSQL 17',
    // The 2026-09-22 sweep: the refusals an agent meets, the environment and
    // integration answers, and the two boot refusals a self-hoster hits first.
    'Invalid email or password.',
    'has not been confirmed. Sign-in codes and password resets go there',
    'Unknown parameter',
    'is not an id STMA issued',
    'Loop guard: more than',
    'a cross-project environment diff is not meaningful',
    'This snapshot carried no envVarNames',
    'The token was refused',
    'Jira refused the credentials on both API doors',
    'X-Hub-Signature-256 mismatch',
    'DATABASE_URL is required in production',
    'is not a CIDR range like',
  ]) {
    expect(html, `somebody searching for "${printed}" must land on an answer`).toContain(printed);
  }
  // An index that names each section, and a count beside it, is how a page this
  // long stays usable.
  expect(html).toContain('class="helpidx"');
  expect(html).toContain('href="#refusals"');
  // This instance sets no SUPPORT_EMAIL or PRIVACY_EMAIL, so the page must not
  // invent a door — and must still not end in silence.
  expect(html).not.toContain('mailto:');
  expect(html).toContain('publishes no support address');
});

it('quotes only what the product actually prints', () => {
  // The page is worth having only if somebody can search for the string on their
  // screen and find it, so every quote names the file that prints it and the
  // literal that must appear there. This reads those files: when a message is
  // reworded and the page is not, the page has quietly become a FAQ, and this
  // goes red instead of a person discovering it while they are already stuck.
  const packages = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
  const sources = new Map<string, string>();
  const source = (rel: string) => {
    const cached = sources.get(rel);
    if (cached !== undefined) return cached;
    const text = readFileSync(path.join(packages, rel), 'utf8');
    sources.set(rel, text);
    return text;
  };

  let checked = 0;
  for (const section of helpSections()) {
    for (const entry of section.entries) {
      for (const quote of entry.quotes ?? []) {
        const find = quote.find ?? quote.text;
        // The example values a quote fills in may not contradict the fixed words.
        expect(quote.text, `the quote must contain the words it claims: ${find}`).toContain(find);
        if (!quote.from) {
          // Printed by another program, or by the private hosted layer, whose
          // source is not in the tree this suite runs in. Either way it says so.
          expect(
            Boolean(quote.by || quote.hostedOnly),
            `"${find}" must name who prints it`,
          ).toBe(true);
          continue;
        }
        // Only the packages tree: this file ships to the public mirror, which
        // has no `ee/` and no `docs/`.
        expect(quote.from, `${quote.from} is not a public package source`).toMatch(
          /^(server|cli|shared)\/src\//,
        );
        expect(source(quote.from), `${quote.from} no longer prints: ${find}`).toContain(find);
        checked += 1;
      }
    }
  }
  // A reference, not a handful of examples. The number only ever goes up.
  expect(checked).toBeGreaterThanOrEqual(80);
});

it('indexes every section it draws, and draws every section it indexes', async () => {
  const html = await (await fetch(`${srv.url}/help`)).text();
  const drawn = [...html.matchAll(/<section class="doc-section" id="([a-z-]+)"/g)].map((m) => m[1]!);
  const indexed = new Set(
    [...html.matchAll(/href="#([a-z-]+)"/g)].map((m) => m[1]!),
  );
  expect(drawn.length, 'the page should have its sections').toBeGreaterThan(5);
  for (const id of drawn) expect([...indexed], `#${id} must be reachable from the index`).toContain(id);
  for (const id of indexed) expect(drawn, `the index must not point at a missing #${id}`).toContain(id);
});

it('links help from every footer a signed-out reader can reach', async () => {
  // Signed out, because that is the reader who needs it; the three marketing
  // footers are hand-rolled copies and have drifted before.
  for (const route of ['/', '/docs', '/terms', '/privacy']) {
    const html = await (await fetch(`${srv.url}${route}`)).text();
    expect(html, `${route} should link /help`).toContain('href="/help"');
  }
  // And on the pages somebody stuck is actually looking at.
  for (const route of ['/login', '/signup']) {
    const html = await (await fetch(`${srv.url}${route}`)).text();
    expect(html, `${route} should point at the troubleshooting page`).toContain('/help#signin');
  }
});

it('reads the docs as a document with a table of contents beside it', async () => {
  const docs = await page('/docs');
  expect(docs.status).toBe(200);
  expect(docs.html).toContain('class="docgrid"');
  expect(docs.html).toContain('class="sidetoc"');
  // Every entry has to point at a section that exists — a table of contents
  // with a dead link is worse than none.
  for (const id of ['how', 'web', 'connect', 'tools', 'prompts', 'dashboard', 'security']) {
    expect(docs.html, `#${id} must exist`).toContain(`id="${id}"`);
    expect(docs.html).toContain(`href="#${id}"`);
  }
});
