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

export async function connectDb(env: Env): Promise<{ db: Db; close: () => Promise<void> }> {
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
    return { db, close: () => client.end() };
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
 * What major this build's embedded engine writes, learned by asking it.
 *
 * There is no constant to read: PGlite carries its PostgreSQL inside a wasm
 * build and publishes no major of its own. One throwaway directory is the
 * honest way to find out, and it is created only on a path where the instance
 * has already failed to start.
 */
export async function embeddedMajor(): Promise<string | undefined> {
  const probe = mkdtempSync(path.join(tmpdir(), 'stma-pg-major-'));
  try {
    const client = new PGlite(probe);
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
 * package alone now. Whether to stay on 18 and write an export and import path
 * or go back to 17 is the owner's call and is open; either way the message
 * names the cause on the first read rather than the third.
 *
 * Deliberately not automatic. Moving somebody's only copy of their data is not
 * a thing to do on their behalf while they watch a server fail to start.
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
    return new Error(
      `The database in ${dir} was written by PostgreSQL ${wrote}, and this build's embedded engine is PostgreSQL ${expected}. ` +
        'A major version never opens an older data directory in place, so this is a data migration rather than a restart. ' +
        'Run the release that last opened this directory, or move it aside to start with an empty one — nothing here will move it for you. ' +
        `Underlying error: ${detail}`,
    );
  }
  return new Error(`The database in ${dir} (PostgreSQL ${wrote}) could not be opened: ${detail}`);
}
