import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentEnrollments, agentInstallations, launchAttempts, tokens, teams, users } from '../src/db/schema';
import { assignableAgents } from '../src/domain/assignments';
import { loadEnv } from '../src/env';
import {
  BOTH_DOORS,
  CLAUDE_APP_BOUNDARY,
  CLAUDE_APP_SUMMARY,
  CODING_AGENT_SUMMARY,
  CONSOLE_NOT_SECOND_AGENT,
  claudeConnectorLink,
  entryAnchor,
  parseEntry,
} from '../src/lib/entry';
import { startServer, type StartedServer } from '../src/server';
import {
  CLAUDE_CALLBACK,
  LOOPBACK_CALLBACK,
  authorizeParams,
  connectOAuth,
  devLogin,
  getPage,
  jar,
  pageText,
  postForm,
  registerClient,
  rpc,
  type Jar,
} from './helpers/oauthClient';

/**
 * Two doors into STMA (T02, 2026-10-22). A Claude app console is Claude on the
 * web, desktop or phone using STMA as a connector; a coding agent in a checkout
 * is Claude Code, Codex or Cursor connected to a project. One account can use
 * both, the page says which is which, a door chosen before sign-in survives
 * signup and creating a first workspace, and the first test between two agents
 * cannot be taken for proof about a checkout when a console was one of them.
 */

let srv: StartedServer;
let dataDir: string;
let rpcId = 1;

const EM_DASH = /—|&mdash;|&#8212;/;
const decode = (html: string) => html.replaceAll('&amp;', '&');
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
/** The row of the connections table (the one with a status block), not the Claude app section's. */
const rowOf = (html: string, name: string) =>
  html.split('<tr').find((part) => new RegExp(`class="name">[^<]*${name}`).test(part) && part.includes('class="cstate"')) ?? '';

async function tool(accessToken: string, name: string, args: Record<string, unknown>) {
  const answer = await rpc(srv.url, accessToken, 'tools/call', { name, arguments: args }, rpcId++);
  const result = answer.body.result as { content?: { text: string }[]; isError?: boolean } | undefined;
  const raw = result?.content?.[0]?.text ?? '';
  let data: any = null;
  try {
    data = JSON.parse(raw);
  } catch {
    // an error sentence
  }
  return { status: answer.status, isError: Boolean(result?.isError) || !result, text: raw, data };
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-two-doors-'));
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
}, 120_000);

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the words', () => {
  it('are one set of constants with no em dash, and the closed entry set drops everything else', () => {
    for (const sentence of [CLAUDE_APP_SUMMARY, CLAUDE_APP_BOUNDARY, CODING_AGENT_SUMMARY, CONSOLE_NOT_SECOND_AGENT, BOTH_DOORS]) {
      expect(sentence).not.toMatch(EM_DASH);
    }
    expect(parseEntry('claude-app')).toBe('claude-app');
    expect(parseEntry('coding-client')).toBe('coding-client');
    for (const other of ['', 'Claude-App', '<script>', 'claude-app ', undefined, null, 7, ['claude-app']]) {
      expect(parseEntry(other)).toBeUndefined();
    }
    expect(entryAnchor('claude-app')).toBe('#claude-app');
    expect(entryAnchor('coding-client')).toBe('#connect');
    const link = new URL(claudeConnectorLink('https://stma.example'));
    expect(link.origin + link.pathname).toBe('https://claude.ai/customize/connectors');
    expect(link.searchParams.get('modal')).toBe('add-custom-connector');
    expect(link.searchParams.get('connectorUrl')).toBe('https://stma.example/mcp');
  });
});

