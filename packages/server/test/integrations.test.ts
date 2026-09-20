import { createServer, type Server } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { projects } from '../src/db/schema';
import { loadEnv, type Env } from '../src/env';
import { githubOutbox, parseIssueRef } from '../src/lib/github';
import { clickupOutbox, isClickupCustomTaskId, parseClickupTaskRef } from '../src/lib/clickup';
import {
  guessTracker,
  pickableTrackers,
  ticketExamples,
  TICKET_PICKER_LIMIT,
} from '../src/domain/tickets';
import { flushNotificationsOnce } from '../src/lib/notifications';
import { startServer, type StartedServer } from '../src/server';

/**
 * The two outward-facing integrations: a team's GitHub issues, and a person's
 * own chat client.
 *
 * GitHub runs on the memory transport here (NODE_ENV=test, lib/github), so
 * every decision this code makes — when to comment, when to refuse, what a
 * task key has to look like before STMA writes into somebody's tracker — is
 * exercised without a token or a network call. The personal webhook is tested
 * against a real local receiver, because "did the POST actually arrive" is the
 * entire question that feature answers.
 */

let srv: StartedServer;
let env: Env;
let dataDir: string;
let alice = '';
let bob = '';
let aliceCookie: Record<string, string> = {};
let bobCookie: Record<string, string> = {};

/** A local Slack-shaped receiver, so webhook delivery is observed, not assumed. */
let receiver: Server;
let receiverUrl = '';
const received: unknown[] = [];

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
    /* prose answers */
  }
  return { text, data, isError: json.result?.isError === true || json.error !== undefined };
}

async function tokenFor(cookie: Record<string, string>, name: string) {
  const res = await fetch(`${srv.url}/app/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...cookie },
    body: new URLSearchParams({ name }),
  });
  const tok = /stma_[0-9a-f]{40}/.exec(await res.text())?.[0] ?? '';
  expect(tok, `token for ${name}`).toBeTruthy();
  return tok;
}

const connectGithub = (extra: Record<string, string> = {}) =>
  form(
    `${srv.url}/app/teams/ship/integrations/github`,
    { action: 'save', repo: 'acme/storefront', token: 'ghp_testtoken', comment_on_finish: 'on', ...extra },
    aliceCookie,
  );

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-integrations-'));
  env = loadEnv({
    port: 0,
    host: '127.0.0.1',
    nodeEnv: 'test',
    devMode: true,
    databaseUrl: undefined,
    pgliteDir: dataDir,
    notifyDebounceSeconds: 0,
    clickup: { clientId: 'clickup-client-test', clientSecret: 'clickup-secret-test' },
  });
  srv = await startServer(env);

  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        received.push(JSON.parse(body));
      } catch {
        received.push(body);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/hook`;

  const a = jar();
  a.store(await form(`${srv.url}/auth/dev`, { username: 'alice' }));
  aliceCookie = a.header();
  await form(`${srv.url}/app/teams`, { name: 'Ship' }, aliceCookie);
  alice = await tokenFor(aliceCookie, 'alice-macbook');

  await form(`${srv.url}/app/teams/ship/invites`, {}, aliceCookie);
  const teamPage = await (await fetch(`${srv.url}/app/teams/ship?tab=people`, { headers: aliceCookie })).text();
  const code = /\/join\/([A-Za-z0-9_-]+)/.exec(teamPage)?.[1] ?? '';
  const b = jar();
  b.store(await form(`${srv.url}/auth/dev`, { username: 'bob' }));
  bobCookie = b.header();
  await form(`${srv.url}/join/${code}`, {}, bobCookie);
  bob = await tokenFor(bobCookie, 'bob-desktop');
});

