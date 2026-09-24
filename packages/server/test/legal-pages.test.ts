import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

/**
 * `/terms` and `/privacy` — the published documents, not a draft.
 *
 * Two servers, because the one thing that differs between them is the whole
 * point: the documents describe the hosted service at stma.ai, and an instance
 * somebody else runs has to say so rather than let its users believe they are
 * agreeing with us. Everything else is pinned because it is a promise: the
 * addresses a person writes to, the anchor the footer links, and a handful of
 * claims that are true of the code and would have to be rewritten here if the
 * code changed.
 */

let hosted: StartedServer;
let own: StartedServer;
let hostedDir: string;
let ownDir: string;

const BASE = {
  port: 0,
  host: '127.0.0.1',
  nodeEnv: 'test' as const,
  devMode: false,
  databaseUrl: undefined,
};

const page = async (srv: StartedServer, route: string) => {
  const res = await fetch(`${srv.url}${route}`);
  expect(res.status, `${route} must be public`).toBe(200);
  return res.text();
};

beforeAll(async () => {
  hostedDir = mkdtempSync(path.join(tmpdir(), 'stma-legal-hosted-'));
  ownDir = mkdtempSync(path.join(tmpdir(), 'stma-legal-own-'));
  hosted = await startServer(loadEnv({ ...BASE, pgliteDir: hostedDir, hosted: true }));
  own = await startServer(loadEnv({ ...BASE, pgliteDir: ownDir, hosted: false }));
});

afterAll(async () => {
  await hosted?.close();
  await own?.close();
  rmSync(hostedDir, { recursive: true, force: true });
  rmSync(ownDir, { recursive: true, force: true });
});

it('serves both documents to a stranger, with the addresses a person writes to', async () => {
  for (const srv of [hosted, own]) {
    for (const route of ['/terms', '/privacy']) {
      const html = await page(srv, route);
      expect(html).toContain('Matte AI LLC');
      // Each document carries its own date: the Privacy Policy was revised for
      // emailed invitations on 24 September 2026 and the Terms were not.
      expect(html).toContain(route === '/terms' ? 'Effective 23 September 2026' : 'Effective 24 September 2026');
      // Data protection and everything else go to different mailboxes, and both
      // are in both documents: somebody reading one must not have to find the
      // other to know where to write.
      expect(html, `${route} must offer the data protection address`).toContain(
        'gdpr@matteai.com',
      );
      expect(html, `${route} must offer the support address`).toContain('support@matteai.com');
      // A vulnerability report goes to the same mailbox as everything else
      // technical (2026-09-23): security@stma.ai was written into these
      // documents before anybody checked whether it existed, and it does not,
      // so a report to it would have bounced while looking delivered.
      expect(html, `${route} must not name a mailbox nobody reads`).not.toContain(
        'security@stma.ai',
      );
    }
  }
});

it('no longer says it is a draft, and no longer names the retired addresses', async () => {
  for (const srv of [hosted, own]) {
    for (const route of ['/terms', '/privacy']) {
      const html = await page(srv, route);
      expect(html, `${route} is not a draft any more`).not.toContain('not yet reviewed');
      expect(html).not.toContain('privacy@stma.ai');
      expect(html).not.toContain('legal@stma.ai');
      expect(html).not.toContain('security@stma.ai');
    }
  }
});

it('says whose rules apply on an instance somebody else runs, and only there', async () => {
  const note = 'This server is not the hosted STMA service';
  for (const route of ['/terms', '/privacy']) {
    expect(await page(own, route), `${route} on a self-hosted instance`).toContain(note);
    expect(await page(hosted, route), `${route} on the hosted service`).not.toContain(note);
  }
  // The note has one job: point at the operator who actually holds the data.
  expect(await page(own, '/privacy')).toContain('is the controller of the personal data it holds');
});

it('defaults the data protection address for the hosted service and nobody else', () => {
  expect(loadEnv({ ...BASE, pgliteDir: ownDir, hosted: true }).privacyEmail).toBe(
    'gdpr@matteai.com',
  );
  expect(loadEnv({ ...BASE, pgliteDir: ownDir, hosted: false }).privacyEmail).toBe('');
});

