/**
 * A demo workspace for one account, written by the product itself.
 *
 * Claude's connector directory reviews a connector through a test account it
 * asks to be "fully populated", and a reviewer who connects to an empty
 * workspace can only learn that the tools answer "nothing yet". The operator
 * presses one button on the account's admin page and this leaves behind a
 * workspace somebody can ask real questions of: three agents on three
 * machines, published rules, reference knowledge, the environment difference
 * between two machines, a finished piece of work, a problem solved before, a
 * handoff and an assignment waiting, and a question still open.
 *
 * Like the agent lab's past (`acceptance/agent-lab/past.mjs`), nothing here is
 * inserted into a table by hand. The agents' part goes through `/mcp`, under
 * each agent's own credential, over this server's own socket, so every row is
 * what those tools write for any agent. The lead's part (the workspace, the
 * project, the connections, the rules, the knowledge and the assignments) goes
 * through the same functions the console's forms call. A page that counted any
 * of it wrongly would count it wrongly for the reviewer too, which is the
 * point: the demo shows the product, not a picture of it.
 *
 * It is for an account with no workspace yet, so it is always that account's
 * first and pressing the button twice cannot pile demos up. The plan is data,
 * with literal request ids, so every demo tells the same story. The agents'
 * credentials exist only while this runs: the installations stay connected
 * (they are who the reviewer's Claude can give work to) and nobody holds a
 * token for them afterwards.
 */
import { randomUUID } from 'node:crypto';
import { parseContentRule, policyDocumentSchema, snapshotSchema, type PolicyDocument } from '@bridge/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db';
import { memberships, teams } from '../db/schema';
import type { Env } from '../env';
import type { AppLifecycleHooks } from '../extensions';
import { randomCode, randomHex } from '../lib/crypto';
import { logLine } from '../lib/log';
import { recordMembershipChange } from '../lib/memberships';
import { findOrCreateProject } from '../lib/projects';
import { slugify } from '../lib/slug';
import { assignableAgents, handoffAllowance, writeAssignment, type AssignmentDraft } from './assignments';
import { saveDeliveryFlow } from './delivery';
import { createAgentEnrollment, redeemAgentEnrollment } from './enrollments';
import { setEnvironmentBaseline } from './environments';
import { FLOW_TEMPLATES } from './flowTemplates';
import { hostedKnowledgeCapacityLimits, proposeKnowledge, publishKnowledge } from './knowledge';
import { publishPolicy } from './policies';

export const DEMO_WORKSPACE = 'Parcel Desk';
export const DEMO_PROJECT = 'parcel-desk';
/** A host that cannot be anybody's repository, so no real one is ever implied. */
export const DEMO_REPOSITORY = 'https://git.example.com/acme/parcel-desk.git';
const HEAD = '4f1c2a9e8b7d6c5f4e3a2b1c0d9e8f7a6b5c4d3e';
const HANDED_OVER = '9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b';

/** One person, three agents, three machines: the common shape, and nobody invented to fill a team. */
export const DEMO_AGENTS = [
  { key: 'mac', name: 'claude-code', device: 'macbook', client: 'claude-code' },
  { key: 'desk', name: 'codex', device: 'desktop', client: 'codex' },
  { key: 'laptop', name: 'cursor', device: 'thinkpad', client: 'cursor' },
] as const;
type AgentKey = (typeof DEMO_AGENTS)[number]['key'];

export const DEMO_POLICY: PolicyDocument = policyDocumentSchema.parse({
  guidance: [
    'Keep each change small and on its own branch; the pull request is where it is reviewed.',
    'Run npm test before handing work to another agent, and say in the handoff whether it passed.',
  ],
  permissions: {
    deny: [
      'content: "Comic Sans" in public/** — the dashboard uses the brand typeface only',
      'Force-pushing to main',
      'Committing .env files or any credential',
    ],
    requireApproval: ['Changing a database migration', 'Adding a production dependency'],
  },
  requiredChecks: ['npm test'],
  protectedPaths: ['db/migrations/**', '.github/workflows/**'],
  environment: {
    requiredEnvVarNames: ['CARRIER_API_KEY', 'DATABASE_URL', 'LABEL_PRINTER_PORT'],
    runtimes: { node: '22.4.0' },
  },
});

/** How work moves here, from the console's own blueprint library. */
export const DEMO_FLOW_TEMPLATE = 'trunk-pr';

