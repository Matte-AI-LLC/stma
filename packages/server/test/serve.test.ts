import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { connectSnippet, defaultDataDir, resolveServerEntry, serveEnv } from '../../cli/src/serve';

/**
 * The zero-infrastructure entry point.
 *
 * Trying STMA used to require an invite to the hosted instance or a decision to
 * self-host — a database, a Docker command, an environment file. `stma serve`
 * is the answer to "let me see it work first". What is asserted here is the
 * shape of that instance, because the defaults are the whole feature: get one
 * wrong and the command either fails to start or starts something unsafe.
 */

it('defaults to a private instance with no infrastructure and no open door', () => {
  const env = serveEnv({ port: 3000, host: '127.0.0.1', dataDir: '/tmp/x' });
  expect(env.EMBEDDED_DB).toBe('1');
  expect(env.DATABASE_URL).toBeUndefined();
  expect(env.PGLITE_DIR).toBe('/tmp/x');
  expect(env.HOST).toBe('127.0.0.1');
  expect(env.BASE_URL).toBe('http://127.0.0.1:3000');
  // The person running this should get the first account, with a password.
  expect(env.AUTH_LOCAL).toBe('1');
  expect(env.SIGNUPS_OPEN).toBe('1');
  // Passwordless dev login is NOT something to hand somebody by default, even
  // on localhost — this is the assertion that stops it creeping in.
  expect(env.AUTH_DEV_MODE).toBeUndefined();
});

it('keeps its data in one place, so any directory finds the same instance', () => {
  const dir = defaultDataDir();
  expect(dir.startsWith(os.homedir())).toBe(true);
  expect(dir).toContain('.stma');
  // Not the current working directory: running from two repos must not create
  // two half-empty instances.
  expect(dir).not.toBe(path.join(process.cwd(), '.stma', 'data'));
});

it('names localhost in the connect snippet rather than a bind address', () => {
  const env = serveEnv({ port: 8080, host: '0.0.0.0', dataDir: '/tmp/x' });
  // 0.0.0.0 is a thing to listen on, not a thing to connect to.
  expect(env.BASE_URL).toBe('http://localhost:8080');
  expect(connectSnippet('http://localhost:8080')).toContain('http://localhost:8080/mcp');
  expect(connectSnippet('http://localhost:8080')).toContain('Authorization: Bearer stma_YOUR_TOKEN');
});

it('finds the server that ships with this checkout', () => {
  const entry = resolveServerEntry();
  // Built by `npm run build`; in a fresh checkout it is fetched instead, which
  // is the branch this cannot assert without a network.
  if (entry) {
    expect(existsSync(entry)).toBe(true);
    expect(entry.endsWith(path.join('dist', 'index.js'))).toBe(true);
  }
});

it('publishes the server with the migrations it needs to boot', () => {
  const pkg = JSON.parse(
    readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
  ) as { name: string; private?: boolean; bin?: Record<string, string>; files?: string[] };
  expect(pkg.name).toBe('@matteai/stma-server');
  expect(pkg.private).toBeUndefined();
  expect(pkg.bin?.['stma-server']).toBe('./dist/index.js');
  // A published server without its migrations is a server with no tables.
  expect(pkg.files).toContain('drizzle');
  expect(pkg.files).toContain('dist');
});
