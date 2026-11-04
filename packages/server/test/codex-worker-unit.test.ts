import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import {
  assertCodexConfigIsolation,
  assertCodexWorkerBundle,
  codexEnvironment,
  codexExecArgs,
  codexSandboxSetupDiagnostic,
  codexSandboxProbeOutput,
  codexWorkerModel,
  codexWindowsShellEnvironment,
  codexSecurityArgs,
  launchCodexWorker,
  type CodexLaunch,
  type CodexObservation,
} from '../../cli/src/codexWorkerRuntime';
import { superviseWorker, type WorkerRequest } from '../../cli/src/worker';
import {
  canonicalCheckout,
  checkoutFingerprint,
  signalWorker,
  type WorkerConfig,
} from '../../cli/src/workerState';
import { windowsJobCommand, windowsJobFrame } from '../../cli/src/windowsWorkerJob';

it('retains only a validated Windows SystemRoot in the shell environment override', () => {
  expect(codexWindowsShellEnvironment({ sYsTeMrOoT: 'C:/Windows Space/Unicode-ç', CODEX_API_KEY: 'secret-canary', STMA_WORKER_CHILD_TOKEN: 'secret-canary', PATH: 'secret-canary' }))
    .toEqual({ SystemRoot: 'C:\\Windows Space\\Unicode-ç' });
  for (const root of ['', 'Windows', 'C:Windows', '\\\\server\\Windows', '\\\\?\\C:\\Windows', 'C:\\Windows\\..\\other', 'C:\\Windows\\.', 'C:\\Windows ', 'C:\\Windows:stream', 'C:\\Windows"\ninherit="all"', 'C:\\Windows\0', 'C:\\' + 'x'.repeat(260)]) {
    expect(() => codexWindowsShellEnvironment({ SystemRoot: root })).toThrow('Windows Codex worker requires one absolute local SystemRoot path.');
  }
  expect(() => codexWindowsShellEnvironment({})).toThrow(/SystemRoot/);
  expect(() => codexWindowsShellEnvironment({ SystemRoot: 'C:\\Windows', SYSTEMROOT: 'D:\\Windows' })).toThrow(/SystemRoot/);
});

it('keeps sandbox probe diagnostics to byte counts and fixed code hints without output', () => {
  const secret = 'sensitive-fixture-content';
  const stderr = `Native process failed (os error 1385): C:\\private\\${secret}`;
  expect(codexSandboxProbeOutput({ stdout: 'é', stderr })).toEqual({ stdoutBytes: 2, stderrBytes: Buffer.byteLength(stderr), nativeDiagnostic: 'os_error_1385', nativeErrorCode: 1385 });
  for (const code of [5, 1314, 1326, 1385]) expect(codexSandboxProbeOutput({ stderr: `(os error ${code}) ${secret}` }).nativeDiagnostic).toBe(`os_error_${code}`);
  expect(codexSandboxProbeOutput({ stdout: Buffer.from(secret), stderr: '(os error 999999)' })).toEqual({ stdoutBytes: Buffer.byteLength(secret), stderrBytes: 17, nativeDiagnostic: 'unclassified_output', nativeErrorCode: 999999 });
  expect(codexSandboxProbeOutput({ stdout: '', stderr: '' })).toEqual({ stdoutBytes: 0, stderrBytes: 0, nativeDiagnostic: null, nativeErrorCode: null });
  expect(codexSandboxProbeOutput({ stdout: { secret }, stderr: null })).toEqual({ stdoutBytes: null, stderrBytes: null, nativeDiagnostic: null, nativeErrorCode: null });
  expect(JSON.stringify(codexSandboxProbeOutput({ stdout: secret, stderr }))).not.toContain(secret);
  const cases = [
    ['windows sandbox failed: CreateProcessWithLogonW failed: 267', 'runner_logon_failed', 267],
    ['windows sandbox failed: runner failed during SpawnChild: private path (Windows error 123)', 'runner_spawn_child_failed', 123],
    ['windows sandbox failed: runner pipe closed before spawn_ready', 'runner_pipe_closed_before_spawn_ready', null],
    ['windows sandbox failed: wait for runner spawn_ready', 'runner_spawn_ready_wait_failed', null],
    ['windows sandbox stdin forwarder failed: private input (os error 6)', 'sandbox_stdin_forwarder_failed', 6],
    ['windows sandbox failed: private startup detail', 'sandbox_startup_failed', null],
  ] as const;
  for (const [text, nativeDiagnostic, nativeErrorCode] of cases) {
    const result = codexSandboxProbeOutput({ stderr: text + ' ' + secret });
    expect(result).toMatchObject({ nativeDiagnostic, nativeErrorCode });
    expect(JSON.stringify(result)).not.toContain(secret);
  }
  for (const code of ['-1', '4294967296', '12345678901234567890']) expect(codexSandboxProbeOutput({ stderr: `(os error ${code})` }).nativeErrorCode).toBeNull();
});

