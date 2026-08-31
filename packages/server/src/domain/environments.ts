import {
  compareSnapshots,
  snapshotSchema,
  type CompareResult,
  type Snapshot,
} from '@bridge/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db';
import {
  agentRuns,
  environmentBaselines,
  environmentChecks,
  projects,
  users,
} from '../db/schema';
import { fingerprintJson } from '../lib/canonical';
import { findOrCreateProject } from '../lib/projects';
import { projectForTeam, teamForUser } from './access';
import { runForOwner } from './agents';
import { effectivePolicy } from './policies';

export async function setEnvironmentBaseline(
  db: Db,
  userId: string,
  input: { team: string; project: string; snapshot: Snapshot },
) {
  const access = await teamForUser(db, userId, input.team);
  if (!access || access.role !== 'owner') {
    return { error: 'Only a team owner can set an environment baseline.' } as const;
  }
  const projectResult = await findOrCreateProject(db, access.team, input.project, userId);
  if ('error' in projectResult) return { error: projectResult.error } as const;
  const snapshot = snapshotSchema.parse(input.snapshot);
  await db
    .update(environmentBaselines)
    .set({ active: false })
    .where(
      and(
        eq(environmentBaselines.teamId, access.team.id),
        eq(environmentBaselines.projectId, projectResult.project.id),
        eq(environmentBaselines.active, true),
      ),
    );
  const rows = await db
    .insert(environmentBaselines)
    .values({
      teamId: access.team.id,
      projectId: projectResult.project.id,
      data: snapshot,
      fingerprint: fingerprintJson(snapshot),
      active: true,
      createdBy: userId,
    })
    .returning();
  return { baseline: rows[0]! } as const;
}

export async function environmentPreflight(
  db: Db,
  userId: string,
  input: { team: string; project: string; runId?: string; snapshot: Snapshot },
) {
  const access = await teamForUser(db, userId, input.team);
  if (!access) return { error: `You are not a member of team "${input.team}".` } as const;
  const project = await projectForTeam(db, access.team.id, input.project);
  if (!project) return { error: `Unknown project "${input.project}".` } as const;
  const rows = await db
    .select()
    .from(environmentBaselines)
    .where(
      and(
        eq(environmentBaselines.teamId, access.team.id),
        eq(environmentBaselines.projectId, project.id),
        eq(environmentBaselines.active, true),
      ),
    )
    .orderBy(desc(environmentBaselines.createdAt))
    .limit(1);
  const snapshot = snapshotSchema.parse(input.snapshot);
  const fingerprint = fingerprintJson(snapshot);
  if (input.runId) {
    const owned = await runForOwner(db, input.runId, userId);
    if (!owned) return { error: 'Unknown agent run.' } as const;
    if (owned.run.teamId !== access.team.id || owned.run.projectId !== project.id) {
      return { error: 'Agent run does not belong to this team/project.' } as const;
    }
    await db
      .update(agentRuns)
      .set({ environmentFingerprint: fingerprint })
      .where(eq(agentRuns.id, input.runId));
  }
  const policyResult = await effectivePolicy(db, userId, {
    team: input.team,
    project: input.project,
  });
  const policy = 'error' in policyResult ? undefined : policyResult.document.environment;
  // Absence of the field is not evidence of absence on the machine. A caller that
  // omitted it — an agent whose own safety review stripped the list before sending,
  // say — would otherwise be told every required variable is missing, and get a
  // blocking `critical` for an environment nobody actually looked at. Same rule the
  // lockfiles already follow: only escalate what was really reported.
  const reported = snapshot.envVarNames;
  const envVarNamesReported = reported !== undefined;
  const missingEnvVarNames = reported
    ? (policy?.requiredEnvVarNames.filter((name) => !reported.includes(name)) ?? [])
    : [];
  const runtimeMismatches = Object.entries(policy?.runtimes ?? {}).flatMap(
    ([runtime, expected]) =>
      snapshot.runtimes[runtime] === expected
        ? []
        : [{ runtime, expected, actual: snapshot.runtimes[runtime] ?? null }],
  );
  const policyViolations = { missingEnvVarNames, runtimeMismatches, envVarNamesReported };
  const violatesPolicy = missingEnvVarNames.length > 0 || runtimeMismatches.length > 0;
  const baseline = rows[0];
  let differences: CompareResult | null = null;
  if (baseline) {
    const parsedBaseline = snapshotSchema.safeParse(baseline.data);
    if (!parsedBaseline.success) {
      return { error: 'Stored baseline has an incompatible schema.' } as const;
    }
    differences = compareSnapshots(parsedBaseline.data, snapshot, {
      a: 'baseline',
      b: 'current',
    });
  }
  // Only a lockfile the baseline actually records counts as critical: a mismatched
  // hash, or one the machine is missing entirely. A lockfile the baseline never
  // listed is worth showing but must not escalate — otherwise a baseline has to
  // enumerate every lockfile in the repo or every machine reads critical, and a
  // radar that cries wolf stops being read.
  const lockfileBreak = (differences?.sections ?? [])
    .filter((section) => section.section === 'lockfiles')
    .some((section) => section.entries.some((entry) => entry.kind !== 'only_b'));
  const critical = violatesPolicy || lockfileBreak;
  const status: EnvironmentCheckStatus = !differences
    ? violatesPolicy
      ? 'critical'
      : 'no_baseline'
    : differences.identical && !violatesPolicy
      ? 'ok'
      : critical
        ? 'critical'
        : 'warning';
  return {
    status,
    fingerprint,
    baselineFingerprint: baseline?.fingerprint ?? null,
    differences,
    policyViolations,
    // Ids the caller needs to record the check and attribute it in the activity
    // feed; the route strips them so the agent-facing payload stays as it was.
    scope: { teamId: access.team.id, projectId: project.id },
  } as const;
}

