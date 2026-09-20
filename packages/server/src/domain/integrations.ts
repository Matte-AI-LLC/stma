/**
 * Workspace provider connections and explicit project/repository bindings.
 * Ambiguous selection fails closed; credentials are opened only on this path.
 *
 * The owner check lives in the routes, next to every other authority decision;
 * what lives here is the part both the web form and the agent tools need to
 * agree on — where the credential is, and when STMA is allowed to write to
 * somebody else's issue tracker.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db';
import { projects, repositoryBindings, teamIntegrations } from '../db/schema';
import { criticalAudit } from '../lib/securityHooks';
import { protectIntegrationSecret, revealIntegrationSecret } from '../lib/secretStore';
import type { Env } from '../env';
import { parseAdoLocator, type AdoConfig } from '../lib/azureDevops';
import { commentOnIssue, normalizeRepo, parseIssueRef, type GithubConfig } from '../lib/github';
import type { JiraConfig } from '../lib/jira';
import {
  commentOnClickupTask,
  getClickupTask,
  parseClickupTaskRef,
  type ClickupConfig,
} from '../lib/clickup';
import { logLine } from '../lib/log';

export interface GithubIntegration extends GithubConfig {
  commentOnFinish: boolean;
}

export async function githubForTeam(
  db: Db,
  teamId: string,
  projectId?: string | null,
): Promise<GithubIntegration | undefined> {
  const row = await integrationFor(db, teamId, 'github', undefined, projectId);
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
  const protectedToken = await protectIntegrationSecret(
    input.token.trim(),
    `${input.teamId}:github:${repo}`,
  );
  // Same trail as every other provider: a credential arrived for this team.
  await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await auditIntegration(tx, input.teamId, 'github', repo, {
      actorId: input.userId,
      action: 'integration_connected',
    });
    await tx
      .insert(teamIntegrations)
      .values({
        teamId: input.teamId,
        provider: 'github',
        repo,
        token: protectedToken,
        commentOnFinish: input.commentOnFinish,
        createdBy: input.userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [teamIntegrations.teamId, teamIntegrations.provider, teamIntegrations.repo],
        set: {
          repo,
          token: protectedToken,
          commentOnFinish: input.commentOnFinish,
          updatedAt: now,
        },
      });
  });
  return { ok: true, repo };
}

export async function removeGithubIntegration(
  db: Db,
  teamId: string,
  actorId?: string,
): Promise<void> {
  await removeIntegration(
    db,
    teamId,
    'github',
    undefined,
    actorId ? { actorId, action: 'integration_disconnected' } : undefined,
  );
}

// ------------------------------------------------------- other providers

export type IntegrationProvider = 'github' | 'azure-devops' | 'jira' | 'clickup';

export async function integrationFor(
  db: Db,
  teamId: string,
  provider: IntegrationProvider,
  repo?: string,
  projectId?: string | null,
): Promise<typeof teamIntegrations.$inferSelect | undefined> {
  if (projectId) {
    const bindings = await db
      .select({ connection: teamIntegrations, binding: repositoryBindings })
      .from(repositoryBindings)
      .innerJoin(teamIntegrations, eq(repositoryBindings.connectionId, teamIntegrations.id))
      .where(
        and(
          eq(repositoryBindings.teamId, teamId),
          eq(teamIntegrations.teamId, teamId),
          eq(repositoryBindings.provider, provider),
          eq(repositoryBindings.projectId, projectId),
          repo ? eq(repositoryBindings.fullName, repo) : undefined,
        ),
      )
      .limit(2);
    if (bindings.length === 0) {
      // Compatibility only for a single legacy connection whose explicit project
      // name matches. Multiple connections or any binding never use this fallback.
      const anyBindings = await db
        .select({ id: repositoryBindings.id })
        .from(repositoryBindings)
        .where(
          and(eq(repositoryBindings.teamId, teamId), eq(repositoryBindings.provider, provider)),
        )
        .limit(1);
      if (anyBindings.length) return undefined;
      const legacy = await integrationFor(db, teamId, provider, repo);
      const [project] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.teamId, teamId)))
        .limit(1);
      return legacy &&
        project &&
        legacy.repo.split('/').at(-1)?.toLowerCase() === project.name.toLowerCase()
        ? legacy
        : undefined;
    }
    if (bindings.length !== 1) return undefined;
    const row = bindings[0]!.connection;
    return {
      ...row,
      repo: bindings[0]!.binding.fullName,
      token: await revealIntegrationSecret(row.token, `${teamId}:${provider}:${row.repo}`),
    };
  }
  const rows = await db
    .select()
    .from(teamIntegrations)
    .where(
      and(
        eq(teamIntegrations.teamId, teamId),
        eq(teamIntegrations.provider, provider),
        repo ? eq(teamIntegrations.repo, repo) : undefined,
      ),
    )
    .limit(2);
  if (rows.length !== 1) return undefined; // Ambiguity never selects somebody else's repo.
  const row = rows[0]!;
  return {
    ...row,
    token: await revealIntegrationSecret(row.token, `${teamId}:${provider}:${row.repo}`),
  };
}

/** How many providers this team has connected — what maxIntegrations counts. */
export async function countIntegrations(db: Db, teamId: string): Promise<number> {
  const rows = await db
    .select({ id: teamIntegrations.id })
    .from(teamIntegrations)
    .where(eq(teamIntegrations.teamId, teamId));
  return rows.length;
}

