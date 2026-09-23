import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { teams, users } from '../src/db/schema';
import { loadEnv } from '../src/env';
import { MONTH_MS, hitCounter } from '../src/lib/counters';
import { startServer, type StartedServer } from '../src/server';

/**
 * The private beta's two switches.
 *
 * `SIGNUP_ACCESS_CODES` is the door: hosted signup is open in the sense that
 * anybody with a code can make an account, and closed in the sense that nobody
 * else can. `BETA_UNMETERED` is the answer to "which plan am I on" while there
 * is nothing to buy — every workspace has everything, and no ceiling refuses
 * work somebody cannot pay their way out of.
 *
 * Both are deliberately invisible to a self-hosted instance, which is why the
 * unconfigured server here has to keep behaving exactly as it always did.
 */

let beta: StartedServer;
let betaDir: string;

const CODE = 'stma-beta-cohort-one';
/**
 * A configured code the operator gave no `:label` to.
 *
 * The corner the storage has to keep separate: it is not a cohort, and it is
 * also not "arrived before the beta". Both would otherwise be null.
 */
const UNLABELLED = 'stma-beta-no-label';
/** The operator reading the console — an address, so the file needs no dev login. */
const ADMIN = 'ada@example.dev';

const form = (url: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });

/**
 * One server for the whole file. The embedded fixtures are memory-heavy enough
 * that the suite caps workers at two, so a file that holds a second server open
 * for tests that do not need it starves the ones running beside it.
 */
const BASE = {
  port: 0,
  host: '127.0.0.1',
  nodeEnv: 'test' as const,
  devMode: false,
  databaseUrl: undefined,
};

beforeAll(async () => {
  betaDir = mkdtempSync(path.join(tmpdir(), 'stma-beta-'));
  beta = await startServer(
    loadEnv({
      ...BASE,
      pgliteDir: betaDir,
      hosted: true,
      betaUnmetered: true,
      publicMode: 'teaser',
      signupAccessCodes: [{ code: CODE, label: 'cohort-one' }, { code: UNLABELLED }],
      demoLogins: [{ email: 'shown@example.dev', password: 'hunter2' }],
      // The beta ledger is an operator page, so the fixture needs an operator.
      // An address rather than a username because this server has no dev login.
      adminEmails: [ADMIN],
    }),
  );
});

afterAll(async () => {
  await beta?.close();
  rmSync(betaDir, { recursive: true, force: true });
});

it('refuses signup without the access code and accepts it with', async () => {
  const page = await (await fetch(`${beta.url}/signup`)).text();
  expect(page).toContain('Access code');
  expect(page).toContain('private beta');
  // The form must never print the code it is checking against.
  expect(page).not.toContain(CODE);

  const wrong = await form(`${beta.url}/auth/local/signup`, {
    access_code: 'not-the-code',
    email: 'nobody@example.dev',
    password: 'correct horse battery',
  });
  expect(wrong.status).toBe(302);
  expect(decodeURIComponent(wrong.headers.get('location') ?? '')).toContain(
    'access code is not valid',
  );

  const right = await form(`${beta.url}/auth/local/signup`, {
    access_code: CODE,
    email: ADMIN,
    password: 'correct horse battery',
  });
  expect(right.status).toBe(302);
  expect(right.headers.get('location')).not.toContain('error');
});

/**
 * The cohort has to outlive the log line.
 *
 * It used to reach one `logLine` at signup and nowhere else, and that log is
 * swept at thirty days — so a beta that runs longer than a month could not say
 * which wave a workspace came from. The column is the fix, and the three states
 * it can hold are the whole point: a named cohort, a code the operator named
 * nothing for, and no code at all. Two of those would collapse into null if the
 * door only recorded a label.
 */
it('stores the cohort an account arrived through, and never the code', async () => {
  const cohortOf = async (email: string) =>
    (await beta.db.select().from(users).where(eq(users.email, email)).limit(1))[0]?.signupCohort;

  expect(await cohortOf(ADMIN)).toBe('cohort-one');

  const unlabelled = await form(`${beta.url}/auth/local/signup`, {
    access_code: UNLABELLED,
    email: 'bo@example.dev',
    password: 'correct horse battery',
  });
  expect(unlabelled.status).toBe(302);
  // Not null: this account came through the door. Not a label either, because
  // the operator typed none and the console must not invent one.
  expect(await cohortOf('bo@example.dev')).toBe('');

  // The rule the whole access-code module is built around, asserted where it
  // would now be easiest to break: a stored cohort must never be a stored code.
  const stored = await beta.db.select({ cohort: users.signupCohort }).from(users);
  for (const row of stored) {
    expect(row.cohort).not.toBe(CODE);
    expect(row.cohort).not.toBe(UNLABELLED);
  }
});

