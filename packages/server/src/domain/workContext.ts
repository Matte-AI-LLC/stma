import {
  ACTIVE_AGENT_RUN_STATUSES,
  WORK_CONTEXT_SECTIONS,
  WORK_LIMITS,
  WORK_TOKEN_ESTIMATE_METHOD,
  artifactVersionState,
  estimateTokens,
  fingerprintJson,
  type WorkArtifact,
  type WorkContextSection,
} from '@bridge/shared';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../db';
import {
  agentInstallations,
  agentRuns,
  handoffs,
  projects,
  teams,
  users,
  workBlockers,
  workContextReads,
  workDeliveries,
  workItems,
  workLinks,
} from '../db/schema';
import { grantLabel } from '../lib/grants';
import { isCanonicalUuid } from '../lib/ids';
import { getKnowledge } from './knowledge';
import { effectivePolicy } from './policies';
import { OPEN_HANDOFF_STATES, workAccess } from './workAccess';
import { READY_FOR_REVIEW_MEANING, evaluateReadiness, type Readiness } from './workEvidence';
import { NOT_BLOCKED, blockingState, type WorkBlockingState } from './workGraph';
import { WORK_UNTRUSTED, nextActionsForWork } from './workRead';
import { loadRevision, type RevisionContent } from './workRevisions';
import {
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
 * A bounded working package for one work item (spec 11): what an agent about
 * to work on it needs, in priority order, inside a byte budget the caller
 * picks. It never carries the whole history, and it never cuts: every item is
 * whole, and what does not fit is said, with a continuation, rather than
 * dropped. The scope (what this principal may do) and the blockers are always
 * in it, whatever sections were asked for, because a package that leaves out
 * why the work cannot move is worse than no package.
 *
 * Tokens are not counted: there is no vendor tokenizer on the server. The
 * budget is in UTF-8 bytes of the reply exactly as it is sent (compact JSON),
 * and the token figure is an estimate that says how it was made.
 */

const NOT_VISIBLE = 'No work with that id is visible to this principal.';
const ALWAYS: readonly WorkContextSection[] = ['scope', 'blockers'];
const ACTIVE_LIMIT = 50;
/** Wide enough for any byte count the budget allows; the real figures are never longer. */
const SIZE_PLACEHOLDER = 99_999;

const ACTIVE_NOTE =
  'Recorded states only. Sent means no agent has accepted it yet; accepted and started are what the receiving agent reported. STMA does not observe whether a process is running.';

/**
 * The scope block every Work reply carries: whose workspace and project this
 * is, and that only what this principal may read is in it.
 */
export function workScopeBlock(
  principal: WorkPrincipal,
  team: { slug: string } | null,
  project: { id: string; slug: string | null; name: string | null } | null,
) {
  return {
    team: team?.slug ?? null,
    project: project ? { id: project.id, slug: project.slug, name: project.name } : null,
    note:
      principal.kind === 'agent'
        ? `Only what this connection can read is included. Its access is ${grantLabel(principal.grant)}.`
        : 'Only what you can read in this workspace is included.',
  };
}

// ---------------------------------------------------------------------------
// Units: the whole items a package is made of, in priority order. A unit sets
// one field, merges a few short ones into its section, or appends one element
// to a list; a page is a prefix of them, so assembling any prefix gives the
// same shape a later page continues.
// ---------------------------------------------------------------------------

type Unit =
  | { section: WorkContextSection; op: 'merge'; value: Record<string, unknown> }
  | { section: WorkContextSection; op: 'set' | 'push'; path: readonly string[]; value: unknown };

function assemble(units: readonly Unit[]): Record<string, Record<string, unknown>> {
  const content: Record<string, Record<string, unknown>> = {};
  for (const unit of units) {
    const section = (content[unit.section] ??= {});
    if (unit.op === 'merge') {
      Object.assign(section, unit.value);
      continue;
    }
    let node: Record<string, unknown> = section;
    for (const key of unit.path.slice(0, -1)) node = (node[key] ??= {}) as Record<string, unknown>;
    const last = unit.path[unit.path.length - 1]!;
    if (unit.op === 'set') node[last] = unit.value;
    else ((node[last] ??= []) as unknown[]).push(unit.value);
  }
  return content;
}

interface Gathered {
  work: WorkItemRow;
  access: WorkAccess;
  team: { slug: string };
  project: { id: string; slug: string | null; name: string | null };
  revision: RevisionContent;
  owner: string | null;
  acceptor: string | null;
  nextActions: string[];
  readiness: Readiness;
  blocking: WorkBlockingState;
  blockerReasons: Map<string, string>;
  sent: Record<string, unknown>[];
  taken: Record<string, unknown>[];
  runs: Record<string, unknown>[];
  delivery: typeof workDeliveries.$inferSelect | null;
  policy: { hash: string; team_version: number | null; project_version: number | null } | null;
  knowledge: Record<string, unknown>[];
}

async function gather(db: Db, principal: WorkPrincipal, access: WorkAccess, work: WorkItemRow): Promise<Gathered> {
  const [place] = await db
    .select({ teamSlug: teams.slug, id: projects.id, slug: projects.slug, name: projects.name })
    .from(projects)
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .where(eq(projects.id, work.projectId))
    .limit(1);
  const revision = await loadRevision(db, work.id, work.specRevision);
  if (!place || !revision) throw new Error(`Work ${work.id} has no project or no revision ${work.specRevision}.`);

  const people = [work.ownerUserId, work.acceptorUserId].filter((id): id is string => Boolean(id));
  const usernames = new Map(
    people.length
      ? (await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, people))).map(
          (row) => [row.id, row.username],
        )
      : [],
  );

  const blocking = (await blockingState(db, [work.id])).get(work.id) ?? NOT_BLOCKED;
  // The graph trims a reason for its lists; a package carries whole items.
  const storedIds = blocking.blockers.flatMap((blocker) => (blocker.id ? [blocker.id] : []));
  const blockerReasons = new Map(
    storedIds.length
      ? (await db.select({ id: workBlockers.id, reason: workBlockers.reason }).from(workBlockers).where(inArray(workBlockers.id, storedIds))).map(
          (row) => [row.id, row.reason],
        )
      : [],
  );

  const assignments = await db
    .select({
      id: handoffs.id,
      sessionId: handoffs.sessionId,
      kind: handoffs.kind,
      state: handoffs.state,
      createdAt: handoffs.createdAt,
      acceptedAt: handoffs.acceptedAt,
      resumedAt: handoffs.resumedAt,
      pinned: workLinks.specRevision,
      agent: agentInstallations.name,
      device: agentInstallations.deviceLabel,
      owner: users.username,
    })
    .from(workLinks)
    .innerJoin(handoffs, eq(handoffs.id, workLinks.handoffId))
    .leftJoin(agentInstallations, eq(agentInstallations.id, handoffs.targetInstallationId))
    .leftJoin(users, eq(users.id, agentInstallations.userId))
    .where(
      and(
        eq(workLinks.workId, work.id),
        isNull(workLinks.supersededAt),
        inArray(workLinks.kind, ['assignment', 'handoff']),
        inArray(handoffs.state, [...OPEN_HANDOFF_STATES]),
      ),
    )
    .orderBy(asc(handoffs.createdAt), asc(handoffs.id))
    .limit(ACTIVE_LIMIT * 2);
  const assignment = (row: (typeof assignments)[number]) => ({
    handoff_id: row.id,
    session_id: row.sessionId,
    kind: row.kind,
    state: row.state,
    agent: row.agent,
    device: row.device,
    owner: row.owner,
    pinned_revision: row.pinned,
    sent_at: row.createdAt.toISOString(),
    accepted_at: row.acceptedAt?.toISOString() ?? null,
    started_at: row.resumedAt?.toISOString() ?? null,
  });
  const sent = assignments.filter((row) => row.state === 'offered').slice(0, ACTIVE_LIMIT).map(assignment);
  const taken = assignments.filter((row) => row.state !== 'offered').slice(0, ACTIVE_LIMIT).map(assignment);

  const runs = (
    await db
      .select({
        id: agentRuns.id,
        status: agentRuns.status,
        branch: agentRuns.branch,
        lastHeartbeatAt: agentRuns.lastHeartbeatAt,
        pinned: workLinks.specRevision,
        agent: agentInstallations.name,
        device: agentInstallations.deviceLabel,
        owner: users.username,
      })
      .from(workLinks)
      .innerJoin(agentRuns, eq(agentRuns.id, workLinks.runId))
      .leftJoin(agentInstallations, eq(agentInstallations.id, agentRuns.installationId))
      .leftJoin(users, eq(users.id, agentInstallations.userId))
      .where(
        and(
          eq(workLinks.workId, work.id),
          isNull(workLinks.supersededAt),
          eq(workLinks.kind, 'run'),
          inArray(agentRuns.status, [...ACTIVE_AGENT_RUN_STATUSES]),
        ),
      )
      .orderBy(asc(agentRuns.startedAt), asc(agentRuns.id))
      .limit(ACTIVE_LIMIT)
  ).map((row) => ({
    run_id: row.id,
    status: row.status,
    agent: row.agent,
    device: row.device,
    owner: row.owner,
    branch: row.branch,
    pinned_revision: row.pinned,
    last_heartbeat_at: row.lastHeartbeatAt?.toISOString() ?? null,
  }));

  const [delivery] = work.currentDeliveryId
    ? await db.select().from(workDeliveries).where(eq(workDeliveries.id, work.currentDeliveryId)).limit(1)
    : [];

  const effective = await effectivePolicy(db, principal.userId, { team: place.teamSlug, projectId: work.projectId });
  const policy =
    'error' in effective
      ? null
      : {
          hash: effective.hash,
          team_version: effective.sources.find((source) => source.scope === 'team')?.version ?? null,
          project_version: effective.sources.find((source) => source.scope !== 'team')?.version ?? null,
        };

  // A Knowledge pointer is resolved through the same read an agent would make,
  // so a record this principal could not read is never named as current.
  const knowledge: Record<string, unknown>[] = [];
  for (const ref of revision.contextRefs) {
    if (ref.kind !== 'knowledge') continue;
    const read = await getKnowledge(
      db,
      principal.userId,
      { team: place.teamSlug, project: work.projectId, id: ref.key },
      principal.kind === 'agent' ? principal.grant : undefined,
    );
    const current = 'knowledge' in read && read.knowledge?.availability === 'current' ? read.knowledge : null;
    knowledge.push({
      key: ref.key,
      readable: Boolean(current),
      current_version_id: current?.versionId ?? null,
      ...(ref.version_id ? { pinned_version_id: ref.version_id, pinned_is_current: current?.versionId === ref.version_id } : {}),
    });
  }

  return {
    work,
    access,
    team: { slug: place.teamSlug },
    project: { id: place.id, slug: place.slug, name: place.name },
    revision,
    owner: work.ownerUserId ? (usernames.get(work.ownerUserId) ?? null) : null,
    acceptor: work.acceptorUserId ? (usernames.get(work.acceptorUserId) ?? null) : null,
    nextActions: await nextActionsForWork(db, principal, access, work),
    readiness: await evaluateReadiness(db, work),
    blocking,
    blockerReasons,
    sent,
    taken,
    runs,
    delivery: delivery ?? null,
    policy,
    knowledge,
  };
}