export type EnvironmentCheckStatus = 'ok' | 'warning' | 'critical' | 'no_baseline';
export type PreflightResult = Extract<
  Awaited<ReturnType<typeof environmentPreflight>>,
  { status: EnvironmentCheckStatus }
>;

/** Plain-language names for the snapshot sections, for a one-line summary. */
const SECTION_WORDS: Record<string, string> = {
  os: 'os',
  runtimes: 'runtimes',
  packageManagers: 'package managers',
  lockfiles: 'lockfiles',
  envVarNames: 'env vars',
  git: 'git',
  system: 'system',
};

/** How many differing sections the one-line summary names before it stops counting. */
const SUMMARY_SECTIONS = 4;

/** One line an owner can read in a table: what this machine actually got wrong. */
export function preflightSummary(result: PreflightResult): string {
  // Policy violations lead: they are the rules this machine broke, not just drift.
  const parts: string[] = [];
  for (const mismatch of result.policyViolations.runtimeMismatches) {
    parts.push(`${mismatch.runtime} ${mismatch.actual ?? 'missing'} ≠ ${mismatch.expected}`);
  }
  if (result.policyViolations.missingEnvVarNames.length > 0) {
    parts.push(`missing ${result.policyViolations.missingEnvVarNames.join(', ')}`);
  } else if (!result.policyViolations.envVarNamesReported) {
    // An unchecked requirement is not a met one, and the line an owner reads
    // should not imply it was.
    parts.push('env var names not reported');
  }
  const sections = (result.differences?.sections ?? []).filter(
    (section) => section.entries.length > 0,
  );
  for (const section of sections.slice(0, SUMMARY_SECTIONS)) {
    parts.push(`${section.entries.length} ${SECTION_WORDS[section.section] ?? section.section}`);
  }
  if (sections.length > SUMMARY_SECTIONS) {
    parts.push(`+${sections.length - SUMMARY_SECTIONS} more`);
  }
  if (parts.length === 0) {
    return result.status === 'no_baseline' ? 'no baseline recorded yet' : 'matches the baseline';
  }
  return parts.join(' · ').slice(0, 300);
}

