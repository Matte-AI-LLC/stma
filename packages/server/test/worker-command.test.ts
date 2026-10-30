import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { generatePat } from '../src/auth/pat';
import { agentInstallations, executionAttempts, executionJobs, executionTargets, memberships, projects, teams, tokens, users, workerInstances } from '../src/db/schema';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';
import { canonicalCheckout, readWorkerJson, workerDirectory, type WorkerConfig, type WorkerJournal } from '../../cli/src/workerState';

it('runs built worker configure/start/status/stop against a disabled target without provider authentication or launch', async () => {
  const directory = canonicalCheckout(mkdtempSync(path.join(os.tmpdir(), 'stma-worker-command-')));
  const checkout = path.join(directory, 'checkout'); const home = path.join(directory, 'home');
  mkdirSync(checkout, { mode: 0o700 }); mkdirSync(home, { mode: 0o700 });
  execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', 'init', '-b', 'main'], { cwd: checkout, windowsHide: true, stdio: 'pipe' });
  execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/worker-command.git'], { cwd: checkout, windowsHide: true, stdio: 'pipe' });
  // npm pretest builds this same standalone entrypoint before the suite on every OS.
  const cli = fileURLToPath(new URL('../dist/agent-runtime.js', import.meta.url));
  expect(existsSync(cli)).toBe(true);
  const runtimeCalls = path.join(directory, 'runtime-calls.jsonl');
  const fakeRuntime = path.join(directory, 'version-fixture.cjs');
  const preload = path.join(directory, 'runtime-fixture.mjs');
  writeFileSync(fakeRuntime, `if(JSON.stringify(process.argv.slice(2))!=='["--version"]')process.exit(91);console.log('2.1.278 (Claude Code)');`);
  // Only the native version boundary is substituted, with another real process.
  // The built command, private state, HTTP requests and Windows ACL handling stay real.
  // This is command wiring coverage, not proof of a real provider's CLI compatibility.
  writeFileSync(preload, `
import cp from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const originalSync = cp.spawnSync;
const originalSpawn = cp.spawn;
const executable = realpathSync.native(process.execPath);
const calls = ${JSON.stringify(runtimeCalls)};
function isRuntime(value) { try { return realpathSync.native(value) === executable; } catch { return false; } }
cp.spawnSync = function (file, args, options) {
  if (!isRuntime(file)) return originalSync(file, args, options);
  const version = JSON.stringify(args) === '["--version"]';
  appendFileSync(calls, JSON.stringify(version ? 'version' : 'forbidden-auth-or-runtime') + '\\n', { mode: 0o600 });
  if (!version) throw new Error('Provider calls are forbidden in the command fixture.');
  return originalSync(file, [${JSON.stringify(fakeRuntime)}, ...args], options);
};
cp.spawn = function (file, args, options) {
  if (!isRuntime(file)) return originalSpawn(file, args, options);
  appendFileSync(calls, JSON.stringify('forbidden-runtime') + '\\n', { mode: 0o600 });
  throw new Error('Provider calls are forbidden in the command fixture.');
};
syncBuiltinESMExports();
`);
  let server: StartedServer | undefined;
  const children = new Set<ReturnType<typeof spawn>>();
  try {
    server = await startServer(loadEnv({ port: 0, host: '127.0.0.1', baseUrl: 'http://127.0.0.1:0', nodeEnv: 'test', devMode: true,
      hosted: false, databaseUrl: undefined, migrationsDir: undefined, pgliteDir: path.join(directory, 'db'),
      github: undefined, clickup: undefined, resendApiKey: undefined }));
    const db = server.db;
    const user = (await db.insert(users).values({ username: 'worker-command-owner' }).returning())[0]!;
    const team = (await db.insert(teams).values({ name: 'Worker command', slug: 'worker-command', createdBy: user.id }).returning())[0]!;
    await db.insert(memberships).values({ userId: user.id, teamId: team.id, role: 'owner' });
    const project = (await db.insert(projects).values({ teamId: team.id, name: 'fixture', slug: 'fixture', repositoryIdentity: 'example.invalid/worker-command', createdBy: user.id }).returning())[0]!;
    const pat = generatePat();
    const token = (await db.insert(tokens).values({ userId: user.id, name: 'fixture', tokenHash: pat.hash, prefix: pat.prefix, scope: 'project', teamId: team.id, projectId: project.id }).returning())[0]!;
    const installation = (await db.insert(agentInstallations).values({ userId: user.id, tokenId: token.id, name: 'fixture', deviceFingerprint: 'worker-command-fixture', clientType: 'claude-code' }).returning())[0]!;
    // Never inherit personal configuration, provider keys, preload options or credential routing.
    const environment: NodeJS.ProcessEnv = {};
    for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']) {
      const source = Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase());
      if (source) environment[name] = process.env[source];
    }
    Object.assign(environment, { HOME: home, USERPROFILE: home, STMA_URL: server.url, STMA_TOKEN: pat.token, FIXTURE_PROVIDER_KEY: 'synthetic-provider-never-used' });
    const command = (...args: string[]) => {
      const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, cli, 'worker', ...args], {
        cwd: checkout, env: environment, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
      });
      children.add(child);
      let stdout = ''; let stderr = '';
      child.stdout!.setEncoding('utf8'); child.stdout!.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr!.setEncoding('utf8'); child.stderr!.on('data', (chunk: string) => { stderr += chunk; });
      const completion = new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => { children.delete(child); resolve({ code, signal, stdout, stderr }); });
      });
      return { completion };
    };
    const configured = await command('configure', '--dedicated', '--server', server.url, '--runtime-executable', process.execPath,
      '--api-key-env', 'FIXTURE_PROVIDER_KEY', '--max-runtime-seconds', '60', '--max-turns', '1').completion;
    expect(configured.code, configured.stderr).toBe(0);
    expect(configured.stdout).not.toContain(pat.token);
    const state = workerDirectory(checkout, home);
    const config = readWorkerJson<WorkerConfig>(path.join(state, 'config.json'))!;
    expect(config).toMatchObject({ checkout, server: server.url, installationId: installation.id, apiKeyEnv: 'FIXTURE_PROVIDER_KEY', runtimeVersion: '2.1.278', maxRuntimeSeconds: 60, maxTurns: 1 });
    expect(readFileSync(config.hookRuntime)).toEqual(readFileSync(cli));
    expect(readFileSync(path.join(state, 'config.json'), 'utf8')).not.toContain(pat.token);
    const [target] = await db.select().from(executionTargets).where(eq(executionTargets.id, config.targetId));
    expect(target).toMatchObject({ enabled: false, installationId: installation.id, checkoutPath: checkout });

    const started = command('start');
    await expect.poll(async () => (await db.select().from(workerInstances).where(eq(workerInstances.targetId, config.targetId))).length, { timeout: 10_000 }).toBe(1);
    await expect.poll(() => readWorkerJson<WorkerJournal>(path.join(state, 'journal.json'))?.phase, { timeout: 10_000 }).toBe('idle');
    const status = await command('status').completion;
    expect(status.code, status.stderr).toBe(0);
    const snapshot = JSON.parse(status.stdout);
    expect(snapshot).toMatchObject({ configured: true, checkout, api_key_present: true, journal: { phase: 'idle' }, control: { command: 'run' } });
    const [worker] = await db.select().from(workerInstances).where(eq(workerInstances.targetId, config.targetId));
    expect(snapshot.owner.owner).toBe(worker!.id);
    expect(snapshot.journal.workerId).toBe(worker!.id);

    const stopped = await command('stop').completion;
    expect(stopped.code, stopped.stderr).toBe(0);
    const ended = await started.completion;
    expect(ended.code, ended.stderr).toBe(0);
    expect(ended.signal).toBeNull();
    expect(existsSync(path.join(state, 'owner.lock'))).toBe(false);
    expect((await db.select().from(executionTargets).where(eq(executionTargets.id, config.targetId)))[0]).toMatchObject({ enabled: false, quarantined: false });
    expect(await db.select().from(executionJobs)).toHaveLength(0);
    expect(await db.select().from(executionAttempts)).toHaveLength(0);
    expect(readFileSync(runtimeCalls, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual(['version', 'version']);
  } finally {
    // Only this test's own command handles can be stopped; never search for or kill other PIDs.
    await Promise.all([...children].map((child) => new Promise<void>((resolve) => { child.once('close', () => resolve()); child.kill(); })));
    await server?.close();
    if (path.dirname(directory) === canonicalCheckout(os.tmpdir())) rmSync(directory, { recursive: true, force: true });
  }
});
