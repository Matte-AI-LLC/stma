import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { installAdapter, uninstallAdapter } from '../../cli/src/adapters';
import { checkNativeRuntime, nativeHookCommand, prepareNativeRuntime } from '../../cli/src/nativeInstall';
import { windowsDirectoryRefusal, windowsPrivateDirectory } from '../../cli/src/windowsAcl';

const roots: string[] = [];
const originalHome = process.env.HOME;

afterEach(() => {
  process.env.HOME = originalHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporary(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function checkout(parent: string): string {
  const directory = path.join(parent, 'parcel desk');
  mkdirSync(directory, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(path.join(directory, 'README.md'), 'fixture\n');
  git('add', 'README.md');
  git('commit', '-m', 'Fixture baseline');
  return directory;
}

function runtimeSource(parent: string): string {
  const file = path.join(parent, 'runtime.mjs');
  writeFileSync(file, "console.log('stma-runtime ' + process.argv.slice(2).join(' '));\n");
  return file;
}

it('quotes POSIX hook commands and gives Windows one spelling that bash and PowerShell both read', () => {
  expect(nativeHookCommand('darwin', '/opt/node/bin/node', "/Users/ada/it's/.stma/runtime-a.mjs"))
    .toBe("'/opt/node/bin/node' '/Users/ada/it'\\''s/.stma/runtime-a.mjs'");
  expect(nativeHookCommand('win32', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\Ada Lovelace\\parcel desk\\.stma\\runtime-a.mjs'))
    .toBe('node "C:/Users/Ada Lovelace/parcel desk/.stma/runtime-a.mjs"');
  for (const unsafe of ['C:\\Users\\$ada\\p', 'C:\\Users\\a"b\\p', 'C:\\Users\\%TEMP%\\p', 'C:\\Users\\a`b\\p']) {
    expect(() => nativeHookCommand('win32', 'node.exe', unsafe)).toThrow(/without quotes/);
  }
});

it('keeps ownership detection for a Windows hook command whose path contains spaces', () => {
  const root = temporary('stma-native-owner-');
  const command = 'node "C:/Users/Ada Lovelace/parcel desk/.stma/runtime-a.mjs"';
  const config = {
    schemaVersion: 2 as const, target: 'claude-code' as const, team: 'lab', project: 'parcel',
    agentName: 'win-agent', profileId: 'win', applyPolicy: false, preflight: false, writeGuard: true,
  };
  installAdapter({ root, config, command, apply: true });
  const settings = readFileSync(path.join(root, '.claude', 'settings.local.json'), 'utf8');
  expect(settings).toContain('node \\"C:/Users/Ada Lovelace/parcel desk/.stma/runtime-a.mjs\\" adapter hook --event start --profile win');
  uninstallAdapter({ root, profileId: 'win', apply: true });
  expect(readFileSync(path.join(root, '.claude', 'settings.local.json'), 'utf8')).not.toContain('adapter hook');
});

it.skipIf(process.platform === 'win32')('refuses dev sources and non-root checkouts before any write', () => {
  const parent = temporary('stma-native-check-');
  const directory = checkout(parent);
  const source = runtimeSource(parent);
  expect(() => checkNativeRuntime(directory, path.join(parent, 'index.ts'))).toThrow(/standalone JavaScript/);
  mkdirSync(path.join(directory, 'src'));
  expect(() => checkNativeRuntime(path.join(directory, 'src'), source)).toThrow(/checkout root/);
  expect(existsSync(path.join(directory, '.stma'))).toBe(false);
});

it.skipIf(process.platform === 'win32')('pins a Windows checkout wherever it lives, without POSIX ownership checks', () => {
  // The location of a checkout says nothing about its Windows ACL, so a path
  // outside the user profile must work; windowsAcl.ts owns the real boundary.
  const outside = temporary('stma-native-outside-');
  const source = runtimeSource(outside);
  const owned = checkout(outside);
  checkNativeRuntime(owned, source, 'win32');
  const command = prepareNativeRuntime(owned, source, 'claude-code', 'win32');
  expect(command).toMatch(/^node "[^"]*\/parcel desk\/\.stma\/runtime-[a-f0-9]{64}\.mjs"$/);
  const exclude = readFileSync(path.join(owned, '.git', 'info', 'exclude'), 'utf8').split(/\r?\n/);
  expect(exclude).toEqual(expect.arrayContaining(['/.stma/', '/.claude/settings.local.json']));
  // Pinning again is idempotent and still verifies the stored runtime hash.
  expect(prepareNativeRuntime(owned, source, 'claude-code', 'win32')).toBe(command);
});

it('reads a Windows permission verdict into one actionable sentence', () => {
  expect(windowsDirectoryRefusal('C:/repo/.stma', { ok: true, tightened: true })).toBeUndefined();
  expect(windowsDirectoryRefusal('C:/repo/.stma', { ok: false, reason: 'owned_by_another_account', owner: 'S-1-5-21-9-1001' }))
    .toContain('belongs to another Windows account (S-1-5-21-9-1001)');
  expect(windowsDirectoryRefusal('C:/repo/.stma', { ok: false, reason: 'not_a_plain_directory' })).toContain('is a link or not a directory');
  expect(windowsDirectoryRefusal('C:/repo/.stma', { ok: false, reason: 'permission_check_failed' })).toContain('could not read Windows permissions');
  // The Windows error itself is what makes such a refusal actionable.
  expect(windowsDirectoryRefusal('C:/repo/.stma', { ok: false, reason: 'permission_check_failed', detail: 'Cannot find\n  path' }))
    .toContain('Windows reported: Cannot find path');
  expect(windowsDirectoryRefusal('C:/repo/.stma', { ok: false, reason: 'writable_by_other_accounts', writers: ['S-1-1-0'] }))
    .toContain('Still writable by: S-1-1-0');
});

it.skipIf(process.platform !== 'win32')('runs the pinned Windows hook command through Git Bash and PowerShell', () => {
  const parent = temporary('stma native win ');
  const directory = checkout(parent);
  const source = runtimeSource(parent);
  const command = `${prepareNativeRuntime(directory, source, 'claude-code')} adapter hook --event start --profile win`;
  expect(command.startsWith('node "')).toBe(true);
  const bash = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
  expect(existsSync(bash)).toBe(true);
  const shells: Array<[string, string[]]> = [
    [bash, ['-c', command]],
    ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]],
  ];
  for (const [shell, args] of shells) {
    const result = spawnSync(shell, args, { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    expect({ shell, status: result.status, stdout: result.stdout.trim() }).toEqual({
      shell, status: 0, stdout: 'stma-runtime adapter hook --event start --profile win',
    });
  }
});

it.skipIf(process.platform !== 'win32')('makes the runtime directory private to this account and tightens a loosened one', () => {
  const parent = temporary('stma native acl ');
  const directory = checkout(parent);
  const source = runtimeSource(parent);
  prepareNativeRuntime(directory, source, 'claude-code');
  const stma = path.join(directory, '.stma');
  // .NET, like windowsAcl.ts: the runner's PSModulePath points at PowerShell 7,
  // so Get-Acl is not loadable here. A failure must show what Windows said.
  const ps = (script: string) => {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 30_000,
    });
    if (result.status !== 0) {
      throw new Error(`PowerShell exited ${result.status} for ${script.slice(0, 60)}…: ${(result.stderr || result.stdout).trim().slice(0, 400)}`);
    }
    return result.stdout.trim();
  };
  const security = `(New-Object IO.DirectoryInfo('${stma}')).GetAccessControl()`;
  expect(ps(`${security}.AreAccessRulesProtected`)).toBe('True');
  expect(windowsPrivateDirectory(stma, 'probe')).toMatchObject({ ok: true, writers: [] });

  // Everyone:Modify is exactly the inherited entry a data drive hands out.
  ps(`$info = New-Object IO.DirectoryInfo('${stma}'); $s = $info.GetAccessControl(); $s.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule([Security.Principal.SecurityIdentifier]'S-1-1-0', 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))); $info.SetAccessControl($s)`);
  expect(windowsPrivateDirectory(stma, 'probe')).toMatchObject({ ok: true, writers: ['S-1-1-0'], tightens: true });
  expect(windowsPrivateDirectory(stma, 'ensure')).toMatchObject({ ok: true, writers: [], tightened: true });
  expect(prepareNativeRuntime(directory, source, 'claude-code')).toContain('.stma/runtime-');
  expect(windowsPrivateDirectory(stma, 'probe')).toMatchObject({ ok: true, writers: [] });
});
