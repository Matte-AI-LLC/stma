import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';
import {
  agentRuns,
  debugSessions,
  environmentBaselines,
  policyBundles,
  projects as projectRows,
  snapshots,
  teams,
  tokens,
} from '../src/db/schema';
import { connectorAsset } from '../src/lib/connectorAsset';

let srv: StartedServer;
let dataDir: string;
let rpcId = 1;

function jar() {
  const cookies = new Map<string, string>();
  return {
    header(): Record<string, string> {
      return cookies.size
        ? { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') }
        : {};
    },
    store(response: Response) {
      for (const line of response.headers.getSetCookie()) {
        const [pair] = line.split(';');
        const separator = pair!.indexOf('=');
        cookies.set(pair!.slice(0, separator), pair!.slice(separator + 1));
      }
    },
  };
}

type CookieJar = ReturnType<typeof jar>;

async function devLogin(username: string) {
  const cookies = jar();
  const response = await fetch(`${srv.url}/auth/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username }),
    redirect: 'manual',
  });
  cookies.store(response);
  expect(response.status).toBe(302);
  return cookies;
}

async function form(cookies: CookieJar, pathname: string, body: Record<string, string>) {
  return fetch(`${srv.url}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...cookies.header() },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });
}

async function legacyToken(cookies: CookieJar, name: string) {
  const response = await form(cookies, '/app/tokens', { name });
  const html = await response.text();
  const token = /stma_[0-9a-f]{40}/.exec(html)?.[0];
  expect(token).toBeTruthy();
  return token!;
}

async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId++,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  expect(response.status).toBe(200);
  const json = (await response.json()) as {
    result: { isError?: boolean; content: Array<{ type: string; text: string }> };
  };
  return json.result;
}

const parsed = (result: Awaited<ReturnType<typeof callTool>>) =>
  JSON.parse(result.content[0]!.text) as Record<string, any>;

