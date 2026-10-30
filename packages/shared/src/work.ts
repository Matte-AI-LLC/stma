import { z } from 'zod/v3';
import { CLAIM_ACCESS_MODES, CLAIM_RESOURCE_TYPES } from './agents';

/**
 * Native Work: a durable unit of work that outlives the agents, runs, sessions
 * and trackers that touch it. This file is the wire contract shared by the MCP
 * tools, the REST routes and the console: the vocabulary, the limits (one
 * source, so a refusal names the same number the schema enforces), the typed
 * command payloads and the error codes. It holds no database or server code.
 *
 * Every bigint the server returns (version, event sequence, evidence epoch)
 * travels as a decimal string, never a JSON number.
 */

export const WORK_STATES = ['draft', 'ready', 'in_progress', 'in_review', 'accepted', 'cancelled'] as const;
export type WorkState = (typeof WORK_STATES)[number];

/**
 * Every state change the lifecycle allows. `accepted` is reached only through a
 * person's recorded decision, and leaving `accepted` or `cancelled` only
 * through an explicit reopen; neither is reachable with the plain transition
 * operation (see WORK_TRANSITION_TARGETS).
 */
export const WORK_TRANSITIONS: Readonly<Record<WorkState, readonly WorkState[]>> = {
  draft: ['ready', 'cancelled'],
  ready: ['in_progress', 'draft', 'cancelled'],
  in_progress: ['in_review', 'cancelled'],
  in_review: ['accepted', 'in_progress', 'cancelled'],
  accepted: ['in_progress'],
  cancelled: ['draft'],
};

/** The targets the `transition` operation may name. */
export const WORK_TRANSITION_TARGETS = ['ready', 'draft', 'in_progress', 'in_review', 'cancelled'] as const;
export type WorkTransitionTarget = (typeof WORK_TRANSITION_TARGETS)[number];

export const isWorkTransitionAllowed = (from: WorkState, to: WorkState): boolean =>
  WORK_TRANSITIONS[from].includes(to);

/** Where a work item came from. A change between them is an explicit command. */
export const WORK_ORIGINS = ['native', 'external'] as const;
export type WorkOrigin = (typeof WORK_ORIGINS)[number];

export const WORK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type WorkPriority = (typeof WORK_PRIORITIES)[number];

export const WORK_RISK_TIERS = ['low', 'medium', 'high'] as const;
export type WorkRiskTier = (typeof WORK_RISK_TIERS)[number];

/** What a delivery of this work is expected to be. Code is one kind among several. */
export const WORK_ARTIFACT_KINDS = ['code', 'document', 'research', 'analysis'] as const;
export type WorkArtifactKind = (typeof WORK_ARTIFACT_KINDS)[number];

/** The kinds of evidence a criterion may ask for. */
export const WORK_EVIDENCE_KINDS = ['agent_report', 'provider_observation', 'artifact', 'human_check'] as const;
export type WorkEvidenceKind = (typeof WORK_EVIDENCE_KINDS)[number];

/**
 * Who stands behind a piece of evidence. Always decided by the server from the
 * authenticated principal and the source, never taken from the caller: an
 * agent can only ever write `agent_reported`.
 */
export const WORK_PROVENANCES = ['agent_reported', 'stma_observed', 'provider_observed', 'human_decision'] as const;
export type WorkProvenance = (typeof WORK_PROVENANCES)[number];

export const WORK_ASSERTIONS = ['pass', 'fail', 'inconclusive'] as const;
export type WorkAssertion = (typeof WORK_ASSERTIONS)[number];

/** Computed on read; never stored as a success. */
export const WORK_EVIDENCE_VALIDITY = ['current', 'stale', 'unavailable', 'withdrawn'] as const;
export type WorkEvidenceValidity = (typeof WORK_EVIDENCE_VALIDITY)[number];

/** A criterion's readiness against the current delivery. Unknown is a result, never a pass. */
export const WORK_CRITERION_RESULTS = ['pass', 'fail', 'unknown', 'stale', 'inconclusive'] as const;
export type WorkCriterionResult = (typeof WORK_CRITERION_RESULTS)[number];

export const WORK_LINK_KINDS = ['run', 'assignment', 'handoff', 'knowledge'] as const;
export type WorkLinkKind = (typeof WORK_LINK_KINDS)[number];

