import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';
import { projects, teams, users, workItems } from '../src/db/schema';
import { createWork, updateWork } from '../src/domain/work';
import { submitDelivery } from '../src/domain/workEvidence';
import { humanPrincipal, type WorkPrincipal } from '../src/domain/workTypes';
import { workspaceWorkOverview, WORKSPACE_WORK_ITEM_LIMIT, WORKSPACE_WORK_PROJECT_LIMIT } from '../src/lib/workspaceWorkOverview';
import { withSecurityHooks } from '../src/lib/securityHooks';

let server: StartedServer;
let directory: string;
let cookie: string;
let owner: WorkPrincipal;
let teamId: string;
let outsiderId: string;
let reviewId: string;
let blockedId: string;

const success = (value: any) => { if (value.error) throw new Error(JSON.stringify(value.error)); return value; };
const form = (url: string, fields: Record<string, string>, authenticated = true) => fetch(`${server.url}${url}`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(authenticated ? { cookie } : {}) },
  body: new URLSearchParams(fields), redirect: 'manual',
});
async function create(title: string, project = 'alpha', scope = teamId) {
  return success(await createWork(server.db, owner, {
    request_id: randomUUID(), project, contract: { title, goal: 'Inspect the report.', artifact_kind: 'document' },
    acceptor: 'overview-owner', criteria: [{ id: 'checked', text: 'A person checked it.', evidence_kinds: ['human_check'] }],
  }, { teamId: scope })).work_id as string;
}
async function command(id: string, operation: string, payload: Record<string, unknown>) {
  const [row] = await server.db.select().from(workItems).where(eq(workItems.id, id));
  return success(await updateWork(server.db, owner, {
    request_id: randomUUID(), work_id: id, expected_version: row!.version.toString(), operation, payload,
  } as never));
}

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'stma-work-overview-'));
  server = await startServer(loadEnv({ port: 0, host: '127.0.0.1', nodeEnv: 'test', devMode: true, hosted: true, pgliteDir: directory, databaseUrl: undefined }));
  const signedIn = await form('/auth/dev', { username: 'overview-owner' }, false);
  cookie = signedIn.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  const [user] = await server.db.select().from(users).where(eq(users.username, 'overview-owner'));
  owner = humanPrincipal(user!.id);
  await form('/app/teams', { name: 'Overview proof' });
  const [team] = await server.db.select().from(teams).where(eq(teams.slug, 'overview-proof'));
  teamId = team!.id;
  await form('/app/projects', { team: 'overview-proof', project: 'alpha' });
  await form('/app/projects', { team: 'overview-proof', project: 'beta' });
  await form('/auth/dev', { username: 'overview-outsider' }, false);
  outsiderId = (await server.db.select().from(users).where(eq(users.username, 'overview-outsider')))[0]!.id;

  blockedId = await create('Blocked <script>untrusted()</script>', 'alpha');
  await command(blockedId, 'set_blocker', { kind: 'other', reason: 'Waiting for the specification.', next_action: 'Ask the owner.' });
  reviewId = await create('Review the beta report', 'beta');
  await command(reviewId, 'transition', { to: 'ready' });
  const [row] = await server.db.select().from(workItems).where(eq(workItems.id, reviewId));
  success(await submitDelivery(server.db, owner, { request_id: randomUUID(), work_id: reviewId,
    expected_version: row!.version.toString(), spec_revision: 1,
    artifacts: [{ kind: 'file', name: 'report.md', sha256: 'a'.repeat(64) }],
  }));
  const cancelled = await create('Closed item');
  await command(cancelled, 'transition', { to: 'cancelled', reason: 'No longer needed.' });
  const archived = await create('Archived fixture');
  await server.db.update(workItems).set({ archivedAt: new Date() }).where(eq(workItems.id, archived));
  await form('/app/teams', { name: 'Other overview' });
  const other = (await server.db.select().from(teams).where(eq(teams.slug, 'other-overview')))[0]!;
  await form('/app/projects', { team: 'other-overview', project: 'alpha' });
  await create('Outside the requested workspace', 'alpha', other.id);
});

