import { z } from 'zod';

export const AGENT_CLIENT_TYPES = [
  'generic',
  'claude-code',
  'codex',
  'cursor',
  'other',
] as const;
export const agentClientTypeSchema = z.enum(AGENT_CLIENT_TYPES);
export type AgentClientType = z.infer<typeof agentClientTypeSchema>;

export const AGENT_RUN_STATUSES = [
  'starting',
  'active',
  'waiting',
  'blocked',
  'completed',
  'failed',
  'stale',
] as const;
export const agentRunStatusSchema = z.enum(AGENT_RUN_STATUSES);
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;

export const ACTIVE_AGENT_RUN_STATUSES = ['starting', 'active', 'waiting', 'blocked'] as const;

export const CLAIM_RESOURCE_TYPES = [
  'path',
  'component',
  'contract',
  'migration',
  'config',
] as const;
export const claimResourceTypeSchema = z.enum(CLAIM_RESOURCE_TYPES);
export type ClaimResourceType = z.infer<typeof claimResourceTypeSchema>;

export const CLAIM_ACCESS_MODES = ['read', 'write'] as const;
export const claimAccessModeSchema = z.enum(CLAIM_ACCESS_MODES);
export type ClaimAccessMode = z.infer<typeof claimAccessModeSchema>;

export const workClaimSchema = z.object({
  resourceType: claimResourceTypeSchema,
  resourceKey: z.string().trim().min(1).max(500),
  access: claimAccessModeSchema.default('write'),
});
export type WorkClaim = z.infer<typeof workClaimSchema>;

/**
 * What an agent's own vendor allowance looks like right now.
 *
 * STMA cannot measure this — only the client knows how much of its Claude/Codex
 * window it has burned. So the agent reports it and the fleet reacts: the map
 * shows who is about to run out, and the run is told to hand off before it
 * stops mid-task rather than after.
 */
export const QUOTA_STATES = ['ok', 'warning', 'critical'] as const;
export const quotaStateSchema = z.enum(QUOTA_STATES);
export type QuotaState = z.infer<typeof quotaStateSchema>;

/** Report the allowance at these levels and the fleet starts acting on it. */
export const QUOTA_WARNING_PCT = 75;
export const QUOTA_CRITICAL_PCT = 90;

export function quotaStateFor(usedPct: number): QuotaState {
  if (usedPct >= QUOTA_CRITICAL_PCT) return 'critical';
  if (usedPct >= QUOTA_WARNING_PCT) return 'warning';
  return 'ok';
}

/**
 * Where a reported percentage came from.
 *
 * Asked to report its allowance, a real agent with no way to read one produced
 * 25 → 42 → 58 → 65 and labelled them "Codex usage window"; asked afterwards
 * where the numbers came from it said "I estimated them. No file, API,
 * environment variable, or tool output provided those percentages."
 * (2026-08-25.) The percentages were plausible, monotonic and completely
 * invented, and STMA showed them to teammates as that agent's vendor allowance.
 *
 * So the number now travels with its provenance, and `estimate` is the default:
 * an agent that does not say where it read the figure is guessing. STMA records
 * a guess and shows it as a guess, but only a `measured` figure moves the fleet
 * — a handoff triggered at the wrong moment by an invented number costs more
 * than the handoff it was meant to save.
 */
export const QUOTA_SOURCES = ['measured', 'estimate'] as const;
export const quotaSourceSchema = z.enum(QUOTA_SOURCES);
export type QuotaSource = z.infer<typeof quotaSourceSchema>;

export const agentQuotaSchema = z.object({
  /** How much of the current window is spent, 0-100. */
  usedPct: z.number().min(0).max(100),
  /** When the vendor window resets, if the client knows. */
  resetsAt: z.string().datetime().optional(),
  /** What the allowance is called on the client, e.g. "claude 5h window". */
  label: z.string().trim().max(80).optional(),
  /** Read from something real, or guessed. Absent means guessed. */
  source: quotaSourceSchema.default('estimate'),
});
export type AgentQuota = z.infer<typeof agentQuotaSchema>;

/** Client roles, so a policy or a human can tell agents apart by what they do. */
export const AGENT_ROLES = [
  'generalist',
  'implementer',
  'reviewer',
  'tester',
  'planner',
  'ops',
] as const;
export const agentRoleSchema = z.enum(AGENT_ROLES);
export type AgentRole = z.infer<typeof agentRoleSchema>;

export const registerAgentSchema = z.object({
  name: z.string().trim().min(1).max(80),
  clientType: agentClientTypeSchema.default('generic'),
  clientVersion: z.string().trim().max(80).optional(),
  deviceFingerprint: z.string().trim().min(8).max(128),
  capabilities: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
  role: agentRoleSchema.optional(),
});

export const startAgentRunSchema = z.object({
  installationId: z.string().uuid(),
  team: z.string().trim().min(1).max(80),
  project: z.string().trim().min(1).max(120).optional(),
  taskKey: z.string().trim().max(120).optional(),
  intent: z.string().trim().max(2_000).optional(),
  repo: z.string().trim().max(300).optional(),
  branch: z.string().trim().max(300).optional(),
  worktree: z.string().trim().max(500).optional(),
  baseSha: z.string().trim().max(64).optional(),
  claims: z.array(workClaimSchema).max(200).default([]),
  /**
   * Runs that are deliberately parallel attempts at the same task. Agents in one
   * group never warn each other: fanning one prompt across three worktrees is the
   * normal way to work now, and reporting it as three collisions made the radar
   * useless exactly where it was busiest.
   */
  attemptGroup: z.string().trim().min(1).max(120).optional(),
});

export const heartbeatAgentRunSchema = z.object({
  status: z.enum(['active', 'waiting', 'blocked']).optional(),
  claims: z.array(workClaimSchema).max(200).optional(),
  usage: agentQuotaSchema.optional(),
});

export const finishAgentRunSchema = z.object({
  status: z.enum(['completed', 'failed']).default('completed'),
  detail: z.string().trim().max(2_000).optional(),
});