/**
 * Persist one preflight verdict. Mirrors lib/track: the decision has already been
 * returned to the agent, so a failed insert must never turn it into an error.
 */
export async function recordEnvironmentCheck(
  db: Db,
  input: {
    teamId: string;
    projectId: string;
    userId: string;
    runId?: string | null;
    result: PreflightResult;
  },
): Promise<void> {
  try {
    await db.insert(environmentChecks).values({
      teamId: input.teamId,
      projectId: input.projectId,
      userId: input.userId,
      runId: input.runId ?? null,
      status: input.result.status,
      fingerprint: input.result.fingerprint,
      baselineFingerprint: input.result.baselineFingerprint,
      summary: preflightSummary(input.result),
      details: {
        totalDifferences: input.result.differences?.totalDifferences ?? 0,
        sections: (input.result.differences?.sections ?? []).map((section) => ({
          section: section.section,
          differences: section.entries.length,
        })),
        policyViolations: input.result.policyViolations,
      },
    });
  } catch (err) {
    console.warn(
      '[stma] environment check insert failed:',
      err instanceof Error ? err.message : err,
    );
  }
}

/** How many preflight rows one team keeps — a noisy team can never evict a quiet one. */
export const ENVIRONMENT_CHECK_CAP_PER_TEAM = 200;

/** Trim each team back to its newest rows. Age alone cannot bound a preflight loop. */
export async function trimEnvironmentChecks(
  db: Db,
  cap = ENVIRONMENT_CHECK_CAP_PER_TEAM,
): Promise<void> {
  await db.execute(sql`
    delete from ${environmentChecks} where ${environmentChecks.id} in (
      select id from (
        select ${environmentChecks.id} as id, row_number() over (
          partition by ${environmentChecks.teamId} order by ${desc(environmentChecks.createdAt)}
        ) as rn from ${environmentChecks}
      ) ranked where ranked.rn > ${cap}
    )
  `);
}

/** Active baseline per project for one team, newest first. */
export async function activeBaselines(db: Db, teamId: string, limit = 25, projectId?: string) {
  return db
    .select({
      baseline: environmentBaselines,
      projectName: projects.name,
      author: users.username,
    })
    .from(environmentBaselines)
    .innerJoin(projects, eq(environmentBaselines.projectId, projects.id))
    .leftJoin(users, eq(environmentBaselines.createdBy, users.id))
    .where(
      and(
        eq(environmentBaselines.teamId, teamId),
        eq(environmentBaselines.active, true),
        projectId ? eq(environmentBaselines.projectId, projectId) : undefined,
      ),
    )
    .orderBy(desc(environmentBaselines.createdAt))
    .limit(limit);
}

/**
 * Recent preflight verdicts, criticals first — a critical must not fall out of the
 * window just because a hundred clean machines checked in after it.
 */
export async function recentEnvironmentChecks(
  db: Db,
  teamId: string,
  limit = 25,
  projectId?: string,
) {
  return db
    .select({
      check: environmentChecks,
      projectName: projects.name,
      username: users.username,
      taskKey: agentRuns.taskKey,
    })
    .from(environmentChecks)
    .innerJoin(projects, eq(environmentChecks.projectId, projects.id))
    .leftJoin(users, eq(environmentChecks.userId, users.id))
    .leftJoin(agentRuns, eq(environmentChecks.runId, agentRuns.id))
    .where(
      and(
        eq(environmentChecks.teamId, teamId),
        projectId ? eq(environmentChecks.projectId, projectId) : undefined,
      ),
    )
    .orderBy(
      sql`case when ${environmentChecks.status} = 'critical' then 0 else 1 end`,
      desc(environmentChecks.createdAt),
    )
    .limit(limit);
}
