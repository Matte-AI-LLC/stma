import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  adapterDeliveryStatus,
  adapterProfileIds,
  adapterProfilePaths,
  atomicWriteJson,
  enqueueHookEvent,
  installAdapter,
  loadAdapterProfile,
  mergeAdapterHooks,
  migrateLegacyProfile,
  normalizeProfileId,
  readQueuedHookEvents,
  removeAdapterHooks,
  repairProfileOutbox,
  uninstallAdapter,
  type AdapterConfig,
  type QueuedHookEvent,
} from '../../cli/src/adapters';
import {
  buildNativeHeartbeatRequest,
  buildNativeStartRequest,
  hookQuota,
  isCliEntrypoint,
  manualStartIdentity,
  mcpEntryLoads,
  quotaFlags,
} from '../../cli/src/index';

const temporaryRoots: string[] = [];

function config(
  profileId: string,
  options: Partial<AdapterConfig> = {},
): AdapterConfig {
  return {
    schemaVersion: 2,
    profileId,
    target: 'codex',
    team: 'acme',
    project: 'payments',
    agentName: profileId,
    role: 'implementer',
    applyPolicy: false,
    preflight: false,
    ...options,
  };
}

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
      'payments-implementer',
    );
    const second = mergeAdapterHooks('codex', first, 'stma', 'payments-implementer');
    const third = mergeAdapterHooks('codex', second, 'stma', 'payments-reviewer');

    expect(third.hooks.PostToolUse).toHaveLength(3);
    expect(JSON.stringify(third)).toContain('company-audit');
    expect(JSON.stringify(third).match(/adapter hook --event heartbeat/g)).toHaveLength(2);
    expect(third.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
      'stma adapter hook --event start --profile payments-implementer',
    );
    expect(JSON.stringify(removeAdapterHooks('codex', third, 'payments-implementer'))).not.toContain(
      '--profile payments-implementer',
    );
    expect(JSON.stringify(removeAdapterHooks('codex', third, 'payments-implementer'))).toContain(
      '--profile payments-reviewer',
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

  it('rejects ambiguous same-client profiles and preserves other vendors on disconnect', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'stma-adapter-'));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, '.codex'), { recursive: true });
    writeFileSync(
      path.join(root, '.codex', 'hooks.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'human-cleanup' }] }] } }),
    );

    installAdapter({ root, command: 'stma', apply: true, config: config('payments-implementer') });
    expect(() => installAdapter({
      root,
      command: 'stma',
      apply: true,
      config: config('storefront-reviewer', { project: 'storefront', role: 'reviewer' }),
    })).toThrow(/two profiles would misattribute/);
    installAdapter({
      root,
      command: 'stma',
      apply: true,
      config: config('claude-payments-reviewer', { target: 'claude-code', role: 'reviewer' }),
    });

    expect(adapterProfileIds(root)).toEqual([
      'claude-payments-reviewer',
      'payments-implementer',
    ]);
    const before = readFileSync(path.join(root, '.codex', 'hooks.json'), 'utf8');
    expect(before).toContain('--profile payments-implementer');
    expect(before).not.toContain('--profile storefront-reviewer');
    expect(before).toContain('human-cleanup');

    uninstallAdapter({ root, profileId: 'payments-implementer', apply: true });
    const after = readFileSync(path.join(root, '.codex', 'hooks.json'), 'utf8');
    expect(after).not.toContain('--profile payments-implementer');
    expect(after).not.toContain('--profile storefront-reviewer');
    expect(after).toContain('human-cleanup');
    expect(loadAdapterProfile(root, 'storefront-reviewer')).toBeUndefined();
    expect(loadAdapterProfile(root, 'claude-payments-reviewer')?.config.target).toBe('claude-code');
  });

  it('copies legacy config, state and outbox safely and idempotently', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'stma-adapter-'));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, '.stma'), { recursive: true });
    const legacy = config('ignored', { schemaVersion: 1, profileId: undefined });
    writeFileSync(path.join(root, '.stma', 'adapter.json'), JSON.stringify(legacy));
    writeFileSync(path.join(root, '.stma', 'local.json'), JSON.stringify({ installationId: randomUUID() }));
    const event: QueuedHookEvent = {
      id: randomUUID(),
      event: 'start',
      payload: { session_id: 'legacy-session' },
      queuedAt: '2026-09-04T10:00:00.000Z',
    };
    writeFileSync(path.join(root, '.stma', 'outbox.json'), JSON.stringify([event]));

    const first = migrateLegacyProfile(root);
    expect(first.migrated).toBe(true);
    expect(first.profile?.source).not.toBe('legacy');
    expect(existsSync(path.join(root, '.stma', 'adapter.json'))).toBe(true);
    expect(readQueuedHookEvents(root, first.profile!.id).events.map((item) => item.event.id)).toEqual([
      event.id,
    ]);
    expect(existsSync(adapterProfilePaths(root, first.profile!.id).statePath)).toBe(true);

    const second = migrateLegacyProfile(root);
    expect(second.migrated).toBe(false);
    expect(readQueuedHookEvents(root, first.profile!.id).events).toHaveLength(1);
  });

  it('uses per-event durable writes, reports overflow and quarantines corruption', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'stma-adapter-'));
    temporaryRoots.push(root);
    const profile = 'concurrent-profile';
    const events = Array.from({ length: 20 }, (_, index): QueuedHookEvent => ({
      id: randomUUID(),
      event: 'heartbeat',
      payload: { index },
      queuedAt: new Date(1_000 + index).toISOString(),
    }));
    await Promise.all(
      events.map(
        (event) =>
          new Promise<void>((resolve) =>
            setImmediate(() => {
              enqueueHookEvent(root, profile, event, 20);
              resolve();
            }),
          ),
      ),
    );
    expect(readQueuedHookEvents(root, profile).events).toHaveLength(20);
    expect(enqueueHookEvent(root, profile, events[0]!, 20).queued).toBe(true);
    expect(readQueuedHookEvents(root, profile).events).toHaveLength(20);

    const overflow = enqueueHookEvent(
      root,
      profile,
      { id: randomUUID(), event: 'finish', payload: {}, queuedAt: new Date().toISOString() },
      20,
    );
    expect(overflow).toMatchObject({ queued: false, pendingEvents: 20, droppedEvents: 1 });
    expect(adapterDeliveryStatus(root, profile).lastOverflowAt).toBeTruthy();

    const paths = adapterProfilePaths(root, profile);
    writeFileSync(path.join(paths.outboxDirectory, '0000000000000-corrupt.json'), '{');
    expect(adapterDeliveryStatus(root, profile).corruptEvents).toEqual([
      '0000000000000-corrupt.json',
    ]);
    const repaired = repairProfileOutbox(root, profile);
    expect(repaired.quarantinedEvents).toEqual(['0000000000000-corrupt.json']);
    expect(adapterDeliveryStatus(root, profile).corruptEvents).toEqual([]);
  });

  it('leaves the current event queued when the network is unavailable', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'stma-adapter-'));
    temporaryRoots.push(root);
    installAdapter({ root, command: 'stma', apply: true, config: config('offline-profile') });
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(
          path.join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs'),
        ).href,
        path.join(repositoryRoot, 'packages', 'cli', 'src', 'index.ts'),
        'adapter',
        'hook',
        '--event',
        'start',
        '--profile',
        'offline-profile',
      ],
      {
        cwd: root,
        input: JSON.stringify({ session_id: 'offline-session', prompt: 'work offline' }),
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          STMA_URL: 'http://127.0.0.1:1',
          STMA_TOKEN: 'stma_' + 'a'.repeat(40),
        },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('lifecycle event(s) pending');
    expect(readQueuedHookEvents(root, 'offline-profile').events).toHaveLength(1);
  });

  it('builds stable start identity, observed native claims and measured quota provenance', () => {
    const adapter = config('native-reviewer', { role: 'reviewer' }) as AdapterConfig & {
      schemaVersion: 2;
      profileId: string;
    };
    const eventId = randomUUID();
    const installationId = randomUUID();
    const git = {
      repo: 'payments',
      branch: 'feat/review',
      baseSha: 'a'.repeat(40),
      worktree: '/workspace/payments',
    };
    const claims = [{ resourceType: 'path' as const, resourceKey: 'src/pay.ts', access: 'write' as const }];
    const first = buildNativeStartRequest(
      adapter,
      eventId,
      installationId,
      { prompt: 'review payments' },
      git,
      claims,
    );
    const replay = buildNativeStartRequest(
      adapter,
      eventId,
      installationId,
      { prompt: 'review payments' },
      git,
      claims,
    );
    expect(replay).toEqual(first);
    expect(first).toMatchObject({ requestId: eventId, installationId, claims });

    expect(
      buildNativeHeartbeatRequest(
        { usage: { usedPct: 76, source: 'measured', label: 'Codex 5h' } },
        claims,
      ),
    ).toMatchObject({
      claimSource: 'observed',
      claims,
      usage: { usedPct: 76, source: 'measured', label: 'Codex 5h' },
    });
  });

  it('freezes a manual start identity before networking and refuses ambiguous replacement', () => {
    const request = {
      installationId: randomUUID(),
      team: 'acme',
      project: 'payments',
      taskKey: 'PAY-142',
      claims: [{ resourceType: 'path', resourceKey: 'src/payments', access: 'write' }],
    };
    const first = manualStartIdentity(undefined, request);
    const pending = {
      ...first,
      request: { ...request, requestId: first.requestId },
      createdAt: '2026-09-04T10:00:00.000Z',
    };
    expect(manualStartIdentity(pending, request)).toEqual({ ...first, replayed: true });
    expect(() => manualStartIdentity(pending, { ...request, taskKey: 'PAY-143' })).toThrow(
      /may have reached the server/,
    );
    expect(() => manualStartIdentity(pending, request, randomUUID())).toThrow(/could duplicate/);
  });

  it('recognizes the installed npm bin symlink as the CLI entrypoint', (context) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'stma-cli-entry-'));
    temporaryRoots.push(root);
    const target = path.join(root, 'dist-index.js');
    const bin = path.join(root, 'stma');
    writeFileSync(target, '#!/usr/bin/env node\n');
    try {
      symlinkSync(target, bin);
    } catch (error) {
      // Windows refuses symlinks unless Developer Mode is on or the session is
      // elevated, and npm installs a .cmd shim there rather than a symlink. The
      // CI runner happens to be elevated; an ordinary Windows checkout is not,
      // and a suite that cannot pass on the user's own machine is not a gate.
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      context.skip();
      return;
    }
    expect(isCliEntrypoint(pathToFileURL(target).href, bin)).toBe(true);
    expect(isCliEntrypoint(pathToFileURL(target).href, path.join(root, 'missing'))).toBe(false);
  });

  it('normalizes profile ids without allowing path traversal', () => {
    expect(normalizeProfileId('Codex / Ödeme Reviewer')).toBe('codex-odeme-reviewer');
    expect(normalizeProfileId('../../another profile')).toBe('another-profile');
    expect(() => normalizeProfileId('///')).toThrow(/letter or number/);
    const root = mkdtempSync(path.join(os.tmpdir(), 'stma-adapter-'));
    temporaryRoots.push(root);
    const file = adapterProfilePaths(root, '../../escape').adapterPath;
    expect(file.startsWith(path.join(root, '.stma', 'profiles') + path.sep)).toBe(true);
    atomicWriteJson(file, { safe: true });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ safe: true });
  });

  it('carries explicit quota provenance and defaults unknown sources to estimate', () => {
    expect(
      hookQuota({
        usage: {
          used_pct: 81,
          resets_at: '2026-09-04T15:00:00.000Z',
          label: 'Codex 5h',
          source: 'measured',
        },
      }),
    ).toEqual({
      usedPct: 81,
      resetsAt: '2026-09-04T15:00:00.000Z',
      label: 'Codex 5h',
      source: 'measured',
    });
    expect(hookQuota({}, { STMA_USED_PCT: '82' })).toMatchObject({
      usedPct: 82,
      source: 'estimate',
    });
    expect(
      hookQuota({}, { STMA_USED_PCT: '83', STMA_QUOTA_SOURCE: 'measured' }),
    ).toMatchObject({ usedPct: 83, source: 'measured' });
    expect(
      quotaFlags(
        new Map([
          ['used-pct', ['84']],
          ['quota-source', ['measured']],
        ]),
      ),
    ).toMatchObject({ usedPct: 84, source: 'measured' });
    expect(quotaFlags(new Map([['used-pct', ['85']]]))).toMatchObject({
      usedPct: 85,
      source: 'estimate',
    });
  });
});

