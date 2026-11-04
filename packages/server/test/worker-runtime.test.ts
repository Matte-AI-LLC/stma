import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { installWorkerHookRuntime, superviseWorker, workerAssignmentPrompt, workerSettings, type WorkerRequest } from '../../cli/src/worker';
import { launchWorkerRuntime, parseWorkerRuntimeLine, verifyWorkerApiAuth, workerChildEnvironment, workerRuntimeArguments, type RuntimeLaunch, type RuntimeObservation } from '../../cli/src/workerRuntime';
import { acquireWorkerLock, canonicalCheckout, checkoutFingerprint, readWorkerJson, signalWorker, writeWorkerJson, type WorkerConfig, type WorkerJournal } from '../../cli/src/workerState';
import { acquireWorkerHookLock, workerFileClaims, workerStartRequest } from '../../cli/src/workerHook';

const directories: string[] = [];
const temporary = () => { const directory = mkdtempSync(path.join(os.tmpdir(), 'stma-worker-')); directories.push(directory); return directory; };
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function launch(root: string): RuntimeLaunch {
  return { executable: process.execPath, cwd: root, sessionId: randomUUID(), configDirectory: path.join(root, 'isolated'), settingsFile: path.join(root, 'settings.json'), mcpFile: path.join(root, 'mcp.json'), hookContext: path.join(root, 'context.json'), apiKey: 'synthetic-provider-fixture', maxTurns: 3, prompt: 'task with & | < > $() ` ; " --bg\nsecond line' };
}

