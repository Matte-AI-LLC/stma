/** Operator-created demo identities are not verified mailboxes or ordinary users. */
import { and, eq, ne } from 'drizzle-orm';
import type { Db } from '../db';
import { memberships } from '../db/schema';
import { reviewAccessActive } from './reviewAccess';

export const TEST_EMAIL_DOMAIN = 'demo.stma.invalid';
export const TEST_ACCOUNT_LOCKED = 'Test accounts are managed by an operator. Their sign-in address, password and workspace cannot be changed here.';
export const TEST_ACCOUNT_UNAVAILABLE = 'This test account is expired or disabled. Ask its operator to renew access.';

export const isTestEmail = (email: string | null | undefined): boolean =>
  Boolean(email && email.trim().toLowerCase().endsWith(`@${TEST_EMAIL_DOMAIN}`));

export interface TestAccountCandidate {
  id: string;
  isTest?: boolean;
  email?: string | null;
  testWorkspaceId?: string | null;
  reviewAccessUntil?: Date | null;
}

/** Fail closed if expired, malformed, or added to another workspace by another writer. */
export async function testAccountAvailable(db: Db, account: TestAccountCandidate): Promise<boolean> {
  if (!account.isTest) return true;
  if (!isTestEmail(account.email) || !account.testWorkspaceId || !reviewAccessActive(account)) return false;
  const foreign = await db.select({ teamId: memberships.teamId }).from(memberships)
    .where(and(eq(memberships.userId, account.id), ne(memberships.teamId, account.testWorkspaceId))).limit(1);
  return foreign.length === 0;
}
