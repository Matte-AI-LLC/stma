import { and, count, eq, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { projects, teams } from '../db/schema';
import { sha256hex } from './crypto';
import { effectiveLimits } from './entitlements';
import { slugify } from './slug';

type Team = typeof teams.$inferSelect;
export type Project = typeof projects.$inferSelect;

import { canonicalRepositoryIdentity, normalizeRepositoryPath, urlRepositoryIdentity, scpRepositoryIdentity } from '@bridge/shared';
export { canonicalRepositoryIdentity } from '@bridge/shared';

/** Compatibility name used by snapshot matching; it is repository identity. */
export const canonicalProjectName = canonicalRepositoryIdentity;

function inferredRepositoryIdentity(raw: string): string | null {
  const value = raw.trim();
  if (!value || /^[a-z]:[\\/]/i.test(value)) return null;
  if (urlRepositoryIdentity(value) || scpRepositoryIdentity(value)) {
    return canonicalRepositoryIdentity(value);
  }
  // owner/repository and host/owner/repository preserve enough information to
  // distinguish same-basename remotes. A bare legacy name proves nothing.
  return normalizeRepositoryPath(value).includes('/')
    ? canonicalRepositoryIdentity(value)
    : null;
}

function repositoryDisplayName(raw: string): string {
  const normalized = normalizeRepositoryPath(raw);
  return normalized.split('/').filter(Boolean).at(-1) ?? raw.trim();
}

/**
 * Whether two snapshots describe the same repository/project.
 *
 * A project id is authoritative when both snapshots have one. Older snapshots
 * can predate the project foreign key, so their canonical repo names are the
 * compatibility fallback. Two entirely unscoped legacy snapshots are allowed:
 * there is no evidence that they differ, and rejecting them would make the old
 * single-repository workflow unusable.
 */
export function snapshotsShareProject(
  a: { projectId: string | null; repo: string | null },
  b: { projectId: string | null; repo: string | null },
): boolean {
  if (a.projectId && b.projectId) return a.projectId === b.projectId;
  if (a.repo && b.repo) {
    return (
      canonicalProjectName(a.repo).toLowerCase() === canonicalProjectName(b.repo).toLowerCase()
    );
  }
  return !a.projectId && !b.projectId && !a.repo && !b.repo;
}

/** Human-facing snapshot scope for a mismatch error. */
export function snapshotProjectLabel(snapshot: { repo: string | null }): string {
  return snapshot.repo ? canonicalProjectName(snapshot.repo) : 'an unscoped project';
}

/**
 * Projects are born lazily from the `repo` identifier agents pass along with
 * snapshots/sessions — no manual setup step. `created` says whether this call
 * was the birth, so a caller can warn the agent that it just forked the team's
 * conflict radar rather than joining an existing project.
 */
export async function findOrCreateProject(
  db: Db,
  team: Team,
  name: string,
  userId: string | null,
  repositoryIdentity?: string,
): Promise<{ project: Project; created: boolean } | { error: string }> {
  return db.transaction((transaction) =>
    findOrCreateProjectInTransaction(
      transaction as unknown as Db,
      team,
      name,
      userId,
      repositoryIdentity,
    ),
  );
}

interface ProjectWriteOptions {
  repositoryIdentity?: string;
  /**
   * Server-enforced target carried by a project-scoped credential. When set,
   * the durable id wins over the caller's display-name spelling and project
   * discovery is disabled.
   */
  fixedProjectId?: string | null;
  /**
   * What fixed the project, when it was not the credential: a run started for
   * a work item lands in the work's own project. A checkout of another
   * repository is refused either way; only the sentence differs, because a
   * personal or team credential is bound to nothing and telling its agent to
   * reconnect the checkout sends its human after the wrong thing.
   */
  fixedBy?: 'credential' | 'work';
}

/**
 * Resolve the project a write belongs to.
 *
 * Personal/team/browser callers retain lazy project discovery. A project-scoped
 * credential instead writes to its already-authorized project id, so an
 * injected display name can never create a second legacy project next to a
 * manually-created repository identity.
 */
export async function resolveProjectForWrite(
  db: Db,
  team: Team,
  name: string,
  userId: string | null,
  options: ProjectWriteOptions = {},
): Promise<{ project: Project; created: boolean } | { error: string }> {
  return db.transaction((transaction) =>
    resolveProjectForWriteInTransaction(
      transaction as unknown as Db,
      team,
      name,
      userId,
      options,
    ),
  );
}

/** Transaction-owned form of {@link resolveProjectForWrite}. */
export async function resolveProjectForWriteInTransaction(
  db: Db,
  team: Team,
  name: string,
  userId: string | null,
  options: ProjectWriteOptions = {},
): Promise<{ project: Project; created: boolean } | { error: string }> {
  if (options.fixedProjectId) {
    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, options.fixedProjectId), eq(projects.teamId, team.id)))
      .limit(1);
    if (!project) return { error: "This credential's project is no longer available." };
    if (
      options.repositoryIdentity !== undefined && project.repositoryIdentity &&
      canonicalRepositoryIdentity(options.repositoryIdentity) !== canonicalRepositoryIdentity(project.repositoryIdentity)
    )
      return {
        error:
          options.fixedBy === 'work'
            ? `Repository identity does not match the project this work item is filed in, which is bound to ${canonicalRepositoryIdentity(project.repositoryIdentity)}. Start the run for this work from a checkout of that repository.`
            : 'Repository identity does not match the credential-bound project. Connect this checkout to its own project before starting work.',
      };
    return { project, created: false };
  }
  return findOrCreateProjectInTransaction(
    db,
    team,
    name,
    userId,
    options.repositoryIdentity,
  );
}

