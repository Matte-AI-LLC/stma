import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
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
      host: 'localhost',
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

it('gives a project a page of its own, born from the run that named it', async () => {
  // Nothing to create: the project appears because an agent named a repository.
  const empty = await page('/app/teams/v2-team/projects');
  expect(empty.status).toBe(200);
  expect(empty.html).toContain('Nothing to create');

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
  expect(detail.html).toContain('Policy');
  expect(detail.html).toContain('Environment');
  expect(detail.html).toContain('PAY-1');
  // …each next to the page that owns it, rather than replacing it.
  expect(detail.html).toContain('/app/agents');
  expect(detail.html).toContain('/app/teams/v2-team/governance');

  // A project nobody has named is not a page.
  expect((await page('/app/teams/v2-team/projects/nope-api')).status).toBe(404);
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
  const map = await page('/app/agents');
  expect(map.html).toContain('critical');
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
  expect(overview.html).toContain('Team health');
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
  expect(nonsense.html).toContain('Team health');
});

it('offers the team switcher only when there is somewhere to switch to', async () => {
  const one = await page('/app/agents');
  // One team: a label, not a control that cannot do anything.
  expect(one.html).toContain('class="teamswitch"');
  expect(one.html).not.toContain('class="teampick"');

  await form(`${srv.url}/app/teams`, { name: 'Second Team' }, { cookie });
  const two = await page('/app/agents');
  expect(two.html).toContain('class="teampick"');
  expect(two.html).toContain('All teams');
  expect(two.html).toContain('Second Team');
});

it('shows a stranger the documentation and an honest sentence, not a product page', async () => {
  // The pre-launch face of the hosted service. `SITE_MODE=teaser` is a claim
  // about who the marketing is for; it must not become a second product.
  const dir = mkdtempSync(path.join(tmpdir(), 'stma-teaser-'));
  const teaser = await startServer(
    loadEnv({
      port: 0,
      host: 'localhost',
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
    expect(landing).toContain('Coming very soon');
    expect(landing).toContain('invite only');
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
  } finally {
    await teaser.close();
    rmSync(dir, { recursive: true, force: true });
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
