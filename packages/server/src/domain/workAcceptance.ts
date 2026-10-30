import { randomUUID } from 'node:crypto';
import { workDecisionSchema, type WorkArtifact, type WorkDecisionInput } from '@bridge/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db';
import {
  agentInstallations,
  agentRuns,
  workAcceptances,
  workDeliveries,
  workEvidence,
  workItems,
  workLinks,
} from '../db/schema';
import { isCanonicalUuid } from '../lib/ids';
import { redactSecrets } from '../lib/redact';
import { runWorkCommand } from './work';
import { artifactVersionLabel, buildEvidenceManifest, resolveArtifact } from './workEvidence';
import { blockingState } from './workGraph';
import { loadRevision } from './workRevisions';
import {
  parseOrRefuse,
  refusalOf,
  refuse,
  wireBigint,
  workError,
  type WorkCommandOutcome,
  type WorkItemRow,
  type WorkOpContext,
  type WorkOpResult,
  type WorkPrincipal,
  type WorkRefusalError,
  type WorkResult,
} from './workTypes';

/**
 * A person's recorded decision on one delivery: accept, or request changes.
 *
 * Only a browser session decides. A bearer credential is an agent principal
 * even when it is a person's own token, and no MCP door reaches this function.
 * The decision is bound to the snapshot the person looked at (version, contract
 * revision, delivery, evidence epoch and manifest hash), recomputed under the
 * work lock before anything is written, so a provider fact or a new delivery
 * that lands while they read refuses the decision instead of slipping under it.
 * The manifest is stored whole beside its hash: the decision can be reread
 * exactly as it was made, and a new decision is a new row.
 */

const NOT_VISIBLE = 'No work with that id is visible to this principal.';
const SHORT_REASON_CHARS = 200;

const isRefusal = (value: unknown): value is { error: WorkRefusalError } =>
  Boolean(value && typeof value === 'object' && 'error' in value);

const short = (value: string) => (value.length > SHORT_REASON_CHARS ? `${value.slice(0, SHORT_REASON_CHARS)}…` : value);

/** What the decision form sends back unchanged, besides the decision itself. */
const SNAPSHOT_FIELDS = ['spec_revision', 'delivery_id', 'evidence_epoch', 'evidence_manifest_hash'] as const;

/**
 * The people who did the work: whoever submitted any of its deliveries, and the
 * owners of every run ever linked to it. A superseded link counts too: a
 * correction says where a run is filed now, not that it never ran here, and
 * any member may make one for a run without any say over this work, so
 * dropping superseded links would let an acceptor who ran part of it file
 * their own run elsewhere and then decide as if they had not. A link that
 * really was a mistake costs only this: the person named by it cannot accept
 * work that asks for independence, and another acceptor, or a workspace owner
 * with a reason, decides. Independence is judged against them.
 */
async function executorsOf(tx: Db, workId: string): Promise<Set<string>> {
  const submitters = await tx
    .selectDistinct({ userId: workDeliveries.submittedByUserId })
    .from(workDeliveries)
    .where(eq(workDeliveries.workId, workId));
  const runners = await tx
    .selectDistinct({ userId: agentInstallations.userId })
    .from(workLinks)
    .innerJoin(agentRuns, eq(agentRuns.id, workLinks.runId))
    .innerJoin(agentInstallations, eq(agentInstallations.id, agentRuns.installationId))
    .where(and(eq(workLinks.workId, workId), eq(workLinks.kind, 'run')));
  return new Set([...submitters, ...runners].flatMap((row) => (row.userId ? [row.userId] : [])));
}

/**
 * Record a decision. `workId` is the work the decision is about (the console
 * resolves it from the address); the input is the decision form as posted.
 */
