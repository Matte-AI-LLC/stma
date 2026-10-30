import { WORK_LIMITS, parseWorkKey, type WorkBlockerKind, type WorkCommandOf, type WorkState } from '@bridge/shared';
import { and, asc, count, eq, inArray, isNull, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { Db } from '../db';
import { users, workAcceptances, workBlockers, workDependencies, workItems } from '../db/schema';
import { isCanonicalUuid } from '../lib/ids';
import { memberByUsername } from './access';
import { agentMayReport, hasContractAuthority } from './workAccess';
import {
  principalId,
  refuse,
  type WorkAccess,
  type WorkItemRow,
  type WorkOpContext,
  type WorkOpResult,
  type WorkPrincipal,
} from './workTypes';

/**
 * Dependencies and blockers: what stops a work item, kept apart from its
 * lifecycle. A dependency says this work waits on another work of the same
 * project being accepted at a contract revision; a blocker is a stored record
 * with an owner and a next step. One blocker is never stored: a work whose
 * acceptor can no longer decide on it reads as `acceptor_unavailable` on every
 * read, and the read writes nothing.
 *
 * Every rule that decides whether a work is blocked is written once, as SQL
 * over table aliases, and used twice: by `blockingState` for the reply and by
 * `blockedWorkSql` for the list filter and its tab counts. Two spellings of one
 * rule are how a tab count comes to disagree with the rows under it.
 */

// ---------------------------------------------------------------------------
// The rules, as SQL. Each builder takes the alias of the row it reads and uses
// its own aliases inside, so it can be nested in any query, including one that
// reads `work_items` unaliased: a qualified `"work_items"."id"` from the outer
// query cannot bind to an aliased table inside.
// ---------------------------------------------------------------------------

const alias = (name: string) => sql.raw(name);

/**
 * Has the set of upstreams this work was accepted against changed: an upstream
 * reopened, revised or re-accepted, or a dependency added or removed since.
 * `w` is the accepted work, `a` its current acceptance, whose stored manifest
 * carries the snapshot `dependencySnapshot` produced when it was decided. A
 * manifest with no snapshot reads as an empty one, so a work that depends on
 * something and recorded nothing is reported changed rather than assumed fine.
 */
function snapshotChangedSql(w: string, a: string): SQL {
  const W = alias(w);
  const A = alias(a);
  const stored = sql`case when jsonb_typeof(${A}.evidence_manifest -> 'dependencies') = 'array'
    then ${A}.evidence_manifest -> 'dependencies' else '[]'::jsonb end`;
  const current = sql`select dd.depends_on_id::text, du.current_acceptance_id::text, du.spec_revision
    from work_dependencies dd join work_items du on du.id = dd.depends_on_id where dd.work_id = ${W}.id`;
  const recorded = sql`select sn.work_id, sn.acceptance_id, sn.spec_revision
    from jsonb_to_recordset(${stored}) as sn(work_id text, acceptance_id text, spec_revision integer)`;
  return sql`(exists (${current} except ${recorded}) or exists (${recorded} except ${current}))`;
}

/**
 * Has what an acceptance `a` of work `w` read moved without its evidence epoch
 * moving. The epoch moves with every report, delivery, decision and provider
 * fact; three inputs of the manifest change without one, and each makes
 * `acceptanceIsStale` in `workEvidence.ts` answer stale, so the edge must too:
 * a repository binding disconnected, moved or unverified (a provider check
 * then reads unavailable), the project's repository identity changed, and a
 * checkpoint the evidence named deleted with its run (read as unavailable).
 * Read off the manifest stored whole on the acceptance: the providers' verified
 * repositories, in the order the manifest lists them, and the evidence rows it
 * read as current or stale. Anything subtler that moves the manifest with no
 * epoch (a binding replaced by one of the same name, which drops its facts) is
 * still read by the manifest comparison alone; this covers what an owner does.
 */
function acceptanceInputsMovedSql(w: string, a: string): SQL {
  const W = alias(w);
  const A = alias(a);
  const providers = sql`case when jsonb_typeof(${A}.evidence_manifest -> 'scope' -> 'providers') = 'array'
    then ${A}.evidence_manifest -> 'scope' -> 'providers' else '[]'::jsonb end`;
  const verified = sql`coalesce((select jsonb_agg(sb.full_name order by sb.full_name) from repository_bindings sb
    where sb.project_id = ${W}.project_id and sb.team_id = ${W}.team_id and sb.provider = sp.provider
      and sb.verified_at is not null), '[]'::jsonb)`;
  const read = sql`select se.value from jsonb_array_elements(case when jsonb_typeof(${A}.evidence_manifest -> 'criteria') = 'array'
      then ${A}.evidence_manifest -> 'criteria' else '[]'::jsonb end) sc,
    jsonb_array_elements(case when jsonb_typeof(sc.value -> 'evidence') = 'array' then sc.value -> 'evidence' else '[]'::jsonb end) se`;
  return sql`(
    exists (select 1 from jsonb_to_recordset(${providers}) as sp(provider text, repositories jsonb)
      where coalesce(sp.repositories, '[]'::jsonb) is distinct from ${verified})
    or (${A}.evidence_manifest -> 'scope' ->> 'repository_identity') is distinct from
      (select sj.repository_identity from projects sj where sj.id = ${W}.project_id)
    or exists (select 1 from (${read}) as sr(ev)
      where sr.ev ->> 'source_kind' = 'checkpoint' and sr.ev ->> 'validity' in ('current', 'stale')
        and not exists (select 1 from run_checkpoints sk where sk.id = case
          when lower(sr.ev ->> 'source_ref') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then lower(sr.ev ->> 'source_ref')::uuid end))
  )`;
}

/**
 * Does the edge `e` (a `work_dependencies` row) fail to be met by its upstream
 * `u` and that upstream's current acceptance `a` (left joined, so it may be
 * null). Met means: accepted, by an accept decision that is still current (its
 * revision and evidence epoch are the upstream's own, and nothing it read has
 * moved without the epoch), at or above the revision the edge requires, and
 * against the upstreams it was itself accepted with. The epoch is how W04 marks
 * an acceptance stale once evidence moved under it.
 */
function edgeUnmetSql(e: string, u: string, a: string): SQL {
  const E = alias(e);
  const U = alias(u);
  const A = alias(a);
  return sql`not (
    ${U}.state = 'accepted'
    and ${A}.id is not null
    and ${A}.work_id = ${U}.id
    and ${A}.decision = 'accept'
    and ${A}.spec_revision = ${U}.spec_revision
    and ${A}.evidence_epoch = ${U}.evidence_epoch
    and not ${acceptanceInputsMovedSql(u, a)}
    and ${A}.spec_revision >= coalesce(${E}.required_spec_revision, 0)
    and not ${snapshotChangedSql(u, a)}
  )`;
}

/**
 * Is anything this work depends on, directly or through other work, unmet: an
 * edge anywhere in its upstream closure that its upstream does not meet. An
 * accepted upstream that itself waits on something does not stand for the work
 * behind it, so one reopen far upstream reaches every work that leans on it.
 * `union` (not `union all`) bounds the walk even if a cycle were ever stored.
 */
function unmetDependencySql(workId: SQLWrapper): SQL {
  return sql`exists (
    with recursive reach(id) as (
      select ${workId}::uuid
      union
      select rd.depends_on_id from work_dependencies rd join reach on rd.work_id = reach.id
    )
    select 1 from reach
    join work_dependencies ed on ed.work_id = reach.id
    join work_items eu on eu.id = ed.depends_on_id
    left join work_acceptances ea on ea.id = eu.current_acceptance_id
    where ${edgeUnmetSql('ed', 'eu', 'ea')}
  )`;
}

/**
 * Nobody named on this open work can decide on it: past draft it has no
 * acceptor, or the acceptor it names is no longer a member of the workspace.
 * The core membership row is read, never a viewer's membership filter, so the
 * answer is the same whoever asks and can be stored on an event; an
 * organization deactivating a member deletes that row too.
 */
function acceptorUnavailableSql(w: string): SQL {
  const W = alias(w);
  return sql`(${W}.state not in ('accepted', 'cancelled') and (
    (${W}.acceptor_user_id is null and ${W}.state <> 'draft')
    or (${W}.acceptor_user_id is not null and not exists (
      select 1 from memberships am where am.team_id = ${W}.team_id and am.user_id = ${W}.acceptor_user_id))
  ))`;
}

/**
 * The same answer as `blockingState(...).blocked`, as a SQL predicate over a
 * `work_items.id` column, for list filters and tab counts that cannot call a
 * function per row. Closed and archived work is never blocked: nothing is
 * waiting to move it.
 */
export function blockedWorkSql(workId: SQLWrapper): SQL {
  return sql`exists (
    select 1 from work_items bw
    where bw.id = ${workId}
      and bw.archived_at is null
      and bw.state not in ('accepted', 'cancelled')
      and (
        exists (select 1 from work_blockers bb where bb.work_id = bw.id and bb.resolved_at is null)
        or ${acceptorUnavailableSql('bw')}
        or ${unmetDependencySql(sql.raw('bw.id'))}
      )
  )`;
}

// ---------------------------------------------------------------------------
// The reply.
// ---------------------------------------------------------------------------

const SHORT_TEXT_CHARS = 200;
const trim = (value: string, max: number) => (value.length > max ? `${value.slice(0, max)}…` : value);

/** One open blocker as a reader sees it. A derived one has no id: it is stored nowhere. */
export interface BlockingBlocker {
  id: string | null;
  kind: WorkBlockerKind;
  reason: string;
  owner: string | null;
  next_action: string;
  created_at: string | null;
  derived: boolean;
}

/**
 * Why a direct dependency is not met. `reopened_since`: the upstream was
 * accepted once and is not now. `acceptance_stale`: it is accepted, but that
 * acceptance no longer holds (its evidence moved, or the work it was accepted
 * against changed). `upstream_unmet`: it is accepted, but waits on something
 * further up that is not.
 */
export type UnmetDependencyReason =
  | 'not_accepted'
  | 'reopened_since'
  | 'revision_below_required'
  | 'acceptance_stale'
  | 'upstream_unmet';

export interface UnmetDependency {
  work_id: string;
  key: string;
  state: WorkState;
  spec_revision: number;
  required_spec_revision: number | null;
  why: UnmetDependencyReason;
}

/** What stops one work item: an open blocker or an upstream dependency not yet met. */
export interface WorkBlockingState {
  blocked: boolean;
  /** Open blockers, the derived one included. */
  openBlockers: number;
  /** Direct dependencies not met. */
  unmetDependencies: number;
  /** Derived first, then oldest first. */
  blockers: readonly BlockingBlocker[];
  /** In upstream number order. */
  unmet: readonly UnmetDependency[];
  /** Shown in `blockers` as a derived `acceptor_unavailable`. */
  acceptorUnavailable: boolean;
  /**
   * Accepted work only: what it was accepted against has changed since (an
   * upstream reopened, revised or re-accepted, a dependency added or removed,
   * or an upstream no longer met). The acceptance itself stays as it was.
   */
  dependencyChanged: boolean;
}

export const NOT_BLOCKED: WorkBlockingState = Object.freeze({
  blocked: false,
  openBlockers: 0,
  unmetDependencies: 0,
  blockers: Object.freeze([]) as readonly BlockingBlocker[],
  unmet: Object.freeze([]) as readonly UnmetDependency[],
  acceptorUnavailable: false,
  dependencyChanged: false,
});

const CLOSED_STATES: readonly string[] = ['accepted', 'cancelled'];

/**
 * Per work id; a work missing from the map reads as NOT_BLOCKED. A read: it
 * never writes, the derived blocker included. A fixed number of queries
 * whatever the number of works, each bounded by the per-work limits.
 */
export async function blockingState(db: Db, workIds: readonly string[]): Promise<Map<string, WorkBlockingState>> {
  const ids = [...new Set(workIds)];
  if (!ids.length) return new Map();

  const rows = await db
    .select({
      id: workItems.id,
      state: workItems.state,
      archivedAt: workItems.archivedAt,
      acceptorUserId: workItems.acceptorUserId,
      ownerUsername: users.username,
      acceptorUnavailable: sql<boolean>`exists (
        select 1 from work_items aw where aw.id = ${workItems.id} and ${acceptorUnavailableSql('aw')})`,
      snapshotChanged: sql<boolean>`exists (
        select 1 from work_items cw
        join work_acceptances ca on ca.id = cw.current_acceptance_id and ca.work_id = cw.id
        where cw.id = ${workItems.id} and cw.state = 'accepted' and ${snapshotChangedSql('cw', 'ca')})`,
    })
    .from(workItems)
    .leftJoin(users, eq(users.id, workItems.ownerUserId))
    .where(inArray(workItems.id, ids));
  if (!rows.length) return new Map();
  const present = rows.map((row) => row.id);

  const open = await db
    .select({ blocker: workBlockers, ownerUsername: users.username })
    .from(workBlockers)
    .leftJoin(users, eq(users.id, workBlockers.ownerUserId))
    .where(and(inArray(workBlockers.workId, present), isNull(workBlockers.resolvedAt)))
    .orderBy(asc(workBlockers.createdAt), asc(workBlockers.id));

  // The edge verdict is read through `edgeUnmetSql` itself, joined back by the
  // edge's key, so the reason a reader is given can never disagree with the
  // predicate the list filter runs.
  const edges = await db
    .select({
      workId: workDependencies.workId,
      upstreamId: workItems.id,
      key: workItems.displayKey,
      state: workItems.state,
      specRevision: workItems.specRevision,
      required: workDependencies.requiredSpecRevision,
      acceptanceDecision: workAcceptances.decision,
      acceptanceRevision: workAcceptances.specRevision,
      edgeUnmet: sql<boolean>`exists (
        select 1 from work_dependencies ed
        join work_items eu on eu.id = ed.depends_on_id
        left join work_acceptances ea on ea.id = eu.current_acceptance_id
        where ed.work_id = ${workDependencies.workId} and ed.depends_on_id = ${workDependencies.dependsOnId}
          and ${edgeUnmetSql('ed', 'eu', 'ea')})`,
      upstreamUnmet: sql<boolean>`${unmetDependencySql(workDependencies.dependsOnId)}`,
      everAccepted: sql<boolean>`exists (
        select 1 from work_acceptances ha where ha.work_id = ${workDependencies.dependsOnId} and ha.decision = 'accept')`,
    })
    .from(workDependencies)
    .innerJoin(workItems, eq(workItems.id, workDependencies.dependsOnId))
    .leftJoin(workAcceptances, eq(workAcceptances.id, workItems.currentAcceptanceId))
    .where(inArray(workDependencies.workId, present))
    .orderBy(asc(workItems.number));

  const blockersByWork = new Map<string, BlockingBlocker[]>();
  for (const { blocker, ownerUsername } of open) {
    const list = blockersByWork.get(blocker.workId) ?? [];
    list.push({
      id: blocker.id,
      kind: blocker.kind as WorkBlockerKind,
      reason: trim(blocker.reason, SHORT_TEXT_CHARS),
      owner: ownerUsername ?? null,
      next_action: blocker.nextAction,
      created_at: blocker.createdAt.toISOString(),
      derived: false,
    });
    blockersByWork.set(blocker.workId, list);
  }

  const unmetByWork = new Map<string, UnmetDependency[]>();
  for (const edge of edges) {
    const why = unmetReason(edge);
    if (!why) continue;
    const list = unmetByWork.get(edge.workId) ?? [];
    list.push({
      work_id: edge.upstreamId,
      key: edge.key,
      state: edge.state as WorkState,
      spec_revision: edge.specRevision,
      required_spec_revision: edge.required,
      why,
    });
    unmetByWork.set(edge.workId, list);
  }

  const result = new Map<string, WorkBlockingState>();
  for (const row of rows) {
    const stored = blockersByWork.get(row.id) ?? [];
    const acceptorUnavailable = row.acceptorUnavailable === true;
    const blockers: BlockingBlocker[] = acceptorUnavailable
      ? [
          {
            id: null,
            kind: 'acceptor_unavailable',
            reason: row.acceptorUserId
              ? 'The acceptor named on this work is no longer a member of this workspace.'
              : 'This work has no acceptor, so nobody is named to decide on it.',
            owner: row.ownerUsername ?? null,
            next_action: "The work's owner or a workspace owner names an acceptor who is a member (patch acceptor).",
            created_at: null,
            derived: true,
          },
          ...stored,
        ]
      : stored;
    const unmet = unmetByWork.get(row.id) ?? [];
    const open = row.archivedAt === null && !CLOSED_STATES.includes(row.state);
    result.set(row.id, {
      blocked: open && (stored.length > 0 || acceptorUnavailable || unmet.length > 0),
      openBlockers: blockers.length,
      unmetDependencies: unmet.length,
      blockers,
      unmet,
      acceptorUnavailable,
      dependencyChanged: row.state === 'accepted' && (row.snapshotChanged === true || unmet.length > 0),
    });
  }
  return result;
}

/**
 * The reason for one direct edge, in the order a reader can act on: an
 * upstream not accepted at all, then one accepted below the revision required,
 * then one whose acceptance no longer holds, then one that holds but leans on
 * something that does not. Null when the edge is met.
 */
function unmetReason(edge: {
  state: string;
  required: number | null;
  acceptanceDecision: string | null;
  acceptanceRevision: number | null;
  edgeUnmet: boolean;
  upstreamUnmet: boolean;
  everAccepted: boolean;
}): UnmetDependencyReason | null {
  if (edge.edgeUnmet !== true) return edge.upstreamUnmet === true ? 'upstream_unmet' : null;
  if (edge.state !== 'accepted') return edge.everAccepted === true ? 'reopened_since' : 'not_accepted';
  if (
    edge.acceptanceDecision === 'accept' &&
    edge.acceptanceRevision !== null &&
    edge.acceptanceRevision < (edge.required ?? 0)
  ) {
    return 'revision_below_required';
  }
  return 'acceptance_stale';
}

/** One upstream as a work depends on it at one moment. */
export interface DependencySnapshotEntry {
  work_id: string;
  key: string;
  /** The upstream's current acceptance; null when it has none. */
  acceptance_id: string | null;
  spec_revision: number;
  required_spec_revision: number | null;
}

/**
 * The upstream acceptances and revisions this work depends on right now, in
 * work id order so the same set always hashes the same. W04 stores it in an
 * acceptance's evidence manifest under `dependencies`; `blockingState` compares
 * that stored copy with this one to report `dependencyChanged`, matching on
 * work id, acceptance id and revision.
 */
export async function dependencySnapshot(db: Db, workId: string): Promise<DependencySnapshotEntry[]> {
  const rows = await db
    .select({
      workId: workItems.id,
      key: workItems.displayKey,
      acceptanceId: workItems.currentAcceptanceId,
      specRevision: workItems.specRevision,
      required: workDependencies.requiredSpecRevision,
    })
    .from(workDependencies)
    .innerJoin(workItems, eq(workItems.id, workDependencies.dependsOnId))
    .where(eq(workDependencies.workId, workId))
    .orderBy(asc(workItems.id));
  return rows.map((row) => ({
    work_id: row.workId,
    key: row.key,
    acceptance_id: row.acceptanceId,
    spec_revision: row.specRevision,
    required_spec_revision: row.required,
  }));
}

// ---------------------------------------------------------------------------
// The four operations. Each runs inside the command envelope, which already
// holds the project counter lock and the work's own row: every Work mutation in
// a project waits on that counter, so the cycle check below reads a graph no
// other transaction can change before this one commits.
// ---------------------------------------------------------------------------

const NOT_IN_PROJECT = 'No work with that id or key is visible in this project.';
const CYCLE_PATH_KEYS = 12;

function commandParts(ctx: WorkOpContext): { principal: WorkPrincipal; access: WorkAccess; work: WorkItemRow } {
  if (!ctx.principal || !ctx.access || !ctx.work) throw new Error('A Work update needs a principal and its work.');
  return { principal: ctx.principal, access: ctx.access, work: ctx.work };
}

const archivedRefusal = () =>
  refuse('INVALID_TRANSITION', 'Archived work is read-only.', { next_action: 'Reopen it with a reason first.' });

const closedRefusal = (work: WorkItemRow, what: string) =>
  refuse('INVALID_TRANSITION', `Work in ${work.state} is closed; its ${what} cannot change.`, {
    next_action: 'Reopen it with a reason first.',
  });

function requireDependencyAuthority(principal: WorkPrincipal, access: WorkAccess, work: WorkItemRow) {
  if (hasContractAuthority(principal, access, work)) return;
  if (principal.kind === 'agent') {
    throw refuse(
      'FORBIDDEN',
      "An agent cannot change dependencies; the work's owner, its acceptor or a workspace owner does that.",
      { next_action: 'To ask for one, record a blocker of kind dependency.' },
    );
  }
  throw refuse('FORBIDDEN', "Only the work's owner, its acceptor or a workspace owner may change its dependencies.");
}

/**
 * A work of this project named by its id or its key. Anything else, a work of
 * another project or workspace included, is NOT_FOUND: an id the caller cannot
 * reach from here does not exist for this operation, and a key is a label
 * inside one project only.
 */
async function workInProject(tx: Db, ctx: WorkOpContext, ref: string) {
  const spelling = ref.trim();
  const scope = and(eq(workItems.projectId, ctx.projectId), eq(workItems.teamId, ctx.teamId));
  let condition: SQL | undefined;
  if (isCanonicalUuid(spelling)) condition = eq(workItems.id, spelling.toLowerCase());
  else {
    const number = parseWorkKey(spelling);
    if (number) condition = eq(workItems.number, BigInt(number));
  }
  const [row] = condition
    ? await tx
        .select({ id: workItems.id, key: workItems.displayKey })
        .from(workItems)
        .where(and(scope, condition))
        .limit(1)
    : [];
  if (!row) throw refuse('NOT_FOUND', NOT_IN_PROJECT, { fields: ['payload.depends_on'] });
  return row;
}

/**
 * The upstream path from `from` to `to` through existing edges, by work id, or
 * null when `to` is not upstream of `from`. Reachability is one recursive query;
 * the path is only built when there is one, from the edges of `from`'s closure.
 */
async function upstreamPath(tx: Db, from: string, to: string): Promise<string[] | null> {
  const closure = sql`with recursive reach(id) as (
      select ${from}::uuid
      union
      select cd.depends_on_id from work_dependencies cd join reach on cd.work_id = reach.id
    ) select id from reach`;
  const [hit] = await tx
    .select({ id: workItems.id })
    .from(workItems)
    .where(and(eq(workItems.id, to), sql`${workItems.id} in (${closure})`))
    .limit(1);
  if (!hit) return null;
  const edges = await tx
    .select({ from: workDependencies.workId, to: workDependencies.dependsOnId })
    .from(workDependencies)
    .where(sql`${workDependencies.workId} in (${closure})`);
  const next = new Map<string, string[]>();
  for (const edge of edges) next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
  const parent = new Map<string, string>([[from, from]]);
  const queue = [from];
  while (queue.length) {
    const node = queue.shift()!;
    if (node === to) break;
    for (const up of next.get(node) ?? []) {
      if (parent.has(up)) continue;
      parent.set(up, node);
      queue.push(up);
    }
  }
  if (!parent.has(to)) return [from, to];
  const path = [to];
  while (path[0] !== from) path.unshift(parent.get(path[0]!)!);
  return path;
}

async function keysFor(tx: Db, ids: readonly string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await tx
    .select({ id: workItems.id, key: workItems.displayKey })
    .from(workItems)
    .where(inArray(workItems.id, [...new Set(ids)]));
  return new Map(rows.map((row) => [row.id, row.key]));
}

export async function addDependency(
  tx: Db,
  ctx: WorkOpContext,
  payload: WorkCommandOf<'add_dependency'>['payload'],
): Promise<WorkOpResult> {
  const { principal, access, work } = commandParts(ctx);
  if (work.archivedAt) throw archivedRefusal();
  requireDependencyAuthority(principal, access, work);
  if (CLOSED_STATES.includes(work.state)) throw closedRefusal(work, 'dependencies');

  const target = await workInProject(tx, ctx, payload.depends_on);
  if (target.id === work.id) {
    throw refuse('INVALID_INPUT', 'A work item cannot depend on itself.', { fields: ['payload.depends_on'] });
  }
  // Locked like any work the command touches; the project counter is already
  // held, so this second row lock cannot wait on another Work transaction.
  const upstream = await ctx.lockWork(target.id);
  const required = payload.required_spec_revision ?? upstream.specRevision;
  if (required > upstream.specRevision) {
    throw refuse(
      'INVALID_INPUT',
      `${upstream.displayKey} is at revision ${upstream.specRevision}; a dependency cannot require revision ${required}.`,
      { fields: ['payload.required_spec_revision'] },
    );
  }

  const [existing] = await tx
    .select({ required: workDependencies.requiredSpecRevision })
    .from(workDependencies)
    .where(and(eq(workDependencies.workId, work.id), eq(workDependencies.dependsOnId, upstream.id)))
    .limit(1);
  if (existing) {
    throw refuse(
      'INVALID_INPUT',
      `${work.displayKey} already depends on ${upstream.displayKey}${existing.required === null ? '' : ` at revision ${existing.required}`}.`,
      { fields: ['payload.depends_on'], next_action: 'Remove the dependency first to require another revision.' },
    );
  }
  const [{ used }] = (await tx
    .select({ used: count() })
    .from(workDependencies)
    .where(eq(workDependencies.workId, work.id))) as [{ used: number }];
  if (used >= WORK_LIMITS.dependencies) {
    throw refuse(
      'LIMIT_EXCEEDED',
      `${work.displayKey} already depends on ${used} work items; at most ${WORK_LIMITS.dependencies} are allowed.`,
      { used, limit: WORK_LIMITS.dependencies },
    );
  }

  // The new edge closes a cycle exactly when this work is already upstream of
  // the work it would now wait on.
  const path = await upstreamPath(tx, upstream.id, work.id);
  if (path) {
    const keys = await keysFor(tx, path);
    const shown = path.slice(0, CYCLE_PATH_KEYS).map((id) => keys.get(id) ?? id);
    if (path.length > CYCLE_PATH_KEYS) shown.push('…');
    throw refuse(
      'INVALID_INPUT',
      `${work.displayKey} cannot depend on ${upstream.displayKey}: ${upstream.displayKey} already depends on ${work.displayKey} (${shown.join(' -> ')}), so the new dependency would make a cycle.`,
      { fields: ['payload.depends_on'] },
    );
  }

  await tx.insert(workDependencies).values({
    workId: work.id,
    dependsOnId: upstream.id,
    requiredSpecRevision: required,
    createdByKind: principal.kind,
    createdById: principalId(principal),
    createdAt: ctx.now,
  });
  const state = (await blockingState(tx, [work.id])).get(work.id) ?? NOT_BLOCKED;
  const unmet = state.unmet.find((dependency) => dependency.work_id === upstream.id);
  return {
    events: [
      {
        workId: work.id,
        type: 'work_dependency_added',
        payload: { depends_on: upstream.id, depends_on_key: upstream.displayKey, required_spec_revision: required },
      },
    ],
    resultRef: upstream.id,
    response: {
      dependency: {
        work_id: upstream.id,
        key: upstream.displayKey,
        required_spec_revision: required,
        met: !unmet,
        ...(unmet ? { why: unmet.why } : {}),
      },
    },
  };
}

export async function removeDependency(
  tx: Db,
  ctx: WorkOpContext,
  payload: WorkCommandOf<'remove_dependency'>['payload'],
): Promise<WorkOpResult> {
  const { principal, access, work } = commandParts(ctx);
  if (work.archivedAt) throw archivedRefusal();
  requireDependencyAuthority(principal, access, work);
  if (CLOSED_STATES.includes(work.state)) throw closedRefusal(work, 'dependencies');

  const target = await workInProject(tx, ctx, payload.depends_on);
  const removed = await tx
    .delete(workDependencies)
    .where(and(eq(workDependencies.workId, work.id), eq(workDependencies.dependsOnId, target.id)))
    .returning({ required: workDependencies.requiredSpecRevision });
  if (!removed.length) {
    throw refuse('NOT_FOUND', `${work.displayKey} does not depend on ${target.key}.`, { fields: ['payload.depends_on'] });
  }
  const eventPayload: Record<string, unknown> = { depends_on: target.id, depends_on_key: target.key };
  if (payload.reason) eventPayload.reason = payload.reason;
  return {
    events: [{ workId: work.id, type: 'work_dependency_removed', payload: eventPayload }],
    resultRef: target.id,
    response: { dependency: { work_id: target.id, key: target.key, removed: true } },
  };
}

export async function setBlocker(
  tx: Db,
  ctx: WorkOpContext,
  payload: WorkCommandOf<'set_blocker'>['payload'],
): Promise<WorkOpResult> {
  const { principal, work } = commandParts(ctx);
  if (work.archivedAt) throw archivedRefusal();
  // A person's standing is their membership, which the envelope already read.
  if (principal.kind === 'agent' && !(await agentMayReport(tx, principal, work))) {
    throw refuse(
      'FORBIDDEN',
      'An agent may set a blocker only on work it filed or is linked to: an assignment or handoff to it, or one of its runs.',
    );
  }
  if (CLOSED_STATES.includes(work.state)) throw closedRefusal(work, 'blockers');
  if (payload.kind === 'acceptor_unavailable') {
    throw refuse(
      'INVALID_INPUT',
      "acceptor_unavailable is not set by hand: STMA shows it whenever the work's acceptor cannot decide on it.",
      { fields: ['payload.kind'], next_action: 'Name a new acceptor, or choose another kind.' },
    );
  }

  let ownerUserId: string | null = null;
  if (payload.owner !== undefined) {
    const member = await memberByUsername(tx, ctx.teamId, payload.owner);
    if (!member) {
      throw refuse('INVALID_INPUT', 'payload.owner: no member of this workspace has that username.', {
        fields: ['payload.owner'],
      });
    }
    ownerUserId = member.id;
  }

  // The same open blocker raised again (a poll, a retried report) is the one
  // that is already open: it answers with that row, and history says it was
  // raised again rather than holding two copies of one fact.
  const sourceRef = payload.source_ref ?? '';
  if (sourceRef) {
    const [open] = await tx
      .select({ id: workBlockers.id })
      .from(workBlockers)
      .where(
        and(
          eq(workBlockers.workId, work.id),
          eq(workBlockers.kind, payload.kind),
          eq(workBlockers.sourceRef, sourceRef),
          isNull(workBlockers.resolvedAt),
        ),
      )
      .limit(1);
    if (open) {
      return {
        events: [
          { workId: work.id, type: 'work_blocker_set', payload: { blocker_id: open.id, kind: payload.kind, deduplicated: true } },
        ],
        resultRef: open.id,
        response: { blocker_id: open.id, deduplicated: true },
      };
    }
  }

  const [{ used }] = (await tx
    .select({ used: count() })
    .from(workBlockers)
    .where(and(eq(workBlockers.workId, work.id), isNull(workBlockers.resolvedAt)))) as [{ used: number }];
  if (used >= WORK_LIMITS.openBlockers) {
    throw refuse(
      'LIMIT_EXCEEDED',
      `${work.displayKey} has ${used} open blockers; at most ${WORK_LIMITS.openBlockers} may be open at once.`,
      { used, limit: WORK_LIMITS.openBlockers, next_action: 'Resolve one first.' },
    );
  }
  const [blocker] = await tx
    .insert(workBlockers)
    .values({
      workId: work.id,
      kind: payload.kind,
      ownerUserId,
      reason: payload.reason,
      nextAction: payload.next_action,
      sourceRef,
      createdByKind: principal.kind,
      createdById: principalId(principal),
      createdAt: ctx.now,
    })
    .returning({ id: workBlockers.id });
  return {
    events: [{ workId: work.id, type: 'work_blocker_set', payload: { blocker_id: blocker!.id, kind: payload.kind } }],
    resultRef: blocker!.id,
    response: { blocker_id: blocker!.id, deduplicated: false },
  };
}

/**
 * Who may close a blocker: whoever has contract authority over the work, the
 * person who raised it or the person it names as owner; an agent only the
 * blockers it raised itself.
 */
function mayResolve(
  principal: WorkPrincipal,
  access: WorkAccess,
  work: WorkItemRow,
  blocker: typeof workBlockers.$inferSelect,
): boolean {
  if (principal.kind === 'agent') return blocker.createdByKind === 'agent' && blocker.createdById === principalId(principal);
  return (
    hasContractAuthority(principal, access, work) ||
    (blocker.createdByKind === 'human' && blocker.createdById === principal.userId) ||
    blocker.ownerUserId === principal.userId
  );
}

export async function resolveBlocker(
  tx: Db,
  ctx: WorkOpContext,
  payload: WorkCommandOf<'resolve_blocker'>['payload'],
): Promise<WorkOpResult> {
  const { principal, access, work } = commandParts(ctx);
  if (work.archivedAt) throw archivedRefusal();
  const [blocker] = await tx
    .select()
    .from(workBlockers)
    .where(and(eq(workBlockers.id, payload.blocker_id.toLowerCase()), eq(workBlockers.workId, work.id)))
    .limit(1);
  if (!blocker) {
    throw refuse('NOT_FOUND', `${work.displayKey} has no blocker with that id.`, { fields: ['payload.blocker_id'] });
  }
  if (!mayResolve(principal, access, work, blocker)) {
    throw refuse(
      'FORBIDDEN',
      principal.kind === 'agent'
        ? 'An agent may resolve only the blockers it raised.'
        : "Only the person who raised this blocker, its owner, or the work's owner, acceptor or a workspace owner may resolve it.",
    );
  }
  if (blocker.resolvedAt) {
    throw refuse('INVALID_TRANSITION', 'This blocker is already resolved.', {
      next_action: 'If it is back, set a new blocker; the resolved one stays in the history.',
    });
  }
  await tx
    .update(workBlockers)
    .set({
      resolvedAt: ctx.now,
      resolvedByKind: principal.kind,
      resolvedById: principalId(principal),
      resolutionReason: payload.reason,
    })
    .where(eq(workBlockers.id, blocker.id));
  return {
    events: [
      {
        workId: work.id,
        type: 'work_blocker_resolved',
        payload: { blocker_id: blocker.id, kind: blocker.kind, reason: payload.reason },
      },
    ],
    resultRef: blocker.id,
    response: { blocker_id: blocker.id },
  };
}
