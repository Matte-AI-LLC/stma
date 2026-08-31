import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

let srv: StartedServer;
let dataDir: string;

function jar() {
  const cookies = new Map<string, string>();
  return {
    header(): Record<string, string> {
      return cookies.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {};
    },
    store(res: Response) {
      for (const line of res.headers.getSetCookie()) {
        const [kv] = line.split(';');
        const i = kv!.indexOf('=');
        cookies.set(kv!.slice(0, i), kv!.slice(i + 1));
      }
    },
  };
}

async function devLogin(username: string) {
  const j = jar();
  const res = await fetch(`${srv.url}/auth/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username }),
    redirect: 'manual',
  });
  j.store(res);
  expect(res.status).toBe(302);
  return j;
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'bridge-team-create-'));
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

/**
 * Creating a team is one control, not two.
 *
 * The page used to carry a "New team" button that was an anchor to a card
 * further down, plus a separate "Create team" form inside that card. On a short
 * page the anchor jump moved nothing, so the button read as broken and the real
 * control was somewhere else — reported by the owner, 2026-08-25.
 */
it('makes a team from one dialog, with optional fields marked as optional', async () => {
  // One login for the whole case: /auth/* is IP rate limited, and a test file
  // that signs in once per assertion runs into the brake it is not testing.
  const j = await devLogin('team-dialog');
  const html = await (await fetch(`${srv.url}/app`, { headers: j.header() })).text();

  // One opener, wired to a dialog rather than to an anchor nobody can see move.
  expect(html).toContain('data-open-dialog="#new-team"');
  expect(html).not.toContain('href="#new-team"');
  expect(html).toContain('<dialog id="new-team"');
  expect(html).not.toContain('Create a team');

  // Required and optional are both marked: "unmarked means optional" is a
  // convention no reader has agreed to.
  expect(html).toMatch(/for="team-name"[^>]*>Team name\s*<span class="fmark fmark-req">required</);
  expect(html).toMatch(/for="team-tag"[^>]*>Tag\s*<span class="fmark fmark-opt">optional</);
  expect(html).toMatch(
    /for="team-webhook"[^>]*>Team chat webhook\s*<span class="fmark fmark-opt">optional</,
  );
  // Real label/control pairs, and the guidance is announced rather than only seen.
  for (const id of ['team-name', 'team-tag', 'team-webhook']) {
    expect(html).toContain(`id="${id}"`);
    expect(html).toContain(`aria-describedby="${id}-help"`);
  }

  const create = (body: Record<string, string>) =>
    fetch(`${srv.url}/app/teams`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...j.header() },
      body: new URLSearchParams(body),
      redirect: 'manual',
    });
  const errorOf = async (res: Response) =>
    new URL(`${srv.url}${res.headers.get('location')}`).searchParams.get('error');

  // A chosen tag is used as given, normalised to the shape URLs need.
  const chosen = await create({ name: 'Billing Crew', tag: 'Billing Crew EU' });
  expect(chosen.headers.get('location')).toBe('/app/teams/billing-crew-eu');

  // A second team with the same tag is refused rather than quietly renamed —
  // and the typing comes back, so nobody retypes three fields to fix one.
  const clash = await create({
    name: 'Billing Crew Two',
    tag: 'billing-crew-eu',
    webhook_url: 'https://hooks.slack.com/services/T0/B0/xyz',
  });
  const back = new URL(`${srv.url}${clash.headers.get('location')}`);
  expect(back.pathname).toBe('/app');
  expect(back.searchParams.get('error')).toMatch(/"billing-crew-eu" is taken/);
  expect(back.searchParams.get('name')).toBe('Billing Crew Two');
  expect(back.searchParams.get('tag')).toBe('billing-crew-eu');
  expect(back.searchParams.get('webhook_url')).toBe('https://hooks.slack.com/services/T0/B0/xyz');
  const reopened = await (
    await fetch(`${srv.url}${clash.headers.get('location')}`, { headers: j.header() })
  ).text();
  expect(reopened).toContain('value="Billing Crew Two"');
  expect(reopened).toContain('value="billing-crew-eu"');

  // A tag with nothing usable in it is named as a mistake rather than silently
  // becoming the "p-8f3a21" digest slugify() falls back to.
  expect(await errorOf(await create({ name: 'Symbols Only', tag: '///' }))).toMatch(
    /at least one letter \(a-z\) or digit/,
  );

  // Blank tag keeps the old behaviour: derived from the name.
  const derived = await create({ name: 'Derived Name' });
  expect(derived.headers.get('location')).toBe('/app/teams/derived-name');

  // The optional webhook is stored on creation, so an owner does not have to go
  // to the team page afterwards to do what the dialog just offered.
  const withHook = await create({
    name: 'Hooked Team',
    webhook_url: 'https://hooks.slack.com/services/T1/B1/abc',
  });
  const hookedHtml = await (
    await fetch(`${srv.url}${withHook.headers.get('location')!}?tab=integrations`, {
      headers: j.header(),
    })
  ).text();
  expect(hookedHtml).toContain('https://hooks.slack.com/services/T1/B1/abc');

  // And a webhook that is not a webhook is refused before the team exists.
  expect(
    await errorOf(await create({ name: 'Bad Hook Team', webhook_url: 'ftp://example.com/x' })),
  ).toMatch(/public https:\/\/ address/);
});