describe('managed worker launch boundary', () => {
  it('serializes two overlapping real heartbeat hooks without poisoning the attempt', async () => {
    const root = canonicalCheckout(temporary()); const stateDir = temporary(); const sessionId = randomUUID(); const runId = randomUUID();
    const contextFile = path.join(stateDir, 'context.json'); const stateFile = path.join(stateDir, 'hook-state.json');
    writeWorkerJson(contextFile, { schema: 1, checkout: root, server: 'https://example.invalid', token: 'synthetic-attempt', sessionId, installationId: randomUUID(), attemptId: randomUUID(), startCall: {}, repositoryIdentity: 'example.invalid/fixture', branch: 'main' });
    writeWorkerJson(stateFile, { runId, started: true });
    const entered = path.join(stateDir, 'first-entered'); const contended = path.join(stateDir, 'second-contended'); const release = path.join(stateDir, 'release-first');
    const hookModule = pathToFileURL(fileURLToPath(new URL('../../cli/src/workerHook.ts', import.meta.url))).href;
    const fixture = path.join(stateDir, 'parallel-hook.mts');
    writeFileSync(fixture, `import fs,{existsSync,writeFileSync} from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {setTimeout as delay} from 'node:timers/promises';import {runWorkerHook} from ${JSON.stringify(hookModule)};const originalOpen=fs.openSync;fs.openSync=(file,...args)=>{try{return originalOpen(file,...args);}catch(error){if(process.argv[2]==='second'&&file===${JSON.stringify(path.join(stateDir, 'hook.lock'))}&&error.code==='EEXIST')writeFileSync(${JSON.stringify(contended)},'');throw error;}};syncBuiltinESMExports();globalThis.fetch=async(url)=>{if(!url.endsWith('/runs/${runId}/heartbeat'))throw Error('wrong run');if(process.argv[2]==='first'){writeFileSync(${JSON.stringify(entered)},'');while(!existsSync(${JSON.stringify(release)}))await delay(10);}return {ok:true,json:async()=>({ok:true,runId:'${runId}',status:'active',closed:false})};};await runWorkerHook('heartbeat');`);
    const run = (role: string) => {
      const child = spawn(process.execPath, ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, fixture, role], { cwd: root, env: { ...process.env, STMA_WORKER_CONTEXT: contextFile }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdout.resume(); child.stderr.resume(); child.stdin.end(JSON.stringify({ session_id: sessionId, cwd: root }));
      const completion = new Promise<number | null>((resolve) => child.once('close', resolve));
      return { child, completion };
    };
    const waitFor = async (file: string) => { const until = Date.now() + 10_000; while (!existsSync(file) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10)); expect(existsSync(file)).toBe(true); };
    const first = run('first'); let second: ReturnType<typeof run> | undefined;
    try {
      await waitFor(entered); second = run('second'); await waitFor(contended);
      writeFileSync(release, '');
      expect(await Promise.all([first.completion, second.completion])).toEqual([0, 0]);
      expect(readWorkerJson<any>(stateFile)).toEqual({ runId, started: true });
      expect(existsSync(path.join(stateDir, 'hook-failed'))).toBe(false);
      expect(existsSync(path.join(stateDir, 'hook.lock'))).toBe(false);
    } finally {
      writeFileSync(release, '');
      for (const owned of [first, second]) if (owned && owned.child.exitCode === null) owned.child.kill();
      await Promise.all([first.completion, second?.completion]);
    }
  });
  it('bounds lock waiting and never removes a lock owned by another hook', async () => {
    const file = path.join(temporary(), 'hook.lock');
    writeWorkerJson(file, { owner: 'existing-owner' });
    await expect(acquireWorkerHookLock(file, 50)).rejects.toThrow(/bounded wait/);
    expect(readWorkerJson(file)).toEqual({ owner: 'existing-owner' });
    const ownFile = path.join(temporary(), 'hook.lock');
    const lock = await acquireWorkerHookLock(ownFile);
    writeWorkerJson(ownFile, { owner: 'replacement-owner' });
    expect(lock.owns()).toBe(false); expect(() => lock.release()).toThrow(/ownership changed/);
    expect(readWorkerJson(ownFile)).toEqual({ owner: 'replacement-owner' });
  });
  it.each(['marker-before', 'marker-during', 'lock-replaced', 'lock-timeout', 'state-unsafe'] as const)('fails a real guard closed on %s without deleting another owner or overwriting unowned state', (mode) => {
    const root = canonicalCheckout(temporary()); const stateDir = temporary(); const sessionId = randomUUID(); const runId = randomUUID();
    const contextFile = path.join(stateDir, 'context.json'); const stateFile = path.join(stateDir, 'hook-state.json');
    const marker = path.join(stateDir, 'hook-failed'); const lockFile = path.join(stateDir, 'hook.lock'); const requested = path.join(stateDir, 'request-observed');
    writeWorkerJson(contextFile, { schema: 1, checkout: root, server: 'https://example.invalid', token: 'synthetic-attempt', sessionId, installationId: randomUUID(), attemptId: randomUUID(), startCall: {}, repositoryIdentity: 'example.invalid/fixture', branch: 'main' });
    writeWorkerJson(stateFile, { runId, started: true });
    if (mode === 'marker-before') writeFileSync(marker, '', { mode: 0o600 });
    if (mode === 'lock-timeout') writeWorkerJson(lockFile, { owner: 'another-owner' });
    if (mode === 'state-unsafe') writeFileSync(stateFile, 'invalid-json');
    const hookModule = pathToFileURL(fileURLToPath(new URL('../../cli/src/workerHook.ts', import.meta.url))).href;
    const fixture = path.join(stateDir, 'uncertain-hook.mts');
    writeFileSync(fixture, `import {writeFileSync} from 'node:fs';import {runWorkerHook} from ${JSON.stringify(hookModule)};globalThis.fetch=async(url)=>{writeFileSync(${JSON.stringify(requested)},'');if(${JSON.stringify(mode)}==='marker-during')writeFileSync(${JSON.stringify(marker)},'',{mode:0o600});if(${JSON.stringify(mode)}==='lock-replaced')writeFileSync(${JSON.stringify(lockFile)},JSON.stringify({owner:'another-owner'}));return {ok:true,json:async()=>({ok:true,allowed:true,runId:'${runId}',coverage:'installed_file_tool_hook_only',contentRules:[]})};};await runWorkerHook('guard');`);
    const response = spawnSync(process.execPath, ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, fixture], { cwd: root, env: { ...process.env, STMA_WORKER_CONTEXT: contextFile }, input: JSON.stringify({ session_id: sessionId, cwd: root, tool_name: 'Write', tool_input: { file_path: path.join(root, 'allowed.txt'), content: 'test' } }), encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    expect(response.status, response.stderr).toBe(0);
    expect(response.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(response.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(existsSync(marker)).toBe(true);
    if (mode === 'marker-before' || mode === 'lock-timeout' || mode === 'state-unsafe') expect(existsSync(requested)).toBe(false);
    if (mode === 'marker-before' || mode === 'marker-during') expect(readWorkerJson<any>(stateFile).guardRefusal).toEqual({ tool: 'Write', stage: mode === 'marker-before' ? 'run_state' : 'completion' });
    if (mode === 'lock-replaced' || mode === 'lock-timeout') {
      expect(readWorkerJson(lockFile)).toEqual({ owner: 'another-owner' });
      expect(readWorkerJson(stateFile)).toEqual({ runId, started: true });
    }
  });
  it.each(['outside-path', 'request-refused', 'response-refused', 'unknown-tool'] as const)('records only the first fixed guard refusal for %s without granting write authority', (mode) => {
    const root = canonicalCheckout(temporary()); const stateDir = temporary(); const sessionId = randomUUID(); const runId = randomUUID();
    const contextFile = path.join(stateDir, 'context.json'); const stateFile = path.join(stateDir, 'hook-state.json');
    const privateMarker = 'synthetic-private-guard-marker';
    writeWorkerJson(contextFile, { schema: 1, checkout: root, server: 'https://example.invalid', token: privateMarker, sessionId, installationId: randomUUID(), attemptId: randomUUID(), startCall: {}, repositoryIdentity: 'example.invalid/fixture', branch: 'main' });
    writeWorkerJson(stateFile, { runId, started: true });
    const hookModule = pathToFileURL(fileURLToPath(new URL('../../cli/src/workerHook.ts', import.meta.url))).href;
    const fixture = path.join(stateDir, 'guard-diagnostic.mts');
    writeFileSync(fixture, `import {runWorkerHook} from ${JSON.stringify(hookModule)};globalThis.fetch=async()=>({ok:${mode !== 'request-refused'},json:async()=>({ok:true,allowed:false,runId:'${runId}',coverage:'installed_file_tool_hook_only',contentRules:[]})});await runWorkerHook('guard');`);
    const tool = mode === 'unknown-tool' ? privateMarker : 'Write';
    const file = mode === 'outside-path' ? path.join(root, '..', privateMarker) : path.join(root, 'safe.txt');
    const invoke = (toolName: string, filePath: string) => spawnSync(process.execPath, ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, fixture], { cwd: root, env: { ...process.env, STMA_WORKER_CONTEXT: contextFile }, input: JSON.stringify({ session_id: sessionId, cwd: root, tool_name: toolName, tool_input: { file_path: filePath, content: privateMarker } }), encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    const response = invoke(tool, file);
    expect(response.status).toBe(0); expect(JSON.parse(response.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    const expected = { tool: mode === 'unknown-tool' ? 'unknown' : 'Write', stage: mode === 'outside-path' || mode === 'unknown-tool' ? 'file_claims' : mode === 'request-refused' ? 'guard_request' : 'guard_response' };
    expect(readWorkerJson<any>(stateFile).guardRefusal).toEqual(expected);
    const second = invoke('Write', path.join(root, '..', 'another-outside-path'));
    expect(second.status).toBe(0); expect(readWorkerJson<any>(stateFile).guardRefusal).toEqual(expected);
    expect(readWorkerJson<any>(stateFile).denied).toBe(true);
    for (const forbidden of [privateMarker, file, root]) expect(readFileSync(stateFile, 'utf8')).not.toContain(forbidden);
    expect(existsSync(path.join(root, 'safe.txt'))).toBe(false);
  });
  it('supplies minimal assignment lifecycle calls and preserves Native Work delivery requirements', () => {
    const sessionId = randomUUID(); const workId = randomUUID();
    const job = { session_id: sessionId, work_id: null, spec_revision: null, assignment: { task: 'Inspect fixture', brief: 'Write the requested file.', repository_identity: 'example.invalid/fixture', branch: 'main', start_call: {} } };
    const prompt = workerAssignmentPrompt(job);
    const lifecycle = JSON.parse(prompt.split('\n').find((line) => line.startsWith('Assignment lifecycle: '))!.slice('Assignment lifecycle: '.length));
    expect(lifecycle.inspect).toEqual({ tool: 'get_session', arguments: { session_id: sessionId } });
    for (const action of ['accept', 'resume', 'complete']) expect(lifecycle[action]).toEqual({ tool: 'update_handoff', arguments: { session_id: sessionId, action } });
    expect(prompt).toContain('omit repository_identity, commit_sha and worktree_clean');
    expect(prompt).toContain('read the returned handoff.state');
    expect(prompt).toContain('For accepted, call resume without another accept');
    expect(prompt).toContain('For in_progress, continue the assigned work without another accept or resume');
    expect(prompt).toContain('For any other or missing state, stop');
    expect(prompt).toContain('If a required call is refused, stop before writing');
    expect(prompt).not.toContain('submit_work');
    const workPrompt = workerAssignmentPrompt({ ...job, work_id: workId, spec_revision: 3 });
    expect(workPrompt).toContain(`Native Work ${workId} at specification revision 3`);
    expect(workPrompt).toContain('submit_work with honest required artifacts and evidence before calling complete');
    expect(workPrompt).toContain('file edits alone do not satisfy those requirements');
  });
  it('keeps a finished run closed across real PostToolUse and SessionEnd hook processes while refusing later writes', () => {
    const root = canonicalCheckout(temporary()); const stateDir = temporary(); const sessionId = randomUUID(); const runId = randomUUID();
    const contextFile = path.join(stateDir, 'context.json'); const stateFile = path.join(stateDir, 'hook-state.json');
    writeWorkerJson(contextFile, { schema: 1, checkout: root, server: 'https://example.invalid', token: 'synthetic-attempt', sessionId, installationId: randomUUID(), attemptId: randomUUID(), startCall: {}, repositoryIdentity: 'example.invalid/fixture', branch: 'main' });
    writeWorkerJson(stateFile, { runId, started: true });
    const hookModule = pathToFileURL(fileURLToPath(new URL('../../cli/src/workerHook.ts', import.meta.url))).href;
    const fixture = path.join(stateDir, 'closed-hook.mts');
    writeFileSync(fixture, `import {runWorkerHook} from ${JSON.stringify(hookModule)};globalThis.fetch=async(url,options)=>{if(!url.includes('/runs/${runId}/'))throw Error('wrong run');if(url.endsWith('/write-guard'))throw Error('closed run must not request write authority');return {ok:true,json:async()=>({ok:true,runId:'${runId}',status:'completed',closed:url.endsWith('/heartbeat'),replayed:true})};};await runWorkerHook(process.argv[2]);`);
    const run = (event: string) => spawnSync(process.execPath, ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, fixture, event], { cwd: root, env: { ...process.env, STMA_WORKER_CONTEXT: contextFile }, input: JSON.stringify({ session_id: sessionId, cwd: root, tool_name: event === 'guard' ? 'Write' : 'mcp__stma_worker__finish_run', tool_input: { file_path: path.join(root, 'late.txt'), content: 'late' } }), encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    expect(run('heartbeat').status).toBe(0); expect(readWorkerJson<any>(stateFile).runClosed).toBe(true);
    expect(run('guard').stdout).toContain('"permissionDecision":"deny"');
    expect(run('heartbeat').status).toBe(0);
    expect(run('finish').status).toBe(0); expect(readWorkerJson<any>(stateFile).finished).toBe(true);
    expect(existsSync(path.join(stateDir, 'hook-failed'))).toBe(false);
  });
  it('compares actual Git HTTPS/SCP/SSH repository aliases using the shared canonical identity and refuses other repos/hosts/ports', () => {
    const root = canonicalCheckout(temporary());
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-b', 'main'); git('-c', 'user.name=Worker Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
    git('remote', 'add', 'origin', 'https://github.com/acme/api.git');
    const context = { schema: 1 as const, checkout: root, server: 'https://example.invalid', token: 'synthetic-attempt', sessionId: randomUUID(), installationId: randomUUID(), attemptId: randomUUID(), startCall: { team: 'team', project: 'api', work_id: randomUUID(), expected_spec_revision: 2 }, repositoryIdentity: 'github.com/acme/api', branch: 'main' };
    expect(() => workerStartRequest({ ...context, installationId: '' })).toThrow(/installation identity/);
    expect(() => workerStartRequest({ ...context, repositoryIdentity: null })).toThrow(/pinned repository identity/);
    for (const remote of ['https://github.com/acme/api.git', 'git@github.com:acme/api.git', 'ssh://git@github.com:22/acme/api.git']) {
      git('remote', 'set-url', 'origin', remote); expect(workerStartRequest(context)).toMatchObject({ installationId: context.installationId, repositoryIdentity: 'github.com/acme/api', branch: 'main', workId: context.startCall.work_id, expectedSpecRevision: 2 });
    }
    for (const remote of ['https://github.com/other/api.git', 'https://elsewhere.invalid/acme/api.git', 'ssh://git@github.com:2222/acme/api.git']) { git('remote', 'set-url', 'origin', remote); expect(() => workerStartRequest(context)).toThrow(/repository does not match/); }
    expect(workerStartRequest({ ...context, repositoryIdentity: 'github.com:2222/acme/api' })).toMatchObject({ repositoryIdentity: 'github.com:2222/acme/api' });
    git('config', 'core.fsmonitor', 'a-deliberately-nonexistent-helper');
    expect(workerStartRequest({ ...context, repositoryIdentity: 'github.com:2222/acme/api' })).toBeDefined();
  });
  it('reuses an identical pinned hook runtime after interrupted configuration and rejects changed content', () => {
    const directory = temporary(); const source = path.join(directory, 'source.mjs'); writeFileSync(source, 'export {};');
    const first = installWorkerHookRuntime(directory, source); expect(installWorkerHookRuntime(directory, source)).toBe(first);
    writeFileSync(first, 'changed'); expect(() => installWorkerHookRuntime(directory, source)).toThrow(/content hash/);
  });
  it('runs a real managed finish-hook process against only its bound run and rejects another provider session', () => {
    const root = canonicalCheckout(temporary()); const stateDir = temporary(); const sessionId = randomUUID(); const runId = randomUUID();
    const contextFile = path.join(stateDir, 'context.json'); const stateFile = path.join(stateDir, 'hook-state.json');
    writeWorkerJson(contextFile, { schema: 1, checkout: root, server: 'https://example.invalid', token: 'synthetic-attempt', sessionId, installationId: randomUUID(), attemptId: randomUUID(), startCall: {}, repositoryIdentity: null, branch: null });
    writeWorkerJson(stateFile, { runId, started: true });
    const hookModule = pathToFileURL(fileURLToPath(new URL('../../cli/src/workerHook.ts', import.meta.url))).href;
    const fixture = path.join(stateDir, 'hook-fixture.mts');
    writeFileSync(fixture, `import {writeFileSync} from 'node:fs';import {runWorkerHook} from ${JSON.stringify(hookModule)};globalThis.fetch=async(url,options)=>{if(options.headers.authorization!=='Bearer synthetic-attempt')throw Error('wrong credential');writeFileSync(${JSON.stringify(path.join(root, 'request.json'))},JSON.stringify({url,body:JSON.parse(options.body)}));return {ok:true,json:async()=>({ok:true,runId:${JSON.stringify(runId)},status:'completed',replayed:true})};};await runWorkerHook('finish');`);
    const run = (session: string) => spawnSync(process.execPath, ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, fixture], { cwd: root, env: { ...process.env, STMA_WORKER_CONTEXT: contextFile, STMA_TOKEN: 'synthetic-parent-must-not-be-used' }, input: JSON.stringify({ session_id: session, cwd: root }), encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    const completed = run(sessionId); expect(completed.status, completed.stderr).toBe(0);
    expect(JSON.parse(readFileSync(path.join(root, 'request.json'), 'utf8'))).toEqual({ url: `https://example.invalid/api/agent/runs/${runId}/finish`, body: { status: 'completed' } });
    expect(readWorkerJson<any>(stateFile).finished).toBe(true);
    const mismatched = run(randomUUID()); expect(mismatched.status).toBe(2);
    expect(mismatched.stderr).not.toContain('synthetic-');
    writeWorkerJson(stateFile, { runId: randomUUID(), started: true });
    const foreignRun = run(sessionId); expect(foreignRun.status).toBe(2);
    expect(readWorkerJson<any>(stateFile).finished).not.toBe(true);
  });
  it('refuses metadata, control paths, outside paths and directory junction aliases', () => {
    // Production config stores a canonical checkout; macOS temp paths may alias /private/var.
    const root = canonicalCheckout(temporary()); const outside = temporary();
    for (const file of ['.git', '.git/config', '.git::$DATA', '.git. /config', '.claude/settings.json', '.stma/state.json', '.stma.json', '.stma.json.', '../escape.txt']) {
      expect(() => workerFileClaims(root, { tool_name: 'Write', tool_input: { file_path: path.join(root, file), content: 'text' } })).toThrow();
    }
    const alias = path.join(root, 'alias'); symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => workerFileClaims(root, { tool_name: 'Write', tool_input: { file_path: path.join(alias, 'escape.txt'), content: 'text' } })).toThrow();
    expect(workerFileClaims(root, { tool_name: 'Write', tool_input: { file_path: path.join(root, 'safe.txt') } })).toEqual([{ resourceType: 'path', resourceKey: 'safe.txt', access: 'write' }]);
  });
  it('starts a real sleeping native child with exact cwd/stdin, fixed argv, restricted environment and bounded JSON observation', async () => {
    const root = temporary(); const input = launch(root); const fixture = path.join(root, 'fake-runtime.cjs');
    writeFileSync(fixture, `const fs=require('node:fs');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{const args=process.argv.slice(2);fs.writeFileSync('observed.json',JSON.stringify({input,cwd:process.cwd(),args,env:process.env}));setTimeout(()=>{console.log(JSON.stringify({type:'system',subtype:'init',session_id:args[args.indexOf('--session-id')+1],cwd:process.cwd(),mcp_servers:[{name:'stma_worker',status:'connected'}]}));console.log(JSON.stringify({type:'result',subtype:'success',permission_denials:[]}));},50);});`);
    const observations: RuntimeObservation[] = []; let shell: unknown;
    // Production spawn arguments/options reach a real Node process; only the fake CLI entry is substituted.
    const fakeSpawn = ((executable: string, args: string[], options: any) => { shell = options.shell; return spawn(executable, [fixture, ...args], options); }) as typeof spawn;
    const processHandle = launchWorkerRuntime(input, (event) => observations.push(event), fakeSpawn);
    expect(processHandle.pid).toBeGreaterThan(0);
    expect(await processHandle.completion).toEqual({ code: 0, signal: null });
    const observed = JSON.parse(readFileSync(path.join(root, 'observed.json'), 'utf8'));
    expect(shell).toBe(false); expect(canonicalCheckout(observed.cwd)).toBe(canonicalCheckout(root)); expect(observed.input).toBe(input.prompt);
    expect(observed.args).toEqual(workerRuntimeArguments(input)); expect(observed.args).not.toContain(input.prompt);
    expect(observed.env.CLAUDE_CONFIG_DIR).toBe(input.configDirectory); expect(observed.env.ANTHROPIC_API_KEY).toBe(input.apiKey);
    expect(observed.env.STMA_TOKEN).toBeUndefined(); expect(observed.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(observations).toEqual([{ type: 'started', sessionId: input.sessionId, cwd: observed.cwd, mcpReady: true }, { type: 'result', success: true, denied: false, auth: false, quota: false }]);
  });
  it('never inherits unrelated credentials, provider routing, hook preload or runtime options', () => {
    const env = workerChildEnvironment(launch(temporary()), { PATH: 'safe-path', STMA_TOKEN: 'synthetic-parent', ANTHROPIC_BASE_URL: 'https://wrong.invalid', CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-other', NODE_OPTIONS: '--require ./evil', AWS_SECRET_ACCESS_KEY: 'synthetic-aws' });
    expect(Object.keys(env)).not.toEqual(expect.arrayContaining(['STMA_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'NODE_OPTIONS', 'AWS_SECRET_ACCESS_KEY']));
    const args = workerRuntimeArguments(launch(temporary()));
    expect(args).toContain('--restricted'); expect(args).toContain('dontAsk'); expect(args).not.toContain('--bare'); expect(args.join(' ')).not.toContain('bypassPermissions');
    expect(args[args.indexOf('--allowedTools') + 1]).not.toContain('*');
    expect(JSON.stringify(workerSettings('node pinned.mjs'))).toContain('worker hook --event guard');
  });
  it('does not treat exit text or provider completion as evidence; detects auth, permissions and extra MCP connections', () => {
    expect(parseWorkerRuntimeLine('not-json')).toEqual({ type: 'invalid' });
    expect(parseWorkerRuntimeLine(JSON.stringify({ type: 'result', subtype: 'error_during_execution', errors: ['authentication 401'] }))).toMatchObject({ success: false, auth: true });
    expect(parseWorkerRuntimeLine(JSON.stringify({ type: 'result', subtype: 'success', permission_denials: [{}] }))).toMatchObject({ denied: true });
    expect(parseWorkerRuntimeLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: randomUUID(), cwd: '.', mcp_servers: [{ name: 'stma_worker', status: 'connected' }, { name: 'other', status: 'connected' }] }))).toMatchObject({ mcpReady: false });
  });
});

function setup() {
  const root = canonicalCheckout(temporary()); const directory = temporary(); const targetId = randomUUID(); const attemptId = randomUUID(); const sessionId = randomUUID();
  const config: WorkerConfig = { schema: 1, checkout: root, fingerprint: checkoutFingerprint(root), targetId, installationId: randomUUID(), server: 'https://example.invalid', executable: process.execPath, runtimeVersion: '2.1.278', apiKeyEnv: 'EXPLICIT_PROVIDER_KEY', hookRuntime: path.join(directory, 'runtime.mjs'), maxRuntimeSeconds: 60, maxTurns: 3 };
  const claim = { job: { id: randomUUID(), target_id: targetId, max_turns: 3, max_runtime_seconds: 60, assignment: { task: 'fixture', brief: 'fixture', start_call: {}, branch: null, repository_identity: null } }, attempt: { id: attemptId, fence: 1, provider_session_id: sessionId }, attempt_token: 'synthetic-attempt' };
  const events: any[] = [];
  const request: WorkerRequest = async <T>(endpoint: string, body?: any): Promise<T> => {
    if (endpoint.endsWith('/claim')) return claim as T;
    if (endpoint.endsWith('/heartbeat')) return { cancel_requested: false, lease_expires_at: new Date(Date.now() + 60_000).toISOString() } as T;
    events.push(body); if (['succeeded', 'failed', 'needs_input'].includes(body?.state)) signalWorker(directory, 'stop');
    return { ok: true } as T;
  };
  return { root, directory, config, claim, events, request };
}
describe('durable worker checkout ownership', () => {
  it.skipIf(process.platform === 'win32')('rejects group or other readable state even inside a private worker directory', () => {
    const file = path.join(temporary(), 'hook-state.json');
    writeWorkerJson(file, { started: true, finished: true });
    expect(readWorkerJson(file)).toEqual({ started: true, finished: true });
    for (const mode of [0o640, 0o604]) {
      chmodSync(file, mode);
      expect(() => readWorkerJson(file)).toThrow('Unsafe worker state file.');
    }
  });
  it('backs off boundedly on empty polls without launching a runtime or using attempt credentials', async () => {
    const fixture = setup();
    let claims = 0; let authChecks = 0; let launches = 0;
    const delays: number[] = [];
    const request: WorkerRequest = async <T>(endpoint: string): Promise<T> => {
      expect(endpoint).toBe('/api/agent/worker/claim');
      claims++;
      return { job: null } as T;
    };
    await superviseWorker(fixture.config, fixture.directory, {
      request,
      apiKey: 'synthetic-provider-unused',
      pollMs: 5_000,
      random: () => 0.5,
      wait: async (ms) => {
        delays.push(ms);
        if (delays.length === 5) signalWorker(fixture.directory, 'stop');
      },
      verifyAuth: () => { authChecks++; },
      launch: () => { launches++; throw new Error('must not launch'); },
    });
    expect(claims).toBe(5);
    expect(delays).toEqual([5_250, 10_250, 20_250, 30_250, 30_250]);
    expect(authChecks).toBe(0);
    expect(launches).toBe(0);
    expect(fixture.events).toEqual([]);
    expect(readWorkerJson<WorkerJournal>(path.join(fixture.directory, 'journal.json'))?.phase).toBe('idle');
  });
  it('drives the entire foreground supervisor through a real fake auth process and real coding child, never a provider', async () => {
    const fixture = setup(); const program = path.join(fixture.directory, 'fake-provider.cjs');
    // Match the real hook's private state permissions independently of the CI runner's umask.
    writeFileSync(program, `const fs=require('node:fs'),path=require('node:path');if(process.argv.includes('auth')){console.log(JSON.stringify({authMethod:'api_key',configDirectory:process.env.CLAUDE_CONFIG_DIR}));}else{let task='';process.stdin.on('data',s=>task+=s);process.stdin.on('end',()=>{setTimeout(()=>{const context=JSON.parse(fs.readFileSync(process.env.STMA_WORKER_CONTEXT,'utf8'));fs.writeFileSync(path.join(path.dirname(process.env.STMA_WORKER_CONTEXT),'hook-state.json'),JSON.stringify({started:true,finished:true}),{mode:0o600});console.log(JSON.stringify({type:'system',subtype:'init',session_id:context.sessionId,cwd:process.cwd(),mcp_servers:[{name:'stma_worker',status:'connected'}]}));console.log(JSON.stringify({type:'result',subtype:'success'}));},50);});}`);
    const spawnFake = ((executable: string, args: string[], options: any) => spawn(executable, [program, ...args], options)) as typeof spawn;
    const authFake = ((executable: string, args: string[], options: any) => spawnSync(executable, [program, ...args], options)) as typeof spawnSync;
    await superviseWorker(fixture.config, fixture.directory, { request: fixture.request, apiKey: 'synthetic-provider', preflight: () => {},
      verifyAuth: (input) => verifyWorkerApiAuth(input, authFake), launch: (input, observe) => launchWorkerRuntime(input, observe, spawnFake) });
    expect(fixture.events.map((event) => event.state)).toEqual(['starting', 'running', 'succeeded']);
    expect(readWorkerJson<WorkerJournal>(path.join(fixture.directory, 'journal.json'))?.phase).toBe('terminal');
    expect(existsSync(path.join(fixture.directory, 'owner.lock'))).toBe(false);
  });
  it('rejects subscription, third-party, unknown-schema and mismatched-directory auth without model spawn', () => {
    const input = launch(temporary()); input.configDirectory = input.cwd;
    for (const response of [{ authMethod: 'claude.ai', configDirectory: input.cwd }, { authMethod: 'third_party', configDirectory: input.cwd }, { authMethod: 'api_key' }, { authMethod: 'api_key', configDirectory: temporary() }]) {
      const fake = (() => ({ status: 0, stdout: JSON.stringify(response) })) as unknown as typeof spawnSync;
      expect(() => verifyWorkerApiAuth(input, fake)).toThrow(/not verified/);
    }
  });
  it('does not evict an old or dead PID lock and cannot signal another owner accidentally', () => {
    const directory = temporary(); const owner = randomUUID(); const release = acquireWorkerLock(directory, owner);
    expect(() => acquireWorkerLock(directory, randomUUID())).toThrow(/worker owner/);
    signalWorker(directory, 'pause'); expect(readWorkerJson<any>(path.join(directory, 'control.json'))).toEqual({ owner, command: 'pause' });
    writeWorkerJson(path.join(directory, 'owner.lock'), { owner: 'different-owner', pid: 0 }); release();
    expect(existsSync(path.join(directory, 'owner.lock'))).toBe(true);
  });
  it('requires matching init, clean result, root exit and completed synchronous hooks before release', async () => {
    const fixture = setup();
    await superviseWorker(fixture.config, fixture.directory, { request: fixture.request, apiKey: 'synthetic-provider', preflight: () => {}, verifyAuth: () => {}, launch: (input, observe) => {
      observe({ type: 'started', sessionId: input.sessionId, cwd: input.cwd, mcpReady: true }); observe({ type: 'result', success: true, denied: false, auth: false, quota: false });
      writeWorkerJson(path.join(path.dirname(input.hookContext), 'hook-state.json'), { started: true, finished: true });
      return { pid: 12345, completion: Promise.resolve({ code: 0, signal: null }), stop: () => {} };
    } });
    expect(fixture.events.map((event) => event.state)).toContain('succeeded');
    expect(existsSync(path.join(fixture.directory, 'owner.lock'))).toBe(false);
    expect(readFileSync(path.join(fixture.directory, 'journal.json'), 'utf8')).not.toContain('synthetic-');
    expect(existsSync(path.join(fixture.directory, fixture.claim.attempt.id, 'context.json'))).toBe(false);
  });
  it('quarantines spawn exceptions and never reclaims a possibly running attempt on restart', async () => {
    const fixture = setup(); let launches = 0;
    const dependencies = { request: fixture.request, apiKey: 'synthetic-provider', preflight: () => {}, verifyAuth: () => {}, launch: () => { launches++; throw new Error('ambiguous spawn'); } };
    await superviseWorker(fixture.config, fixture.directory, dependencies);
    expect(readWorkerJson<WorkerJournal>(path.join(fixture.directory, 'journal.json'))?.phase).toBe('quarantined');
    await expect(superviseWorker(fixture.config, fixture.directory, dependencies)).rejects.toThrow(/quarantined/);
    expect(launches).toBe(1); expect(fixture.events.at(-1)).toMatchObject({ state: 'dispatch_unknown', process_stopped: false });
    expect(existsSync(path.join(fixture.directory, fixture.claim.attempt.id, 'context.json'))).toBe(true);
  });
  it('treats root exit without hook completion as descendant ambiguity, not confirmed cancellation', async () => {
    const fixture = setup();
    await superviseWorker(fixture.config, fixture.directory, { request: fixture.request, apiKey: 'synthetic-provider', preflight: () => {}, verifyAuth: () => {}, launch: (input, observe) => {
      observe({ type: 'started', sessionId: input.sessionId, cwd: input.cwd, mcpReady: true }); observe({ type: 'result', success: true, denied: false, auth: false, quota: false });
      return { pid: 12345, completion: Promise.resolve({ code: 0, signal: null }), stop: () => {} };
    } });
    expect(fixture.events.at(-1)).toMatchObject({ state: 'dispatch_unknown', process_stopped: false }); expect(existsSync(path.join(fixture.directory, 'owner.lock'))).toBe(true);
  });
  it('keeps explicit authentication refusal quarantined when synchronous hook shutdown is unproved', async () => {
    const fixture = setup();
    await superviseWorker(fixture.config, fixture.directory, { request: fixture.request, apiKey: 'synthetic-provider', preflight: () => {}, verifyAuth: () => {}, launch: (_input, observe) => {
      observe({ type: 'result', success: false, denied: false, auth: true, quota: false });
      return { completion: Promise.resolve({ code: 1, signal: null }), stop: () => {} };
    } });
    expect(fixture.events.at(-1)).toMatchObject({ state: 'dispatch_unknown', process_stopped: false });
  });
  it('records an unstarted preflight refusal as stopped needs_input without creating a provider process', async () => {
    const fixture = setup(); let spawned = false;
    await superviseWorker(fixture.config, fixture.directory, { request: fixture.request, apiKey: 'synthetic-provider', preflight: () => { throw new Error('Wrong branch'); }, launch: () => { spawned = true; throw new Error('must not spawn'); } });
    expect(spawned).toBe(false); expect(fixture.events.at(-1)).toMatchObject({ state: 'needs_input', process_stopped: true });
    expect(existsSync(path.join(fixture.directory, 'owner.lock'))).toBe(false);
  });
  it('fences exact provider session/cwd mismatch and stops only its live child handle', async () => {
    const fixture = setup(); let stopped = 0; let finish!: (value: { code: number | null; signal: string | null }) => void;
    await superviseWorker(fixture.config, fixture.directory, { request: fixture.request, apiKey: 'synthetic-provider', preflight: () => {}, verifyAuth: () => {}, launch: (input, observe) => {
      observe({ type: 'started', sessionId: randomUUID(), cwd: input.cwd, mcpReady: true });
      return { pid: 12345, completion: new Promise((resolve) => { finish = resolve; }), stop: () => { stopped++; finish({ code: null, signal: 'SIGTERM' }); } };
    } });
    expect(stopped).toBe(1); expect(fixture.events.at(-1)).toMatchObject({ state: 'dispatch_unknown', process_stopped: false });
  });
});
