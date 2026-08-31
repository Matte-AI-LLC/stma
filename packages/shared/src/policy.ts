import { z } from 'zod';
import { CLAIM_RESOURCE_TYPES } from './agents';

export const policyDocumentSchema = z.object({
  guidance: z.array(z.string().trim().min(1).max(2_000)).max(200).default([]),
  permissions: z
    .object({
      deny: z.array(z.string().trim().min(1).max(500)).max(200).default([]),
      requireApproval: z.array(z.string().trim().min(1).max(500)).max(200).default([]),
    })
    .default({ deny: [], requireApproval: [] }),
  requiredChecks: z.array(z.string().trim().min(1).max(500)).max(200).default([]),
  protectedPaths: z.array(z.string().trim().min(1).max(500)).max(200).default([]),
  environment: z
    .object({
      requiredEnvVarNames: z.array(z.string().trim().min(1).max(200)).max(500).default([]),
      runtimes: z.record(z.string().trim().max(200)).default({}),
    })
    .default({ requiredEnvVarNames: [], runtimes: {} }),
  /**
   * How much a run may do on this ground before a person is in the loop.
   *
   * "Allow the agent or don't" is too coarse to be useful: the same agent that
   * should freely edit a test file should not quietly rewrite a migration
   * chain. The tier belongs to the *work*, not to the agent — so it is declared
   * per claim type, which is the only thing a run states before it starts.
   *
   * This tells; it does not block. Claims are advisory here by design, and a
   * gate an agent can route around is worse than a sentence it can read.
   */
  autonomy: z
    .object({
      /** Claim types a run must get a human to agree to before changing. */
      requireApprovalFor: z.array(z.enum(CLAIM_RESOURCE_TYPES)).max(8).default([]),
    })
    .default({ requireApprovalFor: [] }),
  /**
   * Small batches, as a rule rather than as advice.
   *
   * DORA's clearest countermeasure to AI-sized changes is keeping them small,
   * and the cheapest moment to say so is before the work starts — the run has
   * already declared its scope by then, so the number is knowable and the
   * suggestion ("split it") is still free to act on.
   *
   * 0 means no budget, which is the default: a limit nobody chose should not
   * start warning people.
   */
  changeBudget: z
    .object({
      /** Total claims one run may declare. */
      maxScopeItems: z.number().int().min(0).max(200).default(0),
      /** Path claims specifically — the ones that turn into review minutes. */
      maxPaths: z.number().int().min(0).max(200).default(0),
    })
    .default({ maxScopeItems: 0, maxPaths: 0 }),
});
export type PolicyDocument = z.infer<typeof policyDocumentSchema>;

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** Smaller of two budgets, treating 0 as "not set" rather than "nothing allowed". */
function tighter(a: number, b: number): number {
  if (a === 0) return b;
  if (b === 0) return a;
  return Math.min(a, b);
}

/** Team policy first, then project policy additions/overrides. */
export function mergePolicyDocuments(
  base: PolicyDocument,
  override?: PolicyDocument,
): PolicyDocument {
  if (!override) return base;
  return {
    guidance: unique([...base.guidance, ...override.guidance]),
    permissions: {
      deny: unique([...base.permissions.deny, ...override.permissions.deny]),
      requireApproval: unique([
        ...base.permissions.requireApproval,
        ...override.permissions.requireApproval,
      ]),
    },
    requiredChecks: unique([...base.requiredChecks, ...override.requiredChecks]),
    protectedPaths: unique([...base.protectedPaths, ...override.protectedPaths]),
    environment: {
      requiredEnvVarNames: unique([
        ...base.environment.requiredEnvVarNames,
        ...override.environment.requiredEnvVarNames,
      ]),
      runtimes: { ...base.environment.runtimes, ...override.environment.runtimes },
    },
    autonomy: {
      // Union, like every other list here: a project may add ground that needs a
      // person, never remove ground the team decided needs one.
      requireApprovalFor: unique([
        ...base.autonomy.requireApprovalFor,
        ...override.autonomy.requireApprovalFor,
      ]),
    },
    changeBudget: {
      // The tighter number wins, and 0 means "unset" rather than "zero allowed",
      // so a project can impose a budget the team did not and neither can
      // accidentally lift one by leaving a field blank.
      maxScopeItems: tighter(base.changeBudget.maxScopeItems, override.changeBudget.maxScopeItems),
      maxPaths: tighter(base.changeBudget.maxPaths, override.changeBudget.maxPaths),
    },
  };
}

