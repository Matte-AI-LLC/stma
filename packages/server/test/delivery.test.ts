import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deliveryFlows,
  memberships,
  projects,
  repositoryBindings,
  teamIntegrations,
  teams,
  users,
} from '../src/db/schema';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';
import {
  flowForRecommendation,
  recommendTemplate,
  FLOW_TEMPLATES,
  templateByKey,
} from '../src/domain/flowTemplates';
import { renderPipeline, flowBrief, pipelineIsScaffold } from '../src/domain/delivery';
import { effectivePolicy, publishPolicy } from '../src/domain/policies';
import { adoOutbox, describeAdoFailure } from '../src/lib/azureDevops';
import { describeJiraFailure, jiraOutbox } from '../src/lib/jira';
import {
  branchPatternToRegex,
  deliveryFlowSchema,
  flowAdvice,
  policyDocumentSchema,
} from '@bridge/shared';

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
      host: '127.0.0.1',
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
  // Invite links live on the People tab; read from the overview this found nothing and the
  // 'member' of every test below was a stranger (caught 2026-09-20 by a page a member may read).
  const teamPage = await page('/app/teams/flow-lab?tab=people', owner);
  const code = /\/join\/([A-Za-z0-9_-]+)/.exec(teamPage.html)?.[1]!;
  expect(code).toBeTruthy();
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
  it('offers the eight distinct blueprint families', () => {
    expect(FLOW_TEMPLATES.map((template) => template.key)).toEqual([
      'trunk-pr',
      'preview-cd',
      'staged-promotion',
      'progressive-delivery',
      'gitops-promotion',
      'ticket-gated',
      'release-train',
      'solo-ci',
    ]);
  });

  it.each([
    ['preview', 'preview-cd'],
    ['staged', 'staged-promotion'],
    ['progressive', 'progressive-delivery'],
    ['gitops', 'gitops-promotion'],
    ['release', 'release-train'],
  ] as const)('keeps the explicit %s release model in the recommendation', (release, key) => {
    const { template } = recommendTemplate({
      tracker: release === 'gitops' ? 'jira' : 'none',
      provider: 'github-actions',
      teamSize: release === 'release' ? 'solo' : 'small',
      protection: 'review',
      release,
    });
    expect(template.key).toBe(key);
  });

  it('recommends the ticket-gated flow for a Jira team with staged releases', () => {
    const { template, reasons } = recommendTemplate({
      tracker: 'jira',
      provider: 'azure-devops',
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
      provider: 'github-actions',
      teamSize: 'solo',
      protection: 'checks',
      release: 'continuous',
    });
    expect(template.key).toBe('solo-ci');
  });

  it('renders the recommendation with its reasons on the page', async () => {
    const { html } = await page(
      '/app/teams/flow-lab/delivery?wizard=1&tracker=jira&provider=azure-devops&teamSize=small&protection=review&release=staged',
      owner,
    );
    expect(html).toContain('Ticket-gated delivery');
    expect(html).toContain('Why: it');
    expect(html).toContain('Use this template');
    expect(html).toContain('preserveAspectRatio="xMinYMid meet"');
    expect(html).toContain('flow-scroll');
  });

  it('asks for all five answers without the old four-answer copy', async () => {
    const { html } = await page('/app/teams/flow-lab/delivery?wizard=1', owner);
    expect(html).toContain('Answer all five to get a recommendation.');
    expect(html).not.toContain('Answer all four');
  });

  it('draws a pull-request preview before merge', async () => {
    const { html } = await page(
      '/app/teams/flow-lab/delivery?template=preview-cd#template-preview',
      owner,
    );
    expect(html).toContain(
      'Delivery flow: Ticket, then Branch, then Pull request, then preview, then Merge (squash), then production',
    );
  });

  it('carries explicit provider and protection answers into the designer', async () => {
    const answers = {
      tracker: 'github' as const,
      provider: 'github-actions' as const,
      teamSize: 'small' as const,
      protection: 'strict' as const,
      release: 'continuous' as const,
    };
    const recommended = recommendTemplate(answers);
    const document = flowForRecommendation(recommended.template, answers);
    expect(document.ticket.system).toBe('github');
    expect(document.review.approvals).toBe(2);

    const { html } = await page(
      '/app/teams/flow-lab/delivery?wizard=1&tracker=github&provider=github-actions&teamSize=small&protection=strict&release=continuous',
      owner,
    );
    expect(html).toContain('<option value="github-actions" selected="">');
    expect(html).toContain('name="approvals" type="number" min="0" max="10" style="width:110px" value="2"');
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
    expect(html).toContain('Delivery overview');
    expect(html).not.toContain('<div class="card-title">Blueprint library</div>');
    expect(html).not.toContain('<div class="card-title">Published flows</div>');
  });

  it('refuses a member, whichever door they try', async () => {
    const res = await form('/app/teams/flow-lab/delivery', designerForm({ name: 'Sneaky' }), member);
    expect(location(res)).toContain('Only a team owner');
  });

  /**
   * The refusal is one malformed line at the end of a long list, and the
   * designer used to redirect to this page with the reason in a band and the
   * dialog closed over an empty form: the other nine fields were gone. The page
   * comes back holding what was typed — it is the only way that can work,
   * because a document that does not parse cannot be re-rendered from itself.
   */
  it('says which line of the environments box is wrong, and keeps the rest of the form', async () => {
    const typed = designerForm({
      name: 'Nearly right',
      environments: 'stage = merge\nuat = sometimes',
      notes: 'A house rule worth not retyping.',
    });
    const res = await form('/app/teams/flow-lab/delivery', typed, owner);
    // The page, not a redirect; not a 200 either, because nothing was published.
    expect(res.status).toBe(422);
    const html = await res.text();
    // The reason names the line, HTML-escaped as the page renders it.
    expect(html).toContain('&quot;uat = sometimes&quot;');
    expect(html).toContain('value="Nearly right"');
    expect(html).toContain('stage = merge');
    expect(html).toContain('A house rule worth not retyping.');
    expect(html).toContain('npm ci');
    // And open, because a person whose work is in there must not have to find it.
    expect(html).toContain('id="design-flow"');
    expect(/<dialog id="design-flow"[^>]*\sopen/.test(html)).toBe(true);

    const missingCommand = await form(
      '/app/teams/flow-lab/delivery',
      designerForm({ environments: 'stage = merge =>' }),
      owner,
    );
    expect(missingCommand.status).toBe(422);
    expect(await missingCommand.text()).toContain('write a command after =&gt;');

    // Nothing was published by either refusal.
    const { html: list } = await page('/app/teams/flow-lab/delivery', owner);
    expect(list).not.toContain('Nearly right');
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

  it('serializes concurrent publishes and enforces one active flow in the database', async () => {
    const ownerUser = (
      await server.db.select({ id: users.id }).from(users).where(eq(users.username, 'flow-owner')).limit(1)
    )[0]!;
    const raceTeam = (
      await server.db
        .insert(teams)
        .values({ name: 'Flow Race Lab', slug: 'flow-race-lab', createdBy: ownerUser.id })
        .returning()
    )[0]!;
    await server.db
      .insert(memberships)
      .values({ teamId: raceTeam.id, userId: ownerUser.id, role: 'owner' });

    const responses = await Promise.all([
      form('/app/teams/flow-race-lab/delivery', designerForm({ name: 'Concurrent A' }), owner),
      form('/app/teams/flow-race-lab/delivery', designerForm({ name: 'Concurrent B' }), owner),
    ]);
    expect(responses.map((res) => res.status)).toEqual([302, 302]);

    const active = await server.db
      .select()
      .from(deliveryFlows)
      .where(
        and(
          eq(deliveryFlows.teamId, raceTeam.id),
          isNull(deliveryFlows.projectId),
          eq(deliveryFlows.status, 'active'),
        ),
      );
    expect(active).toHaveLength(1);
    expect(['Concurrent A', 'Concurrent B']).toContain(active[0]!.name);

    await expect(
      server.db.insert(deliveryFlows).values({
        teamId: raceTeam.id,
        name: 'Constraint bypass attempt',
        templateKey: 'ticket-gated',
        provider: 'azure-devops',
        document: active[0]!.document,
        createdBy: ownerUser.id,
      }),
    ).rejects.toThrow();
  });

  it('keeps a project selected while editing and preserves one active flow when it moves scope', async () => {
    const created = await form('/app/teams', { name: 'Scope Lab' }, owner);
    expect(created.status).toBe(302);
    await form('/app/teams/scope-lab/delivery', designerForm({ name: 'Scope team flow' }), owner);
    const projectFlow = await form(
      '/app/teams/scope-lab/delivery',
      designerForm({ name: 'API flow', scope: 'api' }),
      owner,
    );
    const flowId = /flow=([0-9a-f-]{36})/.exec(location(projectFlow))?.[1]!;
    expect(flowId).toBeTruthy();

    const editPage = await page(`/app/teams/scope-lab/delivery?flow=${flowId}`, owner);
    expect(editPage.html).toMatch(/<option value="[0-9a-f-]{36}" selected[^>]*>\s*Project: api/);

    const moved = await form(
      '/app/teams/scope-lab/delivery',
      designerForm({ flowId, name: 'Moved API flow', scope: '' }),
      owner,
    );
    expect(location(moved)).toContain('Published');
    const served = await call('get_workflow', { team: 'scope-lab' }, ownerToken);
    expect(served.data.name).toBe('Moved API flow');

    const listing = await page('/app/teams/scope-lab/delivery', owner);
    const activeRows = listing.html
      .split('<tr')
      .filter((row) => row.includes('pill-active'));
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0]).toContain('Moved API flow');
  });
});

