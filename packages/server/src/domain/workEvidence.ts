import { randomUUID } from 'node:crypto';
import {
  artifactVersionState,
  canonicalJson,
  fingerprintJson,
  workRecordEvidenceSchema,
  workSubmitSchema,
  type WorkArtifact,
  type WorkCriterionResult,
  type WorkEvidenceInput,
  type WorkEvidenceSelector,
  type WorkRecordEvidenceInput,
  type WorkState,
  type WorkSubmitInput,
  type WorkVerificationRule,
} from '@bridge/shared';
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';
import type { Db } from '../db';
import {
  agentInstallations,
  agentRuns,
  projects,
  providerObservations,
  repositoryBindings,
  runCheckpoints,
  workAcceptances,
  workCriteria,
  workDeliveries,
  workEvents,
  workEvidence,
  workItems,
  workLinks,
} from '../db/schema';
import { parseAdoLocator } from '../lib/azureDevops';
import { isHosted } from '../lib/entitlements';
import { isCanonicalUuid } from '../lib/ids';
import { canonicalRepositoryIdentity } from '../lib/projects';
import { redactSecrets } from '../lib/redact';
import { adapterListeningFor } from './companions';
import { mutateWorkInTransaction, runWorkCommand } from './work';
import { agentLinkedToWork, workAccess } from './workAccess';
import { dependencySnapshot } from './workGraph';
import { WORK_UNTRUSTED } from './workRead';
import type { CriterionContent } from './workRevisions';
import {
  parseOrRefuse,
  principalId,
  refusalOf,
  refuse,
  wireBigint,
  type WorkCommandOutcome,
  type WorkItemRow,
  type WorkOpContext,
  type WorkOpResult,
  type WorkPrincipal,
  type WorkResult,
} from './workTypes';

/**
 * Deliveries, evidence, readiness and the evidence manifest.
 *
 * A delivery is an immutable artifact set submitted against one contract
 * revision; evidence is one observation about one criterion of one delivery,
 * with a provenance the server decides and never the caller. Readiness is
 * computed on read, deterministically, from the stored rows: an unknown, a
 * stale or an unavailable answer is never turned into a pass, and a current
 * fail is never hidden by another source's pass. The manifest freezes that
 * reading so a person's decision can be bound to exactly what they looked at.
 *
 * The evidence epoch moves whenever evidence about the current delivery
 * changes, a provider fact included. An acceptance stores the epoch it was made
 * at; the dependency rule in `workGraph.ts` and `evidenceState` below both
 * read an acceptance whose epoch is no longer the work's as stale. Three inputs
 * move the manifest with no epoch (a binding disconnected, moved or unverified,
 * the project's repository identity, a deleted checkpoint), and the dependency
 * rule reads those off the stored manifest (`acceptanceInputsMovedSql`), so the
 * two do not disagree about whether an accepted upstream still stands.
 */

/** Hosted engineering guardrails, not plan entitlements: self-hosted instances never apply them. */
export const WORK_HOSTED_MAX_DELIVERIES = 200;
export const WORK_HOSTED_MAX_EVIDENCE_PER_DELIVERY = 500;

const NOT_VISIBLE = 'No work with that id is visible to this principal.';

/** An agent may date its observation slightly ahead of the server's clock, not into the future. */
const FUTURE_SKEW_MS = 60_000;
/** How many evidence rows per criterion the manifest lists; the rest are counted. */
const MANIFEST_ROWS_PER_CRITERION = 20;
/** How many provider facts the manifest lists. */
const MANIFEST_PROVIDER_FACTS = 50;
/**
 * Provider facts read for one batch of works, then for one work: far above
 * what one delivery's commits collect. Read newest first, so a cut drops the
 * oldest facts and never the attempt that decides; a work whose own facts are
 * cut reads its provider criteria as unknown and says why.
 */
const OBSERVATION_SCAN = 2_000;

type DeliveryRow = typeof workDeliveries.$inferSelect;
type EvidenceRow = typeof workEvidence.$inferSelect;
type AcceptanceRow = typeof workAcceptances.$inferSelect;
type CodeArtifact = Extract<WorkArtifact, { kind: 'code' }>;

// ---------------------------------------------------------------------------
// Artifacts: normalized once at submit, then matched by the locators a report
// can name them by.
// ---------------------------------------------------------------------------

/** Stored form: canonical repository identity, lowercase digests, no absent keys. */
function normalizeArtifact(artifact: WorkArtifact): WorkArtifact {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(artifact)) if (value !== undefined) out[key] = value;
  if (artifact.kind === 'code') {
    out.repository_identity = canonicalRepositoryIdentity(artifact.repository_identity);
    out.commit_sha = artifact.commit_sha.toLowerCase();
    if (artifact.checkpoint_id) out.checkpoint_id = artifact.checkpoint_id.toLowerCase();
  }
  if ((artifact.kind === 'file' || artifact.kind === 'document') && artifact.sha256) {
    out.sha256 = artifact.sha256.toLowerCase();
  }
  return out as WorkArtifact;
}

/** What makes two artifacts the same artifact, whatever their notes say. */
function artifactIdentity(artifact: WorkArtifact): unknown {
  switch (artifact.kind) {
    case 'code':
      return ['code', artifact.repository_identity, artifact.commit_sha];
    case 'document':
      return ['document', artifact.uri, artifact.document_id ?? null, artifact.version_id ?? null, artifact.sha256 ?? null];
    case 'file':
      return ['file', artifact.name, artifact.sha256];
  }
}

/**
 * Does `ref` name this artifact. A code artifact answers to its full commit SHA
 * or `repository@sha`; a document to its uri or document id; a file to its name
 * or digest. Exact matches only: a short SHA or a prefix names nothing.
 */
function artifactMatches(artifact: WorkArtifact, ref: string): boolean {
  switch (artifact.kind) {
    case 'code': {
      if (ref.toLowerCase() === artifact.commit_sha) return true;
      const at = ref.lastIndexOf('@');
      if (at <= 0) return false;
      return (
        ref.slice(at + 1).toLowerCase() === artifact.commit_sha &&
        canonicalRepositoryIdentity(ref.slice(0, at)) === artifact.repository_identity
      );
    }
    case 'document':
      return ref === artifact.uri || (artifact.document_id !== undefined && ref === artifact.document_id);
    case 'file':
      return ref === artifact.name || ref.toLowerCase() === artifact.sha256;
  }
}

const INDEX_REF = /^artifacts\[([0-9]{1,2})\]$/;

/**
 * The one artifact of a delivery a reference names, `'ambiguous'` when it names
 * more than one (the caller then uses `artifacts[N]`), or null. Delivery
 * artifacts are immutable, so the same reference resolves the same way on
 * every later read.
 */
export function resolveArtifact(
  artifacts: readonly WorkArtifact[],
  rawRef: string,
): { index: number; artifact: WorkArtifact } | 'ambiguous' | null {
  const ref = rawRef.trim();
  const indexed = INDEX_REF.exec(ref);
  if (indexed) {
    const index = Number(indexed[1]);
    const artifact = artifacts[index];
    return artifact ? { index, artifact } : null;
  }
  const found = artifacts.flatMap((artifact, index) => (artifactMatches(artifact, ref) ? [{ index, artifact }] : []));
  if (found.length > 1) return 'ambiguous';
  return found[0] ?? null;
}

/** The exact version a person or agent looked at, as one short label for the evidence row. */
export function artifactVersionLabel(artifact: WorkArtifact): string | null {
  switch (artifact.kind) {
    case 'code':
      return artifact.commit_sha;
    case 'document':
      return artifact.version_id ?? (artifact.sha256 ? `sha256:${artifact.sha256}` : null);
    case 'file':
      return `sha256:${artifact.sha256}`;
  }
}

const codeArtifacts = (artifacts: readonly WorkArtifact[]) =>
  artifacts.filter((artifact): artifact is CodeArtifact => artifact.kind === 'code');

/** One key per delivered code artifact: its repository and its commit, both as stored. */
const deliveredKey = (repositoryIdentity: string, commitSha: string) => `${repositoryIdentity}\u0000${commitSha}`;

/**
 * The repository identities a verified binding stands for, in the canonical
 * form a code artifact is stored in: `github.com/<owner>/<name>` for GitHub,
 * and for Azure DevOps the clone addresses Azure DevOps itself hands out for
 * the binding's organization, project and repository (HTTPS and SSH, on
 * dev.azure.com and on the older visualstudio.com host).
 *
 * A provider fact counts for a delivered commit only through a binding of the
 * repository that commit was delivered in (design section 9). A project may
 * bind several repositories of one provider, a fork among them, and a fork
 * shares the commit history: its workflow passing on the same commit is not a
 * check of the delivery. A remote spelled in some other way matches no binding,
 * which reads as a check STMA cannot observe (`repository_not_bound`), never
 * as a pass.
 */
function bindingRepositoryIdentities(provider: string, fullName: string): string[] {
  if (provider === 'github') return [canonicalRepositoryIdentity(`https://github.com/${fullName}`)];
  if (provider !== 'azure-devops') return [];
  const locator = parseAdoLocator(fullName);
  if (!locator) return [];
  const { organization: org, project, repo } = locator;
  return [
    ...new Set(
      [
        `https://dev.azure.com/${org}/${project}/_git/${repo}`,
        `git@ssh.dev.azure.com:v3/${org}/${project}/${repo}`,
        `https://${org}.visualstudio.com/${project}/_git/${repo}`,
        `https://${org}.visualstudio.com/DefaultCollection/${project}/_git/${repo}`,
        `${org}@vs-ssh.visualstudio.com:v3/${org}/${project}/${repo}`,
      ].map(canonicalRepositoryIdentity),
    ),
  ];
}

/**
 * Does a reported version name this artifact's own: the commit of a code
 * artifact, the provider version or the digest (with or without `sha256:`) of
 * a document, the digest of a file. Exact; hex is compared without case.
 */
function versionMatches(artifact: WorkArtifact, claimed: string): boolean {
  const value = claimed.trim();
  const digest = value.toLowerCase().replace(/^sha256:/, '');
  switch (artifact.kind) {
    case 'code':
      return value.toLowerCase() === artifact.commit_sha;
    case 'document':
      return (artifact.version_id !== undefined && value === artifact.version_id) || (artifact.sha256 !== undefined && digest === artifact.sha256);
    case 'file':
      return digest === artifact.sha256;
  }
}

// ---------------------------------------------------------------------------
// Readiness: what each criterion of the current revision reads against the
// current delivery. Pure functions over rows loaded in a fixed number of
// queries, so a list page and a single read give the same answer.
// ---------------------------------------------------------------------------

/** A selector's own result. `unavailable` is never a criterion's: a criterion reads it as unknown. */
export type SelectorResult = WorkCriterionResult | 'unavailable';

/** Why a result is not a plain pass or fail. A closed set of words, never caller text. */
export type ReadinessReason =
  | 'no_delivery'
  | 'delivery_for_older_revision'
  | 'no_evidence'
  | 'older_than_max_age'
  | 'unversioned'
  | 'reported_inconclusive'
  | 'no_verified_binding'
  | 'repository_not_bound'
  | 'no_code_artifact'
  | 'not_observed'
  | 'conflicting_observations'
  | 'provider_state_unknown'
  | 'observations_truncated'
  | 'source_deleted';

