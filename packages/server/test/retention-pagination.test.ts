import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, count, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db';
import {
  activity,
  agentEvents,
  agentInstallations,
  agentRuns,
  debugSessions,
  memberships,
  messages,
  readState,
  teams,
  users,
} from '../src/db/schema';
import { trimAgentEvents } from '../src/domain/agents';
import { loadEnv } from '../src/env';
import { runCleanupOnce } from '../src/lib/cleanup';
import { getAnnouncementsSession, trimAnnouncements } from '../src/lib/sessions';
import { trimActivity } from '../src/lib/track';
import { startServer, type StartedServer } from '../src/server';

let srv: StartedServer;
let db: Db;
let dataDir: string;

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
/** Distinct, ordered timestamps so "newest first" is deterministic. */
const stamp = (i: number) => new Date(Date.now() - (500 - i) * 60_000);

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
type Jar = ReturnType<typeof jar>;

const form = (j: Jar) => ({
  'content-type': 'application/x-www-form-urlencoded',
  ...j.header(),
});

async function devLogin(username: string): Promise<Jar> {
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

async function createTeam(j: Jar, name: string): Promise<string> {
  const res = await fetch(`${srv.url}/app/teams`, {
    method: 'POST',
    headers: form(j),
    body: new URLSearchParams({ name }),
    redirect: 'manual',
  });
  expect(res.status).toBe(302);
  return res.headers.get('location')!.split('/').pop()!; // slug
}

async function joinTeam(owner: Jar, member: Jar, slug: string): Promise<void> {
  const inv = await fetch(`${srv.url}/app/teams/${slug}/invites`, {
    method: 'POST',
    headers: owner.header(),
    redirect: 'manual',
  });
  expect(inv.status).toBe(302);
  const html = await (await fetch(`${srv.url}/app/teams/${slug}?tab=people`, { headers: owner.header() })).text();
  const code = /\/join\/([A-Za-z0-9_-]+)/.exec(html)?.[1];
  expect(code).toBeTruthy();
  const joined = await fetch(`${srv.url}/join/${code}`, {
    method: 'POST',
    headers: member.header(),
    redirect: 'manual',
  });
  expect(joined.status).toBe(302);
}

const get = (url: string, j: Jar) => fetch(`${srv.url}${url}`, { headers: j.header() });

async function html(url: string, j: Jar): Promise<string> {
  const res = await get(url, j);
  expect(res.status).toBe(200);
  return res.text();
}

async function teamId(slug: string): Promise<string> {
  const rows = await db.select({ id: teams.id }).from(teams).where(eq(teams.slug, slug)).limit(1);
  return rows[0]!.id;
}

async function userId(username: string): Promise<string> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  return rows[0]!.id;
}

/** An installation + run to hang agent events off. */
async function seedRun(uid: string, tid: string, fingerprint: string): Promise<string> {
  const install = (
    await db
      .insert(agentInstallations)
      .values({ userId: uid, name: `agent-${fingerprint}`, deviceFingerprint: fingerprint })
      .returning()
  )[0]!;
  const run = (
    await db
      .insert(agentRuns)
      .values({ installationId: install.id, teamId: tid, status: 'active' })
      .returning()
  )[0]!;
  return run.id;
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-retention-'));
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
  db = srv.db;
});

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ retention

