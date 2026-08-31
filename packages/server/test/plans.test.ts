import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { teams } from '../src/db/schema';
import { loadEnv } from '../src/env';
import { PLANS, planLimits } from '../src/lib/entitlements';
import { startServer, type StartedServer } from '../src/server';

/**
 * What each plan actually buys.
 *
 * Before this the plan moved three numbers and nothing else: every team, paid or
 * not, got the fleet, the governance screen and evidence. The internal pricing
 * matrix is the thing being enforced here, and
 * its first column — "self-host, full-featured" — is the one most easily broken
 * by accident, so it gets a server of its own.
 */

let hostedSrv: StartedServer;
let ownSrv: StartedServer;
let hostedDir: string;
let ownDir: string;

function jar() {
  const cookies = new Map<string, string>();
  return {
    header: (): Record<string, string> =>
      cookies.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {},
    store(res: Response) {
      for (const line of res.headers.getSetCookie()) {
        const [kv] = line.split(';');
        const i = kv!.indexOf('=');
        cookies.set(kv!.slice(0, i), kv!.slice(i + 1));
      }
    },
  };
}

const form = (url: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });

let rpcId = 1;
async function call(srv: StartedServer, tool: string, args: Record<string, unknown>, tok: string) {
  const res = await fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${tok}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId++,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  });
  const json = (await res.json()) as {
    result?: { content?: { text: string }[]; isError?: boolean };
    error?: { message?: string };
  };
  const text = json.result?.content?.[0]?.text ?? json.error?.message ?? '';
  return { text, isError: json.result?.isError === true || json.error !== undefined };
}