export const WORK_BLOCKER_KINDS = [
  'dependency',
  'decision',
  'access',
  'environment',
  'external',
  'contract_change_request',
  'acceptor_unavailable',
  'other',
] as const;
export type WorkBlockerKind = (typeof WORK_BLOCKER_KINDS)[number];

export const WORK_DECISIONS = ['accept', 'request_changes'] as const;
export type WorkDecision = (typeof WORK_DECISIONS)[number];

export const WORK_EXTERNAL_MODES = ['reference', 'external_authoritative', 'imported_native'] as const;
export type WorkExternalMode = (typeof WORK_EXTERNAL_MODES)[number];

/** The trackers a work item can be tied to. One in this release: GitHub issues, read through the workspace's connection. */
export const WORK_EXTERNAL_PROVIDERS = ['github'] as const;
export type WorkExternalProvider = (typeof WORK_EXTERNAL_PROVIDERS)[number];

/** Who acted. A browser session is a person; every bearer credential is an agent principal. */
export const WORK_PRINCIPAL_KINDS = ['human', 'agent', 'system'] as const;
export type WorkPrincipalKind = (typeof WORK_PRINCIPAL_KINDS)[number];

/**
 * One table of limits. The schemas below enforce them and a refusal names them,
 * so the number in an error and the number in the schema cannot differ.
 */
export const WORK_LIMITS = {
  titleChars: 200,
  goalChars: 4000,
  nonGoalsChars: 2000,
  criteria: 30,
  criterionChars: 1000,
  contextRefs: 30,
  labels: 10,
  labelChars: 40,
  scopeEntries: 50,
  scopeEntryChars: 300,
  artifacts: 20,
  artifactNoteChars: 300,
  excerptChars: 1000,
  reasonChars: 1000,
  nextActionChars: 500,
  dependencies: 50,
  openBlockers: 50,
  selectors: 10,
  listDefault: 20,
  listMax: 50,
  changesDefault: 50,
  changesMax: 200,
  contextDefaultBytes: 12 * 1024,
  contextMinBytes: 4 * 1024,
  contextMaxBytes: 32 * 1024,
  snapshotMaxItems: 500,
  snapshotTtlSeconds: 600,
  /** Whole work commands larger than this are refused before they are parsed further. */
  commandBytes: 64 * 1024,
} as const;

export const WORK_KEY_PREFIX = 'WORK';
export const workDisplayKey = (number: number | bigint | string): string => `${WORK_KEY_PREFIX}-${number}`;
const WORK_KEY_RE = /^WORK-([1-9][0-9]{0,17})$/i;
/** `WORK-42` to its project-local number, or null. A key is a label within one project, never an id. */
export const parseWorkKey = (value: string): string | null => {
  const match = WORK_KEY_RE.exec(value.trim());
  return match ? match[1]! : null;
};

/** A bigint carried as a decimal string. */
export const decimalString = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/, 'a decimal integer as a string, e.g. "3"');

const UUID = z.string().uuid();
const HEX_SHA = /^[a-f0-9]{40,64}$/i;
const HEX_SHA256 = /^[a-f0-9]{64}$/i;

const text = (max: number) => z.string().trim().max(max);
const required = (max: number) => z.string().trim().min(1).max(max);

/**
 * An outbound link STMA will show to people: http(s) only, no credentials in it,
 * no control characters. STMA never fetches it.
 */
export const safeUri = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((value) => {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
      if (url.username || url.password) return false;
      return !/[\u0000-\u001f\u007f]/.test(value);
    } catch {
      return false;
    }
  }, 'an http(s) address with no credentials in it');

export const workCriterionIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, 'lowercase letters, digits, dashes or underscores, at most 40');

/**
 * Which observations may satisfy a criterion. A closed, typed set of selectors:
 * no user code, SQL or free regex is ever run, and a provider selector names an
 * exact subject an adapter reports.
 */
export const workEvidenceSelectorSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('agent_report') }).strict(),
  z
    .object({
      source: z.literal('provider_observation'),
      provider: z.enum(['github', 'azure-devops']),
      subject: required(200),
    })
    .strict(),
  z
    .object({
      source: z.literal('artifact'),
      artifact_kind: z.enum(['code', 'document', 'file']).optional(),
    })
    .strict(),
  z.object({ source: z.literal('human_check') }).strict(),
]);
export type WorkEvidenceSelector = z.infer<typeof workEvidenceSelectorSchema>;

