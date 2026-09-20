import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { debugSessions, handoffs, memberships, projects, teams, users } from '../src/db/schema';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

/**
 * A two-person workspace end to end: an owner and an invited member, one
 * agent each, a lead-to-member assignment, a member-to-lead assignment (to
 * find out whether that is even allowed today), the roster each of them can
 * see, and a cross-person agent-to-agent handoff by name that only the named
 * installation may accept.
 *
 * Fixture shape (cookie jar, form(), the MCP call() envelope, connectAgent())
 * is copied from assignments.test.ts rather than reinvented — same
 * enrollment flow other tests already rely on. The invite-code lookup
 * (`?tab=people`, not the overview) is copied from delivery.test.ts's
 * beforeAll, which names the exact same trap this file would otherwise fall
 * into: invites have not been on the overview tab since it got tabs.
 */

let srv: StartedServer;
let dataDir: string;

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
async function call(tool: string, args: Record<string, unknown>, tok: string) {
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
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* prose answer */
  }
  return { text, data, isError: json.result?.isError === true || json.error !== undefined };
}

const news = async (tok: string) =>
  (await fetch(`${srv.url}/api/agent/news`, { headers: { authorization: `Bearer ${tok}` } })).json() as Promise<{
    pendingHandoffs: {
      sessionId: string;
      kind: string;
      assignedTo: { agent: string; device: string | null; thisAgent: boolean } | null;
    }[];
  }>;