describe('retention', () => {
  it('ages out the activity feed and keeps recent events', async () => {
    const owner = await devLogin('ret-activity');
    const slug = await createTeam(owner, 'Retention Activity');
    const tid = await teamId(slug);
    const uid = await userId('ret-activity');
    await db.insert(activity).values([
      { teamId: tid, userId: uid, action: 'ancient', createdAt: ago(400) },
      { teamId: tid, userId: uid, action: 'old', createdAt: ago(200) },
      { teamId: tid, userId: uid, action: 'just-inside', createdAt: ago(179) },
      { teamId: tid, userId: uid, action: 'recent', createdAt: ago(3) },
    ]);

    await runCleanupOnce(
      db,
      loadEnv({ nodeEnv: 'test', databaseUrl: undefined, activityRetentionDays: 180 }),
    );

    const left = await db
      .select({ action: activity.action })
      .from(activity)
      .where(eq(activity.teamId, tid));
    const actions = left.map((r) => r.action);
    expect(actions).toContain('recent');
    expect(actions).toContain('just-inside'); // the boundary is the cutoff, not "old-ish"
    expect(actions).not.toContain('ancient');
    expect(actions).not.toContain('old');
  });

  it('keeps a paying team\'s history and sweeps a free one, on the hosted service', async () => {
    const owner = await devLogin('ret-plans');
    const freeSlug = await createTeam(owner, 'Retention Free');
    const paidSlug = await createTeam(owner, 'Retention Paid');
    const [freeId, paidId] = [await teamId(freeSlug), await teamId(paidSlug)];
    const uid = await userId('ret-plans');
    await db.update(teams).set({ plan: 'team' }).where(eq(teams.id, paidId));
    await db.insert(activity).values([
      { teamId: freeId, userId: uid, action: 'free-120', createdAt: ago(120) },
      { teamId: freeId, userId: uid, action: 'free-30', createdAt: ago(30) },
      { teamId: paidId, userId: uid, action: 'paid-120', createdAt: ago(120) },
      { teamId: paidId, userId: uid, action: 'paid-900', createdAt: ago(900) },
    ]);

    // Hosted: the plan decides, and the environment number does not enter into
    // it. This is the thing being sold — an outcome history swept every 90 days
    // is not a record anyone can plan against.
    await runCleanupOnce(
      db,
      loadEnv({ nodeEnv: 'test', databaseUrl: undefined, hosted: true, activityRetentionDays: 180 }),
    );

    const actions = (
      await db
        .select({ action: activity.action, teamId: activity.teamId })
        .from(activity)
        .where(inArray(activity.teamId, [freeId, paidId]))
    ).map((r) => r.action);
    expect(actions, 'free tier keeps 90 days').toContain('free-30');
    expect(actions, 'free tier is swept past 90').not.toContain('free-120');
    expect(actions, 'a paid team was promised the rows would still be there').toContain('paid-120');
    expect(actions, 'and that promise has no far edge either').toContain('paid-900');
  });

  it('leaves the feed alone when the age purge is disabled, but still applies the cap', async () => {
    const owner = await devLogin('ret-cap');
    const slugA = await createTeam(owner, 'Cap Team A');
    const slugB = await createTeam(owner, 'Cap Team B');
    const [tidA, tidB] = [await teamId(slugA), await teamId(slugB)];
    const uid = await userId('ret-cap');
    const rows = (tid: string, tag: string) =>
      Array.from({ length: 12 }, (_, i) => ({
        teamId: tid,
        userId: uid,
        action: `${tag}-${String(i).padStart(2, '0')}`,
        createdAt: stamp(i),
      }));
    await db.insert(activity).values([...rows(tidA, 'a'), ...rows(tidB, 'b')]);

    // Age purge off: nothing ages out even though these rows are "old" by any clock.
    await runCleanupOnce(
      db,
      loadEnv({ nodeEnv: 'test', databaseUrl: undefined, activityRetentionDays: 0 }),
    );
    const beforeTrim = await db.select({ n: count() }).from(activity).where(eq(activity.teamId, tidA));
    expect(beforeTrim[0]!.n).toBeGreaterThanOrEqual(12);

    // The cap is per team: A is trimmed to its newest rows, B is untouched.
    const deleted = await trimActivity(db, 5);
    expect(deleted).toBeGreaterThan(0);
    const a = await db
      .select({ action: activity.action })
      .from(activity)
      .where(eq(activity.teamId, tidA));
    const b = await db
      .select({ action: activity.action })
      .from(activity)
      .where(eq(activity.teamId, tidB));
    expect(a).toHaveLength(5);
    expect(b).toHaveLength(5);
    expect(a.map((r) => r.action)).toContain('a-11'); // newest survives
    expect(a.map((r) => r.action)).not.toContain('a-00'); // oldest evicted
  });

  it('ages out and caps the agent run trail', async () => {
    const owner = await devLogin('ret-events');
    const slug = await createTeam(owner, 'Retention Events');
    const tid = await teamId(slug);
    const uid = await userId('ret-events');
    const runId = await seedRun(uid, tid, 'fp-retention-1');
    await db.insert(agentEvents).values([
      { runId, type: 'ancient', createdAt: ago(400) },
      { runId, type: 'recent', createdAt: ago(1) },
    ]);

    await runCleanupOnce(
      db,
      loadEnv({ nodeEnv: 'test', databaseUrl: undefined, activityRetentionDays: 180 }),
    );
    const kinds = (await db.select({ type: agentEvents.type }).from(agentEvents).where(eq(agentEvents.runId, runId))).map(
      (r) => r.type,
    );
    expect(kinds).toContain('recent');
    expect(kinds).not.toContain('ancient');

    // Cap: a run in a loop truncates its own trail, not another run's.
    const otherRun = await seedRun(uid, tid, 'fp-retention-2');
    await db.insert(agentEvents).values(
      Array.from({ length: 10 }, (_, i) => ({
        runId,
        type: `loop-${String(i).padStart(2, '0')}`,
        createdAt: stamp(i),
      })),
    );
    await db.insert(agentEvents).values({ runId: otherRun, type: 'other-run', createdAt: stamp(1) });
    await trimAgentEvents(db, 4);
    const trail = (
      await db.select({ type: agentEvents.type }).from(agentEvents).where(eq(agentEvents.runId, runId))
    ).map((r) => r.type);
    expect(trail).toHaveLength(4);
    expect(trail).toContain('loop-09');
    expect(trail).not.toContain('loop-00');
    const untouched = await db
      .select({ n: count() })
      .from(agentEvents)
      .where(eq(agentEvents.runId, otherRun));
    expect(untouched[0]!.n).toBe(1);
  });

  it('bounds the announcements channel without touching the debug archive', async () => {
    const owner = await devLogin('ret-messages');
    const slug = await createTeam(owner, 'Retention Messages');
    const tid = await teamId(slug);
    const uid = await userId('ret-messages');
    const channel = await getAnnouncementsSession(db, tid, uid);
    const archived = (
      await db
        .insert(debugSessions)
        .values({
          teamId: tid,
          title: 'ancient but resolved',
          status: 'resolved',
          openedBy: uid,
          createdAt: ago(400),
          resolvedAt: ago(390),
        })
        .returning()
    )[0]!;
    await db.insert(messages).values([
      { sessionId: channel.id, authorId: uid, body: 'ancient announcement', createdAt: ago(400) },
      { sessionId: channel.id, authorId: uid, body: 'fresh announcement', createdAt: ago(1) },
      { sessionId: archived.id, authorId: uid, body: 'the fix that saved us', createdAt: ago(400) },
    ]);

    await runCleanupOnce(
      db,
      loadEnv({
        nodeEnv: 'test',
        databaseUrl: undefined,
        activityRetentionDays: 180,
        sessionRetentionDays: 0, // the default: keep the archive forever
      }),
    );

    const bodies = (
      await db.select({ body: messages.body }).from(messages).where(eq(messages.sessionId, channel.id))
    ).map((r) => r.body);
    expect(bodies).toContain('fresh announcement');
    expect(bodies).not.toContain('ancient announcement');
    // The archive is untouched: an old resolved thread keeps its messages.
    const archive = await db
      .select({ n: count() })
      .from(messages)
      .where(eq(messages.sessionId, archived.id));
    expect(archive[0]!.n).toBe(1);

    // The cap bounds a burst between sweeps, and only inside the channel.
    await db.insert(messages).values(
      Array.from({ length: 8 }, (_, i) => ({
        sessionId: channel.id,
        authorId: uid,
        body: `notice-${String(i).padStart(2, '0')}`,
        createdAt: stamp(i),
      })),
    );
    await trimAnnouncements(db, { days: 0, cap: 3 });
    const capped = await db
      .select({ body: messages.body })
      .from(messages)
      .where(eq(messages.sessionId, channel.id));
    expect(capped).toHaveLength(3);
    expect(capped.map((r) => r.body)).toContain('notice-07');
    expect((await db.select({ n: count() }).from(messages).where(eq(messages.sessionId, archived.id)))[0]!.n).toBe(1);
  });

  it('purges an old resolved session with its messages and read state', async () => {
    const owner = await devLogin('ret-sessions');
    const slug = await createTeam(owner, 'Retention Sessions');
    const tid = await teamId(slug);
    const uid = await userId('ret-sessions');
    const mk = async (title: string, status: string, resolvedAt: Date | null) =>
      (
        await db
          .insert(debugSessions)
          .values({ teamId: tid, title, status, openedBy: uid, resolvedAt, createdAt: ago(400) })
          .returning()
      )[0]!;
    const stale = await mk('stale resolved', 'resolved', ago(120));
    const fresh = await mk('recently resolved', 'resolved', ago(2));
    const open = await mk('still open', 'open', null);
    for (const s of [stale, fresh, open]) {
      await db.insert(messages).values({ sessionId: s.id, authorId: uid, body: `body of ${s.title}` });
      await db.insert(readState).values({ userId: uid, sessionId: s.id });
    }
    const survivorMessages = async () =>
      (
        await db
          .select({ n: count() })
          .from(messages)
          .where(inArray(messages.sessionId, [fresh.id, open.id]))
      )[0]!.n;
    expect(await survivorMessages()).toBe(2);

    await runCleanupOnce(
      db,
      loadEnv({ nodeEnv: 'test', databaseUrl: undefined, sessionRetentionDays: 30 }),
    );

    const left = await db
      .select({ id: debugSessions.id })
      .from(debugSessions)
      .where(eq(debugSessions.teamId, tid));
    const ids = left.map((r) => r.id);
    expect(ids).not.toContain(stale.id);
    expect(ids).toContain(fresh.id);
    expect(ids).toContain(open.id);
    // Cascade: the purged session took its messages and read state with it, and
    // the sessions that stayed kept theirs.
    expect(await survivorMessages()).toBe(2);
    const orphanMessages = await db
      .select({ n: count() })
      .from(messages)
      .where(eq(messages.sessionId, stale.id));
    expect(orphanMessages[0]!.n).toBe(0);
    const orphanRead = await db
      .select({ n: count() })
      .from(readState)
      .where(eq(readState.sessionId, stale.id));
    expect(orphanRead[0]!.n).toBe(0);
  });
});

