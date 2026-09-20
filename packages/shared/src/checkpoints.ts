import { z } from 'zod/v3';

export const RUN_CHECKPOINT_KINDS = ['start', 'delivery', 'tested'] as const;
export type RunCheckpointKind = (typeof RUN_CHECKPOINT_KINDS)[number];

export const CHECKPOINT_TEST_STATES = ['passed', 'failed', 'not_run'] as const;

/**
 * A client-reported immutable repository observation. It is evidence of what
 * the client reported seeing, never permission to checkout, merge or deploy.
 */
export const runCheckpointSchema = z.object({
  requestId: z.string().uuid(),
  kind: z.enum(RUN_CHECKPOINT_KINDS),
  repositoryIdentity: z.string().trim().min(1).max(300),
  commitSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  worktreeClean: z.boolean(),
  tests: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        state: z.enum(CHECKPOINT_TEST_STATES),
        detail: z.string().trim().max(500).optional(),
      }),
    )
    .max(50)
    .default([]),
});
export type RunCheckpointInput = z.infer<typeof runCheckpointSchema>;
