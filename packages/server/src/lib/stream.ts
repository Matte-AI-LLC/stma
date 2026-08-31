/**
 * The live channel behind the console's pages.
 *
 * Every watch page used to reload itself every 30 seconds whether or not
 * anything had happened — a full round trip to learn nothing, and up to half a
 * minute of staleness on a page whose whole claim is that it says what is true
 * *right now*. This is the other half: the server says when something changed,
 * and the page reacts to that instead of to a clock.
 *
 * Deliberately in-process. A pub/sub server would be the correct answer for many
 * replicas, and the app is not there yet (see the shared rate-counter note in
 * CLAUDE.md); until it is, an EventEmitter is the whole mechanism and the 30s
 * poll stays as the fallback that makes a missed event cost latency, not
 * correctness. When the app does go multi-replica, only this file changes.
 */
import { logLine } from './log';

export type ChangeKind =
  | 'run'
  | 'claims'
  | 'quota'
  | 'session'
  | 'activity'
  | 'policy'
  | 'announcement';

interface Subscriber {
  teams: Set<string>;
  send: (event: { kind: ChangeKind; teamId: string; at: number }) => void;
}

/**
 * Hard ceiling on live connections per process. Reached only by something
 * pathological (a reconnect loop, a scripted client); past it the page keeps
 * working on its polling fallback, which is exactly what this is a shortcut for.
 */
export const MAX_SUBSCRIBERS = 500;

const subscribers = new Set<Subscriber>();

export function subscriberCount(): number {
  return subscribers.size;
}

/**
 * Watch a set of teams. Returns the unsubscribe function, or undefined when the
 * process is already at its ceiling — the caller then serves a normal response
 * and the page polls.
 */
export function subscribe(sub: Subscriber): (() => void) | undefined {
  if (subscribers.size >= MAX_SUBSCRIBERS) {
    logLine({ evt: 'stream', a: 'refused', n: subscribers.size });
    return undefined;
  }
  subscribers.add(sub);
  return () => {
    subscribers.delete(sub);
  };
}

/**
 * Tell every watcher of this team that something changed. Never throws: a live
 * page failing to update must not break the request that was doing real work.
 */
export function publishChange(teamId: string | null | undefined, kind: ChangeKind): void {
  if (!teamId || subscribers.size === 0) return;
  const event = { kind, teamId, at: Date.now() };
  for (const sub of subscribers) {
    if (!sub.teams.has(teamId)) continue;
    try {
      sub.send(event);
    } catch {
      // A dead connection: drop it rather than let it collect events forever.
      subscribers.delete(sub);
    }
  }
}

/** Test hook — drops every connection so a suite cannot leak them across files. */
export function resetSubscribers(): void {
  subscribers.clear();
}