/** STMA's own sentence for an `unavailable` selector, by why; never a provider's or a caller's. */
const UNAVAILABLE_DETAIL: Partial<Record<ReadinessReason, string>> = {
  no_verified_binding:
    'No verified repository of this provider is bound to the project, so STMA cannot observe this check. A missing observation is not a pass.',
  source_deleted:
    'The checkpoint this evidence names no longer exists (it went with the run that reported it), so it cannot stand for the delivery. A missing source is not a pass.',
};

export interface SelectorOutcome {
  source: WorkEvidenceSelector['source'];
  provider?: string;
  subject?: string;
  artifact_kind?: string;
  result: SelectorResult;
  reason: ReadinessReason | null;
  /** Only for `unavailable`: STMA's own sentence, never a provider's or a caller's. */
  detail?: string;
  /** The evidence rows the result was read from. */
  evidence_ids: string[];
  /** The provider facts the result was read from. */
  observation_ids: string[];
}

export interface CriterionOutcome {
  id: string;
  required: boolean;
  result: WorkCriterionResult;
  reasons: ReadinessReason[];
  mode: 'all' | 'any';
  max_age_seconds: number | null;
  selectors: SelectorOutcome[];
}

export type ResultCounts = Record<WorkCriterionResult, number>;

/** One work's readiness. `ready_for_review` never means accepted, merge-ready or deploy-ready. */
export interface Readiness {
  work_id: string;
  spec_revision: number;
  delivery_id: string | null;
  delivery_spec_revision: number | null;
  evidence_epoch: string;
  ready_for_review: boolean;
  /** Required criteria by result. */
  counts: ResultCounts;
  criteria: CriterionOutcome[];
}

interface ObservationFact {
  id: string;
  bindingId: string;
  provider: string;
  /** The repositories its binding stands for (`bindingRepositoryIdentities`). */
  repositoryIdentities: string[];
  subjectId: string;
  subjectName: string | null;
  /** The provider's id of the workflow or pipeline the run belongs to; null where it did not say. */
  subjectDefinition: string | null;
  commitSha: string;
  state: string;
  attempt: number;
  observedAt: Date;
}

/** Everything readiness and the manifest read for one work, loaded in batches. */
interface EvidenceInputs {
  work: WorkItemRow;
  criteria: CriterionContent[];
  delivery: DeliveryRow | null;
  artifacts: WorkArtifact[];
  /** Every evidence row of the current delivery. */
  rows: EvidenceRow[];
  /** Criterion id to the number of rows recorded against earlier deliveries. */
  older: Map<string, number>;
  repositoryIdentity: string | null;
  /** Verified bindings of the work's project, with the repositories each stands for. */
  bindings: { provider: string; fullName: string; repositoryIdentities: string[] }[];
  /**
   * Workflow facts on the current delivery's code artifacts, observed for this
   * project through a binding of the very repository each commit was delivered in.
   */
  observations: ObservationFact[];
  /** More facts matched this work's commits than one read holds: what is here is not all there is. */
  observationsTruncated: boolean;
  /**
   * Checkpoint-sourced rows of the current delivery whose checkpoint is gone
   * (a run cascades with its installation, and that with an erased account).
   * Such a row is read as unavailable: its source can no longer be shown.
   */
  missingSources: Set<string>;
}

/**
 * Workflow facts on these commits, observed for these projects through a
 * binding that still points there and is still verified, newest first. One
 * row more than the scan, so a cut is known rather than silent.
 */
function readFacts(db: Db, commits: readonly string[], projectIds: readonly string[]) {
  return db
    .select({
      id: providerObservations.id,
      bindingId: providerObservations.bindingId,
      projectId: providerObservations.projectId,
      provider: repositoryBindings.provider,
      fullName: repositoryBindings.fullName,
      bindingTeamId: repositoryBindings.teamId,
      bindingProjectId: repositoryBindings.projectId,
      subjectId: providerObservations.subjectId,
      subjectName: providerObservations.subjectName,
      subjectDefinition: providerObservations.subjectDefinition,
      commitSha: providerObservations.commitSha,
      state: providerObservations.state,
      attempt: providerObservations.attempt,
      observedAt: providerObservations.observedAt,
    })
    .from(providerObservations)
    .innerJoin(repositoryBindings, eq(repositoryBindings.id, providerObservations.bindingId))
    .where(
      and(
        eq(providerObservations.kind, 'workflow'),
        inArray(providerObservations.commitSha, [...commits]),
        inArray(providerObservations.projectId, [...projectIds]),
        inArray(repositoryBindings.projectId, [...projectIds]),
        isNotNull(repositoryBindings.verifiedAt),
      ),
    )
    .orderBy(desc(providerObservations.observedAt), desc(providerObservations.attempt), asc(providerObservations.id))
    .limit(OBSERVATION_SCAN + 1);
}

async function loadInputs(db: Db, works: readonly WorkItemRow[]): Promise<Map<string, EvidenceInputs>> {
  const out = new Map<string, EvidenceInputs>();
  if (!works.length) return out;
  const ids = works.map((work) => work.id);
  const projectIds = [...new Set(works.map((work) => work.projectId))];

  const criteriaRows = await db
    .select()
    .from(workCriteria)
    .where(or(...works.map((work) => and(eq(workCriteria.workId, work.id), eq(workCriteria.revision, work.specRevision)))))
    .orderBy(asc(workCriteria.workId), asc(workCriteria.position));

  const deliveryIds = works.flatMap((work) => (work.currentDeliveryId ? [work.currentDeliveryId] : []));
  const deliveries = deliveryIds.length
    ? await db.select().from(workDeliveries).where(inArray(workDeliveries.id, deliveryIds))
    : [];
  const rows = deliveryIds.length
    ? await db.select().from(workEvidence).where(inArray(workEvidence.deliveryId, deliveryIds))
    : [];
  const older = await db
    .select({ workId: workEvidence.workId, criterionId: workEvidence.criterionId, n: count() })
    .from(workEvidence)
    .where(
      and(
        inArray(workEvidence.workId, ids),
        deliveryIds.length ? notInArray(workEvidence.deliveryId, deliveryIds) : undefined,
      ),
    )
    .groupBy(workEvidence.workId, workEvidence.criterionId);

  // Which checkpoints the current deliveries' evidence names still exist. One
  // read, by id; a stored ref that is not a uuid never named a checkpoint.
  const namedCheckpoints = [
    ...new Set(
      rows
        .filter((row) => row.sourceKind === 'checkpoint' && isCanonicalUuid(row.sourceRef))
        .map((row) => row.sourceRef.toLowerCase()),
    ),
  ];
  const existing = namedCheckpoints.length
    ? new Set(
        (await db.select({ id: runCheckpoints.id }).from(runCheckpoints).where(inArray(runCheckpoints.id, namedCheckpoints))).map(
          (row) => row.id,
        ),
      )
    : new Set<string>();
  const missingSources = new Set(
    rows
      .filter((row) => row.sourceKind === 'checkpoint' && !existing.has(row.sourceRef.toLowerCase()))
      .map((row) => row.id),
  );

  const projectRows = await db
    .select({ id: projects.id, repositoryIdentity: projects.repositoryIdentity })
    .from(projects)
    .where(inArray(projects.id, projectIds));
  const bindings = await db
    .select({
      teamId: repositoryBindings.teamId,
      projectId: repositoryBindings.projectId,
      provider: repositoryBindings.provider,
      fullName: repositoryBindings.fullName,
    })
    .from(repositoryBindings)
    .where(and(inArray(repositoryBindings.projectId, projectIds), isNotNull(repositoryBindings.verifiedAt)))
    .orderBy(asc(repositoryBindings.provider), asc(repositoryBindings.fullName));

  const deliveriesById = new Map(deliveries.map((delivery) => [delivery.id, delivery]));
  const commits = [
    ...new Set(deliveries.flatMap((delivery) => codeArtifacts(delivery.artifacts as WorkArtifact[]).map((a) => a.commit_sha))),
  ];
  // The fact must be about this project twice over: observed while its binding
  // pointed here (the row's own scope), and through a binding that still
  // points here and is still verified. Moving a binding never relabels history.
  let facts = commits.length ? await readFacts(db, commits, projectIds) : [];
  const truncated = new Set<string>();
  if (facts.length > OBSERVATION_SCAN) {
    // One batch matched more than one read holds: read each work's own commits,
    // so a busy commit of one work never pushes another work's facts out.
    const byId = new Map<string, (typeof facts)[number]>();
    for (const work of works) {
      const delivery = work.currentDeliveryId ? deliveriesById.get(work.currentDeliveryId) : undefined;
      const own = [...new Set(codeArtifacts((delivery?.artifacts as WorkArtifact[] | undefined) ?? []).map((a) => a.commit_sha))];
      if (!own.length) continue;
      const rows = await readFacts(db, own, [work.projectId]);
      if (rows.length > OBSERVATION_SCAN) truncated.add(work.id);
      for (const row of rows.slice(0, OBSERVATION_SCAN)) byId.set(row.id, row);
    }
    facts = [...byId.values()];
  }

  // Read once per binding: every fact of one binding stands for the same repositories.
  const identitiesOf = new Map<string, string[]>();
  const repositoriesOf = (provider: string, fullName: string) => {
    const key = `${provider}\u0000${fullName}`;
    let found = identitiesOf.get(key);
    if (!found) identitiesOf.set(key, (found = bindingRepositoryIdentities(provider, fullName)));
    return found;
  };

  for (const work of works) {
    const delivery = work.currentDeliveryId ? (deliveriesById.get(work.currentDeliveryId) ?? null) : null;
    const artifacts = (delivery?.artifacts as WorkArtifact[] | undefined) ?? [];
    // A fact is about the delivery only through the repository its commit was
    // delivered in, never through another binding that happens to hold the
    // same commit (a fork, a mirror).
    const delivered = new Set(codeArtifacts(artifacts).map((artifact) => deliveredKey(artifact.repository_identity, artifact.commit_sha)));
    out.set(work.id, {
      work,
      criteria: criteriaRows
        .filter((row) => row.workId === work.id)
        .map((row) => ({
          id: row.criterionId,
          text: row.text,
          required: row.required,
          evidenceKinds: row.evidenceKinds as CriterionContent['evidenceKinds'],
          verificationRule: row.verificationRule as WorkVerificationRule,
        })),
      delivery,
      artifacts,
      rows: delivery ? rows.filter((row) => row.deliveryId === delivery.id) : [],
      older: new Map(older.filter((row) => row.workId === work.id).map((row) => [row.criterionId, Number(row.n)])),
      repositoryIdentity: projectRows.find((row) => row.id === work.projectId)?.repositoryIdentity ?? null,
      bindings: bindings
        .filter((row) => row.projectId === work.projectId && row.teamId === work.teamId)
        .map((row) => ({
          provider: row.provider,
          fullName: row.fullName,
          repositoryIdentities: repositoriesOf(row.provider, row.fullName),
        })),
      observations: facts
        .filter(
          (fact) =>
            fact.projectId === work.projectId &&
            fact.bindingProjectId === work.projectId &&
            fact.bindingTeamId === work.teamId &&
            repositoriesOf(fact.provider, fact.fullName).some((identity) => delivered.has(deliveredKey(identity, fact.commitSha))),
        )
        .map((fact) => ({
          id: fact.id,
          bindingId: fact.bindingId,
          provider: fact.provider,
          repositoryIdentities: repositoriesOf(fact.provider, fact.fullName),
          subjectId: fact.subjectId,
          subjectName: fact.subjectName,
          subjectDefinition: fact.subjectDefinition,
          commitSha: fact.commitSha,
          state: fact.state,
          attempt: fact.attempt,
          observedAt: fact.observedAt,
        })),
      observationsTruncated: truncated.has(work.id),
      missingSources,
    });
  }
  return out;
}

