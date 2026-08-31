import { and, eq } from 'drizzle-orm';
import type { Db } from '../db';
import { memberships, projects, teams } from '../db/schema';
import { canonicalProjectName } from '../lib/projects';
import { slugify } from '../lib/slug';

export async function teamForUser(db: Db, userId: string, slug: string) {
  const rows = await db
    .select({ team: teams, role: memberships.role })
    .from(memberships)
    .innerJoin(teams, eq(memberships.teamId, teams.id))
    .where(and(eq(memberships.userId, userId), eq(teams.slug, slug)))
    .limit(1);
  return rows[0];
}

export async function projectForTeam(db: Db, teamId: string, slugOrName: string) {
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
  // Projects are born from a repo identifier that gets canonicalised and then
  // slugified, so a caller passing any spelling of the same identifier later
  // must resolve the same way — otherwise a policy lookup quietly answers "no
  // project" for a project that exists, or worse, forks the conflict radar.
  const slug = slugify(canonicalProjectName(slugOrName));
  if (!slug || slug === slugOrName) return undefined;
  const bySlugified = await db
    .select()
    .from(projects)
    .where(and(eq(projects.teamId, teamId), eq(projects.slug, slug)))
    .limit(1);
  return bySlugified[0];
}

