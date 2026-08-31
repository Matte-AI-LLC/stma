import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

/**
 * A service that collects accounts needs somewhere to point at, reachable
 * without one. These pages are public on purpose.
 */

let srv: StartedServer;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-legal-'));
  srv = await startServer(
    loadEnv({
      port: 0,
      host: 'localhost',
      nodeEnv: 'test',
      devMode: true,
      databaseUrl: undefined,
      pgliteDir: dataDir,
    }),
  );
});

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

it('serves terms and privacy to anonymous visitors', async () => {
  for (const [route, heading] of [
    ['/terms', 'Terms of Service'],
    ['/privacy', 'Privacy Policy'],
  ]) {
    const res = await fetch(`${srv.url}${route}`);
    expect(res.status, `${route} must be public`).toBe(200);
    const html = await res.text();
    expect(html).toContain(heading!);
    expect(html).toContain('Matte AI LLC');
    // Says plainly that it has not been through counsel yet.
    expect(html).toContain('not yet');
  }
});

it('states the privacy claims the product actually implements', async () => {
  const html = await (await fetch(`${srv.url}/privacy`)).text();
  // The names-only guarantee is the product's central promise; if the page ever
  // stops saying it, either the page or the product has drifted.
  expect(html).toContain('names');
  expect(html).toContain('North Europe');
  expect(html).toContain('privacy@stma.ai');
});

it('links the legal pages from the public footers', async () => {
  for (const route of ['/', '/docs']) {
    const html = await (await fetch(`${srv.url}${route}`)).text();
    expect(html, `${route} footer should link the terms`).toContain('href="/terms"');
    expect(html, `${route} footer should link the privacy policy`).toContain('href="/privacy"');
  }
});