/** Rows a later row of the same delivery supersedes. */
const supersededIds = (rows: readonly EvidenceRow[]) =>
  new Set(rows.flatMap((row) => (row.supersedesId ? [row.supersedesId] : [])));

/** Newest first, by the server's clock: an agent cannot reorder its own reports by dating them. */
const newestFirst = (a: EvidenceRow, b: EvidenceRow) =>
  b.recordedAt.getTime() - a.recordedAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** When the observation was made: the reporter's time when it is earlier than the server's. */
const evidenceTime = (row: EvidenceRow) =>
  row.observedAt && row.observedAt < row.recordedAt ? row.observedAt : row.recordedAt;

interface SelectorScope {
  inputs: EvidenceInputs;
  /** This criterion's rows, neither superseded nor withdrawn, newest first. */
  effective: EvidenceRow[];
  maxAgeSeconds: number | null;
  asOf: Date;
}

const tooOld = (at: Date, scope: { maxAgeSeconds: number | null; asOf: Date }) =>
  scope.maxAgeSeconds !== null && scope.asOf.getTime() - at.getTime() > scope.maxAgeSeconds * 1000;

export type EvidenceValidity = 'current' | 'stale' | 'unavailable' | 'superseded' | 'withdrawn';

/** Validity belongs beside the report's assertion, never in place of it. */
function rowValidity(
  row: EvidenceRow,
  context: {
    currentRevision: number;
    deliveryRevision: number | null;
    missingSources: ReadonlySet<string>;
    superseded: ReadonlySet<string>;
    maxAgeSeconds: number | null;
    asOf: Date;
  },
): EvidenceValidity {
  if (row.withdrawnAt) return 'withdrawn';
  if (context.superseded.has(row.id)) return 'superseded';
  if (context.missingSources.has(row.id)) return 'unavailable';
  if (context.deliveryRevision !== context.currentRevision || row.specRevision !== context.currentRevision || tooOld(evidenceTime(row), context)) {
    return 'stale';
  }
  return 'current';
}

/** Page validity uses replacements from the entire delivery, including other pages. */
export async function evidenceValidity(db: Db, work: WorkItemRow, rows: readonly EvidenceRow[], asOf = new Date()) {
  if (!rows.length) return new Map<string, EvidenceValidity>();
  const [delivery] = work.currentDeliveryId
    ? await db.select({ revision: workDeliveries.specRevision }).from(workDeliveries).where(eq(workDeliveries.id, work.currentDeliveryId))
    : [];
  const replacements = await db
    .select({ id: workEvidence.supersedesId })
    .from(workEvidence)
    .where(and(eq(workEvidence.workId, work.id), inArray(workEvidence.supersedesId, rows.map((row) => row.id)),
      work.currentDeliveryId ? eq(workEvidence.deliveryId, work.currentDeliveryId) : undefined));
  const superseded = new Set(replacements.flatMap((row) => row.id ? [row.id] : []));
  const named = rows.filter((row) => row.sourceKind === 'checkpoint' && isCanonicalUuid(row.sourceRef)).map((row) => row.sourceRef.toLowerCase());
  const existing = new Set(named.length
    ? (await db.select({ id: runCheckpoints.id }).from(runCheckpoints).where(inArray(runCheckpoints.id, named))).map((row) => row.id)
    : []);
  const missingSources = new Set(rows.filter((row) => row.sourceKind === 'checkpoint' && !existing.has(row.sourceRef.toLowerCase())).map((row) => row.id));
  const criteria = await db.select({ id: workCriteria.criterionId, rule: workCriteria.verificationRule }).from(workCriteria)
    .where(and(eq(workCriteria.workId, work.id), eq(workCriteria.revision, work.specRevision)));
  const ages = new Map(criteria.map((criterion) => [criterion.id, (criterion.rule as WorkVerificationRule).max_age_seconds ?? null]));
  return new Map(rows.map((row) => [row.id, rowValidity(row, {
    currentRevision: work.specRevision,
    deliveryRevision: delivery?.revision ?? null,
    missingSources,
    superseded,
    maxAgeSeconds: ages.get(row.criterionId) ?? null,
    asOf,
  })]));
}

function selectorLabel(selector: WorkEvidenceSelector) {
  const label: Pick<SelectorOutcome, 'source' | 'provider' | 'subject' | 'artifact_kind'> = { source: selector.source };
  if (selector.source === 'provider_observation') {
    label.provider = selector.provider;
    label.subject = selector.subject;
  }
  if (selector.source === 'artifact' && selector.artifact_kind) label.artifact_kind = selector.artifact_kind;
  return label;
}

function outcome(
  selector: WorkEvidenceSelector,
  result: SelectorResult,
  reason: ReadinessReason | null,
  evidence: string[] = [],
  observations: string[] = [],
): SelectorOutcome {
  const out: SelectorOutcome = {
    ...selectorLabel(selector),
    result,
    reason,
    evidence_ids: evidence,
    observation_ids: observations,
  };
  if (result === 'unavailable' && reason && UNAVAILABLE_DETAIL[reason]) out.detail = UNAVAILABLE_DETAIL[reason];
  return out;
}

/** A reported row as a result: its assertion, unless it is older than the criterion allows. */
function fromRow(selector: WorkEvidenceSelector, row: EvidenceRow | undefined, scope: SelectorScope): SelectorOutcome {
  if (!row) return outcome(selector, 'unknown', 'no_evidence');
  if (scope.inputs.missingSources.has(row.id)) return outcome(selector, 'unavailable', 'source_deleted', [row.id]);
  if (tooOld(evidenceTime(row), scope)) return outcome(selector, 'stale', 'older_than_max_age', [row.id]);
  const assertion = row.assertion as 'pass' | 'fail' | 'inconclusive';
  return outcome(selector, assertion, assertion === 'inconclusive' ? 'reported_inconclusive' : null, [row.id]);
}

/**
 * Does a provider fact answer to this selector: the stable workflow name, or
 * the exact subject id. Readiness, the manifest and the epoch a new fact moves
 * all ask this one question, so a fact that moves the epoch is always one a
 * criterion reads.
 */
const factMatches = (
  fact: Pick<ObservationFact, 'provider' | 'subjectId' | 'subjectName'>,
  selector: Extract<WorkEvidenceSelector, { source: 'provider_observation' }>,
) => fact.provider === selector.provider && (fact.subjectName === selector.subject || fact.subjectId === selector.subject);

const RESULT_SEVERITY: readonly WorkCriterionResult[] = ['unknown', 'stale', 'inconclusive'];

function evaluateProvider(
  selector: Extract<WorkEvidenceSelector, { source: 'provider_observation' }>,
  scope: SelectorScope,
): SelectorOutcome {
  const providerBindings = scope.inputs.bindings.filter((binding) => binding.provider === selector.provider);
  if (!providerBindings.length) return outcome(selector, 'unavailable', 'no_verified_binding');
  // Each delivered artifact is its repository and its commit together.
  const delivered = [
    ...new Map(
      codeArtifacts(scope.inputs.artifacts).map((artifact) => [
        deliveredKey(artifact.repository_identity, artifact.commit_sha),
        { repository: artifact.repository_identity, commit: artifact.commit_sha },
      ]),
    ).values(),
  ];
  if (!delivered.length) return outcome(selector, 'unknown', 'no_code_artifact');
  // Not all the facts were read, so the one that decides may be among those
  // that were not: unknown, never a pass read off part of the record.
  if (scope.inputs.observationsTruncated) return outcome(selector, 'unknown', 'observations_truncated');
  const used: string[] = [];
  const perCommit: { result: WorkCriterionResult; reason: ReadinessReason | null }[] = [];
  for (const { repository, commit } of delivered) {
    // A binding of this provider exists, but none of the repository the
    // commit was delivered in: no fact through another binding stands for it.
    if (!providerBindings.some((binding) => binding.repositoryIdentities.includes(repository))) {
      perCommit.push({ result: 'unknown', reason: 'repository_not_bound' });
      continue;
    }
    const facts = scope.inputs.observations.filter(
      (fact) => fact.commitSha === commit && fact.repositoryIdentities.includes(repository) && factMatches(fact, selector),
    );
    if (!facts.length) {
      perCommit.push({ result: 'unknown', reason: 'not_observed' });
      continue;
    }
    // One run of a workflow may report several attempts: the highest attempt,
    // then the latest observation, is that run's current fact.
    const bySubject = new Map<string, ObservationFact[]>();
    for (const fact of facts) {
      const key = `${fact.bindingId}\u0000${fact.subjectId}`;
      bySubject.set(key, [...(bySubject.get(key) ?? []), fact]);
    }
    const heads = [...bySubject.values()].map((group) => {
      group.sort((a, b) => b.attempt - a.attempt || b.observedAt.getTime() - a.observedAt.getTime());
      const top = group[0]!;
      return group.filter((fact) => fact.attempt === top.attempt && fact.observedAt.getTime() === top.observedAt.getTime());
    });
    // Across runs of one workflow the latest run is current. A name is not one
    // workflow: two workflow files may both be called `CI`, and a pipeline
    // name repeats across Azure DevOps folders, so runs are grouped by the
    // provider's own id of the workflow, and a current fail of one is never
    // covered by a later pass of another. Runs that carry no id (older rows, a
    // provider that did not say) are grouped by name, as all runs once were.
    // A tie that disagrees, inside one run or across runs of one workflow, is
    // not resolved by guessing.
    const byWorkflow = new Map<string, ObservationFact[][]>();
    for (const tied of heads) {
      const head = tied[0]!;
      const key = head.subjectDefinition === null ? '' : `${head.bindingId}\u0000${head.subjectDefinition}`;
      byWorkflow.set(key, [...(byWorkflow.get(key) ?? []), tied]);
    }
    for (const runs of byWorkflow.values()) {
      const latest = Math.max(...runs.map((tied) => tied[0]!.observedAt.getTime()));
      const current = runs.filter((tied) => tied[0]!.observedAt.getTime() === latest).flat();
      used.push(...current.map((fact) => fact.id));
      const states = new Set(current.map((fact) => fact.state));
      if (states.size > 1) {
        perCommit.push({ result: 'inconclusive', reason: 'conflicting_observations' });
        continue;
      }
      if (tooOld(current[0]!.observedAt, scope)) {
        perCommit.push({ result: 'stale', reason: 'older_than_max_age' });
        continue;
      }
      const state = current[0]!.state;
      perCommit.push(
        state === 'success'
          ? { result: 'pass', reason: null }
          : state === 'failure'
            ? { result: 'fail', reason: null }
            : { result: 'unknown', reason: 'provider_state_unknown' },
      );
    }
  }
  // Every delivered commit must pass, and on each every workflow the selector
  // matched: a pass on one repository does not stand for a commit nobody
  // observed in another, nor one workflow's pass for another's fail.
  const ids = [...new Set(used)].sort();
  if (perCommit.some((entry) => entry.result === 'fail')) return outcome(selector, 'fail', null, [], ids);
  if (perCommit.every((entry) => entry.result === 'pass')) return outcome(selector, 'pass', null, [], ids);
  for (const result of RESULT_SEVERITY) {
    const entry = perCommit.find((candidate) => candidate.result === result);
    if (entry) return outcome(selector, result, entry.reason, [], ids);
  }
  return outcome(selector, 'unknown', 'not_observed', [], ids);
}

