import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PolicyDocument, Snapshot, WorkClaim } from '@bridge/shared';
import {
  ADAPTER_TARGETS,
  acquireProfileReplayLock,
  adapterDeliveryStatus,
  adapterProfileIds,
  adapterProfilePaths,
  atomicWriteJson,
  defaultProfileId,
  discardHookEvent,
  enqueueHookEvent,
  installAdapter,
  installedHookCount,
  loadAdapterProfile,
  markHookEventDelivered,
  markHookEventFailed,
  migrateLegacyProfile,
  normalizeProfileId,
  readQueuedHookEvents,
  repairProfileOutbox,
  uninstallAdapter,
  updateQueuedHookEvent,
  withFileLock,
  type AdapterConfig,
  type AdapterTarget,
  type LoadedAdapterProfile,
  type ProfileAdapterConfig,
  type QueuedHookEvent,
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
import { applyPolicy, readPolicyHash } from './policy.js';
import { VERSION, clientHeaders } from './version.js';
import { environmentNotice } from './notices.js';
import { savedConnection, type ConnectionReference } from './connectionCredentials.js';
import { checkoutAddedText, fileToolAddedText, fileToolClaims, nativeHookContext, retainedHookPayload, hookSessionIdentity } from './fileGuard.js';
import { conflictReport, matchContentRules, parseContentRules, type RightOfWayConflict } from '@bridge/shared';
import { checkNativeRuntime, prepareNativeRuntime } from './nativeInstall.js';
import { appendCodexEntry, checkCodexEntry, codexConfigPath, readCodexConfig, removeCodexEntry, writeCodexConfig } from './codexConfig.js';
import { authorizeLocalAdapter, isTerminalCredential, localOAuthConnection, revokeLocalAdapterCredential, revokeTerminalCredential, saveTerminalCredential } from './oauthLocal.js';

interface LocalConfig {
  server?: string;
  /** Reference only. The bearer stays in the approved private native MCP config. */
  connection?: ConnectionReference;
  /** When the hook last asked the server what is waiting, and what it already said. */
  newsCheckedAt?: string;
  /** `<hook session>|<handoff key>`: what each client session has already been told. */
  newsAnnounced?: string[];
  /** Client sessions that have had their first news check; a new one is not throttled. */
  newsSessions?: string[];
  installationId?: string;
  /** The client's MCP server entry for this checkout, so the hook can name it. */
  mcpAlias?: string;
  agentName?: string;
  clientType?: string;
  currentRunId?: string;
  currentTeam?: string;
  currentProject?: string;
  currentClaims?: WorkClaim[];
  adapterRuns?: Record<string, string>;
  /** The branch each hook-owned run began on; a switch closes it and starts another. */
  adapterRunBranches?: Record<string, string>;
  /**
   * The commit each hook-owned run began at, so the end-of-run content scan can
   * ask git what THIS run put in the checkout rather than what the branch has
   * carried since it was cut.
   */
  adapterRunCommits?: Record<string, string>;
  /** Persisted before a manual start request so a lost response cannot create a second run. */
  pendingStarts?: Record<string, ManualStartEnvelope>;
}

export interface ManualStartEnvelope {
  requestId: string;
  requestHash: string;
  request: Record<string, unknown>;
  createdAt: string;
}

type Flags = Map<string, string[]>;

const cwd = process.cwd();
const stmaDir = path.join(cwd, '.stma');
const configPath = path.join(stmaDir, 'local.json');
const configLockPath = path.join(stmaDir, 'local.lock');

function loadConfig(): LocalConfig {
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf8')) as LocalConfig;
  } catch {
    fail(`Could not read ${configPath}. Fix or remove the invalid JSON file.`);
  }
}

function saveConfig(config: LocalConfig): void {
  atomicWriteJson(configPath, config);
}

function updateConfig(update: (current: LocalConfig) => LocalConfig): LocalConfig {
  return withFileLock(configLockPath, () => {
    const next = update(loadConfig());
    saveConfig(next);
    return next;
  });
}

function loadProfileConfig(profileId: string): LocalConfig {
  const file = adapterProfilePaths(cwd, profileId).statePath;
  if (!existsSync(file)) return {};
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value as LocalConfig;
  } catch {
    throw new Error(`Could not read ${file}. Run stma adapter doctor --profile ${profileId}.`);
  }
}

