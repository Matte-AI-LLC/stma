import { z } from 'zod/v3';

/** Local foreground execution. Runtime completion is never delivery or acceptance. */
export const EXECUTION_RUNTIME = 'claude-print-v1' as const;
export const EXECUTION_PERMISSION_PROFILE = 'restricted-files-v1' as const;
export const CODEX_EXECUTION_RUNTIME = 'codex-read-only-v1' as const;
export const CODEX_PERMISSION_PROFILE = 'sandbox-read-only-v1' as const;
export const EXECUTION_READONLY_TOOLS = ['whoami', 'get_work', 'get_work_context'] as const;
export const EXECUTION_STATES = ['queued', 'leased', 'starting', 'running', 'needs_input', 'cancel_requested', 'succeeded', 'failed', 'cancelled', 'dispatch_unknown', 'lost'] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];
export const EXECUTION_LEASE_SECONDS = 60;
/** Same closed capability list in the child runtime and server, never provider-fetch or worker control. */
export const EXECUTION_CHILD_TOOLS = ['whoami', 'get_policy', 'get_workflow', 'get_knowledge_context', 'report_knowledge_receipt',
  'get_work', 'get_work_context', 'start_run', 'update_run', 'finish_run', 'update_handoff', 'get_session', 'post_message',
  'submit_work', 'record_work_evidence', 'get_evidence', 'check_environment', 'update_work'] as const;
export const executionConfigureSchema = z.object({
  checkout_path: z.string().min(1).max(2048),
  checkout_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  runtime: z.enum([EXECUTION_RUNTIME, CODEX_EXECUTION_RUNTIME]),
  runtime_version: z.string().min(1).max(80),
  permission_profile: z.enum([EXECUTION_PERMISSION_PROFILE, CODEX_PERMISSION_PROFILE]),
  max_runtime_seconds: z.number().int().min(60).max(3600),
  max_turns: z.number().int().min(1).max(100),
  dedicated: z.literal(true),
}).strict().refine((value) => (value.runtime === EXECUTION_RUNTIME && value.permission_profile === EXECUTION_PERMISSION_PROFILE) || (value.runtime === CODEX_EXECUTION_RUNTIME && value.permission_profile === CODEX_PERMISSION_PROFILE), 'Runtime and permission profile must match.');
export type ExecutionConfigureInput = z.infer<typeof executionConfigureSchema>;
export const executionDispatchSchema = z.object({
  target_id: z.string().uuid(),
  session_id: z.string().uuid(),
  request_id: z.string().uuid(),
}).strict();
export type ExecutionDispatchInput = z.infer<typeof executionDispatchSchema>;
export const executionClaimSchema = z.object({ target_id: z.string().uuid(), worker_id: z.string().uuid() }).strict();
export const executionLeaseSchema = executionClaimSchema.extend({ attempt_id: z.string().uuid(), fence: z.number().int().positive() }).strict();
export type ExecutionLeaseInput = z.infer<typeof executionLeaseSchema>;
export const executionEventSchema = executionLeaseSchema.extend({
  event_id: z.string().uuid(),
  state: z.enum(['starting', 'running', 'needs_input', 'succeeded', 'failed', 'cancelled', 'dispatch_unknown']),
  provider_session_id: z.string().uuid(),
  checkout_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  process_stopped: z.boolean().default(false),
  reason: z.enum(['spawn_intent', 'session_observed', 'turn_completed', 'permission_required', 'auth_required', 'quota_exceeded', 'runtime_failed', 'timeout', 'cancelled', 'lease_lost', 'spawn_unknown', 'worker_stopped']),
  detail: z.string().max(1000).optional(),
}).strict();
export type ExecutionEventInput = z.infer<typeof executionEventSchema>;
export interface ExecutionTargetDto {
  id: string; installation_id: string; installation_name: string; owner_id: string;
  team_id: string; project_id: string; project_name: string;
  checkout_path: string; checkout_fingerprint: string;
  runtime: typeof EXECUTION_RUNTIME | typeof CODEX_EXECUTION_RUNTIME; runtime_version: string;
  permission_profile: typeof EXECUTION_PERMISSION_PROFILE | typeof CODEX_PERMISSION_PROFILE;
  max_runtime_seconds: number; max_turns: number; grant_version: number;
  enabled: boolean; quarantined: boolean; last_seen: string | null;
  readiness: 'available' | 'busy' | 'offline' | 'disabled' | 'quarantined' | 'needs_auth';
  reason: string;
}
export interface ExecutionAttemptDto {
  id: string; fence: number; lease_expires_at: string; provider_session_id: string;
  run_id: string | null; state: ExecutionState; process_stopped: boolean;
}
export interface ExecutionJobDto {
  id: string; target_id: string; session_id: string; state: ExecutionState;
  work_id: string | null; spec_revision: number | null;
  max_runtime_seconds: number; max_turns: number; created_at: string;
  assignment: { task: string; brief: string; branch: string | null; repository_identity: string | null; start_call: Record<string, unknown> };
}
export interface ExecutionClaimDto { job: ExecutionJobDto; attempt: ExecutionAttemptDto; attempt_token: string; child_token?: string; }
export interface ExecutionHeartbeatDto { state: ExecutionState; lease_expires_at: string; cancel_requested: boolean; }
export interface ExecutionDetailDto {
  can_cancel: boolean;
  job: ExecutionJobDto; target: ExecutionTargetDto; attempt: ExecutionAttemptDto | null;
  events: Array<{ id: string; state: string; reason: string; detail: string | null; created_at: string }>;
  result_provenance: 'worker_reported';
  acceptance: 'separate';
}
export type ExecutionResult<T> = T | { error: { code: string; message: string; retryable: boolean } };