/**
 * Every effective row a selector reads, newest first, as one result. A current
 * fail in any of them is the result: a later pass about something else, or
 * from another reporter, does not hide it, and a reporter that fixed what it
 * reported replaces its own row with `supersedes_id` (only its own may be
 * named). Otherwise the newest row decides, as it always did.
 */
function fromRows(
  selector: WorkEvidenceSelector,
  rows: readonly EvidenceRow[],
  scope: SelectorScope,
  judge: (row: EvidenceRow) => SelectorOutcome = (row) => fromRow(selector, row, scope),
): SelectorOutcome {
  const read = rows.map(judge);
  return read.find((entry) => entry.result === 'fail') ?? read[0] ?? outcome(selector, 'unknown', 'no_evidence');
}

function evaluateSelector(selector: WorkEvidenceSelector, scope: SelectorScope): SelectorOutcome {
  switch (selector.source) {
    case 'agent_report':
      return fromRows(
        selector,
        scope.effective.filter((row) => row.provenance === 'agent_reported'),
        scope,
      );
    case 'human_check': {
      const row = scope.effective.find((candidate) => candidate.provenance === 'human_decision');
      // A check that names no artifact version is a general "I looked", which
      // is not evidence of what was delivered (spec 10). The decision refuses
      // to write one; a row without a version is read as what it is.
      if (row && !row.sourceVersion) return outcome(selector, 'unknown', 'unversioned', [row.id]);
      return fromRow(selector, row, scope);
    }
    case 'artifact': {
      const about = scope.effective.flatMap((row) => {
        if (row.sourceKind !== 'artifact' || row.provenance !== 'agent_reported') return [];
        const found = resolveArtifact(scope.inputs.artifacts, row.sourceRef);
        if (!found || found === 'ambiguous') return [];
        if (selector.artifact_kind && found.artifact.kind !== selector.artifact_kind) return [];
        return [{ row, artifact: found.artifact }];
      });
      const artifactOf = new Map(about.map((entry) => [entry.row.id, entry.artifact]));
      return fromRows(
        selector,
        about.map((entry) => entry.row),
        scope,
        // A mutable link cannot establish a pass, but a current reported
        // failure still stands until its reporter supersedes it.
        (row) =>
          artifactVersionState(artifactOf.get(row.id)!) === 'unversioned' && row.assertion !== 'fail'
            ? outcome(selector, 'unknown', 'unversioned', [row.id])
            : fromRow(selector, row, scope),
      );
    }
    case 'provider_observation':
      return evaluateProvider(selector, scope);
  }
}

/**
 * `all`: pass only when every selector passes. `any`: pass when one passes.
 * In both, a current fail anywhere is the criterion's result: a fail is never
 * hidden by another source's pass. Otherwise the most severe of unknown
 * (unavailable included), stale and inconclusive, in that order.
 */
function combine(mode: 'all' | 'any', outcomes: readonly SelectorOutcome[]): WorkCriterionResult {
  const results = outcomes.map((entry) => (entry.result === 'unavailable' ? 'unknown' : entry.result));
  if (results.includes('fail')) return 'fail';
  if (mode === 'all' ? results.length > 0 && results.every((result) => result === 'pass') : results.includes('pass')) {
    return 'pass';
  }
  for (const result of RESULT_SEVERITY) if (results.includes(result)) return result;
  return 'unknown';
}

const emptyCounts = (): ResultCounts => ({ pass: 0, fail: 0, unknown: 0, stale: 0, inconclusive: 0 });

function evaluate(inputs: EvidenceInputs, asOf: Date): Readiness {
  const { work, delivery } = inputs;
  const superseded = supersededIds(inputs.rows);
  const forRevision = delivery !== null && delivery.specRevision === work.specRevision;
  const criteria = inputs.criteria.map((criterion): CriterionOutcome => {
    const rule = criterion.verificationRule;
    const base = {
      id: criterion.id,
      required: criterion.required,
      mode: rule.mode,
      max_age_seconds: rule.max_age_seconds ?? null,
    };
    if (!delivery) return { ...base, result: 'unknown', reasons: ['no_delivery'], selectors: [] };
    if (!forRevision) {
      // Evidence does not move to another revision of the contract by itself:
      // what was reported against the old one is listed as stale, never counted.
      const reported = inputs.rows.some((row) => row.criterionId === criterion.id);
      return { ...base, result: reported ? 'stale' : 'unknown', reasons: ['delivery_for_older_revision'], selectors: [] };
    }
    const scope: SelectorScope = {
      inputs,
      effective: inputs.rows
        .filter((row) => row.criterionId === criterion.id && !row.withdrawnAt && !superseded.has(row.id))
        .sort(newestFirst),
      maxAgeSeconds: rule.max_age_seconds ?? null,
      asOf,
    };
    const selectors = rule.selectors.map((selector) => evaluateSelector(selector, scope));
    const result = combine(rule.mode, selectors);
    const reasons =
      result === 'pass'
        ? []
        : [...new Set(selectors.flatMap((entry) => (entry.result !== 'pass' && entry.reason ? [entry.reason] : [])))];
    return { ...base, result, reasons, selectors };
  });
  const counts = emptyCounts();
  for (const criterion of criteria) if (criterion.required) counts[criterion.result] += 1;
  return {
    work_id: work.id,
    spec_revision: work.specRevision,
    delivery_id: delivery?.id ?? null,
    delivery_spec_revision: delivery?.specRevision ?? null,
    evidence_epoch: wireBigint(work.evidenceEpoch),
    ready_for_review: forRevision && criteria.every((criterion) => !criterion.required || criterion.result === 'pass'),
    counts,
    criteria,
  };
}

// ---------------------------------------------------------------------------
// The manifest: the readiness reading frozen, with the evidence it was read
// from, the provider facts, what is missing, the scope and the upstreams. It
// carries nothing time-of-read, so the same rows always hash the same.
// ---------------------------------------------------------------------------

export type EvidenceManifest = ReturnType<typeof manifestOf>;

function manifestOf(
  inputs: EvidenceInputs,
  readiness: Readiness,
  dependencies: Awaited<ReturnType<typeof dependencySnapshot>>,
  asOf: Date,
) {
  const { work, delivery } = inputs;
  const superseded = supersededIds(inputs.rows);
  const criteria = readiness.criteria.map((criterion) => {
    const mine = inputs.rows.filter((row) => row.criterionId === criterion.id);
    const listed = mine.filter((row) => !superseded.has(row.id)).sort(newestFirst);
    return {
      id: criterion.id,
      required: criterion.required,
      result: criterion.result,
      reasons: criterion.reasons,
      rule: { mode: criterion.mode, max_age_seconds: criterion.max_age_seconds },
      selectors: criterion.selectors,
      evidence: listed.slice(0, MANIFEST_ROWS_PER_CRITERION).map((row) => ({
        id: row.id,
        provenance: row.provenance,
        assertion: row.assertion,
        source_kind: row.sourceKind,
        source_ref: row.sourceRef,
        source_version: row.sourceVersion,
        observed_at: row.observedAt?.toISOString() ?? null,
        recorded_at: row.recordedAt.toISOString(),
        supersedes_id: row.supersedesId,
        validity: rowValidity(row, {
          currentRevision: work.specRevision,
          deliveryRevision: delivery?.specRevision ?? null,
          missingSources: inputs.missingSources,
          superseded,
          maxAgeSeconds: criterion.max_age_seconds,
          asOf,
        }),
      })),
      evidence_more: Math.max(0, listed.length - MANIFEST_ROWS_PER_CRITERION),
      superseded: mine.length - listed.length,
      older_deliveries: inputs.older.get(criterion.id) ?? 0,
    };
  });

  const providerSelectors = inputs.criteria.flatMap((criterion) =>
    criterion.verificationRule.selectors.flatMap((selector) =>
      selector.source === 'provider_observation' ? [selector] : [],
    ),
  );
  const subjects = inputs.observations
    .filter((fact) => providerSelectors.some((selector) => factMatches(fact, selector)))
    .sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) ||
        a.commitSha.localeCompare(b.commitSha) ||
        a.subjectId.localeCompare(b.subjectId) ||
        a.attempt - b.attempt ||
        a.observedAt.getTime() - b.observedAt.getTime() ||
        a.id.localeCompare(b.id),
    );
  const providers = [...new Set(providerSelectors.map((selector) => selector.provider))].sort();

  return {
    format: 'stma.work.evidence.v1' as const,
    work_id: work.id,
    key: work.displayKey,
    spec_revision: work.specRevision,
    delivery: delivery
      ? {
          id: delivery.id,
          sequence: delivery.sequence,
          spec_revision: delivery.specRevision,
          artifact_set_hash: delivery.artifactSetHash,
        }
      : null,
    evidence_epoch: wireBigint(work.evidenceEpoch),
    ready_for_review: readiness.ready_for_review,
    criteria,
    provider_subjects: {
      items: subjects.slice(0, MANIFEST_PROVIDER_FACTS).map((fact) => ({
        id: fact.id,
        provider: fact.provider,
        subject_id: fact.subjectId,
        subject_name: fact.subjectName,
        commit_sha: fact.commitSha,
        state: fact.state,
        attempt: fact.attempt,
        observed_at: fact.observedAt.toISOString(),
      })),
      more: Math.max(0, subjects.length - MANIFEST_PROVIDER_FACTS),
    },
    missing: readiness.criteria
      .filter((criterion) => criterion.required && criterion.result !== 'pass')
      .map((criterion) => ({ criterion_id: criterion.id, result: criterion.result, reasons: criterion.reasons })),
    scope: {
      project_id: work.projectId,
      repository_identity: inputs.repositoryIdentity,
      // Only the providers a criterion names: a workflow passing is never all
      // required checks, and which providers were looked at is said, not implied.
      providers: providers.map((provider) => ({
        provider,
        verified: inputs.bindings.some((binding) => binding.provider === provider),
        repositories: inputs.bindings.filter((binding) => binding.provider === provider).map((binding) => binding.fullName),
      })),
    },
    // `workGraph.ts` reads this key back with `jsonb_to_recordset` to tell an
    // accepted downstream that its upstreams changed; keep the name and shape.
    dependencies,
  };
}

