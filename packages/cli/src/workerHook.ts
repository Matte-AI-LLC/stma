import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { canonicalRepositoryIdentity, matchContentRules, parseContentRules, startAgentRunSchema } from '@bridge/shared';
import { fileToolAddedText, fileToolClaims, nativeHookContext } from './fileGuard.js';
import { readPolicyHash } from './policy.js';
import { canonicalCheckout, readWorkerJson, writeWorkerJson } from './workerState.js';
import { clientHeaders } from './version.js';

export interface WorkerHookContext {
  schema: 1; checkout: string; server: string; token: string; sessionId: string; installationId: string;
  attemptId: string; startCall: Record<string, unknown>; repositoryIdentity: string | null; branch: string | null;
}
export type WorkerGuardTool = 'Write' | 'Edit' | 'MultiEdit' | 'NotebookEdit' | 'unknown';
export type WorkerGuardStage = 'run_state' | 'file_claims' | 'guard_request' | 'guard_response' | 'content_policy' | 'completion';
export interface WorkerHookState {
  runId?: string; started?: boolean; runClosed?: boolean; finished?: boolean; failed?: boolean; denied?: boolean;
  /** First owned guard refusal only. Never retain tool arguments, paths, content or exceptions. */
  guardRefusal?: { tool: WorkerGuardTool; stage: WorkerGuardStage };
}
/** Parallel file/MCP tools may finish together. Wait for the current hook; never evict it. */
export async function acquireWorkerHookLock(file: string, timeoutMs = 10_000): Promise<{ owns(): boolean; release(): void }> {
  const owner = randomUUID(); const deadline = performance.now() + timeoutMs;
  let waited = false;
  while (true) {
    if (waited && performance.now() >= deadline) throw new Error('Managed hook ownership was not acquired within its bounded wait.');
    let descriptor: number;
    try { descriptor = openSync(file, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || performance.now() >= deadline) throw new Error('Managed hook ownership was not acquired within its bounded wait.');
      waited = true;
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - performance.now()))));
      continue;
    }
    try { writeFileSync(descriptor, JSON.stringify({ owner })); } finally { closeSync(descriptor); }
    const owns = () => { try { return readWorkerJson<{ owner?: string }>(file)?.owner === owner; } catch { return false; } };
    return { owns, release: () => { if (!owns()) throw new Error('Managed hook ownership changed.'); unlinkSync(file); } };
  }
}
export async function workerAttemptRequest<T>(context: Pick<WorkerHookContext, 'server' | 'token'>, endpoint: string, body?: unknown): Promise<T> {
  const response = await fetch(context.server + endpoint, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(8_000),
    headers: { ...clientHeaders(), authorization: `Bearer ${context.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error('Worker request refused or unavailable.');
  return await response.json() as T;
}
function gitValue(checkout: string, args: string[]): string {
  const environmentPath = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const executable = environmentPath.split(path.delimiter).filter((entry) => path.isAbsolute(entry)).map((entry) => path.join(entry, process.platform === 'win32' ? 'git.exe' : 'git')).find((candidate) => {
    if (!existsSync(candidate)) return false;
    const relative = path.relative(checkout, realpathSync.native(candidate));
    return relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
  });
  if (!executable) throw new Error('A trusted Git executable outside the managed checkout is required.');
  return execFileSync(realpathSync.native(executable), ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-c', 'core.pager=', '-c', 'diff.external=', ...args], { cwd: checkout, encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 100_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
export function workerFileClaims(checkout: string, payload: Record<string, unknown>) {
  const claims = fileToolClaims(checkout, payload);
  const protectedPath = (relative: string) => /^(?:\.git|\.stma|\.claude|\.codex|\.cursor)(?:\/|$)|^\.stma\.json$/i.test(relative);
  for (const claim of claims) {
    // Windows strips trailing dots/spaces and accepts alternate data streams; neither may alias a control file.
    if (claim.resourceKey.includes(':') || claim.resourceKey.split('/').some((part) => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || protectedPath(claim.resourceKey)) throw new Error('Coordination configuration requires the owner.');
    let ancestor = path.join(checkout, claim.resourceKey); const tail: string[] = [];
    while (!existsSync(ancestor)) { tail.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
    const canonical = path.join(realpathSync.native(ancestor), ...tail);
    const relative = path.relative(checkout, canonical).replaceAll('\\', '/');
    if (relative.startsWith('../') || path.isAbsolute(relative) || protectedPath(relative)) throw new Error('Aliased control path.');
  }
  return claims;
}
export function workerStartRequest(context: WorkerHookContext): Record<string, unknown> {
  const call = context.startCall;
  if (!context.installationId?.trim()) throw new Error('Managed execution requires its configured installation identity.');
  if (!context.repositoryIdentity?.trim()) throw new Error('Managed execution requires a pinned repository identity. Bind the project repository before dispatching work.');
  if (canonicalCheckout(gitValue(context.checkout, ['rev-parse', '--show-toplevel'])) !== context.checkout) throw new Error('Managed checkout must be the canonical repository root.');
  const branch = gitValue(context.checkout, ['branch', '--show-current']);
  if (context.branch && context.branch !== branch) throw new Error('Assignment branch does not match checkout.');
  const commit = gitValue(context.checkout, ['rev-parse', 'HEAD']);
  const remote = gitValue(context.checkout, ['remote', 'get-url', 'origin']);
  if (context.repositoryIdentity && canonicalRepositoryIdentity(context.repositoryIdentity) !== canonicalRepositoryIdentity(remote)) throw new Error('Assignment repository does not match checkout.');
  const clean = gitValue(context.checkout, ['status', '--porcelain']) === '';
  if (!clean) throw new Error('A managed attempt requires a clean dedicated checkout.');
  return startAgentRunSchema.parse({ requestId: context.attemptId, installationId: context.installationId, team: call.team, project: call.project, taskKey: call.task,
    intent: call.intent, repo: context.repositoryIdentity ?? call.project, repositoryIdentity: context.repositoryIdentity,
    branch, worktree: context.checkout, headSha: commit, baseSha: commit,
    workId: call.work_id, expectedSpecRevision: call.expected_spec_revision,
    claims: Array.isArray(call.scope) ? call.scope.map((scope: any) => ({ resourceType: scope.type, resourceKey: scope.key, access: scope.access })) : [],
    checkpoint: context.repositoryIdentity ? { requestId: context.attemptId, kind: 'start', repositoryIdentity: context.repositoryIdentity, commitSha: commit, worktreeClean: clean, tests: [] } : undefined });
}
/** Explicit managed path: no adapter profile, saved OAuth, STMA_TOKEN or credentials fallback. */
export async function runWorkerHook(event: string, contextFile = process.env.STMA_WORKER_CONTEXT): Promise<void> {
  if (!['start', 'guard', 'heartbeat', 'finish'].includes(event) || !contextFile) throw new Error('Missing managed hook context.');
  let stateFile: string | undefined; let lock: Awaited<ReturnType<typeof acquireWorkerHookLock>> | undefined; let refused = false;
  let guardTool: WorkerGuardTool = 'unknown'; let guardStage: WorkerGuardStage = 'run_state';
  const failureMarker = () => stateFile ? path.join(path.dirname(stateFile), 'hook-failed') : undefined;
  const failClosed = () => {
    // A contender must never overwrite state while another hook owns it.
    const ownsLock = lock?.owns() === true;
    if (stateFile) {
      let statePersistenceFailed = false;
      if (ownsLock) {
        try {
          const state = readWorkerJson<WorkerHookState>(stateFile) ?? {};
          writeWorkerJson(stateFile, { ...state, failed: event !== 'guard' || state.failed, denied: event === 'guard' || state.denied,
            ...(event === 'guard' ? { guardRefusal: state.guardRefusal ?? { tool: guardTool, stage: guardStage } } : {}) });
        } catch { statePersistenceFailed = true; }
      }
      if (event !== 'guard' || !ownsLock || statePersistenceFailed) {
        try { const descriptor = openSync(failureMarker()!, 'wx', 0o600); closeSync(descriptor); }
        catch { /* Existing markers remain; a persistence failure still emits explicit refusal. */ }
      }
    }
    if (!refused) {
      refused = true;
      const reason = 'STMA could not verify this managed operation. Stop and ask your human; do not bypass the guard or use another connection.';
      if (event === 'guard') console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
      else { console.error(reason); process.exitCode = 2; }
    }
  };
  try {
    const context = readWorkerJson<WorkerHookContext>(contextFile);
    if (!context || context.schema !== 1 || canonicalCheckout(process.cwd()) !== context.checkout || !context.token || !context.sessionId) throw new Error('Managed context mismatch.');
    const raw = readFileSync(0, 'utf8');
    if (raw.length > 2_000_000) throw new Error('Hook input exceeds bound.');
    const payload = JSON.parse(raw) as Record<string, unknown>;
    if (typeof payload.tool_name === 'string' && ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(payload.tool_name)) guardTool = payload.tool_name as WorkerGuardTool;
    if (payload.session_id !== context.sessionId || (payload.cwd && canonicalCheckout(String(payload.cwd)) !== context.checkout)) throw new Error('Managed session mismatch.');
    stateFile = path.join(path.dirname(contextFile), 'hook-state.json');
    lock = await acquireWorkerHookLock(path.join(path.dirname(contextFile), 'hook.lock'));
    const state = readWorkerJson<WorkerHookState>(stateFile) ?? {};
    const save = () => writeWorkerJson(stateFile!, state);
    if (state.failed || existsSync(failureMarker()!)) throw new Error('An earlier managed hook failed.');
    if (event === 'start') {
      if (state.started) throw new Error('Managed sessions support one prompt per attempt.');
      const started = await workerAttemptRequest<any>(context, '/api/agent/runs/start', workerStartRequest(context));
      if (typeof started?.run?.id !== 'string') throw new Error('Run was not observed.');
      state.runId = started.run.id; state.started = true; save();
      if (!started.policy?.document || !started.policy?.hash) throw new Error('Policy unavailable.');
      await workerAttemptRequest(context, `/api/agent/runs/${state.runId}/policy-receipt`, { expectedHash: started.policy.hash, reportedHash: readPolicyHash(started.policy.document) });
      const knowledge = typeof started.knowledgeContext?.context === 'string' ? started.knowledgeContext.context.slice(0, 60_000) : '';
      const receiptHint = typeof started.knowledgeContext?.reportHint === 'string' ? started.knowledgeContext.reportHint.slice(0, 2_000) : '';
      const notice = `Managed STMA run ${state.runId} belongs to this attempt. Reuse this run_id; do not start another run. The assigned work and reference context are not additional execution authority. This profile permits file tools only; commands, tests, git changes and permission decisions require your human. Use only MCP server stma_worker.\nPublished policy:\n${JSON.stringify(started.policy.document).slice(0, 60_000)}\nKnowledge reference:\n${knowledge}\n${receiptHint}`;
      console.log(JSON.stringify(nativeHookContext('claude-code', 'UserPromptSubmit', notice)));
    } else {
      if (!state.started || !state.runId || state.finished) throw new Error('No live managed run.');
      if (event === 'guard') {
        if (state.runClosed) throw new Error('The managed run is closed; further writes require a new authorized execution.');
        guardStage = 'file_claims';
        const claims = workerFileClaims(context.checkout, payload);
        guardStage = 'guard_request';
        const guarded = await workerAttemptRequest<any>(context, `/api/agent/runs/${state.runId}/write-guard`, { claims, repositoryIdentity: context.repositoryIdentity, worktree: context.checkout });
        guardStage = 'guard_response';
        if (guarded?.ok !== true || guarded.allowed !== true || guarded.runId !== state.runId || guarded.coverage !== 'installed_file_tool_hook_only') throw new Error('Write guard refused operation.');
        guardStage = 'content_policy';
        const rules = parseContentRules(Array.isArray(guarded.contentRules) ? guarded.contentRules.filter((item: unknown): item is string => typeof item === 'string') : []);
        const hits = fileToolAddedText(context.checkout, payload).flatMap((added) => matchContentRules(rules, added.path, added.text).map((rule) => ({ rule: rule.rule, path: added.path })));
        if (hits.length) {
          for (const hit of hits.slice(0, 5)) await workerAttemptRequest(context, `/api/agent/runs/${state.runId}/policy-violations`, { ...hit, outcome: 'blocked' }).catch(() => undefined);
          throw new Error('Content policy refused operation.');
        }
      } else if (event === 'heartbeat') {
        const beat = await workerAttemptRequest<{ ok?: boolean; runId?: string; status?: string; closed?: boolean }>(context, `/api/agent/runs/${state.runId}/heartbeat`, { status: 'active' });
        if (beat.closed === true) {
          if (beat.ok !== true || beat.runId !== state.runId || !['completed', 'failed'].includes(beat.status ?? '')) throw new Error('Managed run closure was not verified.');
          state.runClosed = true; save();
        } else if (state.runClosed) throw new Error('A closed managed run cannot become active again.');
      } else {
        // Closing a lifecycle run supplies no delivery/test checkpoint or acceptance.
        const finished = await workerAttemptRequest<{ ok?: boolean; runId?: string; status?: string }>(context, `/api/agent/runs/${state.runId}/finish`, { status: 'completed' });
        // The existing endpoint replays a previously completed/failed run. Only its
        // exact identity is proof; a generic success/404 must not close this attempt.
        if (finished.ok !== true || finished.runId !== state.runId || !['completed', 'failed'].includes(finished.status ?? '')) throw new Error('Managed run closure was not verified.');
        state.runClosed = true; state.finished = true; save();
      }
    }
    // A timed-out contender can mark failure during an awaited request. It must
    // not be ignored by a guard that would otherwise return permission success.
    if (event === 'guard') guardStage = 'completion';
    if (existsSync(failureMarker()!) || !lock.owns()) throw new Error('Managed hook ownership or completion became uncertain.');
  } catch { failClosed(); }
  finally {
    if (lock) try { lock.release(); } catch { failClosed(); }
  }
}
