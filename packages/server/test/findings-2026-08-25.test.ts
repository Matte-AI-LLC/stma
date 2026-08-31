import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

/**
 * Regressions from the 2026-08-25 Mac pass (docs/test-raporu-2026-08-25.md), where a
 * real MCP client drove the product instead of a fixture. Each of these was found by
 * watching an agent or a browser do something ordinary.
 */

let srv: StartedServer;
let dataDir: string;

function jar() {
  const cookies = new Map<string, string>();
  return {
    header(): Record<string, string> {
      return cookies.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {};
    },
    store(res: Response) {
      for (const line of res.headers.getSetCookie()) {
        const [kv] = line.split(';');
        const i = kv!.indexOf('=');
        cookies.set(kv!.slice(0, i), kv!.slice(i + 1));
      }
    },
  };
}

async function devLogin(username: string) {
  const j = jar();
  const res = await fetch(`${srv.url}/auth/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username }),
    redirect: 'manual',
  });
  j.store(res);
  expect(res.status).toBe(302);
  return j;
}

async function form(j: ReturnType<typeof jar>, url: string, body: Record<string, string>) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...j.header() },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });
}

let rpcId = 1;
async function callTool(pat: string, name: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${pat}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const json = (await res.json()) as {
    result?: { isError?: boolean; content: Array<{ type: string; text: string }> };
  };
  return json.result!;
}

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'bridge-findings-test-'));
  srv = await startServer(
    loadEnv({
      port: 0,
      host: 'localhost',
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

it('the token page rendered by POST still knows which team you are in', async () => {
  // The rail is computed for GET page loads; POST /app/tokens is the one route that
  // answers a POST with a page, and it is the first page a new user ever sees.
  const j = await devLogin('rail-user');
  const created = await form(j, `${srv.url}/app/teams`, { name: 'Rail Team' });
  expect(created.status).toBe(302);

  const res = await fetch(`${srv.url}/app/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...j.header() },
    body: new URLSearchParams({ name: 'laptop' }),
  });
  const html = await res.text();
  expect(html).toContain('rail-team');
  expect(html).not.toContain('no team yet');
});

it('a revoked token is told it was revoked, not to send a token', async () => {
  const j = await devLogin('revoker');
  await form(j, `${srv.url}/app/teams`, { name: 'Revoke Team' });
  const tokRes = await fetch(`${srv.url}/app/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...j.header() },
    body: new URLSearchParams({ name: 'doomed' }),
  });
  const tokHtml = await tokRes.text();
  const pat = /stma_[0-9a-f]{40}/.exec(tokHtml)![0];
  const id = /\/app\/tokens\/([0-9a-f-]{36})\/revoke/.exec(tokHtml)![1]!;

  expect((await callTool(pat, 'whoami')).isError).toBeFalsy();
  expect((await form(j, `${srv.url}/app/tokens/${id}/revoke`, {})).status).toBe(302);

  const after = await fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${pat}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'whoami', arguments: {} } }),
  });
  expect(after.status).toBe(401);
  const body = (await after.json()) as { hint: string };
  expect(body.hint).toMatch(/revoked/i);
  expect(body.hint).toContain('/app/tokens');

  // An unknown token still gets the generic answer: nothing here says whether a
  // token ever existed to somebody who does not already hold it.
  const unknown = await fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer stma_${'0'.repeat(40)}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'whoami', arguments: {} } }),
  });
  expect(unknown.status).toBe(401);
  expect(((await unknown.json()) as { hint: string }).hint).not.toMatch(/revoked/i);
});

it('the activity export opens as UTF-8 in Excel', async () => {
  const j = await devLogin('csv-user');
  const created = await form(j, `${srv.url}/app/teams`, { name: 'CSV Team' });
  const teamPath = created.headers.get('location')!;
  const slug = teamPath.split('/').pop()!;
  const res = await fetch(`${srv.url}/app/teams/${slug}/activity.csv`, { headers: j.header() });
  expect(res.status).toBe(200);
  const bytes = new Uint8Array(await res.arrayBuffer());
  expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
});

it('the snapshot checklist tells the agent to skip committed dotenv templates', async () => {
  // The one variable that differs between two machines is usually present in
  // .env.example on both, so folding a template in can only hide it.
  const j = await devLogin('checklist-user');
  await form(j, `${srv.url}/app/teams`, { name: 'Checklist Team' });
  const tokRes = await fetch(`${srv.url}/app/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...j.header() },
    body: new URLSearchParams({ name: 'cli' }),
  });
  const pat = /stma_[0-9a-f]{40}/.exec(await tokRes.text())![0];
  const checklist = (await callTool(pat, 'get_snapshot_checklist')).content[0]!.text;
  expect(checklist).toContain('.env.example');
  expect(checklist).toMatch(/SKIP committed templates/);
});