function unitsFor(principal: WorkPrincipal, g: Gathered, sections: readonly WorkContextSection[]): Unit[] {
  const units: Unit[] = [];
  const want = new Set(sections);
  const { work, revision } = g;

  // 1. The authority boundary: which work, in which state, and what this
  // principal may do with it next. Never optional.
  units.push({
    section: 'scope',
    op: 'merge',
    value: {
      work: {
        id: work.id,
        key: work.displayKey,
        origin: work.origin,
        state: work.state,
        version: wireBigint(work.version),
        spec_revision: work.specRevision,
        archived: work.archivedAt !== null,
      },
      principal: principal.kind,
      role: g.access.role,
      next_actions: g.nextActions,
      // Said on the first page whatever else fits on it, so a blocker listed on
      // a later page is never one the reader did not know to ask for.
      blocked: g.blocking.blocked,
      open_blockers: g.blocking.blockers.length,
      unmet_dependencies: g.blocking.unmet.length,
    },
  });

  // 2. The contract: what done means.
  if (want.has('contract')) {
    units.push({
      section: 'contract',
      op: 'merge',
      value: {
        title: revision.title,
        owner: g.owner,
        acceptor: g.acceptor,
        risk_tier: revision.riskTier,
        artifact_kind: revision.artifactKind,
        acceptance_policy: revision.acceptancePolicy,
        priority: work.priority,
        due_at: work.dueAt?.toISOString() ?? null,
        labels: work.labels,
      },
    });
    if (revision.goal) units.push({ section: 'contract', op: 'set', path: ['goal'], value: revision.goal });
    if (revision.nonGoals) units.push({ section: 'contract', op: 'set', path: ['non_goals'], value: revision.nonGoals });
    for (const kind of ['paths', 'components', 'contracts'] as const) {
      for (const entry of revision.scope[kind] ?? []) {
        units.push({ section: 'contract', op: 'push', path: ['scope', kind], value: entry });
      }
    }
  }

  // 3. The criteria, each with what it reads against the current delivery.
  if (want.has('criteria')) {
    const readiness = g.readiness;
    units.push({
      section: 'criteria',
      op: 'merge',
      value: {
        delivery_id: readiness.delivery_id,
        delivery_spec_revision: readiness.delivery_spec_revision,
        evidence_epoch: readiness.evidence_epoch,
        ready_for_review: readiness.ready_for_review,
        counts: readiness.counts,
        meaning: READY_FOR_REVIEW_MEANING,
      },
    });
    const outcomes = new Map(readiness.criteria.map((outcome) => [outcome.id, outcome]));
    for (const criterion of revision.criteria) {
      const outcome = outcomes.get(criterion.id);
      units.push({
        section: 'criteria',
        op: 'push',
        path: ['items'],
        value: {
          id: criterion.id,
          text: criterion.text,
          required: criterion.required,
          evidence_kinds: criterion.evidenceKinds,
          result: outcome?.result ?? 'unknown',
          reasons: outcome?.reasons ?? [],
          mode: criterion.verificationRule.mode,
          max_age_seconds: criterion.verificationRule.max_age_seconds ?? null,
          // Which rows each answer was read from are pointers, listed under sources.
          selectors: (outcome?.selectors ?? []).map(({ evidence_ids: _e, observation_ids: _o, ...selector }) => selector),
        },
      });
    }
  }

  // 4. What stops it. Never optional, and never trimmed.
  const blocking = g.blocking;
  units.push({
    section: 'blockers',
    op: 'merge',
    value: {
      blocked: blocking.blocked,
      open_blockers: blocking.blockers.length,
      unmet_dependencies: blocking.unmet.length,
      acceptor_unavailable: blocking.acceptorUnavailable,
      dependency_changed: blocking.dependencyChanged,
    },
  });
  for (const blocker of blocking.blockers) {
    units.push({
      section: 'blockers',
      op: 'push',
      path: ['open'],
      value: {
        id: blocker.id,
        kind: blocker.kind,
        reason: blocker.id ? (g.blockerReasons.get(blocker.id) ?? blocker.reason) : blocker.reason,
        owner: blocker.owner,
        next_action: blocker.next_action,
        derived: blocker.derived,
        created_at: blocker.created_at,
      },
    });
  }
  // Listed under `unmet`, beside `open`: `unmet_dependencies` is the count
  // merged above, and a push onto it failed every read of a work that waits on one.
  for (const dependency of blocking.unmet) {
    units.push({ section: 'blockers', op: 'push', path: ['unmet'], value: dependency });
  }

  // 5. Who is on it now, from what was recorded.
  if (want.has('active')) {
    units.push({
      section: 'active',
      op: 'merge',
      value: { sent: g.sent.length, taken: g.taken.length, runs: g.runs.length, listed_at_most: ACTIVE_LIMIT, note: ACTIVE_NOTE },
    });
    for (const row of g.sent) units.push({ section: 'active', op: 'push', path: ['assignments_sent'], value: row });
    for (const row of g.taken) units.push({ section: 'active', op: 'push', path: ['assignments_taken'], value: row });
    // Listed under a key of their own, as the assignments are: `runs` is the
    // count merged above, and a push onto it failed the whole read for any work
    // with a live linked run, which is exactly the work an agent is reading.
    for (const row of g.runs) units.push({ section: 'active', op: 'push', path: ['linked_runs'], value: row });
    if (g.delivery) {
      const delivery = g.delivery;
      units.push({
        section: 'active',
        op: 'set',
        path: ['delivery'],
        value: {
          id: delivery.id,
          sequence: delivery.sequence,
          spec_revision: delivery.specRevision,
          for_current_revision: delivery.specRevision === work.specRevision,
          run_id: delivery.runId,
          note: delivery.note,
          submitted_at: delivery.submittedAt.toISOString(),
        },
      });
      for (const [index, artifact] of (delivery.artifacts as WorkArtifact[]).entries()) {
        units.push({
          section: 'active',
          op: 'push',
          path: ['delivery_artifacts'],
          value: { index, version: artifactVersionState(artifact), ...artifact },
        });
      }
    }
  }

  // 6. Where to read more: pointers, never copies.
  if (want.has('sources')) {
    for (const ref of g.knowledge) units.push({ section: 'sources', op: 'push', path: ['knowledge'], value: ref });
    for (const ref of revision.contextRefs) {
      if (ref.kind === 'policy') {
        units.push({ section: 'sources', op: 'push', path: ['policy'], value: { pinned_version: ref.version ?? null } });
      } else if (ref.kind === 'document') {
        units.push({
          section: 'sources',
          op: 'push',
          path: ['documents'],
          value: { uri: ref.uri, version: ref.version ?? null, title: ref.title ?? null },
        });
      }
    }
    for (const outcome of g.readiness.criteria) {
      const evidence = [...new Set(outcome.selectors.flatMap((selector) => selector.evidence_ids))];
      const observations = [...new Set(outcome.selectors.flatMap((selector) => selector.observation_ids))];
      if (!evidence.length && !observations.length) continue;
      units.push({
        section: 'sources',
        op: 'push',
        path: ['evidence'],
        value: { criterion_id: outcome.id, evidence_ids: evidence, observation_ids: observations },
      });
    }
    for (const id of checkpointIds(g.delivery)) {
      units.push({ section: 'sources', op: 'push', path: ['checkpoints'], value: id });
    }
  }
  return units;
}