export const DEMO_KNOWLEDGE = [
  {
    stableKey: 'runbooks/deploy',
    kind: 'procedure',
    title: 'Deploying parcel-desk',
    body: [
      'Merges to main deploy to staging automatically. Production follows a tag.',
      '',
      '1. Make sure the pull request is merged and CI is green on main.',
      '2. Tag the merge commit: `git tag v1.8.0 && git push --tags`.',
      '3. Watch the release job; it runs the migrations before it swaps traffic.',
      '4. Check `/health` reports the new version, then post in the release thread.',
      '',
      'Never run migrations by hand against production; the release job holds the lock.',
    ].join('\n'),
  },
  {
    stableKey: 'printers/label-port',
    kind: 'known_solution',
    title: 'Label printer times out on Windows',
    body: [
      'Symptom: printing a shipping label hangs for 30 seconds and fails with ETIMEDOUT, on Windows only.',
      '',
      'Cause: LABEL_PRINTER_PORT is not set, so the driver falls back to scanning every COM port.',
      '',
      'Fix: set LABEL_PRINTER_PORT to the port the printer is on (Device Manager shows it, usually COM3) and restart the dev server.',
    ].join('\n'),
  },
] as const;

/** What `get_snapshot_checklist` asks an agent to collect, for the two machines that differ. */
function demoSnapshots(now: Date) {
  const collectedAt = now.toISOString();
  return {
    desk: {
      os: { platform: 'win32', release: '10.0.22631', arch: 'x64' },
      shell: 'pwsh 7.4.5',
      runtimes: { node: '20.11.1' },
      packageManagers: { npm: '10.2.4' },
      lockfiles: [{ path: 'package-lock.json', hash: '3b18e512dba79e4c8300dd08aeb37f8e728b8dad' }],
      envVarNames: ['CARRIER_API_KEY', 'DATABASE_URL', 'LABEL_PRINTER_PORT'],
      git: { branch: 'main', sha: HEAD, dirtyFiles: [] },
      locale: 'en-US',
      timezone: 'Europe/Berlin',
      collectedAt,
    },
    mac: {
      os: { platform: 'darwin', release: '24.6.0', arch: 'arm64' },
      shell: 'zsh 5.9',
      runtimes: { node: '22.4.0' },
      packageManagers: { npm: '10.8.1' },
      lockfiles: [{ path: 'package-lock.json', hash: 'c9e0a6f13d5b7f24e8a1d2c3b4a59687e0f1a2b3' }],
      envVarNames: ['CARRIER_API_KEY', 'DATABASE_URL'],
      git: { branch: 'main', sha: HEAD, dirtyFiles: [] },
      locale: 'en-GB',
      timezone: 'Europe/London',
      collectedAt,
    },
  };
}

/** Work the lead gave out. The first is done; the last is still waiting for its agent. */
export const DEMO_ASSIGNMENTS = [
  {
    key: 'eta',
    task: 'PD-18 Round carrier ETAs to the minute',
    to: 'mac',
    brief: 'Carrier ETAs are rounded down to the half hour, so a parcel due at 14:29 shows 14:00. Round to the nearest minute and keep the backend tests green.',
    steps: ['Read the project rules from STMA first', 'Fix and test', 'Report back'],
  },
  {
    key: 'csv',
    task: 'PD-31 Add CSV export to the parcel list',
    to: 'laptop',
    brief: 'Operations wants to download the filtered parcel list as CSV for the carrier reconciliation. One button above the table; the export follows the filters on screen.',
    steps: ['Read the project rules from STMA first', 'Add the export and a test', 'Open a pull request'],
  },
] as const;

const REQUEST = {
  etaRun: 'd3a1b2c4-0018-4a5b-8c6d-0e1f2a3b4c5d',
  labelRun: 'd3a1b2c4-0027-4a5b-8c6d-0e1f2a3b4c5d',
  handoff: 'd3a1b2c4-1027-4a5b-8c6d-0e1f2a3b4c5d',
  checkpoint: 'd3a1b2c4-2027-4a5b-8c6d-0e1f2a3b4c5d',
};

export interface DemoWorkspaceResult {
  team: { id: string; slug: string; name: string };
  agents: string[];
}

interface DemoInput {
  db: Db;
  env: Env;
  lifecycle: AppLifecycleHooks;
  operator: { id: string; username: string };
  account: { id: string; username: string };
  /** This server's own origin, reached over loopback; the agents talk to `/mcp` there. */
  origin: string;
}

