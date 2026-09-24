import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { activity, invites, memberships, teams, users } from '../src/db/schema';
import { createLinkInvite, issueEmailInvites } from '../src/domain/invites';
import { loadEnv, type Env } from '../src/env';
import type { AppExtension } from '../src/extensions';
import { setTeamPlan } from '../src/lib/ceilings';
import { mailOutbox } from '../src/lib/mailer';
import { flushNotificationsOnce } from '../src/lib/notifications';
import { startServer, type StartedServer } from '../src/server';

/**
 * Adding a person to a workspace (2026-09-24).
 *
 * The owner found that there was no team management to speak of: the one way
 * in was a link an owner copied from a tab called People and carried to people
 * by hand, unlimited for a week, and nobody was told when somebody used it.
 * What these hold:
 *
 * - an invitation can be emailed, and then works once and only for an account
 *   holding that address, confirmed — accepting it never counts as confirming,
 *   because the owner can copy the link;
 * - a link says how many people it is for;
 * - the owners are emailed when somebody joins, and when somebody could not
 *   because the workspace is at its plan's member limit, which on a metered
 *   plan the invite card says before anybody is asked, with the price of a
 *   seat on a paid Team;
 * - an invitation opens signup where it is otherwise shut, the way the
 *   terminal door always did, and only for its own address when emailed.
 */
let srv: StartedServer;
let env: Env;
let metered: StartedServer;
let meteredEnv: Env;
let closed: StartedServer;
const dirs: string[] = [];

function jar() {
  const cookies = new Map<string, string>();
  return {
    header(extra: Record<string, string> = {}): Record<string, string> {
      return cookies.size
        ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...extra }
        : { ...extra };
    },
    store(res: Response) {
      for (const line of res.headers.getSetCookie()) {
        const [kv] = line.split(';');
        const i = kv!.indexOf('=');
        const value = kv!.slice(i + 1);
        if (value) cookies.set(kv!.slice(0, i), value);
        else cookies.delete(kv!.slice(0, i));
      }
    },
  };
}
type Jar = ReturnType<typeof jar>;

const post = (
  on: StartedServer,
  url: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
) =>
  fetch(on.url + url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields),
    redirect: 'manual',
  });

const get = async (on: StartedServer, url: string, j?: Jar) => {
  const res = await fetch(on.url + url, { headers: j?.header() ?? {}, redirect: 'manual' });
  return { status: res.status, html: await res.text(), location: res.headers.get('location') ?? '' };
};

const where = (res: Response) => decodeURIComponent(res.headers.get('location') ?? '');

let ip = 0;
async function signup(on: StartedServer, email: string, password: string, next?: string): Promise<Jar> {
  const j = jar();
  const res = await post(
    on,
    '/auth/local/signup',
    { email, password, ...(next ? { next } : {}) },
    { 'x-forwarded-for': `10.61.0.${++ip}` },
  );
  expect(res.status, `signup ${email}`).toBe(302);
  j.store(res);
  return j;
}

function codeFor(email: string): string {
  const mail = mailOutbox.latest(email);
  expect(mail, `no mail for ${email}`).toBeTruthy();
  return /\b(\d{6})\b/.exec(mail!.subject)![1]!;
}

async function confirm(on: StartedServer, email: string, j: Jar, back?: string) {
  const res = await post(
    on,
    '/app/account/email/verify',
    { code: codeFor(email), ...(back ? { back } : {}) },
    j.header(),
  );
  expect(res.status).toBe(302);
  return where(res);
}

async function workspace(on: StartedServer, name: string, j: Jar): Promise<string> {
  const res = await post(on, '/app/teams', { name }, j.header());
  expect(res.status).toBe(302);
  return where(res).replace('/app/teams/', '');
}

const joinCodeIn = (email: string) => /\/join\/([A-Za-z0-9_-]+)/.exec(mailOutbox.latest(email)!.text)![1]!;

