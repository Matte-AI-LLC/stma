/** Product-owned, dependency-bundled installer. Never print exceptions or response bodies. */
import { constants, lstatSync, readFileSync, openSync, fstatSync, closeSync, unlinkSync, mkdirSync, writeFileSync, renameSync, fsyncSync, existsSync, realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';

export const CONNECTOR_VERSION = 2;
const fields = ['endpoint', 'enrollmentId', 'installationName', 'device', 'clientType', 'role', 'grantScope', 'teamSlug', 'projectName'] as const;
type Expected = Record<(typeof fields)[number], string | null>;
export type Envelope = {
  STMA_URL: string; STMA_ENROLLMENT_CODE: string; STMA_ENROLLMENT_EXPIRES_AT: string;
  STMA_EXPECTED_REDEMPTION: Expected;
};
class SetupError extends Error {}
const fail = (reason: string): never => { throw new SetupError(reason); };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const plain = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
function safeOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) fail('invalid_origin');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) fail('https_required');
  return url.origin;
}
function safeParents(file: string, home: string) {
  if (process.platform === 'win32') fail('unsupported_permissions_platform');
  const root = realpathSync(home);
  if (root !== path.resolve(home) || !file.startsWith(`${root}${path.sep}`)) fail('unsafe_home');
  let parent = path.dirname(file);
  while (parent !== root) {
    if (existsSync(parent)) {
      const s = lstatSync(parent);
      if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid!() || (s.mode & 0o022)) fail('unsafe_config_parent');
    }
    parent = path.dirname(parent);
  }
}
function readConfig(file: string): { source: string; identity: string } {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error: any) { if (error.code === 'ENOENT') return { source: '', identity: 'missing' }; return fail('unsafe_config_file'); }
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid!() || s.nlink !== 1) fail('unsafe_config_file');
    const source = readFileSync(fd, 'utf8');
    return { source, identity: `${s.dev}:${s.ino}:${s.mode}:${s.mtimeMs}:${digest(source)}` };
  } finally { closeSync(fd); }
}
export function configTarget(client: string, home: string): string {
  const relative = client === 'codex' ? '.codex/config.toml' : client === 'claude-code' ? '.claude.json' : client === 'cursor' ? '.cursor/mcp.json' : fail('unsupported_client');
  return path.join(home, relative);
}
function parseConfig(client: string, source: string): Record<string, any> {
  try {
    const result = client === 'codex' ? parseToml(source) : source.trim() ? JSON.parse(source) : {};
    if (!plain(result)) fail('invalid_config');
    const servers = result[client === 'codex' ? 'mcp_servers' : 'mcpServers'];
    if (servers !== undefined && !plain(servers)) fail('invalid_config');
    return result;
  } catch { return fail('invalid_config'); }
}
export function mergeConfig(client: string, source: string, alias: string, endpoint: string, token: string): string {
  const config = parseConfig(client, source);
  const key = client === 'codex' ? 'mcp_servers' : 'mcpServers';
  if (Object.hasOwn(config[key] ?? {}, alias)) fail('connection_already_exists');
  if (client === 'codex') {
    // Append a NEW uniquely-named table; parsing before AND after protects all
    // valid TOML spellings while preserving every existing byte and comment.
    const next = `${source}\n[mcp_servers.${alias}]\nurl = ${JSON.stringify(endpoint)}\nhttp_headers = { Authorization = ${JSON.stringify(`Bearer ${token}`)} }\n`;
    parseConfig(client, next);
    return next;
  }
  config[key] = { ...(config[key] ?? {}), [alias]: { ...(client === 'claude-code' ? { type: 'http' } : {}), url: endpoint, headers: { Authorization: `Bearer ${token}` } } };
  return `${JSON.stringify(config, null, 2)}\n`;
}
export async function installConnection(envelope: Envelope, options: { approved: boolean; home?: string; request?: typeof fetch } = { approved: false }) {
  const result: Record<string, any> = { connectorVersion: CONNECTOR_VERSION, ok: false, stage: 'preflight', cleanupAttempted: false, cleanupHttpStatus: null, cleanupStatus: 'not_needed' };
  let credential: string | undefined;
  let installationId: string | undefined;
  let origin: string | undefined;
  let temp: string | undefined;
  const request = options.request ?? fetch;
  try {
    if (!options.approved) fail('approval_required');
    if (process.platform === 'win32') fail('unsupported_permissions_platform');
    origin = safeOrigin(envelope.STMA_URL);
    const expected = envelope.STMA_EXPECTED_REDEMPTION;
    if (!plain(expected) || fields.some((key) => !(key in expected)) || !/^[0-9a-f-]{36}$/i.test(expected.enrollmentId ?? '')) fail('invalid_envelope');
    if (expected.endpoint !== `${origin}/mcp` || !/^stma_enroll_[a-f0-9]{40}$/.test(envelope.STMA_ENROLLMENT_CODE)) fail('invalid_envelope');
    if (!(Date.parse(envelope.STMA_ENROLLMENT_EXPIRES_AT) > Date.now())) fail('code_expired_create_new_connection');
    const client = expected.clientType ?? '';
    const home = realpathSync(options.home ?? homedir());
    if (!options.home && client === 'codex' && process.env.CODEX_HOME && path.resolve(process.env.CODEX_HOME) !== path.join(home, '.codex')) fail('custom_config_home_unsupported');
    if (lstatSync(home).uid !== process.getuid!()) fail('unsafe_home');
    const target = configTarget(client, home);
    const alias = `stma_${expected.enrollmentId!.replaceAll('-', '')}`;
    result.configTarget = target; result.alias = alias;
    safeParents(target, home);
    const before = readConfig(target);
    mergeConfig(client, before.source, alias, expected.endpoint!, '[REDACTED]');
    // Check writable destination before consuming the one-use code; creating a
    // private parent is within the approved local change, never in the repo.
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    safeParents(target, home);
    temp = path.join(path.dirname(target), `.stma-${randomUUID()}.tmp`);
    const probe = openSync(temp, 'wx', 0o600); closeSync(probe);
    if (readConfig(target).identity !== before.identity) fail('config_changed');
    result.stage = 'redemption';
    result.cleanupStatus = 'unconfirmed';
    const response = await request(`${origin}/api/agent-enrollments/redeem`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: envelope.STMA_ENROLLMENT_CODE, protocolVersion: CONNECTOR_VERSION }),
    });
    result.httpStatus = response.status;
    if (response.status !== 200) {
      // A proxy/server 5xx can happen after a committed redemption. Do not
      // assert that nothing was minted when the response cannot prove it.
      result.cleanupStatus = response.status >= 400 && response.status < 500 ? 'not_needed' : 'unconfirmed';
      fail('redemption_rejected_create_new_connection');
    }
    result.cleanupStatus = 'unconfirmed';
    const raw = await response.text();
    if (raw.length > 64_000) fail('response_too_large');
    let data: any; try { data = JSON.parse(raw); } catch { fail('invalid_response_json'); }
    if (typeof data?.token === 'string' && /^stma_[a-f0-9]{40}$/.test(data.token)) credential = data.token;
    if (typeof data?.installation?.id === 'string' && /^[a-f0-9-]{36}$/i.test(data.installation.id)) installationId = data.installation.id;
    result.stage = 'validation';
    result.validationFieldMatches = Object.fromEntries(fields.map((key) => [key, data?.validation?.[key] === expected[key]]));
    result.validationExactMatch = plain(data?.validation) && Object.keys(data.validation).length === fields.length && Object.values(result.validationFieldMatches).every(Boolean);
    result.tokenPresent = !!credential; result.installationIdPresent = !!installationId;
    result.credentialMetadataPresent = plain(data?.credential) && (data.credential.expiresAt === null ? data.credential.lifetime === 'until_revoked' : Number.isFinite(Date.parse(data.credential.expiresAt)) && data.credential.lifetime === 'time_limited');
    if (data?.protocolVersion !== CONNECTOR_VERSION) fail('protocol_version_mismatch');
    if (!result.validationExactMatch) fail('identity_mismatch');
    if (!credential || !installationId || !result.credentialMetadataPresent) fail('invalid_response_shape');
    if (data?.activation?.state !== 'awaiting_client' || !(Date.parse(data.activation.expiresAt) > Date.now())) fail('invalid_activation_receipt');
    const next = mergeConfig(client, before.source, alias, expected.endpoint!, credential!);
    result.stage = 'config_write';
    const fd = openSync(temp, constants.O_WRONLY | constants.O_NOFOLLOW);
    try { writeFileSync(fd, next); fsyncSync(fd); } finally { closeSync(fd); }
    safeParents(target, home);
    if (readConfig(target).identity !== before.identity) fail('config_changed');
    renameSync(temp, target); temp = undefined;
    result.ok = true; result.stage = 'awaiting_client'; result.installationId = installationId;
    result.activationExpiresAt = data.activation.expiresAt;
    result.credentialExpiresAt = data.credential.expiresAt;
    result.cleanupStatus = 'not_needed'; result.restartRequired = true;
    // Do NOT call whoami here. Writing a config is not evidence the client loaded it.
  } catch (error) {
    result.reason = error instanceof SetupError ? error.message : 'setup_failed';
    if (credential && origin) {
      result.cleanupAttempted = true; result.cleanupStatus = 'unconfirmed';
      try {
        const revoked = await request(`${origin}/api/agent-enrollments/self-revoke`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${credential}` } });
        result.cleanupHttpStatus = revoked.status;
        const receipt: any = await revoked.json();
        if (revoked.status === 200 && receipt.ok === true && receipt.revoked === true && installationId && receipt.installationId === installationId) result.cleanupStatus = 'revoked';
      } catch { /* Unconfirmed is deliberately not success. Pending setup still expires. */ }
    }
  } finally {
    if (temp) try { unlinkSync(temp); } catch { /* never print a secret-bearing temp file */ }
  }
  return result;
}

export function consumeEnvelope(file: string): Envelope {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid!() || (s.mode & 0o777) !== 0o600 || s.nlink !== 1 || s.size > 32_000) fail('unsafe_envelope_file');
    unlinkSync(file);
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}
async function main() {
  const file = process.argv[process.argv.indexOf('--envelope-file') + 1];
  if (!process.argv.includes('--approved') || !process.argv.includes('--envelope-file') || !file) {
    console.log(JSON.stringify({ ok: false, reason: 'usage: connector --approved --envelope-file PRIVATE_FILE' })); process.exitCode = 1; return;
  }
  try {
    const homeIndex = process.argv.indexOf('--config-home');
    const result = await installConnection(consumeEnvelope(file), { approved: true, ...(homeIndex >= 0 ? { home: process.argv[homeIndex + 1] } : {}) });
    console.log(JSON.stringify(result)); process.exitCode = result.ok ? 0 : 1;
  } catch { console.log(JSON.stringify({ ok: false, reason: 'invalid_private_envelope' })); process.exitCode = 1; }
}
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) void main();
