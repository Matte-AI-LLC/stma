import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod/v3';
import type { Db } from '../db';
import { providerObservations, repositoryBindings, teams } from '../db/schema';
import { noteProviderObservation } from './workEvidence';

export const providerObservationSchema = z.object({
  bindingId: z.string().uuid().optional(),
  repositoryId: z.string().min(1).max(200),
  deliveryId: z.string().min(1).max(200),
  subjectId: z.string().min(1).max(200),
  /**
   * The workflow or pipeline name a person can write into a criterion. It is
   * the provider's own label for the subject, never evidence of anything by
   * itself; a criterion matches it beside the exact `subjectId`.
   */
  subjectName: z.string().min(1).max(200).optional(),
  /**
   * The provider's own id of the workflow or pipeline definition the run
   * belongs to (GitHub's `workflow_id`, Azure DevOps' `definition.id`). A name
   * is not unique: two workflow files may both be called `CI`, and Azure
   * DevOps repeats a pipeline name across folders. Runs of one definition
   * supersede each other; runs of two never do (`evaluateProvider`).
   */
  subjectDefinition: z.string().min(1).max(100).optional(),
  commitSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  kind: z.enum(['workflow', 'pull_request']),
  state: z.enum(['success', 'failure', 'open', 'merged', 'closed', 'unknown']),
  attempt: z.number().int().positive().max(1_000_000).default(1),
  observedAt: z.coerce.date(),
});

/**
 * A provider's name for the subject, made safe to store and show: control
 * characters out, at most 200 characters, absent when nothing is left. An odd
 * or overlong name must never cost the observation itself, which is why this
 * runs before the schema rather than inside it.
 */
function cleanSubjectName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200).trim();
  return cleaned || undefined;
}

/**
 * The provider's id of the workflow or pipeline, as text: a number or a short
 * word of letters, digits, dots, colons and dashes, or absent. Like the name it
 * never costs the observation: a missing or odd one only means the run is
 * grouped with the others of its name, as every run was before ids were kept.
 */
function cleanSubjectDefinition(value: unknown): string | undefined {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === 'string' && /^[\w.:-]{1,100}$/.test(text) ? text : undefined;
}

/** Call only after transport authentication. Never infer repository or commit identity. */
export async function recordProviderObservation(
  db: Db,
  teamId: string,
  provider: string,
  value: unknown,
) {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const parsed = providerObservationSchema.safeParse({
    ...raw,
    subjectName: cleanSubjectName(raw.subjectName),
    subjectDefinition: cleanSubjectDefinition(raw.subjectDefinition),
  });
  if (!parsed.success) return { recorded: false, reason: 'incomplete_identity' };
  const input = { ...parsed.data, commitSha: parsed.data.commitSha.toLowerCase() };
  if (input.observedAt.getTime() > Date.now() + 60_000)
    return { recorded: false, reason: 'future_event' };
  // Native Work's side of a new fact, run once the fact has committed.
  const pending: { afterCommit?: (db: Db) => Promise<void> } = {};
  const result = await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    // The workspace row first, `for key share`: the Work side of a fact inserts
    // events naming the workspace, whose foreign-key check takes exactly this
    // lock, and taken there it came after the binding lock below. A repository
    // rebind takes the workspace `for update` and then the binding, and a hosted
    // disconnect the workspace (its audit) and then the cascade delete of the
    // binding: the opposite order, and a deadlock with this transaction. Taking
    // it here puts every writer in one order, workspace then binding, and costs
    // nothing against another fact or a Work command, whose key share it shares.
    await tx.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)).for('key share');
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
      // `no key update`: it serializes facts for one binding all the same, and
      // this transaction goes on to take Work locks, while it holds this one,
      // so it must not be a lock a foreign-key check could have to wait on.
      .for('no key update');
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
    // The same run attempt seen twice, by the webhook and by the read-back on
    // Repository connections, arrives under two delivery ids and says nothing
    // the first row did not. Recording it again would move the evidence epoch
    // of every work in review on that commit and refuse a decision taken on
    // evidence that has not changed, so it is the duplicate it is. A second
    // sighting that adds a name or a definition the first lacked is a new fact.
    if (
      previous &&
      previous.attempt === input.attempt &&
      previous.observedAt.getTime() === input.observedAt.getTime() &&
      previous.state === input.state &&
      previous.subjectName === (input.subjectName ?? null) &&
      previous.subjectDefinition === (input.subjectDefinition ?? null)
    )
      return { recorded: false, reason: 'duplicate', bindingId: binding.id };
    const rows = await tx
      .insert(providerObservations)
      .values({
        bindingId: binding.id,
        projectId: binding.projectId,
        deliveryId: input.deliveryId,
        subjectId: input.subjectId,
        subjectName: input.subjectName ?? null,
        subjectDefinition: input.subjectDefinition ?? null,
        commitSha: input.commitSha.toLowerCase(),
        kind: input.kind,
        state: input.state,
        attempt: input.attempt,
        observedAt: input.observedAt,
      })
      .onConflictDoNothing()
      .returning({ id: providerObservations.id });
    // A new fact about a commit that is somebody's current delivery moves that
    // work's evidence epoch in this same transaction, so a decision taken on the
    // evidence before it can never commit after it unnoticed. The binding lock
    // above is held; the Work locks taken here are the last ones.
    if (rows.length === 1) {
      const after = await noteProviderObservation(tx, {
        teamId,
        projectId: binding.projectId,
        observationId: rows[0]!.id,
        provider,
        repository: binding.fullName,
        kind: input.kind,
        subjectId: input.subjectId,
        subjectName: input.subjectName ?? null,
        commitSha: input.commitSha,
        state: input.state,
        attempt: input.attempt,
      });
      if (after) pending.afterCommit = after;
    }
    return {
      recorded: rows.length === 1,
      reason: rows.length ? 'observed' : 'duplicate',
      bindingId: binding.id,
    };
  });
  await pending.afterCommit?.(db);
  return result;
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
      provider: repositoryBindings.provider,
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

/**
 * One current fact per exact provider subject. A provider may report several
 * attempts for one workflow or PR; the rows arrive newest first, so the first
 * one per subject is current and a superseded failure cannot sit beside the
 * success that replaced it. Shared by the evidence pack and the handoff thread,
 * so the two never disagree about what the provider said.
 */
export function currentProviderFacts<
  T extends { fact: { bindingId: string; kind: string; subjectId: string } },
>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.fact.bindingId}:${row.fact.kind}:${row.fact.subjectId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