/**
 * Who changed a team's provider connection, in the tamper-evident trail.
 *
 * Three actions, not one per form: a credential arrived, a credential was
 * withdrawn, or what an existing credential may touch changed. Everything the
 * console can do to an integration is one of those three, and a reader asking
 * "when did this workspace hand STMA a tracker token" should not have to know
 * which button was pressed.
 *
 * The subject is the provider plus its locator — a workspace id, a repository,
 * a site — never the credential and never a task, list or message. `activity`
 * keeps carrying the readable line; this is the append-only chain beside it.
 */
export type IntegrationAudit = {
  actorId: string;
  action: 'integration_connected' | 'integration_disconnected' | 'integration_scope_changed';
};

const auditIntegration = (
  db: Db,
  teamId: string,
  provider: IntegrationProvider,
  locator: string,
  audit: IntegrationAudit | undefined,
) =>
  audit
    ? criticalAudit(db, {
        teamId,
        actorId: audit.actorId,
        action: audit.action,
        subjectId: `${provider}:${locator}`,
      })
    : Promise.resolve();

export async function removeIntegration(
  db: Db,
  teamId: string,
  provider: IntegrationProvider,
  repo?: string,
  audit?: IntegrationAudit,
): Promise<void> {
  // Revocation must remain possible even if an encryption key was lost.
  // Select metadata only; never decrypt a credential merely to disconnect it.
  const selected = await db
    .select({ id: teamIntegrations.id, repo: teamIntegrations.repo })
    .from(teamIntegrations)
    .where(
      and(
        eq(teamIntegrations.teamId, teamId),
        eq(teamIntegrations.provider, provider),
        repo ? eq(teamIntegrations.repo, repo) : undefined,
      ),
    )
    .limit(2);
  if (selected.length !== 1) return;
  const row = selected[0]!;
  // The audit row and the delete are one transaction: an append-only chain that
  // can record a withdrawal which then rolled back is worse than no chain.
  await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await auditIntegration(tx, teamId, provider, row.repo, audit);
    await tx.delete(teamIntegrations).where(eq(teamIntegrations.id, row.id));
  });
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
    commentOnFinish?: boolean;
    /** Omitted where the write is bookkeeping — storing a connection check's verdict. */
    audit?: IntegrationAudit;
  },
): Promise<void> {
  const now = new Date();
  const protectedToken = await protectIntegrationSecret(
    input.token,
    `${input.teamId}:${input.provider}:${input.locator}`,
  );
  await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await auditIntegration(tx, input.teamId, input.provider, input.locator, input.audit);
    await tx
      .insert(teamIntegrations)
      .values({
        teamId: input.teamId,
        provider: input.provider,
        repo: input.locator,
        token: protectedToken,
        commentOnFinish: input.commentOnFinish ?? false,
        config: input.config ?? null,
        createdBy: input.userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [teamIntegrations.teamId, teamIntegrations.provider, teamIntegrations.repo],
        set: {
          repo: input.locator,
          token: protectedToken,
          config: input.config ?? null,
          ...(input.commentOnFinish === undefined
            ? {}
            : { commentOnFinish: input.commentOnFinish }),
          updatedAt: now,
        },
      });
  });
}

