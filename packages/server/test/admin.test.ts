import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';
import { agentInstallations, projects, tokens } from '../src/db/schema';

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
      host: '127.0.0.1',
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
      host: '127.0.0.1',
      nodeEnv: 'test',
      devMode: true,
      hosted: true,
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
let rootId: string;
let malloryId: string;
let contactId: string;

it('returns 404 for the whole /admin area when ADMIN_USERNAMES is unset', async () => {
  expect((await fetch(`${plain.url}/admin`)).status).toBe(404);
  // Even a signed-in user whose name would be on the list elsewhere gets a 404.
  const j = await devLogin(plain, 'root');
  expect((await fetch(`${plain.url}/admin`, { headers: j.header() })).status).toBe(404);
  expect((await fetch(`${plain.url}/admin/crm`, { headers: j.header() })).status).toBe(404);
  const appHtml = await (await fetch(`${plain.url}/app`, { headers: j.header() })).text();
  expect(appHtml).not.toContain('href="/admin"');
  const docsHtml = await (await fetch(`${plain.url}/docs`, { headers: j.header() })).text();
  expect(docsHtml).not.toContain('id="instance-admin"');
});

it('returns 404 for anonymous visitors and signed-in non-admins', async () => {
  expect((await fetch(`${srv.url}/admin`)).status).toBe(404);
  mallory = await devLogin(srv, 'mallory');
  for (const p of ['/admin', '/admin/teams', '/admin/users', '/admin/crm']) {
    expect((await fetch(srv.url + p, { headers: mallory.header() })).status).toBe(404);
  }
  const appHtml = await (await fetch(`${srv.url}/app`, { headers: mallory.header() })).text();
  expect(appHtml).not.toContain('href="/admin"');
  const docsHtml = await (await fetch(`${srv.url}/docs`, { headers: mallory.header() })).text();
  expect(docsHtml).not.toContain('id="instance-admin"');
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
  const docsHtml = await (await fetch(`${srv.url}/docs`, { headers: root.header() })).text();
  expect(docsHtml).toContain('id="instance-admin"');
  expect(docsHtml).toContain('workspace → project → scoped agent connection');
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

it('renders filterable users with clickable workspace-plan memberships', async () => {
  const res = await fetch(`${srv.url}/admin/users`, { headers: root.header() });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('mallory');
  expect(html).toContain('root');
  expect(html).toContain('>admin<'); // admin badge on root's row
  expect(html).toContain('Growth Lab · owner · team');
  expect(html).toContain('Workspace plan');
  expect(html).toContain('Workspace memberships');
  rootId = /data-user-row="root"[\s\S]{0,200}?\/admin\/users\/([0-9a-f-]{36})/.exec(html)?.[1] ?? '';
  malloryId = /data-user-row="mallory"[\s\S]{0,200}?\/admin\/users\/([0-9a-f-]{36})/.exec(html)?.[1] ?? '';
  expect(rootId).toBeTruthy();
  expect(malloryId).toBeTruthy();

  const userSearch = await (
    await fetch(`${srv.url}/admin/users?q=mallory`, { headers: root.header() })
  ).text();
  expect(userSearch).toContain('data-user-row="mallory"');
  expect(userSearch).not.toContain('data-user-row="root"');
  const paidUsers = await (
    await fetch(`${srv.url}/admin/users?plan=team`, { headers: root.header() })
  ).text();
  expect(paidUsers).toContain('data-user-row="root"');
  expect(paidUsers).not.toContain('data-user-row="mallory"');

  const workspaceSearch = await (
    await fetch(`${srv.url}/admin/teams?q=growth&plan=team`, { headers: root.header() })
  ).text();
  expect(workspaceSearch).toContain('Growth Lab');
  const noWorkspace = await (
    await fetch(`${srv.url}/admin/teams?q=growth&plan=free`, { headers: root.header() })
  ).text();
  expect(noWorkspace).toContain('No matching workspaces');
});

it('drills into workspace hierarchy and manages a user membership without losing the last owner', async () => {
  const [project] = await srv.db
    .insert(projects)
    .values({
      teamId,
      name: 'Checkout Service',
      slug: 'checkout-service',
      repositoryIdentity: 'github.com/acme/checkout-service',
      createdBy: rootId,
    })
    .returning();
  const [token] = await srv.db
    .insert(tokens)
    .values({
      userId: rootId,
      name: 'checkout-agent credential',
      scope: 'project',
      teamId,
      projectId: project!.id,
      tokenHash: 'admin-fixture-project-token-hash',
      prefix: 'stma_admin_fixture',
    })
    .returning();
  await srv.db.insert(agentInstallations).values({
    userId: rootId,
    tokenId: token!.id,
    name: 'checkout-agent',
    deviceLabel: 'qa-laptop',
    clientType: 'claude-code',
    deviceFingerprint: 'admin-fixture-device',
  });
  const workspace = await (
    await fetch(`${srv.url}/admin/teams/${teamId}`, { headers: root.header() })
  ).text();
  expect(workspace).toContain('Workspace → projects → scoped agent connections');
  expect(workspace).toContain('Applies to this workspace, not directly to a user');
  expect(workspace).toContain(`/admin/users/${rootId}`);
  expect(workspace).toContain('Agent connections');
  expect(workspace).toContain('Checkout Service');
  expect(workspace).toContain('github.com/acme/checkout-service');
  expect(workspace).toContain('checkout-agent');
  expect(workspace).toContain('qa-laptop');
  expect(workspace).toContain('name="return_to" value="detail"');

  const before = await (
    await fetch(`${srv.url}/admin/users/${malloryId}`, { headers: root.header() })
  ).text();
  expect(before).toContain('Add workspace membership');
  expect(before).toContain(`value="${teamId}"`);

  const added = await fetch(
    `${srv.url}/admin/users/${malloryId}/memberships`,
    form({ team_id: teamId, role: 'member' }, root.header()),
  );
  expect(added.status).toBe(302);
  expect(added.headers.get('location')).toContain('ok=');
  const afterAdd = await (
    await fetch(`${srv.url}/admin/users/${malloryId}`, { headers: root.header() })
  ).text();
  expect(afterAdd).toContain('Growth Lab');
  expect(afterAdd).toContain('value="member" selected');

  const promoted = await fetch(
    `${srv.url}/admin/users/${malloryId}/memberships/${teamId}/role`,
    form({ role: 'owner' }, root.header()),
  );
  expect(promoted.headers.get('location')).toContain('ok=');
  const afterRole = await (
    await fetch(`${srv.url}/admin/users/${malloryId}`, { headers: root.header() })
  ).text();
  expect(afterRole).toContain('value="owner" selected');

  const removed = await fetch(
    `${srv.url}/admin/users/${malloryId}/memberships/${teamId}/remove`,
    { method: 'POST', headers: root.header(), redirect: 'manual' },
  );
  expect(removed.headers.get('location')).toContain('ok=');
  const afterRemove = await (
    await fetch(`${srv.url}/admin/users/${malloryId}`, { headers: root.header() })
  ).text();
  expect(afterRemove).toContain('No workspace memberships');

  const lastOwner = await fetch(
    `${srv.url}/admin/users/${rootId}/memberships/${teamId}/role`,
    form({ role: 'member' }, root.header()),
  );
  expect(decodeURIComponent(lastOwner.headers.get('location') ?? '')).toContain(
    'A workspace needs at least one owner',
  );
  const lastOwnerRemove = await fetch(
    `${srv.url}/admin/users/${rootId}/memberships/${teamId}/remove`,
    { method: 'POST', headers: root.header(), redirect: 'manual' },
  );
  expect(decodeURIComponent(lastOwnerRemove.headers.get('location') ?? '')).toContain(
    'The last workspace owner cannot be removed',
  );

  const freeWorkspace = await fetch(
    `${srv.url}/app/teams`,
    form({ name: 'Free Capacity Lab' }, root.header()),
  );
  expect(freeWorkspace.status).toBe(302);
  const freeList = await (
    await fetch(`${srv.url}/admin/teams?q=Free+Capacity`, { headers: root.header() })
  ).text();
  const freeTeamId = /\/admin\/teams\/([0-9a-f-]{36})\/plan/.exec(freeList)?.[1] ?? '';
  expect(freeTeamId).toBeTruthy();
  const overCapacity = await fetch(
    `${srv.url}/admin/users/${malloryId}/memberships`,
    form({ team_id: freeTeamId, role: 'member' }, root.header()),
  );
  expect(decodeURIComponent(overCapacity.headers.get('location') ?? '')).toContain(
    'free plan member limit',
  );
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

it('returns 404 for non-admin POSTs to plan, membership and CRM routes', async () => {
  const planRes = await fetch(
    `${srv.url}/admin/teams/${teamId}/plan`,
    form({ plan: 'free' }, mallory.header()),
  );
  expect(planRes.status).toBe(404);
  const memberRes = await fetch(
    `${srv.url}/admin/users/${malloryId}/memberships`,
    form({ team_id: teamId, role: 'member' }, mallory.header()),
  );
  expect(memberRes.status).toBe(404);
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