it('withholds a setup command when another Codex home may own the global sandbox accounts', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'stma-codex-setup-check-'));
  try {
    expect(codexSandboxSetupDiagnostic(process.execPath, base, '')).toMatchObject({ blocked: false });
    const other = path.join(base, 'custom-codex'); mkdirSync(other); mkdirSync(path.join(other, '.sandbox-secrets'));
    writeFileSync(path.join(other, '.sandbox-secrets', 'sandbox_users.json'), 'not read by this check');
    const diagnostic = codexSandboxSetupDiagnostic(process.execPath, base, other);
    expect(diagnostic).toMatchObject({ blocked: true, reason: 'another_codex_sandbox_home_detected' });
    expect(diagnostic).not.toHaveProperty('args'); expect(diagnostic).not.toHaveProperty('executable');
    mkdirSync(path.join(base, '.codex')); mkdirSync(path.join(base, '.codex', '.sandbox'));
    writeFileSync(path.join(base, '.codex', '.sandbox', 'setup_marker.json'), 'not read');
    expect(codexSandboxSetupDiagnostic(process.execPath, base, '')).toMatchObject({ blocked: true });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

it('refuses standalone Codex binaries and incomplete or mismatched helper bundles', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'stma-codex-bundle-'));
  try {
    mkdirSync(path.join(base, 'bin')); mkdirSync(path.join(base, 'codex-resources'));
    const executable = path.join(base, 'bin', 'codex.exe'); writeFileSync(executable, 'fixture');
    expect(() => assertCodexWorkerBundle(executable)).toThrow(/complete official/);
    const manifest = { layoutVersion: 1, version: '0.166.0', target: 'x86_64-pc-windows-msvc', variant: 'codex', entrypoint: 'bin/codex.exe', resourcesDir: 'codex-resources' };
    writeFileSync(path.join(base, 'codex-package.json'), JSON.stringify(manifest));
    expect(() => assertCodexWorkerBundle(executable)).toThrow(/complete official/);
    for (const name of ['codex-windows-sandbox-setup.exe', 'codex-command-runner.exe']) writeFileSync(path.join(base, 'codex-resources', name), 'fixture');
    expect(() => assertCodexWorkerBundle(executable)).not.toThrow();
    writeFileSync(path.join(base, 'codex-package.json'), JSON.stringify({ ...manifest, version: '0.155.1' }));
    expect(() => assertCodexWorkerBundle(executable)).toThrow(/complete official/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

it('requires an explicit model and refuses whitespace, options and missing old configuration', () => {
  expect(codexWorkerModel('gpt-fixture-2026-01-01')).toBe('gpt-fixture-2026-01-01');
  for (const model of [undefined, '', '--model', 'model --config=x', 'model\nother', 'a'.repeat(101)])
    expect(() => codexWorkerModel(model)).toThrow(/explicit model/);
});

it('denies default and custom Claude credential directories, including canonical aliases', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'stma-codex-paths-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  try {
    const actual = path.join(base, 'actual');
    const alias = path.join(base, 'alias');
    mkdirSync(actual);
    symlinkSync(actual, alias, 'junction');
    process.env.CLAUDE_CONFIG_DIR = alias;
    const launch: CodexLaunch = {
      executable: process.execPath,
      model: 'fixture-model',
      checkout: process.cwd(),
      codexHome: path.join(base, 'child'),
      workerDirectory: path.join(base, 'worker'),
      server: 'https://example.invalid',
      token: '',
      apiKey: '',
      prompt: '',
    };
    const policy = codexSecurityArgs(launch).join('\n');
    for (const protectedPath of [path.join(os.homedir(), '.claude'), alias, realpathSync.native(actual)])
      expect(policy).toContain(`${JSON.stringify(path.resolve(protectedPath))}="deny"`);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(base, { recursive: true, force: true });
  }
});