const workRowFor = async (db: Db, work: WorkItemRow | string): Promise<WorkItemRow> => {
  if (typeof work !== 'string') return work;
  const [row] = await db.select().from(workItems).where(eq(workItems.id, work)).limit(1);
  if (!row) throw new Error(`Work ${work} does not exist.`);
  return row;
};

/** Readiness of one work now (or as of a given instant, for a stored decision). */
export async function evaluateReadiness(
  db: Db,
  work: WorkItemRow | string,
  options: { asOf?: Date } = {},
): Promise<Readiness> {
  const row = await workRowFor(db, work);
  const inputs = (await loadInputs(db, [row])).get(row.id)!;
  return evaluate(inputs, options.asOf ?? new Date());
}

/**
 * The manifest a decision is bound to, and its hash. Pass a row read under the
 * work lock when calling inside a Work command, so the epoch and the delivery
 * it names are the ones the command is about to compare.
 */
export async function buildEvidenceManifest(
  db: Db,
  work: WorkItemRow | string,
  options: { asOf?: Date } = {},
): Promise<{ manifest: EvidenceManifest; hash: string; readiness: Readiness }> {
  const row = await workRowFor(db, work);
  const inputs = (await loadInputs(db, [row])).get(row.id)!;
  const asOf = options.asOf ?? new Date();
  const readiness = evaluate(inputs, asOf);
  const manifest = manifestOf(inputs, readiness, await dependencySnapshot(db, row.id), asOf);
  return { manifest, hash: fingerprintJson(manifest), readiness };
}

/**
 * A manifest without what the provider facts it lists decide: the facts
 * themselves, every criterion's result and reasons, the provider selectors'
 * results and the totals read off them. What is left is everything else a
 * decision rests on (the delivery, the evidence rows and their validity, the
 * rules, the scope, the upstreams), which no provider fact can move.
 */
function withoutProviderReading(manifest: EvidenceManifest) {
  const { provider_subjects: _subjects, ready_for_review: _ready, missing: _missing, ...rest } = manifest;
  return {
    ...rest,
    criteria: manifest.criteria.map(({ result: _result, reasons: _reasons, ...criterion }) => ({
      ...criterion,
      selectors: criterion.selectors.map((selector) =>
        selector.source === 'provider_observation'
          ? { source: selector.source, provider: selector.provider, subject: selector.subject }
          : selector,
      ),
    })),
  };
}

/** A manifest without the upstream snapshot, which the dependency graph reads on its own. */
function withoutUpstreams<T extends { dependencies?: unknown }>(manifest: T): Omit<T, 'dependencies'> {
  const { dependencies: _upstreams, ...rest } = manifest;
  return rest;
}

/**
 * Is the work's current acceptance still what was accepted.
 *
 * Stale when the evidence epoch moved (the rule `workGraph.ts` applies to an
 * upstream), when anything the manifest records other than the provider facts
 * and the upstream snapshot moved (rebuilt as of the moment of the decision, so a time limit running out
 * later does not by itself reopen the question), and when a provider fact
 * observed since adds a current failure to a criterion that no longer reads
 * as accepted: a new negative observation (spec 5.6). Unknown alone is not
 * negative evidence. A fact that
 * agrees with the acceptance, a rerun of the check it was accepted on passing
 * again, changes the facts the manifest lists and nothing a decision rests on,
 * so it leaves the acceptance standing; `noteProviderObservation` moves no
 * epoch for it either, and the two never disagree about an upstream.
 */
async function acceptanceIsStale(db: Db, inputs: EvidenceInputs, acceptance: AcceptanceRow): Promise<boolean> {
  if (acceptance.evidenceEpoch !== inputs.work.evidenceEpoch) return true;
  const readiness = evaluate(inputs, acceptance.createdAt);
  const manifest = manifestOf(inputs, readiness, await dependencySnapshot(db, inputs.work.id), acceptance.createdAt);
  if (fingerprintJson(manifest) === acceptance.evidenceManifestHash) return false;
  const accepted = acceptance.evidenceManifest as EvidenceManifest | null;
  if (!accepted || !Array.isArray(accepted.criteria)) return true;
  // The upstreams are not this work's evidence. One reopened, revised or
  // accepted again is said as its own fact (`dependencyChanged`, "Upstream
  // changed"), and reading it here too told a person this delivery's evidence
  // had moved when none of it had.
  if (fingerprintJson(withoutUpstreams(withoutProviderReading(manifest))) !== fingerprintJson(withoutUpstreams(withoutProviderReading(accepted)))) {
    return true;
  }
  const was = new Map(accepted.criteria.map((criterion) => [criterion.id, criterion]));
  const facts = new Map(inputs.observations.map((fact) => [fact.id, fact]));
  // A second readback of a failing attempt may add a row with richer metadata;
  // it is still the same negative result the acceptor already saw.
  const failuresOf = (selectors: readonly SelectorOutcome[]) => new Set(selectors.flatMap((selector) =>
    selector.source === 'provider_observation'
      ? selector.observation_ids.flatMap((id) => {
          const fact = facts.get(id);
          return fact?.state === 'failure'
            ? [canonicalJson([fact.bindingId, fact.provider, fact.subjectId, fact.commitSha, fact.attempt])]
            : [];
        })
      : [],
  ));
  return manifest.criteria.some((criterion) => {
    const before = was.get(criterion.id);
    // An incomplete scan can hide a new failure even when an optional result
    // stays unknown or an any-rule still passes through another selector.
    if (criterion.selectors.some((selector) => selector.reason === 'observations_truncated')) return true;
    if (criterion.result === 'pass' || criterion.result === before?.result) return false;
    const knownFailures = failuresOf(before?.selectors ?? []);
    return [...failuresOf(criterion.selectors)].some((failure) => !knownFailures.has(failure));
  });
}

export interface WorkEvidenceState {
  /** Evidence about the current delivery no longer counts: a contract moved past it, or it aged out. */
  staleEvidence: boolean;
  /** The current acceptance was made on a snapshot that has since moved. */
  acceptanceStale: boolean;
  /** Required criteria by their result against the current delivery; null while there is none. */
  criteria: ResultCounts | null;
  /** Every required criterion passes against a delivery for the current revision. Never "accepted". */
  readyForReview: boolean;
  /** In review, with a current delivery nobody has decided on yet. */
  needsDecision: boolean;
  /**
   * The current delivery already has a decision: changes were requested on it,
   * or it was accepted. Every criterion may still pass, but nothing waits on a
   * reviewer, so the console does not call it ready for review.
   */
  currentDecided: boolean;
  deliveryId: string | null;
  evidenceEpoch: string;
}

export const NO_EVIDENCE: WorkEvidenceState = {
  staleEvidence: false,
  acceptanceStale: false,
  criteria: null,
  readyForReview: false,
  needsDecision: false,
  currentDecided: false,
  deliveryId: null,
  evidenceEpoch: '0',
};

/** Per work id; a work missing from the map reads as NO_EVIDENCE. A read: it writes nothing. */
export async function evidenceState(db: Db, workIds: readonly string[]): Promise<Map<string, WorkEvidenceState>> {
  const out = new Map<string, WorkEvidenceState>();
  const ids = [...new Set(workIds)].filter((id) => isCanonicalUuid(id));
  if (!ids.length) return out;
  const works = await db.select().from(workItems).where(inArray(workItems.id, ids));
  if (!works.length) return out;
  const inputs = await loadInputs(db, works);
  const now = new Date();

  const deliveryIds = works.flatMap((work) => (work.currentDeliveryId ? [work.currentDeliveryId] : []));
  const decided = deliveryIds.length
    ? new Set(
        (
          await db
            .selectDistinct({ deliveryId: workAcceptances.deliveryId })
            .from(workAcceptances)
            .where(inArray(workAcceptances.deliveryId, deliveryIds))
        ).map((row) => row.deliveryId),
      )
    : new Set<string>();
  const acceptanceIds = works.flatMap((work) => (work.currentAcceptanceId ? [work.currentAcceptanceId] : []));
  const acceptances = acceptanceIds.length
    ? await db.select().from(workAcceptances).where(inArray(workAcceptances.id, acceptanceIds))
    : [];

  for (const work of works) {
    const input = inputs.get(work.id)!;
    const readiness = evaluate(input, now);
    const acceptance = acceptances.find((row) => row.id === work.currentAcceptanceId);
    const forRevision = input.delivery !== null && input.delivery.specRevision === work.specRevision;
    // Only for work that takes a new delivery, which is the remedy the flag
    // points at. Accepted work is judged by `acceptanceStale`, as of its
    // decision, so a time limit running out afterwards reopens nothing; and
    // accepted or cancelled work refuses a delivery, so telling its page or a
    // client that a new one is needed sent them to a door that is shut.
    const takesDelivery = work.state !== 'accepted' && work.state !== 'cancelled';
    out.set(work.id, {
      staleEvidence:
        takesDelivery &&
        input.delivery !== null &&
        (!forRevision || readiness.criteria.some((criterion) => criterion.result === 'stale')),
      acceptanceStale: acceptance ? await acceptanceIsStale(db, input, acceptance) : false,
      criteria: input.delivery ? readiness.counts : null,
      readyForReview: readiness.ready_for_review,
      needsDecision: work.state === 'in_review' && work.currentDeliveryId !== null && !decided.has(work.currentDeliveryId),
      currentDecided: work.currentDeliveryId !== null && decided.has(work.currentDeliveryId),
      deliveryId: work.currentDeliveryId,
      evidenceEpoch: wireBigint(work.evidenceEpoch),
    });
  }
  return out;
}

/** What `ready_for_review` means, said wherever it is shown. */
export const READY_FOR_REVIEW_MEANING =
  'Ready for review means every required criterion has current passing evidence. It is not an acceptance, and it says nothing about merging or deploying.';

/**
 * The evidence a reader (and a person about to decide) sees for one work: the
 * manifest and the four values a decision must send back unchanged. Read-only;
 * any principal that can see the work may read it.
 */
export async function readEvidence(
  db: Db,
  principal: WorkPrincipal,
  workId: string,
): Promise<WorkResult<Record<string, unknown>>> {
  try {
    if (!isCanonicalUuid(workId)) throw refuse('NOT_FOUND', NOT_VISIBLE);
    const [work] = await db.select().from(workItems).where(eq(workItems.id, workId.toLowerCase())).limit(1);
    if (!work) throw refuse('NOT_FOUND', NOT_VISIBLE);
    const access = await workAccess(db, principal, work.teamId, work.projectId);
    if (!access) throw refuse('NOT_FOUND', NOT_VISIBLE);
    const { manifest, hash, readiness } = await buildEvidenceManifest(db, work);
    const state = (await evidenceState(db, [work.id])).get(work.id) ?? NO_EVIDENCE;
    const mayDecide =
      principal.kind === 'human' &&
      work.state === 'in_review' &&
      state.needsDecision &&
      (work.acceptorUserId === principal.userId || access.role === 'owner');
    return {
      work_id: work.id,
      key: work.displayKey,
      state: work.state,
      version: wireBigint(work.version),
      spec_revision: work.specRevision,
      delivery_id: work.currentDeliveryId,
      evidence_epoch: wireBigint(work.evidenceEpoch),
      evidence_manifest_hash: hash,
      readiness,
      ready_for_review_meaning: READY_FOR_REVIEW_MEANING,
      manifest,
      acceptance: work.currentAcceptanceId ? { id: work.currentAcceptanceId, stale: state.acceptanceStale } : null,
      may_decide: mayDecide,
      untrusted: WORK_UNTRUSTED,
    };
  } catch (error) {
    return refusalOf(error);
  }
}