async function teamId(on: StartedServer, slug: string) {
  return (await on.db.select({ id: teams.id }).from(teams).where(eq(teams.slug, slug)))[0]!.id;
}

async function roleIn(on: StartedServer, slug: string, email: string) {
  const [row] = await on.db
    .select({ role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(teams, eq(teams.id, memberships.teamId))
    .where(and(eq(users.email, email), eq(teams.slug, slug)));
  return row?.role;
}

const seatPricing: AppExtension = {
  name: 'test-seat-pricing',
  capabilities: { seatPricing: { plan: 'team', included: 5, monthlyCents: 1200, yearlyCents: 12_000 } },
  register() {},
};

beforeAll(async () => {
  const base = { port: 0, host: '127.0.0.1', nodeEnv: 'test' as const, databaseUrl: undefined };
  const dir = () => {
    const made = mkdtempSync(path.join(tmpdir(), 'stma-invitations-'));
    dirs.push(made);
    return made;
  };
  // Configured the way production is: hosted, in beta, with email codes on.
  env = loadEnv({
    ...base,
    pgliteDir: dir(),
    devMode: false,
    twoFactor: true,
    hosted: true,
    betaUnmetered: true,
    baseUrl: 'https://stma.ai',
    notifyDebounceSeconds: 0,
    notifyMaxPerHour: 50,
  });
  srv = await startServer(env);
  // What the service will be once the beta ends: every ceiling applies.
  meteredEnv = loadEnv({
    ...base,
    pgliteDir: dir(),
    devMode: false,
    twoFactor: true,
    hosted: true,
    betaUnmetered: false,
    baseUrl: 'https://stma.ai',
    notifyDebounceSeconds: 0,
    notifyMaxPerHour: 50,
  });
  metered = await startServer(meteredEnv, { extensions: [seatPricing] });
  // A self-hosted server with signup shut and no mail: the invite-only case.
  closed = await startServer(
    loadEnv({ ...base, pgliteDir: dir(), devMode: true, twoFactor: false, signupsOpen: false }),
  );
}, 120_000);

afterAll(async () => {
  await srv?.close();
  await metered?.close();
  await closed?.close();
  mailOutbox.clear();
  for (const made of dirs) rmSync(made, { recursive: true, force: true });
});

let owner: Jar;
let lab: string;

it('emails an invitation per address, and keeps every address out of the subject and the feed', async () => {
  owner = await signup(srv, 'lead@invite.test', 'leadpassword1');
  await confirm(srv, 'lead@invite.test', owner);
  lab = await workspace(srv, 'Invite Lab', owner);

  const people = await get(srv, `/app/teams/${lab}?tab=people`, owner);
  expect(people.html).toContain('Invite people');
  expect(people.html).toContain('Send invitations');
  expect(people.html).toContain('Or share a link');
  expect(people.html, 'the beta has no member limit, and says so').toContain('any number of people');
  expect(people.html).toContain('No invitations waiting');

  const sent = await post(
    srv,
    `/app/teams/${lab}/invites/email`,
    { emails: 'ana@invite.test, Sam@Invite.test\nana@invite.test', role: 'member' },
    owner.header(),
  );
  expect(sent.status).toBe(302);
  expect(where(sent)).toContain('2 invitations sent. Each works for 7 days.');
  expect(where(sent), 'no address travels in the redirect').not.toContain('@invite.test');

  const mail = mailOutbox.latest('ana@invite.test')!;
  expect(mail.kind).toBe('workspace_invite');
  expect(mail.subject).toBe('You are invited to a workspace on STMA');
  expect(mail.text).toContain('lead invited you to the workspace "Invite Lab" on STMA, as a member.');
  expect(mail.text).toContain('https://stma.ai/join/');
  expect(mail.text).toContain('only for an account with this email address');
  expect(mailOutbox.latest('sam@invite.test'), 'addresses are lowercased and deduplicated').toBeTruthy();

  const rows = await srv.db.select().from(invites).where(eq(invites.teamId, await teamId(srv, lab)));
  expect(rows.map((row) => row.email).sort()).toEqual(['ana@invite.test', 'sam@invite.test']);
  for (const row of rows) {
    expect(row.maxUses).toBe(1);
    expect(row.sentAt).toBeTruthy();
  }

  const listed = await get(srv, `/app/teams/${lab}?tab=people`, owner);
  expect(listed.html).toContain('ana@invite.test');
  expect(listed.html).toContain('Send again');
  expect(listed.html).toContain('<!--email_off-->ana@invite.test<!--email_on-->');

  const feed = await srv.db
    .select({ detail: activity.detail })
    .from(activity)
    .where(and(eq(activity.teamId, await teamId(srv, lab)), eq(activity.action, 'invite_created')));
  expect(feed.map((row) => row.detail)).toContain('emailed 2 invitations, joins as member');
  expect(feed.every((row) => !row.detail?.includes('@'))).toBe(true);
});

it('lets the invitee create an account from the invitation, confirm it and join, and tells the owner', async () => {
  const code = joinCodeIn('ana@invite.test');

  // Signed out, the invitation is a page of its own rather than a sign-in form.
  const landing = await get(srv, `/join/${code}`);
  expect(landing.status).toBe(200);
  expect(landing.html).toContain('Join Invite Lab on STMA');
  expect(landing.html).toContain('ana@invite.test');
  expect(landing.html).toContain(`/signup?next=${encodeURIComponent(`/join/${code}`)}`);

  const form = await get(srv, `/signup?next=${encodeURIComponent(`/join/${code}`)}`);
  expect(form.html).toContain('Invite Lab is waiting for you');
  expect(form.html, 'the address comes from the invitation, not the URL').toContain('value="ana@invite.test"');

  const ana = await signup(srv, 'ana@invite.test', 'anapassword12', `/join/${code}`);
  const page = await get(srv, `/join/${code}`, ana);
  expect(page.html).toContain('Confirm that the address is yours to accept it');
  expect(page.html.match(/name="code"/g), 'one code field: the band keeps only its sentence').toHaveLength(1);

  // Accepting is refused until the address is confirmed.
  const early = await post(srv, `/join/${code}`, {}, ana.header());
  expect(where(early)).toBe(`/join/${code}`);
  expect(await roleIn(srv, lab, 'ana@invite.test')).toBeUndefined();

  // Confirming from the invitation comes back to it.
  expect(await confirm(srv, 'ana@invite.test', ana, `/join/${code}`)).toContain(
    `/join/${code}?ok=Address confirmed. You can accept the invitation now.`,
  );
  expect((await get(srv, `/join/${code}`, ana)).html).toContain('Join workspace');

  const joined = await post(srv, `/join/${code}`, {}, ana.header());
  expect(where(joined)).toContain(`/app/teams/${lab}?ok=You joined Invite Lab.`);
  expect(await roleIn(srv, lab, 'ana@invite.test')).toBe('member');
  const [used] = await srv.db.select().from(invites).where(eq(invites.code, code));
  expect(used!.uses).toBe(1);

  // The browser door writes to the feed now, as the terminal door always did.
  const feed = await srv.db
    .select({ action: activity.action, detail: activity.detail })
    .from(activity)
    .where(eq(activity.teamId, await teamId(srv, lab)));
  expect(feed).toContainEqual({ action: 'member_joined', detail: 'ana' });

  // And the owner hears about it.
  await flushNotificationsOnce(srv.db, env);
  const told = mailOutbox.latest('lead@invite.test')!;
  expect(told.subject).toBe('ana joined Invite Lab');
  expect(told.text).toContain('ana joined your workspace Invite Lab as a member.');
  expect(told.text).toContain(`https://stma.ai/app/teams/${lab}?tab=people`);

  // An accepted invitation has done its job and leaves the list.
  const listed = await get(srv, `/app/teams/${lab}?tab=people`, owner);
  expect(listed.html).not.toContain('ana@invite.test');
  expect(listed.html).toContain('sam@invite.test');
});

it('does nothing for an account with another address, and signs out back to the invitation', async () => {
  const code = joinCodeIn('sam@invite.test');
  const mallory = await signup(srv, 'mallory@invite.test', 'mallorypass12');
  await confirm(srv, 'mallory@invite.test', mallory);

  const page = await get(srv, `/join/${code}`, mallory);
  expect(page.html).toContain('It only works for an account with that address.');
  expect(page.html).toContain('sam@invite.test');
  const tried = await post(srv, `/join/${code}`, {}, mallory.header());
  expect(where(tried)).toBe(`/join/${code}`);
  expect(await roleIn(srv, lab, 'mallory@invite.test')).toBeUndefined();

  const out = await post(srv, '/logout', { next: `/join/${code}` }, mallory.header());
  expect(where(out)).toBe(`/join/${code}`);
  // Anything but an invitation still goes home.
  const plain = await signup(srv, 'plain@invite.test', 'plainpassword1');
  expect(where(await post(srv, '/logout', { next: 'https://evil.example/' }, plain.header()))).toBe('/');
});

it('refuses an emailed invitation at the terminal door, and leaves no account behind', async () => {
  const code = joinCodeIn('sam@invite.test');
  const res = await fetch(`${srv.url}/api/invites/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.61.1.1' },
    body: JSON.stringify({ code, email: 'sam@invite.test', password: 'sampassword12' }),
  });
  expect(res.status).toBe(403);
  expect(((await res.json()) as { error: string }).error).toContain('open it in a browser');
  expect(await srv.db.select().from(users).where(eq(users.email, 'sam@invite.test'))).toHaveLength(0);
});

it('asks the same address again by renewing its invitation, not by adding a second', async () => {
  const id = await teamId(srv, lab);
  const before = mailOutbox.all().filter((m) => m.to === 'sam@invite.test').length;
  const again = await post(
    srv,
    `/app/teams/${lab}/invites/email`,
    { emails: 'sam@invite.test', role: 'owner' },
    owner.header(),
  );
  expect(where(again)).toContain('Invitation sent. It works for 7 days.');
  const rows = await srv.db
    .select()
    .from(invites)
    .where(and(eq(invites.teamId, id), eq(invites.email, 'sam@invite.test')));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.role).toBe('owner');
  expect(mailOutbox.all().filter((m) => m.to === 'sam@invite.test')).toHaveLength(before + 1);
  expect(mailOutbox.latest('sam@invite.test')!.text).toContain('as an owner');

  const resent = await post(srv, `/app/teams/${lab}/invites/${rows[0]!.id}/resend`, {}, owner.header());
  expect(where(resent)).toContain('Sent again. It works for another 7 days.');
  expect(mailOutbox.all().filter((m) => m.to === 'sam@invite.test')).toHaveLength(before + 2);
});

it('hands a refused list back as typed, and sends nothing', async () => {
  const bad = await post(
    srv,
    `/app/teams/${lab}/invites/email`,
    { emails: 'good@invite.test, not-an-address', role: 'owner' },
    owner.header(),
  );
  expect(bad.status).toBe(422);
  const html = await bad.text();
  expect(html).toContain('Nothing was sent: &quot;not-an-address&quot; is not an email address.');
  expect(html, 'the typing comes back').toContain('good@invite.test, not-an-address</textarea>');
  expect(html, 'and so does the role').toMatch(/<option value="owner" selected=""/);
  expect(await srv.db.select().from(invites).where(eq(invites.email, 'good@invite.test'))).toHaveLength(0);

  const many = Array.from({ length: 11 }, (_, n) => `p${n}@invite.test`).join(', ');
  const tooMany = await post(srv, `/app/teams/${lab}/invites/email`, { emails: many }, owner.header());
  expect(tooMany.status).toBe(422);
  expect(await tooMany.text()).toContain('Up to 10 addresses at a time, and this was 11.');
});

it('asks an owner with an unconfirmed address to confirm it before emailing anybody', async () => {
  const fresh = await signup(srv, 'fresh@invite.test', 'freshpassword1');
  const slug = await workspace(srv, 'Fresh Lab', fresh);
  const people = await get(srv, `/app/teams/${slug}?tab=people`, fresh);
  expect(people.html).toContain('confirm your own address first');
  expect(people.html).not.toContain('Send invitations');
  expect(people.html, 'a link is still there').toContain('Create link');
  const refused = await post(srv, `/app/teams/${slug}/invites/email`, { emails: 'x@invite.test' }, fresh.header());
  expect(refused.status).toBe(422);
  expect(await refused.text()).toContain('Confirm your own email address first');
  expect(mailOutbox.latest('x@invite.test')).toBeUndefined();
});

it('lets a link in as many people as it says', async () => {
  const made = await post(srv, `/app/teams/${lab}/invites`, { role: 'member', uses: '1' }, owner.header());
  expect(made.status).toBe(302);
  const links = await srv.db
    .select()
    .from(invites)
    .where(and(eq(invites.teamId, await teamId(srv, lab)), isNull(invites.email)));
  const link = links.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).at(-1)!;
  expect(link.maxUses).toBe(1);
  const code = link.code;
  const listed = await get(srv, `/app/teams/${lab}?tab=people`, owner);
  expect(listed.html).toContain('0 of 1 used');

  const first = await signup(srv, 'first@invite.test', 'firstpassword1');
  expect(where(await post(srv, `/join/${code}`, {}, first.header()))).toContain(`/app/teams/${lab}?ok=`);
  const second = await signup(srv, 'second@invite.test', 'secondpassword1');
  const spent = await get(srv, `/join/${code}`, second);
  expect(spent.status).toBe(404);
  expect(spent.html).toContain('This invitation is no longer valid');
});

it('is found from People and agents, Overview and Account, and says workspace', async () => {
  const roster = await get(srv, `/app/teams/${lab}/agents`, owner);
  expect(roster.html).toContain(`/app/teams/${lab}?tab=people#invites`);
  expect(roster.html).toContain('Invite people');
  const overview = await get(srv, `/app/teams/${lab}`, owner);
  expect(overview.html).toContain('Members and invites');
  const account = await get(srv, '/app/account', owner);
  const card = account.html.slice(account.html.indexOf('id="plan"'));
  expect(card).toContain('<th>People</th>');
  expect(card).toContain(`href="/app/teams/${lab}?tab=people"`);
  const settings = await get(srv, `/app/teams/${lab}?tab=settings`, owner);
  expect(settings.html).toContain('Leave workspace');
  expect(settings.html).toContain('Delete workspace');
  expect(settings.html).not.toContain('Leave team');
});

it('says a workspace is full before anybody is asked, and tells the owner when somebody tried', async () => {
  const lead = await signup(metered, 'lead@full.test', 'leadpassword1');
  await confirm(metered, 'lead@full.test', lead);
  const slug = await workspace(metered, 'Full Lab', lead);

  const people = await get(metered, `/app/teams/${slug}?tab=people`, lead);
  expect(people.html).toContain('This workspace is full.');
  expect(people.html).toContain('The Cloud Free plan is for one person');
  expect(people.html).toContain('1 / 1');
  expect(people.html).not.toContain('Send invitations');
  expect(people.html, 'a gift or the beta is not metered, and Free has no seat price').not.toContain('a month to the bill');

  const refused = await post(metered, `/app/teams/${slug}/invites`, { uses: '5' }, lead.header());
  expect(where(refused)).toContain('This workspace is full.');
  const id = await teamId(metered, slug);
  expect(await metered.db.select().from(invites).where(eq(invites.teamId, id))).toHaveLength(0);

  // An invitation made before the ceiling came down still reaches the door.
  const [leadRow] = await metered.db.select().from(users).where(eq(users.email, 'lead@full.test'));
  const link = await createLinkInvite(metered.db, { teamId: id, createdBy: leadRow!.id, role: 'member', uses: '5' });
  const guest = await signup(metered, 'guest@full.test', 'guestpassword1');
  const page = await get(metered, `/join/${link.code}`, guest);
  expect(page.html).toContain('Full Lab is full');
  expect(page.html).toContain('Tell the owners I tried');
  const tried = await post(metered, `/join/${link.code}`, {}, guest.header());
  expect(tried.status).toBe(409);
  expect(await tried.text()).toContain('Its owners have been told you tried.');
  await post(metered, `/join/${link.code}`, {}, guest.header());
  const refusals = await metered.db
    .select()
    .from(activity)
    .where(and(eq(activity.teamId, id), eq(activity.action, 'join_refused')));
  expect(refusals, 'once an hour per person, however often they press').toHaveLength(1);

  await flushNotificationsOnce(metered.db, meteredEnv);
  const told = mailOutbox.latest('lead@full.test')!;
  expect(told.subject).toBe('Full Lab is full');
  expect(told.text).toContain('guest tried to join your workspace Full Lab with an invitation');
  expect(told.text).toContain('the 1 person its free plan allows');

  // On a paid Team the card says what a join costs before the invitation goes.
  await setTeamPlan(metered.db, { teamId: id, plan: 'team', source: 'operator', route: 'test' });
  const team = await get(metered, `/app/teams/${slug}?tab=people`, lead);
  expect(team.html).toContain('1 / 50');
  expect(team.html).toContain('Team includes 5 people. Each person beyond 5 adds $12 a month');
  expect(team.html).toContain('$120 a year on annual billing');
  expect(team.html).toContain('Send invitations');
});

it('opens signup for an invitation where signup is otherwise shut, for its own address only', async () => {
  const lead = jar();
  const dev = await post(closed, '/auth/dev', { username: 'closedlead' });
  lead.store(dev);
  const slug = await workspace(closed, 'Closed Lab', lead);
  const people = await get(closed, `/app/teams/${slug}?tab=people`, lead);
  expect(people.html).toContain('This server does not confirm email addresses');
  expect(people.html).not.toContain('Send invitations');

  expect((await post(closed, `/app/teams/${slug}/invites`, {}, lead.header())).status).toBe(302);
  const code = /\/join\/([A-Za-z0-9_-]+)/.exec((await get(closed, `/app/teams/${slug}?tab=people`, lead)).html)![1]!;

  // Shut to anybody without an invitation, exactly as before.
  expect((await get(closed, '/signup')).location).toBe('/login');
  expect((await post(closed, '/auth/local/signup', { email: 'x@closed.test', password: 'xpassword123' })).status).toBe(404);

  const form = await get(closed, `/signup?next=${encodeURIComponent(`/join/${code}`)}`);
  expect(form.status).toBe(200);
  expect(form.html).toContain('Closed Lab is waiting for you');
  const newcomer = await signup(closed, 'new@closed.test', 'newpassword123', `/join/${code}`);
  expect(where(await post(closed, `/join/${code}`, {}, newcomer.header()))).toContain(`/app/teams/${slug}?ok=`);
  expect(await roleIn(closed, slug, 'new@closed.test')).toBe('member');

  // An emailed invitation opens the door for its own address and no other.
  const [leadRow] = await closed.db.select().from(users).where(eq(users.username, 'closedlead'));
  const [emailed] = await issueEmailInvites(closed.db, {
    teamId: await teamId(closed, slug),
    createdBy: leadRow!.id,
    role: 'member',
    emails: ['only@closed.test'],
  });
  const other = await post(closed, '/auth/local/signup', {
    email: 'other@closed.test',
    password: 'otherpassword1',
    next: `/join/${emailed!.invite.code}`,
  });
  expect(where(other)).toContain('This invitation is for another address.');
  expect(await closed.db.select().from(users).where(eq(users.email, 'other@closed.test'))).toHaveLength(0);
});
