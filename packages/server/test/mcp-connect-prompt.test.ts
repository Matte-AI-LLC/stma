import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_CHECKOUT_ALIAS_POSIX,
  CLAUDE_CHECKOUT_ALIAS_POWERSHELL,
  claudeCheckoutAgentName,
  mcpConnectPrompt,
  mcpServerAlias,
} from '../src/lib/mcpConnectPrompt';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function checkout(parent: string, folder: string): string {
  const directory = path.join(parent, folder);
  mkdirSync(path.join(directory, 'nested'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: directory });
  return directory;
}

function run(shell: string, args: string[], cwd: string): string {
  const result = spawnSync(shell, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  expect({ shell, status: result.status, stderr: result.stderr.trim() }).toMatchObject({ shell, status: 0 });
  return result.stdout.trim();
}

const CHECKOUT_ALIAS = /^stma-[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?-[0-9a-f]{4}$/;

const scope = {
  baseUrl: 'https://stma.example.test/',
  teamSlug: 'my-workspace',
  projectSlug: 'payments-api',
  projectName: 'Payments API',
};

describe('copy-ready native MCP setup requests', () => {
  it('uses a stable, readable alias for the selected project or workspace', () => {
    expect(mcpServerAlias(scope)).toBe('stma-payments-api');
    expect(mcpServerAlias({ teamSlug: 'My Workspace' })).toBe('stma-my-workspace');
    expect(mcpServerAlias({})).toBe('stma');
  });

  it('asks Codex to use only its native add and OAuth login commands', () => {
    const prompt = mcpConnectPrompt({ ...scope, client: 'codex' });
    expect(prompt).toContain('codex mcp get stma-payments-api >/dev/null 2>&1');
    expect(prompt).toContain('codex mcp add stma-payments-api --url "https://stma.example.test/mcp"');
    expect(prompt).toContain('codex mcp login stma-payments-api');
    expect(prompt).toContain('If that command already opens the STMA browser flow');
    expect(prompt).toContain('do not run "codex mcp status"');
    expect(prompt).toContain('do not launch a nested or non-interactive "codex exec"');
    expect(prompt).toContain('reload or restart this Codex task');
    expect(prompt).toContain('Project only — Payments API in workspace my-workspace');
    expect(prompt).toContain('Do not approve the browser consent on my behalf');
    expect(prompt).toContain('do not edit its raw config file directly');
    expect(prompt).not.toMatch(/stma_(?:enroll_)?[a-f0-9]{20,}/i);
    expect(prompt).not.toContain('Authorization: Bearer');
  });

  it('connects each Claude checkout under its own local-scope name and hands login off inside that checkout', () => {
    const prompt = mcpConnectPrompt({ ...scope, client: 'claude-code' });
    expect(prompt).toContain('claude mcp help login >/dev/null 2>&1');
    expect(prompt).toContain('stop before adding anything');
    expect(prompt).toContain('tell me to run "claude update"');
    expect(prompt).toContain(CLAUDE_CHECKOUT_ALIAS_POSIX);
    expect(prompt).toContain(CLAUDE_CHECKOUT_ALIAS_POWERSHELL);
    expect(prompt).toContain('It is fine to paste this same request into every Claude Code agent');
    // The earlier machine-wide name would load beside the checkout entry: stop, never remove it.
    expect(prompt).toContain('claude mcp get stma-payments-api >/dev/null 2>&1');
    expect(prompt).toContain('claude mcp remove --scope user stma-payments-api');
    expect(prompt).toContain('Do not remove it.');
    expect(prompt).toContain('claude mcp get SERVER_NAME >/dev/null 2>&1');
    expect(prompt).toContain('claude mcp add --transport http --scope local SERVER_NAME "https://stma.example.test/mcp"');
    expect(prompt).not.toContain('--scope user stma-payments-api "');
    expect(prompt).toContain('[ -t 0 ] && [ -t 1 ]');
    expect(prompt).toContain('[Console]::IsInputRedirected');
    expect(prompt).toContain('claude mcp login SERVER_NAME');
    expect(prompt).toContain('do not attempt login from the non-interactive tool shell');
    // Windows PowerShell's default execution policy refuses the npm claude.ps1 shim.
    expect(prompt).toContain('type "claude.cmd" instead of "claude"');
    expect(prompt).toContain('never be asked to change the execution policy');
    expect(prompt).toContain('the login must run inside it or one of its subfolders');
    expect(prompt).not.toContain('from any directory');
    expect(prompt).toContain('does not broaden the access enforced by STMA');
    expect(prompt).toContain('reload or restart this Claude Code task in this checkout');
    expect(prompt).not.toContain('open /mcp');
    expect(prompt).toContain('Do not approve the browser consent on my behalf');
    expect(prompt).not.toContain('helper');
    expect(prompt).not.toContain('enrollment code:');
  });

  it('keeps Codex on its one user-config identity and says so', () => {
    const prompt = mcpConnectPrompt({ ...scope, client: 'codex' });
    expect(prompt).toContain('every Codex task on this machine shares this one STMA identity');
    expect(prompt).not.toContain('SERVER_NAME');
  });

  it.skipIf(process.platform === 'win32')('derives a stable, distinct checkout name in bash and zsh from any subfolder', () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'stma-alias-'));
    roots.push(parent);
    const first = checkout(parent, 'Parcel Desk_Claude');
    const twin = checkout(path.join(parent, 'elsewhere'), 'Parcel Desk_Claude');
    const long = checkout(parent, 'a-very-long-checkout-folder-name-for-agents');
    const shells = ['bash', ...(existsSync('/bin/zsh') ? ['/bin/zsh'] : [])];
    for (const shell of shells) {
      const alias = run(shell, ['-c', CLAUDE_CHECKOUT_ALIAS_POSIX], first);
      expect(alias).toMatch(CHECKOUT_ALIAS);
      expect(alias.startsWith('stma-parcel-desk-claude-')).toBe(true);
      expect(run(shell, ['-c', CLAUDE_CHECKOUT_ALIAS_POSIX], path.join(first, 'nested'))).toBe(alias);
      const twinAlias = run(shell, ['-c', CLAUDE_CHECKOUT_ALIAS_POSIX], twin);
      expect(twinAlias.startsWith('stma-parcel-desk-claude-')).toBe(true);
      expect(twinAlias).not.toBe(alias);
      const longAlias = run(shell, ['-c', CLAUDE_CHECKOUT_ALIAS_POSIX], long);
      expect(longAlias).toMatch(CHECKOUT_ALIAS);
      expect(longAlias.length).toBeLessThanOrEqual(30);
      expect(claudeCheckoutAgentName(`Claude Code (${alias})`)).toBe('parcel-desk-claude');
    }
    const outside = spawnSync('bash', ['-c', CLAUDE_CHECKOUT_ALIAS_POSIX], { cwd: parent, encoding: 'utf8' });
    expect(outside.status).not.toBe(0);
    expect(outside.stdout.trim()).toBe('');
  });

  it.skipIf(process.platform !== 'win32')('derives a checkout name through Git Bash and PowerShell on Windows', () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'stma alias '));
    roots.push(parent);
    const first = checkout(parent, 'Parcel Desk_Claude');
    const second = checkout(parent, 'parcel-desk-codex');
    const bash = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
    const shells: Array<[string, string[]]> = [
      [bash, ['-c', CLAUDE_CHECKOUT_ALIAS_POSIX]],
      ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', CLAUDE_CHECKOUT_ALIAS_POWERSHELL]],
    ];
    for (const [shell, args] of shells) {
      const alias = run(shell, args, first);
      expect(alias).toMatch(CHECKOUT_ALIAS);
      expect(alias.startsWith('stma-parcel-desk-claude-')).toBe(true);
      expect(run(shell, args, path.join(first, 'nested'))).toBe(alias);
      const other = run(shell, args, second);
      expect(other.startsWith('stma-parcel-desk-codex-')).toBe(true);
    }
  });

  it('reads the checkout folder back only from a checkout-shaped Claude Code registration', () => {
    expect(claudeCheckoutAgentName('Claude Code (stma-parcel-desk-claude-3f9a)')).toBe('parcel-desk-claude');
    expect(claudeCheckoutAgentName('Claude Code (stma-checkout-00ff)')).toBe('checkout');
    expect(claudeCheckoutAgentName('Claude Code (stma-payments-api)')).toBeUndefined();
    expect(claudeCheckoutAgentName('Codex (stma-parcel-desk-claude-3f9a)')).toBeUndefined();
    expect(claudeCheckoutAgentName('Claude Code (stma-<b>x</b>-3f9a)')).toBeUndefined();
  });

  it('stops instead of overwriting an existing connection with different trust data', () => {
    expect(mcpConnectPrompt({ ...scope, client: 'codex' })).toContain('If it exists, stop and tell me it was left untouched');
    expect(mcpConnectPrompt({ ...scope, client: 'claude-code' })).toContain('If it exists, stop and tell me this checkout is already connected and was left untouched');
    for (const client of ['codex', 'claude-code'] as const) {
      const prompt = mcpConnectPrompt({ ...scope, client });
      expect(prompt).toContain('Do not list, inspect, remove or treat any differently named MCP entry as a blocker');
      expect(prompt).toContain('Never display raw MCP configuration');
      expect(prompt).toContain('do not fall back to a custom installer or copied token');
    }
  });
});
