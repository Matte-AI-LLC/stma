import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const ADAPTER_TARGETS = ['claude-code', 'codex', 'cursor'] as const;
export type AdapterTarget = (typeof ADAPTER_TARGETS)[number];

/** Version 1 is the historical checkout-wide .stma/adapter.json shape. */
export interface AdapterConfig {
  schemaVersion: 1 | 2;
  profileId?: string;
  target: AdapterTarget;
  team: string;
  project?: string;
  agentName: string;
  role?: 'generalist' | 'implementer' | 'reviewer' | 'tester' | 'planner' | 'ops';
  defaultTask?: string;
  defaultIntent?: string;
  applyPolicy: boolean;
  preflight: boolean;
  /** Opt-in synchronous guard for native file-edit tools; not a shell/OS sandbox. */
  writeGuard?: boolean;
}

export type ProfileAdapterConfig = AdapterConfig & { schemaVersion: 2; profileId: string };

export interface AdapterInstallOptions {
  root: string;
  config: AdapterConfig;
  command: string;
  apply: boolean;
  replace?: boolean;
}

export interface AdapterProfilePaths {
  directory: string;
  adapterPath: string;
  statePath: string;
  outboxDirectory: string;
  deliveryPath: string;
  migrationPath: string;
  stateLockPath: string;
  outboxLockPath: string;
  replayLockPath: string;
}

export interface LoadedAdapterProfile {
  id: string;
  config: ProfileAdapterConfig;
  source: 'profile' | 'legacy' | 'unique-profile';
}

export interface QueuedHookEvent {
  id: string;
  event: 'start' | 'heartbeat' | 'finish';
  payload: Record<string, unknown>;
  queuedAt: string;
  /** Frozen REST body used when a response is lost and this event replays. */
  request?: Record<string, unknown>;
  /** Frozen server-generated notice, retained until stdout delivery succeeds. */
  notice?: string;
}

interface DeliveryRecord {
  schemaVersion: 1;
  droppedEvents: number;
  lastEnqueuedAt?: string;
  lastDeliveredAt?: string;
  lastFailedAt?: string;
  lastOverflowAt?: string;
  lastError?: string;
  lastEventId?: string;
}

export interface AdapterDeliveryStatus extends DeliveryRecord {
  pendingEvents: number;
  corruptEvents: string[];
  statusCorrupt: boolean;
}

type JsonObject = Record<string, any>;

export const MAX_OUTBOX_EVENTS = 500;
const MAX_PROFILE_ID_LENGTH = 64;
const LOCK_STALE_MS = 30_000;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** A shell-safe, path-safe id; installed hook commands never need quoting. */
export function normalizeProfileId(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) throw new Error('Profile id must contain at least one letter or number.');
  if (normalized.length <= MAX_PROFILE_ID_LENGTH) return normalized;
  const prefix = normalized.slice(0, MAX_PROFILE_ID_LENGTH - 9).replace(/-+$/g, '');
  return prefix + '-' + sha256(normalized).slice(0, 8);
}

export function defaultProfileId(
  config: Pick<AdapterConfig, 'target' | 'team' | 'project' | 'role' | 'agentName'>,
): string {
  return normalizeProfileId(
    [
      config.target,
      config.team,
      config.project ?? 'workspace',
      config.role ?? 'generalist',
      config.agentName,
    ].join('-'),
  );
}

function resolvedConfig(config: AdapterConfig, requestedId?: string): ProfileAdapterConfig {
  if (!ADAPTER_TARGETS.includes(config.target)) throw new Error('Unknown adapter target: ' + config.target);
  if (!config.team?.trim()) throw new Error('Adapter team cannot be empty.');
  if (!config.agentName?.trim()) throw new Error('Adapter agent name cannot be empty.');
  const profileId = normalizeProfileId(requestedId ?? config.profileId ?? defaultProfileId(config));
  return { ...config, role: config.role ?? 'generalist', schemaVersion: 2, profileId };
}

