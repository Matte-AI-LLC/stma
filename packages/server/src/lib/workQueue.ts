import { and, count, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '../db';
import { projects, users, workItems, workRevisions } from '../db/schema';
import { blockedWorkSql } from '../domain/workGraph';
import { needsDecisionSql } from '../domain/workRead';

/**
 * What the Work pages count and list across a workspace, from one predicate
 * each. The rail badge and the queue read the same "needs a decision", but
 * they are not the same set and say so: the badge counts what waits for this
 * person (they are the acceptor), while the queue lists every undecided item,
 * because a workspace owner may decide in the acceptor's place with a reason,
 * and marks the ones that are this person's to decide ("Yours to decide"),
 * wherever they are listed and only while a decision is due.
 *
 * "Needs a decision" is the predicate `domain/workRead.ts` uses for the list
 * view of that name (in review, a current delivery, nobody has decided on it
 * yet), imported rather than written again, over `work_items` for queries that
 * are not `listWork`. `work-console.test.ts` still pins the badge against that
 * list view, because the badge adds conditions of its own (the acceptor, the
 * scope) and those can drift where the predicate cannot.
 */

// A wrapper rather than an alias: the rail imports this module, and an alias read
// at load time would depend on which of the two modules a cycle evaluated first.
export const needsDecisionWhere = (): SQL => needsDecisionSql();

/**
 * Work waiting for this person's decision: they are its acceptor. A workspace
 * owner may also decide, with a reason, but that is an override and not
 * "waiting for you", so it is not a number that follows them around the rail.
 */
export async function awaitingDecisionCount(
  db: Db,
  userId: string,
  scope: { teamIds: readonly string[]; projectId?: string },
): Promise<number> {
  if (!scope.teamIds.length) return 0;
  const [row] = await db
    .select({ n: count() })
    .from(workItems)
    .where(
      and(
        inArray(workItems.teamId, [...scope.teamIds]),
        scope.projectId ? eq(workItems.projectId, scope.projectId) : undefined,
        isNull(workItems.archivedAt),
        eq(workItems.acceptorUserId, userId),
        needsDecisionWhere(),
      ),
    );
  return Number(row?.n ?? 0);
}

export interface QueueRow {
  id: string;
  key: string;
  title: string;
  state: string;
  projectSlug: string;
  projectName: string;
  owner: string | null;
  acceptor: string | null;
  /**
   * This person is the acceptor and a decision is due: in review, with a
   * delivery nobody has decided on. Not the acceptor alone, because the same
   * table draws Yours and Blocked, where draft and ready work has nothing to
   * decide.
   */
  decisionIsMine: boolean;
  updatedAt: Date;
}

export interface QueueSection {
  total: number;
  rows: QueueRow[];
}

export interface WorkQueue {
  needsDecision: QueueSection;
  mine: QueueSection;
  blocked: QueueSection;
}

/** Rows shown per section; the page says how many more there are. */
export const QUEUE_ROWS = 25;

const owners = alias(users, 'work_queue_owner');
const acceptors = alias(users, 'work_queue_acceptor');

/** Open work: not archived, and not already closed one way or the other. */
const openWork = (): SQL => sql`(${workItems.archivedAt} is null and ${workItems.state} not in ('accepted', 'cancelled'))`;

async function section(db: Db, where: SQL, userId: string): Promise<QueueSection> {
  const [total] = await db.select({ n: count() }).from(workItems).where(where);
  const rows = await db
    .select({
      id: workItems.id,
      key: workItems.displayKey,
      title: workRevisions.title,
      state: workItems.state,
      projectSlug: projects.slug,
      projectName: projects.name,
      owner: owners.username,
      acceptor: acceptors.username,
      acceptorUserId: workItems.acceptorUserId,
      awaitingDecision: sql<boolean>`(${workItems.archivedAt} is null and ${needsDecisionWhere()})`,
      updatedAt: workItems.updatedAt,
    })
    .from(workItems)
    .innerJoin(projects, eq(projects.id, workItems.projectId))
    .innerJoin(
      workRevisions,
      and(eq(workRevisions.workId, workItems.id), eq(workRevisions.revision, workItems.specRevision)),
    )
    .leftJoin(owners, eq(owners.id, workItems.ownerUserId))
    .leftJoin(acceptors, eq(acceptors.id, workItems.acceptorUserId))
    .where(where)
    .orderBy(desc(workItems.updatedAt), desc(workItems.id))
    .limit(QUEUE_ROWS);
  return {
    total: Number(total?.n ?? 0),
    rows: rows.map((row) => ({
      id: row.id,
      key: row.key,
      title: row.title,
      state: row.state,
      projectSlug: row.projectSlug,
      projectName: row.projectName,
      owner: row.owner,
      acceptor: row.acceptor,
      decisionIsMine: row.acceptorUserId === userId && row.awaitingDecision === true,
      updatedAt: row.updatedAt,
    })),
  };
}

/**
 * The workspace queue: what waits for a decision, what is this person's, and
 * what is blocked, across every project. The caller has proved the person's
 * membership of the workspace; nothing here widens it.
 */
export async function workQueue(db: Db, teamId: string, userId: string): Promise<WorkQueue> {
  const inTeam = eq(workItems.teamId, teamId);
  return {
    needsDecision: await section(db, and(inTeam, isNull(workItems.archivedAt), needsDecisionWhere())!, userId),
    mine: await section(
      db,
      and(inTeam, openWork(), sql`(${workItems.ownerUserId} = ${userId} or ${workItems.acceptorUserId} = ${userId})`)!,
      userId,
    ),
    // The graph's own predicate: the same one the project list's Blocked tab reads.
    blocked: await section(db, and(inTeam, blockedWorkSql(workItems.id))!, userId),
  };
}
