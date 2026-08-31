/**
 * `GET /app/stream` — the server-sent-events channel the console's watch pages
 * listen on instead of reloading on a timer.
 *
 * The contract is deliberately tiny: this stream never carries data, only the
 * news that data changed. The page then re-fetches through the same
 * server-rendered path it always used, so nothing here duplicates a query, a
 * permission check, or a rendering rule — the one thing a live channel must not
 * become is a second, subtly different copy of the app.
 */
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { memberships } from '../db/schema';
import { subscribe, type ChangeKind } from '../lib/stream';
import type { AppEnv } from '../types';

export const streamRoutes = new Hono<AppEnv>();

/** Comment frame interval — keeps proxies from reaping an idle connection. */
const PING_MS = 20_000;
/**
 * How long one connection lives before the browser is asked to reconnect.
 * EventSource reconnects on its own, and a bounded lifetime means a leaked
 * connection is a five-minute problem rather than a permanent one.
 */
const MAX_LIFETIME_MS = 5 * 60_000;

streamRoutes.get('/app/stream', async (c) => {
  const user = c.get('user');
  if (!user) return c.text('sign in first', 401);
  const rows = await c
    .get('db')
    .select({ teamId: memberships.teamId })
    .from(memberships)
    .where(eq(memberships.userId, user.id));
  const teams = new Set(rows.map((r) => r.teamId));

  return streamSSE(c, async (stream) => {
    const queue: ChangeKind[] = [];
    let wake: (() => void) | null = null;
    let aborted = false;
    const nudge = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    stream.onAbort(() => {
      aborted = true;
      nudge();
    });

    const unsubscribe = subscribe({
      teams,
      send: (event) => {
        queue.push(event.kind);
        nudge();
      },
    });
    // At the connection ceiling: say so and hang up. The page keeps its polling
    // fallback, so the worst case is the behaviour that existed before this.
    if (!unsubscribe) {
      await stream.writeSSE({ event: 'unavailable', data: 'poll' });
      return;
    }

    try {
      // Tells the client the channel is real, so it can say "live" rather than
      // "poll 30s" — and only after the server actually accepted the connection.
      await stream.writeSSE({ event: 'ready', data: JSON.stringify({ teams: teams.size }) });
      const deadline = Date.now() + MAX_LIFETIME_MS;
      while (!aborted && Date.now() < deadline) {
        if (queue.length === 0) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await new Promise<void>((resolve) => {
            wake = resolve;
            timer = setTimeout(resolve, PING_MS);
          });
          wake = null;
          if (timer) clearTimeout(timer);
        }
        if (aborted) break;
        if (queue.length === 0) {
          await stream.writeSSE({ event: 'ping', data: String(Date.now()) });
          continue;
        }
        // Everything that piled up while the page was being re-fetched collapses
        // into one notification: the page reloads once either way.
        const kinds = [...new Set(queue.splice(0))];
        await stream.writeSSE({
          event: 'change',
          data: JSON.stringify({ kinds, at: Date.now() }),
        });
      }
    } finally {
      unsubscribe();
    }
  });
});
