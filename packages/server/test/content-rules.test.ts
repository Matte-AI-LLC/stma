import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  looksLikeContentRule,
  matchContentRules,
  parseContentRule,
  parseContentRules,
} from '@bridge/shared';
import { fileToolAddedText } from '../../cli/src/fileGuard';
import { agentEvents, projects, teams } from '../src/db/schema';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

/**
 * A rule a machine can check, and the evidence when somebody tries to break it.
 *
 * "Do not use fonts outside the design system" used to be a sentence an agent
 * was trusted to follow; nothing could say afterwards whether it had. The check
 * cannot run on the server — content never leaves the machine — so it runs in
 * the local file guard, and what reaches the server is the rule's own published
 * words and a file path. This file covers the three halves: the grammar, the
 * local extraction that must see only *added* text, and the server's refusal to
 * record anything it did not itself publish.
 */

const FONT_RULE = 'content: "Comic Sans" in public/** — not in the design system';

it('parses a content rule and leaves every other deny line a sentence', () => {
  expect(parseContentRule(FONT_RULE)).toEqual({
    rule: FONT_RULE,
    needle: 'Comic Sans',
    pathPattern: 'public/**',
    reason: 'not in the design system',
  });
  expect(parseContentRule('content: "fonts.googleapis.com"')).toMatchObject({
    needle: 'fonts.googleapis.com',
    pathPattern: null,
    reason: null,
  });
  // Prose, and a typo that only looks like a rule: neither guards anything.
  expect(parseContentRule('push to main')).toBeNull();
  expect(parseContentRule('content: Comic Sans in public/**')).toBeNull();
  expect(looksLikeContentRule('content: Comic Sans in public/**')).toBe(true);
  expect(looksLikeContentRule('push to main')).toBe(false);
  expect(parseContentRules(['read secret values', FONT_RULE]).map((r) => r.needle)).toEqual([
    'Comic Sans',
  ]);
});

it('matches added text by literal and by ground, ignoring case', () => {
  const rules = parseContentRules([FONT_RULE]);
  const css = "h1 { font-family: 'COMIC SANS MS', cursive; }";
  expect(matchContentRules(rules, 'public/styles.css', css)).toHaveLength(1);
  expect(matchContentRules(rules, 'public/nested/deep/app.css', css)).toHaveLength(1);
  // Same text outside the rule's ground, and compliant text inside it.
  expect(matchContentRules(rules, 'docs/typography.md', css)).toHaveLength(0);
  expect(matchContentRules(rules, 'public/styles.css', "h1 { font-family: 'Geist'; }")).toHaveLength(0);
});

it('looks only at what an edit adds, per file, and never at what it removes', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'stma-content-'));
  try {
    expect(
      fileToolAddedText(root, {
        tool_name: 'Edit',
        tool_input: { file_path: 'public/styles.css', old_string: 'Comic Sans', new_string: 'Geist' },
      }),
    ).toEqual([{ path: 'public/styles.css', text: 'Geist' }]);
    expect(
      fileToolAddedText(root, {
        tool_name: 'MultiEdit',
        tool_input: {
          file_path: 'public/styles.css',
          edits: [{ old_string: 'a', new_string: 'one' }, { old_string: 'b', new_string: 'two' }],
        },
      }),
    ).toEqual([{ path: 'public/styles.css', text: 'one\ntwo' }]);
    const patch = [
      '*** Begin Patch',
      '*** Update File: public/styles.css',
      '-h1 { font-family: Comic Sans; }',
      '+h1 { font-family: Geist; }',
      '*** Add File: public/fonts.css',
      '+@import url(comic-sans.css);',
      '*** Delete File: public/old.css',
      '*** End Patch',
    ].join('\n');
    expect(fileToolAddedText(root, { tool_name: 'apply_patch', tool_input: { command: patch } })).toEqual([
      { path: 'public/styles.css', text: 'h1 { font-family: Geist; }' },
      { path: 'public/fonts.css', text: '@import url(comic-sans.css);' },
    ]);
    // Removing the forbidden font is not a violation of the rule that forbids it.
    const rules = parseContentRules([FONT_RULE]);
    const removal = fileToolAddedText(root, {
      tool_name: 'Edit',
      tool_input: { file_path: 'public/styles.css', old_string: 'Comic Sans', new_string: 'Geist' },
    });
    expect(removal.flatMap((a) => matchContentRules(rules, a.path, a.text))).toHaveLength(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ over HTTP

let srv: StartedServer;
let dataDir: string;
let cookie = '';
const REPO = 'github.com/example/parcel-desk';
const WORKTREE = '/work/win/parcel-desk-claude1';
let agent = { token: '', id: '' };

const form = (pathname: string, body: Record<string, string>, jar = cookie) =>
  fetch(srv.url + pathname, {
    method: 'POST',
    headers: { cookie: jar, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });
const api = (endpoint: string, body: unknown = {}) =>
  fetch(srv.url + endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const page = async (pathname: string) => (await fetch(srv.url + pathname, { headers: { cookie } })).text();

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-content-http-'));
  srv = await startServer(
    loadEnv({ host: '127.0.0.1', port: 0, nodeEnv: 'test', devMode: true, databaseUrl: undefined, pgliteDir: dataDir }),
  );
  const login = await form('/auth/dev', { username: 'design-lead' }, '');
  cookie = login.headers.getSetCookie().map((item) => item.split(';')[0]).join('; ');
  expect((await form('/app/teams', { name: 'Design Lab' })).status).toBe(302);
  const [team] = await srv.db.select().from(teams).where(eq(teams.slug, 'design-lab'));
  const [project] = await srv.db
    .insert(projects)
    .values({ teamId: team!.id, name: 'parcel-desk', slug: 'parcel-desk', repositoryIdentity: REPO })
    .returning();
  const prompt = await form('/app/tokens', {
    name: 'claude-b1',
    device: 'win',
    client: 'claude-code',
    role: 'generalist',
    access: `project:${project!.id}`,
  });
  const code = /stma_enroll_[a-f0-9]{40}/.exec(await prompt.text())?.[0];
  expect(code).toBeTruthy();
  const redeemed: any = await (
    await fetch(srv.url + '/api/agent-enrollments/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, protocolVersion: 2 }),
    })
  ).json();
  agent = { token: redeemed.token, id: redeemed.installation.id };
  const who = await fetch(srv.url + '/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${agent.token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }),
  });
  expect(who.status).toBe(200);
});

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

