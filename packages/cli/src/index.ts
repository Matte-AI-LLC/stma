import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PolicyDocument, Snapshot, WorkClaim } from '@bridge/shared';
import {
  ADAPTER_TARGETS,
  installAdapter,
  loadAdapterConfig,
  type AdapterConfig,
  type AdapterTarget,
} from './adapters.js';
import { LOCKFILE_NAMES, dotenvNames, scanEcosystems } from './collect.js';
import {
  NEWS_TIMEOUT_MS,
  dueForCheck,
  handoffKey,
  rememberAnnounced,
  renderNews,
  unseen,
  type News,
} from './news.js';
import { gitBlobHash } from './hash.js';
import { defaultDataDir, serve } from './serve.js';
import { applyPolicy } from './policy.js';
import { VERSION, clientHeaders } from './version.js';

interface LocalConfig {
  server?: string;
  /** When the hook last asked the server what is waiting, and what it already said. */
  newsCheckedAt?: string;
  newsAnnounced?: string[];
  installationId?: string;
  agentName?: string;
  clientType?: string;
  currentRunId?: string;
  currentTeam?: string;
  currentProject?: string;
  currentClaims?: WorkClaim[];
  adapterRuns?: Record<string, string>;
}

interface QueuedHook {
  id: string;
  event: 'start' | 'heartbeat' | 'finish';
  payload: Record<string, unknown>;
  queuedAt: string;
}

type Flags = Map<string, string[]>;

const cwd = process.cwd();
const stmaDir = path.join(cwd, '.stma');
const configPath = path.join(stmaDir, 'local.json');
const outboxPath = path.join(stmaDir, 'outbox.json');

function loadConfig(): LocalConfig {
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf8')) as LocalConfig;
  } catch {
    fail(`Could not read ${configPath}. Fix or remove the invalid JSON file.`);
  }
}

