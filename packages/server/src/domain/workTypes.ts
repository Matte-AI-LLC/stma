import {
  WORK_LIMITS,
  WORK_RETRYABLE,
  type WorkError,
  type WorkErrorCode,
  type WorkState,
} from '@bridge/shared';
import type { ZodTypeAny, z } from 'zod/v3';
import type { Db } from '../db';
import type { workItems } from '../db/schema';
import type { Env } from '../env';
import type { AgentGrant } from '../lib/grants';

/**
 * Who is acting on a work item. Only a browser session is a person: every
 * bearer credential, a person's own PAT included, is an agent principal,
 * because a token that can be pasted into a script cannot stand for somebody
 * looking at a screen. Only `human` may ever record a decision.
 */
export type WorkPrincipal =
  | { kind: 'human'; userId: string }
  | {
      kind: 'agent';
      userId: string;
      installationId: string | null;
      tokenId: string | null;
      grant: AgentGrant;
    };

/**
 * STMA acting on its own, inside another domain's transaction (a provider fact
 * moving the evidence epoch). It has no receipt, no access and no authority:
 * the domain that called it already decided.
 */
export type WorkActor = WorkPrincipal | { kind: 'system' };

export const humanPrincipal = (userId: string): WorkPrincipal => ({ kind: 'human', userId });

/** The agent principal of one authenticated bearer request. */
export const agentPrincipal = (userId: string, grant: AgentGrant): WorkPrincipal => ({
  kind: 'agent',
  userId,
  installationId: grant.installationId,
  tokenId: grant.tokenId,
  grant,
});

/**
 * The durable identity receipts and `created_by_id` are keyed on: the user id
 * for a person, the installation for an agent (it survives OAuth refresh, which
 * rotates the token), and the token only for a legacy credential that has no
 * installation at all.
 */
export const principalId = (principal: WorkPrincipal): string =>
  principal.kind === 'human' ? principal.userId : (principal.installationId ?? principal.tokenId!);

export const actorKind = (actor: WorkActor): 'human' | 'agent' | 'system' => actor.kind;
export const actorId = (actor: WorkActor): string | null =>
  actor.kind === 'system' ? null : principalId(actor);
export const actorUserId = (actor: WorkActor): string | null =>
  actor.kind === 'system' ? null : actor.userId;

/**
 * A refusal carried as an exception, so the transaction it is thrown from rolls
 * back whole: the receipt slot, the counter and every row the command touched.
 * A refused command therefore leaves nothing behind, and the same request id
 * can be retried with a corrected payload.
 */
export class WorkRefusal extends Error {
  constructor(readonly error: WorkRefusalError) {
    super(error.message);
  }
}

/**
 * The wire error plus the two numbers a LIMIT_EXCEEDED refusal reports. The
 * shared contract's WorkError has no field for them; they ride beside it.
 */
export type WorkRefusalError = WorkError & { used?: number; limit?: number };

export type WorkRefusalExtras = Partial<
  Pick<WorkRefusalError, 'current_version' | 'fields' | 'next_action' | 'used' | 'limit'>
>;

/** Builds the error once, so `retryable` always comes from the shared table. */
export function workError(code: WorkErrorCode, message: string, extras: WorkRefusalExtras = {}): WorkRefusalError {
  const error: WorkRefusalError = { code, message, retryable: WORK_RETRYABLE.has(code) };
  if (extras.current_version !== undefined) error.current_version = extras.current_version;
  if (extras.fields?.length) error.fields = extras.fields;
  if (extras.next_action) error.next_action = extras.next_action;
  if (extras.used !== undefined) error.used = extras.used;
  if (extras.limit !== undefined) error.limit = extras.limit;
  return error;
}

/** `throw refuse(...)`: returned rather than thrown so control flow stays visible. */
export const refuse = (code: WorkErrorCode, message: string, extras?: WorkRefusalExtras) =>
  new WorkRefusal(workError(code, message, extras));

/** Every bigint leaves the server as a decimal string, never a JSON number. */
export const wireBigint = (value: bigint): string => value.toString();
export const wireBigintOrNull = (value: bigint | null | undefined): string | null =>
  value === null || value === undefined ? null : value.toString();

/** A decimal string from the wire, or null when it is not one. */
export function parseWireBigint(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)) return null;
  return BigInt(value);
}

/** zod's issue path to the wire spelling a caller typed: `criteria[2].text`. */
export function wirePath(path: readonly (string | number)[], prefix = ''): string {
  let out = prefix;
  for (const part of path) {
    if (typeof part === 'number') out += `[${part}]`;
    else out += out && !out.endsWith('.') ? `.${part}` : part;
  }
  return out.replace(/\.$/, '') || 'input';
}

