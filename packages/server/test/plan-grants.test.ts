import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db';
import { activity, ceilingChanges, planGrants, teams, users } from '../src/db/schema';
import { betaLedger } from '../src/domain/betaCohorts';
import { loadEnv } from '../src/env';
import { runCleanupOnce } from '../src/lib/cleanup';
import {
  PLANS,
  UNMETERED,
  effectiveLimits,
  effectivePlanLabel,
  withEntitlements,
} from '../src/lib/entitlements';
import {
  MAX_GRANT_NOTE,
  activePlanGrant,
  describeGrant,
  endsAtFromLastDay,
  grantLastDay,
  normalizeGrantNote,
  revokePlanGrant,
  setPlanGrant,
} from '../src/lib/planGrants';
import { startServer, type StartedServer } from '../src/server';

/**
 * A plan an operator gives a workspace, beside the plan it has.
 *
 * The owner's case: "I'm going to give my friend a subscription from the admin
 * panel", unlimited or with an end date. What has to hold is that every gate
 * sees it (it is resolved where every gate already reads the matrix), that it
 * ends by the clock with nothing to undo, that the history sweep follows it,
 * and that the operator's own pages measure a gifted workspace against what it
 * was given rather than against free.
 */

let srv: StartedServer;
let db: Db;
let dataDir: string;

const ADMIN = 'grant-admin';
const DAY = 86_400_000;

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

