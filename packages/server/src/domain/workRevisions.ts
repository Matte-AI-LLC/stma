import {
  canonicalJson,
  defaultVerificationRule,
  fingerprintJson,
  type WorkAcceptancePolicy,
  type WorkArtifactKind,
  type WorkContextRef,
  type WorkContract,
  type WorkContractPatch,
  type WorkCriterionInput,
  type WorkEvidenceKind,
  type WorkRiskTier,
  type WorkScope,
  type WorkVerificationRule,
} from '@bridge/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../db';
import { workCriteria, workRevisions } from '../db/schema';
import { actorId, actorKind, actorUserId, refuse, type WorkActor } from './workTypes';

export interface CriterionContent {
  id: string;
  text: string;
  required: boolean;
  evidenceKinds: WorkEvidenceKind[];
  verificationRule: WorkVerificationRule;
}

/** Everything one revision freezes: the contract fields and its criteria, in order. */
export interface RevisionContent {
  title: string;
  goal: string;
  nonGoals: string;
  scope: WorkScope;
  riskTier: WorkRiskTier;
  artifactKind: WorkArtifactKind | null;
  contextRefs: WorkContextRef[];
  acceptancePolicy: WorkAcceptancePolicy;
  criteria: CriterionContent[];
}

/**
 * An empty list and an absent one mean the same scope. Dropping the empty ones
 * keeps `{}` and `{ paths: [] }` from hashing differently and producing a
 * revision that changed nothing a reader could see.
 */
function normalizeScope(scope: WorkScope | undefined): WorkScope {
  const out: WorkScope = {};
  for (const key of ['paths', 'components', 'contracts'] as const) {
    const list = scope?.[key];
    if (list?.length) out[key] = [...new Set(list)];
  }
  return out;
}

/** The wire shape the hash is taken over. One function, so the hash cannot drift from the fields. */
function canonicalContent(content: RevisionContent) {
  return {
    title: content.title,
    goal: content.goal,
    non_goals: content.nonGoals,
    scope: content.scope,
    risk_tier: content.riskTier,
    artifact_kind: content.artifactKind,
    context_refs: content.contextRefs,
    acceptance_policy: content.acceptancePolicy,
    criteria: content.criteria.map(canonicalCriterion),
  };
}

const canonicalCriterion = (criterion: CriterionContent) => ({
  id: criterion.id,
  text: criterion.text,
  required: criterion.required,
  evidence_kinds: criterion.evidenceKinds,
  verification_rule: criterion.verificationRule,
});

export const revisionContentHash = (content: RevisionContent): string => fingerprintJson(canonicalContent(content));

const GENERATED_ID = /^c([0-9]{1,9})$/;

/**
 * Turn a caller's criterion list into stored criteria. A given id is kept: it
 * is the caller saying "this is the same criterion". A missing one becomes
 * `c<n>`, numbered above every id this work has ever used, so a criterion that
 * was removed never lends its identity (and its evidence) to a new meaning.
 * `prefix` is where the list sits on the wire (`payload.` inside a patch).
 */
