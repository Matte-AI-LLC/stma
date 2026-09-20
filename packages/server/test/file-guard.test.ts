import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { fileToolClaims, nativeHookContext, retainedHookPayload, hookSessionIdentity } from '../../cli/src/fileGuard';
import { mergeAdapterHooks } from '../../cli/src/adapters';
import { safeRepositoryRemote } from '../../cli/src/index';
const roots: string[] = [];
const root = () => { const p = mkdtempSync(path.join(tmpdir(), 'stma-file-guard-')); roots.push(p); return p; };
it('removes Git URL credentials, queries and fragments before tracking', () => {
  expect(safeRepositoryRemote('https://user:private@github.com/example/repo.git?token=private#private')).toBe('https://github.com/example/repo.git');
  expect(safeRepositoryRemote('git@github.com:example/repo.git')).toBe('ssh://github.com/example/repo.git');
  expect(safeRepositoryRemote('/private/local-repo')).toBeUndefined();
});
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });

it('extracts all edit, delete, add and move paths, never their source text', () => {
  const p = root();
  const claims = fileToolClaims(p, { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: src/a.js\n*** Move to: src/b.js\n+private source text\n*** Delete File: old.js\n*** Add File: new.js\n*** End Patch' } });
  expect(claims.map((c) => c.resourceKey)).toEqual(['src/a.js', 'src/b.js', 'old.js', 'new.js']);
  expect(JSON.stringify(claims)).not.toContain('private source');
  expect(fileToolClaims(p, { tool_name: 'Write', tool_input: { file_path: path.join(p, 'new.js'), content: 'private source' } })).toEqual([{ resourceType: 'path', resourceKey: 'new.js', access: 'write' }]);
});
it('rejects unknown tools, malformed paths, traversal and coordination settings', () => {
  const p = root();
  for (const file of ['../outside.js', '.stma/runtime.mjs', '.git/config', '*.js']) expect(() => fileToolClaims(p, { tool_name: 'Write', tool_input: { file_path: file } })).toThrow();
  expect(() => fileToolClaims(p, { tool_name: 'Bash', tool_input: { command: 'anything' } })).toThrow();
  expect(() => fileToolClaims(p, { tool_name: 'apply_patch', tool_input: { command: 'not a patch' } })).toThrow();
});
it.skipIf(process.platform === 'win32')('rejects dangling symlinks as well as live aliased directories', () => {
  const p = root(); const outside = root();
  symlinkSync(path.join(outside, 'not-created'), path.join(p, 'dangling'));
  mkdirSync(path.join(outside, 'directory'));
  symlinkSync(path.join(outside, 'directory'), path.join(p, 'linked'));
  for (const file of ['dangling', 'linked/new.js']) expect(() => fileToolClaims(p, { tool_name: 'Write', tool_input: { file_path: file } })).toThrow();
});
it('retains only reported session identity, never prompt, tool input, output or transcript', () => {
  const payload = { session_id: 'a', agent_id: 'child', hook_event_name: 'PostToolUse', prompt: 'secret prompt', tool_input: { content: 'secret input' }, tool_response: 'secret output', transcript_path: '/private/transcript' };
  expect(retainedHookPayload(payload)).toEqual({ session_id: 'a', agent_id: 'child', hook_event_name: 'PostToolUse' });
  expect(hookSessionIdentity(payload)).not.toBe(hookSessionIdentity({ session_id: 'a', agent_id: 'other' }));
  expect(() => hookSessionIdentity({})).toThrow(/session identity/);
});
it('uses event-correct model context and installs a synchronous deny-capable hook', () => {
  for (const target of ['codex', 'claude-code'] as const) {
    expect(nativeHookContext(target, 'PostToolUse', 'Notice')).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'Notice' } });
    const hooks = mergeAdapterHooks(target, {}, 'stma', 'local', { writeGuard: true }).hooks;
    expect(hooks.PreToolUse[0].hooks[0].command).toContain('--event guard');
    expect(hooks.PreToolUse[0].hooks[0].async).toBeUndefined();
    expect(hooks.Stop[0].hooks[0].command).toContain('--event heartbeat');
    expect(hooks.SessionEnd[0].hooks[0].command).toContain('--event finish');
  }
});
