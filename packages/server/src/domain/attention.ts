import {
  ACTIVE_AGENT_RUN_STATUSES,
  areAttemptSiblings,
  describeHolder,
  detectClaimConflicts,
  holderNeedsAPerson,
  isReadOverlap,
  type ClaimConflict,
  type ConflictClaim,
  type ConflictSeverity,
} from '@bridge/shared';
import { and, countDistinct, desc, eq, gt, gte, inArray, ne, notInArray } from 'drizzle-orm';
import type { Db } from '../db';
import {
  agentEvents,
  agentInstallations,
  agentRuns,
  debugSessions,
  handoffs,
  memberships,
  policyReceipts,
  projects,
  tokens,
  users,
  workClaims,
} from '../db/schema';
import { pendingHandoffs } from '../lib/sessions';
import { claimDeclarationKey, RELEASED_CLAIM } from './agents';

/**
 * What a workspace member should look at now: the read model behind Needs
 * attention.
 *
 * It answers one question per source, from the table that holds the truth, and
 * keeps every other reading out:
 *
 *   - **Overlaps are recomputed from live claims**, never read back from
 *     `conflicts_detected` events. An event is a record that something was true
 *     once. Read as an inbox it failed in both directions: a collision stayed
 *     "live" after the counterpart finished or the ground moved, and a real one
 *     vanished once sixty newer heartbeat events pushed it out of the newest-50
 *     window (and the page then printed an all-clear). The pairing is the agent
 *     map's own (`areAttemptSiblings`, the same team and project, then
 *     `detectClaimConflicts`), so the two cannot disagree about what is
 *     contested; `attention.test.ts` pins that.
 *   - **Receipts are read for live runs directly**, not as the newest N of every
 *     run filtered afterwards, which let finished runs' receipts hide a live
 *     drifted one. Drift is a deviation and needs action. A receipt nobody has
 *     answered yet is *unconfirmed*, a different state that Governance and the
 *     rail already keep apart, so it is only advisory and only once the run has
 *     been alive long enough for silence to mean something.
 *   - **Handoffs have an age, never an expiry.** Nothing in the lifecycle
 *     expires a handoff, so a stale offer is shown as waiting, with how long,
 *     rather than being hidden or declared dead.
 *
 * Every row says who is responsible only when a stored fact says so: the
 * accepting member, else the named person, else the owner of the named agent.
 * The sender is shown as the sender and is never made responsible, because a
 * sender is often the one waiting.
 *
 * Bounded everywhere and the bounds are returned, so the page can say "at
 * least" instead of implying a total. Writes nothing. Read by the Needs
 * attention page only, which is why `acceptance/tiers.json` lists it under
 * consoleOnly: it CALLS surface modules (`pendingHandoffs`, the conflict
 * functions) and edits none of them.
 */

/** Open handoffs listed; one more is asked for so "more than N" can be said. */
export const ATTENTION_HANDOFF_LIMIT = 10;
/** Live runs read for overlaps and receipts, newest heartbeat first. */
export const ATTENTION_RUN_SCAN = 200;
/** Overlapping run pairs and receipt rows drawn per kind. */
export const ATTENTION_ROWS = 10;
/** A run that has not answered the policy receipt this long has been silent, not merely new. */
export const UNCONFIRMED_GRACE_MINUTES = 15;
/** How far back "recently ended" looks. */
export const ATTENTION_ENDED_DAYS = 7;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ACTIVE = [...ACTIVE_AGENT_RUN_STATUSES];
const NAMED_RESOURCES = 3;

export type AttentionState = 'needs_action' | 'waiting' | 'advisory';

export interface AttentionPerson {
  label: string;
  role: 'sender' | 'receiver' | 'run owner';
}

export interface AttentionLink {
  href: string;
  /** Always says "(read only)": nothing on this page changes anything. */
  label: string;
}