export function buildCriteria(
  input: readonly WorkCriterionInput[],
  usedIds: ReadonlySet<string>,
  prefix = '',
): CriterionContent[] {
  const seen = new Map<string, number>();
  let highest = 0;
  const consider = (id: string) => {
    const match = GENERATED_ID.exec(id);
    if (match) highest = Math.max(highest, Number(match[1]));
  };
  for (const id of usedIds) consider(id);
  input.forEach((criterion, index) => {
    if (!criterion.id) return;
    const earlier = seen.get(criterion.id);
    if (earlier !== undefined) {
      throw refuse(
        'INVALID_INPUT',
        `${prefix}criteria[${index}].id repeats the id of ${prefix}criteria[${earlier}]; each criterion needs its own id.`,
        { fields: [`${prefix}criteria[${index}].id`] },
      );
    }
    seen.set(criterion.id, index);
    consider(criterion.id);
  });

  return input.map((criterion, index) => {
    const evidenceKinds = [...new Set(criterion.evidence_kinds ?? ['agent_report'])] as WorkEvidenceKind[];
    let verificationRule = criterion.verification_rule;
    if (!verificationRule) {
      const fallback = defaultVerificationRule(evidenceKinds);
      if ('error' in fallback) {
        throw refuse('INVALID_INPUT', `${prefix}criteria[${index}].verification_rule: ${fallback.error}.`, {
          fields: [`${prefix}criteria[${index}].verification_rule`],
        });
      }
      verificationRule = fallback;
    } else {
      // The rule is what is evaluated and the kinds are what every page, the
      // export and the tool replies say a criterion asks for, so they must name
      // the same sources. Apart, a criterion that read "provider observation"
      // could be met by the agent's own report, which is exactly what a
      // provider kind exists to rule out.
      const sources = [...new Set(verificationRule.selectors.map((selector) => selector.source))].sort();
      const kinds = [...evidenceKinds].sort();
      if (sources.join() !== kinds.join()) {
        throw refuse(
          'INVALID_INPUT',
          `${prefix}criteria[${index}].evidence_kinds names ${kinds.join(', ')}, but its verification_rule reads ${sources.join(', ')}. List exactly the sources the rule's selectors use.`,
          { fields: [`${prefix}criteria[${index}].evidence_kinds`, `${prefix}criteria[${index}].verification_rule`] },
        );
      }
    }
    return {
      id: criterion.id ?? `c${++highest}`,
      text: criterion.text,
      required: criterion.required ?? true,
      evidenceKinds,
      verificationRule,
    };
  });
}

/**
 * Revision 1, from a create command whose criteria were already built. The
 * title and goal arrive resolved: typed, or taken from a tracker record.
 */
export function contentFromCreate(input: { contract: WorkContract }, criteria: CriterionContent[]): RevisionContent {
  const contract = input.contract;
  return {
    title: contract.title,
    goal: contract.goal ?? '',
    nonGoals: contract.non_goals ?? '',
    scope: normalizeScope(contract.scope),
    riskTier: contract.risk_tier ?? 'medium',
    artifactKind: contract.artifact_kind ?? null,
    contextRefs: contract.context_refs ?? [],
    acceptancePolicy: { require_independent_acceptor: contract.acceptance_policy?.require_independent_acceptor ?? false },
    criteria,
  };
}

/** The next revision's content: the current one with only the named fields replaced. */
export function applyContractPatch(
  current: RevisionContent,
  patch: WorkContractPatch | undefined,
  criteria: CriterionContent[] | undefined,
): RevisionContent {
  return {
    title: patch?.title ?? current.title,
    goal: patch?.goal ?? current.goal,
    nonGoals: patch?.non_goals ?? current.nonGoals,
    scope: patch?.scope !== undefined ? normalizeScope(patch.scope) : current.scope,
    riskTier: patch?.risk_tier ?? current.riskTier,
    artifactKind: patch?.artifact_kind !== undefined ? patch.artifact_kind : current.artifactKind,
    contextRefs: patch?.context_refs ?? current.contextRefs,
    acceptancePolicy: patch?.acceptance_policy
      ? { require_independent_acceptor: patch.acceptance_policy.require_independent_acceptor ?? false }
      : current.acceptancePolicy,
    criteria: criteria ?? current.criteria,
  };
}

/** The wire names of the contract fields that differ between two revisions. */
export function changedContractFields(before: RevisionContent, after: RevisionContent): string[] {
  const a = canonicalContent(before);
  const b = canonicalContent(after);
  const changed: string[] = [];
  for (const key of Object.keys(a) as (keyof typeof a)[]) {
    if (canonicalJson(a[key]) === canonicalJson(b[key])) continue;
    changed.push(key === 'criteria' ? 'criteria' : `contract.${key}`);
  }
  return changed;
}