/**
 * Parse at the domain boundary too. The doors parse first, but a domain
 * function is also called from tests and from other domains, and a refusal
 * that names `criteria[3].text` is only possible where the schema runs.
 */
export function parseOrRefuse<S extends ZodTypeAny>(schema: S, value: unknown, prefix = ''): z.infer<S> {
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    throw refuse('INVALID_INPUT', 'The command is not valid JSON.');
  }
  if (bytes > WORK_LIMITS.commandBytes) {
    throw refuse('LIMIT_EXCEEDED', `The command is ${bytes} bytes; at most ${WORK_LIMITS.commandBytes} are accepted.`, {
      used: bytes,
      limit: WORK_LIMITS.commandBytes,
    });
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.slice(0, 10);
  const fields = [...new Set(issues.map((issue) => wirePath(issue.path, prefix)))];
  const first = issues[0];
  throw refuse(
    'INVALID_INPUT',
    first ? `${wirePath(first.path, prefix)}: ${first.message}` : 'The command does not match its schema.',
    { fields },
  );
}

export type WorkItemRow = typeof workItems.$inferSelect;

/** A person's membership of the workspace the work lives in, as authority reads it. */
export interface WorkAccess {
  role: 'owner' | 'member';
}

/** One event a command writes. The envelope adds the sequence, version and filter fields. */
export interface WorkEventDraft {
  workId: string;
  /** `work_created`, `work_patched`, `work_state_changed`, ... A closed word, never caller text. */
  type: string;
  /** What changed, by id and wire field name, plus short reasons. Never a body. */
  payload: Record<string, unknown>;
}

/** What a handler sees: the locked scope, before it changes anything. */
export interface WorkOpContext {
  actor: WorkActor;
  /** The actor when it is a principal; null for a system actor. */
  principal: WorkPrincipal | null;
  /** The principal's access, re-read inside the transaction; null for a system actor. */
  access: WorkAccess | null;
  teamId: string;
  projectId: string;
  now: Date;
  /** The command's own work as read under lock; null while it is being created. */
  work: WorkItemRow | null;
  /** Every work locked so far, as read under lock before the handler ran. */
  works: ReadonlyMap<string, WorkItemRow>;
  /**
   * Lock one more work of the same project (a dependency's upstream). Safe in
   * any order: every Work path holds the project counter lock first, so two
   * Work transactions in one project never interleave their row locks.
   */
  lockWork(workId: string): Promise<WorkItemRow>;
  /** The next project-local number, for a work this command creates. */
  allocateWorkNumber(): bigint;
  /**
   * The server's environment, when the door that called has one. Only an
   * operation that rides another domain needs it: `assign` meters the handoff
   * allowance and queues the owner's notification exactly as `assign_work` does.
   */
  env?: Env;
}

export interface WorkOpResult {
  events: WorkEventDraft[];
  /**
   * The command changed nothing (a patch naming only what the work already
   * holds): no event, no version step, and the receipt answers with the
   * version it found. Only a command about one existing work may say so.
   */
  unchanged?: true;
  /** Works this command inserted: they start at version 1 and have no `filter_before`. */
  created?: string[];
  /** The row the command produced (a delivery, a blocker, a link), kept on the receipt. */
  resultRef?: string | null;
  /** Extra fields for the successful reply, beside the envelope's own. */
  response?: Record<string, unknown>;
  /**
   * Runs after commit, never inside the transaction: notifications, provider
   * calls. It is handed the committed handle, because the handler only ever saw
   * the transaction's and must not keep using it once that has ended.
   */
  afterCommit?: (db: Db) => Promise<void> | void;
}

/** The reply to every successful command, on every door. */
export interface WorkCommandOutcome {
  work_id: string;
  key: string;
  version: string;
  spec_revision: number;
  /** The last project event this command wrote for the work; null when a replay cannot name it. */
  event_seq: string | null;
  state: WorkState;
  next_actions: string[];
  replayed: boolean;
  /** Present on a replay whose work has moved on since. */
  current_version?: string;
  [extra: string]: unknown;
}

export type WorkResult<T> = T | { error: WorkRefusalError };

/** Turn a thrown refusal into the `{ error }` every door answers with; rethrow anything else. */
export function refusalOf(error: unknown): { error: WorkRefusalError } {
  if (error instanceof WorkRefusal) return { error: error.error };
  throw error;
}
