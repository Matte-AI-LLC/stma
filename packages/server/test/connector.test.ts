import { afterEach, expect, it as test } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { consumeEnvelope, installConnection, mergeConfig, configTarget, type Envelope } from '../src/connector/installer';
import { savedConnection } from '../../cli/src/connectionCredentials';

const roots: string[] = [];
// POSIX adapter acceptance is not Windows ACL acceptance.
const it = test.skipIf(process.platform === 'win32');
const home = () => { const dir = mkdtempSync(path.join(tmpdir(), 'stma-connector-')); roots.push(dir); return dir; };
afterEach(() => { roots.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); });
const token = `stma_${'a'.repeat(40)}`;
const id = '00000000-0000-4000-8000-000000000001';
const installationId = '00000000-0000-4000-8000-000000000002';
const envelope = (clientType = 'codex'): Envelope => ({
  STMA_URL: 'https://stma.example', STMA_ENROLLMENT_CODE: `stma_enroll_${'b'.repeat(40)}`,
  STMA_ENROLLMENT_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString(),
  STMA_EXPECTED_REDEMPTION: { endpoint: 'https://stma.example/mcp', enrollmentId: id, installationName: 'test', device: 'test-device', clientType, role: 'generalist', grantScope: 'project', teamSlug: 'lab', projectName: 'demo' },
});
const body = (input: Envelope) => ({ ok: true, protocolVersion: 2, token, installation: { id: installationId }, validation: input.STMA_EXPECTED_REDEMPTION, credential: { expiresAt: null, lifetime: 'until_revoked' }, activation: { state: 'awaiting_client', expiresAt: new Date(Date.now() + 900_000).toISOString() } });
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
it.each(['codex', 'claude-code', 'cursor'])('installs %s with a unique alias, private permissions and unrelated settings preserved', async (client) => {
  const dir = home(); const input = envelope(client); const target = configTarget(client, dir);
  mkdirSync(path.dirname(target), { recursive: true });
  const original = client === 'codex' ? '# preserved comment\nmodel = "example"\n[mcp_servers.existing]\nurl = "https://existing.example/mcp"\n' : JSON.stringify({ theme: 'dark', mcpServers: { existing: { url: 'https://existing.example/mcp' } } });
  writeFileSync(target, original, { mode: 0o644 });
  let calls = 0;
  const result = await installConnection(input, { approved: true, home: dir, request: async () => { calls++; return response(body(input)); } });
  expect(result).toMatchObject({ ok: true, stage: 'awaiting_client', restartRequired: true });
  expect(calls).toBe(1); // No synthetic whoami: real client loading is separate evidence.
  expect(statSync(target).mode & 0o777).toBe(0o600);
  const contents = readFileSync(target, 'utf8');
  const parsed = client === 'codex' ? parseToml(contents) : JSON.parse(contents);
  const servers = parsed[client === 'codex' ? 'mcp_servers' : 'mcpServers'];
  expect(servers.existing.url).toBe('https://existing.example/mcp');
  expect(servers[result.alias]).toBeTruthy();
  expect(savedConnection({ client, alias: result.alias }, dir)).toEqual({ server: 'https://stma.example', token });
  if (client === 'codex') expect(contents.startsWith(original)).toBe(true);
  expect(JSON.stringify(result)).not.toContain(token);
  expect(JSON.stringify(result)).not.toContain(input.STMA_ENROLLMENT_CODE);
});
it('denial, expiry, unsupported client and invalid config consume no code', async () => {
  let calls = 0; const request: typeof fetch = async () => { calls++; throw new Error('unexpected'); };
  const dir = home();
  expect((await installConnection(envelope(), { approved: false, home: dir, request })).reason).toBe('approval_required');
  expect((await installConnection({ ...envelope(), STMA_ENROLLMENT_EXPIRES_AT: '2000-01-01' }, { approved: true, home: dir, request })).reason).toContain('expired');
  expect((await installConnection(envelope('other'), { approved: true, home: dir, request })).reason).toBe('unsupported_client');
  mkdirSync(path.join(dir, '.codex')); writeFileSync(path.join(dir, '.codex/config.toml'), '[broken');
  expect((await installConnection(envelope(), { approved: true, home: dir, request })).reason).toBe('invalid_config');
  expect(calls).toBe(0);
});
it('never follows config symlinks or replaces an existing connection', async () => {
  const dir = home(); const target = configTarget('claude-code', dir);
  writeFileSync(path.join(dir, 'other'), '{}'); symlinkSync(path.join(dir, 'other'), target);
  const result = await installConnection(envelope('claude-code'), { approved: true, home: dir, request: async () => { throw new Error('must not redeem'); } });
  expect(result.reason).toBe('unsafe_config_file');
  expect(readFileSync(path.join(dir, 'other'), 'utf8')).toBe('{}');
  expect(() => mergeConfig('codex', '[mcp_servers.stma_unique]\nurl="x"', 'stma_unique', 'https://stma.example/mcp', token)).toThrow('connection_already_exists');
});
it.each(['wrong_field', 'missing_token', 'metadata_token_only', 'wrong_protocol', 'concurrent_write'])('fails closed for %s; cleanup only succeeds with a matching receipt', async (failure) => {
  const dir = home(); const input = envelope('claude-code'); const target = configTarget('claude-code', dir); writeFileSync(target, '{"keep":true}', { mode: 0o600 });
  let calls = 0;
  const result = await installConnection(input, { approved: true, home: dir, request: async (_url, options) => {
    calls++;
    if (calls === 2) { expect(options?.headers).toEqual({ authorization: `Bearer ${token}` }); return response({ ok: true, revoked: true, installationId }); }
    const data: any = body(input);
    if (failure === 'wrong_field') data.validation = { ...data.validation, clientType: null };
    if (failure === 'missing_token' || failure === 'metadata_token_only') delete data.token;
    if (failure === 'metadata_token_only') data.credential.token = token;
    if (failure === 'wrong_protocol') data.protocolVersion = 1;
    if (failure === 'concurrent_write') writeFileSync(target, '{"concurrent":true}');
    return response(data);
  } });
  expect(result.ok).toBe(false);
  expect(result.cleanupStatus).toBe(['missing_token', 'metadata_token_only'].includes(failure) ? 'unconfirmed' : 'revoked');
  expect(readFileSync(target, 'utf8')).toBe(failure === 'concurrent_write' ? '{"concurrent":true}' : '{"keep":true}');
  expect(JSON.stringify(result)).not.toContain(token);
});
it('lost responses and failed cleanup are never retried or reported as revoked', async () => {
  const input = envelope(); let calls = 0;
  const lost = await installConnection(input, { approved: true, home: home(), request: async () => { calls++; throw Error(token); } });
  expect(calls).toBe(1); expect(lost.cleanupStatus).toBe('unconfirmed'); expect(JSON.stringify(lost)).not.toContain(token);
  calls = 0;
  const failed = await installConnection(input, { approved: true, home: home(), request: async () => ++calls === 1 ? response({ ...body(input), protocolVersion: 1 }) : response({ ok: true, revoked: true, installationId: 'wrong' }) });
  expect(failed.cleanupAttempted).toBe(true); expect(failed.cleanupStatus).toBe('unconfirmed'); expect(calls).toBe(2);
});
it('consumes a private envelope once without printing it', () => {
  const file = path.join(home(), 'bootstrap.json'); writeFileSync(file, JSON.stringify(envelope()), { mode: 0o600 });
  expect(consumeEnvelope(file).STMA_ENROLLMENT_CODE).toBe(envelope().STMA_ENROLLMENT_CODE); expect(existsSync(file)).toBe(false);
});
