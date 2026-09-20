import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db';
import { debugSessions, handoffRequests, tokens } from '../db/schema';
import type { AgentGrant } from '../lib/grants';
import { collaborationAccess } from './collaboration';

type Created = { sessionId: string; response: Record<string, unknown> };
class Refused extends Error {}

/** One transaction for the allowance, brief, run release and notification queue.
 * Lock the credential before looking up a receipt: concurrent retries must not
 * execute the operation twice, including requests which implicitly select a run.
 * Recheck access on replay; a receipt is not a new authorization capability.
 */
export async function createHandoffOnce(
  db: Db,
  userId: string,
  grant: AgentGrant,
  requestKey: string | undefined,
  requestHash: string,
  create: (tx: Db) => Promise<Created | { error: string }>,
): Promise<{ response: Record<string, unknown>; replayed: boolean } | { error: string }> {
  try {
    return await db.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      const [credential] = await tx.select().from(tokens).where(and(
        eq(tokens.id, grant.tokenId), eq(tokens.userId, userId), isNull(tokens.revokedAt),
      )).for('update');
      if (!credential) throw new Refused('This credential is no longer available.');
      if (requestKey) {
        const [previous] = await tx.select({ receipt: handoffRequests, session: debugSessions })
          .from(handoffRequests)
          .innerJoin(debugSessions, eq(debugSessions.id, handoffRequests.sessionId))
          .where(and(eq(handoffRequests.tokenId, grant.tokenId), eq(handoffRequests.requestKey, requestKey)));
        if (previous) {
          if (!(await collaborationAccess(tx, userId, previous.session.teamId, previous.session.projectId, grant)))
            throw new Refused('The original handoff is no longer available in this credential scope.');
          if (previous.receipt.requestHash !== requestHash)
            throw new Refused('This request_id was already used with different arguments. Retry unchanged, or use a new request_id for new work.');
          return { response: previous.receipt.response, replayed: true };
        }
      }
      const result = await create(tx);
      // Throw rather than return: even refusals after a quota check must undo
      // the counter and any lazy project creation performed by this attempt.
      if ('error' in result) throw new Refused(result.error);
      const [session] = await tx.select().from(debugSessions).where(eq(debugSessions.id, result.sessionId));
      if (!session || !(await collaborationAccess(tx, userId, session.teamId, session.projectId, grant)))
        throw new Refused('The handoff is unavailable in this credential scope.');
      if (requestKey) await tx.insert(handoffRequests).values({
        tokenId: grant.tokenId, requestKey, requestHash,
        sessionId: result.sessionId, response: result.response,
      });
      return { response: result.response, replayed: false };
    });
  } catch (error) {
    if (error instanceof Refused) return { error: error.message };
    throw error;
  }
}