/** The team's Azure DevOps connection as a ready-to-call config, if any. */
export async function adoForTeam(
  db: Db,
  teamId: string,
  projectId?: string | null,
): Promise<AdoConfig | undefined> {
  const row = await integrationFor(db, teamId, 'azure-devops', undefined, projectId);
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

export interface ClickupBinding {
  projectId: string;
  listId: string;
  listName: string;
}

/** What the connection last did, for the owner to read. Never a body. */
export interface ClickupDelivery {
  at: string;
  ok: boolean;
  /** The task reference, which is an identifier — not its title and not the comment. */
  task: string;
  list: string;
  error?: string;
}

export interface ClickupCheck {
  ok: boolean;
  at: string;
  error?: string;
}

interface ClickupStoredConfig {
  workspaceName?: string;
  bindings?: ClickupBinding[];
  /**
   * Set while the owner has paused the connection. An ISO timestamp rather than
   * a boolean, because "paused" is only useful next to "since when" — a
   * connection quiet for an hour and one quiet since March are different
   * situations and the card has to be able to say which.
   */
  pausedAt?: string | null;
  lastCheck?: ClickupCheck;
  lastComment?: ClickupDelivery;
}

/**
 * Mappings are read out of jsonb, so their shape is checked rather than assumed.
 *
 * `liveClickupBindings` puts these ids into a `uuid` comparison on the run hot
 * path; a malformed row would turn a finished run into a 500, and no mapping at
 * all is the safe reading of a mapping nobody can parse.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const readBindings = (value: unknown): ClickupBinding[] =>
  (Array.isArray(value) ? value : []).filter(
    (row): row is ClickupBinding =>
      !!row &&
      typeof (row as ClickupBinding).projectId === 'string' &&
      UUID.test((row as ClickupBinding).projectId) &&
      typeof (row as ClickupBinding).listId === 'string' &&
      typeof (row as ClickupBinding).listName === 'string',
  );

/** The OAuth connection itself, before or after a project/list mapping exists. */
export async function clickupConnectionForTeam(db: Db, teamId: string) {
  const row = await integrationFor(db, teamId, 'clickup');
  if (!row) return undefined;
  const config = (row.config ?? {}) as ClickupStoredConfig;
  return {
    workspaceId: row.repo,
    workspaceName: config.workspaceName ?? row.repo,
    token: row.token,
    commentOnFinish: row.commentOnFinish,
    bindings: readBindings(config.bindings),
    pausedAt: typeof config.pausedAt === 'string' ? config.pausedAt : null,
    lastCheck: config.lastCheck,
    lastComment: config.lastComment,
    connectedAt: row.updatedAt ?? row.createdAt ?? null,
  };
}

/**
 * The mappings whose STMA project still exists.
 *
 * A binding is a pointer into `config`, so deleting a project cannot cascade to
 * it and one can outlive its target indefinitely. That is a fail-*open* on the
 * one path that had no project name to check against: with a single stale
 * binding left, `clickupForTeam(db, team)` used to resolve a List mapped to a
 * project nobody can open any more, and `list_clickup_tasks` with no project
 * named would read it. The rows are not pruned on read — a mapping is the
 * owner's, and silently rewriting their configuration because a page was loaded
 * is not this codebase's habit — they are simply not resolvable, and the card
 * offers the button that removes them.
 */
async function liveClickupBindings(
  db: Db,
  teamId: string,
  bindings: readonly ClickupBinding[],
): Promise<ClickupBinding[]> {
  if (bindings.length === 0) return [];
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.teamId, teamId),
        inArray(
          projects.id,
          bindings.map((row) => row.projectId),
        ),
      ),
    );
  const live = new Set(rows.map((row) => row.id));
  return bindings.filter((row) => live.has(row.projectId));
}