/** Why this account cannot be given the demo, or null. */
export async function demoWorkspaceRefusal(db: Db, accountId: string): Promise<string | null> {
  const held = await db.select({ teamId: memberships.teamId }).from(memberships).where(eq(memberships.userId, accountId));
  if (held.length > 0) {
    return `The demo is an account's first workspace, and this account already belongs to ${held.length === 1 ? 'one' : held.length}.`;
  }
  return null;
}

class DemoStepFailed extends Error {}

let rpcId = 1;

/** One tool call under one demo agent's credential. A refusal stops the demo at that step. */
async function call(origin: string, token: string, tool: string, args: Record<string, unknown>) {
  const response = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    result?: { content?: Array<{ text?: string }>; isError?: boolean };
    error?: { message?: string };
  };
  const text = body.result?.content?.[0]?.text ?? body.error?.message ?? `HTTP ${response.status}`;
  if (!response.ok || body.error || body.result?.isError) {
    throw new DemoStepFailed(`${tool} was refused: ${String(text).replace(/\s+/g, ' ').slice(0, 240)}`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { text };
  }
}

/**
 * The receipt a hooked agent files on its own: the policy `start_run` served,
 * confirmed by its hash, so Governance reads the demo's runs as following the
 * rules rather than as runs nobody confirmed.
 */
async function confirmPolicy(origin: string, token: string, run: Record<string, unknown>) {
  const served = (run.policy as { hash?: string } | undefined)?.hash;
  const hinted = /"policy_hash":"([0-9a-f]+)"/.exec(String(run.policyHint ?? ''))?.[1];
  const hash = served ?? hinted;
  if (!hash) throw new DemoStepFailed('start_run served no policy to confirm');
  await call(origin, token, 'update_run', { run_id: run.runId, policy_hash: hash });
}

/**
 * Build the demo. Returns what it made, or the step that stopped it; a stopped
 * demo leaves the workspace it had made so far, which its owner can delete.
 */