export interface AttentionItem {
  id: string;
  kind: 'handoff' | 'overlap' | 'policy_drift' | 'policy_unconfirmed';
  state: AttentionState;
  problem: string;
  /** Null when the record names no project (a team-wide run, a session with none). */
  project: string | null;
  runIds: string[];
  person: AttentionPerson[];
  why: string;
  nextStep: string;
  links: AttentionLink[];
}

export interface AttentionLimits {
  handoffs: { limit: number; shown: number; more: boolean };
  runs: { limit: number; read: number; truncated: boolean };
  overlaps: { limit: number; shown: number; total: number };
  receipts: { limit: number; shown: number; total: number };
}

export interface AttentionReading {
  items: AttentionItem[];
  groups: Record<AttentionState, AttentionItem[]>;
  /** Read-against-write overlaps: counted, never a row. A read holds nothing. */
  readOnlyOverlaps: { pairs: number };
  limits: AttentionLimits;
  /** Distinct runs that reported an overlap in the last week and are no longer live. */
  ended: number;
  endedDays: number;
  at: Date;
}

/** "3 days ago", from the reading's own clock so the same reading says the same words. */
export function agoWords(from: Date, now: Date): string {
  const ms = Math.max(0, now.getTime() - from.getTime());
  if (ms < MINUTE) return 'moments ago';
  if (ms < HOUR) {
    const minutes = Math.floor(ms / MINUTE);
    return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  }
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR);
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }
  const days = Math.floor(ms / DAY);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

const stateRank: Record<AttentionState, number> = { needs_action: 0, waiting: 1, advisory: 2 };
const severityRank: Record<ConflictSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const list = (values: string[]) => {
  const unique = [...new Set(values)];
  return unique.length > 1 ? `${unique.slice(0, -1).join(', ')} and ${unique.at(-1)}` : (unique[0] ?? '');
};

function namedResources(keys: string[]): string {
  const unique = [...new Map(keys.map((key) => [key.toLowerCase(), key])).values()];
  const named = unique.slice(0, NAMED_RESOURCES);
  const rest = unique.length - named.length;
  const head = list(named);
  return rest > 0 ? `${head} and ${rest} more` : head;
}

interface LiveRun {
  run: typeof agentRuns.$inferSelect;
  agentName: string;
  ownerId: string;
  owner: string;
  projectName: string | null;
  projectSlug: string | null;
}

type Pair = {
  a: LiveRun;
  b: LiveRun;
  write: Array<ClaimConflict & { first: 'a' | 'b' | null }>;
  readOnly: number;
};

/** Pairs of live runs that overlap, the way the agent map pairs them. */
function pairOverlaps(
  runs: LiveRun[],
  claimsByRun: Map<string, ConflictClaim[]>,
  firstDeclared: Map<string, Date>,
): Pair[] {
  const byProject = new Map<string, LiveRun[]>();
  for (const row of runs) {
    const key = row.run.projectId ?? '';
    byProject.set(key, [...(byProject.get(key) ?? []), row]);
  }
  const pairs: Pair[] = [];
  for (const group of byProject.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i]!;
        const b = group[j]!;
        // Parallel attempts of one person at one task are a fan-out, not a collision.
        const identity = (row: LiveRun) => ({
          ownerId: row.ownerId,
          attemptGroup: row.run.attemptGroup,
          taskKey: row.run.taskKey,
          worktree: row.run.worktree,
        });
        if (areAttemptSiblings(identity(a), identity(b))) continue;
        const left = claimsByRun.get(a.run.id) ?? [];
        const right = claimsByRun.get(b.run.id) ?? [];
        if (left.length === 0 || right.length === 0) continue;
        const found = detectClaimConflicts(left, right);
        if (found.length === 0) continue;
        const write: Pair['write'] = [];
        let readOnly = 0;
        for (const conflict of found) {
          if (isReadOverlap(conflict)) {
            readOnly += 1;
            continue;
          }
          const fa = firstDeclared.get(`${a.run.id}\0${claimDeclarationKey(conflict.current)}`);
          const fb = firstDeclared.get(`${b.run.id}\0${claimDeclarationKey(conflict.existing)}`);
          const first = fa && fb ? (fa < fb ? 'a' : fb < fa ? 'b' : null) : null;
          write.push({ ...conflict, first });
        }
        pairs.push({ a, b, write, readOnly });
      }
    }
  }
  return pairs;
}

