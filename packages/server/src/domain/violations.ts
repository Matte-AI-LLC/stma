import { parseContentRules } from '@bridge/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db';
import { agentEvents, agentInstallations, agentRuns, projects, teams, users } from '../db/schema';
import { addAgentEvent, runForOwner } from './agents';
import { companionInstallations } from './companions';
import { effectivePolicy } from './policies';

/**
 * Policy violations — who tried to break which rule, and where.
 *
 * Until this existed, governance could say whether an agent *received* the
 * rules (the receipt) and nothing about whether it kept them. A lead asking
 * "did anybody put a font in the app that is not in the design system" had no
 * page to look at, and the honest answer was that STMA could not know: content
 * never leaves the machine.
 *
 * It still does not. The local file guard checks the text an edit would add
 * against the team's `content:` deny rules (`shared/contentRules.ts`), stops the
 * edit, and reports two things here — the rule, in the owner's own published
 * words, and the file path. Never the content, and never a rule the server did
 * not publish: the text is matched against the run's current effective policy,
 * so this endpoint cannot be used to write arbitrary sentences into a team's
 * governance page.
 *
 * Two outcomes, and they answer different questions. `blocked` is the guard:
 * an edit that was stopped. `present` is the checkout, read once when the run
 * finishes: the forbidden thing is in the branch anyway. The second exists
 * because the first covers only the supported file tools of a client with the
 * hook installed — a shell redirect, an MCP-only agent, an editor or a
 * generator is outside it — so a lead could see what was stopped and never
 * what landed. Both carry the rule's published words and a path, never content.
 *
 * What this is still not: proof that nothing landed another way. The scan runs
 * in one checkout at the end of one run; work done elsewhere, or after it, is
 * not in it, and the page says so.
 */

/** Events are recorded when they change, not when they are seen — the rule collisions and quota follow. */
export const VIOLATION_DEDUPE_MS = 10 * 60_000;

const LIVE = ['starting', 'active', 'waiting', 'blocked'];

export interface ViolationInput {
  rule: string;
  path: string;
  outcome: 'blocked' | 'present';
}

export async function recordPolicyViolation(
  db: Db,
  runId: string,
  userId: string,
  input: ViolationInput,
) {
  const found = await runForOwner(db, runId, userId);
  if (!found || found.installation.revokedAt || !LIVE.includes(found.run.status)) return undefined;
  const [team] = await db.select().from(teams).where(eq(teams.id, found.run.teamId)).limit(1);
  if (!team) return undefined;
  const policy = await effectivePolicy(db, userId, {
    team: team.slug,
    project: found.project?.name,
    projectId: found.run.projectId,
  });
  if ('error' in policy) return { error: 'policy_unavailable' as const };
  const rule = parseContentRules(policy.document.permissions.deny).find(
    (candidate) => candidate.rule === input.rule.trim(),
  );
  if (!rule) return { error: 'unknown_rule' as const };

  const [latest] = await db
    .select()
    .from(agentEvents)
    .where(and(eq(agentEvents.runId, runId), eq(agentEvents.type, 'policy_violation')))
    .orderBy(desc(agentEvents.createdAt))
    .limit(1);
  const previous = latest?.detail as { rule?: string; path?: string; outcome?: string } | null;
  const deduped = Boolean(
    latest &&
      previous?.rule === rule.rule &&
      previous?.path === input.path &&
      previous?.outcome === input.outcome &&
      Date.now() - latest.createdAt.getTime() < VIOLATION_DEDUPE_MS,
  );
  if (!deduped) {
    await addAgentEvent(db, runId, 'policy_violation', {
      rule: rule.rule,
      path: input.path,
      outcome: input.outcome,
      installationId: found.installation.id,
      policyHash: policy.hash,
    });
  }
  // The hook reports, so the run — and this event — belong to the adapter's
  // installation. A lead reads the feed for the agent they gave the task to, so
  // the line names that agent and says how the report arrived.
  const [beside] = found.installation.companionOf
    ? await db
        .select({ name: agentInstallations.name })
        .from(agentInstallations)
        .where(eq(agentInstallations.id, found.installation.companionOf))
        .limit(1)
    : [];
  return {
    recorded: !deduped,
    deduped,
    rule: rule.rule,
    agentName: beside ? `${beside.name} (via its adapter ${found.installation.name})` : found.installation.name,
    owner: found.owner.username,
    scope: {
      teamId: found.run.teamId,
      projectId: found.run.projectId,
      taskKey: found.run.taskKey,
    },
  };
}

/**
 * Newest first, bounded — the governance card's reader.
 *
 * `agentName` is always the installation that reported, which for a hooked
 * checkout is the local adapter. `companionName` is the agent that adapter is
 * paired with *now*, resolved on read like every other name on the page; the
 * card shows both, so re-pairing an adapter can change who a row is filed
 * beside but never hides who reported it.
 */
export async function recentPolicyViolations(
  db: Db,
  teamId: string,
  limit = 25,
  projectId?: string,
) {
  return db
    .select({
      event: agentEvents,
      run: agentRuns,
      agentName: agentInstallations.name,
      device: agentInstallations.deviceLabel,
      companionName: companionInstallations.name,
      owner: users.username,
      projectName: projects.name,
    })
    .from(agentEvents)
    .innerJoin(agentRuns, eq(agentEvents.runId, agentRuns.id))
    .innerJoin(agentInstallations, eq(agentRuns.installationId, agentInstallations.id))
    .leftJoin(companionInstallations, eq(companionInstallations.id, agentInstallations.companionOf))
    .innerJoin(users, eq(agentInstallations.userId, users.id))
    .leftJoin(projects, eq(agentRuns.projectId, projects.id))
    .where(
      and(
        eq(agentEvents.type, 'policy_violation'),
        eq(agentRuns.teamId, teamId),
        projectId ? eq(agentRuns.projectId, projectId) : undefined,
      ),
    )
    .orderBy(desc(agentEvents.createdAt))
    .limit(limit);
}