it('refuses local config and hook layers that could change sandbox or MCP behavior', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'stma-codex-config-'));
  try {
    const checkout = path.join(base, 'checkout');
    const home = path.join(base, 'home');
    mkdirSync(checkout);
    mkdirSync(home);
    const launch: CodexLaunch = {
      executable: process.execPath,
      model: 'fixture-model',
      checkout,
      codexHome: home,
      workerDirectory: path.join(base, 'worker'),
      server: 'https://example.invalid',
      token: '',
      apiKey: '',
      prompt: '',
    };
    expect(() => assertCodexConfigIsolation(launch)).not.toThrow();
    for (const file of [path.join(home, 'config.toml'), path.join(home, 'hooks.json')]) {
      writeFileSync(file, 'fixture');
      expect(() => assertCodexConfigIsolation(launch)).toThrow(/config or hook layers/);
      rmSync(file);
    }
    mkdirSync(path.join(checkout, '.codex'));
    expect(() => assertCodexConfigIsolation(launch)).toThrow(/config or hook layers/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

it.runIf(process.platform === 'win32')(
  'isolates CLI settings and observes a bounded model result from the child stream',
  async () => {
    const launch: CodexLaunch = {
      executable: process.execPath,
      model: 'fixture-model',
      checkout: process.cwd(),
      codexHome: path.join(os.tmpdir(), 'stma-unit-codex'),
      workerDirectory: process.cwd(),
      server: 'https://example.invalid',
      token: 'child-secret',
      apiKey: 'provider-secret',
      prompt: 'Analyze',
    };
    const args = codexExecArgs(launch);
    expect(args.join(' ')).not.toContain(launch.apiKey);
    expect(args.join(' ')).not.toContain(launch.token);
    expect(args).toContain('--ignore-user-config');
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'fixture-model']);
    expect(args).toContain('windows.sandbox="elevated"');
    expect(args).toContain('features.prefer_mxc=false');
    expect(args.filter(arg => arg.startsWith('service_tier='))).toEqual(['service_tier="default"']);
    expect(args.join(' ')).toContain('required=true');
    expect(args.join(' ')).not.toContain('dangerously-bypass');
    expect(args).toContain('shell_environment_policy.inherit="none"');
    expect(args.filter(arg => arg.startsWith('shell_environment_policy.set=')))
      .toEqual([`shell_environment_policy.set={SystemRoot=${JSON.stringify(codexWindowsShellEnvironment().SystemRoot)}}`]);
    expect(
      codexEnvironment(launch, { STMA_TOKEN: 'parent-secret', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }),
    ).not.toHaveProperty('STMA_TOKEN');
    const sourceEnvironment = { sYsTeMrOoT: process.env.SystemRoot!, pSmOdUlEpAtH: 'C:\\untrusted-module-canary' };
    const isolatedEnvironment = codexEnvironment(launch, sourceEnvironment);
    expect(isolatedEnvironment.PSModulePath).toBe(path.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'));
    expect(JSON.stringify(isolatedEnvironment)).not.toContain('untrusted-module-canary');
    expect(sourceEnvironment.pSmOdUlEpAtH).toBe('C:\\untrusted-module-canary');
    let oversizedSpawned = false;
    expect(() => launchCodexWorker({ ...launch, prompt: 'x'.repeat(1_048_576) }, () => {}, (() => {
      oversizedSpawned = true; throw new Error('Unexpected oversized launch');
    }) as any)).toThrow('Windows worker launch payload exceeds 1,048,576 characters.');
    expect(oversizedSpawned).toBe(false);
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: 123,
      kill: () => true,
    });
    const events: CodexObservation[] = [];
    const handle = launchCodexWorker(launch, (event) => events.push(event), (() => child) as any);
    child.stdout.write(
      JSON.stringify({ type: 'thread.started', thread_id: '11111111-1111-4111-8111-111111111111' }) + '\n',
    );
    child.stdout.write(
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'analysis' } }) + '\n',
    );
    child.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\n');
    child.emit('close', 0, null);
    await expect(handle.completion).resolves.toEqual({ code: 0, signal: null });
    expect(events).toEqual([
      { type: 'started', threadId: '11111111-1111-4111-8111-111111111111' },
      { type: 'result', success: true, text: 'analysis', auth: false, quota: false },
    ]);
  },
);

