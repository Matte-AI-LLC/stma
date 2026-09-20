import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod/v3';
import type { Db } from '../db';
import { providerObservations, repositoryBindings } from '../db/schema';

export const providerObservationSchema = z.object({
  bindingId: z.string().uuid().optional(),
  repositoryId: z.string().min(1).max(200),
  deliveryId: z.string().min(1).max(200),
  subjectId: z.string().min(1).max(200),
  commitSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  kind: z.enum(['workflow', 'pull_request']),
  state: z.enum(['success', 'failure', 'open', 'merged', 'closed', 'unknown']),
  attempt: z.number().int().positive().max(1_000_000).default(1),
  observedAt: z.coerce.date(),
});

/** Call only after transport authentication. Never infer repository or commit identity. */
export async function recordProviderObservation(
  db: Db,
  teamId: string,
  provider: string,
  value: unknown,
) {
  const parsed = providerObservationSchema.safeParse(value);
  if (!parsed.success) return { recorded: false, reason: 'incomplete_identity' };
  const input = { ...parsed.data, commitSha: parsed.data.commitSha.toLowerCase() };
  if (input.observedAt.getTime() > Date.now() + 60_000)
    return { recorded: false, reason: 'future_event' };
  return db.transaction(async (tx) => {
    const [binding] = await tx
      .select()
      .from(repositoryBindings)
      .where(
        and(
          eq(repositoryBindings.teamId, teamId),
          eq(repositoryBindings.provider, provider),
          eq(repositoryBindings.repositoryId, input.repositoryId),
          input.bindingId ? eq(repositoryBindings.id, input.bindingId) : undefined,
        ),
      )
      .for('update');
    if (!binding?.verifiedAt) return { recorded: false, reason: 'repository_not_verified' };
    const [previous] = await tx
      .select()
      .from(providerObservations)
      .where(
        and(
          eq(providerObservations.bindingId, binding.id),
          eq(providerObservations.kind, input.kind),
          eq(providerObservations.subjectId, input.subjectId),
          eq(providerObservations.commitSha, input.commitSha),
        ),
      )
      .orderBy(desc(providerObservations.attempt), desc(providerObservations.observedAt))
      .limit(1);
    if (
      previous &&
      (previous.attempt > input.attempt ||
        (previous.attempt === input.attempt && previous.observedAt > input.observedAt))
    )
      return { recorded: false, reason: 'stale_event' };
    const rows = await tx
      .insert(providerObservations)
      .values({
        bindingId: binding.id,
        projectId: binding.projectId,
        deliveryId: input.deliveryId,
        subjectId: input.subjectId,
        commitSha: input.commitSha.toLowerCase(),
        kind: input.kind,
        state: input.state,
        attempt: input.attempt,
        observedAt: input.observedAt,
      })
      .onConflictDoNothing()
      .returning({ id: providerObservations.id });
    return {
      recorded: rows.length === 1,
      reason: rows.length ? 'observed' : 'duplicate',
      bindingId: binding.id,
    };
  });
}

export async function exactProviderEvidence(
  db: Db,
  teamId: string,
  projectId: string | null,
  commitSha: string | null,
) {
  if (!projectId || !commitSha) return [];
  return db
    .select({
      repositoryId: repositoryBindings.repositoryId,
      fullName: repositoryBindings.fullName,
      fact: providerObservations,
    })
    .from(providerObservations)
    .innerJoin(repositoryBindings, eq(providerObservations.bindingId, repositoryBindings.id))
    .where(
      and(
        eq(repositoryBindings.teamId, teamId),
        eq(repositoryBindings.projectId, projectId),
        eq(providerObservations.projectId, projectId),
        eq(providerObservations.commitSha, commitSha.toLowerCase()),
      ),
    )
    .orderBy(desc(providerObservations.observedAt))
    .limit(100);
}
