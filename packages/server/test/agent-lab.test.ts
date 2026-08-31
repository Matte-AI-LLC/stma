import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

interface CookieJar {
  header(): Record<string, string>;
  store(response: Response): void;
}

interface AgentIdentity {
  username: string;
  token: string;
  installationId: string;
}

let server: StartedServer;
let dataDir: string;

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

async function inviteAndJoin(owner: CookieJar, username: string): Promise<CookieJar> {
  const inviteResponse = await fetch(`${server.url}/app/teams/agent-lab/invites`, {
    method: 'POST',
    headers: owner.header(),
    redirect: 'manual',
  });
  expect(inviteResponse.status).toBe(302);

  const teamPage = await fetch(`${server.url}/app/teams/agent-lab?tab=people`, {
    headers: owner.header(),
  });
  const code = /\/join\/([A-Za-z0-9_-]+)/.exec(await teamPage.text())?.[1];
  expect(code).toBeTruthy();

  const member = await devLogin(username);
  const joinResponse = await fetch(`${server.url}/join/${code}`, {
    method: 'POST',
    headers: member.header(),
    redirect: 'manual',
  });
  expect(joinResponse.status).toBe(302);
  return member;
}

function control(endpoint: string, token: string, body?: unknown) {
  return fetch(`${server.url}${endpoint}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function registerAgent(
  jar: CookieJar,
  username: string,
  name: string,
  clientType: 'claude-code' | 'codex' | 'cursor',
): Promise<AgentIdentity> {
  const token = await createToken(jar, `${name}-token`);
  const response = await control('/api/agent/installations/register', token, {
    name,
    clientType,
    clientVersion: 'agent-lab',
    deviceFingerprint: `agent-lab-${username}-${clientType}`,
    capabilities: ['wrapper', 'claims', 'preflight'],
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as any;
  return { username, token, installationId: body.installation.id as string };
}

const baselineSnapshot = {
  os: { platform: 'linux', arch: 'x64' },
  runtimes: { node: '24.1.0' },
  packageManagers: { npm: '11.0.0' },
  lockfiles: [{ path: 'package-lock.json', hash: 'lab-lock-v1' }],
  envVarNames: ['PATH', 'CI'],
  git: { branch: 'main', sha: 'agent-lab-base', dirtyFiles: [] },
  timezone: 'Europe/Istanbul',
};

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-agent-lab-'));
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
});

afterAll(async () => {
  await server?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('multi-agent acceptance lab', () => {
  it('coordinates three agents across two projects and surfaces drift and conflicting work', async () => {
    const aliceJar = await devLogin('lab-alice');
    const createTeam = await fetch(`${server.url}/app/teams`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...aliceJar.header() },
      body: new URLSearchParams({ name: 'Agent Lab' }),
      redirect: 'manual',
    });
    expect(createTeam.status).toBe(302);
    expect(createTeam.headers.get('location')).toBe('/app/teams/agent-lab');

    const bobJar = await inviteAndJoin(aliceJar, 'lab-bob');
    const carolJar = await inviteAndJoin(aliceJar, 'lab-carol');

    const alice = await registerAgent(aliceJar, 'lab-alice', 'alice-claude', 'claude-code');
    const bob = await registerAgent(bobJar, 'lab-bob', 'bob-codex', 'codex');
    const carol = await registerAgent(carolJar, 'lab-carol', 'carol-cursor', 'cursor');

    const paymentsPolicy = await control('/api/control/policies', alice.token, {
      team: 'agent-lab',
      project: 'payments-api',
      document: {
        guidance: ['Keep payment migrations backwards compatible.'],
        permissions: {
          deny: ['read secret values'],
          requireApproval: ['production changes'],
        },
        requiredChecks: ['npm test'],
        protectedPaths: ['db/migrations/**'],
        environment: {
          requiredEnvVarNames: ['PATH', 'CI'],
          runtimes: { node: '24.1.0' },
        },
      },
    });
    expect(paymentsPolicy.status).toBe(200);

    const storefrontPolicy = await control('/api/control/policies', alice.token, {
      team: 'agent-lab',
      project: 'storefront-web',
      document: {
        guidance: ['Keep storefront work isolated from payment releases.'],
        permissions: { deny: [], requireApproval: [] },
        requiredChecks: ['npm test'],
        protectedPaths: [],
        environment: { requiredEnvVarNames: ['PATH'], runtimes: { node: '24.1.0' } },
      },
    });
    expect(storefrontPolicy.status).toBe(200);

    const baseline = await control('/api/control/environment-baselines', alice.token, {
      team: 'agent-lab',
      project: 'payments-api',
      snapshot: baselineSnapshot,
    });
    expect(baseline.status).toBe(200);

    const runAliceResponse = await control('/api/agent/runs/start', alice.token, {
      installationId: alice.installationId,
      team: 'agent-lab',
      project: 'payments-api',
      taskKey: 'PAY-101',
      intent: 'Add the refunds ledger migration',
      repo: 'payments-api',
      branch: 'feat/refunds-ledger',
      baseSha: 'agent-lab-base',
      claims: [
        { resourceType: 'path', resourceKey: 'db/migrations/**', access: 'write' },
        { resourceType: 'migration', resourceKey: 'payments-db', access: 'write' },
      ],
    });
    const runAlice = (await runAliceResponse.json()) as any;
    expect(runAliceResponse.status).toBe(200);
    expect(runAlice.conflicts).toEqual([]);

    // Same logical claims are safe in a different project: project boundaries isolate leases.
    const runCarolResponse = await control('/api/agent/runs/start', carol.token, {
      installationId: carol.installationId,
      team: 'agent-lab',
      project: 'storefront-web',
      taskKey: 'WEB-201',
      intent: 'Prepare storefront release notes and its local schema fixture',
      repo: 'storefront-web',
      branch: 'feat/release-notes',
      baseSha: 'agent-lab-base',
      claims: [
        { resourceType: 'path', resourceKey: 'db/migrations/**', access: 'write' },
        { resourceType: 'migration', resourceKey: 'payments-db', access: 'write' },
      ],
    });
    const runCarol = (await runCarolResponse.json()) as any;
    expect(runCarolResponse.status).toBe(200);
    expect(runCarol.conflicts).toEqual([]);

    // Bob overlaps Alice inside payments-api on both a protected path and migration chain.
    const runBobResponse = await control('/api/agent/runs/start', bob.token, {
      installationId: bob.installationId,
      team: 'agent-lab',
      project: 'payments-api',
      taskKey: 'PAY-102',
      intent: 'Rewrite the refunds migration and contract',
      repo: 'payments-api',
      branch: 'feat/refund-contract',
      baseSha: 'agent-lab-base',
      claims: [
        {
          resourceType: 'path',
          resourceKey: 'db/migrations/0042_refunds.sql',
          access: 'write',
        },
        { resourceType: 'migration', resourceKey: 'payments-db', access: 'write' },
      ],
    });
    const runBob = (await runBobResponse.json()) as any;
    expect(runBobResponse.status).toBe(200);
    expect(runBob.conflicts).toHaveLength(2);
    expect(runBob.conflicts.every((conflict: any) => conflict.severity === 'critical')).toBe(true);
    expect(runBob.conflicts.map((conflict: any) => conflict.existing.owner)).toEqual([
      'lab-alice',
      'lab-alice',
    ]);

    const activeResponse = await control('/api/agent/runs/active?team=agent-lab', alice.token);
    const active = (await activeResponse.json()) as any;
    expect(activeResponse.status).toBe(200);
    expect(active.runs).toHaveLength(3);
    expect(new Set(active.runs.map((run: any) => run.owner))).toEqual(
      new Set(['lab-alice', 'lab-bob', 'lab-carol']),
    );
    expect(new Set(active.runs.map((run: any) => run.installation.clientType))).toEqual(
      new Set(['claude-code', 'codex', 'cursor']),
    );
    expect(active.runs.find((run: any) => run.owner === 'lab-carol').project).toBe(
      'storefront-web',
    );

    const mapPage = await fetch(`${server.url}/app/agents`, { headers: aliceJar.header() });
    const mapHtml = await mapPage.text();
    expect(mapPage.status).toBe(200);
    expect(mapHtml).toContain('alice-claude');
    expect(mapHtml).toContain('bob-codex');
    expect(mapHtml).toContain('carol-cursor');
    expect(mapHtml).toContain('payments-api');
    expect(mapHtml).toContain('storefront-web');
    expect(mapHtml).toContain('critical');

    // The server keeps the authoritative policy hash even when the agent reports a forged one.
    const forgedHash = '0'.repeat(64);
    const receiptResponse = await control(
      `/api/agent/runs/${runBob.run.id}/policy-receipt`,
      bob.token,
      { expectedHash: forgedHash, reportedHash: forgedHash },
    );
    const receipt = (await receiptResponse.json()) as any;
    expect(receiptResponse.status).toBe(200);
    expect(receipt.receipt.expectedHash).toBe(runBob.policy.hash);
    expect(receipt.receipt.reportedHash).toBe(forgedHash);
    expect(receipt.receipt.drift).toBe(true);

    // Runtime, lockfile and required-variable drift makes the readiness decision critical.
    const preflightResponse = await control('/api/agent/environment/preflight', bob.token, {
      team: 'agent-lab',
      project: 'payments-api',
      runId: runBob.run.id,
      snapshot: {
        ...baselineSnapshot,
        runtimes: { node: '20.11.0' },
        lockfiles: [{ path: 'package-lock.json', hash: 'drifted-lock' }],
        envVarNames: ['PATH'],
        git: { branch: 'feat/refund-contract', sha: 'agent-lab-drift', dirtyFiles: [] },
      },
    });
    const preflight = (await preflightResponse.json()) as any;
    expect(preflightResponse.status).toBe(200);
    expect(preflight.status).toBe('critical');
    expect(preflight.policyViolations.missingEnvVarNames).toEqual(['CI']);
    expect(preflight.policyViolations.runtimeMismatches).toEqual([
      { runtime: 'node', expected: '24.1.0', actual: '20.11.0' },
    ]);
    expect(preflight.differences.totalDifferences).toBeGreaterThanOrEqual(3);

    for (const [runId, token] of [
      [runAlice.run.id, alice.token],
      [runBob.run.id, bob.token],
      [runCarol.run.id, carol.token],
    ] as const) {
      const finish = await control(`/api/agent/runs/${runId}/finish`, token, {
        status: 'completed',
      });
      expect(finish.status).toBe(200);
    }

    const afterFinish = await control('/api/agent/runs/active?team=agent-lab', alice.token);
    expect(((await afterFinish.json()) as any).runs).toEqual([]);
  });
});
