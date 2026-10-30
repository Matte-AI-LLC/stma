import { randomUUID } from 'node:crypto';
import {
  WORK_TRANSITIONS,
  WORK_TRANSITION_TARGETS,
  canonicalJson,
  fingerprintJson,
  isWorkTransitionAllowed,
  missingForReady,
  workCommandSchema,
  workCreateSchema,
  workDisplayKey,
  workEnvelopeSchema,
  type WorkCommand,
  type WorkCommandOf,
  type WorkCreateInput,
  type WorkOperation,
  type WorkReconcileExternalPayload,
  type WorkState,
} from '@bridge/shared';
import { and, count, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db';
import type { Env } from '../env';
import {
  memberships,
  projects,
  users,
  workCommands,
  workEvents,
  workItems,
  workProjectCounters,
} from '../db/schema';
import { isHosted } from '../lib/entitlements';
import { grantAllowsProject } from '../lib/grants';
import { membershipUser } from '../lib/securityHooks';
import { publishChange } from '../lib/stream';
import { track } from '../lib/track';
import { memberByUsername, projectForTeam } from './access';
import { hasContractAuthority, isOwnDraft, workAccess } from './workAccess';
import {
  EXTERNALLY_OWNED_FIELDS,
  assertLocallyOwned,
  authoritativeRef,
  externalForCreate,
  prepareCreateExternal,
  prepareReconcile,
  reconcileExternal,
} from './workExternal';
import { addDependency, removeDependency, resolveBlocker, setBlocker } from './workGraph';
import { assignWork, linkTarget } from './workLinks';
import {
  activeExecution,
  currentDeliveryIsForRevision,
  currentDeliveryReviewable,
  filterFieldsFor,
  nextActionsForWork,
  type WorkFilterFields,
} from './workRead';
import {
  applyContractPatch,
  buildCriteria,
  changedContractFields,
  contentFromCreate,
  loadRevision,
  revisionContentHash,
  usedCriterionIds,
  writeRevision,
} from './workRevisions';
import {
  actorId,
  actorKind,
  actorUserId,
  parseOrRefuse,
  principalId,
  refusalOf,
  refuse,
  wireBigint,
  type WorkAccess,
  type WorkActor,
  type WorkCommandOutcome,
  type WorkEventDraft,
  type WorkItemRow,
  type WorkOpContext,
  type WorkOpResult,
  type WorkPrincipal,
  type WorkResult,
} from './workTypes';

/**
 * Native Work's one write path. Every mutation of a work item, from MCP, REST
 * or the console, goes through `runWorkCommand`; a side effect that rides
 * another domain's transaction goes through `mutateWorkInTransaction`. Both run
 * the same locked scope: the project counter row first (it serializes every
 * Work mutation in one project and hands out numbers and event sequences), then
 * the work rows, then the handler, then one version step and the events in the
 * same commit. Work locks are always the last locks a transaction takes.
 *
 * Inserting a row is a lock too: PostgreSQL checks each foreign key by taking
 * `for key share` on the row it names (the workspace of every event, the run
 * of a delivery, the installation an assignment targets, the token behind a
 * message). So a transaction that holds a row lock while it waits for a Work
 * lock takes that row `for no key update`, never `for update`: the second
 * conflicts with `key share`, and a Work command already holding the lock and
 * inserting a row that names it would wait on that transaction while that
 * transaction waits on it. `work-links.test.ts` reads every lock taken before
 * a Work lock to hold the rule.
 */

/** A hosted engineering guardrail, not a plan entitlement: self-hosted instances never apply it. */
export const WORK_HOSTED_MAX_ITEMS_PER_PROJECT = 5_000;

const NOT_VISIBLE = 'No work with that id is visible to this principal.';

/** The few events a lead acts on reach the activity feed; the rest stay in the Work trail. */
const TRACKED_EVENT_TYPES = new Set(['work_created', 'work_delivered', 'work_accepted', 'work_changes_requested']);

function activityAction(event: WorkEventDraft): string | null {
  if (TRACKED_EVENT_TYPES.has(event.type)) return event.type;
  // Something now contradicts what was accepted: the acceptance stays, and a lead looks.
  if (event.type === 'acceptance_stale') return 'work_acceptance_stale';
  if (event.type === 'work_state_changed') {
    if (event.payload.to === 'ready') return 'work_ready';
    if (event.payload.to === 'cancelled') return 'work_cancelled';
  }
  return null;
}

interface LockedScope {
  tx: Db;
  actor: WorkActor;
  teamId: string;
  projectId: string;
  now: Date;
  nextWorkNumber: bigint;
  nextEventSeq: bigint;
  works: Map<string, WorkItemRow>;
  before: Map<string, WorkFilterFields>;
}

/**
 * Step 2: the project counter. Inserted on first use and then locked, so the
 * first Work mutation in a project and every later one take the same lock.
 */
async function openScope(tx: Db, actor: WorkActor, teamId: string, projectId: string, now: Date): Promise<LockedScope> {
  const [project] = await tx
    .select({ teamId: projects.teamId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project || project.teamId !== teamId) throw refuse('NOT_FOUND', NOT_VISIBLE);
  await tx.insert(workProjectCounters).values({ projectId, teamId }).onConflictDoNothing();
  const [counter] = await tx
    .select()
    .from(workProjectCounters)
    .where(eq(workProjectCounters.projectId, projectId))
    .for('update');
  if (!counter || counter.teamId !== teamId) throw refuse('NOT_FOUND', NOT_VISIBLE);
  return {
    tx,
    actor,
    teamId,
    projectId,
    now,
    nextWorkNumber: counter.nextWorkNumber,
    nextEventSeq: counter.nextEventSeq,
    works: new Map(),
    before: new Map(),
  };
}

/**
 * Step 3, one row: lock it, prove it belongs to the scope, and remember how it
 * read before anything changed (the event's `filter_before`). A work in another
 * project is NOT_FOUND, exactly like a work that does not exist.
 */
async function lockWorkRow(scope: LockedScope, workId: string): Promise<WorkItemRow> {
  const held = scope.works.get(workId);
  if (held) return held;
  const [row] = await scope.tx.select().from(workItems).where(eq(workItems.id, workId)).for('update');
  if (!row || row.teamId !== scope.teamId || row.projectId !== scope.projectId) {
    throw refuse('NOT_FOUND', NOT_VISIBLE);
  }
  scope.works.set(row.id, row);
  scope.before.set(row.id, (await filterFieldsFor(scope.tx, [row])).get(row.id)!);
  return row;
}

function contextFor(scope: LockedScope, access: WorkAccess | null, primary: WorkItemRow | null): WorkOpContext {
  return {
    actor: scope.actor,
    principal: scope.actor.kind === 'system' ? null : scope.actor,
    access,
    teamId: scope.teamId,
    projectId: scope.projectId,
    now: scope.now,
    work: primary,
    works: scope.works,
    lockWork: (workId) => lockWorkRow(scope, workId),
    allocateWorkNumber: () => scope.nextWorkNumber++,
  };
}

interface Written {
  rows: Map<string, WorkItemRow>;
  lastSeq: Map<string, bigint>;
  tracked: { action: string; key: string }[];
}

/**
 * Step 5: one version step per work the command wrote an event for, one
 * sequence number per event, the filter fields before and after, and the
 * counter written back. A work this command created starts at version 1.
 */
async function finishScope(scope: LockedScope, result: WorkOpResult, primaryId: string | null): Promise<Written> {
  if (!result.events.length) throw new Error('A Work command must write at least one event.');
  const created = new Set(result.created ?? []);
  const touched = [...new Set(result.events.map((event) => event.workId))];
  if (primaryId && !touched.includes(primaryId)) {
    throw new Error('A Work command must write an event for the work it names.');
  }
  for (const workId of touched) {
    if (created.has(workId)) continue;
    const held = scope.works.get(workId);
    if (!held) throw new Error('A Work event names a work that was neither locked nor created.');
    await scope.tx
      .update(workItems)
      .set({ version: held.version + 1n, updatedAt: scope.now })
      .where(eq(workItems.id, workId));
  }
  const fresh = await scope.tx.select().from(workItems).where(inArray(workItems.id, touched));
  const rows = new Map(fresh.map((row) => [row.id, row]));
  if (rows.size !== touched.length) throw new Error('A Work event names a work that does not exist.');
  const after = await filterFieldsFor(scope.tx, fresh);

  const lastSeq = new Map<string, bigint>();
  const tracked: Written['tracked'] = [];
  const values = result.events.map((event) => {
    const row = rows.get(event.workId)!;
    const seq = scope.nextEventSeq++;
    lastSeq.set(event.workId, seq);
    const action = activityAction(event);
    if (action) tracked.push({ action, key: row.displayKey });
    return {
      teamId: scope.teamId,
      projectId: scope.projectId,
      projectSeq: seq,
      workId: event.workId,
      workVersion: row.version,
      type: event.type,
      actorKind: actorKind(scope.actor),
      actorId: actorId(scope.actor),
      actorUserId: actorUserId(scope.actor),
      // Stamped here so a replay, which keeps no copy of the reply, can still
      // say which revision the command left the work at.
      payload: { ...event.payload, spec_revision: row.specRevision },
      filterBefore: created.has(event.workId) ? null : (scope.before.get(event.workId) ?? null),
      filterAfter: after.get(event.workId)!,
      createdAt: scope.now,
    };
  });
  await scope.tx.insert(workEvents).values(values);
  await scope.tx
    .update(workProjectCounters)
    .set({ nextWorkNumber: scope.nextWorkNumber, nextEventSeq: scope.nextEventSeq })
    .where(eq(workProjectCounters.projectId, scope.projectId));
  return { rows, lastSeq, tracked };
}

async function afterWorkCommit(
  db: Db,
  actor: WorkActor,
  teamId: string,
  projectId: string,
  written: Written,
  result: WorkOpResult,
): Promise<void> {
  publishChange(teamId, 'work');
  for (const entry of written.tracked) {
    await track(db, {
      teamId,
      projectId,
      userId: actorUserId(actor),
      tokenId: actor.kind === 'agent' ? actor.tokenId : null,
      action: entry.action,
      // The key only: a title is somebody's text, and the feed line reads as STMA's.
      detail: entry.key,
    });
  }
  await result.afterCommit?.(db);
}

export interface WorkCommandSpec {
  /** The caller's idempotency key, a uuid. */
  requestId: string;
  /** `create`, an update operation, `submit`, `record_evidence` or `decision`. */
  operation: string;
  teamId: string;
  projectId: string;
  /** The work the command is about; generated by the caller for a create. */
  workId: string;
  /** Null only for a create. */
  expectedVersion: bigint | null;
  /** `{ operation, work_id | project_id, expected_version, payload }`, canonicalized and hashed. */
  hashInput: unknown;
}

/**
 * The command envelope (design section 3). Everything happens in one
 * transaction, in this order: reserve the receipt slot (a replay or a reused
 * request id is answered here and writes nothing), lock the project counter,
 * lock the work, re-check access and the expected version, apply, then step
 * the version, write the events and fill the receipt. A refusal is thrown, so
 * the receipt rolls back with everything else.
 */
export async function runWorkCommand(
  db: Db,
  principal: WorkPrincipal,
  cmd: WorkCommandSpec,
  apply: (tx: Db, ctx: WorkOpContext) => Promise<WorkOpResult>,
): Promise<WorkResult<WorkCommandOutcome>> {
  const canonicalHash = fingerprintJson(cmd.hashInput);
  const key = {
    principalKind: principal.kind,
    principalId: principalId(principal),
    requestId: cmd.requestId,
  };
  const receipt = and(
    eq(workCommands.principalKind, key.principalKind),
    eq(workCommands.principalId, key.principalId),
    eq(workCommands.requestId, key.requestId),
  );
  const now = new Date();
  let done:
    | { outcome: WorkCommandOutcome; replay: true }
    | { outcome: WorkCommandOutcome; replay: false; written: Written | null; result: WorkOpResult };
  try {
    done = await db.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      // Before the receipt and before any lock: a door that found the work by
      // id alone (the REST commands, deliveries and evidence) must answer a work
      // outside the caller's reach exactly as one that does not exist. Read
      // after the slot, a reused request id answered REQUEST_ID_REUSED for it,
      // and a new one took the other project's counter and row locks first.
      if (!(await workAccess(tx, principal, cmd.teamId, cmd.projectId))) throw refuse('NOT_FOUND', NOT_VISIBLE);
      const [slot] = await tx
        .insert(workCommands)
        .values({
          ...key,
          operation: cmd.operation,
          canonicalHash,
          teamId: cmd.teamId,
          projectId: cmd.projectId,
          workId: cmd.workId,
          scopeSnapshot: scopeSnapshot(principal),
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning({ requestId: workCommands.requestId });
      if (!slot) {
        const [existing] = await tx.select().from(workCommands).where(receipt).limit(1);
        if (!existing) throw new Error('A Work receipt conflicted and then could not be read.');
        if (existing.canonicalHash !== canonicalHash) {
          throw refuse(
            'REQUEST_ID_REUSED',
            'This request_id was already used for a different command. Retry the original unchanged, or use a new request_id for new work.',
          );
        }
        return { outcome: await replayOutcome(tx, principal, existing), replay: true as const };
      }

      const scope = await openScope(tx, principal, cmd.teamId, cmd.projectId, now);
      const primary = cmd.expectedVersion === null ? null : await lockWorkRow(scope, cmd.workId);
      // A receipt is not authority and neither is a remembered id: access is
      // read again here, under the locks, every time.
      const access = await workAccess(tx, principal, cmd.teamId, cmd.projectId);
      if (!access) throw refuse('NOT_FOUND', NOT_VISIBLE);
      if (primary && primary.version !== cmd.expectedVersion) {
        throw refuse(
          'VERSION_CONFLICT',
          `The work is at version ${primary.version}; this command expected ${cmd.expectedVersion}. Read it again and send a new command.`,
          { current_version: wireBigint(primary.version) },
        );
      }
      const result = await apply(tx, contextFor(scope, access, primary));
      if (result.unchanged) {
        if (!primary || result.events.length) throw new Error('Only a command about an existing work, writing nothing, is unchanged.');
        // The receipt still answers a retry, with the version the work was at,
        // and says it wrote nothing: the events at that version are another
        // command's, and a retry answered with their sequence named a change
        // this request never made.
        await tx
          .update(workCommands)
          .set({ resultVersion: primary.version, resultRef: result.resultRef ?? null, unchanged: true })
          .where(receipt);
        const outcome: WorkCommandOutcome = {
          ...(result.response ?? {}),
          work_id: primary.id,
          key: primary.displayKey,
          version: wireBigint(primary.version),
          spec_revision: primary.specRevision,
          event_seq: null,
          state: primary.state as WorkState,
          next_actions: await nextActionsForWork(tx, principal, access, primary),
          replayed: false,
        };
        return { outcome, replay: false as const, written: null, result };
      }
      const written = await finishScope(scope, result, cmd.workId);
      const row = written.rows.get(cmd.workId);
      if (!row) throw new Error('A Work command finished without its own work.');
      await tx
        .update(workCommands)
        .set({ resultVersion: row.version, resultRef: result.resultRef ?? null })
        .where(receipt);
      const outcome: WorkCommandOutcome = {
        ...(result.response ?? {}),
        work_id: row.id,
        key: row.displayKey,
        version: wireBigint(row.version),
        spec_revision: row.specRevision,
        event_seq: wireBigint(written.lastSeq.get(row.id)!),
        state: row.state as WorkState,
        next_actions: await nextActionsForWork(tx, principal, access, row),
        replayed: false,
      };
      return { outcome, replay: false as const, written, result };
    });
  } catch (error) {
    return refusalOf(error);
  }
  // An unchanged command wrote nothing, so there is nothing to announce.
  if (!done.replay && done.written) await afterWorkCommit(db, principal, cmd.teamId, cmd.projectId, done.written, done.result);
  return done.outcome;
}

/** What the receipt keeps about the credential the command was made under. Never a secret. */
function scopeSnapshot(principal: WorkPrincipal): Record<string, unknown> {
  if (principal.kind === 'human') return { kind: 'human' };
  return {
    kind: 'agent',
    scope: principal.grant.scope,
    teamId: principal.grant.teamId,
    projectId: principal.grant.projectId,
    tokenId: principal.tokenId,
    installationId: principal.installationId,
  };
}

/**
 * The answer to a retried command. It keeps no copy of the original reply, so
 * it is rebuilt from the receipt and the events that command wrote, after the
 * principal's access is checked again: a revoked credential holding an old
 * request id reads nothing.
 */
async function replayOutcome(
  tx: Db,
  principal: WorkPrincipal,
  existing: typeof workCommands.$inferSelect,
): Promise<WorkCommandOutcome> {
  const [row] = await tx.select().from(workItems).where(eq(workItems.id, existing.workId)).limit(1);
  if (!row) throw refuse('NOT_FOUND', NOT_VISIBLE);
  const access = await workAccess(tx, principal, row.teamId, row.projectId);
  if (!access || existing.resultVersion === null) throw refuse('NOT_FOUND', NOT_VISIBLE);
  const events = await tx
    .select({ seq: workEvents.projectSeq, payload: workEvents.payload, filterAfter: workEvents.filterAfter })
    .from(workEvents)
    .where(and(eq(workEvents.workId, row.id), eq(workEvents.workVersion, existing.resultVersion)));
  const last = events.reduce<(typeof events)[number] | undefined>(
    (best, event) => (!best || event.seq > best.seq ? event : best),
    undefined,
  );
  const recordedState = (last?.filterAfter as { state?: string } | undefined)?.state;
  const recordedRevision = (last?.payload as { spec_revision?: unknown } | undefined)?.spec_revision;
  // The state and revision at that version are still read from those events,
  // whoever wrote them: they describe the version the command answered with.
  const outcome: WorkCommandOutcome = {
    work_id: row.id,
    key: row.displayKey,
    version: wireBigint(existing.resultVersion),
    spec_revision: typeof recordedRevision === 'number' ? recordedRevision : row.specRevision,
    event_seq: last && !existing.unchanged ? wireBigint(last.seq) : null,
    state: (recordedState ?? row.state) as WorkState,
    next_actions: await nextActionsForWork(tx, principal, access, row),
    replayed: true,
    result_ref: existing.resultRef,
  };
  if (row.version !== existing.resultVersion) outcome.current_version = wireBigint(row.version);
  return outcome;
}

/**
 * Steps 2 to 5 inside a transaction somebody else opened, without a receipt:
 * a run start linking its run, a provider fact moving the evidence epoch. The
 * caller has already decided the act is allowed; a principal actor still has
 * its access to the project read again. A refusal is thrown as `WorkRefusal`,
 * which rolls the caller's transaction back unless the caller catches it.
 * Call `afterCommit(db)` once the caller's transaction has committed.
 */
export async function mutateWorkInTransaction(
  tx: Db,
  input: { teamId: string; projectId: string; workIds: readonly string[]; actor: WorkActor },
  fn: (tx: Db, ctx: WorkOpContext) => Promise<WorkOpResult>,
): Promise<{
  versions: Map<string, bigint>;
  eventSeqs: Map<string, bigint>;
  response: Record<string, unknown>;
  afterCommit: (db: Db) => Promise<void>;
}> {
  const scope = await openScope(tx, input.actor, input.teamId, input.projectId, new Date());
  for (const workId of [...new Set(input.workIds)].sort()) await lockWorkRow(scope, workId);
  let access: WorkAccess | null = null;
  if (input.actor.kind !== 'system') {
    access = await workAccess(tx, input.actor, input.teamId, input.projectId);
    if (!access) throw refuse('NOT_FOUND', NOT_VISIBLE);
  }
  const primary = input.workIds.length === 1 ? (scope.works.get(input.workIds[0]!) ?? null) : null;
  const result = await fn(tx, contextFor(scope, access, primary));
  // A side effect may find, once it holds the locks, that nothing it chose is
  // still its business (a provider fact whose work moved to another delivery
  // meanwhile). It writes nothing then: no version step, no event, no counter.
  if (!result.events.length) {
    return { versions: new Map(), eventSeqs: new Map(), response: result.response ?? {}, afterCommit: async () => {} };
  }
  const written = await finishScope(scope, result, null);
  return {
    versions: new Map([...written.rows].map(([id, row]) => [id, row.version])),
    eventSeqs: written.lastSeq,
    response: result.response ?? {},
    afterCommit: (db) => afterWorkCommit(db, input.actor, input.teamId, input.projectId, written, result),
  };
}

/**
 * The project a create names, inside the principal's reach and never created.
 * A team- or project-scoped credential looks only in its own workspace; a
 * person or a personal credential looks in every workspace they belong to, and
 * a spelling that matches projects in two of them is refused rather than
 * guessed. A door that already knows the workspace passes it.
 */
async function projectInReach(db: Db, principal: WorkPrincipal, spelling: string, teamId: string | undefined) {
  let teamIds: string[];
  if (teamId) teamIds = [teamId];
  else if (principal.kind === 'agent' && principal.grant.scope !== 'personal' && principal.grant.teamId) {
    teamIds = [principal.grant.teamId];
  } else {
    const rows = await db
      .select({ teamId: memberships.teamId })
      .from(memberships)
      .where(membershipUser(principal.userId));
    teamIds = rows.map((row) => row.teamId);
  }
  const found = [];
  for (const id of teamIds) {
    const project = await projectForTeam(db, id, spelling);
    if (!project) continue;
    if (principal.kind === 'agent' && !grantAllowsProject(principal.grant, project.teamId, project.id)) continue;
    found.push(project);
  }
  if (!found.length) {
    throw refuse(
      'NOT_FOUND',
      'That project is not in this principal\'s reach. Work is filed in an existing project; none was created.',
      { fields: ['project'] },
    );
  }
  if (found.length > 1) {
    throw refuse('INVALID_INPUT', `That name matches projects in ${found.length} workspaces; send the project id.`, {
      fields: ['project'],
    });
  }
  return found[0]!;
}

/** The usernames of these accounts, by id; a null id or a deleted account is simply absent. */
async function usernamesOf(tx: Db, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (!wanted.length) return new Map();
  const rows = await tx.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, wanted));
  return new Map(rows.map((row) => [row.id, row.username]));
}

