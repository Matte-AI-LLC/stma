import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installAdapter, mergeAdapterHooks } from '../../cli/src/adapters';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('native lifecycle adapters', () => {
  it('preserves unrelated hooks and replaces its own definition idempotently', () => {
    const first = mergeAdapterHooks(
      'codex',
      {
        hooks: {
          PostToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'company-audit' }] },
          ],
        },
      },
      'stma',
    );
    const second = mergeAdapterHooks('codex', first, 'stma');

    expect(second.hooks.PostToolUse).toHaveLength(2);
    expect(JSON.stringify(second)).toContain('company-audit');
    expect(JSON.stringify(second).match(/adapter hook --event heartbeat/g)).toHaveLength(1);
    expect(second.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
      'stma adapter hook --event start',
    );
  });

  it('uses each client native schema without writing during dry run', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'stma-adapter-'));
    temporaryRoots.push(root);

    for (const target of ['claude-code', 'codex', 'cursor'] as const) {
      const result = installAdapter({
        root,
        command: 'npm run cli --',
        apply: false,
        config: {
          schemaVersion: 1,
          target,
          team: 'acme',
          project: 'payments',
          agentName: `alice-${target}`,
          applyPolicy: true,
          preflight: true,
        },
      });
      expect(JSON.stringify(result.hooks)).toContain('adapter hook --event start');
      expect(() => readFileSync(result.hookPath)).toThrow();
    }
  });

  it('merges into an existing Cursor project config when applied', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'stma-adapter-'));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, '.cursor'), { recursive: true });
    writeFileSync(
      path.join(root, '.cursor', 'hooks.json'),
      JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: 'formatter' }] } }),
    );

    const result = installAdapter({
      root,
      command: 'stma',
      apply: true,
      config: {
        schemaVersion: 1,
        target: 'cursor',
        team: 'acme',
        project: 'payments',
        agentName: 'alice-cursor',
        applyPolicy: true,
        preflight: true,
      },
    });
    const hooks = JSON.parse(readFileSync(result.hookPath, 'utf8'));
    const adapter = JSON.parse(readFileSync(result.adapterPath, 'utf8'));

    expect(hooks.hooks.afterFileEdit[0].command).toBe('formatter');
    expect(hooks.hooks.beforeSubmitPrompt[0].command).toContain('adapter hook --event start');
    expect(adapter).toMatchObject({ target: 'cursor', team: 'acme', project: 'payments' });
  });
});