function overlapItem(pair: Pair, slug: string, now: Date): AttentionItem {
  const worst = pair.write.reduce<ConflictSeverity>(
    (best, conflict) => (severityRank[conflict.severity] < severityRank[best] ? conflict.severity : best),
    'low',
  );
  const [pa, pb] = [pair.a, pair.b];
  const firsts = new Set(pair.write.map((conflict) => conflict.first));
  const firstRun = firsts.size === 1 && !firsts.has(null) ? (firsts.has('a') ? pa : pb) : null;
  const mixed = firsts.has('a') && firsts.has('b');
  const stopped = [pa, pb].filter((row) => holderNeedsAPerson(row.run.status as ConflictClaim['runState']));
  const owners = list([pa.owner, pb.owner]);

  let nextStep: string;
  if (stopped.length > 0) {
    const names = list(stopped.map((row) => `${row.agentName} (${row.owner})`));
    nextStep = `${names} stopped to ask a person and will not free this ground by itself. Ask ${list(stopped.map((row) => row.owner))} to answer it or to release the ground.`;
  } else if (firstRun) {
    const other = firstRun === pa ? pb : pa;
    nextStep = `${firstRun.agentName} declared the ground first and carries on. Ask ${other.owner} to have ${other.agentName} wait or narrow its scope.`;
  } else if (mixed) {
    nextStep = `Each run was first on part of the ground. Ask ${owners} to agree which one carries on where.`;
  } else {
    nextStep = `Neither run is provably first. Ask ${owners} which one carries on.`;
  }

  const sample = pair.write[0]!;
  const keys = pair.write.flatMap((conflict) => [conflict.current.resourceKey, conflict.existing.resourceKey]);
  return {
    id: `overlap:${[pa.run.id, pb.run.id].sort().join(':')}`,
    kind: 'overlap',
    state: 'needs_action',
    problem: `Live scope overlap (${worst}): two live runs may change the same ground`,
    project: pa.projectName,
    runIds: [pa.run.id, pb.run.id],
    person: [
      { label: pa.owner, role: 'run owner' },
      ...(pb.ownerId === pa.ownerId ? [] : [{ label: pb.owner, role: 'run owner' as const }]),
    ],
    why: `${namedResources(keys)}. ${describeHolder(sample.current, now)}; ${describeHolder(sample.existing, now)}. Both claims are live now.`,
    nextStep,
    links: [pa, pb].map((row) => ({
      href: `/app/agents?run=${row.run.id}&team=${slug}`,
      label: `Open ${row.agentName}'s run (read only)`,
    })),
  };
}

/**
 * Everything Needs attention shows, read at one instant.
 *
 * `now` is a parameter so two readings around a mutation are comparable, and so
 * a lease that lapsed a second ago is lapsed in every query below.
 */
