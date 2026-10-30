import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { WORK_LIMITS, fingerprintJson, workFilterSchema, type WorkFilter } from '@bridge/shared';
import { and, asc, count, desc, eq, gt, inArray, isNull, lte, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db';
import {
  projects,
  users,
  workCursorKeys,
  workEvents,
  workItems,
  workRevisions,
  workSnapshots,
} from '../db/schema';
import { isCanonicalUuid } from '../lib/ids';
import { memberByUsername } from './access';
import { workAccess } from './workAccess';
import { NO_EVIDENCE, evidenceState } from './workEvidence';
import { NO_EXTERNAL, externalState } from './workExternal';
import { NOT_BLOCKED, blockedWorkSql, blockingState } from './workGraph';
import { WORK_UNTRUSTED, decisionPending, needsDecisionSql, type WorkFilterFields } from './workRead';
import {
  parseOrRefuse,
  principalId,
  refusalOf,
  refuse,
  wireBigint,
  type WorkAccess,
  type WorkItemRow,
  type WorkPrincipal,
  type WorkResult,
} from './workTypes';

/**
 * What changed in a project's work since a reader last looked (spec 11.1).
 *
 * The first call takes a snapshot of the items a filter matches, together with
 * the project event sequence that snapshot stands at, from one short read-only
 * transaction. Every later call reads the events after a cursor in committed
 * order and turns each work's events into one answer for this reader: an item
 * that entered the filter or changed inside it is an upsert, an item that left
 * it is a tombstone, and an item the reader never saw is skipped while the
 * cursor still moves past it. Membership is judged on the bounded fields each
 * event stored before and after it, never on the current row alone, which is
 * the only way to tell a reader that a `ready` item became `in_progress`. The
 * Blocked view is derived and can move with no event on the work; how it is
 * kept right is under "Membership that moves with no event".
 *
 * A cursor is signed and bound to the project, the filter and what this
 * principal may read. It grants nothing: every page reads access again.
 */

const NOT_VISIBLE_PROJECT = 'No project with that id is visible to this principal.';
const CURSOR_KEY_ID = 'v1';
const CURSOR_MAX_CHARS = 2_000;

/** The same item shape `listWork` answers with, so one client handles both. */
export interface WorkChangeItem {
  id: string;
  key: string;
  state: string;
  version: string;
  spec_revision: number;
  title: string;
  owner: string | null;
  acceptor: string | null;
  priority: string;
  due_at: string | null;
  labels: string[];
  archived: boolean;
  flags: {
    blocked: boolean;
    needs_decision: boolean;
    stale_evidence: boolean;
    acceptance_stale: boolean;
    external_change_pending: boolean;
    dependency_changed: boolean;
  };
  updated_at: string;
}

// ---------------------------------------------------------------------------
// The signing key. The server has no general secret and replicas must agree,
// so the key is a row, made on first use. A cursor carries no authority; the
// signature only makes a tampered one refusable instead of misread.
// ---------------------------------------------------------------------------

const keyCache = new WeakMap<Db, Buffer>();

async function cursorKey(db: Db): Promise<Buffer> {
  const cached = keyCache.get(db);
  if (cached) return cached;
  await db
    .insert(workCursorKeys)
    .values({ id: CURSOR_KEY_ID, secret: randomBytes(32).toString('hex') })
    .onConflictDoNothing();
  const [row] = await db.select().from(workCursorKeys).where(eq(workCursorKeys.id, CURSOR_KEY_ID)).limit(1);
  if (!row) throw new Error('The work cursor key could not be read after it was written.');
  const key = Buffer.from(row.secret, 'hex');
  keyCache.set(db, key);
  return key;
}

/**
 * A delta position, or a page of a stored snapshot. Short keys: a cursor travels in every call.
 * `b`, on the Blocked view only, is the digest of the works whose membership moved with no
 * event on them, as the cursor's position stood (`driftDigest`).
 */
type CursorBody =
  | { v: 1; k: 'd'; p: string; f: string; s: string; q: string; b?: string }
  | { v: 1; k: 's'; p: string; f: string; s: string; q: string; n: string; o: number; b?: string };

const sign = (key: Buffer, body: string) => createHmac('sha256', key).update(body).digest('base64url');

function writeCursor(key: Buffer, body: CursorBody): string {
  const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  return `${encoded}.${sign(key, encoded)}`;
}

const invalidated = (message: string) =>
  refuse('CURSOR_INVALIDATED', message, {
    fields: ['after_cursor'],
    next_action: 'Start again without a cursor: the first page is a fresh snapshot.',
  });

const DECIMAL = /^(0|[1-9][0-9]{0,18})$/;
const HEX64 = /^[a-f0-9]{64}$/;

function readCursor(key: Buffer, raw: string): CursorBody {
  const tampered = () => invalidated('This cursor was not issued by this server, or it was altered.');
  if (typeof raw !== 'string' || raw.length > CURSOR_MAX_CHARS) throw tampered();
  const [encoded, signature, extra] = raw.split('.');
  if (!encoded || !signature || extra !== undefined) throw tampered();
  const expected = Buffer.from(sign(key, encoded), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw tampered();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw tampered();
  }
  const common =
    body.v === 1 &&
    isCanonicalUuid(body.p) &&
    typeof body.f === 'string' &&
    HEX64.test(body.f) &&
    typeof body.s === 'string' &&
    HEX64.test(body.s) &&
    typeof body.q === 'string' &&
    DECIMAL.test(body.q) &&
    (body.b === undefined || (typeof body.b === 'string' && HEX64.test(body.b)));
  if (common && body.k === 'd') return body as CursorBody;
  if (
    common &&
    body.k === 's' &&
    isCanonicalUuid(body.n) &&
    typeof body.o === 'number' &&
    Number.isInteger(body.o) &&
    body.o >= 0 &&
    body.o <= WORK_LIMITS.snapshotMaxItems
  ) {
    return body as CursorBody;
  }
  throw tampered();
}

// ---------------------------------------------------------------------------
// What a cursor is bound to.
// ---------------------------------------------------------------------------

/**
 * The filter as parsed (defaults applied, lists in one order), with its project
 * and the member its owner name resolved to. The name alone was not the
 * filter's meaning: once that member left the workspace it resolved to nobody,
 * every event read as outside the filter, and the reader kept rows a fresh
 * snapshot of the same filter no longer had, with no tombstone and no reset.
 * A name that resolves differently now is a filter that means something else.
 */
function filterFingerprint(projectId: string, filter: WorkFilter, owner: OwnerFilter): string {
  return fingerprintJson({
    project: projectId,
    view: filter.view,
    states: filter.states ? [...new Set(filter.states)].sort() : null,
    owner: filter.owner ?? null,
    ...(filter.owner ? { owner_id: owner ?? null } : {}),
    label: filter.label ?? null,
    include_archived: filter.include_archived,
  });
}

/**
 * Who reads and how far their reach goes: the principal, its credential's scope
 * and its role in the workspace. A cursor issued to somebody else, or before a
 * role or a grant changed, no longer matches, so a reader can never page on
 * under a scope it has lost or gained.
 */
function scopeFingerprint(principal: WorkPrincipal, access: WorkAccess): string {
  return fingerprintJson({
    kind: principal.kind,
    id: principalId(principal),
    scope: principal.kind === 'agent' ? principal.grant.scope : null,
    team: principal.kind === 'agent' ? principal.grant.teamId : null,
    project: principal.kind === 'agent' ? principal.grant.projectId : null,
    role: access.role,
  });
}

// ---------------------------------------------------------------------------
// Membership of a filter. Two spellings of one rule: SQL for the snapshot, the
// stored filter fields for every event after it. They must agree, so they sit
// side by side and the tests replay one against the other.
// ---------------------------------------------------------------------------

/**
 * `owner` resolved once per page: undefined when the filter names nobody, null
 * when it names somebody who is not a member (who then owns nothing here).
 */
type OwnerFilter = string | null | undefined;

/**
 * "Mine" here is the reader's own user id as the work's owner or acceptor, for
 * a person and an agent alike: it is the one notion of mine an event's stored
 * fields can answer for, so the snapshot uses it too.
 */
export function matchesFilter(
  fields: WorkFilterFields | null | undefined,
  filter: WorkFilter,
  userId: string,
  owner: OwnerFilter,
): boolean {
  if (!fields) return false;
  if (!filter.include_archived && fields.archived) return false;
  if (filter.states?.length && !filter.states.includes(fields.state)) return false;
  if (filter.label && !fields.labels.includes(filter.label)) return false;
  if (owner !== undefined && (owner === null || fields.owner_user_id !== owner)) return false;
  switch (filter.view) {
    case 'all':
      return true;
    case 'mine':
      return fields.owner_user_id === userId || fields.acceptor_user_id === userId;
    case 'needs_decision':
      return fields.needs_decision;
    case 'blocked':
      return fields.blocked;
    case 'ready':
    case 'in_progress':
    case 'in_review':
      return fields.state === filter.view;
  }
}

function snapshotConditions(projectId: string, filter: WorkFilter, userId: string, owner: OwnerFilter): SQL[] {
  const conditions: SQL[] = [eq(workItems.projectId, projectId)];
  if (!filter.include_archived) conditions.push(isNull(workItems.archivedAt));
  if (filter.states?.length) conditions.push(inArray(workItems.state, filter.states));
  if (filter.label) conditions.push(sql`${workItems.labels} @> ${JSON.stringify([filter.label])}::jsonb`);
  if (owner !== undefined) conditions.push(owner === null ? sql`false` : eq(workItems.ownerUserId, owner));
  switch (filter.view) {
    case 'all':
      break;
    case 'mine':
      conditions.push(or(eq(workItems.ownerUserId, userId), eq(workItems.acceptorUserId, userId))!);
      break;
    case 'needs_decision':
      // `decisionPending` over the row: workRead's own predicate for its list.
      conditions.push(needsDecisionSql());
      break;
    case 'blocked':
      conditions.push(blockedWorkSql(workItems.id));
      break;
    case 'ready':
    case 'in_progress':
    case 'in_review':
      conditions.push(eq(workItems.state, filter.view));
      break;
  }
  return conditions;
}

// ---------------------------------------------------------------------------
// Membership that moves with no event. `blocked` is derived: an upstream
// accepted, reopened or made stale by a provider fact, or an acceptor removed
// from the workspace, moves a work in or out of the Blocked view and writes no
// event on that work. The stored fields cannot say so, so the Blocked view
// reads two more things. Within the events: a work whose fields before one
// command differ in membership from its fields after the command before (a
// silent move in between, absorbed by its next event) is answered by where it
// stands, upsert or tombstone, never skipped. And at the head of the stream: the
// works whose current membership differs from what their latest event recorded
// (a silent move nothing has absorbed yet) are digested into the cursor; a
// digest that moved means the reader holds a list nothing here can correct, so
// it is told to start again rather than left with a row that moved on.
// ---------------------------------------------------------------------------

const CLOSED_STATES = ['accepted', 'cancelled'];

const DRIFTED =
  'A work entered or left this view through something other than its own events (an upstream accepted, ' +
  'reopened or revised, or an acceptor removed from the workspace), which a delta cannot carry.';

/**
 * The works matching the filter now whose latest event (at or below `upTo`)
 * recorded otherwise, with that event's sequence, as one digest. Read inside
 * the transaction that read the events, so it stands exactly where they end.
 * Closed work is never blocked, and closing it writes an event, so only open
 * work is read.
 */
async function driftDigest(tx: Db, scope: PageScope, upTo: bigint): Promise<string> {
  const { filter, principal, owner, bound } = scope;
  const matching = new Set(
    (
      await tx
        .select({ id: workItems.id })
        .from(workItems)
        .where(and(...snapshotConditions(bound.project, filter, principal.userId, owner)))
    ).map((row) => row.id),
  );
  const latest = await tx
    .selectDistinctOn([workEvents.workId], { workId: workEvents.workId, seq: workEvents.projectSeq, after: workEvents.filterAfter })
    .from(workEvents)
    .innerJoin(workItems, eq(workItems.id, workEvents.workId))
    .where(
      and(
        eq(workEvents.projectId, bound.project),
        lte(workEvents.projectSeq, upTo),
        notInArray(workItems.state, CLOSED_STATES),
      ),
    )
    .orderBy(workEvents.workId, desc(workEvents.projectSeq));
  const recorded = new Map(latest.map((row) => [row.workId, row]));
  const drift: string[] = [];
  for (const id of new Set([...matching, ...recorded.keys()])) {
    const row = recorded.get(id);
    const now = matching.has(id);
    const then = row ? matchesFilter(row.after as WorkFilterFields, filter, principal.userId, owner) : false;
    if (now !== then) drift.push(`${id}:${now ? 1 : 0}:${row?.seq ?? 0n}`);
  }
  return fingerprintJson(drift.sort());
}

interface ScannedEvent {
  seq: bigint;
  workId: string;
  workVersion: bigint;
  filterBefore: unknown;
  filterAfter: unknown;
}

/**
 * The works of a page whose membership moved between two of their commands
 * with no event: one command's fields before disagree with the previous
 * command's fields after. Events of one command share a version and carry the
 * same before and after, so only a change of version is a boundary. The
 * command before the page is read too, so a move just before the cursor counts.
 */
async function silentMoves(tx: Db, scope: PageScope, scanned: readonly ScannedEvent[], after: bigint): Promise<Set<string>> {
  const { filter, principal, owner, bound } = scope;
  const ids = [...new Set(scanned.map((event) => event.workId))];
  const moved = new Set<string>();
  if (!ids.length) return moved;
  const match = (fields: unknown) => matchesFilter(fields as WorkFilterFields | null, filter, principal.userId, owner);
  const prior = await tx
    .selectDistinctOn([workEvents.workId], {
      workId: workEvents.workId,
      workVersion: workEvents.workVersion,
      after: workEvents.filterAfter,
    })
    .from(workEvents)
    .where(and(eq(workEvents.projectId, bound.project), inArray(workEvents.workId, ids), lte(workEvents.projectSeq, after)))
    .orderBy(workEvents.workId, desc(workEvents.projectSeq));
  const last = new Map(prior.map((row) => [row.workId, { version: row.workVersion, matched: match(row.after) }]));
  for (const event of scanned) {
    const previous = last.get(event.workId);
    if (previous && previous.version !== event.workVersion && previous.matched !== match(event.filterBefore)) {
      moved.add(event.workId);
    }
    last.set(event.workId, { version: event.workVersion, matched: match(event.filterAfter) });
  }
  return moved;
}

// ---------------------------------------------------------------------------
// Items. Read in a fixed number of queries per page, whatever its size.
// ---------------------------------------------------------------------------

async function itemsFor(db: Db, works: readonly WorkItemRow[]): Promise<WorkChangeItem[]> {
  if (!works.length) return [];
  const ids = works.map((work) => work.id);
  const titles = new Map(
    (
      await db
        .select({ id: workRevisions.workId, title: workRevisions.title })
        .from(workRevisions)
        .innerJoin(
          workItems,
          and(eq(workItems.id, workRevisions.workId), eq(workItems.specRevision, workRevisions.revision)),
        )
        .where(inArray(workRevisions.workId, ids))
    ).map((row) => [row.id, row.title]),
  );
  const blocking = await blockingState(db, ids);
  const evidence = await evidenceState(db, ids);
  const external = await externalState(db, ids);
  const pending = await decisionPending(db, works);
  const userIds = [...new Set(works.flatMap((work) => [work.ownerUserId, work.acceptorUserId]).filter((id): id is string => Boolean(id)))];
  const names = new Map(
    userIds.length
      ? (await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, userIds))).map(
          (row) => [row.id, row.username],
        )
      : [],
  );
  return works.map((work) => ({
    id: work.id,
    key: work.displayKey,
    state: work.state,
    version: wireBigint(work.version),
    spec_revision: work.specRevision,
    title: titles.get(work.id) ?? '',
    owner: work.ownerUserId ? (names.get(work.ownerUserId) ?? null) : null,
    acceptor: work.acceptorUserId ? (names.get(work.acceptorUserId) ?? null) : null,
    priority: work.priority,
    due_at: work.dueAt?.toISOString() ?? null,
    labels: work.labels,
    archived: work.archivedAt !== null,
    flags: {
      blocked: (blocking.get(work.id) ?? NOT_BLOCKED).blocked,
      needs_decision: pending.has(work.id),
      stale_evidence: (evidence.get(work.id) ?? NO_EVIDENCE).staleEvidence,
      acceptance_stale: (evidence.get(work.id) ?? NO_EVIDENCE).acceptanceStale,
      external_change_pending: (external.get(work.id) ?? NO_EXTERNAL).changePending,
      dependency_changed: (blocking.get(work.id) ?? NOT_BLOCKED).dependencyChanged,
    },
    updated_at: work.updatedAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// The read.
// ---------------------------------------------------------------------------

export interface WorkChangesPage {
  afterCursor?: string | null;
  limit?: number;
}

/**
 * One page of changes for this principal. Without a cursor: a snapshot (the
 * whole filtered set when it fits on one page, otherwise its first page and a
 * snapshot cursor). With a delta cursor: the events after it, collapsed per work.
 */
export async function getWorkChanges(
  db: Db,
  principal: WorkPrincipal,
  projectId: string,
  rawFilter: Partial<WorkFilter> | Record<string, unknown> = {},
  page: WorkChangesPage = {},
): Promise<WorkResult<Record<string, unknown>>> {
  try {
    if (!isCanonicalUuid(projectId)) throw refuse('NOT_FOUND', NOT_VISIBLE_PROJECT);
    const [project] = await db
      .select({ id: projects.id, teamId: projects.teamId })
      .from(projects)
      .where(eq(projects.id, projectId.toLowerCase()))
      .limit(1);
    if (!project) throw refuse('NOT_FOUND', NOT_VISIBLE_PROJECT);
    // Every page, not just the first: a cursor is never authority.
    const access = await workAccess(db, principal, project.teamId, project.id);
    if (!access) throw refuse('NOT_FOUND', NOT_VISIBLE_PROJECT);
    const filter = parseOrRefuse(workFilterSchema, rawFilter ?? {}, 'filter.');
    const limit = Math.min(Math.max(page.limit ?? WORK_LIMITS.changesDefault, 1), WORK_LIMITS.changesMax);
    const owner: OwnerFilter = filter.owner
      ? ((await memberByUsername(db, project.teamId, filter.owner))?.id ?? null)
      : undefined;
    const bound = {
      project: project.id,
      filter: filterFingerprint(project.id, filter, owner),
      scope: scopeFingerprint(principal, access),
    };
    const key = await cursorKey(db);
    const scope = { db, principal, filter, owner, limit, key, bound };

    if (!page.afterCursor) return await firstPage(scope);
    const cursor = readCursor(key, page.afterCursor);
    if (cursor.p !== bound.project) throw invalidated('This cursor was issued for another project.');
    if (cursor.f !== bound.filter) {
      throw invalidated(
        filter.owner
          ? 'The filter is not the one this cursor was issued for, or the owner it names is no longer the same member of this workspace. Send the same filter with every page.'
          : 'The filter is not the one this cursor was issued for. Send the same filter with every page.',
      );
    }
    if (cursor.s !== bound.scope) {
      throw invalidated(
        'This cursor was issued to another principal, or what this principal may read has changed since it was issued.',
      );
    }
    if (cursor.k === 's') return await snapshotPage(scope, cursor);
    return await deltaPage(scope, cursor);
  } catch (error) {
    return refusalOf(error);
  }
}

interface PageScope {
  db: Db;
  principal: WorkPrincipal;
  filter: WorkFilter;
  owner: OwnerFilter;
  limit: number;
  key: Buffer;
  bound: { project: string; filter: string; scope: string };
}

const deltaCursor = (scope: PageScope, seq: bigint, drift?: string) =>
  writeCursor(scope.key, {
    v: 1,
    k: 'd',
    p: scope.bound.project,
    f: scope.bound.filter,
    s: scope.bound.scope,
    q: seq.toString(),
    ...(drift ? { b: drift } : {}),
  });

/** The Blocked view's membership is derived, and the only view that needs `driftDigest`. */
const derivedView = (filter: WorkFilter) => filter.view === 'blocked';

/**
 * `asOf` is the moment the items were read: a later page of a stored snapshot
 * says when that snapshot was taken, never when the page was sent, because
 * its rows are as they were then and silence is not freshness.
 */
const reply = (body: Record<string, unknown>, asOf: Date = new Date()) => ({
  ...body,
  as_of: asOf.toISOString(),
  untrusted: WORK_UNTRUSTED,
});

/**
 * The snapshot and the sequence it stands at come from one read-only
 * transaction, REPEATABLE READ where the driver honours it, so no event can be
 * both inside the items and after `as_of_seq`. Events commit in sequence order
 * (the project counter row is held until commit), so nothing below that
 * number can still arrive.
 */
async function firstPage(scope: PageScope): Promise<Record<string, unknown>> {
  const { db, principal, filter, owner, bound } = scope;
  // Taken before the read, so the moment a page says it stands at is never
  // later than what it holds. Kept with a stored snapshot for its later pages.
  const takenAt = new Date();
  const taken = await db.transaction(
    async (transaction) => {
      const tx = transaction as unknown as Db;
      const [stand] = await tx
        .select({ seq: sql<string>`coalesce(max(${workEvents.projectSeq}), 0)::text` })
        .from(workEvents)
        .where(eq(workEvents.projectId, bound.project));
      const conditions = snapshotConditions(bound.project, filter, principal.userId, owner);
      const rows = await tx
        .select()
        .from(workItems)
        .where(and(...conditions))
        .orderBy(desc(workItems.updatedAt), desc(workItems.id))
        .limit(WORK_LIMITS.snapshotMaxItems + 1);
      if (rows.length > WORK_LIMITS.snapshotMaxItems) {
        const [{ used }] = (await tx.select({ used: count() }).from(workItems).where(and(...conditions))) as [{ used: number }];
        return { tooMany: Number(used) } as const;
      }
      const asOfSeq = BigInt(stand?.seq ?? '0');
      // Read from the same snapshot, so a silent move already standing here is
      // the reader's starting point and never mistaken for a new one.
      const drift = derivedView(filter) ? await driftDigest(tx, scope, asOfSeq) : undefined;
      return { items: await itemsFor(tx, rows), asOfSeq, drift } as const;
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
  if ('tooMany' in taken) {
    throw refuse(
      'LIMIT_EXCEEDED',
      `This filter matches ${taken.tooMany} work items; a snapshot holds at most ${WORK_LIMITS.snapshotMaxItems}.`,
      {
        used: taken.tooMany,
        limit: WORK_LIMITS.snapshotMaxItems,
        fields: ['filter'],
        next_action: 'Narrow the filter (a view, states, an owner or a label) and start again.',
      },
    );
  }
  const { items, asOfSeq, drift } = taken;
  if (items.length <= scope.limit) {
    return reply({
      mode: 'snapshot',
      reset: true,
      upserts: items,
      tombstones: [],
      next_cursor: deltaCursor(scope, asOfSeq, drift),
      has_more: false,
      as_of_seq: wireBigint(asOfSeq),
    }, takenAt);
  }
  // More than one page: keep the projection, never an open transaction, so the
  // later pages answer from the same moment.
  const [stored] = await db
    .insert(workSnapshots)
    .values({
      principalKind: principal.kind,
      principalId: principalId(principal),
      projectId: bound.project,
      filterFingerprint: bound.filter,
      scopeFingerprint: bound.scope,
      asOfSeq,
      items,
      createdAt: takenAt,
      expiresAt: new Date(Date.now() + WORK_LIMITS.snapshotTtlSeconds * 1000),
    })
    .returning({ id: workSnapshots.id });
  return reply({
    mode: 'snapshot',
    reset: true,
    upserts: items.slice(0, scope.limit),
    tombstones: [],
    next_cursor: writeCursor(scope.key, {
      v: 1,
      k: 's',
      p: bound.project,
      f: bound.filter,
      s: bound.scope,
      q: asOfSeq.toString(),
      n: stored!.id,
      o: scope.limit,
      ...(drift ? { b: drift } : {}),
    }),
    has_more: true,
    as_of_seq: wireBigint(asOfSeq),
    snapshot_items: items.length,
  }, takenAt);
}

async function snapshotPage(scope: PageScope, cursor: Extract<CursorBody, { k: 's' }>): Promise<Record<string, unknown>> {
  const { db, principal, bound } = scope;
  const [stored] = await db.select().from(workSnapshots).where(eq(workSnapshots.id, cursor.n)).limit(1);
  if (!stored || stored.expiresAt <= new Date()) {
    throw refuse(
      'CURSOR_EXPIRED',
      `This snapshot was kept for ${WORK_LIMITS.snapshotTtlSeconds / 60} minutes and has expired.`,
      { fields: ['after_cursor'], next_action: 'Start again without a cursor: the first page is a fresh snapshot.' },
    );
  }
  // Signed already; checked against the row as well, so a snapshot can only
  // ever be read back by the principal, project, filter and scope it was made for.
  if (
    stored.principalKind !== principal.kind ||
    stored.principalId !== principalId(principal) ||
    stored.projectId !== bound.project ||
    stored.filterFingerprint !== bound.filter ||
    stored.scopeFingerprint !== bound.scope ||
    stored.asOfSeq.toString() !== cursor.q
  ) {
    throw invalidated('This cursor does not belong to this snapshot.');
  }
  const items = stored.items as WorkChangeItem[];
  const end = cursor.o + scope.limit;
  const more = end < items.length;
  return reply({
    mode: 'snapshot',
    reset: false,
    upserts: items.slice(cursor.o, end),
    tombstones: [],
    next_cursor: more
      ? writeCursor(scope.key, { ...cursor, o: end })
      : deltaCursor(scope, stored.asOfSeq, cursor.b),
    has_more: more,
    as_of_seq: wireBigint(stored.asOfSeq),
    snapshot_items: items.length,
  }, stored.createdAt);
}

/**
 * Events after the cursor, in committed order, collapsed per work: the first
 * event's `filter_before` is how the reader last saw it and the last event's
 * `filter_after` is how it stands at the end of this page. A page that skipped
 * everything still moves the cursor to the last sequence it read, so a reader
 * filtering on a quiet view never loops on the same events.
 */
async function deltaPage(scope: PageScope, cursor: Extract<CursorBody, { k: 'd' }>): Promise<Record<string, unknown>> {
  const { db, principal, filter, owner, bound, limit } = scope;
  const after = BigInt(cursor.q);
  const derived = derivedView(filter);
  // A Blocked cursor that carries no digest cannot be checked, so it is
  // refused rather than trusted to be current.
  if (derived && !cursor.b) throw invalidated(DRIFTED);
  const read = async (tx: Db) => {
    const events: ScannedEvent[] = await tx
      .select({
        seq: workEvents.projectSeq,
        workId: workEvents.workId,
        workVersion: workEvents.workVersion,
        filterBefore: workEvents.filterBefore,
        filterAfter: workEvents.filterAfter,
      })
      .from(workEvents)
      .where(and(eq(workEvents.projectId, bound.project), gt(workEvents.projectSeq, after)))
      .orderBy(asc(workEvents.projectSeq))
      .limit(limit + 1);
    const scanned = events.slice(0, limit);
    const more = events.length > limit;
    const last = scanned.length ? scanned[scanned.length - 1]!.seq : after;
    if (!derived) return { scanned, more, last, moved: new Set<string>(), drift: undefined };
    const moved = await silentMoves(tx, scope, scanned, after);
    // Checked where the page reaches the head of the stream, so the digest and
    // the events stand at one sequence. A page with more behind it hands the
    // reader's digest on unchanged.
    if (!more && (await driftDigest(tx, scope, last)) !== cursor.b) throw invalidated(DRIFTED);
    return { scanned, more, last, moved, drift: cursor.b };
  };
  const { scanned, more, last, moved, drift } = derived
    ? await db.transaction((transaction) => read(transaction as unknown as Db), {
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
      })
    : await read(db);

  const byWork = new Map<string, { before: WorkFilterFields | null; after: WorkFilterFields; seq: bigint }>();
  for (const event of scanned) {
    const held = byWork.get(event.workId);
    if (held) {
      held.after = event.filterAfter as WorkFilterFields;
      held.seq = event.seq;
    } else {
      byWork.set(event.workId, {
        before: (event.filterBefore as WorkFilterFields | null) ?? null,
        after: event.filterAfter as WorkFilterFields,
        seq: event.seq,
      });
    }
  }
  const upsertIds: string[] = [];
  const tombstoneIds: string[] = [];
  for (const [workId, change] of [...byWork].sort(([, a], [, b]) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))) {
    const was = matchesFilter(change.before, filter, principal.userId, owner);
    const is = matchesFilter(change.after, filter, principal.userId, owner);
    if (is) upsertIds.push(workId);
    // A work that moved silently may be on the reader's list whatever `was`
    // says, so it is answered by where it stands.
    else if (was || moved.has(workId)) tombstoneIds.push(workId);
  }
  const ids = [...upsertIds, ...tombstoneIds];
  const rows = ids.length ? await db.select().from(workItems).where(inArray(workItems.id, ids)) : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const items = await itemsFor(
    db,
    upsertIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
  );
  const itemsById = new Map(items.map((item) => [item.id, item]));
  return reply({
    mode: 'delta',
    reset: false,
    upserts: upsertIds.flatMap((id) => (itemsById.has(id) ? [itemsById.get(id)!] : [])),
    // Only the identity, which the reader may read: a tombstone says nothing new.
    tombstones: tombstoneIds.flatMap((id) => (byId.has(id) ? [{ work_id: id, key: byId.get(id)!.displayKey }] : [])),
    next_cursor: deltaCursor(scope, last, drift),
    has_more: more,
    as_of_seq: wireBigint(last),
    events_read: scanned.length,
  });
}