/** One enrolled, client-confirmed agent: the shape every real connection has. */
async function connectAgent(cookie: Record<string, string>, teamId: string, name: string, device: string) {
  const page = await form(
    `${srv.url}/app/tokens`,
    { name, device, access: `team:${teamId}`, client: 'codex', role: 'generalist' },
    cookie,
  );
  const html = await page.text();
  const code = /(?:&quot;|")STMA_ENROLLMENT_CODE(?:&quot;|")\s*:\s*(?:&quot;|")([^"&<]+)/.exec(html)?.[1];
  expect(code, `enrollment code for ${name}`).toMatch(/^stma_enroll_/);
  const redeemed = (await (
    await fetch(`${srv.url}/api/agent-enrollments/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
  ).json()) as { token: string };
  expect(redeemed.token).toMatch(/^stma_/);
  // Bootstrap authority becomes a working credential only once the client
  // confirms it loaded the tools — exactly as a real client would.
  const who = await call('whoami', {}, redeemed.token);
  expect(who.isError, who.text).toBe(false);
  return { token: redeemed.token, installationId: who.data.credential.installationId as string };
}

/**
 * One server for the whole file, as beta-access.test.ts does: the suite caps
 * workers at two because each embedded-PGlite fixture is memory-heavy, and a
 * second boot here would starve whatever runs beside it.
 */
beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-hierarchy-'));
  srv = await startServer(
    loadEnv({
      port: 0,
      host: '127.0.0.1',
      nodeEnv: 'test',
      devMode: true,
      databaseUrl: undefined,
      pgliteDir: dataDir,
    }),
  );
});

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

let leadCookie: Record<string, string> = {};
let memberCookie: Record<string, string> = {};
let teamId = '';
let teamSlug = '';
let projectSlug = '';
let projectId = '';
let leadAgent = { token: '', installationId: '' };
let memberAgent = { token: '', installationId: '' };
/** Connected only for step 7: the lead's other machine, a genuine third installation. */
let leadAgentTwo = { token: '', installationId: '' };
/** Connected only for step 7: the member's other machine — same owner as the named agent. */
let memberAgentTwo = { token: '', installationId: '' };

it('1. the owner creates a workspace and a project', async () => {
  const lead = jar();
  lead.store(await form(`${srv.url}/auth/dev`, { username: 'roster-lead' }));
  leadCookie = lead.header();

  const createdTeam = await form(`${srv.url}/app/teams`, { name: 'Roster HQ' }, leadCookie);
  expect(createdTeam.status).toBe(302);
  const [team] = await srv.db.select().from(teams).where(eq(teams.name, 'Roster HQ'));
  expect(team).toBeTruthy();
  teamId = team!.id;
  teamSlug = team!.slug;

  const createdProject = await form(`${srv.url}/app/projects`, { team: teamSlug, project: 'roster-app' }, leadCookie);
  expect(new URL(createdProject.headers.get('location')!, srv.url).searchParams.get('ok')).toContain(
    'Project created',
  );
  const [project] = await srv.db.select().from(projects).where(eq(projects.name, 'roster-app'));
  expect(project).toBeTruthy();
  projectSlug = project!.slug;
  projectId = project!.id;

  // The creator is the workspace's owner, not just a member — the fact the
  // rest of this file tests the consequences of. Exactly one membership
  // exists at this point (nobody else has joined yet), so it is the creator's.
  const [only] = await srv.db.select({ role: memberships.role }).from(memberships).where(eq(memberships.teamId, teamId));
  expect(only?.role).toBe('owner');
});

it('2. the owner invites a second human, who redeems the code and joins', async () => {
  await form(`${srv.url}/app/teams/${teamSlug}/invites`, {}, leadCookie);
  // Invite links live on the People tab, not the overview — reading the
  // overview here finds nothing, and every "member" call below would then be
  // a stranger instead of a joined teammate (the same trap delivery.test.ts's
  // fixture comment names, found 2026-09-20 on a page a member may read).
  const peoplePage = await (await fetch(`${srv.url}/app/teams/${teamSlug}?tab=people`, { headers: leadCookie })).text();
  const invite = /\/join\/([A-Za-z0-9_-]+)/.exec(peoplePage)?.[1] ?? '';
  expect(invite, 'invite code').toBeTruthy();

  const member = jar();
  member.store(await form(`${srv.url}/auth/dev`, { username: 'roster-member' }));
  memberCookie = member.header();
  const joined = await form(`${srv.url}/join/${invite}`, {}, memberCookie);
  expect(joined.status).toBe(302);

  const [row] = await srv.db
    .select({ role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.teamId, teamId), eq(users.username, 'roster-member')));
  // The member really is a member, not a second owner — the premise step 5 tests.
  expect(row?.role).toBe('member');
});

it('3. each human connects their own agent', async () => {
  leadAgent = await connectAgent(leadCookie, teamId, 'Lead Agent', 'lead-mac');
  memberAgent = await connectAgent(memberCookie, teamId, 'Member Agent', 'member-linux');
  expect(leadAgent.installationId).not.toBe(memberAgent.installationId);

  const { data, isError, text } = await call('list_teammates', { team: teamSlug }, leadAgent.token);
  expect(isError, text).toBe(false);
  const leadMember = data.members.find((m: any) => m.username === 'roster-lead');
  const memberMember = data.members.find((m: any) => m.username === 'roster-member');
  expect(leadMember.agents.map((a: any) => a.agent)).toEqual(['Lead Agent']);
  expect(memberMember.agents.map((a: any) => a.agent)).toEqual(['Member Agent']);
});

let leadToMemberSession = '';

it("4. the lead assigns work to the member's agent", async () => {
  const created = await form(
    `${srv.url}/app/teams/${teamSlug}/projects/${projectSlug}/assign`,
    {
      agent: memberAgent.installationId,
      task: 'RH-1 Build the roster page',
      brief: 'Render the roster grouped by person, owner first.',
      steps: 'Run the tests\nCommit on the current branch',
      branch: '',
    },
    leadCookie,
  );
  expect(created.status).toBe(302);
  const location = created.headers.get('location') ?? '';
  expect(location).not.toContain('assign_error');
  const sessionId = /[?&]assigned=([0-9a-f-]{36})/.exec(location)?.[1];
  expect(sessionId, location).toBeTruthy();
  leadToMemberSession = sessionId!;

  const landed = await (await fetch(`${srv.url}${location.split('#')[0]}`, { headers: leadCookie })).text();
  expect(landed).toContain('went to <b>Member Agent on member-linux</b>');

  const [row] = await srv.db.select().from(handoffs).where(eq(handoffs.sessionId, leadToMemberSession));
  expect(row?.targetInstallationId).toBe(memberAgent.installationId);
  expect(row?.kind).toBe('assignment');

  const forMember = await news(memberAgent.token);
  expect(forMember.pendingHandoffs.some((h) => h.sessionId === leadToMemberSession)).toBe(true);
});

it(
  "5. the member assigns work to the lead's agent — the handler has no owner check",
  async () => {
    // projects.tsx `.post('/app/teams/:slug/projects/:project/assign', ...)`
    // resolves access with `teamForUser(db, user.id, slug)` only — the same
    // plain membership lookup `/app/teams/:slug/agents` uses — and never
    // reads `access.role`. That is a real asymmetry inside this same file:
    // `POST /app/projects` (project creation, exercised below) refuses
    // anybody whose role is not 'owner', and domain/policies.ts,
    // domain/delivery.ts and domain/environments.ts all gate their writes the
    // same way. Assignment dispatch simply never asks the question. This
    // assertion is the proof, not a guess from reading the source.
    const created = await form(
      `${srv.url}/app/teams/${teamSlug}/projects/${projectSlug}/assign`,
      {
        agent: leadAgent.installationId,
        task: 'RH-2 Review the grouping',
        brief: 'Check that the roster groups every agent under its owner.',
        steps: '',
        branch: '',
      },
      memberCookie,
    );
    expect(created.status).toBe(302);
    const location = created.headers.get('location') ?? '';
    expect(location).not.toContain('assign_error');
    const sessionId = /[?&]assigned=([0-9a-f-]{36})/.exec(location)?.[1];
    expect(sessionId, location).toBeTruthy();

    const [row] = await srv.db.select().from(handoffs).where(eq(handoffs.sessionId, sessionId!));
    expect(row?.targetInstallationId).toBe(leadAgent.installationId);
    expect(row?.kind).toBe('assignment');

    // The contrast: the workspace does gate some writes to owners only —
    // just not this one. A member cannot do what the owner did in step 1.
    const projectAttempt = await form(
      `${srv.url}/app/projects`,
      { team: teamSlug, project: 'member-cannot-make-this' },
      memberCookie,
    );
    expect(projectAttempt.status).toBe(404);
  },
);

it("6. the lead sees the full roster; record what the member sees too", async () => {
  const run = await call(
    'start_run',
    {
      request_id: randomUUID(),
      team: teamSlug,
      project: 'roster-app',
      task: 'RH-3 Roster grouping',
      scope: [{ type: 'path', key: 'src/roster.ts', access: 'write' }],
    },
    memberAgent.token,
  );
  expect(run.isError, run.text).toBe(false);

  const row = (html: string, agent: string) =>
    new RegExp(`<tr><td><div class="name">${agent}</div>.*?</tr>`, 's').exec(html)?.[0] ?? '';

  const asLead = await (await fetch(`${srv.url}/app/teams/${teamSlug}/agents`, { headers: leadCookie })).text();
  const named = (who: string) => `/people/${who}">${who}</a>`;
  expect(asLead).toContain(named('roster-lead'));
  expect(asLead).toContain(named('roster-member'));
  expect(row(asLead, 'Member Agent')).toContain('RH-3 Roster grouping');
  expect(row(asLead, 'Member Agent')).toContain('holding 1');
  expect(row(asLead, 'Lead Agent')).toBeTruthy();

  // What the member sees on the identical URL: `domain/roster.ts`
  // `agentRoster`/`rosterByPerson` takes the team id only, never the viewer,
  // so a non-owner member sees the same grouped roster the owner does —
  // including the lead's own agent, not merely their own row. Recorded
  // rather than assumed: both bodies are asserted against the same markers.
  const asMember = await (await fetch(`${srv.url}/app/teams/${teamSlug}/agents`, { headers: memberCookie })).text();
  expect(asMember).toContain(named('roster-lead'));
  expect(asMember).toContain(named('roster-member'));
  expect(row(asMember, 'Member Agent')).toContain('RH-3 Roster grouping');
  expect(row(asMember, 'Member Agent')).toContain('holding 1');
  expect(row(asMember, 'Lead Agent')).toBeTruthy();

  // And a person's own page: a plain member may read it about the lead. Reading
  // who did what is not an owner's privilege here — the roster above already
  // shows every member's agents to every member, and a page nobody could open
  // would make each of those names a dead link.
  const leadsPage = await fetch(`${srv.url}/app/teams/${teamSlug}/people/roster-lead`, { headers: memberCookie });
  expect(leadsPage.status).toBe(200);
  const aboutLead = await leadsPage.text();
  expect(aboutLead).toContain('<h1>roster-lead</h1>');
  expect(aboutLead).toContain('owner in');
  expect(row(aboutLead, 'Lead Agent')).toBeTruthy();
  // It is one person's page, not the roster: the other member's agents are not on it.
  expect(row(aboutLead, 'Member Agent')).toBe('');

  // Same for the project-scoped roster: a plain member is not turned away.
  const projectRes = await fetch(`${srv.url}/app/teams/${teamSlug}/projects/${projectSlug}/agents`, {
    headers: memberCookie,
  });
  expect(projectRes.status).toBe(200);
  const projectAsMember = await projectRes.text();
  expect(row(projectAsMember, 'Member Agent')).toContain('holding 1');
  expect(row(projectAsMember, 'Lead Agent')).toBeTruthy();

  expect((await call('finish_run', { run_id: run.data.runId }, memberAgent.token)).isError).toBe(false);
});

let crossHandoffSession = '';

it('7. one agent hands work to the other by name; no other installation can accept it', async () => {
  // Two flavours of "somebody else", connected up front so both refusals in
  // this test are against real installations rather than a made-up id:
  //  - the lead's other machine: a different installation AND a different
  //    person than the named agent's owner.
  //  - the member's other machine: a different installation but the SAME
  //    person as the named agent's owner.
  leadAgentTwo = await connectAgent(leadCookie, teamId, 'Lead Agent Two', 'lead-second-mac');
  memberAgentTwo = await connectAgent(memberCookie, teamId, 'Member Agent Two', 'member-second-linux');

  const handed = await call(
    'handoff_work',
    {
      request_id: randomUUID(),
      summary: 'Runbook: extend the roster grouping to show idle time per agent.',
      next_steps: ['Read the project context from STMA first', 'Add the idle-time column', 'Run the tests'],
      to_agent: 'Member Agent',
      to: 'roster-member',
      team: teamSlug,
      project: 'roster-app',
    },
    leadAgent.token,
  );
  expect(handed.isError, handed.text).toBe(false);
  expect(handed.data.assignedTo).toEqual({ agent: 'Member Agent', device: 'member-linux' });
  crossHandoffSession = handed.data.sessionId as string;

  // The receiving installation is the one named — read off the row
  // `transitionHandoff` itself checks against, not inferred from response prose.
  const [row] = await srv.db.select().from(handoffs).where(eq(handoffs.sessionId, crossHandoffSession));
  expect(row?.targetInstallationId).toBe(memberAgent.installationId);
  expect(row?.targetUserId).toBeTruthy();

  // `transitionHandoff` (domain/collaboration.ts) actually checks this in two
  // layers, and each installation here trips a different one:
  //   1. `offer.targetUserId !== userId` — a coarser, person-level check,
  //      reached first. The lead's other machine fails here, before the
  //      installation is ever compared, because it belongs to a different
  //      person than the named agent's owner.
  const crossPerson = await call(
    'update_handoff',
    { session_id: crossHandoffSession, action: 'accept' },
    leadAgentTwo.token,
  );
  expect(crossPerson.isError).toBe(true);
  expect(crossPerson.text).toContain('This offer addresses another member');

  //   2. `grant.installationId !== offer.targetInstallationId` — reached only
  //      once the person matches. The member's OTHER agent is owned by the
  //      right person and still refused, by the installation, naming the one
  //      that was actually addressed.
  const samePersonOtherInstallation = await call(
    'update_handoff',
    { session_id: crossHandoffSession, action: 'accept' },
    memberAgentTwo.token,
  );
  expect(samePersonOtherInstallation.isError).toBe(true);
  expect(samePersonOtherInstallation.text).toContain('assigned by name to Member Agent on member-linux');

  // Not even the sender's own installation: the same layer-2 rule applies to it too.
  const sender = await call('update_handoff', { session_id: crossHandoffSession, action: 'accept' }, leadAgent.token);
  expect(sender.isError).toBe(true);

  const accepted = await call(
    'update_handoff',
    { session_id: crossHandoffSession, action: 'accept' },
    memberAgent.token,
  );
  expect(accepted.isError, accepted.text).toBe(false);
  expect(accepted.data.handoff.state).toBe('accepted');
});

it('8. news for the assignment reaches only the agent it names', async () => {
  const forNamed = await news(memberAgent.token);
  const mine = forNamed.pendingHandoffs.find((h) => h.sessionId === crossHandoffSession);
  expect(mine).toBeTruthy();
  expect(mine!.assignedTo).toEqual({ agent: 'Member Agent', device: 'member-linux', thisAgent: true });

  // Not the lead's other installation, a different person entirely...
  const forThird = await news(leadAgentTwo.token);
  expect(forThird.pendingHandoffs.some((h) => h.sessionId === crossHandoffSession)).toBe(false);

  // ...and, the sharper case, not even the member's OTHER agent: isolation is
  // per installation, not per person, so the same human's second machine is
  // told nothing about work addressed to their first.
  const forSamePersonOtherInstallation = await news(memberAgentTwo.token);
  expect(forSamePersonOtherInstallation.pendingHandoffs.some((h) => h.sessionId === crossHandoffSession)).toBe(
    false,
  );

  // ...and not the sender's own installation either: it wrote the brief
  // itself, and `pendingHandoffs` (lib/sessions.ts) drops what a machine
  // wrote from its own news feed (the `here` flag) before the per-agent
  // `assignedTo`/`forThisAgent` filter in routes/control.ts even applies.
  const forSender = await news(leadAgent.token);
  expect(forSender.pendingHandoffs.some((h) => h.sessionId === crossHandoffSession)).toBe(false);
});

/**
 * Step 9: the sessions list narrowed to one person, and the slice of it on that
 * person's page.
 *
 * The filter lives on Sessions and the person page composes it — the other way
 * round would have produced a list the Sessions page could not reproduce, which
 * is the drift this page was built to avoid. So the assertions below are mostly
 * about the two agreeing: the same reader, the same definition, the same rows,
 * in the same order.
 *
 * What the definition includes and excludes is asserted against real threads
 * rather than read off the source: one the member opened in a browser, one the
 * lead opened and the member's *agent* replied in (an agent writes under its
 * human's account), one nobody but the lead touched, the announcements channel
 * they broadcast into, and the handoff from step 7 whose thread they wrote in
 * by accepting it.
 */
let memberOpened = '';
let memberRepliedIn = '';
let leadOnly = '';

it('9. the person filter answers "opened or wrote in", and excludes dispatched work', async () => {
  // Opened by the member, in the project, from a browser.
  const opened = await form(
    `${srv.url}/app/sessions`,
    {
      team: teamSlug,
      project: projectId,
      title: 'Roster page renders empty',
      body: 'Fresh workspace, no rows, no error in the log.',
    },
    memberCookie,
  );
  expect(opened.status).toBe(302);
  memberOpened = /\/app\/sessions\/([0-9a-f-]{36})/.exec(opened.headers.get('location') ?? '')?.[1] ?? '';
  expect(memberOpened, opened.headers.get('location') ?? '').toBeTruthy();

  // Opened by the lead's agent; replied to by the MEMBER's agent. Every MCP
  // write carries the owning human as `author_id`, so this is the member
  // writing in a thread they did not open — the half of the definition that an
  // `opened_by` filter alone would miss.
  const leadThread = await call(
    'open_session',
    { team: teamSlug, title: 'Heartbeat lease looks short', body: 'Lease expired mid-edit twice today.' },
    leadAgent.token,
  );
  expect(leadThread.isError, leadThread.text).toBe(false);
  memberRepliedIn = leadThread.data.sessionId as string;
  const replied = await call(
    'post_message',
    { session_id: memberRepliedIn, body: 'Same on member-linux, both times after a waiting update.', kind: 'note' },
    memberAgent.token,
  );
  expect(replied.isError, replied.text).toBe(false);

  // And one the member never touched at all.
  const untouched = await call(
    'open_session',
    { team: teamSlug, title: 'Nobody else was in here', body: 'Only the lead.' },
    leadAgent.token,
  );
  expect(untouched.isError, untouched.text).toBe(false);
  leadOnly = untouched.data.sessionId as string;

  // The announcements channel: created lazily by whoever first triggered it and
  // written into by everybody, so without the rule it would be filed under the
  // member as a thread they wrote in.
  expect(
    (await call('announce', { team: teamSlug, body: 'Rebased main onto the roster branch.' }, memberAgent.token))
      .isError,
  ).toBe(false);
  const [channel] = await srv.db
    .select({ id: debugSessions.id })
    .from(debugSessions)
    .where(and(eq(debugSessions.teamId, teamId), eq(debugSessions.kind, 'announcements')));
  expect(channel?.id, 'announcements channel').toBeTruthy();

  const href = (id: string) => `/app/sessions/${id}`;
  const everything = await (await fetch(`${srv.url}/app/sessions?team=${teamSlug}`, { headers: leadCookie })).text();
  // The unfiltered list of the same workspace holds all of it — so what the
  // filtered list leaves out below is the filter working, not missing rows.
  for (const id of [memberOpened, memberRepliedIn, leadOnly, crossHandoffSession, leadToMemberSession]) {
    expect(everything, `unfiltered list should hold ${id}`).toContain(href(id));
  }

  const res = await fetch(`${srv.url}/app/sessions?team=${teamSlug}&person=roster-member`, { headers: leadCookie });
  expect(res.status).toBe(200);
  const mine = await res.text();
  expect(mine).toContain(href(memberOpened));
  expect(mine).toContain(href(memberRepliedIn));
  expect(mine).not.toContain(href(leadOnly));
  expect(mine).not.toContain(href(channel!.id));
  // Dispatched work is the sharp case: the member accepted this handoff, and
  // accepting writes a message into its thread under their account. It stays
  // out, because it is work rather than conversation and their page already
  // lists it as work.
  expect(mine).not.toContain(href(crossHandoffSession));
  expect(mine).not.toContain(href(leadToMemberSession));
  // The tab counts the rows under it, filter included — one number meaning two
  // things is how a page starts arguing with itself.
  expect(mine).toContain('Open (2)');
  // Narrowed to a person, the way back is that person's page.
  expect(mine).toContain(`/app/teams/${teamSlug}/people/roster-member`);

  // A person filter needs a workspace to name a membership in, and a name that
  // is not a member here is the same 404 as a name that is nobody — otherwise
  // the filter answers "does this person exist" to anybody with a slug.
  const outsider = jar();
  outsider.store(await form(`${srv.url}/auth/dev`, { username: 'roster-outsider' }));
  for (const url of [
    `${srv.url}/app/sessions?team=${teamSlug}&person=nobody-at-all`,
    `${srv.url}/app/sessions?team=${teamSlug}&person=roster-outsider`,
    `${srv.url}/app/sessions?person=roster-member`,
  ]) {
    expect((await fetch(url, { headers: leadCookie })).status, url).toBe(404);
  }
});

it('10. the filter composes with project scope and survives paging', async () => {
  const scoped = await (
    await fetch(`${srv.url}/app/teams/${teamSlug}/projects/${projectSlug}/sessions?person=roster-member`, {
      headers: leadCookie,
    })
  ).text();
  // One of the member's two threads is in this project, the other is workspace-wide.
  expect(scoped).toContain(`/app/sessions/${memberOpened}`);
  expect(scoped).not.toContain(`/app/sessions/${memberRepliedIn}`);
  expect(scoped).toContain('Open (1)');

  // Paging: the pager's own links carry the filter, like project, action, actor
  // and the rest do on Activity. Page 2 of a two-row list is empty, which is
  // what makes its Newer link readable here.
  const second = await (
    await fetch(`${srv.url}/app/sessions?team=${teamSlug}&person=roster-member&page=2`, { headers: leadCookie })
  ).text();
  const newer = /href="([^"]*)"[^>]*>\s*← Newer/.exec(second)?.[1] ?? '';
  expect(newer.replace(/&amp;/g, '&')).toBe(`/app/sessions?team=${teamSlug}&person=roster-member`);
});