export const workVerificationRuleSchema = z
  .object({
    mode: z.enum(['all', 'any']).default('all'),
    selectors: z.array(workEvidenceSelectorSchema).min(1).max(WORK_LIMITS.selectors),
    max_age_seconds: z.number().int().positive().max(366 * 86400).optional(),
  })
  .strict();
export type WorkVerificationRule = z.infer<typeof workVerificationRuleSchema>;

export const workCriterionInputSchema = z
  .object({
    /** Keep the same id while the meaning is the same; a new meaning is a new id. */
    id: workCriterionIdSchema.optional(),
    text: required(WORK_LIMITS.criterionChars),
    required: z.boolean().default(true),
    evidence_kinds: z.array(z.enum(WORK_EVIDENCE_KINDS)).min(1).max(4).default(['agent_report']),
    verification_rule: workVerificationRuleSchema.optional(),
  })
  .strict();
export type WorkCriterionInput = z.infer<typeof workCriterionInputSchema>;

/** The rule a criterion is evaluated by when the caller named only evidence kinds. */
export const defaultVerificationRule = (
  kinds: readonly WorkEvidenceKind[],
): WorkVerificationRule | { error: string } => {
  if (kinds.includes('provider_observation')) {
    return {
      error:
        'a criterion that asks for provider_observation needs a verification_rule naming the provider and the exact subject (check or pipeline) it means',
    };
  }
  return {
    mode: 'all',
    selectors: [...new Set(kinds)].map((source) => ({ source }) as WorkEvidenceSelector),
  };
};

export const workScopeSchema = z
  .object({
    paths: z.array(required(WORK_LIMITS.scopeEntryChars)).max(WORK_LIMITS.scopeEntries).optional(),
    components: z.array(required(WORK_LIMITS.scopeEntryChars)).max(WORK_LIMITS.scopeEntries).optional(),
    contracts: z.array(required(WORK_LIMITS.scopeEntryChars)).max(WORK_LIMITS.scopeEntries).optional(),
  })
  .strict();
export type WorkScope = z.infer<typeof workScopeSchema>;

/** Pointers to what a worker should read, never copies of it. */
export const workContextRefSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('knowledge'),
      key: required(120),
      version_id: UUID.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('policy'), version: z.number().int().positive().optional() }).strict(),
  z
    .object({
      kind: z.literal('document'),
      uri: safeUri,
      version: text(200).optional(),
      title: text(200).optional(),
    })
    .strict(),
]);
export type WorkContextRef = z.infer<typeof workContextRefSchema>;

export const workAcceptancePolicySchema = z
  .object({ require_independent_acceptor: z.boolean().default(false) })
  .strict();
export type WorkAcceptancePolicy = z.infer<typeof workAcceptancePolicySchema>;

/** The contract fields: changing any of them is a new, immutable spec revision. */
export const workContractSchema = z
  .object({
    title: required(WORK_LIMITS.titleChars),
    goal: text(WORK_LIMITS.goalChars).default(''),
    non_goals: text(WORK_LIMITS.nonGoalsChars).default(''),
    scope: workScopeSchema.default({}),
    risk_tier: z.enum(WORK_RISK_TIERS).default('medium'),
    artifact_kind: z.enum(WORK_ARTIFACT_KINDS).nullable().default(null),
    context_refs: z.array(workContextRefSchema).max(WORK_LIMITS.contextRefs).default([]),
    acceptance_policy: workAcceptancePolicySchema.default({}),
  })
  .strict();
export type WorkContract = z.infer<typeof workContractSchema>;

/** A partial contract for a patch: only what is named changes. */
export const workContractPatchSchema = z
  .object({
    title: required(WORK_LIMITS.titleChars).optional(),
    goal: text(WORK_LIMITS.goalChars).optional(),
    non_goals: text(WORK_LIMITS.nonGoalsChars).optional(),
    scope: workScopeSchema.optional(),
    risk_tier: z.enum(WORK_RISK_TIERS).optional(),
    artifact_kind: z.enum(WORK_ARTIFACT_KINDS).nullable().optional(),
    context_refs: z.array(workContextRefSchema).max(WORK_LIMITS.contextRefs).optional(),
    acceptance_policy: workAcceptancePolicySchema.optional(),
  })
  .strict();
