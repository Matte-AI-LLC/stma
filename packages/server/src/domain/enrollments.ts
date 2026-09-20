import type { AgentClientType, AgentRole } from '@bridge/shared';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { generatePat } from '../auth/pat';
import type { Db } from '../db';
import {
  agentEnrollments,
  agentInstallations,
  memberships,
  projects,
  teams,
  tokens,
  users,
} from '../db/schema';
import { randomHex, sha256hex } from '../lib/crypto';
import type { TokenScope } from '../lib/grants';
import { beforeEnrollmentRedeem, enrollmentIssued, enrollmentRedeemed } from '../lib/securityHooks';
import { LOCAL_ADAPTER_CAPABILITY, resolveCompanion, type CompanionCandidate } from './companions';

export const AGENT_ENROLLMENT_TTL_MINUTES = 30;
export const AGENT_ENROLLMENT_PREFIX = 'stma_enroll_';
export const AGENT_SETUP_TTL_MINUTES = 15;
/** `stma connect`: the code only has to survive a copy and a paste. */
export const TERMINAL_CONNECT_TTL_MINUTES = 10;
/** Installation capability: a human ran the first-party CLI in a terminal; no model handled the code. */
export const TERMINAL_CONNECT_CAPABILITY = 'terminal-connect';

export interface CreateAgentEnrollmentInput {
  userId: string;
  name: string;
  deviceLabel: string;
  clientType: AgentClientType;
  role?: AgentRole;
  scope: TokenScope;
  teamId?: string;
  projectId?: string;
  /** A local adapter's consent only: the owner's agent it will listen for. Already checked by the caller. */
  companionOf?: string;
  /** Shorter than the default when the code is pasted straight into a terminal. */
  ttlMinutes?: number;
}

/** Issue one high-entropy code. Only its hash survives the response. */
export async function createAgentEnrollment(db: Db, input: CreateAgentEnrollmentInput) {
  const code = `${AGENT_ENROLLMENT_PREFIX}${randomHex(20)}`;
  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(agentEnrollments)
      .values({
        userId: input.userId,
        codeHash: sha256hex(code),
        codePrefix: code.slice(0, AGENT_ENROLLMENT_PREFIX.length + 6),
        name: input.name,
        deviceLabel: input.deviceLabel,
        clientType: input.clientType,
        role: input.role ?? 'generalist',
        scope: input.scope,
        teamId: input.teamId ?? null,
        projectId: input.projectId ?? null,
        companionOf: input.companionOf ?? null,
        expiresAt: new Date(Date.now() + (input.ttlMinutes ?? AGENT_ENROLLMENT_TTL_MINUTES) * 60_000),
      })
      .returning();
    await enrollmentIssued(tx as unknown as Db, rows[0]!.id, input);
    return { enrollment: rows[0]!, code };
  });
}

type RedeemedEnrollment = {
  enrollment: typeof agentEnrollments.$inferSelect;
  token: string;
  tokenId: string;
  credentialExpiresAt: Date | null;
  setupExpiresAt: Date;
  installation: typeof agentInstallations.$inferSelect;
  /** The agent a local adapter was paired with at consent, if the choice still held. */
  companion: { installationId: string; name: string; device: string | null } | null;
  team: { id: string; slug: string; name: string } | null;
  project: { id: string; slug: string; name: string } | null;
};

type EnrollmentTarget = {
  enrollment: typeof agentEnrollments.$inferSelect;
  team: typeof teams.$inferSelect | null;
  project: typeof projects.$inferSelect | null;
};

async function enrollmentTarget(
  db: Db,
  where: ReturnType<typeof eq>,
): Promise<EnrollmentTarget | undefined> {
  const rows = await db
    .select({ enrollment: agentEnrollments, team: teams, project: projects })
    .from(agentEnrollments)
    .leftJoin(teams, eq(agentEnrollments.teamId, teams.id))
    .leftJoin(projects, eq(agentEnrollments.projectId, projects.id))
    .where(where)
    .limit(1);
  return rows[0];
}

