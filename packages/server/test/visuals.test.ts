import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

/**
 * The pictures: the system diagram on /docs, the visual agent map, and the
 * fleet panel in the operator console. They are the surfaces most likely to
 * rot silently — nothing throws when a diagram stops being drawn — so each one
 * is asserted on its rendered markup rather than on a status code.
 */

let srv: StartedServer;
let dataDir: string;
let adaToken = '';
let adaIdleId = '';

function jar() {
  const cookies = new Map<string, string>();
  return {
    header: (): Record<string, string> =>
      cookies.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {},
    store(res: Response) {
      for (const line of res.headers.getSetCookie()) {
        const [kv] = line.split(';');
        const i = kv!.indexOf('=');
        cookies.set(kv!.slice(0, i), kv!.slice(i + 1));
      }
    },
  };
}

const form = (url: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });

const api = (url: string, body: unknown, token: string) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

async function signIn(username: string) {
  const j = jar();
  j.store(await form(`${srv.url}/auth/dev`, { username }));
  return j;
}

async function tokenFor(cookie: Record<string, string>, name: string) {
  const res = await fetch(`${srv.url}/app/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...cookie },
    body: new URLSearchParams({ name }),
  });
  const token = /stma_[0-9a-f]{40}/.exec(await res.text())?.[0] ?? '';
  expect(token, `no token issued for ${name}`).toBeTruthy();
  return token;
}

/** Registers an agent and starts a run claiming the shared migration. */
async function runClaiming(token: string, agent: string, client: string, task: string) {
  const install = await api(
    `${srv.url}/api/agent/installations/register`,
    { name: agent, clientType: client, deviceFingerprint: `device-${agent}` },
    token,
  );
  expect(install.status).toBe(200);
  const installationId = ((await install.json()) as { installation: { id: string } }).installation
    .id;
  const started = await api(
    `${srv.url}/api/agent/runs/start`,
    {
      installationId,
      team: 'pictures',
      project: 'payments-api',
      taskKey: task,
      branch: `feat/${task.toLowerCase()}`,
      claims: [
        { resourceType: 'migration', resourceKey: 'refunds-ledger', access: 'write' },
        { resourceType: 'path', resourceKey: 'src/payments/refund.ts', access: 'write' },
        // Read-only, and keyed per run so it can never overlap: reading a
        // contract is not changing it, and the graph has to draw that
        // difference or the picture says every line is a claim on the ground.
        { resourceType: 'path', resourceKey: `docs/${task.toLowerCase()}.md`, access: 'read' },
      ],
    },
    token,
  );
  expect(started.status).toBe(200);
  return started;
}

beforeAll(async () => {
  process.env.ADMIN_USERNAMES = 'ada';
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-visuals-'));
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

  const ada = await signIn('ada');
  await form(`${srv.url}/app/teams`, { name: 'Pictures' }, ada.header());
  adaToken = await tokenFor(ada.header(), 'ada-macbook');

  // A second human in the same team, so the map has two people to draw.
  const invite = await form(`${srv.url}/app/teams/pictures/invites`, {}, ada.header());
  expect(invite.status).toBe(302);
  // The join code only ever appears on the team page, never in the redirect.
  const teamPage = await (
    await fetch(`${srv.url}/app/teams/pictures?tab=people`, { headers: ada.header() })
  ).text();
  const code = /\/join\/([A-Za-z0-9_-]+)/.exec(teamPage)?.[1] ?? '';
  expect(code, 'invite code').toBeTruthy();
  const bo = await signIn('bo');
  const joined = await form(`${srv.url}/join/${code}`, {}, bo.header());
  expect(joined.status).toBe(302);
  const boToken = await tokenFor(bo.header(), 'bo-desktop');

  await runClaiming(adaToken, 'ada-claude', 'claude-code', 'PAY-1');
  await runClaiming(boToken, 'bo-cursor', 'cursor', 'PAY-2');
  const idle = await api(
    `${srv.url}/api/agent/installations/register`,
    {
      name: 'ada-reviewer-idle',
      clientType: 'codex',
      deviceFingerprint: 'device-ada-reviewer-idle',
      role: 'reviewer',
    },
    adaToken,
  );
  expect(idle.status).toBe(200);
  adaIdleId = ((await idle.json()) as { installation: { id: string } }).installation.id;
});

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ADMIN_USERNAMES;
});

// ---------------------------------------------------------------- docs diagram

it('draws the system diagram on /docs, signed out and signed in', async () => {
  for (const headers of [{}, (await signIn('ada')).header()]) {
    const html = await (await fetch(`${srv.url}/docs`, { headers })).text();
    expect(html).toContain('id="how"');
    expect(html).toContain('How it works');
    // The drawing itself, not just its heading.
    expect(html).toContain('<svg viewBox="0 0 1000 650"');
    expect(html).toContain('class="dg-plane"');
    expect(html).toContain('THE CONTROL PLANE');
    expect(html).toContain('WHAT THE TEAM SEES');
    // Both transports are named, because that split is the thing being taught.
    expect(html).toContain('MCP · /mcp');
    expect(html).toContain('/api/agent');
    // The privacy claim travels with the picture.
    expect(html).toContain('never leave the machine');
    // Prose stays at reading width; the diagram gets the whole container.
    expect(html).toContain('class="doc-col"');
    expect(html).not.toContain('style="max-width:860px"');
  }
});

it('describes the diagram for readers who cannot see it', async () => {
  const html = await (await fetch(`${srv.url}/docs`)).text();
  expect(html).toContain('role="img"');
  expect(html).toContain('<title id="dg-title">How STMA works</title>');
  expect(html).toContain('<desc id="dg-desc">');
});

// ---------------------------------------------------------------- agent map

it('lays the runs out as a ledger with an inspector on the selected one', async () => {
  const html = await (
    await fetch(`${srv.url}/app/agents`, { headers: (await signIn('ada')).header() })
  ).text();

  // The console grammar: rail, status strip, ledger, inspector, key hints.
  expect(html).toContain('class="rail"');
  expect(html).toContain('class="strip"');
  expect(html).toContain('class="ledger"');
  expect(html).toContain('class="inspector"');
  expect(html).toContain('Run / owner');
  expect(html).toContain('Scope held');

  // Both runs are in the ledger, and selecting one is a link, not script.
  expect(html).toContain('ada-claude');
  expect(html).toContain('bo-cursor');
  expect(html).toContain('/app/agents?run=');

  // The band names the collision and keeps saying claims are advisory.
  expect(html).toContain('migration:refunds-ledger');
  expect(html).toContain('does not lock the file');

  // The inspector carries the authority half: scope, compliance, trail.
  expect(html).toContain('Compliance');
  expect(html).toContain('Trail');
  expect(html).toContain('class="holds hot"');

  // And it names the other side. "Overlaps another live run — high." told a
  // human less than the MCP reply told their agent, which is backwards: the
  // inspector is where somebody decides who to go and talk to.
  expect(html).toContain('Overlaps <b>ada/PAY-1</b> \u2014 critical.');
  expect(html).toContain('migration:refunds-ledger');
  // ada and bo also overlap on a path, and the second one is counted, not
  // dropped — silently showing the worst of several is how a page starts lying.
  expect(html).toContain('+1 more');
});

it('keeps idle agent identities visible and lets only their owner disable them durably', async () => {
  const ada = await signIn('ada');
  // The inventory is the map's second tab now: it used to sit under every live
  // run, where reaching an idle identity meant scrolling past the whole fleet.
  const before = await (
    await fetch(`${srv.url}/app/agents?tab=identities`, { headers: ada.header() })
  ).text();
  expect(before).toContain('Agent inventory');
  expect(before).toContain('ada-reviewer-idle');
  expect(before).toContain('Registered; no run yet');
  expect(before).toContain('>idle</span>');
  const inventory = before.slice(before.indexOf('Agent inventory'));
  expect(inventory.indexOf('ada-claude')).toBeLessThan(inventory.indexOf('ada-reviewer-idle'));
  expect(inventory.indexOf('bo-cursor')).toBeLessThan(inventory.indexOf('ada-reviewer-idle'));

  const bo = await signIn('bo');
  const outsiderAttempt = await form(
    `${srv.url}/app/agents/installations/${adaIdleId}/revoke`,
    {},
    bo.header(),
  );
  expect(outsiderAttempt.status).toBe(302);
  expect(decodeURIComponent(outsiderAttempt.headers.get('location') ?? '')).toContain('not yours');

  const disabled = await form(
    `${srv.url}/app/agents/installations/${adaIdleId}/revoke`,
    {},
    ada.header(),
  );
  expect(disabled.status).toBe(302);
  expect(decodeURIComponent(disabled.headers.get('location') ?? '')).toContain(
    'Disabled ada-reviewer-idle',
  );

  // Repeating registration with the same device identity must not undo a
  // human's decision — otherwise the next lifecycle hook re-enables it.
  const retry = await api(
    `${srv.url}/api/agent/installations/register`,
    {
      name: 'ada-reviewer-idle',
      clientType: 'codex',
      deviceFingerprint: 'device-ada-reviewer-idle',
      role: 'reviewer',
    },
    adaToken,
  );
  expect(retry.status).toBe(409);
  expect((await retry.json()) as object).toMatchObject({ error: 'installation_revoked' });

  const after = await (
    await fetch(`${srv.url}/app/agents?tab=identities`, { headers: ada.header() })
  ).text();
  const row = after.split('<tr').find((part) => part.includes('ada-reviewer-idle')) ?? '';
  expect(row).toContain('>disabled</span>');
  expect(row).not.toContain('>Disable</button>');
});

it('draws the scope graph from the same conflict result the ledger badges use', async () => {
  const html = await (
    await fetch(`${srv.url}/app/agents`, { headers: (await signIn('ada')).header() })
  ).text();
  // The picture and the words come from one detection pass. If the graph ever
  // recomputed "contested" for itself, this is the assertion that would catch a
  // red box next to a clear badge.
  expect(html).toContain('Scope graph');
  expect(html).toContain('class="sg"');
  expect(html).toContain('sg-link hot');
  expect(html).toContain('sg-box hot');
  // Read claims are drawn, and drawn differently from writes.
  expect(html).toContain('sg-link read');

  // A scope is selectable, and selecting one answers "who else is on this".
  const scope = /href="([^"]*scope=[^"]*)"/.exec(html)?.[1];
  expect(scope).toBeTruthy();
  const picked = await (
    await fetch(`${srv.url}${scope!.replace(/&amp;/g, '&')}`, {
      headers: (await signIn('ada')).header(),
    })
  ).text();
  expect(picked).toContain('Held by');
  expect(picked).toContain('Held for write by more than one live run');
});

it('filters the map to critical without changing what the strip counts', async () => {
  const html = await (
    await fetch(`${srv.url}/app/agents?only=critical`, { headers: (await signIn('ada')).header() })
  ).text();
  expect(html).toContain('showing only');
  expect(html).toContain('critical only');
  // The counts describe the team, not the filter: a status strip that changed
  // with the view would make "1 critical" mean two different things.
  expect(html).toContain('2 runs');
});

it('counts each collision once, in the number the strip reports', async () => {
  const html = await (
    await fetch(`${srv.url}/app/agents`, { headers: (await signIn('ada')).header() })
  ).text();
  // ada and bo overlap on both the migration and the path. Detection sees each
  // from both sides, so without deduplication the strip would claim two
  // criticals and the band would offer to show one more that does not exist.
  expect(html).toContain('1 critical');
  expect(html).not.toContain('2 critical');
  expect(html).not.toContain('more overlap');
});

// ---------------------------------------------------------------- admin fleet

it('shows who has which agent in the operator console', async () => {
  const html = await (await fetch(`${srv.url}/admin`, { headers: (await signIn('ada')).header() })).text();
  expect(html).toContain('Who has which agent');
  expect(html).toContain('agentchip');
  expect(html).toContain('ada-claude · claude-code');
  expect(html).toContain('bo-cursor · cursor');
  // Bars for the client mix and for who is running right now.
  expect(html).toContain('Agent clients');
  expect(html).toContain('Running right now');
  expect(html).toContain('class="barrow"');
  expect(html).toContain('class="fill k0"');
  expect(html).toContain('1 device · 1 agent');
});

it('keeps the fleet panel out of reach of non-operators', async () => {
  const bo = await signIn('bo');
  expect((await fetch(`${srv.url}/admin`, { headers: bo.header() })).status).toBe(404);
});

it('renders the usage console: windows, funnel and per-team activity', async () => {
  const html = await (
    await fetch(`${srv.url}/admin/usage`, { headers: (await signIn('ada')).header() })
  ).text();
  expect(html).toContain('Monthly active humans');
  expect(html).toContain('data-metric="mau"');
  expect(html).toContain('Independent feature adoption counts');
  expect(html).toContain('Launch cohorts');
  // The funnel steps carry prose, not just bars — a number nobody can interpret
  // is a number nobody acts on.
  expect(html).toContain('Second member');
  expect(html).toContain('Fleet activated');
  expect(html).toContain('funnelnote');
  expect(html).toContain('Teams by activity');
  expect(html).toContain('Calls today');
  expect(html).toContain('Pilot value and cost signals');
  expect(html).toContain('data-metric="first-real-results"');
  expect(html).toContain('data-metric="measured-run-cost"');
  expect(html).toContain('Estimated run cost');
  expect(html).toContain('Economic source coverage');
  expect(html).toContain('Support time by workspace / project');
  expect(html).toContain('No managed-job cost source');
  expect(html).toContain('Four-week pilot observation plan');
  expect(html).toContain('W4');
  // And it is behind the same operator gate as the rest of /admin.
  const bo = await signIn('bo');
  expect((await fetch(`${srv.url}/admin/usage`, { headers: bo.header() })).status).toBe(404);
});

// ---------------------------------------------------------------- console shell

it('draws the same console chrome on every signed-in page', async () => {
  const ada = await signIn('ada');
  for (const path of ['/app', '/app/agents', '/app/tokens', '/app/sessions', '/docs']) {
    const html = await (await fetch(`${srv.url}${path}`, { headers: ada.header() })).text();
    expect(html, `${path} lost the rail`).toContain('class="rail"');
    expect(html, `${path} lost the scope bar`).toContain('class="scopebar"');
    // Rail and scope bar are the whole navigation, so every destination must be
    // on one of them. These are account pages: they offer the workspaces and the
    // person's own pages, and no longer a map or a sessions list that mixes every
    // workspace (phase 4 of the console plan) — those numbers are on /app, per workspace.
    for (const link of ['/app', '/app/teams/pictures', '/app/tokens', '/docs']) {
      expect(html, `${path} lost the ${link} link`).toContain(`href="${link}"`);
    }
    // The old top nav must be gone, not merely hidden.
    expect(html, `${path} still renders the old nav`).not.toContain('class="appnav"');
  }
});

it('counts on the rail agree with the pages behind them', async () => {
  const ada = await signIn('ada');
  const html = await (await fetch(`${srv.url}/app/agents?team=pictures`, { headers: ada.header() })).text();
  // Two runs are live in this fixture, and the rail says so next to Agent map.
  expect(/Agent map<span class="rail-badge">2<\/span>/.test(html)).toBe(true);
  // The list of workspaces says the same number for the same workspace, as a link to that map.
  const home = await (await fetch(`${srv.url}/app`, { headers: ada.header() })).text();
  expect(home).toContain('<a href="/app/agents?team=pictures">2</a>');
  expect(html).toContain('2 runs');
  // A badge is only drawn when there is something to report.
  expect(html).not.toContain('rail-badge">0<');
});

it('gives the team-scoped rail links a team, and the picker when there is none', async () => {
  const withTeam = await (
    await fetch(`${srv.url}/app/agents`, { headers: (await signIn('ada')).header() })
  ).text();
  // Unscoped, the map is an account page: it offers the workspace, not its sections.
  expect(withTeam).toContain('href="/app/teams/pictures"');
  const inside = await (
    await fetch(`${srv.url}/app/agents?team=pictures`, { headers: (await signIn('ada')).header() })
  ).text();
  expect(inside).toContain('/app/teams/pictures/governance');
  expect(inside).toContain('/app/teams/pictures/activity');

  // Somebody with no team must not be handed a link to /app/teams/null/...
  const loner = await signIn('loner');
  const html = await (await fetch(`${srv.url}/app/tokens`, { headers: loner.header() })).text();
  expect(html).not.toContain('teams/null');
  expect(html).not.toContain('teams/undefined');
  expect(html).toContain('no workspace yet');
});

it('exports the activity log as a real file, not a dead button', async () => {
  const ada = await signIn('ada');
  const res = await fetch(`${srv.url}/app/teams/pictures/activity.csv`, { headers: ada.header() });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/csv');
  expect(res.headers.get('content-disposition')).toContain('stma-pictures-activity-');
  const body = await res.text();
  expect(body.split('\r\n')[0]).toBe('"at","team","project","person","agent","action","detail"');
  expect(body).toContain('"run_started"');
  // Quoted per RFC 4180, so a detail containing a comma cannot shift a column.
  expect(body).toContain('"pictures"');

  // Same team gate as the page it belongs to.
  const outsider = await signIn('outsider');
  expect(
    (await fetch(`${srv.url}/app/teams/pictures/activity.csv`, { headers: outsider.header() }))
      .status,
  ).toBe(404);
});

it('offers freeze wherever the page reloads itself', async () => {
  const ada = await signIn('ada');
  for (const path of ['/app/agents', '/app/teams/pictures/activity']) {
    const html = await (await fetch(`${srv.url}${path}`, { headers: ada.header() })).text();
    // A live page that reloads under you while you are reading is hostile; the
    // control and the state it reports both have to be there.
    expect(html, `${path} has no freeze control`).toContain('data-freeze="t"');
    expect(html, `${path} does not report its polling state`).toContain('data-freeze-state=');
    expect(html).toContain('data-autorefresh');
  }
});

// ------------------------------------------------------ the typefaces, served

it('serves Geist and Geist Mono from this origin, content-hashed and immutable', async () => {
  // The design system has named these two faces since the first screen, and no
  // page ever loaded them: `Head` takes no third-party font stylesheet, so every
  // visitor without Geist installed read the product in their system font.
  const html = await (await fetch(`${srv.url}/`)).text();
  const preload = /href="(\/fonts\/geist\.[0-9a-f]{10}\.woff2)"/.exec(html)?.[1];
  expect(preload, 'the page must preload the sans face it will use').toBeTruthy();

  const cssUrl = /href="(\/style\.[0-9a-f]{10}\.css)"/.exec(html)![1]!;
  const sheet = await (await fetch(`${srv.url}${cssUrl}`)).text();
  expect(sheet).toContain("font-family: 'Geist'");
  expect(sheet).toContain("font-family: 'Geist Mono'");
  // A slow connection shows the words first and swaps the face in after.
  expect(sheet).toContain('font-display: swap');
  const monoUrl = /url\((\/fonts\/geist-mono\.[0-9a-f]{10}\.woff2)\)/.exec(sheet)?.[1];
  expect(monoUrl, 'the stylesheet must point at a fingerprinted mono face').toBeTruthy();

  for (const url of [preload!, monoUrl!]) {
    const font = await fetch(`${srv.url}${url}`);
    expect(font.status, url).toBe(200);
    expect(font.headers.get('content-type')).toBe('font/woff2');
    expect(font.headers.get('cache-control')).toContain('immutable');
    const bytes = new Uint8Array(await font.arrayBuffer());
    // wOF2, the signature of the format the stylesheet asked for.
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('wOF2');
    expect(bytes.byteLength).toBeGreaterThan(20_000);
  }
});

// ------------------------------------------------------ the landing page

it('says what the product is now, and offers no door that is not there', async () => {
  const html = await (await fetch(`${srv.url}/`)).text();
  // The scope is the whole operation, not two agents comparing notes.
  expect(html).toContain('AgentOps');
  expect(html).not.toContain('Let your agents compare notes');
  // The six pillars, each named by the verb the console uses for it.
  for (const verb of ['See', 'Coordinate', 'Govern', 'Dispatch', 'Reproduce', 'Prove']) {
    expect(html, `the landing page must carry the ${verb} pillar`).toContain(`· ${verb}</span>`);
  }
  // The product is drawn, not described: the mock is the console's own shapes.
  expect(html).toContain('class="lx-window"');
  expect(html).toContain('class="lxg"');
  // Self-hosting needs no invitation, and the command is on the page.
  expect(html).toContain('npx @matteai/stma serve');
  // This instance has no managed billing composed, so it sells nothing.
  expect(html).not.toContain('href="/pricing"');
});

it('serves the stylesheet from a URL that changes when the stylesheet does', async () => {
  const html = await (await fetch(`${srv.url}/`)).text();
  const cssUrl = /href="(\/style\.[0-9a-f]{10}\.css)"/.exec(html)?.[1];
  const jsUrl = /src="(\/app\.[0-9a-f]{10}\.js)"/.exec(html)?.[1];
  expect(cssUrl, 'the page must link a fingerprinted stylesheet').toBeTruthy();
  expect(jsUrl, 'the page must link a fingerprinted script').toBeTruthy();

  // stma.ai sits behind a CDN that caches .css by extension for four hours
  // whether or not the origin asked. A deploy used to serve new markup against
  // the previous stylesheet; an immutable, content-addressed URL cannot go
  // stale, because new markup asks for a file no cache has seen.
  const asset = await fetch(`${srv.url}${cssUrl}`);
  expect(asset.status).toBe(200);
  expect(asset.headers.get('cache-control')).toContain('immutable');
  expect(asset.headers.get('content-type')).toContain('text/css');
  expect(await asset.text()).toContain('.rail-link');

  // The unhashed path still answers, for HTML already in a browser — and must
  // never be held anywhere.
  const legacy = await fetch(`${srv.url}/style.css`);
  expect(legacy.status).toBe(200);
  expect(legacy.headers.get('cache-control')).toBe('no-cache');
});

// ------------------------------------------------------ chrome tells the truth

it('highlights the rail item you are actually on', async () => {
  const ada = await signIn('ada');
  const expected: Array<[string, string]> = [
    ['/app', 'All workspaces'],
    ['/app/teams/pictures', 'Overview'],
    // Unscoped, the map and the lists are the account-level view of everything.
    ['/app/agents', 'All workspaces'],
    ['/app/tokens', 'My agent connections'],
    ['/app/tokens?team=pictures', 'Agent connections'],
    ['/app/agents?team=pictures', 'Agent map'],
    ['/app/sessions?team=pictures', 'Sessions'],
    ['/app/handoffs?team=pictures', 'Work'],
    ['/app/teams/pictures?tab=people', 'Members'],
    ['/app/notifications', 'Notifications'],
    ['/app/sessions', 'All workspaces'],
    ['/app/teams/pictures/governance', 'Governance'],
    ['/app/teams/pictures/activity', 'Activity'],
    // This one was wrong: the environment diff highlighted Teams, so the rail
    // said you were somewhere you were not, and clicking Teams looked like it
    // had taken you to compare.
    ['/app/teams/pictures/compare', 'Environments'],
  ];
  for (const [path, label] of expected) {
    const html = await (await fetch(`${srv.url}${path}`, { headers: ada.header() })).text();
    const active = [...html.matchAll(/class="rail-link active"[^>]*>([^<]*)/g)].map((m) =>
      m[1]!.trim(),
    );
    expect(active, `${path} highlights the wrong rail item`).toEqual([label]);
  }
});

it('groups personal controls under Account instead of presenting notifications as an inbox', async () => {
  const ada = await signIn('ada');
  const page = await (
    await fetch(`${srv.url}/app/notifications`, { headers: ada.header() })
  ).text();
  // An account page draws the account's rail: the person's own pages, and the
  // workspaces they can open — not the sections of whichever workspace is newest.
  expect(page).toContain('<span class="rail-group later">Account</span>');
  expect(page).not.toContain('class="rail-group">Workspace</span>');
  expect(page).toContain('Notification settings');
  expect(page).toContain('not a notification inbox');
  expect(page).toContain('Back to account');
});

it('keeps every class in the stylesheet defined exactly once', async () => {
  const { css } = await import('../src/ui/styles');
  const counts = new Map<string, number>();
  for (const match of css.matchAll(/^([.#][^{}\n]*?)\s*\{/gm)) {
    const selector = match[1]!.trim();
    counts.set(selector, (counts.get(selector) ?? 0) + 1);
  }
  const duplicates = [...counts].filter(([, n]) => n > 1).map(([s]) => s);
  // `.checkrow` was written twice — a clickable form row and a plain ✓/✗ line.
  // The second won on colour and font while the first still handed the lists a
  // border and a pointer cursor, and nothing failed to say so.
  expect(duplicates, `these selectors are defined more than once: ${duplicates.join(', ')}`).toEqual(
    [],
  );
});

it('does not dress a count as the docs step number', async () => {
  const { css } = await import('../src/ui/styles');
  // `.num` is a black circle with white text. Reusing the name for the admin
  // bar-list count inherited the circle and overrode only the colour, which
  // rendered as dark grey on near-black — unreadable, and invisible to tests
  // that only look at markup.
  expect(css).toContain('.barrow .barval');
  expect(css).not.toContain('.barrow .num');
  const html = await (
    await fetch(`${srv.url}/admin/usage`, { headers: (await signIn('ada')).header() })
  ).text();
  expect(html).toContain('class="barval"');
  expect(html).not.toContain('class="num"');
});

it('draws the diagram no wider than the prose it explains', async () => {
  const { css } = await import('../src/ui/styles');
  // A figure wider than its own explanation reads as a poster. The cap and the
  // prose column have to agree, so they are asserted together.
  expect(css).toContain('.doc-col { max-width: 860px');
  expect(/\.diagram svg \{[^}]*max-width: 860px/.test(css)).toBe(true);
  const html = await (await fetch(`${srv.url}/docs`)).text();
  // Aspect ratio is the other half of "too big": the viewBox is what decides
  // how tall 860px of width turns out to be.
  expect(html).toContain('viewBox="0 0 1000 650"');
});

/**
 * Geist Mono is for text a machine wrote or will read, not for labels.
 *
 * It had become the console's label face — 97 rules on 2026-09-23, breadcrumbs
 * and role chips and counts and the whole status strip among them — and a page
 * where a third of the words are typewritten reads as a terminal emulator. The
 * rule is written at `--mono` in the stylesheet; this keeps the chrome honest
 * by naming the pieces that drifted, and keeps the pieces that should be
 * typewritten typewritten, because the fix for "too much mono" must not become
 * "no mono" and take the commands and paths with it.
 */
it('keeps the typewriter face for machine text and off the console chrome', async () => {
  const { css } = await import('../src/ui/styles');
  // Anchored at the line start so `a.holds { … }` is not read as `.holds`.
  const rule = (selector: string): string =>
    new RegExp(`^${selector.replace(/[.]/g, '\.')} \{([^}]*)\}`, 'm').exec(css)?.[1] ?? '';
  for (const selector of ['.crumb', '.chip', '.rail-badge', '.legend', '.msg-time', '.invmeta']) {
    expect(rule(selector), `${selector} is chrome and must not be typewritten`).not.toContain(
      'var(--mono)',
    );
  }
  // And the other half of the rule: these carry text somebody would paste.
  expect(css).toContain('code { font-family: var(--mono); }');
  for (const selector of ['.holds', '.toolrow .tn', '.flow-scope,.flow-device']) {
    expect(rule(selector), `${selector} carries machine text`).toContain('var(--mono)');
  }
});
