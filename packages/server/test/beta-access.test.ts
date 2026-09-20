import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
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
      signupAccessCodes: [{ code: CODE, label: 'cohort-one' }],
      demoLogins: [{ email: 'shown@example.dev', password: 'hunter2' }],
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
    email: 'ada@example.dev',
    password: 'correct horse battery',
  });
  expect(right.status).toBe(302);
  expect(right.headers.get('location')).not.toContain('error');
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

it('gives a beta workspace every feature and no ceiling', async () => {
  const jar = new Map<string, string>();
  const store = (res: Response) => {
    for (const line of res.headers.getSetCookie()) {
      const [kv] = line.split(';');
      const i = kv!.indexOf('=');
      jar.set(kv!.slice(0, i), kv!.slice(i + 1));
    }
  };
  const header = () => ({ cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') });
  store(
    await form(`${beta.url}/auth/local/login`, {
      email: 'ada@example.dev',
      password: 'correct horse battery',
    }),
  );
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
  expect(label).toContain('plan Private beta');
  expect(label).not.toContain('plan free');
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
  } finally {
    await plain.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------- the support door

it('puts a support address on the hosted landing page, and none on a self-hosted one', async () => {
  const landing = await (await fetch(beta.url)).text();
  expect(landing).toContain('mailto:support@stma.ai');
  expect(landing).toContain('>Support<');

  // The troubleshooting page has one job the footer link does not: it must not
  // be a dead end. Everything it can answer without a person comes first, and
  // the address is where the page ends.
  const help = await (await fetch(`${beta.url}/help`)).text();
  expect(help).toContain('mailto:support@stma.ai');
  expect(help).not.toContain('publishes no support address');

  // And the signup page — the first wall a cohort code meets, and until now the
  // one page with nothing to link to when it refused.
  const signup = await (await fetch(`${beta.url}/signup`)).text();
  expect(signup).toContain('Access code refused');
  expect(signup).toContain('/help#signin');
  expect(signup).toContain('mailto:support@stma.ai');

  // Same rule the access-code call to action follows: a page must not offer a
  // door that is not there. A self-hosted instance telling its users to write to
  // our address would send us mail we cannot act on, and its operator none.
  const own = loadEnv({ ...BASE, pgliteDir: betaDir, hosted: false });
  expect(own.supportEmail).toBe('');
  expect(loadEnv({ ...BASE, pgliteDir: betaDir, hosted: true }).supportEmail).toBe(
    'support@stma.ai',
  );
});
