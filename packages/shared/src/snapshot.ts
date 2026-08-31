import { z } from 'zod';

/**
 * Environment snapshot, v1. Collected by the agent on the developer's machine
 * and pushed to the bridge. Values of environment variables are NEVER part of
 * a snapshot — only their names.
 */
export const snapshotSchema = z.strictObject({
  schemaVersion: z.literal(1).default(1),
  os: z.object({
    platform: z.string().max(40),
    release: z.string().max(120).optional(),
    arch: z.string().max(40),
  }),
  shell: z.string().max(120).optional(),
  /** e.g. { node: "24.1.0", python: "3.12.4" } */
  runtimes: z.record(z.string().max(200)).default({}),
  /** e.g. { npm: "11.6.2", pnpm: "9.0.0" } */
  packageManagers: z.record(z.string().max(200)).default({}),
  lockfiles: z
    .array(z.object({ path: z.string().max(300), hash: z.string().max(128) }))
    .max(50)
    .default([])
    // Comparison keys lockfiles by path, so a repeated path silently kept only
    // the last hash and reported a machine that matched the first one as
    // critical.
    .refine((files) => new Set(files.map((f) => f.path)).size === files.length, {
      message: 'lockfiles must not list the same path twice',
    }),
  /**
   * Names only, never values. Optional rather than defaulted to `[]`: an absent
   * list means "this machine was not asked", and a preflight that cannot tell
   * that from "this machine has nothing" reports every required variable as
   * missing on a snapshot nobody actually inspected.
   */
  envVarNames: z.array(z.string().max(200)).max(1000).optional(),
  git: z
    .object({
      branch: z.string().max(300).optional(),
      sha: z.string().max(64).optional(),
      dirtyFiles: z.array(z.string().max(500)).max(500).default([]),
      aheadBehind: z.string().max(60).optional(),
    })
    .optional(),
  locale: z.string().max(60).optional(),
  timezone: z.string().max(60).optional(),
  collectedAt: z.string().max(40).optional(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