export async function readAttention(
  db: Db,
  input: {
    userId: string;
    team: { id: string; slug: string };
    now?: Date;
  },
): Promise<AttentionReading> {
  const { userId, team } = input;
  const now = input.now ?? new Date();
  const slug = team.slug;

  // ---- live runs, bounded (one more than the bound, to know there were more)
  const scanned = await db
    .select({
      run: agentRuns,
      agentName: agentInstallations.name,
      ownerId: users.id,
      owner: users.username,
      projectName: projects.name,
      projectSlug: projects.slug,
    })
    .from(agentRuns)
    .innerJoin(agentInstallations, eq(agentRuns.installationId, agentInstallations.id))
    .innerJoin(users, eq(agentInstallations.userId, users.id))
    .leftJoin(projects, eq(agentRuns.projectId, projects.id))
    .where(and(eq(agentRuns.teamId, team.id), inArray(agentRuns.status, ACTIVE)))
    .orderBy(desc(agentRuns.lastHeartbeatAt))
    .limit(ATTENTION_RUN_SCAN + 1);
  const runsTruncated = scanned.length > ATTENTION_RUN_SCAN;
  const runs: LiveRun[] = scanned.slice(0, ATTENTION_RUN_SCAN);
  const runById = new Map(runs.map((row) => [row.run.id, row]));

  // ---- overlaps: live claims of live runs, one clock
  const claimRows = runs.length
    ? await db
        .select()
        .from(workClaims)
        .where(
          and(
            inArray(workClaims.runId, runs.map((row) => row.run.id)),
            gt(workClaims.leaseExpiresAt, now),
            ne(workClaims.source, RELEASED_CLAIM),
          ),
        )
    : [];
  const claimsByRun = new Map<string, ConflictClaim[]>();
  const firstDeclared = new Map<string, Date>();
  const seenClaim = new Set<string>();
  for (const claim of claimRows) {
    const row = runById.get(claim.runId);
    if (!row) continue;
    const declaration = `${claim.runId}\0${claimDeclarationKey(claim)}`;
    if (claim.firstDeclaredAt) {
      const known = firstDeclared.get(declaration);
      if (!known || claim.firstDeclaredAt < known) firstDeclared.set(declaration, claim.firstDeclaredAt);
    }
    // A claim planned and observed at once is one piece of ground.
    if (seenClaim.has(declaration)) continue;
    seenClaim.add(declaration);
    const conflictClaim: ConflictClaim = {
      runId: claim.runId,
      owner: row.owner,
      agentName: row.agentName,
      taskKey: row.run.taskKey,
      resourceType: claim.resourceType as ConflictClaim['resourceType'],
      resourceKey: claim.resourceKey,
      access: claim.access as ConflictClaim['access'],
      runState: row.run.status as ConflictClaim['runState'],
      leaseEndsAt: claim.leaseExpiresAt.toISOString(),
    };
    claimsByRun.set(claim.runId, [...(claimsByRun.get(claim.runId) ?? []), conflictClaim]);
  }
  let pairs = pairOverlaps(runs, claimsByRun, firstDeclared);

  // ---- the resolution race: a run may have finished between the reads above
  // and now. Ask once more, in this same reading, and drop anything a run that
  // is no longer live is part of.
  const involved = [...new Set(pairs.flatMap((pair) => [pair.a.run.id, pair.b.run.id]))];
  if (involved.length > 0) {
    const stillLive = new Set(
      (
        await db
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(and(inArray(agentRuns.id, involved), inArray(agentRuns.status, ACTIVE)))
      ).map((row) => row.id),
    );
    pairs = pairs.filter((pair) => stillLive.has(pair.a.run.id) && stillLive.has(pair.b.run.id));
  }
  const writePairs = pairs
    .filter((pair) => pair.write.length > 0)
    .map((pair) => ({
      pair,
      worst: Math.min(...pair.write.map((conflict) => severityRank[conflict.severity])),
    }))
    .sort((x, y) => x.worst - y.worst);
  const readOnlyPairs = pairs.filter((pair) => pair.write.length === 0 && pair.readOnly > 0).length;
  const shownPairs = writePairs.slice(0, ATTENTION_ROWS);
  const items: AttentionItem[] = shownPairs.map(({ pair }) => overlapItem(pair, slug, now));

  // ---- policy receipts of live runs
  const receiptRows = runs.length
    ? await db
        .select()
        .from(policyReceipts)
        .where(inArray(policyReceipts.runId, runs.map((row) => row.run.id)))
    : [];
  const receiptItems: AttentionItem[] = [];
  const quiet = UNCONFIRMED_GRACE_MINUTES * MINUTE;
  for (const receipt of receiptRows) {
    const row = runById.get(receipt.runId);
    if (!row) continue;
    const common = {
      project: row.projectName,
      runIds: [row.run.id],
      person: [{ label: row.owner, role: 'run owner' as const }],
      links: [
        { href: `/app/agents?run=${row.run.id}&team=${slug}`, label: `Open ${row.agentName}'s run (read only)` },
        { href: `/app/teams/${slug}/governance`, label: 'Open Governance (read only)' },
      ],
    };
    const task = row.run.taskKey ?? 'untitled run';
    if (receipt.drift) {
      receiptItems.push({
        ...common,
        id: `drift:${row.run.id}`,
        kind: 'policy_drift',
        state: 'needs_action',
        problem: 'Reported policy hash differs',
        why: `${row.agentName} (${row.owner}) reported a policy hash other than the one the server served for ${task}, ${agoWords(row.run.startedAt, now)}. A matching hash would not prove compliance either.`,
        nextStep: `Ask ${row.owner} which rules the agent is following, and compare with the published rules on Governance.`,
      });
    } else if (!receipt.reportedHash && now.getTime() - row.run.startedAt.getTime() >= quiet) {
      receiptItems.push({
        ...common,
        id: `unconfirmed:${row.run.id}`,
        kind: 'policy_unconfirmed',
        state: 'advisory',
        problem: 'Policy hash not reported',
        why: `${row.agentName} (${row.owner}) has not said which rules it applied for ${task}; the run started ${agoWords(row.run.startedAt, now)} and has reported nothing about them. This is silence, not a deviation, and a matching hash would not prove compliance.`,
        nextStep: `Nothing is wrong yet. If it matters, ask ${row.owner} whether the agent read the published rules.`,
      });
    }
  }
  receiptItems.sort(
    (x, y) => stateRank[x.state] - stateRank[y.state] || x.id.localeCompare(y.id),
  );
  items.push(...receiptItems.slice(0, ATTENTION_ROWS));

  // ---- handoffs
  // `pendingHandoffs` returns one row per handoff message, so a session with two
  // of them uses two rows. Ask for a window wider than the probe, collapse by
  // session, and only then compare with the limit. A window that came back full
  // yet holds no more than the limit in distinct sessions cannot prove it is
  // complete, so it reads as "more" rather than as a total.
  const offerWindow = (ATTENTION_HANDOFF_LIMIT + 1) * 3;
  const offers = await pendingHandoffs(db, [team.id], { userId }, offerWindow);
  const uniqueOffers = [...new Map(offers.map((offer) => [offer.sessionId, offer])).values()];
  const moreHandoffs =
    uniqueOffers.length > ATTENTION_HANDOFF_LIMIT ||
    (offers.length >= offerWindow && uniqueOffers.length >= ATTENTION_HANDOFF_LIMIT);
  const shownOffers = uniqueOffers.slice(0, ATTENTION_HANDOFF_LIMIT);
  if (shownOffers.length > 0) {
    const sessionIds = shownOffers.map((offer) => offer.sessionId);
    const [records, sessions] = await Promise.all([
      db.select().from(handoffs).where(inArray(handoffs.sessionId, sessionIds)),
      db
        .select({
          id: debugSessions.id,
          createdAt: debugSessions.createdAt,
          projectName: projects.name,
          projectSlug: projects.slug,
        })
        .from(debugSessions)
        .leftJoin(projects, eq(projects.id, debugSessions.projectId))
        .where(and(inArray(debugSessions.id, sessionIds), eq(debugSessions.teamId, team.id))),
    ]);
    const recordBySession = new Map(records.map((record) => [record.sessionId, record]));
    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    const installationIds = [
      ...new Set(records.map((record) => record.targetInstallationId).filter((id): id is string => Boolean(id))),
    ];
    const installations = installationIds.length
      ? await db
          .select({ id: agentInstallations.id, name: agentInstallations.name, userId: agentInstallations.userId })
          .from(agentInstallations)
          .where(inArray(agentInstallations.id, installationIds))
      : [];
    const installationById = new Map(installations.map((row) => [row.id, row]));
    const userIds = [
      ...new Set(
        [
          ...records.flatMap((record) => [record.offeredBy, record.acceptedBy, record.targetUserId]),
          ...installations.map((row) => row.userId),
        ].filter((id): id is string => Boolean(id)),
      ),
    ];
    const people = userIds.length
      ? await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, userIds))
      : [];
    const nameOf = new Map(people.map((row) => [row.id, row.username]));

    // `needs_attention` reaches this page from two different causes: the
    // accepting member or connection is gone (derived by the reader), or the
    // receiving agent reported itself blocked (stored). Only the first may be
    // described as "left or revoked", so check that fact here, for the
    // accepted work in the window, instead of inferring it from the state.
    const acceptors = [
      ...new Set(records.map((record) => record.acceptedBy).filter((id): id is string => Boolean(id))),
    ];
    const stillMembers = new Set(
      acceptors.length
        ? (
            await db
              .select({ userId: memberships.userId })
              .from(memberships)
              .where(and(eq(memberships.teamId, team.id), inArray(memberships.userId, acceptors)))
          ).map((row) => row.userId)
        : [],
    );
    const acceptingInstallationIds = [
      ...new Set(records.map((record) => record.installationId).filter((id): id is string => Boolean(id))),
    ];
    const revokedInstallations = new Set(
      acceptingInstallationIds.length
        ? (
            await db
              .select({ id: agentInstallations.id, revokedAt: agentInstallations.revokedAt, tokenRevokedAt: tokens.revokedAt })
              .from(agentInstallations)
              .leftJoin(tokens, eq(tokens.id, agentInstallations.tokenId))
              .where(inArray(agentInstallations.id, acceptingInstallationIds))
          )
            .filter((row) => row.revokedAt !== null || row.tokenRevokedAt !== null)
            .map((row) => row.id)
        : [],
    );

    for (const offer of shownOffers) {
      const record = recordBySession.get(offer.sessionId);
      const session = sessionById.get(offer.sessionId);
      const sender = (record ? nameOf.get(record.offeredBy) : null) ?? offer.from ?? 'a former member';
      // Responsible, in the order the records give it. Never the sender.
      const receiverId =
        record?.acceptedBy ??
        record?.targetUserId ??
        (record?.targetInstallationId ? installationById.get(record.targetInstallationId)?.userId : null) ??
        null;
      const receiver = receiverId ? (nameOf.get(receiverId) ?? null) : null;
      const person: AttentionPerson[] = [
        ...(receiver ? [{ label: receiver, role: 'receiver' as const }] : []),
        { label: sender, role: 'sender' },
      ];
      const born = record?.createdAt ?? session?.createdAt ?? offer.at;
      const kindWord = offer.kind === 'assignment' ? 'assignment' : 'handoff';
      const target = offer.assignedTo ? `${offer.assignedTo.name}` : null;
      let state: AttentionState;
      let why: string;
      let nextStep: string;
      if (offer.legacy) {
        state = 'waiting';
        why = `A brief from ${sender}, ${agoWords(born, now)}, from before handoffs had a tracked state. Chat replies cannot accept or complete it.`;
        nextStep = `Ask ${sender} to send it again as a tracked handoff.`;
      } else if (offer.state === 'needs_attention') {
        state = 'needs_action';
        const acceptedWhen = record?.acceptedAt ? agoWords(record.acceptedAt, now) : agoWords(born, now);
        const carrierGone =
          record?.acceptedBy != null &&
          (!stillMembers.has(record.acceptedBy) ||
            (record.installationId != null && revokedInstallations.has(record.installationId)));
        if (carrierGone) {
          why = `${receiver ? `${receiver} accepted it` : 'It was accepted'} ${acceptedWhen}, but the accepting member has left the workspace or their agent connection was revoked. Nobody is carrying it.`;
          nextStep = offer.mine
            ? 'You sent it. Open the thread to cancel it, or send the work again to another agent.'
            : `Ask ${sender} to cancel it or send it again; only the sender can cancel.`;
        } else {
          why = `${receiver ? `${receiver}'s agent` : 'The receiving agent'} accepted it ${acceptedWhen} and then reported that it is blocked. The member and the connection are still there.`;
          nextStep = receiver
            ? `Ask ${receiver} what is blocking it. Open the thread to read what the agent reported.`
            : 'Open the thread to read what the agent reported.';
        }
      } else if (offer.state === 'accepted' || offer.state === 'in_progress') {
        state = 'waiting';
        why = `${receiver ?? 'Someone'} accepted this ${kindWord} ${record?.acceptedAt ? agoWords(record.acceptedAt, now) : agoWords(born, now)} and has not reported it complete.`;
        nextStep = receiver
          ? `Ask ${receiver} for a status. Nothing needs doing here if they are working on it.`
          : 'Open the thread to see who has it.';
      } else {
        state = 'waiting';
        why = target
          ? `${sender} assigned this ${kindWord} to ${target} ${agoWords(born, now)}; it has not been accepted.`
          : `${sender} offered this ${kindWord} ${agoWords(born, now)}; nobody has accepted it.`;
        nextStep = target
          ? `Ask ${receiver ?? 'the agent\'s owner'} to check that ${target} is connected and has seen it, or ask ${sender} to cancel it if it is no longer needed.`
          : `Ask a teammate to take it, or ask ${sender} to cancel it if it is no longer needed.`;
      }
      const links: AttentionLink[] = [
        { href: `/app/sessions/${offer.sessionId}`, label: 'Open the thread (read only)' },
      ];
      if (session?.projectSlug) {
        links.push({
          href: `/app/teams/${slug}/projects/${session.projectSlug}`,
          label: 'Open the project (read only)',
        });
      }
      items.push({
        id: `handoff:${offer.sessionId}`,
        kind: 'handoff',
        state,
        problem: offer.title,
        project: session?.projectName ?? null,
        runIds: [],
        person,
        why,
        nextStep,
        links,
      });
    }
  }

  // ---- what ended: a count and nothing else
  const since = new Date(now.getTime() - ATTENTION_ENDED_DAYS * DAY);
  const [endedRow] = await db
    .select({ n: countDistinct(agentEvents.runId) })
    .from(agentEvents)
    .innerJoin(agentRuns, eq(agentRuns.id, agentEvents.runId))
    .where(
      and(
        eq(agentRuns.teamId, team.id),
        eq(agentEvents.type, 'conflicts_detected'),
        gte(agentEvents.createdAt, since),
        notInArray(agentRuns.status, ACTIVE),
      ),
    );

  items.sort(
    (x, y) =>
      stateRank[x.state] - stateRank[y.state] ||
      (x.kind === 'overlap' ? 0 : 1) - (y.kind === 'overlap' ? 0 : 1),
  );
  const groups: Record<AttentionState, AttentionItem[]> = { needs_action: [], waiting: [], advisory: [] };
  for (const item of items) groups[item.state].push(item);

  return {
    items,
    groups,
    readOnlyOverlaps: { pairs: readOnlyPairs },
    limits: {
      handoffs: { limit: ATTENTION_HANDOFF_LIMIT, shown: shownOffers.length, more: moreHandoffs },
      runs: { limit: ATTENTION_RUN_SCAN, read: runs.length, truncated: runsTruncated },
      overlaps: { limit: ATTENTION_ROWS, shown: shownPairs.length, total: writePairs.length },
      receipts: {
        limit: ATTENTION_ROWS,
        shown: Math.min(receiptItems.length, ATTENTION_ROWS),
        total: receiptItems.length,
      },
    },
    ended: Number(endedRow?.n ?? 0),
    endedDays: ATTENTION_ENDED_DAYS,
    at: now,
  };
}