it('11. the person page shows a slice of that same list, and the same brief only once', async () => {
  const aboutMember = await (
    await fetch(`${srv.url}/app/teams/${teamSlug}/people/roster-member`, { headers: leadCookie })
  ).text();
  /** One card of the person page: from its title to the next card's title. */
  const cardOf = (html: string, title: string) => {
    const start = html.indexOf(`<div class="card-title">${title}</div>`);
    if (start === -1) return '';
    const end = html.indexOf('<div class="card-title">', start + 1);
    return html.slice(start, end === -1 ? undefined : end);
  };
  const sessions = cardOf(aboutMember, 'Sessions');
  expect(sessions, 'Sessions card').toBeTruthy();
  expect(sessions).toContain(`/app/sessions/${memberOpened}`);
  expect(sessions).toContain(`/app/sessions/${memberRepliedIn}`);
  expect(sessions).not.toContain(`/app/sessions/${leadOnly}`);
  // The definition, said on the row rather than only in the card's note.
  expect(sessions).toContain('opened it');
  expect(sessions).toContain('wrote in it');
  // The link leads to the list filtered the same way.
  expect(sessions.replace(/&amp;/g, '&')).toContain(`/app/sessions?team=${teamSlug}&person=roster-member`);

  // The handoff is on this page exactly once, and under one label: as work.
  expect(sessions).not.toContain(`/app/sessions/${crossHandoffSession}`);
  expect(cardOf(aboutMember, 'Work')).toContain(`/app/sessions/${crossHandoffSession}`);

  // And the acceptance line itself: the same rows, in the same order, as the
  // page the card links to.
  const list = await (
    await fetch(`${srv.url}/app/sessions?team=${teamSlug}&person=roster-member`, { headers: leadCookie })
  ).text();
  const threads = (html: string) => [...html.matchAll(/\/app\/sessions\/([0-9a-f-]{36})/g)].map((m) => m[1]);
  expect(threads(sessions)).toEqual(threads(list.slice(list.indexOf('<div class="sesslist">'))));
  expect(threads(sessions)).toHaveLength(2);
});