export type WorkContractPatch = z.infer<typeof workContractPatchSchema>;

const labelSchema = z
  .string()
  .trim()
  .min(1)
  .max(WORK_LIMITS.labelChars)
  .regex(/^[^\u0000-\u001f\u007f,]+$/, 'no commas or control characters');

/** Coordination fields: they never change the contract or its revision. */
export const workCoordinationSchema = z
  .object({
    priority: z.enum(WORK_PRIORITIES).optional(),
    due_at: z.string().datetime({ offset: true }).nullable().optional(),
    labels: z.array(labelSchema).max(WORK_LIMITS.labels).optional(),
  })
  .strict();
export type WorkCoordination = z.infer<typeof workCoordinationSchema>;

/** A person, named the way the console names them. Never a user id typed by a caller. */
const username = z.string().trim().min(1).max(60);

/**
 * A tracker record, named the way people paste it: `#42` (the repository
 * connected to the project), `owner/repo#42`, or the issue's address. A bare
 * number is never one: it reads as any ordinary ticket id.
 */
const externalIssue = required(300);

/**
 * Where a new work item comes from when it starts from a tracker record:
 * `reference` keeps the record beside the work for context, `external_authoritative`
 * lets the record own the title and goal, `imported_native` copies it once and
 * never looks again.
 */
export const workExternalSourceSchema = z
  .object({
    provider: z.enum(WORK_EXTERNAL_PROVIDERS).default('github'),
    issue: externalIssue,
    mode: z.enum(WORK_EXTERNAL_MODES).default('reference'),
  })
  .strict();
export type WorkExternalSource = z.infer<typeof workExternalSourceSchema>;

/**
 * The contract of a create. Title and goal may be left out only when a tracker
 * record supplies them; the refinement on the create schema says so.
 */
const workCreateContractSchema = workContractSchema.extend({
  title: required(WORK_LIMITS.titleChars).optional(),
  goal: text(WORK_LIMITS.goalChars).optional(),
});

export const workCreateSchema = z
  .object({
    request_id: UUID,
    project: required(120),
    contract: workCreateContractSchema,
    criteria: z.array(workCriterionInputSchema).max(WORK_LIMITS.criteria).default([]),
    coordination: workCoordinationSchema.default({}),
    owner: username.nullable().optional(),
    acceptor: username.nullable().optional(),
    external: workExternalSourceSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.external && value.contract.title === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['contract', 'title'], message: 'Required' });
    }
  });
export type WorkCreateInput = z.infer<typeof workCreateSchema>;

const reason = required(WORK_LIMITS.reasonChars);

export const workPatchPayloadSchema = z
  .object({
    contract: workContractPatchSchema.optional(),
    /** The whole list after the change. Keep an id to keep a criterion's identity. */
    criteria: z.array(workCriterionInputSchema).max(WORK_LIMITS.criteria).optional(),
    coordination: workCoordinationSchema.optional(),
    owner: username.nullable().optional(),
    acceptor: username.nullable().optional(),
    change_reason: text(WORK_LIMITS.reasonChars).optional(),
    /** Required, in the same command, when the contract of accepted work changes. */
    reopen_reason: text(WORK_LIMITS.reasonChars).optional(),
  })
  .strict();

export const workTransitionPayloadSchema = z
  .object({ to: z.enum(WORK_TRANSITION_TARGETS), reason: text(WORK_LIMITS.reasonChars).optional() })
  .strict();

export const workLinkPayloadSchema = z
  .object({
    kind: z.enum(WORK_LINK_KINDS),
    target_id: UUID,
    /** Correct an earlier link: it is superseded, never edited or deleted. */
    replaces_link_id: UUID.optional(),
    reason: text(WORK_LIMITS.reasonChars).optional(),
  })
  .strict();

const workRef = z.string().trim().min(1).max(60);

export const workAddDependencyPayloadSchema = z
  .object({
    /** The upstream work, as its id or its key in the same project (`WORK-12`). */
    depends_on: workRef,
    required_spec_revision: z.number().int().positive().optional(),
  })
  .strict();

export const workRemoveDependencyPayloadSchema = z
  .object({ depends_on: workRef, reason: text(WORK_LIMITS.reasonChars).optional() })
  .strict();