it('preflight does not read a missing envVarNames as "every variable is missing"', async () => {
  const j = await devLogin('preflight-user');
  const created = await form(j, `${srv.url}/app/teams`, { name: 'Preflight Team' });
  const slug = created.headers.get('location')!.split('/').pop()!;
  const tokRes = await fetch(`${srv.url}/app/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...j.header() },
    body: new URLSearchParams({ name: 'cli' }),
  });
  const pat = /stma_[0-9a-f]{40}/.exec(await tokRes.text())![0];

  await form(j, `${srv.url}/app/teams/${slug}/policy`, {
    scope: 'team',
    requiredEnvVarNames: 'DATABASE_URL\nSTRIPE_KEY',
    guidance: 'read the migration first',
  });
  // Projects are created lazily by the first run or snapshot that names one.
  await callTool(pat, 'start_run', {
    team: slug,
    project: 'demo',
    intent: 'give the project a row to hang the preflight on',
    scope: [{ type: 'path', key: 'src/index.ts', access: 'write' }],
  });

  const base = {
    schemaVersion: 1 as const,
    collectedAt: new Date().toISOString(),
    os: { platform: 'darwin', arch: 'arm64', release: '25.3.0' },
    runtimes: { node: 'v25.2.1' },
    packageManagers: { npm: '11.6.2' },
    lockfiles: [],
  };

  const silent = parse(
    await callTool(pat, 'check_environment', { team: slug, project: 'demo', snapshot: base }),
  );
  expect(silent.policyViolations.missingEnvVarNames).toEqual([]);
  expect(silent.policyViolations.envVarNamesReported).toBe(false);
  expect(silent.unchecked).toMatch(/not checked/);
  expect(silent.summary).toContain('env var names not reported');

  // Reported and genuinely short: still a violation, still blocking.
  const reported = parse(
    await callTool(pat, 'check_environment', {
      team: slug,
      project: 'demo',
      snapshot: { ...base, envVarNames: ['DATABASE_URL'] },
    }),
  );
  expect(reported.policyViolations.envVarNamesReported).toBe(true);
  expect(reported.policyViolations.missingEnvVarNames).toEqual(['STRIPE_KEY']);
  expect(reported.blocking).toBe(true);
});

it('the governance drift line does not blame a policy nobody published', async () => {
  const j = await devLogin('gov-user');
  const created = await form(j, `${srv.url}/app/teams`, { name: 'Gov Copy Team' });
  const slug = created.headers.get('location')!.split('/').pop()!;
  const tokRes = await fetch(`${srv.url}/app/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...j.header() },
    body: new URLSearchParams({ name: 'cli' }),
  });
  const pat = /stma_[0-9a-f]{40}/.exec(await tokRes.text())![0];
  await callTool(pat, 'start_run', {
    team: slug,
    project: 'demo',
    intent: 'a run before any policy exists',
    scope: [{ type: 'path', key: 'src/index.ts', access: 'write' }],
  });

  const html = await (
    await fetch(`${srv.url}/app/teams/${slug}/governance`, { headers: j.header() })
  ).text();
  expect(html).toContain('No policy published yet');
  expect(html).not.toContain('the published policy');
  expect(html).toContain('nothing for them to confirm');
});

it('every field in the policy editor has an accessible name', async () => {
  const j = await devLogin('a11y-user');
  const created = await form(j, `${srv.url}/app/teams`, { name: 'A11y Team' });
  const slug = created.headers.get('location')!.split('/').pop()!;
  const html = await (
    await fetch(`${srv.url}/app/teams/${slug}/policy`, { headers: j.header() })
  ).text();
  for (const name of [
    'guidance',
    'deny',
    'requireApproval',
    'requiredChecks',
    'protectedPaths',
    'requiredEnvVarNames',
    'runtimes',
  ]) {
    // Either a real <label for> pair or an aria-label: the editor page uses the
    // first, which is the better answer to the same question.
    const labelled =
      new RegExp(`name="${name}"[^>]*aria-label="`).test(html) ||
      new RegExp(`<label for="([\\w-]+)"[^>]*>[^<]*</label>[\\s\\S]{0,400}?id="\\1"[^>]*name="${name}"`).test(
        html,
      );
    expect(labelled, `${name} needs a label or an aria-label`).toBe(true);
  }
});

