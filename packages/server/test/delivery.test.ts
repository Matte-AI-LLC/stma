import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';
import { recommendTemplate, FLOW_TEMPLATES } from '../src/domain/flowTemplates';
import { renderPipeline, flowBrief } from '../src/domain/delivery';
import { adoOutbox, describeAdoFailure } from '../src/lib/azureDevops';
import { describeJiraFailure, jiraOutbox } from '../src/lib/jira';
import { branchPatternToRegex, deliveryFlowSchema, flowAdvice } from '@bridge/shared';

let server: StartedServer;
let dataDir: string;

interface Jar {
  header(): Record<string, string>;
  store(res: Response): void;
}

function jar(): Jar {
  const cookies = new Map<string, string>();
  return {
    header(): Record<string, string> {
      if (!cookies.size) return {};
      return { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
    },
    store(res) {
      for (const line of res.headers.getSetCookie()) {
        const [kv] = line.split(';');
        const i = kv!.indexOf('=');
        cookies.set(kv!.slice(0, i), kv!.slice(i + 1));
      }
    },
  };
}

let owner: Jar;
let member: Jar;
let ownerToken: string;

async function login(username: string): Promise<Jar> {
  const j = jar();
  const res = await fetch(`${server.url}/auth/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username }),
    redirect: 'manual',
  });
  j.store(res);
  expect(res.status).toBe(302);
  return j;
}

const form = (url: string, body: Record<string, string>, j: Jar) =>
  fetch(`${server.url}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...j.header() },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });

const page = async (url: string, j: Jar) => {
  const res = await fetch(`${server.url}${url}`, { headers: j.header() });
  return { status: res.status, html: await res.text() };
};

const location = (res: Response) => decodeURIComponent(res.headers.get('location') ?? '');