/** A person named by username, who must be a member of the workspace now. */
async function memberIdFor(tx: Db, teamId: string, username: string | null, field: string): Promise<string | null> {
  if (username === null) return null;
  const member = await memberByUsername(tx, teamId, username);
  if (!member) throw refuse('INVALID_INPUT', `${field}: no member of this workspace has that username.`, { fields: [field] });
  return member.id;
}

const omit = <T extends Record<string, unknown>>(value: T, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

/**
 * File a new work item as a draft. Revision 1 and its criteria are written in
 * the same command. A person who names no owner owns what they file (otherwise
 * a member could file work nobody may then edit); an agent's draft has no
 * owner until somebody names one.
 *
 * With `external` the work starts from a tracker record (`workExternal.ts`).
 * The record is read here, before the transaction, because no provider call
 * may hold a Work lock; what it found is judged inside, where a replay of a
 * create that already succeeded is answered before any of it matters. A door
 * that lets a person do this passes `env`.
 */
export async function createWork(
  db: Db,
  principal: WorkPrincipal,
  rawInput: WorkCreateInput | Record<string, unknown>,
  options: { teamId?: string; hosted?: boolean; env?: Env } = {},
): Promise<WorkResult<WorkCommandOutcome>> {
  let input: WorkCreateInput;
  let project: Awaited<ReturnType<typeof projectInReach>>;
  let criteria: ReturnType<typeof buildCriteria>;
  try {
    input = parseOrRefuse(workCreateSchema, rawInput);
    // A native contract hashes exactly as it did before a tracker could supply
    // the goal: an absent goal is the empty one.
    if (!input.external && input.contract.goal === undefined) input.contract.goal = '';
    criteria = buildCriteria(input.criteria, new Set());
    project = await projectInReach(db, principal, input.project, options.teamId);
  } catch (error) {
    return refusalOf(error);
  }
  const prefetch = input.external
    ? await prepareCreateExternal(db, principal, { teamId: project.teamId, projectId: project.id }, input.external, options.env)
    : undefined;
  const hosted = options.hosted ?? isHosted();
  const workId = randomUUID();
  return runWorkCommand(
    db,
    principal,
    {
      requestId: input.request_id,
      operation: 'create',
      teamId: project.teamId,
      projectId: project.id,
      workId,
      expectedVersion: null,
      hashInput: {
        operation: 'create',
        project_id: project.id,
        expected_version: null,
        payload: omit(input as unknown as Record<string, unknown>, ['request_id', 'project']),
      },
    },
    async (tx, ctx) => {
      if (hosted) {
        const [{ used }] = (await tx
          .select({ used: count() })
          .from(workItems)
          .where(eq(workItems.projectId, ctx.projectId))) as [{ used: number }];
        if (used >= WORK_HOSTED_MAX_ITEMS_PER_PROJECT) {
          throw refuse(
            'LIMIT_EXCEEDED',
            `This project holds ${used} work items; at most ${WORK_HOSTED_MAX_ITEMS_PER_PROJECT} are kept per project on the hosted service.`,
            { used, limit: WORK_HOSTED_MAX_ITEMS_PER_PROJECT },
          );
        }
      }
      const external = input.external ? externalForCreate(ctx, principal, input, prefetch) : null;
      const ownerDefault = principal.kind === 'human' ? principal.userId : null;
      const ownerUserId =
        input.owner === undefined ? ownerDefault : await memberIdFor(tx, ctx.teamId, input.owner, 'owner');
      const acceptorUserId =
        input.acceptor === undefined || input.acceptor === null
          ? null
          : await memberIdFor(tx, ctx.teamId, input.acceptor, 'acceptor');
      const number = ctx.allocateWorkNumber();
      const displayKey = workDisplayKey(number);
      const coordination = input.coordination ?? {};
      await tx.insert(workItems).values({
        id: workId,
        teamId: ctx.teamId,
        projectId: ctx.projectId,
        number,
        displayKey,
        origin: external?.origin ?? 'native',
        state: 'draft',
        version: 1n,
        specRevision: 1,
        ownerUserId,
        acceptorUserId,
        priority: coordination.priority ?? 'normal',
        dueAt: coordination.due_at ? new Date(coordination.due_at) : null,
        labels: [...new Set(coordination.labels ?? [])],
        createdByKind: principal.kind,
        createdById: principalId(principal),
        createdByUserId: principal.userId,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      });
      const contract = {
        ...input.contract,
        title: external?.title ?? input.contract.title ?? '',
        goal: external?.goal ?? input.contract.goal ?? '',
      };
      await writeRevision(tx, {
        workId,
        revision: 1,
        content: contentFromCreate({ contract }, criteria),
        actor: principal,
        source: external?.source,
        now: ctx.now,
      });
      const events: WorkEventDraft[] = [
        { workId, type: 'work_created', payload: { key: displayKey, revision: 1, criteria: criteria.length } },
      ];
      if (external) events.push(await external.attach(tx, workId));
      return { events, created: [workId], resultRef: workId };
    },
  );
}

export type WorkUpdateInput = { request_id: string; work_id: string; expected_version: string } & WorkCommand;

type Handler<O extends WorkOperation> = (
  tx: Db,
  ctx: WorkOpContext,
  payload: WorkCommandOf<O>['payload'],
) => Promise<WorkOpResult>;

/** One handler per operation; the parsed payload decides which, never a free-form interpreter. */
const HANDLERS: { [O in WorkOperation]: Handler<O> } = {
  patch: patchWork,
  transition: transitionWork,
  reopen: reopenWork,
  archive: archiveWork,
  link: linkTarget,
  assign: assignWork,
  add_dependency: addDependency,
  remove_dependency: removeDependency,
  set_blocker: setBlocker,
  resolve_blocker: resolveBlocker,
  reconcile_external: reconcileExternal,
};

/**
 * Every update operation on an existing work item, through the one envelope.
 * A door that has the server environment passes it: `assign` refuses to run
 * without it, because it meters and notifies the way `assign_work` does.
 */
export async function updateWork(
  db: Db,
  principal: WorkPrincipal,
  rawInput: WorkUpdateInput | Record<string, unknown>,
  options: {
    env?: Env;
    /**
     * For `assign` from the console: the installation the person picked from
     * a list of installations. Names are unique only per person and machine
     * fingerprint, so two live connections of one person can share a name and a
     * device label, and resolving the pick again by name refuses both as one
     * ambiguous agent. The payload still names the agent, for the record.
     */
    assignee?: string;
  } = {},
): Promise<WorkResult<WorkCommandOutcome>> {
  let envelope: { request_id: string; work_id: string; expected_version: string };
  let command: WorkCommand;
  let target: { teamId: string; projectId: string } | undefined;
  try {
    envelope = parseOrRefuse(workEnvelopeSchema, rawInput);
    const raw = rawInput as Record<string, unknown>;
    command = parseOrRefuse(workCommandSchema, { operation: raw.operation, payload: raw.payload });
    [target] = await db
      .select({ teamId: workItems.teamId, projectId: workItems.projectId })
      .from(workItems)
      .where(eq(workItems.id, envelope.work_id))
      .limit(1);
    if (!target) throw refuse('NOT_FOUND', NOT_VISIBLE);
  } catch (error) {
    return refusalOf(error);
  }
  let handler = HANDLERS[command.operation] as Handler<WorkOperation>;
  if (command.operation === 'reconcile_external') {
    // The tracker is read now, before the locks, and only for a person the
    // command will let through; the handler judges what came back under them.
    const prefetch = await prepareReconcile(db, principal, envelope.work_id.toLowerCase(), command.payload, options.env);
    handler = (tx, ctx, payload) => reconcileExternal(tx, ctx, payload as WorkReconcileExternalPayload, prefetch);
  }
  const assignee = command.operation === 'assign' ? options.assignee : undefined;
  if (assignee) {
    handler = (tx, ctx, payload) => assignWork(tx, ctx, payload as WorkCommandOf<'assign'>['payload'], { installationId: assignee });
  }
  return runWorkCommand(
    db,
    principal,
    {
      requestId: envelope.request_id,
      operation: command.operation,
      teamId: target.teamId,
      projectId: target.projectId,
      workId: envelope.work_id.toLowerCase(),
      expectedVersion: BigInt(envelope.expected_version),
      hashInput: {
        operation: command.operation,
        work_id: envelope.work_id.toLowerCase(),
        expected_version: envelope.expected_version,
        payload: command.payload,
        // One request id is one assignment: a pick of another installation is another command.
        ...(assignee ? { assignee } : {}),
      },
    },
    (tx, ctx) => handler(tx, { ...ctx, env: options.env }, command.payload as never),
  );
}

// ---------------------------------------------------------------------------
// Handlers owned by this step: patch, transition, reopen, archive.
// ---------------------------------------------------------------------------

function commandParts(ctx: WorkOpContext) {
  if (!ctx.principal || !ctx.access || !ctx.work) throw new Error('A Work update needs a principal and its work.');
  return { principal: ctx.principal, access: ctx.access, work: ctx.work };
}

const archivedRefusal = () =>
  refuse('INVALID_TRANSITION', 'Archived work is read-only.', { next_action: 'Reopen it with a reason first.' });

async function patchWork(tx: Db, ctx: WorkOpContext, p: WorkCommandOf<'patch'>['payload']): Promise<WorkOpResult> {
  const { principal, access, work } = commandParts(ctx);
  if (work.archivedAt) throw archivedRefusal();
  if (work.state === 'cancelled') {
    throw refuse('INVALID_TRANSITION', 'Cancelled work cannot be changed.', {
      next_action: 'Reopen it with a reason first; it returns to draft.',
    });
  }
  const contractKeys = Object.entries(p.contract ?? {})
    .filter(([, value]) => value !== undefined)
    .map(([field]) => field);
  const coordination = p.coordination ?? {};
  const coordinationKeys = Object.entries(coordination)
    .filter(([, value]) => value !== undefined)
    .map(([field]) => field);
  const touchesContract = contractKeys.length > 0 || p.criteria !== undefined;
  const touchesOwner = p.owner !== undefined;
  const touchesAcceptor = p.acceptor !== undefined;
  if (!touchesContract && !touchesOwner && !touchesAcceptor && !coordinationKeys.length) {
    throw refuse('INVALID_INPUT', 'A patch must name at least one field to change.', { fields: ['payload'] });
  }

  if (principal.kind === 'agent') {
    if (!isOwnDraft(principal, work)) {
      throw refuse('FORBIDDEN', 'An agent may change only its own draft.', {
        next_action: 'To ask for a change, record a blocker of kind contract_change_request.',
      });
    }
  } else if ((touchesContract || touchesOwner || touchesAcceptor) && !hasContractAuthority(principal, access, work)) {
    throw refuse(
      'FORBIDDEN',
      "Only the work's owner, its acceptor or a workspace owner may change its contract, owner or acceptor.",
    );
  }

  await assertLocallyOwned(
    tx,
    work.id,
    [
      ...contractKeys.map((field) => `contract.${field}`),
      ...(p.criteria !== undefined ? ['criteria'] : []),
      ...coordinationKeys.map((field) => `coordination.${field}`),
      ...(touchesOwner ? ['owner'] : []),
      ...(touchesAcceptor ? ['acceptor'] : []),
    ],
    // What the patch would write, so repeating the value a tracker gave is not a change.
    {
      ...(p.contract?.title !== undefined ? { 'contract.title': p.contract.title } : {}),
      ...(p.contract?.goal !== undefined ? { 'contract.goal': p.contract.goal } : {}),
    },
  );

  // Naming the person a field already holds is not a change, and is not asked
  // of the member list: an owner who has left the workspace stays on the work
  // until somebody names another, and a form that sends both people (the
  // console's always does) must not be refused over the one it did not touch.
  const holders = touchesOwner || touchesAcceptor ? await usernamesOf(tx, [work.ownerUserId, work.acceptorUserId]) : new Map();
  const holds = (current: string | null, named: string | null | undefined) =>
    current !== null && typeof named === 'string' && holders.get(current) === named;
  const ownerUserId = !touchesOwner
    ? work.ownerUserId
    : holds(work.ownerUserId, p.owner)
      ? work.ownerUserId
      : await memberIdFor(tx, ctx.teamId, p.owner ?? null, 'payload.owner');
  const acceptorUserId = !touchesAcceptor
    ? work.acceptorUserId
    : holds(work.acceptorUserId, p.acceptor)
      ? work.acceptorUserId
      : await memberIdFor(tx, ctx.teamId, p.acceptor ?? null, 'payload.acceptor');

  const current = await loadRevision(tx, work.id, work.specRevision);
  if (!current) throw new Error(`Work ${work.id} has no revision ${work.specRevision}.`);
  let next = current;
  let revised = false;
  let changedContract: string[] = [];
  if (touchesContract) {
    const criteria =
      p.criteria !== undefined ? buildCriteria(p.criteria, await usedCriterionIds(tx, work.id), 'payload.') : undefined;
    next = applyContractPatch(current, p.contract, criteria);
    if (revisionContentHash(next) !== revisionContentHash(current)) {
      revised = true;
      changedContract = changedContractFields(current, next);
    }
  }
  const revision = revised ? work.specRevision + 1 : work.specRevision;

  let state = work.state as WorkState;
  let clearAcceptance = false;
  let reopenReason: string | undefined;
  if (revised && work.state === 'in_review') state = 'in_progress';
  if (revised && work.state === 'accepted') {
    if (!p.reopen_reason) {
      throw refuse(
        'INVALID_TRANSITION',
        'Changing the contract of accepted work reopens it; send reopen_reason in the same command.',
        { fields: ['payload.reopen_reason'] },
      );
    }
    state = 'in_progress';
    clearAcceptance = true;
    reopenReason = p.reopen_reason;
  }
  if (work.state === 'ready' && (revised || touchesOwner || touchesAcceptor)) {
    const missing = missingForReady({
      goal: next.goal,
      artifactKind: next.artifactKind,
      criteria: next.criteria.length,
      ownerUserId,
      acceptorUserId,
    });
    if (missing.length) {
      throw refuse('CONTRACT_INCOMPLETE', `Ready work must stay complete; this change leaves it without: ${missing.join(', ')}.`, {
        fields: missing,
        next_action: 'Include the missing fields, or move the work back to draft first.',
      });
    }
  }

  const set: Partial<typeof workItems.$inferInsert> = {};
  const changed: string[] = [];
  if (touchesOwner && ownerUserId !== work.ownerUserId) {
    set.ownerUserId = ownerUserId;
    changed.push('owner');
  }
  if (touchesAcceptor && acceptorUserId !== work.acceptorUserId) {
    set.acceptorUserId = acceptorUserId;
    changed.push('acceptor');
  }
  if (coordination.priority !== undefined && coordination.priority !== work.priority) {
    set.priority = coordination.priority;
    changed.push('coordination.priority');
  }
  if (coordination.due_at !== undefined) {
    const due = coordination.due_at === null ? null : new Date(coordination.due_at);
    if ((due?.getTime() ?? null) !== (work.dueAt?.getTime() ?? null)) {
      set.dueAt = due;
      changed.push('coordination.due_at');
    }
  }
  if (coordination.labels !== undefined) {
    const labels = [...new Set(coordination.labels)];
    if (canonicalJson(labels) !== canonicalJson(work.labels)) {
      set.labels = labels;
      changed.push('coordination.labels');
    }
  }
  if (revised) {
    await writeRevision(tx, {
      workId: work.id,
      revision,
      content: next,
      actor: principal,
      changeReason: p.change_reason,
      now: ctx.now,
    });
    set.specRevision = revision;
    changed.push(...changedContract);
  }
  if (state !== work.state) set.state = state;
  if (clearAcceptance) set.currentAcceptanceId = null;
  if (Object.keys(set).length) await tx.update(workItems).set(set).where(eq(workItems.id, work.id));

  // Runs and assignments working to the old contract are named, never stopped:
  // STMA cannot stop a process on somebody's machine, and saying so is the point.
  let contractChanged: { runs: string[]; assignments: string[] } | undefined;
  if (revised) {
    const active = await activeExecution(tx, work.id);
    const pinned = (rows: { id: string; specRevision: number | null }[]) =>
      rows.filter((row) => row.specRevision !== null && row.specRevision < revision).map((row) => row.id);
    const runs = pinned(active.runs);
    const assignments = pinned(active.assignments);
    if (runs.length || assignments.length) contractChanged = { runs, assignments };
  }

  // Nothing the patch names differs from what the work holds: a Save pressed
  // without an edit. It writes no event and steps no version, so it says
  // nothing changed where nothing did, and leaves every other open form (an
  // acceptor's decision among them) current.
  if (!revised && !changed.length) {
    return { events: [], unchanged: true, response: { revised: false, changed: [] } };
  }

  const payload: Record<string, unknown> = { changed };
  if (revised) payload.revision = revision;
  if (revised && p.change_reason) payload.change_reason = p.change_reason;
  if (state !== work.state) payload.state = { from: work.state, to: state };
  if (reopenReason) payload.reopen_reason = reopenReason;
  if (contractChanged) payload.contract_changed = contractChanged;
  return {
    events: [{ workId: work.id, type: 'work_patched', payload }],
    response: { revised, changed, ...(contractChanged ? { contract_changed: contractChanged } : {}) },
  };
}

const allowedTargets = (state: WorkState) =>
  WORK_TRANSITIONS[state].filter((to) => (WORK_TRANSITION_TARGETS as readonly string[]).includes(to));

/**
 * What to do about a contract that is not complete enough for ready. A field
 * the tracker owns (the goal of work that follows an issue with no
 * description) cannot be patched here, a patch of it is refused as owned
 * elsewhere, and the console shows it read only; "patch the missing fields"
 * sent the person to a field they could not edit, so the issue is named.
 */
async function incompleteNextAction(tx: Db, workId: string, missing: readonly string[]): Promise<string> {
  const owned = missing.filter((field) => (EXTERNALLY_OWNED_FIELDS as readonly string[]).includes(field));
  const owner = owned.length ? await authoritativeRef(tx, workId) : undefined;
  if (!owner) return 'Patch the missing fields, then move it to ready.';
  const here = missing.filter((field) => !owned.includes(field));
  return (
    `${owned.join(' and ')} ${owned.length > 1 ? 'come' : 'comes'} from GitHub issue ${owner.remoteId}, which owns ${owned.length > 1 ? 'them' : 'it'}: ` +
    `complete the issue on GitHub${owner.remoteUrl ? ` (${owner.remoteUrl})` : ''}, then read it again (Read GitHub again in the console, or reconcile_external with action refresh)` +
    `${here.length ? `, and patch ${here.join(', ')} here` : ''}. Then move it to ready.`
  );
}

async function transitionWork(
  tx: Db,
  ctx: WorkOpContext,
  p: WorkCommandOf<'transition'>['payload'],
): Promise<WorkOpResult> {
  const { principal, access, work } = commandParts(ctx);
  if (work.archivedAt) throw archivedRefusal();
  const from = work.state as WorkState;
  const to = p.to;
  // Leaving accepted or cancelled is a reopen: it asks for a reason and clears
  // the standing acceptance. The table allows the step, and a plain move would
  // take it without either, leaving an old acceptance on work that is open again.
  if (from === 'accepted' || from === 'cancelled') {
    throw refuse('INVALID_TRANSITION', `Work in ${from} is reopened, not moved.`, {
      next_action: 'Reopen it with a reason first.',
    });
  }
  if (!isWorkTransitionAllowed(from, to)) {
    const targets = allowedTargets(from);
    throw refuse('INVALID_TRANSITION', `Work in ${from} cannot move to ${to}.`, {
      next_action: targets.length
        ? `From ${from} it can move to: ${targets.join(', ')}.`
        : `Nothing moves it out of ${from} with a transition.`,
    });
  }
  if (to === 'ready' || to === 'draft' || to === 'cancelled') {
    if (!hasContractAuthority(principal, access, work)) {
      throw refuse(
        'FORBIDDEN',
        principal.kind === 'agent'
          ? `An agent cannot move work to ${to}; the work's owner, its acceptor or a workspace owner does that.`
          : `Only the work's owner, its acceptor or a workspace owner may move it to ${to}.`,
      );
    }
  } else if (principal.kind === 'agent') {
    throw refuse(
      'FORBIDDEN',
      to === 'in_progress'
        ? 'An agent cannot start work by moving it; starting a run linked to the work does that.'
        : 'An agent cannot move work to in_review; submitting a delivery does that.',
    );
  }

  if (to === 'ready') {
    const revision = await loadRevision(tx, work.id, work.specRevision);
    if (!revision) throw new Error(`Work ${work.id} has no revision ${work.specRevision}.`);
    const missing = missingForReady({
      goal: revision.goal,
      artifactKind: revision.artifactKind,
      criteria: revision.criteria.length,
      ownerUserId: work.ownerUserId,
      acceptorUserId: work.acceptorUserId,
    });
    if (missing.length) {
      throw refuse('CONTRACT_INCOMPLETE', `The contract is not complete yet; it is missing: ${missing.join(', ')}.`, {
        fields: missing,
        next_action: await incompleteNextAction(tx, work.id, missing),
      });
    }
  }
  if (to === 'in_review' && !(await currentDeliveryIsForRevision(tx, work))) {
    throw refuse('INVALID_TRANSITION', `In review needs a delivery for revision ${work.specRevision}.`, {
      next_action: `Submit a delivery for revision ${work.specRevision} first.`,
    });
  }
  // A delivery somebody already decided on goes back to review only as a new
  // delivery: unchanged, it would sit in review with nothing left to decide.
  if (to === 'in_review' && !(await currentDeliveryReviewable(tx, work))) {
    throw refuse('INVALID_TRANSITION', 'The current delivery already has a decision; in review needs a new delivery.', {
      next_action: `Submit a new delivery for revision ${work.specRevision}.`,
    });
  }
  if (to === 'cancelled' && !p.reason) {
    throw refuse('INVALID_INPUT', 'Cancelling work needs a reason.', { fields: ['payload.reason'] });
  }

  await tx.update(workItems).set({ state: to }).where(eq(workItems.id, work.id));
  const response: Record<string, unknown> = {};
  if (to === 'cancelled') {
    const active = await activeExecution(tx, work.id);
    if (active.runs.length || active.assignments.length) {
      response.execution_warning =
        'Cancelling the work does not stop an agent that is running; its linked runs and assignments carry on until their agents stop or are told to.';
      response.active = { runs: active.runs.map((row) => row.id), assignments: active.assignments.map((row) => row.id) };
    }
  }
  const payload: Record<string, unknown> = { from, to };
  if (p.reason) payload.reason = p.reason;
  return { events: [{ workId: work.id, type: 'work_state_changed', payload }], response };
}

async function reopenWork(tx: Db, ctx: WorkOpContext, p: WorkCommandOf<'reopen'>['payload']): Promise<WorkOpResult> {
  const { principal, access, work } = commandParts(ctx);
  if (!hasContractAuthority(principal, access, work)) {
    throw refuse('FORBIDDEN', "Only the work's owner, its acceptor or a workspace owner may reopen it.");
  }
  const from = work.state as WorkState;
  // Reopening an archived draft only brings it back: there is no state to
  // leave, and without this an archived draft could never change again.
  const to: WorkState | null =
    from === 'accepted' ? 'in_progress' : from === 'cancelled' ? 'draft' : from === 'draft' && work.archivedAt ? 'draft' : null;
  if (!to) {
    throw refuse('INVALID_TRANSITION', `Work in ${from} is not closed; only accepted or cancelled work is reopened.`);
  }
  await tx
    .update(workItems)
    .set({ state: to, archivedAt: null, ...(from === 'accepted' ? { currentAcceptanceId: null } : {}) })
    .where(eq(workItems.id, work.id));
  return {
    events: [
      {
        workId: work.id,
        type: 'work_reopened',
        payload: { from, to, reason: p.reason, ...(work.archivedAt ? { unarchived: true } : {}) },
      },
    ],
  };
}

async function archiveWork(tx: Db, ctx: WorkOpContext, p: WorkCommandOf<'archive'>['payload']): Promise<WorkOpResult> {
  const { principal, access, work } = commandParts(ctx);
  if (!hasContractAuthority(principal, access, work)) {
    throw refuse('FORBIDDEN', "Only the work's owner, its acceptor or a workspace owner may archive it.");
  }
  if (work.archivedAt) throw refuse('INVALID_TRANSITION', 'This work is already archived.');
  if (!['accepted', 'cancelled', 'draft'].includes(work.state)) {
    throw refuse('INVALID_TRANSITION', `Work in ${work.state} is still active and cannot be archived.`, {
      next_action: 'Cancel it with a reason first, or archive it once it is accepted.',
    });
  }
  const active = await activeExecution(tx, work.id);
  if (active.runs.length || active.assignments.length) {
    throw refuse('INVALID_TRANSITION', 'Runs or assignments linked to this work are still open.', {
      next_action: 'Finish or cancel the linked runs and assignments first; archiving does not stop them.',
    });
  }
  await tx.update(workItems).set({ archivedAt: ctx.now }).where(eq(workItems.id, work.id));
  return {
    events: [{ workId: work.id, type: 'work_archived', payload: p.reason ? { reason: p.reason } : {} }],
  };
}