/**
 * Half a disconnect leaves the hooks, the profile and the credential in place
 * and takes the MCP entry away.
 *
 * It happened for real on 2026-09-19: Kaspersky killed `adapter disconnect`
 * partway through, the process died before the request and before the local
 * removal, and only the separate `claude mcp remove` took effect. The checkout
 * kept firing hooks whose own text names a server the client no longer loads,
 * and `adapter doctor` said OK.
 */
describe('a checkout whose MCP entry is gone while its hooks remain', () => {
  const claudeState = { mcpAlias: 'stma-parcel-a1b2', clientType: 'claude-code' };

  it('says so when the client ran and could not find the entry', () => {
    expect(mcpEntryLoads(claudeState, () => ({ status: 1 }))).toBe(false);
    expect(mcpEntryLoads(claudeState, () => ({ status: 0 }))).toBe(true);
  });

  it('answers nothing rather than a verdict when it could not ask', () => {
    // A null status is a binary that is not there, which is not the same answer
    // as a binary that ran and found nothing. Doctor reports what it checked.
    expect(mcpEntryLoads(claudeState, () => ({ status: null }))).toBeUndefined();
    // An older profile has no recorded alias; there is nothing to look for.
    expect(mcpEntryLoads({ clientType: 'claude-code' }, () => ({ status: 1 }))).toBeUndefined();
    expect(mcpEntryLoads(undefined, () => ({ status: 1 }))).toBeUndefined();
    // A client whose entries this CLI does not manage.
    expect(mcpEntryLoads({ mcpAlias: 'stma-x', clientType: 'cursor' }, () => ({ status: 1 }))).toBeUndefined();
    // An alias that is not one is never interpolated into a command.
    expect(mcpEntryLoads({ mcpAlias: 'rm -rf /', clientType: 'claude-code' }, () => ({ status: 1 }))).toBeUndefined();
  });

  it('reads the Codex entry out of the config file that client actually loads', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'stma-doctor-codex-'));
    temporaryRoots.push(home);
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      const state = { mcpAlias: 'stma-parcel', clientType: 'codex' };
      // No config at all is not a verdict either: Codex may simply never have
      // been run on this machine.
      expect(mcpEntryLoads(state)).toBeUndefined();

      mkdirSync(home, { recursive: true });
      writeFileSync(path.join(home, 'config.toml'), '[mcp_servers.something-else]\nurl = "https://elsewhere.invalid/mcp"\n');
      expect(mcpEntryLoads(state)).toBe(false);

      writeFileSync(
        path.join(home, 'config.toml'),
        '[mcp_servers.stma-parcel]\nurl = "https://stma.example/mcp"\n',
      );
      expect(mcpEntryLoads(state)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });
});
