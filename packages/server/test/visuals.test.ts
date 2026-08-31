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
      host: 'localhost',
      nodeEnv: 'test',
      devMode: true,
      databaseUrl: undefined,
      pgliteDir: dataDir,
    }),
  );

  const ada = await signIn('ada');
  await form(`${srv.url}/app/teams`, { name: 'Pictures' }, ada.header());
  const adaToken = await tokenFor(ada.header(), 'ada-macbook');

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
  expect(html).toContain('Activation funnel');
  // The funnel steps carry prose, not just bars — a number nobody can interpret
  // is a number nobody acts on.
  expect(html).toContain('Second member');
  expect(html).toContain('Fleet activated');
  expect(html).toContain('funnelnote');
  expect(html).toContain('Teams by activity');
  expect(html).toContain('Calls today');
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
    // The rail is the whole navigation now, so every destination must be on it.
    for (const link of ['/app/agents', '/app/sessions', '/app/tokens', '/docs']) {
      expect(html, `${path} lost the ${link} link`).toContain(`href="${link}"`);
    }
    // The old top nav must be gone, not merely hidden.
    expect(html, `${path} still renders the old nav`).not.toContain('class="appnav"');
  }
});

it('counts on the rail agree with the pages behind them', async () => {
  const html = await (
    await fetch(`${srv.url}/app/agents`, { headers: (await signIn('ada')).header() })
  ).text();
  // Two runs are live in this fixture, and the rail says so next to Agent map.
  expect(/Agent map<span class="rail-badge">2<\/span>/.test(html)).toBe(true);
  expect(html).toContain('2 runs');
  // A badge is only drawn when there is something to report.
  expect(html).not.toContain('rail-badge">0<');
});

it('gives the team-scoped rail links a team, and the picker when there is none', async () => {
  const withTeam = await (
    await fetch(`${srv.url}/app/agents`, { headers: (await signIn('ada')).header() })
  ).text();
  expect(withTeam).toContain('/app/teams/pictures/governance');
  expect(withTeam).toContain('/app/teams/pictures/activity');

  // Somebody with no team must not be handed a link to /app/teams/null/...
  const loner = await signIn('loner');
  const html = await (await fetch(`${srv.url}/app/tokens`, { headers: loner.header() })).text();
  expect(html).not.toContain('teams/null');
  expect(html).not.toContain('teams/undefined');
  expect(html).toContain('no team yet');
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
    ['/app', 'Teams'],
    ['/app/agents', 'Agent map'],
    ['/app/tokens', 'Tokens'],
    ['/app/sessions', 'Sessions'],
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