/**
 * Transaction-only redemption primitive shared by the legacy one-use-code API
 * and MCP OAuth's authorization-code exchange. OAuth authenticates the human in
 * the browser and therefore names the already-created enrollment by id; neither
 * path can bypass the same membership, scope, EE and one-use checks below.
 */
export async function redeemAgentEnrollmentByIdInTransaction(
  tx: Db,
  enrollmentId: string,
  userId: string,
  oauth?: { accessExpiresAt: Date; audience: string; localAdapter?: boolean },
  terminal = false,
): Promise<{ ok: true; value: RedeemedEnrollment } | { ok: false }> {
  const found = await enrollmentTarget(tx, eq(agentEnrollments.id, enrollmentId));
  if (
    !found ||
    found.enrollment.userId !== userId ||
    found.enrollment.expiresAt <= new Date()
  ) {
    return { ok: false } as const;
  }
  await beforeEnrollmentRedeem(tx, found.enrollment.id);

  const scope = found.enrollment.scope as TokenScope;
  if (
    !['personal', 'team', 'project'].includes(scope) ||
    (scope !== 'personal' && !found.team) ||
    (scope === 'project' &&
      (!found.project || !found.team || found.project.teamId !== found.team.id))
  ) {
    return { ok: false } as const;
  }
  if (found.team) {
    const membership = await tx
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, found.enrollment.userId),
          eq(memberships.teamId, found.team.id),
        ),
      )
      .limit(1);
    if (!membership[0]) return { ok: false } as const;
  }

  const consumed = await tx
    .update(agentEnrollments)
    .set({ redeemedAt: new Date() })
    .where(
      and(
        eq(agentEnrollments.id, found.enrollment.id),
        isNull(agentEnrollments.redeemedAt),
        isNull(agentEnrollments.revokedAt),
        gt(agentEnrollments.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!consumed[0]) return { ok: false } as const;

  const pat = generatePat();
  const tokenRows = await tx
    .insert(tokens)
    .values({
      userId: found.enrollment.userId,
      name: `${found.enrollment.deviceLabel} · ${found.enrollment.name}`.slice(0, 120),
      scope,
      teamId: found.team?.id ?? null,
      projectId: found.project?.id ?? null,
      tokenHash: pat.hash,
      prefix: pat.prefix,
      audience: oauth?.audience ?? null,
      setupExpiresAt: new Date(Date.now() + AGENT_SETUP_TTL_MINUTES * 60_000),
    })
    .returning();
  let token = tokenRows[0]!;
  const credential = await enrollmentRedeemed(tx, found.enrollment.id, token.id);
  const expiries = [credential.expiresAt, oauth?.accessExpiresAt].filter(
    (value): value is Date => value instanceof Date,
  );
  const effectiveExpiry = expiries.length
    ? new Date(Math.min(...expiries.map((value) => value.getTime())))
    : null;
  if (effectiveExpiry) {
    const updated = await tx
      .update(tokens)
      .set({ expiresAt: effectiveExpiry })
      .where(eq(tokens.id, token.id))
      .returning();
    token = updated[0]!;
  }

  // The pairing was chosen on the consent screen, minutes ago. It is re-checked
  // rather than trusted: an agent revoked in between must not gain a listener,
  // and only an adapter may carry the link at all. A choice that no longer
  // holds is dropped, not fatal — the hooks still install, the adapter says it
  // is unpaired, and the owner pairs it on Agent connections.
  let companion: CompanionCandidate | null = null;
  if (oauth?.localAdapter && found.enrollment.companionOf) {
    const resolved = await resolveCompanion(tx, found.enrollment.userId, found.enrollment.companionOf, {
      scope,
      teamId: found.team?.id ?? null,
      projectId: found.project?.id ?? null,
    });
    if (!('error' in resolved)) companion = resolved.target;
  }

  const installationRows = await tx
    .insert(agentInstallations)
    .values({
      userId: found.enrollment.userId,
      tokenId: token.id,
      name: found.enrollment.name,
      deviceLabel: found.enrollment.deviceLabel,
      clientType: found.enrollment.clientType,
      role: found.enrollment.role ?? 'generalist',
      deviceFingerprint: `enrollment:${found.enrollment.id}`,
      capabilities: [
        'mcp',
        'scoped-enrollment',
        ...(oauth ? ['oauth'] : []),
        ...(oauth?.localAdapter ? [LOCAL_ADAPTER_CAPABILITY] : []),
        ...(terminal ? [TERMINAL_CONNECT_CAPABILITY] : []),
      ],
      companionOf: companion?.installationId ?? null,
    })
    .returning();
  const installation = installationRows[0]!;
  await tx
    .update(agentEnrollments)
    .set({ installationId: installation.id })
    .where(eq(agentEnrollments.id, found.enrollment.id));

  return {
    ok: true,
    value: {
      enrollment: { ...consumed[0], installationId: installation.id },
      token: pat.token,
      tokenId: token.id,
      credentialExpiresAt: effectiveExpiry,
      setupExpiresAt: token.setupExpiresAt!,
      installation,
      companion: companion
        ? { installationId: companion.installationId, name: companion.name, device: companion.device }
        : null,
      team: found.team
        ? { id: found.team.id, slug: found.team.slug, name: found.team.name }
        : null,
      project: found.project
        ? { id: found.project.id, slug: found.project.slug, name: found.project.name }
        : null,
    },
  } as const;
}

/**
 * Consume an enrollment exactly once and bind its credential to one durable
 * installation. The membership check happens at redemption too: leaving a team
 * invalidates a still-open prompt instead of minting stale authority.
 */
export async function redeemAgentEnrollment(
  db: Db,
  rawCode: string,
  terminal = false,
): Promise<{ ok: true; value: RedeemedEnrollment } | { ok: false }> {
  const codeHash = sha256hex(rawCode);
  return db.transaction(async (tx) => {
    const found = await enrollmentTarget(
      tx as unknown as Db,
      eq(agentEnrollments.codeHash, codeHash),
    );
    if (!found) return { ok: false } as const;
    return redeemAgentEnrollmentByIdInTransaction(
      tx as unknown as Db,
      found.enrollment.id,
      found.enrollment.userId,
      undefined,
      terminal,
    );
  });
}

/**
 * What a code would connect, without consuming it. `stma connect` shows this
 * and asks before it redeems: somebody handed a command by a stranger must see
 * whose workspace their agent is about to join. The code is 160 bits, so this
 * answers nothing to a guesser that redemption would not.
 */
export async function previewAgentEnrollment(db: Db, rawCode: string) {
  const found = await enrollmentTarget(db, eq(agentEnrollments.codeHash, sha256hex(rawCode)));
  if (
    !found ||
    found.enrollment.redeemedAt ||
    found.enrollment.revokedAt ||
    found.enrollment.expiresAt <= new Date()
  ) {
    return null;
  }
  const owner = await db
    .select({ username: users.username })
    .from(users)
    .where(eq(users.id, found.enrollment.userId))
    .limit(1);
  return {
    agent: found.enrollment.name,
    device: found.enrollment.deviceLabel,
    clientType: found.enrollment.clientType,
    role: found.enrollment.role ?? 'generalist',
    scope: found.enrollment.scope,
    team: found.team ? { slug: found.team.slug, name: found.team.name } : null,
    project: found.project ? { slug: found.project.slug, name: found.project.name } : null,
    owner: owner[0]?.username ?? null,
    expiresAt: found.enrollment.expiresAt.toISOString(),
  };
}

export async function revokePendingEnrollment(db: Db, userId: string, id: string) {
  return db
    .update(agentEnrollments)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(agentEnrollments.id, id),
        eq(agentEnrollments.userId, userId),
        isNull(agentEnrollments.redeemedAt),
        isNull(agentEnrollments.revokedAt),
      ),
    )
    .returning({ id: agentEnrollments.id });
}
