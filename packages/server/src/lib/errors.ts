import { count, desc, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { errorEvents } from '../db/schema';
import { logLine } from './log';
import { templatePath } from './metrics';
import { redactSecrets } from './redact';

/** Validated values for error_events.kind (plain text column). */
export const ERROR_EVENT_KINDS = ['http', 'unhandled'] as const;
export type ErrorEventKind = (typeof ERROR_EVENT_KINDS)[number];

/** Hard ceiling on stored rows — the table can never grow unbounded. */
export const ERROR_EVENT_CAP = 2000;
/** Opportunistic trim cadence, so a burst between retention sweeps stays capped. */
const TRIM_EVERY = 200;
const MAX_MESSAGE = 500;
const MAX_STACK = 2000;

let sinceTrim = 0;

/** Routes whose path itself carries a secret; those are stored templated, never raw. */
const SECRET_PATHS = /^\/(?:api\/hooks\/(?:announce|github)|join)\//;

/** A request path safe to keep in the operator log. */
export function safeErrorPath(path: string): string {
  return SECRET_PATHS.test(path) ? templatePath(path) : redactSecrets(path);
}

/** Redacted, length-capped message + stack for one thrown value. */
export function errorFields(err: unknown): { message: string; stack?: string } {
  const base = redactSecrets(err instanceof Error ? err.message : String(err));
  // Drizzle wraps the real database error as `cause`; without it every failed query
  // in the console would just read "Failed query: select …".
  const cause =
    err instanceof Error && err.cause instanceof Error && err.cause.message && err.cause.message !== base
      ? ` | ${redactSecrets(err.cause.message).slice(0, 200)}`
      : '';
  const message = `${base.slice(0, MAX_MESSAGE - cause.length)}${cause}` || 'unknown error';
  const stack = err instanceof Error && err.stack ? redactSecrets(err.stack).slice(0, MAX_STACK) : undefined;
  return { message, stack };
}

/**
 * Persist one error for the operator console. Mirrors lib/track: a failing insert
 * is swallowed so error handling itself can never break a request (or recurse).
 */
export async function recordErrorEvent(
  db: Db,
  e: {
    kind: ErrorEventKind;
    message: string;
    stack?: string;
    method?: string | null;
    path?: string | null;
    status?: number | null;
    userId?: string | null;
    teamSlug?: string | null;
    requestId?: string | null;
  },
): Promise<void> {
  try {
    await db.insert(errorEvents).values({
      kind: ERROR_EVENT_KINDS.includes(e.kind) ? e.kind : 'http',
      message: e.message.slice(0, MAX_MESSAGE),
      stack: e.stack?.slice(0, MAX_STACK) ?? null,
      method: e.method?.slice(0, 10) ?? null,
      path: e.path?.slice(0, 500) ?? null,
      status: e.status ?? null,
      userId: e.userId ?? null,
      teamSlug: e.teamSlug?.slice(0, 120) ?? null,
      requestId: e.requestId?.slice(0, 120) ?? null,
    });
    if (++sinceTrim >= TRIM_EVERY) {
      sinceTrim = 0;
      await trimErrorEvents(db);
    }
  } catch (err) {
    console.warn('[stma] error_events insert failed:', err instanceof Error ? err.message : err);
  }
}

/** Keep only the newest ERROR_EVENT_CAP rows. Cheap: counts first, deletes only past the cap. */
export async function trimErrorEvents(db: Db, cap = ERROR_EVENT_CAP): Promise<number> {
  const rows = await db.select({ n: count() }).from(errorEvents);
  const total = rows[0]?.n ?? 0;
  if (total <= cap) return 0;
  await db.execute(
    sql`delete from ${errorEvents} where id not in (select id from ${errorEvents} order by ${desc(errorEvents.at)} limit ${cap})`,
  );
  return total - cap;
}

// ------------------------------------------------------- process-level capture

let monitor: ((err: Error, origin: string) => void) | null = null;
let installs = 0;
let activeDb: Db | null = null;

/**
 * Capture crashes that never reach the Hono error handler.
 *
 * `uncaughtExceptionMonitor` is used deliberately instead of `uncaughtException`:
 * it observes the failure without handling it, so the process still dies exactly as
 * it does today — and because Node's default mode escalates an unhandled rejection
 * into an uncaught exception, rejections arrive here too. Installing a real
 * `unhandledRejection`/`uncaughtException` listener would silently make those
 * failures survivable, which is a bigger behavior change than this console is worth.
 * The stdout line is therefore the durable record and the DB write is best effort.
 *
 * Reference counted so booting several servers in one process (the test suite)
 * neither stacks listeners nor leaks one.
 */
export function installProcessErrorCapture(db: Db): () => void {
  activeDb = db;
  installs += 1;
  if (!monitor) {
    monitor = (err, origin) => {
      const { message, stack } = errorFields(err);
      logLine({ evt: 'error', kind: 'unhandled', origin, msg: message });
      const target = activeDb;
      if (target) {
        void recordErrorEvent(target, { kind: 'unhandled', message, stack, path: origin });
      }
    };
    process.on('uncaughtExceptionMonitor', monitor);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    installs -= 1;
    if (installs <= 0 && monitor) {
      process.off('uncaughtExceptionMonitor', monitor);
      monitor = null;
      activeDb = null;
      installs = 0;
    }
  };
}
