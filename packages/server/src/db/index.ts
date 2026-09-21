import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePg, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate as migratePg } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import type { Env } from '../env';
import { defaultMigrationsDir } from '../paths';
import { PACKAGE_NAME as SERVER_PACKAGE, VERSION } from '../version';
import * as schema from './schema';

export * as schema from './schema';

// Both drivers expose the same query API for our usage; we normalize on the
// postgres-js database type so the rest of the code is driver-agnostic.
export type Db = PostgresJsDatabase<typeof schema>;

/**
 * How many rows a raw `db.execute(...)` touched. The two drivers disagree on the
 * field name (postgres-js: `count`, PGlite: `affectedRows`, node-postgres:
 * `rowCount`), and none of them is part of drizzle's typed surface — so an
 * unrecognized shape reports 0 rather than breaking a sweep that did succeed.
 * Used for retention logging only; never for control flow.
 */
export function rowsAffected(result: unknown): number {
  const r = result as
    | { rowCount?: number | null; affectedRows?: number | null; count?: number | null }
    | null;
  return r?.rowCount ?? r?.affectedRows ?? r?.count ?? 0;
}

/**
 * The database's own notification bus, when the connected driver has one that
 * crosses processes.
 *
 * `lib/stream` is the only caller: it carries the news that something changed
 * between replicas, never the change itself. Deliberately two methods and a
 * string — naming the capability here rather than handing `lib/stream` a
 * postgres-js client is what keeps everything outside this file from running a
 * query on the listener's connection.
 */
export interface NotifyBus {
  /** Fire and forget. Rejects rather than throwing into a caller's flow. */
  notify(channel: string, payload: string): Promise<void>;
  /** Resolves once the backend is listening; the returned disposer stops it. */
  listen(channel: string, onPayload: (payload: string) => void): Promise<() => Promise<void>>;
}

export interface Connection {
  db: Db;
  close: () => Promise<void>;
  /**
   * Present only on the PostgreSQL path. PGlite has `listen`/`notify` too — it
   * is PostgreSQL — but its backend is a wasm build inside *this* Node process,
   * so a notification there can only ever reach the process that sent it. An
   * embedded instance is one process by definition, which is why the seam is
   * absent rather than wired to something that would add a database round trip
   * to hand an event back to its own sender.
   */
  notifyBus?: NotifyBus;
}

export async function connectDb(env: Env): Promise<Connection> {
  const migrationsFolder = env.migrationsDir
    ? path.resolve(process.cwd(), env.migrationsDir)
    : defaultMigrationsDir;

  if (env.databaseUrl) {
    const client = postgres(env.databaseUrl, { max: 10, onnotice: () => {} });
    const db = drizzlePg(client, { schema });
    // Advisory locks belong to a PostgreSQL session, not to the app pool. Use a
    // dedicated one-connection client with no lifetime/idle recycling for the
    // entire lock/migrate/unlock sequence. A reserved postgres-js SQL handle is
    // not a full client: Drizzle requires its options/parsers and transaction API.
    const migrationClient = postgres(env.databaseUrl, {
      max: 1,
      idle_timeout: 0,
      max_lifetime: 0,
      onnotice: () => {},
    });
    try {
      await migrationClient`select pg_advisory_lock(727272)`;
      try {
        await migratePg(drizzlePg(migrationClient, { schema }), { migrationsFolder });
      } finally {
        await migrationClient`select pg_advisory_unlock(727272)`;
      }
    } catch (error) {
      await client.end();
      throw error;
    } finally {
      await migrationClient.end();
    }
    // `sql.listen` opens its OWN connection — max 1, no idle timeout, no
    // lifetime recycling — separate from this pool, and re-issues every LISTEN
    // when that connection closes. It is the same shape the migration client
    // above is built by hand for, and for the same reason: a session-scoped
    // thing must never ride a connection the pool can take back. `client.end()`
    // ends it too, so there is still one close path.
    const notifyBus: NotifyBus = {
      notify: async (channel, payload) => {
        await client.notify(channel, payload);
      },
      listen: async (channel, onPayload) => {
        const subscription = await client.listen(channel, onPayload);
        return () => subscription.unlisten();
      },
    };
    return { db, close: () => client.end(), notifyBus };
  }

  mkdirSync(env.pgliteDir, { recursive: true }); // PGlite's own mkdir is not recursive
  // Read before the directory is opened, because the failure it explains looks
  // like a crash rather than an answer. See dataDirectoryRefusal.
  const wroteThisDirectory = dataDirectoryMajor(env.pgliteDir);
  const client = new PGlite(env.pgliteDir);
  try {
    const db = drizzlePglite(client, { schema });
    await migratePglite(db, { migrationsFolder });
    return { db: db as unknown as Db, close: () => client.close() };
  } catch (error) {
    throw await dataDirectoryRefusal(env.pgliteDir, wroteThisDirectory, error);
  }
}

/** Which PostgreSQL wrote this directory, read without opening it. */
export function dataDirectoryMajor(dir: string): string | undefined {
  try {
    return readFileSync(path.join(dir, 'PG_VERSION'), 'utf8').trim() || undefined;
  } catch {
    // No directory yet, or not one PostgreSQL wrote. Either way, not this.
    return undefined;
  }
}

