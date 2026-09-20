import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';

/**
 * Codex's own CLI cannot add an HTTP MCP server with a static header, so
 * `stma connect` writes the entry itself. Two rules keep that small:
 *
 * - **Append only.** A new, uniquely named table goes on the end and the file is
 *   parsed before and after. Every existing byte and comment survives, in every
 *   TOML spelling a person may have used.
 * - **One STMA identity per Codex.** Codex loads its user config in every
 *   checkout, so a second entry for the same server would hand one session two
 *   identities. An existing entry for this endpoint is a refusal, not a merge.
 */

export const codexConfigPath = (home = os.homedir()): string =>
  path.join(process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(home, '.codex'), 'config.toml');

const plain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function servers(source: string): Record<string, unknown> {
  let config: unknown;
  try { config = parse(source); } catch { throw new Error('Codex config.toml could not be parsed. Nothing was changed.'); }
  const table = plain(config) ? config.mcp_servers : undefined;
  if (table !== undefined && !plain(table)) throw new Error('Codex config.toml has an unexpected mcp_servers value. Nothing was changed.');
  return (table as Record<string, unknown> | undefined) ?? {};
}

/** Throws the sentence to show the human; returns nothing when the entry may be added. */
export function checkCodexEntry(source: string, alias: string, endpoint: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(alias)) throw new Error('Invalid MCP entry name.');
  const existing = servers(source);
  if (Object.hasOwn(existing, alias)) {
    throw new Error(`Codex already has an MCP entry named ${alias}. Remove it from config.toml first.`);
  }
  const same = Object.entries(existing).find(([, entry]) =>
    plain(entry) && typeof entry.url === 'string' && entry.url.replace(/\/+$/, '') === endpoint);
  if (same) {
    throw new Error(`Codex already connects to ${endpoint} as "${same[0]}". Codex loads its user config in every checkout, so a second entry would give one session two STMA identities. Remove that entry first, or keep using it.`);
  }
}

export function appendCodexEntry(source: string, alias: string, endpoint: string, token: string): string {
  checkCodexEntry(source, alias, endpoint);
  if (!/^stma_[a-f0-9]{40}$/.test(token)) throw new Error('Invalid credential.');
  const gap = source === '' || source.endsWith('\n\n') ? '' : source.endsWith('\n') ? '\n' : '\n\n';
  const next = `${source}${gap}[mcp_servers.${alias}]\nurl = ${JSON.stringify(endpoint)}\nhttp_headers = { Authorization = ${JSON.stringify(`Bearer ${token}`)} }\n`;
  const entry = servers(next)[alias];
  if (!plain(entry) || entry.url !== endpoint) throw new Error('Codex config.toml would not parse after the change. Nothing was changed.');
  return next;
}

/** Remove exactly the table this module appended. Anything else is left for its owner. */
export function removeCodexEntry(source: string, alias: string): string {
  const block = new RegExp(`\\n?\\[mcp_servers\\.${alias}\\]\\nurl = "[^"\\n]*"\\nhttp_headers = \\{ Authorization = "Bearer stma_[a-f0-9]{40}" \\}\\n`);
  return source.replace(block, '');
}

export const readCodexConfig = (file: string): string => (existsSync(file) ? readFileSync(file, 'utf8') : '');

/** Temp file, fsync, rename; owner-only on POSIX because the file now holds a bearer. */
export function writeCodexConfig(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(file), `.stma-${randomUUID()}.tmp`);
  const fd = openSync(temp, 'wx', 0o600);
  try {
    try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* never leave a secret-bearing temp file behind */ }
    throw error;
  }
  if (process.platform !== 'win32') chmodSync(file, 0o600);
}