it('refuses a content rule with a typo instead of publishing it as prose', async () => {
  const res = await form('/app/teams/design-lab/policy', {
    scope: 'team',
    deny: 'content: Comic Sans in public/**',
  });
  // The owner gets the editor back with the reason and the line they typed, rather than
  // being sent to another page with a band and an empty form behind it.
  expect(res.status).toBe(422);
  const refused = await res.text();
  expect(refused).toContain('not a valid content rule');
  expect(refused).toContain('content: Comic Sans in public/**');
  expect(await page('/app/teams/design-lab/policy')).toContain('content: &quot;text&quot; in path/**');
});

let runId = '';

it('publishes the rule from the browser and hands it to the local guard with an allowed edit', async () => {
  const published = await form('/app/teams/design-lab/policy', {
    scope: 'team',
    guidance: 'Typography follows the design system: Geist and Geist Mono only.',
    deny: `read secret values\n${FONT_RULE}`,
  });
  expect(published.status).toBe(302);
  expect(decodeURIComponent(published.headers.get('location') ?? '')).toContain('Published');

  const started: any = await (
    await api('/api/agent/runs/start', {
      requestId: randomUUID(),
      installationId: agent.id,
      team: 'design-lab',
      project: 'parcel-desk',
      repositoryIdentity: REPO,
      worktree: WORKTREE,
      taskKey: 'PD-11 Headings',
    })
  ).json();
  runId = started.run.id;

  const guard: any = await (
    await api(`/api/agent/runs/${runId}/write-guard`, {
      claims: [{ resourceType: 'path', resourceKey: 'public/styles.css', access: 'write' }],
      repositoryIdentity: REPO,
      worktree: WORKTREE,
    })
  ).json();
  // The path is fine; the content is the local guard's to judge, with these.
  expect(guard.allowed).toBe(true);
  expect(guard.contentRules).toEqual([FONT_RULE]);
});

it('records who tried to break which rule and where, once, and nothing it did not publish', async () => {
  const report = { rule: FONT_RULE, path: 'public/styles.css', outcome: 'blocked' };
  const first = await api(`/api/agent/runs/${runId}/policy-violations`, report);
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ recorded: true, deduped: false });
  // The agent retries the same edit a minute later: one moment, one row.
  expect(await (await api(`/api/agent/runs/${runId}/policy-violations`, report)).json()).toMatchObject({
    recorded: false,
    deduped: true,
  });

  // Not a way to write sentences into somebody's governance page.
  const invented = await api(`/api/agent/runs/${runId}/policy-violations`, {
    ...report,
    rule: 'content: "anything" — the lead is wrong about fonts',
  });
  expect(invented.status).toBe(409);
  for (const bad of ['../outside.css', '/etc/passwd', 'public\\styles.css']) {
    expect((await api(`/api/agent/runs/${runId}/policy-violations`, { ...report, path: bad })).status).toBe(400);
  }
  // No field for content exists, and an unknown one is refused rather than stored.
  expect(
    (await api(`/api/agent/runs/${runId}/policy-violations`, { ...report, content: "font-family: 'Comic Sans'" })).status,
  ).toBe(400);

  const rows = (await srv.db.select().from(agentEvents).where(eq(agentEvents.runId, runId))).filter(
    (row) => row.type === 'policy_violation',
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.detail).toMatchObject({ rule: FONT_RULE, path: 'public/styles.css', outcome: 'blocked', installationId: agent.id });
  expect(JSON.stringify(rows[0]!.detail)).not.toContain('font-family');
});

it('shows the lead the agent, the rule and the file on the governance page and the feed', async () => {
  const governance = await page('/app/teams/design-lab/governance');
  expect(governance).toContain('Policy violations');
  expect(governance).toContain('1 policy violation stopped');
  expect(governance).toContain('<b>claude-b1</b>');
  expect(governance).toContain('design-lead · win');
  expect(governance).toContain('public/styles.css');
  expect(governance).toContain('not in the design system');
  expect(governance).toContain('Attention required');

  const activity = await page('/app/teams/design-lab/activity');
  expect(activity).toContain('policy_violation');
  expect(activity).toContain('claude-b1');
});