/**
 * A unit as the content hash reads it: a linked run without its last
 * heartbeat. The heartbeat is presence, not content, and the run of the agent
 * reading its own work's package beats between every two page calls (its hook
 * reports every tool call), so a hash that read it answered each continuation
 * with a fresh first page and the pages after the first were never reached.
 * The page itself still carries the heartbeat as it is when it is read.
 */
function withoutPresence(unit: Unit): Unit {
  if (unit.op !== 'push' || unit.section !== 'active' || unit.path[0] !== 'linked_runs') return unit;
  return { ...unit, value: { ...(unit.value as Record<string, unknown>), last_heartbeat_at: null } };
}

const checkpointIds = (delivery: Gathered['delivery']): string[] =>
  delivery
    ? [
        ...new Set(
          (delivery.artifacts as WorkArtifact[]).flatMap((artifact) =>
            artifact.kind === 'code' && artifact.checkpoint_id ? [artifact.checkpoint_id] : [],
          ),
        ),
      ]
    : [];

// ---------------------------------------------------------------------------
// Continuations: a position in the unit list, made at one version and over
// one content. Not signed: it grants nothing, and access is read again.
// ---------------------------------------------------------------------------

interface Continuation {
  w: string;
  v: string;
  h: string;
  p: number;
  s: WorkContextSection[];
}

