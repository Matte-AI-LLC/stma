import {
  deliveryFlowSchema,
  FLOW_PROVIDERS,
  type DeliveryFlow,
  type FlowProvider,
} from '@bridge/shared';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { deliveryFlows, projects, users } from '../db/schema';
import { findOrCreateProject } from '../lib/projects';
import { projectForTeam, teamForUser } from './access';

/**
 * Delivery flows: the team's "how work moves here" document as data.
 *
 * One document, three renderings — prose for agents (the brief), a picture for
 * people (ui/FlowDiagram), and YAML for the CI provider — all derived on read.
 * The rule that keeps this honest is the same one policy follows: what is
 * stored is what somebody decided, never a cached rendering of it.
 */

export type FlowRow = typeof deliveryFlows.$inferSelect;

const sameScope = (teamId: string, projectId: string | null) =>
  and(
    eq(deliveryFlows.teamId, teamId),
    projectId === null ? isNull(deliveryFlows.projectId) : eq(deliveryFlows.projectId, projectId),
    eq(deliveryFlows.status, 'active'),
  );

export async function saveDeliveryFlow(
  db: Db,
  userId: string,
  input: {
    team: string;
    project?: string;
    name: string;
    templateKey: string;
    provider: string;
    document: unknown;
    /** Updating this flow in place; otherwise a new one is created. */
    flowId?: string;
  },
) {
  const access = await teamForUser(db, userId, input.team);
  if (!access || access.role !== 'owner') {
    return { error: 'Only a team owner can publish a delivery flow.' } as const;
  }
  const provider = FLOW_PROVIDERS.includes(input.provider as FlowProvider)
    ? (input.provider as FlowProvider)
    : undefined;
  if (!provider) return { error: `Unknown provider "${input.provider}".` } as const;
  const parsed = deliveryFlowSchema.safeParse(input.document);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: `${issue?.path.join('.') || 'document'}: ${issue?.message ?? 'invalid'}` } as const;
  }
  const name = input.name.trim();
  if (!name) return { error: 'The flow needs a name.' } as const;

  let projectId: string | null = null;
  if (input.project) {
    const found = await findOrCreateProject(db, access.team, input.project, userId);
    if ('error' in found) return { error: found.error } as const;
    projectId = found.project.id;
  }

  if (input.flowId) {
    const rows = await db
      .update(deliveryFlows)
      .set({
        name,
        provider,
        document: parsed.data,
        projectId,
        updatedAt: new Date(),
        // A cheap edit counter, not a history: the activity feed carries the trail.
        version: (await currentVersion(db, input.flowId, access.team.id)) + 1,
      })
      .where(and(eq(deliveryFlows.id, input.flowId), eq(deliveryFlows.teamId, access.team.id)))
      .returning();
    const row = rows[0];
    return row ? ({ flow: row } as const) : ({ error: 'That flow is not in this team.' } as const);
  }

  // One active flow per scope: the previous answer to "how does work move
  // here" is archived, not deleted — it stays readable in the table.
  await db
    .update(deliveryFlows)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(sameScope(access.team.id, projectId));
  const rows = await db
    .insert(deliveryFlows)
    .values({
      teamId: access.team.id,
      projectId,
      name,
      templateKey: input.templateKey,
      provider,
      document: parsed.data,
      createdBy: userId,
    })
    .returning();
  return { flow: rows[0]! } as const;
}

async function currentVersion(db: Db, flowId: string, teamId: string): Promise<number> {
  const rows = await db
    .select({ version: deliveryFlows.version })
    .from(deliveryFlows)
    .where(and(eq(deliveryFlows.id, flowId), eq(deliveryFlows.teamId, teamId)))
    .limit(1);
  return rows[0]?.version ?? 1;
}

export async function archiveDeliveryFlow(db: Db, userId: string, team: string, flowId: string) {
  const access = await teamForUser(db, userId, team);
  if (!access || access.role !== 'owner') {
    return { error: 'Only a team owner can archive a delivery flow.' } as const;
  }
  const rows = await db
    .update(deliveryFlows)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(and(eq(deliveryFlows.id, flowId), eq(deliveryFlows.teamId, access.team.id)))
    .returning();
  return rows[0] ? ({ flow: rows[0] } as const) : ({ error: 'That flow is not in this team.' } as const);
}

