/**
 * "Is anything waiting for me?" — asked on the agent's behalf, answered into
 * its context.
 *
 * The lifecycle hook fires immediately before the agent reads the human's next
 * message, and whatever it prints becomes context. That is the only moment in a
 * coding agent's loop where an outside system can put something in front of it
 * without being asked, which is why this lives in the hook and not in a
 * background process: a background process can watch perfectly well and still
 * has no way to make the agent look.
 *
 * Three rules, because this runs on the human's critical path:
 *   1. Never block. A slow or unreachable server costs nothing but silence.
 *   2. Never repeat. A handoff announced once must not be announced again on
 *      every prompt until somebody takes it.
 *   3. Stay short. Two or three lines that say what to do, not a digest.
 */

export interface NewsResume {
  branch?: string | null;
  task?: string | null;
  project?: string | null;
  steps?: string[];
  checkout?: string | null;
  reclaim?: { tool: string; arguments: Record<string, unknown> } | null;
}

export interface NewsHandoff {
  sessionId: string;
  team: string | null;
  title: string;
  from: string | null;
  at: string;
  mine?: boolean;
  resume: NewsResume | null;
}

export interface News {
  checkedAt: string;
  pendingHandoffs: NewsHandoff[];
  unreadSessions: number;
}

/** Not more often than this, however fast the human types. */
export const NEWS_MIN_INTERVAL_MS = 60_000;
/** A hung server must not hold up a prompt. */
export const NEWS_TIMEOUT_MS = 2_500;

export interface NewsState {
  lastCheckedAt?: string;
  announced?: string[];
}

export function dueForCheck(state: NewsState, now = Date.now()): boolean {
  if (!state.lastCheckedAt) return true;
  const last = Date.parse(state.lastCheckedAt);
  return !Number.isFinite(last) || now - last >= NEWS_MIN_INTERVAL_MS;
}

/** Announcement identity: the session plus when it was handed over. */
export const handoffKey = (handoff: NewsHandoff): string => `${handoff.sessionId}:${handoff.at}`;

/**
 * What this agent has not been told yet. Anything already announced stays out,
 * and the list is trimmed so `.stma/local.json` cannot grow without bound.
 */
export function unseen(news: News, state: NewsState): NewsHandoff[] {
  const seen = new Set(state.announced ?? []);
  return news.pendingHandoffs.filter((h) => !seen.has(handoffKey(h)));
}

export function rememberAnnounced(state: NewsState, handoffs: NewsHandoff[]): string[] {
  return [...new Set([...(state.announced ?? []), ...handoffs.map(handoffKey)])].slice(-50);
}

/**
 * The offer, in the words the agent needs.
 *
 * It names what is waiting, then hands over the two exact calls that pick it up
 * — the checkout and the `start_run` that re-claims the same ground — and stops
 * there. It does NOT tell the agent to run them: the receiving side is a human
 * decision, and a brief that arrives mid-task should not silently move somebody
 * off what they were doing.
 */
export function renderNews(handoffs: NewsHandoff[], unreadSessions: number): string | undefined {
  if (handoffs.length === 0 && unreadSessions === 0) return undefined;
  const lines: string[] = [];

  for (const handoff of handoffs.slice(0, 3)) {
    const who = handoff.mine ? 'your own agent on another machine' : (handoff.from ?? 'a teammate');
    const where = handoff.resume?.branch ? ` on \`${handoff.resume.branch}\`` : '';
    lines.push(`STMA — work is waiting: "${handoff.title}"${where}, handed over by ${who}.`);
    const steps = handoff.resume?.steps ?? [];
    if (steps.length > 0) lines.push(`  Next: ${steps.slice(0, 2).join('; ')}`);
    if (handoff.resume?.checkout) lines.push(`  Take it: ${handoff.resume.checkout}`);
    if (handoff.resume?.reclaim) {
      lines.push(
        `  Then re-claim the same scope: ${handoff.resume.reclaim.tool} ${JSON.stringify(
          handoff.resume.reclaim.arguments,
        )}`,
      );
    }
    lines.push(`  Read it in full with get_session {"session_id":"${handoff.sessionId}"}.`);
  }

  if (unreadSessions > 0) {
    lines.push(
      `STMA — ${unreadSessions} debug ${unreadSessions === 1 ? 'session has' : 'sessions have'} unread replies. Call inbox to read them.`,
    );
  }

  lines.push(
    'Tell your human what is waiting and ask before acting on it — do not check out a branch or start a run unprompted.',
  );
  return lines.join('\n');
}