async function tenant(srv: StartedServer, who: string, teamName: string) {
  const j = jar();
  j.store(await form(`${srv.url}/auth/dev`, { username: who }));
  await form(`${srv.url}/app/teams`, { name: teamName }, j.header());
  const res = await fetch(`${srv.url}/app/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...j.header() },
    body: new URLSearchParams({ name: `${who}-machine` }),
  });
  const tok = /stma_[0-9a-f]{40}/.exec(await res.text())?.[0] ?? '';
  expect(tok, `token for ${who}`).toBeTruthy();
  return tok;
}

let freeToken = '';
let paidToken = '';
let ownToken = '';

beforeAll(async () => {
  hostedDir = mkdtempSync(path.join(tmpdir(), 'stma-plans-hosted-'));
  ownDir = mkdtempSync(path.join(tmpdir(), 'stma-plans-own-'));
  const base = {
    port: 0,
    host: 'localhost',
    nodeEnv: 'test' as const,
    devMode: true,
    databaseUrl: undefined,
  };
  hostedSrv = await startServer(loadEnv({ ...base, pgliteDir: hostedDir, hosted: true }));
  ownSrv = await startServer(loadEnv({ ...base, pgliteDir: ownDir, hosted: false }));

  freeToken = await tenant(hostedSrv, 'thrifty', 'Thrifty');
  paidToken = await tenant(hostedSrv, 'flush', 'Flush');
  await hostedSrv.db.update(teams).set({ plan: 'team' }).where(eq(teams.slug, 'flush'));

  ownToken = await tenant(ownSrv, 'homelab', 'Homelab');
});

afterAll(async () => {
  await hostedSrv?.close();
  await ownSrv?.close();
  rmSync(hostedDir, { recursive: true, force: true });
  rmSync(ownDir, { recursive: true, force: true });
});

it('shows a free team the fleet without letting it claim ground', async () => {
  const started = await call(hostedSrv, 'start_run', { team: 'thrifty', task: 'PAY-1' }, freeToken);
  expect(started.isError).toBe(true);
  expect(started.text).toContain('not part of the free plan');
  // The refusal has to name a way forward and a person. An agent that reads
  // "no" with no next step either stops or invents one.
  expect(started.text).toContain('solo');
  expect(started.text).toContain('your human');

  // The teaser: the map still answers, which is where the reason to upgrade is
  // visible. Closing it entirely would hide the product being sold.
  const map = await call(hostedSrv, 'list_active_agents', { team: 'thrifty' }, freeToken);
  expect(map.isError, map.text).toBe(false);
});

it('keeps policy and preflight behind the same line', async () => {
  const policy = await call(hostedSrv, 'get_policy', { team: 'thrifty' }, freeToken);
  expect(policy.isError).toBe(true);
  expect(policy.text).toContain('Policy is not part of the free plan');
});

it('gives the free plan three handoffs and then says the work is not lost', async () => {
  for (let i = 1; i <= 3; i++) {
    const ok = await call(
      hostedSrv,
      'handoff_work',
      { team: 'thrifty', summary: `Taster handoff number ${i}, with enough words in it.` },
      freeToken,
    );
    expect(ok.isError, `handoff ${i} of 3: ${ok.text}`).toBe(false);
  }
  const fourth = await call(
    hostedSrv,
    'handoff_work',
    { team: 'thrifty', summary: 'The fourth one, which should be refused politely.' },
    freeToken,
  );
  expect(fourth.isError).toBe(true);
  expect(fourth.text).toContain('3 handoffs');
  // The point of the taster is the moment the work survives a limit. A refusal
  // that reads like the work was dropped teaches the opposite lesson.
  expect(fourth.text).toContain('the work is not lost');
});

it('lets a paid team do all of it', async () => {
  const started = await call(hostedSrv, 'start_run', { team: 'flush', task: 'PAY-9' }, paidToken);
  expect(started.isError, started.text).toBe(false);
  const policy = await call(hostedSrv, 'get_policy', { team: 'flush' }, paidToken);
  expect(policy.isError, policy.text).toBe(false);
  for (let i = 0; i < 4; i++) {
    const ok = await call(
      hostedSrv,
      'handoff_work',
      { team: 'flush', summary: `Unlimited handoff number ${i}, long enough to pass.` },
      paidToken,
    );
    expect(ok.isError, `paid handoff ${i}: ${ok.text}`).toBe(false);
  }
});

it('never meters an instance somebody runs themselves', async () => {
  // The matrix's first column, and the one an accident breaks silently: a
  // self-hosted instance has no plan to be on, so its team sits on `free`
  // defaults and would inherit every limit meant for the hosted free tier.
  const started = await call(ownSrv, 'start_run', { team: 'homelab', task: 'HOME-1' }, ownToken);
  expect(started.isError, started.text).toBe(false);
  const policy = await call(ownSrv, 'get_policy', { team: 'homelab' }, ownToken);
  expect(policy.isError, policy.text).toBe(false);
  for (let i = 0; i < 5; i++) {
    const ok = await call(
      ownSrv,
      'handoff_work',
      { team: 'homelab', summary: `Self-hosted handoff ${i}, past the hosted free cap.` },
      ownToken,
    );
    expect(ok.isError, `self-host handoff ${i}: ${ok.text}`).toBe(false);
  }
  expect(planLimits('free', false).fleet).toBe('full');
  expect(planLimits('free', false).retentionDays).toBeNull();
});

it('reads an id it does not know as the cheapest plan, which is why 0016 exists', () => {
  // `pro` was renamed to `team`. An unknown id resolves to free, so a team left
  // on the old string would silently lose everything it paid for — the migration
  // is what stops that, and this is the behaviour it protects against.
  expect('pro' in PLANS).toBe(false);
  expect(planLimits('pro', true)).toEqual(PLANS.free);
  expect(planLimits('team', true).fleet).toBe('full');
});

it('prints demo logins only from configuration, and only when configured', async () => {
  // The default: nothing. A sign-in page that lists accounts is a decision
  // somebody has to make on purpose, per environment.
  const plain = await (await fetch(`${hostedSrv.url}/login`)).text();
  expect(plain).not.toContain('Demo accounts');

  const demoDir = mkdtempSync(path.join(tmpdir(), 'stma-demo-'));
  const demoSrv = await startServer(
    loadEnv({
      port: 0,
      host: 'localhost',
      nodeEnv: 'test',
      devMode: false,
      databaseUrl: undefined,
      pgliteDir: demoDir,
      demoLogins: [
        { email: 'ada@example.dev', password: 'throwaway-1', note: 'owner' },
        { email: 'bo@example.dev', password: 'throwaway-2' },
      ],
    }),
  );
  try {
    const html = await (await fetch(`${demoSrv.url}/login`)).text();
    expect(html).toContain('Demo accounts');
    expect(html).toContain('ada@example.dev');
    expect(html).toContain('throwaway-1');
    expect(html).toContain('owner');
    // The page renders the literal it was handed and never queries users, so a
    // real account cannot appear here even if this ends up on the wrong app.
    expect(html).not.toContain('thrifty');
    expect(html).toContain('never reuse a password');
  } finally {
    await demoSrv.close();
    rmSync(demoDir, { recursive: true, force: true });
  }
});

it('does not send a free team at a tool that will refuse it', async () => {
  // The map is deliberately not gated — a read-only view is the reason to
  // upgrade, and hiding it hides that. But its empty state told everyone to
  // "ask an agent to call start_run", which on this plan is a refusal.
  const j = jar();
  j.store(await form(`${hostedSrv.url}/auth/dev`, { username: 'thrifty' }));
  const free = await (await fetch(`${hostedSrv.url}/app/agents`, { headers: j.header() })).text();
  expect(free).toContain('read-only on your plan');
  expect(free).toContain('solo');
  expect(free).not.toContain('Ask an agent to call');
  // And it says why an empty map is not the same as a broken one.
  expect(free).toContain('presence, not history');

  const k = jar();
  k.store(await form(`${hostedSrv.url}/auth/dev`, { username: 'flush' }));
  const paid = await (await fetch(`${hostedSrv.url}/app/agents`, { headers: k.header() })).text();
  expect(paid).not.toContain('read-only on your plan');
});

it('gates governance at the same line for a person as for an agent', async () => {
  // get_policy and check_environment were gated when the plan reached the
  // product; the page was not. An agent refused the rulebook while its human
  // read the whole governance screen next to it is one matrix line meaning two
  // things depending on which door you came through.
  const j = jar();
  j.store(await form(`${hostedSrv.url}/auth/dev`, { username: 'thrifty' }));
  const res = await fetch(`${hostedSrv.url}/app/teams/thrifty/governance`, { headers: j.header() });
  expect(res.status).toBe(402);
  const html = await res.text();
  expect(html).toContain('class="rail"');
  expect(html).toContain('plan up');
  // Nothing has happened in this team — every fleet call was refused — so the
  // page says that rather than advertising a zero.
  expect(html).toContain('Nothing recorded yet');

  // Publishing is the same door. A gate on the read and not the write is not a gate.
  const published = await form(
    `${hostedSrv.url}/app/teams/thrifty/policy`,
    { scope: 'team', guidance: 'read the migration first' },
    j.header(),
  );
  expect(published.status).toBe(404);

  // A paid team sees the real screen.
  const k = jar();
  k.store(await form(`${hostedSrv.url}/auth/dev`, { username: 'flush' }));
  const paid = await fetch(`${hostedSrv.url}/app/teams/flush/governance`, { headers: k.header() });
  expect(paid.status).toBe(200);
});

