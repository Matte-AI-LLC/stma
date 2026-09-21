import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db } from '../db';
import { and, eq, type SQL } from 'drizzle-orm';
import { memberships } from '../db/schema';
import type { CreateAgentEnrollmentInput } from '../domain/enrollments';

export interface SecurityPrincipal {
  userId: string;
  sessionId?: string;
  tokenId?: string;
  teamId?: string | null;
  projectId?: string | null;
  path: string;
  method: string;
}

/**
 * Every action core can hand a composition's audit hook, as data.
 *
 * It is a value rather than only a union because the signed export in
 * `ee/src/audit.tsx` publishes a `coverage[]` list, and that list was
 * hand-maintained beside this union: adding an action needed two edits in two
 * trees, and when the three `integration_*` actions arrived in 2026-09-20's
 * change only one of the two was made. Measured on this branch: the export
 * claimed seven actions while ten were being written, so a customer reading
 * `coverage` was told their integration credential changes were not audited
 * when they were. `coverage` is derived from this array now, and
 * `admin-history.test.ts` fails if a hand-written list appears again.
 */
export const CRITICAL_AUDIT_ACTIONS = [
  'membership_joined',
  'policy_published',
  'knowledge_published',
  'knowledge_archived',
  'knowledge_withdrawn',
  'knowledge_deleted',
  // Handing STMA a tracker credential, withdrawing it, or changing what it
  // may touch. The subject is `provider:locator` — never the credential, and
  // never a task, list or message.
  'integration_connected',
  'integration_disconnected',
  'integration_scope_changed',
] as const;
export type CriticalAuditAction = (typeof CRITICAL_AUDIT_ACTIONS)[number];

/**
 * Membership *removal* is deliberately not in that list.
 *
 * `criticalAudit` is a no-op without a composition — core alone writes nothing
 * — while the reader for "who lost access to this workspace" is the operator at
 * `/admin`, which is core. And `ee_audit_events` is chained per team, so one
 * organization deprovisioning across five workspaces would be five chains with
 * nothing tying them together. That record is `lib/memberships` instead, which
 * is core, spans workspaces, and carries the `group_id` that makes one act one
 * query. Adding the actions here as well would give two records to drift apart
 * and put membership churn into an export whose stated coverage is deliberately
 * narrow; if a customer asks for it, the array above is where it goes.
 */
export interface CriticalAuditEvent {
  teamId: string;
  actorId: string;
  action: CriticalAuditAction;
  subjectId: string;
}
export interface EnrollmentCredentialMetadata {
  /** Null means the core credential has no automatic expiry and lasts until revoked/access loss. */
  expiresAt: Date | null;
}
export interface SecurityHooks {
  /** Must write on the supplied transaction. Throwing rolls back the mutation. */
  audit?: (db: Db, event: CriticalAuditEvent) => Promise<void>;
  membershipFilter?: (userId: string, principal?: SecurityPrincipal) => SQL | undefined;
  authorize?: (
    db: Db,
    principal: SecurityPrincipal,
    operation: string,
    args?: Record<string, unknown>,
  ) => Promise<string | null>;
  enrollmentIssued?: (
    db: Db,
    id: string,
    input: CreateAgentEnrollmentInput,
    principal?: SecurityPrincipal,
  ) => Promise<void>;
  enrollmentRedeemed?: (
    db: Db,
    id: string,
    tokenId: string,
  ) => Promise<EnrollmentCredentialMetadata | void>;
  beforeEnrollmentRedeem?: (db: Db, id: string) => Promise<void>;
  notificationAllowed?: (
    db: Db,
    input: { userId: string; teamId: string; projectId: string | null },
  ) => Promise<boolean>;
  accountDeleted?: (db: Db, userId: string) => Promise<void>;
}
const context = new AsyncLocalStorage<{ hooks: SecurityHooks; principal?: SecurityPrincipal }>();
export const withSecurityHooks = <T>(hooks: SecurityHooks, fn: () => T): T =>
  context.run({ hooks }, fn);
export const criticalAudit = async (db: Db, event: CriticalAuditEvent) => {
  await context.getStore()?.hooks.audit?.(db, event);
};
export const setSecurityPrincipal = (principal: SecurityPrincipal) => {
  const state = context.getStore();
  if (state) state.principal = principal;
};
export const membershipUser = (userId: string) =>
  and(
    eq(memberships.userId, userId),
    context.getStore()?.hooks.membershipFilter?.(userId, context.getStore()?.principal),
  )!;
export const authorizeSecurity = async (
  db: Db,
  operation: string,
  args?: Record<string, unknown>,
) => {
  const state = context.getStore();
  return state?.principal
    ? ((await state.hooks.authorize?.(db, state.principal, operation, args)) ?? null)
    : null;
};
export class SecurityRefusal extends Error {}
export const enrollmentIssued = async (db: Db, id: string, input: CreateAgentEnrollmentInput) => {
  await context.getStore()?.hooks.enrollmentIssued?.(db, id, input, context.getStore()?.principal);
};
export const enrollmentRedeemed = async (db: Db, id: string, tokenId: string) => {
  return (await context.getStore()?.hooks.enrollmentRedeemed?.(db, id, tokenId)) ?? { expiresAt: null };
};
export const beforeEnrollmentRedeem = async (db: Db, id: string) => {
  await context.getStore()?.hooks.beforeEnrollmentRedeem?.(db, id);
};
export const notificationAllowed = async (
  db: Db,
  input: { userId: string; teamId: string; projectId: string | null },
) => (await context.getStore()?.hooks.notificationAllowed?.(db, input)) ?? true;
export const accountDeleted = async (db: Db, userId: string) => {
  await context.getStore()?.hooks.accountDeleted?.(db, userId);
};