afterAll(async () => { await server?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });

it('aggregates only this workspace, excludes archived/closed work, and shares decision/blocker predicates', async () => {
  const data = (await workspaceWorkOverview(server.db, owner.userId, teamId))!;
  expect(data.totals).toEqual({ open: 2, ready: 0, in_progress: 0, in_review: 1 });
  expect(data.projects.map((p) => [p.name, p.open])).toEqual([['alpha', 1], ['beta', 1]]);
  expect((await workspaceWorkOverview(server.db, owner.userId, teamId, 'needs_decision'))!.items.map((i) => i.id)).toEqual([reviewId]);
  const blocked = (await workspaceWorkOverview(server.db, owner.userId, teamId, 'blocked'))!.items;
  expect(blocked.map((i) => i.id)).toEqual([blockedId]);
  expect(blocked[0]!.waiting).toBe('Waiting for the specification.');
  expect((await workspaceWorkOverview(server.db, owner.userId, teamId, 'untrusted'))!.view).toBe('open');
});

it('keeps reads on Free, escapes authored text, and rejects nonmembers and composition-filtered access', async () => {
  const response = await fetch(`${server.url}/app/teams/overview-proof?work_view=blocked`, { headers: { cookie } });
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain('Work across projects');
  expect(html).toContain('Blocked &lt;script&gt;untrusted()&lt;/script&gt;');
  expect(html).not.toContain('<script>untrusted()</script>');
  expect(html).toContain('/projects/alpha/work/WORK-1');
  expect(html).not.toContain('Outside the requested workspace');
  expect(await workspaceWorkOverview(server.db, outsiderId, teamId)).toBeNull();
  expect(await withSecurityHooks({ membershipFilter: () => sql`false` }, () => workspaceWorkOverview(server.db, owner.userId, teamId))).toBeNull();
});

it('bounds details without silently truncating the workspace totals', async () => {
  for (let i = 0; i < WORKSPACE_WORK_ITEM_LIMIT; i++) await create(`Additional work ${i}`);
  const data = (await workspaceWorkOverview(server.db, owner.userId, teamId))!;
  expect(data.totals.open).toBe(WORKSPACE_WORK_ITEM_LIMIT + 2);
  expect(data.items).toHaveLength(WORKSPACE_WORK_ITEM_LIMIT);
  expect(data.moreItems).toBe(true);
  const html = await (await fetch(`${server.url}/app/teams/overview-proof`, { headers: { cookie } })).text();
  expect(html).toContain(`Showing the oldest ${WORKSPACE_WORK_ITEM_LIMIT} matching items`);
});

it('discloses the project boundary and counts only the included projects', async () => {
  // Persist the larger Enterprise-shaped fixture without changing the Free route fixture.
  await server.db.insert(projects).values(Array.from({ length: WORKSPACE_WORK_PROJECT_LIMIT }, (_, i) => ({
    id: randomUUID(), teamId, slug: `later-${i}`, name: `zz project ${i.toString().padStart(3, '0')}`,
  })));
  await create('Outside the overview project window', 'later-99');
  const data = (await workspaceWorkOverview(server.db, owner.userId, teamId))!;
  expect(data.projectsTruncated).toBe(true);
  expect(data.projectCount).toBe(WORKSPACE_WORK_PROJECT_LIMIT);
  expect(data.projects).toHaveLength(WORKSPACE_WORK_PROJECT_LIMIT);
  expect(data.projects.some((p) => p.slug === 'later-99')).toBe(false);
  expect(data.totals.open).toBe(WORKSPACE_WORK_ITEM_LIMIT + 2);
  const html = await (await fetch(`${server.url}/app/teams/overview-proof`, { headers: { cookie } })).text();
  expect(html).toContain(`This overview covers the first ${WORKSPACE_WORK_PROJECT_LIMIT} projects by name`);
  expect(html).not.toContain('Outside the overview project window');
});
