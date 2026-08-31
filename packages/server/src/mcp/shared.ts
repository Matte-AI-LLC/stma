import { eq } from 'drizzle-orm';
import type { Db } from '../db';
import { memberships, teams } from '../db/schema';
import { DAY_MS, hitCounter } from '../lib/counters';
import type { Env } from '../env';
import { cheapestWith, planLimits, type PlanLimits } from '../lib/entitlements';

/**
 * Reply shape and team resolution, shared by every MCP tool module. Extracted
 * when the fleet tools arrived: they need exactly the same "which team did you
 * mean" answer, and an agent that gets two different phrasings of that question
 * has to learn the surface twice.
 */
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

export async function teamsOf(db: Db, userId: string) {
  return db
    .select({ team: teams, role: memberships.role })
    .from(memberships)
    .innerJoin(teams, eq(memberships.teamId, teams.id))
    .where(eq(memberships.userId, userId));
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
): Promise<TeamRow | { error: string }> {
  const mine = await teamsOf(db, userId);
  const target = slug
    ? mine.find((m) => m.team.slug === slug)
    : mine.length === 1
      ? mine[0]
      : undefined;
  if (target) {
    const allowance = planLimits(target.team.plan, hosted).maxToolCallsPerDay;
    const used = await hitCounter(db, 'team-day', target.team.id, DAY_MS, allowance);
    if (used.exceeded) {
      return {
        error:
          `Team "${target.team.slug}" has used its ${allowance.toLocaleString('en-US')} tool calls for today ` +
          `(resets ${used.resetAt.toISOString().slice(11, 16)} UTC). Nothing was written. ` +
          'If this was not a runaway loop, tell your human the team needs a larger plan.',
      };
    }
    return target;
  }
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
export function requireFeature(
  env: Pick<Env, 'hosted'>,
  team: { plan: string | null; slug: string },
  pick: (limits: PlanLimits) => boolean,
  what: string,
): { error: string } | null {
  const limits = planLimits(team.plan, env.hosted);
  if (pick(limits)) return null;
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
