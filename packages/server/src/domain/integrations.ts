/**
 * Team-level outbound integrations. Today that means one GitHub repository per
 * team, which is what turns a run's `task` string from a label into a link.
 *
 * The owner check lives in the routes, next to every other authority decision;
 * what lives here is the part both the web form and the agent tools need to
 * agree on — where the credential is, and when STMA is allowed to write to
 * somebody else's issue tracker.
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db';
import { teamIntegrations } from '../db/schema';
import type { Env } from '../env';
import { parseAdoLocator, type AdoConfig } from '../lib/azureDevops';
import {
  commentOnIssue,
  normalizeRepo,
  parseIssueRef,
  type GithubConfig,
} from '../lib/github';
import type { JiraConfig } from '../lib/jira';
import { logLine } from '../lib/log';

export interface GithubIntegration extends GithubConfig {
  commentOnFinish: boolean;
}

export async function githubForTeam(
  db: Db,
  teamId: string,
): Promise<GithubIntegration | undefined> {
  const rows = await db
    .select()
    .from(teamIntegrations)
    .where(and(eq(teamIntegrations.teamId, teamId), eq(teamIntegrations.provider, 'github')))
    .limit(1);
  const row = rows[0];
  return row
    ? { repo: row.repo, token: row.token, commentOnFinish: row.commentOnFinish }
    : undefined;
}

export async function saveGithubIntegration(
  db: Db,
  input: { teamId: string; userId: string; repo: string; token: string; commentOnFinish: boolean },
): Promise<{ ok: true; repo: string } | { ok: false; error: string }> {
  const repo = normalizeRepo(input.repo);
  if (!repo) {
    return { ok: false, error: 'Repository must look like owner/name, e.g. acme/payments-api.' };
  }
  if (!input.token.trim()) {
    return { ok: false, error: 'A token is required — without one STMA cannot read the issues.' };
  }
  const now = new Date();
  await db
    .insert(teamIntegrations)
    .values({
      teamId: input.teamId,
      provider: 'github',
      repo,
      token: input.token.trim(),
      commentOnFinish: input.commentOnFinish,
      createdBy: input.userId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [teamIntegrations.teamId, teamIntegrations.provider],
      set: {
        repo,
        token: input.token.trim(),
        commentOnFinish: input.commentOnFinish,
        updatedAt: now,
      },
    });
  return { ok: true, repo };
}

export async function removeGithubIntegration(db: Db, teamId: string): Promise<void> {
  await db
    .delete(teamIntegrations)
    .where(and(eq(teamIntegrations.teamId, teamId), eq(teamIntegrations.provider, 'github')));
}

// ------------------------------------------------------- other providers

export type IntegrationProvider = 'github' | 'azure-devops' | 'jira';

export async function integrationFor(db: Db, teamId: string, provider: IntegrationProvider) {
  const rows = await db
    .select()
    .from(teamIntegrations)
    .where(and(eq(teamIntegrations.teamId, teamId), eq(teamIntegrations.provider, provider)))
    .limit(1);
  return rows[0];
}

/** How many providers this team has connected — what maxIntegrations counts. */
export async function countIntegrations(db: Db, teamId: string): Promise<number> {
  const rows = await db
    .select({ id: teamIntegrations.id })
    .from(teamIntegrations)
    .where(eq(teamIntegrations.teamId, teamId));
  return rows.length;
}

export async function removeIntegration(
  db: Db,
  teamId: string,
  provider: IntegrationProvider,
): Promise<void> {
  await db
    .delete(teamIntegrations)
    .where(and(eq(teamIntegrations.teamId, teamId), eq(teamIntegrations.provider, provider)));
}

/**
 * Upsert one provider connection. The locator goes in `repo` (whatever "where"
 * means for the provider), the secret in `token`, anything else in `config` —
 * see the schema comment. Validation of the locator happened in the caller,
 * because its shape is provider-specific and this function is not.
 */
export async function saveIntegration(
  db: Db,
  input: {
    teamId: string;
    userId: string;
    provider: IntegrationProvider;
    locator: string;
    token: string;
    config?: Record<string, unknown> | null;
  },
): Promise<void> {
  const now = new Date();
  await db
    .insert(teamIntegrations)
    .values({
      teamId: input.teamId,
      provider: input.provider,
      repo: input.locator,
      token: input.token,
      commentOnFinish: false,
      config: input.config ?? null,
      createdBy: input.userId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [teamIntegrations.teamId, teamIntegrations.provider],
      set: {
        repo: input.locator,
        token: input.token,
        config: input.config ?? null,
        updatedAt: now,
      },
    });
}

/** The team's Azure DevOps connection as a ready-to-call config, if any. */
export async function adoForTeam(db: Db, teamId: string): Promise<AdoConfig | undefined> {
  const row = await integrationFor(db, teamId, 'azure-devops');
  if (!row) return undefined;
  const parsed = parseAdoLocator(row.repo);
  return parsed ? { ...parsed, token: row.token } : undefined;
}

/** The team's Jira connection as a ready-to-call config, if any. */
export async function jiraForTeam(db: Db, teamId: string): Promise<JiraConfig | undefined> {
  const row = await integrationFor(db, teamId, 'jira');
  if (!row) return undefined;
  const config = row.config as { email?: string; cloudId?: string } | null;
  return config?.email
    ? { site: row.repo, email: config.email, token: row.token, cloudId: config.cloudId }
    : undefined;
}

/**
 * Comment on the issue a run named, if it named one and the team asked for it.
 *
 * Three deliberate gates, because writing into a team's issue tracker is the
 * most visible thing STMA does outside its own walls: an integration must
 * exist, the team must have left commenting on, and the task key must
 * *unambiguously* be an issue (see parseIssueRef — a bare number is not).
 * Never throws: the run has already finished, and a failed comment must not
 * turn a successful handoff into an error.
 */
export async function commentOnRunIssue(
  db: Db,
  env: Env,
  input: { teamId: string; taskKey: string | null | undefined; body: string },
): Promise<{ commented: false; reason: string } | { commented: true; issue: number; repo: string }> {
  try {
    const integration = await githubForTeam(db, input.teamId);
    if (!integration) return { commented: false, reason: 'no_integration' };
    if (!integration.commentOnFinish) return { commented: false, reason: 'disabled' };
    const ref = parseIssueRef(input.taskKey, integration.repo);
    if (!ref) return { commented: false, reason: 'task_is_not_an_issue' };
    const posted = await commentOnIssue(env, integration, ref.number, input.body, ref.repo);
    if (!posted.ok) {
      logLine({ evt: 'github', a: 'comment_failed', why: posted.error, issue: ref.number });
      return { commented: false, reason: posted.error };
    }
    logLine({ evt: 'github', a: 'comment', repo: ref.repo, issue: ref.number });
    return { commented: true, issue: ref.number, repo: ref.repo };
  } catch (err) {
    logLine({
      evt: 'github',
      a: 'comment_failed',
      why: err instanceof Error ? err.message.slice(0, 120) : 'unknown',
    });
    return { commented: false, reason: 'error' };
  }
}
