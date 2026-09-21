/**
 * The live channel behind the console's pages.
 *
 * Every watch page used to reload itself every 30 seconds whether or not
 * anything had happened — a full round trip to learn nothing, and up to half a
 * minute of staleness on a page whose whole claim is that it says what is true
 * *right now*. This is the other half: the server says when something changed,
 * and the page reacts to that instead of to a clock.
 *
 * **The channel carries no data, only the news that data changed.** The page
 * then re-fetches through the same server-rendered path it always used, which
 * is what keeps this from becoming a second, subtly different copy of the app —
 * and it is why PostgreSQL's 8000-byte `NOTIFY` limit is a hint rather than an
 * obstacle. A payload here is a team id and one word.
 *
 * **Two halves, and the second one is what took the single-replica pin off.**
 * Fan-out inside a process is a set of subscribers, because that is the whole
 * mechanism a single process needs. Where the driver has a `NotifyBus`
 * (`db/index.ts` — the PostgreSQL path), `attachChangeTransport` also publishes
 * each event with `NOTIFY` and delivers what the other replicas sent, so a
 * browser watching replica A hears what replica B did. An embedded instance
 * installs nothing: PGlite has `LISTEN`/`NOTIFY` too — it is PostgreSQL — but
 * its backend is a wasm build inside the sending process, so a self-hoster
 * would be paying a round trip to hand an event back to itself.
 *
 * **The 30-second poll stays**, and is the reason this can ship without proving
 * the transport never drops anything. A notification lost to a dead listener, a
 * reconnect, or a `NOTIFY` that failed costs the page latency and never
 * correctness: `ui/client.ts` resumes reloading every 30 seconds once no change
 * has arrived for two minutes, and a replica whose listener is down stops
 * hearing the others entirely, so that silence is exactly the state that hands
 * the page back to its timer.
 *
 * **`publishChange` deliberately does not take a database handle.** Keying the
 * channel on one was tried and is a trap: `replaceRunClaims`, `recordRunQuota`
 * and one repository-binding write are all called with a transaction handle
 * rather than the pool's, so a per-handle channel would have silently dropped
 * the claims event on every heartbeat. Local fan-out and the transports are
 * per process, which is what a replica is.
 */
import { randomBytes } from 'node:crypto';
import type { NotifyBus } from '../db';
import { logLine } from './log';

export type ChangeKind =
  | 'run'
  | 'claims'
  | 'quota'
  | 'session'
  | 'activity'
  | 'policy'
  | 'announcement';

const CHANGE_KINDS: readonly string[] = [
  'run',
  'claims',
  'quota',
  'session',
  'activity',
  'policy',
  'announcement',
];

/** The PostgreSQL channel every replica of one deployment listens on. */
export const CHANGE_CHANNEL = 'stma_change';

/** How long a boot waits for the listener before coming up poll-only. */
export const ATTACH_TIMEOUT_MS = 10_000;

/**
 * This process, for as long as it lives — the sender stamped on every payload
 * so the copy PostgreSQL hands back to us is dropped rather than delivered
 * twice. A random boot id rather than a hostname or a pid, for the reason
 * `lib/loadHistory`'s `INSTANCE_ID` is one: in a container neither is an
 * identity anybody can look up, and two containers collide on the second.
 */
const INSTANCE = randomBytes(6).toString('hex');

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

/**
 * The buses this process publishes on. A set rather than one, because a test
 * can start two servers in one process; in production it holds exactly one.
 */
const transports = new Set<NotifyBus>();

/** Whether the last NOTIFY got through, so a dead bus logs once, not per event. */
let publishing = true;

export function subscriberCount(): number {
  return subscribers.size;
}