/** The console's view: every mapping, including the ones pointing nowhere. */
export async function clickupBindingsForTeam(
  db: Db,
  teamId: string,
  bindings: readonly ClickupBinding[],
): Promise<Array<ClickupBinding & { projectExists: boolean }>> {
  const live = new Set((await liveClickupBindings(db, teamId, bindings)).map((r) => r.projectId));
  return bindings.map((row) => ({ ...row, projectExists: live.has(row.projectId) }));
}

/**
 * Resolve an exact project to an exact ClickUp List; ambiguity never guesses.
 *
 * Paused answers nothing, which is the whole of what pausing means: STMA stops
 * using the connection. One rule rather than a second half-switch beside
 * `commentOnFinish` — reads and writes both stop, the mappings are kept, and
 * one click brings it all back. (The owner's own **Test access** button still
 * calls ClickUp while paused; it is the button you press to decide whether to
 * resume, and it is a person acting, not STMA acting on their behalf.)
 */
export async function clickupForTeam(
  db: Db,
  teamId: string,
  projectId?: string | null,
): Promise<ClickupConfig | undefined> {
  const connection = await clickupConnectionForTeam(db, teamId);
  if (!connection || connection.pausedAt) return undefined;
  const live = await liveClickupBindings(db, teamId, connection.bindings);
  const binding = projectId
    ? live.find((row) => row.projectId === projectId)
    : live.length === 1
      ? live[0]
      : undefined;
  if (!binding) return undefined;
  return {
    workspaceId: connection.workspaceId,
    workspaceName: connection.workspaceName,
    token: connection.token,
    listId: binding.listId,
    listName: binding.listName,
    projectId: binding.projectId,
    commentOnFinish: connection.commentOnFinish,
  };
}

/**
 * Rewrite the stored ClickUp configuration, keeping the credential where it is.
 *
 * Every console write to this connection goes through here so the three things
 * that must not drift stay together: the workspace locator the credential was
 * sealed against, the mappings, and the audit line saying somebody changed what
 * STMA may touch.
 */
async function writeClickupConfig(
  db: Db,
  input: {
    teamId: string;
    userId: string;
    connection: NonNullable<Awaited<ReturnType<typeof clickupConnectionForTeam>>>;
    bindings: ClickupBinding[];
    commentOnFinish?: boolean;
    pausedAt?: string | null;
  },
): Promise<void> {
  await saveIntegration(db, {
    teamId: input.teamId,
    userId: input.userId,
    provider: 'clickup',
    locator: input.connection.workspaceId,
    token: input.connection.token,
    ...(input.commentOnFinish === undefined ? {} : { commentOnFinish: input.commentOnFinish }),
    config: {
      workspaceName: input.connection.workspaceName,
      bindings: input.bindings,
      pausedAt: input.pausedAt === undefined ? input.connection.pausedAt : input.pausedAt,
      ...(input.connection.lastCheck ? { lastCheck: input.connection.lastCheck } : {}),
      ...(input.connection.lastComment ? { lastComment: input.connection.lastComment } : {}),
    },
    audit: { actorId: input.userId, action: 'integration_scope_changed' },
  });
}

/**
 * Map one project to one List.
 *
 * Commenting is deliberately not a field here any more: it rode this form, so
 * the one moment somebody wants to stop STMA writing into their tracker was the
 * moment they had to re-choose a project and a List, and two controls setting
 * one switch is how the card came to disagree with itself.
 * `setClickupCommentOnFinish` is the single place now.
 */
export async function saveClickupBinding(
  db: Db,
  input: {
    teamId: string;
    userId: string;
    projectId: string;
    listId: string;
    listName: string;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.teamId, input.teamId)))
    .limit(1);
  if (!project) return { ok: false, error: 'That project does not belong to this workspace.' };
  const connection = await clickupConnectionForTeam(db, input.teamId);
  if (!connection) return { ok: false, error: 'Connect ClickUp first.' };
  const bindings = connection.bindings.filter((row) => row.projectId !== input.projectId);
  bindings.push({ projectId: input.projectId, listId: input.listId, listName: input.listName });
  await writeClickupConfig(db, { teamId: input.teamId, userId: input.userId, connection, bindings });
  return { ok: true };
}

