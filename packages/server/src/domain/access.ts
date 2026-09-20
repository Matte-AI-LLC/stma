import { membershipUser } from '../lib/securityHooks';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db';
import { memberships, projects, teams, users } from '../db/schema';
import { canonicalProjectName, resolveProjectForWrite, type Project } from '../lib/projects';
import { slugify } from '../lib/slug';

export async function teamForUser(db: Db, userId: string, slug: string) {
  const rows = await db
    .select({ team: teams, role: memberships.role })
    .from(memberships)
    .innerJoin(teams, eq(memberships.teamId, teams.id))
    .where(and(membershipUser(userId), eq(teams.slug, slug)))
    .limit(1);
  const row = rows[0];
  return row;
}

/**
 * One member of one workspace, by the name that appears in its URLs.
 *
 * Two pages ask this — `/app/teams/:slug/people/:username` and the sessions
 * list narrowed with `?person=` — and they must answer identically, because the
 * second is linked from the first. The caller's own membership is proved
 * separately by `teamForUser`, which is where `membershipUser` belongs; the
 * join here is the *subject's* membership of this workspace.
 *
 * Absent means exactly two things and deliberately does not say which: not a
 * member here, or no such account. A console that tells those apart answers
 * "does this person exist" to anybody holding a workspace slug.
 */
export async function memberByUsername(db: Db, teamId: string, username: string) {
  const [row] = await db
    .select({
      id: users.id,
      username: users.username,
      role: memberships.role,
      joinedAt: memberships.createdAt,
    })
    .from(users)
    .innerJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.teamId, teamId)))
    .where(eq(users.username, username))
    .limit(1);
  return row;
}

export async function projectForTeam(db: Db, teamId: string, slugOrName: string) {
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(slugOrName)) {
    const [byId] = await db.select().from(projects).where(and(eq(projects.teamId, teamId), eq(projects.id, slugOrName))).limit(1);
    if (byId) return byId;
  }
  const rows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.teamId, teamId), eq(projects.slug, slugOrName)))
    .limit(1);
  if (rows[0]) return rows[0];
  const byName = await db
    .select()
    .from(projects)
    .where(and(eq(projects.teamId, teamId), eq(projects.name, slugOrName)))
    .limit(1);
  if (byName[0]) return byName[0];
  const repositoryIdentity = canonicalProjectName(slugOrName);
  const [byRepository] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.teamId, teamId),
        eq(projects.repositoryIdentity, repositoryIdentity),
      ),
    )
    .limit(1);
  if (byRepository) return byRepository;
  // Projects are born from a repo identifier that gets canonicalised and then
  // slugified, so a caller passing any spelling of the same identifier later
  // must resolve the same way — otherwise a policy lookup quietly answers "no
  // project" for a project that exists, or worse, forks the conflict radar.
  const slug = slugify(repositoryIdentity);
  if (!slug || slug === slugOrName) return undefined;
  const bySlugified = await db
    .select()
    .from(projects)
    .where(and(eq(projects.teamId, teamId), eq(projects.slug, slug)))
    .limit(1);
  return bySlugified[0];
}

/**
 * A project somebody *named* — a display name, slug or repository from the
 * console or `list_projects` — as opposed to one a checkout proved with its
 * repository identity. The existing project comes first, found the way every
 * reader finds it; only a spelling that names none creates one.
 *
 * The write resolver on its own matches a bare name only against projects with
 * no recorded repository. That is right for evidence, where a basename proves
 * no repository, and wrong for a pointer: the display name of a repository-bound
 * project was answered with a new name-only sibling (`…-legacy`) beside it, so
 * a brief filed there never reached the hook listening in the real project
 * (found 2026-09-19 through `assign_work`). Delivery flows, assignments and
 * handoffs made without a run name projects this way. A project-scoped
 * credential keeps writing to its own project, whatever it typed.
 */
export async function namedProject(
  db: Db,
  team: typeof teams.$inferSelect,
  spelling: string,
  userId: string | null,
  fixedProjectId: string | null = null,
): Promise<{ project: Project; created: boolean } | { error: string }> {
  if (!fixedProjectId) {
    const existing = await projectForTeam(db, team.id, spelling);
    if (existing) return { project: existing, created: false };
  }
  return resolveProjectForWrite(db, team, spelling, userId, { fixedProjectId });
}
