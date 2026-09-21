import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '../db';
import { agentInstallations, projects, teams, tokens } from '../db/schema';
import { grantLabel, type TokenScope } from '../lib/grants';

/**
 * Companions — which agent a checkout's hooks sit beside.
 *
 * `stma adapter activate` authorizes its own installation: the hooks never read
 * or copy the MCP client's credential, which is the right trust boundary and
 * leaves two installations in one checkout that nothing on the server connects.
 * Three things broke on that gap (found 2026-09-19 writing the lead-first test):
 * the prompt hook was never told about work assigned to the agent beside it,
 * because news is addressed to an installation and the hook asks with another;
 * the adapter was offered as somebody to assign work to, though it cannot call
 * a tool and so can never accept; and a stopped edit named the adapter on the
 * governance page rather than the agent the lead had given the task to.
 *
 * The link is one nullable column, set by the owner and shown wherever it
 * matters. It means "this adapter listens for, and acts beside, that agent".
 *
 * It moves authority in exactly one direction, and that was a decision rather
 * than a drift (2026-09-21): the agent an adapter names may update, finish and
 * hand off the runs that adapter owns — `adapterListensFor` below, read by
 * `lib/grants.ts`. The hook starts the run under the adapter's installation and
 * tells the agent beside it to reuse that `run_id`, and until this the agent's
 * own credential was refused, so the product refused the instruction the product
 * had just given. The consent that opens it was already there: the owner picked
 * this pairing by hand, on the adapter's consent screen or on Agent connections,
 * and `resolveCompanion` checked it there and again at redemption.
 *
 * Nothing else moves, and the shape is what keeps it that way. The column lives
 * on the adapter and points at the agent, so the edge is one-way by
 * construction: an adapter still cannot touch the agent's own runs. It still
 * cannot accept the assignment it hears about — `transitionHandoff` lets only
 * the named installation accept — and it reaches no other project, because a
 * credential's own team/project scope is checked first and is unchanged.
 *
 * Many adapters may name one agent — Codex keeps one MCP identity per machine
 * and an adapter per checkout — but an adapter names at most one, and only an
 * adapter can name anybody, so a chain cannot form.
 */

/** Marks an installation created by the first-party local adapter's OAuth client. */
export const LOCAL_ADAPTER_CAPABILITY = 'local-adapter';

/**
 * The installations table a second time, as "the agent this one sits beside".
 * One named alias for every reader that joins it, so a query never has two
 * unlabelled copies of the table and a reader guessing which is which.
 */
export const companionInstallations = alias(agentInstallations, 'companion_installations');

/** A bound on the select, not an inventory. */
export const COMPANION_CANDIDATE_LIMIT = 100;

/**
 * `stma adapter activate` registers as `STMA local adapter (<target>)`
 * (cli/src/oauthLocal.ts). Self-reported OAuth metadata, like the client type
 * the consent page shows — enough to decide which screen to draw, and the
 * human still approves the pairing by hand.
 */