const writeContinuation = (value: Continuation) =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

function readContinuation(raw: string, workId: string): Continuation {
  const bad = () =>
    refuse('INVALID_INPUT', 'continuation: not a continuation this server issued for this work.', {
      fields: ['continuation'],
    });
  if (typeof raw !== 'string' || raw.length > 1_000) throw bad();
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw bad();
  }
  if (
    value.w !== workId ||
    typeof value.v !== 'string' ||
    !/^[0-9]{1,19}$/.test(value.v) ||
    typeof value.h !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.h) ||
    typeof value.p !== 'number' ||
    !Number.isInteger(value.p) ||
    value.p < 0 ||
    value.p > 100_000 ||
    !Array.isArray(value.s) ||
    !value.s.every((section) => (WORK_CONTEXT_SECTIONS as readonly unknown[]).includes(section))
  ) {
    throw bad();
  }
  return value as unknown as Continuation;
}

function sectionsFor(requested: readonly string[] | undefined): WorkContextSection[] {
  if (requested !== undefined) {
    for (const section of requested) {
      if (!(WORK_CONTEXT_SECTIONS as readonly string[]).includes(section)) {
        throw refuse('INVALID_INPUT', `sections: "${String(section).slice(0, 40)}" is not a context section.`, {
          fields: ['sections'],
        });
      }
    }
  }
  const chosen = new Set<string>([...(requested?.length ? requested : WORK_CONTEXT_SECTIONS), ...ALWAYS]);
  return WORK_CONTEXT_SECTIONS.filter((section) => chosen.has(section));
}