it('the live-page script does not start its "heard from" clock at the epoch', async () => {
  // lastEventAt = 0 made the 30s fallback reload every turn even with the stream
  // connected, which is the behaviour the stream was added to replace.
  const html = await (await fetch(`${srv.url}/login`)).text();
  const src = /src="(\/app\.[0-9a-f]+\.js)"/.exec(html)?.[1] ?? '/app.js';
  const script = await (await fetch(srv.url + src)).text();
  expect(script).toContain('var lastEventAt = Date.now()');
  expect(script).not.toContain('var lastEventAt = 0');
});

/**
 * The four the first pass deliberately left alone, because each was a product
 * decision rather than a bug. These are the decisions.
 */

it('a run is unconfirmed until it says which policy it applied, and drift means a deviation', async () => {
  const j = await devLogin('receipt-user');
  const created = await form(j, `${srv.url}/app/teams`, { name: 'Receipt Team' });
  const slug = created.headers.get('location')!.split('/').pop()!;
  const tokRes = await fetch(`${srv.url}/app/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...j.header() },
    body: new URLSearchParams({ name: 'cli' }),
  });
  const pat = /stma_[0-9a-f]{40}/.exec(await tokRes.text())![0];
  await form(j, `${srv.url}/app/teams/${slug}/policy`, {
    scope: 'team',
    guidance: 'read the migration before touching payments',
  });

  const started = parse(
    await callTool(pat, 'start_run', {
      team: slug,
      project: 'receipts',
      intent: 'a run that will confirm its policy',
      scope: [{ type: 'path', key: 'src/a.ts', access: 'write' }],
    }),
  );
  // The one thing an MCP-only agent could not previously do: it is told how.
  expect(started.policyHint).toContain('policy_hash');
  expect(started.policyHint).toContain(started.policy.hash);

  // Silence is not breakage. Before the receipt is answered the page says
  // unconfirmed, and the rail's drift badge stays dark.
  const quiet = await (
    await fetch(`${srv.url}/app/teams/${slug}/governance`, { headers: j.header() })
  ).text();
  expect(quiet).toContain('never confirmed which rules they applied');
  expect(quiet).not.toContain('applied a policy other than the one the server served');

  const confirmed = parse(
    await callTool(pat, 'update_run', { run_id: started.runId, policy_hash: started.policy.hash }),
  );
  expect(confirmed.policy.confirmed).toBe(true);
  const clean = await (
    await fetch(`${srv.url}/app/teams/${slug}/governance`, { headers: j.header() })
  ).text();
  expect(clean).not.toContain('never confirmed which rules they applied');
  expect(clean).not.toContain('applied a policy other than the one the server served');

  // Applying something else is what drift is for, and it still reports.
  const drifted = parse(
    await callTool(pat, 'update_run', { run_id: started.runId, policy_hash: 'a'.repeat(64) }),
  );
  expect(drifted.policy.confirmed).toBe(false);
  expect(drifted.policy.note).toMatch(/not the policy this run was served/);
  const loud = await (
    await fetch(`${srv.url}/app/teams/${slug}/governance`, { headers: j.header() })
  ).text();
  expect(loud).toContain('applied a policy other than the one the server served');
  await callTool(pat, 'finish_run', { run_id: started.runId });
});

it('acts on a measured allowance and only records a guessed one', async () => {
  const j = await devLogin('quota-truth');
  const created = await form(j, `${srv.url}/app/teams`, { name: 'Quota Truth' });
  const slug = created.headers.get('location')!.split('/').pop()!;
  const tokRes = await fetch(`${srv.url}/app/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...j.header() },
    body: new URLSearchParams({ name: 'cli' }),
  });
  const pat = /stma_[0-9a-f]{40}/.exec(await tokRes.text())![0];

  const guessRun = parse(
    await callTool(pat, 'start_run', {
      team: slug,
      project: 'quota-demo',
      branch: 'feat/guess',
      task: 'GUESS-1',
      intent: 'reports a number it cannot actually read',
      scope: [{ type: 'path', key: 'src/guess.ts', access: 'write' }],
    }),
  );
  // No source given is a guess: that is the case a real agent produced when it
  // sent 25 → 42 → 58 → 65 and later admitted it had estimated them.
  const guessed = parse(
    await callTool(pat, 'update_run', { run_id: guessRun.runId, usage: { used_pct: 94 } }),
  );
  expect(guessed.quota.source).toBe('estimate');
  expect(guessed.quota.state).toBe('critical');
  expect(guessed.quota.acted).toBe(false);
  expect(guessed.quotaAdvice).toMatch(/as an estimate/);
  expect(guessed.quotaAdvice).toMatch(/source "measured"/);

  const afterGuess = await (
    await fetch(`${srv.url}/app/teams/${slug}/activity`, { headers: j.header() })
  ).text();
  expect(afterGuess).not.toContain('quota_warning');
  const mapAfterGuess = await (await fetch(`${srv.url}/app/agents`, { headers: j.header() })).text();
  expect(mapAfterGuess).not.toContain('out of quota');

  // The same number, read from something real, moves the fleet.
  const measured = parse(
    await callTool(pat, 'update_run', {
      run_id: guessRun.runId,
      usage: { used_pct: 94, source: 'measured', label: 'codex weekly' },
    }),
  );
  expect(measured.quota.acted).toBe(true);
  expect(measured.quotaAdvice).toMatch(/handoff_work now/);
  const afterMeasured = await (
    await fetch(`${srv.url}/app/teams/${slug}/activity`, { headers: j.header() })
  ).text();
  expect(afterMeasured).toContain('quota_warning');
  await callTool(pat, 'finish_run', { run_id: guessRun.runId });
});