// ----------------------------------------------------------------- pagination

describe('pagination', () => {
  it('pages the activity feed and says when older events are hidden', async () => {
    const owner = await devLogin('page-activity');
    const slug = await createTeam(owner, 'Paged Activity');
    const tid = await teamId(slug);
    const uid = await userId('page-activity');
    await db.insert(activity).values(
      Array.from({ length: 240 }, (_, i) => ({
        teamId: tid,
        userId: uid,
        action: 'push_snapshot',
        detail: `event-${String(i).padStart(3, '0')}`,
        createdAt: stamp(i),
      })),
    );

    const first = await html(`/app/teams/${slug}/activity`, owner);
    expect(first).toContain('event-239'); // newest
    expect(first).not.toContain('event-100');
    expect(first).toContain('older events are not shown'); // the truncation signal
    expect(first).toContain(`/app/teams/${slug}/activity?page=2`);

    const second = await html(`/app/teams/${slug}/activity?page=2`, owner);
    expect(second).toContain('event-139');
    expect(second).not.toContain('event-239');
    expect(second).toContain(`/app/teams/${slug}/activity">`); // "Newer" back to page 1
    expect(second).toContain(`/app/teams/${slug}/activity?page=3`);

    // Past the end: no rows, no crash, and the view says so instead of looking empty.
    const last = await html(`/app/teams/${slug}/activity?page=9`, owner);
    expect(last).toContain('the feed ends before this page');
    expect(last).not.toContain('?page=10');

    // A junk page parameter falls back to page 1 rather than erroring.
    const junk = await html(`/app/teams/${slug}/activity?page=not-a-number`, owner);
    expect(junk).toContain('event-239');
  });

  it('pages the sessions list', async () => {
    const owner = await devLogin('page-sessions');
    const slug = await createTeam(owner, 'Paged Sessions');
    const tid = await teamId(slug);
    const uid = await userId('page-sessions');
    await db.insert(debugSessions).values(
      Array.from({ length: 60 }, (_, i) => ({
        teamId: tid,
        title: `session-${String(i).padStart(3, '0')}`,
        openedBy: uid,
        createdAt: stamp(i),
      })),
    );

    const first = await html('/app/sessions', owner);
    expect(first).toContain('session-059');
    expect(first).not.toContain('session-000');
    expect(first).toContain('older sessions are not shown');
    expect(first).toContain('/app/sessions?page=2');

    const third = await html('/app/sessions?page=3', owner);
    expect(third).toContain('session-000'); // the oldest is finally reachable
    expect(third).not.toContain('session-059');
  });

  it('shows the newest messages of a long thread first, with older ones a page away', async () => {
    const owner = await devLogin('page-thread');
    const slug = await createTeam(owner, 'Paged Thread');
    const tid = await teamId(slug);
    const uid = await userId('page-thread');
    const session = (
      await db
        .insert(debugSessions)
        .values({ teamId: tid, title: 'long thread', openedBy: uid })
        .returning()
    )[0]!;
    await db.insert(messages).values(
      Array.from({ length: 130 }, (_, i) => ({
        sessionId: session.id,
        authorId: uid,
        body: `msg-${String(i).padStart(3, '0')}`,
        createdAt: stamp(i),
      })),
    );

    const first = await html(`/app/sessions/${session.id}`, owner);
    expect(first).toContain('msg-129'); // the newest message is on the first page
    expect(first).not.toContain('msg-000');
    expect(first).toContain('older messages are not shown');
    expect(first).toContain(`/app/sessions/${session.id}?page=2`);

    const second = await html(`/app/sessions/${session.id}?page=2`, owner);
    expect(second).toContain('msg-000');
    expect(second).not.toContain('msg-129');
  });
});