// ---------------------------------------------------------------------------
// The two commands: submit a delivery, record evidence.
// ---------------------------------------------------------------------------

const without = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

const ENVELOPE_KEYS = ['request_id', 'work_id', 'expected_version'] as const;

/** The work's team and project, read before the envelope locks it. */
async function scopeOf(db: Db, workId: string) {
  const [target] = await db
    .select({ teamId: workItems.teamId, projectId: workItems.projectId })
    .from(workItems)
    .where(eq(workItems.id, workId))
    .limit(1);
  if (!target) throw refuse('NOT_FOUND', NOT_VISIBLE);
  return target;
}

function commandParts(ctx: WorkOpContext) {
  if (!ctx.principal || !ctx.access || !ctx.work) throw new Error('A Work command needs a principal and its work.');
  return { principal: ctx.principal, work: ctx.work };
}

/**
 * Only an agent linked to the work reports on it: the target of an assignment
 * filed against it, or the owner of a run linked to it. A person's standing is
 * their membership, which the envelope has already checked.
 */
async function assertLinked(db: Db, principal: WorkPrincipal, work: WorkItemRow, act: string) {
  if (principal.kind === 'human') return;
  if (await agentLinkedToWork(db, work.id, principal)) return;
  throw refuse('FORBIDDEN', `An agent may ${act} only on work it is linked to: an assignment it was given, or a run of its own linked to the work.`, {
    next_action: 'Start a run linked to this work, or ask its owner to assign it to you.',
  });
}

const archivedRefusal = () =>
  refuse('INVALID_TRANSITION', 'Archived work is read-only.', { next_action: 'Reopen it with a reason first.' });

/**
 * Validate and normalize a delivery's artifacts. A code artifact must be in the
 * project's repository when the project has one; a checkpoint it names must be
 * one reported in this project, about this repository and this exact commit.
 */
async function checkArtifacts(tx: Db, ctx: WorkOpContext, artifacts: readonly WorkArtifact[]): Promise<WorkArtifact[]> {
  const [project] = await tx
    .select({ repositoryIdentity: projects.repositoryIdentity })
    .from(projects)
    .where(eq(projects.id, ctx.projectId))
    .limit(1);
  const projectIdentity = project?.repositoryIdentity ? canonicalRepositoryIdentity(project.repositoryIdentity) : null;
  const seen = new Map<string, number>();
  const out: WorkArtifact[] = [];
  for (const [index, raw] of artifacts.entries()) {
    const artifact = normalizeArtifact(raw);
    const identity = canonicalJson(artifactIdentity(artifact));
    const earlier = seen.get(identity);
    if (earlier !== undefined) {
      throw refuse('INVALID_INPUT', `artifacts[${index}] is the same artifact as artifacts[${earlier}].`, {
        fields: [`artifacts[${index}]`],
      });
    }
    seen.set(identity, index);
    if (artifact.kind === 'code') {
      if (projectIdentity && artifact.repository_identity !== projectIdentity) {
        throw refuse('INVALID_INPUT', `artifacts[${index}].repository_identity is not this project's repository (${projectIdentity}).`, {
          fields: [`artifacts[${index}].repository_identity`],
        });
      }
      if (artifact.checkpoint_id) {
        const [checkpoint] = await tx
          .select()
          .from(runCheckpoints)
          .where(eq(runCheckpoints.id, artifact.checkpoint_id))
          .limit(1);
        if (!checkpoint || checkpoint.teamId !== ctx.teamId || checkpoint.projectId !== ctx.projectId) {
          throw refuse('INVALID_INPUT', `artifacts[${index}].checkpoint_id: no checkpoint with that id was reported in this project.`, {
            fields: [`artifacts[${index}].checkpoint_id`],
          });
        }
        if (checkpoint.repositoryIdentity !== artifact.repository_identity) {
          throw refuse('INVALID_INPUT', `artifacts[${index}].repository_identity is not the repository the checkpoint reported.`, {
            fields: [`artifacts[${index}].repository_identity`],
          });
        }
        if (checkpoint.commitSha !== artifact.commit_sha) {
          throw refuse(
            'INVALID_INPUT',
            `artifacts[${index}].commit_sha is not the commit the checkpoint reported (${checkpoint.commitSha.slice(0, 12)}).`,
            { fields: [`artifacts[${index}].commit_sha`] },
          );
        }
      }
    }
    out.push(artifact);
  }
  return out;
}

/**
 * A run a delivery names must be the caller's own and linked to this work: its
 * installation (or, for an agent, a local adapter paired with it, the
 * `actionableRuns` edge), owned by the same person, through a link nobody has
 * superseded.
 */
async function checkRun(tx: Db, principal: WorkPrincipal, work: WorkItemRow, runId: string): Promise<string> {
  const id = runId.toLowerCase();
  const own =
    principal.kind === 'agent'
      ? principal.installationId
        ? or(eq(agentRuns.installationId, principal.installationId), adapterListeningFor(principal.installationId))
        : sql`false`
      : undefined;
  const [row] = await tx
    .select({ id: agentRuns.id })
    .from(workLinks)
    .innerJoin(agentRuns, eq(agentRuns.id, workLinks.runId))
    .innerJoin(agentInstallations, eq(agentInstallations.id, agentRuns.installationId))
    .where(
      and(
        eq(workLinks.workId, work.id),
        eq(workLinks.kind, 'run'),
        isNull(workLinks.supersededAt),
        eq(agentRuns.id, id),
        eq(agentInstallations.userId, principal.userId),
        own,
      ),
    )
    .limit(1);
  if (!row) {
    throw refuse('INVALID_INPUT', 'run_id is not a run of this principal linked to this work.', {
      fields: ['run_id'],
      next_action: 'Leave run_id out, or name the run you linked to this work.',
    });
  }
  return id;
}

interface DeliveryFacts {
  id: string;
  specRevision: number;
  artifacts: readonly WorkArtifact[];
}

/**
 * Write evidence rows for one delivery. Provenance is decided here and only
 * here: a bearer principal writes `agent_reported`, always. A person's
 * observation is a human check recorded with the decision, never a row here.
 */
async function writeEvidence(
  tx: Db,
  ctx: WorkOpContext,
  principal: WorkPrincipal,
  delivery: DeliveryFacts,
  drafts: { input: WorkEvidenceInput; prefix: string; supersedesId?: string | null }[],
  hosted: boolean,
): Promise<string[]> {
  if (!drafts.length) return [];
  if (principal.kind !== 'agent') {
    throw refuse('FORBIDDEN', 'Evidence rows are reported by agents. A person records what they checked as a human check in the decision.', {
      fields: [drafts[0]!.prefix ? 'evidence' : 'criterion_id'],
    });
  }
  if (hosted) {
    const [{ used }] = (await tx
      .select({ used: count() })
      .from(workEvidence)
      .where(eq(workEvidence.deliveryId, delivery.id))) as [{ used: number }];
    if (used + drafts.length > WORK_HOSTED_MAX_EVIDENCE_PER_DELIVERY) {
      throw refuse(
        'LIMIT_EXCEEDED',
        `This delivery holds ${used} evidence rows; at most ${WORK_HOSTED_MAX_EVIDENCE_PER_DELIVERY} are kept per delivery on the hosted service.`,
        { used, limit: WORK_HOSTED_MAX_EVIDENCE_PER_DELIVERY },
      );
    }
  }
  const criteria = new Set(
    (
      await tx
        .select({ id: workCriteria.criterionId })
        .from(workCriteria)
        .where(and(eq(workCriteria.workId, ctx.work!.id), eq(workCriteria.revision, delivery.specRevision)))
    ).map((row) => row.id),
  );
  const codes = codeArtifacts(delivery.artifacts);
  const perCriterion = new Map<string, string>();
  const values: (typeof workEvidence.$inferInsert)[] = [];
  for (const { input, prefix, supersedesId } of drafts) {
    if (!criteria.has(input.criterion_id)) {
      throw refuse('INVALID_INPUT', `${prefix}criterion_id is not a criterion of contract revision ${delivery.specRevision}.`, {
        fields: [`${prefix}criterion_id`],
      });
    }
    // Two rows about one criterion in one command would have no order between
    // them; a second report is its own command.
    const earlier = perCriterion.get(input.criterion_id);
    if (earlier !== undefined) {
      throw refuse('INVALID_INPUT', `${prefix}criterion_id repeats the criterion of ${earlier}; send one row per criterion per command.`, {
        fields: [`${prefix}criterion_id`],
      });
    }
    perCriterion.set(input.criterion_id, prefix ? prefix.replace(/\.$/, '') : 'this command');
    let sourceRef = input.source_ref;
    let sourceVersion = input.source_version || null;
    // Evidence about another commit or document version is not evidence about
    // this delivery (spec 5.5), and does not move onto it by itself (spec 3.3):
    // a version the report names must be the one the delivery carries for what
    // it names. The message names no version: a document's is somebody's text.
    const otherVersion = () =>
      refuse(
        'INVALID_INPUT',
        `${prefix}source_version is not the version this delivery carries for that source; evidence about another version does not count for this delivery.`,
        { fields: [`${prefix}source_version`], next_action: 'Report against the delivered version, or leave source_version out.' },
      );
    if (input.source_kind === 'checkpoint') {
      const id = sourceRef.toLowerCase();
      const [checkpoint] = isCanonicalUuid(id)
        ? await tx.select().from(runCheckpoints).where(eq(runCheckpoints.id, id)).limit(1)
        : [];
      if (!checkpoint || checkpoint.teamId !== ctx.teamId || checkpoint.projectId !== ctx.projectId) {
        throw refuse('INVALID_INPUT', `${prefix}source_ref: no checkpoint with that id was reported in this project.`, {
          fields: [`${prefix}source_ref`],
        });
      }
      if (!codes.some((code) => code.commit_sha === checkpoint.commitSha && code.repository_identity === checkpoint.repositoryIdentity)) {
        throw refuse('INVALID_INPUT', `${prefix}source_ref: that checkpoint's commit is not an artifact of this delivery.`, {
          fields: [`${prefix}source_ref`],
        });
      }
      if (sourceVersion !== null) {
        if (sourceVersion.toLowerCase() !== checkpoint.commitSha.toLowerCase()) throw otherVersion();
        sourceVersion = checkpoint.commitSha.toLowerCase();
      }
      sourceRef = id;
    } else if (input.source_kind === 'artifact') {
      const found = resolveArtifact(delivery.artifacts, sourceRef);
      if (found === 'ambiguous') {
        throw refuse('INVALID_INPUT', `${prefix}source_ref names more than one artifact of this delivery; use artifacts[N].`, {
          fields: [`${prefix}source_ref`],
        });
      }
      if (!found) {
        throw refuse('INVALID_INPUT', `${prefix}source_ref names no artifact of this delivery.`, {
          fields: [`${prefix}source_ref`],
          next_action: 'Name it by its commit SHA, its uri, its file name or digest, or as artifacts[N].',
        });
      }
      // An unversioned document has no version a report could match.
      if (sourceVersion !== null) {
        if (!versionMatches(found.artifact, sourceVersion)) throw otherVersion();
        sourceVersion = artifactVersionLabel(found.artifact);
      }
    } else if (sourceVersion !== null) {
      // A plain report names no artifact, so the version it names must be one
      // the delivery carries for some artifact: a test run of an older commit
      // reported as `agent_report` is evidence about that commit, not this one.
      const carried = delivery.artifacts.find((artifact) => versionMatches(artifact, sourceVersion!));
      if (!carried) throw otherVersion();
      sourceVersion = artifactVersionLabel(carried);
    }
    let observedAt: Date | null = null;
    if (input.observed_at) {
      observedAt = new Date(input.observed_at);
      if (observedAt.getTime() > ctx.now.getTime() + FUTURE_SKEW_MS) {
        throw refuse('INVALID_INPUT', `${prefix}observed_at is in the future.`, { fields: [`${prefix}observed_at`] });
      }
    }
    values.push({
      id: randomUUID(),
      workId: ctx.work!.id,
      deliveryId: delivery.id,
      criterionId: input.criterion_id,
      specRevision: delivery.specRevision,
      sourceKind: input.source_kind,
      sourceRef,
      sourceVersion,
      assertion: input.assertion,
      excerpt: input.excerpt ? redactSecrets(input.excerpt) : null,
      provenance: 'agent_reported',
      reportedByKind: 'agent',
      reportedById: principalId(principal),
      reportedByUserId: principal.userId,
      observedAt,
      recordedAt: ctx.now,
      supersedesId: supersedesId ?? null,
    });
  }
  await tx.insert(workEvidence).values(values);
  return values.map((value) => value.id!);
}