afterAll(async () => {
  await srv?.close();
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

// ------------------------------------------------------------- issue parsing

it('only treats a task key as an issue when it unambiguously is one', () => {
  expect(parseIssueRef('#42', 'acme/store')).toEqual({ repo: 'acme/store', number: 42 });
  expect(parseIssueRef('other/repo#7', 'acme/store')).toEqual({ repo: 'other/repo', number: 7 });
  expect(parseIssueRef('https://github.com/acme/store/issues/9', 'acme/store')).toEqual({
    repo: 'acme/store',
    number: 9,
  });
  // The important negatives: an internal ticket id must never become a comment
  // on a stranger's issue.
  expect(parseIssueRef('421', 'acme/store')).toBeNull();
  expect(parseIssueRef('PAY-421', 'acme/store')).toBeNull();
  expect(parseIssueRef('', 'acme/store')).toBeNull();
  expect(parseIssueRef(null, 'acme/store')).toBeNull();
});

it('only accepts explicit ClickUp task ids or task URLs', () => {
  expect(parseClickupTaskRef('clickup:z8qu5cuwp4')).toBe('z8qu5cuwp4');
  expect(parseClickupTaskRef('https://app.clickup.com/t/z8qu5cuwp4')).toBe('z8qu5cuwp4');
  expect(parseClickupTaskRef('PAY 421')).toBeNull();
});

/**
 * Which tracker somebody meant, from what they typed. Assign work has one field
 * rather than a picker, so this rule is the whole of it: a lead pastes what
 * their team already says out loud and does not classify it first.
 */
it('reads the tracker off the shape of a ticket reference', () => {
  const all = ['jira', 'github', 'clickup'] as const;
  expect(guessTracker('#42', all)).toBe('github');
  expect(guessTracker('acme/store#42', all)).toBe('github');
  expect(guessTracker('https://github.com/acme/store/issues/42', all)).toBe('github');
  expect(guessTracker('PAY-421', all)).toBe('jira');
  expect(guessTracker('pay-421', all)).toBe('jira');
  expect(guessTracker('https://app.clickup.com/t/z8qu5cuwp4', all)).toBe('clickup');
  expect(guessTracker('clickup:z8qu5cuwp4', all)).toBe('clickup');

  // parseClickupTaskRef accepts any single word, so ClickUp is tried last: a
  // Jira key is a Jira key even in a workspace that has ClickUp connected.
  expect(guessTracker('PAY-421', ['clickup'])).toBe('jira');
  // A bare id is read as ClickUp only where ClickUp is what is connected.
  expect(guessTracker('z8qu5cuwp4', ['clickup'])).toBe('clickup');
  expect(guessTracker('z8qu5cuwp4', ['jira', 'github'])).toBeNull();

  // Shape first, connection second, so the refusal can say *this is a Jira key
  // and no Jira site is connected* rather than *that is not a ticket*.
  expect(guessTracker('PAY-421', [])).toBe('jira');
  expect(guessTracker('not a ticket', all)).toBeNull();
  expect(guessTracker('   ', all)).toBeNull();

  // And the help text offers only what this project can actually read.
  expect(ticketExamples(['jira'])).toBe('PROJ-42');
  expect(ticketExamples(['github', 'clickup'])).toBe('#42 or owner/repo#42, a ClickUp task link');
  expect(ticketExamples([])).toBe('');
});

/**
 * Pasting a reference and browsing for one are not the same list.
 *
 * Every connected tracker can be pasted from; only GitHub and ClickUp can be
 * browsed. Atlassian moved issue search to `/rest/api/3/search/jql`, nothing
 * here has exercised that endpoint against a real site, and `getJiraIssue` is
 * the one Jira door this codebase has measured — against both of Jira's. A
 * guessed search call would fail on a lead's critical path rather than in a
 * test, so a Jira-connected project keeps the field and is told why the button
 * is missing.
 */
it('offers browsing for the trackers whose list endpoint has been measured', () => {
  expect(pickableTrackers(['jira', 'github', 'clickup'])).toEqual(['github', 'clickup']);
  expect(pickableTrackers(['jira'])).toEqual([]);
  expect(pickableTrackers(['clickup'])).toEqual(['clickup']);
  expect(pickableTrackers([])).toEqual([]);
  // The order is the constant's, not the caller's, so two projects with the
  // same trackers never draw their buttons in a different order.
  expect(pickableTrackers(['clickup', 'github'])).toEqual(['github', 'clickup']);
  // A picker, not a mirror.
  expect(TICKET_PICKER_LIMIT).toBeLessThanOrEqual(20);
});

// ------------------------------------------------------------------- github

it('says plainly that no repository is connected, instead of failing', async () => {
  const res = await call('list_issues', { team: 'ship' }, alice);
  expect(res.isError).toBe(true);
  expect(res.text).toContain('no GitHub repository connected');
  // And it points at the page where an owner fixes it.
  expect(res.text).toContain('/app/teams/ship');
});

it('lets an owner connect a repository, and nobody else', async () => {
  const denied = await form(
    `${srv.url}/app/teams/ship/integrations/github`,
    { action: 'save', repo: 'acme/storefront', token: 'ghp_x' },
    bobCookie,
  );
  expect(denied.status).toBe(404);

  const bad = await connectGithub({ repo: 'not-a-repo' });
  expect(bad.headers.get('location')).toContain('error=');

  const ok = await connectGithub();
  expect(ok.headers.get('location')).toContain('ok=');
  const page = await (await fetch(`${srv.url}/app/teams/ship?tab=integrations`, { headers: aliceCookie })).text();
  expect(page).toContain('acme/storefront');
  // The token is write-only: storing it must not put it back on the page.
  expect(page).not.toContain('ghp_testtoken');

  // A member does not even see the card.
  const memberPage = await (await fetch(`${srv.url}/app/teams/ship?tab=integrations`, { headers: bobCookie })).text();
  expect(memberPage).not.toContain('GitHub issues');
});

it('offers open issues as work and starts a run on one', async () => {
  githubOutbox.clear();
  githubOutbox.seedIssues([
    {
      number: 42,
      title: 'Checkout drops the discount code',
      url: 'https://github.com/acme/storefront/issues/42',
      labels: ['bug'],
      updatedAt: '2026-08-24T10:00:00Z',
    },
  ]);

  const listed = await call('list_issues', { team: 'ship' }, alice);
  expect(listed.isError).toBe(false);
  expect(listed.data.repo).toBe('acme/storefront');
  expect(listed.data.issues[0].number).toBe(42);

  const started = await call(
    'start_run',
    { team: 'ship', project: 'storefront', issue: 42, branch: 'fix/discount' },
    alice,
  );
  expect(started.isError).toBe(false);
  // The issue number becomes the task key, and its title becomes the intent —
  // so the map says what the work is, not what the agent called it.
  expect(started.data.task).toBe('#42');
  expect(started.data.issueUrl).toBe('https://github.com/acme/storefront/issues/42');

  const map = await (await fetch(`${srv.url}/app/agents`, { headers: aliceCookie })).text();
  expect(map).toContain('#42');

  // Finishing reports back where the team is watching.
  const finished = await call(
    'finish_run',
    { run_id: started.data.runId, note: 'discount code now survives the redirect' },
    alice,
  );
  expect(finished.data.issueComment).toContain('acme/storefront#42');
  const comments = githubOutbox.comments();
  expect(comments).toHaveLength(1);
  expect(comments[0]!.path).toBe('/repos/acme/storefront/issues/42/comments');
  expect((comments[0]!.body as { body: string }).body).toContain('finished');
  expect((comments[0]!.body as { body: string }).body).toContain('discount code');
});

it('comments the handoff brief onto the issue', async () => {
  githubOutbox.clear();
  githubOutbox.seedIssues([
    {
      number: 43,
      title: 'Cart totals drift on refunds',
      url: 'https://github.com/acme/storefront/issues/43',
      labels: [],
      updatedAt: '2026-08-24T11:00:00Z',
    },
  ]);
  const started = await call(
    'start_run',
    { team: 'ship', project: 'storefront', issue: 43, branch: 'fix/refund-totals' },
    alice,
  );
  const handed = await call(
    'handoff_work',
    {
      branch: 'fix/refund-totals',
      summary: 'Reproduced it: the refund path rounds before tax instead of after.',
      next_steps: ['Move the rounding after tax', 'Add a regression test'],
      reason: 'usage_limit',
      run_id: started.data.runId,
      checkpoint: {
        request_id: randomUUID(),
        kind: 'tested',
        repository_identity: 'https://github.com/acme/storefront.git',
        commit_sha: 'f'.repeat(40),
        worktree_clean: true,
        tests: [{ name: 'refund regression', state: 'passed' }],
      },
    },
    alice,
  );
  expect(handed.data.issueComment).toContain('acme/storefront#43');
  const body = (githubOutbox.comments()[0]!.body as { body: string }).body;
  expect(body).toContain('Handed off');
  expect(body).toContain('fix/refund-totals');
  expect(body).toContain('Move the rounding after tax');
});

it('never comments when the task is not an issue, or when the team turned it off', async () => {
  githubOutbox.clear();
  const plain = await call(
    'start_run',
    { team: 'ship', project: 'storefront', task: 'PAY-421', branch: 'chore/x' },
    alice,
  );
  await call('finish_run', { run_id: plain.data.runId }, alice);
  expect(githubOutbox.comments()).toHaveLength(0);

  // Commenting off: STMA reads the tracker but does not write to it.
  await connectGithub({ comment_on_finish: '' });
  githubOutbox.seedIssues([
    {
      number: 44,
      title: 'Silent one',
      url: 'https://github.com/acme/storefront/issues/44',
      labels: [],
      updatedAt: '2026-08-24T12:00:00Z',
    },
  ]);
  const quiet = await call('start_run', { team: 'ship', project: 'storefront', issue: 44 }, alice);
  const done = await call('finish_run', { run_id: quiet.data.runId }, alice);
  expect(done.data.issueComment).toBeUndefined();
  expect(githubOutbox.comments()).toHaveLength(0);
  await connectGithub(); // restore for later tests
});

// ------------------------------------------------------------------ ClickUp

it('connects ClickUp through OAuth, maps a project List, and lets an agent finish a task', async () => {
  clickupOutbox.clear();
  clickupOutbox.seed({
    tasks: [
      {
        id: 'cu-task-1',
        customId: null,
        name: 'Reduce onboarding friction',
        url: 'https://app.clickup.com/t/cu-task-1',
        status: 'backlog',
        updatedAt: '2026-09-14T08:00:00.000Z',
      },
    ],
  });

  // Create the STMA project through the same agent path a real workspace uses.
  const primer = await call(
    'start_run',
    { team: 'ship', project: 'clickup-demo', task: 'bootstrap-project' },
    alice,
  );
  expect(primer.isError).toBe(false);
  await call('finish_run', { run_id: primer.data.runId }, alice);

  const denied = await fetch(`${srv.url}/app/teams/ship/integrations/clickup/start`, {
    headers: bobCookie,
    redirect: 'manual',
  });
  expect(denied.status).toBe(404);

  const start = await fetch(`${srv.url}/app/teams/ship/integrations/clickup/start`, {
    headers: aliceCookie,
    redirect: 'manual',
  });
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get('location')!);
  expect(authorize.hostname).toBe('app.clickup.com');
  expect(authorize.searchParams.get('client_id')).toBe('clickup-client-test');
  const connectCookie = start.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');
  const callback = await fetch(
    `${srv.url}/auth/clickup/callback?state=${encodeURIComponent(authorize.searchParams.get('state')!)}&code=one-use-code`,
    {
      headers: { cookie: `${aliceCookie.cookie}; ${connectCookie}` },
      redirect: 'manual',
    },
  );
  expect(callback.status).toBe(302);
  expect(callback.headers.get('location')).toContain('Connected');

  const page = await (
    await fetch(`${srv.url}/app/teams/ship?tab=integrations`, { headers: aliceCookie })
  ).text();
  expect(page).toContain('Connected to <b>Test workspace</b>');
  expect(page).not.toContain('pk_test_clickup_oauth');
  const projectId = /option value="([a-f0-9-]+)">clickup-demo<\/option>/.exec(page)?.[1];
  expect(projectId).toBeTruthy();

  const mapped = await form(
    `${srv.url}/app/teams/ship/integrations/clickup/binding`,
    { project_id: projectId!, list_id: '2200', comment_on_finish: 'on' },
    aliceCookie,
  );
  expect(mapped.headers.get('location')).toContain('ok=');

  const listed = await call('list_clickup_tasks', { team: 'ship', project: 'clickup-demo' }, alice);
  expect(listed.isError).toBe(false);
  expect(listed.data.list).toEqual({ id: '2200', name: 'Engineering' });
  expect(listed.data.tasks[0].name).toBe('Reduce onboarding friction');

  clickupOutbox.seed({ taskListId: '9999' });
  const outside = await call(
    'start_run',
    { team: 'ship', project: 'clickup-demo', clickup_task: 'cu-task-1' },
    alice,
  );
  expect(outside.isError).toBe(true);
  expect(outside.text).toContain('task_outside_mapped_list');
  clickupOutbox.seed({ taskListId: '2200' });

  const started = await call(
    'start_run',
    { team: 'ship', project: 'clickup-demo', clickup_task: 'cu-task-1' },
    alice,
  );
  expect(started.isError).toBe(false);
  expect(started.data.task).toBe('clickup:cu-task-1');
  expect(started.data.issueUrl).toBe('https://app.clickup.com/t/cu-task-1');

  const finished = await call(
    'finish_run',
    { run_id: started.data.runId, note: 'OAuth path and mapping are covered.' },
    alice,
  );
  expect(finished.data.trackerComment).toContain('ClickUp cu-task-1');
  expect(finished.data.issueComment).toBeUndefined();
  expect(clickupOutbox.comments()).toHaveLength(1);
  expect(clickupOutbox.comments()[0]!.path).toBe('/task/cu-task-1/comment');
});

it('does not comment when a ClickUp task moved outside the mapped List after the run started', async () => {
  clickupOutbox.clear();
  clickupOutbox.seed({
    tasks: [
      {
        id: 'cu-task-moved',
        customId: null,
        name: 'Move between Lists',
        url: 'https://app.clickup.com/t/cu-task-moved',
        status: 'in progress',
        updatedAt: '2026-09-14T09:00:00.000Z',
      },
    ],
    taskListId: '2200',
  });
  const started = await call(
    'start_run',
    { team: 'ship', project: 'clickup-demo', clickup_task: 'cu-task-moved' },
    alice,
  );
  expect(started.isError).toBe(false);

  clickupOutbox.seed({ taskListId: '9999' });
  const finished = await call(
    'finish_run',
    { run_id: started.data.runId, note: 'Task moved while this run was open.' },
    alice,
  );
  expect(finished.isError).toBe(false);
  expect(finished.data.trackerComment).toBeUndefined();
  expect(clickupOutbox.comments()).toHaveLength(0);
});

/**
 * ClickUp keeps two id spaces and they are not interchangeable: the native id
 * is what the API answers by default, and a workspace's own `PD-207` is found
 * only with `custom_task_ids=true` *and* `team_id`. Both halves are asserted on
 * the wire, because a fake that matched either id would pass a caller that
 * forgot the flag — which is exactly the bug that made every custom id a 404.
 */
it('reads a ClickUp task by its custom id, and still records the native one', async () => {
  clickupOutbox.clear();
  clickupOutbox.seed({
    tasks: [
      {
        id: 'cu-task-custom',
        customId: 'PD-207',
        name: 'Parcel scanner drops the last digit',
        url: 'https://app.clickup.com/t/cu-task-custom',
        status: 'in progress',
        updatedAt: '2026-09-20T08:00:00.000Z',
      },
    ],
    taskListId: '2200',
  });

  expect(isClickupCustomTaskId('PD-207')).toBe(true);
  expect(isClickupCustomTaskId('cu-task-custom')).toBe(false);
  // The `clickup:` prefix survives a custom id, so a pasted reference and an
  // agent's parameter reach the same resolver.
  expect(parseClickupTaskRef('clickup:PD-207')).toBe('PD-207');

  const started = await call(
    'start_run',
    { team: 'ship', project: 'clickup-demo', clickup_task: 'PD-207' },
    alice,
  );
  expect(started.isError, started.text).toBe(false);
  // Stored native, deliberately: ClickUp guarantees that id, while a custom
  // prefix is a per-space setting somebody can change or switch off, and a task
  // key is written once and read back at merge time.
  expect(started.data.task).toBe('clickup:cu-task-custom');

  const read = clickupOutbox
    .all()
    .filter((c) => c.method === 'GET' && c.path.startsWith('/task/'))
    .at(-1)!;
  expect(read.path).toContain('/task/PD-207?');
  expect(read.path).toContain('custom_task_ids=true');
  expect(read.path).toContain('team_id=1100');

  // The comment at the end of the run re-reads the stored native reference, so
  // that call must go back to the native lookup.
  const finished = await call(
    'finish_run',
    { run_id: started.data.runId, note: 'Custom id path.' },
    alice,
  );
  expect(finished.data.trackerComment).toContain('ClickUp cu-task-custom');
  const reread = clickupOutbox
    .all()
    .filter((c) => c.method === 'GET' && c.path.startsWith('/task/cu-task-custom'))
    .at(-1)!;
  expect(reread.path).toContain('custom_task_ids=false');
  expect(clickupOutbox.comments()).toHaveLength(1);
  expect(clickupOutbox.comments()[0]!.path).toBe('/task/cu-task-custom/comment');
});

/**
 * "Retry-safe" is not "retrying". ClickUp's comment endpoint takes no
 * idempotency key, so STMA sends once and reports the outcome; what must hold
 * is that a *repeat of the same request* never posts twice, which is the only
 * repeat there is — every terminal call here is idempotent by request id.
 */
it('never comments twice for a replayed finish, and records what it last did', async () => {
  clickupOutbox.clear();
  clickupOutbox.seed({
    tasks: [
      {
        id: 'cu-task-replay',
        customId: null,
        name: 'Replayed finish',
        url: 'https://app.clickup.com/t/cu-task-replay',
        status: 'open',
        updatedAt: '2026-09-20T09:00:00.000Z',
      },
    ],
    taskListId: '2200',
  });
  const started = await call(
    'start_run',
    { team: 'ship', project: 'clickup-demo', clickup_task: 'cu-task-replay' },
    alice,
  );
  const note = 'a finish note that must never reach a page';
  const first = await call('finish_run', { run_id: started.data.runId, note }, alice);
  expect(first.data.trackerComment).toContain('ClickUp cu-task-replay');
  const again = await call('finish_run', { run_id: started.data.runId, note }, alice);
  expect(again.data.replayed).toBe(true);
  expect(again.data.trackerComment).toBeUndefined();
  expect(clickupOutbox.comments()).toHaveLength(1);

  const card = await (
    await fetch(`${srv.url}/app/teams/ship?tab=integrations`, { headers: aliceCookie })
  ).text();
  expect(card).toContain('cu-task-replay');
  expect(card).toContain('delivered');
  // The record is an identifier, a list and an outcome — never the comment.
  expect(card).not.toContain(note);
});

it('reports a refused ClickUp comment on the card instead of retrying it', async () => {
  clickupOutbox.clear();
  clickupOutbox.seed({
    tasks: [
      {
        id: 'cu-task-429',
        customId: null,
        name: 'Rate limited',
        url: 'https://app.clickup.com/t/cu-task-429',
        status: 'open',
        updatedAt: '2026-09-20T10:00:00.000Z',
      },
    ],
    taskListId: '2200',
  });
  const started = await call(
    'start_run',
    { team: 'ship', project: 'clickup-demo', clickup_task: 'cu-task-429' },
    alice,
  );
  clickupOutbox.seedFailure('rate_limited');
  const finished = await call('finish_run', { run_id: started.data.runId }, alice);
  clickupOutbox.seedFailure(null);
  // The run finished; the tracker did not fail it.
  expect(finished.isError).toBe(false);
  expect(finished.data.status).toBe('completed');
  expect(finished.data.trackerComment).toBeUndefined();

  const card = await (
    await fetch(`${srv.url}/app/teams/ship?tab=integrations`, { headers: aliceCookie })
  ).text();
  expect(card).toContain('not delivered (rate_limited)');
  expect(card).toContain('no idempotency key');
});

it('stores the verdict of Test access, and keeps calling ClickUp while paused', async () => {
  clickupOutbox.clear();
  const tested = await form(`${srv.url}/app/teams/ship/integrations/clickup`, { action: 'test' }, aliceCookie);
  expect(tested.headers.get('location')).toContain('ok=');
  let card = await (
    await fetch(`${srv.url}/app/teams/ship?tab=integrations`, { headers: aliceCookie })
  ).text();
  expect(card).toContain('Last checked');
  expect(card).toContain('ClickUp answered.');

  const paused = await form(`${srv.url}/app/teams/ship/integrations/clickup`, { action: 'pause' }, aliceCookie);
  expect(paused.headers.get('location')).toContain('ok=');
  card = await (
    await fetch(`${srv.url}/app/teams/ship?tab=integrations`, { headers: aliceCookie })
  ).text();
  expect(card).toContain('<b>Paused</b>');
  expect(card).toContain('Resume');

  // Paused means STMA stops using the connection: no reads for agents...
  const listed = await call('list_clickup_tasks', { team: 'ship', project: 'clickup-demo' }, alice);
  expect(listed.isError).toBe(true);
  expect(listed.text).toContain('No ClickUp List is mapped');
  // ...and no writes either, without touching the mapping.
  const started = await call(
    'start_run',
    { team: 'ship', project: 'clickup-demo', task: 'clickup:cu-task-1' },
    alice,
  );
  const finished = await call('finish_run', { run_id: started.data.runId }, alice);
  expect(finished.data.trackerComment).toBeUndefined();
  expect(clickupOutbox.comments()).toHaveLength(0);

  // The owner's own Test button still answers — it is how they decide to resume.
  const whilePaused = await form(`${srv.url}/app/teams/ship/integrations/clickup`, { action: 'test' }, aliceCookie);
  expect(whilePaused.headers.get('location')).toContain('ok=');

  const resumed = await form(`${srv.url}/app/teams/ship/integrations/clickup`, { action: 'resume' }, aliceCookie);
  expect(resumed.headers.get('location')).toContain('ok=');
  const back = await call('list_clickup_tasks', { team: 'ship', project: 'clickup-demo' }, alice);
  expect(back.isError, back.text).toBe(false);
});

it('turns commenting off without making the owner re-pick a project and a List', async () => {
  clickupOutbox.clear();
  clickupOutbox.seed({
    tasks: [
      {
        id: 'cu-task-quiet',
        customId: null,
        name: 'No comment wanted',
        url: 'https://app.clickup.com/t/cu-task-quiet',
        status: 'open',
        updatedAt: '2026-09-20T11:00:00.000Z',
      },
    ],
    taskListId: '2200',
  });
  const off = await form(
    `${srv.url}/app/teams/ship/integrations/clickup/comments`,
    { comment_on_finish: 'off' },
    aliceCookie,
  );
  expect(off.headers.get('location')).toContain('ok=');

  const started = await call(
    'start_run',
    { team: 'ship', project: 'clickup-demo', clickup_task: 'cu-task-quiet' },
    alice,
  );
  // Reads still work; only the write stopped.
  expect(started.isError, started.text).toBe(false);
  const finished = await call('finish_run', { run_id: started.data.runId }, alice);
  expect(finished.data.trackerComment).toBeUndefined();
  expect(clickupOutbox.comments()).toHaveLength(0);

  const on = await form(
    `${srv.url}/app/teams/ship/integrations/clickup/comments`,
    { comment_on_finish: 'on' },
    aliceCookie,
  );
  expect(on.headers.get('location')).toContain('ok=');
});

/**
 * A mapping is a pointer inside `config`, so deleting a project cannot cascade
 * to it. With one stale mapping left, `clickupForTeam(team)` used to resolve a
 * List belonging to a project nobody can open — a fail-open on the only path
 * that has no project name to check against.
 */
it('refuses a mapping whose STMA project is gone, and offers to remove it', async () => {
  clickupOutbox.clear();
  const page = await (
    await fetch(`${srv.url}/app/teams/ship?tab=integrations`, { headers: aliceCookie })
  ).text();
  const demoId = /option value="([a-f0-9-]+)">clickup-demo<\/option>/.exec(page)?.[1]!;
  expect(demoId).toBeTruthy();

  // A second project, mapped, then deleted out from under the mapping.
  const primer = await call(
    'start_run',
    { team: 'ship', project: 'clickup-gone', task: 'bootstrap' },
    alice,
  );
  await call('finish_run', { run_id: primer.data.runId }, alice);
  const withGone = await (
    await fetch(`${srv.url}/app/teams/ship?tab=integrations`, { headers: aliceCookie })
  ).text();
  const goneId = /option value="([a-f0-9-]+)">clickup-gone<\/option>/.exec(withGone)?.[1]!;
  expect(goneId).toBeTruthy();
  await form(
    `${srv.url}/app/teams/ship/integrations/clickup/binding`,
    { project_id: goneId, list_id: '2200', comment_on_finish: 'on' },
    aliceCookie,
  );
  // Leave exactly one mapping, so the team-wide fallback has something to pick.
  const dropped = await form(
    `${srv.url}/app/teams/ship/integrations/clickup/binding/remove`,
    { project_id: demoId },
    aliceCookie,
  );
  expect(dropped.headers.get('location')).toContain('ok=');
  const onlyGone = await call('list_clickup_tasks', { team: 'ship' }, alice);
  expect(onlyGone.isError, 'one live mapping resolves team-wide').toBe(false);

  await srv.db.delete(projects).where(eq(projects.id, goneId));

  const refused = await call('list_clickup_tasks', { team: 'ship' }, alice);
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain('No ClickUp List is mapped');
  const stale = await (
    await fetch(`${srv.url}/app/teams/ship?tab=integrations`, { headers: aliceCookie })
  ).text();
  expect(stale).toContain('its STMA project is gone');
  expect(stale).toContain('Remove mapping');

  // Removing it is possible without disconnecting the workspace.
  const removed = await form(
    `${srv.url}/app/teams/ship/integrations/clickup/binding/remove`,
    { project_id: goneId },
    aliceCookie,
  );
  expect(removed.headers.get('location')).toContain('ok=');
  const clean = await (
    await fetch(`${srv.url}/app/teams/ship?tab=integrations`, { headers: aliceCookie })
  ).text();
  expect(clean).toContain('no project is mapped yet');
  expect(clean).toContain('Connected to <b>Test workspace</b>');
});

/**
 * Nothing ClickUp touches may put a credential, a task title or a message body
 * into the activity feed, which is rendered and exported as CSV. The feed is
 * read whole here rather than one row at a time: a new write path that starts
 * carrying a body would otherwise pass until somebody thought to look.
 */
it('keeps tokens, task titles and comment bodies out of the activity feed', async () => {
  const feedRes = await fetch(`${srv.url}/app/teams/ship/activity`, { headers: aliceCookie });
  // Proved to have rendered before anything is asserted absent from it: a 404
  // satisfies every `not.toContain` in this test and proves nothing at all.
  expect(feedRes.status).toBe(200);
  const feed = await feedRes.text();
  expect(feed).toContain('Activity');
  expect(feed).not.toContain('pk_test_clickup_oauth');
  expect(feed).not.toContain('Reduce onboarding friction');
  expect(feed).not.toContain('Parcel scanner drops the last digit');
  expect(feed).not.toContain('a finish note that must never reach a page');
  const csvRes = await fetch(`${srv.url}/app/teams/ship/activity.csv`, { headers: aliceCookie });
  expect(csvRes.status).toBe(200);
  const csv = await csvRes.text();
  // The header row as the exporter actually writes it, every cell quoted:
  // asserting the file rendered is what makes the absences below mean anything.
  // (`Response.text()` has already eaten the Excel BOM by the time it is here.)
  expect(csv).toContain('"at","team","project","person","agent","action","detail"');
  expect(csv).not.toContain('pk_test_clickup_oauth');
  expect(csv).not.toContain('Parcel scanner drops the last digit');
});

it('requires an explicit choice when ClickUp authorizes multiple workspaces', async () => {
  clickupOutbox.seed({
    workspaces: [
      { id: '1100', name: 'First workspace' },
      { id: '1200', name: 'Second workspace' },
    ],
  });
  const start = await fetch(`${srv.url}/app/teams/ship/integrations/clickup/start`, {
    headers: aliceCookie,
    redirect: 'manual',
  });
  const authorize = new URL(start.headers.get('location')!);
  const connectCookie = start.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');
  const callback = await fetch(
    `${srv.url}/auth/clickup/callback?state=${encodeURIComponent(authorize.searchParams.get('state')!)}&code=second-code`,
    {
      headers: { cookie: `${aliceCookie.cookie}; ${connectCookie}` },
      redirect: 'manual',
    },
  );
  expect(callback.status).toBe(200);
  const chooser = await callback.text();
  expect(chooser).toContain('Choose one ClickUp workspace');
  expect(chooser).toContain('First workspace');
  expect(chooser).toContain('Second workspace');
  const pendingCookie = callback.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .find((line) => line.startsWith('clickup_pending='));
  expect(pendingCookie).toBeTruthy();

  const chosen = await form(
    `${srv.url}/app/teams/ship/integrations/clickup/workspace`,
    { workspace_id: '1200' },
    { cookie: `${aliceCookie.cookie}; ${pendingCookie}` },
  );
  expect(chosen.headers.get('location')).toContain('Connected');
  const page = await (
    await fetch(`${srv.url}/app/teams/ship?tab=integrations`, { headers: aliceCookie })
  ).text();
  expect(page).toContain('Connected to <b>Second workspace</b>');
  // A different workspace never inherits the old project's numeric List id.
  expect(page).toContain('no project is mapped yet');
});

it('turns an opened issue into a team announcement agents can read', async () => {
  const page = await (await fetch(`${srv.url}/app/teams/ship?tab=integrations`, { headers: aliceCookie })).text();
  const hook = /\/api\/hooks\/github\/([A-Za-z0-9_-]+)/.exec(page)?.[1] ?? '';
  expect(hook, 'inbound hook token').toBeTruthy();

  const openedBody = JSON.stringify({
    action: 'opened',
    issue: { number: 77, title: 'Search returns nothing on empty query', user: { login: 'dana' } },
    repository: { name: 'storefront', full_name: 'acme/storefront' },
    sender: { login: 'dana' },
  });
  const res = await fetch(`${srv.url}/api/hooks/github/${hook}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'issues',
      'x-hub-signature-256': `sha256=${createHmac('sha256', hook).update(openedBody).digest('hex')}`,
    },
    body: openedBody,
  });
  expect(res.status).toBe(200);

  // The inbox lists threads, not bodies — so this is the path an agent really
  // takes: see the channel is unread, then read it.
  const inbox = await call('inbox', {}, bob);
  const channel = (inbox.data.unreadSessions as any[]).find((s) => s.title === 'Announcements');
  expect(channel, 'announcements channel should be unread for bob').toBeTruthy();
  const thread = await call('get_session', { session_id: channel.sessionId }, bob);
  expect(thread.text).toContain('issue #77 opened');
  expect(thread.text).toContain('start_run');

  // Label churn is not news.
  const labeledBody = JSON.stringify({
    action: 'labeled',
    issue: { number: 77 },
    repository: { name: 'x' },
  });
  const ignored = await fetch(`${srv.url}/api/hooks/github/${hook}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'issues',
      'x-hub-signature-256': `sha256=${createHmac('sha256', hook).update(labeledBody).digest('hex')}`,
    },
    body: labeledBody,
  });
  expect(((await ignored.json()) as { ignored?: string }).ignored).toBe('issues.labeled');
});

