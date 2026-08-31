import {
  mergePolicyDocuments,
  policyDocumentSchema,
  type PolicyDocument,
} from '@bridge/shared';
import { and, desc, eq, max, or, sql } from 'drizzle-orm';
import type { Db } from '../db';
import {
  agentInstallations,
  agentRuns,
  policyBundles,
  policyReceipts,
  projects,
  users,
} from '../db/schema';
import { fingerprintJson } from '../lib/canonical';
import { findOrCreateProject } from '../lib/projects';
import { projectForTeam, teamForUser } from './access';
import { runForOwner } from './agents';

const EMPTY_POLICY = policyDocumentSchema.parse({});

export async function publishPolicy(
  db: Db,
  userId: string,
  input: { team: string; project?: string; document: PolicyDocument },
) {
  const access = await teamForUser(db, userId, input.team);
  if (!access || access.role !== 'owner') return { error: 'Only a team owner can publish policies.' } as const;
  let projectId: string | null = null;
  if (input.project) {
    const found = await findOrCreateProject(db, access.team, input.project, userId);
    if ('error' in found) return { error: found.error } as const;
    projectId = found.project.id;
  }
  const scopeKey = projectId ? `project:${projectId}` : 'team';
  const versionRows = await db
    .select({ version: max(policyBundles.version) })
    .from(policyBundles)
    .where(and(eq(policyBundles.teamId, access.team.id), eq(policyBundles.scopeKey, scopeKey)));
  const version = (versionRows[0]?.version ?? 0) + 1;
  const document = policyDocumentSchema.parse(input.document);
  const hash = fingerprintJson(document);
  const rows = await db
    .insert(policyBundles)
    .values({
      teamId: access.team.id,
      projectId,
      scopeKey,
      version,
      status: 'active',
      document,
      hash,
      createdBy: userId,
    })
    .returning();
  return { policy: rows[0]! } as const;
}

async function latestAtScope(db: Db, teamId: string, scopeKey: string) {
  const rows = await db
    .select()
    .from(policyBundles)
    .where(
      and(
        eq(policyBundles.teamId, teamId),
        eq(policyBundles.scopeKey, scopeKey),
        eq(policyBundles.status, 'active'),
      ),
    )
    .orderBy(desc(policyBundles.version))
    .limit(1);
  return rows[0];
}

export async function effectivePolicy(
  db: Db,
  userId: string,
  input: { team: string; project?: string },
) {
  const access = await teamForUser(db, userId, input.team);
  if (!access) return { error: `You are not a member of team "${input.team}".` } as const;
  const teamPolicy = await latestAtScope(db, access.team.id, 'team');
  let projectPolicy: typeof teamPolicy | undefined;
  let projectId: string | null = null;
  if (input.project) {
    const project = await projectForTeam(db, access.team.id, input.project);
    projectId = project?.id ?? null;
    if (project) projectPolicy = await latestAtScope(db, access.team.id, `project:${project.id}`);
  }
  const teamDocument = teamPolicy
    ? policyDocumentSchema.parse(teamPolicy.document)
    : EMPTY_POLICY;
  const projectDocument = projectPolicy
    ? policyDocumentSchema.parse(projectPolicy.document)
    : undefined;
  const document = mergePolicyDocuments(teamDocument, projectDocument);
  return {
    team: access.team.slug,
    project: input.project ?? null,
    projectId,
    // Say so rather than answering with team-only policy: an agent that mistyped
    // its project would otherwise be told it has no protected paths at all.
    warning:
      input.project && !projectId
        ? `No project "${input.project}" in team "${access.team.slug}" — this is team policy only. Check the name with list_projects.`
        : undefined,
    document,
    hash: fingerprintJson(document),
    sources: [teamPolicy, projectPolicy]
      .filter((p): p is NonNullable<typeof p> => Boolean(p))
      .map((p) => ({ id: p.id, scope: p.scopeKey, version: p.version, hash: p.hash })),
  } as const;
}

/**
 * The newest active bundle of every scope in one team — team policy plus each
 * project override — with the merged document an agent in that scope actually gets.
 *
 * Two bounded queries: one grouped scan for the winning version per scope, then one
 * fetch of exactly those rows. Never a scan of a team's whole policy history.
 */