/** A work's readiness inside the command that just changed it, from the row as it is now. */
async function readinessAfter(tx: Db, workId: string, now: Date): Promise<Readiness> {
  const [row] = await tx.select().from(workItems).where(eq(workItems.id, workId)).limit(1);
  return evaluateReadiness(tx, row!, { asOf: now });
}

/**
 * Submit a delivery: an immutable artifact set against the current contract
 * revision. It becomes the current delivery, supersedes the previous one,
 * moves the evidence epoch and puts the work in review; work that was ready
 * passes through in progress on the way.
 */
export async function submitDelivery(
  db: Db,
  principal: WorkPrincipal,
  rawInput: WorkSubmitInput | Record<string, unknown>,
  options: { hosted?: boolean } = {},
): Promise<WorkResult<WorkCommandOutcome>> {
  let input: WorkSubmitInput;
  let target: { teamId: string; projectId: string };
  try {
    input = parseOrRefuse(workSubmitSchema, rawInput);
    target = await scopeOf(db, input.work_id.toLowerCase());
  } catch (error) {
    return refusalOf(error);
  }
  const hosted = options.hosted ?? isHosted();
  const workId = input.work_id.toLowerCase();
  return runWorkCommand(
    db,
    principal,
    {
      requestId: input.request_id,
      operation: 'submit',
      teamId: target.teamId,
      projectId: target.projectId,
      workId,
      expectedVersion: BigInt(input.expected_version),
      hashInput: {
        operation: 'submit',
        work_id: workId,
        expected_version: input.expected_version,
        payload: without(input as unknown as Record<string, unknown>, ENVELOPE_KEYS),
      },
    },
    async (tx, ctx) => {
      const { principal: actor, work } = commandParts(ctx);
      if (work.archivedAt) throw archivedRefusal();
      await assertLinked(tx, actor, work, 'submit a delivery');
      const from = work.state as WorkState;
      if (from === 'draft') {
        throw refuse('INVALID_TRANSITION', 'Draft work takes no delivery.', { next_action: 'Move it to ready first.' });
      }
      if (from === 'accepted' || from === 'cancelled') {
        throw refuse('INVALID_TRANSITION', `Work in ${from} takes no new delivery.`, { next_action: 'Reopen it with a reason first.' });
      }
      if (input.spec_revision !== work.specRevision) {
        throw refuse(
          'CONTRACT_CHANGED',
          `The contract is at revision ${work.specRevision}; this delivery was made against revision ${input.spec_revision}.`,
          {
            fields: ['spec_revision'],
            next_action: `Read the contract at revision ${work.specRevision} and deliver against it.`,
          },
        );
      }
      const [{ delivered, last }] = (await tx
        .select({ delivered: count(), last: sql<number | null>`max(${workDeliveries.sequence})` })
        .from(workDeliveries)
        .where(eq(workDeliveries.workId, work.id))) as [{ delivered: number; last: number | null }];
      if (hosted && delivered >= WORK_HOSTED_MAX_DELIVERIES) {
        throw refuse(
          'LIMIT_EXCEEDED',
          `This work holds ${delivered} deliveries; at most ${WORK_HOSTED_MAX_DELIVERIES} are kept per work item on the hosted service.`,
          { used: delivered, limit: WORK_HOSTED_MAX_DELIVERIES },
        );
      }
      const artifacts = await checkArtifacts(tx, ctx, input.artifacts);
      const runId = input.run_id ? await checkRun(tx, actor, work, input.run_id) : null;
      const deliveryId = randomUUID();
      const sequence = Number(last ?? 0) + 1;
      const artifactSetHash = fingerprintJson(
        [...artifacts].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
      );
      await tx.insert(workDeliveries).values({
        id: deliveryId,
        workId: work.id,
        specRevision: work.specRevision,
        sequence,
        artifacts,
        artifactSetHash,
        runId,
        note: input.note || null,
        submittedByKind: actor.kind,
        submittedById: principalId(actor),
        submittedByUserId: actor.userId,
        supersedesDeliveryId: work.currentDeliveryId,
        submittedAt: ctx.now,
      });
      const evidenceIds = await writeEvidence(
        tx,
        ctx,
        actor,
        { id: deliveryId, specRevision: work.specRevision, artifacts },
        input.evidence.map((entry, index) => ({ input: entry, prefix: `evidence[${index}].` })),
        hosted,
      );
      const epoch = work.evidenceEpoch + 1n;
      await tx
        .update(workItems)
        .set({ currentDeliveryId: deliveryId, evidenceEpoch: epoch, state: 'in_review' })
        .where(eq(workItems.id, work.id));
      const readiness = await readinessAfter(tx, work.id, ctx.now);

      const payload: Record<string, unknown> = {
        delivery_id: deliveryId,
        sequence,
        artifacts: artifacts.length,
        commits: codeArtifacts(artifacts).map((artifact) => artifact.commit_sha),
        evidence: evidenceIds.length,
        evidence_epoch: wireBigint(epoch),
      };
      if (work.currentDeliveryId) payload.supersedes_delivery_id = work.currentDeliveryId;
      if (from !== 'in_review') {
        payload.state = { from, to: 'in_review', ...(from === 'ready' ? { through: 'in_progress' } : {}) };
      }
      if (runId) payload.run_id = runId;
      return {
        events: [{ workId: work.id, type: 'work_delivered', payload }],
        resultRef: deliveryId,
        response: {
          delivery_id: deliveryId,
          sequence,
          artifact_set_hash: artifactSetHash,
          supersedes_delivery_id: work.currentDeliveryId,
          evidence_ids: evidenceIds,
          evidence_epoch: wireBigint(epoch),
          readiness,
        },
      };
    },
  );
}

/**
 * Record one piece of evidence about one criterion of the current delivery.
 * An older delivery takes no new evidence (EVIDENCE_STALE); `supersedes_id`
 * replaces the reporter's own earlier row without deleting it.
 */
