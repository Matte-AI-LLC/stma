import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EXECUTION_READONLY_TOOLS } from '@bridge/shared';
import { nativeWorkerExecutable, type WorkerRuntimeHandle } from './workerRuntime.js';
import { windowsJobCommand, windowsJobFrame } from './windowsWorkerJob.js';

export interface CodexLaunch {
  executable: string;
  model: string;
  checkout: string;
  codexHome: string;
  workerDirectory: string;
  server: string;
  token: string;
  apiKey: string;
  prompt: string;
}
export type CodexObservation =
  | { type: 'started'; threadId: string }
  | { type: 'result'; success: boolean; text: string; auth: boolean; quota: boolean }
  | { type: 'invalid' };
export function inspectCodexWorker(executable: string): string {
  assertCodexWorkerBundle(executable);
  const result = spawnSync(nativeWorkerExecutable(executable), ['--version'], {
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 16_000,
  });
  const version = /^codex-cli (0\.166\.0)$/.exec(result.stdout?.trim() ?? '');
  if (result.error || result.status !== 0 || !version)
    throw new Error('The read-only worker requires the reviewed Codex CLI 0.166.0.');
  return version[1]!;
}
/** A lone pinned exe can otherwise resolve incompatible sandbox helpers from PATH. */
export function assertCodexWorkerBundle(executable: string): void {
  const resolved = nativeWorkerExecutable(executable);
  const root = path.dirname(path.dirname(resolved));
  const manifest = path.join(root, 'codex-package.json');
  try {
    const stat = lstatSync(manifest);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) throw new Error();
    const metadata = JSON.parse(readFileSync(manifest, 'utf8'));
    if (metadata.layoutVersion !== 1 || metadata.version !== '0.166.0' || metadata.variant !== 'codex' ||
      metadata.entrypoint !== 'bin/codex.exe' || metadata.resourcesDir !== 'codex-resources' ||
      !['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc'].includes(metadata.target) ||
      path.relative(root, resolved).replaceAll('\\', '/') !== 'bin/codex.exe') throw new Error();
    for (const name of ['codex-windows-sandbox-setup.exe', 'codex-command-runner.exe']) {
      const helper = path.join(root, 'codex-resources', name); const entry = lstatSync(helper);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || realpathSync.native(helper) !== helper) throw new Error();
    }
  } catch {
    throw new Error('Codex worker requires the complete official 0.166.0 native package with its manifest and adjacent sandbox helpers; a standalone exe or PATH fallback is not supported.');
  }
}
const toml = (value: string) => JSON.stringify(value);
/** The Windows crypto runtime needs this OS path even when shell inheritance is disabled. */
export function codexWindowsShellEnvironment(source: NodeJS.ProcessEnv = process.env): { SystemRoot: string } {
  const entries = Object.entries(source).filter(([name]) => name.toLowerCase() === 'systemroot');
  const root = entries.length === 1 ? entries[0]![1] : undefined;
  if (!root || root.length > 260 || !/^[A-Za-z]:[\\/]/.test(root) ||
    /[\x00-\x1f<>"|?*:]/.test(root.slice(2)) || /(?:^|[\\/])\.{1,2}(?:[\\/]|$)/.test(root) || /[ .](?:[\\/]|$)/.test(root))
    throw new Error('Windows Codex worker requires one absolute local SystemRoot path.');
  return { SystemRoot: path.win32.normalize(root) };
}
export function codexWorkerModel(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value))
    throw new Error('Codex read-only requires an explicit model id with --model; configure a new dedicated checkout if it is missing.');
  return value;
}
/** Provisioning rotates machine-wide sandbox accounts; another home may rely on them. */
export function codexSandboxSetupDiagnostic(executable: string, home = os.homedir(), configuredHome = process.env.CODEX_HOME) {
  const workerHome = path.join(home, '.stma-codex-worker');
  const canonical = (directory: string) => existsSync(directory) ? realpathSync.native(directory) : path.resolve(directory);
  const own = canonical(workerHome).toLowerCase();
  const otherHomes = [path.join(home, '.codex'), ...(configuredHome ? [configuredHome] : [])].filter(directory => canonical(directory).toLowerCase() !== own);
  if (otherHomes.some(directory => existsSync(path.join(directory, '.sandbox', 'setup_marker.json')) || existsSync(path.join(directory, '.sandbox-secrets', 'sandbox_users.json')))) {
    return { blocked: true, reason: 'another_codex_sandbox_home_detected', note: 'Do not provision another Codex home on this Windows host: setup rotates machine-wide sandbox account passwords and can invalidate the existing home. Use a dedicated Windows host or VM with independent local accounts. STMA does not run setup.' };
  }
  return { blocked: false, executable, args: ['sandbox', 'setup', '--elevated', '--current-user', '--codex-home', workerHome], note: 'Run separately with the required administrator setup on a dedicated Windows host or VM. Setup rotates machine-wide sandbox accounts; other Codex homes may not be known to this check. STMA never runs setup automatically. Every attempt checks the sandbox before launch.' };
}
/** Named profile deliberately permits general reads outside protected paths; it is not host isolation. */
export function codexSecurityArgs(launch: CodexLaunch): string[] {
  const home = os.homedir();
  // These are known credential stores, not a claim that every host secret is covered.
  const explicitPaths = [
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
    'AZURE_CONFIG_DIR',
    'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_CONFIG_FILE',
    'GOOGLE_APPLICATION_CREDENTIALS',
  ].flatMap((name) => (process.env[name] ? [process.env[name]!] : []));
  const kubePaths = (process.env.KUBECONFIG ?? '').split(path.delimiter).filter(Boolean);
  const configuredPaths = [...explicitPaths, ...kubePaths].flatMap((value) =>
    value === '~'
      ? [value, home]
      : /^~[\\/]/.test(value)
        ? [value, path.join(home, value.slice(2))]
        : [value],
  );
  const protectedPaths = [
    path.join(home, '.stma'),
    path.join(home, '.codex'),
    path.join(home, '.claude'),
    path.join(home, '.claude.json'),
    path.join(home, '.cursor'),
    path.join(home, '.ssh'),
    path.join(home, '.aws'),
    path.join(home, '.azure'),
    path.join(home, '.kube'),
    path.join(home, '.config', 'gcloud'),
    path.join(home, '.config', 'gh'),
    path.join(launch.checkout, '.stma'),
    launch.workerDirectory,
    ...configuredPaths,
  ];
  const resolved = [
    ...new Set(
      protectedPaths.flatMap((entry) => {
        const absolute = path.resolve(entry);
        return existsSync(absolute) ? [absolute, realpathSync.native(absolute)] : [absolute];
      }),
    ),
  ];
  if (
    resolved.some((entry) => {
      const relative = path.relative(entry, path.resolve(launch.codexHome));
      return !relative || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    })
  )
    throw new Error('The isolated Codex home overlaps a protected credential path.');
  const entries = resolved.map((entry) => `${toml(entry)}="deny"`);
  return [
    '-c',
    'default_permissions="stma"',
    '-c',
    `permissions.stma.filesystem={":root"="read",${entries.join(',')}}`,
    '-c',
    'windows.sandbox="elevated"',
    '-c',
    'features.prefer_mxc=false',
    '-c',
    'permissions.stma.network.enabled=false',
    '-c',
    'approval_policy="never"',
    '-c',
    'shell_environment_policy.inherit="none"',
    ...(process.platform === 'win32' ? ['-c', `shell_environment_policy.set={SystemRoot=${toml(codexWindowsShellEnvironment().SystemRoot)}}`] : []),
    '-c',
    'shell_environment_policy.exclude=["CODEX_API_KEY","STMA_WORKER_CHILD_TOKEN"]',
    '-c',
    'web_search="disabled"',
  ];
}
export function codexEnvironment(
  launch: CodexLaunch,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'PATH',
    'PATHEXT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'LANG',
    'LC_ALL',
  ]) {
    const name = Object.keys(source).find((item) => item.toLowerCase() === key.toLowerCase());
    if (name && source[name]) env[key] = source[name];
  }
  env.CODEX_HOME = launch.codexHome;
  env.CODEX_API_KEY = launch.apiKey;
  env.STMA_WORKER_CHILD_TOKEN = launch.token;
  env.PATH = (env.PATH ?? '')
    .split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry))
    .join(path.delimiter);
  // Missing PSModulePath triggers host-specific defaults in Windows PowerShell.
  // Never inherit user modules or a PowerShell 7 module search path.
  if (process.platform === 'win32') {
    env.SystemRoot = codexWindowsShellEnvironment(source).SystemRoot;
    env.PSModulePath = path.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  }
  return env;
}
export function codexExecArgs(launch: CodexLaunch): string[] {
  const mcp = `mcp_servers={stma_worker={url=${toml(launch.server + '/mcp')},bearer_token_env_var="STMA_WORKER_CHILD_TOKEN",required=true,enabled_tools=[${EXECUTION_READONLY_TOOLS.map(toml).join(',')}]}}`;
  return [
    'exec',
    '--model',
    codexWorkerModel(launch.model),
    ...codexSecurityArgs(launch),
    '-c',
    'service_tier="default"',
    '-c',
    mcp,
    '--strict-config',
    '--ignore-user-config',
    '--ephemeral',
    '--json',
    '--color',
    'never',
    '-',
  ];
}
/** Preflight and exec must not see different local configuration or hook layers. */
export function assertCodexConfigIsolation(launch: CodexLaunch): void {
  for (const file of [
    path.join(launch.codexHome, 'config.toml'),
    path.join(launch.codexHome, 'hooks.json'),
    path.join(launch.checkout, '.codex'),
  ]) {
    try {
      lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    throw new Error(
      'Codex worker refuses local config or hook layers; use an isolated home and dedicated checkout without .codex.',
    );
  }
}
export type CodexSandboxProbeName = 'mcp_list' | 'host_read' | 'host_write' | 'sandbox_control' | 'sandbox_readable_control' | 'sandbox_denied_read' | 'sandbox_denied_write';
export type CodexSandboxNativeDiagnostic = 'os_error_5' | 'os_error_1314' | 'os_error_1326' | 'os_error_1385' | 'unclassified_output'
  | 'runner_logon_failed' | 'runner_spawn_request_failed' | 'runner_spawn_child_failed' | 'runner_write_ready_failed'
  | 'runner_spawn_ready_wait_failed' | 'runner_pipe_closed_before_spawn_ready' | 'runner_pipe_closed_before_exit'
  | 'runner_read_failed' | 'runner_handshake_task_failed' | 'sandbox_setup_helper_failed'
  | 'sandbox_stdin_forwarder_failed' | 'sandbox_output_forwarder_failed' | 'sandbox_startup_failed';
export interface CodexSandboxProbeObservation {
  name: CodexSandboxProbeName; phase: 'before' | 'after'; elapsedMs: number;
  exitCode: number | null; signal: 'SIGTERM' | 'SIGKILL' | 'other' | null; error: 'timeout' | 'spawn_error' | null;
  stdoutBytes: number | null; stderrBytes: number | null;
  nativeDiagnostic: CodexSandboxNativeDiagnostic | null; nativeErrorCode: number | null;
}
/** Optional diagnostics retain counts and fixed observed code hints, never native output. */
export function codexSandboxProbeOutput(result: { stdout?: unknown; stderr?: unknown }): Pick<CodexSandboxProbeObservation, 'stdoutBytes' | 'stderrBytes' | 'nativeDiagnostic' | 'nativeErrorCode'> {
  const bytes = (value: unknown) => typeof value === 'string' ? Buffer.byteLength(value) : Buffer.isBuffer(value) ? value.byteLength : null;
  const text = (value: unknown) => typeof value === 'string' ? value.slice(0, 100_000) : Buffer.isBuffer(value) ? value.subarray(0, 100_000).toString('utf8') : '';
  const output = text(result.stdout) + '\n' + text(result.stderr);
  // These fragments are emitted by the pinned runtime's Windows startup/stdio paths.
  // They identify observed diagnostics, not an inferred root cause or a successful denial.
  const messages: Array<[CodexSandboxNativeDiagnostic, string]> = [
    ['runner_logon_failed', 'CreateProcessWithLogonW failed:'],
    ['runner_spawn_request_failed', 'runner failed during ReadSpawnRequest:'],
    ['runner_spawn_child_failed', 'runner failed during SpawnChild:'],
    ['runner_write_ready_failed', 'runner failed during WriteSpawnReady:'],
    ['runner_spawn_ready_wait_failed', 'wait for runner spawn_ready'],
    ['runner_pipe_closed_before_spawn_ready', 'runner pipe closed before spawn_ready'],
    ['runner_pipe_closed_before_exit', 'runner pipe closed before exit'],
    ['runner_read_failed', 'runner read failed:'],
    ['runner_handshake_task_failed', 'runner handshake task failed:'],
    ['sandbox_setup_helper_failed', 'setup helper exited with status'],
    ['sandbox_stdin_forwarder_failed', 'windows sandbox stdin forwarder failed:'],
    ['sandbox_output_forwarder_failed', 'windows sandbox output forwarder failed to'],
    ['sandbox_startup_failed', 'windows sandbox failed:'],
  ];
  const match = /\b(?:os error|Windows error) (\d{1,10})\b|CreateProcessWithLogonW failed: (\d{1,10})\b/i.exec(output);
  const code = Number(match?.[1] ?? match?.[2]);
  const nativeErrorCode = Number.isSafeInteger(code) && code >= 0 && code <= 0xffffffff ? code : null;
  const knownCode = nativeErrorCode !== null && [5, 1314, 1326, 1385].includes(nativeErrorCode) ? `os_error_${nativeErrorCode}` as CodexSandboxNativeDiagnostic : null;
  const nativeDiagnostic = messages.find(([, text]) => output.includes(text))?.[0] ?? knownCode ?? (output.trim() ? 'unclassified_output' : null);
  return { stdoutBytes: bytes(result.stdout), stderrBytes: bytes(result.stderr), nativeDiagnostic, nativeErrorCode };
}
/** Validate both a denied credential file and a non-protected attempted write, before every spawn. */
export function verifyCodexSandbox(launch: CodexLaunch, observe?: (event: CodexSandboxProbeObservation) => void): void {
  if (process.platform !== 'win32')
    throw new Error('Codex process-tree containment is currently available only on Windows.');
  assertCodexConfigIsolation(launch);
  assertCodexWorkerBundle(launch.executable);
  const secretProbe = path.join(launch.workerDirectory, `sandbox-read-${randomUUID()}`);
  const writeProbe = path.join(os.tmpdir(), `stma-sandbox-write-${randomUUID()}`);
  // Optional acceptance diagnostics disclose only fixed probe names and bounded result metadata.
  const probe = <T extends { status: number | null; signal: string | null; error?: Error; stdout?: unknown; stderr?: unknown }>(name: CodexSandboxProbeName, execute: () => T): T => {
    const start = Date.now();
    observe?.({ name, phase: 'before', elapsedMs: 0, exitCode: null, signal: null, error: null, stdoutBytes: null, stderrBytes: null, nativeDiagnostic: null, nativeErrorCode: null });
    const result = execute();
    observe?.({ name, phase: 'after', elapsedMs: Date.now() - start, exitCode: result.status,
      signal: result.signal === 'SIGTERM' || result.signal === 'SIGKILL' ? result.signal : result.signal ? 'other' : null,
      error: result.error ? (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? 'timeout' : 'spawn_error' : null,
      ...codexSandboxProbeOutput(result) });
    return result;
  };
  writeFileSync(secretProbe, 'probe', { flag: 'wx', mode: 0o600 });
  try {
    const args = codexExecArgs(launch);
    const mcpIndex = args.findIndex((value) => value.startsWith('mcp_servers='));
    const list = probe('mcp_list', () => spawnSync(
      nativeWorkerExecutable(launch.executable),
      ['mcp', 'list', '--json', '-c', args[mcpIndex]!],
      {
        cwd: launch.checkout,
        env: codexEnvironment({ ...launch, apiKey: '', token: '' }),
        shell: false,
        windowsHide: true,
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 100_000,
      },
    ));
    let servers: any;
    try {
      servers = JSON.parse(list.stdout ?? '');
    } catch {
      /* fail closed */
    }
    const server = servers?.[0];
    if (
      list.error ||
      list.status !== 0 ||
      !Array.isArray(servers) ||
      servers.length !== 1 ||
      server?.name !== 'stma_worker' ||
      server.enabled !== true ||
      server.transport?.type !== 'streamable_http' ||
      server.transport.url !== launch.server + '/mcp' ||
      server.transport.bearer_token_env_var !== 'STMA_WORKER_CHILD_TOKEN' ||
      server.transport.http_headers ||
      server.transport.env_http_headers ||
      server.transport.http_headers_helper
    )
      throw new Error('Codex MCP configuration could not be isolated.');
    if ([secretProbe, writeProbe].some((value) => /[&|<>^%!()"\r\n]/.test(value)))
      throw new Error('Sandbox probe path contains unsupported command characters.');
    const cmd = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
    const read = [cmd, '/d', '/c', 'type', secretProbe];
    const write = [cmd, '/d', '/c', 'copy', '/y', 'nul', writeProbe];
    const opts = {
      cwd: launch.checkout,
      env: codexEnvironment({ ...launch, apiKey: '', token: '' }),
      shell: false,
      windowsHide: true,
      encoding: 'utf8' as const,
      timeout: 15_000,
      maxBuffer: 16_000,
    };
    // First prove both probes succeed outside the sandbox, so a broken command cannot count as denial.
    const hostRead = probe('host_read', () => spawnSync(read[0]!, read.slice(1), opts));
    const hostWrite = probe('host_write', () => spawnSync(write[0]!, write.slice(1), opts));
    if (
      hostRead.error ||
      hostRead.status !== 0 ||
      hostWrite.error ||
      hostWrite.status !== 0 ||
      !existsSync(writeProbe)
    )
      throw new Error('Sandbox control probes did not execute correctly.');
    const sandbox = (probe: string[]) =>
      spawnSync(
        nativeWorkerExecutable(launch.executable),
        ['sandbox', ...codexSecurityArgs(launch), '--', ...probe],
        opts,
      );
    const control = probe('sandbox_control', () => sandbox([cmd, '/d', '/c', 'exit', '0']));
    const readableControl = probe('sandbox_readable_control', () => sandbox([cmd, '/d', '/c', 'type', writeProbe]));
    if (control.error || control.status !== 0 || readableControl.error || readableControl.status !== 0)
      throw new Error('Sandbox control probes did not execute correctly.');
    unlinkSync(writeProbe);
    const deniedRead = probe('sandbox_denied_read', () => sandbox(read));
    const deniedWrite = probe('sandbox_denied_write', () => sandbox(write));
    if (
      deniedRead.error ||
      deniedRead.status === 0 ||
      deniedWrite.error ||
      deniedWrite.status === 0 ||
      existsSync(writeProbe)
    )
      throw new Error('Codex sandbox could not prove denied credential reads and writes.');
  } finally {
    if (existsSync(secretProbe)) unlinkSync(secretProbe);
    if (existsSync(writeProbe)) unlinkSync(writeProbe);
  }
}
export function launchCodexWorker(
  launch: CodexLaunch,
  observe: (event: CodexObservation) => void,
  spawnChild: typeof spawn = spawn,
): WorkerRuntimeHandle {
  if (process.platform !== 'win32')
    throw new Error('Codex process-tree containment is currently available only on Windows.');
  assertCodexConfigIsolation(launch);
  const executable = nativeWorkerExecutable(launch.executable);
  const job = windowsJobCommand();
  const frame = windowsJobFrame({ exe: executable, args: codexExecArgs(launch), cwd: launch.checkout, input: launch.prompt });
  const child = spawnChild(job.executable, job.args, {
    cwd: launch.checkout,
    env: codexEnvironment(launch),
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  let buffer = '';
  let stderr = '';
  let bytes = 0;
  let closed = false;
  let thread = '';
  let final = '';
  let terminal = false;
  const line = (value: string) => {
    if (value.length > 1_000_000) return observe({ type: 'invalid' });
    let event: any;
    try {
      event = JSON.parse(value);
    } catch {
      return observe({ type: 'invalid' });
    }
    if (event?.type === 'thread.started') {
      if (thread || !/^[a-f0-9-]{36}$/i.test(event.thread_id ?? '')) return observe({ type: 'invalid' });
      thread = event.thread_id;
      observe({ type: 'started', threadId: thread });
    } else if (
      event?.type === 'item.completed' &&
      event.item?.type === 'agent_message' &&
      typeof event.item.text === 'string'
    )
      final = event.item.text.slice(0, 20_000);
    else if (event?.type === 'turn.completed') {
      if (!thread || terminal) return observe({ type: 'invalid' });
      terminal = true;
      observe({ type: 'result', success: true, text: final, auth: false, quota: false });
    } else if (event?.type === 'turn.failed' || event?.type === 'error') {
      if (terminal) return observe({ type: 'invalid' });
      terminal = true;
      const detail = JSON.stringify(event).slice(0, 20_000);
      observe({
        type: 'result',
        success: false,
        text: '',
        auth: /authentication|unauthorized|invalid.{0,15}(?:api.?key|credential)|\b401\b/i.test(detail),
        quota: /rate.limit|quota|\b429\b|credit balance/i.test(detail),
      });
    }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    bytes += chunk.length;
    buffer += chunk;
    if (bytes > 2_000_000 || buffer.length > 1_000_000) {
      buffer = '';
      observe({ type: 'invalid' });
      return;
    }
    let i: number;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const value = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (value.trim()) line(value);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-20_000);
  });
  child.stdin.on('error', () => {});
  const completion = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once('error', () => {
      closed = true;
      resolve({ code: null, signal: 'spawn_error' });
    });
    child.once('close', (code, signal) => {
      closed = true;
      if (buffer.trim()) line(buffer);
      if (!terminal && code !== 0 && !signal) {
        const auth = /authentication|unauthorized|invalid.{0,15}(?:api.?key|credential)|\b401\b/i.test(
          stderr,
        );
        const quota = /rate.limit|quota|\b429\b|credit balance/i.test(stderr);
        if (auth || quota) {
          terminal = true;
          observe({ type: 'result', success: false, text: '', auth, quota });
        }
      }
      resolve({ code, signal });
    });
  });
  child.stdin.end(frame);
  return {
    pid: child.pid,
    completion,
    stop: () => {
      if (!closed) child.kill();
    },
  };
}