it.runIf(process.platform === 'win32')('launches a UTF-8 frame without stdin EOF and preserves embedded CR/LF', async () => {
  const input = 'Türkçe 東京 😀\r\nsecond line\n"quoted"\\tail';
  const digest = createHash('sha256').update(input).digest('hex');
  const code = "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',value=>input+=value);process.stdin.on('end',()=>{if(require('crypto').createHash('sha256').update(input).digest('hex')!==" + JSON.stringify(digest) + ")process.exit(2);process.stdout.write('framed-ready\\n');});";
  const job = windowsJobCommand();
  const child = spawn(job.executable, job.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let closed = false; let output = ''; let timer: NodeJS.Timeout | undefined;
  const completion = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); });
  });
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.resume(); child.stdin.on('error', () => {});
  try {
    child.stdin.write(windowsJobFrame({ exe: process.execPath, args: ['-e', code], cwd: process.cwd(), input }));
    const result = await Promise.race([completion, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Framed launcher waited for stdin EOF.')), 10_000);
    })]);
    expect(result).toEqual({ code: 0, signal: null });
    expect(output).toBe('framed-ready\n');
    expect(child.stdin.writableEnded).toBe(false);
  } finally {
    if (timer) clearTimeout(timer);
    if (!closed) child.kill();
    await completion.catch(() => {});
  }
}, 20_000);

it.runIf(process.platform === 'win32')('runs Node with only SystemRoot through a raw Windows environment block', () => {
  const shellEnvironment = codexWindowsShellEnvironment();
  const lit = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const code = "const e=process.env;if(Object.keys(e).length!==1||!e.SystemRoot||e.STMA_SECRET_CANARY||e.CODEX_API_KEY||e.STMA_WORKER_CHILD_TOKEN)process.exit(7);process.stdout.write('minimal-system-root-ready\\n');";
  // .NET's cleared environment bypasses libuv, which silently restores Windows defaults.
  const script = `
$ErrorActionPreference='Stop'
$start=[Diagnostics.ProcessStartInfo]::new()
$start.FileName=${lit(process.execPath)}
$start.Arguments=${lit('-e "' + code + '"')}
$start.UseShellExecute=$false;$start.CreateNoWindow=$true
$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
$start.EnvironmentVariables.Clear()
$start.EnvironmentVariables['SystemRoot']=${lit(shellEnvironment.SystemRoot)}
$child=[Diagnostics.Process]::Start($start)
try {
  $out=$child.StandardOutput.ReadToEndAsync();$err=$child.StandardError.ReadToEndAsync()
  if(-not $child.WaitForExit(5000)){$child.Kill();$child.WaitForExit();exit 2}
  if($child.ExitCode -ne 0){exit 3}
  [Console]::Write($out.GetAwaiter().GetResult())
} finally {if(-not $child.HasExited){$child.Kill();$child.WaitForExit()};$child.Dispose()}
`;
  const job = windowsJobCommand();
  const result = spawnSync(job.executable, job.args, {
    input: windowsJobFrame({ exe: job.executable, args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], cwd: process.cwd(), input: '' }),
    env: { ...process.env, STMA_SECRET_CANARY: 'secret-canary', CODEX_API_KEY: 'secret-canary', STMA_WORKER_CHILD_TOKEN: 'secret-canary' },
    timeout: 10_000, windowsHide: true,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout.toString()).toBe('minimal-system-root-ready\n');
}, 20_000);