describe('both doors are named where a person decides', () => {
  it('on the workspace page, the guide and the consent page, in the same words', async () => {
    const owner = await devLogin(srv.url, 'td-words');
    expect((await postForm(srv.url, owner, '/app/teams', { name: 'Door Words' })).status).toBe(302);
    const page = await pageText(srv.url, owner, '/app/teams/door-words/connections');
    const doors = page.slice(page.indexOf('id="two-ways-in"'), page.indexOf('id="connect"'));
    expect(doors.length).toBeGreaterThan(500);
    expect(doors).toContain('Claude app console');
    expect(doors).toContain('coding agent in a checkout');
    expect(doors).toContain('not an agent in a checkout');
    expect(doors).toContain('no hooks');
    expect(doors).toContain(`href="${claudeConnectorLink(srv.url).replaceAll('&', '&amp;')}"`);
    expect(doors).not.toMatch(EM_DASH);
    expect(page).toContain('id="claude-app"');
    expect(page).toContain('<a href="#claude-app">Claude app</a>');
    // The section lists no Claude app connection of this person's yet, and says what revoking does.
    expect(text(page)).toContain('No Claude app connection of yours can work here yet.');

    const docs = await (await fetch(`${srv.url}/docs`)).text();
    expect(docs).toContain('Two ways in: the Claude app and a coding agent');
    expect(docs).toContain('Claude app console');
    expect(docs).toContain('coding agent in a checkout');
    expect(text(docs)).toContain('not an agent in a checkout');
    expect(docs).toContain('id="connection-status"');
    expect(text(docs)).toContain(CONSOLE_NOT_SECOND_AGENT);
    expect(docs).toContain(`href="${claudeConnectorLink(srv.url).replaceAll('&', '&amp;')}"`);

    const clientId = await registerClient(srv.url, 'Claude', CLAUDE_CALLBACK);
    const consent = await (
      await fetch(`${srv.url}/oauth/authorize?${new URLSearchParams(authorizeParams(srv.url, clientId, CLAUDE_CALLBACK, 'words'))}`, {
        headers: owner.header(),
      })
    ).text();
    expect(consent).toContain('This is the Claude app console');
    expect(text(consent)).toContain('not an agent in a checkout');
    expect(consent).toContain('value="claude-app"');
    expect(consent).not.toContain('id="oauth-device"');

    // The first-test card says the console is not its second agent, signed in and out.
    expect(text(page)).toContain(CONSOLE_NOT_SECOND_AGENT);
  });
});