function updateProfileConfig(
  profileId: string,
  update: (current: LocalConfig) => LocalConfig,
): LocalConfig {
  const paths = adapterProfilePaths(cwd, profileId);
  return withFileLock(paths.stateLockPath, () => {
    const next = update(loadProfileConfig(profileId));
    atomicWriteJson(paths.statePath, next);
    return next;
  });
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

// #region acceptance:devices
// What git answers here depends on the machine: its line-ending settings decide
// whether a checkout another operating system pushed reads as clean.
function shell(command: string, args: string[]): string | undefined {
  try {
    return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

export function safeRepositoryRemote(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return undefined;
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.toString();
  } catch {
    const scp = /^(?:[^/@:\s]+@)?([^/:\s]+):([^\s?#]+)$/.exec(value);
    return scp ? `ssh://${scp[1]}/${scp[2]}` : undefined;
  }
}

function gitContext() {
  const worktree = shell('git', ['rev-parse', '--show-toplevel']);
  const headSha = shell('git', ['rev-parse', 'HEAD']);
  const rawRemote = shell('git', ['remote', 'get-url', 'origin']);
  const repositoryIdentity = rawRemote ? safeRepositoryRemote(rawRemote) : undefined;
  const status = shell('git', ['status', '--porcelain']);
  return {
    repo: repositoryIdentity ?? path.basename(worktree ?? cwd),
    repositoryIdentity,
    branch: shell('git', ['branch', '--show-current']),
    baseSha: headSha,
    headSha,
    worktree,
    worktreeClean: status === '',
  };
}
// #endregion acceptance:devices

/** A stable UUID for a (queued event, commit) pair; request ids must be UUIDs. */
function derivedUuid(input: string): string {
  const h = sha256(input);
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function gitCheckpoint(
  requestId: string,
  kind: 'start' | 'delivery' | 'tested',
  git: {
    repositoryIdentity?: string;
    headSha?: string;
    worktreeClean?: boolean;
  },
): Record<string, unknown> | undefined {
  if (!git.repositoryIdentity || !git.headSha) return undefined;
  // A delivery checkpoint is retry-safe per request id, and a queued hook event
  // keeps its id across replays. If the agent committed between the first
  // attempt and the replay the same id would now describe another commit and
  // be refused; binding the id to the commit makes that a new checkpoint.
  return {
    requestId: kind === 'start' ? requestId : derivedUuid(`${requestId}:${git.headSha}`),
    kind,
    repositoryIdentity: git.repositoryIdentity,
    commitSha: git.headSha,
    worktreeClean: git.worktreeClean === true,
    tests: [],
  };
}

/**
 * The files this checkout has changed, as the run's observed ground.
 *
 * Read without the trimming the helper above does, because
 * `git status --porcelain` is `XY<space>PATH` and X is a **space** for the most
 * ordinary state there is: edited, not staged. Trimming the whole output and
 * then slicing three characters off each line ate the first character of the
 * first path — `native.js` was claimed as `ative.js` — so a run's observed
 * scope named a file that does not exist, overlapped nobody, and the collision
 * the hook exists to find was silently missed. Every later line kept its
 * leading space and parsed correctly, which is why it survived: one dirty file
 * is the common case and it was always the broken one. Found while testing the
 * collision wording against the shipped runtime, 2026-09-20.
 */
function dirtyFiles(): string[] {
  let output: string;
  try {
    output = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return [];
  }
  return output
    .split(/\r?\n/)
    .map((line) => /^.. (.*)$/.exec(line)?.[1]?.trim().split(' -> ').at(-1) ?? '')
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

async function connection(config: LocalConfig): Promise<{ server: string; token: string }> {
  if (config.connection) {
    if (config.connection.client === 'oauth-local') {
      return localOAuthConnection(config.connection.alias, config.server ?? process.env.STMA_URL);
    }
    const saved = savedConnection(config.connection);
    // A repository/env override must never redirect a stored native credential.
    if ((config.server && config.server.replace(/\/$/, '') !== saved.server) || (process.env.STMA_URL && process.env.STMA_URL.replace(/\/$/, '') !== saved.server)) throw Error('Server override does not match the saved MCP connection. No credential was sent.');
    return saved;
  }
  const server = (process.env.STMA_URL ?? config.server ?? 'http://localhost:3000').replace(/\/$/, '');
  const token = process.env.STMA_TOKEN;
  if (!token) throw new Error('Use adapter activate for browser OAuth, or provide an approved legacy STMA_TOKEN. Never paste a token into a command.');
  return { server, token };
}

async function apiRequest<T>(
  config: LocalConfig,
  endpoint: string,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<T> {
  const { server, token } = await connection(config);
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) abortFromCaller();
  else init.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms.`)), timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${server}${endpoint}`, {
      ...init,
      redirect: 'error',
      signal: controller.signal,
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
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', abortFromCaller);
  }
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
  const connected = await connection(config);
  updateConfig((latest) => ({
    ...latest,
    server: connected.server,
    installationId: result.installation.id,
    agentName: name,
    clientType,
  }));
  console.log(`Registered ${name} (${clientType}) as ${result.installation.id}`);
}

export function manualStartIdentity(
  existing: ManualStartEnvelope | undefined,
  requestBase: Record<string, unknown>,
  requestedId?: string,
): { requestId: string; requestHash: string; replayed: boolean } {
  const requestHash = sha256(JSON.stringify(requestBase));
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new Error(
        'A previous manual run start may have reached the server with different arguments. Retry it unchanged or pass --discard-pending=true only after verifying that creating a new logical run is intended.',
      );
    }
    if (requestedId && requestedId !== existing.requestId) {
      throw new Error(
        `Pending run start uses request ${existing.requestId}; a different --request-id could duplicate it.`,
      );
    }
    return { requestId: existing.requestId, requestHash, replayed: true };
  }
  const requestId = requestedId ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    throw new Error('--request-id must be a UUID.');
  }
  return { requestId, requestHash, replayed: false };
}

async function startRun(flags: Flags): Promise<any> {
  const config = loadConfig();
  const installationId = one(flags, 'agent') ?? config.installationId;
  if (!installationId) fail('Register an agent first or pass --agent.');
  const team = required(flags, 'team');
  const project = one(flags, 'project');
  const git = gitContext();
  const claims = all(flags, 'scope').map(parseClaim);
  const requestBase = {
    installationId,
    team,
    project,
    taskKey: one(flags, 'task'),
    intent: one(flags, 'intent'),
    repo: one(flags, 'repo') ?? project ?? git.repo,
    repositoryIdentity: git.repositoryIdentity,
    branch: one(flags, 'branch') ?? git.branch,
    worktree: one(flags, 'worktree') ?? git.worktree,
    baseSha: git.baseSha,
    headSha: git.headSha,
    claims,
    attemptGroup: one(flags, 'attempt-group'),
  };
  let envelope!: ManualStartEnvelope;
  const persistedConfig = updateConfig((latest) => {
    const pendingStarts = { ...(latest.pendingStarts ?? {}) };
    if (one(flags, 'discard-pending') === 'true') delete pendingStarts[installationId];
    const identity = manualStartIdentity(
      pendingStarts[installationId],
      requestBase,
      one(flags, 'request-id'),
    );
    envelope =
      pendingStarts[installationId] ??
      {
        requestId: identity.requestId,
        requestHash: identity.requestHash,
        request: {
          ...requestBase,
          requestId: identity.requestId,
          checkpoint: gitCheckpoint(identity.requestId, 'start', git),
        },
        createdAt: new Date().toISOString(),
      };
    pendingStarts[installationId] = envelope;
    return { ...latest, pendingStarts };
  });
  const result = await request<any>(persistedConfig, '/api/agent/runs/start', {
    method: 'POST',
    body: JSON.stringify(envelope.request),
  });
  const knowledge = result.knowledgeContext as Record<string, unknown> | undefined;
  updateConfig((latest) => {
    const pendingStarts = { ...(latest.pendingStarts ?? {}) };
    if (pendingStarts[installationId]?.requestId === envelope.requestId) {
      delete pendingStarts[installationId];
    }
    return {
      ...latest,
      pendingStarts: Object.keys(pendingStarts).length > 0 ? pendingStarts : undefined,
      currentRunId: result.run.id,
      currentTeam: team,
      currentProject: project,
      currentClaims: claims,
    };
  });
  console.log(`Run started: ${result.run.id}`);
  printConflicts(result.conflicts ?? []);
  if (result.policy) {
    console.log(`Effective policy: ${result.policy.hash} (${result.policy.sources.length} source(s))`);
  }
  if (typeof knowledge?.context === 'string') {
    console.log(`Knowledge Hub context (reference, not execution authority):\n${knowledge.context}`);
  }
  if (typeof knowledge?.reportHint === 'string') console.log(knowledge.reportHint);
  return result;
}

async function reportKnowledgeReceipt(flags: Flags): Promise<void> {
  const config = loadConfig();
  const contextId = required(flags, 'context');
  const manifestHash = required(flags, 'manifest');
  const result = await request<any>(
    config,
    `/api/agent/knowledge/contexts/${encodeURIComponent(contextId)}/receipt`,
    {
      method: 'POST',
      body: JSON.stringify({ manifestHash }),
    },
  );
  console.log(
    `Knowledge context ${contextId} reported by this client: ${result.matches ? 'exact manifest match' : 'manifest mismatch'}.`,
  );
  console.log('This is client-provenance delivery evidence, not compliance or execution proof.');
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
    body: JSON.stringify({
      status: one(flags, 'status'),
      claims,
      usage: quotaFlags(flags),
      checkpoint: gitCheckpoint(randomUUID(), 'delivery', gitContext()),
    }),
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
export function hookQuota(
  payload: Record<string, unknown>,
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> | undefined {
  const fromPayload = payload.usage ?? payload.quota;
  if (fromPayload && typeof fromPayload === 'object') {
    const u = fromPayload as Record<string, unknown>;
    const pct = Number(u.usedPct ?? u.used_pct ?? u.percent_used);
    if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
      const rawSource = u.source ?? u.quotaSource ?? u.quota_source;
      const source = rawSource === 'measured' || rawSource === 'estimate' ? rawSource : 'estimate';
      return {
        usedPct: pct,
        resetsAt:
          typeof (u.resetsAt ?? u.resets_at) === 'string' ? (u.resetsAt ?? u.resets_at) : undefined,
        label: typeof u.label === 'string' ? u.label : undefined,
        source,
      };
    }
  }
  const env = Number(environment.STMA_USED_PCT);
  if (!Number.isFinite(env) || env < 0 || env > 100) return undefined;
  const source =
    environment.STMA_QUOTA_SOURCE === 'measured' || environment.STMA_QUOTA_SOURCE === 'estimate'
      ? environment.STMA_QUOTA_SOURCE
      : 'estimate';
  return {
    usedPct: env,
    resetsAt: environment.STMA_QUOTA_RESETS_AT || undefined,
    label: environment.STMA_QUOTA_LABEL || undefined,
    source,
  };
}

/**
 * The vendor allowance, if this invocation was told about it. Only the client
 * knows the number, so the CLI's job is to carry it, not to guess it — a hook
 * or a wrapper script passes --used-pct, and everything downstream follows.
 */
export function quotaFlags(flags: Flags): Record<string, unknown> | undefined {
  const raw = one(flags, 'used-pct');
  if (raw === undefined) return undefined;
  const usedPct = Number(raw);
  if (!Number.isFinite(usedPct) || usedPct < 0 || usedPct > 100) {
    fail('--used-pct must be a number between 0 and 100.');
  }
  const rawSource = one(flags, 'quota-source') ?? 'estimate';
  if (rawSource !== 'measured' && rawSource !== 'estimate') {
    fail('--quota-source must be measured or estimate.');
  }
  return {
    usedPct,
    resetsAt: one(flags, 'resets-at'),
    label: one(flags, 'quota-label'),
    source: rawSource,
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
      checkpoint: gitCheckpoint(randomUUID(), 'delivery', gitContext()),
    }),
  });
  if (config.currentRunId === runId) {
    updateConfig((latest) => ({ ...latest, currentRunId: undefined, currentClaims: undefined }));
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
  const apply = one(flags, 'apply') === 'true';
  const local = loadConfig();
  const role = one(flags, 'role') ?? 'generalist';
  const alias = one(flags, 'connection');
  const reference = alias ? { client: target, alias } : undefined;
  const saved = reference && apply ? savedConnection(reference) : undefined;
  if (!['generalist', 'implementer', 'reviewer', 'tester', 'planner', 'ops'].includes(role)) {
    fail('--role must be generalist, implementer, reviewer, tester, planner, or ops.');
  }
  const adapter: AdapterConfig = {
    schemaVersion: 2,
    target,
    team: required(flags, 'team'),
    project: one(flags, 'project'),
    agentName: one(flags, 'name') ?? `${os.userInfo().username}-${target}`,
    role: role as ProfileAdapterConfig['role'],
    defaultTask: one(flags, 'task'),
    defaultIntent: one(flags, 'intent'),
    applyPolicy: one(flags, 'policy') !== 'false',
    preflight: one(flags, 'preflight') !== 'false',
    writeGuard: one(flags, 'write-guard') === 'true',
  };
  adapter.profileId = normalizeProfileId(one(flags, 'profile') ?? defaultProfileId(adapter));
  // Preflight profile routing before creating local runtime/ignore metadata.
  installAdapter({ root: cwd, config: adapter, command: 'stma', apply: false, replace: one(flags, 'replace') === 'true' });
  const pinnedCommand = one(flags, 'pin-runtime') === 'true' && apply ? prepareNativeRuntime(cwd, fileURLToPath(import.meta.url), target) : undefined;
  if (apply) migrateLegacyProfile(cwd);
  const result = installAdapter({
    root: cwd,
    config: adapter,
    command: one(flags, 'command') ?? pinnedCommand ?? 'stma',
    apply,
    replace: one(flags, 'replace') === 'true',
  });

  if (!apply) {
    console.log(`Dry run for ${target}. Nothing was written.`);
    console.log(`Profile: ${result.profileId}`);
    console.log(`Hook file: ${result.hookPath}`);
    console.log(JSON.stringify(result.hooks, null, 2));
    console.log('Run again with --apply after reviewing the hook command.');
    return;
  }

  updateProfileConfig(result.profileId, (current) => ({
    ...current,
    server: saved?.server ?? (process.env.STMA_URL ?? current.server ?? local.server ?? 'http://localhost:3000').replace(/\/$/, ''),
    ...(reference ? { connection: reference } : {}),
    agentName: adapter.agentName,
    clientType: target,
  }));
  console.log(`Installed ${target} lifecycle hooks at ${result.hookPath}`);
  console.log(`Profile: ${result.profileId}`);
  console.log(`Adapter ownership config: ${result.adapterPath}`);
  if (target === 'codex') console.log('Open /hooks in Codex and trust the new project hooks.');
}

/** One visible, project-scoped OAuth approval, then local hooks. No client config scraping. */
async function adapterActivate(flags: Flags): Promise<void> {
  const target = required(flags, 'target');
  if (target !== 'claude-code' && target !== 'codex') fail('OAuth local activation supports Claude Code and Codex.');
  const team = required(flags, 'team');
  const project = required(flags, 'project');
  const server = required(flags, 'server').replace(/\/+$/, '');
  const name = one(flags, 'name') ?? `${os.userInfo().username}-${target}-local`;
  const adapter: AdapterConfig = {
    schemaVersion: 2, target, team, project, agentName: name, role: 'generalist',
    applyPolicy: false, preflight: true, writeGuard: true,
  };
  adapter.profileId = defaultProfileId(adapter);
  if (loadAdapterProfile(cwd, adapter.profileId)) {
    fail(`Profile ${adapter.profileId} already exists. Use adapter status/doctor; activation will not mint a second credential.`);
  }
  // Fail before browser consent if this checkout cannot accept the hooks or the
  // pinned runtime; a refusal after approval would mint a credential only to revoke it.
  installAdapter({ root: cwd, config: adapter, command: 'stma', apply: false });
  checkNativeRuntime(cwd, fileURLToPath(import.meta.url));
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail('Open a regular interactive terminal to approve local adapter activation. Nothing was installed.');
  }
  const credentialId = normalizeProfileId(`${adapter.profileId}-${sha256(cwd).slice(0, 8)}`);
  console.log(`Local activation: ${target} in ${cwd}`);
  console.log(`Requested STMA access: ${team} / ${project} at ${server}`);
  console.log('STMA will add ignored project-local lifecycle hooks and a private OAuth credential for this adapter.');
  console.log('The browser will ask you to approve the exact project. This does not change the client MCP entry.');
  console.log('Supported native file tools can be blocked on conflict/offline; shell/OS writes are not a complete guard.');
  console.log('Press Enter to open the STMA approval page, or Ctrl+C to stop.');
  await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
  const approved = await authorizeLocalAdapter({ server, id: credentialId, target,
    expectedTeam: team, expectedProject: project });
  // Browser consent is authoritative for the visible installation identity.
  adapter.agentName = approved.identity.credential.installationName;
  let result: ReturnType<typeof installAdapter> | undefined;
  try {
    const pinnedCommand = prepareNativeRuntime(cwd, fileURLToPath(import.meta.url), target);
    result = installAdapter({ root: cwd, config: adapter, command: pinnedCommand, apply: true });
    updateProfileConfig(result.profileId, (current) => ({ ...current, server: approved.server,
      connection: { client: 'oauth-local', alias: credentialId }, agentName: adapter.agentName, clientType: target,
      installationId: approved.identity.credential.installationId }));
  } catch (error) {
    if (result) {
      try { uninstallAdapter({ root: cwd, profileId: result.profileId, apply: true }); } catch { /* report cleanup separately */ }
    }
    const revoked = await revokeLocalAdapterCredential(credentialId);
    throw new Error(`Local hook installation failed: ${requestError(error)}. New credential cleanup: ${revoked ? 'revoked' : 'unconfirmed; revoke it in STMA Agent connections'}.`);
  }
  if (!result) throw new Error('Local adapter installation did not complete.');
  console.log(`Local coordination installed for ${team} / ${project}.`);
  console.log(`Installation: ${approved.identity.credential.installationName} on ${approved.identity.credential.device} (${approved.identity.credential.installationId})`);
  // The pairing chosen on the consent screen. A server that predates pairing
  // sends no such field, and saying "not paired" to it would describe a choice
  // nobody was offered.
  if ('companion' in approved.identity.credential) {
    const companion = approved.identity.credential.companion as { agent?: string; device?: string | null } | null;
    console.log(companion?.agent
      ? `Listens for: ${companion.agent}${companion.device ? ` on ${companion.device}` : ''}. This hook announces work assigned to that agent; it cannot accept it.`
      : 'Not paired with an agent: this hook is not told about work assigned to the agent in this checkout. Pair it in STMA under Agent connections → Listens for.');
  }
  console.log(`Hook file: ${result.hookPath}`);
  if (target === 'codex') console.log('Open /hooks in Codex and explicitly trust this project hook before working.');
  console.log('Run stma adapter doctor to verify; do not call this complete until one real task creates a run.');
}

// #region acceptance:devices
// Spawning the client's own CLI, and the one command a person runs per checkout.
/** Run the Claude Code CLI. On Windows npm installs a .cmd shim, which needs a shell. */
function claudeCli(args: string[]): { status: number | null; output: string } {
  // Every interpolated value is validated by the caller (alias, https origin,
  // stma_ token), so quoting here only has to keep the header one argument.
  const windows = process.platform === 'win32';
  const result = windows
    ? spawnSync(['claude', ...args.map((arg) => (/[\s"]/.test(arg) ? `"${arg.replaceAll('"', '')}"` : arg))].join(' '),
      { cwd, shell: true, encoding: 'utf8', windowsHide: true, timeout: 60_000 })
    : spawnSync('claude', args, { cwd, encoding: 'utf8', timeout: 60_000 });
  return { status: result.error ? null : result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/**
 * One command, run by a person in a terminal inside the checkout: redeem a
 * short-lived code from Agent connections, add the MCP entry for this checkout,
 * install the local hooks, and give both the same installation.
 *
 * The code is never handed to a model. The 2026-09-07 attempt that asked the
 * agent to redeem it was refused, correctly: a model sending a secret to an
 * address from a prompt and writing a persistent credential is what an
 * injection looks like. Here the human is the actor and the CLI is first-party.
 */
async function connectCheckout(code: string | undefined, flags: Flags): Promise<void> {
  if (!code || !/^stma_enroll_[a-f0-9]{40}$/.test(code)) {
    fail('Usage: stma connect CODE --server HTTPS_ORIGIN   (create the command under Agent connections)');
  }
  let server: string;
  try {
    const url = new URL(required(flags, 'server'));
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname) ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw new Error('unsafe');
    server = url.origin;
  } catch { fail('--server must be a plain https origin such as https://stma.ai'); }
  const top = shell('git', ['rev-parse', '--show-toplevel']);
  if (!top || realpathSync(top) !== realpathSync(cwd)) {
    fail('Run this at the root of the Git checkout the agent works in. Nothing was connected.');
  }

  const preview = await fetch(`${server}/api/agent-enrollments/preview`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/json', ...clientHeaders() }, body: JSON.stringify({ code }),
  }).catch(() => undefined);
  if (!preview) fail(`Could not reach ${server}. Nothing was connected.`);
  if (preview.status === 404) fail('This code is invalid, expired, already used or revoked. Create a new command under Agent connections.');
  if (!preview.ok) fail(`${server} answered HTTP ${preview.status}${preview.status === 404 ? '' : '; it may predate stma connect'}. Nothing was connected.`);
  const offer = await preview.json() as { agent: string; device: string; clientType: string; scope: string; owner: string | null;
    team: { slug: string; name: string } | null; project: { slug: string; name: string } | null; endpoint: string };
  if (offer.clientType !== 'claude-code' && offer.clientType !== 'codex') fail('This code was created for another client. stma connect supports Claude Code and Codex.');
  const target: 'claude-code' | 'codex' = offer.clientType;
  if (target === 'claude-code' && claudeCli(['--version']).status !== 0) {
    fail('Claude Code was not found on PATH. Install it, or use the OAuth path on Agent connections. Nothing was connected.');
  }
  if (offer.scope !== 'project' || !offer.team || !offer.project) fail('stma connect needs a project-only code: the hooks belong to one checkout.');
  if (offer.endpoint !== `${server}/mcp`) fail('The server describes a different MCP address than --server. Nothing was connected.');

  const folder = path.basename(cwd).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'checkout';
  const alias = `stma-${folder}-${sha256(realpathSync(cwd)).slice(0, 4)}`;
  const adapter: AdapterConfig = {
    schemaVersion: 2, target, team: offer.team.slug, project: offer.project.name,
    agentName: offer.agent, role: 'generalist', applyPolicy: false, preflight: true, writeGuard: true,
  };
  adapter.profileId = defaultProfileId(adapter);
  if (loadAdapterProfile(cwd, adapter.profileId)) {
    fail(`This checkout already has local profile ${adapter.profileId}. Run "stma adapter disconnect --profile ${adapter.profileId} --apply" first. Nothing was connected.`);
  }
  const codexFile = codexConfigPath();
  const alsoLoaded: string[] = [];
  if (target === 'claude-code') {
    if (claudeCli(['mcp', 'get', alias]).status === 0) {
      fail(`Claude Code already has an MCP entry named ${alias} here. Remove it with "claude mcp remove ${alias}" first. Nothing was connected.`);
    }
    // Every entry this checkout would load, at any scope. A second STMA server
    // in one session is a second identity, and an agent given a bare tool name
    // will sometimes pick it (measured 2026-09-19: a user-scope entry for another
    // server). The same server twice is refused; another server is named.
    for (const line of claudeCli(['mcp', 'list']).output.split(/\r?\n/)) {
      const entry = /^([^:\s]+):\s+(https?:\/\/\S+\/mcp)\b/.exec(line.trim());
      if (!entry || entry[1] === alias) continue;
      if (entry[2].replace(/\/+$/, '') === `${server}/mcp`) {
        fail(`Claude Code already connects to ${server} here as "${entry[1]}". A second entry for the same server would give one session two STMA identities. Remove it (claude mcp remove ${entry[1]}) or keep using it. Nothing was connected.`);
      }
      // Plenty of unrelated MCP servers answer on /mcp. Only an entry whose name
      // or host says STMA is worth a sentence; the same-endpoint refusal above
      // does not depend on the name.
      let host = '';
      try { host = new URL(entry[2]).hostname; } catch { /* not a URL we can judge */ }
      if (!/stma/i.test(entry[1]) && !/stma/i.test(host)) continue;
      alsoLoaded.push(`${entry[1]} (${entry[2]})`);
    }
  } else {
    try { checkCodexEntry(readCodexConfig(codexFile), alias, `${server}/mcp`); }
    catch (error) { fail(`${requestError(error)} Nothing was connected.`); }
  }
  installAdapter({ root: cwd, config: adapter, command: 'stma', apply: false });
  checkNativeRuntime(cwd, fileURLToPath(import.meta.url));

  console.log(`Server     ${server}`);
  console.log(`Workspace  ${offer.team.name} (${offer.team.slug})${offer.owner ? `, as ${offer.owner}` : ''}`);
  console.log(`Project    ${offer.project.name} — project only`);
  console.log(`Agent      ${offer.agent} on ${offer.device}`);
  console.log(`Checkout   ${cwd}`);
  for (const other of alsoLoaded) {
    console.log(`Also loads MCP server ${other}: another STMA connection with its own identity. The hook`);
    console.log('           will name this one; consider removing or scoping the other so the agent cannot mix them.');
  }
  if (target === 'claude-code') {
    console.log(`Will add   Claude Code MCP entry "${alias}" (local scope, this checkout only)`);
    console.log('           ignored project-local hooks and file guard under .stma/ and .claude/');
    console.log('The credential is stored in Claude Code\'s configuration for this checkout and, protected');
    console.log('for your OS user, under ~/.stma. Revoke it any time under Agent connections.');
  } else {
    console.log(`Will add   Codex MCP entry "${alias}" appended to ${codexFile}`);
    console.log('           (Codex loads it in every checkout: one STMA identity per Codex on this machine)');
    console.log('           ignored project-local hooks and file guard under .stma/ and .codex/');
    console.log('The credential is stored in that Codex config file and, protected for your OS user, under');
    console.log('~/.stma. Revoke it any time under Agent connections.');
  }
  if (one(flags, 'yes') !== 'true') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      fail('Run this in a regular interactive terminal so you can confirm it. Nothing was connected and the code is unused.');
    }
    const answer = await new Promise<string>((resolve) => {
      process.stdout.write('Connect this checkout? [y/N] ');
      process.stdin.once('data', (data) => resolve(String(data).trim().toLowerCase()));
    });
    process.stdin.pause();
    if (answer !== 'y' && answer !== 'yes') fail('Stopped. Nothing was connected and the code is unused.');
  }

  const redeemed = await fetch(`${server}/api/agent-enrollments/redeem`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { 'content-type': 'application/json', ...clientHeaders() },
    body: JSON.stringify({ code, protocolVersion: 2, via: 'terminal' }),
  }).catch(() => undefined);
  if (!redeemed?.ok) fail('The code could not be redeemed. Create a new command under Agent connections.');
  const receipt = await redeemed.json() as { token?: string; installation?: { id?: string } };
  const token = receipt.token;
  if (typeof token !== 'string' || !/^stma_[a-f0-9]{40}$/.test(token)) fail('The server reply was not a credential. Revoke the pending connection under Agent connections.');
  const credentialId = normalizeProfileId(`${adapter.profileId}-${sha256(cwd).slice(0, 8)}`);
  let added = false;
  let hooks: ReturnType<typeof installAdapter> | undefined;
  try {
    if (target === 'claude-code') {
      const add = claudeCli(['mcp', 'add', '--transport', 'http', '--scope', 'local', alias, `${server}/mcp`,
        '--header', `Authorization: Bearer ${token}`]);
      // Claude's own output can echo the header; never print it.
      if (add.status !== 0) throw new Error('claude mcp add failed');
    } else {
      // Re-read: the file may have changed while the human was reading the prompt.
      writeCodexConfig(codexFile, appendCodexEntry(readCodexConfig(codexFile), alias, `${server}/mcp`, token));
    }
    added = true;
    saveTerminalCredential(credentialId, server, token);
    const pinned = prepareNativeRuntime(cwd, fileURLToPath(import.meta.url), target);
    hooks = installAdapter({ root: cwd, config: adapter, command: pinned, apply: true });
    updateProfileConfig(hooks.profileId, (current) => ({ ...current, server,
      connection: { client: 'oauth-local', alias: credentialId }, agentName: adapter.agentName,
      clientType: target, installationId: receipt.installation?.id, mcpAlias: alias }));
  } catch (error) {
    if (hooks) try { uninstallAdapter({ root: cwd, profileId: hooks.profileId, apply: true }); } catch { /* reported below */ }
    if (added && target === 'claude-code') claudeCli(['mcp', 'remove', '--scope', 'local', alias]);
    if (added && target === 'codex') {
      try { writeCodexConfig(codexFile, removeCodexEntry(readCodexConfig(codexFile), alias)); } catch { /* reported below */ }
    }
    let revoked = false;
    try { revoked = (await fetch(`${server}/api/agent-enrollments/self-revoke`, { method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${token}` } })).ok; } catch { /* unconfirmed */ }
    fail(`Setup failed (${requestError(error)}). Local changes were rolled back; the new credential is ${revoked ? 'revoked' : 'NOT confirmed revoked — revoke it under Agent connections'}.`);
  }
  // The real client binary reads the entry and initializes against the server:
  // that, not this CLI, is what confirms the installation.
  if (target === 'claude-code') claudeCli(['mcp', 'get', alias]);
  // The blocking client calls above outlive the server's keep-alive window, so
  // the first request can land on a socket the server already closed.
  // /api/agent/news is closed (403 setup_pending) until the client's initialize
  // confirmed the credential; /api/agent/identity answers either way and would
  // call an unconfirmed connection confirmed.
  const askIdentity = () => fetch(`${server}/api/agent/news`, { signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${token}`, ...clientHeaders() } }).catch(() => undefined);
  const identity = (await askIdentity()) ?? (await askIdentity());
  console.log('');
  console.log(`Connected ${offer.agent} to ${offer.team.slug} / ${offer.project.name}.`);
  const client = target === 'codex' ? 'Codex' : 'Claude Code';
  console.log(identity?.ok
    ? `${client} reached STMA with the new entry: the connection is confirmed.`
    : `Not confirmed yet: start ${client} in this folder within 15 minutes so it loads the entry, or the pending credential expires.`);
  console.log(`Next: close any ${client} session open in this folder and start it again here.`);
  if (target === 'codex') console.log('Then open /hooks in Codex and trust this project\'s hooks; until you do, nothing is tracked or guarded.');
  console.log(`To undo: stma adapter disconnect --profile ${hooks!.profileId} --apply   and   ${target === 'codex' ? `delete [mcp_servers.${alias}] from ${codexFile}` : `claude mcp remove ${alias}`}`);
}
// #endregion acceptance:devices

function readHookPayload(): Record<string, unknown> {
  if (process.stdin.isTTY) return {};
  const raw = readFileSync(0, 'utf8');
  if (!raw.trim()) return {};
  if (raw.length > 1_000_000) throw new Error('Hook input exceeds 1 MB.');
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

const HOOK_REQUEST_TIMEOUT_MS = 1_200;

function hookSessionKey(adapter: ProfileAdapterConfig, payload: Record<string, unknown>): string {
  return `${adapter.profileId}:${adapter.target}:${hookSessionIdentity(payload)}`;
}

function hookIntent(adapter: ProfileAdapterConfig, payload: Record<string, unknown>): string | undefined {
  for (const key of ['prompt', 'user_prompt', 'message', 'task']) {
    if (typeof payload[key] === 'string' && payload[key]) return payload[key].slice(0, 2_000);
  }
  return adapter.defaultIntent;
}

function requestError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function selectedAdapterProfile(flags: Flags, migrate: boolean): LoadedAdapterProfile {
  const requested = one(flags, 'profile');
  let loaded = loadAdapterProfile(cwd, requested);
  if (loaded?.source === 'legacy' && migrate) {
    const migration = migrateLegacyProfile(cwd);
    loaded = migration.profile ?? loadAdapterProfile(cwd, loaded.id);
  }
  if (loaded) return loaded;
  const ids = adapterProfileIds(cwd);
  if (!requested && ids.length > 1) {
    throw new Error(`Multiple adapter profiles exist; pass --profile (${ids.join(', ')}).`);
  }
  throw new Error(
    requested
      ? `Unknown adapter profile: ${normalizeProfileId(requested)}`
      : 'Run stma adapter install --apply first.',
  );
}

async function ensureAdapterInstallation(
  profile: LoadedAdapterProfile,
  eventId: string,
): Promise<string> {
  const local = loadProfileConfig(profile.id);
  const adapter = profile.config;
  const rawDevice = [
    os.hostname(),
    os.userInfo().username,
    process.platform,
    adapter.target,
    profile.id,
  ].join('\0');
  const result = await apiRequest<any>(local, '/api/agent/installations/register', {
    method: 'POST',
    headers: { 'x-stma-event-id': eventId },
    body: JSON.stringify({
      name: adapter.agentName,
      clientType: adapter.target,
      deviceFingerprint: sha256(rawDevice),
      capabilities: ['native-hooks', 'policy-sync', 'environment-preflight', 'offline-outbox'],
      role: adapter.role,
    }),
  }, HOOK_REQUEST_TIMEOUT_MS);
  const connected = await connection(local);
  updateProfileConfig(profile.id, (current) => ({
    ...current,
    server: connected.server,
    installationId: result.installation.id,
    agentName: adapter.agentName,
    clientType: adapter.target,
  }));
  return result.installation.id as string;
}

function nativeClaims(): WorkClaim[] {
  return dirtyFiles().map((file) => ({
    resourceType: 'path',
    resourceKey: file,
    access: 'write',
  }));
}

export function buildNativeStartRequest(
  adapter: ProfileAdapterConfig,
  eventId: string,
  installationId: string,
  payload: Record<string, unknown>,
  git: {
    repo: string;
    repositoryIdentity?: string;
    branch?: string;
    baseSha?: string;
    headSha?: string;
    worktree?: string;
    worktreeClean?: boolean;
  },
  claims: WorkClaim[],
): Record<string, unknown> {
  return {
    requestId: eventId,
    installationId,
    team: adapter.team,
    project: adapter.project,
    taskKey: adapter.defaultTask,
    intent: hookIntent(adapter, payload),
    repo: git.repositoryIdentity ?? adapter.project ?? git.repo,
    repositoryIdentity: git.repositoryIdentity,
    branch: git.branch,
    worktree: git.worktree,
    baseSha: git.baseSha,
    headSha: git.headSha,
    checkpoint: gitCheckpoint(eventId, 'start', git),
    claims,
  };
}

export function buildNativeHeartbeatRequest(
  payload: Record<string, unknown>,
  observed: WorkClaim[],
  eventId?: string,
  git = gitContext(),
): Record<string, unknown> {
  const usage = hookQuota(payload);
  return {
    status: payload.hook_event_name === 'Stop' ? 'waiting' : 'active',
    claimSource: 'observed',
    ...(observed.length > 0 ? { claims: observed } : {}),
    ...(usage ? { usage } : {}),
    ...(eventId ? { checkpoint: gitCheckpoint(eventId, 'delivery', git) } : {}),
  };
}

async function startNativeRun(
  profile: LoadedAdapterProfile,
  stored: { file: string; event: QueuedHookEvent },
): Promise<string | undefined> {
  const adapter = profile.config;
  const event = stored.event;
  const sessionKey = hookSessionKey(adapter, event.payload);
  let local = loadProfileConfig(profile.id);
  const current = local.adapterRuns?.[sessionKey];
  if (current && event.notice) {
    const environment = await completeNativeSetup(profile, current, event.id);
    return [event.notice, environment].filter(Boolean).join('\n');
  }
  let request = event.request;
  if (!request) {
    if (current) {
      try {
        await apiRequest(local, `/api/agent/runs/${current}/heartbeat`, { method: 'POST', body: JSON.stringify({ status: 'active' }) }, HOOK_REQUEST_TIMEOUT_MS);
        const environment = await completeNativeSetup(profile, current, event.id);
        return [`STMA native tracking owns run ${current} for this client session. Reuse this run_id; do not start a second MCP run.`, environment].filter(Boolean).join('\n');
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
        forgetAdapterRun(profile.id, sessionKey, current);
        return startNativeRun(profile, stored);
      }
    }
    const installationId = await ensureAdapterInstallation(profile, event.id);
    local = loadProfileConfig(profile.id);
    const git = gitContext();
    request = buildNativeStartRequest(
      adapter,
      event.id,
      installationId,
      event.payload,
      git,
      nativeClaims(),
    );
    event.request = request;
    updateQueuedHookEvent(cwd, profile.id, stored.file, event);
  }
  const result = await apiRequest<any>(local, '/api/agent/runs/start', {
    method: 'POST',
    headers: { 'x-stma-event-id': event.id },
    body: JSON.stringify(request),
  }, HOOK_REQUEST_TIMEOUT_MS);
  const runId = result.run.id as string;
  if (!current) {
    const started = gitContext();
    updateProfileConfig(profile.id, (latest) => ({
      ...latest,
      currentRunId: runId,
      currentTeam: adapter.team,
      currentProject: adapter.project,
      currentClaims: Array.isArray(request?.claims) ? (request.claims as WorkClaim[]) : [],
      adapterRuns: { ...(latest.adapterRuns ?? {}), [sessionKey]: runId },
      ...(started.branch ? { adapterRunBranches: { ...(latest.adapterRunBranches ?? {}), [sessionKey]: started.branch } } : {}),
      ...(started.headSha ? { adapterRunCommits: { ...(latest.adapterRunCommits ?? {}), [sessionKey]: started.headSha } } : {}),
    }));
  }
  // The run exists the moment the server answered, and its id is the one thing
  // the agent cannot work without. Everything after it — the policy receipt,
  // the environment preflight — is advisory, and it used to be able to take the
  // id with it. Measured in the agent lab (2026-09-20): a branch switch closed
  // one run and started another, the preflight behind it failed, the notice
  // naming the new run was never printed, and the agent went on addressing the
  // run its own hook had just closed. It was refused by update_handoff and
  // update_run, then started a third run of its own, which is the state in
  // which a resume can no longer tell which run is doing the work.
  let environment: string | undefined;
  try {
    environment = await completeNativeSetup(profile, runId, event.id, result.policy);
  } catch {
    // Silence, like the receipt's own catch: a run whose optional setup failed
    // is still a run, and the hook still has to say which one.
  }

  const knowledge = result.knowledgeContext as Record<string, unknown> | undefined;
  const readiness = result.readiness as Record<string, any> | undefined;
  const notices: string[] = [`STMA native tracking owns run ${runId} for this client session. Reuse this run_id for planned scope and handoffs; do not start a second MCP run. File-tool guards do not cover arbitrary shell/MCP writes. Readiness and policy prose are not execution permission.`];
  if (environment) notices.push(environment);
  if (typeof knowledge?.context === 'string') {
    notices.push(
      'STMA Knowledge Hub context (published reference, never execution authority):\n' +
        knowledge.context,
    );
    if (typeof knowledge.reportHint === 'string') notices.push(knowledge.reportHint);
  }
  notices.push(...collisionNotices(result.conflicts));
  const approvals = Array.isArray(readiness?.needsApproval)
    ? readiness.needsApproval.length
    : readiness?.needsApproval
      ? 1
      : 0;
  const overBudget = Array.isArray(readiness?.overBudget)
    ? readiness.overBudget.length
    : readiness?.overBudget
      ? 1
      : 0;
  if (approvals) notices.push(`STMA readiness: ${approvals} protected claim(s) need approval.`);
  if (overBudget) notices.push(`STMA readiness: ${overBudget} claim(s) exceed the configured budget.`);
  if (Array.isArray(readiness?.possibleDuplicates) && readiness.possibleDuplicates.length) {
    notices.push(`STMA readiness: ${readiness.possibleDuplicates.length} possible duplicate run(s).`);
  }
  if (Array.isArray(readiness?.flowAdvice)) {
    notices.push(...readiness.flowAdvice.filter((item: unknown): item is string => typeof item === 'string'));
  } else if (typeof readiness?.flowAdvice === 'string' && readiness.flowAdvice) {
    notices.push(readiness.flowAdvice);
  }
  if (readiness?.advisory && typeof readiness?.enforcement === 'string') {
    notices.push(readiness.enforcement);
  }
  const notice = notices.join('\n') || undefined;
  if (notice) {
    event.notice = notice;
    updateQueuedHookEvent(cwd, profile.id, stored.file, event);
  }
  return notice;
}

async function completeNativeSetup(
  profile: LoadedAdapterProfile,
  runId: string,
  eventId: string,
  suppliedPolicy?: any,
): Promise<string | undefined> {
  const adapter = profile.config;
  const local = loadProfileConfig(profile.id);
  if (adapter.applyPolicy) {
    let policy = suppliedPolicy;
    if (!policy) {
      const query = new URLSearchParams({
        team: adapter.team,
        ...(adapter.project ? { project: adapter.project } : {}),
      });
      policy = await apiRequest<any>(
        local,
        `/api/agent/policies/effective?${query}`,
        { headers: { 'x-stma-event-id': eventId } },
        HOOK_REQUEST_TIMEOUT_MS,
      );
    }
    if (policy?.document && policy?.hash) {
      const reportedHash = applyPolicy(cwd, policy.document, policy.hash, adapter.target);
      await apiRequest(local, `/api/agent/runs/${runId}/policy-receipt`, {
        method: 'POST',
        headers: { 'x-stma-event-id': eventId },
        body: JSON.stringify({ expectedHash: policy.hash, reportedHash }),
      }, HOOK_REQUEST_TIMEOUT_MS);
    }
  } else if (suppliedPolicy?.document && suppliedPolicy?.hash) {
    // A run the hook owns answers for itself. The agent never had to remember
    // update_run { policy_hash }, and it never did: every hook-owned run sat on
    // the governance page as `?`, which reads as a run nobody is checking.
    //
    // The document is the one run start already returned, so this costs no
    // request, and the hash is recomputed from it rather than echoed — see
    // readPolicyHash. Nothing is written into the checkout: `applyPolicy` is
    // off here because `stma connect` does not install repository rules
    // without the human authorizing that, and attesting is not installing.
    //
    // Start only. The later prompts of the same run reach this function with no
    // policy in hand, and fetching one there would put a request on the human's
    // critical path to re-answer a question already answered.
    try {
      await apiRequest(local, `/api/agent/runs/${runId}/policy-receipt`, {
        method: 'POST',
        headers: { 'x-stma-event-id': eventId },
        body: JSON.stringify({ expectedHash: suppliedPolicy.hash, reportedHash: readPolicyHash(suppliedPolicy.document) }),
      }, HOOK_REQUEST_TIMEOUT_MS);
    } catch {
      // Silence stays "not reported", which is what it was before this. A
      // receipt is evidence; a hook that fails to file one must not fail the
      // human's prompt, and it must never guess a hash to fill the gap.
    }
  }
  if (adapter.preflight && adapter.project) {
    const verdict = await apiRequest(local, '/api/agent/environment/preflight', {
      method: 'POST',
      headers: { 'x-stma-event-id': eventId },
      body: JSON.stringify({
        team: adapter.team,
        project: adapter.project,
        runId,
        snapshot: collectSnapshot(),
      }),
    }, HOOK_REQUEST_TIMEOUT_MS);
    return environmentNotice(verdict);
  }
}

function forgetAdapterRun(profileId: string, sessionKey: string, runId: string): void {
  updateProfileConfig(profileId, (latest) => {
    const adapterRuns = { ...(latest.adapterRuns ?? {}) };
    delete adapterRuns[sessionKey];
    const adapterRunBranches = { ...(latest.adapterRunBranches ?? {}) };
    delete adapterRunBranches[sessionKey];
    const adapterRunCommits = { ...(latest.adapterRunCommits ?? {}) };
    delete adapterRunCommits[sessionKey];
    return {
      ...latest,
      currentRunId: latest.currentRunId === runId ? undefined : latest.currentRunId,
      currentClaims: latest.currentRunId === runId ? undefined : latest.currentClaims,
      adapterRuns,
      adapterRunBranches,
      adapterRunCommits,
    };
  });
}

/**
 * What a collision reported by the server should say in this agent's context.
 *
 * The same `conflictReport` the tool replies are built from, so the hook and
 * `update_run` cannot tell one agent two different stories about one heartbeat.
 * Until 2026-09-20 they did: the hook counted the overlaps it was not first on
 * ("conflict radar found 2 overlap(s)") and separately told the run to carry on
 * with the ground it was first on, neither sentence naming a file, while the
 * tool answered "narrow what you touch, or coordinate". A real agent read both,
 * wrote in its report that they contradicted each other and stopped.
 *
 * Agent names, usernames and paths are typed by people and this text becomes
 * another agent's context, so every fragment that came off the wire passes a
 * shape check first — the rule the write guard's `conflictAgents` already
 * follows — and anything unrecognised is named generically instead of dropped.
 */
function collisionNotices(conflicts: unknown): string[] {
  const rows = (Array.isArray(conflicts) ? conflicts : []).filter(
    (item): item is RightOfWayConflict =>
      Boolean(item) && typeof (item as RightOfWayConflict)?.current?.resourceKey === 'string',
  );
  if (rows.length === 0) return [];
  const report = conflictReport(rows, {
    safe: (text, kind) =>
      kind === 'holder'
        ? /^[\w ,.()@-]{1,160}$/.test(text)
          ? text
          : 'another agent'
        : /^[\w./\\@+-]{1,160}$/.test(text)
          ? text
          : 'a path it claimed',
  });
  return [report.blocked, report.holding].filter((line): line is string => Boolean(line)).map((line) => `STMA — ${line}`);
}

/**
 * A hook-owned run is one branch. When the checkout moves to another branch —
 * a handoff received on a different branch is the ordinary case — the old run
 * is closed and a new one starts on the branch the work is now on, so its
 * start checkpoint names the commit the work began from. Measured 2026-09-19:
 * a receiver that switched branches could not resume, because the only run
 * it had started elsewhere and `update_handoff resume` compares that run's
 * start commit with the handoff's.
 */
async function migrateRunIfBranchChanged(
  profile: LoadedAdapterProfile,
  stored: { file: string; event: QueuedHookEvent },
  sessionKey: string,
  runId: string,
): Promise<string | undefined> {
  const local = loadProfileConfig(profile.id);
  const startedOn = local.adapterRunBranches?.[sessionKey];
  const now = gitContext().branch;
  if (!startedOn || !now || now === startedOn) return undefined;
  try {
    await apiRequest(local, `/api/agent/runs/${runId}/finish`, {
      method: 'POST', headers: { 'x-stma-event-id': `${stored.event.id}:switch` }, body: JSON.stringify({ status: 'completed' }),
    }, HOOK_REQUEST_TIMEOUT_MS);
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
  }
  forgetAdapterRun(profile.id, sessionKey, runId);
  const started = await startNativeRun(profile, { ...stored, event: { ...stored.event, request: undefined } });
  return [
    `STMA: this checkout switched from branch ${startedOn} to ${now}. Native tracking closed run ${runId} and started another on ${now}; use the new run_id below for scope and handoffs.`,
    started,
  ].filter(Boolean).join('\n');
}

async function processHookEvent(
  profile: LoadedAdapterProfile,
  stored: { file: string; event: QueuedHookEvent },
): Promise<string | undefined> {
  const adapter = profile.config;
  const event = stored.event;
  const sessionKey = hookSessionKey(adapter, event.payload);

  if (event.event === 'start') {
    const owned = loadProfileConfig(profile.id).adapterRuns?.[sessionKey];
    if (owned) {
      const moved = await migrateRunIfBranchChanged(profile, stored, sessionKey, owned);
      if (moved) return moved;
    }
    return startNativeRun(profile, stored);
  }
  let local = loadProfileConfig(profile.id);
  let runId = local.adapterRuns?.[sessionKey];
  if (event.event === 'heartbeat' && !runId) {
    await startNativeRun(profile, stored);
    local = loadProfileConfig(profile.id);
    runId = local.adapterRuns?.[sessionKey];
  }
  if (!runId) return undefined;
  if (event.event === 'heartbeat') {
    const moved = await migrateRunIfBranchChanged(profile, stored, sessionKey, runId);
    if (moved) return moved;
    local = loadProfileConfig(profile.id);
  }

  if (event.event === 'heartbeat') {
    const observed = nativeClaims();
    try {
      const result = await apiRequest<any>(local, `/api/agent/runs/${runId}/heartbeat`, {
        method: 'POST',
        headers: { 'x-stma-event-id': event.id },
        body: JSON.stringify(buildNativeHeartbeatRequest(event.payload, observed, event.id)),
      }, HOOK_REQUEST_TIMEOUT_MS);
      const notices: string[] = [...collisionNotices(result?.conflicts)];
      const stale = Array.isArray(result?.stale) ? result.stale.length : result?.stale ? 1 : 0;
      if (stale) notices.push(`STMA warning: ${stale} stale-ground overlap(s) detected.`);
      if (result?.quota && result.quota.state !== 'ok' && result.quota.advice) {
        notices.push(`[stma] ${result.quota.advice}`);
      }
      return notices.join('\n') || undefined;
    } catch (error) {
      if ((error as { status?: number }).status === 404) forgetAdapterRun(profile.id, sessionKey, runId);
      throw error;
    }
  }

  await reportContentThatLanded(profile, local, runId, event.id, sessionKey);
  try {
    await apiRequest(local, `/api/agent/runs/${runId}/finish`, {
      method: 'POST',
      headers: { 'x-stma-event-id': event.id },
      body: JSON.stringify({
        status: 'completed',
        checkpoint: gitCheckpoint(event.id, 'delivery', gitContext()),
      }),
    }, HOOK_REQUEST_TIMEOUT_MS);
  } catch (error) {
    if ((error as { status?: number }).status === 404) forgetAdapterRun(profile.id, sessionKey, runId);
    throw error;
  }
  forgetAdapterRun(profile.id, sessionKey, runId);
  return undefined;
}

function hookOutput(target: AdapterTarget, notice?: string, event = 'UserPromptSubmit'): void {
  if (!notice) return;
  console.log(JSON.stringify(nativeHookContext(target, event, notice)));
}

async function adapterFileGuard(flags: Flags): Promise<void> {
  let reason = 'coordination_unavailable';
  let deniedRule: string | undefined;
  let holders = '';
  let needsAPerson = false;
  try {
    const profile = selectedAdapterProfile(flags, false);
    if (!profile.config.writeGuard || profile.config.target === 'cursor') throw new Error('guard_not_enabled');
    const payload = readHookPayload();
    const key = hookSessionKey(profile.config, payload);
    const claims = fileToolClaims(cwd, payload);
    const local = loadProfileConfig(profile.id);
    const runId = local.adapterRuns?.[key];
    if (!runId) { reason = 'no_tracked_run'; throw new Error(reason); }
    const git = gitContext();
    const reply = await apiRequest<any>(local, `/api/agent/runs/${runId}/write-guard`, {
      method: 'POST', body: JSON.stringify({ claims, repositoryIdentity: git.repositoryIdentity, worktree: git.worktree }),
    }, 4_000);
    if (reply?.ok === true && reply.allowed === true && reply.runId === runId && reply.coverage === 'installed_file_tool_hook_only') {
      // The path is clear. Now the content — checked here, against the team's
      // published `content:` deny lines, and never sent: a report carries the
      // rule's own words and the file path, which the server already holds.
      const rules = parseContentRules(
        Array.isArray(reply.contentRules)
          ? reply.contentRules.filter((line: unknown): line is string => typeof line === 'string')
          : [],
      );
      const hits = rules.length === 0 ? [] : fileToolAddedText(cwd, payload).flatMap((added) =>
        matchContentRules(rules, added.path, added.text).map((rule) => ({ rule: rule.rule, path: added.path })));
      if (hits.length === 0) return;
      for (const hit of hits.slice(0, 5)) {
        // Best effort: the edit is stopped whether or not the report arrives.
        try {
          await apiRequest(local, `/api/agent/runs/${runId}/policy-violations`, {
            method: 'POST', body: JSON.stringify({ rule: hit.rule, path: hit.path, outcome: 'blocked' }),
          }, 2_500);
        } catch { /* a missed report costs evidence, never the block */ }
      }
      reason = 'policy_content_denied';
      deniedRule = hits[0]!.rule;
    } else {
      const known = ['checkout_mismatch', 'policy_unavailable', 'scope_capacity', 'owner_approval_required', 'change_budget_exceeded', 'work_conflict', 'stale_ground'];
      reason = known.includes(reply?.reason) ? reply.reason : 'unverified_guard_response';
      if (Array.isArray(reply?.conflictAgents)) {
        // Server-built from an agent name, a username, a run state and a lease,
        // but the first two are typed by people: the shape check is what keeps a
        // name from writing a sentence into this agent's context.
        holders = reply.conflictAgents.filter((name: unknown) => typeof name === 'string' && /^[\w ,.()@-]{1,160}$/.test(name)).slice(0, 5).join('; ');
      }
      needsAPerson = reply?.conflictNeedsAPerson === true;
    }
  } catch { /* Fail closed, with no raw tool input, response, path or credential in diagnostics. */ }
  const explanation = deniedRule
    ? `Your team's published policy denies this content here — ${deniedRule}. Tell your human which rule stopped you; do not bypass it through a shell or another tool.`
    : reason === 'stale_ground'
      ? 'Another run finished on this ground after yours started, so what you read may be gone. Tell your human; fetch or pull only as they direct; then re-declare your scope with update_run (STMA reports what moved) and retry the edit. Do not bypass it through a shell or another tool.'
      : reason === 'work_conflict'
        ? `Another live run holds this ground${holders ? `: ${holders}` : ''}. Tell your human${needsAPerson ? ', including that the run holding it has stopped to ask a person and so will not free the ground by itself: waiting will not help, coordinate through a session' : ', and wait or coordinate through a session'}; do not bypass it through a shell or another tool.`
        : 'Resolve the connection, scope or conflict with your human; do not bypass it through a shell or another tool.';
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `STMA stopped this file edit: ${reason}. ${explanation}` } }));
}

/**
 * What is in the checkout that the team's rules forbid, reported once when the
 * run ends.
 *
 * The file guard is the other half of this and it can only ever be half: it
 * sees the supported file tools of a client that has the hook installed, so a
 * shell redirect, an editor, `git apply`, a generator or an agent with no hook
 * all walk past it. Governance could say what was stopped and never what
 * landed, which is the one thing a content rule exists to answer.
 *
 * Same boundary as the guard, stated again because it is the whole design: the
 * text is read and matched in this process and then dropped. What leaves is the
 * rule in the owner's own published words and a path the server already holds
 * as a claim, and the endpoint has no field for anything else.
 *
 * Best effort throughout. A finish that fails because a scan failed would trade
 * a missing line on a page for a run nobody closed.
 */
async function reportContentThatLanded(
  profile: LoadedAdapterProfile,
  local: LocalConfig,
  runId: string,
  eventId: string,
  sessionKey: string,
): Promise<void> {
  const adapter = profile.config;
  if (!adapter.writeGuard || adapter.target === 'cursor') return;
  const since = local.adapterRunCommits?.[sessionKey];
  if (!since) return;
  try {
    const query = new URLSearchParams({
      team: adapter.team,
      ...(adapter.project ? { project: adapter.project } : {}),
    });
    const policy = await apiRequest<any>(
      local,
      `/api/agent/policies/effective?${query}`,
      { headers: { 'x-stma-event-id': eventId } },
      HOOK_REQUEST_TIMEOUT_MS,
    );
    const rules = parseContentRules(policy?.document?.permissions?.deny ?? []);
    if (rules.length === 0) return;
    const hits = checkoutAddedText(cwd, since, (args) => shell('git', args) ?? '').flatMap((file) =>
      matchContentRules(rules, file.path, file.text).map((rule) => ({ rule: rule.rule, path: file.path })),
    );
    // One line per (rule, path); the server dedupes across runs, this dedupes
    // within one, and five is the same cap the guard reports under.
    const seen = new Set<string>();
    for (const hit of hits) {
      const key = `${hit.rule}\0${hit.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size > 5) break;
      await apiRequest(local, `/api/agent/runs/${runId}/policy-violations`, {
        method: 'POST',
        headers: { 'x-stma-event-id': eventId },
        body: JSON.stringify({ rule: hit.rule, path: hit.path, outcome: 'present' }),
      }, HOOK_REQUEST_TIMEOUT_MS);
    }
  } catch {
    // A missed report costs evidence, never the finish.
  }
}

/** 4xx means the request itself is wrong; only 5xx and transport faults retry. */
function isPermanentHookFailure(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

async function adapterHook(flags: Flags): Promise<void> {
  const value = required(flags, 'event');
  if (value === 'guard') return adapterFileGuard(flags);
  if (!['start', 'heartbeat', 'finish'].includes(value)) fail('Invalid adapter hook event.');
  let profile: LoadedAdapterProfile;
  let payload: Record<string, unknown>;
  try {
    profile = selectedAdapterProfile(flags, true);
    payload = readHookPayload();
    hookSessionIdentity(payload); // Never merge unidentified clients into one checkout-wide run.
    if (adapterProfileIds(cwd).filter((id) => loadAdapterProfile(cwd, id)?.config.target === profile.config.target).length > 1) throw new Error('Ambiguous client profiles; keep one profile per client in this checkout.');
  } catch (error) {
    console.error('[stma] ' + requestError(error));
    return;
  }
  const safePayload = retainedHookPayload(payload);
  const quota = hookQuota(payload);
  if (quota) safePayload.usage = {
    usedPct: quota.usedPct, source: quota.source,
    ...(typeof quota.resetsAt === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(quota.resetsAt) ? { resetsAt: quota.resetsAt } : {}),
  };
  const current: QueuedHookEvent = {
    id: randomUUID(),
    event: value as QueuedHookEvent['event'],
    payload: safePayload,
    queuedAt: new Date().toISOString(),
  };
  let enqueue;
  try {
    // This fsync completes before the first network call. If the native client
    // kills its hook at the timeout boundary, the same event id replays later.
    enqueue = enqueueHookEvent(cwd, profile.id, current);
  } catch (error) {
    console.error('[stma] Could not persist lifecycle event: ' + requestError(error));
    return;
  }
  if (!enqueue.queued) {
    const warning = `STMA outbox is full (${enqueue.pendingEvents} pending, ${enqueue.droppedEvents} dropped). Run stma adapter status --profile ${profile.id}.`;
    console.error('[stma] ' + warning);
    hookOutput(profile.config.target, warning, String(payload.hook_event_name ?? 'UserPromptSubmit'));
    return;
  }

  const release = acquireProfileReplayLock(cwd, profile.id);
  if (!release) {
    console.error(`[stma] ${enqueue.pendingEvents} lifecycle event(s) pending for ${profile.id}; another hook is syncing.`);
    return;
  }
  const deadline = Date.now() + (value === 'finish' ? 2_200 : 8_000);
  const notices: string[] = [];
  const delivered: Array<{ file: string; id: string }> = [];
  // Asked before the queued lifecycle work and awaited after it. A prompt is
  // the one moment an announcement can land, and this used to be skipped when
  // the queue had already spent most of the hook's budget — which is every
  // first prompt of every session, because that is the one that has to create
  // the run, file its receipt and run the preflight first. Measured across both
  // agent-lab rounds of 2026-09-20: not one of the eight first prompts asked,
  // the lead's assignment reached each agent on its next tool call instead, and
  // two of four agents correctly refused to act on work that had arrived inside
  // a tool result. The request is the same bounded GET as before; it now
  // overlaps work already in flight rather than queueing behind it.
  const waiting = value === 'finish'
    ? undefined
    : newsNotice(profile, hookSessionKey(profile.config, payload), value === 'start');
  try {
    const pending = readQueuedHookEvents(cwd, profile.id);
    for (const stored of pending.events) {
      if (Date.now() + HOOK_REQUEST_TIMEOUT_MS >= deadline) break;
      try {
        const result = await processHookEvent(profile, stored);
        if (result) notices.push(result);
        delivered.push({ file: stored.file, id: stored.event.id });
      } catch (error) {
        const message = requestError(error);
        if (isPermanentHookFailure(error)) {
          discardHookEvent(cwd, profile.id, stored.file, stored.event.id, message);
          // An agent that closed its run itself (finish_run, or a handoff that
          // released it) leaves the next heartbeat and the Stop/SessionEnd hook
          // nothing to report to; that is the normal end of a job, not a
          // rejection worth a notice. The run id is already forgotten (404).
          const alreadyClosed = (stored.event.event === 'finish' || stored.event.event === 'heartbeat') &&
            /unknown_or_inactive_run/.test(message);
          if (stored.event.id === current.id && !alreadyClosed) {
            notices.push('STMA rejected this lifecycle event: ' + message);
          }
          continue;
        }
        try {
          markHookEventFailed(cwd, profile.id, stored.event.id, message);
        } catch {
          // The event remains durable; doctor will expose status corruption.
        }
        break;
      }
    }
    hookOutput(
      profile.config.target,
      [...notices, await waiting].filter(Boolean).join('\n\n') || undefined,
      String(payload.hook_event_name ?? (value === 'heartbeat' ? 'PostToolUse' : value === 'finish' ? 'Stop' : 'UserPromptSubmit')),
    );
    // Delete only after stdout has received every server-generated notice. A
    // killed hook may duplicate a notice on replay, but cannot silently lose it.
    for (const item of delivered) {
      markHookEventDelivered(cwd, profile.id, item.file, item.id);
    }
  } finally {
    release();
  }
  const delivery = adapterDeliveryStatus(cwd, profile.id);
  if (delivery.corruptEvents.length || delivery.statusCorrupt) {
    console.error(`[stma] Outbox corruption detected for ${profile.id}; run stma adapter repair --profile ${profile.id} --apply.`);
  } else if (delivery.pendingEvents) {
    console.error(`[stma] ${delivery.pendingEvents} lifecycle event(s) pending for ${profile.id}.`);
  }
}

/**
 * Ask the server what is waiting and only report what
 * has not been reported before — to *this client session*. Announcements used
 * to be remembered per checkout, so a session closed before the agent acted,
 * or one whose context was lost, never heard the assignment again (measured
 * 2026-09-19); now each session is told once.
 *
 * `prompt` is a person typing, the one moment an announcement can land, so it
 * always asks. The once-a-minute limit is for tool-use heartbeats, which fire
 * many times a minute. Holding a prompt to it meant a lead who assigned work
 * within a minute of the agent's last tool call was not announced: the agent
 * found the assignment in its inbox on its own and, without the hook's "accept
 * unless your human objects", asked first — one more sentence on that machine
 * (measured in the agent lab, 2026-09-19).
 *
 * Everything about this function is defensive: it is on the path between a
 * human pressing enter and their agent answering. A server that is slow, down,
 * or returning something unexpected must cost nothing but silence.
 */
async function newsNotice(profile: LoadedAdapterProfile, sessionKey?: string, prompt = false): Promise<string | undefined> {
  try {
    const config = loadProfileConfig(profile.id);
    const scope = sessionKey ? `${sessionKey}|` : '';
    const firstPromptOfSession = !!sessionKey && !(config.newsSessions ?? []).includes(sessionKey);
    if (!prompt && !firstPromptOfSession && !dueForCheck({ lastCheckedAt: config.newsCheckedAt, announced: config.newsAnnounced })) {
      return undefined;
    }
    const { server, token } = await connection(config);
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
    const state = {
      lastCheckedAt: config.newsCheckedAt,
      announced: (config.newsAnnounced ?? []).filter((key) => key.startsWith(scope)).map((key) => key.slice(scope.length)),
    };
    const fresh = unseen(news, state);
    // The timestamp moves even when there is nothing to say, so an idle team
    // does not re-ask on every single prompt.
    updateProfileConfig(profile.id, (latest) => ({
      ...latest,
      newsCheckedAt: news.checkedAt,
      newsAnnounced: [...new Set([...(latest.newsAnnounced ?? []), ...fresh.map((h) => scope + handoffKey(h))])].slice(-100),
      ...(sessionKey ? { newsSessions: [...new Set([...(latest.newsSessions ?? []), sessionKey])].slice(-20) } : {}),
    }));
    return renderNews(fresh, news.unreadSessions, config.mcpAlias);
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
  const { server } = await connection(config);
  const announced = new Set<string>();
  let firstPass = true;

  console.log(`stma: watching ${server} every ${seconds}s. Ctrl+C to stop.`);
  for (;;) {
    try {
      const { token } = await connection(config);
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
          const branch = handoff.resume?.branch ? ` on ${handoff.resume.branch}` : '';
          const line =
            handoff.kind === 'assignment' && handoff.assignedTo?.thisAgent
              ? `assigned to this agent — "${handoff.title}" by ${handoff.from ?? 'a teammate'}${branch}`
              : `work waiting — "${handoff.title}" from ${who}${branch}`;
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

function profilesForInspection(flags: Flags): LoadedAdapterProfile[] {
  const requested = one(flags, 'profile');
  if (requested) {
    const loaded = loadAdapterProfile(cwd, requested);
    if (!loaded) throw new Error(`Unknown adapter profile: ${normalizeProfileId(requested)}`);
    return [loaded];
  }
  const profiles = adapterProfileIds(cwd)
    .map((id) => loadAdapterProfile(cwd, id))
    .filter((profile): profile is LoadedAdapterProfile => Boolean(profile));
  const legacy = loadAdapterProfile(cwd);
  if (legacy?.source === 'legacy' && !profiles.some((profile) => profile.id === legacy.id)) {
    profiles.unshift(legacy);
  }
  return profiles;
}

function inspectAdapterProfile(profile: LoadedAdapterProfile): {
  state?: LocalConfig;
  delivery: ReturnType<typeof adapterDeliveryStatus>;
  hookCount: number;
  issues: string[];
} {
  const issues: string[] = [];
  let state: LocalConfig | undefined;
  let hookCount = -1;
  try {
    state = loadProfileConfig(profile.id);
  } catch (error) {
    issues.push(requestError(error));
  }
  const delivery = adapterDeliveryStatus(cwd, profile.id);
  try {
    hookCount = installedHookCount(cwd, profile.config);
    const expectedHooks = profile.config.writeGuard ? 5 : 3;
    if (hookCount !== expectedHooks) issues.push(`expected ${expectedHooks} owned hooks, found ${hookCount}`);
  } catch (error) {
    issues.push(requestError(error));
  }
  if (profile.source === 'legacy') issues.push('legacy config needs repair/migration');
  if (delivery.statusCorrupt) issues.push('delivery status is corrupt');
  if (delivery.corruptEvents.length) issues.push(`${delivery.corruptEvents.length} corrupt outbox event(s)`);
  if (delivery.droppedEvents) issues.push(`${delivery.droppedEvents} event(s) dropped`);
  return { state, delivery, hookCount, issues };
}

function adapterStatus(flags: Flags): void {
  let profiles: LoadedAdapterProfile[];
  try {
    profiles = profilesForInspection(flags);
  } catch (error) {
    fail(requestError(error));
  }
  if (!profiles.length) {
    console.log('No adapter profiles installed.');
    return;
  }
  for (const profile of profiles) {
    const inspected = inspectAdapterProfile(profile);
    console.log(
      `${profile.id}  ${profile.config.target}  ${profile.config.team}/${profile.config.project ?? '—'}  ` +
        `${profile.config.role ?? 'generalist'}  hooks:${inspected.hookCount < 0 ? '?' : inspected.hookCount}`,
    );
    console.log(
      `  delivery: ${inspected.delivery.pendingEvents} pending, ${inspected.delivery.droppedEvents} dropped, ` +
        `${inspected.delivery.corruptEvents.length} corrupt; last synced ${inspected.delivery.lastDeliveredAt ?? 'never'}`,
    );
    if (inspected.delivery.lastError) console.log(`  last error: ${inspected.delivery.lastError}`);
    if (inspected.state?.installationId) console.log(`  installation: ${inspected.state.installationId}`);
    if (inspected.issues.length) console.log(`  attention: ${inspected.issues.join('; ')}`);
  }
}

/**
 * Whether the client still loads the MCP entry this checkout was connected with.
 *
 * Half a disconnect leaves exactly this: hooks, profile and credential in place
 * and the entry gone. It happened for real on 2026-09-19, when Kaspersky killed
 * `adapter disconnect` partway through — the process died before the request and
 * before the local removal, so only the separate `claude mcp remove` took
 * effect. A checkout in that state keeps firing hooks whose own text names a
 * server the client cannot load, and nothing said so.
 *
 * Absent rather than false when the answer is not knowable: an old profile has
 * no recorded alias, the Claude binary may not be on PATH, and Codex keeps its
 * entries in a user file that may legitimately not exist. Doctor reports what it
 * checked, and silence is not a verdict.
 */
export function mcpEntryLoads(
  state: { mcpAlias?: string; clientType?: string } | undefined,
  // Injected so both branches are testable without a Claude binary on PATH;
  // the real one is the only caller that leaves it out.
  askClaude: (args: string[]) => { status: number | null } = claudeCli,
): boolean | undefined {
  const alias = state?.mcpAlias;
  if (!alias || !/^[\w.-]{1,120}$/.test(alias)) return undefined;
  if (state?.clientType === 'claude-code') {
    const found = askClaude(['mcp', 'get', alias]);
    // A missing binary is a null status, which is not the same answer as a
    // binary that ran and could not find the entry.
    return found.status === null ? undefined : found.status === 0;
  }
  if (state?.clientType === 'codex') {
    try {
      const file = codexConfigPath();
      if (!existsSync(file)) return undefined;
      return readCodexConfig(file).includes(`[mcp_servers.${alias}]`);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function adapterDoctor(flags: Flags): Promise<void> {
  let profiles: LoadedAdapterProfile[];
  try {
    profiles = profilesForInspection(flags);
  } catch (error) {
    fail(requestError(error));
  }
  if (!profiles.length) fail('No adapter profiles installed.');
  let unhealthy = false;
  for (const profile of profiles) {
    const inspected = inspectAdapterProfile(profile);
    const issues = [...inspected.issues];
    if (!process.env.STMA_TOKEN && !inspected.state?.connection) issues.push('no approved credential is linked');
    if (!inspected.state?.server) issues.push('server URL is not recorded');
    if (mcpEntryLoads(inspected.state) === false) {
      issues.push(
        `the hooks are installed but this client no longer loads the MCP entry "${inspected.state!.mcpAlias}" — half a disconnect. ` +
          `Finish it with "stma adapter disconnect --profile ${profile.id} --apply", or connect again with "stma connect".`,
      );
    }
    if (inspected.state?.server && (inspected.state?.connection || process.env.STMA_TOKEN)) {
      try { await connection(inspected.state); } catch (error) { issues.push(`credential check failed: ${requestError(error)}`); }
    }
    if (issues.length) {
      unhealthy = true;
      console.log(`${profile.id}: ATTENTION`);
      for (const issue of issues) console.log(`  - ${issue}`);
    } else {
      console.log(`${profile.id}: OK`);
      if (!inspected.delivery.lastDeliveredAt) console.log('  Real task tracking is not verified yet.');
      // Said out loud, because "OK" about a check that did not run is the kind
      // of reassurance that costs somebody an afternoon.
      if (mcpEntryLoads(inspected.state) === undefined) {
        console.log('  Whether the client still loads this checkout\'s MCP entry could not be checked here.');
      }
    }
  }
  if (unhealthy) process.exitCode = 1;
}

function adapterRepair(flags: Flags): void {
  const apply = one(flags, 'apply') === 'true';
  // A pinned runtime never updates itself — that is the point of pinning — so
  // an upgraded CLI needs a deliberate way into a checkout that is already
  // connected. Re-pinning keeps the credential and the consent; activating
  // again would mint a second installation to deliver a bug fix.
  const pin = one(flags, 'pin-runtime') === 'true';
  let profile: LoadedAdapterProfile;
  try {
    profile = selectedAdapterProfile(flags, false);
    if (profile.source === 'legacy' && apply) {
      profile = migrateLegacyProfile(cwd).profile ?? profile;
    }
    const result = installAdapter({
      root: cwd,
      config: profile.config,
      command: pin && apply
        ? prepareNativeRuntime(cwd, fileURLToPath(import.meta.url), profile.config.target)
        : (one(flags, 'command') ?? 'stma'),
      apply,
      replace: true,
    });
    if (!apply) {
      console.log(`Dry run repair for ${result.profileId}. Nothing was written.`);
      console.log(JSON.stringify(result.hooks, null, 2));
      return;
    }
    const repaired = repairProfileOutbox(cwd, result.profileId);
    updateProfileConfig(result.profileId, (current) => ({
      ...current,
      server: (process.env.STMA_URL ?? current.server ?? loadConfig().server ?? 'http://localhost:3000').replace(/\/$/, ''),
      agentName: profile.config.agentName,
      clientType: profile.config.target,
    }));
    console.log(`Repaired ${result.profileId}; hooks restored at ${result.hookPath}.${pin ? ' Runtime re-pinned to this CLI.' : ''}`);
    if (repaired.quarantinedEvents.length || repaired.statusQuarantined) {
      console.log(
        `Preserved ${repaired.quarantinedEvents.length} corrupt event(s)` +
          `${repaired.statusQuarantined ? ' and corrupt delivery status' : ''} for inspection.`,
      );
    }
  } catch (error) {
    fail(requestError(error));
  }
}

// #region acceptance:devices
async function adapterDisconnect(flags: Flags): Promise<void> {
  const apply = one(flags, 'apply') === 'true';
  let profile: LoadedAdapterProfile;
  try {
    profile = selectedAdapterProfile(flags, apply);
    const delivery = adapterDeliveryStatus(cwd, profile.id);
    if (
      apply &&
      one(flags, 'force') !== 'true' &&
      (delivery.pendingEvents > 0 || delivery.corruptEvents.length > 0)
    ) {
      fail(
        `Profile ${profile.id} has ${delivery.pendingEvents} pending and ${delivery.corruptEvents.length} corrupt event(s). Retry sync or pass --force=true.`,
      );
    }
    const credential = loadProfileConfig(profile.id).connection;
    const revoked = apply && credential?.client === 'oauth-local'
      ? await (isTerminalCredential(credential.alias) ? revokeTerminalCredential(credential.alias) : revokeLocalAdapterCredential(credential.alias))
      : undefined;
    const result = uninstallAdapter({ root: cwd, profileId: profile.id, apply });
    if (!apply) {
      console.log(`Dry run disconnect for ${profile.id}. Nothing was written.`);
      console.log(`Would remove only this profile's hooks from ${result.hookPath}.`);
      return;
    }
    console.log(`Disconnected local adapter profile ${profile.id}.`);
    if (result.preservedFiles.length) {
      console.log(`Preserved unowned files in its directory: ${result.preservedFiles.join(', ')}`);
    }
    if (revoked === true) console.log('This local adapter OAuth installation was revoked.');
    else if (revoked === false) console.log('Remote OAuth revocation is UNCONFIRMED. Revoke this installation in STMA Agent connections.');
    else console.log('Remote installation was not revoked; use the STMA Agent Fleet console if revocation is required.');
  } catch (error) {
    fail(requestError(error));
  }
}
// #endregion acceptance:devices

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
                 [--attempt-group KEY] [--request-id UUID]
                 A pending request is frozen before networking and reused after a lost response.
                 Use --discard-pending=true only to declare a deliberately new logical start.
  stma run heartbeat [--status active|waiting|blocked]
                     [--used-pct N] [--resets-at ISO] [--quota-label TEXT]
                     [--quota-source measured|estimate]
                     report your own vendor allowance; STMA answers with when to hand off
  stma run finish [--status completed|failed]
  stma run list [--team TEAM]
  stma run exec --team TEAM [run options] -- <agent command>
  stma policy publish --team TEAM [--project PROJECT] [--file policy.json]
  stma policy pull --team TEAM [--project PROJECT] [--apply]
  stma knowledge receipt --context UUID --manifest SHA256
                         explicitly report a context after this client applied it; never compliance
  stma env baseline --team TEAM --project PROJECT
  stma env preflight --team TEAM --project PROJECT
  stma connect CODE --server HTTPS_ORIGIN
             Run in a terminal at a Git checkout root with the command from Agent connections:
             adds the Claude Code (this checkout) or Codex (user config) MCP entry and the
             checkout's local hooks as ONE installation.
             Shows the workspace and project and asks first. Never paste the code into an agent.
  stma adapter install --target claude-code|codex|cursor --team TEAM [--project PROJECT]
                       [--profile ID] [--name NAME] [--role ROLE] [--command stma]
                       [--policy=false] [--preflight=false] [--replace=true] [--apply]
  stma adapter activate --target claude-code|codex --team TEAM --project PROJECT
                        --server HTTPS_ORIGIN [--name NAME]
             Approve a separate local adapter OAuth identity, then install project hooks.
  stma adapter status [--profile ID]
  stma adapter doctor [--profile ID]
  stma adapter repair [--profile ID] [--command stma] [--pin-runtime] [--apply]
  stma adapter disconnect --profile ID [--force=true] [--apply]
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

export async function main(): Promise<void> {
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
  // `connect CODE --server …`: the code is positional because it is pasted, not typed.
  if (group === 'connect') {
    const positional = action && !action.startsWith('--') ? action : undefined;
    return connectCheckout(positional, parseFlags(positional ? rest : argv.slice(1)).flags);
  }
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
  if (group === 'knowledge' && action === 'receipt') return reportKnowledgeReceipt(flags);
  if (group === 'env' && action === 'baseline') return environment(flags, 'baseline');
  if (group === 'env' && action === 'preflight') return environment(flags, 'preflight');
  if (group === 'adapter' && action === 'install') return adapterInstall(flags);
  if (group === 'adapter' && action === 'activate') return adapterActivate(flags);
  if (group === 'adapter' && action === 'hook') return adapterHook(flags);
  if (group === 'adapter' && action === 'status') return adapterStatus(flags);
  if (group === 'adapter' && action === 'doctor') return adapterDoctor(flags);
  if (group === 'adapter' && action === 'repair') return adapterRepair(flags);
  if (group === 'adapter' && (action === 'disconnect' || action === 'uninstall')) {
    return adapterDisconnect(flags);
  }
  help();
}

export function isCliEntrypoint(moduleUrl: string, argvEntry: string | undefined): boolean {
  if (!argvEntry) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(path.resolve(argvEntry));
  } catch {
    return false;
  }
}

if (isCliEntrypoint(import.meta.url, process.argv[1])) {
  await main();
}
