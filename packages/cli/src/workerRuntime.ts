import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { EXECUTION_CHILD_TOOLS } from '@bridge/shared';

export const WORKER_MCP_ALIAS = 'stma_worker';
export const WORKER_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep'] as const;
export interface RuntimeLaunch {
  executable: string; cwd: string; sessionId: string; configDirectory: string;
  settingsFile: string; mcpFile: string; hookContext: string; apiKey: string;
  maxTurns: number; prompt: string;
}
export type RuntimeObservation =
  | { type: 'started'; sessionId: string; cwd: string; mcpReady: boolean }
  | { type: 'result'; success: boolean; denied: boolean; auth: boolean; quota: boolean }
  | { type: 'invalid' };
export function nativeWorkerExecutable(value: string, platform = process.platform): string {
  if (!path.isAbsolute(value)) throw new Error('Use an absolute native Claude executable path.');
  const resolved = realpathSync.native(value);
  if (!lstatSync(resolved).isFile() || (platform === 'win32' && path.extname(resolved).toLowerCase() !== '.exe') || /\.(?:cmd|bat|ps1)$/i.test(resolved)) throw new Error('Shell wrappers are not supported by the worker. Select the native Claude executable.');
  return resolved;
}
export function inspectWorkerRuntime(executable: string): string {
  const result = spawnSync(nativeWorkerExecutable(executable), ['--version'], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 10_000, maxBuffer: 16_000 });
  const version = /^(2\.1\.(\d+)) \(Claude Code\)/.exec(result.stdout?.trim() ?? '');
  if (result.error || result.status !== 0 || !version || Number(version[2]) < 278) throw new Error('Claude Code 2.1.278 or newer in the 2.1 release series is required; this combination still requires acceptance testing.');
  return version[1]!;
}
/** The caller's general environment and provider selectors are never spread into the child. */
export function workerChildEnvironment(launch: RuntimeLaunch, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL']) {
    const found = Object.keys(source).find((name) => name.toLowerCase() === key.toLowerCase());
    if (found && source[found]) result[key] = source[found];
  }
  Object.assign(result, {
    CLAUDE_CONFIG_DIR: launch.configDirectory, ANTHROPIC_API_KEY: launch.apiKey,
    STMA_WORKER_CONTEXT: launch.hookContext, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
  });
  // Native hooks use `node` for portability across Claude's Windows hook shells.
  // Resolve it to this runtime first; never search a relative PATH entry in the checkout.
  result.PATH = [path.dirname(process.execPath), ...(result.PATH ?? '').split(path.delimiter).filter((entry) => path.isAbsolute(entry))].join(path.delimiter);
  return result;
}
export function verifyWorkerApiAuth(launch: RuntimeLaunch, run: typeof spawnSync = spawnSync): void {
  const result = run(nativeWorkerExecutable(launch.executable), ['--restricted', '--setting-sources', '', '--settings', launch.settingsFile, 'auth', 'status'], {
    cwd: launch.cwd, env: workerChildEnvironment(launch), shell: false, windowsHide: true, encoding: 'utf8', timeout: 10_000, maxBuffer: 32_000,
  });
  let status: { authMethod?: unknown; configDirectory?: unknown } | undefined;
  try { status = JSON.parse(String(result.stdout ?? '')); } catch { /* No raw credential/status output in diagnostics. */ }
  // These two fields are documented CLI output; third_party, OAuth, helpers and unknown schemas fail closed.
  if (result.error || result.status !== 0 || status?.authMethod !== 'api_key' || typeof status.configDirectory !== 'string' || realpathSync.native(status.configDirectory) !== realpathSync.native(launch.configDirectory)) throw new Error('Explicit isolated API authentication was not verified; worker remains stopped.');
}
export function workerRuntimeArguments(launch: RuntimeLaunch): string[] {
  if (!/^[a-f0-9-]{36}$/i.test(launch.sessionId) || !Number.isInteger(launch.maxTurns) || launch.maxTurns < 1 || launch.maxTurns > 100) throw new Error('Invalid runtime limits or session identity.');
  return ['--print', '--verbose', '--output-format', 'stream-json', '--session-id', launch.sessionId,
    '--restricted', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--setting-sources', '', '--settings', launch.settingsFile, '--strict-mcp-config', '--mcp-config', launch.mcpFile,
    '--tools', WORKER_TOOLS.join(','), '--allowedTools', [...WORKER_TOOLS, ...EXECUTION_CHILD_TOOLS.map((tool) => `mcp__${WORKER_MCP_ALIAS}__${tool}`)].join(','),
    '--disable-slash-commands', '--no-chrome', '--no-session-persistence', '--max-turns', String(launch.maxTurns)];
}
export function parseWorkerRuntimeLine(line: string): RuntimeObservation | undefined {
  if (line.length > 1_000_000) return { type: 'invalid' };
  let message: any;
  try { message = JSON.parse(line); } catch { return { type: 'invalid' }; }
  if (message?.type === 'system' && message.subtype === 'init') {
    return { type: 'started', sessionId: message.session_id, cwd: message.cwd,
      mcpReady: Array.isArray(message.mcp_servers) && message.mcp_servers.length === 1 && message.mcp_servers[0]?.name === WORKER_MCP_ALIAS && message.mcp_servers[0]?.status === 'connected' };
  }
  if (message?.type === 'result') {
    const errors = JSON.stringify(message.errors ?? []).slice(0, 20_000);
    return { type: 'result', success: message.subtype === 'success' && message.is_error !== true,
      denied: Array.isArray(message.permission_denials) && message.permission_denials.length > 0,
      auth: /authentication|not logged in|invalid.{0,15}(?:api.?key|credential)|401/i.test(errors),
      quota: /rate.limit|quota|429|credit balance/i.test(errors) };
  }
  return undefined;
}
export interface WorkerRuntimeHandle { pid?: number; completion: Promise<{ code: number | null; signal: string | null }>; stop(): void; }
export function launchWorkerRuntime(launch: RuntimeLaunch, observe: (event: RuntimeObservation) => void, spawnChild: typeof spawn = spawn): WorkerRuntimeHandle {
  const child = spawnChild(nativeWorkerExecutable(launch.executable), workerRuntimeArguments(launch), {
    cwd: launch.cwd, env: workerChildEnvironment(launch), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  let buffer = ''; let closed = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 2_000_000) { buffer = ''; observe({ type: 'invalid' }); return; }
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (line.trim()) { const event = parseWorkerRuntimeLine(line); if (event) observe(event); }
    }
  });
  // Runtime output may contain source, prompts or secrets. Never persist or forward it.
  child.stderr.resume(); child.stdin.on('error', () => { /* completion handles failed spawn / closed input */ });
  const completion = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once('error', () => { closed = true; resolve({ code: null, signal: 'spawn_error' }); });
    child.once('close', (code, signal) => { closed = true; if (buffer.trim()) { const event = parseWorkerRuntimeLine(buffer); if (event) observe(event); } resolve({ code, signal }); });
  });
  child.stdin.end(launch.prompt);
  return { pid: child.pid, completion, stop: () => { if (!closed) child.kill(); } };
}