it.runIf(process.platform === 'win32')('refuses incomplete and invalid UTF-8 frames before worker creation', () => {
  const job = windowsJobCommand();
  for (const input of [Buffer.from('{"exe":"unused"}'), Buffer.from([0xff, 10])]) {
    const result = spawnSync(job.executable, job.args, { input, windowsHide: true, timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(126);
    expect(result.stdout.toString()).toBe('');
    expect(result.stderr.toString()).toContain('STMA Windows job payload refused.');
  }
}, 20_000);

it.runIf(process.platform === 'win32')(
  'contains a real Windows descendant and waits for job termination',
  async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'stma-job-test-'));
    try {
      const started = path.join(base, 'started');
      const marker = path.join(base, 'marker');
      const script = path.join(base, 'child.js');
      writeFileSync(
        script,
        `require('fs').writeFileSync(${JSON.stringify(started)},'start');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'bad'),3000)`,
      );
      const lit = (value: string) => `'${value.replaceAll("'", "''")}'`;
      const source = `$p=New-Object System.Diagnostics.ProcessStartInfo;$p.FileName=${lit(process.execPath)};$p.Arguments='"'+${lit(script)}+'"';$p.UseShellExecute=$false;$p.CreateNoWindow=$true;[System.Diagnostics.Process]::Start($p)|Out-Null;for($i=0;$i -lt 200;$i++){if(Test-Path -LiteralPath ${lit(started)}){exit 0};Start-Sleep -Milliseconds 20};exit 1`;
      const powershell = path.join(
        process.env.SystemRoot!,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      );
      const job = windowsJobCommand();
      const result = spawnSync(job.executable, job.args, {
        input: windowsJobFrame({
          exe: powershell,
          args: [
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(source, 'utf16le').toString('base64'),
          ],
          cwd: process.cwd(),
          input: '',
        }),
        timeout: 15_000,
        windowsHide: true,
      });
      expect(result.status).toBe(125);
      expect(existsSync(started)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 3200));
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
  20_000,
);

