import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serverSpec } from '../../cli/src/serve';
import { VERSION as CLI_VERSION } from '../../cli/src/version';
import { bootNodeEnv, loadEnv } from '../src/env';
import { PLANS, UNMETERED, planLimits } from '../src/lib/entitlements';
import { FLEET_TOOL_PARAMS } from '../src/mcp/fleet';
import { TOOL_PARAMS } from '../src/routes/mcp';
import { startServer, type StartedServer } from '../src/server';
import { VERSION } from '../src/version';

/**
 * The three layers, and the rules that keep them from lying to each other.
 *
 * This repository ships the same code three ways: as source under ELv2, as two
 * npm packages, and as a container image running the hosted service. Nothing in
 * a monorepo notices when those drift — a workspace-only dependency left in a
 * published manifest, a version that means three different things, a feature
 * that quietly exists on one layer and not another. Each of those is invisible
 * in review and expensive in the wild, which is the definition of something
 * that belongs in a test rather than in a document.
 *
 * The rules asserted here:
 *   1. One version across all four manifests, so a tag names one thing.
 *   2. A published package may not depend on a package that is not published.
 *   3. Self-host is the full product; the paid Team plan is the same product.
 *   4. The API surface is additive — removing a tool has to be deliberate.
 *   5. Client and server can say who they are to each other.
 */

const repo = path.resolve(__dirname, '../../..');
const manifest = (rel: string) => JSON.parse(readFileSync(path.join(repo, rel), 'utf8'));

let hosted: StartedServer;
let selfHost: StartedServer;
let hostedDir: string;
let selfHostDir: string;
let hostedToken = '';
let selfHostToken = '';

/** A signed-in account with a machine token — `/mcp` answers nothing without one. */
async function tenant(srv: StartedServer, who: string): Promise<string> {
  const login = await fetch(`${srv.url}/auth/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: who }),
    redirect: 'manual',
  });
  const cookie = login.headers.getSetCookie().map((line) => line.split(';')[0]!).join('; ');
  await fetch(`${srv.url}/app/teams`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ name: `${who} team` }),
    redirect: 'manual',
  });
  const res = await fetch(`${srv.url}/app/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ name: `${who}-machine` }),
  });
  const token = /stma_[0-9a-f]{40}/.exec(await res.text())?.[0] ?? '';
  expect(token, `token for ${who}`).toBeTruthy();
  return token;
}

beforeAll(async () => {
  hostedDir = mkdtempSync(path.join(tmpdir(), 'stma-layers-hosted-'));
  selfHostDir = mkdtempSync(path.join(tmpdir(), 'stma-layers-own-'));
  const base = { port: 0, host: 'localhost', nodeEnv: 'test' as const, devMode: true, databaseUrl: undefined };
  hosted = await startServer(loadEnv({ ...base, pgliteDir: hostedDir, hosted: true }));
  selfHost = await startServer(loadEnv({ ...base, pgliteDir: selfHostDir, hosted: false }));
  hostedToken = await tenant(hosted, 'tenant');
  selfHostToken = await tenant(selfHost, 'homelab');
});

afterAll(async () => {
  await hosted?.close();
  await selfHost?.close();
  rmSync(hostedDir, { recursive: true, force: true });
  rmSync(selfHostDir, { recursive: true, force: true });
});

describe('one version', () => {
  it('is the same number in every manifest', () => {
    // The train's whole premise: a `v*` tag publishes two npm packages, a ghcr
    // image and a production deploy from one commit. Four numbers would make
    // "which build is this" unanswerable — it was, before: the image was on
    // v0.10.1 while the server package said 0.7.2 and the CLI said 0.2.2.
    const versions = [
      'package.json',
      'packages/shared/package.json',
      'packages/server/package.json',
      'packages/cli/package.json',
    ].map((rel) => [rel, manifest(rel).version] as const);
    const distinct = new Set(versions.map(([, v]) => v));
    expect([...distinct], JSON.stringify(versions)).toHaveLength(1);
  });

  it('is what the running server and the CLI report', () => {
    // Both read their own manifest at the same relative path in the checkout
    // and in the bundle, which is what lets `stma version --server` compare
    // them at all.
    expect(VERSION).toBe(manifest('packages/server/package.json').version);
    expect(CLI_VERSION).toBe(manifest('packages/cli/package.json').version);
  });

  it('is what `stma serve` asks npm for', () => {
    // `serve` fetches the server package when this machine has no copy. Asking
    // for `latest` would mean a CLI installed months ago pulling a server built
    // against a newer client — the one skew the release train can prevent
    // rather than merely report.
    expect(serverSpec()).toBe(`@matteai/stma-server@${CLI_VERSION}`);
    // A build that is not a release (someone's own checkout) falls back to the
    // unpinned name rather than asking for a version nobody published.
    expect(serverSpec('0.0.0-dev')).toBe('@matteai/stma-server');
  });
});

