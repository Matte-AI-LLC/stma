import { membershipUser } from '../lib/securityHooks';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db';
import { memberships, teams } from '../db/schema';
import { DAY_MS, hitCounter } from '../lib/counters';
import type { Env } from '../env';
import { cheapestWith, effectiveLimits, planLimits, type PlanLimits } from '../lib/entitlements';
import type { AgentGrant } from '../lib/grants';

/**
 * Reply shape and team resolution, shared by every MCP tool module. Extracted
 * when the fleet tools arrived: they need exactly the same "which team did you
 * mean" answer, and an agent that gets two different phrasings of that question
 * has to learn the surface twice.
 */
/**
 * Where a tool is documented, for a tool that takes a free-form `body`.
 *
 * Claude's connector directory reads a caller-written body as a request to some
 * API and asks the description to name that API's docs; its scan flagged the
 * four tools with a `body` (2026-09-24). The target is STMA itself, and every
 * tool has a row at `/docs#tool-<name>` (held by `layers.test.ts`), so the
 * reference is that row on this server. `claude-connector.test.ts` requires it
 * of every tool whose schema has a `body`.
 */
export function toolReference(baseUrl: string, name: string): string {
  return ` STMA API reference: ${baseUrl}/docs#tool-${name}`;
}

export type ToolText = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export function text(payload: unknown): ToolText {
  return {
    content: [
      {
        type: 'text',
        text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export function err(message: string): ToolText {
  return { ...text(message), isError: true };
}

export async function teamsOf(db: Db, userId: string, grant?: AgentGrant) {
  const rows = await db
    .select({ team: teams, role: memberships.role })
    .from(memberships)
    .innerJoin(teams, eq(memberships.teamId, teams.id))
    .where(
      and(
        membershipUser(userId),
        grant && grant.scope !== 'personal' && grant.teamId
          ? eq(memberships.teamId, grant.teamId)
          : undefined,
      ),
    );
  return rows;
}

export type TeamRow = { team: typeof teams.$inferSelect; role: string };

/**
 * Which team did you mean — and does that team have calls left today?
 *
 * The quota is charged here rather than in the route because this is the one
 * place every team-scoped tool already passes through, and the team row it just
 * read carries the plan. A middleware would need its own query on every request
 * to learn the same thing.
 */
export async function resolveTeam(
  db: Db,
  userId: string,
  slug?: string,
  hosted = true,
  grant?: AgentGrant,
): Promise<TeamRow | { error: string }> {
  const target = await chooseTeam(db, userId, slug, grant);
  if ('error' in target) return target;
  const charged = await chargeTeamDay(db, target.team, hosted);
  return charged ?? target;
}

/**
 * Today's tool call against the team's daily allowance. An upsert of the
 * team's `rate_counters` row, which stays locked until the caller's
 * transaction commits: a transaction that goes on to wait for a Work lock
 * charges after that lock (`assign_work` with `work_id`), or every call in the
 * workspace, all of which charge this row, queues behind it.
 */
export async function chargeTeamDay(
  db: Db,
  team: typeof teams.$inferSelect,
  hosted = true,
): Promise<{ error: string } | null> {
  const allowance = (await effectiveLimits(db, team, hosted)).maxToolCallsPerDay;
  const used = await hitCounter(db, 'team-day', team.id, DAY_MS, allowance);
  if (!used.exceeded) return null;
  return {
    error:
      `Team "${team.slug}" has used its ${allowance.toLocaleString('en-US')} tool calls for today ` +
      `(resets ${used.resetAt.toISOString().slice(11, 16)} UTC). Nothing was written. ` +
      'If this was not a runaway loop, tell your human the team needs a larger plan.',
  };
}

/** Which team did you mean: `resolveTeam` without the charge. */
export async function chooseTeam(
  db: Db,
  userId: string,
  slug?: string,
  grant?: AgentGrant,
): Promise<TeamRow | { error: string }> {
  const mine = await teamsOf(db, userId, grant);
  const target = slug
    ? mine.find((m) => m.team.slug === slug)
    : mine.length === 1
      ? mine[0]
      : undefined;
  if (target) return target;
  const slugs = mine.map((m) => m.team.slug);
  if (slugs.length === 0) {
    return { error: 'You are not a member of any team yet. Create or join one in the dashboard.' };
  }
  // Two different failures, and telling the caller to send the argument it just
  // sent is not one of them: an agent reads that literally and retries with the
  // same value. Naming the slug back discloses nothing — "you are not a member
  // of a team called X" is equally true whether or not X exists.
  return {
    error: slug
      ? `You are not a member of a team called "${slug}". Your teams: ${slugs.join(', ')}.`
      : `You are in ${slugs.length} teams, so name one with the team parameter: ${slugs.join(', ')}.`,
  };
}

/**
 * Is this team's plan allowed to do this at all?
 *
 * Kept next to `resolveTeam` because that is the one place every team-scoped
 * tool already passes through with the plan in hand, so a gate costs no extra
 * query. It answers in the second person and names the cheapest plan that would
 * work: an agent reads the refusal out loud to its human, and "not on your plan"
 * with no way forward is a dead end rather than an answer.
 */
export async function requireFeature(
  db: Db,
  env: Pick<Env, 'hosted'>,
  team: { id: string; plan: string | null; slug: string },
  pick: (limits: PlanLimits) => boolean,
  what: string,
  /** The sentence for a workspace whose own plan row carries the feature; see below. */
  narrowed?: string,
): Promise<{ error: string } | null> {
  const limits = await effectiveLimits(db, team, env.hosted);
  if (pick(limits)) return null;
  // The workspace's own plan row carries it, so something narrowed it on the
  // way here: a composition resolver, or a grant to a smaller plan. Naming the
  // cheapest plan that has it would then be untrue (this workspace may already
  // be on a bigger one), so the answer names no plan.
  if (pick(planLimits(team.plan, env.hosted))) {
    return {
      error:
        `${narrowed ?? `${what} is not included in the plan this workspace is on right now.`} ` +
        'Tell your human: this is their decision, not something to work around.',
    };
  }
  const upgrade = cheapestWith(pick);
  return {
    error:
      `${what} is not part of the ${team.plan ?? 'free'} plan that team "${team.slug}" is on. ` +
      (upgrade
        ? `It is included from the ${upgrade} plan up. Tell your human — this is their decision, not something to work around.`
        : 'Tell your human.'),
  };
}

export { failed } from '../lib/result';
