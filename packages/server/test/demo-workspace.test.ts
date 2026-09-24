/**
 * The demo workspace (`domain/demoWorkspace.ts`), read the way a reviewer reads it.
 *
 * The operator builds it from the account's admin page; then the reviewer
 * connects the Claude app to that account and asks the listing's example
 * prompts. So the assertions here are made through the tools those prompts
 * call, over the reviewer's own OAuth connection, not through the tables: a
 * demo whose rows exist and whose tools answer "nothing yet" fails a review
 * just the same.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentInstallations, memberships, teams, users } from '../src/db/schema';
import { DEMO_AGENTS, demoContentRuleParses } from '../src/domain/demoWorkspace';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

let srv: StartedServer;
let dataDir: string;
let rpcId = 1;

const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const verifier = 'demo-workspace-reviewer-verifier-with-enough-entropy';
const challenge = createHash('sha256').update(verifier).digest('base64url');

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

async function devLogin(username: string): Promise<Jar> {
  const cookies = jar();
  const response = await form(cookies, '/auth/dev', { username });
  expect(response.status).toBe(302);
  cookies.store(response);
  return cookies;
}

function form(cookies: Jar, pathname: string, body: Record<string, string>) {
  return fetch(`${srv.url}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...cookies.header() },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });
}

const where = (response: Response) => decodeURIComponent(response.headers.get('location') ?? '');

async function rpc(accessToken: string, method: string, params: Record<string, unknown> = {}) {
  const response = await fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });
  return (await response.json()) as Record<string, any>;
}

/** One tool call from the reviewer's Claude, answered as the text Claude reads. */
async function ask(accessToken: string, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const body = await rpc(accessToken, 'tools/call', { name, arguments: args });
  expect(body.error, `${name}: ${JSON.stringify(body.error)}`).toBeUndefined();
  const text = body.result.content[0].text as string;
  expect(body.result.isError, `${name}: ${text}`).toBeFalsy();
  return text;
}

/** The reviewer's side: the Claude app connected to the demo account, Personal, as Claude proposes. */
async function connectClaude(cookies: Jar): Promise<string> {
  const registered = await fetch(`${srv.url}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CLAUDE_CALLBACK] }),
  });
  expect(registered.status).toBe(201);
  const { client_id: clientId } = (await registered.json()) as { client_id: string };
  const request = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'review',
    scope: 'stma',
    resource: `${srv.url}/mcp`,
  };
  const allowed = await form(cookies, '/oauth/authorize', { ...request, decision: 'allow', name: 'claude', access: 'personal' });
  expect(allowed.status).toBe(302);
  const code = new URL(allowed.headers.get('location')!).searchParams.get('code')!;
  const token = await fetch(`${srv.url}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: CLAUDE_CALLBACK,
      code_verifier: verifier,
      resource: `${srv.url}/mcp`,
    }),
  });
  expect(token.status).toBe(200);
  const { access_token: accessToken } = (await token.json()) as { access_token: string };
  const init = await rpc(accessToken, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'claude-ai', version: '1.0.0' },
  });
  expect(init.result?.serverInfo?.name).toBe('stma');
  return accessToken;
}