it('collapses the spellings of one repository onto one project, and warns about a second name', async () => {
  const j = await devLogin('project-truth');
  const created = await form(j, `${srv.url}/app/teams`, { name: 'Project Truth' });
  const slug = created.headers.get('location')!.split('/').pop()!;
  const tokRes = await fetch(`${srv.url}/app/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...j.header() },
    body: new URLSearchParams({ name: 'cli' }),
  });
  const pat = /stma_[0-9a-f]{40}/.exec(await tokRes.text())![0];

  const first = parse(
    await callTool(pat, 'start_run', {
      team: slug,
      project: 'payments-api',
      intent: 'the name from the origin remote',
      scope: [{ type: 'path', key: 'src/config.js', access: 'write' }],
    }),
  );
  expect(first.projectNote).toBeUndefined();

  // Every spelling of the same repository lands on the same project, so the two
  // runs can still see each other.
  for (const spelling of [
    'acme/payments-api',
    'git@github.com:acme/payments-api.git',
    'https://github.com/acme/payments-api',
    'Payments-API',
  ]) {
    const same = parse(
      await callTool(pat, 'start_run', {
        team: slug,
        project: spelling,
        intent: `spelled as ${spelling}`,
        scope: [{ type: 'path', key: 'src/config.js', access: 'write' }],
      }),
    );
    expect(same.projectNote, `${spelling} must not fork the project`).toBeUndefined();
    expect(same.conflicts.length, `${spelling} must still see the first run`).toBeGreaterThan(0);
    await callTool(pat, 'finish_run', { run_id: same.runId });
  }

  const projects = parse(await callTool(pat, 'list_projects', { team: slug }));
  expect(projects.projects.map((p: { slug: string }) => p.slug)).toEqual(['payments-api']);

  // A genuinely different name is allowed — monorepos are real — but the agent is
  // told what it just did, at the only moment it can still fix it.
  const forked = parse(
    await callTool(pat, 'start_run', {
      team: slug,
      project: 'payments',
      intent: 'the name from package.json',
      scope: [{ type: 'path', key: 'src/config.js', access: 'write' }],
    }),
  );
  expect(forked.projectNote).toContain('"payments-api"');
  expect(forked.projectNote).toContain('scoped per project');
  expect(forked.conflicts).toEqual([]);
  await callTool(pat, 'finish_run', { run_id: forked.runId });
  await callTool(pat, 'finish_run', { run_id: first.runId });
});

it('does not claim a teammate\'s handoff was written by you', async () => {
  const owner = await devLogin('handoff-owner');
  const created = await form(owner, `${srv.url}/app/teams`, { name: 'Handoff Notice' });
  const slug = created.headers.get('location')!.split('/').pop()!;
  expect((await form(owner, `${srv.url}/app/teams/${slug}/invites`, {})).status).toBe(302);
  const inviteHtml = await (
    await fetch(`${srv.url}/app/teams/${slug}?tab=people`, { headers: owner.header() })
  ).text();
  const code = /\/join\/([A-Za-z0-9_-]+)/.exec(inviteHtml)?.[1];
  expect(code, 'an invite code').toBeTruthy();

  const mate = await devLogin('handoff-mate');
  expect((await form(mate, `${srv.url}/join/${code}`, {})).status).toBe(302);

  const tokens = async (jj: ReturnType<typeof jar>, name: string) => {
    const res = await fetch(`${srv.url}/app/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...jj.header() },
      body: new URLSearchParams({ name }),
    });
    return /stma_[0-9a-f]{40}/.exec(await res.text())![0];
  };
  const ownerPat = await tokens(owner, 'owner-machine');
  const matePat = await tokens(mate, 'mate-machine');

  const run = parse(
    await callTool(matePat, 'start_run', {
      team: slug,
      project: 'shared-repo',
      branch: 'fix/theirs',
      intent: 'work the teammate will hand over',
      scope: [{ type: 'path', key: 'src/theirs.ts', access: 'write' }],
    }),
  );
  await callTool(matePat, 'handoff_work', {
    run_id: run.runId,
    branch: 'fix/theirs',
    summary: 'Half of it is done: the parser lands, the writer does not.',
    next_steps: ['Finish writeTheirs and cover the empty case'],
  });

  const inbox = parse(await callTool(ownerPat, 'inbox', { team: slug }));
  const waiting = inbox.pendingHandoffs[0];
  expect(waiting.yours).toBe(false);
  expect(waiting.branch).toBe('fix/theirs');
  expect(inbox.notice).toContain('`resume` field');
  expect(inbox.notice).not.toContain('written by your own account');

  const thread = parse(await callTool(ownerPat, 'get_session', { session_id: waiting.sessionId }));
  expect(thread.notice).not.toContain('written by your own account');
  const handoff = thread.messages.find((m: { kind: string }) => m.kind === 'handoff');
  expect(handoff.mine).toBe(false);
  expect(handoff.resume.reclaim.arguments.scope).toEqual([
    { type: 'path', key: 'src/theirs.ts', access: 'write' },
  ]);
});