export async function policyScopes(db: Db, teamId: string, limit = 12) {
  const latest = await db
    .select({ scopeKey: policyBundles.scopeKey, version: max(policyBundles.version) })
    .from(policyBundles)
    .where(and(eq(policyBundles.teamId, teamId), eq(policyBundles.status, 'active')))
    .groupBy(policyBundles.scopeKey)
    // Team scope first: it is the base of every merge, so the cap must never drop it.
    .orderBy(
      sql`case when ${policyBundles.scopeKey} = 'team' then 0 else 1 end`,
      policyBundles.scopeKey,
    )
    .limit(limit);
  if (latest.length === 0) return [];
  const rows = await db
    .select({ bundle: policyBundles, author: users.username, projectName: projects.name })
    .from(policyBundles)
    .leftJoin(users, eq(policyBundles.createdBy, users.id))
    .leftJoin(projects, eq(policyBundles.projectId, projects.id))
    .where(
      and(
        eq(policyBundles.teamId, teamId),
        eq(policyBundles.status, 'active'),
        or(
          ...latest.map((row) =>
            and(
              eq(policyBundles.scopeKey, row.scopeKey),
              eq(policyBundles.version, row.version ?? 0),
            ),
          ),
        ),
      ),
    );
  const team = rows.find((row) => row.bundle.scopeKey === 'team');
  const teamDocument = team ? policyDocumentSchema.parse(team.bundle.document) : EMPTY_POLICY;
  return rows
    .map((row) => {
      const own = policyDocumentSchema.parse(row.bundle.document);
      const document =
        row.bundle.scopeKey === 'team' ? own : mergePolicyDocuments(teamDocument, own);
      return {
        bundle: row.bundle,
        author: row.author,
        label: row.bundle.scopeKey === 'team' ? 'Team' : (row.projectName ?? 'project'),
        isTeam: row.bundle.scopeKey === 'team',
        document,
        hash: fingerprintJson(document),
      };
    })
    .sort((a, b) => (a.isTeam ? -1 : b.isTeam ? 1 : a.label.localeCompare(b.label)));
}

/** Recent policy receipts for a team's runs — what each agent said it applied. */
export async function recentPolicyReceipts(
  db: Db,
  teamId: string,
  limit = 25,
  projectId?: string,
) {
  return db
    .select({
      receipt: policyReceipts,
      run: agentRuns,
      agentName: agentInstallations.name,
      owner: users.username,
      projectName: projects.name,
    })
    .from(policyReceipts)
    .innerJoin(agentRuns, eq(policyReceipts.runId, agentRuns.id))
    .innerJoin(agentInstallations, eq(agentRuns.installationId, agentInstallations.id))
    .innerJoin(users, eq(agentInstallations.userId, users.id))
    .leftJoin(projects, eq(agentRuns.projectId, projects.id))
    .where(
      and(
        eq(agentRuns.teamId, teamId),
        projectId ? eq(agentRuns.projectId, projectId) : undefined,
      ),
    )
    .orderBy(desc(policyReceipts.createdAt))
    .limit(limit);
}

export async function recordPolicyReceipt(
  db: Db,
  userId: string,
  runId: string,
  expectedHash: string,
  reportedHash?: string,
) {
  const found = await runForOwner(db, runId, userId);
  if (!found) return undefined;
  const existing = await db
    .select({ expectedHash: policyReceipts.expectedHash })
    .from(policyReceipts)
    .where(eq(policyReceipts.runId, runId))
    .limit(1);
  // The hash recorded by run start is authoritative; clients may report what they applied but
  // cannot redefine what the server expected.
  const authoritativeExpectedHash = existing[0]?.expectedHash ?? expectedHash;
  // Drift is a deviation, not a silence. Treating "has not answered yet" as drift
  // was defensible while only the CLI could answer; over MCP nothing could, so
  // every MCP-only run was permanently in breach and the badge counted runs
  // rather than problems. `update_run { policy_hash }` is the answer now, and an
  // unanswered receipt is reported as unconfirmed instead — visible on the
  // governance page, not lit up as a rule somebody broke.
  const drift = reportedHash !== undefined && authoritativeExpectedHash !== reportedHash;
  await db
    .insert(policyReceipts)
    .values({
      runId,
      expectedHash: authoritativeExpectedHash,
      reportedHash: reportedHash ?? null,
      drift,
    })
    .onConflictDoUpdate({
      target: policyReceipts.runId,
      set: {
        expectedHash: authoritativeExpectedHash,
        reportedHash: reportedHash ?? null,
        drift,
        createdAt: new Date(),
      },
    });
  await db.update(agentRuns).set({ policyHash: reportedHash ?? null }).where(eq(agentRuns.id, runId));
  return {
    runId,
    expectedHash: authoritativeExpectedHash,
    reportedHash: reportedHash ?? null,
    drift,
    // Attribution for the activity feed; the route strips it from the agent's payload.
    scope: { teamId: found.run.teamId, projectId: found.run.projectId, taskKey: found.run.taskKey },
  };
}