beforeAll(async () => {
  process.env.ADMIN_USERNAMES = 'ops';
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-demo-workspace-'));
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
}, 120_000);

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the demo workspace', () => {
  it('publishes a content rule the guard can read', () => {
    expect(demoContentRuleParses()).toBe(true);
  });

  it('is built by an operator and answers the listing prompts through the reviewer\'s Claude', async () => {
    const reviewer = await devLogin('demo-reviewer');
    const [account] = await srv.db.select().from(users).where(eq(users.username, 'demo-reviewer'));
    const ops = await devLogin('ops');

    const page = await (await fetch(`${srv.url}/admin/users/${account!.id}`, { headers: ops.header() })).text();
    expect(page).toContain('Build the demo workspace');
    const built = await form(ops, `/admin/users/${account!.id}/demo-workspace`, {});
    expect(built.status).toBe(302);
    expect(where(built)).toContain('Built Parcel Desk');

    const [team] = await srv.db
      .select({ id: teams.id, slug: teams.slug })
      .from(teams)
      .innerJoin(memberships, eq(memberships.teamId, teams.id))
      .where(and(eq(memberships.userId, account!.id), eq(memberships.role, 'owner')));
    expect(team).toBeTruthy();
    const installations = await srv.db
      .select()
      .from(agentInstallations)
      .where(eq(agentInstallations.userId, account!.id));
    expect(installations.map((row) => row.name).sort()).toEqual(DEMO_AGENTS.map((agent) => agent.name).sort());
    expect(installations.every((row) => !row.revokedAt)).toBe(true);

    // What the owner sees in the console: both runs confirmed the rules they
    // were served, and the Mac is the baseline preflight measures against.
    const projectPage = await (
      await fetch(`${srv.url}/app/teams/${team!.slug}/projects/parcel-desk`, { headers: reviewer.header() })
    ).text();
    expect(projectPage).toContain('2 of 2 recent runs confirmed it');
    expect(projectPage).not.toContain('No baseline recorded');
    expect(projectPage).toContain('PD-31 Add CSV export to the parcel list');

    const claude = await connectClaude(reviewer);

    // "Who is on my team and which agents do they run?"
    const teammates = await ask(claude, 'list_teammates', { team: team!.slug });
    for (const agent of DEMO_AGENTS) expect(teammates).toContain(agent.name);

    // "What is waiting for my agents?"
    const inbox = await ask(claude, 'inbox', { team: team!.slug });
    expect(inbox).toContain('PD-31 Add CSV export to the parcel list');
    expect(inbox).toContain('PD-27');
    expect(inbox).toContain('Should the CSV export include cancelled parcels?');
    expect(inbox).not.toContain('PD-18');

    // "Show me the rules our agents follow."
    const policy = await ask(claude, 'get_policy', { team: team!.slug, project: 'parcel-desk' });
    expect(policy).toContain('Comic Sans');
    expect(policy).toContain('LABEL_PRINTER_PORT');

    // "Compare my two machines."
    const compared = await ask(claude, 'compare_env', { team: team!.slug, device: 'macbook', their_device: 'desktop' });
    expect(compared).toContain('20.11.1');
    expect(compared).toContain('22.4.0');
    expect(compared).toContain('LABEL_PRINTER_PORT');

    // "Have we seen the label printer time out before?"
    const past = await ask(claude, 'search_past_issues', { team: team!.slug, query: 'label printer' });
    expect(past).toContain('Label printer times out on Windows');
    expect(past).toContain('COM3');

    // "How do we deploy?"
    const knowledge = await ask(claude, 'search_knowledge', { team: team!.slug, query: 'deploy' });
    expect(knowledge).toContain('Deploying parcel-desk');

    // "Give PD-40 to my Claude Code on the MacBook."
    const assigned = await ask(claude, 'assign_work', {
      team: team!.slug,
      project: 'parcel-desk',
      to_agent: 'claude-code',
      device: 'macbook',
      task: 'PD-40 Show the carrier logo on each parcel row',
      brief: 'Each parcel row should show its carrier logo left of the tracking number, from public/carriers/.',
    });
    expect(assigned).toContain('claude-code');
  }, 120_000);

  /**
   * The portal asks the submitter to confirm every tool was tried, and a
   * verified review calls each one: "every tool must return a successful
   * response when called with valid parameters". Five cannot succeed from a
   * chat on this demo by design, and each is held to answering with what is
   * missing rather than a generic error: two read trackers the demo has not
   * connected, two take ids only the console issues, and work named to another
   * agent is that agent's to accept.
   */
  it('answers every tool from the reviewer\'s Claude, or says what is missing', async () => {
    const reviewer = await devLogin('demo-tools');
    const [account] = await srv.db.select().from(users).where(eq(users.username, 'demo-tools'));
    const ops = await devLogin('ops');
    expect(where(await form(ops, `/admin/users/${account!.id}/demo-workspace`, {}))).toContain('Built Parcel Desk');
    const [team] = await srv.db
      .select({ slug: teams.slug })
      .from(teams)
      .innerJoin(memberships, eq(memberships.teamId, teams.id))
      .where(eq(memberships.userId, account!.id));
    const t = team!.slug;
    const claude = await connectClaude(reviewer);
    const listed = await rpc(claude, 'tools/list');
    const names = (listed.result.tools as Array<{ name: string }>).map((tool) => tool.name).sort();

    const answered = new Map<string, 'answered' | 'refused'>();
    const call = async (name: string, args: Record<string, unknown>) => {
      const body = await rpc(claude, 'tools/call', { name, arguments: args });
      const text = String(body.result?.content?.[0]?.text ?? body.error?.message ?? '');
      return { ok: !body.error && !body.result?.isError, text };
    };
    const works = async (name: string, args: Record<string, unknown> = {}) => {
      const answer = await call(name, args);
      expect(answer.ok, `${name}: ${answer.text.slice(0, 400)}`).toBe(true);
      answered.set(name, 'answered');
      try {
        return JSON.parse(answer.text) as Record<string, any>;
      } catch {
        return { text: answer.text } as Record<string, any>;
      }
    };
    const refuses = async (name: string, args: Record<string, unknown>, because: RegExp) => {
      const answer = await call(name, args);
      expect(answer.ok, `${name} answered: ${answer.text.slice(0, 200)}`).toBe(false);
      expect(answer.text, name).toMatch(because);
      expect(answer.text.length, `${name}: "${answer.text}"`).toBeGreaterThan(40);
      answered.set(name, 'refused');
    };

    await works('whoami');
    await works('list_teammates', { team: t });
    await works('list_projects', { team: t });
    await works('get_snapshot_checklist');
    await works('get_snapshot', { team: t, device: 'macbook' });
    await works('compare_env', { team: t, device: 'macbook', their_device: 'desktop' });
    await works('onboard_repo', { team: t, repo: 'parcel-desk' });
    const inbox = await works('inbox', { team: t });
    await works('list_active_agents', { team: t });
    await works('get_policy', { team: t, project: 'parcel-desk' });
    await works('get_workflow', { team: t, project: 'parcel-desk' });
    await works('search_past_issues', { team: t, query: 'label printer' });
    await works('list_sessions', { team: t, status: 'resolved' });
    const pending = (inbox.pendingHandoffs ?? []) as Array<{ sessionId: string; title?: string; task?: string }>;
    const handedOver = pending.find((handoff) => JSON.stringify(handoff).includes('PD-27'));
    expect(handedOver, JSON.stringify(pending).slice(0, 300)).toBeTruthy();
    await works('get_session', { session_id: handedOver!.sessionId });

    const found = await works('search_knowledge', { team: t, query: 'deploy' });
    const item = (found.results ?? found.items ?? [])[0] as { id: string } | undefined;
    expect(item, JSON.stringify(found).slice(0, 300)).toBeTruthy();
    await works('get_knowledge', { team: t, id: item!.id });
    const context = await works('get_knowledge_context', { team: t, project: 'parcel-desk', query: 'deploy' });
    await works('report_knowledge_receipt', {
      context_id: context.contextId ?? context.context?.id,
      manifest_hash: context.manifestHash ?? context.context?.manifestHash,
    });
    await works('propose_knowledge', {
      team: t,
      stable_key: 'notes/review-walkthrough',
      kind: 'reference',
      title: 'Review walkthrough',
      body: 'Proposed from Claude during a review; an owner publishes it or not.',
      audience: 'workspace_members',
    });

    const snapshot = { os: { platform: 'darwin', arch: 'arm64' }, runtimes: { node: '22.4.0' }, envVarNames: ['DATABASE_URL'] };
    await works('push_snapshot', { team: t, device: 'review-laptop', repo: 'parcel-desk', snapshot });
    await works('check_environment', { team: t, project: 'parcel-desk', snapshot });

    const run = await works('start_run', {
      team: t,
      project: 'parcel-desk',
      request_id: 'e4b1c2d3-0040-4a5b-8c6d-0e1f2a3b4c5d',
      repository_identity: 'https://git.example.com/acme/parcel-desk.git',
      task: 'Review walkthrough',
      intent: 'Try the run lifecycle from Claude.',
      scope: [{ type: 'path', key: 'README.md', access: 'read' }],
    });
    await works('update_run', { run_id: run.runId, scope: [{ type: 'path', key: 'docs/review.md', access: 'write' }] });
    await works('get_evidence', { run_id: run.runId });
    await works('finish_run', { run_id: run.runId, status: 'completed', note: 'Walkthrough done.' });

    const thread = await works('open_session', { team: t, title: 'Review question', body: 'Is the CSV export on the roadmap for this sprint?' });
    await works('post_message', { session_id: thread.sessionId, body: 'Yes, PD-31 is assigned to cursor on the thinkpad.' });
    await works('resolve_session', { session_id: thread.sessionId, root_cause: 'A question, not a defect.', fix: 'Answered in the thread.' });
    await works('announce', { team: t, body: 'Release 1.8 goes out at 16:00 UTC.' });
    await works('create_invite', { team: t });
    await works('assign_work', {
      team: t,
      project: 'parcel-desk',
      request_id: 'e4b1c2d3-1040-4a5b-8c6d-0e1f2a3b4c5d',
      to_agent: 'claude-code',
      device: 'macbook',
      task: 'PD-40 Show the carrier logo on each parcel row',
      brief: 'Each parcel row shows its carrier logo left of the tracking number, from public/carriers/.',
    });
    await works('handoff_work', {
      team: t,
      project: 'parcel-desk',
      request_id: 'e4b1c2d3-2040-4a5b-8c6d-0e1f2a3b4c5d',
      summary: 'A plan with no code: before 1.8 ships, check the carrier ETA fix against the live carrier sandbox.',
      next_steps: ['Run the carrier sandbox checks', 'Report the result in the release thread'],
      to_agent: 'codex',
      device: 'desktop',
    });

    await refuses('list_issues', { team: t }, /GitHub/);
    await refuses('list_clickup_tasks', { team: t, project: 'parcel-desk' }, /ClickUp/);
    await refuses('launch_check', { launch_id: 'e4b1c2d3-3040-4a5b-8c6d-0e1f2a3b4c5d', action: 'status' }, /launch/i);
    await refuses(
      'record_delivery_receipt',
      {
        receipt: {
          schemaVersion: 2,
          setupId: 'a'.repeat(64),
          flowHash: 'b'.repeat(64),
          policyHash: null,
          status: 'planned',
          commitSha: null,
          repositoryId: null,
          repositoryWrites: false,
          providerWrites: false,
        },
      },
      /setup/i,
    );
    await refuses('update_handoff', { session_id: handedOver!.sessionId, action: 'accept' }, /claude-code/);

    expect([...answered.keys()].sort()).toEqual(names);
    expect([...answered.values()].filter((value) => value === 'refused')).toHaveLength(5);
  }, 180_000);

  it('is only an account\'s first workspace, and only an operator builds it', async () => {
    await devLogin('demo-twice');
    const [account] = await srv.db.select().from(users).where(eq(users.username, 'demo-twice'));
    const ops = await devLogin('ops');
    expect(where(await form(ops, `/admin/users/${account!.id}/demo-workspace`, {}))).toContain('Built Parcel Desk');
    const again = await form(ops, `/admin/users/${account!.id}/demo-workspace`, {});
    expect(where(again)).toContain('already belongs to one');
    const owned = await srv.db.select().from(memberships).where(eq(memberships.userId, account!.id));
    expect(owned).toHaveLength(1);

    const stranger = await devLogin('demo-stranger');
    const [target] = await srv.db.select().from(users).where(eq(users.username, 'demo-stranger'));
    expect((await form(stranger, `/admin/users/${target!.id}/demo-workspace`, {})).status).toBe(404);
  }, 120_000);
});
