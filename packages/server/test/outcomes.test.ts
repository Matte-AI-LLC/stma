import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

/**
 * PR/CI outcome linkage and measured-only cost attribution — the two halves of
 * "the change merged, and here is what it cost", read from webhooks and the
 * run's own reports rather than inferred.
 */

let server: StartedServer;
let dataDir: string;
let cookie: Record<string, string>;
let pat: string;
let hookToken: string;

async function login(username: string): Promise<Record<string, string>> {
  const res = await fetch(`${server.url}/auth/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username }),
    redirect: 'manual',
  });
  const cookies = res.headers
    .getSetCookie()
    .map((line) => line.split(';')[0]!)
    .join('; ');
  expect(res.status).toBe(302);
  return { cookie: cookies };
}

let rpcId = 1;
async function call(tool: string, args: Record<string, unknown>) {
  const res = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${pat}`,
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
  };
  const text = json.result?.content?.[0]?.text ?? '';
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* prose */
  }
  return { text, data, isError: json.result?.isError === true };
}

const githubHook = (event: string, payload: unknown) =>
  fetch(`${server.url}/api/hooks/github/${hookToken}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': event },
    body: JSON.stringify(payload),
  });

const adoHook = (payload: unknown) =>
  fetch(`${server.url}/api/hooks/azure-devops/${hookToken}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

const startRun = async (task: string, branch: string) => {
  const res = await call('start_run', {
    team: 'outcome-lab',
    project: 'payments-api',
    task,
    branch,
    intent: `Work on ${task}`,
    scope: [{ type: 'path', key: `src/${task}/**`, access: 'write' }],
  });
  expect(res.isError).toBe(false);
  return res.data.runId as string;
};

const evidence = async (runId: string) => (await call('get_evidence', { run_id: runId })).data;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-outcomes-'));
  server = await startServer(
    loadEnv({
      port: 0,
      host: 'localhost',
      nodeEnv: 'test',
      devMode: true,
      databaseUrl: undefined,
      pgliteDir: dataDir,
    }),
  );
  cookie = await login('outcome-owner');
  const created = await fetch(`${server.url}/app/teams`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...cookie },
    body: new URLSearchParams({ name: 'Outcome Lab' }),
    redirect: 'manual',
  });
  expect(created.status).toBe(302);
  const tokenRes = await fetch(`${server.url}/app/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...cookie },
    body: new URLSearchParams({ name: 'outcome-mac' }),
  });
  pat = /stma_[0-9a-f]{40}/.exec(await tokenRes.text())?.[0]!;
  expect(pat).toBeTruthy();
  const inbound = await fetch(`${server.url}/app/teams/outcome-lab/inbound-token`, {
    method: 'POST',
    headers: cookie,
    redirect: 'manual',
  });
  expect(inbound.status).toBe(302);
  const teamPage = await (
    await fetch(`${server.url}/app/teams/outcome-lab?tab=integrations`, { headers: cookie })
  ).text();
  hookToken = /\/api\/hooks\/github\/([A-Za-z0-9_-]+)/.exec(teamPage)?.[1] ?? '';
  expect(hookToken).toBeTruthy();
});

afterAll(async () => {
  await server?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('GitHub outcome linkage', () => {
  let runId: string;

  it('links an opened PR to the run holding that branch', async () => {
    runId = await startRun('OUT-1', 'feature/OUT-1-pay');
    const res = await githubHook('pull_request', {
      action: 'opened',
      pull_request: {
        number: 5,
        title: 'Wire the refund path',
        html_url: 'https://github.com/acme/payments-api/pull/5',
        merged: false,
        head: { ref: 'feature/OUT-1-pay' },
      },
      repository: { name: 'payments-api' },
    });
    expect(((await res.json()) as any).linked).toBe(true);
    const pack = await evidence(runId);
    expect(pack.run.pr).toEqual({
      number: 5,
      url: 'https://github.com/acme/payments-api/pull/5',
      state: 'open',
    });
  });

  it('records the merge against the run even after it finished', async () => {
    await call('finish_run', { run_id: runId, status: 'completed' });
    const res = await githubHook('pull_request', {
      action: 'closed',
      pull_request: {
        number: 5,
        title: 'Wire the refund path',
        html_url: 'https://github.com/acme/payments-api/pull/5',
        merged: true,
        head: { ref: 'feature/OUT-1-pay' },
      },
      repository: { name: 'payments-api' },
    });
    expect(((await res.json()) as any).linked).toBe(true);
    const pack = await evidence(runId);
    expect(pack.run.pr.state).toBe('merged');
    const outcome = pack.checks.find((c: any) => c.key === 'outcome');
    expect(outcome.state).toBe('ok');
    expect(outcome.detail).toContain('PR #5 merged');
    // "The change merged" is the feed-worthy line.
    const feed = await (
      await fetch(`${server.url}/app/teams/outcome-lab/activity`, { headers: cookie })
    ).text();
    expect(feed).toContain('run_merged');
    expect(feed).toContain('PR #5');
  });

  it('writes the event once, however many times the webhook is delivered', async () => {
    await githubHook('pull_request', {
      action: 'closed',
      pull_request: {
        number: 5,
        title: 'Wire the refund path',
        html_url: 'https://github.com/acme/payments-api/pull/5',
        merged: true,
        head: { ref: 'feature/OUT-1-pay' },
      },
      repository: { name: 'payments-api' },
    });
    const pack = await evidence(runId);
    expect(pack.trail.filter((e: any) => e.type === 'pr_merged')).toHaveLength(1);
  });

  it('tracks CI verdicts on change, not on every completion', async () => {
    const failed = await githubHook('workflow_run', {
      action: 'completed',
      workflow_run: { head_branch: 'feature/OUT-1-pay', conclusion: 'failure', name: 'CI' },
      repository: { name: 'payments-api' },
    });
    expect(((await failed.json()) as any).linked).toBe(true);
    let pack = await evidence(runId);
    expect(pack.run.ci).toBe('failing');
    const outcome = pack.checks.find((c: any) => c.key === 'outcome');
    expect(outcome.state).toBe('attention');
    expect(outcome.detail).toContain('CI failing');

    await githubHook('workflow_run', {
      action: 'completed',
      workflow_run: { head_branch: 'feature/OUT-1-pay', conclusion: 'success', name: 'CI' },
      repository: { name: 'payments-api' },
    });
    await githubHook('workflow_run', {
      action: 'completed',
      workflow_run: { head_branch: 'feature/OUT-1-pay', conclusion: 'success', name: 'CI' },
      repository: { name: 'payments-api' },
    });
    pack = await evidence(runId);
    expect(pack.run.ci).toBe('passing');
    expect(pack.trail.filter((e: any) => e.type === 'ci_completed')).toHaveLength(2);
  });

  it('answers linked:false for a branch no run declared, without erroring', async () => {
    const res = await githubHook('pull_request', {
      action: 'opened',
      pull_request: { number: 99, html_url: 'x', merged: false, head: { ref: 'somebody-elses' } },
      repository: { name: 'payments-api' },
    });
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.linked).toBe(false);
  });
});

describe('Azure DevOps outcome linkage', () => {
  let runId: string;

  it('links PR created and completed through service hooks', async () => {
    runId = await startRun('OUT-2', 'feature/OUT-2-ado');
    const created = await adoHook({
      eventType: 'git.pullrequest.created',
      resource: {
        pullRequestId: 9,
        title: 'ADO change',
        status: 'active',
        sourceRefName: 'refs/heads/feature/OUT-2-ado',
        repository: {
          name: 'payments-api',
          webUrl: 'https://dev.azure.com/matteai/x/_git/payments-api',
        },
      },
    });
    expect(((await created.json()) as any).linked).toBe(true);
    let pack = await evidence(runId);
    expect(pack.run.pr.state).toBe('open');
    expect(pack.run.pr.url).toContain('/pullrequest/9');

    const merged = await adoHook({
      eventType: 'git.pullrequest.updated',
      resource: {
        pullRequestId: 9,
        title: 'ADO change',
        status: 'completed',
        sourceRefName: 'refs/heads/feature/OUT-2-ado',
        repository: { name: 'payments-api', webUrl: 'https://dev.azure.com/matteai/x/_git/payments-api' },
      },
    });
    expect(((await merged.json()) as any).linked).toBe(true);
    pack = await evidence(runId);
    expect(pack.run.pr.state).toBe('merged');
  });

  it('maps build.complete results, counting partiallySucceeded as a failure', async () => {
    const res = await adoHook({
      eventType: 'build.complete',
      resource: {
        result: 'partiallySucceeded',
        sourceBranch: 'refs/heads/feature/OUT-2-ado',
        definition: { name: 'stma-company-flow' },
      },
    });
    expect(((await res.json()) as any).linked).toBe(true);
    const pack = await evidence(runId);
    expect(pack.run.ci).toBe('failing');
  });

  it('ignores event types it does not know, politely', async () => {
    const res = await adoHook({ eventType: 'workitem.updated', resource: {} });
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.ignored).toBe('workitem.updated');
  });
});

describe('run cost, measured only', () => {
  it('records a measured cost and counts it in the savings ledger', async () => {
    const runId = await startRun('OUT-3', 'feature/OUT-3-cost');
    const res = await call('update_run', {
      run_id: runId,
      usage: { cost_usd: 4.2, source: 'measured' },
    });
    expect(res.isError).toBe(false);
    expect(res.data.cost.recordedUsd).toBe(4.2);
    expect(res.data.cost.note).toContain('counts');

    const pack = await evidence(runId);
    expect(pack.run.cost).toEqual({ usd: 4.2, source: 'measured' });

    const savings = await (
      await fetch(`${server.url}/app/teams/outcome-lab/savings`, { headers: cookie })
    ).text();
    expect(savings).toContain('Agents reported spending');
    expect(savings).toContain('$4');
  });

  it('records an estimate as an estimate and keeps it out of every total', async () => {
    const runId = await startRun('OUT-4', 'feature/OUT-4-est');
    const res = await call('update_run', {
      run_id: runId,
      usage: { cost_usd: 900, source: 'estimate' },
    });
    expect(res.data.cost.note).toContain('never added');
    const pack = await evidence(runId);
    expect(pack.run.cost).toEqual({ usd: 900, source: 'estimate' });

    const savings = await (
      await fetch(`${server.url}/app/teams/outcome-lab/savings`, { headers: cookie })
    ).text();
    // The $900 guess must not appear in the measured total.
    expect(savings).toContain('$4');
    expect(savings).not.toContain('$904');
  });

  it('takes a cost report without a percentage', async () => {
    const runId = await startRun('OUT-5', 'feature/OUT-5-only-cost');
    const res = await call('update_run', { run_id: runId, usage: { cost_usd: 1.5 } });
    expect(res.isError).toBe(false);
    // No source named: recorded as the estimate it is.
    expect(res.data.cost.source).toBe('estimate');
    expect(res.data.quota ?? null).toBeNull();
  });
});
