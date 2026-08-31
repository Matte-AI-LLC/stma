import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectDb } from '../src/db';
import { environmentChecks, projects, teams, users } from '../src/db/schema';
import { trimEnvironmentChecks } from '../src/domain/environments';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

interface CookieJar {
  header(): Record<string, string>;
  store(response: Response): void;
}

let server: StartedServer;
let dataDir: string;

let ownerJar: CookieJar;
let memberJar: CookieJar;
let strangerJar: CookieJar;
let ownerToken: string;
let memberToken: string;
/** Activity feed HTML captured either side of a heartbeat. */
let feedBeforeHeartbeat: string;
let feedAfterHeartbeat: string;

function cookieJar(): CookieJar {
  const cookies = new Map<string, string>();
  return {
    header(): Record<string, string> {
      if (!cookies.size) return {};
      return { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') };
    },
    store(response) {
      for (const line of response.headers.getSetCookie()) {
        const [keyValue] = line.split(';');
        const separator = keyValue!.indexOf('=');
        cookies.set(keyValue!.slice(0, separator), keyValue!.slice(separator + 1));
      }
    },
  };
}

async function devLogin(username: string): Promise<CookieJar> {
  const jar = cookieJar();
  const response = await fetch(`${server.url}/auth/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username }),
    redirect: 'manual',
  });
  jar.store(response);
  expect(response.status).toBe(302);
  return jar;
}

async function createToken(jar: CookieJar, name: string): Promise<string> {
  const response = await fetch(`${server.url}/app/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...jar.header() },
    body: new URLSearchParams({ name }),
  });
  expect(response.status).toBe(200);
  const token = /stma_[0-9a-f]{40}/.exec(await response.text())?.[0];
  expect(token).toBeTruthy();
  return token!;
}

async function createTeam(jar: CookieJar, name: string, slug: string): Promise<void> {
  const response = await fetch(`${server.url}/app/teams`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...jar.header() },
    body: new URLSearchParams({ name }),
    redirect: 'manual',
  });
  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe(`/app/teams/${slug}`);
}

async function inviteAndJoin(owner: CookieJar, slug: string, member: CookieJar): Promise<void> {
  const invite = await fetch(`${server.url}/app/teams/${slug}/invites`, {
    method: 'POST',
    headers: owner.header(),
    redirect: 'manual',
  });
  expect(invite.status).toBe(302);
  const teamPage = await fetch(`${server.url}/app/teams/${slug}?tab=people`, { headers: owner.header() });
  const code = /\/join\/([A-Za-z0-9_-]+)/.exec(await teamPage.text())?.[1];
  expect(code).toBeTruthy();
  const join = await fetch(`${server.url}/join/${code}`, {
    method: 'POST',
    headers: member.header(),
    redirect: 'manual',
  });
  expect(join.status).toBe(302);
}

