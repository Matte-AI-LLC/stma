/** Operator-owned fixture identities. They never join a workspace implicitly. */
import { and, count, eq, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { memberships, teams, users } from '../db/schema';
import { hashPassword, randomHex } from './crypto';
import { criticalAudit, SecurityRefusal } from './securityHooks';
import { TEST_EMAIL_DOMAIN, testAccountAvailable } from './testAccounts';

export const TEST_PARTICIPANT_LIMIT = 5;

export async function createTestParticipants(db: Db, input: {
  ownerId: string;
  actorId: string;
  count: number;
  reserved: (username: string, email: string) => boolean;
}) {
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > TEST_PARTICIPANT_LIMIT) {
    throw new SecurityRefusal('Choose between one and five test participants.');
  }
  const [initial] = await db.select().from(users).where(eq(users.id, input.ownerId)).limit(1);
  if (!initial?.isTest || !initial.testWorkspaceId) throw new SecurityRefusal('Choose an isolated test workspace owner.');
  // Expensive password hashing happens outside the workspace transaction.
  const credentials = await Promise.all(Array.from({ length: input.count }, async () => {
    const username = `demo-member-${randomHex(6)}`;
    const email = `${username}@${TEST_EMAIL_DOMAIN}`;
    if (input.reserved(username, email)) throw new SecurityRefusal('A generated identity conflicts with an operator name. Retry.');
    const password = randomHex(20);
    return { username, email, password, passwordHash: await hashPassword(password) };
  }));
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from teams where id = ${initial.testWorkspaceId} for update`);
    const [owner] = await tx.select().from(users).where(eq(users.id, input.ownerId)).limit(1);
    if (!owner?.isTest || owner.testWorkspaceId !== initial.testWorkspaceId || !(await testAccountAvailable(tx as unknown as Db, owner))) {
      throw new SecurityRefusal('The test owner must have current access to its isolated workspace.');
    }
    const [workspace] = await tx.select().from(teams).where(eq(teams.id, owner.testWorkspaceId!)).limit(1);
    const members = await tx.select({ user: users, role: memberships.role }).from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.teamId, owner.testWorkspaceId!));
    if (!workspace || !members.some(m => m.user.id === owner.id && m.role === 'owner') ||
        members.some(m => !m.user.isTest || m.user.testWorkspaceId !== workspace.id)) {
      throw new SecurityRefusal('Participants can only be created for an isolated workspace containing test identities.');
    }
    const [existing] = await tx.select({ n: count() }).from(users).where(and(eq(users.isTest, true), eq(users.testWorkspaceId, workspace.id)));
    if ((existing?.n ?? 0) + input.count > TEST_PARTICIPANT_LIMIT + 1) {
      throw new SecurityRefusal('An isolated test workspace supports at most six fixture identities, including its owner.');
    }
    const created = [];
    for (const credential of credentials) {
      const [participant] = await tx.insert(users).values({
        username: credential.username, email: credential.email, displayName: 'Test participant',
        passwordHash: credential.passwordHash, isTest: true, testWorkspaceId: workspace.id,
        reviewAccessUntil: owner.reviewAccessUntil,
      }).returning({ id: users.id });
      await criticalAudit(tx as unknown as Db, {
        teamId: workspace.id, actorId: input.actorId, action: 'test_account_created', subjectId: participant!.id,
      });
      created.push({ id: participant!.id, username: credential.username, email: credential.email, password: credential.password });
    }
    return { workspace: { id: workspace.id, slug: workspace.slug }, until: owner.reviewAccessUntil!, participants: created };
  });
}