// ---------------------------------------------------------- personal webhook

it('proves a personal webhook before trusting it, then delivers to it', async () => {
  received.length = 0;
  const bad = await form(
    `${srv.url}/app/notifications/webhook`,
    { action: 'test', webhook_url: 'not-a-url' },
    bobCookie,
  );
  expect(bad.headers.get('location')).toContain('err=');

  const tested = await form(
    `${srv.url}/app/notifications/webhook`,
    { action: 'test', webhook_url: receiverUrl },
    bobCookie,
  );
  expect(tested.headers.get('location')).toContain('ok=');
  expect(received).toHaveLength(1);
  expect(JSON.stringify(received[0])).toContain('bob');
  // A successful test also saves it — proving a URL and then losing it is a trap.
  const prefsPage = await (
    await fetch(`${srv.url}/app/notifications`, { headers: bobCookie })
  ).text();
  expect(prefsPage).toContain(receiverUrl);

  // Drain whatever this suite queued earlier (bob joining the team), so the
  // next assertion is about the reply and nothing else.
  await flushNotificationsOnce(srv.db, env);
  received.length = 0;

  // Now the real thing: alice's agent replies in a thread bob is part of.
  const opened = await call(
    'open_session',
    { title: 'webhook delivery', body: 'does chat get it too?', team: 'ship' },
    bob,
  );
  const sessionId = opened.data?.sessionId ?? /"sessionId":"([^"]+)"/.exec(opened.text)?.[1];
  expect(sessionId).toBeTruthy();
  const replied = await call(
    'post_message',
    { session_id: sessionId, body: 'yes, it should arrive in chat', kind: 'answer' },
    alice,
  );
  expect(replied.isError, replied.text).toBe(false);

  const delivered = await flushNotificationsOnce(srv.db, env);
  expect(delivered).toBe(1);
  expect(received).toHaveLength(1);
  const line = JSON.stringify(received[0]);
  expect(line).toContain('webhook delivery');
  expect(line).toContain('/app/sessions/');

  // Turning the switch off silences both routes, not just the email.
  await form(`${srv.url}/app/notifications`, { session_resolved: 'on' }, bobCookie);
  received.length = 0;
  await call('post_message', { session_id: sessionId, body: 'and again', kind: 'answer' }, alice);
  expect(await flushNotificationsOnce(srv.db, env)).toBe(0);
  expect(received).toHaveLength(0);

  // Removing it leaves the switches alone.
  const removed = await form(
    `${srv.url}/app/notifications/webhook`,
    { action: 'remove' },
    bobCookie,
  );
  expect(removed.headers.get('location')).toContain('ok=');
  const after = await (await fetch(`${srv.url}/app/notifications`, { headers: bobCookie })).text();
  expect(after).not.toContain(receiverUrl);
});
