import { z } from 'zod/v3';

/** Deliberately small first vocabulary; semantic/connector kinds are later investments. */
export const KNOWLEDGE_KINDS = [
  'decision',
  'domain_fact',
  'procedure',
  'reference',
  'known_solution',
] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export const KNOWLEDGE_AUDIENCES = ['workspace_members', 'selected_projects'] as const;
export type KnowledgeAudienceType = (typeof KNOWLEDGE_AUDIENCES)[number];

export const KNOWLEDGE_ITEM_STATES = ['active', 'archived', 'withdrawn', 'deleted'] as const;
export type KnowledgeItemState = (typeof KNOWLEDGE_ITEM_STATES)[number];

export const KNOWLEDGE_SOURCE_TYPES = ['native', 'import'] as const;
export type KnowledgeSourceType = (typeof KNOWLEDGE_SOURCE_TYPES)[number];

export const KNOWLEDGE_ITEM_MAX_BYTES = 64 * 1024;
export const KNOWLEDGE_IMPORT_MAX_FILES = 20;
export const KNOWLEDGE_IMPORT_MAX_BYTES = 1024 * 1024;
export const KNOWLEDGE_CONTEXT_MAX_BYTES = 8 * 1024;
export const KNOWLEDGE_PAGE_MAX = 20;

const stableKey = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(
    /^[a-z0-9][a-z0-9._/-]*$/,
    'use lowercase letters, numbers, dots, dashes, underscores or slashes',
  );

const projectName = z.string().trim().min(1).max(120);

export const knowledgeAudienceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('workspace_members') }),
  z.object({
    type: z.literal('selected_projects'),
    projects: z.array(projectName).min(1).max(20),
  }),
]);
export type KnowledgeAudience = z.infer<typeof knowledgeAudienceSchema>;

export const knowledgeSourceSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('native') }),
    z.object({
      type: z.literal('import'),
      path: z.string().trim().min(1).max(500),
      repository: z.string().trim().min(1).max(300).optional(),
      commit: z.string().regex(/^[a-f0-9]{40,64}$/i).optional(),
      symlink: z.boolean().optional().default(false),
    }),
  ])
  .superRefine((source, context) => {
    if (source.type !== 'import') return;
    if (Boolean(source.repository) !== Boolean(source.commit)) {
      context.addIssue({
        code: 'custom',
        message: 'repository and a full commit SHA must be supplied together',
      });
    }
  });
export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>;

/** One immutable draft proposal. Publishing copies it into an immutable published version. */
export const knowledgeDraftSchema = z.object({
  team: z.string().trim().min(1).max(120),
  stableKey,
  kind: z.enum(KNOWLEDGE_KINDS),
  title: z.string().trim().min(1).max(200),
  body: z.string().min(1),
  audience: knowledgeAudienceSchema,
  source: knowledgeSourceSchema.default({ type: 'native' }),
  validUntil: z.string().datetime({ offset: true }).nullable().optional(),
  reviewAfter: z.string().datetime({ offset: true }).nullable().optional(),
  conflictsWithVersionId: z.string().uuid().nullable().optional(),
  conflictReason: z.string().trim().min(1).max(500).nullable().optional(),
  expectedDraftVersionId: z.string().uuid().nullable().optional(),
}).superRefine((draft, context) => {
  if (Boolean(draft.conflictsWithVersionId) !== Boolean(draft.conflictReason)) {
    context.addIssue({
      code: 'custom',
      message: 'conflictsWithVersionId and conflictReason must be supplied together',
    });
  }
});
export type KnowledgeDraftInput = z.infer<typeof knowledgeDraftSchema>;

export const knowledgeSearchSchema = z.object({
  team: z.string().trim().min(1).max(120),
  project: projectName.optional(),
  query: z.string().trim().min(1).max(200),
  page: z.number().int().min(1).max(50).default(1),
  pageSize: z.number().int().min(1).max(KNOWLEDGE_PAGE_MAX).default(10),
});
export type KnowledgeSearchInput = z.infer<typeof knowledgeSearchSchema>;

export const knowledgeGetSchema = z.object({
  team: z.string().trim().min(1).max(120),
  project: projectName.optional(),
  id: z.string().trim().min(1).max(120),
});
export type KnowledgeGetInput = z.infer<typeof knowledgeGetSchema>;

export const knowledgeContextSchema = z.object({
  team: z.string().trim().min(1).max(120),
  project: projectName.optional(),
  query: z.string().trim().min(1).max(200).optional(),
  maxItems: z.number().int().min(1).max(KNOWLEDGE_PAGE_MAX).default(10),
  /** Optional lifecycle provenance; both are server-authorized before linking. */
  runId: z.string().uuid().optional(),
  checkpointId: z.string().uuid().optional(),
});
export type KnowledgeContextInput = z.infer<typeof knowledgeContextSchema>;

export const knowledgeReceiptSchema = z.object({
  contextId: z.string().uuid(),
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/i),
});
export type KnowledgeReceiptInput = z.infer<typeof knowledgeReceiptSchema>;

export const knowledgePublishSchema = z.object({
  team: z.string().trim().min(1).max(120),
  itemId: z.string().uuid(),
  draftVersionId: z.string().uuid(),
  expectedCurrentVersionId: z.string().uuid().nullable(),
});
export type KnowledgePublishInput = z.infer<typeof knowledgePublishSchema>;

export const knowledgeLifecycleSchema = z.object({
  team: z.string().trim().min(1).max(120),
  itemId: z.string().uuid(),
  expectedCurrentVersionId: z.string().uuid().nullable(),
  state: z.enum(['archived', 'withdrawn']),
});
export type KnowledgeLifecycleInput = z.infer<typeof knowledgeLifecycleSchema>;

export const knowledgeDeleteSchema = z.object({
  team: z.string().trim().min(1).max(120),
  itemId: z.string().uuid(),
  expectedGeneration: z.number().int().min(0),
});
export type KnowledgeDeleteInput = z.infer<typeof knowledgeDeleteSchema>;