export async function recordDecision(
  db: Db,
  principal: WorkPrincipal,
  workId: string,
  rawInput: WorkDecisionInput | Record<string, unknown>,
): Promise<WorkResult<WorkCommandOutcome>> {
  // Refused before anything is reserved: an agent's attempt leaves no receipt.
  if (principal.kind !== 'human') {
    return {
      error: workError(
        'FORBIDDEN',
        'Only a person signed in to the console records a decision. No agent, token or API credential can accept or request changes.',
      ),
    };
  }
  let input: WorkDecisionInput;
  let target: { teamId: string; projectId: string } | undefined;
  try {
    input = parseOrRefuse(workDecisionSchema, rawInput);
    if (!isCanonicalUuid(workId)) throw refuse('NOT_FOUND', NOT_VISIBLE);
    [target] = await db
      .select({ teamId: workItems.teamId, projectId: workItems.projectId })
      .from(workItems)
      .where(eq(workItems.id, workId.toLowerCase()))
      .limit(1);
    if (!target) throw refuse('NOT_FOUND', NOT_VISIBLE);
  } catch (error) {
    return refusalOf(error);
  }
  const id = workId.toLowerCase();
  const { request_id: requestId, expected_version: expectedVersion, ...payload } = input;
  const result = await runWorkCommand(
    db,
    principal,
    {
      requestId,
      operation: 'decision',
      teamId: target.teamId,
      projectId: target.projectId,
      workId: id,
      expectedVersion: BigInt(expectedVersion),
      hashInput: { operation: 'decision', work_id: id, expected_version: expectedVersion, payload },
    },
    (tx, ctx) => applyDecision(tx, ctx, input),
  );
  if (isRefusal(result) && result.error.code === 'VERSION_CONFLICT') {
    return { error: await whatMoved(db, id, input, result.error) };
  }
  return result;
}

/**
 * A version conflict on a decision usually means the evidence moved (a
 * provider fact, a new delivery). The envelope refuses before the snapshot is
 * compared, so the fields that moved are named here, read after the refusal:
 * the caller has just been shown to have access, and nothing was written.
 */
async function whatMoved(db: Db, workId: string, input: WorkDecisionInput, error: WorkRefusalError) {
  const [row] = await db
    .select({
      specRevision: workItems.specRevision,
      currentDeliveryId: workItems.currentDeliveryId,
      evidenceEpoch: workItems.evidenceEpoch,
    })
    .from(workItems)
    .where(eq(workItems.id, workId))
    .limit(1);
  if (!row) return error;
  const moved: string[] = [];
  if (row.specRevision !== input.spec_revision) moved.push('spec_revision');
  if (row.currentDeliveryId !== input.delivery_id.toLowerCase()) moved.push('delivery_id');
  if (wireBigint(row.evidenceEpoch) !== input.evidence_epoch) moved.push('evidence_epoch');
  if (!moved.length) return error;
  return {
    ...error,
    message: `${error.message} What moved: ${moved.join(', ')}.`,
    fields: [...new Set([...(error.fields ?? []), ...moved])],
  };
}