it.skipIf(process.platform === 'win32')('runs the served connector artifact end to end for two client configs and confirms only real MCP usage', async () => {
  const owner = await devLogin('connector-e2e-owner');
  await createTeam(owner, 'Connector E2E');
  const [team] = await srv.db.select().from(teams).where(eq(teams.slug, 'connector-e2e'));
  const root = mkdtempSync(path.join(tmpdir(), 'stma-served-connector-'));
  const artifact = connectorAsset();
  const downloaded = await fetch(srv.url + artifact.path);
  const code = await downloaded.text();
  expect(createHash('sha256').update(code).digest('hex')).toBe(artifact.sha256);
  const executable = path.join(root, 'connector.mjs'); writeFileSync(executable, code, { mode: 0o600 });
  try {
    for (const client of ['codex', 'claude-code']) {
      const issued = await createEnrollment(owner, { name: `distributed-${client}`, device: 'e2e-machine', access: `team:${team!.id}`, client });
      const data = { STMA_URL: srv.url, STMA_ENROLLMENT_CODE: issued.code, STMA_ENROLLMENT_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString(),
        STMA_EXPECTED_REDEMPTION: { endpoint: `${srv.url}/mcp`, enrollmentId: promptJsonValue(issued.html, 'STMA_ENROLLMENT_ID'), installationName: `distributed-${client}`, device: 'e2e-machine', clientType: client, role: 'generalist', grantScope: 'team', teamSlug: 'connector-e2e', projectName: null } };
      const input = path.join(root, `${client}-bootstrap.json`); writeFileSync(input, JSON.stringify(data), { mode: 0o600 });
      const output = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [executable, '--approved', '--envelope-file', input, '--config-home', root], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject); child.on('close', (status) => resolve({ status, stdout, stderr }));
      });
      expect(output.status, output.stdout).toBe(0); expect(output.stderr).toBe(''); expect(existsSync(input)).toBe(false);
      const installed = JSON.parse(output.stdout); expect(installed.stage).toBe('awaiting_client');
      const configuration = readFileSync(installed.configTarget, 'utf8');
      const saved = client === 'codex' ? parseToml(configuration) : JSON.parse(configuration);
      const server = saved[client === 'codex' ? 'mcp_servers' : 'mcpServers'][installed.alias];
      const credential = (client === 'codex' ? server.http_headers.Authorization : server.headers.Authorization).slice(7);
      expect(output.stdout).not.toContain(credential); expect(output.stdout).not.toContain(issued.code);
      expect(statSync(installed.configTarget).mode & 0o777).toBe(0o600);
      const premature = await callTool(credential, 'open_session', { title: 'must not write before client verification' });
      expect(premature.isError).toBe(true);
      const who = parsed(await callTool(credential, 'whoami'));
      expect(who.credential.installationId).toBe(installed.installationId);
      expect(who.credential.team).toBe('connector-e2e');
      expect((await callTool(credential, 'whoami')).isError).toBeFalsy(); // idempotent confirmation
      const revoked = await fetch(`${srv.url}/api/agent-enrollments/self-revoke`, { method: 'POST', headers: { authorization: `Bearer ${credential}` } });
      expect(revoked.status).toBe(200);
      const rejected = await fetch(`${srv.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: '{}' });
      expect(rejected.status).toBe(401);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('expires abandoned bootstrap authority without a sweeper and never revives a revoked setup', async () => {
  const owner = await devLogin('expiry-owner'); await createTeam(owner, 'Expiry Lab');
  const [team] = await srv.db.select().from(teams).where(eq(teams.slug, 'expiry-lab'));
  const setup = await createEnrollment(owner, { name: 'never-loaded', device: 'test-machine', access: `team:${team!.id}` });
  const data: any = await (await redeem(setup.code)).json();
  const before = await fetch(`${srv.url}/api/agent/installations/register`, { method: 'POST', headers: { authorization: `Bearer ${data.token}`, 'content-type': 'application/json' }, body: '{}' });
  expect(before.status).toBe(403);
  await srv.db.update(tokens).set({ setupExpiresAt: new Date(Date.now() - 1000) }).where(eq(tokens.name, 'test-machine · never-loaded'));
  const expired = await fetch(`${srv.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${data.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }) });
  expect(expired.status).toBe(401);
  expect((await redeem(setup.code)).status).toBe(404);
  const page = await fetch(`${srv.url}/app/tokens`, { headers: owner.header() }); expect(await page.text()).toContain('setup expired');
  const [row] = await srv.db.select().from(tokens).where(eq(tokens.name, 'test-machine · never-loaded'));
  expect(row!.activatedAt).toBeNull(); expect(row!.lastUsedAt).toBeNull();
});

function promptJsonValue(html: string, key: string) {
  const value = new RegExp(
    `(?:&quot;|")${key}(?:&quot;|")\\s*:\\s*(?:&quot;|")([^"&<]+)`,
  ).exec(html)?.[1];
  expect(value, `missing ${key} in rendered connection JSON`).toBeTruthy();
  return value!;
}

async function createTeam(cookies: CookieJar, name: string) {
  const response = await form(cookies, '/app/teams', { name });
  expect(response.status).toBe(302);
}

async function createEnrollment(
  cookies: CookieJar,
  input: { name: string; device: string; access: string; client?: string; role?: string },
) {
  const response = await form(cookies, '/app/tokens', {
    name: input.name,
    device: input.device,
    access: input.access,
    client: input.client ?? 'codex',
    role: input.role ?? 'generalist',
  });
  expect(response.status).toBe(200);
  const html = await response.text();
  const code = promptJsonValue(html, 'STMA_ENROLLMENT_CODE');
  expect(code).toMatch(/^stma_enroll_[0-9a-f]{40}$/);
  // The prompt transports a short-lived code, never a long-lived PAT.
  expect(/stma_[0-9a-f]{40}/.test(html)).toBe(false);
  return { code: code!, html };
}