describe('agent setup pack', () => {
  let packFlowId: string;
  let effectiveHash: string;

  beforeAll(async () => {
    const created = await form('/app/teams', { name: 'Agent Pack Lab' }, owner);
    expect(created.status).toBe(302);
    const published = await form(
      '/app/teams/agent-pack-lab/delivery',
      designerForm({ name: 'Payments delivery', scope: 'payments-api' }),
      owner,
    );
    packFlowId = /flow=([0-9a-f-]{36})/.exec(location(published))?.[1]!;
    expect(packFlowId).toBeTruthy();

    const ownerUser = (
      await server.db.select({ id: users.id }).from(users).where(eq(users.username, 'flow-owner')).limit(1)
    )[0]!;
    const teamPolicy = await publishPolicy(server.db, ownerUser.id, {
      team: 'agent-pack-lab',
      document: policyDocumentSchema.parse({
        guidance: ['Keep deployment changes small and reversible.'],
        permissions: { deny: ['Never delete production data.'] },
        requiredChecks: ['npm test'],
        environment: { requiredEnvVarNames: ['DATABASE_URL'] },
      }),
    });
    expect('policy' in teamPolicy).toBe(true);
    const projectPolicy = await publishPolicy(server.db, ownerUser.id, {
      team: 'agent-pack-lab',
      project: 'payments-api',
      document: policyDocumentSchema.parse({
        permissions: { requireApproval: ['Changes under infra/payments/**.'] },
        protectedPaths: ['infra/payments/**'],
        autonomy: { requireApprovalFor: ['migration'] },
      }),
    });
    expect('policy' in projectPolicy).toBe(true);
    const effective = await effectivePolicy(server.db, ownerUser.id, {
      team: 'agent-pack-lab',
      project: 'payments-api',
    });
    expect('error' in effective).toBe(false);
    effectiveHash = 'error' in effective ? '' : effective.hash;
  });

  it('previews and downloads an English plan-only pack with exact effective project governance', async () => {
    const query = new URLSearchParams({
      flow: packFlowId,
      agent: 'preview',
      agentMode: 'plan-only',
      agentGovernance: 'effective',
    }).toString();
    const preview = await page(`/app/teams/agent-pack-lab/delivery?${query}`, owner);
    expect(preview.status).toBe(200);
    expect(preview.html).toContain('Send this flow to an agent');
    expect(preview.html).toContain('Project: payments-api');
    expect(preview.html).toContain('Agent setup Markdown');
    expect(preview.html).toContain('This is **plan-only**');
    expect(preview.html).toContain('Keep deployment changes small and reversible.');
    expect(preview.html).toContain('infra/payments/**');

    const download = await fetch(
      `${server.url}/app/teams/agent-pack-lab/delivery/agent-setup.md?${query}`,
      { headers: owner.header() },
    );
    const markdown = await download.text();
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(download.headers.get('cache-control')).toBe('private, no-store');
    expect(download.headers.get('x-content-type-options')).toBe('nosniff');
    expect(download.headers.get('content-disposition')).toContain(
      'stma-agent-pack-lab-payments-delivery-agent-setup.md',
    );
    expect(markdown).toContain('project: "payments-api"');
    expect(markdown).toContain(`governance_hash: "${effectiveHash}"`);
    expect(markdown).toContain('target_scope: "project:payments-api"');
    expect(markdown).toContain('governance_scope: "project:payments-api"');
    expect(markdown).toContain('Keep deployment changes small and reversible.');
    expect(markdown).toContain('Never delete production data.');
    expect(markdown).toContain('Changes under infra/payments/**.');
    expect(markdown).toContain('"DATABASE_URL"');
    expect(markdown).toContain('Run `az account show`');
    expect(markdown).not.toContain('DATABASE_URL=');
  });

  it('downloads an unpublished provider-specific blueprint without governance by default', async () => {
    const query = new URLSearchParams({
      template: 'preview-cd',
      provider: 'github-actions',
      agentProject: 'payments-api',
      agentMode: 'propose-then-apply',
    }).toString();
    const download = await fetch(
      `${server.url}/app/teams/agent-pack-lab/delivery/agent-setup.md?${query}`,
      { headers: owner.header() },
    );
    const markdown = await download.text();
    expect(download.status).toBe(200);
    expect(markdown).toContain('provider: "github-actions"');
    expect(markdown).toContain('project: "payments-api"');
    expect(markdown).toContain('Run `gh auth status`');
    expect(markdown).toContain('governance_hash: "not-included"');
    expect(markdown).toContain('governance_scope: "not-included"');
    expect(markdown).toContain('(an unpublished blueprint)');
  });

  it('refuses an unknown target project instead of silently falling back to team scope', async () => {
    const query = new URLSearchParams({
      template: 'preview-cd',
      provider: 'github-actions',
      agentProject: 'paymets-api',
    }).toString();
    const download = await fetch(
      `${server.url}/app/teams/agent-pack-lab/delivery/agent-setup.md?${query}`,
      { headers: owner.header() },
    );
    expect(download.status).toBe(400);
    expect(await download.text()).toContain('Project "paymets-api" is not available');
  });

  it('does not expose a setup pack to a user outside the team', async () => {
    const download = await fetch(
      `${server.url}/app/teams/agent-pack-lab/delivery/agent-setup.md?flow=${packFlowId}`,
      { headers: member.header() },
    );
    expect(download.status).toBe(404);
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
    expect(res.data.pipelineScaffold).toBe(true);
    expect(res.data.pipelineMissing.deployCommands).toEqual(['stage', 'uat', 'prod']);
    expect(res.data.note).toContain('still a scaffold');
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

describe('delivery inside a project', () => {
  // The owner, 2026-09-20: "knowledge governance delivery… bunlar across workspace
  // bir şey mi, proje bazlı mı, belli değil". Inside a project the page answers
  // which flow an agent there gets and whether it is the project's own.
  it('names the flow in effect and says whether it is the project\'s own or inherited', async () => {
    const own = await page('/app/teams/flow-lab/delivery?project=web-app', owner);
    expect(own.status).toBe(200);
    const card = own.html.slice(own.html.indexOf('id="flow-in-effect"'), own.html.indexOf('id="flow-in-effect"') + 1800);
    expect(card).toContain('In effect in web-app');
    expect(card).toContain('This project&#39;s own flow');
    expect(card).toContain('this project only');
    expect(card).toContain('Open Web flow v1');
    // The trail runs through the project, so "up" is the project and not the workspace list.
    expect(own.html).toContain('<a href="/app/teams/flow-lab/projects/web-app">web-app</a>');
    // A flow opened from here stays here.
    expect(card).toMatch(/delivery\?flow=[0-9a-f-]+&amp;project=web-app/);

    // A project with no flow of its own is told it inherits, and an owner is offered its own.
    expect((await form('/app/projects', { team: 'flow-lab', project: 'docs-site' }, owner)).status).toBe(302);
    const inherited = await page('/app/teams/flow-lab/delivery?project=docs-site', owner);
    const inheritedCard = inherited.html.slice(inherited.html.indexOf('id="flow-in-effect"'), inherited.html.indexOf('id="flow-in-effect"') + 1800);
    expect(inheritedCard).toContain('Inherited from the workspace');
    expect(inheritedCard).toContain('from the workspace');
    expect(inheritedCard).toContain('Open Company flow 2026');
    expect(inheritedCard).toContain('Give this project its own flow');
    // The designer it opens starts on this project and comes back to it.
    expect(inherited.html).toContain('name="scope_project" value="docs-site"');
    expect(inherited.html).toMatch(/<option value="[0-9a-f-]+" selected[^>]*>\s*Project: docs-site/);
    // A member sees the same answer without the offer to change it.
    const asMember = await page('/app/teams/flow-lab/delivery?project=docs-site', member);
    expect(asMember.html).toContain('Inherited from the workspace');
    expect(asMember.html).not.toContain('Give this project its own flow');
  });

  it('says on the workspace page who each flow applies to', async () => {
    const { html } = await page('/app/teams/flow-lab/delivery', owner);
    expect(html).not.toContain('id="flow-in-effect"');
    expect(html).toContain('<th>Applies to</th>');
    expect(html).toContain('web-app only');
    expect(html).toMatch(/every project without its own flow \(\d+ of \d+\)/);
  });

  it('returns a publish made inside a project to that project', async () => {
    const res = await form(
      '/app/teams/flow-lab/delivery',
      designerForm({ name: 'Web flow', scope: 'web-app', ticketRequired: '', scope_project: 'web-app' }),
      owner,
    );
    expect(res.status).toBe(302);
    expect(location(res)).toContain('Published');
    // Back to the page it was published from, at that page's own address.
    expect(location(res)).toContain('/app/teams/flow-lab/projects/web-app/delivery?');
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
    expect(pipelineIsScaffold(yaml)).toBe(true);
  });

  it('renders GitHub Actions jobs chained only inside the same trigger lane', () => {
    const { path: p, yaml } = renderPipeline(document, 'github-actions', { name: 'X', version: 1 });
    expect(p).toBe('.github/workflows/stma-flow.yml');
    expect(yaml).toContain('needs: checks');
    expect(yaml).not.toContain('needs: deploy_stage');
    expect(yaml).toContain("startsWith(github.ref, 'refs/tags/v')");
  });

  it('renders pull-request preview jobs as a separate event lane', () => {
    const preview = templateByKey('preview-cd')!.document;
    const azure = renderPipeline(preview, 'azure-devops', { name: 'Preview', version: 1 }).yaml;
    expect(azure).toContain("eq(variables['Build.Reason'], 'PullRequest')");
    expect(azure).toContain('dependsOn: checks');

    const github = renderPipeline(preview, 'github-actions', { name: 'Preview', version: 1 }).yaml;
    expect(github).toContain("if: github.event_name == 'pull_request'");
    expect(github).toContain('needs: checks');

    const brief = flowBrief(preview, { name: 'Preview', team: 'flow-lab' });
    expect(brief).toContain('preview (for each pull request)');
  });

  it('chains same-trigger environments and checks out source in every deployment job', () => {
    const manual = deliveryFlowSchema.parse({
      ...document,
      environments: [
        { name: 'uat', deployOn: 'manual', approval: false, command: './deploy uat' },
        { name: 'prod', deployOn: 'manual', approval: true, command: './deploy prod' },
      ],
    });
    const github = renderPipeline(manual, 'github-actions', { name: 'Manual', version: 1 }).yaml;
    expect(github).toContain('needs: deploy_uat');
    expect(github.match(/uses: actions\/checkout@v4/g)).toHaveLength(3);

    const azure = renderPipeline(manual, 'azure-devops', { name: 'Manual', version: 1 }).yaml;
    expect(azure).toContain('dependsOn: deploy_uat');
    expect(azure.match(/checkout: self/g)).toHaveLength(2);
  });

  it('renders real deploy commands once and stops calling the result a scaffold', () => {
    const ready = deliveryFlowSchema.parse({
      ...document,
      environments: [
        { name: 'stage', deployOn: 'merge', approval: false, command: 'npm run deploy:stage' },
        { name: 'prod', deployOn: 'tag', approval: true, command: './scripts/deploy prod' },
      ],
    });
    for (const provider of ['azure-devops', 'github-actions'] as const) {
      const pipeline = renderPipeline(ready, provider, { name: 'Ready', version: 1 });
      expect(pipeline.yaml).toContain('npm run deploy:stage');
      expect(pipeline.yaml).toContain('./scripts/deploy prod');
      expect(pipelineIsScaffold(pipeline)).toBe(false);
    }
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

  it('uses the exact repository binding for a project-scoped flow without creating a duplicate project', async () => {
    adoOutbox.clear();
    const created = await form('/app/teams', { name: 'Bound Delivery Lab' }, owner);
    expect(created.status).toBe(302);
    await form(
      '/app/teams/bound-delivery-lab/integrations/azure-devops',
      { action: 'save', locator: 'matte/stma/stma-repo', token: 'ado-bound-pat' },
      owner,
    );
    const [workspace] = await server.db
      .select()
      .from(teams)
      .where(eq(teams.slug, 'bound-delivery-lab'));
    const [ownerUser] = await server.db
      .select()
      .from(users)
      .where(eq(users.username, 'flow-owner'));
    const [connection] = await server.db
      .select()
      .from(teamIntegrations)
      .where(
        and(
          eq(teamIntegrations.teamId, workspace!.id),
          eq(teamIntegrations.provider, 'azure-devops'),
          eq(teamIntegrations.repo, 'matte/stma/stma-repo'),
        ),
      );
    const [project] = await server.db
      .insert(projects)
      .values({
        teamId: workspace!.id,
        name: 'Bound delivery',
        slug: 'bound-delivery',
        repositoryIdentity: 'dev.azure.com/matte/stma/_git/stma-repo',
        createdBy: ownerUser!.id,
      })
      .returning();
    await server.db.insert(repositoryBindings).values({
      connectionId: connection!.id,
      teamId: workspace!.id,
      projectId: project!.id,
      provider: 'azure-devops',
      repositoryId: 'ado-bound-delivery-repo',
      fullName: 'matte/stma/stma-repo',
      verifiedAt: new Date(),
    });

    const published = await form(
      '/app/teams/bound-delivery-lab/delivery',
      designerForm({
        name: 'Bound delivery flow',
        scope: project!.id,
        environments: 'stage = merge => npm run deploy:stage',
      }),
      owner,
    );
    const boundFlowId = /flow=([0-9a-f-]{36})/.exec(location(published))?.[1]!;
    const scopedProjects = await server.db
      .select()
      .from(projects)
      .where(and(eq(projects.teamId, workspace!.id), eq(projects.name, 'Bound delivery')));
    expect(scopedProjects).toHaveLength(1);

    const detail = await page(
      `/app/teams/bound-delivery-lab/delivery?flow=${boundFlowId}`,
      owner,
    );
    expect(detail.html).toContain('Apply pipeline');
    expect(detail.html).not.toContain('Connect Azure DevOps to apply this pipeline');

    const applied = await form(
      `/app/teams/bound-delivery-lab/delivery/${boundFlowId}/apply`,
      {},
      owner,
    );
    expect(location(applied)).toContain('Committed azure-pipelines.yml on main');
    expect(adoOutbox.pushes()).toHaveLength(1);
    adoOutbox.clear();
  });

  it('commits the pipeline file and registers the pipeline, in wire shape', async () => {
    adoOutbox.clear();
    const { html } = await page('/app/teams/flow-lab/delivery', owner);
    const [workspace] = await server.db.select().from(teams).where(eq(teams.slug, 'flow-lab'));
    const [unscoped] = await server.db.select().from(deliveryFlows).where(and(eq(deliveryFlows.teamId, workspace!.id), isNull(deliveryFlows.projectId), eq(deliveryFlows.status, 'active')));
    flowId = unscoped!.id; // Explicitly test the workspace flow, never an arbitrary project's repository.
    expect(flowId).toBeTruthy();

    // The legacy/direct apply shape must not pass a placeholder pipeline off as
    // complete setup. Committing the draft remains available as an explicit,
    // honestly labelled scaffold action.
    const refused = await form(`/app/teams/flow-lab/delivery/${flowId}/apply`, {}, owner);
    expect(location(refused)).toContain('placeholder deploy steps');
    expect(adoOutbox.pushes()).toHaveLength(0);

    const res = await form(
      `/app/teams/flow-lab/delivery/${flowId}/apply`,
      { mode: 'scaffold' },
      owner,
    );
    expect(location(res)).toContain('Committed pipeline scaffold azure-pipelines.yml on main');
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
    const res = await form(
      `/app/teams/flow-lab/delivery/${flowId}/apply`,
      { mode: 'scaffold' },
      owner,
    );
    expect(location(res)).toContain('Updated pipeline scaffold azure-pipelines.yml');
    const push = adoOutbox.pushes()[0]!.body as any;
    expect(push.commits[0].changes[0].changeType).toBe('edit');
    adoOutbox.clear();
  });

  it('lets only an owner apply', async () => {
    const res = await form(
      `/app/teams/flow-lab/delivery/${flowId}/apply`,
      { mode: 'scaffold' },
      member,
    );
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
    const [workspace] = await server.db.select().from(teams).where(eq(teams.slug, 'flow-lab'));
    const [webFlow] = await server.db
      .select()
      .from(deliveryFlows)
      .where(
        and(
          eq(deliveryFlows.teamId, workspace!.id),
          eq(deliveryFlows.name, 'Web flow'),
          eq(deliveryFlows.status, 'active'),
        ),
      )
      .limit(1);
    const flowId = webFlow!.id;
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
    const res = await form(
      `/app/teams/flow-lab/delivery/${flowId}/apply`,
      { mode: 'scaffold' },
      owner,
    );
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
    const res = await form(
      `/app/teams/flow-lab/delivery/${flowId}/apply`,
      { mode: 'scaffold' },
      owner,
    );
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
    const res = await form(
      `/app/teams/flow-lab/delivery/${flowId}/apply`,
      { mode: 'scaffold' },
      owner,
    );
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
      designerForm({
        name: 'Lab flow',
        environments:
          'stage = merge => npm run deploy:stage\nuat = manual, approval => ./scripts/deploy uat\nprod = manual, approval => ./scripts/deploy prod',
      }),
      owner,
    );
    const flowId = /flow=([0-9a-f-]{36})/.exec(location(published))?.[1]!;

    const before = await page(`/app/teams/pipeline-lab/delivery?flow=${flowId}`, owner);
    expect(before.html).toContain('pipeline content ready');
    expect(before.html).toContain('Every deployment environment has a real command');
    expect(before.html).toContain('Connect Azure DevOps to apply this pipeline');
    expect(before.html).toContain('How to create this token');

    const connect = await form(
      '/app/teams/pipeline-lab/integrations/azure-devops',
      {
        action: 'save',
        locator: 'matte/lab/lab-repo',
        token: 'lab-pat',
        return_to: 'delivery',
        flow_id: flowId,
      },
      owner,
    );
    const dest = connect.headers.get('location') ?? '';
    expect(dest.startsWith('/app/teams/pipeline-lab/delivery?')).toBe(true);
    expect(dest).toContain(`flow=${flowId}`);
    expect(decodeURIComponent(dest)).toContain('verified');

    const after = await page(dest, owner);
    expect(after.html).toContain('Apply pipeline');
    adoOutbox.clear();
    const applied = await form(
      `/app/teams/pipeline-lab/delivery/${flowId}/apply`,
      {},
      owner,
    );
    expect(location(applied)).toContain('Committed azure-pipelines.yml on main');
    expect(location(applied)).not.toContain('scaffold');
    expect(adoOutbox.pushes()).toHaveLength(1);
    const workflow = await call('get_workflow', { team: 'pipeline-lab' }, ownerToken);
    expect(workflow.data.pipelineScaffold).toBe(false);
    expect(workflow.data.pipelineMissing).toEqual({ checks: false, deployCommands: [] });
    expect(workflow.data.brief).toContain('Deploy command for stage: npm run deploy:stage.');
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