function control(endpoint: string, token: string, body?: unknown) {
  return fetch(`${server.url}${endpoint}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function registerAgent(token: string, name: string): Promise<string> {
  const response = await control('/api/agent/installations/register', token, {
    name,
    clientType: 'claude-code',
    clientVersion: 'governance-test',
    deviceFingerprint: `governance-${name}`,
    capabilities: ['wrapper', 'preflight'],
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as any).installation.id as string;
}

/** track() is fire-and-forget by contract, so let its insert land before reading the feed. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

async function page(url: string, jar: CookieJar): Promise<{ status: number; html: string }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(`${server.url}${url}`, { headers: jar.header() });
      return { status: response.status, html: await response.text() };
    } catch (error) {
      // See post(): a reused keep-alive socket, not a failing page.
      if (attempt > 0) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

/** The slice of a page between two card titles, so a row assertion cannot match another table. */
function section(html: string, from: string, to: string): string {
  const start = html.indexOf(from);
  const end = html.indexOf(to);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

const rowsContaining = (html: string, needle: string): string[] =>
  html.split('<tr').filter((row) => row.includes(needle));

const baselineSnapshot = {
  os: { platform: 'linux', arch: 'x64' },
  runtimes: { node: '24.1.0' },
  packageManagers: { npm: '11.0.0' },
  lockfiles: [{ path: 'package-lock.json', hash: 'governance-lock-v1' }],
  envVarNames: ['PATH', 'CI'],
  git: { branch: 'main', sha: 'governance-base', dirtyFiles: [] },
  timezone: 'Europe/Istanbul',
};

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-governance-'));
  server = await startServer(
    loadEnv({
      port: 0,
      host: 'localhost',
      nodeEnv: 'test',
      devMode: true,
      databaseUrl: undefined,
      pgliteDir: dataDir,
    }),
  );

  ownerJar = await devLogin('gov-owner');
  memberJar = await devLogin('gov-member');
  strangerJar = await devLogin('gov-stranger');
  await createTeam(ownerJar, 'Governance Lab', 'governance-lab');
  await createTeam(ownerJar, 'Bare Team', 'bare-team');
  await inviteAndJoin(ownerJar, 'governance-lab', memberJar);
  await inviteAndJoin(ownerJar, 'bare-team', memberJar);

  ownerToken = await createToken(ownerJar, 'gov-owner-token');
  memberToken = await createToken(memberJar, 'gov-member-token');
  const ownerInstallation = await registerAgent(ownerToken, 'owner-claude');
  const memberInstallation = await registerAgent(memberToken, 'member-claude');

  const teamPolicy = await control('/api/control/policies', ownerToken, {
    team: 'governance-lab',
    document: {
      guidance: ['Ship behind a feature flag.'],
      permissions: { deny: ['push to main'], requireApproval: [] },
      requiredChecks: [],
      protectedPaths: [],
      environment: { requiredEnvVarNames: [], runtimes: {} },
    },
  });
  expect(teamPolicy.status).toBe(200);

  const published = await control('/api/control/policies', ownerToken, {
    team: 'governance-lab',
    project: 'billing-api',
    document: {
      guidance: ['Never edit a released invoice migration.'],
      permissions: { deny: ['read secret values'], requireApproval: ['production changes'] },
      requiredChecks: ['npm test'],
      protectedPaths: ['db/migrations/**'],
      environment: { requiredEnvVarNames: ['PATH', 'CI'], runtimes: { node: '24.1.0' } },
    },
  });
  expect(published.status).toBe(200);

  const baseline = await control('/api/control/environment-baselines', ownerToken, {
    team: 'governance-lab',
    project: 'billing-api',
    snapshot: baselineSnapshot,
  });
  expect(baseline.status).toBe(200);

  // The owner's agent applies the policy it was handed: a clean receipt.
  const ownerRunResponse = await control('/api/agent/runs/start', ownerToken, {
    installationId: ownerInstallation,
    team: 'governance-lab',
    project: 'billing-api',
    taskKey: 'GOV-CLEAN',
    intent: 'Add the invoice ledger',
    repo: 'billing-api',
    branch: 'feat/ledger',
    claims: [{ resourceType: 'path', resourceKey: 'src/ledger/**', access: 'write' }],
  });
  const ownerRun = (await ownerRunResponse.json()) as any;
  expect(ownerRunResponse.status).toBe(200);
  const cleanReceipt = await control(
    `/api/agent/runs/${ownerRun.run.id}/policy-receipt`,
    ownerToken,
    { expectedHash: ownerRun.policy.hash, reportedHash: ownerRun.policy.hash },
  );
  expect(((await cleanReceipt.json()) as any).receipt.drift).toBe(false);

  // The member's agent reports a policy nobody published: drift.
  const memberRunResponse = await control('/api/agent/runs/start', memberToken, {
    installationId: memberInstallation,
    team: 'governance-lab',
    project: 'billing-api',
    taskKey: 'GOV-DRIFT',
    intent: 'Rewrite the refund path',
    repo: 'billing-api',
    branch: 'feat/refunds',
    claims: [{ resourceType: 'path', resourceKey: 'src/refunds/**', access: 'write' }],
  });
  const memberRun = (await memberRunResponse.json()) as any;
  expect(memberRunResponse.status).toBe(200);
  const forgedHash = 'a'.repeat(64);
  const driftReceipt = await control(
    `/api/agent/runs/${memberRun.run.id}/policy-receipt`,
    memberToken,
    { expectedHash: forgedHash, reportedHash: forgedHash },
  );
  expect(((await driftReceipt.json()) as any).receipt.drift).toBe(true);

  const preflight = await control('/api/agent/environment/preflight', memberToken, {
    team: 'governance-lab',
    project: 'billing-api',
    runId: memberRun.run.id,
    snapshot: {
      ...baselineSnapshot,
      runtimes: { node: '20.11.0' },
      lockfiles: [{ path: 'package-lock.json', hash: 'governance-lock-drifted' }],
      envVarNames: ['PATH'],
      git: { branch: 'feat/refunds', sha: 'governance-drift', dirtyFiles: [] },
    },
  });
  expect(((await preflight.json()) as any).status).toBe('critical');

  // A clean machine checks in afterwards: newer, but it must not push the critical
  // verdict off the top of the table, and it is not feed-worthy either.
  const cleanPreflight = await control('/api/agent/environment/preflight', ownerToken, {
    team: 'governance-lab',
    project: 'billing-api',
    snapshot: baselineSnapshot,
  });
  expect(((await cleanPreflight.json()) as any).status).toBe('ok');

  await settle();
  feedBeforeHeartbeat = (await page('/app/teams/governance-lab/activity', ownerJar)).html;
  // A heartbeat is presence, not an event: it must leave the feed untouched.
  const heartbeat = await control(`/api/agent/runs/${memberRun.run.id}/heartbeat`, memberToken, {
    status: 'active',
  });
  expect(heartbeat.status).toBe(200);
  await settle();
  feedAfterHeartbeat = (await page('/app/teams/governance-lab/activity', ownerJar)).html;

  const finish = await control(`/api/agent/runs/${ownerRun.run.id}/finish`, ownerToken, {
    status: 'completed',
    detail: 'ledger shipped',
  });
  expect(finish.status).toBe(200);
  await settle();
});

afterAll(async () => {
  await server?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('governance page', () => {
  it('shows the effective policy per scope with version, hash and author', async () => {
    const { status, html } = await page('/app/teams/governance-lab/governance', ownerJar);
    expect(status).toBe(200);
    const policy = section(html, 'Effective policy', 'Policy receipts');
    expect(policy).toContain('billing-api');
    expect(policy).toContain('v1');
    expect(policy).toContain('gov-owner');
    expect(policy).toContain('Never edit a released invoice migration.');
    expect(policy).toContain('db/migrations/**');
    expect(policy).toContain('production changes');
    expect(policy).toContain('npm test');
    expect(policy).toContain('node 24.1.0');
    // The project scope is handed the merge, so it inherits the team's rules …
    expect(policy).toContain('Ship behind a feature flag.');
    expect(policy).toContain('push to main');
    // … and its effective hash is not the hash of the bundle that was published.
    expect(policy).toContain('published ');
  });

  it('marks a drifted receipt unmissably and leaves a clean one unmarked', async () => {
    const { html } = await page('/app/teams/governance-lab/governance', ownerJar);
    const receipts = section(html, 'Policy receipts', 'Environment baselines');

    const driftRow = rowsContaining(receipts, 'GOV-DRIFT');
    expect(driftRow).toHaveLength(1);
    expect(driftRow[0]).toContain('pill-danger');
    expect(driftRow[0]).toContain('>drift<');
    expect(driftRow[0]).toContain('class="warm"');
    expect(driftRow[0]).toContain('gov-member');

    const cleanRow = rowsContaining(receipts, 'GOV-CLEAN');
    expect(cleanRow).toHaveLength(1);
    expect(cleanRow[0]).not.toContain('pill-danger');
    expect(cleanRow[0]).not.toContain('>drift<');
    expect(cleanRow[0]).not.toContain('class="warm"');
    expect(cleanRow[0]).toContain('match');

    // The summary bar counts the deviation, so an owner sees it without reading
    // rows — and says "applied a policy other than the one the server served"
    // rather than lumping it in with runs that simply have not answered yet.
    expect(html).toContain('applied a policy other than the one the server served');
  });

  it('persists a critical preflight and renders it, criticals first', async () => {
    const { html } = await page('/app/teams/governance-lab/governance', ownerJar);
    const baselines = section(html, 'Environment baselines', 'Preflight results');
    expect(baselines).toContain('billing-api');
    expect(baselines).toContain('gov-owner');

    const checks = section(html, 'Preflight results', 'Run timeline');
    const row = rowsContaining(checks, 'GOV-DRIFT');
    expect(row).toHaveLength(1);
    expect(row[0]).toContain('critical');
    expect(row[0]).toContain('pill-danger');
    expect(row[0]).toContain('class="warm"');
    // The stored summary says what the machine actually got wrong.
    expect(row[0]).toContain('node 20.11.0');
    expect(row[0]).toContain('missing CI');
    expect(html).toContain('called a machine critically misconfigured');
    // The newer, clean check is listed — below the critical one.
    expect(checks).toContain('pill pill-active');
    expect(checks.indexOf('pill pill-danger')).toBeLessThan(checks.indexOf('pill pill-active'));
  });

  it('reads the append-only run trail as a timeline', async () => {
    const { html } = await page('/app/teams/governance-lab/governance', ownerJar);
    const timeline = section(html, 'Run timeline', '</body>');
    expect(timeline).toContain('run_started');
    expect(timeline).toContain('run_finished');
    expect(timeline).toContain('GOV-CLEAN');
    expect(timeline).toContain('GOV-DRIFT');
    expect(timeline).toContain('owner-claude');
  });

  it('lets a plain member read the page without the owner-only guidance', async () => {
    const { status, html } = await page('/app/teams/governance-lab/governance', memberJar);
    expect(status).toBe(200);
    expect(html).toContain('Policy receipts');
    expect(html).not.toContain('stma policy publish');
  });

  it('gives a non-member no access', async () => {
    const { status, html } = await page('/app/teams/governance-lab/governance', strangerJar);
    expect(status).toBe(404);
    expect(html).toContain('Team not found');
    expect(html).not.toContain('GOV-DRIFT');
    expect(html).not.toContain('Never edit a released invoice migration.');
  });

  it('gives an owner the control, not a command to copy', async () => {
    const owner = await page('/app/teams/bare-team/governance', ownerJar);
    expect(owner.status).toBe(200);
    expect(owner.html).toContain('No policy published yet');
    expect(owner.html).toContain('No baseline recorded');
    expect(owner.html).toContain('No receipts yet');
    expect(owner.html).toContain('No preflight has run yet');
    expect(owner.html).toContain('No runs recorded yet');

    // Both used to be "run this in a terminal", which put the team's rulebook
    // behind a CLI the rest of the team may not have installed.
    // Policy moved from a modal to its own page — eight lists and a consequence
    // is not a decision you hold in your head — so the control here is the way in.
    expect(owner.html).toContain('/app/teams/bare-team/policy');
    expect(owner.html).toContain('data-open-dialog="#record-baseline"');
    expect(owner.html).not.toContain('stma policy publish');
    expect(owner.html).not.toContain('stma env baseline');

    // A member is told who can do it, and is offered neither the control nor
    // a dialog they could POST from.
    const member = await page('/app/teams/bare-team/governance', memberJar);
    expect(member.status).toBe(200);
    expect(member.html).toContain('No policy published yet');
    expect(member.html).toContain('Ask a team owner to publish one');
    expect(member.html).not.toContain('/app/teams/bare-team/policy');
  });
});

describe('control-plane activity', () => {
  it('records the owner-facing control-plane actions in the team feed', async () => {
    const { status, html } = await page('/app/teams/governance-lab/activity', ownerJar);
    expect(status).toBe(200);
    expect(html).toContain('policy_published');
    expect(html).toContain('env_baseline_set');
    expect(html).toContain('run_started');
    expect(html).toContain('run_finished');
    expect(html).toContain('policy_drift');
    expect(html).toContain('env_preflight_critical');
    // Attribution: acting user, project and the agent's token.
    expect(html).toContain('gov-member');
    expect(html).toContain('billing-api');
    expect(html).toContain('gov-owner-token');
  });

  it('does not turn a heartbeat into an event', async () => {
    const count = (html: string) => html.split('pill pill-member').length;
    expect(feedAfterHeartbeat).not.toContain('heartbeat');
    expect(count(feedAfterHeartbeat)).toBe(count(feedBeforeHeartbeat));
  });

  it('leaves a clean receipt and a clean preflight out of the feed', async () => {
    const { html } = await page('/app/teams/governance-lab/activity', ownerJar);
    const driftRows = html.split('<tr').filter((row) => row.includes('policy_drift'));
    expect(driftRows).toHaveLength(1);
    expect(driftRows[0]).toContain('GOV-DRIFT');
    // Two preflights ran; only the critical one is news.
    expect(html.split('<tr').filter((row) => row.includes('env_preflight'))).toHaveLength(1);
  });
});

describe('preflight retention', () => {
  it('caps stored checks per team, keeping the newest', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stma-governance-retain-'));
    const raw = await connectDb(
      loadEnv({ nodeEnv: 'test', databaseUrl: undefined, pgliteDir: dir }),
    );
    try {
      const user = (
        await raw.db.insert(users).values({ username: 'retain-user' }).returning()
      )[0]!;
      for (const slug of ['retain-a', 'retain-b']) {
        const team = (
          await raw.db.insert(teams).values({ name: slug, slug }).returning()
        )[0]!;
        const project = (
          await raw.db
            .insert(projects)
            .values({ teamId: team.id, name: 'app', slug: 'app' })
            .returning()
        )[0]!;
        for (let i = 0; i < 5; i += 1) {
          await raw.db.insert(environmentChecks).values({
            teamId: team.id,
            projectId: project.id,
            userId: user.id,
            status: 'ok',
            fingerprint: `fp-${slug}-${i}`,
            createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
          });
        }
      }
      await trimEnvironmentChecks(raw.db, 2);
      const kept = await raw.db.select().from(environmentChecks);
      expect(kept.map((row) => row.fingerprint).sort()).toEqual([
        'fp-retain-a-3',
        'fp-retain-a-4',
        'fp-retain-b-3',
        'fp-retain-b-4',
      ]);
    } finally {
      await raw.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------- publishing from the browser

/**
 * Submits a form the way the dialogs do, following nothing.
 *
 * Retries once on a connection-level failure. Under a loaded machine the whole
 * suite shares, Node's fetch will occasionally reuse a keep-alive socket the
 * server has already closed and surface it as ECONNRESET — a property of the
 * runner, not of the route, and one that made this file flake only when run
 * alongside the others.
 */
async function post(
  url: string,
  jar: CookieJar,
  fields: Record<string, string>,
): Promise<{ status: number; location: string }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(`${server.url}${url}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...jar.header() },
        body: new URLSearchParams(fields),
        redirect: 'manual',
      });
      return { status: response.status, location: response.headers.get('location') ?? '' };
    } catch (error) {
      if (attempt > 0) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

describe('policy from the UI', () => {
  it('publishes a rulebook an owner typed into a form', async () => {
    const res = await post('/app/teams/bare-team/policy', ownerJar, {
      scope: 'team',
      guidance: 'Ship behind a feature flag\n\n  Never touch another agent\u2019s branch  ',
      deny: 'push to main\nread secret values',
      requireApproval: 'schema migrations',
      requiredChecks: 'npm test',
      protectedPaths: 'db/migrations/**',
      requiredEnvVarNames: 'DATABASE_URL',
      runtimes: 'node=22.14.0\npython=3.12.4',
    });
    expect(res.status).toBe(302);
    expect(res.location).toContain('ok=');
    expect(decodeURIComponent(res.location)).toContain('v1');

    const html = (await page('/app/teams/bare-team/governance', ownerJar)).html;
    expect(html).toContain('Ship behind a feature flag');
    expect(html).toContain('push to main');
    expect(html).toContain('db/migrations/**');
    expect(html).toContain('DATABASE_URL');
    expect(html).toContain('22.14.0');
    // Blank lines and stray whitespace are dropped, not published as rules.
    expect(html).not.toContain('<li></li>');
  });

  it('serves the same document to an agent that the form published', async () => {
    const res = await fetch(
      `${server.url}/api/agent/policies/effective?team=bare-team`,
      { headers: { authorization: `Bearer ${memberToken}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      document: { permissions: { deny: string[] }; environment: { runtimes: Record<string, string> } };
      hash: string;
    };
    // The point of publishing from a browser is that agents get exactly what
    // the owner saw — not a second, web-only representation.
    expect(body.document.permissions.deny).toContain('push to main');
    expect(body.document.environment.runtimes.node).toBe('22.14.0');
    expect(body.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('opens the editor on the document the team is already serving', async () => {
    // A blank form would quietly delete every rule the moment somebody pressed
    // publish, so the editor has to open on the live rulebook.
    const html = (await page('/app/teams/bare-team/policy', ownerJar)).html;
    expect(html).toContain('Ship behind a feature flag');
    expect(html).toContain('node=22.14.0');
    // …and it says what the agents will receive, next to the form that changes it.
    expect(html).toContain('What get_policy will serve');
  });

  it('refuses to publish a rulebook with no rules in it', async () => {
    const res = await post('/app/teams/bare-team/policy', ownerJar, { scope: 'team' });
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.location)).toContain('would publish a rulebook with no rules');
    // And the live policy is untouched.
    const html = (await page('/app/teams/bare-team/governance', ownerJar)).html;
    expect(html).toContain('push to main');
  });

  it('lets only an owner write policy, whichever door they use', async () => {
    const res = await post('/app/teams/bare-team/policy', memberJar, {
      scope: 'team',
      deny: 'everything',
    });
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.location)).toContain('Only a team owner');
    const stranger = await post('/app/teams/bare-team/policy', strangerJar, {
      scope: 'team',
      deny: 'everything',
    });
    expect(stranger.status).toBe(404);
  });
});

describe('baseline from the UI', () => {
  it('promotes a snapshot the team already pushed', async () => {
    // A machine reports in, exactly as an agent would.
    const pushed = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${memberToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 700,
        method: 'tools/call',
        params: {
          name: 'push_snapshot',
          arguments: {
            team: 'bare-team',
            repo: 'bare-api',
            device: 'the-good-machine',
            snapshot: {
              os: { platform: 'linux', arch: 'x64' },
              runtimes: { node: '22.14.0' },
              packageManagers: { npm: '11.0.0' },
              lockfiles: [{ path: 'package-lock.json', hash: 'beef1234' }],
              envVarNames: ['DATABASE_URL'],
              git: { branch: 'main', sha: 'aaa', dirtyFiles: [] },
              timezone: 'Europe/Istanbul',
            },
          },
        },
      }),
    });
    expect(pushed.status).toBe(200);

    // The owner sees it offered by person and machine — the CLI could only
    // baseline the machine it was running on.
    const before = (await page('/app/teams/bare-team/governance', ownerJar)).html;
    const dialog = before.slice(before.indexOf('<dialog id="record-baseline"'));
    expect(dialog).toContain('the-good-machine');
    expect(dialog).toContain('gov-member');
    const id = /<option value="([0-9a-f-]{36})"/.exec(dialog)?.[1];
    expect(id, 'a promotable snapshot').toBeTruthy();

    const res = await post('/app/teams/bare-team/baseline', ownerJar, {
      snapshot: id!,
      project: 'bare-api',
    });
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.location)).toContain('gov-member@the-good-machine');

    const html = (await page('/app/teams/bare-team/governance', ownerJar)).html;
    expect(html).not.toContain('No baseline recorded');
    expect(html).toContain('bare-api');
  });

  it('gives an agent a preflight verdict against the promoted machine', async () => {
    const res = await fetch(`${server.url}/api/agent/environment/preflight`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${memberToken}` },
      body: JSON.stringify({
        team: 'bare-team',
        project: 'bare-api',
        snapshot: {
          os: { platform: 'linux', arch: 'x64' },
          runtimes: { node: '20.11.1' },
          packageManagers: { npm: '11.0.0' },
          lockfiles: [{ path: 'package-lock.json', hash: 'different' }],
          envVarNames: ['DATABASE_URL'],
          git: { branch: 'main', sha: 'bbb', dirtyFiles: [] },
          timezone: 'Europe/Istanbul',
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    // A baseline recorded from the browser has to do the same work as one
    // recorded from a terminal, or the shortcut is a lie.
    expect(body.status).toBe('critical');
  });

  it('refuses a snapshot from another team, and a member trying to promote one', async () => {
    const html = (await page('/app/teams/bare-team/governance', ownerJar)).html;
    const dialog = html.slice(html.indexOf('<dialog id="record-baseline"'));
    const id = /<option value="([0-9a-f-]{36})"/.exec(dialog)?.[1]!;

    const byMember = await post('/app/teams/bare-team/baseline', memberJar, {
      snapshot: id,
      project: 'bare-api',
    });
    expect(decodeURIComponent(byMember.location)).toContain('Only a team owner');

    const bogus = await post('/app/teams/bare-team/baseline', ownerJar, {
      snapshot: '00000000-0000-0000-0000-000000000000',
      project: 'bare-api',
    });
    expect(decodeURIComponent(bogus.location)).toContain('not in this team');
  });
});

describe('project scope on the governance page', () => {
  beforeAll(async () => {
    // A second project, so filtering has something to exclude.
    const webRun = await control('/api/agent/runs/start', ownerToken, {
      installationId: (await (async () => {
        const rows = await control('/api/agent/installations/register', ownerToken, {
          name: 'owner-web-claude',
          clientType: 'claude-code',
          clientVersion: 'governance-test',
          deviceFingerprint: 'governance-owner-web',
          capabilities: ['wrapper'],
        });
        return ((await rows.json()) as any).installation.id as string;
      })()),
      team: 'governance-lab',
      project: 'web-app',
      taskKey: 'GOV-WEB',
      intent: 'Restyle the pricing page',
      repo: 'web-app',
      branch: 'feat/pricing',
      claims: [{ resourceType: 'path', resourceKey: 'src/pricing/**', access: 'write' }],
    });
    expect(webRun.status).toBe(200);
    await settle();
  });

  it('narrows receipts, checks and the timeline to the chosen project', async () => {
    const scoped = (await page('/app/teams/governance-lab/governance?project=billing-api', ownerJar))
      .html;
    expect(scoped).toContain('GOV-CLEAN');
    expect(scoped).not.toContain('GOV-WEB');

    const web = (await page('/app/teams/governance-lab/governance?project=web-app', ownerJar)).html;
    expect(web).toContain('GOV-WEB');
    expect(web).not.toContain('GOV-CLEAN');
    // billing-api's baseline must not appear under web-app's scope.
    const baselines = section(web, 'Environment baselines', 'Preflight results');
    expect(rowsContaining(baselines, 'billing-api')).toHaveLength(0);
  });

  it("shows team policy plus only the chosen project's override", async () => {
    const scoped = (await page('/app/teams/governance-lab/governance?project=billing-api', ownerJar))
      .html;
    const policyCard = section(scoped, 'Effective policy', 'Policy receipts');
    expect(policyCard).toContain('billing-api');
    // The scoped view is team + this project: exactly two scope tables.
    expect(policyCard).toContain('Ship behind a feature flag.');
    expect(policyCard).toContain('Never edit a released invoice migration.');
  });

  it("opens the editor on the project's own additions, not the merge", async () => {
    const scoped = (await page('/app/teams/governance-lab/policy?project=billing-api', ownerJar))
      .html;
    const form = section(scoped, 'id="policy-form"', 'What get_policy will serve');
    // The project's own rules are the draft…
    expect(form).toContain('Never edit a released invoice migration.');
    // …and the team's base rules are not, or publishing would copy every team
    // rule into the project bundle. (They still appear in the preview, which is
    // the merged document an agent receives — that is the point of showing it.)
    expect(form).not.toContain('Ship behind a feature flag.');
    expect(scoped).toContain('Ship behind a feature flag.');

    const global = (await page('/app/teams/governance-lab/policy', ownerJar)).html;
    const globalForm = section(global, 'id="policy-form"', 'What get_policy will serve');
    expect(globalForm).toContain('Ship behind a feature flag.');
  });

  it('says so when the project does not exist, and shows the whole team', async () => {
    const html = (await page('/app/teams/governance-lab/governance?project=nope-api', ownerJar))
      .html;
    expect(html).toContain('No project called');
    expect(html).toContain('GOV-CLEAN');
  });

  it('scopes the activity page and its export the same way', async () => {
    const scoped = (await page('/app/teams/governance-lab/activity?project=web-app', ownerJar))
      .html;
    expect(scoped).toContain('GOV-WEB');
    expect(scoped).not.toContain('GOV-CLEAN');
    expect(scoped).toContain('export csv');

    const csv = await fetch(
      `${server.url}/app/teams/governance-lab/activity.csv?project=web-app`,
      { headers: ownerJar.header() },
    );
    const body = await csv.text();
    expect(body).toContain('GOV-WEB');
    expect(body).not.toContain('GOV-CLEAN');
  });

  it("scopes the environment comparison to one project's snapshots", async () => {
    const html = (
      await page(
        '/app/teams/governance-lab/compare?project=billing-api&a=gov-owner&b=gov-member',
        ownerJar,
      )
    ).html;
    // Nobody pushed a billing-api snapshot (the baseline came in over the control
    // API), so the page must say the *project* has no snapshot, not the machine.
    expect(html).toContain('no billing-api snapshot');
  });
});