/** Which criteria a revision added, changed in meaning-bearing fields, or removed. */
export function criteriaDiff(before: readonly CriterionContent[], after: readonly CriterionContent[]) {
  const previous = new Map(before.map((criterion) => [criterion.id, criterion]));
  const next = new Set(after.map((criterion) => criterion.id));
  const added: string[] = [];
  const changed: string[] = [];
  for (const criterion of after) {
    const old = previous.get(criterion.id);
    if (!old) added.push(criterion.id);
    else if (canonicalJson(canonicalCriterion(old)) !== canonicalJson(canonicalCriterion(criterion))) {
      changed.push(criterion.id);
    }
  }
  const removed = before.filter((criterion) => !next.has(criterion.id)).map((criterion) => criterion.id);
  return { added, changed, removed };
}


/** One stored revision with its criteria in position order, or null. */
export async function loadRevision(db: Db, workId: string, revision: number): Promise<RevisionContent | null> {
  const [row] = await db
    .select()
    .from(workRevisions)
    .where(and(eq(workRevisions.workId, workId), eq(workRevisions.revision, revision)))
    .limit(1);
  if (!row) return null;
  const criteria = await db
    .select()
    .from(workCriteria)
    .where(and(eq(workCriteria.workId, workId), eq(workCriteria.revision, revision)))
    .orderBy(asc(workCriteria.position));
  return {
    title: row.title,
    goal: row.goal,
    nonGoals: row.nonGoals,
    scope: row.scope as WorkScope,
    riskTier: row.riskTier as WorkRiskTier,
    artifactKind: row.artifactKind as WorkArtifactKind | null,
    contextRefs: row.contextRefs as WorkContextRef[],
    acceptancePolicy: row.acceptancePolicy as WorkAcceptancePolicy,
    criteria: criteria.map((criterion) => ({
      id: criterion.criterionId,
      text: criterion.text,
      required: criterion.required,
      evidenceKinds: criterion.evidenceKinds as WorkEvidenceKind[],
      verificationRule: criterion.verificationRule as WorkVerificationRule,
    })),
  };
}

/** Every criterion id this work has used in any revision: the floor for generated ids. */
export async function usedCriterionIds(db: Db, workId: string): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ id: workCriteria.criterionId })
    .from(workCriteria)
    .where(eq(workCriteria.workId, workId));
  return new Set(rows.map((row) => row.id));
}

/** Write one immutable revision and its criteria. Never called for an existing (work, revision). */
export async function writeRevision(
  tx: Db,
  input: {
    workId: string;
    revision: number;
    content: RevisionContent;
    actor: WorkActor;
    changeReason?: string | null;
    source?: 'native' | 'external';
    now: Date;
  },
): Promise<string> {
  const contentHash = revisionContentHash(input.content);
  const id = actorId(input.actor);
  if (!id) throw new Error('A revision needs a principal; a system actor writes none in this release.');
  await tx.insert(workRevisions).values({
    workId: input.workId,
    revision: input.revision,
    title: input.content.title,
    goal: input.content.goal,
    nonGoals: input.content.nonGoals,
    scope: input.content.scope,
    riskTier: input.content.riskTier,
    artifactKind: input.content.artifactKind,
    contextRefs: input.content.contextRefs,
    acceptancePolicy: input.content.acceptancePolicy,
    contentHash,
    source: input.source ?? 'native',
    createdByKind: actorKind(input.actor),
    createdById: id,
    createdByUserId: actorUserId(input.actor),
    changeReason: input.changeReason || null,
    createdAt: input.now,
  });
  if (input.content.criteria.length) {
    await tx.insert(workCriteria).values(
      input.content.criteria.map((criterion, position) => ({
        workId: input.workId,
        revision: input.revision,
        criterionId: criterion.id,
        text: criterion.text,
        required: criterion.required,
        evidenceKinds: criterion.evidenceKinds,
        verificationRule: criterion.verificationRule,
        position,
      })),
    );
  }
  return contentHash;
}