export const workSetBlockerPayloadSchema = z
  .object({
    kind: z.enum(WORK_BLOCKER_KINDS),
    reason,
    next_action: required(WORK_LIMITS.nextActionChars),
    owner: username.optional(),
    source_ref: text(300).optional(),
  })
  .strict();

export const workResolveBlockerPayloadSchema = z.object({ blocker_id: UUID, reason }).strict();

/** The `{type, key, access}` claim shape assign_work and start_run take over MCP. */
export const workAssignClaimSchema = z
  .object({
    type: z.enum(CLAIM_RESOURCE_TYPES),
    key: z.string().min(1).max(300),
    access: z.enum(CLAIM_ACCESS_MODES).default('write'),
  })
  .strict();

export const workAssignPayloadSchema = z
  .object({
    to_agent: required(80),
    to: text(60).optional(),
    device: text(80).optional(),
    /** The revision the assignment is pinned to; refused when it is not the current one. */
    expected_spec_revision: z.number().int().positive(),
    brief: z.string().max(8000).optional(),
    next_steps: z.array(z.string().max(500)).max(20).optional(),
    branch: z.string().min(1).max(300).optional(),
    scope: z.array(workAssignClaimSchema).max(50).optional(),
  })
  .strict();

export const workReopenPayloadSchema = z.object({ reason }).strict();
export const workArchivePayloadSchema = z.object({ reason: text(WORK_LIMITS.reasonChars).optional() }).strict();

/**
 * How a work item is tied to a tracker record, one action at a time. Every
 * action is a person's with authority over the work; none writes to the tracker.
 */
export const workReconcileExternalPayloadSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('attach'),
      provider: z.enum(WORK_EXTERNAL_PROVIDERS).default('github'),
      issue: externalIssue,
      /** A copy made once (`imported_native`) is a create; existing work attaches one of these two. */
      mode: z.enum(['reference', 'external_authoritative']).default('reference'),
    })
    .strict(),
  z.object({ action: z.literal('refresh'), ref_id: UUID }).strict(),
  z
    .object({
      action: z.literal('accept_remote'),
      ref_id: UUID,
      /** The remote revision the person looked at; refused when it is not the one waiting. */
      remote_revision: required(200),
      /** Required when the work is accepted: taking the remote change reopens it. */
      reason: text(WORK_LIMITS.reasonChars).optional(),
    })
    .strict(),
  z.object({ action: z.literal('convert_to_reference'), ref_id: UUID, reason: text(WORK_LIMITS.reasonChars).optional() }).strict(),
  z
    .object({
      action: z.literal('detach'),
      ref_id: UUID,
      /** Required when the record owned the title and goal. */
      reason: text(WORK_LIMITS.reasonChars).optional(),
    })
    .strict(),
]);
export type WorkReconcileExternalPayload = z.infer<typeof workReconcileExternalPayloadSchema>;

export const WORK_OPERATIONS = [
  'patch',
  'transition',
  'link',
  'add_dependency',
  'remove_dependency',
  'set_blocker',
  'resolve_blocker',
  'assign',
  'reopen',
  'archive',
  'reconcile_external',
] as const;
export type WorkOperation = (typeof WORK_OPERATIONS)[number];

export const workCommandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('patch'), payload: workPatchPayloadSchema }),
  z.object({ operation: z.literal('transition'), payload: workTransitionPayloadSchema }),
  z.object({ operation: z.literal('link'), payload: workLinkPayloadSchema }),
  z.object({ operation: z.literal('add_dependency'), payload: workAddDependencyPayloadSchema }),
  z.object({ operation: z.literal('remove_dependency'), payload: workRemoveDependencyPayloadSchema }),
  z.object({ operation: z.literal('set_blocker'), payload: workSetBlockerPayloadSchema }),
  z.object({ operation: z.literal('resolve_blocker'), payload: workResolveBlockerPayloadSchema }),
  z.object({ operation: z.literal('assign'), payload: workAssignPayloadSchema }),
  z.object({ operation: z.literal('reopen'), payload: workReopenPayloadSchema }),
  z.object({ operation: z.literal('archive'), payload: workArchivePayloadSchema }),
  z.object({ operation: z.literal('reconcile_external'), payload: workReconcileExternalPayloadSchema }),
]);
export type WorkCommand = z.infer<typeof workCommandSchema>;
export type WorkCommandOf<O extends WorkOperation> = Extract<WorkCommand, { operation: O }>;