export function isLocalAdapterClient(clientName: string): boolean {
  return /^STMA local adapter \(/.test(clientName);
}

/** The same marker, read from a row. `capabilities` is free-form jsonb, so it is checked, not cast. */
export function isLocalAdapter(capabilities: unknown): boolean {
  return Array.isArray(capabilities) && capabilities.includes(LOCAL_ADAPTER_CAPABILITY);
}

const isAdapterSql = sql`${agentInstallations.capabilities} @> ${JSON.stringify([LOCAL_ADAPTER_CAPABILITY])}::jsonb`;

/**
 * An installation somebody can give work to: not an adapter, paired or not.
 * An adapter's credential reaches `/api/agent/*` from a hook; nothing drives
 * MCP tools with it, so `update_handoff accept` is a call it will never make.
 */
export const takesWork = and(isNull(agentInstallations.companionOf), sql`not (${isAdapterSql})`);

export interface Reach {
  scope: string;
  teamId: string | null;
  projectId: string | null;
}

/**
 * Two credentials that can meet on at least one project. A personal credential
 * follows its owner's memberships; two team-bound ones need the same team, and
 * two project-bound ones the same project.
 */
export function reachOverlaps(a: Reach, b: Reach): boolean {
  if (a.scope === 'personal' || b.scope === 'personal') return true;
  if (!a.teamId || a.teamId !== b.teamId) return false;
  return !(a.scope === 'project' && b.scope === 'project') || a.projectId === b.projectId;
}

export interface CompanionCandidate extends Reach {
  installationId: string;
  name: string;
  device: string | null;
  client: string;
  lastSeenAt: Date;
  /** "parcel-desk / parcel-desk-api" — what the owner recognises the connection by. */
  access: string;
}

/**
 * The owner's own live agents an adapter may be paired with: credential-bound
 * (an assignment can only ever reach one of those), not revoked, confirmed by
 * their client, and not themselves adapters. Newest-seen first, like the assign
 * picker. "Confirmed" because a connection whose client never loaded it dies
 * when its setup window lapses without ever being revoked — a row that looks
 * live and can never accept anything.
 */
export async function companionCandidates(db: Db, userId: string): Promise<CompanionCandidate[]> {
  const rows = await db
    .select({
      installationId: agentInstallations.id,
      name: agentInstallations.name,
      device: agentInstallations.deviceLabel,
      client: agentInstallations.clientType,
      lastSeenAt: agentInstallations.lastSeenAt,
      scope: tokens.scope,
      teamId: tokens.teamId,
      projectId: tokens.projectId,
      teamSlug: teams.slug,
      projectName: projects.name,
    })
    .from(agentInstallations)
    .innerJoin(tokens, eq(tokens.id, agentInstallations.tokenId))
    .leftJoin(teams, eq(teams.id, tokens.teamId))
    .leftJoin(projects, eq(projects.id, tokens.projectId))
    .where(
      and(
        eq(agentInstallations.userId, userId),
        isNull(agentInstallations.revokedAt),
        isNull(tokens.revokedAt),
        // Legacy credentials have no setup window; enrolled ones must have confirmed.
        or(isNull(tokens.setupExpiresAt), isNotNull(tokens.activatedAt)),
        takesWork,
      ),
    )
    .orderBy(desc(agentInstallations.lastSeenAt))
    .limit(COMPANION_CANDIDATE_LIMIT);
  return rows.map(({ teamSlug, projectName, ...row }) => ({
    ...row,
    access: grantLabel({ scope: row.scope as TokenScope, teamSlug, projectName }),
  }));
}

/**
 * One definition of "may be paired", used by the consent screen, by redemption
 * and by the connections page — so the select never offers what the write
 * refuses.
 */
export async function resolveCompanion(
  db: Db,
  userId: string,
  targetId: string,
  adapterReach: Reach,
): Promise<{ target: CompanionCandidate } | { error: string }> {
  const target = (await companionCandidates(db, userId)).find((c) => c.installationId === targetId);
  if (!target) {
    return {
      error:
        'Choose one of your own connected agents. A revoked connection, another member\'s agent or another adapter cannot be paired.',
    };
  }
  if (!reachOverlaps(target, adapterReach)) {
    return {
      error: `${target.name} is connected to ${target.access} and cannot reach the project this adapter works in. Pair it with an agent connected to the same project or workspace.`,
    };
  }
  return { target };
}

export type PairResult =
  | { ok: true; adapter: { id: string; name: string }; companion: CompanionCandidate | null }
  | { error: string };

/** Pair, re-pair or (with `null`) unpair one of the owner's adapters. */
export async function setCompanion(
  db: Db,
  userId: string,
  adapterId: string,
  targetId: string | null,
): Promise<PairResult> {
  const [adapter] = await db
    .select({
      id: agentInstallations.id,
      name: agentInstallations.name,
      capabilities: agentInstallations.capabilities,
      scope: tokens.scope,
      teamId: tokens.teamId,
      projectId: tokens.projectId,
    })
    .from(agentInstallations)
    .innerJoin(tokens, eq(tokens.id, agentInstallations.tokenId))
    .where(
      and(
        eq(agentInstallations.id, adapterId),
        eq(agentInstallations.userId, userId),
        isNull(agentInstallations.revokedAt),
      ),
    )
    .limit(1);
  if (!adapter) return { error: 'That connection is not one of your live agent connections.' };
  if (!isLocalAdapter(adapter.capabilities)) {
    return {
      error:
        'Only a local adapter can be paired with an agent. This connection is an agent itself; work is assigned to it directly.',
    };
  }
  let companion: CompanionCandidate | null = null;
  if (targetId) {
    const resolved = await resolveCompanion(db, userId, targetId, adapter);
    if ('error' in resolved) return resolved;
    companion = resolved.target;
  }
  await db
    .update(agentInstallations)
    .set({ companionOf: companion?.installationId ?? null })
    .where(eq(agentInstallations.id, adapter.id));
  return { ok: true, adapter: { id: adapter.id, name: adapter.name }, companion };
}

/**
 * How many live adapters listen for each of these agents. Pairing proves an
 * adapter was authorized beside the agent, not that its hooks are still in the
 * checkout or trusted by the client — so callers say "adapter paired", never
 * "guarded".
 */
export async function pairedAdapterCounts(db: Db, installationIds: string[]): Promise<Map<string, number>> {
  if (installationIds.length === 0) return new Map();
  const rows = await db
    .select({ target: agentInstallations.companionOf, n: sql<number>`count(*)` })
    .from(agentInstallations)
    .where(
      and(
        isNotNull(agentInstallations.companionOf),
        inArray(agentInstallations.companionOf, installationIds),
        isNull(agentInstallations.revokedAt),
      ),
    )
    .groupBy(agentInstallations.companionOf);
  return new Map(rows.map((row) => [row.target!, Number(row.n)]));
}

/**
 * Of these agents, the ones whose prompt hook would hear an assignment filed in
 * `projectId` — a live paired adapter can see that project. News reaches a
 * listener only within its own credential's reach (`/api/agent/news`), and
 * adapter consent is project-only, so a pairing says nothing about work filed in
 * another project or in none. `assign_work` used to answer `hookWillAnnounce`
 * from the pairing alone, and said yes about assignments the hook never saw.
 */
export async function agentsHeardIn(
  db: Db,
  agentIds: string[],
  teamId: string,
  projectId: string | null,
): Promise<Set<string>> {
  if (agentIds.length === 0) return new Set();
  const rows = await db
    .select({
      target: agentInstallations.companionOf,
      scope: tokens.scope,
      teamId: tokens.teamId,
      projectId: tokens.projectId,
    })
    .from(agentInstallations)
    .innerJoin(tokens, eq(tokens.id, agentInstallations.tokenId))
    .where(
      and(
        inArray(agentInstallations.companionOf, agentIds),
        isNull(agentInstallations.revokedAt),
        isNull(tokens.revokedAt),
      ),
    );
  return new Set(
    rows
      .filter(
        (row) =>
          row.scope === 'personal' ||
          (row.teamId === teamId && (row.scope !== 'project' || row.projectId === projectId)),
      )
      .map((row) => row.target!),
  );
}

/** A bound on one person's Agent connections page, not a plan ceiling. */
const PAIRING_ROWS = 500;

export interface ConnectionPairing {
  installationId: string;
  /** A local adapter: the one kind of connection that may listen for another. */
  adapter: boolean;
  /** The agent it listens for. `live: false` means that agent was revoked and the pairing is dead weight. */
  companion: { installationId: string; name: string; device: string | null; live: boolean } | null;
  /** Names of the live adapters paired with this connection. */
  adapters: string[];
  /** What this adapter may be paired with — the list `setCompanion` accepts, so the select never offers a refusal. */
  choices: CompanionCandidate[];
}

/** Everything the Agent connections page says about pairing, keyed by the row's token. */
export async function connectionPairings(db: Db, userId: string): Promise<Map<string, ConnectionPairing>> {
  const rows = await db
    .select({
      id: agentInstallations.id,
      tokenId: agentInstallations.tokenId,
      name: agentInstallations.name,
      device: agentInstallations.deviceLabel,
      capabilities: agentInstallations.capabilities,
      companionOf: agentInstallations.companionOf,
      revokedAt: agentInstallations.revokedAt,
      scope: tokens.scope,
      teamId: tokens.teamId,
      projectId: tokens.projectId,
    })
    .from(agentInstallations)
    .innerJoin(tokens, eq(tokens.id, agentInstallations.tokenId))
    .where(eq(agentInstallations.userId, userId))
    .orderBy(desc(agentInstallations.lastSeenAt))
    .limit(PAIRING_ROWS);
  const candidates = await companionCandidates(db, userId);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const pairings = new Map<string, ConnectionPairing>();
  for (const row of rows) {
    const adapter = isLocalAdapter(row.capabilities);
    const beside = row.companionOf ? byId.get(row.companionOf) : undefined;
    const choices = adapter ? candidates.filter((candidate) => reachOverlaps(candidate, row)) : [];
    pairings.set(row.tokenId!, {
      installationId: row.id,
      adapter,
      companion: beside
        ? { installationId: beside.id, name: beside.name, device: beside.device, live: !beside.revokedAt }
        : null,
      adapters: rows
        .filter((other) => other.companionOf === row.id && !other.revokedAt)
        .map((other) => other.name),
      choices,
    });
  }
  return pairings;
}

/**
 * The `agent_installations` row in hand is a live local adapter whose stored
 * companion is this installation. The one definition of the run edge, written
 * once and read by both the guards in `lib/grants.ts` and the tools in
 * `mcp/fleet.ts` that decide which run a call means — a guard that allows what
 * the tool then refuses is worse than either.
 *
 * It is not a second definition of who may be *paired*: `resolveCompanion` is
 * still the only one of those, and it ran when the owner chose and again at
 * redemption. This reads the stored answer back under the rules it was written
 * under, the way `liveCompanion` does, so a row hand-edited into the column or
 * a pairing whose adapter was revoked widens nothing. It says nothing about the
 * owner, because it cannot: every caller already pins one, either by the user
 * id it is querying under or by the join below.
 */
export const adapterListeningFor = (agentInstallationId: string) =>
  and(
    isAdapterSql,
    eq(agentInstallations.companionOf, agentInstallationId),
    isNull(agentInstallations.revokedAt),
  );

/**
 * Is the installation that owns this run an adapter that listens for this
 * credential? The one authorization question a pairing answers (2026-09-21).
 *
 * Asked per call, against the current row, which is the whole answer to what
 * happens when a pairing moves under a live run: unpair or re-point it and the
 * agent is refused from its very next call, with no grandfathering. It keeps
 * nothing either, because the run was never its own — `agent_runs.installation_id`
 * does not move, so every record still names the adapter that reported it.
 */
export async function adapterListensFor(
  db: Db,
  runInstallationId: string,
  credentialInstallationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: agentInstallations.id })
    .from(agentInstallations)
    .innerJoin(companionInstallations, eq(companionInstallations.id, agentInstallations.companionOf))
    .where(
      and(
        eq(agentInstallations.id, runInstallationId),
        eq(companionInstallations.id, credentialInstallationId),
        // One person's on both sides. The guards hold no user id of their own,
        // so this asks the two rows rather than trusting the column.
        eq(agentInstallations.userId, companionInstallations.userId),
        isNull(companionInstallations.revokedAt),
        adapterListeningFor(credentialInstallationId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** The live agent this installation listens for — what the news endpoint asks on behalf of. */
export async function liveCompanion(db: Db, userId: string, companionId: string | null | undefined) {
  if (!companionId) return undefined;
  const [row] = await db
    .select({
      installationId: agentInstallations.id,
      name: agentInstallations.name,
      device: agentInstallations.deviceLabel,
      tokenId: agentInstallations.tokenId,
    })
    .from(agentInstallations)
    .where(
      and(
        eq(agentInstallations.id, companionId),
        // The column is only ever written for the same owner; reading it back
        // under the same rule keeps a hand-edited row from widening anything.
        eq(agentInstallations.userId, userId),
        isNull(agentInstallations.revokedAt),
      ),
    )
    .limit(1);
  return row;
}