/**
 * The part of a PGlite build this file and the upgrade path need.
 *
 * Structural rather than the real type, because the upgrade loads a *second,
 * older* engine at runtime: two different copies of the package, which cannot
 * share a declaration. This is what both of them answer to.
 */
export interface EmbeddedEngine {
  new (dataDir: string): EmbeddedClient;
}

export interface EmbeddedClient {
  query(
    query: string,
    params?: unknown[],
    options?: { blob?: Blob },
  ): Promise<{ rows: Record<string, unknown>[]; blob?: Blob }>;
  exec(query: string): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * What major an engine writes, learned by asking it.
 *
 * There is no constant to read: PGlite carries its PostgreSQL inside a wasm
 * build and publishes no major of its own. One throwaway directory is the
 * honest way to find out — and it is the only way to check an engine that was
 * loaded from a path rather than imported, where the name it was installed
 * under is not evidence of the version that arrived.
 */
const majors = new WeakMap<EmbeddedEngine, Promise<string | undefined>>();

export function majorWrittenBy(engine: EmbeddedEngine): Promise<string | undefined> {
  // Remembered per engine, not per call: an initdb costs seconds, and a wasm
  // build cannot change its mind about which PostgreSQL it carries. The upgrade
  // asks several times over and the refusal path can be reached more than once.
  const known = majors.get(engine);
  if (known) return known;
  const asking = askMajor(engine).then((major) => {
    // An engine that failed to start has not answered, and a non-answer is not
    // worth keeping: the next caller should ask again.
    if (major === undefined) majors.delete(engine);
    return major;
  });
  majors.set(engine, asking);
  return asking;
}

async function askMajor(engine: EmbeddedEngine): Promise<string | undefined> {
  const probe = mkdtempSync(path.join(tmpdir(), 'stma-pg-major-'));
  try {
    const client = new engine(probe);
    await client.query('select 1');
    await client.close();
    return dataDirectoryMajor(probe);
  } catch {
    return undefined;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

/**
 * What major this build's embedded engine writes. Created only on a path where
 * the instance has already failed to start, or when somebody asked for the
 * upgrade.
 */
export async function embeddedMajor(): Promise<string | undefined> {
  // The one cast: PGlite is the engine EmbeddedEngine was written from, and
  // duck typing across two package copies is the whole point of the interface.
  return majorWrittenBy(PGlite as unknown as EmbeddedEngine);
}

/**
 * Turn "PGlite failed to initialize properly" into a sentence somebody can act
 * on.
 *
 * A PostgreSQL major never opens an older data directory in place, and PGlite
 * carries its major inside its own MINOR version, because it is a 0.x package:
 * 0.3 bundles 17, 0.5 bundles 18. A data-format change therefore arrives
 * looking like a routine bump, and on 2026-09-14 Dependabot's grouped
 * minor/patch rule merged exactly that. `@matteai/stma-server@0.14.2` shipped
 * it, so anybody who ran `stma serve` on an earlier release and then upgraded
 * met an opaque failure with no way out of it. Dependabot is told to leave this
 * package alone now, and the way out is `--upgrade-data` (`db/upgrade.ts`),
 * which this message names.
 *
 * Deliberately not automatic. Moving somebody's only copy of their data is not
 * a thing to do on their behalf while they watch a server fail to start — so
 * boot still refuses, and the upgrade is a command a person types.
 */
export async function dataDirectoryRefusal(
  dir: string,
  wrote: string | undefined,
  cause: unknown,
): Promise<Error> {
  const detail = cause instanceof Error ? cause.message : String(cause);
  // No PG_VERSION means this was never a data directory of ours, and the
  // original error is the better answer.
  if (!wrote) return cause instanceof Error ? cause : new Error(detail);
  const expected = await embeddedMajor();
  if (expected && expected !== wrote) {
    return named(
      `The database in ${dir} was written by PostgreSQL ${wrote}, and this build's embedded engine is PostgreSQL ${expected}.\n` +
        'A major version never opens an older data directory in place, so this is a data migration rather than a restart.\n' +
        '\nUpgrade it once, keeping the old copy beside it:\n\n' +
        `  npx ${SERVER_PACKAGE}@${VERSION} --upgrade-data "${dir}"\n\n` +
        `(in a container or a checkout, the same binary: stma-server --upgrade-data "${dir}")\n` +
        '\nOr run the release that last opened this directory, or move it aside to start with an ' +
        'empty one — nothing here will move it for you.\n' +
        `\nUnderlying error: ${detail}`,
    );
  }
  return named(`The database in ${dir} (PostgreSQL ${wrote}) could not be opened: ${detail}`);
}

/**
 * The sentence is the answer, so the bin prints it on its own instead of
 * wrapping it in a stack trace — which is how the opaque failure read in the
 * first place. `name` rather than a subclass: nothing catches this by type, and
 * a subclass would invite something to start.
 */
export const DATA_DIRECTORY_ERROR = 'DataDirectoryError';

function named(text: string): Error {
  const error = new Error(text);
  error.name = DATA_DIRECTORY_ERROR;
  return error;
}