async function applyDecision(tx: Db, ctx: WorkOpContext, input: WorkDecisionInput): Promise<WorkOpResult> {
  const { principal, access, work } = ctx;
  if (!principal || !access || !work) throw new Error('A decision needs a principal and its work.');
  if (principal.kind !== 'human') throw refuse('FORBIDDEN', 'Only a person signed in to the console records a decision.');
  if (work.archivedAt) {
    throw refuse('INVALID_TRANSITION', 'Archived work is read-only.', { next_action: 'Reopen it with a reason first.' });
  }
  if (work.state !== 'in_review') {
    throw refuse('INVALID_TRANSITION', `Work in ${work.state} takes no decision; a decision is recorded on work in review.`, {
      next_action:
        work.state === 'in_progress'
          ? `It needs a delivery for revision ${work.specRevision} first.`
          : 'Read the work again; its state has moved.',
    });
  }

  // Standing: the acceptor, or a workspace owner who says why they decide instead.
  const reason = input.reason.trim();
  const standing = work.acceptorUserId === principal.userId ? 'acceptor' : access.role === 'owner' ? 'owner_override' : null;
  if (!standing) {
    throw refuse('FORBIDDEN', "Only the work's acceptor, or a workspace owner giving a reason, records a decision.");
  }
  if (standing === 'owner_override' && !reason) {
    throw refuse('INVALID_INPUT', 'A workspace owner deciding instead of the acceptor must give a reason.', {
      fields: ['reason'],
    });
  }

  // The snapshot the person looked at, recomputed before their own checks land.
  const before = await buildEvidenceManifest(tx, work, { asOf: ctx.now });
  const moved: string[] = [];
  if (input.spec_revision !== work.specRevision) moved.push('spec_revision');
  if (input.delivery_id.toLowerCase() !== work.currentDeliveryId) moved.push('delivery_id');
  if (input.evidence_epoch !== wireBigint(work.evidenceEpoch)) moved.push('evidence_epoch');
  if (input.evidence_manifest_hash.toLowerCase() !== before.hash) moved.push('evidence_manifest_hash');
  if (moved.length) {
    throw refuse('EVIDENCE_STALE', 'The evidence changed after it was shown. Read it again and decide on what is there now.', {
      fields: SNAPSHOT_FIELDS.filter((field) => moved.includes(field)),
      next_action: 'Reload the work and decide again.',
    });
  }
  const [delivery] = await tx
    .select()
    .from(workDeliveries)
    .where(and(eq(workDeliveries.id, work.currentDeliveryId!), eq(workDeliveries.workId, work.id)))
    .limit(1);
  if (!delivery || delivery.specRevision !== work.specRevision) {
    throw refuse('EVIDENCE_STALE', `The current delivery is not for contract revision ${work.specRevision}.`, {
      fields: ['delivery_id'],
      next_action: `Wait for a delivery against revision ${work.specRevision}.`,
    });
  }
  const revision = await loadRevision(tx, work.id, work.specRevision);
  if (!revision) throw new Error(`Work ${work.id} has no revision ${work.specRevision}.`);
  const criteria = new Map(revision.criteria.map((criterion) => [criterion.id, criterion]));
  const artifacts = delivery.artifacts as WorkArtifact[];

  // Human checks become evidence rows of their own provenance, each naming the
  // exact artifact version that was looked at. A general "I looked" is not one.
  const checked = new Set<string>();
  const values: (typeof workEvidence.$inferInsert)[] = [];
  for (const [index, check] of input.human_checks.entries()) {
    const field = `human_checks[${index}]`;
    const criterion = criteria.get(check.criterion_id);
    if (!criterion) {
      throw refuse('INVALID_INPUT', `${field}.criterion_id is not a criterion of contract revision ${work.specRevision}.`, {
        fields: [`${field}.criterion_id`],
      });
    }
    if (!criterion.verificationRule.selectors.some((selector) => selector.source === 'human_check')) {
      throw refuse('INVALID_INPUT', `${field}.criterion_id does not ask for a human check.`, { fields: [`${field}.criterion_id`] });
    }
    if (checked.has(check.criterion_id)) {
      throw refuse('INVALID_INPUT', `${field}.criterion_id is checked twice in one decision.`, { fields: [`${field}.criterion_id`] });
    }
    checked.add(check.criterion_id);
    const found = resolveArtifact(artifacts, check.artifact_ref);
    if (!found || found === 'ambiguous') {
      throw refuse(
        'INVALID_INPUT',
        found === 'ambiguous'
          ? `${field}.artifact_ref names more than one artifact of this delivery; use artifacts[N].`
          : `${field}.artifact_ref names no artifact of this delivery.`,
        { fields: [`${field}.artifact_ref`] },
      );
    }
    // The check records the version that was looked at (spec 10). A document
    // delivered as a bare link has none: whatever is behind it can change, and
    // a check against it says nothing about what was delivered.
    const version = artifactVersionLabel(found.artifact);
    if (version === null) {
      throw refuse(
        'INVALID_INPUT',
        `${field}.artifact_ref names a document delivered without a version_id or a sha256, so the version that was checked cannot be recorded.`,
        {
          fields: [`${field}.artifact_ref`],
          next_action: 'Request changes asking for a delivery that pins the document version, then check that one.',
        },
      );
    }
    const [previous] = await tx
      .select({ id: workEvidence.id })
      .from(workEvidence)
      .where(
        and(
          eq(workEvidence.deliveryId, delivery.id),
          eq(workEvidence.criterionId, check.criterion_id),
          eq(workEvidence.provenance, 'human_decision'),
        ),
      )
      .orderBy(desc(workEvidence.recordedAt), desc(workEvidence.id))
      .limit(1);
    values.push({
      id: randomUUID(),
      workId: work.id,
      deliveryId: delivery.id,
      criterionId: check.criterion_id,
      specRevision: delivery.specRevision,
      sourceKind: 'human_check',
      sourceRef: check.artifact_ref,
      sourceVersion: version,
      assertion: check.assertion,
      excerpt: redactSecrets(check.note),
      provenance: 'human_decision',
      reportedByKind: 'human',
      reportedById: principal.userId,
      reportedByUserId: principal.userId,
      observedAt: ctx.now,
      recordedAt: ctx.now,
      supersedesId: previous?.id ?? null,
    });
  }
  let current: WorkItemRow = work;
  if (values.length) {
    await tx.insert(workEvidence).values(values);
    // Evidence about the current delivery changed, so the epoch moves; the
    // acceptance stores the moved one, which is what keeps it current.
    current = { ...work, evidenceEpoch: work.evidenceEpoch + 1n };
    await tx.update(workItems).set({ evidenceEpoch: current.evidenceEpoch }).where(eq(workItems.id, work.id));
  }
  const after = values.length ? await buildEvidenceManifest(tx, current, { asOf: ctx.now }) : before;

  let changeCriteria: string[] = [];
  if (input.decision === 'accept') {
    const fields = after.readiness.criteria
      .filter((criterion) => criterion.required && criterion.result !== 'pass')
      .map((criterion) => `criteria.${criterion.id}`);
    const blocking = (await blockingState(tx, [work.id])).get(work.id);
    if (blocking?.blocked) {
      for (const blocker of blocking.blockers) {
        fields.push(blocker.id ? `blockers.${blocker.id}` : `blockers.${blocker.kind}`);
      }
      for (const dependency of blocking.unmet) fields.push(`dependencies.${dependency.key}`);
      if (!blocking.blockers.length && !blocking.unmet.length) fields.push('blockers');
    }
    if (fields.length) {
      throw refuse(
        'INVALID_TRANSITION',
        'Accepting needs every required criterion to pass against this delivery and nothing blocking the work.',
        { fields, next_action: 'Request changes naming the criteria that are not met, or wait for the missing evidence.' },
      );
    }
  } else {
    if (!reason) throw refuse('INVALID_INPUT', 'Requesting changes needs a reason.', { fields: ['reason'] });
    if (!input.criteria.length) {
      throw refuse('INVALID_INPUT', 'Name at least one criterion that is not met.', { fields: ['criteria'] });
    }
    input.criteria.forEach((criterionId, index) => {
      if (!criteria.has(criterionId)) {
        throw refuse('INVALID_INPUT', `criteria[${index}] is not a criterion of contract revision ${work.specRevision}.`, {
          fields: [`criteria[${index}]`],
        });
      }
    });
    changeCriteria = [...new Set(input.criteria)];
  }

  // Independence: an acceptor who delivered or ran part of the work is a self
  // review. Refused for an accept when the contract asks for independence;
  // otherwise allowed and said, on the row and in the event.
  const selfReview = (await executorsOf(tx, work.id)).has(principal.userId);
  const requireIndependent = revision.acceptancePolicy.require_independent_acceptor === true;
  if (input.decision === 'accept' && selfReview && requireIndependent) {
    throw refuse('FORBIDDEN', 'This work asks for an independent acceptor, and you delivered or ran part of it.', {
      next_action: 'Have another member named as the acceptor decide.',
    });
  }

  const acceptanceId = randomUUID();
  await tx.insert(workAcceptances).values({
    id: acceptanceId,
    workId: work.id,
    specRevision: work.specRevision,
    deliveryId: delivery.id,
    evidenceManifest: after.manifest,
    evidenceManifestHash: after.hash,
    evidenceEpoch: current.evidenceEpoch,
    decision: input.decision,
    reason,
    criteria: changeCriteria,
    actorUserId: principal.userId,
    actorScopeSnapshot: {
      role: access.role,
      standing,
      self_review: selfReview,
      require_independent_acceptor: requireIndependent,
      human_checks: values.length,
    },
    policyVersion: null,
    // The manifest was read as of this instant; a later staleness check rebuilds it as of the same one.
    createdAt: ctx.now,
  });
  const to = input.decision === 'accept' ? 'accepted' : 'in_progress';
  await tx
    .update(workItems)
    .set(input.decision === 'accept' ? { state: to, currentAcceptanceId: acceptanceId } : { state: to })
    .where(eq(workItems.id, work.id));

  const payload: Record<string, unknown> = {
    acceptance_id: acceptanceId,
    delivery_id: delivery.id,
    spec_revision: work.specRevision,
    evidence_epoch: wireBigint(current.evidenceEpoch),
    evidence_manifest_hash: after.hash,
    standing,
    self_review: selfReview,
    human_checks: values.length,
    state: { from: work.state, to },
  };
  if (changeCriteria.length) payload.criteria = changeCriteria;
  if (reason) payload.reason = short(reason);
  return {
    events: [
      { workId: work.id, type: input.decision === 'accept' ? 'work_accepted' : 'work_changes_requested', payload },
    ],
    resultRef: acceptanceId,
    response: {
      acceptance_id: acceptanceId,
      decision: input.decision,
      standing,
      self_review: selfReview,
      evidence_epoch: wireBigint(current.evidenceEpoch),
      evidence_manifest_hash: after.hash,
    },
  };
}