describe('a door chosen before signing in survives signup and the first workspace', () => {
  it('signed out, the door becomes a sign-in with a way back; anything else is dropped', async () => {
    const out = await fetch(`${srv.url}/app/tokens?entry=coding-client`, { redirect: 'manual' });
    expect(out.status).toBe(302);
    expect(out.headers.get('location')).toBe('/login?next=%2Fapp%2Ftokens%3Fentry%3Dcoding-client');
    const claude = await fetch(`${srv.url}/app/tokens?entry=claude-app`, { redirect: 'manual' });
    expect(claude.headers.get('location')).toBe('/login?next=%2Fapp%2Ftokens%3Fentry%3Dclaude-app');
    for (const value of ['unknown', '%3Cscript%3E', 'https%3A%2F%2Fevil.example', '%2Fadmin']) {
      const other = await fetch(`${srv.url}/app/tokens?entry=${value}`, { redirect: 'manual' });
      expect(other.headers.get('location')).toBe('/login?next=%2Fapp%2Ftokens');
    }
  });

  it('signing up or signing in with the door in the address lands on it, and a made-up next is dropped', async () => {
    const door = '/app/tokens?entry=claude-app';
    const page = await (await fetch(`${srv.url}/signup?next=${encodeURIComponent(door)}`)).text();
    expect(decode(page)).toContain(`name="next" value="${door}"`);
    expect(decode(await (await fetch(`${srv.url}/login?next=${encodeURIComponent(door)}`)).text())).toContain(
      `name="next" value="${door}"`,
    );

    const form = (path: string, body: Record<string, string>) =>
      fetch(`${srv.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body),
        redirect: 'manual',
      });
    const signed = await form('/auth/local/signup', { email: 'doors-new@example.com', password: 'password-1234', next: door });
    expect(signed.status).toBe(302);
    expect(signed.headers.get('location')).toBe(door);
    const cookies = jar();
    cookies.store(signed);

    // Signed in with no workspace, the door still carries through to the first workspace.
    const chooser = await getPage(srv.url, cookies, door);
    expect(chooser.status).toBe(200);
    expect(await chooser.text()).toContain('<input type="hidden" name="entry" value="claude-app"/>');
    const made = await postForm(srv.url, cookies, '/app/teams', { name: 'Signup Doors', entry: 'claude-app' });
    expect(made.headers.get('location')).toBe('/app/teams/signup-doors/connections#claude-app');

    // The same door through an ordinary sign-in.
    const again = await form('/auth/local/login', { email: 'doors-new@example.com', password: 'password-1234', next: door });
    expect(again.status).toBe(302);
    expect(again.headers.get('location')).toBe(door);

    // A next that is not a local path never becomes the destination.
    const elsewhere = await form('/auth/local/signup', {
      email: 'doors-elsewhere@example.com',
      password: 'password-1234',
      next: 'https://evil.example/app/tokens?entry=claude-app',
    });
    expect(elsewhere.status).toBe(302);
    expect(elsewhere.headers.get('location')).toBe('/app');
  });

  it('with no workspace the form carries the door, and the first workspace ends on that section', async () => {
    const newcomer = await devLogin(srv.url, 'td-newcomer');
    const chooser = await getPage(srv.url, newcomer, '/app/tokens?entry=claude-app');
    expect(chooser.status).toBe(200);
    const html = await chooser.text();
    expect(html).toContain('Create a workspace first');
    expect(html).toContain('<input type="hidden" name="entry" value="claude-app"/>');
    expect(html).toContain('action="/app/teams"');

    // The workspace list says the same, when asked for the door.
    const list = await pageText(srv.url, newcomer, '/app?entry=coding-client');
    expect(list).toContain('<input type="hidden" name="entry" value="coding-client"/>');
    expect(text(list)).toContain('Claude app console');
    expect(text(list)).toContain('coding agent in a checkout');
    // The empty list offers both doors as actions: Claude's own connector dialog, and a
    // new workspace to connect a coding agent from.
    expect(list).toContain('id="two-ways-in"');
    expect(decode(list)).toContain(`href="${claudeConnectorLink(srv.url)}"`);
    expect(list).toContain('data-open-dialog="#new-team"');

    const made = await postForm(srv.url, newcomer, '/app/teams', { name: 'Newcomer Doors', entry: 'claude-app' });
    expect(made.status).toBe(302);
    expect(made.headers.get('location')).toBe('/app/teams/newcomer-doors/connections#claude-app');
    const landed = await pageText(srv.url, newcomer, '/app/teams/newcomer-doors/connections');
    expect(landed).toContain('id="claude-app"');
  });

  it('with the other door the section is #connect, and a value that is not a door changes nothing', async () => {
    const other = await devLogin(srv.url, 'td-other-door');
    const made = await postForm(srv.url, other, '/app/teams', { name: 'Other Door', entry: 'coding-client' });
    expect(made.headers.get('location')).toBe('/app/teams/other-door/connections#connect');
    for (const entry of ['<script>alert(1)</script>', 'https://evil.example/', '/admin', 'claude-app/../x']) {
      const plain = await postForm(srv.url, other, '/app/teams', { name: `Plain ${entry.length}`, entry });
      expect(plain.status).toBe(302);
      expect(plain.headers.get('location')).toMatch(/^\/app\/teams\/plain-\d+$/);
    }
    // The echo is never reflected.
    const probe = await (await fetch(`${srv.url}/app/tokens?entry=%3Cscript%3Ealert(1)%3C/script%3E`, { headers: other.header() })).text();
    expect(probe).not.toContain('<script>alert(1)');
  });

  it('a person with one workspace is taken to its page at the door they asked for', async () => {
    const solo = await devLogin(srv.url, 'td-solo');
    expect((await postForm(srv.url, solo, '/app/teams', { name: 'Solo Doors' })).status).toBe(302);
    const claude = await getPage(srv.url, solo, '/app/tokens?entry=claude-app');
    expect(claude.status).toBe(303);
    expect(claude.headers.get('location')).toBe('/app/teams/solo-doors/connections#claude-app');
    const coding = await getPage(srv.url, solo, '/app/tokens?entry=coding-client');
    expect(coding.headers.get('location')).toBe('/app/teams/solo-doors/connections#connect');
    const none = await getPage(srv.url, solo, '/app/tokens?entry=nonsense');
    expect(none.headers.get('location')).toBe('/app/teams/solo-doors/connections');
    const named = await getPage(srv.url, solo, '/app/tokens?team=solo-doors&entry=claude-app');
    expect(named.headers.get('location')).toBe('/app/teams/solo-doors/connections#claude-app');
    // From the workspace list, with a workspace already, the same door.
    const list = await getPage(srv.url, solo, '/app?entry=coding-client');
    expect(list.status).toBe(303);
    expect(list.headers.get('location')).toBe('/app/tokens?entry=coding-client');
  });

  it('with several workspaces the person chooses, and the door rides on each link', async () => {
    const many = await devLogin(srv.url, 'td-many');
    for (const name of ['Many Doors One', 'Many Doors Two']) {
      expect((await postForm(srv.url, many, '/app/teams', { name })).status).toBe(302);
    }
    const page = await getPage(srv.url, many, '/app/tokens?entry=claude-app');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('href="/app/teams/many-doors-one/connections#claude-app"');
    expect(html).toContain('href="/app/teams/many-doors-two/connections#claude-app"');
    const coding = await (await getPage(srv.url, many, '/app/tokens?entry=coding-client')).text();
    expect(coding).toContain('href="/app/teams/many-doors-two/connections#connect"');
    const bare = await (await getPage(srv.url, many, '/app/tokens')).text();
    expect(bare).toContain('href="/app/teams/many-doors-one/connections"');
  });

  it('the OAuth return still wins, and no other next address is honoured', async () => {
    const maker = await devLogin(srv.url, 'td-next');
    const oauth = '/oauth/authorize?response_type=code&client_id=x';
    const first = await postForm(srv.url, maker, '/app/teams', { name: 'Next One', entry: 'claude-app', next: oauth });
    expect(first.headers.get('location')).toBe(oauth);
    const refused = ['https://evil.example/oauth/authorize?x=1', '//evil.example/oauth/authorize?x=1', '/app/x', '/admin'];
    for (const [index, next] of refused.entries()) {
      const made = await postForm(srv.url, maker, '/app/teams', { name: `Next ${index}`, entry: 'claude-app', next });
      expect(made.headers.get('location')).toMatch(/^\/app\/teams\/next-\d+\/connections#claude-app$/);
    }
  });

  it('a rejected workspace comes back with the door still on the form', async () => {
    const retry = await devLogin(srv.url, 'td-retry');
    const refused = await postForm(srv.url, retry, '/app/teams', { name: '', entry: 'coding-client' });
    expect(refused.status).toBe(302);
    const back = refused.headers.get('location')!;
    expect(new URL(back, srv.url).searchParams.get('entry')).toBe('coding-client');
    const html = await pageText(srv.url, retry, back);
    expect(html).toContain('<input type="hidden" name="entry" value="coding-client"/>');
  });
});

describe('one account, both doors', () => {
  let owner: Jar;
  let teamId: string;
  let ownerId: string;
  let consoleToken = '';
  let agentOne = '';
  let agentTwo = '';

  const SLUG = '/app/teams/doors-both';

  beforeAll(async () => {
    owner = await devLogin(srv.url, 'td-both');
    expect((await postForm(srv.url, owner, '/app/teams', { name: 'Doors Both' })).status).toBe(302);
    const [team] = await srv.db.select().from(teams).where(eq(teams.slug, 'doors-both'));
    teamId = team!.id;
    ownerId = team!.createdBy!;
    const app = await connectOAuth(srv.url, owner, {
      clientName: 'Claude',
      callback: CLAUDE_CALLBACK,
      state: 'app',
      fields: { name: 'claude-app', access: 'personal' },
    });
    consoleToken = app.accessToken;
    const one = await connectOAuth(srv.url, owner, {
      clientName: 'Claude Code (stma-doors-one)',
      callback: LOOPBACK_CALLBACK,
      state: 'one',
      fields: { name: 'door-agent-one', device: 'desk', access: `team:${teamId}` },
    });
    agentOne = one.accessToken;
    const two = await connectOAuth(srv.url, owner, {
      clientName: 'Codex',
      callback: LOOPBACK_CALLBACK,
      state: 'two',
      fields: { name: 'door-agent-two', device: 'laptop', access: `team:${teamId}` },
    });
    agentTwo = two.accessToken;
  }, 120_000);

  it('is one account with several installations, labelled by what each is', async () => {
    const installations = await srv.db.select().from(agentInstallations).where(eq(agentInstallations.userId, ownerId));
    expect(installations.map((row) => row.clientType).sort()).toEqual(['claude-app', 'claude-code', 'codex']);
    expect((await srv.db.select().from(users).where(eq(users.id, ownerId))).length).toBe(1);

    const page = await pageText(srv.url, owner, `${SLUG}/connections`);
    expect(rowOf(page, 'claude-app')).toContain('Claude app console');
    expect(rowOf(page, 'claude-app')).not.toContain('<dt>Local adapter</dt>');
    expect(rowOf(page, 'claude-app')).not.toContain('<dt>Task</dt>');
    expect(text(rowOf(page, 'claude-app'))).toContain('This is your console');
    expect(rowOf(page, 'door-agent-one')).toContain('Coding agent');
    expect(rowOf(page, 'door-agent-one')).toContain('<dt>Local adapter</dt>');
    expect(text(rowOf(page, 'door-agent-one'))).toContain('authorized');
    // The Claude app section lists the console with its reach and a revoke that says so.
    const section = page.slice(page.indexOf('id="claude-app"'), page.indexOf('id="connect"'));
    expect(section).toContain('Every workspace you are in');
    expect(section).toContain('so it stops everywhere');

    // Only an agent can be given work.
    const names = (await assignableAgents(srv.db, teamId)).map((agent) => agent.name);
    expect(names).toEqual(expect.arrayContaining(['door-agent-one', 'door-agent-two']));
    expect(names).not.toContain('claude-app');
  });

  it('lets the console take part in the first test, and says on the page that it proves less', async () => {
    const started = await postForm(srv.url, owner, '/app/launches', { team: 'doors-both', intent: 'my_agents' });
    const launchId = new URL(started.headers.get('location')!, srv.url).searchParams.get('launch')!;
    // The directory reviewer path: a Claude app connection sends and an agent replies.
    const sent = await tool(consoleToken, 'launch_check', { launch_id: launchId, action: 'send' });
    expect(sent.isError, sent.text).toBe(false);
    const replied = await tool(agentOne, 'launch_check', { launch_id: launchId, action: 'reply' });
    expect(replied.isError, replied.text).toBe(false);

    const page = await pageText(srv.url, owner, `${SLUG}/connections?launch=${launchId}`);
    const card = text(page.slice(page.indexOf('id="launch"'), page.indexOf('id="connections"')));
    expect(card).toContain('The exchange included the Claude app console');
    expect(card).toContain('This exchange included the Claude app console. It proves STMA reached it, not that a coding agent works in a checkout. Run the test with two coding agents.');
    expect(card).not.toContain('Your agents exchanged a message');
    expect(card).toContain('Sender · Claude app console');
    expect(card).toContain('Reply · coding agent');
    expect(text(page)).toContain('exchange confirmed (console included)');
  });

  it('shows no warning when two coding agents exchange, and links the handoff that completed the test', async () => {
    const started = await postForm(srv.url, owner, '/app/launches', {
      team: 'doors-both',
      intent: 'my_agents',
      fresh: 'yes',
    });
    const launchId = new URL(started.headers.get('location')!, srv.url).searchParams.get('launch')!;
    expect((await tool(agentOne, 'launch_check', { launch_id: launchId, action: 'send' })).isError).toBe(false);
    expect((await tool(agentTwo, 'launch_check', { launch_id: launchId, action: 'reply' })).isError).toBe(false);
    const confirmed = text(await pageText(srv.url, owner, `${SLUG}/connections?launch=${launchId}`));
    expect(confirmed).toContain('Your agents exchanged a message');
    expect(confirmed).not.toContain('This exchange included the Claude app console');
    expect(confirmed).not.toContain('(console included)');
    expect(confirmed).not.toContain('Open the completed handoff');
    // Until a real task is done, the card points at where one is assigned.
    expect(confirmed).toContain('assign work to a coding agent');

    const assigned = await tool(agentOne, 'assign_work', {
      request_id: randomUUID(),
      to_agent: 'door-agent-two',
      task: 'PD-41 Door check',
      brief: 'Add one line to the changelog saying the doors page exists. Nothing else.',
      team: 'doors-both',
    });
    expect(assigned.isError, assigned.text).toBe(false);
    const session = assigned.data.sessionId as string;
    for (const action of ['accept', 'resume', 'complete']) {
      const step = await tool(agentTwo, 'update_handoff', { session_id: session, action });
      expect(step.isError, `${action}: ${step.text}`).toBe(false);
    }
    const [launch] = await srv.db.select().from(launchAttempts).where(eq(launchAttempts.id, launchId));
    expect(launch!.firstRealResultAt).toBeTruthy();

    const done = await pageText(srv.url, owner, `${SLUG}/connections?launch=${launchId}`);
    const card = text(done.slice(done.indexOf('id="launch"'), done.indexOf('id="connections"')));
    expect(card).toContain('Your first tracked handoff completed');
    expect(done).toContain(`href="/app/sessions/${session}"`);
    expect(card).toContain('Open the completed handoff');
    expect(card).not.toContain('This exchange included the Claude app console');
  });

  it('adding the Claude app again is allowed and says so, until the first is revoked', async () => {
    const clientId = await registerClient(srv.url, 'Claude', CLAUDE_CALLBACK);
    const consent = async (state: string) =>
      (
        await fetch(`${srv.url}/oauth/authorize?${new URLSearchParams(authorizeParams(srv.url, clientId, CLAUDE_CALLBACK, state))}`, {
          headers: owner.header(),
        })
      ).text();
    const again = await consent('again');
    expect(text(again)).toContain('You already have 1 live Claude app connection.');
    expect(text(again)).toContain('adds another rather than replacing it');
    expect(again).not.toMatch(/value="allow" disabled/);

    const [row] = await srv.db
      .select({ id: tokens.id })
      .from(tokens)
      .innerJoin(agentInstallations, eq(agentInstallations.tokenId, tokens.id))
      .where(and(eq(tokens.userId, ownerId), eq(agentInstallations.clientType, 'claude-app')));
    expect((await postForm(srv.url, owner, `/app/tokens/${row!.id}/revoke`, { back_team: 'doors-both', back_project: '' })).status).toBe(302);
    const gone = await consent('gone');
    expect(text(gone)).not.toContain('You already have');
    // A coding agent's consent never carries the notice.
    const agentClient = await registerClient(srv.url, 'Claude Code (stma-doors-three)', LOOPBACK_CALLBACK);
    const agentConsent = await (
      await fetch(`${srv.url}/oauth/authorize?${new URLSearchParams(authorizeParams(srv.url, agentClient, LOOPBACK_CALLBACK, 'agent'))}`, {
        headers: owner.header(),
      })
    ).text();
    expect(text(agentConsent)).not.toContain('Claude app connection');
  });
});

describe('what a Personal Claude app connection reaches', () => {
  it('is listed in every workspace of its owner with its reach, and in nobody else\'s', async () => {
    const lead = await devLogin(srv.url, 'td-personal');
    expect((await postForm(srv.url, lead, '/app/teams', { name: 'Personal One' })).status).toBe(302);
    expect((await postForm(srv.url, lead, '/app/teams', { name: 'Personal Two' })).status).toBe(302);
    // Nobody offers Personal for a new connection from a workspace page.
    const one = await pageText(srv.url, lead, '/app/teams/personal-one/connections');
    expect(one).not.toContain('value="personal"');

    await connectOAuth(srv.url, lead, {
      clientName: 'Claude',
      callback: CLAUDE_CALLBACK,
      state: 'personal',
      fields: { name: 'personal-console', access: 'personal' },
    });
    const [teamOne] = await srv.db.select().from(teams).where(eq(teams.slug, 'personal-one'));
    await connectOAuth(srv.url, lead, {
      clientName: 'Claude',
      callback: CLAUDE_CALLBACK,
      state: 'scoped',
      fields: { name: 'scoped-console', access: `team:${teamOne!.id}` },
    });

    for (const slug of ['personal-one', 'personal-two']) {
      const page = await pageText(srv.url, lead, `/app/teams/${slug}/connections`);
      const row = rowOf(page, 'personal-console');
      expect(row, slug).not.toBe('');
      expect(text(row)).toContain('Every workspace you are in');
      expect(row).toContain('so it stops everywhere');
    }
    // The workspace-scoped one is listed where it works and nowhere else.
    expect(rowOf(await pageText(srv.url, lead, '/app/teams/personal-one/connections'), 'scoped-console')).not.toBe('');
    expect(rowOf(await pageText(srv.url, lead, '/app/teams/personal-two/connections'), 'scoped-console')).toBe('');

    // Another member of the same workspace never sees either.
    expect((await postForm(srv.url, lead, '/app/teams/personal-one/invites', {})).status).toBe(302);
    const people = await pageText(srv.url, lead, '/app/teams/personal-one?tab=people');
    const code = /\/join\/([A-Za-z0-9_-]+)/.exec(people)?.[1];
    const colleague = await devLogin(srv.url, 'td-colleague');
    expect((await postForm(srv.url, colleague, `/join/${code}`, {})).status).toBe(302);
    const theirs = await pageText(srv.url, colleague, '/app/teams/personal-one/connections');
    expect(theirs).not.toContain('personal-console');
    expect(theirs).not.toContain('scoped-console');
  });
});

describe('leaving a workspace, and asking for a connection in one you are not in', () => {
  it('removes a person from the project roster and closes their connections page', async () => {
    const lead = await devLogin(srv.url, 'td-lead');
    expect((await postForm(srv.url, lead, '/app/teams', { name: 'Leave Doors' })).status).toBe(302);
    const [team] = await srv.db.select().from(teams).where(eq(teams.slug, 'leave-doors'));
    const [project] = await srv.db
      .insert((await import('../src/db/schema')).projects)
      .values({ teamId: team!.id, name: 'leave-api', slug: 'leave-api', repositoryIdentity: 'github.com/example/leave-api' })
      .returning();
    expect((await postForm(srv.url, lead, '/app/teams/leave-doors/invites', {})).status).toBe(302);
    const people = await pageText(srv.url, lead, '/app/teams/leave-doors?tab=people');
    const code = /\/join\/([A-Za-z0-9_-]+)/.exec(people)?.[1];
    const leaver = await devLogin(srv.url, 'td-leaver');
    expect((await postForm(srv.url, leaver, `/join/${code}`, {})).status).toBe(302);
    await connectOAuth(srv.url, leaver, {
      clientName: 'Claude Code (stma-leave-one)',
      callback: LOOPBACK_CALLBACK,
      state: 'leave',
      fields: { name: 'leaver-agent', device: 'desk', access: `project:${project!.id}` },
    });
    const roster = '/app/teams/leave-doors/projects/leave-api/agents';
    expect(await pageText(srv.url, lead, roster)).toContain('leaver-agent');
    expect((await getPage(srv.url, leaver, '/app/teams/leave-doors/projects/leave-api/connections')).status).toBe(200);

    const [leaverRow] = await srv.db.select().from(users).where(eq(users.username, 'td-leaver'));
    expect((await postForm(srv.url, lead, `/app/teams/leave-doors/members/${leaverRow!.id}/remove`, {})).status).toBe(302);
    expect(await pageText(srv.url, lead, roster)).not.toContain('leaver-agent');
    expect((await getPage(srv.url, leaver, '/app/teams/leave-doors/projects/leave-api/connections')).status).toBe(404);
    expect((await getPage(srv.url, leaver, '/app/teams/leave-doors/connections')).status).toBe(404);
  });

  it('refuses a connection for a workspace the person is not in, and creates nothing', async () => {
    const stranger = await devLogin(srv.url, 'td-intruder');
    expect((await postForm(srv.url, stranger, '/app/teams', { name: 'Intruder Home' })).status).toBe(302);
    const [target] = await srv.db.select().from(teams).where(eq(teams.slug, 'leave-doors'));
    const [project] = await srv.db
      .select()
      .from((await import('../src/db/schema')).projects)
      .where(eq((await import('../src/db/schema')).projects.slug, 'leave-api'));
    const before = (await srv.db.select().from(agentEnrollments)).length;
    const forms = {
      // A connect command is project-only, so this reaches the membership check.
      terminal: { name: 'sneaky', device: 'mac', client: 'codex', access: `project:${project!.id}`, mode: 'terminal' },
      // The prompt form takes a whole workspace, and reaches the same check.
      workspace: { name: 'sneaky2', device: 'mac', client: 'codex', access: `team:${target!.id}` },
    };
    for (const [label, form] of Object.entries(forms)) {
      const denied = await postForm(srv.url, stranger, '/app/tokens', form);
      const body = await denied.text();
      expect(denied.status, label).toBe(422);
      expect(text(body), label).toContain('That workspace or project is no longer available to your account.');
      expect(body, label).not.toMatch(/stma_enroll_[0-9a-f]{40}/);
    }
    expect((await srv.db.select().from(agentEnrollments)).length).toBe(before);

    // The same forms from a member of that workspace are accepted, so the only
    // difference between refusal and success is who asked.
    const owner = await devLogin(srv.url, 'td-lead');
    for (const [label, form] of Object.entries(forms)) {
      const accepted = await postForm(srv.url, owner, '/app/tokens', form);
      expect(accepted.status, `${label} from a member`).toBe(200);
      expect(await accepted.text(), label).toMatch(/stma_enroll_[0-9a-f]{40}/);
    }
  });
});