const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

export interface WorkContextOptions {
  /** The budget for the whole reply in UTF-8 bytes; 12 KiB by default, 4 to 32 KiB. */
  maxBytes?: number;
  /** Which sections to include; scope and blockers are always included. */
  sections?: readonly string[];
  /** From a previous page's `continuation`. */
  continuation?: string | null;
}

/**
 * One page of a work item's context for this principal, at most `maxBytes`
 * bytes as compact JSON. Writes one `work_context_reads` row: how many bytes
 * a work's readers were served is what a pilot measures.
 */
export async function getWorkContext(
  db: Db,
  principal: WorkPrincipal,
  workId: string,
  options: WorkContextOptions = {},
): Promise<WorkResult<Record<string, unknown>>> {
  try {
    if (!isCanonicalUuid(workId)) throw refuse('NOT_FOUND', NOT_VISIBLE);
    const [work] = await db.select().from(workItems).where(eq(workItems.id, workId.toLowerCase())).limit(1);
    if (!work) throw refuse('NOT_FOUND', NOT_VISIBLE);
    const access = await workAccess(db, principal, work.teamId, work.projectId);
    if (!access) throw refuse('NOT_FOUND', NOT_VISIBLE);

    const maxBytes = options.maxBytes ?? WORK_LIMITS.contextDefaultBytes;
    if (!Number.isInteger(maxBytes) || maxBytes < WORK_LIMITS.contextMinBytes || maxBytes > WORK_LIMITS.contextMaxBytes) {
      throw refuse(
        'INVALID_INPUT',
        `max_bytes: between ${WORK_LIMITS.contextMinBytes} and ${WORK_LIMITS.contextMaxBytes} bytes.`,
        { fields: ['max_bytes'] },
      );
    }

    let continuation: Continuation | null = null;
    let sections: WorkContextSection[];
    if (options.continuation) {
      continuation = readContinuation(options.continuation, work.id);
      // A continuation carries the sections it was made for; a different list
      // beside it would page through a package nobody asked for.
      if (options.sections !== undefined && sectionsFor(options.sections).join() !== sectionsFor(continuation.s).join()) {
        throw refuse('INVALID_INPUT', 'sections: a continuation carries its own sections; omit sections, or start again without the continuation.', {
          fields: ['sections'],
        });
      }
      sections = sectionsFor(continuation.s);
    } else {
      sections = sectionsFor(options.sections);
    }

    const gathered = await gather(db, principal, access, work);
    const units = unitsFor(principal, gathered, sections);
    const version = wireBigint(work.version);
    const contentHash = fingerprintJson(assemble(units.map(withoutPresence)));

    let position = 0;
    let restarted: string | undefined;
    if (continuation) {
      if (continuation.v !== version) {
        restarted = `The work moved from version ${continuation.v} to ${version} since that continuation was made; this is a fresh first page.`;
      } else if (continuation.h !== contentHash) {
        restarted =
          'What the work reads as changed since that continuation was made (an assignment, a run, a blocker or evidence moved); this is a fresh first page.';
      } else {
        position = Math.min(continuation.p, units.length);
      }
    }

    const manifest = {
      work_id: work.id,
      key: work.displayKey,
      version,
      spec_revision: work.specRevision,
      policy: gathered.policy,
      knowledge_version_ids: [
        ...new Set(gathered.knowledge.flatMap((ref) => (typeof ref.current_version_id === 'string' ? [ref.current_version_id] : []))),
      ].sort(),
      // The delivery and its epoch pin the exact evidence set: the epoch moves
      // whenever a row is added or a provider observes the delivered commit.
      sources: {
        delivery_id: work.currentDeliveryId,
        evidence_epoch: wireBigint(work.evidenceEpoch),
        checkpoint_ids: checkpointIds(gathered.delivery).sort(),
      },
      sections,
      created_at: new Date().toISOString(),
      content_hash: contentHash,
    };
    const scope = workScopeBlock(principal, gathered.team, gathered.project);

    const build = (count: number, sizes = { bytes: SIZE_PLACEHOLDER, tokens: SIZE_PLACEHOLDER }) => {
      const end = position + count;
      const rest = units.slice(end);
      const incomplete = rest.length > 0;
      return {
        work_id: work.id,
        key: work.displayKey,
        version,
        spec_revision: work.specRevision,
        scope,
        content: assemble(units.slice(position, end)),
        manifest,
        page: { position, items: count, total_items: units.length },
        max_bytes: maxBytes,
        bytes: sizes.bytes,
        estimated_tokens: sizes.tokens,
        estimate_method: WORK_TOKEN_ESTIMATE_METHOD,
        incomplete,
        omitted_sections: [...new Set(rest.map((unit) => unit.section))],
        continuation: incomplete
          ? writeContinuation({ w: work.id, v: version, h: contentHash, p: end, s: sections })
          : null,
        ...(restarted ? { restarted } : {}),
        as_of: manifest.created_at,
        untrusted: WORK_UNTRUSTED,
      } as Record<string, unknown>;
    };
    const remaining = units.length - position;
    // The room a retry needs to make progress: the next item beside the fixed
    // part, or the fixed part alone when nothing is left. Measured with
    // `max_bytes` at its widest, because the reply echoes it: 4096 asked for
    // and 13,500 needed is one digit more on the retry, and a figure measured
    // at 4096 answered the retry with the same empty page, one byte short.
    const needed = () => bytesOf({ ...build(remaining > 0 ? 1 : 0), max_bytes: WORK_LIMITS.contextMaxBytes });
    // An empty page while items remain says how much room the next one needs
    // instead of answering the same empty page forever. Those two fields are
    // part of the reply, so they are inside the budget like everything else.
    const page = (count: number) => {
      const built = build(count);
      if (count > 0 || remaining === 0) return built;
      const room = needed();
      return {
        ...built,
        next_item_bytes: bytesOf(units[position]!.value),
        next_action:
          room <= WORK_LIMITS.contextMaxBytes
            ? `The next item does not fit in ${maxBytes} bytes. Ask again with this continuation and max_bytes of at least ${room}.`
            : 'The next item does not fit even in the largest page; read it with get_work, view detail.',
      };
    };
    const fits = (count: number) => bytesOf(page(count)) <= maxBytes;

    // The largest prefix that fits. Adding a unit only adds bytes, except that
    // the last one also drops the continuation, so that case is tried first.
    let count = 0;
    if (fits(remaining)) count = remaining;
    else {
      let low = 0;
      let high = remaining - 1;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (fits(middle)) low = middle;
        else high = middle - 1;
      }
      count = fits(low) ? low : -1;
    }
    if (count < 0) {
      // Not even the fixed part (the manifest, the scope, the continuation and
      // the sentence that says what is missing) fits in the budget. The budget
      // is a hard limit, so nothing is sent over it: the refusal says how much
      // room the next page needs, and the continuation sent stays good.
      const room = needed();
      throw refuse(
        'INVALID_INPUT',
        `max_bytes: this work's context needs more than ${maxBytes} bytes even for an empty page (its manifest, scope and continuation); nothing was sent over the budget.`,
        {
          fields: ['max_bytes'],
          next_action:
            room <= WORK_LIMITS.contextMaxBytes
              ? `Ask again${continuation ? ' with the same continuation' : ''} and max_bytes of at least ${room}.`
              : 'Read the work with get_work, view detail.',
        },
      );
    }

    let reply = page(count);
    // The real figures are never longer than the placeholders, so the reply
    // stays inside the budget; settle `bytes` on the length it describes.
    let bytes = bytesOf(reply);
    for (let round = 0; round < 3; round++) {
      reply = { ...reply, bytes, estimated_tokens: estimateTokens(bytes) };
      const measured = bytesOf(reply);
      if (measured === bytes) break;
      bytes = measured;
    }

    await db.insert(workContextReads).values({
      workId: work.id,
      teamId: work.teamId,
      principalKind: principal.kind,
      principalId: principalId(principal),
      bytes,
      incomplete: reply.incomplete === true,
    });
    return reply;
  } catch (error) {
    return refusalOf(error);
  }
}