/** The envelope every mutation of an existing work item carries. */
export const workEnvelopeSchema = z.object({
  request_id: UUID,
  work_id: UUID,
  expected_version: decimalString,
});

/** One immutable artifact of a delivery. A branch is only ever a label beside a commit. */
export const workArtifactSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('code'),
      repository_identity: required(300),
      commit_sha: z.string().regex(HEX_SHA, 'a full commit SHA'),
      checkpoint_id: UUID.optional(),
      branch: text(300).optional(),
      note: text(WORK_LIMITS.artifactNoteChars).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('document'),
      uri: safeUri,
      provider: text(60).optional(),
      document_id: text(300).optional(),
      version_id: text(200).optional(),
      sha256: z.string().regex(HEX_SHA256, 'a sha256 hex digest').optional(),
      note: text(WORK_LIMITS.artifactNoteChars).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('file'),
      name: required(300),
      sha256: z.string().regex(HEX_SHA256, 'a sha256 hex digest'),
      bytes: z.number().int().nonnegative().optional(),
      note: text(WORK_LIMITS.artifactNoteChars).optional(),
    })
    .strict(),
]);
export type WorkArtifact = z.infer<typeof workArtifactSchema>;

/**
 * Whether an artifact names an exact version. A document link with neither a
 * provider version nor a content digest is `unversioned`: a mutable link is
 * never exact-version evidence.
 */
export const artifactVersionState = (artifact: WorkArtifact): 'exact' | 'unversioned' => {
  if (artifact.kind === 'document') return artifact.version_id || artifact.sha256 ? 'exact' : 'unversioned';
  return 'exact';
};