// ------------------------------------------------------------------ ownership

describe('ownership transfer', () => {
  const roleChange = (j: Jar, slug: string, uid: string, role: string) =>
    fetch(`${srv.url}/app/teams/${slug}/members/${uid}/role`, {
      method: 'POST',
      headers: form(j),
      body: new URLSearchParams({ role }),
      redirect: 'manual',
    });

  it('promotes a member, lets the new owner act, and frees the old owner to leave', async () => {
    const founder = await devLogin('transfer-founder');
    const heir = await devLogin('transfer-heir');
    const slug = await createTeam(founder, 'Succession');
    await joinTeam(founder, heir, slug);
    const tid = await teamId(slug);
    const founderId = await userId('transfer-founder');
    const heirId = await userId('transfer-heir');

    // The trap: before any transfer, the only owner cannot leave.
    const trapped = await fetch(`${srv.url}/app/teams/${slug}/leave`, {
      method: 'POST',
      headers: form(founder),
      redirect: 'manual',
    });
    expect(trapped.status).toBe(302);
    expect(decodeURIComponent(trapped.headers.get('location')!)).toContain('only owner');

    // A member cannot promote anyone — not even themselves.
    const selfPromote = await roleChange(heir, slug, heirId, 'owner');
    expect(selfPromote.status).toBe(403);
    const stillMember = await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.teamId, tid), eq(memberships.userId, heirId)))
      .limit(1);
    expect(stillMember[0]!.role).toBe('member');

    // The owner promotes them.
    const promote = await roleChange(founder, slug, heirId, 'owner');
    expect(promote.status).toBe(302);
    expect(decodeURIComponent(promote.headers.get('location')!)).toContain('is now an owner');
    const promoted = await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.teamId, tid), eq(memberships.userId, heirId)))
      .limit(1);
    expect(promoted[0]!.role).toBe('owner');

    // The promotion is in the team's activity feed.
    const feed = await html(`/app/teams/${slug}/activity`, founder);
    expect(feed).toContain('member_promoted');
    expect(feed).toContain('transfer-heir was made an owner by transfer-founder');

    // The new owner can do owner-only things (here: change team settings).
    const settings = await fetch(`${srv.url}/app/teams/${slug}/settings`, {
      method: 'POST',
      headers: form(heir),
      body: new URLSearchParams({ webhook_url: '' }),
      redirect: 'manual',
    });
    expect(settings.status).toBe(302);
    expect(settings.headers.get('location')).toBe(`/app/teams/${slug}`);

    // And the founder is no longer trapped.
    const left = await fetch(`${srv.url}/app/teams/${slug}/leave`, {
      method: 'POST',
      headers: form(founder),
      redirect: 'manual',
    });
    expect(left.status).toBe(302);
    expect(decodeURIComponent(left.headers.get('location')!)).toContain('You left');
    const remaining = await db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(eq(memberships.teamId, tid));
    expect(remaining.map((r) => r.userId)).toEqual([heirId]);
    expect(remaining.map((r) => r.userId)).not.toContain(founderId);
  });

  it('refuses to demote the last owner and lets an owner step down once there are two', async () => {
    const owner = await devLogin('demote-owner');
    const second = await devLogin('demote-second');
    const slug = await createTeam(owner, 'Last Owner Guard');
    await joinTeam(owner, second, slug);
    const tid = await teamId(slug);
    const ownerId = await userId('demote-owner');
    const secondId = await userId('demote-second');

    // Sole owner demoting themselves: refused, role unchanged.
    const refused = await roleChange(owner, slug, ownerId, 'member');
    expect(refused.status).toBe(302);
    expect(decodeURIComponent(refused.headers.get('location')!)).toContain(
      'A team needs at least one owner',
    );
    const roleAfter = await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.teamId, tid), eq(memberships.userId, ownerId)))
      .limit(1);
    expect(roleAfter[0]!.role).toBe('owner');

    // The page offers no demote control while there is only one owner.
    const page = await html(`/app/teams/${slug}?tab=people`, owner);
    expect(page).toContain('Make owner');
    expect(page).not.toContain('Step down');

    // With a second owner in place, stepping down works…
    expect((await roleChange(owner, slug, secondId, 'owner')).status).toBe(302);
    const stepDown = await roleChange(owner, slug, ownerId, 'member');
    expect(stepDown.status).toBe(302);
    const demoted = await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.teamId, tid), eq(memberships.userId, ownerId)))
      .limit(1);
    expect(demoted[0]!.role).toBe('member');
    // …and the demotion is logged for the team.
    const feed = await html(`/app/teams/${slug}/activity`, second);
    expect(feed).toContain('member_demoted');

    // The demoted founder has really lost owner powers.
    const denied = await roleChange(owner, slug, secondId, 'member');
    expect(denied.status).toBe(403);
    // …and the new sole owner cannot demote themselves either.
    const lastOne = await roleChange(second, slug, secondId, 'member');
    expect(decodeURIComponent(lastOne.headers.get('location')!)).toContain(
      'A team needs at least one owner',
    );
  });

  it('ignores an unknown role and a target outside the team', async () => {
    const owner = await devLogin('role-guard-owner');
    const outsider = await devLogin('role-guard-outsider');
    const slug = await createTeam(owner, 'Role Guards');
    const outsiderId = await userId('role-guard-outsider');
    const ownerId = await userId('role-guard-owner');

    const bogus = await roleChange(owner, slug, ownerId, 'superuser');
    expect(bogus.status).toBe(404);
    const stranger = await roleChange(owner, slug, outsiderId, 'owner');
    expect(stranger.status).toBe(404);
    const notAMember = await roleChange(outsider, slug, ownerId, 'member');
    expect(notAMember.status).toBe(404); // team is invisible to non-members

    // A member id that is not even a uuid is a 404, not a database error.
    for (const route of ['role', 'remove']) {
      const malformed = await fetch(`${srv.url}/app/teams/${slug}/members/not-a-uuid/${route}`, {
        method: 'POST',
        headers: form(owner),
        body: new URLSearchParams({ role: 'owner' }),
        redirect: 'manual',
      });
      expect(malformed.status).toBe(404);
    }
  });
});
