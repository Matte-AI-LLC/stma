import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod/v3';
import type { Db } from '../db';
import {
  deliveryFlows,
  deliverySetups,
  deliverySetupReceipts,
  teams,
  projects,
} from '../db/schema';
import { fingerprintJson } from '../lib/canonical';
import type { AgentGrant } from '../lib/grants';
import { collaborationAccess } from './collaboration';
import type { agentSetupManifest } from './agentSetup';
import { effectivePolicy } from './policies';

export const setupReceiptSchema = z
  .object({
    schemaVersion: z.literal(2),
    setupId: z.string().regex(/^[a-f0-9]{64}$/),
    flowHash: z.string().regex(/^[a-f0-9]{64}$/),
    policyHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    status: z.enum(['planned', 'complete', 'partial', 'blocked']),
    commitSha: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/i)
      .nullable(),
    repositoryId: z.string().min(1).max(200).nullable(),
    repositoryWrites: z.boolean(),
    providerWrites: z.boolean(),
  })
  .strict();

export async function receiveSetupReceipt(
  db: Db,
  userId: string,
  value: unknown,
  grant?: AgentGrant,
) {
  const parsed = setupReceiptSchema.safeParse(value);
  if (!parsed.success)
    return {
      error: 'Invalid receipt schema. Use schemaVersion 2; omit secrets and free-form logs.',
    };
  const input = parsed.data;
  const [setup] = await db
    .select()
    .from(deliverySetups)
    .where(eq(deliverySetups.id, input.setupId));
  if (!setup || !(await collaborationAccess(db, userId, setup.teamId, setup.projectId, grant)))
    return {
      error:
        'No delivery setup with this setupId is available to this connection. A setup pack is ' +
        "issued from a project's Delivery page (Agent setup), and the receipt repeats the setupId, " +
        'flowHash and policyHash printed in it.',
    };
  const manifest = setup.manifest as ReturnType<typeof agentSetupManifest>;
  if (manifest.flowHash !== input.flowHash || manifest.policyHash !== input.policyHash)
    return { error: 'Receipt does not match the issued setup. Generate a fresh pack.' };
  if (
    manifest.mode === 'plan-only' &&
    (input.repositoryWrites || input.providerWrites || input.status === 'complete')
  )
    return { error: 'Plan-only receipts cannot report writes or implementation completion.' };
  if (manifest.flowVersion !== null) {
    const [current] = await db
      .select()
      .from(deliveryFlows)
      .where(
        and(
          eq(deliveryFlows.teamId, setup.teamId),
          setup.projectId
            ? eq(deliveryFlows.projectId, setup.projectId)
            : isNull(deliveryFlows.projectId),
          eq(deliveryFlows.status, 'active'),
        ),
      )
      .orderBy(desc(deliveryFlows.version))
      .limit(1);
    if (
      !current ||
      current.version !== manifest.flowVersion ||
      fingerprintJson(current.document) !== input.flowHash
    )
      return { error: 'Delivery flow changed or was archived. Generate a fresh pack.' };
  }
  if (manifest.policyHash) {
    const [team] = await db.select().from(teams).where(eq(teams.id, setup.teamId));
    const [project] = setup.projectId
      ? await db.select().from(projects).where(eq(projects.id, setup.projectId))
      : [];
    const policy = await effectivePolicy(db, userId, { team: team!.slug, project: project?.name });
    if ('error' in policy || policy.hash !== manifest.policyHash)
      return { error: 'Effective policy changed. Generate a fresh pack.' };
  }
  const digest = fingerprintJson({ userId, tokenId: grant?.tokenId ?? null, receipt: input });
  await db
    .insert(deliverySetupReceipts)
    .values({ setupId: setup.id, userId, tokenId: grant?.tokenId ?? null, digest, receipt: input })
    .onConflictDoNothing();
  return {
    accepted: true,
    setupId: setup.id,
    provenance: grant ? 'client_report' : 'human_report',
    verification: 'unverified',
    next: 'Review the exact repository and commit through provider observations. A receipt is not permission to merge, an approval or a verified deployment.',
  };
}