describe('the npm layer is installable', () => {
  const published = ['packages/server/package.json', 'packages/cli/package.json'];

  it('never ships a dependency that is not on the registry', () => {
    // Measured, not hypothetical: the server declared `@bridge/shared: "*"` as a
    // runtime dependency while tsup bundled it. `npm i @matteai/stma-server`
    // would have gone looking for a private workspace package on the public
    // registry and failed with E404 — which is why the package was never
    // published, and why `stma serve` could not fetch it.
    const workspaceOnly = ['@bridge/shared', 'stma'];
    for (const rel of published) {
      for (const name of Object.keys(manifest(rel).dependencies ?? {})) {
        expect(workspaceOnly, `${rel} declares ${name} as a runtime dependency`).not.toContain(name);
      }
    }
  });

  it('bundles the workspace code it needs instead', () => {
    for (const pkg of ['server', 'cli']) {
      const tsup = readFileSync(path.join(repo, `packages/${pkg}/tsup.config.ts`), 'utf8');
      expect(tsup, `${pkg} must bundle @bridge/* — it cannot resolve them at runtime`).toContain(
        'noExternal',
      );
      expect(tsup).toContain('@bridge');
    }
  });

  it('ships the files each package needs to boot', () => {
    // Migrations resolve relative to the installed package, so a server tarball
    // without `drizzle/` starts and then fails on the first query.
    expect(manifest('packages/server/package.json').files).toEqual(
      expect.arrayContaining(['dist', 'drizzle']),
    );
    expect(manifest('packages/cli/package.json').files).toEqual(expect.arrayContaining(['dist']));
    // Both are public scoped packages; without this npm refuses the publish.
    for (const rel of published) expect(manifest(rel).publishConfig?.access).toBe('public');
  });

  it('keeps the shared package private, because it is bundled into both', () => {
    expect(manifest('packages/shared/package.json').private).toBe(true);
  });

  it('pins exactly what each tarball ships, so ee/ can never ride along', () => {
    // The day commercial-only code is born it lives under ee/, stays out of the
    // public mirror by allowlist, and out of the npm artefacts by THIS pin: any
    // attempt to widen the files list is a red test and therefore a decision.
    expect(manifest('packages/server/package.json').files).toEqual([
      'dist',
      'drizzle',
      'README.md',
      'LICENSE',
    ]);
    expect(manifest('packages/cli/package.json').files).toEqual(['README.md', 'LICENSE', 'dist']);
  });
});

describe('the artefact does not inherit the checkout', () => {
  it('assumes production when nobody said otherwise', () => {
    // Measured on a real install during this change: `stma-server` from the
    // packed tarball booted with "dev auth ON", because devMode follows
    // NODE_ENV and NODE_ENV defaults to development — a default written for
    // `npm run dev` that reached a stranger's machine.
    expect(bootNodeEnv({}, [])).toBe('production');
    expect(bootNodeEnv({}, ['node', 'index.js'])).toBe('production');
  });

  it('lets development say so, explicitly and cross-platform', () => {
    // A flag rather than an env prefix, because `npm run dev` also runs on
    // Windows, where `NODE_ENV=x cmd` is not a thing.
    expect(bootNodeEnv({}, ['node', 'src/index.ts', '--dev'])).toBe('development');
    // Anything that sets NODE_ENV itself wins — Dockerfile, compose, the demo
    // scripts, the test suite.
    expect(bootNodeEnv({ NODE_ENV: 'production' }, ['node', 'src/index.ts', '--dev'])).toBe('production');
    expect(bootNodeEnv({ NODE_ENV: 'test' }, [])).toBe('test');
  });

  it('keeps the passwordless login form off unless it was asked for', () => {
    // The rule `stma serve` already followed and the server bin did not. Set on
    // process.env rather than passed as an override, because `devMode` is
    // derived from the environment before overrides are applied — which is
    // exactly the path the bin takes.
    const before = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = bootNodeEnv({}, []);
      expect(process.env.NODE_ENV).toBe('production');
      expect(loadEnv({ embeddedDb: true }).devMode).toBe(false);
    } finally {
      process.env.NODE_ENV = before;
    }
  });
});

