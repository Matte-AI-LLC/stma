import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const ADAPTER_TARGETS = ['claude-code', 'codex', 'cursor'] as const;
export type AdapterTarget = (typeof ADAPTER_TARGETS)[number];

export interface AdapterConfig {
  schemaVersion: 1;
  target: AdapterTarget;
  team: string;
  project?: string;
  agentName: string;
  defaultTask?: string;
  defaultIntent?: string;
  applyPolicy: boolean;
  preflight: boolean;
}

export interface AdapterInstallOptions {
  root: string;
  config: AdapterConfig;
  command: string;
  apply: boolean;
}

type JsonObject = Record<string, any>;

function readJson(file: string): JsonObject {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  } catch {
    throw new Error(`Refusing to replace invalid JSON at ${file}. Fix it first.`);
  }
}

function handler(command: string, event: 'start' | 'heartbeat' | 'finish', nested: boolean) {
  const hook = {
    type: 'command',
    command: `${command} adapter hook --event ${event}`,
    timeout: event === 'finish' ? 3 : 10,
  };
  return nested ? { hooks: [hook] } : hook;
}

function isStmaHook(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === 'object' &&
      JSON.stringify(value).includes('adapter hook --event'),
  );
}

function replaceEvent(hooks: JsonObject, event: string, definition: JsonObject): void {
  const existing = Array.isArray(hooks[event]) ? hooks[event].filter((item: unknown) => !isStmaHook(item)) : [];
  hooks[event] = [...existing, definition];
}

export function mergeAdapterHooks(
  target: AdapterTarget,
  existing: JsonObject,
  command: string,
): JsonObject {
  const next = structuredClone(existing);
  const hooks = next.hooks && typeof next.hooks === 'object' ? next.hooks : {};
  next.hooks = hooks;

  if (target === 'cursor') {
    next.version ??= 1;
    replaceEvent(hooks, 'beforeSubmitPrompt', handler(command, 'start', false));
    replaceEvent(hooks, 'postToolUse', {
      ...handler(command, 'heartbeat', false),
      matcher: 'Shell|Write|Delete|MCP:.*',
    });
    replaceEvent(hooks, 'stop', handler(command, 'finish', false));
    return next;
  }

  if (target === 'codex') {
    next.description ??= 'Project lifecycle hooks, including STMA agent coordination.';
    replaceEvent(hooks, 'UserPromptSubmit', handler(command, 'start', true));
    replaceEvent(hooks, 'PostToolUse', {
      matcher: 'Bash|apply_patch|Edit|Write|mcp__.*',
      ...handler(command, 'heartbeat', true),
    });
    replaceEvent(hooks, 'Stop', handler(command, 'finish', true));
    return next;
  }

  replaceEvent(hooks, 'UserPromptSubmit', handler(command, 'start', true));
  replaceEvent(hooks, 'PostToolUse', {
    matcher: 'Bash|Edit|Write|NotebookEdit|mcp__.*',
    ...handler(command, 'heartbeat', true),
  });
  replaceEvent(hooks, 'Stop', handler(command, 'finish', true));
  return next;
}

function targetPath(root: string, target: AdapterTarget): string {
  if (target === 'claude-code') return path.join(root, '.claude', 'settings.local.json');
  if (target === 'codex') return path.join(root, '.codex', 'hooks.json');
  return path.join(root, '.cursor', 'hooks.json');
}

export function installAdapter(options: AdapterInstallOptions): {
  hookPath: string;
  adapterPath: string;
  hooks: JsonObject;
} {
  const hookPath = targetPath(options.root, options.config.target);
  const adapterPath = path.join(options.root, '.stma', 'adapter.json');
  const hooks = mergeAdapterHooks(
    options.config.target,
    readJson(hookPath),
    options.command.trim() || 'stma',
  );

  if (options.apply) {
    mkdirSync(path.dirname(hookPath), { recursive: true });
    mkdirSync(path.dirname(adapterPath), { recursive: true });
    writeFileSync(hookPath, `${JSON.stringify(hooks, null, 2)}\n`, 'utf8');
    writeFileSync(adapterPath, `${JSON.stringify(options.config, null, 2)}\n`, 'utf8');
  }

  return { hookPath, adapterPath, hooks };
}

export function loadAdapterConfig(root: string): AdapterConfig | undefined {
  const file = path.join(root, '.stma', 'adapter.json');
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as AdapterConfig;
}
