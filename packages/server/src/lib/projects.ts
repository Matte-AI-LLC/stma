import { and, count, eq } from 'drizzle-orm';
import type { Db } from '../db';
import { projects, teams } from '../db/schema';
import { planLimits } from './entitlements';
import { slugify } from './slug';

type Team = typeof teams.$inferSelect;
export type Project = typeof projects.$inferSelect;

/**
 * One repository, one project — whatever spelling the agent arrived with.
 *
 * Conflict detection is scoped per team+project, so two agents in the same
 * checkout that name it differently never see each other. That is not a
 * hypothetical: one Codex run derived the name from the git remote and another
 * from package.json's `name`, in the same clone, and the radar went quiet
 * without telling anybody (2026-08-25). Nothing here can rescue two genuinely
 * different names, but the spellings of the *same* name — a URL, an owner
 * prefix, a `.git` suffix, a trailing slash, different case — collapse onto one
 * project instead of forking the team's history.
 */
export function canonicalProjectName(raw: string): string {
  let value = raw.trim();
  // git@github.com:owner/repo.git and https://github.com/owner/repo both reduce
  // to the last path segment, which is what the snapshot checklist asks for.
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^/@]+@/, '');
  value = value.replace(/[/:]+$/, '');
  const segment = value.split(/[/:]/).filter(Boolean).at(-1) ?? value;
  return segment.replace(/\.git$/i, '').trim() || raw.trim();
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
): Promise<{ project: Project; created: boolean } | { error: string }> {
  const canonical = canonicalProjectName(name);
  const slug = slugify(canonical);
  const existing = await db
    .select()
    .from(projects)
    .where(and(eq(projects.teamId, team.id), eq(projects.slug, slug)))
    .limit(1);
  if (existing[0]) return { project: existing[0], created: false };

  const [{ n }] = await db
    .select({ n: count() })
    .from(projects)
    .where(eq(projects.teamId, team.id));
  const limits = planLimits(team.plan);
  if (n >= limits.maxProjects) {
    return {
      error: `Project limit reached (${limits.maxProjects} on the ${team.plan} plan). Reuse an existing project name or upgrade the plan.`,
    };
  }
  try {
    const inserted = await db
      .insert(projects)
      .values({ teamId: team.id, name: canonical.slice(0, 120), slug, createdBy: userId })
      .returning();
    return { project: inserted[0]!, created: true };
  } catch {
    const raced = await db
      .select()
      .from(projects)
      .where(and(eq(projects.teamId, team.id), eq(projects.slug, slug)))
      .limit(1);
    if (raced[0]) return { project: raced[0], created: false };
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
    'the last path segment of the origin remote (git remote get-url origin); list_projects shows what ' +
    'the team already calls things.'
  );
}