/** An agent's (or a person's) report about one criterion. Provenance is never part of it. */
export const workEvidenceInputSchema = z
  .object({
    criterion_id: workCriterionIdSchema,
    assertion: z.enum(WORK_ASSERTIONS),
    source_kind: z.enum(['agent_report', 'artifact', 'checkpoint']),
    /** What the report is about: a checkpoint id, an artifact locator, a test name. */
    source_ref: required(500),
    source_version: text(200).optional(),
    excerpt: text(WORK_LIMITS.excerptChars).optional(),
    observed_at: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type WorkEvidenceInput = z.infer<typeof workEvidenceInputSchema>;

export const workSubmitSchema = workEnvelopeSchema
  .extend({
    spec_revision: z.number().int().positive(),
    artifacts: z.array(workArtifactSchema).min(1).max(WORK_LIMITS.artifacts),
    evidence: z.array(workEvidenceInputSchema).max(WORK_LIMITS.criteria * 4).default([]),
    /** The run that produced it, when there is one. Must be the caller's own run on this work. */
    run_id: UUID.optional(),
    note: text(WORK_LIMITS.reasonChars).optional(),
  })
  .strict();
export type WorkSubmitInput = z.infer<typeof workSubmitSchema>;

export const workRecordEvidenceSchema = workEnvelopeSchema
  .extend({
    delivery_id: UUID,
    supersedes_id: UUID.optional(),
  })
  .merge(workEvidenceInputSchema)
  .strict();
export type WorkRecordEvidenceInput = z.infer<typeof workRecordEvidenceSchema>;

/** A person's recorded decision, bound to the exact snapshot they looked at. */
export const workDecisionSchema = z
  .object({
    request_id: UUID,
    expected_version: decimalString,
    spec_revision: z.number().int().positive(),
    delivery_id: UUID,
    evidence_epoch: decimalString,
    evidence_manifest_hash: z.string().regex(HEX_SHA256),
    decision: z.enum(WORK_DECISIONS),
    reason: text(WORK_LIMITS.reasonChars).default(''),
    /** For request_changes: the criteria that are not met. */
    criteria: z.array(workCriterionIdSchema).max(WORK_LIMITS.criteria).default([]),
    /** For human_check criteria: what the acceptor observed, on which artifact version. */
    human_checks: z
      .array(
        z
          .object({
            criterion_id: workCriterionIdSchema,
            assertion: z.enum(['pass', 'fail']),
            artifact_ref: required(500),
            note: required(WORK_LIMITS.excerptChars),
          })
          .strict(),
      )
      .max(WORK_LIMITS.criteria)
      .default([]),
  })
  .strict();
export type WorkDecisionInput = z.infer<typeof workDecisionSchema>;

/** The list views; each is a filter over the same records, never a second state machine. */
export const WORK_VIEWS = ['all', 'mine', 'needs_decision', 'blocked', 'ready', 'in_progress', 'in_review'] as const;
export type WorkView = (typeof WORK_VIEWS)[number];

export const workFilterSchema = z
  .object({
    view: z.enum(WORK_VIEWS).default('all'),
    states: z.array(z.enum(WORK_STATES)).max(WORK_STATES.length).optional(),
    owner: username.optional(),
    label: labelSchema.optional(),
    include_archived: z.boolean().default(false),
  })
  .strict();
export type WorkFilter = z.infer<typeof workFilterSchema>;

/** Sections get_work can open; an allowlist, never a database projection. */
export const WORK_DETAIL_SECTIONS = [
  'contract',
  'criteria',
  'revisions',
  'links',
  'blockers',
  'dependencies',
  'deliveries',
  'evidence',
  'acceptances',
  'external',
  'events',
] as const;
export type WorkDetailSection = (typeof WORK_DETAIL_SECTIONS)[number];

export const WORK_CONTEXT_SECTIONS = ['scope', 'contract', 'criteria', 'blockers', 'active', 'sources'] as const;
export type WorkContextSection = (typeof WORK_CONTEXT_SECTIONS)[number];

export const WORK_ERROR_CODES = [
  'NOT_FOUND',
  'FORBIDDEN',
  'INVALID_INPUT',
  'VERSION_CONFLICT',
  'REQUEST_ID_REUSED',
  'INVALID_TRANSITION',
  'CONTRACT_INCOMPLETE',
  'CONTRACT_CHANGED',
  'EVIDENCE_STALE',
  'SOURCE_UNAVAILABLE',
  'FIELD_OWNED_EXTERNALLY',
  'LIMIT_EXCEEDED',
  'CURSOR_INVALIDATED',
  'CURSOR_EXPIRED',
] as const;
export type WorkErrorCode = (typeof WORK_ERROR_CODES)[number];

/** HTTP status for each code. An id the caller may not see is NOT_FOUND, never FORBIDDEN. */
export const WORK_ERROR_STATUS: Readonly<Record<WorkErrorCode, number>> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  INVALID_INPUT: 400,
  VERSION_CONFLICT: 409,
  REQUEST_ID_REUSED: 409,
  INVALID_TRANSITION: 409,
  CONTRACT_INCOMPLETE: 422,
  CONTRACT_CHANGED: 409,
  EVIDENCE_STALE: 409,
  SOURCE_UNAVAILABLE: 424,
  FIELD_OWNED_EXTERNALLY: 409,
  LIMIT_EXCEEDED: 413,
  CURSOR_INVALIDATED: 409,
  CURSOR_EXPIRED: 410,
};

/** Retrying the same command unchanged can succeed only for these. */
export const WORK_RETRYABLE: ReadonlySet<WorkErrorCode> = new Set(['SOURCE_UNAVAILABLE']);

export type WorkError = {
  code: WorkErrorCode;
  message: string;
  retryable: boolean;
  /** Only when the caller may read the work. */
  current_version?: string;
  fields?: string[];
  next_action?: string;
};

/**
 * What a contract still lacks before it can be `ready`: a human owner and
 * acceptor, a goal, at least one criterion and a target artifact kind. Field
 * names are the wire names, so a refusal can list them as they are typed.
 */
export const missingForReady = (input: {
  goal: string;
  artifactKind: WorkArtifactKind | null;
  criteria: number;
  ownerUserId: string | null;
  acceptorUserId: string | null;
}): string[] => {
  const missing: string[] = [];
  if (!input.ownerUserId) missing.push('owner');
  if (!input.acceptorUserId) missing.push('acceptor');
  if (!input.goal.trim()) missing.push('contract.goal');
  if (input.criteria < 1) missing.push('criteria');
  if (!input.artifactKind) missing.push('contract.artifact_kind');
  return missing;
};

/**
 * Tokens are not counted here: no vendor tokenizer is available server-side, so
 * every budget is in UTF-8 bytes and the token figure is an estimate that says
 * how it was made.
 */
export const WORK_TOKEN_ESTIMATE_METHOD = 'utf8_bytes_div_4';
export const estimateTokens = (bytes: number): number => Math.ceil(bytes / 4);