const post = (url: string, j: Jar, fields: Record<string, string> = {}) =>
  fetch(`${srv.url}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...j.header() },
    body: new URLSearchParams(fields),
    redirect: 'manual',
  });

const get = (url: string, j: Jar) => fetch(`${srv.url}${url}`, { headers: j.header() });

async function createTeam(j: Jar, name: string) {
  const res = await post('/app/teams', j, { name });
  expect(res.status).toBe(302);
  const slug = res.headers.get('location')!.split('/').pop()!;
  const team = (await db.select().from(teams).where(eq(teams.slug, slug)).limit(1))[0]!;
  return team;
}

async function userId(username: string): Promise<string> {
  return (await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1))[0]!.id;
}

const grantHistory = (teamId: string) =>
  db
    .select()
    .from(ceilingChanges)
    .where(and(eq(ceilingChanges.teamId, teamId), eq(ceilingChanges.field, 'grant')))
    .orderBy(desc(ceilingChanges.at));

/** A last day `days` from now, as the form sends it. */
const dayFromNow = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

let admin: Jar;

beforeAll(async () => {
  process.env.ADMIN_USERNAMES = ADMIN;
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-grants-'));
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
  db = srv.db;
  delete process.env.ADMIN_USERNAMES;
  admin = await devLogin(ADMIN);
}, 60_000);

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// --------------------------------------------------------------- the pure half

describe('what a last day means', () => {
  const now = new Date('2026-09-21T12:00:00.000Z');

  it('keeps the day the operator typed, included', () => {
    const parsed = endsAtFromLastDay('2026-12-31', now);
    if ('error' in parsed) throw new Error(parsed.error);
    // Through the thirty-first means the first of January is the first
    // instant it no longer applies — and the page reads the typed day back.
    expect(parsed.endsAt.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(grantLastDay(parsed.endsAt)).toBe('2026-12-31');
    expect(describeGrant({ plan: 'team', endsAt: parsed.endsAt })).toBe('team through 2026-12-31');
    expect(describeGrant({ plan: 'solo', endsAt: null })).toBe('solo, no end date');
  });

  it('allows today and refuses what is not a coming day', () => {
    expect('endsAt' in endsAtFromLastDay('2026-09-21', now)).toBe(true);
    expect(endsAtFromLastDay('2026-09-20', now)).toEqual({
      error: '2026-09-20 has already passed. Choose today or a later day.',
    });
    // Date would roll this into March without the round trip.
    expect(endsAtFromLastDay('2026-02-30', now)).toEqual({ error: '2026-02-30 is not a date.' });
    expect('error' in endsAtFromLastDay('soon', now)).toBe(true);
    expect('error' in endsAtFromLastDay('', now)).toBe(true);
  });

  it('keeps the note short, single-line and absent rather than empty', () => {
    expect(normalizeGrantNote('  launch   friend\n until he ships ')).toBe('launch friend until he ships');
    expect(normalizeGrantNote('   ')).toBeNull();
    expect(normalizeGrantNote(undefined)).toBeNull();
    expect(normalizeGrantNote('x'.repeat(500))!.length).toBe(MAX_GRANT_NOTE);
  });
});

// ------------------------------------------------- every gate sees it, or none

describe('a grant decides every gate while it lasts', () => {
  it('opens a gated page, labels the plan, and closes it again on revoke', async () => {
    const owner = await devLogin('grant-gate-owner');
    const team = await createTeam(owner, 'Grant Gate');
    // Governance is the clearest gate to watch from outside: a free workspace
    // gets the explanation with 402, a workspace that has it gets the page.
    expect((await get(`/app/teams/${team.slug}/governance`, owner)).status).toBe(402);

    const given = await setPlanGrant(db, {
      teamId: team.id,
      plan: 'team',
      endsAt: null,
      note: null,
      actorId: null,
      actorLabel: ADMIN,
      route: 'test',
    });
    expect(given?.changed).toBe(true);
    expect((await get(`/app/teams/${team.slug}/governance`, owner)).status).toBe(200);

    const limits = await effectiveLimits(db, team, true);
    expect(limits.governance).toBe(true);
    expect(limits.maxMembers).toBe(PLANS.team.maxMembers);
    expect(limits.grant).toEqual({ plan: 'team', endsAt: null });
    expect(effectivePlanLabel(team.plan, limits)).toBe('team · complimentary');
    // The column is never written: the grant rides beside it.
    expect((await db.select().from(teams).where(eq(teams.id, team.id)))[0]!.plan).toBe('free');

    // The owner reads the same label in the status strip of their workspace.
    const home = await (await get(`/app/teams/${team.slug}`, owner)).text();
    expect(home).toContain('plan team · complimentary');

    await revokePlanGrant(db, { teamId: team.id, actorId: null, actorLabel: ADMIN, route: 'test' });
    expect((await get(`/app/teams/${team.slug}/governance`, owner)).status).toBe(402);
    expect((await effectiveLimits(db, team, true)).grant).toBeUndefined();
  });

  it('names the last day in the label of a dated grant', async () => {
    const owner = await devLogin('grant-dated-owner');
    const team = await createTeam(owner, 'Grant Dated');
    const last = dayFromNow(30);
    const parsed = endsAtFromLastDay(last);
    if ('error' in parsed) throw new Error(parsed.error);
    await setPlanGrant(db, {
      teamId: team.id,
      plan: 'solo',
      endsAt: parsed.endsAt,
      note: null,
      actorId: null,
      actorLabel: ADMIN,
      route: 'test',
    });
    const limits = await effectiveLimits(db, team, true);
    expect(effectivePlanLabel(team.plan, limits)).toBe(`solo · complimentary through ${last}`);
  });

  it('ends by the clock: an ended grant decides nothing and nothing had to be written', async () => {
    const owner = await devLogin('grant-ended-owner');
    const team = await createTeam(owner, 'Grant Ended');
    await db.insert(planGrants).values({
      teamId: team.id,
      plan: 'team',
      endsAt: new Date(Date.now() - 60_000),
      grantedByLabel: ADMIN,
    });
    expect(await activePlanGrant(db, team.id)).toBeNull();
    expect((await effectiveLimits(db, team, true)).governance).toBe(false);
    expect((await get(`/app/teams/${team.slug}/governance`, owner)).status).toBe(402);
  });

  it('is not read where plans decide nothing: the beta and a self-hosted instance', async () => {
    const owner = await devLogin('grant-regime-owner');
    const team = await createTeam(owner, 'Grant Regime');
    await setPlanGrant(db, {
      teamId: team.id,
      plan: 'solo',
      endsAt: null,
      note: null,
      actorId: null,
      actorLabel: ADMIN,
      route: 'test',
    });
    // The private beta: hosted, unmetered. Every ceiling is already lifted, and
    // a grant must not narrow that to Solo.
    const beta = await withEntitlements(undefined, () => effectiveLimits(db, team, true), true, true);
    expect(beta).toEqual(UNMETERED);
    // Self-hosted: the matrix does not apply at all.
    expect(await effectiveLimits(db, team, false)).toEqual(UNMETERED);
  });
});

// ------------------------------------------------------------ the operator door

describe('the operator gives, changes and takes back', () => {
  it('is an undisclosed area to anybody who is not an operator', async () => {
    const owner = await devLogin('grant-stranger');
    const team = await createTeam(owner, 'Grant Stranger');
    const res = await post(`/admin/teams/${team.id}/grant`, owner, { plan: 'team', ends: 'never' });
    expect(res.status).toBe(404);
    expect(await activePlanGrant(db, team.id)).toBeNull();
  });

  it('gives a dated plan, records who and until when, and keeps the note out of the history', async () => {
    const owner = await devLogin('grant-friend');
    const team = await createTeam(owner, 'Friend Workspace');
    const last = dayFromNow(90);

    const res = await post(`/admin/teams/${team.id}/grant`, admin, {
      plan: 'team',
      ends: 'date',
      last_day: last,
      note: '  launch   friend ',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain(`/admin/teams/${team.id}?ok=`);
    expect(res.headers.get('location')).toContain('#plan-grant');

    const row = (await db.select().from(planGrants).where(eq(planGrants.teamId, team.id)))[0]!;
    expect(row.plan).toBe('team');
    expect(grantLastDay(row.endsAt!)).toBe(last);
    expect(row.note).toBe('launch friend');
    expect(row.grantedByLabel).toBe(ADMIN);
    expect(row.grantedBy).toBe(await userId(ADMIN));

    const history = await grantHistory(team.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      previous: null,
      next: `team through ${last}`,
      source: 'operator',
      actorLabel: ADMIN,
      route: 'POST /admin/teams/:id/grant',
    });
    // The note is the operator's own words; the record is composed from facts.
    expect(history[0]!.detail).not.toContain('launch friend');

    // The same form twice is not a second change.
    await post(`/admin/teams/${team.id}/grant`, admin, {
      plan: 'team',
      ends: 'date',
      last_day: last,
      note: 'launch friend',
    });
    expect(await grantHistory(team.id)).toHaveLength(1);

    // A note-only edit moves no ceiling and writes no history row.
    await post(`/admin/teams/${team.id}/grant`, admin, {
      plan: 'team',
      ends: 'date',
      last_day: last,
      note: 'launch friend, second wave',
    });
    expect(await grantHistory(team.id)).toHaveLength(1);
    expect((await activePlanGrant(db, team.id))!.note).toBe('launch friend, second wave');

    // Wide authority: from a dated Team to an unlimited Enterprise in one step.
    await post(`/admin/teams/${team.id}/grant`, admin, { plan: 'enterprise', ends: 'never' });
    const changed = await grantHistory(team.id);
    expect(changed).toHaveLength(2);
    expect(changed[0]).toMatchObject({ previous: `team through ${last}`, next: 'enterprise, no end date' });
    expect((await effectiveLimits(db, team, true)).grant).toEqual({ plan: 'enterprise', endsAt: null });
  });

  it('shows the grant where the operator looks for it', async () => {
    const owner = await devLogin('grant-shown');
    const team = await createTeam(owner, 'Grant Shown');
    await post(`/admin/teams/${team.id}/grant`, admin, {
      plan: 'solo',
      ends: 'never',
      note: 'design partner',
    });

    const detail = await (await get(`/admin/teams/${team.id}`, admin)).text();
    expect(detail).toContain('data-card="plan-grant"');
    expect(detail).toContain('data-grant-state="active"');
    expect(detail).toContain('with no end date');
    expect(detail).toContain(`given by ${ADMIN}`);
    expect(detail).toContain('design partner');
    expect(detail).toContain('solo, given');
    // What happens at the end is said before anybody picks a date.
    expect(detail).toContain('data-grant-retention');
    expect(detail).toContain('older than 90 days are deleted at the next sweep');

    const list = await (await get('/admin/teams', admin)).text();
    expect(list).toContain(`data-grant="${team.slug}"`);
    expect(list).toContain('given solo, no end date');
  });

  it('refuses what is not a grant and changes nothing', async () => {
    const owner = await devLogin('grant-refused');
    const team = await createTeam(owner, 'Grant Refused');
    const refused: Record<string, string>[] = [
      { plan: 'free', ends: 'never' },
      { plan: 'pro', ends: 'never' },
      { plan: 'team', ends: 'date', last_day: '2026-02-30' },
      { plan: 'team', ends: 'date', last_day: '2020-01-01' },
      { plan: 'team', ends: 'date', last_day: '' },
    ];
    for (const fields of refused) {
      const res = await post(`/admin/teams/${team.id}/grant`, admin, fields);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('?error=');
    }
    expect(await activePlanGrant(db, team.id)).toBeNull();
    expect(await grantHistory(team.id)).toHaveLength(0);
  });

  it('takes a grant back, and says so when there was nothing to take', async () => {
    const owner = await devLogin('grant-revoked');
    const team = await createTeam(owner, 'Grant Revoked');
    await post(`/admin/teams/${team.id}/grant`, admin, { plan: 'team', ends: 'never' });

    const res = await post(`/admin/teams/${team.id}/grant/revoke`, admin);
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get('location')!)).toContain('back on its own plan, free');
    expect(await activePlanGrant(db, team.id)).toBeNull();
    const history = await grantHistory(team.id);
    expect(history[0]).toMatchObject({ previous: 'team, no end date', next: null, source: 'operator' });

    const again = await post(`/admin/teams/${team.id}/grant/revoke`, admin);
    expect(decodeURIComponent(again.headers.get('location')!)).toContain('has no complimentary plan');
    expect(await grantHistory(team.id)).toHaveLength(history.length);
  });

  it('clears an ended grant without recording a ceiling change', async () => {
    const owner = await devLogin('grant-cleared');
    const team = await createTeam(owner, 'Grant Cleared');
    await db.insert(planGrants).values({
      teamId: team.id,
      plan: 'solo',
      endsAt: new Date(Date.now() - DAY),
      grantedByLabel: ADMIN,
    });
    const detail = await (await get(`/admin/teams/${team.id}`, admin)).text();
    expect(detail).toContain('data-grant-state="ended"');
    const res = await post(`/admin/teams/${team.id}/grant/revoke`, admin);
    expect(decodeURIComponent(res.headers.get('location')!)).toContain('Cleared the ended grant');
    expect(await grantHistory(team.id)).toHaveLength(0);
  });
});

// ------------------------------------------------- history follows the plan in force

describe('the history sweep keeps what the plan in force keeps', () => {
  it('keeps a gifted workspace like its gift, and sweeps it like its own plan once the gift ends', async () => {
    const owner = await devLogin('grant-history');
    const gifted = await createTeam(owner, 'Grant History Gifted');
    const plain = await createTeam(owner, 'Grant History Plain');
    const uid = await userId('grant-history');
    const ago = (days: number) => new Date(Date.now() - days * DAY);
    await db.insert(activity).values([
      { teamId: gifted.id, userId: uid, action: 'gifted-120', createdAt: ago(120) },
      { teamId: plain.id, userId: uid, action: 'plain-120', createdAt: ago(120) },
    ]);
    await setPlanGrant(db, {
      teamId: gifted.id,
      plan: 'team',
      endsAt: null,
      note: null,
      actorId: null,
      actorLabel: ADMIN,
      route: 'test',
    });

    const hostedEnv = loadEnv({
      nodeEnv: 'test',
      databaseUrl: undefined,
      hosted: true,
      activityRetentionDays: 180,
    });
    await runCleanupOnce(db, hostedEnv);
    const actions = async () =>
      (
        await db
          .select({ action: activity.action })
          .from(activity)
          .where(inArray(activity.teamId, [gifted.id, plain.id]))
      ).map((r) => r.action);
    // Free keeps 90 days; Team keeps everything. The gift is Team.
    expect(await actions()).toEqual(['gifted-120']);

    // The gift ends. Nothing is written when it does; the next sweep simply
    // reads free again, exactly as it would for a paid plan that ended.
    await db
      .update(planGrants)
      .set({ endsAt: new Date(Date.now() - 1000) })
      .where(eq(planGrants.teamId, gifted.id));
    await runCleanupOnce(db, hostedEnv);
    expect(await actions()).toEqual([]);
  });
});

// ------------------------------------------ the beta page measures against the gift

describe('the beta ledger measures a workspace against the plan it lands on', () => {
  it('lands a gifted workspace on its gift and everybody else on their own plan', async () => {
    const owner = await devLogin('grant-beta');
    const gifted = await createTeam(owner, 'Grant Beta Gifted');
    const plain = await createTeam(owner, 'Grant Beta Plain');
    await setPlanGrant(db, {
      teamId: gifted.id,
      plan: 'team',
      endsAt: null,
      note: null,
      actorId: null,
      actorLabel: ADMIN,
      route: 'test',
    });

    const ledger = await betaLedger(db);
    const row = (id: string) => ledger.workspaces.find((w) => w.teamId === id)!;
    expect(row(gifted.id).landsOn).toBe('team');
    expect(row(gifted.id).grant).toEqual({ plan: 'team', endsAt: null });
    expect(row(gifted.id).ceilings.find((c) => c.key === 'members')!.limit).toBe(PLANS.team.maxMembers);
    // Team carries every feature switch, so the flip closes nothing here.
    expect(row(gifted.id).features.filter((f) => f.state !== 'kept')).toEqual([]);
    expect(row(gifted.id).losing).toEqual([]);

    expect(row(plain.id).landsOn).toBe('free');
    expect(row(plain.id).grant).toBeNull();
    expect(row(plain.id).ceilings.find((c) => c.key === 'members')!.limit).toBe(PLANS.free.maxMembers);

    const page = await (await get('/admin/beta', admin)).text();
    expect(page).toContain('data-lands-on="team"');
    expect(page).toContain('Given a plan');
    expect(page).not.toContain('Distance to the free ceilings');
  });
});
