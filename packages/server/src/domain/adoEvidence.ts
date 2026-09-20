import { and, eq } from 'drizzle-orm';
import { z } from 'zod/v3';
import type { Db } from '../db';
import { repositoryBindings, teamIntegrations } from '../db/schema';
import type { Env } from '../env';
import { parseAdoLocator, readAdoBuild } from '../lib/azureDevops';
import { integrationFor } from './integrations';
import { recordProviderObservation } from './providerEvidence';

// Build REST 7.1. The sourceVersion is the commit actually built, which may be
// a PR merge commit: do not substitute the source branch head. There is no
// workflow run_attempt field here; this fact is build-level, not job-attempt proof.
const buildSchema = z.object({
  id: z.number().int().positive(),
  repository: z.object({ id: z.string().min(1), type: z.literal('TfsGit') }),
  sourceVersion: z.string().regex(/^[a-f0-9]{40}$/i),
  status: z.string(),
  result: z.string().optional(),
  deleted: z.boolean().optional(),
  lastChangedDate: z.string().datetime({ offset: true }),
});

/** Webhooks are hints. Only the configured provider's read-back supplies evidence. */
export async function observeAdoBuild(db: Db, env: Env, teamId: string, bindingId: string, buildId: number) {
  const [found] = await db.select({ binding: repositoryBindings, connection: teamIntegrations })
    .from(repositoryBindings)
    .innerJoin(teamIntegrations, eq(teamIntegrations.id, repositoryBindings.connectionId))
    .where(and(eq(repositoryBindings.id, bindingId), eq(repositoryBindings.teamId, teamId),
      eq(teamIntegrations.teamId, teamId), eq(repositoryBindings.provider, 'azure-devops'),
      eq(teamIntegrations.provider, 'azure-devops')));
  if (!found?.binding.verifiedAt) return { recorded: false, reason: 'repository_not_verified' };
  const locator = parseAdoLocator(found.binding.fullName);
  if (!locator) return { recorded: false, reason: 'invalid_binding' };
  let token: string | undefined;
  try {
    token = (await integrationFor(db, teamId, 'azure-devops', found.connection.repo))?.token;
  } catch {
    return { recorded: false, reason: 'connection_unavailable' };
  }
  if (!token) return { recorded: false, reason: 'connection_unavailable' };
  const read = await readAdoBuild(env, { ...locator, token }, buildId);
  if (!read.ok)
    return {
      recorded: false,
      reason: read.error === 'invalid_build_id' ? 'invalid_build_id' : 'provider_unavailable',
    };
  const parsed = buildSchema.safeParse(read.value);
  if (!parsed.success || parsed.data.id !== buildId || parsed.data.deleted ||
      parsed.data.repository.id !== found.binding.repositoryId)
    return { recorded: false, reason: 'provider_identity_mismatch' };
  const build = parsed.data;
  const state = build.status !== 'completed' ? 'unknown'
    : build.result === 'succeeded' ? 'success'
      : ['failed', 'partiallySucceeded'].includes(build.result ?? '') ? 'failure' : 'unknown';
  return recordProviderObservation(db, teamId, 'azure-devops', {
    bindingId: found.binding.id,
    repositoryId: build.repository.id,
    deliveryId: `ado-read:build:${build.id}:${build.lastChangedDate}`,
    subjectId: `build:${build.id}`,
    commitSha: build.sourceVersion,
    kind: 'workflow', state, attempt: 1,
    observedAt: build.lastChangedDate,
  });
}
