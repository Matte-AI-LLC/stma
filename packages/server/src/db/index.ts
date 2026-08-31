import { mkdirSync } from 'node:fs';
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
    // Serialize boot migrations across replicas.
    await client`select pg_advisory_lock(727272)`;
    try {
      await migratePg(db, { migrationsFolder });
    } finally {
      await client`select pg_advisory_unlock(727272)`;
    }
    return { db, close: () => client.end() };
  }

  mkdirSync(env.pgliteDir, { recursive: true }); // PGlite's own mkdir is not recursive
  const client = new PGlite(env.pgliteDir);
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder });
  return { db: db as unknown as Db, close: () => client.close() };
}