it('checks the code before the address, so the door cannot confirm an account', async () => {
  // ada@example.dev now exists. Without a code the answer must be about the
  // code and nothing else — otherwise the form reports who has an account to
  // somebody who was never let in.
  const res = await form(`${beta.url}/auth/local/signup`, {
    access_code: 'still-wrong',
    email: 'ada@example.dev',
    password: 'correct horse battery',
  });
  const location = decodeURIComponent(res.headers.get('location') ?? '');
  expect(location).toContain('access code is not valid');
  expect(location).not.toContain('already exists');
});

it('never prints example accounts on a hosted sign-in page', async () => {
  const page = await (await fetch(`${beta.url}/login`)).text();
  expect(page).not.toContain('shown@example.dev');
  expect(page).not.toContain('Demo accounts');
});

/** A cookie jar and the sign-in that fills it — two tests need the same one. */
async function signIn(email: string) {
  const jar = new Map<string, string>();
  const res = await form(`${beta.url}/auth/local/login`, {
    email,
    password: 'correct horse battery',
  });
  for (const line of res.headers.getSetCookie()) {
    const [kv] = line.split(';');
    const i = kv!.indexOf('=');
    jar.set(kv!.slice(0, i), kv!.slice(i + 1));
  }
  return { header: () => ({ cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') }) };
}

/** A personal token for a signed-in account: what its agent would carry. */
async function tokenFor(header: () => Record<string, string>) {
  const res = await form(`${beta.url}/app/tokens`, { name: 'beta-machine' }, header());
  const token = /stma_[0-9a-f]{40}/.exec(await res.text())?.[0] ?? '';
  expect(token, 'a token from /app/tokens').toBeTruthy();
  return token;
}

async function pushSnapshot(token: string, team: string, device: string) {
  const res = await fetch(`${beta.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'push_snapshot',
        arguments: { team, device, snapshot: { os: { platform: 'linux', arch: 'x64' } } },
      },
    }),
  });
  const json = (await res.json()) as {
    result?: { content?: { text: string }[]; isError?: boolean };
    error?: { message?: string };
  };
  return {
    isError: json.result?.isError === true || json.error !== undefined,
    text: json.result?.content?.[0]?.text ?? json.error?.message ?? '',
  };
}

it('gives a beta workspace every feature and no ceiling that refuses work', async () => {
  const { header } = await signIn(ADMIN);
  await form(`${beta.url}/app/teams`, { name: 'Northwind' }, header());

  // Governance is the plan gate a free hosted workspace would meet first.
  const governance = await fetch(`${beta.url}/app/teams/northwind/governance`, {
    headers: header(),
  });
  expect(governance.status).toBe(200);
  // The workspace page is where the plan label lives. "free" beside a console
  // with every feature on is the one label that is certainly wrong.
  const label = await (
    await fetch(`${beta.url}/app/teams/northwind`, { headers: header() })
  ).text();
  expect(label).toContain('plan Beta');
  expect(label).not.toContain('plan free');
});

/**
 * The one ceiling the beta keeps (decided 2026-09-21), said where somebody reads
 * their history. Both pages printed the environment's retention, 180 unless set,
 * which the hosted service does not apply to these tables at all.
 */
it('tells a beta workspace how long its history lasts, in the number the sweep uses', async () => {
  const { header } = await signIn(ADMIN);
  for (const path of ['/app/teams/northwind/activity', '/app/teams/northwind/people/ada']) {
    const res = await fetch(`${beta.url}${path}`, { headers: header() });
    expect(res.status, path).toBe(200);
    const html = await res.text();
    expect(html, path).toContain('purged after 90 days');
    expect(html, path).not.toContain('purged after 180 days');
  }
});

/**
 * The operator console's answer to "who did we give how much beta to".
 *
 * The distance, not the arrival: `/admin/usage` already draws signups. What
 * this page owes is what unsetting `BETA_UNMETERED` costs each workspace, so
 * the assertion that matters is a ceiling read from the limiter's own counter
 * and reported as already past.
 */
it('answers, per workspace, the cohort and the distance to the plan it lands on', async () => {
  // An operator address counts once a code mailed to it came back (audit
  // 2026-09-21, F1). This server sends no codes, so the fixture records the
  // proof the way the confirm form would; the gate itself is tested in
  // `audit-2026-09-21.test.ts`.
  await beta.db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.email, ADMIN));
  const { header } = await signIn(ADMIN);
  // The second wave, so the page has to render both a named cohort and the one
  // the operator gave no name to. A workspace is what the ledger lists, so the
  // unnamed account has to have made one.
  const bo = await signIn('bo@example.dev');
  await form(`${beta.url}/app/teams`, { name: 'Contoso' }, bo.header());

  const northwind = (
    await beta.db.select().from(teams).where(eq(teams.slug, 'northwind')).limit(1)
  )[0]!;

  // Four handoffs against a free ceiling of three, spent through the same
  // function `handoffAllowance` spends them through. Writing the row directly
  // would prove the page can read a table; this proves it reads the meter.
  for (let i = 0; i < 4; i += 1) {
    await hitCounter(beta.db, 'handoff-month', northwind.id, MONTH_MS, 3);
  }

  // Three machines of one member against a free ceiling of two, pushed through
  // push_snapshot itself. The beta lifts the gate, so all three are stored —
  // and the page counts them the way the gate will the day the flag is unset.
  const token = await tokenFor(header);
  for (const device of ['macbook', 'win-desktop', 'win-laptop']) {
    const pushed = await pushSnapshot(token, 'northwind', device);
    expect(pushed.isError, pushed.text).toBe(false);
  }

  const page = await fetch(`${beta.url}/admin/beta`, { headers: header() });
  expect(page.status).toBe(200);
  const html = await page.text();

  // Which wave, and the wave that has no name — both spelled by describeCohort.
  expect(html).toContain('cohort-one');
  expect(html).toContain('Unnamed code');
  // What it has used since, and which ceiling it is already past.
  expect(html).toContain('handoffs 4 / 3');
  // Every ceiling, not only the ones that broke: the summary line is what makes
  // "what has this workspace used" answerable without hovering the chart. One
  // member against a ceiling of one is every beta workspace's real position —
  // an invite away from breaking — so it belongs on the page in words.
  // Non-breaking inside a pair, so a narrow column wraps between ceilings and
  // never inside one — `C 0 / 20,000` split across two lines reads as two
  // numbers, which is how a summary line stops being read at all.
  expect(html).toContain('H 4 / 3');
  expect(html).toContain('M 1 / 1');
  // Devices are enforced now, so they are a ceiling a workspace can be past.
  expect(html).toContain('devices 3 / 2');
  expect(html).toContain('D 3 / 2');
  expect(html).toContain('devices per member, last 30 days');
  expect(html).toContain('data-card="beta-distance"');
  expect(html).toContain('data-table="beta-workspaces"');
  expect(html).toContain('data-metric="beta-over"');
  // Retention is deliberately not in the table, and the page says why rather
  // than leaving an operator to notice the gap on the flip day.
  // Retention is absent from the ledger because the beta does not lift it, and
  // since operator grants it follows the plan in force: free's 90 days, or the gift's.
  expect(html).toContain('the sweep already keeps each workspace');
  expect(html).not.toContain('nothing in the server enforces it');
  // The code itself never reaches an operator page either.
  expect(html).not.toContain(CODE);
  expect(html).not.toContain(UNLABELLED);
});

it('keeps the beta ledger undisclosed to everybody but an operator', async () => {
  // bo@example.dev is a real beta account and not on the admin list: a plain
  // 404, never a 403, so the area's existence is not disclosed.
  const { header } = await signIn('bo@example.dev');
  expect((await fetch(`${beta.url}/admin/beta`, { headers: header() })).status).toBe(404);
  expect((await fetch(`${beta.url}/admin/beta`)).status).toBe(404);
});

it('does not sell anything while the beta runs', async () => {
  const pricing = await fetch(`${beta.url}/pricing`);
  // The hosted build composes billing; the beta build must not offer it. A core
  // server has no such route at all, which is the other acceptable answer.
  if (pricing.status !== 404) {
    expect(await pricing.text()).toContain('Nothing to pay yet');
  }
});

it('leaves an unconfigured instance exactly as it was', async () => {
  // Started here and closed immediately rather than held open for the file: a
  // self-hosted instance is one assertion, not a fixture worth the memory.
  const dir = mkdtempSync(path.join(tmpdir(), 'stma-plain-'));
  const plain = await startServer(loadEnv({ ...BASE, pgliteDir: dir, hosted: false }));
  try {
    const page = await (await fetch(`${plain.url}/signup`)).text();
    expect(page).not.toContain('Access code');
    const created = await form(`${plain.url}/auth/local/signup`, {
      email: 'homelab@example.dev',
      password: 'correct horse battery',
    });
    expect(created.status).toBe(302);
    expect(created.headers.get('location')).not.toContain('error');
    // Null, not the empty marker: nobody was asked for a code here. An instance
    // somebody runs themselves is not in anybody's cohort, and the operator
    // page has to be able to tell that from a code with no name on it.
    const row = (
      await plain.db
        .select({ cohort: users.signupCohort })
        .from(users)
        .where(eq(users.email, 'homelab@example.dev'))
        .limit(1)
    )[0];
    expect(row?.cohort).toBeNull();
    // And /admin does not exist at all without an operator list.
    expect((await fetch(`${plain.url}/admin/beta`)).status).toBe(404);
  } finally {
    await plain.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------- the support door

it('puts a support address on the hosted landing page, and none on a self-hosted one', async () => {
  const landing = await (await fetch(beta.url)).text();
  expect(landing).toContain('mailto:support@matteai.com');
  expect(landing).toContain('>Support<');

  // The troubleshooting page has one job the footer link does not: it must not
  // be a dead end. Everything it can answer without a person comes first, and
  // the address is where the page ends — with the data-protection address beside
  // it, because "delete my data" is not a support ticket.
  const help = await (await fetch(`${beta.url}/help`)).text();
  expect(help).toContain('mailto:support@matteai.com');
  expect(help).not.toContain('publishes no support address');
  expect(help).toContain('mailto:gdpr@matteai.com');

  // And the signup page — the first wall a cohort code meets, and until now the
  // one page with nothing to link to when it refused.
  const signup = await (await fetch(`${beta.url}/signup`)).text();
  expect(signup).toContain('Access code refused');
  expect(signup).toContain('/help#signin');
  expect(signup).toContain('mailto:support@matteai.com');

  // Same rule the access-code call to action follows: a page must not offer a
  // door that is not there. A self-hosted instance telling its users to write to
  // our address would send us mail we cannot act on, and its operator none.
  const own = loadEnv({ ...BASE, pgliteDir: betaDir, hosted: false });
  expect(own.supportEmail).toBe('');
  expect(own.privacyEmail).toBe('');
  const ours = loadEnv({ ...BASE, pgliteDir: betaDir, hosted: true });
  expect(ours.supportEmail).toBe('support@matteai.com');
  expect(ours.privacyEmail).toBe('gdpr@matteai.com');
});

/**
 * The door opened on 2026-09-23, and the page has to say which beta it is.
 *
 * Three states, one derivation (`siteInfo` in `ui/Site.tsx`): the pre-launch
 * face is private whatever else is set, a hosted instance that is not charging
 * is a beta and its door decides which, and once the ceilings are back it is
 * not a beta at all. Asserted here rather than in a unit test because the thing
 * that matters is what a stranger reads, in the footer and in the hero.
 */
it('says public beta once the door takes no code, and stops saying beta when the ceilings return', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'stma-public-'));
  const open = await startServer(
    loadEnv({ ...BASE, pgliteDir: dir, hosted: true, betaUnmetered: true, publicMode: 'full' }),
  );
  const metered = mkdtempSync(path.join(tmpdir(), 'stma-metered-'));
  const selling = await startServer(
    loadEnv({ ...BASE, pgliteDir: metered, hosted: true, betaUnmetered: false, publicMode: 'full' }),
  );
  try {
    const landing = await (await fetch(`${open.url}/`)).text();
    expect(landing).toContain('<b>Public beta</b>');
    expect(landing).toContain('in public beta');
    expect(landing).toContain('Public beta · v');
    // No code is asked for, so the door says so and the signup page agrees.
    expect(landing).not.toContain('I have an access code');
    expect(landing).toContain('Get started free');
    const signup = await (await fetch(`${open.url}/signup`)).text();
    expect(signup).not.toContain('Access code');
    expect(signup).toContain('STMA is in public beta');

    // The teaser instance is a private beta even though its door is shut.
    const teaser = await (await fetch(`${beta.url}/`)).text();
    expect(teaser).toContain('<b>Private beta</b>');

    // Ceilings back: nobody is on the house, so the word goes away entirely.
    const sold = await (await fetch(`${selling.url}/`)).text();
    expect(sold).not.toContain('Public beta');
    expect(sold).not.toContain('Private beta');
    expect(sold).toContain('AgentOps for coding agents');
  } finally {
    await open.close();
    await selling.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(metered, { recursive: true, force: true });
  }
});

/**
 * With no access code there is no volumetric brake on account creation that a
 * second replica does not weaken, so signup counts against a shared counter.
 * Ten per address per hour; the eleventh is refused without saying anything
 * about the address, because the count is spent before the email is read.
 */
it('holds account creation to a ceiling every replica agrees on', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'stma-signup-rate-'));
  const open = await startServer(
    loadEnv({ ...BASE, pgliteDir: dir, hosted: true, betaUnmetered: true, publicMode: 'full' }),
  );
  try {
    const ip = { 'x-forwarded-for': '203.0.113.77' };
    const made: number[] = [];
    for (let n = 0; n < 11; n += 1) {
      const res = await form(
        `${open.url}/auth/local/signup`,
        { email: `crowd-${n}@example.dev`, password: 'correct horse battery' },
        ip,
      );
      made.push(res.status);
      if (n === 10) {
        expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain(
          'Too many accounts have been created from this network',
        );
      }
    }
    expect(made.filter((s) => s === 302)).toHaveLength(11);
    // The eleventh created nothing: it was refused before the address was read.
    const eleventh = await fetch(`${open.url}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'crowd-10@example.dev', password: 'correct horse battery' }),
      redirect: 'manual',
    });
    expect(decodeURIComponent(eleventh.headers.get('location') ?? '')).not.toContain('/app');

    // Another address is not held by somebody else's burst.
    const elsewhere = await form(
      `${open.url}/auth/local/signup`,
      { email: 'quiet@example.dev', password: 'correct horse battery' },
      { 'x-forwarded-for': '198.51.100.9' },
    );
    expect(decodeURIComponent(elsewhere.headers.get('location') ?? '')).not.toContain(
      'Too many accounts',
    );
  } finally {
    await open.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * /help describes the walls this instance actually has.
 *
 * The page is where a locked-out stranger is sent from sign-in and from all
 * four password screens, so on the day the door opened (2026-09-23) two of its
 * entries became worse than useless: one explained a refused access code and
 * one told the reader registration was closed and they needed an invitation.
 * Both are still right for an instance that works that way, which is what the
 * two servers here are for.
 */
it('shows the access-code wall only where there is one, and the closed-door wall only where signup is shut', async () => {
  const codeHelp = await (await fetch(`${beta.url}/help`)).text();
  expect(codeHelp, 'an instance that asks for a code explains a refused one').toContain(
    'That access code is not valid',
  );

  const dir = mkdtempSync(path.join(tmpdir(), 'stma-openhelp-'));
  const open = await startServer(
    loadEnv({ ...BASE, pgliteDir: dir, hosted: true, betaUnmetered: true, publicMode: 'full' }),
  );
  const shutDir = mkdtempSync(path.join(tmpdir(), 'stma-shuthelp-'));
  const shut = await startServer(
    loadEnv({ ...BASE, pgliteDir: shutDir, hosted: true, signupsOpen: false, publicMode: 'full' }),
  );
  try {
    const openHelp = await (await fetch(`${open.url}/help`)).text();
    expect(openHelp, 'no code is asked for, so no entry about a refused one').not.toContain(
      'That access code is not valid',
    );
    expect(openHelp, 'anybody can sign up, so registration is not closed').not.toContain(
      'Registration is closed on this instance',
    );
    // And the page does not contradict the footer it carries.
    expect(openHelp).not.toContain('private beta');

    const shutHelp = await (await fetch(`${shut.url}/help`)).text();
    expect(shutHelp, 'signup is shut, so the entry that says so belongs here').toContain(
      'Registration is closed on this instance',
    );
  } finally {
    await open.close();
    await shut.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(shutDir, { recursive: true, force: true });
  }
});
