import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

/** Server booted WITHOUT ADMIN_USERNAMES — the /admin area must not exist. */
let plain: StartedServer;
let plainDir: string;
/** Server booted with ADMIN_USERNAMES=' Root , ada ' (exercises trim + case-insensitive). */
let srv: StartedServer;
let dataDir: string;

function jar() {
  const cookies = new Map<string, string>();
  return {
    header(): Record<string, string> {
      return cookies.size
        ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') }
        : {};
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

async function devLogin(server: StartedServer, username: string) {
  const j = jar();
  const res = await fetch(`${server.url}/auth/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username }),
    redirect: 'manual',
  });
  j.store(res);
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('/app');
  return j;
}

const form = (fields: Record<string, string>, cookies: Record<string, string>) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...cookies },
  body: new URLSearchParams(fields),
  redirect: 'manual' as const,
});

beforeAll(async () => {
  delete process.env.ADMIN_USERNAMES;
  plainDir = mkdtempSync(path.join(tmpdir(), 'bridge-admin-off-'));
  plain = await startServer(
    loadEnv({
      port: 0,
      host: 'localhost',
      nodeEnv: 'test',
      devMode: true,
      databaseUrl: undefined,
      pgliteDir: plainDir,
    }),
  );

  process.env.ADMIN_USERNAMES = ' Root , ada ';
  dataDir = mkdtempSync(path.join(tmpdir(), 'bridge-admin-'));
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
  delete process.env.ADMIN_USERNAMES;
}, 60_000);

afterAll(async () => {
  await srv?.close();
  await plain?.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(plainDir, { recursive: true, force: true });
});

// Shared state across the sequential tests below (same pattern as e2e.test.ts).
let root: ReturnType<typeof jar>;
let mallory: ReturnType<typeof jar>;
let teamId: string;
let contactId: string;

it('returns 404 for the whole /admin area when ADMIN_USERNAMES is unset', async () => {
  expect((await fetch(`${plain.url}/admin`)).status).toBe(404);
  // Even a signed-in user whose name would be on the list elsewhere gets a 404.
  const j = await devLogin(plain, 'root');
  expect((await fetch(`${plain.url}/admin`, { headers: j.header() })).status).toBe(404);
  expect((await fetch(`${plain.url}/admin/crm`, { headers: j.header() })).status).toBe(404);
  const appHtml = await (await fetch(`${plain.url}/app`, { headers: j.header() })).text();
  expect(appHtml).not.toContain('href="/admin"');
});

it('returns 404 for anonymous visitors and signed-in non-admins', async () => {
  expect((await fetch(`${srv.url}/admin`)).status).toBe(404);
  mallory = await devLogin(srv, 'mallory');
  for (const p of ['/admin', '/admin/teams', '/admin/users', '/admin/crm']) {
    expect((await fetch(srv.url + p, { headers: mallory.header() })).status).toBe(404);
  }
  const appHtml = await (await fetch(`${srv.url}/app`, { headers: mallory.header() })).text();
  expect(appHtml).not.toContain('href="/admin"');
});

it('shows the overview with instance stats to an admin', async () => {
  // ' Root ' in ADMIN_USERNAMES matches the user "root" (trimmed, case-insensitive).
  root = await devLogin(srv, 'root');

  // Seed some data so the tiles have something to count.
  const createRes = await fetch(`${srv.url}/app/teams`, form({ name: 'Growth Lab' }, root.header()));
  expect(createRes.status).toBe(302);

  const appHtml = await (await fetch(`${srv.url}/app`, { headers: root.header() })).text();
  expect(appHtml).toContain('href="/admin"');

  const res = await fetch(`${srv.url}/admin`, { headers: root.header() });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('Operator console');
  for (const label of [
    'Users',
    'Teams',
    'Projects',
    'Snapshots',
    'Open sessions',
    'Resolved sessions',
    'Messages',
    'Agent installations',
    'Active agent runs',
    'Activity events (7d)',
    'Active users (7d)',
    'Active agent tokens (7d)',
    'Recent activity',
  ]) {
    expect(html).toContain(label);
  }
});

it('renders the teams page and persists a plan switch to a paid rung', async () => {
  const page = await fetch(`${srv.url}/admin/teams`, { headers: root.header() });
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('Growth Lab');
  expect(html).toContain('value="free" selected');
  teamId = /\/admin\/teams\/([0-9a-f-]{36})\/plan/.exec(html)?.[1] ?? '';
  expect(teamId).toBeTruthy();

  const switchRes = await fetch(
    `${srv.url}/admin/teams/${teamId}/plan`,
    form({ plan: 'team' }, root.header()),
  );
  expect(switchRes.status).toBe(302);
  expect(switchRes.headers.get('location')).toContain('ok=');

  const after = await (await fetch(`${srv.url}/admin/teams`, { headers: root.header() })).text();
  expect(after).toContain('value="team" selected');
  expect(after).not.toContain('value="free" selected');
});

it('rejects an invalid plan', async () => {
  const res = await fetch(
    `${srv.url}/admin/teams/${teamId}/plan`,
    // `enterprise` used to be the invalid one. It is a real rung now, so the
    // test needs a name that will never be a plan rather than one that is not
    // a plan yet.
    form({ plan: 'platinum' }, root.header()),
  );
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toContain('error=');
  const html = await (await fetch(`${srv.url}/admin/teams`, { headers: root.header() })).text();
  expect(html).toContain('value="team" selected'); // unchanged
});

it('renders the users page with badges', async () => {
  const res = await fetch(`${srv.url}/admin/users`, { headers: root.header() });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('mallory');
  expect(html).toContain('root');
  expect(html).toContain('>admin<'); // admin badge on root's row
  expect(html).toContain('Growth Lab'); // team membership listed
});

it('creates a CRM contact and persists a status change', async () => {
  // Name is required.
  const noName = await fetch(`${srv.url}/admin/crm`, form({ org: 'Acme' }, root.header()));
  expect(noName.status).toBe(302);
  expect(noName.headers.get('location')).toContain('error=');

  // A malformed next-action date is rejected.
  const badDate = await fetch(
    `${srv.url}/admin/crm`,
    form({ name: 'Jane Doe', next_action: 'not-a-date' }, root.header()),
  );
  expect(badDate.headers.get('location')).toContain('error=');

  const created = await fetch(
    `${srv.url}/admin/crm`,
    form(
      {
        name: 'Jane Doe',
        org: 'Acme Robotics',
        contact: 'jane@acme.dev',
        source: 'HN launch',
        status: 'lead',
        notes: 'Met at the launch thread; wants multi-agent policy support.',
        next_action: '2020-01-15',
      },
      root.header(),
    ),
  );
  expect(created.status).toBe(302);
  expect(created.headers.get('location')).toContain('ok=');

  const html = await (await fetch(`${srv.url}/admin/crm`, { headers: root.header() })).text();
  expect(html).toContain('Jane Doe');
  expect(html).toContain('Acme Robotics');
  expect(html).toContain('2020-01-15');
  expect(html).toContain('dot red'); // past next-action date is highlighted
  contactId = /\/admin\/crm\/([0-9a-f-]{36})\/status/.exec(html)?.[1] ?? '';
  expect(contactId).toBeTruthy();

  const moved = await fetch(
    `${srv.url}/admin/crm/${contactId}/status`,
    form({ status: 'demo' }, root.header()),
  );
  expect(moved.status).toBe(302);
  expect(moved.headers.get('location')).toContain('ok=');
  const after = await (await fetch(`${srv.url}/admin/crm`, { headers: root.header() })).text();
  expect(after).toContain('value="demo" selected');
});

it('rejects an invalid CRM status', async () => {
  const res = await fetch(
    `${srv.url}/admin/crm/${contactId}/status`,
    form({ status: 'bogus' }, root.header()),
  );
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toContain('error=');
  const html = await (await fetch(`${srv.url}/admin/crm`, { headers: root.header() })).text();
  expect(html).toContain('value="demo" selected'); // unchanged
});

it('edits and deletes a CRM contact', async () => {
  const updated = await fetch(
    `${srv.url}/admin/crm/${contactId}/update`,
    form(
      { name: 'Jane Smith', org: 'Acme Robotics', status: 'onboarding', notes: 'Signed the pilot.' },
      root.header(),
    ),
  );
  expect(updated.status).toBe(302);
  expect(updated.headers.get('location')).toContain('ok=');
  const html = await (await fetch(`${srv.url}/admin/crm`, { headers: root.header() })).text();
  expect(html).toContain('Jane Smith');
  expect(html).toContain('value="onboarding" selected');

  const deleted = await fetch(`${srv.url}/admin/crm/${contactId}/delete`, {
    method: 'POST',
    headers: root.header(),
    redirect: 'manual',
  });
  expect(deleted.status).toBe(302);
  expect(deleted.headers.get('location')).toContain('ok=');
  const after = await (await fetch(`${srv.url}/admin/crm`, { headers: root.header() })).text();
  expect(after).not.toContain('Jane Smith');
});

it('returns 404 for non-admin POSTs to plan and CRM routes', async () => {
  const planRes = await fetch(
    `${srv.url}/admin/teams/${teamId}/plan`,
    form({ plan: 'free' }, mallory.header()),
  );
  expect(planRes.status).toBe(404);
  const crmRes = await fetch(`${srv.url}/admin/crm`, form({ name: 'Sneaky' }, mallory.header()));
  expect(crmRes.status).toBe(404);
  const delRes = await fetch(`${srv.url}/admin/crm/${contactId}/delete`, {
    method: 'POST',
    headers: mallory.header(),
    redirect: 'manual',
  });
  expect(delRes.status).toBe(404);

  // The team is untouched by the non-admin attempt.
  const html = await (await fetch(`${srv.url}/admin/teams`, { headers: root.header() })).text();
  expect(html).toContain('value="team" selected');
});