/**
 * Drop one project's mapping without withdrawing the credential.
 *
 * There was no way to do this: a mapping could be added and then only replaced,
 * so a project deleted in STMA or a List deleted in ClickUp left a row the
 * owner could see and not remove, and disconnecting the whole workspace was the
 * only door out.
 */
export async function removeClickupBinding(
  db: Db,
  input: { teamId: string; userId: string; projectId: string },
): Promise<{ ok: true; listName: string } | { ok: false; error: string }> {
  const connection = await clickupConnectionForTeam(db, input.teamId);
  if (!connection) return { ok: false, error: 'Connect ClickUp first.' };
  const removed = connection.bindings.find((row) => row.projectId === input.projectId);
  if (!removed) return { ok: false, error: 'That project is not mapped to a ClickUp List.' };
  await writeClickupConfig(db, {
    teamId: input.teamId,
    userId: input.userId,
    connection,
    bindings: connection.bindings.filter((row) => row.projectId !== input.projectId),
  });
  return { ok: true, listName: removed.listName };
}

/** Pause or resume the whole connection, keeping every mapping in place. */
export async function setClickupPaused(
  db: Db,
  input: { teamId: string; userId: string; paused: boolean },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const connection = await clickupConnectionForTeam(db, input.teamId);
  if (!connection) return { ok: false, error: 'Connect ClickUp first.' };
  await writeClickupConfig(db, {
    teamId: input.teamId,
    userId: input.userId,
    connection,
    bindings: connection.bindings,
    pausedAt: input.paused ? new Date().toISOString() : null,
  });
  return { ok: true };
}

/** Turn commenting on or off without re-picking a project and a List. */
export async function setClickupCommentOnFinish(
  db: Db,
  input: { teamId: string; userId: string; commentOnFinish: boolean },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const connection = await clickupConnectionForTeam(db, input.teamId);
  if (!connection) return { ok: false, error: 'Connect ClickUp first.' };
  await writeClickupConfig(db, {
    teamId: input.teamId,
    userId: input.userId,
    connection,
    bindings: connection.bindings,
    commentOnFinish: input.commentOnFinish,
  });
  return { ok: true };
}

/** Store a connection check's verdict beside the connection, as ADO and Jira do. */
export async function recordClickupCheck(
  db: Db,
  input: { teamId: string; userId: string; check: ClickupCheck },
): Promise<void> {
  const connection = await clickupConnectionForTeam(db, input.teamId);
  if (!connection) return;
  // Bookkeeping, so no audit line: nobody's access changed by pressing Test.
  await saveIntegration(db, {
    teamId: input.teamId,
    userId: input.userId,
    provider: 'clickup',
    locator: connection.workspaceId,
    token: connection.token,
    config: {
      workspaceName: connection.workspaceName,
      bindings: connection.bindings,
      pausedAt: connection.pausedAt,
      lastCheck: input.check,
      ...(connection.lastComment ? { lastComment: connection.lastComment } : {}),
    },
  });
}

/**
 * Record what the outbound path last did.
 *
 * A narrow update of `config` alone: it runs after a run has already finished,
 * on the hot path, and must neither reopen the sealed credential nor move
 * `updated_at`, which means when the *connection* last changed. Never throws
 * and never records a body — the fields are an identifier, a list name and an
 * outcome, which is what an owner needs to tell "nothing to say" from "the
 * token died three days ago" apart.
 */
async function recordClickupDelivery(
  db: Db,
  teamId: string,
  outcome: ClickupDelivery,
): Promise<void> {
  try {
    const rows = await db
      .select({ id: teamIntegrations.id, config: teamIntegrations.config })
      .from(teamIntegrations)
      .where(and(eq(teamIntegrations.teamId, teamId), eq(teamIntegrations.provider, 'clickup')))
      .limit(2);
    if (rows.length !== 1) return;
    await db
      .update(teamIntegrations)
      .set({ config: { ...((rows[0]!.config ?? {}) as ClickupStoredConfig), lastComment: outcome } })
      .where(eq(teamIntegrations.id, rows[0]!.id));
  } catch {
    /* A label on a page must never be able to fail a run that already finished. */
  }
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
  input: {
    teamId: string;
    projectId?: string | null;
    taskKey: string | null | undefined;
    body: string;
  },
): Promise<
  { commented: false; reason: string } | { commented: true; issue: number; repo: string }
