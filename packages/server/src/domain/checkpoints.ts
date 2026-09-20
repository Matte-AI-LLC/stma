import { runCheckpointSchema, type RunCheckpointInput } from '@bridge/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db';
import { agentInstallations, agentRuns, projects, runCheckpoints } from '../db/schema';
import { fingerprintJson } from '../lib/canonical';
import { canonicalRepositoryIdentity } from '../lib/projects';
import { redactSecrets } from '../lib/redact';

type Checkpoint = typeof runCheckpoints.$inferSelect;
type Run = typeof agentRuns.$inferSelect;

const normalizedInput = (input: RunCheckpointInput) => ({
  ...input,
  repositoryIdentity: canonicalRepositoryIdentity(input.repositoryIdentity),
  commitSha: input.commitSha.toLowerCase(),
  tests: input.tests.map((test) => ({
    ...test,
    detail: test.detail ? redactSecrets(test.detail) : undefined,
  })),
});

export async function writeRunCheckpoint(
  db: Db,
  run: Run,
  projectRepositoryIdentity: string | null | undefined,
  raw: RunCheckpointInput,
): Promise<{ checkpoint: Checkpoint; replayed: boolean } | { error: string }> {
  const parsed = runCheckpointSchema.safeParse(raw);
  if (!parsed.success) return { error: 'Invalid checkpoint.' };
  const input = normalizedInput(parsed.data);
  const requestHash = fingerprintJson(input);
  const [previous] = await db
    .select()
    .from(runCheckpoints)
    .where(
      and(eq(runCheckpoints.runId, run.id), eq(runCheckpoints.requestId, input.requestId)),
    )
    .limit(1);
  if (previous) {
    return previous.requestHash === requestHash
      ? ({ checkpoint: previous, replayed: true } as const)
      : ({
          error: 'This checkpoint requestId was already used with different repository facts.',
        } as const);
  }
  if (
    projectRepositoryIdentity &&
    canonicalRepositoryIdentity(projectRepositoryIdentity) !== input.repositoryIdentity
  ) {
    return {
      error: `Checkpoint repository ${input.repositoryIdentity} does not match this project's bound repository ${projectRepositoryIdentity}.`,
    } as const;
  }
  const [checkpoint] = await db
    .insert(runCheckpoints)
    .values({
      runId: run.id,
      teamId: run.teamId,
      projectId: run.projectId,
      installationId: run.installationId,
      kind: input.kind,
      repositoryIdentity: input.repositoryIdentity,
      commitSha: input.commitSha,
      worktreeClean: input.worktreeClean,
      tests: input.tests,
      requestId: input.requestId,
      requestHash,
    })
    .returning();
  return { checkpoint: checkpoint!, replayed: false } as const;
}

export async function recordRunCheckpoint(
  db: Db,
  runId: string,
  userId: string,
  raw: RunCheckpointInput,
): Promise<{ checkpoint: Checkpoint; replayed: boolean } | { error: string }> {
  const parsed = runCheckpointSchema.safeParse(raw);
  if (!parsed.success) return { error: 'Invalid checkpoint.' };

  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const [found] = await tx
      .select({ run: agentRuns, installation: agentInstallations, project: projects })
      .from(agentRuns)
      .innerJoin(agentInstallations, eq(agentRuns.installationId, agentInstallations.id))
      .leftJoin(projects, eq(agentRuns.projectId, projects.id))
      .where(and(eq(agentRuns.id, runId), eq(agentInstallations.userId, userId)))
      .for('update', { of: agentRuns });
    if (!found) return { error: 'Unknown run.' } as const;

    return writeRunCheckpoint(tx, found.run, found.project?.repositoryIdentity, parsed.data);
  });
}

export async function latestRunCheckpoint(
  db: Db,
  runId: string,
  kinds?: Array<'start' | 'delivery' | 'tested'>,
): Promise<Checkpoint | undefined> {
  return (
    await db
      .select()
      .from(runCheckpoints)
      .where(
        and(
          eq(runCheckpoints.runId, runId),
          kinds?.length ? inArray(runCheckpoints.kind, kinds) : undefined,
        ),
      )
      .orderBy(desc(runCheckpoints.createdAt), desc(runCheckpoints.id))
      .limit(1)
  )[0];
}

export function checkpointManifest(checkpoint: Checkpoint | undefined) {
  return checkpoint
    ? {
        id: checkpoint.id,
        kind: checkpoint.kind,
        repositoryIdentity: checkpoint.repositoryIdentity,
        commitSha: checkpoint.commitSha,
        sourceWorktreeClean: checkpoint.worktreeClean,
        tests: checkpoint.tests,
        reportedAt: checkpoint.createdAt.toISOString(),
        provenance: 'client_report' as const,
      }
    : null;
}

export function verifyCheckpointResume(
  checkpoint: Pick<Checkpoint, 'repositoryIdentity' | 'commitSha'>,
  observed: { repositoryIdentity: string; commitSha: string; worktreeClean: boolean },
): { ok: true } | { error: string } {
  const repositoryIdentity = canonicalRepositoryIdentity(observed.repositoryIdentity);
  if (repositoryIdentity !== checkpoint.repositoryIdentity) {
    return {
      error: `Resume repository mismatch: expected ${checkpoint.repositoryIdentity}, observed ${repositoryIdentity}.`,
    };
  }
  if (observed.commitSha.toLowerCase() !== checkpoint.commitSha) {
    return {
      error: `Resume commit mismatch: expected ${checkpoint.commitSha}, observed ${observed.commitSha.toLowerCase()}.`,
    };
  }
  if (!observed.worktreeClean) {
    return {
      error:
        'Resume requires a clean checkout. Preserve local work and ask the human how to proceed; never reset it.',
    };
  }
  return { ok: true };
}