/**
 * The project resolver for a caller which already owns the surrounding
 * transaction. It still locks the team row, so ceilings and first creation are
 * serialized without opening a nested transaction.
 */
export async function findOrCreateProjectInTransaction(
  db: Db,
  team: Team,
  name: string,
  userId: string | null,
  repositoryIdentity?: string,
): Promise<{ project: Project; created: boolean } | { error: string }> {
  const identity = repositoryIdentity
    ? canonicalRepositoryIdentity(repositoryIdentity)
    : inferredRepositoryIdentity(name);
  const displayName = repositoryIdentity
    ? name.trim()
    : identity
      ? repositoryDisplayName(name)
      : name.trim();
  const baseSlug = slugify(displayName);
  // A shared workspace lock makes the project ceiling hold for concurrent agents.
  // `no key update` serializes those exactly as `update` did, and leaves the
  // foreign-key check of a row inserted under a Work lock (every Work event
  // names its workspace) free to proceed: a run start holds this lock while it
  // waits for a Work lock, so `update` here would close the circle.
  await db.select({ id: teams.id }).from(teams).where(eq(teams.id, team.id)).for('no key update');
  const existing = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.teamId, team.id),
        identity
          ? eq(projects.repositoryIdentity, identity)
          : and(eq(projects.name, displayName), sql`${projects.repositoryIdentity} is null`),
      ),
    )
    .limit(1);
  if (existing[0]) return { project: existing[0], created: false };

  const [{ n }] = await db
    .select({ n: count() })
    .from(projects)
    .where(eq(projects.teamId, team.id));
  const limits = await effectiveLimits(db, team);
  if (n >= limits.maxProjects) {
    return {
      error: `Project limit reached (${limits.maxProjects} on the ${team.plan} plan). Reuse an existing project name or upgrade the plan.`,
    };
  }
  try {
    const [slugOwner] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.teamId, team.id), eq(projects.slug, baseSlug)))
      .limit(1);
    const slug = slugOwner
      ? identity
        ? `${baseSlug}-${sha256hex(identity).slice(0, 8)}`
        : `${baseSlug}-legacy`
      : baseSlug;
    const inserted = await db
      .insert(projects)
      .values({
        teamId: team.id,
        name: displayName.slice(0, 120),
        slug,
        repositoryIdentity: identity,
        createdBy: userId,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted[0]) {
      const [raced] = await db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.teamId, team.id),
            identity
              ? eq(projects.repositoryIdentity, identity)
              : and(eq(projects.name, displayName), sql`${projects.repositoryIdentity} is null`),
          ),
        )
        .limit(1);
      return raced
        ? { project: raced, created: false }
        : { error: 'Could not create the project.' };
    }
    return { project: inserted[0]!, created: true };
  } catch {
    return { error: 'Could not create the project.' };
  }
}

/**
 * What to tell an agent that just created a project in a team that already had
 * some. Conflicts are per project, so this is the moment — and the only moment —
 * where a typo silently costs the team its collision warnings.
 */
export async function projectSplitWarning(
  db: Db,
  team: Team,
  created: boolean,
  projectId: string,
): Promise<string | undefined> {
  if (!created) return undefined;
  const siblings = await db
    .select({ id: projects.id, slug: projects.slug })
    .from(projects)
    .where(eq(projects.teamId, team.id));
  const names = siblings.filter((p) => p.id !== projectId).map((p) => p.slug);
  if (names.length === 0) return undefined;
  return (
    `This is a new project in "${team.slug}" — the team already has ${names
      .slice(0, 8)
      .map((n) => `"${n}"`)
      .join(', ')}. ` +
    'Conflict detection is scoped per project, so if this is the same repository under a different ' +
    'name your run will not warn anyone working in it, and nobody will warn you. The name to use is ' +
    'the full origin remote identity (host/owner/repository; git remote get-url origin); list_projects ' +
    'shows what the team already calls things. A bare legacy name is intentionally not guessed into a remote.'
  );
}
