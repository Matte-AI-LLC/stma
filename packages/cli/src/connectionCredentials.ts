import { constants, openSync, closeSync, fstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';

export interface ConnectionReference { client: string; alias: string }
/** Read the approved native MCP credential in memory; never duplicate it in a repository. */
export function savedConnection(reference: ConnectionReference, home = homedir()): { server: string; token: string } {
  if (!/^stma_[a-f0-9]{32}$/.test(reference.alias)) throw Error('Invalid STMA connection alias.');
  const relative = reference.client === 'codex' ? '.codex/config.toml' : reference.client === 'claude-code' ? '.claude.json' : reference.client === 'cursor' ? '.cursor/mcp.json' : null;
  if (!relative) throw Error('Unsupported saved connection client.');
  let fd: number;
  try { fd = openSync(path.join(home, relative), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw Error('Saved MCP connection is unavailable. Reconnect this client first.'); }
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o077) || s.nlink !== 1 || s.size > 2_000_000) throw Error('Saved connection config must be a bounded file owned and readable only by the current OS user.');
    let config: any;
    try { const source = readFileSync(fd, 'utf8'); config = reference.client === 'codex' ? parse(source) : JSON.parse(source); }
    catch { throw Error('Saved connection config could not be parsed.'); }
    const entry = config[reference.client === 'codex' ? 'mcp_servers' : 'mcpServers']?.[reference.alias];
    const header = reference.client === 'codex' ? entry?.http_headers?.Authorization : entry?.headers?.Authorization;
    if (typeof header !== 'string' || !/^Bearer stma_[a-f0-9]{40}$/.test(header) || typeof entry?.url !== 'string') throw Error('Saved STMA connection is missing or incompatible.');
    let url: URL;
    try { url = new URL(entry.url); } catch { throw Error('Saved STMA connection has an invalid endpoint.'); }
    if (url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw Error('Saved STMA connection has an unsafe endpoint.');
    return { server: url.origin, token: header.slice(7) };
  } finally { closeSync(fd); }
}
