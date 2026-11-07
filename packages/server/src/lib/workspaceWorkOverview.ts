import { and, asc, count, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../db';
import { memberships, projects, users, workItems, workRevisions } from '../db/schema';
import { membershipUser } from './securityHooks';
import { blockedWorkSql, blockingState } from '../domain/workGraph';
import { needsDecisionSql } from '../domain/workRead';

/** Browser-only reader. No work transitions or agent instructions originate here. */
export const WORKSPACE_WORK_PROJECT_LIMIT = 100;
export const WORKSPACE_WORK_ITEM_LIMIT = 20;
export const WORKSPACE_WORK_VIEWS = ['open', 'needs_decision', 'blocked', 'ready', 'in_progress'] as const;
export type WorkspaceWorkView = (typeof WORKSPACE_WORK_VIEWS)[number];
const OPEN_STATES = ['draft', 'ready', 'in_progress', 'in_review'];

export async function workspaceWorkOverview(db: Db, userId: string, teamId: string, requestedView?: string) {
  // In particular, organization membership/proof and project-only roles must not
  // gain an aggregate read by entering through a workspace URL.
  const [member] = await db.select({ id: memberships.userId }).from(memberships)
    .where(and(eq(memberships.teamId, teamId), membershipUser(userId))).limit(1);
  if (!member) return null;
  const view: WorkspaceWorkView = WORKSPACE_WORK_VIEWS.includes(requestedView as WorkspaceWorkView)
    ? requestedView as WorkspaceWorkView : 'open';
  const projectRows = await db.select({ id: projects.id, slug: projects.slug, name: projects.name })
    .from(projects).where(eq(projects.teamId, teamId)).orderBy(asc(projects.name), asc(projects.id))
    .limit(WORKSPACE_WORK_PROJECT_LIMIT + 1);
  const shownProjects = projectRows.slice(0, WORKSPACE_WORK_PROJECT_LIMIT);
  const projectIds = shownProjects.map((p) => p.id);
  const projectMap = new Map(shownProjects.map((p) => [p.id, p]));
  const empty = {
    view, projectsTruncated: projectRows.length > WORKSPACE_WORK_PROJECT_LIMIT,
    projectCount: shownProjects.length,
    totals: { open: 0, ready: 0, in_progress: 0, in_review: 0 },
    projects: shownProjects.map((p) => ({ ...p, open: 0, ready: 0, in_progress: 0, in_review: 0 })),
    items: [] as {
      id: string; key: string; title: string; state: string; projectSlug: string; projectName: string;
      owner: string | null; updatedAt: Date; blocked: boolean; waiting: string | null;
    }[],
    moreItems: false,
  };
  if (!projectIds.length) return empty;
  const scope = and(eq(workItems.teamId, teamId), inArray(workItems.projectId, projectIds), isNull(workItems.archivedAt));
  const counts = await db.select({ projectId: workItems.projectId, state: workItems.state, n: count() })
    .from(workItems).where(and(scope, inArray(workItems.state, OPEN_STATES)))
    .groupBy(workItems.projectId, workItems.state);
  const summaries = new Map(empty.projects.map((p) => [p.id, p]));
  for (const row of counts) {
    const project = summaries.get(row.projectId)!;
    const n = Number(row.n);
    project.open += n;
    empty.totals.open += n;
    if (row.state === 'ready' || row.state === 'in_progress' || row.state === 'in_review') {
      project[row.state] += n;
      empty.totals[row.state] += n;
    }
  }
  const filter = view === 'blocked' ? blockedWorkSql(workItems.id)
    : view === 'needs_decision' ? needsDecisionSql()
      : view === 'open' ? inArray(workItems.state, OPEN_STATES) : eq(workItems.state, view);
  const rows = await db.select({
    id: workItems.id, key: workItems.displayKey, title: workRevisions.title, state: workItems.state,
    projectId: workItems.projectId, owner: users.username, updatedAt: workItems.updatedAt,
  }).from(workItems)
    .innerJoin(workRevisions, and(eq(workRevisions.workId, workItems.id), eq(workRevisions.revision, workItems.specRevision)))
    .leftJoin(users, eq(users.id, workItems.ownerUserId))
    .where(and(scope, filter)).orderBy(asc(workItems.updatedAt), asc(workItems.id))
    .limit(WORKSPACE_WORK_ITEM_LIMIT + 1);
  const shown = rows.slice(0, WORKSPACE_WORK_ITEM_LIMIT);
  const blocking = await blockingState(db, shown.map((r) => r.id));
  return {
    ...empty,
    moreItems: rows.length > WORKSPACE_WORK_ITEM_LIMIT,
    items: shown.map((row) => {
      const project = projectMap.get(row.projectId)!;
      const blocked = blocking.get(row.id);
      return {
        ...row, projectSlug: project.slug, projectName: project.name, blocked: blocked?.blocked ?? false,
        waiting: blocked?.blocked
          ? blocked.blockers[0]?.reason ?? (blocked.unmetDependencies ? 'Waiting on a dependency.' : 'Open blocker.')
          : null,
      };
    }),
  };
}

export type WorkspaceWorkOverviewData = NonNullable<Awaited<ReturnType<typeof workspaceWorkOverview>>>;