it('keeps the anchor the footer links, and lets no contents entry point at nothing', async () => {
  const privacy = await page(hosted, '/privacy');
  // `/privacy#rights` is in the footer of every signed-out page.
  expect(privacy).toContain('id="rights"');
  expect(privacy).toContain('href="/privacy#rights"');

  for (const [route, html] of [
    ['/terms', await page(hosted, '/terms')],
    ['/privacy', privacy],
  ] as const) {
    const targets = [...html.matchAll(/href="#([a-z-]+)"/g)].map((m) => m[1]!);
    expect(targets.length, `${route} should have a table of contents`).toBeGreaterThan(10);
    for (const id of new Set(targets)) {
      expect(html, `${route} links #${id}, which must exist`).toContain(`id="${id}"`);
    }
  }

  // The two documents point at each other by section; a renamed section must not
  // leave the other one linking into nothing.
  expect(await page(hosted, '/terms')).toContain('href="/privacy#retention"');
  expect(privacy).toContain('id="retention"');
  expect(privacy).toContain('href="/terms#deletion"');
  expect(await page(hosted, '/terms')).toContain('id="deletion"');
});

/**
 * A privacy policy is only worth anything while it describes the code. These are
 * the claims that would be the most expensive to get wrong, each one a fact
 * asserted elsewhere in this suite or visible in the source.
 */
it('states the promises the product actually keeps', async () => {
  const privacy = await page(hosted, '/privacy');
  // Names, never values — the snapshot schema has no field for a value.
  expect(privacy).toContain('never their values');
  expect(privacy).toContain('scrypt');
  // The free plan's history limit, which the beta does not lift.
  expect(privacy).toContain('90 days on the free plan');
  expect(privacy).toContain('30 days');
  expect(privacy).toContain('redact');

  const terms = await page(hosted, '/terms');
  expect(terms).toContain('Elastic License 2.0');
  // Advisory signals, not locks: the sentence a reader must not be able to miss.
  expect(terms).toContain('They are not locks');
  // Card details never reach us; Stripe hosts the checkout.
  expect(terms).toContain('never reach our servers');
});

it('links both documents from the public footers', async () => {
  // A service that collects accounts needs somewhere to point at, reachable
  // without one, from every page a signed-out visitor can be standing on.
  for (const route of ['/', '/docs', '/help', '/terms', '/privacy']) {
    const html = await page(hosted, route);
    expect(html, `${route} should link the terms`).toContain('href="/terms"');
    expect(html, `${route} should link the privacy policy`).toContain('href="/privacy"');
  }
});

it('accepts the Terms where they are ours to accept, and nowhere else', async () => {
  const line = 'Creating an account means you accept the';
  expect(await page(hosted, '/signup'), 'hosted signup').toContain(line);
  expect(await page(hosted, '/signup')).toContain('href="/terms"');
  // On somebody else's instance the operator's terms apply, so the form must not
  // claim the reader is accepting ours.
  expect(await page(own, '/signup'), 'self-hosted signup').not.toContain(line);
});

it('publishes every address where a CDN cannot hide it', async () => {
  // Cloudflare's Email Address Obfuscation rewrites mailto links and addresses in
  // the text into a script-decoded placeholder. Measured on production
  // 2026-09-22: the privacy policy's own contact sentence served
  // "write to [email protected]", which is all a reader with no script gets, on
  // the page whose job is to publish where a data-protection request goes.
  // `<!--email_off-->` is Cloudflare's own opt-out, and it belongs around every
  // address the product means to publish.
  for (const route of ['/', '/privacy', '/terms', '/help']) {
    const html = await page(hosted, route);
    const outside = html.split(/<!--email_off-->[\s\S]*?<!--email_on-->/).join('');
    expect(outside, `${route} leaves an address where the CDN will hide it`).not.toContain('mailto:');
    expect(outside, `${route} leaves an address in text where the CDN will hide it`).not.toMatch(
      /[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
    );
  }
});