// --------------------------------------------------------------- surface pass

it('answers a wrong URL with a page that has a way back, and JSON to a machine', async () => {
  const j = await devLogin('lost-user');
  const inside = await fetch(`${srv.url}/app/teams/does-not-exist/nope`, { headers: j.header() });
  expect(inside.status).toBe(404);
  const html = await inside.text();
  // Hono's default was text/plain with no layout: a signed-in user who mistypes
  // a slug landed on a dead page and had to reach for the back button.
  expect(html).toContain('class="rail"');
  expect(html).toContain('Page not found');
  expect(html).toContain('/app/agents');
  // It must look the same whether the URL is wrong or merely not yours, or the
  // page becomes a way to enumerate what exists.
  expect(html).not.toContain('does not exist or you are not');

  const out = await fetch(`${srv.url}/nothing-here`);
  expect(out.status).toBe(404);
  const outHtml = await out.text();
  expect(outHtml).toContain('Page not found');
  expect(outHtml).toContain('/login');

  const api = await fetch(`${srv.url}/api/not-a-route`);
  expect(api.status).toBe(404);
  expect(await api.json()).toEqual({ error: 'not_found' });
});

it('keeps every destination on screen when the rail lies down', async () => {
  const { css } = await import('../src/ui/styles');
  const phone = /@media \(max-width: 900px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  expect(phone, 'the phone rules are still where this test looks').toContain('.rail-nav');
  // At 375px the brand and the identity took the width and left .rail-nav 59px
  // to hold 580px of links — scrollable, with nothing on screen saying so. It
  // wraps to a second full-width row now, so nothing is hidden at all.
  expect(phone).toMatch(/\.rail-nav \{[\s\S]*?flex-wrap: wrap/);
  expect(phone).toMatch(/\.rail-nav \{[\s\S]*?flex: 1 0 100%/);
  expect(phone).not.toMatch(/\.rail-nav \{[\s\S]*?overflow-x: auto/);
});

it('will not let an open dialog scroll the page behind it', async () => {
  const { clientJs } = await import('../src/ui/client');
  const { css } = await import('../src/ui/styles');
  expect(css).toContain('html.modal-open { overflow: hidden; }');
  // One way in, so a dialog opened from anywhere gets the lock — the second
  // showModal() call site is exactly how this stops being true.
  expect(clientJs.match(/\.showModal\(\)/g)).toHaveLength(1);
  expect(clientJs).toContain("classList.add('modal-open')");
  expect(clientJs).toContain('dialog[open]');
  // Two signals, on purpose: measured in Chrome 148, close() did not always
  // fire its own event, and a lock released by an event that never arrives
  // leaves the page frozen for good.
  expect(clientJs).toContain('new MutationObserver(release)');
  expect(clientJs).toContain("attributeFilter: ['open']");
});

it('makes the owner choose the machine that works, rather than the newest', async () => {
  const j = await devLogin('baseline-owner');
  const created = await form(j, `${srv.url}/app/teams`, { name: 'Baseline Team' });
  const slug = created.headers.get('location')!.split('/').pop()!;
  const tokRes = await fetch(`${srv.url}/app/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...j.header() },
    body: new URLSearchParams({ name: 'works' }),
  });
  const pat = /stma_[0-9a-f]{40}/.exec(await tokRes.text())![0];
  const snap = {
    os: { platform: 'darwin', arch: 'arm64' },
    runtimes: { node: '20.18.1' },
    packageManagers: { npm: '10.8.3' },
    lockfiles: [{ path: 'package-lock.json', hash: 'aaa111' }],
    envVarNames: ['PATH', 'HOME'],
    git: { branch: 'main', sha: 'abc123', dirtyFiles: [] },
    timezone: 'Europe/Istanbul',
  };
  await callTool(pat, 'push_snapshot', { team: slug, repo: 'demo', device: 'good', snapshot: snap });
  await callTool(pat, 'push_snapshot', {
    team: slug,
    repo: 'demo',
    device: 'broken',
    snapshot: { ...snap, runtimes: { node: '25.2.1' } },
  });

  const html = await (
    await fetch(`${srv.url}/app/teams/${slug}/governance`, { headers: j.header() })
  ).text();
  // The list is newest first, and after a debugging session the newest snapshot
  // is the machine you were just debugging — so nothing is preselected.
  expect(html).toContain('Choose the machine that works');
  expect(html).toMatch(/<option value="" selected(="")? disabled(="")?>/);
  expect(html).toContain('do not take the top');
  expect(html).toMatch(/<select[^>]*name="snapshot"[^>]*required/);
});

it('does not let the back button hand back a page it already cleared', async () => {
  const j = await devLogin('back-button');
  await form(j, `${srv.url}/app/teams`, { name: 'Back Button' });

  // Found by pressing Back after opening a thread: the unread badge the page had
  // just cleared was still on it. These pages carried no cache directive at all,
  // so the browser was free to keep them whole — which is a staleness bug while
  // you are signed in and a disclosure one at a shared desk after you are not.
  const signedIn = await fetch(`${srv.url}/app/sessions`, { headers: j.header() });
  expect(signedIn.status).toBe(200);
  expect(signedIn.headers.get('content-type')).toMatch(/text\/html/);
  // no-store, not no-cache: the second still stores the response and only
  // promises to revalidate, which back/forward navigation does not do.
  expect(signedIn.headers.get('cache-control')).toBe('no-store');

  // Signed-out pages are documents and still cache normally.
  const signedOut = await fetch(`${srv.url}/login`);
  expect(signedOut.status).toBe(200);
  expect(signedOut.headers.get('cache-control')).toBeNull();

  // Safari has historically restored no-store pages from the back/forward cache
  // anyway, so the client reloads when it is handed one.
  const { clientJs } = await import('../src/ui/client');
  expect(clientJs).toContain("addEventListener('pageshow'");
  expect(clientJs).toContain('e.persisted');
});