/** Every flow in a team, active first then newest, bounded. */
export async function listDeliveryFlows(db: Db, teamId: string, limit = 25) {
  return db
    .select({ flow: deliveryFlows, projectName: projects.name, author: users.username })
    .from(deliveryFlows)
    .leftJoin(projects, eq(deliveryFlows.projectId, projects.id))
    .leftJoin(users, eq(deliveryFlows.createdBy, users.id))
    .where(eq(deliveryFlows.teamId, teamId))
    .orderBy(
      sql`case when ${deliveryFlows.status} = 'active' then 0 else 1 end`,
      desc(deliveryFlows.updatedAt),
    )
    .limit(limit);
}

/**
 * The flow an agent in this team+project should follow: the project's own
 * active flow when one exists, the team-wide one otherwise. Same precedence as
 * policy, because an agent that has learned one scoping rule should not need a
 * second.
 */
export async function activeFlowFor(
  db: Db,
  teamId: string,
  projectName?: string,
): Promise<{ flow: FlowRow; projectName: string | null } | undefined> {
  if (projectName) {
    const project = await projectForTeam(db, teamId, projectName);
    if (project) {
      const rows = await db
        .select()
        .from(deliveryFlows)
        .where(sameScope(teamId, project.id))
        .orderBy(desc(deliveryFlows.updatedAt))
        .limit(1);
      if (rows[0]) return { flow: rows[0], projectName: project.name };
    }
  }
  const rows = await db
    .select()
    .from(deliveryFlows)
    .where(sameScope(teamId, null))
    .orderBy(desc(deliveryFlows.updatedAt))
    .limit(1);
  return rows[0] ? { flow: rows[0], projectName: null } : undefined;
}

export const parseFlowDocument = (raw: unknown): DeliveryFlow => deliveryFlowSchema.parse(raw);

// ------------------------------------------------------------------ renderings

const TICKET_WORDS: Record<string, string> = {
  jira: 'a Jira ticket',
  github: 'a GitHub issue',
  'azure-boards': 'an Azure Boards work item',
  none: 'no tracker',
};

const TRIGGER_WORDS: Record<string, string> = {
  merge: 'automatically on merge',
  tag: 'on a version tag',
  manual: 'manually',
};

/**
 * The flow as the prose an agent (or a new teammate) reads — the onboarding
 * document the team lead used to hand out, generated so it cannot drift from
 * the flow the pipeline enforces.
 */
export function flowBrief(
  flow: DeliveryFlow,
  ctx: { name: string; team: string; project?: string | null },
): string {
  const lines: string[] = [];
  lines.push(
    `## Delivery workflow — ${ctx.name} (team ${ctx.team}${ctx.project ? `, project ${ctx.project}` : ''})`,
  );
  if (flow.intro) lines.push(flow.intro);
  if (flow.ticket.system !== 'none') {
    lines.push(
      `Work starts from ${TICKET_WORDS[flow.ticket.system]}${
        flow.ticket.keyPattern ? ` (key like ${flow.ticket.keyPattern})` : ''
      }.${flow.ticket.required ? ' Do not start work without one.' : ''}`,
    );
  }
  lines.push(`Branch from ${flow.branch.from}, named ${flow.branch.pattern}.`);
  if (flow.checks.length > 0) {
    lines.push(`Before opening a PR, these must pass: ${flow.checks.join(' · ')}.`);
  }
  lines.push(
    flow.review.approvals > 0
      ? `A PR needs ${flow.review.approvals} approval${flow.review.approvals === 1 ? '' : 's'}; merge by ${flow.mergeStrategy}.`
      : `No review approval is required; merge by ${flow.mergeStrategy}.`,
  );
  if (flow.environments.length > 0) {
    lines.push(
      `Path to production: ${flow.environments
        .map(
          (env) =>
            `${env.name} (${TRIGGER_WORDS[env.deployOn]}${env.approval ? ', needs sign-off' : ''})`,
        )
        .join(' → ')}.`,
    );
  }
  for (const note of flow.notes) lines.push(`- ${note}`);
  return lines.join('\n');
}

/** Double-quoted YAML scalar — JSON string escaping is valid YAML, so borrow it. */
const y = (value: string): string => JSON.stringify(value);

const slug = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'step';

/** Where the rendered pipeline file lives in the repository, per provider. */
export function pipelinePath(provider: FlowProvider): string {
  return provider === 'azure-devops' ? 'azure-pipelines.yml' : '.github/workflows/stma-flow.yml';
}

/**
 * The flow as CI configuration. A scaffold with the flow's real shape — the
 * checks are the flow's checks, the stages are the flow's environments in
 * order — and honest placeholders where only the team knows the command. The
 * header says a machine wrote it and where to change it.
 */