export function adapterProfilePaths(root: string, value: string): AdapterProfilePaths {
  const profileId = normalizeProfileId(value);
  const directory = path.join(root, '.stma', 'profiles', profileId);
  return {
    directory,
    adapterPath: path.join(directory, 'adapter.json'),
    statePath: path.join(directory, 'state.json'),
    outboxDirectory: path.join(directory, 'outbox'),
    deliveryPath: path.join(directory, 'delivery.json'),
    migrationPath: path.join(directory, 'legacy-migration.json'),
    stateLockPath: path.join(directory, '.state.lock'),
    outboxLockPath: path.join(directory, '.outbox.lock'),
    replayLockPath: path.join(directory, '.replay.lock'),
  };
}

function readObject(file: string): JsonObject {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as JsonObject;
  } catch {
    throw new Error('Refusing to replace invalid JSON at ' + file + '. Fix it first.');
  }
}

/** Temp + fsync + rename keeps a killed hook from leaving half a JSON file. */
export function atomicWriteJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
  let descriptor: number | undefined;
  try {
    const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
    descriptor = openSync(temporary, 'wx', mode);
    writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
    try {
      const directory = openSync(path.dirname(file), 'r');
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } catch {
      // Some platforms do not allow fsync on directories; rename is still atomic.
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function staleLock(file: string): boolean {
  try {
    const age = Date.now() - statSync(file).mtimeMs;
    const lock = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number };
    if (typeof lock.pid !== 'number') return age > LOCK_STALE_MS;
    try {
      process.kill(lock.pid, 0);
      return age > LOCK_STALE_MS * 4;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' || age > LOCK_STALE_MS;
    }
  } catch {
    try {
      return Date.now() - statSync(file).mtimeMs > LOCK_STALE_MS;
    } catch {
      return true;
    }
  }
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function acquireFileLock(file: string, waitMs = 750): (() => void) | undefined {
  mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const descriptor = openSync(file, 'wx', 0o600);
      try {
        writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          unlinkSync(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (staleLock(file)) {
        try {
          unlinkSync(file);
          continue;
        } catch {
          // Another process recovered it first.
        }
      }
      if (Date.now() >= deadline) return undefined;
      sleepSync(10);
    }
  }
}

export function withFileLock<T>(file: string, operation: () => T): T {
  const release = acquireFileLock(file);
  if (!release) throw new Error('Local profile is busy: ' + file);
  try {
    return operation();
  } finally {
    release();
  }
}

function handler(
  command: string,
  event: 'start' | 'heartbeat' | 'finish' | 'guard',
  nested: boolean,
  profileId: string,
) {
  const hook = {
    type: 'command',
    command: command + ' adapter hook --event ' + event + ' --profile ' + profileId,
    timeout: event === 'finish' ? 3 : 10,
  };
  return nested ? { hooks: [hook] } : hook;
}

function hookCommands(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(hookCommands);
  const record = value as Record<string, unknown>;
  return [
    ...(typeof record.command === 'string' ? [record.command] : []),
    ...Object.values(record).flatMap(hookCommands),
  ];
}

function isStmaCommand(command: string): boolean {
  return /(?:^|\s)adapter\s+hook\s+--event(?:=|\s+)/.test(command);
}

function ownsProfile(value: unknown, profileId: string): boolean {
  const markerB = '--profile=' + profileId;
  return hookCommands(value).some(
    (command) =>
      isStmaCommand(command) &&
      (command.split(/\s+/).includes(markerB) ||
        command.split(/\s+/).some((part, index, all) => part === '--profile' && all[index + 1] === profileId)),
  );
}

function isLegacyStmaHook(value: unknown): boolean {
  return hookCommands(value).some(
    (command) => isStmaCommand(command) && !/(?:^|\s)--profile(?:=|\s+)/.test(command),
  );
}

function replaceEvent(
  hooks: JsonObject,
  event: string,
  definition: JsonObject,
  profileId: string,
  replaceLegacy: boolean,
): void {
  const existing = Array.isArray(hooks[event])
    ? hooks[event].filter(
        (item: unknown) => !ownsProfile(item, profileId) && !(replaceLegacy && isLegacyStmaHook(item)),
      )
    : [];
  hooks[event] = [...existing, definition];
}

function removeEvent(hooks: JsonObject, event: string, profileId: string, removeLegacy: boolean): void {
  if (!Array.isArray(hooks[event])) return;
  hooks[event] = hooks[event].filter(
    (item: unknown) => !ownsProfile(item, profileId) && !(removeLegacy && isLegacyStmaHook(item)),
  );
}

export function mergeAdapterHooks(
  target: AdapterTarget,
  existing: JsonObject,
  command: string,
  profileValue = 'default',
  options: { replaceLegacy?: boolean; writeGuard?: boolean } = {},
): JsonObject {
  const profileId = normalizeProfileId(profileValue);
  const next = structuredClone(existing);
  const hooks = next.hooks && typeof next.hooks === 'object' ? next.hooks : {};
  next.hooks = hooks;
  const replaceLegacy = options.replaceLegacy === true;

  if (target === 'cursor') {
    next.version ??= 1;
    replaceEvent(hooks, 'beforeSubmitPrompt', handler(command, 'start', false, profileId), profileId, replaceLegacy);
    replaceEvent(
      hooks,
      'postToolUse',
      { ...handler(command, 'heartbeat', false, profileId), matcher: 'Shell|Write|Delete|MCP:.*' },
      profileId,
      replaceLegacy,
    );
    replaceEvent(hooks, 'stop', handler(command, 'finish', false, profileId), profileId, replaceLegacy);
    return next;
  }

  const postMatcher =
    target === 'codex'
      ? 'Bash|apply_patch|Edit|Write|mcp__.*'
      : 'Bash|Edit|Write|NotebookEdit|mcp__.*';
  if (target === 'codex') {
    next.description ??= 'Project lifecycle hooks, including STMA agent coordination.';
  }
  replaceEvent(hooks, 'UserPromptSubmit', handler(command, 'start', true, profileId), profileId, replaceLegacy);
  replaceEvent(
    hooks,
    'PostToolUse',
    { matcher: postMatcher, ...handler(command, 'heartbeat', true, profileId) },
    profileId,
    replaceLegacy,
  );
  replaceEvent(hooks, 'Stop', handler(command, options.writeGuard ? 'heartbeat' : 'finish', true, profileId), profileId, replaceLegacy);
  if (options.writeGuard) {
    replaceEvent(hooks, 'SessionEnd', handler(command, 'finish', true, profileId), profileId, replaceLegacy);
    replaceEvent(hooks, 'PreToolUse', {
      matcher: target === 'codex' ? '^(apply_patch|Edit|Write)$' : '^(Edit|Write|MultiEdit|NotebookEdit)$',
      ...handler(command, 'guard', true, profileId),
    }, profileId, replaceLegacy);
  } else {
    removeEvent(hooks, 'PreToolUse', profileId, replaceLegacy);
    removeEvent(hooks, 'SessionEnd', profileId, replaceLegacy);
  }
  return next;
}

export function removeAdapterHooks(
  target: AdapterTarget,
  existing: JsonObject,
  profileValue: string,
  options: { removeLegacy?: boolean } = {},
): JsonObject {
  const profileId = normalizeProfileId(profileValue);
  const next = structuredClone(existing);
  const hooks = next.hooks && typeof next.hooks === 'object' ? next.hooks : {};
  next.hooks = hooks;
  const events =
    target === 'cursor'
      ? ['beforeSubmitPrompt', 'postToolUse', 'stop']
      : ['UserPromptSubmit', 'PostToolUse', 'Stop', 'PreToolUse', 'SessionEnd'];
  for (const event of events) removeEvent(hooks, event, profileId, options.removeLegacy === true);
  return next;
}

export function installedHookCount(root: string, config: ProfileAdapterConfig): number {
  const current = readObject(targetPath(root, config.target));
  const hooks = current.hooks && typeof current.hooks === 'object' ? current.hooks : {};
  const events =
    config.target === 'cursor'
      ? ['beforeSubmitPrompt', 'postToolUse', 'stop']
      : ['UserPromptSubmit', 'PostToolUse', 'Stop', 'PreToolUse', 'SessionEnd'];
  return events.reduce(
    (total, event) =>
      total +
      (Array.isArray(hooks[event])
        ? hooks[event].filter((item: unknown) => ownsProfile(item, config.profileId)).length
        : 0),
    0,
  );
}

export function targetPath(root: string, target: AdapterTarget): string {
  if (target === 'claude-code') return path.join(root, '.claude', 'settings.local.json');
  if (target === 'codex') return path.join(root, '.codex', 'hooks.json');
  return path.join(root, '.cursor', 'hooks.json');
}

function legacyAdapterPath(root: string): string {
  return path.join(root, '.stma', 'adapter.json');
}

function loadProfileFile(file: string, requestedId?: string): ProfileAdapterConfig {
  const raw = readObject(file) as AdapterConfig;
  const config = resolvedConfig(raw, requestedId);
  if (raw.profileId && normalizeProfileId(raw.profileId) !== config.profileId) {
    throw new Error('Profile id in ' + file + ' does not match its directory.');
  }
  return config;
}

function loadLegacyProfile(root: string): LoadedAdapterProfile | undefined {
  const file = legacyAdapterPath(root);
  if (!existsSync(file)) return undefined;
  const config = resolvedConfig(readObject(file) as AdapterConfig);
  return { id: config.profileId, config, source: 'legacy' };
}

export function adapterProfileIds(root: string): string[] {
  const directory = path.join(root, '.stma', 'profiles');
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((entry) => {
      try {
        return normalizeProfileId(entry) === entry;
      } catch {
        return false;
      }
    })
    .filter((entry) => existsSync(adapterProfilePaths(root, entry).adapterPath))
    .sort();
}

export function loadAdapterProfile(root: string, requestedId?: string): LoadedAdapterProfile | undefined {
  if (requestedId) {
    const id = normalizeProfileId(requestedId);
    const file = adapterProfilePaths(root, id).adapterPath;
    if (!existsSync(file)) return undefined;
    return { id, config: loadProfileFile(file, id), source: 'profile' };
  }
  const legacy = loadLegacyProfile(root);
  if (legacy) return legacy;
  const ids = adapterProfileIds(root);
  if (ids.length !== 1) return undefined;
  const id = ids[0]!;
  return {
    id,
    config: loadProfileFile(adapterProfilePaths(root, id).adapterPath, id),
    source: 'unique-profile',
  };
}

/** Compatibility wrapper retained for callers that only need the config. */
export function loadAdapterConfig(root: string, requestedId?: string): ProfileAdapterConfig | undefined {
  return loadAdapterProfile(root, requestedId)?.config;
}

export function installAdapter(options: AdapterInstallOptions): {
  hookPath: string;
  previousHookPath?: string;
  adapterPath: string;
  profileId: string;
  hooks: JsonObject;
} {
  const config = resolvedConfig(options.config);
  if (config.writeGuard && config.target === 'cursor') throw new Error('The synchronous file guard is currently supported only for Claude Code and Codex. Cursor lifecycle tracking is not enforcement.');
  // Client project hooks have no per-profile/session matcher. Installing both
  // would fire both identities for every event, not route between agents.
  const competing = adapterProfileIds(options.root).filter((id) => id !== config.profileId && loadAdapterProfile(options.root, id)?.config.target === config.target);
  if (competing.length) throw new Error('This checkout already has a ' + config.target + ' profile. Use its existing connection or a separate worktree; two profiles would misattribute every hook event.');
  const paths = adapterProfilePaths(options.root, config.profileId);
  const hookPath = targetPath(options.root, config.target);
  const existingProfile = existsSync(paths.adapterPath)
    ? loadProfileFile(paths.adapterPath, config.profileId)
    : undefined;
  if (existingProfile && JSON.stringify(existingProfile) !== JSON.stringify(config) && !options.replace) {
    throw new Error('Profile ' + config.profileId + ' already exists. Pass --replace to change it.');
  }
  const legacy = loadLegacyProfile(options.root);
  const replaceLegacy = legacy?.id === config.profileId && legacy.config.target === config.target;
  const hooks = mergeAdapterHooks(
    config.target,
    readObject(hookPath),
    options.command.trim() || 'stma',
    config.profileId,
    { replaceLegacy, writeGuard: config.writeGuard },
  );

  let previousHookPath: string | undefined;
  if (options.apply) {
    atomicWriteJson(paths.adapterPath, config);
    if (existingProfile && existingProfile.target !== config.target) {
      previousHookPath = targetPath(options.root, existingProfile.target);
      atomicWriteJson(
        previousHookPath,
        removeAdapterHooks(existingProfile.target, readObject(previousHookPath), config.profileId),
      );
    }
    atomicWriteJson(hookPath, hooks);
  }
  return { hookPath, previousHookPath, adapterPath: paths.adapterPath, profileId: config.profileId, hooks };
}

function removeKnownFile(file: string): void {
  try {
    unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function removeEmptyDirectory(directory: string): void {
  try {
    rmdirSync(directory);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
}

function eventFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

export function uninstallAdapter(options: { root: string; profileId: string; apply: boolean }): {
  hookPath: string;
  adapterPath: string;
  hooks: JsonObject;
  pendingEvents: number;
  corruptEvents: string[];
  preservedFiles: string[];
} {
  const id = normalizeProfileId(options.profileId);
  const legacy = loadLegacyProfile(options.root);
  const loaded =
    loadAdapterProfile(options.root, id) ?? (legacy?.id === id ? legacy : undefined);
  if (!loaded) throw new Error('Unknown adapter profile: ' + id);
  const ownsLegacy = legacy?.id === id && legacy.config.target === loaded.config.target;
  const paths = adapterProfilePaths(options.root, id);
  const hookPath = targetPath(options.root, loaded.config.target);
  const hooks = removeAdapterHooks(loaded.config.target, readObject(hookPath), id, {
    removeLegacy: ownsLegacy,
  });
  const delivery = adapterDeliveryStatus(options.root, id);
  if (options.apply) {
    atomicWriteJson(hookPath, hooks);
    for (const file of eventFiles(paths.outboxDirectory)) removeKnownFile(file);
    const quarantine = path.join(paths.outboxDirectory, 'quarantine');
    if (existsSync(quarantine)) {
      for (const entry of readdirSync(quarantine, { withFileTypes: true })) {
        if (entry.isFile()) removeKnownFile(path.join(quarantine, entry.name));
      }
      removeEmptyDirectory(quarantine);
    }
    removeEmptyDirectory(paths.outboxDirectory);
    for (const file of [
      paths.adapterPath,
      paths.statePath,
      paths.deliveryPath,
      paths.migrationPath,
      paths.stateLockPath,
      paths.outboxLockPath,
      paths.replayLockPath,
    ]) {
      removeKnownFile(file);
    }
    if (ownsLegacy) {
      const legacyPath = legacyAdapterPath(options.root);
      let archive = path.join(options.root, '.stma', 'adapter.disconnected.json');
      if (existsSync(archive)) archive = path.join(options.root, '.stma', 'adapter.disconnected-' + Date.now() + '.json');
      renameSync(legacyPath, archive);
    }
    removeEmptyDirectory(paths.directory);
    removeEmptyDirectory(path.dirname(paths.directory));
  }
  const preservedFiles = existsSync(paths.directory) ? readdirSync(paths.directory).sort() : [];
  return {
    hookPath,
    adapterPath: paths.adapterPath,
    hooks,
    pendingEvents: delivery.pendingEvents,
    corruptEvents: delivery.corruptEvents,
    preservedFiles,
  };
}

function validEvent(value: unknown): value is QueuedHookEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    ['start', 'heartbeat', 'finish'].includes(String(item.event)) &&
    typeof item.queuedAt === 'string' &&
    Boolean(item.payload) &&
    typeof item.payload === 'object' &&
    !Array.isArray(item.payload)
  );
}

export function readQueuedHookEvents(root: string, profileValue: string): {
  events: Array<{ file: string; event: QueuedHookEvent }>;
  corruptEvents: string[];
} {
  const directory = adapterProfilePaths(root, profileValue).outboxDirectory;
  const events: Array<{ file: string; event: QueuedHookEvent }> = [];
  const corruptEvents: string[] = [];
  for (const file of eventFiles(directory)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (!validEvent(parsed)) throw new Error('invalid event');
      events.push({ file, event: parsed });
    } catch {
      corruptEvents.push(path.basename(file));
    }
  }
  const order = { start: 0, heartbeat: 1, finish: 2 } as const;
  events.sort(
    (left, right) =>
      Date.parse(left.event.queuedAt) - Date.parse(right.event.queuedAt) ||
      order[left.event.event] - order[right.event.event] ||
      left.event.id.localeCompare(right.event.id),
  );
  return { events, corruptEvents };
}

export function updateQueuedHookEvent(
  root: string,
  profileValue: string,
  file: string,
  event: QueuedHookEvent,
): void {
  const paths = adapterProfilePaths(root, profileValue);
  withFileLock(paths.outboxLockPath, () => {
    const resolved = path.resolve(file);
    if (path.dirname(resolved) !== path.resolve(paths.outboxDirectory)) {
      throw new Error('Refusing to update an outbox event outside this profile.');
    }
    if (!existsSync(resolved)) throw new Error('Queued hook event disappeared before it was sent.');
    atomicWriteJson(resolved, event);
  });
}

function emptyDelivery(): DeliveryRecord {
  return { schemaVersion: 1, droppedEvents: 0 };
}

function readDelivery(file: string): DeliveryRecord {
  if (!existsSync(file)) return emptyDelivery();
  const value = readObject(file) as Partial<DeliveryRecord>;
  if (value.schemaVersion !== 1 || !Number.isInteger(value.droppedEvents) || value.droppedEvents! < 0) {
    throw new Error('Invalid delivery status at ' + file + '. Run stma adapter repair.');
  }
  return value as DeliveryRecord;
}

function updateDelivery(paths: AdapterProfilePaths, update: (current: DeliveryRecord) => DeliveryRecord): void {
  atomicWriteJson(paths.deliveryPath, update(readDelivery(paths.deliveryPath)));
}

function eventFileName(event: QueuedHookEvent): string {
  if (!/^[a-f0-9-]{16,64}$/i.test(event.id)) throw new Error('Invalid hook event id: ' + event.id);
  const parsed = Date.parse(event.queuedAt);
  const stamp = Number.isFinite(parsed) ? parsed : Date.now();
  return String(stamp).padStart(13, '0') + '-' + event.id + '.json';
}

export function enqueueHookEvent(
  root: string,
  profileValue: string,
  event: QueuedHookEvent,
  limit = MAX_OUTBOX_EVENTS,
): { queued: boolean; pendingEvents: number; droppedEvents: number } {
  const paths = adapterProfilePaths(root, profileValue);
  return withFileLock(paths.outboxLockPath, () => {
    mkdirSync(paths.outboxDirectory, { recursive: true });
    const scanned = readQueuedHookEvents(root, profileValue);
    const file = path.join(paths.outboxDirectory, eventFileName(event));
    if (existsSync(file)) {
      const delivery = readDelivery(paths.deliveryPath);
      return { queued: true, pendingEvents: scanned.events.length, droppedEvents: delivery.droppedEvents };
    }
    if (scanned.events.length + scanned.corruptEvents.length >= limit) {
      const now = new Date().toISOString();
      let droppedEvents = 0;
      updateDelivery(paths, (current) => {
        droppedEvents = current.droppedEvents + 1;
        return {
          ...current,
          droppedEvents,
          lastOverflowAt: now,
          lastFailedAt: now,
          lastError: 'Outbox capacity ' + limit + ' reached; event ' + event.id + ' was not queued.',
          lastEventId: event.id,
        };
      });
      return { queued: false, pendingEvents: scanned.events.length, droppedEvents };
    }
    atomicWriteJson(file, event);
    updateDelivery(paths, (current) => ({
      ...current,
      lastEnqueuedAt: event.queuedAt,
      lastEventId: event.id,
      ...(scanned.corruptEvents.length
        ? { lastError: scanned.corruptEvents.length + ' corrupt outbox event(s) need repair.' }
        : {}),
    }));
    return {
      queued: true,
      pendingEvents: scanned.events.length + 1,
      droppedEvents: readDelivery(paths.deliveryPath).droppedEvents,
    };
  });
}

export function markHookEventDelivered(
  root: string,
  profileValue: string,
  file: string,
  eventId: string,
): void {
  const paths = adapterProfilePaths(root, profileValue);
  withFileLock(paths.outboxLockPath, () => {
    const resolved = path.resolve(file);
    if (path.dirname(resolved) !== path.resolve(paths.outboxDirectory)) {
      throw new Error('Refusing to remove an outbox event outside this profile.');
    }
    removeKnownFile(resolved);
    updateDelivery(paths, (current) => ({
      ...current,
      lastDeliveredAt: new Date().toISOString(),
      lastError: undefined,
      lastEventId: eventId,
    }));
  });
}

export function discardHookEvent(
  root: string,
  profileValue: string,
  file: string,
  eventId: string,
  message: string,
): void {
  const paths = adapterProfilePaths(root, profileValue);
  withFileLock(paths.outboxLockPath, () => {
    const resolved = path.resolve(file);
    if (path.dirname(resolved) !== path.resolve(paths.outboxDirectory)) {
      throw new Error('Refusing to discard an outbox event outside this profile.');
    }
    removeKnownFile(resolved);
    updateDelivery(paths, (current) => ({
      ...current,
      droppedEvents: current.droppedEvents + 1,
      lastFailedAt: new Date().toISOString(),
      lastError: message.slice(0, 500),
      lastEventId: eventId,
    }));
  });
}

export function markHookEventFailed(
  root: string,
  profileValue: string,
  eventId: string,
  message: string,
): void {
  const paths = adapterProfilePaths(root, profileValue);
  withFileLock(paths.outboxLockPath, () => {
    updateDelivery(paths, (current) => ({
      ...current,
      lastFailedAt: new Date().toISOString(),
      lastError: message.slice(0, 500),
      lastEventId: eventId,
    }));
  });
}

export function adapterDeliveryStatus(root: string, profileValue: string): AdapterDeliveryStatus {
  const paths = adapterProfilePaths(root, profileValue);
  const scanned = readQueuedHookEvents(root, profileValue);
  try {
    return {
      ...readDelivery(paths.deliveryPath),
      pendingEvents: scanned.events.length,
      corruptEvents: scanned.corruptEvents,
      statusCorrupt: false,
    };
  } catch {
    return {
      ...emptyDelivery(),
      pendingEvents: scanned.events.length,
      corruptEvents: scanned.corruptEvents,
      statusCorrupt: true,
      lastError: 'Delivery status is corrupt: ' + paths.deliveryPath,
    };
  }
}

export function acquireProfileReplayLock(root: string, profileValue: string): (() => void) | undefined {
  return acquireFileLock(adapterProfilePaths(root, profileValue).replayLockPath, 0);
}

function deterministicUuid(value: string): string {
  const hash = sha256(value);
  return (
    hash.slice(0, 8) +
    '-' +
    hash.slice(8, 12) +
    '-4' +
    hash.slice(13, 16) +
    '-a' +
    hash.slice(17, 20) +
    '-' +
    hash.slice(20, 32)
  );
}

/** Copy legacy files into a profile without deleting or rewriting their source. */
export function migrateLegacyProfile(root: string): {
  migrated: boolean;
  profile?: LoadedAdapterProfile;
  importedEvents: number;
  warnings: string[];
} {
  const legacy = loadLegacyProfile(root);
  if (!legacy) return { migrated: false, importedEvents: 0, warnings: [] };
  const paths = adapterProfilePaths(root, legacy.id);
  if (existsSync(paths.migrationPath)) {
    return {
      migrated: false,
      profile: loadAdapterProfile(root, legacy.id) ?? legacy,
      importedEvents: 0,
      warnings: [],
    };
  }
  const warnings: string[] = [];
  let importedEvents = 0;
  if (!existsSync(paths.adapterPath)) atomicWriteJson(paths.adapterPath, legacy.config);

  const legacyState = path.join(root, '.stma', 'local.json');
  if (!existsSync(paths.statePath) && existsSync(legacyState)) {
    try {
      atomicWriteJson(paths.statePath, readObject(legacyState));
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }

  const legacyOutbox = path.join(root, '.stma', 'outbox.json');
  if (existsSync(legacyOutbox)) {
    try {
      const raw = JSON.parse(readFileSync(legacyOutbox, 'utf8')) as unknown;
      if (!Array.isArray(raw)) throw new Error('Legacy outbox is not an array.');
      for (let index = 0; index < raw.length; index++) {
        const candidate = raw[index] as Partial<QueuedHookEvent>;
        const event: QueuedHookEvent = {
          id:
            typeof candidate.id === 'string' && /^[a-f0-9-]{16,64}$/i.test(candidate.id)
              ? candidate.id
              : deterministicUuid(JSON.stringify(candidate)),
          event: ['start', 'heartbeat', 'finish'].includes(String(candidate.event))
            ? (candidate.event as QueuedHookEvent['event'])
            : 'heartbeat',
          payload:
            candidate.payload && typeof candidate.payload === 'object' && !Array.isArray(candidate.payload)
              ? (candidate.payload as Record<string, unknown>)
              : {},
          queuedAt:
            typeof candidate.queuedAt === 'string' && Number.isFinite(Date.parse(candidate.queuedAt))
              ? candidate.queuedAt
              : new Date(index).toISOString(),
        };
        if (enqueueHookEvent(root, legacy.id, event).queued) importedEvents++;
      }
    } catch (error) {
      warnings.push(
        'Legacy outbox was preserved but not imported: ' +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  atomicWriteJson(paths.migrationPath, {
    schemaVersion: 1,
    migratedAt: new Date().toISOString(),
    sourceAdapter: legacyAdapterPath(root),
    sourceState: legacyState,
    sourceOutbox: legacyOutbox,
    importedEvents,
    warnings,
  });
  return {
    migrated: true,
    profile: loadAdapterProfile(root, legacy.id) ?? legacy,
    importedEvents,
    warnings,
  };
}

export function repairProfileOutbox(root: string, profileValue: string): {
  quarantinedEvents: string[];
  statusQuarantined: boolean;
} {
  const id = normalizeProfileId(profileValue);
  const paths = adapterProfilePaths(root, id);
  return withFileLock(paths.outboxLockPath, () => {
    let statusQuarantined = false;
    try {
      readDelivery(paths.deliveryPath);
    } catch {
      const quarantine = paths.deliveryPath + '.corrupt-' + Date.now();
      renameSync(paths.deliveryPath, quarantine);
      atomicWriteJson(paths.deliveryPath, {
        ...emptyDelivery(),
        lastError: 'Corrupt delivery status preserved at ' + quarantine + '.',
      });
      statusQuarantined = true;
    }
    const { corruptEvents } = readQueuedHookEvents(root, id);
    if (!corruptEvents.length) return { quarantinedEvents: [], statusQuarantined };
    const quarantine = path.join(paths.outboxDirectory, 'quarantine');
    mkdirSync(quarantine, { recursive: true });
    for (const entry of corruptEvents) {
      renameSync(path.join(paths.outboxDirectory, entry), path.join(quarantine, entry));
    }
    updateDelivery(paths, (current) => ({
      ...current,
      lastError:
        corruptEvents.length + ' corrupt event(s) quarantined; inspect ' + quarantine + '.',
    }));
    return { quarantinedEvents: corruptEvents, statusQuarantined };
  });
}