export async function seedDemoWorkspace(input: DemoInput): Promise<DemoWorkspaceResult | { error: string }> {
  const { db, env, operator, account, origin } = input;
  const refused = await demoWorkspaceRefusal(db, account.id);
  if (refused) return { error: refused };

  // The workspace, as the New workspace form makes one, owned by the account.
  let slug = slugify(DEMO_WORKSPACE);
  const taken = await db.select({ id: teams.id }).from(teams).where(eq(teams.slug, slug)).limit(1);
  if (taken.length > 0) slug = `${slug}-${randomHex(2)}`;
  const team = (
    await db
      .insert(teams)
      .values({ name: DEMO_WORKSPACE, slug, createdBy: account.id, inboundToken: randomCode(16) })
      .returning()
  )[0]!;
  await db.insert(memberships).values({ teamId: team.id, userId: account.id, role: 'owner' });
  await recordMembershipChange(db, {
    teamId: team.id,
    teamSlug: team.slug,
    action: 'added',
    subjectId: account.id,
    subjectLabel: account.username,
    previousRole: null,
    nextRole: 'owner',
    source: 'operator',
    route: 'POST /admin/users/:id/demo-workspace',
    actorId: operator.id,
    actorLabel: operator.username,
    detail: 'created the demo workspace',
  });
  await input.lifecycle.teamMemberCountChanged?.({ db, teamId: team.id });
  const made = { id: team.id, slug: team.slug, name: team.name };

  try {
    const found = await findOrCreateProject(db, team, DEMO_PROJECT, account.id, DEMO_REPOSITORY);
    if ('error' in found) throw new DemoStepFailed(found.error);
    const project = found.project;

    // The rules and the reference, as an owner publishes them from the console.
    const policy = await publishPolicy(db, account.id, { team: team.slug, document: DEMO_POLICY });
    if ('error' in policy) throw new DemoStepFailed(policy.error ?? 'the policy was not published');
    const template = FLOW_TEMPLATES.find((candidate) => candidate.key === DEMO_FLOW_TEMPLATE)!;
    const flow = await saveDeliveryFlow(db, account.id, {
      team: team.slug,
      name: template.name,
      templateKey: template.key,
      provider: 'github-actions',
      document: template.document,
    });
    if ('error' in flow) throw new DemoStepFailed(flow.error ?? 'the delivery flow was not published');
    const limits = hostedKnowledgeCapacityLimits(env);
    const reviewAfter = new Date(Date.now() + 90 * 86_400_000).toISOString();
    for (const item of DEMO_KNOWLEDGE) {
      const draft = await proposeKnowledge(
        db,
        account.id,
        {
          team: team.slug,
          stableKey: item.stableKey,
          kind: item.kind,
          title: item.title,
          body: item.body,
          audience: { type: 'workspace_members' },
          source: { type: 'native' },
          reviewAfter,
        },
        undefined,
        limits,
      );
      if ('error' in draft) throw new DemoStepFailed(draft.error ?? `${item.title} was not saved`);
      const published = await publishKnowledge(
        db,
        account.id,
        {
          team: team.slug,
          itemId: draft.draft.itemId,
          draftVersionId: draft.draft.versionId,
          expectedCurrentVersionId: draft.draft.expectedCurrentVersionId,
        },
        limits,
      );
      if ('error' in published) throw new DemoStepFailed(published.error ?? `${item.title} was not published`);
    }

    // The agents, connected the way a browser consent connects one: a
    // project-only enrollment, redeemed, then confirmed by the client's first call.
    const tokens = new Map<AgentKey, string>();
    const installations = new Map<AgentKey, string>();
    for (const agent of DEMO_AGENTS) {
      const enrollment = await createAgentEnrollment(db, {
        userId: account.id,
        name: agent.name,
        deviceLabel: agent.device,
        clientType: agent.client,
        role: 'generalist',
        scope: 'project',
        teamId: team.id,
        projectId: project.id,
      });
      const redeemed = await redeemAgentEnrollment(db, enrollment.code);
      if (!redeemed.ok) throw new DemoStepFailed(`${agent.name} could not be connected`);
      tokens.set(agent.key, redeemed.value.token);
      installations.set(agent.key, redeemed.value.installation.id);
      await call(origin, redeemed.value.token, 'whoami', {});
    }
    const as = (key: AgentKey) => tokens.get(key)!;
    const via = (key: AgentKey) => DEMO_AGENTS.find((agent) => agent.key === key)!.name;

    // Two machines that disagree: the desktop is a Node major behind and has
    // the one variable the Mac is missing.
    const snapshots = demoSnapshots(new Date());
    await call(origin, as('desk'), 'push_snapshot', { device: 'desktop', repo: DEMO_PROJECT, snapshot: snapshots.desk });
    await call(origin, as('mac'), 'push_snapshot', { device: 'macbook', repo: DEMO_PROJECT, snapshot: snapshots.mac });
    // The Mac is the machine that works, so the owner promotes its snapshot to
    // the project's baseline, as Governance does from a pushed snapshot.
    const baseline = await setEnvironmentBaseline(
      db,
      account.id,
      { team: team.slug, project: DEMO_PROJECT, snapshot: snapshotSchema.parse(snapshots.mac) },
      project.id,
    );
    if ('error' in baseline) throw new DemoStepFailed(baseline.error ?? 'the baseline was not recorded');

    // Work the lead gave out, as the project page's Assign work form gives it.
    const agents = await assignableAgents(db, team.id);
    const assigned = new Map<string, string>();
    for (const work of DEMO_ASSIGNMENTS) {
      const allowance = await handoffAllowance(db, env, team);
      if ('error' in allowance) throw new DemoStepFailed(allowance.error);
      const agent = agents.find((candidate) => candidate.installationId === installations.get(work.to));
      if (!agent) throw new DemoStepFailed(`${via(work.to)} is not offered as an agent to give work to`);
      const draft: AssignmentDraft = {
        team: { id: team.id, slug: team.slug },
        project: { id: project.id, name: project.name, repositoryIdentity: project.repositoryIdentity },
        agent,
        assignedBy: { id: account.id, username: account.username, tokenId: null, via: null },
        task: work.task,
        brief: work.brief,
        steps: [...work.steps],
        branch: null,
        scope: [],
      };
      const created = await db.transaction(async (tx) =>
        writeAssignment(tx as unknown as Db, env, draft, { sessionId: randomUUID(), handoffId: randomUUID() }),
      );
      assigned.set(work.key, created.sessionId);
      if (work.key === 'eta') {
        // Done: accepted, worked in a run of its own, completed and closed.
        const run = await call(origin, as('mac'), 'start_run', {
          request_id: REQUEST.etaRun,
          repository_identity: DEMO_REPOSITORY,
          task: work.task,
          intent: 'Round carrier ETAs to the nearest minute.',
          head_sha: HEAD,
          scope: [{ type: 'path', key: 'src/carrier.mjs', access: 'write' }],
          agent: via('mac'),
        });
        await confirmPolicy(origin, as('mac'), run);
        for (const action of ['accept', 'resume', 'complete']) {
          await call(origin, as('mac'), 'update_handoff', { session_id: created.sessionId, action, run_id: run.runId });
        }
        await call(origin, as('mac'), 'finish_run', {
          run_id: run.runId,
          status: 'completed',
          note: 'PD-18: ETAs round to the nearest minute; backend tests pass.',
        });
      }
    }

    // A problem the team solved before, so the next machine that hits it can find it.
    const printer = await call(origin, as('desk'), 'open_session', {
      title: 'Label printer times out on Windows',
      body: 'Printing a shipping label hangs for about 30 seconds and then fails with ETIMEDOUT. Only on the desktop; the Mac prints fine from the same branch.',
    });
    await call(origin, as('mac'), 'post_message', {
      session_id: printer.sessionId,
      body: 'Comparing our snapshots: the desktop has LABEL_PRINTER_PORT and I do not, but I print over the network. Is the desktop value pointing at the right COM port?',
      kind: 'hypothesis',
    });
    await call(origin, as('desk'), 'resolve_session', {
      session_id: printer.sessionId,
      root_cause: 'LABEL_PRINTER_PORT pointed at COM1 after the dock was replaced, so the driver scanned every port before giving up.',
      fix: 'Set LABEL_PRINTER_PORT=COM3 (Device Manager shows the port) and restarted the dev server. Recorded in Knowledge as a known solution.',
    });

    // Work handed from one machine to another at the end of a day, with the
    // tested commit it continues from. Nobody has picked it up yet.
    const labelRun = await call(origin, as('desk'), 'start_run', {
      request_id: REQUEST.labelRun,
      repository_identity: DEMO_REPOSITORY,
      task: 'PD-27 Retry label printing when the printer is busy',
      intent: 'Retry a busy label printer three times with backoff instead of failing the shipment.',
      head_sha: HEAD,
      scope: [
        { type: 'path', key: 'src/labels.mjs', access: 'write' },
        { type: 'path', key: 'test/labels.test.mjs', access: 'write' },
      ],
      agent: via('desk'),
    });
    await confirmPolicy(origin, as('desk'), labelRun);
    await call(origin, as('desk'), 'handoff_work', {
      request_id: REQUEST.handoff,
      run_id: labelRun.runId,
      branch: 'pd-27-label-retry',
      summary: 'Retries with backoff are in src/labels.mjs and covered by two new tests, both passing. What is left is the operator-facing message when all three attempts fail.',
      next_steps: [
        'Check out pd-27-label-retry',
        'Show "Printer busy, retrying" in the shipment panel while a retry is pending',
        'Run npm test, push to the same branch and open the pull request',
      ],
      reason: 'end_of_day',
      to_agent: via('mac'),
      device: 'macbook',
      checkpoint: {
        request_id: REQUEST.checkpoint,
        kind: 'tested',
        repository_identity: DEMO_REPOSITORY,
        commit_sha: HANDED_OVER,
        worktree_clean: true,
        tests: [{ name: 'npm test', state: 'passed', detail: '41 passed' }],
      },
      via: via('desk'),
    });

    // A question still open, which is what a thread with replies is for.
    await call(origin, as('laptop'), 'open_session', {
      title: 'Should the CSV export include cancelled parcels?',
      body: 'PD-31 says the export follows the filters on screen, and the default filter hides cancelled parcels. Carrier reconciliation might need them anyway. Which one do we want?',
    });

    logLine({
      evt: 'admin',
      a: 'demo_workspace',
      u: operator.username,
      target: account.username,
      team: team.slug,
      assignments: assigned.size,
    });
    return { team: made, agents: DEMO_AGENTS.map((agent) => `${agent.name} on ${agent.device}`) };
  } catch (error) {
    const reason = error instanceof DemoStepFailed ? error.message : error instanceof Error ? error.message : String(error);
    logLine({ evt: 'admin', a: 'demo_workspace_failed', u: operator.username, target: account.username, team: team.slug });
    return {
      error: `The demo stopped partway: ${reason} Workspace ${team.slug} keeps what was made; its owner can delete it.`,
    };
  }
}

/** The demo's content rule has to be one the guard can read, or it guards nothing. */
export function demoContentRuleParses(): boolean {
  return DEMO_POLICY.permissions.deny.filter((line) => line.startsWith('content:')).every((line) => parseContentRule(line) !== null);
}