async function redeem(code: string) {
  return fetch(`${srv.url}/api/agent-enrollments/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-scoped-enrollment-'));
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
});

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

it('redeems one project enrollment once and enforces it at the MCP boundary', async () => {
  const owner = await devLogin('scope-owner');
  await createTeam(owner, 'Scope Alpha');
  await createTeam(owner, 'Scope Beta');
  const bootstrap = await legacyToken(owner, 'bootstrap');

  const snapshot = { os: { platform: 'darwin', arch: 'arm64' } };
  expect(
    (await callTool(bootstrap, 'push_snapshot', {
      team: 'scope-alpha',
      repo: 'payments-api',
      device: 'bootstrap',
      snapshot,
    })).isError,
  ).toBeFalsy();
  expect(
    (await callTool(bootstrap, 'push_snapshot', {
      team: 'scope-alpha',
      repo: 'storefront',
      device: 'bootstrap',
      snapshot,
    })).isError,
  ).toBeFalsy();
  expect(
    (await callTool(bootstrap, 'push_snapshot', {
      team: 'scope-beta',
      repo: 'private-other-team',
      device: 'bootstrap',
      snapshot,
    })).isError,
  ).toBeFalsy();

  const picker = await fetch(
    `${srv.url}/app/tokens?team=scope-alpha&project=payments-api`,
    { headers: owner.header() },
  );
  const pickerHtml = await picker.text();
  // The scope bar says which workspace and project this connection is being made in.
  expect(pickerHtml).toMatch(/class="scope-at"[^>]*>\s*Scope Alpha/);
  expect(pickerHtml).toMatch(/class="scope-at in"[^>]*>\s*payments-api/);
  expect(pickerHtml).toContain('single-use 30-minute enrollment code');
  const access = /<option value="(project:[0-9a-f-]{36})" selected="">Project only — payments-api<\/option>/.exec(
    pickerHtml,
  )?.[1];
  expect(access).toBeTruthy();

  const enrollment = await createEnrollment(owner, {
    name: 'payments-reviewer',
    device: 'mac-mini',
    access: access!,
    role: 'reviewer',
  });
  expect(enrollment.html).toContain('STMA_GRANT_SCOPE&quot;: &quot;project');
  expect(enrollment.html).toContain('STMA_TARGET_TEAM&quot;: &quot;scope-alpha');
  expect(enrollment.html).toContain('STMA_TARGET_PROJECT&quot;: &quot;payments-api');
  expect(enrollment.html).toContain(`${srv.url}/api/agent-enrollments/redeem`);

  const attempts = await Promise.all([redeem(enrollment.code), redeem(enrollment.code)]);
  expect(attempts.map((response) => response.status).sort()).toEqual([200, 404]);
  const activatedResponse = attempts.find((response) => response.status === 200)!;
  expect(activatedResponse.headers.get('cache-control')).toBe('no-store');
  const activated = (await activatedResponse.json()) as any;
  expect(activated.token).toMatch(/^stma_[0-9a-f]{40}$/);
  expect(activated.endpoint).toBe(`${srv.url}/mcp`);
  expect(activated.grant).toMatchObject({
    scope: 'project',
    team: { slug: 'scope-alpha' },
    project: { slug: 'payments-api' },
  });
  expect(activated.installation).toMatchObject({
    name: 'payments-reviewer',
    clientType: 'codex',
    role: 'reviewer',
  });
  expect(activated.credential).toEqual({
    expiresAt: null,
    lifetime: 'until_revoked',
  });
  expect(activated.credential).not.toHaveProperty('token');
  expect(activated.validation).toEqual({
    endpoint: `${srv.url}/mcp`,
    enrollmentId: promptJsonValue(enrollment.html, 'STMA_ENROLLMENT_ID'),
    installationName: 'payments-reviewer',
    device: 'mac-mini',
    clientType: 'codex',
    role: 'reviewer',
    grantScope: 'project',
    teamSlug: 'scope-alpha',
    projectName: 'payments-api',
  });
  expect(activated.cleanup).toEqual({
    endpoint: `${srv.url}/api/agent-enrollments/self-revoke`,
    method: 'POST',
  });

  const who = parsed(await callTool(activated.token, 'whoami'));
  expect(who.credential).toMatchObject({
    scope: 'project',
    team: 'scope-alpha',
    project: 'payments-api',
    installationName: 'payments-reviewer',
    device: 'mac-mini',
  });
  expect(who.teams).toHaveLength(1);
  expect(who.teams[0].slug).toBe('scope-alpha');

  const projects = parsed(await callTool(activated.token, 'list_projects'));
  expect(projects.projects.map((project: { slug: string }) => project.slug)).toEqual([
    'payments-api',
  ]);

  const wrongTeam = await callTool(activated.token, 'list_projects', { team: 'scope-beta' });
  expect(wrongTeam.isError).toBe(true);
  expect(wrongTeam.content[0]!.text).toMatch(/cannot access team/i);
  const wrongProject = await callTool(activated.token, 'start_run', {
    project: 'storefront',
    task: 'SCOPE-0',
  });
  expect(wrongProject.isError).toBe(true);
  expect(wrongProject.content[0]!.text).toMatch(/cannot access project/i);

  // Omitted team/project/device are filled from the grant. An arbitrary agent
  // argument cannot rename the durable installation chosen by the human.
  const pushed = await callTool(activated.token, 'push_snapshot', {
    snapshot: { os: { platform: 'linux', arch: 'x64' } },
  });
  expect(pushed.isError).toBeFalsy();
  expect(pushed.content[0]!.text).toContain('mac-mini');

  const started = parsed(
    await callTool(activated.token, 'start_run', {
      task: 'SCOPE-1',
      agent: 'rename-attempt',
    }),
  );
  expect(started).toMatchObject({
    team: 'scope-alpha',
    project: 'payments-api',
    agent: 'payments-reviewer',
  });
});

it('pins project-scoped writes to a project created from a repository URL', async () => {
  const owner = await devLogin('repository-scope-owner');
  await createTeam(owner, 'Repository Scope Lab');
  const created = await form(owner, '/app/projects', {
    team: 'repository-scope-lab',
    project: 'https://github.com/Matte-AI-LLC/parcel-desk-agent-lab.git',
    return_to: 'tokens',
  });
  expect(created.status).toBe(302);

  const [team] = await srv.db
    .select()
    .from(teams)
    .where(eq(teams.slug, 'repository-scope-lab'))
    .limit(1);
  const [original] = await srv.db
    .select()
    .from(projectRows)
    .where(
      and(
        eq(projectRows.teamId, team!.id),
        eq(projectRows.repositoryIdentity, 'github.com/matte-ai-llc/parcel-desk-agent-lab'),
      ),
    )
    .limit(1);
  expect(original).toMatchObject({ name: 'parcel-desk-agent-lab' });

  const picker = await fetch(
    `${srv.url}/app/tokens?team=repository-scope-lab&project=${original!.slug}`,
    { headers: owner.header() },
  );
  const access = new RegExp(
    `<option value="(project:${original!.id})" selected="">Project only — parcel-desk-agent-lab</option>`,
  ).exec(await picker.text())?.[1];
  expect(access).toBeTruthy();
  const enrollment = await createEnrollment(owner, {
    name: 'repository-scoped-agent',
    device: 'repository-scope-device',
    access: access!,
  });
  const activation = await redeem(enrollment.code);
  expect(activation.status).toBe(200);
  const activated = (await activation.json()) as any;

  expect((await callTool(activated.token, 'whoami')).isError).toBeFalsy();
  const wrongRepository = await callTool(activated.token, 'start_run', {
    repository_identity: 'https://github.com/example/a-different-repository.git',
    scope: [{ type: 'path', key: 'wrong-repo.ts', access: 'write' }],
  });
  expect(wrongRepository.isError).toBe(true);
  expect(wrongRepository.content[0]!.text).toContain('Repository identity');

  expect(
    (await callTool(activated.token, 'push_snapshot', {
      snapshot: { os: { platform: 'darwin', arch: 'arm64' } },
    })).isError,
  ).toBeFalsy();
  const session = parsed(
    await callTool(activated.token, 'open_session', {
      title: 'Repository identity stays pinned',
    }),
  );
  const run = parsed(
    await callTool(activated.token, 'start_run', {
      task: 'REPO-1',
      scope: [{ type: 'path', key: 'src/component.ts', access: 'write' }],
    }),
  );

  const policyResponse = await fetch(`${srv.url}/api/control/policies`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${activated.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      team: 'repository-scope-lab',
      project: 'parcel-desk-agent-lab',
      document: { protectedPaths: ['src/**'] },
    }),
  });
  expect(policyResponse.status).toBe(200);
  const baselineResponse = await fetch(`${srv.url}/api/control/environment-baselines`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${activated.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      team: 'repository-scope-lab',
      project: 'parcel-desk-agent-lab',
      snapshot: { os: { platform: 'darwin', arch: 'arm64' } },
    }),
  });
  expect(baselineResponse.status).toBe(200);

  const allProjects = await srv.db
    .select()
    .from(projectRows)
    .where(eq(projectRows.teamId, team!.id));
  expect(allProjects).toHaveLength(1);
  expect(allProjects[0]!.id).toBe(original!.id);

  const [savedSnapshot] = await srv.db
    .select({ projectId: snapshots.projectId })
    .from(snapshots)
    .where(eq(snapshots.teamId, team!.id));
  const [savedSession] = await srv.db
    .select({ projectId: debugSessions.projectId })
    .from(debugSessions)
    .where(eq(debugSessions.id, session.sessionId));
  const [savedRun] = await srv.db
    .select({ projectId: agentRuns.projectId })
    .from(agentRuns)
    .where(eq(agentRuns.id, run.runId));
  const [savedPolicy] = await srv.db
    .select({ projectId: policyBundles.projectId })
    .from(policyBundles)
    .where(eq(policyBundles.teamId, team!.id));
  const [savedBaseline] = await srv.db
    .select({ projectId: environmentBaselines.projectId })
    .from(environmentBaselines)
    .where(eq(environmentBaselines.teamId, team!.id));
  expect([
    savedSnapshot!.projectId,
    savedSession!.projectId,
    savedRun!.projectId,
    savedPolicy!.projectId,
    savedBaseline!.projectId,
  ]).toEqual(Array(5).fill(original!.id));
});

it('starts a run in a project bound to a remote on its own port', async () => {
  // Found by the one-machine agent lab, whose git remote is a loopback daemon:
  // the stored identity "host:port/path" was canonicalized a second time as
  // scp syntax, so the checkout's own remote never matched its project and
  // every hooked run start was refused. Self-hosted git on a custom port —
  // Bitbucket's 7999 — hit the same wall.
  const owner = await devLogin('ported-remote-owner');
  await createTeam(owner, 'Ported Remote Lab');
  const remote = 'ssh://git@bitbucket.corp.example:7999/PAY/ledger.git';
  expect((await form(owner, '/app/projects', { team: 'ported-remote-lab', project: remote, return_to: 'tokens' })).status).toBe(302);
  const [team] = await srv.db.select().from(teams).where(eq(teams.slug, 'ported-remote-lab')).limit(1);
  const [project] = await srv.db
    .select()
    .from(projectRows)
    .where(and(eq(projectRows.teamId, team!.id), eq(projectRows.repositoryIdentity, 'bitbucket.corp.example:7999/pay/ledger')))
    .limit(1);
  expect(project).toMatchObject({ name: 'ledger' });

  const enrollment = await createEnrollment(owner, { name: 'ported-remote-agent', device: 'ported-remote-device', access: `project:${project!.id}` });
  const activated = (await (await redeem(enrollment.code)).json()) as any;
  expect((await callTool(activated.token, 'whoami')).isError).toBeFalsy();
  const started = await callTool(activated.token, 'start_run', {
    repository_identity: remote,
    scope: [{ type: 'path', key: 'src/ledger.ts', access: 'write' }],
  });
  expect(started.isError, started.content[0]!.text).toBeFalsy();
  expect(parsed(started).runId).toBeTruthy();

  const other = await callTool(activated.token, 'start_run', {
    repository_identity: 'ssh://git@bitbucket.corp.example:7998/PAY/ledger.git',
    scope: [{ type: 'path', key: 'src/other.ts', access: 'write' }],
  });
  expect(other.isError, 'another port is another remote').toBe(true);
});

it('logs non-secret installation and lifecycle correlation fields', async () => {
  const owner = await devLogin('stage-correlation-owner');
  await createTeam(owner, 'Stage Correlation Lab');
  const enrollment = await createEnrollment(owner, {
    name: 'lab-claude-run42',
    device: 'one-mac',
    access: 'personal',
    client: 'claude-code',
  });
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  let token = '';
  let installationId = '';
  try {
    const activation = await redeem(enrollment.code);
    expect(activation.status).toBe(200);
    const activated = (await activation.json()) as any;
    token = activated.token;
    installationId = activated.installation.id;
    expect(parsed(await callTool(token, 'whoami')).credential.installationId).toBe(installationId);
    const session = parsed(await callTool(token, 'open_session', {
      title: 'Safe correlation fixture',
    }));
    const startedResult = await callTool(token, 'start_run', {
      team: 'stage-correlation-lab',
      task: 'SAFE-42',
      scope: [{ type: 'path', key: 'public/app.js', access: 'write' }],
    });
    expect(startedResult.isError, startedResult.content[0]?.text).toBeFalsy();
    const started = parsed(startedResult);
    await callTool(token, 'update_run', { run_id: started.runId });
    await callTool(token, 'finish_run', { run_id: started.runId });

    const events = lines
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, any>);
    expect(events).toContainEqual(expect.objectContaining({
      evt: 'agent_enrollment',
      a: 'redeemed',
      installation: installationId,
      installationName: 'lab-claude-run42',
      device: 'one-mac',
      client: 'claude-code',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      evt: 'http',
      tool: 'tools/call:whoami',
      installation: installationId,
      scope: 'personal',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      evt: 'session',
      a: 'opened',
      session: session.sessionId,
      installation: installationId,
    }));
    for (const action of ['started', 'updated', 'finished']) {
      expect(events).toContainEqual(expect.objectContaining({
        evt: 'agent_run',
        a: action,
        run: started.runId,
        installation: installationId,
      }));
    }
    expect(lines.join('\n')).not.toContain(enrollment.code);
    expect(lines.join('\n')).not.toContain(token);
  } finally {
    spy.mockRestore();
  }
});

it('follows a stale enrollment Revoke to the connection when redemption won the race', async () => {
  const owner = await devLogin('enrollment-revoke-owner');
  await createTeam(owner, 'Enrollment Revoke Lab');

  const unused = await createEnrollment(owner, {
    name: 'unused-agent',
    device: 'unused-machine',
    access: 'personal',
  });
  const unusedId = promptJsonValue(unused.html, 'STMA_ENROLLMENT_ID');
  const revoked = await form(owner, `/app/enrollments/${unusedId}/revoke`, {});
  const revokedLocation = new URL(revoked.headers.get('location')!, srv.url);
  expect(revokedLocation.searchParams.get('ok')).toBe(
    'Unused setup code revoked. No credential was created by it.',
  );
  expect(await redeem(unused.code)).toMatchObject({ status: 404 });

  const alreadyRedeemed = await createEnrollment(owner, {
    name: 'redeemed-agent',
    device: 'redeemed-machine',
    access: 'personal',
  });
  const redeemedId = promptJsonValue(alreadyRedeemed.html, 'STMA_ENROLLMENT_ID');
  const activation = await redeem(alreadyRedeemed.code);
  expect(activation.status).toBe(200);
  const activated = (await activation.json()) as { token: string };

  const staleRevoke = await form(owner, `/app/enrollments/${redeemedId}/revoke`, { filter_team: 'enrollment-revoke-lab', filter_q: 'redeemed-agent' });
  const staleLocation = new URL(staleRevoke.headers.get('location')!, srv.url);
  expect(staleLocation.searchParams.get('team')).toBe('enrollment-revoke-lab');
  expect(staleLocation.searchParams.get('q')).toBe('redeemed-agent');
  expect(staleLocation.searchParams.get('error')).toBeNull();
  expect(staleLocation.searchParams.get('ok')).toContain('activated before this page refreshed');
  expect(staleLocation.searchParams.get('ok')).toContain('server credential are revoked');

  const afterStaleRevoke = await fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${activated.token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId++,
      method: 'tools/call',
      params: { name: 'whoami', arguments: {} },
    }),
  });
  expect(afterStaleRevoke.status).toBe(401);
  expect((await afterStaleRevoke.json()) as any).toMatchObject({
    error: 'unauthorized',
    hint: expect.stringMatching(/revoked|disabled/i),
  });
});

it('lets a failed installer revoke only its own freshly minted connection', async () => {
  const owner = await devLogin('self-revoke-owner');
  await createTeam(owner, 'Self Revoke Lab');
  const legacy = await legacyToken(owner, 'unrelated-legacy-token');
  const enrollment = await createEnrollment(owner, {
    name: 'failed-installer',
    device: 'test-machine',
    access: 'personal',
    client: 'claude-code',
  });
  expect(enrollment.html).toContain('STMA_TARGET_TEAM&quot;: null');
  expect(enrollment.html).toContain('STMA_TARGET_PROJECT&quot;: null');

  const activation = await redeem(enrollment.code);
  expect(activation.status).toBe(200);
  const activated = (await activation.json()) as any;
  expect(activated.validation).toEqual({
    endpoint: `${srv.url}/mcp`,
    enrollmentId: promptJsonValue(enrollment.html, 'STMA_ENROLLMENT_ID'),
    installationName: 'failed-installer',
    device: 'test-machine',
    clientType: 'claude-code',
    role: 'generalist',
    grantScope: 'personal',
    teamSlug: null,
    projectName: null,
  });

  const legacyAttempt = await fetch(`${srv.url}/api/agent-enrollments/self-revoke`, {
    method: 'POST',
    headers: { authorization: `Bearer ${legacy}` },
  });
  expect(legacyAttempt.status).toBe(409);
  expect((await callTool(legacy, 'whoami')).isError).toBeFalsy();

  const cleanup = await fetch(activated.cleanup.endpoint, {
    method: activated.cleanup.method,
    headers: { authorization: `Bearer ${activated.token}` },
  });
  expect(cleanup.status).toBe(200);
  expect(cleanup.headers.get('cache-control')).toBe('no-store');
  expect(await cleanup.json()).toEqual({
    ok: true,
    installationId: activated.installation.id,
    revoked: true,
  });

  const afterCleanup = await fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${activated.token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId++,
      method: 'tools/call',
      params: { name: 'whoami', arguments: {} },
    }),
  });
  expect(afterCleanup.status).toBe(401);
  expect((await afterCleanup.json()) as any).toMatchObject({
    error: 'unauthorized',
    hint: expect.stringMatching(/revoked/i),
  });
});

it('lets a teammate connect their own scoped agent but keeps invitations owner-only', async () => {
  const owner = await devLogin('membership-owner');
  await createTeam(owner, 'Membership Lab');
  const ownerToken = await legacyToken(owner, 'membership-owner-bootstrap');
  const invite = parsed(
    await callTool(ownerToken, 'create_invite', { team: 'membership-lab', max_uses: 2 }),
  );

  const member = await devLogin('membership-member');
  const join = await form(member, `/join/${invite.code}`, {});
  expect(join.status).toBe(302);

  const picker = await fetch(`${srv.url}/app/tokens?team=membership-lab`, {
    headers: member.header(),
  });
  const pickerHtml = await picker.text();
  const teamAccess = /<option value="(team:[0-9a-f-]{36})" selected="">Entire workspace — membership-lab<\/option>/.exec(
    pickerHtml,
  )?.[1];
  expect(teamAccess).toBeTruthy();

  const enrollment = await createEnrollment(member, {
    name: 'member-codex',
    device: 'member-laptop',
    access: teamAccess!,
  });
  const activatedResponse = await redeem(enrollment.code);
  expect(activatedResponse.status).toBe(200);
  const activated = (await activatedResponse.json()) as any;
  const who = parsed(await callTool(activated.token, 'whoami'));
  expect(who.credential).toMatchObject({ scope: 'team', team: 'membership-lab' });

  const forbidden = await callTool(activated.token, 'create_invite');
  expect(forbidden.isError).toBe(true);
  expect(forbidden.content[0]!.text).toContain('Only a team owner');

  const people = await fetch(`${srv.url}/app/teams/membership-lab?tab=people`, {
    headers: owner.header(),
  });
  const memberId = /\/app\/teams\/membership-lab\/members\/([0-9a-f-]{36})\/remove/.exec(
    await people.text(),
  )?.[1];
  expect(memberId).toBeTruthy();
  expect(
    (await form(owner, `/app/teams/membership-lab/members/${memberId}/remove`, {})).status,
  ).toBe(302);

  const afterRemoval = await fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${activated.token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId++,
      method: 'tools/call',
      params: { name: 'whoami', arguments: {} },
    }),
  });
  expect(afterRemoval.status).toBe(401);
  expect((await afterRemoval.json()) as any).toMatchObject({
    error: 'unauthorized',
    hint: expect.stringMatching(/no longer a member/i),
  });
});

it('can join a human and bind their first team agent in the same invite redemption', async () => {
  const owner = await devLogin('invite-owner');
  await createTeam(owner, 'One Prompt Team');
  const ownerToken = await legacyToken(owner, 'invite-owner-bootstrap');
  const invite = parsed(
    await callTool(ownerToken, 'create_invite', { team: 'one-prompt-team', max_uses: 1 }),
  );
  expect(invite.teammateInstructions).toContain(
    'installs no MCP configuration and mints no agent credential',
  );
  expect(invite.teammateInstructions).toContain('Pasting this block is not approval');

  const invalidClient = await fetch(`${srv.url}/api/invites/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: invite.code,
      email: 'one-prompt-member@example.com',
      password: 'safe-test-password',
      agent_name: 'new-member-agent',
      device: 'workstation',
      client: 'made-up-client',
    }),
  });
  expect(invalidClient.status).toBe(400);
  expect(await invalidClient.text()).toContain('client must be one of');

  const response = await fetch(`${srv.url}/api/invites/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: invite.code,
      email: 'one-prompt-member@example.com',
      password: 'safe-test-password',
      agent_name: 'new-member-agent',
      device: 'workstation',
      client: 'cursor',
      role: 'implementer',
    }),
  });
  expect(response.status).toBe(200);
  const joined = (await response.json()) as any;
  expect(joined.grant).toEqual({ scope: 'team', team: 'one-prompt-team', project: null });
  expect(joined.installation).toMatchObject({
    name: 'new-member-agent',
    clientType: 'cursor',
    role: 'implementer',
  });
  expect(JSON.stringify(joined).match(new RegExp(joined.token, 'g'))).toHaveLength(1);
  expect(joined.connect).toMatchObject({ endpoint: `${srv.url}/mcp` });
  expect(joined.connect).not.toHaveProperty('claudeCode');

  const who = parsed(await callTool(joined.token, 'whoami'));
  expect(who.credential).toMatchObject({
    scope: 'team',
    team: 'one-prompt-team',
    installationName: 'new-member-agent',
    device: 'workstation',
  });
  expect(who.teams.map((team: { slug: string }) => team.slug)).toEqual(['one-prompt-team']);
});
