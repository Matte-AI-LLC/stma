import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { browserLaunch, localOAuthConnection, saveCredential } from '../../cli/src/oauthLocal';

const homes: string[] = [];
const access = `stma_${'a'.repeat(40)}`;
const nextAccess = `stma_${'b'.repeat(40)}`;
const refresh = `stma_refresh_${'c'.repeat(64)}`;
const nextRefresh = `stma_refresh_${'d'.repeat(64)}`;
const server = 'https://stma.example';

it('passes the complete Windows OAuth URL to the browser without a command shell', () => {
  const url = 'https://stma.example/oauth/authorize?state=abc&resource=https%3A%2F%2Fstma.example%2Fmcp';
  expect(browserLaunch('win32', url)).toEqual({
    command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url],
  });
});

function fixture(expiresAt: number): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'stma-oauth-local-'));
  homes.push(home);
  mkdirSync(path.join(home, '.stma'), { mode: 0o700 });
  mkdirSync(path.join(home, '.stma', 'oauth'), { mode: 0o700 });
  saveCredential('test-profile', home, {
    server, clientId: `stma_client_${'e'.repeat(48)}`, accessToken: access,
    refreshToken: refresh, expiresAt,
  });
  return home;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

it('uses a private, unexpired local OAuth credential without reading a client config', async () => {
  const home = fixture(Date.now() + 180_000);
  if (process.platform !== 'win32') chmodSync(path.join(home, '.stma'), 0o755); // existing CLI data directory
  expect(await localOAuthConnection('test-profile', server, home)).toEqual({ server, token: access });
  await expect(localOAuthConnection('test-profile', 'https://other.example', home))
    .rejects.toThrow('server override mismatch');
});

it('refreshes expiring OAuth tokens once and persists rotation', async () => {
  const home = fixture(Date.now() + 20_000);
  const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ access_token: nextAccess,
    refresh_token: nextRefresh, expires_in: 3600 }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  expect(await localOAuthConnection('test-profile', server, home)).toEqual({ server, token: nextAccess });
  expect(await localOAuthConnection('test-profile', server, home)).toEqual({ server, token: nextAccess });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]![0]).toBe(`${server}/oauth/token`);
});

it.skipIf(process.platform === 'win32')('rejects world-readable credential files before use', async () => {
  const home = fixture(Date.now() + 180_000);
  const file = path.join(home, '.stma', 'oauth', 'test-profile.json');
  chmodSync(file, 0o644);
  await expect(localOAuthConnection('test-profile', server, home)).rejects.toThrow('private regular file');
});

it.skipIf(process.platform === 'win32')('rejects a group-writable parent directory', async () => {
  const home = fixture(Date.now() + 180_000);
  chmodSync(path.join(home, '.stma'), 0o775);
  await expect(localOAuthConnection('test-profile', server, home)).rejects.toThrow('not private');
});

it('spawns PowerShell without a policy bypass and without cmdlets, so it does not read as malware', () => {
  // Measured in the first two-device round, 2026-09-20: Kaspersky System Watcher
  // killed `adapter disconnect` on Windows as PDM:Trojan.Win32.Generic before it had
  // revoked anything. Node spawning a hidden PowerShell with -ExecutionPolicy Bypass
  // to unprotect a secret is what an infostealer does. The flag was never needed for
  // an inline -Command; what it papered over was cmdlets whose modules a restrictive
  // policy will not autoload, so those stay out too. Per-push CI is Linux only, which
  // is why this reads the source instead of running it.
  const cli = path.join(__dirname, '..', '..', 'cli', 'src');
  for (const file of ['oauthLocal.ts', 'windowsAcl.ts']) {
    const source = readFileSync(path.join(cli, file), 'utf8');
    const spawns = source.match(/spawnSync\('powershell\.exe', \[[^\]]*\]/g) ?? [];
    expect(spawns.length, `${file} spawns PowerShell`).toBeGreaterThan(0);
    for (const call of spawns) {
      expect(call, file).not.toMatch(/ExecutionPolicy|Bypass|EncodedCommand|WindowStyle/i);
      expect(call, file).toContain("'-NoProfile', '-NonInteractive', '-Command'");
    }
    const scripts = [...source.matchAll(/`\$ErrorActionPreference = 'Stop'[\s\S]*?`;/g)].map((match) => match[0]);
    expect(scripts.length, `${file} scripts`).toBeGreaterThan(0);
    for (const script of scripts) {
      const code = script.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
      expect(code, file).not.toMatch(/\b(Add-Type|New-Object|ConvertFrom-Json|ConvertTo-Json|Get-Acl|Set-Acl|New-Item|Test-Path|Import-Module|Invoke-Expression|Invoke-WebRequest)\b/i);
    }
  }
});

it.skipIf(process.platform !== 'win32')('encrypts credentials for the current Windows user and binds them to the profile', async () => {
  const home = fixture(Date.now() + 180_000);
  const file = path.join(home, '.stma', 'oauth', 'test-profile.json');
  const raw = readFileSync(file, 'utf8');
  expect(raw).toContain('dpapi-current-user-v1');
  expect(raw).not.toContain(access);
  expect(raw).not.toContain(refresh);
  expect(await localOAuthConnection('test-profile', server, home)).toEqual({ server, token: access });
  copyFileSync(file, path.join(home, '.stma', 'oauth', 'other-profile.json'));
  await expect(localOAuthConnection('other-profile', server, home)).rejects.toThrow('credential protection failed');
});