function saveConfig(config: LocalConfig): void {
  mkdirSync(stmaDir, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function parseFlags(args: string[]): { flags: Flags; passthrough: string[] } {
  const flags: Flags = new Map();
  const separator = args.indexOf('--');
  const own = separator === -1 ? args : args.slice(0, separator);
  const passthrough = separator === -1 ? [] : args.slice(separator + 1);
  for (let i = 0; i < own.length; i++) {
    const arg = own[i]!;
    if (!arg.startsWith('--')) fail(`Unexpected argument: ${arg}`);
    const eq = arg.indexOf('=');
    const key = arg.slice(2, eq === -1 ? undefined : eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const next = own[i + 1];
    const value = inline ?? (next && !next.startsWith('--') ? (i++, next) : 'true');
    const list = flags.get(key) ?? [];
    list.push(value);
    flags.set(key, list);
  }
  return { flags, passthrough };
}

const one = (flags: Flags, key: string): string | undefined => flags.get(key)?.at(-1);
const all = (flags: Flags, key: string): string[] => flags.get(key) ?? [];
const required = (flags: Flags, key: string): string =>
  one(flags, key) ?? fail(`--${key} is required.`);

function fail(message: string): never {
  console.error(`stma: ${message}`);
  process.exit(1);
}

function shell(command: string, args: string[]): string | undefined {
  try {
    return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

function gitContext() {
  return {
    repo: path.basename(shell('git', ['rev-parse', '--show-toplevel']) ?? cwd),
    branch: shell('git', ['branch', '--show-current']),
    baseSha: shell('git', ['rev-parse', 'HEAD']),
    worktree: shell('git', ['rev-parse', '--show-toplevel']),
  };
}

function dirtyFiles(): string[] {
  const output = shell('git', ['status', '--porcelain']);
  if (!output) return [];
  return output
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim().split(' -> ').at(-1)!)
    .filter(Boolean);
}

function parseClaim(value: string): WorkClaim {
  const parts = value.split(':');
  const types = new Set(['path', 'component', 'contract', 'migration', 'config']);
  if (!types.has(parts[0]!)) return { resourceType: 'path', resourceKey: value, access: 'write' };
  const resourceType = parts.shift() as WorkClaim['resourceType'];
  const possibleAccess = parts.at(-1);
  const access = possibleAccess === 'read' || possibleAccess === 'write' ? parts.pop()! : 'write';
  const resourceKey = parts.join(':');
  if (!resourceKey) fail(`Invalid scope claim: ${value}`);
  return { resourceType, resourceKey, access: access as WorkClaim['access'] };
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function collectSnapshot(): Snapshot {
  const lockfiles = LOCKFILE_NAMES.filter((name) => existsSync(path.join(cwd, name))).map(
    (name) => ({ path: name, hash: gitBlobHash(readFileSync(path.join(cwd, name))) }),
  );
  const git = gitContext();
  const npmVersion = existsSync(path.join(cwd, 'package.json'))
    ? shell('npm', ['--version'])
    : undefined;
  // Node is free — we are running on it. Everything else is probed only when the
  // repository looks like it needs it, so a Go team gets go and cargo rather than
  // node and npm, and nobody pays for a battery of probes they do not use.
  const scan = scanEcosystems(cwd);
  return {
    schemaVersion: 1,
    os: { platform: process.platform, release: os.release(), arch: process.arch },
    shell: process.env.SHELL ?? process.env.ComSpec,
    runtimes: { node: process.version.replace(/^v/, ''), ...scan.runtimes },
    packageManagers: { ...(npmVersion ? { npm: npmVersion } : {}), ...scan.packageManagers },
    lockfiles,
    envVarNames: [...new Set([...Object.keys(process.env), ...dotenvNames(cwd)])].sort(),
    git: {
      branch: git.branch,
      sha: git.baseSha,
      dirtyFiles: dirtyFiles(),
      aheadBehind: shell('git', ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']),
    },
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    collectedAt: new Date().toISOString(),
  };
}

function connection(config: LocalConfig) {
  const server = (process.env.STMA_URL ?? config.server ?? 'http://localhost:3000').replace(/\/$/, '');
  const token = process.env.STMA_TOKEN;
  if (!token) throw new Error('Set STMA_TOKEN to a personal access token. Tokens are never written to local config.');
  return { server, token };
}

async function apiRequest<T>(config: LocalConfig, endpoint: string, init: RequestInit = {}): Promise<T> {
  const { server, token } = connection(config);
  const response = await fetch(`${server}${endpoint}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      // Say which client this is on every call. The server never requires it —
      // an older CLI has to keep working — but a version mix that is visible in
      // the logs is one nobody has to reconstruct from a bug report.
      ...clientHeaders(),
      ...init.headers,
    },
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    // Carry the status so callers can tell a request that will never succeed
    // from one worth retrying later.
    const failure = Object.assign(new Error(data.error ?? `HTTP ${response.status}`), {
      status: response.status,
    });
    throw failure;
  }
  return data;
}

/**
 * A 404 from a STMA server is ambiguous in exactly one expensive way: the
 * endpoint may not exist *yet*. The npm packages and the servers people run
 * themselves move on their own schedules, so a new CLI talking to last
 * quarter's self-hosted instance is normal, and "HTTP 404" sends somebody
 * looking for a bug that is really a version gap. Ask /health — it names the
 * build — and say so. Best-effort and short: this runs on the way to an error
 * that is being printed anyway.
 */
async function skewNote(server: string): Promise<string> {
  try {
    const res = await fetch(`${server}/health`, { signal: AbortSignal.timeout(2_000) });
    const health = (await res.json()) as { version?: string };
    if (!health.version || health.version === VERSION) return '';
    return `\n  The server reports version ${health.version}; this CLI is ${VERSION}. If that endpoint is newer than the server, upgrade it (npm i -g @matteai/stma-server) or use a CLI of the same version.`;
  } catch {
    return '';
  }
}

async function request<T>(config: LocalConfig, endpoint: string, init: RequestInit = {}): Promise<T> {
  try {
    return await apiRequest<T>(config, endpoint, init);
  } catch (error) {
    const server = (process.env.STMA_URL ?? config.server ?? 'http://localhost:3000').replace(/\/$/, '');
    const status = (error as { status?: number }).status;
    const note = status === 404 ? await skewNote(server) : '';
    fail(`Request to ${server} failed: ${error instanceof Error ? error.message : String(error)}${note}`);
  }
}

function printConflicts(conflicts: Array<Record<string, any>>): void {
  if (conflicts.length === 0) {
    console.log('Conflict radar: clear');
    return;
  }
  console.log(`Conflict radar: ${conflicts.length} overlap(s)`);
  for (const conflict of conflicts) {
    console.log(
      `  ${String(conflict.severity).toUpperCase()} ${conflict.current.resourceType}:${conflict.current.resourceKey}` +
        ` overlaps ${conflict.existing.agentName} (${conflict.existing.owner}, ${conflict.existing.taskKey ?? 'no task'})`,
    );
  }
}

async function register(flags: Flags): Promise<void> {
  const config = loadConfig();
  const name = required(flags, 'name');
  const clientType = one(flags, 'client') ?? 'generic';
  const rawDevice = `${os.hostname()}\0${os.userInfo().username}\0${process.platform}`;
  const deviceFingerprint = sha256(rawDevice);
  const result = await request<any>(config, '/api/agent/installations/register', {
    method: 'POST',
    body: JSON.stringify({
      name,
      clientType,
      clientVersion: one(flags, 'version'),
      deviceFingerprint,
      capabilities: all(flags, 'capability'),
      role: one(flags, 'role'),
    }),
  });
  saveConfig({
    ...config,
    server: connection(config).server,
    installationId: result.installation.id,
    agentName: name,
    clientType,
  });
  console.log(`Registered ${name} (${clientType}) as ${result.installation.id}`);
}

async function startRun(flags: Flags): Promise<any> {
  const config = loadConfig();
  const installationId = one(flags, 'agent') ?? config.installationId;
  if (!installationId) fail('Register an agent first or pass --agent.');
  const team = required(flags, 'team');
  const project = one(flags, 'project');
  const git = gitContext();
  const claims = all(flags, 'scope').map(parseClaim);
  const result = await request<any>(config, '/api/agent/runs/start', {
    method: 'POST',
    body: JSON.stringify({
      installationId,
      team,
      project,
      taskKey: one(flags, 'task'),
      intent: one(flags, 'intent'),
      repo: one(flags, 'repo') ?? project ?? git.repo,
      branch: one(flags, 'branch') ?? git.branch,
      worktree: one(flags, 'worktree') ?? git.worktree,
      baseSha: git.baseSha,
      claims,
      attemptGroup: one(flags, 'attempt-group'),
    }),
  });
  saveConfig({
    ...config,
    currentRunId: result.run.id,
    currentTeam: team,
    currentProject: project,
    currentClaims: claims,
  });
  console.log(`Run started: ${result.run.id}`);
  printConflicts(result.conflicts ?? []);
  if (result.policy) {
    console.log(`Effective policy: ${result.policy.hash} (${result.policy.sources.length} source(s))`);
  }
  return result;
}

async function heartbeat(flags: Flags): Promise<void> {
  const config = loadConfig();
  const runId = one(flags, 'run') ?? config.currentRunId;
  if (!runId) fail('No current run. Pass --run or start one first.');
  const actualClaims: WorkClaim[] = dirtyFiles().map((file) => ({
    resourceType: 'path',
    resourceKey: file,
    access: 'write',
  }));
  const claims = [...(config.currentClaims ?? []), ...actualClaims].filter(
    (claim, index, list) =>
      list.findIndex(
        (other) =>
          other.resourceType === claim.resourceType &&
          other.resourceKey === claim.resourceKey &&
          other.access === claim.access,
      ) === index,
  );
  const result = await request<any>(config, `/api/agent/runs/${runId}/heartbeat`, {
    method: 'POST',
    body: JSON.stringify({ status: one(flags, 'status'), claims, usage: quotaFlags(flags) }),
  });
  console.log(`Heartbeat: ${result.status}`);
  printConflicts(result.conflicts ?? []);
  printQuota(result);
}

/**
 * The vendor allowance as seen from inside a lifecycle hook.
 *
 * Two sources, both of them the client's own word. A client that puts usage in
 * its hook payload is read directly; everything else can export STMA_USED_PCT
 * (a wrapper script, a shell function, the client's own settings). Nothing is
 * inferred: a guessed percentage that triggers a handoff is worse than no
 * percentage at all.
 */
function hookQuota(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const fromPayload = payload.usage ?? payload.quota;
  if (fromPayload && typeof fromPayload === 'object') {
    const u = fromPayload as Record<string, unknown>;
    const pct = Number(u.usedPct ?? u.used_pct ?? u.percent_used);
    if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
      return {
        usedPct: pct,
        resetsAt: typeof u.resetsAt === 'string' ? u.resetsAt : undefined,
        label: typeof u.label === 'string' ? u.label : undefined,
      };
    }
  }
  const env = Number(process.env.STMA_USED_PCT);
  if (!Number.isFinite(env) || env < 0 || env > 100) return undefined;
  return {
    usedPct: env,
    resetsAt: process.env.STMA_QUOTA_RESETS_AT || undefined,
    label: process.env.STMA_QUOTA_LABEL || undefined,
  };
}

/**
 * The vendor allowance, if this invocation was told about it. Only the client
 * knows the number, so the CLI's job is to carry it, not to guess it — a hook
 * or a wrapper script passes --used-pct, and everything downstream follows.
 */
function quotaFlags(flags: Flags): Record<string, unknown> | undefined {
  const raw = one(flags, 'used-pct');
  if (raw === undefined) return undefined;
  const usedPct = Number(raw);
  if (!Number.isFinite(usedPct) || usedPct < 0 || usedPct > 100) {
    fail('--used-pct must be a number between 0 and 100.');
  }
  return {
    usedPct,
    resetsAt: one(flags, 'resets-at'),
    label: one(flags, 'quota-label'),
  };
}

/** Say it in the terminal too — a warning only the agent can read is half a warning. */
function printQuota(result: any): void {
  const quota = result?.quota;
  if (!quota || quota.state === 'ok') return;
  console.log(
    `${quota.state === 'critical' ? 'QUOTA CRITICAL' : 'Quota warning'}: ${quota.usedPct}% used${quota.label ? ` (${quota.label})` : ''}`,
  );
  if (quota.advice) console.log(`  ${quota.advice}`);
}

async function finish(flags: Flags): Promise<void> {
  const config = loadConfig();
  const runId = one(flags, 'run') ?? config.currentRunId;
  if (!runId) fail('No current run. Pass --run or start one first.');
  const result = await request<any>(config, `/api/agent/runs/${runId}/finish`, {
    method: 'POST',
    body: JSON.stringify({
      status: one(flags, 'status') ?? 'completed',
      detail: one(flags, 'detail'),
    }),
  });
  if (config.currentRunId === runId) {
    saveConfig({ ...config, currentRunId: undefined, currentClaims: undefined });
  }
  console.log(`Run ${result.runId}: ${result.status}`);
}

async function listRuns(flags: Flags): Promise<void> {
  const config = loadConfig();
  const team = one(flags, 'team');
  const result = await request<any>(config, `/api/agent/runs/active${team ? `?team=${encodeURIComponent(team)}` : ''}`);
  if (result.runs.length === 0) return console.log('No active runs.');
  for (const run of result.runs) {
    console.log(
      `${run.id}  ${run.owner}/${run.installation.name}  ${run.team}/${run.project ?? '—'}  ` +
        `${run.taskKey ?? 'no-task'}  ${run.status}  ${run.branch ?? '—'}`,
    );
  }
}

async function publishPolicy(flags: Flags): Promise<void> {
  const config = loadConfig();
  const file = one(flags, 'file') ?? path.join(stmaDir, 'policy.json');
  if (!existsSync(file)) fail(`Policy file not found: ${file}`);
  const document = JSON.parse(readFileSync(file, 'utf8')) as PolicyDocument;
  const result = await request<any>(config, '/api/control/policies', {
    method: 'POST',
    body: JSON.stringify({
      team: required(flags, 'team'),
      project: one(flags, 'project'),
      document,
    }),
  });
  console.log(`Published policy v${result.policy.version}: ${result.policy.hash}`);
}

async function pullPolicy(flags: Flags): Promise<void> {
  const config = loadConfig();
  const team = required(flags, 'team');
  const project = one(flags, 'project');
  const query = new URLSearchParams({ team, ...(project ? { project } : {}) });
  const result = await request<any>(config, `/api/agent/policies/effective?${query}`);
  console.log(JSON.stringify(result, null, 2));
  if (one(flags, 'apply') === 'true') {
    const reportedHash = applyPolicy(cwd, result.document, result.hash, config.clientType);
    console.log(`Applied policy for ${config.clientType ?? 'generic'} and wrote .stma/effective-policy.json`);
    if (config.currentRunId) {
      await request(config, `/api/agent/runs/${config.currentRunId}/policy-receipt`, {
        method: 'POST',
        body: JSON.stringify({ expectedHash: result.hash, reportedHash }),
      });
    }
  }
}

async function environment(flags: Flags, action: 'baseline' | 'preflight'): Promise<void> {
  const config = loadConfig();
  const body = {
    team: required(flags, 'team'),
    project: required(flags, 'project'),
    runId: one(flags, 'run') ?? config.currentRunId,
    snapshot: collectSnapshot(),
  };
  const endpoint =
    action === 'baseline'
      ? '/api/control/environment-baselines'
      : '/api/agent/environment/preflight';
  const result = await request<any>(config, endpoint, { method: 'POST', body: JSON.stringify(body) });
  console.log(JSON.stringify(result, null, 2));
}

async function execRun(flags: Flags, command: string[]): Promise<void> {
  if (command.length === 0) fail('Pass a command after --, for example: stma run exec ... -- claude');
  const started = await startRun(flags);
  const runId = started.run.id as string;
  let heartbeatBusy = false;
  const timer = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    void heartbeat(new Map([['run', [runId]]])).finally(() => (heartbeatBusy = false));
  }, 60_000);
  const child = spawn(command[0]!, command.slice(1), { cwd, stdio: 'inherit', env: process.env });
  const code = await new Promise<number>((resolve) => {
    child.on('exit', (value) => resolve(value ?? 1));
    child.on('error', () => resolve(1));
  });
  clearInterval(timer);
  await finish(new Map([['run', [runId]], ['status', [code === 0 ? 'completed' : 'failed']]]));
  process.exitCode = code;
}

function adapterInstall(flags: Flags): void {
  const targetValue = required(flags, 'target');
  if (!ADAPTER_TARGETS.includes(targetValue as AdapterTarget)) {
    fail(`--target must be one of: ${ADAPTER_TARGETS.join(', ')}`);
  }
  const target = targetValue as AdapterTarget;
  const local = loadConfig();
  const adapter: AdapterConfig = {
    schemaVersion: 1,
    target,
    team: required(flags, 'team'),
    project: one(flags, 'project'),
    agentName: one(flags, 'name') ?? `${os.userInfo().username}-${target}`,
    defaultTask: one(flags, 'task'),
    defaultIntent: one(flags, 'intent'),
    applyPolicy: one(flags, 'policy') !== 'false',
    preflight: one(flags, 'preflight') !== 'false',
  };
  const apply = one(flags, 'apply') === 'true';
  const result = installAdapter({
    root: cwd,
    config: adapter,
    command: one(flags, 'command') ?? 'stma',
    apply,
  });

  if (!apply) {
    console.log(`Dry run for ${target}. Nothing was written.`);
    console.log(`Hook file: ${result.hookPath}`);
    console.log(JSON.stringify(result.hooks, null, 2));
    console.log('Run again with --apply after reviewing the hook command.');
    return;
  }

  saveConfig({
    ...local,
    server: (process.env.STMA_URL ?? local.server ?? 'http://localhost:3000').replace(/\/$/, ''),
    agentName: adapter.agentName,
    clientType: target,
  });
  console.log(`Installed ${target} lifecycle hooks at ${result.hookPath}`);
  console.log(`Adapter ownership config: ${result.adapterPath}`);
  if (target === 'codex') console.log('Open /hooks in Codex and trust the new project hooks.');
}

function readHookPayload(): Record<string, unknown> {
  if (process.stdin.isTTY) return {};
  const raw = readFileSync(0, 'utf8');
  if (!raw.trim()) return {};
  if (raw.length > 1_000_000) throw new Error('Hook input exceeds 1 MB.');
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function hookSessionKey(adapter: AdapterConfig, payload: Record<string, unknown>): string {
  for (const key of ['session_id', 'conversation_id', 'conversationId', 'thread_id', 'threadId']) {
    if (typeof payload[key] === 'string' && payload[key]) return `${adapter.target}:${payload[key]}`;
  }
  return `${adapter.target}:${sha256(cwd).slice(0, 20)}`;
}

function hookIntent(adapter: AdapterConfig, payload: Record<string, unknown>): string | undefined {
  for (const key of ['prompt', 'user_prompt', 'message', 'task']) {
    if (typeof payload[key] === 'string' && payload[key]) return payload[key].slice(0, 2_000);
  }
  return adapter.defaultIntent;
}

function loadOutbox(): QueuedHook[] {
  if (!existsSync(outboxPath)) return [];
  try {
    const data = JSON.parse(readFileSync(outboxPath, 'utf8')) as unknown;
    return Array.isArray(data) ? (data as QueuedHook[]).slice(-500) : [];
  } catch {
    return [];
  }
}

function saveOutbox(events: QueuedHook[]): void {
  mkdirSync(stmaDir, { recursive: true });
  writeFileSync(outboxPath, `${JSON.stringify(events.slice(-500), null, 2)}\n`, 'utf8');
}

async function ensureAdapterInstallation(adapter: AdapterConfig): Promise<string> {
  const local = loadConfig();
  const rawDevice = `${os.hostname()}\0${os.userInfo().username}\0${process.platform}\0${adapter.target}`;
  const result = await apiRequest<any>(local, '/api/agent/installations/register', {
    method: 'POST',
    body: JSON.stringify({
      name: adapter.agentName,
      clientType: adapter.target,
      deviceFingerprint: sha256(rawDevice),
      capabilities: ['native-hooks', 'policy-sync', 'environment-preflight', 'offline-outbox'],
    }),
  });
  saveConfig({
    ...loadConfig(),
    server: connection(local).server,
    installationId: result.installation.id,
    agentName: adapter.agentName,
    clientType: adapter.target,
  });
  return result.installation.id as string;
}

function nativeClaims(): WorkClaim[] {
  return dirtyFiles().map((file) => ({
    resourceType: 'path',
    resourceKey: file,
    access: 'write',
  }));
}

async function startNativeRun(
  adapter: AdapterConfig,
  sessionKey: string,
  payload: Record<string, unknown>,
): Promise<string | undefined> {
  let local = loadConfig();
  const current = local.adapterRuns?.[sessionKey];
  if (current) return current;
  const installationId = await ensureAdapterInstallation(adapter);
  local = loadConfig();
  const git = gitContext();
  const result = await apiRequest<any>(local, '/api/agent/runs/start', {
    method: 'POST',
    body: JSON.stringify({
      installationId,
      team: adapter.team,
      project: adapter.project,
      taskKey: adapter.defaultTask,
      intent: hookIntent(adapter, payload),
      repo: adapter.project ?? git.repo,
      branch: git.branch,
      worktree: git.worktree,
      baseSha: git.baseSha,
      claims: nativeClaims(),
    }),
  });
  const runId = result.run.id as string;
  saveConfig({
    ...loadConfig(),
    currentRunId: runId,
    currentTeam: adapter.team,
    currentProject: adapter.project,
    currentClaims: nativeClaims(),
    adapterRuns: { ...(loadConfig().adapterRuns ?? {}), [sessionKey]: runId },
  });

  if (adapter.applyPolicy && result.policy) {
    const reportedHash = applyPolicy(cwd, result.policy.document, result.policy.hash, adapter.target);
    await apiRequest(local, `/api/agent/runs/${runId}/policy-receipt`, {
      method: 'POST',
      body: JSON.stringify({ expectedHash: result.policy.hash, reportedHash }),
    });
  }
  if (adapter.preflight && adapter.project) {
    await apiRequest(local, '/api/agent/environment/preflight', {
      method: 'POST',
      body: JSON.stringify({
        team: adapter.team,
        project: adapter.project,
        runId,
        snapshot: collectSnapshot(),
      }),
    });
  }

  const conflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
  if (!conflicts.length) return undefined;
  const critical = conflicts.filter((item: any) => item.severity === 'critical').length;
  return `STMA conflict radar found ${conflicts.length} overlapping work claim(s)` +
    `${critical ? `, including ${critical} critical` : ''}. Check the Live Agent Map before editing.`;
}

async function processHookEvent(event: QueuedHook): Promise<string | undefined> {
  const adapter = loadAdapterConfig(cwd);
  if (!adapter) throw new Error('Run stma adapter install --apply first.');
  const sessionKey = hookSessionKey(adapter, event.payload);

  if (event.event === 'start') return startNativeRun(adapter, sessionKey, event.payload);
  let local = loadConfig();
  let runId = local.adapterRuns?.[sessionKey];
  if (event.event === 'heartbeat' && !runId) {
    await startNativeRun(adapter, sessionKey, event.payload);
    local = loadConfig();
    runId = local.adapterRuns?.[sessionKey];
  }
  if (!runId) return undefined;

  if (event.event === 'heartbeat') {
    // Observed claims come from the dirty worktree, which empties the moment the
    // agent commits. Sending an empty list would ask the server to replace the
    // run's scope with nothing, so only report claims when there are some; the
    // server renews what the run already holds otherwise.
    const observed = nativeClaims();
    const usage = hookQuota(event.payload);
    const result = await apiRequest<any>(local, `/api/agent/runs/${runId}/heartbeat`, {
      method: 'POST',
      body: JSON.stringify({
        status: 'active',
        ...(observed.length > 0 ? { claims: observed } : {}),
        ...(usage ? { usage } : {}),
      }),
    });
    // Hook stderr is what the client shows its agent, so this is the one place
    // the warning can reach the thing that has to act on it.
    if (result?.quota && result.quota.state !== 'ok' && result.quota.advice) {
      console.error(`[stma] ${result.quota.advice}`);
    }
    return undefined;
  }

  await apiRequest(local, `/api/agent/runs/${runId}/finish`, {
    method: 'POST',
    body: JSON.stringify({ status: 'completed' }),
  });
  const latest = loadConfig();
  const adapterRuns = { ...(latest.adapterRuns ?? {}) };
  delete adapterRuns[sessionKey];
  saveConfig({
    ...latest,
    currentRunId: latest.currentRunId === runId ? undefined : latest.currentRunId,
    currentClaims: latest.currentRunId === runId ? undefined : latest.currentClaims,
    adapterRuns,
  });
  return undefined;
}

function hookOutput(target: AdapterTarget, notice?: string): void {
  if (!notice) return;
  if (target === 'claude-code') {
    console.log(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: notice },
      }),
    );
  } else if (target === 'codex') {
    console.log(JSON.stringify({ systemMessage: notice }));
  } else {
    console.log(JSON.stringify({ continue: true, user_message: notice }));
  }
}

/** 4xx means the request itself is wrong; only 5xx and transport faults retry. */
function isPermanentHookFailure(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

async function adapterHook(flags: Flags): Promise<void> {
  const value = required(flags, 'event');
  if (!['start', 'heartbeat', 'finish'].includes(value)) fail('Invalid adapter hook event.');
  let adapter: AdapterConfig | undefined;
  let payload: Record<string, unknown> = {};
  try {
    adapter = loadAdapterConfig(cwd);
    if (!adapter) return;
    payload = readHookPayload();
  } catch {
    return;
  }
  const current: QueuedHook = {
    id: randomUUID(),
    event: value as QueuedHook['event'],
    payload,
    queuedAt: new Date().toISOString(),
  };
  const pending = [...loadOutbox(), current].slice(-500);
  const remaining: QueuedHook[] = [];
  let notice: string | undefined;
  let failed = false;
  for (const item of pending) {
    if (failed) {
      remaining.push(item);
      continue;
    }
    try {
      const result = await processHookEvent(item);
      if (item.id === current.id) notice = result;
    } catch (error) {
      // Only retry what might succeed later. A run the server has already
      // finished or forgotten never becomes valid again, and re-queueing it
      // blocked every event behind it — that machine's radar stayed dark.
      if (isPermanentHookFailure(error)) continue;
      failed = true;
      remaining.push(item);
    }
  }
  saveOutbox(remaining);
  // Whatever the lifecycle produced, plus anything waiting that this agent has
  // not been told about yet. Failure here is silence, never a blocked prompt.
  const waiting = await newsNotice();
  hookOutput(adapter.target, [notice, waiting].filter(Boolean).join('\n\n') || undefined);
}

/**
 * Ask the server what is waiting, at most once a minute, and only report what
 * has not been reported before.
 *
 * Everything about this function is defensive: it is on the path between a
 * human pressing enter and their agent answering. A server that is slow, down,
 * or returning something unexpected must cost nothing but silence.
 */
async function newsNotice(): Promise<string | undefined> {
  try {
    const config = loadConfig();
    if (!dueForCheck({ lastCheckedAt: config.newsCheckedAt, announced: config.newsAnnounced })) {
      return undefined;
    }
    const { server, token } = connection(config);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NEWS_TIMEOUT_MS);
    let news: News;
    try {
      const response = await fetch(`${server}/api/agent/news`, {
        headers: { authorization: `Bearer ${token}`, ...clientHeaders() },
        signal: controller.signal,
      });
      if (!response.ok) return undefined;
      news = (await response.json()) as News;
    } finally {
      clearTimeout(timer);
    }
    const state = { lastCheckedAt: config.newsCheckedAt, announced: config.newsAnnounced };
    const fresh = unseen(news, state);
    // The timestamp moves even when there is nothing to say, so an idle team
    // does not re-ask on every single prompt.
    saveConfig({
      ...config,
      newsCheckedAt: news.checkedAt,
      newsAnnounced: rememberAnnounced(state, fresh),
    });
    return renderNews(fresh, news.unreadSessions);
  } catch {
    return undefined;
  }
}

/**
 * `stma watch` — the part the hook cannot do.
 *
 * The lifecycle hook only fires when the human types, so a handoff that lands
 * overnight waits until morning. This is the out-of-band half: a long-running
 * process that polls the same endpoint and says something where a person will
 * see it. It deliberately cannot make the agent act — nothing outside the
 * agent's own loop can — so it notifies and stops there.
 */
async function watch(flags: Flags): Promise<void> {
  const seconds = Number(one(flags, 'interval') ?? 30);
  if (!Number.isFinite(seconds) || seconds < 10 || seconds > 3600) {
    fail(`--interval must be between 10 and 3600 seconds (got ${one(flags, 'interval')}).`);
  }
  const config = loadConfig();
  const { server, token } = connection(config);
  const announced = new Set<string>();
  let firstPass = true;

  console.log(`stma: watching ${server} every ${seconds}s. Ctrl+C to stop.`);
  for (;;) {
    try {
      const response = await fetch(`${server}/api/agent/news`, {
        headers: { authorization: `Bearer ${token}`, ...clientHeaders() },
      });
      if (response.ok) {
        const news = (await response.json()) as News;
        for (const handoff of news.pendingHandoffs) {
          const key = handoffKey(handoff);
          if (announced.has(key)) continue;
          announced.add(key);
          // The first pass reports the backlog quietly: everything is "new" to a
          // process that just started, and waking somebody for a week-old
          // handoff is how a notifier gets muted.
          const who = handoff.mine ? 'your other machine' : (handoff.from ?? 'a teammate');
          const line = `work waiting — "${handoff.title}" from ${who}${
            handoff.resume?.branch ? ` on ${handoff.resume.branch}` : ''
          }`;
          console.log(`${new Date().toISOString().slice(11, 19)}  ${line}`);
          if (!firstPass) notifyDesktop('STMA', line);
        }
      }
    } catch {
      // A watcher that dies when the network blinks is worse than no watcher.
    }
    firstPass = false;
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }
}

/** Best effort, per platform. A missing notifier is never an error. */
function notifyDesktop(title: string, body: string): void {
  try {
    if (process.platform === 'darwin') {
      execFileSync('osascript', ['-e', `display notification "${body}" with title "${title}"`], {
        stdio: 'ignore',
      });
    } else if (process.platform === 'win32') {
      execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `[console]::beep(880,150)`],
        { stdio: 'ignore' },
      );
    } else {
      execFileSync('notify-send', [title, body], { stdio: 'ignore' });
    }
  } catch {
    /* no notifier on this machine */
  }
}

function help(): void {
  console.log(`STMA local control-plane CLI ${VERSION}

Environment:
  STMA_URL=http://localhost:3000
  STMA_TOKEN=stma_...

Commands:
  stma serve [--port 3000] [--host 127.0.0.1] [--data DIR]
             Run a private instance on this machine — embedded database, no setup.
  stma watch [--interval 30]
             Say when work is handed to you, while you are not at the keyboard.
  stma agent register --name NAME [--client generic] [--role implementer|reviewer|tester|planner|ops]
  stma run start --team TEAM [--project PROJECT] [--task KEY] [--scope path]
                 [--attempt-group KEY]   parallel attempts at one task never warn each other
  stma run heartbeat [--status active|waiting|blocked]
                     [--used-pct N] [--resets-at ISO] [--quota-label TEXT]
                     report your own vendor allowance; STMA answers with when to hand off
  stma run finish [--status completed|failed]
  stma run list [--team TEAM]
  stma run exec --team TEAM [run options] -- <agent command>
  stma policy publish --team TEAM [--project PROJECT] [--file policy.json]
  stma policy pull --team TEAM [--project PROJECT] [--apply]
  stma env baseline --team TEAM --project PROJECT
  stma env preflight --team TEAM --project PROJECT
  stma adapter install --target claude-code|codex|cursor --team TEAM [--project PROJECT]
                       [--name NAME] [--command stma] [--policy=false] [--preflight=false] [--apply]
  stma version [--server]   this CLI's version, and optionally the server's
`);
}

/**
 * Both halves of the answer, because the useful version is never one number.
 * `--server` asks the instance this checkout is pointed at, without a token:
 * /health is public, and being unable to say what you are talking to is the
 * state this command exists to end.
 */
async function version(flags: Flags): Promise<void> {
  console.log(`stma ${VERSION}`);
  if (!flags.has('server')) return;
  const server = (process.env.STMA_URL ?? loadConfig().server ?? 'http://localhost:3000').replace(/\/$/, '');
  try {
    const res = await fetch(`${server}/health`, { signal: AbortSignal.timeout(5_000) });
    const health = (await res.json()) as { version?: string };
    console.log(`server ${health.version ?? 'unknown'} (${server})`);
    if (health.version && health.version !== VERSION) {
      console.log('note: client and server versions differ — features added since the older one will be missing.');
    }
  } catch (error) {
    console.log(`server unreachable (${server}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [group, action, ...rest] = argv;
  // `serve` takes no action word — it is the command somebody runs before they
  // know anything about the tool — so its flags are parsed before the generic
  // pass, which would otherwise choke on the bare value in `serve --port 3000`.
  // Same shape as `serve`: no action word, so its flags are parsed before the
  // generic pass, which treats a bare value as an unexpected argument.
  if (group === 'version' || group === '--version' || group === '-v') {
    return version(parseFlags(argv.slice(1)).flags);
  }
  if (group === 'watch') return watch(parseFlags(argv.slice(1)).flags);
  if (group === 'serve') {
    const serveFlags = parseFlags(argv.slice(1)).flags;
    const port = Number(one(serveFlags, 'port') ?? 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      fail(`--port must be a port number (got ${one(serveFlags, 'port')}).`);
    }
    return serve({
      port,
      host: one(serveFlags, 'host') ?? '127.0.0.1',
      dataDir: one(serveFlags, 'data') ?? defaultDataDir(),
    });
  }
  const { flags, passthrough } = parseFlags(rest);
  if (group === 'agent' && action === 'register') return register(flags);
  if (group === 'run' && action === 'start') return void (await startRun(flags));
  if (group === 'run' && action === 'heartbeat') return heartbeat(flags);
  if (group === 'run' && action === 'finish') return finish(flags);
  if (group === 'run' && action === 'list') return listRuns(flags);
  if (group === 'run' && action === 'exec') return execRun(flags, passthrough);
  if (group === 'policy' && action === 'publish') return publishPolicy(flags);
  if (group === 'policy' && action === 'pull') return pullPolicy(flags);
  if (group === 'env' && action === 'baseline') return environment(flags, 'baseline');
  if (group === 'env' && action === 'preflight') return environment(flags, 'preflight');
  if (group === 'adapter' && action === 'install') return adapterInstall(flags);
  if (group === 'adapter' && action === 'hook') return adapterHook(flags);
  help();
}

await main();
