import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { agentEvents, agentRuns, environmentChecks, projects, teams } from '../src/db/schema';
import { loadEnv } from '../src/env';
import { savingEvents, savingsLedger } from '../src/domain/savings';
import { startServer, type StartedServer } from '../src/server';

/**
 * The ledger, and the line it must not cross.
 *
 * A control plane can observe that it warned somebody. It cannot observe whether
 * the warning changed what they did — and the difference between those two is
 * the difference between a number a buyer trusts and one they stop reading. So
 * the tests here are mostly about what does *not* get counted.
 */

let srv: StartedServer;
let dataDir: string;
let cookie: Record<string, string> = {};
let token = '';
let teamId = '';

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
async function call(tool: string, args: Record<string, unknown>, tok = token) {
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
  const json = (await res.json()) as { result?: { content?: { text: string }[]; isError?: boolean } };
  const text = json.result?.content?.[0]?.text ?? '';
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* prose */
  }
  return { text, data, isError: json.result?.isError === true };
}

const page = async (query = '') =>
  (await fetch(`${srv.url}/app/teams/ledger-lab/savings${query}`, { headers: cookie })).text();

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-savings-'));
  srv = await startServer(
    loadEnv({
      port: 0,
      host: 'localhost',
      nodeEnv: 'test',
      devMode: true,
      databaseUrl: undefined,
      pgliteDir: dataDir,
      hosted: true,
    }),
  );
  const j = jar();
  j.store(await form(`${srv.url}/auth/dev`, { username: 'lead' }));
  cookie = j.header();
  await form(`${srv.url}/app/teams`, { name: 'Ledger Lab' }, cookie);
  const tokRes = await fetch(`${srv.url}/app/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...cookie },
    body: new URLSearchParams({ name: 'lead-laptop' }),
  });
  token = /stma_[0-9a-f]{40}/.exec(await tokRes.text())![0];
  teamId = (await srv.db.select({ id: teams.id }).from(teams).where(eq(teams.slug, 'ledger-lab')).limit(1))[0]!.id;
});

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

it('offers a free team the reason to upgrade rather than a dead end', async () => {
  const res = await fetch(`${srv.url}/app/teams/ledger-lab/savings`, { headers: cookie });
  expect(res.status).toBe(402);
  const html = await res.text();
  expect(html).toContain('class="rail"');
  expect(html).toContain('Solo plan and up');
  // Nothing has happened in this team yet, so the page says that rather than
  // advertising a zero.
  expect(html).toContain('Nothing to count yet');
  // The events accrue either way. A team that upgrades later must not find an
  // empty ledger and conclude the feature does not work.
  expect(html).toContain('still has a history to read');
});


it('records duplicate work as an event instead of only answering the agent', async () => {
  await srv.db.update(teams).set({ plan: 'team' }).where(eq(teams.id, teamId));
  const first = await call('start_run', { team: 'ledger-lab', project: 'api', task: 'PAY-7' });
  expect(first.isError, first.text).toBe(false);
  const second = await call('start_run', {
    team: 'ledger-lab',
    project: 'api',
    task: 'PAY-7',
    worktree: '/tmp/other',
  });
  expect(second.isError, second.text).toBe(false);

  const runs = await srv.db.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.teamId, teamId));
  const events = await srv.db
    .select({ type: agentEvents.type })
    .from(agentEvents)
    .where(eq(agentEvents.runId, runs.at(-1)!.id));
  expect(events.map((e) => e.type)).toContain('duplicates_detected');
});

it('does not write a new collision event on every heartbeat', async () => {
  const scope = [{ type: 'migration', key: 'refunds-ledger', access: 'write' }];
  const first = await call('start_run', { team: 'ledger-lab', project: 'api', task: 'HB-1', scope });
  expect(first.isError, first.text).toBe(false);
  const second = await call('start_run', {
    team: 'ledger-lab',
    project: 'api',
    task: 'HB-2',
    scope,
    worktree: '/tmp/hb2',
  });
  expect(second.isError, second.text).toBe(false);
  expect(second.data.conflicts.length, 'the second run collides').toBeGreaterThan(0);

  const runId = second.data.runId as string;
  const count = async () =>
    (
      await srv.db
        .select({ id: agentEvents.id })
        .from(agentEvents)
        .where(and(eq(agentEvents.runId, runId), eq(agentEvents.type, 'conflicts_detected')))
    ).length;
  const afterStart = await count();
  expect(afterStart).toBe(1);

  // Three heartbeats restating the same scope. Nothing about the collision has
  // changed, so nothing about it is worth writing down again.
  for (let i = 0; i < 3; i++) {
    const beat = await call('update_run', { run_id: runId, scope });
    expect(beat.isError, beat.text).toBe(false);
  }
  expect(await count(), 'an unchanged overlap is one event').toBe(afterStart);
});

it('treats one collision as one moment, however many heartbeats saw it', async () => {
  // Measured on staging: a keep-alive held one overlap for 25 minutes and the
  // evidence pack reported "overlapped another live run 33 time(s)". The trail
  // was writing a row per heartbeat for an unchanged collision — the same thing
  // the quota escalation already refuses to do.
  const runs = await srv.db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.teamId, teamId));
  const runId = runs.at(-1)!.id;
  const before = await savingsLedger(srv.db, teamId, 30);

  const detail = { count: 1, highestSeverity: 'critical', otherRunIds: ['run-a'] };
  await srv.db.insert(agentEvents).values(
    Array.from({ length: 12 }, () => ({ runId, type: 'conflicts_detected', detail })),
  );
  const after = await savingsLedger(srv.db, teamId, 30);
  expect(after.observed.conflict, 'twelve detections of one overlap').toBe(
    before.observed.conflict + 1,
  );

  // A different counterpart is a different collision and does count.
  await srv.db.insert(agentEvents).values({
    runId,
    type: 'conflicts_detected',
    detail: { count: 1, highestSeverity: 'critical', otherRunIds: ['run-b'] },
  });
  const third = await savingsLedger(srv.db, teamId, 30);
  expect(third.observed.conflict).toBe(before.observed.conflict + 2);

  // And the list offers it once, not twelve times.
  const listed = await savingEvents(srv.db, teamId, 50);
  const collisions = listed.filter((e) => e.kind === 'conflict');
  expect(collisions.length).toBeLessThanOrEqual(3);
});

it('lists the moments and counts only the ones that changed what happened', async () => {
  // A machine that was stopped before it started — the other half of the ledger,
  // and the one that comes from a different table entirely.
  const projectId = (
    await srv.db.select({ id: projects.id }).from(projects).where(eq(projects.teamId, teamId)).limit(1)
  )[0]!.id;
  await srv.db.insert(environmentChecks).values({
    teamId,
    projectId,
    status: 'critical',
    fingerprint: 'fp-savings-critical',
    summary: 'node 25.2.1 against a baseline of 20.18.1',
  });

  const before = await page();
  expect(before).toContain('duplicate work');
  expect(before).toContain('machine stopped');
  expect(before).toContain('waiting on you');

  const refs = [...before.matchAll(/name="ref" value="([0-9a-f-]{36})"/g)].map((m) => m[1]!);
  const kinds = [...before.matchAll(/name="kind" value="(\w+)"/g)].map((m) => m[1]!);
  expect(refs.length).toBeGreaterThanOrEqual(2);

  // One that changed what happened, one that was merely interesting.
  await form(
    `${srv.url}/app/teams/ledger-lab/savings/confirm`,
    { kind: kinds[0]!, ref: refs[0]!, verdict: 'changed', minutes: '45', spend: '1' },
    cookie,
  );
  await form(
    `${srv.url}/app/teams/ledger-lab/savings/confirm`,
    { kind: kinds[1]!, ref: refs[1]!, verdict: 'helpful', minutes: '90' },
    cookie,
  );

  const ledger = await savingsLedger(srv.db, teamId, 30);
  expect(ledger.answered, 'both answers are kept').toBe(2);
  // The whole point: "useful, but I would have done the same" is not a saving,
  // and its 90 minutes must not appear anywhere in the total.
  expect(ledger.confirmed).toBe(1);
  expect(ledger.minutesSaved).toBe(45);
  expect(ledger.spendStopped).toBe(1);
  expect(ledger.observedTotal).toBeGreaterThanOrEqual(2);
  expect(ledger.valueCents, 'no rate, so no currency figure is invented').toBeNull();
});

it('answering the same event again replaces the answer rather than adding one', async () => {
  const html = await page();
  const ref = /name="ref" value="([0-9a-f-]{36})"/.exec(html)![1]!;
  const kind = /name="kind" value="(\w+)"/.exec(html)![1]!;
  const confirm = (minutes: string) =>
    form(
      `${srv.url}/app/teams/ledger-lab/savings/confirm`,
      { kind, ref, verdict: 'changed', minutes },
      cookie,
    );
  await confirm('10');
  const once = await savingsLedger(srv.db, teamId, 30);
  await confirm('20');
  const twice = await savingsLedger(srv.db, teamId, 30);
  // Two submissions, one answer. A ledger that grows every time somebody
  // refreshes the page is worse than one nobody fills in.
  expect(twice.answered, 'no second row').toBe(once.answered);
  expect(twice.minutesSaved, 'replaced, not added').toBe(once.minutesSaved - 10 + 20);
});

it('keeps answered moments behind a tab, and the tab is a link', async () => {
  const waiting = await page();
  // Default view is the queue. The answered record is one click away and the
  // click is a link, like the agent map's inspector — it survives a refresh,
  // it can be pasted to somebody, and it needs no JavaScript.
  expect(waiting).toContain('Waiting for an answer');
  expect(waiting).toContain('savings?show=answered');
  expect(waiting).not.toContain('Change this answer');

  const answered = await page('?show=answered');
  expect(answered).toContain('Change this answer');
  expect(answered).toContain('counted');
  // A rejected answer says what was typed into it. Stored but invisible made
  // "deliberately not counted" and "never arrived" look the same from outside,
  // which is the one doubt this page cannot afford.
  expect(answered).toContain('not counted (1.5 h recorded, not added)');
  // The form remembers. "Update" that makes you retype everything is not an
  // update, and a select reading `Choose…` above a line saying it was counted
  // invites exactly one question: is my answer still there?
  expect(answered).toMatch(/<option value="changed" selected(="")?>/);
  expect(answered).toMatch(/name="minutes"[^>]*value="45"/);
  // Correcting one from here comes back here rather than dumping you in the queue.
  expect(answered).toContain('name="show" value="answered"');
  // And an unanswered one still opens blank.
  expect(waiting).toMatch(/<option value="" selected(="")? disabled(="")?>/);
});

it('turns minutes into money only when somebody says what an hour is worth', async () => {
  const noRate = await page();
  expect(noRate).toContain('no hourly rate set');

  await form(`${srv.url}/app/teams/ledger-lab/savings/rate`, { rate: '120' }, cookie);
  const ledger = await savingsLedger(srv.db, teamId, 30);
  expect(ledger.hourlyCostCents).toBe(12_000);
  expect(ledger.valueCents).toBe(Math.round((ledger.minutesSaved * 12_000) / 60));

  const withRate = await page();
  expect(withRate).toContain('at your hourly rate');
  expect(withRate).not.toContain('no hourly rate set');
});

it('shows a gated team its own count, not a claim it cannot check', async () => {
  // Kept last: it needs the moments the tests above create. Put back on free,
  // because the upgrade argument is the reader's own number rather than an
  // assertion about it, and only a gated team ever sees that page.
  //
  const plan = (await srv.db.select({ plan: teams.plan }).from(teams).where(eq(teams.id, teamId)).limit(1))[0]!.plan;
  await srv.db.update(teams).set({ plan: 'free' }).where(eq(teams.id, teamId));
  try {
    const html = await (
      await fetch(`${srv.url}/app/teams/ledger-lab/savings`, { headers: cookie })
    ).text();
    expect(html).toContain('moments worth counting');
    expect(html).toMatch(/<b>[1-9]\d*<\/b>/);
    expect(html).not.toContain('Nothing to count yet');
  } finally {
    await srv.db.update(teams).set({ plan }).where(eq(teams.id, teamId));
  }
});