/** True once this process is carrying events to and from the other replicas. */
export function transportAttached(): boolean {
  return transports.size > 0;
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

/** Hand one event to this process's watchers. Never throws. */
function deliver(teamId: string, kind: ChangeKind): void {
  if (subscribers.size === 0) return;
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

/**
 * Tell every watcher of this team that something changed. Never throws: a live
 * page failing to update must not break the request that was doing real work.
 *
 * Local delivery happens first and unconditionally, so a broken transport can
 * only ever cost the *other* replicas their notification. The `NOTIFY` goes out
 * on the pool rather than inside whatever transaction the caller is in, which
 * is what this always did: a rolled-back write therefore wakes a page that
 * re-fetches and finds nothing new, and that is the harmless direction for a
 * channel carrying no data.
 */
export function publishChange(teamId: string | null | undefined, kind: ChangeKind): void {
  if (!teamId) return;
  deliver(teamId, kind);
  if (transports.size === 0) return;
  const payload = JSON.stringify({ i: INSTANCE, t: teamId, k: kind });
  for (const bus of transports) {
    void bus
      .notify(CHANGE_CHANNEL, payload)
      .then(() => {
        if (publishing) return;
        publishing = true;
        logLine({ evt: 'stream', a: 'notify_recovered' });
      })
      .catch((error: unknown) => {
        // On change only, the rule the conflict and quota records follow: a
        // database that is refusing would otherwise write one line per event.
        if (!publishing) return;
        publishing = false;
        logLine({
          evt: 'stream',
          a: 'notify_failed',
          msg: error instanceof Error ? error.message : String(error),
        });
      });
  }
}

/**
 * Start carrying this replica's events to the others, and theirs to here.
 *
 * Returns a disposer. Failing to subscribe is **not** fatal to the boot: the
 * process comes up poll-only, which is the behaviour every self-hosted instance
 * already has, and a server that refused to start over a live channel would
 * trade a working product for a fresher one. The wait is bounded for the same
 * reason — a boot must not hang on a live channel either.
 *
 * What happens when the listener's connection dies mid-flight: postgres-js owns
 * that connection, reconnects it and re-issues the `LISTEN` (see `NotifyBus` in
 * `db/index.ts`). Anything another replica sent while it was down is gone, and
 * nothing here tries to replay it — there is no sequence to replay, because the
 * payload is news rather than data. What the page sees is silence, and silence
 * for two minutes is what makes `ui/client.ts` resume its 30-second reload.
 */
export async function attachChangeTransport(
  bus: NotifyBus | undefined,
  timeoutMs = ATTACH_TIMEOUT_MS,
): Promise<() => Promise<void>> {
  if (!bus) return async () => {};
  let disposed = false;
  const subscription = bus
    .listen(CHANGE_CHANNEL, (payload) => {
      const event = readChangePayload(payload);
      // Our own NOTIFY comes back to us: local fan-out already happened.
      if (!event || event.i === INSTANCE) return;
      deliver(event.t, event.k);
    })
    .then((stop) => {
      if (disposed) {
        void stop().catch(() => {});
        return undefined;
      }
      transports.add(bus);
      logLine({ evt: 'stream', a: 'transport_attached', id: INSTANCE });
      return stop;
    })
    .catch((error: unknown) => {
      logLine({
        evt: 'stream',
        a: 'transport_unavailable',
        msg: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    });

  // Awaited, so the caller and a test both know the answer — but bounded. A
  // `LISTEN` on a database whose migration finished a moment ago is one round
  // trip; if it somehow is not, the server comes up anyway and the subscription
  // is still cleaned up when it finally answers.
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    subscription,
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        logLine({ evt: 'stream', a: 'transport_slow', ms: timeoutMs });
        resolve();
      }, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);

  return async () => {
    disposed = true;
    transports.delete(bus);
    const stop = await subscription;
    if (stop) await stop().catch(() => {});
  };
}

/**
 * A notification is a string another process wrote, so it is parsed rather than
 * trusted: a payload that is not one of ours is dropped instead of waking every
 * page on the instance, and `kind` is checked against the closed set because it
 * reaches the browser as an event name.
 */
export function readChangePayload(
  payload: string,
): { i: string; t: string; k: ChangeKind } | undefined {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const { i, t, k } = parsed as { i?: unknown; t?: unknown; k?: unknown };
    if (typeof i !== 'string' || typeof t !== 'string' || typeof k !== 'string') return undefined;
    if (!t || !CHANGE_KINDS.includes(k)) return undefined;
    return { i, t, k: k as ChangeKind };
  } catch {
    return undefined;
  }
}

/** Test hook — drops every connection so a suite cannot leak them across files. */
export function resetSubscribers(): void {
  subscribers.clear();
}