export async function recordEvidence(
  db: Db,
  principal: WorkPrincipal,
  rawInput: WorkRecordEvidenceInput | Record<string, unknown>,
  options: { hosted?: boolean } = {},
): Promise<WorkResult<WorkCommandOutcome>> {
  let input: WorkRecordEvidenceInput;
  let target: { teamId: string; projectId: string };
  try {
    input = parseOrRefuse(workRecordEvidenceSchema, rawInput);
    target = await scopeOf(db, input.work_id.toLowerCase());
  } catch (error) {
    return refusalOf(error);
  }
  const hosted = options.hosted ?? isHosted();
  const workId = input.work_id.toLowerCase();
  return runWorkCommand(
    db,
    principal,
    {
      requestId: input.request_id,
      operation: 'record_evidence',
      teamId: target.teamId,
      projectId: target.projectId,
      workId,
      expectedVersion: BigInt(input.expected_version),
      hashInput: {
        operation: 'record_evidence',
        work_id: workId,
        expected_version: input.expected_version,
        payload: without(input as unknown as Record<string, unknown>, ENVELOPE_KEYS),
      },
    },
    async (tx, ctx) => {
      const { principal: actor, work } = commandParts(ctx);
      if (work.archivedAt) throw archivedRefusal();
      if (actor.kind === 'human') {
        throw refuse('FORBIDDEN', 'Evidence rows are reported by agents. A person records what they checked as a human check in the decision.');
      }
      await assertLinked(tx, actor, work, 'record evidence');
      if (work.state === 'accepted' || work.state === 'cancelled') {
        throw refuse('INVALID_TRANSITION', `Work in ${work.state} takes no new evidence.`, { next_action: 'Reopen it with a reason first.' });
      }
      if (!work.currentDeliveryId) {
        throw refuse('INVALID_TRANSITION', 'Nothing has been delivered for this work yet.', {
          next_action: 'Submit a delivery first; evidence is recorded against it.',
        });
      }
      const deliveryId = input.delivery_id.toLowerCase();
      const [delivery] = await tx
        .select()
        .from(workDeliveries)
        .where(and(eq(workDeliveries.id, deliveryId), eq(workDeliveries.workId, work.id)))
        .limit(1);
      if (!delivery) {
        throw refuse('INVALID_INPUT', 'delivery_id: no delivery with that id belongs to this work.', { fields: ['delivery_id'] });
      }
      if (delivery.id !== work.currentDeliveryId) {
        throw refuse('EVIDENCE_STALE', `Delivery ${delivery.sequence} was superseded; evidence is recorded against the current delivery only.`, {
          fields: ['delivery_id'],
          next_action: `Read the work again and record against delivery ${work.currentDeliveryId}.`,
        });
      }
      if (delivery.specRevision !== work.specRevision) {
        throw refuse(
          'EVIDENCE_STALE',
          `The contract moved to revision ${work.specRevision} after this delivery; evidence about it no longer counts.`,
          { fields: ['delivery_id'], next_action: `Submit a new delivery against revision ${work.specRevision}.` },
        );
      }
      let supersedesId: string | null = null;
      if (input.supersedes_id) {
        const id = input.supersedes_id.toLowerCase();
        const [previous] = await tx.select().from(workEvidence).where(eq(workEvidence.id, id)).limit(1);
        const [replaced] = previous
          ? await tx.select({ id: workEvidence.id }).from(workEvidence).where(eq(workEvidence.supersedesId, id)).limit(1)
          : [];
        if (
          !previous ||
          previous.deliveryId !== delivery.id ||
          previous.criterionId !== input.criterion_id ||
          previous.reportedByKind !== 'agent' ||
          previous.reportedById !== principalId(actor)
        ) {
          throw refuse('INVALID_INPUT', 'supersedes_id must be your own earlier row about this criterion of this delivery.', {
            fields: ['supersedes_id'],
          });
        }
        if (replaced) {
          throw refuse('INVALID_INPUT', 'supersedes_id: that row was already superseded; supersede the newer one.', {
            fields: ['supersedes_id'],
          });
        }
        supersedesId = id;
      }
      const evidenceInput: WorkEvidenceInput = {
        criterion_id: input.criterion_id,
        assertion: input.assertion,
        source_kind: input.source_kind,
        source_ref: input.source_ref,
        source_version: input.source_version,
        excerpt: input.excerpt,
        observed_at: input.observed_at,
      };
      const [evidenceId] = await writeEvidence(
        tx,
        ctx,
        actor,
        { id: delivery.id, specRevision: delivery.specRevision, artifacts: delivery.artifacts as WorkArtifact[] },
        [{ input: evidenceInput, prefix: '', supersedesId }],
        hosted,
      );
      const epoch = work.evidenceEpoch + 1n;
      await tx.update(workItems).set({ evidenceEpoch: epoch }).where(eq(workItems.id, work.id));
      const readiness = await readinessAfter(tx, work.id, ctx.now);
      const criterion = readiness.criteria.find((entry) => entry.id === input.criterion_id);
      const payload: Record<string, unknown> = {
        delivery_id: delivery.id,
        evidence_id: evidenceId,
        criterion_id: input.criterion_id,
        assertion: input.assertion,
        provenance: 'agent_reported',
        source_kind: input.source_kind,
        evidence_epoch: wireBigint(epoch),
      };
      if (supersedesId) payload.supersedes_id = supersedesId;
      return {
        events: [{ workId: work.id, type: 'work_evidence_recorded', payload }],
        resultRef: evidenceId,
        response: {
          evidence_id: evidenceId,
          delivery_id: delivery.id,
          provenance: 'agent_reported',
          evidence_epoch: wireBigint(epoch),
          criterion: criterion ? { id: criterion.id, result: criterion.result, reasons: criterion.reasons } : null,
          ready_for_review: readiness.ready_for_review,
        },
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Provider facts reaching work: called by `recordProviderObservation` inside
// its own transaction, after the binding lock and the inserted fact.
// ---------------------------------------------------------------------------

/**
 * Current deliveries read per page while finding the works a fact is about.
 * Paged, never cut: a work left out keeps its epoch while the fact makes its
 * acceptance stale, and every dependency on it then reads met on an upstream
 * that no longer stands (spec 7.2 moves the epoch of every affected work in
 * the same transaction). How many works that is, is bounded by the project's
 * own work (`WORK_HOSTED_MAX_ITEMS_PER_PROJECT` where hosted).
 */
const OBSERVED_WORK_PAGE = 200;

export interface ObservedFact {
  teamId: string;
  projectId: string | null;
  observationId: string;
  provider: string;
  /** The binding's own name for its repository (`owner/name`, or Azure DevOps' `org/project/repo`). */
  repository: string;
  kind: string;
  subjectId: string;
  subjectName: string | null;
  commitSha: string;
  state: string;
  attempt: number;
}

/**
 * The works a fact is about: open, with a current delivery that carries the
 * commit in the repository the fact's binding stands for, and a current
 * revision with a criterion that reads the fact. Asked once to know which
 * works to lock and once more under the locks, restricted to the ones locked
 * (`among`), because a work can move between the two.
 */
async function worksReadingFact(
  db: Db,
  fact: ObservedFact,
  projectId: string,
  commit: string,
  among?: readonly string[],
): Promise<string[]> {
  if (among && !among.length) return [];
  // The same pairing readiness reads (`loadInputs`): a commit delivered in one
  // repository is not observed by a binding of another that holds it too.
  const repositories = bindingRepositoryIdentities(fact.provider, fact.repository);
  if (!repositories.length) return [];
  const delivers = or(
    ...repositories.map(
      (repository) =>
        sql`${workDeliveries.artifacts} @> ${JSON.stringify([{ kind: 'code', repository_identity: repository, commit_sha: commit }])}::jsonb`,
    ),
  );
  const found: string[] = [];
  let after: string | null = null;
  for (;;) {
    const carrying: { id: string; specRevision: number }[] = await db
      .select({ id: workItems.id, specRevision: workItems.specRevision })
      .from(workItems)
      .innerJoin(workDeliveries, eq(workDeliveries.id, workItems.currentDeliveryId))
      .where(
        and(
          eq(workItems.teamId, fact.teamId),
          eq(workItems.projectId, projectId),
          // Archived accepted work still stands for the work that depends on it,
          // and a dependency is met only while its epoch holds: a failing fact
          // that moved nothing for it left an acceptance that read stale while
          // every downstream edge read met.
          or(isNull(workItems.archivedAt), eq(workItems.state, 'accepted')),
          among ? inArray(workItems.id, [...among]) : undefined,
          after ? gt(workItems.id, after) : undefined,
          delivers,
        ),
      )
      .orderBy(asc(workItems.id))
      .limit(OBSERVED_WORK_PAGE);
    if (!carrying.length) break;
    const rules = await db
      .select({ workId: workCriteria.workId, rule: workCriteria.verificationRule })
      .from(workCriteria)
      .where(or(...carrying.map((work) => and(eq(workCriteria.workId, work.id), eq(workCriteria.revision, work.specRevision)))));
    const reads = new Set(
      rules
        .filter((row) =>
          (row.rule as WorkVerificationRule).selectors.some(
            (selector) => selector.source === 'provider_observation' && factMatches(fact, selector),
          ),
        )
        .map((row) => row.workId),
    );
    for (const work of carrying) if (reads.has(work.id)) found.push(work.id);
    if (carrying.length < OBSERVED_WORK_PAGE) break;
    after = carrying[carrying.length - 1]!.id;
  }
  return found;
}

/**
 * Move the evidence epoch of every work whose current delivery carries this
 * commit, in the repository the fact's binding stands for, and whose current
 * contract has a criterion that reads this fact (its provider, and the subject
 * by name or id), with an `evidence_observed` event
 * (actor `system`). Accepted work moves only when the fact makes its
 * acceptance stale (`acceptanceIsStale`), and then also gets one
 * `acceptance_stale` event, the first time it goes stale; the acceptance row
 * itself is never touched. Every such work moves, however many hold the
 * commit: one left out would keep an epoch its own reading no longer agrees
 * with, and the works depending on it would read the edge met.
 *
 * A fact no criterion reads changes nothing a decision rests on (spec 7.2:
 * the epoch moves when a provider result changes the delivery in effect), so
 * it moves no epoch: a nightly job or a rerun of an unrelated workflow on the
 * delivered commit would otherwise refuse a decision being made and mark an
 * acceptance and every downstream dependency stale for nothing.
 *
 * Runs inside the caller's transaction, whose binding lock is already held, so
 * the Work locks it takes are the last ones (design section 3). Returns what to
 * run after that transaction commits, or null when no work was touched.
 */
export async function noteProviderObservation(tx: Db, fact: ObservedFact): Promise<((db: Db) => Promise<void>) | null> {
  // Readiness reads workflow facts only; a pull request's state is not evidence for a criterion.
  if (fact.kind !== 'workflow' || !fact.projectId) return null;
  const projectId = fact.projectId;
  const commit = fact.commitSha.toLowerCase();
  const touched = await worksReadingFact(tx, fact, projectId, commit);
  if (!touched.length) return null;

  const done = await mutateWorkInTransaction(
    tx,
    { teamId: fact.teamId, projectId, workIds: touched, actor: { kind: 'system' } },
    async (inner, ctx) => {
      // Chosen before the Work locks, asked again under them: a delivery
      // submitted or a contract revised in between takes a work out of this
      // fact's reach, and its epoch must not move for a fact about a delivery
      // it no longer holds (a decision being made on the new one would be
      // refused as stale for nothing).
      const still = new Set(await worksReadingFact(inner, fact, projectId, commit, [...ctx.works.keys()]));
      const events: WorkOpResult['events'] = [];
      for (const work of [...ctx.works.values()].sort((a, b) => a.id.localeCompare(b.id))) {
        if (!still.has(work.id)) continue;
        // Accepted work moves only for a fact that leaves its acceptance stale
        // (spec 5.6: a new negative observation). A rerun of the check it was
        // accepted on passing again changes nothing the decision rests on, and
        // moving the epoch for it would reverse the acceptance as a failure
        // does: every dependency on the work unmet, and no way back but a
        // reopen, a new delivery and a new decision, with nothing failed.
        const [acceptance] = work.currentAcceptanceId
          ? await inner.select().from(workAcceptances).where(eq(workAcceptances.id, work.currentAcceptanceId)).limit(1)
          : [];
        if (acceptance) {
          const inputs = (await loadInputs(inner, [work])).get(work.id)!;
          // Ingestion knows a new relevant fact arrived. With incomplete
          // coverage it may be absent from the bounded manifest, leaving its
          // hash unchanged. Preserve that change through the epoch; an ordinary
          // read of a freshly accepted truncated manifest still stands.
          if (!inputs.observationsTruncated && !(await acceptanceIsStale(inner, inputs, acceptance))) continue;
        }
        const epoch = work.evidenceEpoch + 1n;
        await inner.update(workItems).set({ evidenceEpoch: epoch }).where(eq(workItems.id, work.id));
        events.push({
          workId: work.id,
          type: 'evidence_observed',
          payload: {
            provider: fact.provider,
            observation_id: fact.observationId,
            subject_id: fact.subjectId,
            subject_name: fact.subjectName,
            commit_sha: commit,
            state: fact.state,
            attempt: fact.attempt,
            delivery_id: work.currentDeliveryId,
            evidence_epoch: wireBigint(epoch),
          },
        });
        if (!acceptance) continue;
        // One attention per acceptance: once it is stale, a further fact does
        // not make it more so, and the trail still has every evidence_observed.
        const [already] = await inner
          .select({ id: workEvents.id })
          .from(workEvents)
          .where(
            and(
              eq(workEvents.workId, work.id),
              eq(workEvents.type, 'acceptance_stale'),
              sql`${workEvents.payload} ->> 'acceptance_id' = ${acceptance.id}`,
            ),
          )
          .limit(1);
        if (already) continue;
        events.push({
          workId: work.id,
          type: 'acceptance_stale',
          payload: { acceptance_id: acceptance.id, delivery_id: acceptance.deliveryId, observation_id: fact.observationId },
        });
      }
      return { events };
    },
  );
  // The envelope's own after-commit step puts `acceptance_stale` on the
  // activity feed with the other events a lead acts on.
  return done.afterCommit;
}