let rpcId = 1;
async function call(tool: string, args: Record<string, unknown>, tok: string) {
  const res = await fetch(`${server.url}/mcp`, {
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
    /* prose */
  }
  return { text, data, isError: json.result?.isError === true || json.error !== undefined };
}

/** The designer form for the ticket-gated flow, as the browser would send it. */
const designerForm = (over: Record<string, string> = {}): Record<string, string> => ({
  name: 'Company flow',
  templateKey: 'ticket-gated',
  provider: 'azure-devops',
  scope: '',
  intro: 'Every change answers to a ticket.',
  ticketSystem: 'jira',
  ticketKeyPattern: 'PAY-123',
  ticketRequired: 'on',
  branchPattern: 'feature/{ticket}-{slug}',
  branchFrom: 'main',
  checks: 'npm ci\nnpm test',
  approvals: '1',
  mergeStrategy: 'squash',
  environments: 'stage = merge\nuat = manual, approval\nprod = manual, approval',
  notes: 'PR titles carry the ticket key.',
  ...over,
});

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-delivery-'));
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
  owner = await login('flow-owner');
  member = await login('flow-member');
  const created = await form('/app/teams', { name: 'Flow Lab' }, owner);
  expect(created.status).toBe(302);
  // Membership for the non-owner.
  await form('/app/teams/flow-lab/invites', {}, owner);
  const teamPage = await page('/app/teams/flow-lab', owner);
  const code = /\/join\/([A-Za-z0-9_-]+)/.exec(teamPage.html)?.[1]!;
  const joined = await form(`/join/${code}`, {}, member);
  expect(joined.status).toBe(302);
  const tokenRes = await fetch(`${server.url}/app/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...owner.header() },
    body: new URLSearchParams({ name: 'flow-owner-mac' }),
  });
  ownerToken = /stma_[0-9a-f]{40}/.exec(await tokenRes.text())?.[0]!;
  expect(ownerToken).toBeTruthy();
  adoOutbox.clear();
  jiraOutbox.clear();
});

afterAll(async () => {
  await server?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('wizard', () => {
  it('recommends the ticket-gated flow for a Jira team with staged releases', () => {
    const { template, reasons } = recommendTemplate({
      tracker: 'jira',
      teamSize: 'small',
      protection: 'review',
      release: 'staged',
    });
    expect(template.key).toBe('ticket-gated');
    expect(reasons.length).toBeGreaterThan(0);
  });

  it('recommends solo CI for one person with no tracker', () => {
    const { template } = recommendTemplate({
      tracker: 'none',
      teamSize: 'solo',
      protection: 'checks',
      release: 'continuous',
    });
    expect(template.key).toBe('solo-ci');
  });

  it('renders the recommendation with its reasons on the page', async () => {
    const { html } = await page(
      '/app/teams/flow-lab/delivery?wizard=1&tracker=jira&teamSize=small&protection=review&release=staged',
      owner,
    );
    expect(html).toContain('Ticket-gated delivery');
    expect(html).toContain('Why: it');
    expect(html).toContain('Use this template');
  });
});

describe('publishing a flow', () => {
  it('lets an owner publish from the designer and shows all three renderings', async () => {
    const res = await form('/app/teams/flow-lab/delivery', designerForm(), owner);
    expect(res.status).toBe(302);
    expect(location(res)).toContain('Published "Company flow" v1');

    const flowId = /flow=([0-9a-f-]{36})/.exec(location(res))?.[1]!;
    const { html } = await page(`/app/teams/flow-lab/delivery?flow=${flowId}`, owner);
    // The picture...
    expect(html).toContain('flowdg');
    expect(html).toContain('sign-off');
    // ...the brief...
    expect(html).toContain('Do not start work without one');
    // ...and the pipeline.
    expect(html).toContain('azure-pipelines.yml');
    expect(html).toContain('deploy_uat');
  });

  it('refuses a member, whichever door they try', async () => {
    const res = await form('/app/teams/flow-lab/delivery', designerForm({ name: 'Sneaky' }), member);
    expect(location(res)).toContain('Only a team owner');
  });

  it('says which line of the environments box is wrong', async () => {
    const res = await form(
      '/app/teams/flow-lab/delivery',
      designerForm({ environments: 'stage = sometimes' }),
      owner,
    );
    expect(location(res)).toContain('"stage = sometimes"');
  });

  it('archives the previous flow when a new one takes the same scope', async () => {
    const res = await form(
      '/app/teams/flow-lab/delivery',
      designerForm({ name: 'Company flow 2026' }),
      owner,
    );
    expect(location(res)).toContain('Published');
    const { html } = await page('/app/teams/flow-lab/delivery', owner);
    expect(html).toContain('Company flow 2026');
    // The old flow is archived, not gone.
    expect(html).toContain('archived');
  });
});

describe('get_workflow over MCP', () => {
  it('serves the flow with a brief an agent can follow', async () => {
    const res = await call('get_workflow', { team: 'flow-lab' }, ownerToken);
    expect(res.isError).toBe(false);
    expect(res.data.name).toBe('Company flow 2026');
    expect(res.data.brief).toContain('Branch from main, named feature/{ticket}-{slug}');
    expect(res.data.brief).toContain('npm ci · npm test');
    expect(res.data.document.ticket.required).toBe(true);
    expect(res.data.pipelinePath).toBe('azure-pipelines.yml');
  });

  it('prefers a project-scoped flow over the team-wide one', async () => {
    const scoped = await form(
      '/app/teams/flow-lab/delivery',
      designerForm({ name: 'Web flow', scope: 'web-app', ticketRequired: '' }),
      owner,
    );
    expect(location(scoped)).toContain('Published');
    const forProject = await call('get_workflow', { team: 'flow-lab', project: 'web-app' }, ownerToken);
    expect(forProject.data.name).toBe('Web flow');
    expect(forProject.data.scope).toBe('web-app');
    const forTeam = await call('get_workflow', { team: 'flow-lab' }, ownerToken);
    expect(forTeam.data.name).toBe('Company flow 2026');
  });

  it('tells start_run about the flow without inlining it', async () => {
    const res = await call(
      'start_run',
      {
        team: 'flow-lab',
        project: 'web-app',
        task: 'PAY-77',
        intent: 'Wire the refund endpoint',
        scope: [{ type: 'path', key: 'src/refunds/**', access: 'write' }],
      },
      ownerToken,
    );
    expect(res.isError).toBe(false);
    expect(res.data.deliveryHint).toContain('Web flow');
    expect(res.data.deliveryHint).toContain('get_workflow');
  });

  it('answers plainly when nothing is published', async () => {
    const empty = await form('/app/teams', { name: 'Bare Flow Team' }, owner);
    expect(empty.status).toBe(302);
    const res = await call('get_workflow', { team: 'bare-flow-team' }, ownerToken);
    expect(res.data.flow).toBeNull();
    expect(res.data.note).toContain('No delivery flow');
  });
});

describe('pipeline rendering', () => {
  const document = deliveryFlowSchema.parse({
    ticket: { system: 'jira', keyPattern: 'PROJ-1', required: true },
    branch: { pattern: 'feature/{ticket}', from: 'main' },
    checks: ['npm test'],
    review: { approvals: 1 },
    mergeStrategy: 'squash',
    environments: [
      { name: 'stage', deployOn: 'merge', approval: false },
      { name: 'prod', deployOn: 'tag', approval: true },
    ],
  });

  it('renders Azure DevOps stages that mirror the flow', () => {
    const { path: p, yaml } = renderPipeline(document, 'azure-devops', { name: 'X', version: 3 });
    expect(p).toBe('azure-pipelines.yml');
    expect(yaml).toContain('"npm test"');
    expect(yaml).toContain('- stage: deploy_stage');
    expect(yaml).toContain("refs/heads/main");
    expect(yaml).toContain("startsWith(variables['Build.SourceBranch'], 'refs/tags/v')");
    expect(yaml).toContain('environment: "prod" # set an approval check');
    expect(yaml).toContain('delivery flow "X" (v3)');
  });

  it('renders GitHub Actions jobs chained in environment order', () => {
    const { path: p, yaml } = renderPipeline(document, 'github-actions', { name: 'X', version: 1 });
    expect(p).toBe('.github/workflows/stma-flow.yml');
    expect(yaml).toContain('needs: checks');
    expect(yaml).toContain('needs: deploy_stage');
    expect(yaml).toContain("startsWith(github.ref, 'refs/tags/v')");
  });

  it('writes the brief a person could have written', () => {
    const brief = flowBrief(document, { name: 'X', team: 'flow-lab', project: null });
    expect(brief).toContain('Work starts from a Jira ticket (key like PROJ-1). Do not start work without one.');
    expect(brief).toContain('stage (automatically on merge) → prod (on a version tag, needs sign-off)');
  });

  it('ships templates whose documents all validate', () => {
    for (const template of FLOW_TEMPLATES) {
      expect(() => deliveryFlowSchema.parse(template.document)).not.toThrow();
      // Every template renders for both providers without throwing.
      renderPipeline(template.document, 'azure-devops', { name: template.name, version: 1 });
      renderPipeline(template.document, 'github-actions', { name: template.name, version: 1 });
    }
  });
});

describe('Azure DevOps apply', () => {
  let flowId: string;

  it('connects the integration from the team page', async () => {
    const res = await form(
      '/app/teams/flow-lab/integrations/azure-devops',
      { action: 'save', locator: 'matte/stma/stma-repo', token: 'ado-pat-secret' },
      owner,
    );
    expect(location(res)).toContain('Connected to matte/stma/stma-repo');

    const test = await form(
      '/app/teams/flow-lab/integrations/azure-devops',
      { action: 'test' },
      owner,
    );
    expect(location(test)).toContain('is reachable');
  });

  it('rejects a locator that is not org/project/repo', async () => {
    const res = await form(
      '/app/teams/flow-lab/integrations/azure-devops',
      { action: 'save', locator: 'just-a-repo', token: 'x' },
      owner,
    );
    expect(location(res)).toContain('organization/project/repo');
  });

  it('commits the pipeline file and registers the pipeline, in wire shape', async () => {
    adoOutbox.clear();
    const { html } = await page('/app/teams/flow-lab/delivery', owner);
    flowId = /flow=([0-9a-f-]{36})/.exec(html)?.[1]!;
    expect(flowId).toBeTruthy();

    const res = await form(`/app/teams/flow-lab/delivery/${flowId}/apply`, {}, owner);
    expect(location(res)).toContain('Committed azure-pipelines.yml on main');
    expect(location(res)).toContain('registered pipeline #7');

    const pushes = adoOutbox.pushes();
    expect(pushes).toHaveLength(1);
    const push = pushes[0]!.body as any;
    expect(push.refUpdates[0].name).toBe('refs/heads/main');
    expect(push.commits[0].changes[0].changeType).toBe('add');
    expect(push.commits[0].changes[0].item.path).toBe('/azure-pipelines.yml');
    expect(push.commits[0].changes[0].newContent.content).toContain('stages:');

    const pipelines = adoOutbox.pipelines();
    expect(pipelines).toHaveLength(1);
    const pipeline = pipelines[0]!.body as any;
    expect(pipeline.configuration.type).toBe('yaml');
    expect(pipeline.configuration.path).toBe('/azure-pipelines.yml');
  });

  it('edits rather than re-adds when the file already exists', async () => {
    adoOutbox.clear();
    adoOutbox.seedFiles(['azure-pipelines.yml']);
    const res = await form(`/app/teams/flow-lab/delivery/${flowId}/apply`, {}, owner);
    expect(location(res)).toContain('Updated azure-pipelines.yml');
    const push = adoOutbox.pushes()[0]!.body as any;
    expect(push.commits[0].changes[0].changeType).toBe('edit');
    adoOutbox.clear();
  });

  it('lets only an owner apply', async () => {
    const res = await form(`/app/teams/flow-lab/delivery/${flowId}/apply`, {}, member);
    expect(res.status).toBe(404);
  });
});

describe('Jira connection', () => {
  it('refuses a site that is not *.atlassian.net', async () => {
    const res = await form(
      '/app/teams/flow-lab/integrations/jira',
      { action: 'save', site: 'https://evil.example.com', email: 'a@b.co', token: 't' },
      owner,
    );
    expect(location(res)).toContain('atlassian.net');
  });

  it('connects and verifies who the token belongs to', async () => {
    const res = await form(
      '/app/teams/flow-lab/integrations/jira',
      { action: 'save', site: 'https://matteai.atlassian.net/jira', email: 'gorkem@matteai.com', token: 'jira-token' },
      owner,
    );
    expect(location(res)).toContain('Connected to matteai.atlassian.net');

    jiraOutbox.clear();
    const test = await form('/app/teams/flow-lab/integrations/jira', { action: 'test' }, owner);
    expect(location(test)).toContain('Test Person');
    expect(jiraOutbox.all().some((c) => c.path === '/rest/api/3/myself')).toBe(true);
  });
});

describe('archive', () => {
  it('stops serving an archived flow to agents', async () => {
    const { html } = await page('/app/teams/flow-lab/delivery', owner);
    const flowId = /flow=([0-9a-f-]{36})/.exec(html)?.[1]!;
    const res = await form(`/app/teams/flow-lab/delivery/${flowId}/archive`, {}, owner);
    expect(location(res)).toContain('Archived');
    // web-app project flow was archived... the team-wide one may still answer.
    const remaining = await call('get_workflow', { team: 'flow-lab', project: 'web-app' }, ownerToken);
    // Whichever flow remains active, the archived one must not be it.
    if (remaining.data.flow !== null) {
      expect(remaining.data.name).not.toBe('Web flow');
    }
  });
});

describe('PAT fallbacks', () => {
  const firstActiveFlowId = async () => {
    const { html } = await page('/app/teams/flow-lab/delivery', owner);
    return /flow=([0-9a-f-]{36})/.exec(html)?.[1]!;
  };

  it('creates the branch on an empty repository instead of failing', async () => {
    adoOutbox.clear();
    adoOutbox.seedBranches([]); // a brand-new Azure DevOps project: no branches at all
    const flowId = await firstActiveFlowId();
    const res = await form(`/app/teams/flow-lab/delivery/${flowId}/apply`, {}, owner);
    expect(location(res)).toContain('registered pipeline');
    expect(location(res)).toContain('repository was empty');
    const push = adoOutbox.pushes()[0]!.body as any;
    // Pushing against the zero id is what creates the branch.
    expect(push.refUpdates[0].oldObjectId).toBe('0'.repeat(40));
    expect(push.commits[0].changes[0].changeType).toBe('add');
    adoOutbox.clear();
  });

  it('names the real default branch when the flow points at a missing one', async () => {
    adoOutbox.clear();
    adoOutbox.seedBranches(['master']); // history exists, but not under the flow's name
    const flowId = await firstActiveFlowId();
    const res = await form(`/app/teams/flow-lab/delivery/${flowId}/apply`, {}, owner);
    expect(location(res)).toContain('branch "main" not found');
    expect(location(res)).toContain('default branch is "master"');
    // The stored health now carries the failure, and the page warns before the
    // next apply instead of after it.
    const { html } = await page(`/app/teams/flow-lab/delivery?flow=${flowId}`, owner);
    expect(html).toContain('The last connection check failed');
    adoOutbox.clear();
  });

  it('reuses a pipeline that already exists instead of shrugging', async () => {
    adoOutbox.clear();
    const flowId = await firstActiveFlowId();
    adoOutbox.seedPipelines([{ id: 42, name: 'stma-company-flow-2026' }]);
    const res = await form(`/app/teams/flow-lab/delivery/${flowId}/apply`, {}, owner);
    expect(location(res)).toContain('Pipeline #42 already existed');
    adoOutbox.clear();
  });

  it('verifies the connection at save time and shows it on the delivery page', async () => {
    const res = await form(
      '/app/teams/flow-lab/integrations/azure-devops',
      { action: 'save', locator: 'matte/stma/stma-repo', token: 'ado-pat-secret' },
      owner,
    );
    expect(location(res)).toContain('verified — default branch main');
    const flowId = await firstActiveFlowId();
    const { html } = await page(`/app/teams/flow-lab/delivery?flow=${flowId}`, owner);
    expect(html).toContain('verified');
  });

  it('offers the connect form right on the delivery page and returns there', async () => {
    const created = await form('/app/teams', { name: 'Pipeline Lab' }, owner);
    expect(created.status).toBe(302);
    const published = await form(
      '/app/teams/pipeline-lab/delivery',
      designerForm({ name: 'Lab flow' }),
      owner,
    );
    const flowId = /flow=([0-9a-f-]{36})/.exec(location(published))?.[1]!;

    const before = await page(`/app/teams/pipeline-lab/delivery?flow=${flowId}`, owner);
    expect(before.html).toContain('Connect Azure DevOps to apply this flow');
    expect(before.html).toContain('How to create this token');

    const connect = await form(
      '/app/teams/pipeline-lab/integrations/azure-devops',
      { action: 'save', locator: 'matte/lab/lab-repo', token: 'lab-pat', return_to: 'delivery' },
      owner,
    );
    const dest = connect.headers.get('location') ?? '';
    expect(dest.startsWith('/app/teams/pipeline-lab/delivery?')).toBe(true);
    expect(decodeURIComponent(dest)).toContain('verified');
  });

  it('explains failures in remediation language, not status codes', async () => {
    expect(describeAdoFailure('bad_token')).toContain('sign-in page');
    expect(describeAdoFailure('missing_scope')).toContain('Code (Read & Write)');
    expect(describeAdoFailure('not_found_or_no_access')).toContain('ONE organization');
    expect(describeJiraFailure('bad_token')).toContain('id.atlassian.com');
  });
});

describe('the flow reaches the run', () => {
  it('compiles the branch rule into a matcher a human would agree with', () => {
    const re = branchPatternToRegex('feature/{ticket}-{slug}');
    expect(re.test('feature/PAY-421-fix-refunds')).toBe(true);
    expect(re.test('feature/pay-421-fix')).toBe(true);
    expect(re.test('quick-fix')).toBe(false);
    expect(re.test('feature/fix')).toBe(false);
  });

  it('warns about a missing ticket and an off-pattern branch, and blesses a clean run', () => {
    const flow = deliveryFlowSchema.parse({
      ticket: { system: 'jira', keyPattern: 'PAY-123', required: true },
      branch: { pattern: 'feature/{ticket}-{slug}', from: 'main' },
    });
    const dirty = flowAdvice(flow, { taskKey: 'just-refactor', branch: 'wip' });
    expect(dirty).toHaveLength(2);
    expect(dirty[0]).toContain('PAY-123');
    expect(dirty[1]).toContain('naming rule');
    expect(flowAdvice(flow, { taskKey: 'PAY-9', branch: 'feature/PAY-9-ledger' })).toHaveLength(0);
    // No branch declared: nothing to check a pattern against.
    expect(flowAdvice(flow, { taskKey: 'PAY-9' })).toHaveLength(0);
  });

  it('tells a starting run when it ignores the flow', async () => {
    const res = await call(
      'start_run',
      {
        team: 'flow-lab',
        task: 'some-refactor',
        branch: 'wip',
        intent: 'Tidy the refund path',
        scope: [{ type: 'path', key: 'src/tidy/**', access: 'write' }],
      },
      ownerToken,
    );
    expect(res.isError).toBe(false);
    expect(res.data.flowAdvice.warnings).toHaveLength(2);
    expect(res.data.flowAdvice.warnings[0]).toContain('ticket');
    expect(res.data.flowAdvice.warnings[1]).toContain('naming rule');
  });

  it('stays silent for a run that follows it', async () => {
    const res = await call(
      'start_run',
      {
        team: 'flow-lab',
        task: 'PAY-500',
        branch: 'feature/PAY-500-limits',
        intent: 'Raise the limits',
        scope: [{ type: 'path', key: 'src/limits/**', access: 'write' }],
      },
      ownerToken,
    );
    expect(res.isError).toBe(false);
    expect(res.data.flowAdvice).toBeUndefined();
  });

  it('pulls the Jira summary in as the intent for a ticket-shaped task', async () => {
    jiraOutbox.clear();
    const res = await call(
      'start_run',
      {
        team: 'flow-lab',
        task: 'PROJ-77',
        branch: 'feature/PROJ-77-wire-refunds',
        scope: [{ type: 'path', key: 'src/wire/**', access: 'write' }],
      },
      ownerToken,
    );
    expect(res.isError).toBe(false);
    expect(res.data.issueUrl).toBe('https://matteai.atlassian.net/browse/PROJ-77');
    expect(jiraOutbox.all().some((c) => c.path.includes('/issue/PROJ-77'))).toBe(true);
    // The run now says what the work is, not just its key.
    const agents = await call('list_active_agents', { team: 'flow-lab' }, ownerToken);
    expect(JSON.stringify(agents.data)).toContain('Seeded summary for PROJ-77');
  });
});

describe('the admin-key trap', () => {
  it('names the Organization ID confusion when a non-ATATT token is refused', async () => {
    jiraOutbox.seedAuthFailure(true);
    const res = await form(
      '/app/teams/flow-lab/integrations/jira',
      { action: 'save', site: 'matteai.atlassian.net', email: 'gorkem@matteai.com', token: 'org-admin-key-123' },
      owner,
    );
    expect(location(res)).toContain('Saved, but the connection check failed');
    expect(location(res)).toContain('Organization ID');
    expect(location(res)).toContain('admin.atlassian.com');
    jiraOutbox.clear();
  });

  it('does not second-guess a token that looks personal', async () => {
    jiraOutbox.seedAuthFailure(true);
    const res = await form(
      '/app/teams/flow-lab/integrations/jira',
      { action: 'save', site: 'matteai.atlassian.net', email: 'gorkem@matteai.com', token: 'ATATT-perfectly-shaped' },
      owner,
    );
    expect(location(res)).toContain('Jira refused the credentials');
    expect(location(res)).not.toContain('Organization ID');
    jiraOutbox.clear();
    // Restore a working connection so later suites see the healthy state.
    const heal = await form(
      '/app/teams/flow-lab/integrations/jira',
      { action: 'save', site: 'matteai.atlassian.net', email: 'gorkem@matteai.com', token: 'jira-token' },
      owner,
    );
    expect(location(heal)).toContain('verified');
  });
});

describe('scoped Atlassian tokens', () => {
  it('falls back to the cloud-id door when the site door refuses, and remembers it', async () => {
    jiraOutbox.clear();
    jiraOutbox.seedScopedToken(true);
    const res = await form(
      '/app/teams/flow-lab/integrations/jira',
      { action: 'save', site: 'matteai.atlassian.net', email: 'gorkem@matteai.com', token: 'ATATT-scoped-token' },
      owner,
    );
    expect(location(res)).toContain('verified — the token belongs to Test Person');
    expect(location(res)).toContain('Scoped token detected');
    // Both doors were knocked on, in order.
    const bases = jiraOutbox.all().map((c) => c.base);
    expect(bases).toContain('site');
    expect(bases).toContain('cloudid');

    // Issue reads now go straight through the remembered door — no re-failing.
    jiraOutbox.clear();
    jiraOutbox.seedScopedToken(true);
    const run = await call(
      'start_run',
      {
        team: 'flow-lab',
        task: 'SCOP-5',
        branch: 'feature/SCOP-5-scoped',
        scope: [{ type: 'path', key: 'src/scoped/**', access: 'write' }],
      },
      ownerToken,
    );
    expect(run.isError).toBe(false);
    expect(run.data.issueUrl).toBe('https://matteai.atlassian.net/browse/SCOP-5');
    const issueCalls = jiraOutbox.all().filter((c) => c.path.includes('/issue/SCOP-5'));
    expect(issueCalls).toHaveLength(1);
    expect(issueCalls[0]!.base).toBe('cloudid');
    jiraOutbox.clear();
    // Restore the classic connection for any later suite.
    const heal = await form(
      '/app/teams/flow-lab/integrations/jira',
      { action: 'save', site: 'matteai.atlassian.net', email: 'gorkem@matteai.com', token: 'jira-token' },
      owner,
    );
    expect(location(heal)).toContain('verified');
  });

  it('still reports a genuinely dead credential as dead, both doors named', async () => {
    jiraOutbox.clear();
    jiraOutbox.seedAuthFailure(true);
    const res = await form(
      '/app/teams/flow-lab/integrations/jira',
      { action: 'save', site: 'matteai.atlassian.net', email: 'gorkem@matteai.com', token: 'ATATT-dead' },
      owner,
    );
    expect(location(res)).toContain('both API doors');
    jiraOutbox.clear();
  });
});
