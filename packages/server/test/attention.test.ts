import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  agentEvents,
  agentInstallations,
  agentRuns,
  debugSessions,
  handoffs,
  memberships,
  messages,
  policyReceipts,
  projects,
  teams,
  users,
  workClaims,
} from '../src/db/schema';
import {
  ATTENTION_HANDOFF_LIMIT,
  ATTENTION_RUN_SCAN,
  UNCONFIRMED_GRACE_MINUTES,
  readAttention,
} from '../src/domain/attention';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

/**
 * Needs attention is an inbox of things a person can act on, so the ways it can
 * mislead are the ways it is tested: an item that outlives its cause, a live
 * item that falls out of a window, a count that reads as a total, a person
 * named who was never responsible, and a read-only page that offers an action.
 *
 * Runs are started through the tools (the way agents make them); handoffs,
 * leases and receipts that the product only writes in passing are written
 * through srv.db.
 */

let srv: StartedServer;
let dataDir: string;
let team: { id: string; slug: string };
let otherTeam: { id: string; slug: string };
const tokens: Record<string, string> = {};
const cookies: Record<string, Record<string, string>> = {};

function jar() {
  const store = new Map<string, string>();
  return {
    header: (): Record<string, string> =>
      store.size ? { cookie: [...store].map(([k, v]) => `${k}=${v}`).join('; ') } : {},
    store(res: Response) {
      for (const line of res.headers.getSetCookie()) {
        const [kv] = line.split(';');
        const i = kv!.indexOf('=');
        store.set(kv!.slice(0, i), kv!.slice(i + 1));
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
async function call(tool: string, args: Record<string, unknown>, who: string) {
  const res = await fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${tokens[who]}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId++,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  });
  const json = (await res.json()) as { result?: { content?: { text: string }[] }; error?: { message?: string } };
  const text = json.result?.content?.[0]?.text ?? json.error?.message ?? '';
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* prose */
  }
  return { text, data };
}

async function login(username: string) {
  const j = jar();
  j.store(await form(`${srv.url}/auth/dev`, { username }));
  cookies[username] = j.header();
  return j;
}

async function tokenFor(username: string, name: string) {
  const res = await fetch(`${srv.url}/app/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...cookies[username] },
    body: new URLSearchParams({ name }),
  });
  const tok = /stma_[0-9a-f]{40}/.exec(await res.text())?.[0] ?? '';
  expect(tok, `token for ${name}`).toBeTruthy();
  tokens[username] = tok;
}

async function joinAs(username: string, owner: string, slug: string) {
  await form(`${srv.url}/app/teams/${slug}/invites`, {}, cookies[owner]);
  const page = await (await fetch(`${srv.url}/app/teams/${slug}?tab=people`, { headers: cookies[owner] })).text();
  const code = /\/join\/([A-Za-z0-9_-]+)/.exec(page)?.[1] ?? '';
  const j = await login(username);
  await form(`${srv.url}/join/${code}`, {}, j.header());
  await tokenFor(username, `${username}-machine`);
}

const pageOf = async (who: string, slug = 'att') =>
  fetch(`${srv.url}/app/teams/${slug}/attention`, { headers: cookies[who] });
const textOf = async (who: string, slug = 'att') => (await pageOf(who, slug)).text();
/** The part of the page this feature draws; the rail and the logout form are the shell's. */
const stack = (html: string) => /<section class="readiness-stack">[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
const rowCount = (html: string) => (html.match(/Live scope overlap \(/g) ?? []).length;

const shared = [
  { type: 'path', key: 'src/cart/checkout.ts' },
  { type: 'path', key: 'src/cart/totals.ts' },
  { type: 'path', key: 'src/cart/tax.ts' },
];

async function start(who: string, project: string, task: string, scope: unknown[] = shared, extra: Record<string, unknown> = {}) {
  const res = await call('start_run', { team: 'att', project, task, agent: `${who}-agent`, scope, ...extra }, who);
  expect(res.data?.runId, `${who} start_run: ${res.text}`).toBeTruthy();
  return res.data.runId as string;
}

async function userId(username: string) {
  const [row] = await srv.db.select({ id: users.id }).from(users).where(eq(users.username, username));
  return row!.id;
}


/** The installation a person's token created, made by a throwaway run when none exists yet. */
async function installationFor(who: string) {
  const ownerId = await userId(who);
  const find = () => srv.db.select().from(agentInstallations).where(eq(agentInstallations.userId, ownerId)).limit(1);
  let [row] = await find();
  if (!row) {
    const id = await start(who, 'warmup', `warm-${who}`, []);
    await call('finish_run', { run_id: id }, who);
    [row] = await find();
  }
  return row!;
}

async function insertHandoff(o: {
  title: string;
  by: string;
  teamId?: string;
  projectId?: string | null;
  createdAt?: Date;
  state?: string;
  kind?: 'handoff' | 'assignment';
  acceptedBy?: string;
  acceptedAt?: Date;
  targetUser?: string;
  targetInstallationId?: string;
  installationId?: string;
  extraBriefs?: number;
  legacy?: boolean;
}) {
  const offeredBy = await userId(o.by);
  const at = o.createdAt ?? new Date();
  const [session] = await srv.db
    .insert(debugSessions)
    .values({ teamId: o.teamId ?? team.id, projectId: o.projectId ?? null, title: o.title, openedBy: offeredBy, createdAt: at })
    .returning();
  if (!o.legacy) {
    await srv.db.insert(handoffs).values({
      sessionId: session!.id,
      offeredBy,
      state: o.state ?? 'offered',
      kind: o.kind ?? 'handoff',
      acceptedBy: o.acceptedBy ? await userId(o.acceptedBy) : null,
      acceptedAt: o.acceptedAt ?? null,
      targetUserId: o.targetUser ? await userId(o.targetUser) : null,
      targetInstallationId: o.targetInstallationId ?? null,
      installationId: o.installationId ?? null,
      createdAt: at,
      updatedAt: at,
    });
  }
  for (let i = 0; i <= (o.extraBriefs ?? 0); i += 1) {
    await srv.db.insert(messages).values({ sessionId: session!.id, authorId: offeredBy, kind: 'handoff', body: 'brief', createdAt: new Date(at.getTime() + i) });
  }
  return session!.id;
}

const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-attention-'));
  srv = await startServer(
    loadEnv({ port: 0, host: '127.0.0.1', nodeEnv: 'test', devMode: true, databaseUrl: undefined, pgliteDir: dataDir }),
  );
  await login('alice');
  await form(`${srv.url}/app/teams`, { name: 'Att' }, cookies.alice);
  await tokenFor('alice', 'alice-macbook');
  await joinAs('bob', 'alice', 'att');
  await joinAs('carol', 'alice', 'att');
  await login('dave');
  await form(`${srv.url}/app/teams`, { name: 'Other' }, cookies.dave);
  await tokenFor('dave', 'dave-machine');
  await login('eve');
  const rows = await srv.db.select().from(teams).where(inArray(teams.slug, ['att', 'other']));
  team = rows.find((r) => r.slug === 'att')!;
  otherTeam = rows.find((r) => r.slug === 'other')!;
}, 120_000);

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Every case starts from a workspace with nothing live in it.
  for (const t of [team, otherTeam]) {
    await srv.db.delete(agentRuns).where(eq(agentRuns.teamId, t.id));
    await srv.db.delete(debugSessions).where(and(eq(debugSessions.teamId, t.id), eq(debugSessions.kind, 'debug')));
  }
});

// ---------------------------------------------------------------- overlaps

describe('a live overlap', () => {
  it('is one row with project, both runs, both people and one next step, and is gone when a run ends', async () => {
    const a = await start('alice', 'storefront', 'ST-1');
    const b = await start('bob', 'storefront', 'ST-2');
    const html = await textOf('alice');
    const section = stack(html);
    expect(rowCount(section)).toBe(1);
    expect(section).toContain('Needs action now');
    expect(section).toContain('storefront');
    expect(section).toContain(`/app/agents?run=${a}`);
    expect(section).toContain(`/app/agents?run=${b}`);
    expect(section).toContain('alice (run owner)');
    expect(section).toContain('bob (run owner)');
    expect(section).toContain('Next step');
    expect(section).toContain('declared the ground first');
    expect(section).toContain('src/cart/checkout.ts');

    await call('finish_run', { run_id: b }, 'bob');
    const after = stack(await textOf('alice'));
    expect(rowCount(after)).toBe(0);
    expect(after).not.toContain(`/app/agents?run=${b}`);
    // The overlap is not forgotten, only moved out of the live list: a count.
    expect(after).toContain('1 run that reported an overlap in the last 7 days has since ended. No action.');
    // The assignment ledger by its name: the rail's Work is the work items now.
    expect(after).toContain('>Open Dispatched (read only)</a>');
    expect(after).not.toContain('>Open Work (read only)</a>');
    await call('finish_run', { run_id: a }, 'alice');
  });

  it('stays listed after sixty newer events of other kinds (the newest-50 window is gone)', async () => {
    const a = await start('alice', 'storefront', 'ST-1');
    const b = await start('bob', 'storefront', 'ST-2');
    const noise = Array.from({ length: 60 }, (_, i) => ({
      runId: a,
      type: 'heartbeat',
      detail: { n: i },
      createdAt: new Date(Date.now() + 1000 + i),
    }));
    await srv.db.insert(agentEvents).values(noise);
    const section = stack(await textOf('alice'));
    expect(rowCount(section)).toBe(1);
    expect(section).not.toContain('Nothing needs action');
    await call('finish_run', { run_id: a }, 'alice');
    await call('finish_run', { run_id: b }, 'bob');
  });

  it('is not invented by a retained event: a stale conflicts_detected row alone lists nothing and does not read as a problem', async () => {
    const a = await start('alice', 'storefront', 'ST-1', [{ type: 'path', key: 'docs/readme.md' }]);
    await srv.db.insert(agentEvents).values({
      runId: a,
      type: 'conflicts_detected',
      detail: { count: 1, highestSeverity: 'high', otherRunIds: [randomUUID()] },
    });
    const section = stack(await textOf('alice'));
    expect(rowCount(section)).toBe(0);
    expect(section).toContain('Nothing needs action');
    expect(section).toContain('1 live run read');
    // A run that is live is not counted as ended.
    expect(section).toContain('No overlap reported in the last 7 days involves a run that has since ended.');
    await call('finish_run', { run_id: a }, 'alice');
  });

  it('disappears when the counterpart lease lapses, without any run ending', async () => {
    const a = await start('alice', 'storefront', 'ST-1');
    const b = await start('bob', 'storefront', 'ST-2');
    expect(rowCount(stack(await textOf('alice')))).toBe(1);
    await srv.db.update(workClaims).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(workClaims.runId, b));
    const section = stack(await textOf('alice'));
    expect(rowCount(section)).toBe(0);
    expect(section).toContain('Nothing needs action');
    await call('finish_run', { run_id: a }, 'alice');
    await call('finish_run', { run_id: b }, 'bob');
  });

  it('is one row however often it was reported, and three shared files are one problem not three', async () => {
    const a = await start('alice', 'storefront', 'ST-1');
    const b = await start('bob', 'storefront', 'ST-2');
    // Restating scope twice more, and two retained events saying the same thing.
    await call('update_run', { run_id: b, scope: shared }, 'bob');
    await call('update_run', { run_id: a, scope: shared }, 'alice');
    await srv.db.insert(agentEvents).values([
      { runId: b, type: 'conflicts_detected', detail: { count: 3, highestSeverity: 'high', otherRunIds: [a] } },
      { runId: b, type: 'conflicts_detected', detail: { count: 3, highestSeverity: 'high', otherRunIds: [a] } },
    ]);
    const section = stack(await textOf('alice'));
    expect(rowCount(section)).toBe(1);
    expect(section).toContain('src/cart/checkout.ts, src/cart/tax.ts and src/cart/totals.ts');
    await call('finish_run', { run_id: a }, 'alice');
    await call('finish_run', { run_id: b }, 'bob');
  });

  it('names at most three files and says how many more', async () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map((n) => ({ type: 'path', key: `src/lib/${n}.ts` }));
    const a = await start('alice', 'storefront', 'ST-1', five);
    const b = await start('bob', 'storefront', 'ST-2', five);
    const section = stack(await textOf('alice'));
    expect(rowCount(section)).toBe(1);
    expect(section).toMatch(/and 2 more/);
    await call('finish_run', { run_id: a }, 'alice');
    await call('finish_run', { run_id: b }, 'bob');
  });

  it('treats one person\'s parallel attempts as a fan-out, and a third party touching the file as a collision', async () => {
    const attempts: string[] = [];
    for (const n of [1, 2, 3]) {
      attempts.push(
        await start('alice', 'storefront', 'ST-9', shared, {
          branch: `try/${n}`,
          worktree: `/tmp/att-${n}`,
          attempt_group: 'ST-9-fanout',
        }),
      );
    }
    const fanOut = stack(await textOf('alice'));
    expect(rowCount(fanOut)).toBe(0);
    expect(fanOut).toContain('Nothing needs action');

    const c = await start('carol', 'storefront', 'ST-10');
    const section = stack(await textOf('alice'));
    expect(rowCount(section)).toBe(3);
    expect(section).toContain('carol (run owner)');
    for (const id of attempts) await call('finish_run', { run_id: id }, 'alice');
    await call('finish_run', { run_id: c }, 'carol');
  });

  it('counts a read against a write as one muted line and never as a row to act on', async () => {
    const a = await start('alice', 'storefront', 'ST-1');
    const reading = shared.map((s) => ({ ...s, access: 'read' }));
    const b = await start('bob', 'storefront', 'ST-2', reading);
    const section = stack(await textOf('alice'));
    expect(rowCount(section)).toBe(0);
    expect(section).not.toContain('Needs action now');
    expect(section).toContain('1 pair of live runs overlaps where one only reads the ground.');
    expect(section).toContain('A read holds nothing');
    await call('finish_run', { run_id: a }, 'alice');
    await call('finish_run', { run_id: b }, 'bob');
  });

  it('tells a person to ask the owner when the holder stopped to ask a person', async () => {
    const a = await start('alice', 'storefront', 'ST-1');
    const b = await start('bob', 'storefront', 'ST-2');
    await call('update_run', { run_id: a, status: 'waiting' }, 'alice');
    const section = stack(await textOf('carol'));
    expect(rowCount(section)).toBe(1);
    expect(section).toContain('stopped to ask a person and will not free this ground by itself');
    expect(section).toContain('Ask alice');
    await call('finish_run', { run_id: a }, 'alice');
    await call('finish_run', { run_id: b }, 'bob');
  });

  it('says neither run is provably first when the record does not say, and does not invent an order', async () => {
    const a = await start('alice', 'storefront', 'ST-1');
    const b = await start('bob', 'storefront', 'ST-2');
    await srv.db.update(workClaims).set({ firstDeclaredAt: null }).where(inArray(workClaims.runId, [a, b]));
    const section = stack(await textOf('alice'));
    expect(section).toContain('Neither run is provably first');
    await call('finish_run', { run_id: a }, 'alice');
    await call('finish_run', { run_id: b }, 'bob');
  });

  it('never lists a run that is not live when it is read, whatever its claims still say', async () => {
    const a = await start('alice', 'storefront', 'ST-1');
    const b = await start('bob', 'storefront', 'ST-2');
    const now = new Date();
    const before = await readAttention(srv.db, { userId: await userId('alice'), team, now });
    expect(before.groups.needs_action.filter((i) => i.kind === 'overlap')).toHaveLength(1);

    // The run ends between two readings while its claims are still unexpired.
    await srv.db.update(agentRuns).set({ status: 'completed', endedAt: new Date() }).where(eq(agentRuns.id, b));
    const after = await readAttention(srv.db, { userId: await userId('alice'), team, now });
    expect(after.groups.needs_action.filter((i) => i.kind === 'overlap')).toHaveLength(0);
    expect(after.ended).toBe(1); // bob's start reported the overlap and bob's run is no longer live
    // And the same instant read again says the same thing.
    const again = await readAttention(srv.db, { userId: await userId('alice'), team, now });
    expect(again.items).toEqual(after.items);
    await call('finish_run', { run_id: a }, 'alice');
  });

  it('uses the clock it was given: a lease that lapsed before `now` is lapsed, one that lapses after is live', async () => {
    const a = await start('alice', 'storefront', 'ST-1');
    const b = await start('bob', 'storefront', 'ST-2');
    const [claim] = await srv.db.select().from(workClaims).where(eq(workClaims.runId, b)).limit(1);
    const lapsesAt = claim!.leaseExpiresAt;
    const alice = await userId('alice');
    const early = await readAttention(srv.db, { userId: alice, team, now: new Date(lapsesAt.getTime() - 1000) });
    expect(early.items.filter((i) => i.kind === 'overlap')).toHaveLength(1);
    const late = await readAttention(srv.db, { userId: alice, team, now: new Date(lapsesAt.getTime() + 1000) });
    expect(late.items.filter((i) => i.kind === 'overlap')).toHaveLength(0);
    await call('finish_run', { run_id: a }, 'alice');
    await call('finish_run', { run_id: b }, 'bob');
  });

  it('agrees with the agent map about which runs are contested', async () => {
    const a = await start('alice', 'storefront', 'ST-1');
    const b = await start('bob', 'storefront', 'ST-2');
    const c = await start('carol', 'storefront', 'ST-3', [{ type: 'path', key: 'docs/unrelated.md' }]);
    const other = await start('carol', 'payments', 'PAY-1'); // same files, another project
    const map = await (await fetch(`${srv.url}/app/agents?team=att`, { headers: cookies.alice })).text();
    const contestedOnMap = new Set<string>();
    for (const chunk of map.split('class="lrow').slice(1)) {
      const id = /run=([0-9a-f-]{36})/.exec(chunk)?.[1];
      if (id && /<span class="pill pill-(?:danger|owner)">(?:critical|high|medium|low)<\/span>/.test(chunk)) {
        contestedOnMap.add(id);
      }
    }
    const section = stack(await textOf('alice'));
    const onAttention = new Set([...section.matchAll(/\/app\/agents\?run=([0-9a-f-]{36})/g)].map((m) => m[1]!));
    expect([...onAttention].sort()).toEqual([...contestedOnMap].sort());
    expect(onAttention).toEqual(new Set([a, b]));
    expect(onAttention.has(c)).toBe(false);
    expect(onAttention.has(other)).toBe(false);
    for (const [who, id] of [['alice', a], ['bob', b], ['carol', c], ['carol', other]] as const) {
      await call('finish_run', { run_id: id }, who);
    }
  });

  it('says it read only the newest live runs when there are more than it will read', async () => {
    const install = await installationFor('alice');
    await srv.db.insert(agentRuns).values(
      Array.from({ length: ATTENTION_RUN_SCAN + 1 }, (_, i) => ({
        installationId: install.id,
        teamId: team.id,
        status: 'active',
        taskKey: `bulk-${i}`,
      })),
    );
    const section = stack(await textOf('alice'));
    expect(section).toContain(`the ${ATTENTION_RUN_SCAN} most recently active live runs (there are more)`);
    expect(section).toContain(`Only the ${ATTENTION_RUN_SCAN} most recently active live runs were read`);
    expect(section).not.toContain('Nothing needs action in the part of the workspace this page reads (201 live runs read');
  });

  it('shows ten pairs at most, most severe first, and says how many there were', async () => {
    const owners = ['alice', 'bob', 'carol'] as const;
    const ids: Array<[string, string]> = [];
    // Six runs on one file: fifteen pairs, and a person's two runs are not siblings unless they say so.
    for (let i = 0; i < 6; i += 1) {
      const who = owners[i % 3]!;
      ids.push([who, await start(who, 'storefront', `ST-${i}`, [{ type: 'path', key: 'src/shared.ts' }])]);
    }
    const section = stack(await textOf('alice'));
    expect(rowCount(section)).toBe(10);
    expect(section).toMatch(/Showing 10 of 15 overlapping run pairs, most severe first\./);
    for (const [who, id] of ids) await call('finish_run', { run_id: id }, who);
  });
});

// ---------------------------------------------------------------- receipts

describe('policy reports', () => {
  const receipt = async (runId: string, o: { reported?: string | null; drift?: boolean; startedMinutesAgo?: number }) => {
    if (o.startedMinutesAgo !== undefined) {
      await srv.db.update(agentRuns).set({ startedAt: new Date(Date.now() - o.startedMinutesAgo * 60_000) }).where(eq(agentRuns.id, runId));
    }
    await srv.db
      .insert(policyReceipts)
      .values({ runId, expectedHash: 'a'.repeat(64), reportedHash: o.reported ?? null, drift: o.drift ?? false })
      .onConflictDoUpdate({
        target: policyReceipts.runId,
        set: { reportedHash: o.reported ?? null, drift: o.drift ?? false },
      });
  };

  it('does not list a run that has not answered yet, and lists one that has been silent past the grace as advisory only', async () => {
    const fresh = await start('alice', 'storefront', 'ST-1', [{ type: 'path', key: 'docs/a.md' }]);
    await receipt(fresh, { startedMinutesAgo: 1 });
    expect(stack(await textOf('alice'))).not.toContain('Policy hash not reported');

    await receipt(fresh, { startedMinutesAgo: UNCONFIRMED_GRACE_MINUTES + 5 });
    const section = stack(await textOf('alice'));
    expect(section).toContain('Policy hash not reported');
    expect(section).toContain('Worth a look');
    expect(section).not.toContain('Needs action now');
    expect(section).toContain('This is silence, not a deviation');
    await call('finish_run', { run_id: fresh }, 'alice');
  });

  it('lists a reported hash that differs as something to act on', async () => {
    const run = await start('bob', 'storefront', 'ST-1', [{ type: 'path', key: 'docs/b.md' }]);
    await receipt(run, { reported: 'b'.repeat(64), drift: true, startedMinutesAgo: 1 });
    const section = stack(await textOf('alice'));
    expect(section).toContain('Needs action now');
    expect(section).toContain('Reported policy hash differs');
    expect(section).toContain('bob (run owner)');
    expect(section).toContain('A matching hash would not prove compliance either.');
    await call('finish_run', { run_id: run }, 'bob');
  });

  it('is not hidden by newer receipts of finished runs, and a finished run\'s receipt is not listed', async () => {
    const live = await start('bob', 'storefront', 'ST-1', [{ type: 'path', key: 'docs/b.md' }]);
    await receipt(live, { reported: 'b'.repeat(64), drift: true });
    await srv.db.update(policyReceipts).set({ createdAt: new Date(Date.now() - 3 * DAY) }).where(eq(policyReceipts.runId, live));
    const install = await installationFor('carol');
    const done = await srv.db
      .insert(agentRuns)
      .values(
        Array.from({ length: 25 }, (_, i) => ({
          installationId: install.id,
          teamId: team.id,
          status: 'completed',
          taskKey: `done-${i}`,
          endedAt: new Date(),
        })),
      )
      .returning({ id: agentRuns.id });
    await srv.db.insert(policyReceipts).values(
      done.map((row) => ({ runId: row.id, expectedHash: 'a'.repeat(64), reportedHash: 'c'.repeat(64), drift: true })),
    );
    const section = stack(await textOf('alice'));
    expect((section.match(/Reported policy hash differs/g) ?? []).length).toBe(1);
    expect(section).toContain(`/app/agents?run=${live}`);
    await call('finish_run', { run_id: live }, 'bob');
  });
});

// ---------------------------------------------------------------- handoffs

describe('open handoffs', () => {
  it('shows an old offer as waiting with its age and never claims it expired', async () => {
    await insertHandoff({ title: 'Move the label printer', by: 'alice', createdAt: new Date(Date.now() - 10 * DAY) });
    const section = stack(await textOf('bob'));
    expect(section).toContain('Waiting on someone');
    expect(section).toContain('Move the label printer');
    expect(section).toContain('10 days ago');
    expect(section).toContain('nobody has accepted it');
    expect(section).not.toMatch(/expire/i);
    expect(section).not.toContain('Needs action now');
  });

  it('names no responsible person for an unassigned offer, and the sender only as the sender', async () => {
    await insertHandoff({ title: 'Unassigned brief', by: 'alice' });
    const section = stack(await textOf('bob'));
    expect(section).toContain('not assigned to a person');
    expect(section).toContain('sent by alice');
    expect(section).not.toContain('alice (receiver)');
    expect(section).not.toContain('alice (sender)');
  });

  it('names the person an assignment was given to, through the owner of the named agent', async () => {
    const install = await installationFor('carol');
    await insertHandoff({ title: 'Assigned to carol', by: 'alice', kind: 'assignment', targetInstallationId: install.id });
    const section = stack(await textOf('bob'));
    expect(section).toContain('carol (receiver)');
    expect(section).toContain(`assigned this assignment to ${install.name}`);
  });

  it('names the accepting member of accepted work and asks for a status, not an action', async () => {
    await insertHandoff({
      title: 'In flight',
      by: 'alice',
      state: 'accepted',
      acceptedBy: 'bob',
      acceptedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    const section = stack(await textOf('alice'));
    expect(section).toContain('bob (receiver)');
    expect(section).toContain('accepted this handoff 2 hours ago');
    expect(section).toContain('Waiting on someone');
  });

  it('needs action when the member who accepted it can no longer carry it, and says only the sender can cancel', async () => {
    await insertHandoff({ title: 'Orphaned', by: 'alice', state: 'accepted', acceptedBy: 'carol', acceptedAt: new Date(Date.now() - DAY) });
    await srv.db.delete(memberships).where(and(eq(memberships.teamId, team.id), eq(memberships.userId, await userId('carol'))));
    try {
      const forBob = stack(await textOf('bob'));
      expect(forBob).toContain('Needs action now');
      expect(forBob).toContain('has left the workspace or their agent connection was revoked');
      expect(forBob).toContain('Ask alice to cancel it or send it again; only the sender can cancel.');
      const forAlice = stack(await textOf('alice'));
      expect(forAlice).toContain('You sent it. Open the thread to cancel it');
    } finally {
      await srv.db.insert(memberships).values({ teamId: team.id, userId: await userId('carol'), role: 'member' });
    }
  });

  it('does not call a handoff orphaned when the receiving agent reported itself blocked', async () => {
    const install = await installationFor('carol');
    await insertHandoff({
      title: 'Blocked on a token',
      by: 'alice',
      state: 'needs_attention',
      acceptedBy: 'carol',
      acceptedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      installationId: install.id,
    });
    const section = stack(await textOf('bob'));
    expect(section).toContain('Needs action now');
    expect(section).toContain('then reported that it is blocked');
    expect(section).toContain('Ask carol what is blocking it');
    expect(section).not.toContain('has left the workspace');
    expect(section).not.toContain('only the sender can cancel');
  });

  it('calls it orphaned when the accepting connection was revoked, even though the member is still here', async () => {
    const install = await installationFor('carol');
    await insertHandoff({
      title: 'Revoked carrier',
      by: 'alice',
      state: 'accepted',
      acceptedBy: 'carol',
      acceptedAt: new Date(Date.now() - DAY),
      installationId: install.id,
    });
    await srv.db.update(agentInstallations).set({ revokedAt: new Date() }).where(eq(agentInstallations.id, install.id));
    try {
      const section = stack(await textOf('bob'));
      expect(section).toContain('their agent connection was revoked');
      expect(section).not.toContain('reported that it is blocked');
    } finally {
      await srv.db.update(agentInstallations).set({ revokedAt: null }).where(eq(agentInstallations.id, install.id));
    }
  });

  it('says more than ten match when one session carries two briefs and an eleventh session exists', async () => {
    for (let i = 0; i < 10; i += 1) {
      await insertHandoff({ title: `Dup ${i}`, by: 'alice', createdAt: new Date(Date.now() - i * 1000), extraBriefs: i === 0 ? 1 : 0 });
    }
    await insertHandoff({ title: 'Eleventh', by: 'alice', createdAt: new Date(Date.now() - 60_000) });
    const section = stack(await textOf('bob'));
    expect(section.match(/<b>(Dup \d+|Eleventh)<\/b>/g)).toHaveLength(ATTENTION_HANDOFF_LIMIT);
    expect(section).toContain(`more than ${ATTENTION_HANDOFF_LIMIT} match`);
  });

  it('flags a legacy brief and links the project it belongs to', async () => {
    const [project] = await srv.db.insert(projects).values({ teamId: team.id, name: 'Storefront', slug: 'storefront-x' }).returning();
    try {
      await insertHandoff({ title: 'Old brief', by: 'alice', legacy: true, projectId: project!.id });
      const section = stack(await textOf('bob'));
      expect(section).toContain('from before handoffs had a tracked state');
      expect(section).toContain('Storefront');
      expect(section).toContain(`/app/teams/att/projects/storefront-x`);
    } finally {
      await srv.db.delete(debugSessions).where(eq(debugSessions.projectId, project!.id));
      await srv.db.delete(projects).where(eq(projects.id, project!.id));
    }
  });

  it('lists ten at most and says that more than ten match, never "10 of 10"', async () => {
    for (let i = 0; i < 12; i += 1) {
      await insertHandoff({ title: `Offer ${i}`, by: 'alice', createdAt: new Date(Date.now() - i * 1000) });
    }
    const section = stack(await textOf('bob'));
    expect(section.match(/<b>Offer \d+<\/b>/g)).toHaveLength(ATTENTION_HANDOFF_LIMIT);
    expect(section).toContain(`more than ${ATTENTION_HANDOFF_LIMIT} match`);
    expect(section).toContain(`Showing the ${ATTENTION_HANDOFF_LIMIT} newest open handoffs`);
    expect(section).not.toMatch(/Showing 10 of 10/);
  });

  it('says exactly how many it read when there are not more than the limit', async () => {
    for (let i = 0; i < 3; i += 1) await insertHandoff({ title: `Few ${i}`, by: 'alice' });
    const section = stack(await textOf('bob'));
    expect(section).toContain('3 open handoffs');
    expect(section).not.toContain('more than');
  });

  it('leaves terminal handoffs out', async () => {
    await insertHandoff({ title: 'Done already', by: 'alice', state: 'completed' });
    await insertHandoff({ title: 'Cancelled already', by: 'alice', state: 'cancelled' });
    const section = stack(await textOf('bob'));
    expect(section).not.toContain('Done already');
    expect(section).not.toContain('Cancelled already');
    expect(section).toContain('Nothing needs action');
  });
});

// ------------------------------------------------------ access and leakage

describe('who can read it and what it cannot leak', () => {
  it('answers a non-member with a 404 and a signed-out visitor with the sign-in redirect', async () => {
    expect((await pageOf('eve')).status).toBe(404);
    const anonymous = await fetch(`${srv.url}/app/teams/att/attention`, { redirect: 'manual' });
    expect([302, 303]).toContain(anonymous.status);
    expect(anonymous.headers.get('location') ?? '').toContain('/login');
  });

  it('shows an owner and a member the same rows (it is read only)', async () => {
    const a = await start('alice', 'storefront', 'ST-1');
    const b = await start('bob', 'storefront', 'ST-2');
    await insertHandoff({ title: 'Shared brief', by: 'alice' });
    const owner = stack(await textOf('alice'));
    const member = stack(await textOf('carol'));
    expect(member).toBe(owner);
    expect(member).toContain('Shared brief');
    await call('finish_run', { run_id: a }, 'alice');
    await call('finish_run', { run_id: b }, 'bob');
  });

  it('keeps answering the same rows after a role change, and stops only on removal', async () => {
    await insertHandoff({ title: 'Role brief', by: 'alice' });
    const before = stack(await textOf('carol'));
    const carolId = await userId('carol');
    const setRole = (role: string) =>
      srv.db.update(memberships).set({ role }).where(and(eq(memberships.teamId, team.id), eq(memberships.userId, carolId)));
    await setRole('owner');
    expect(stack(await textOf('carol'))).toBe(before);
    await setRole('member');
    expect(stack(await textOf('carol'))).toBe(before);
    expect(before).toContain('Role brief');
  });

  it('stops answering the moment a member is removed', async () => {
    await joinAs('frank', 'alice', 'att');
    expect((await pageOf('frank')).status).toBe(200);
    await srv.db.delete(memberships).where(and(eq(memberships.teamId, team.id), eq(memberships.userId, await userId('frank'))));
    expect((await pageOf('frank')).status).toBe(404);
  });

  it('keeps another workspace\'s runs and handoffs out, even in a project with the same name', async () => {
    const mine = await start('alice', 'storefront', 'ST-1');
    const theirs = (
      await call('start_run', { team: 'other', project: 'storefront', task: 'OT-1', agent: 'dave-agent', scope: shared }, 'dave')
    ).data.runId as string;
    await insertHandoff({ title: 'Dave private brief', by: 'dave', teamId: otherTeam.id });
    const section = stack(await textOf('alice'));
    expect(rowCount(section)).toBe(0);
    expect(section).not.toContain(theirs);
    expect(section).not.toContain('Dave private brief');
    expect(section).toContain('1 live run read');

    const daves = stack(await textOf('dave', 'other'));
    expect(daves).not.toContain(mine);
    expect(daves).toContain('Dave private brief');
    expect((await pageOf('alice', 'other')).status).toBe(404);
    await call('finish_run', { run_id: mine }, 'alice');
    await call('finish_run', { run_id: theirs }, 'dave');
  });

  it('does not pair runs of different projects of one workspace', async () => {
    const a = await start('alice', 'storefront', 'ST-1');
    const b = await start('bob', 'payments', 'PAY-1');
    const section = stack(await textOf('alice'));
    expect(rowCount(section)).toBe(0);
    await call('finish_run', { run_id: a }, 'alice');
    await call('finish_run', { run_id: b }, 'bob');
  });
});

// ------------------------------------------------------------- the page

describe('the page itself', () => {
  it('has no form and no button, labels every inspection link read only, and carries no em dash', async () => {
    const a = await start('alice', 'storefront', 'ST-1');
    const b = await start('bob', 'storefront', 'ST-2');
    await insertHandoff({ title: 'A brief', by: 'alice', createdAt: new Date(Date.now() - 3 * DAY) });
    await insertHandoff({ title: 'Orphan', by: 'alice', state: 'needs_attention' });
    await call('update_run', { run_id: b, status: 'waiting' }, 'bob');
    const section = stack(await textOf('carol'));
    expect(section.length).toBeGreaterThan(500);
    expect(section).not.toContain('<form');
    expect(section).not.toContain('<button');
    expect(section).not.toContain('<input');
    expect(section).not.toMatch(/update_handoff|accept it|Resume now/);
    expect(section).not.toContain(String.fromCharCode(0x2014));
    const inspection = [...section.matchAll(/<a href="([^"]+)">([^<]*)<\/a>/g)].filter(([, href]) =>
      /^\/app\/(agents\?run=|sessions\/)|\/projects\/|\/governance$|\/handoffs\?/.test(href!),
    );
    expect(inspection.length).toBeGreaterThan(3);
    for (const [, href, label] of inspection) expect(label, href).toContain('(read only)');
    await call('finish_run', { run_id: a }, 'alice');
    await call('finish_run', { run_id: b }, 'bob');
  });

  it('points at the doctor command and Agent connections without an anchor', async () => {
    const section = stack(await textOf('alice'));
    expect(section).toContain('<code>stma adapter doctor</code>');
    expect(section).toContain('prints no environment values');
    expect(section).toContain('href="/app/teams/att/connections"');
  });
});