it('reports only an observed completed model analysis using supervisor authority', async () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'stma-codex-unit-'));
  try {
    const checkout = path.join(base, 'checkout');
    const directory = path.join(base, 'state');
    mkdirSync(checkout);
    mkdirSync(directory);
    const canonical = canonicalCheckout(checkout);
    const target = randomUUID();
    const session = randomUUID();
    const attempt = randomUUID();
    const runId = randomUUID();
    const config: WorkerConfig = {
      schema: 1,
      checkout: canonical,
      fingerprint: checkoutFingerprint(canonical),
      targetId: target,
      installationId: randomUUID(),
      server: 'https://example.invalid',
      executable: process.execPath,
      runtimeVersion: '0.166.0',
      apiKeyEnv: 'KEY',
      hookRuntime: process.execPath,
      runtime: 'codex-read-only-v1',
      codexModel: 'fixture-model',
      maxRuntimeSeconds: 60,
      maxTurns: 1,
    };
    const events: any[] = [];
    const brief = 'Read README.md and use get_work for context.\nTo start: Call update_handoff with action accept.';
    let report = '';
    let childToken = '';
    let prompt = '';
    const request: WorkerRequest = async <T>(endpoint: string, body?: any) => {
      if (endpoint.endsWith('/claim'))
        return {
          job: {
            id: randomUUID(),
            target_id: target,
            session_id: session,
            work_id: null,
            spec_revision: null,
            max_runtime_seconds: 60,
            max_turns: 1,
            assignment: {
              task: 'Analyze',
              brief,
              start_call: {},
              branch: null,
              repository_identity: 'fixture',
            },
          },
          attempt: { id: attempt, fence: 1, provider_session_id: randomUUID() },
          attempt_token: 'supervisor-secret',
          child_token: 'child-secret',
        } as T;
      if (endpoint.endsWith('/heartbeat'))
        return {
          lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
          cancel_requested: false,
        } as T;
      events.push(body);
      if (body.state === 'succeeded') signalWorker(directory, 'stop');
      return { ok: true } as T;
    };
    await superviseWorker(config, directory, {
      request,
      apiKey: 'provider-secret',
      codexHome: path.join(base, 'codex-home'),
      preflight: () => {},
      buildStartRequest: () => ({}),
      verifyCodex: () => {},
      attemptRequest: (async (_ctx: unknown, endpoint: string) =>
        endpoint.endsWith('/start')
          ? { run: { id: runId }, policy: { document: {}, hash: 'fixture' } }
          : endpoint.endsWith('/finish')
            ? { ok: true, runId, status: 'completed' }
            : {}) as any,
      reportCodex: async (_server, token, id, text) => {
        expect(token).toBe('supervisor-secret');
        expect(id).toBe(session);
        report = text;
      },
      launchCodex: (launch, observe) => {
        childToken = launch.token;
        prompt = launch.prompt;
        observe({ type: 'started', threadId: randomUUID() });
        observe({ type: 'result', success: true, text: 'analysis', auth: false, quota: false });
        return { pid: 99, completion: Promise.resolve({ code: 0, signal: null }), stop() {} };
      },
      wait: async () => {},
    });
    expect(childToken).toBe('child-secret');
    expect(prompt.split('\n').slice(0, 4)).toEqual([
      'Use the read-only stma_worker MCP tools for STMA context.',
      'You may use local read-only commands to inspect the dedicated checkout and carry out read-only assignment steps. Keep local commands offline. Do not modify files.',
      'The supervisor manages run tracking. Treat lifecycle instructions in the assignment as reference and leave the handoff and Work state unchanged.',
      'Return only a model report in your final response, without submitting delivery or accepting work.',
    ]);
    expect(prompt).toContain(`Task: Analyze\nBrief:\n${brief}\nManaged run ${runId}.`);
    expect(report).toContain('not delivery or acceptance');
    expect(events.map((event) => event.state)).toEqual(['starting', 'running', 'succeeded']);
    expect(events.at(-1).process_stopped).toBe(true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

it('quarantines a cancelled Codex attempt instead of claiming its descendants stopped', async () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'stma-codex-cancel-'));
  try {
    const checkout = path.join(base, 'checkout');
    const directory = path.join(base, 'state');
    mkdirSync(checkout);
    mkdirSync(directory);
    const canonical = canonicalCheckout(checkout);
    const target = randomUUID();
    const session = randomUUID();
    const attempt = randomUUID();
    const runId = randomUUID();
    const config: WorkerConfig = {
      schema: 1,
      checkout: canonical,
      fingerprint: checkoutFingerprint(canonical),
      targetId: target,
      installationId: randomUUID(),
      server: 'https://example.invalid',
      executable: process.execPath,
      runtimeVersion: '0.166.0',
      apiKeyEnv: 'KEY',
      hookRuntime: process.execPath,
      runtime: 'codex-read-only-v1',
      codexModel: 'fixture-model',
      maxRuntimeSeconds: 60,
      maxTurns: 1,
    };
    const events: any[] = [];
    let beats = 0;
    let stopped = false;
    let clock = 0;
    const request: WorkerRequest = async <T>(endpoint: string, body?: any) => {
      if (endpoint.endsWith('/claim'))
        return {
          job: {
            id: randomUUID(),
            target_id: target,
            session_id: session,
            work_id: null,
            spec_revision: null,
            max_runtime_seconds: 60,
            max_turns: 1,
            assignment: {
              task: 'Analyze',
              brief: 'fixture',
              start_call: {},
              branch: null,
              repository_identity: 'fixture',
            },
          },
          attempt: { id: attempt, fence: 1, provider_session_id: randomUUID() },
          attempt_token: 'supervisor-secret',
          child_token: 'child-secret',
        } as T;
      if (endpoint.endsWith('/heartbeat'))
        return { lease_expires_at: new Date(100_000).toISOString(), cancel_requested: ++beats > 1 } as T;
      events.push(body);
      return { ok: true } as T;
    };
    await superviseWorker(config, directory, {
      request,
      apiKey: 'provider-secret',
      codexHome: path.join(base, 'codex-home'),
      preflight: () => {},
      buildStartRequest: () => ({}),
      verifyCodex: () => {},
      attemptRequest: (async (_ctx: unknown, endpoint: string) =>
        endpoint.endsWith('/start')
          ? { run: { id: runId }, policy: { document: {}, hash: 'fixture' } }
          : {}) as any,
      launchCodex: (_launch, observe) => {
        observe({ type: 'started', threadId: randomUUID() });
        return {
          pid: 99,
          completion: new Promise(() => {}),
          stop() {
            stopped = true;
          },
        };
      },
      now: () => clock,
      wait: async (ms) => {
        clock += ms === 100 ? 10_000 : ms;
      },
    });
    expect(stopped).toBe(true);
    expect(events.at(-1).state).toBe('dispatch_unknown');
    expect(events.at(-1).process_stopped).toBe(false);
    expect(existsSync(path.join(directory, 'owner.lock'))).toBe(true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
