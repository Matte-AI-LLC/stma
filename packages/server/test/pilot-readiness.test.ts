/**
 * What a pilot is run with (the growth strategy of 2026-09-26): the receiver of
 * a handoff can see the commit it carried, a reviewer can open and copy a run's
 * evidence after the run has left the map, and the operator can read one pilot
 * workspace without SQL.
 *
 * The workspace is Parcel Desk, built by the operator's demo button — the same
 * way a reviewer's is — so every row is what the product writes, not a fixture
 * shaped to pass.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentRuns, debugSessions, handoffs, memberships, messages, runCheckpoints, teams, users } from '../src/db/schema';
import { pilotWindow, PILOT_MAX_DAYS } from '../src/domain/pilotSheet';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

let srv: StartedServer;
let dataDir: string;

type Jar = { header(): Record<string, string>; store(response: Response): void };

function jar(): Jar {
  const cookies = new Map<string, string>();
  return {
    header: (): Record<string, string> =>
      cookies.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {},
    store(response) {
      for (const line of response.headers.getSetCookie()) {
        const [pair] = line.split(';');
        const at = pair!.indexOf('=');
        cookies.set(pair!.slice(0, at), pair!.slice(at + 1));
      }
    },
  };
}

function form(cookies: Jar, pathname: string, body: Record<string, string>) {
  return fetch(`${srv.url}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...cookies.header() },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });
}

async function devLogin(username: string): Promise<Jar> {
  const cookies = jar();
  const response = await form(cookies, '/auth/dev', { username });
  expect(response.status).toBe(302);
  cookies.store(response);
  return cookies;
}

const get = (cookies: Jar, pathname: string) =>
  fetch(`${srv.url}${pathname}`, { headers: cookies.header(), redirect: 'manual' });

let lead: Jar;
let ops: Jar;
let stranger: Jar;
let team: { id: string; slug: string };
let handoff: { sessionId: string; checkpointId: string; title: string };
let checkpoint: { runId: string; commitSha: string };

beforeAll(async () => {
  process.env.ADMIN_USERNAMES = 'ops';
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-pilot-readiness-'));
  srv = await startServer(
    loadEnv({
      port: 0,
      host: '127.0.0.1',
      nodeEnv: 'test',
      devMode: true,
      databaseUrl: undefined,
      pgliteDir: dataDir,
      hosted: true,
      betaUnmetered: true,
    }),
  );
  delete process.env.ADMIN_USERNAMES;

  lead = await devLogin('pilot-lead');
  ops = await devLogin('ops');
  stranger = await devLogin('pilot-stranger');
  const [account] = await srv.db.select().from(users).where(eq(users.username, 'pilot-lead'));
  const built = await form(ops, `/admin/users/${account!.id}/demo-workspace`, {});
  expect(built.status).toBe(302);
  [team] = await srv.db
    .select({ id: teams.id, slug: teams.slug })
    .from(teams)
    .innerJoin(memberships, eq(memberships.teamId, teams.id))
    .where(and(eq(memberships.userId, account!.id), eq(memberships.role, 'owner')));
  const [row] = await srv.db
    .select({ sessionId: handoffs.sessionId, checkpointId: handoffs.checkpointId, title: debugSessions.title })
    .from(handoffs)
    .innerJoin(debugSessions, eq(debugSessions.id, handoffs.sessionId))
    .where(and(eq(debugSessions.teamId, team!.id), eq(handoffs.kind, 'handoff')));
  expect(row?.checkpointId, 'the demo hands work over with a tested checkpoint').toBeTruthy();
  handoff = { sessionId: row!.sessionId, checkpointId: row!.checkpointId!, title: row!.title };
  const [cp] = await srv.db
    .select({ runId: runCheckpoints.runId, commitSha: runCheckpoints.commitSha })
    .from(runCheckpoints)
    .where(eq(runCheckpoints.id, handoff.checkpointId));
  checkpoint = cp!;
}, 180_000);

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the receiver sees what a handoff carried', () => {
  it('draws the commit, the tests the sender reported and what the provider said, each with its source', async () => {
    const page = await (await get(lead, `/app/sessions/${handoff.sessionId}`)).text();
    expect(page).toContain('What was handed over');
    expect(page).toContain(checkpoint.commitSha);
    expect(page).toContain('pd-27-label-retry');
    expect(page).toContain('npm test: passed');
    expect(page).toContain('reported by the sending agent');
    expect(page).toContain('No provider observation of this exact commit.');
    expect(page).toContain('the receiving agent can resume only from this commit');
    expect(page).toContain(`href="/app/teams/${team.slug}/runs/${checkpoint.runId}"`);
    expect(page).toContain('From the handed-over commit');
  });

  it('says a handoff with no commit is a brief, not code', async () => {
    const [account] = await srv.db.select().from(users).where(eq(users.username, 'pilot-lead'));
    const [session] = await srv.db
      .insert(debugSessions)
      .values({ teamId: team.id, title: 'A runbook for the other machine', openedBy: account!.id })
      .returning();
    await srv.db.insert(handoffs).values({ sessionId: session!.id, offeredBy: account!.id });
    await srv.db.insert(messages).values({
      sessionId: session!.id,
      authorId: account!.id,
      kind: 'handoff',
      body: 'No branch — this is a brief, not code.',
      payload: { kind: 'handoff', branch: null, steps: ['Read the runbook'] },
    });
    const page = await (await get(lead, `/app/sessions/${session!.id}`)).text();
    expect(page).toContain('No commit: this handoff is a brief, not code.');
    expect(page).not.toContain('Evidence for the run it came from');
  });
});

describe("a run's evidence outlives the map", () => {
  it('is on its run page, in words, with a Markdown copy that keeps every source', async () => {
    const href = `/app/teams/${team.slug}/runs/${checkpoint.runId}`;
    const response = await get(lead, href);
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain('Delivered commit');
    expect(page).toContain(checkpoint.commitSha);
    expect(page).toContain('reported by the agent at');
    expect(page).toContain('Copy as Markdown');
    expect(page).toContain('data-copy="## STMA evidence: PD-27');
    expect(page).toContain(handoff.title);
    expect(page).not.toContain('client_report ·');

    const markdown = await get(lead, `${href}/evidence.md`);
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get('content-type')).toContain('text/markdown');
    expect(markdown.headers.get('content-disposition')).toContain('attachment');
    expect(markdown.headers.get('cache-control')).toContain('no-store');
    const text = await markdown.text();
    expect(text).toContain('## STMA evidence: PD-27');
    expect(text).toContain('reported by the agent at');
    expect(text).toContain('Tests reported by the agent: npm test passed (41 passed)');
    expect(text).toContain('No provider observation of this exact commit.');
    expect(text).toContain('**Delivered commit** (ok, reported by the agent)');
    // A check nobody answered is not "reported by the agent", whatever its source would have been.
    expect(text).toContain('**Environment** (unconfirmed, not reported by the agent)');
    expect(text).toContain('Informational evidence, not authorization to merge or deploy.');
  });

  it("is nobody else's, and answers only the canonical spelling of its id", async () => {
    const href = `/app/teams/${team.slug}/runs/${checkpoint.runId}`;
    expect((await get(stranger, href)).status).toBe(404);
    expect((await get(stranger, `${href}/evidence.md`)).status).toBe(404);
    // Another workspace's address does not reach this run either.
    expect((await get(stranger, `/app/teams/pilot-stranger/runs/${checkpoint.runId}`)).status).toBe(404);
    // PostgreSQL reads these as the same row; the page does not (audit 2026-09-21).
    expect((await get(lead, `/app/teams/${team.slug}/runs/${checkpoint.runId.replace(/-/g, '')}`)).status).toBe(404);
    expect((await get(lead, `/app/teams/${team.slug}/runs/%7B${checkpoint.runId}%7D`)).status).toBe(404);
  });

  it('is where the map sends a link to a run it no longer draws', async () => {
    const longAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await srv.db
      .update(agentRuns)
      .set({ endedAt: longAgo, lastHeartbeatAt: longAgo })
      .where(eq(agentRuns.id, checkpoint.runId));
    const page = await (await get(lead, `/app/agents?run=${checkpoint.runId}`)).text();
    expect(page).toContain('That exact run is no longer active');
    expect(page).toContain(`href="/app/teams/${team.slug}/runs/${checkpoint.runId}"`);
    // A stranger is told the run is gone, and not where it lives.
    const theirs = await (await get(stranger, `/app/agents?run=${checkpoint.runId}`)).text();
    expect(theirs).toContain('That exact run is no longer active');
    expect(theirs).not.toContain(`/runs/${checkpoint.runId}`);
  });
});

describe("the operator's pilot sheet", () => {
  it('reads one workspace, marks the operator, and names what it cannot know', async () => {
    const [operator] = await srv.db.select().from(users).where(eq(users.username, 'ops'));
    const [session] = await srv.db
      .insert(debugSessions)
      .values({ teamId: team.id, title: 'Dispatched by the operator', openedBy: operator!.id })
      .returning();
    await srv.db.insert(handoffs).values({ sessionId: session!.id, offeredBy: operator!.id, kind: 'assignment' });
    // The handed-over commit reached the receiver: a resume on a checkpointed
    // handoff is one STMA only accepts on that commit.
    await srv.db.update(handoffs).set({ resumedAt: new Date(), state: 'in_progress' }).where(eq(handoffs.sessionId, handoff.sessionId));

    const response = await get(ops, `/admin/teams/${team.id}/pilot`);
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain('Pilot sheet: Parcel Desk');
    expect(page).toContain('Work handed over and assigned');
    expect(page).toContain('Dispatched by the operator');
    expect(page).toContain('operator</span>');
    expect(page).toContain('on commit');
    expect(page).toContain(checkpoint.commitSha.slice(0, 12));
    expect(page).toContain('Not recorded here: write these in the pilot record');
    expect(page).toContain('Founder reminders');

    const markdown = await get(ops, `/admin/teams/${team.id}/pilot.md`);
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get('cache-control')).toContain('no-store');
    expect(markdown.headers.get('content-disposition')).toContain(`pilot-${team.slug}-`);
    const text = await markdown.text();
    expect(text).toContain('# Pilot sheet: Parcel Desk');
    expect(text).toContain('Dispatched by the operator');
    expect(text).toContain('(operator)');
    expect(text).toContain('✓ commit');
    expect(text).toContain('## Weekly');
    expect(text).toContain('## Not recorded here: write these in the pilot record');
    // Two handoffs (the demo's and the brief above), three assignments (the
    // demo's two and the operator's one): the operator's is counted and named.
    expect(text).toContain('2 handoff(s), 3 assignment(s) (1 dispatched by the operator)');
  });

  it('is the operator\'s alone', async () => {
    expect((await get(lead, `/admin/teams/${team.id}/pilot`)).status).toBe(404);
    expect((await get(lead, `/admin/teams/${team.id}/pilot.md`)).status).toBe(404);
  });

  it('starts at the pilot\'s first day, within bounds', () => {
    const now = new Date('2026-09-26T12:00:00.000Z');
    expect(pilotWindow('2026-09-12', now).since.toISOString()).toBe('2026-09-12T00:00:00.000Z');
    expect(pilotWindow('2000-01-01', now).days).toBe(PILOT_MAX_DAYS);
    expect(pilotWindow('not-a-date', now).days).toBe(28);
    expect(pilotWindow('2027-01-01', now).days).toBe(28);
  });
});