> {
  try {
    const integration = await githubForTeam(db, input.teamId, input.projectId);
    if (!integration) return { commented: false, reason: 'no_integration' };
    if (!integration.commentOnFinish) return { commented: false, reason: 'disabled' };
    const ref = parseIssueRef(input.taskKey, integration.repo);
    if (!ref) return { commented: false, reason: 'task_is_not_an_issue' };
    if (ref.repo.toLowerCase() !== integration.repo.toLowerCase())
      return { commented: false, reason: 'repository_mismatch' };
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

/**
 * Report a terminal run/handoff to the tracker named by its unambiguous task key.
 * GitHub compatibility remains unchanged; ClickUp is selected only by the
 * explicit `clickup:` prefix written by start_run's `clickup_task` parameter.
 *
 * **Delivery is one attempt, deliberately, and STMA says so rather than
 * implying otherwise.** ClickUp's comment endpoint takes no idempotency key, so
 * a retry after a timeout or a 5xx cannot tell "it never arrived" from "the
 * response did", and two comments about one finish is a worse thing to do to a
 * customer's task than none. What retry-safety *does* mean here is that STMA's
 * own retries never double-post: `finish_run`, the REST finish and
 * `handoff_work` all skip this path on a replayed request, which is the only
 * place a repeat can come from, and `test/integrations.test.ts` pins it. The durable record
 * is STMA's own event; the comment is a courtesy copy of it, and its outcome is
 * stored so the owner can see what it last did instead of guessing.
 */
export async function commentOnRunTracker(
  db: Db,
  env: Env,
  input: {
    teamId: string;
    projectId?: string | null;
    taskKey: string | null | undefined;
    body: string;
  },
): Promise<{ commented: false; reason: string } | { commented: true; provider: 'github' | 'clickup'; label: string }> {
  const clickupTask = input.taskKey?.startsWith('clickup:')
    ? parseClickupTaskRef(input.taskKey)
    : null;
  if (!clickupTask) {
    const github = await commentOnRunIssue(db, env, input);
    return github.commented
      ? { commented: true, provider: 'github', label: `${github.repo}#${github.issue}` }
      : github;
  }
  try {
    const integration = await clickupForTeam(db, input.teamId, input.projectId);
    // A paused connection resolves to nothing, so this is also how pausing
    // stops outbound writes. The reason is the same either way: STMA has no
    // mapped List it is allowed to write to right now.
    if (!integration) return { commented: false, reason: 'no_clickup_project_binding' };
    if (!integration.commentOnFinish) return { commented: false, reason: 'disabled' };
    // A task can be moved after start_run. Re-check the exact List at the
    // external-write boundary so an old run cannot comment outside the mapping.
    const current = await getClickupTask(env, integration, clickupTask);
    if (!current.ok) {
      logLine({ evt: 'clickup', a: 'comment_refused', why: current.error, task: clickupTask });
      await recordClickupDelivery(db, input.teamId, {
        at: new Date().toISOString(),
        ok: false,
        task: clickupTask,
        list: integration.listName,
        error: current.error,
      });
      return { commented: false, reason: current.error };
    }
    const posted = await commentOnClickupTask(env, integration, clickupTask, input.body);
    await recordClickupDelivery(db, input.teamId, {
      at: new Date().toISOString(),
      ok: posted.ok,
      task: clickupTask,
      list: integration.listName,
      ...(posted.ok ? {} : { error: posted.error }),
    });
    if (!posted.ok) {
      logLine({ evt: 'clickup', a: 'comment_failed', why: posted.error, task: clickupTask });
      return { commented: false, reason: posted.error };
    }
    logLine({ evt: 'clickup', a: 'comment', list: integration.listId, task: clickupTask });
    return { commented: true, provider: 'clickup', label: `ClickUp ${clickupTask}` };
  } catch (error) {
    logLine({ evt: 'clickup', a: 'comment_failed', why: error instanceof Error ? error.message.slice(0, 120) : 'unknown' });
    return { commented: false, reason: 'error' };
  }
}