describe('same product, different meter', () => {
  it('gives a self-hosted instance everything', () => {
    // The tier matrix's first column. ELv2 already stops a competing hosted
    // service, so a crippled self-host would only punish the people reading the
    // licence honestly.
    expect(planLimits('free', false)).toEqual(UNMETERED);
    expect(planLimits(null, false)).toEqual(UNMETERED);
  });

  it('gives the paid Team plan the same feature set as self-host', () => {
    // This is the rule that keeps the hosted service honest about what it is:
    // a meter and an operator, not a different product. Numbers may differ —
    // ceilings are what a plan sells — but no *feature* may exist on one layer
    // and not the other.
    const features = (limits: typeof UNMETERED) => ({
      fleet: limits.fleet,
      governance: limits.governance,
      evidence: limits.evidence,
      savings: limits.savings,
    });
    expect(features(PLANS.team)).toEqual(features(UNMETERED));
    expect(features(PLANS.enterprise)).toEqual(features(UNMETERED));
  });

  it('never takes a feature away as the plan gets more expensive', () => {
    // A ladder that dips is a support ticket that reads "we upgraded and lost
    // the map". Ceilings climb, switches never go from on to off.
    const ladder = [PLANS.free, PLANS.solo, PLANS.team, PLANS.enterprise];
    // `maxMembers` is deliberately not on this list. Solo allows one human where
    // Free allows ten, because Solo is not a bigger Free — it is one person with
    // several machines, and saying so in the limit is kinder than discovering it
    // at renewal. Every other ceiling climbs.
    const numeric = ['maxProjects', 'maxToolCallsPerDay'] as const;
    for (let i = 1; i < ladder.length; i++) {
      const lower = ladder[i - 1]!;
      const upper = ladder[i]!;
      for (const key of numeric) expect(upper[key]).toBeGreaterThanOrEqual(lower[key]);
      for (const key of ['governance', 'evidence', 'savings'] as const) {
        if (lower[key]) expect(upper[key], `${key} disappears at rung ${i}`).toBe(true);
      }
      if (lower.fleet === 'full') expect(upper.fleet).toBe('full');
      // `null` is unlimited, so a lower rung's number may never beat it.
      for (const key of ['maxDevicesPerMember', 'maxHandoffsPerMonth', 'maxIntegrations', 'retentionDays'] as const) {
        if (lower[key] === null) expect(upper[key], `${key} becomes finite at rung ${i}`).toBeNull();
      }
    }
  });

  it('shrinks the member cap exactly once, on purpose', () => {
    // The exception the ladder check leaves out, asserted here so it stays a
    // decision instead of becoming a hole somebody widens later.
    expect(PLANS.solo.maxMembers).toBe(1);
    expect(PLANS.team.maxMembers).toBeGreaterThan(PLANS.free.maxMembers);
    expect(PLANS.enterprise.maxMembers).toBeGreaterThan(PLANS.team.maxMembers);
  });
});

describe('the API surface is additive', () => {
  // Pinned on purpose. Adding a tool changes this list in the same commit that
  // adds it — a diff a reviewer reads as "new capability". Removing or renaming
  // one changes it too, and that is the point: an agent somewhere is calling it,
  // and a self-hosted server on last quarter's version still answers it. The
  // list is a decision record, not a snapshot to regenerate when it goes red.
  const PUBLIC_TOOLS = [
    // identity and projects
    'whoami',
    'list_teammates',
    'create_invite',
    'onboard_repo',
    'list_projects',
    // snapshots and environment
    'get_snapshot_checklist',
    'push_snapshot',
    'get_snapshot',
    'compare_env',
    'check_environment',
    // sessions
    'open_session',
    'list_sessions',
    'get_session',
    'post_message',
    'resolve_session',
    'inbox',
    'search_past_issues',
    'announce',
    // fleet
    'start_run',
    'update_run',
    'finish_run',
    'list_active_agents',
    'handoff_work',
    'get_policy',
    'get_workflow',
    'get_evidence',
    'list_issues',
  ];

  const list = async (srv: StartedServer, token: string) => {
    const res = await fetch(`${srv.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const body = (await res.json()) as { result?: { tools?: { name: string }[] } };
    return (body.result?.tools ?? []).map((t) => t.name).sort();
  };

  it('answers exactly the tools this version promises', async () => {
    expect(await list(hosted, hostedToken)).toEqual([...PUBLIC_TOOLS].sort());
  });

  it('declares argument validation for every one of them', () => {
    // The drift test's sibling: a tool with no entry in TOOL_PARAMS accepts
    // unknown arguments silently, which is how an agent's typo becomes a
    // no-op that looks like success.
    const declared = new Set([...Object.keys(TOOL_PARAMS), ...Object.keys(FLEET_TOOL_PARAMS)]);
    for (const tool of PUBLIC_TOOLS) expect([...declared]).toContain(tool);
  });

  it('serves the same tool list whether or not it is the hosted service', async () => {
    // Gating happens when a tool is called, never by hiding it: a free team
    // that cannot see `start_run` cannot be told what it would buy.
    expect(await list(hosted, hostedToken)).toEqual(await list(selfHost, selfHostToken));
  });
});

describe('client and server can name themselves', () => {
  it('reports the build on /health', async () => {
    for (const srv of [hosted, selfHost]) {
      const health = (await (await fetch(`${srv.url}/health`)).json()) as { ok: boolean; version: string };
      expect(health.ok).toBe(true);
      expect(health.version).toBe(manifest('packages/server/package.json').version);
    }
  });

  it('serves a client that does not send a version, and one that does', async () => {
    // Old clients keep working: the header is diagnostic, never a gate. This is
    // the compatibility promise the npm layer needs — someone's CLI from three
    // releases ago must still reach a current server.
    const silent = await fetch(`${hosted.url}/health`);
    expect(silent.status).toBe(200);
    const named = await fetch(`${hosted.url}/health`, {
      headers: { 'x-stma-client': 'stma/0.0.1' },
    });
    expect(named.status).toBe(200);
  });
});