export function renderPipeline(
  flow: DeliveryFlow,
  provider: FlowProvider,
  ctx: { name: string; version: number },
): { path: string; yaml: string } {
  const header = [
    `# Generated by STMA from the delivery flow ${y(ctx.name)} (v${ctx.version}).`,
    '# Edit the flow in STMA and re-render rather than letting this file drift.',
  ];
  const from = flow.branch.from;
  if (provider === 'azure-devops') {
    const lines = [...header, ''];
    lines.push('trigger:', '  branches:', `    include: [${y(from)}]`);
    if (flow.environments.some((e) => e.deployOn === 'tag')) {
      lines.push('  tags:', "    include: ['v*']");
    }
    lines.push('pr:', '  branches:', `    include: [${y(from)}]`, '');
    lines.push('stages:');
    lines.push('  - stage: checks');
    lines.push(`    displayName: ${y('Required checks')}`);
    lines.push('    jobs:');
    lines.push('      - job: checks');
    lines.push('        pool:');
    lines.push('          vmImage: ubuntu-latest');
    lines.push('        steps:');
    for (const check of flow.checks.length > 0 ? flow.checks : ['echo "add your checks in STMA"']) {
      lines.push(`          - script: ${y(check)}`);
      lines.push(`            displayName: ${y(check.slice(0, 60))}`);
    }
    for (const env of flow.environments) {
      const stage = slug(env.name);
      lines.push(`  - stage: deploy_${stage}`);
      lines.push(`    displayName: ${y(`Deploy ${env.name}`)}`);
      lines.push(
        env.deployOn === 'tag'
          ? `    condition: and(succeeded(), startsWith(variables['Build.SourceBranch'], 'refs/tags/v'))`
          : env.deployOn === 'merge'
            ? `    condition: and(succeeded(), eq(variables['Build.SourceBranch'], 'refs/heads/${from}'))`
            : // Manual: the stage exists, a person runs it from the pipeline UI.
              `    trigger: manual`,
      );
      lines.push('    jobs:');
      lines.push(`      - deployment: ${stage}`);
      // Approvals are configured on the Azure DevOps Environment itself; naming
      // it here is what makes that gate apply.
      lines.push(`        environment: ${y(env.name)}${env.approval ? ' # set an approval check on this environment in Azure DevOps' : ''}`);
      lines.push('        strategy:');
      lines.push('          runOnce:');
      lines.push('            deploy:');
      lines.push('              steps:');
      lines.push(`                - script: echo ${y(`deploy to ${env.name} — replace with your deploy step`)}`);
      lines.push(`                  displayName: ${y(`Deploy ${env.name}`)}`);
    }
    return { path: pipelinePath(provider), yaml: `${lines.join('\n')}\n` };
  }

  const lines = [...header, ''];
  lines.push(`name: ${y(ctx.name)}`);
  lines.push('on:');
  lines.push('  pull_request:');
  lines.push(`    branches: [${y(from)}]`);
  lines.push('  push:');
  lines.push(`    branches: [${y(from)}]`);
  if (flow.environments.some((e) => e.deployOn === 'tag')) {
    lines.push("    tags: ['v*']");
  }
  if (flow.environments.some((e) => e.deployOn === 'manual')) {
    lines.push('  workflow_dispatch: {}');
  }
  lines.push('');
  lines.push('jobs:');
  lines.push('  checks:');
  lines.push('    runs-on: ubuntu-latest');
  lines.push('    steps:');
  lines.push('      - uses: actions/checkout@v4');
  for (const check of flow.checks.length > 0 ? flow.checks : ['echo "add your checks in STMA"']) {
    lines.push(`      - name: ${y(check.slice(0, 60))}`);
    lines.push(`        run: ${y(check)}`);
  }
  let previous = 'checks';
  for (const env of flow.environments) {
    const job = `deploy_${slug(env.name)}`;
    lines.push(`  ${job}:`);
    lines.push(`    needs: ${previous}`);
    lines.push(
      env.deployOn === 'tag'
        ? `    if: startsWith(github.ref, 'refs/tags/v')`
        : env.deployOn === 'merge'
          ? `    if: github.event_name == 'push' && github.ref == 'refs/heads/${from}'`
          : `    if: github.event_name == 'workflow_dispatch'`,
    );
    lines.push('    runs-on: ubuntu-latest');
    // Approvals live on the GitHub environment ("required reviewers").
    lines.push(`    environment: ${y(env.name)}${env.approval ? ' # add required reviewers to this environment in repo settings' : ''}`);
    lines.push('    steps:');
    lines.push(`      - run: echo ${y(`deploy to ${env.name} — replace with your deploy step`)}`);
    previous = job;
  }
  return { path: pipelinePath(provider), yaml: `${lines.join('\n')}\n` };
}
