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

export interface CriticalAuditEvent {
  teamId: string;
  actorId: string;
  action:
    | 'membership_joined'
    | 'policy_published'
    | 'knowledge_published'
    | 'knowledge_archived'
    | 'knowledge_withdrawn'
    | 'knowledge_deleted'
    // Handing STMA a tracker credential, withdrawing it, or changing what it
    // may touch. The subject is `provider:locator` — never the credential, and
    // never a task, list or message.
    | 'integration_connected'
    | 'integration_disconnected'
    | 'integration_scope_changed';
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
