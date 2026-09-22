import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { defaultMigrationsDir } from '../paths';
import {
  dataDirectoryMajor,
  embeddedMajor,
  majorWrittenBy,
  type EmbeddedClient,
  type EmbeddedEngine,
} from './index';

/**
 * Taking a data directory across a PostgreSQL major, once, because somebody
 * asked.
 *
 * PGlite is a 0.x package, so its minor is its major: 0.3 bundles PostgreSQL 17
 * and 0.5 bundles 18. A PostgreSQL major never opens an older data directory in
 * place, and on 2026-09-14 that arrived here as a routine grouped dependency
 * bump. `@matteai/stma-server@0.14.2` and `0.15.0` shipped it, so every
 * `~/.stma/data` written by an earlier release stops opening on upgrade.
 *
 * The direction is settled: this stays on 18 and grows a path forward. Going
 * back to 17 was arguable on the day it was found; two published releases later
 * it would strand everybody who installed since, and `dataDirectoryRefusal`
 * already tells the older group exactly what happened.
 *
 * The shape is pg_dump and restore in spirit — read everything out under the
 * engine that can open it, write it back under the engine that will — with
 * three things measured rather than assumed:
 *
 * 1. **Two PGlite majors coexist in one Node process.** They are separate wasm
 *    builds with separate memories, and loading the second does not disturb the
 *    first. So this is one process and one pass: a table comes out of 17 and
 *    goes into 18 before the next one is read, and no dump file ever exists.
 * 2. **`COPY … '/dev/blob'` carries the rows**, in PostgreSQL's own text
 *    format, which is what keeps the move independent of how two different
 *    copies of a JS driver would have mapped jsonb, bytea, numeric or a
 *    timestamp. Measured across 17 → 18 with all of those, plus embedded tabs,
 *    newlines and backslashes.
 * 3. **The schema comes from the migration files that shipped with this
 *    build**, replayed to exactly the level the old directory recorded in its
 *    own Drizzle journal — not from reading the old catalog. The journal rows
 *    then move across verbatim, so the ordinary boot migrator picks up where
 *    the old release left off and no data migration is skipped or run twice.
 *    Each replayed file's sha256 is checked against the hash the old directory
 *    stored, so a migration edited after the fact is a refusal rather than a
 *    quietly different schema.
 *
 * What it will not do: move anything by itself. Boot still refuses and explains
 * (`dataDirectoryRefusal`); this runs when a person types it. On success the
 * PostgreSQL 17 directory is kept beside the new one and nothing here ever
 * deletes it.
 */

/** Which published engine opens which PostgreSQL major. */
export const ENGINE_FOR_MAJOR: Readonly<Record<string, string>> = {
  // 0.3.16 is the newest of the 0.3 line, and `^0.3.3` — the range this
  // repository carried from its first commit until 2026-09-14 — is the only
  // range that ever wrote one of these directories. There is no 16 to support:
  // no release of this server has ever depended on a PGlite that bundled it.
  '17': '@electric-sql/pglite@0.3.16',
};

/**
 * The tarball each pinned engine must have arrived as — the same digest the
 * repository's lockfile records for the `pglite-pg17` alias the suite runs, and
 * a test holds the two together. npm checks a download against the integrity
 * its registry announced; this checks that announcement against ours, before
 * anything that arrived is imported.
 */
export const ENGINE_INTEGRITY: Readonly<Record<string, string>> = {
  '17': 'sha512-mZkZfOd9OqTMHsK+1cje8OSzfAQcpD7JmILXTl5ahdempjUDdmg4euf1biDex5/LfQIDJ3gvCu6qDgdnDxfJmA==',
};

/** The flag on the server binary that asks for the upgrade. */
export const UPGRADE_FLAG = '--upgrade-data';

/**
 * An engine this build did not import: a path to the module entry of a PGlite
 * copy that can open the old major. Set it to run offline, or to point at an
 * engine you already have; left unset, the pinned one is fetched once.
 */
export const ENGINE_ENV = 'STMA_UPGRADE_ENGINE';

export interface UpgradeOptions {
  /** The data directory to take across. */
  dir: string;
  /** Where the migration files live; defaults to the ones this build ships. */
  migrationsDir?: string;
  /** Module entry of the old engine, bypassing the fetch. */
  engineEntry?: string;
  log?: (line: string) => void;
}

export type UpgradeResult =
  | { moved: false; major: string; dir: string }
  | {
      moved: true;
      dir: string;
      from: string;
      to: string;
      backup: string;
      migrations: number;
      tables: number;
      rows: number;
    };

interface JournalRow {
  id: number;
  hash: string;
  created_at: number;
}

const ident = (name: unknown): string => `"${String(name).replace(/"/g, '""')}"`;

/** An ISO instant a filesystem accepts, with the Z kept so it reads as UTC. */
const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');

/**
 * Take `dir` from the major that wrote it to the one this build runs.
 *
 * Nothing is destructive until the very end: the work happens in a sibling
 * directory, every check that could refuse has refused before the first rename,
 * and the original is moved aside rather than overwritten. A failure at any
 * point leaves a directory the old engine still opens.
 */
export async function upgradeDataDirectory(options: UpgradeOptions): Promise<UpgradeResult> {
  const log = options.log ?? (() => {});
  const dir = path.resolve(options.dir);
  // Resolved exactly as connectDb resolves it, so the replay reads the files
  // the next boot will read.
  const migrationsDir = options.migrationsDir
    ? path.resolve(process.cwd(), options.migrationsDir)
    : defaultMigrationsDir;

  const from = dataDirectoryMajor(dir);
  if (!from) {
    throw new Error(
      `There is no PostgreSQL data directory at ${dir} — no PG_VERSION file, so nothing here was written by this server. Point ${UPGRADE_FLAG} at the directory the server reported.`,
    );
  }
  const to = await embeddedMajor();
  if (!to) {
    throw new Error(
      "This build's embedded engine did not report a PostgreSQL version, so there is nothing to compare against. Nothing was touched.",
    );
  }
  if (from === to) {
    log(`${dir} is already PostgreSQL ${to}. Nothing to upgrade.`);
    return { moved: false, major: to, dir };
  }
  if (Number(from) > Number(to)) {
    throw new Error(
      `The database in ${dir} was written by PostgreSQL ${from} and this build's engine is PostgreSQL ${to}, which is older. A newer directory cannot be taken backwards; run the release that wrote it.`,
    );
  }

  const spec = ENGINE_FOR_MAJOR[from];
  if (!spec) {
    throw new Error(
      `No engine is pinned for PostgreSQL ${from}, so this build cannot open ${dir} to read it. Nothing was touched.`,
    );
  }

  const Old = await loadEngine(spec, from, options.engineEntry, log);
  // The same cast as embeddedMajor's, and for the same reason: duck typing
  // across two copies of a package is what this whole path is built on.
  const New = PGlite as unknown as EmbeddedEngine;

  const work = `${dir}.upgrading-${stamp()}`;
  log(`Reading ${dir} with PostgreSQL ${from}…`);

  let migrations = 0;
  let tables = 0;
  let rows = 0;

  const source: EmbeddedClient = new Old(dir);
  try {
    const journal = await readJournal(source);
    const shape = await readShape(source);
    const sequences = await readSequences(source);

    const target: EmbeddedClient = new New(work);
    try {
      migrations = await replayMigrations(target, migrationsDir, journal, log);
      await expectSameShape(target, shape, sequences);
      const copied = await copyTables(source, target, shape, log);
      tables = copied.tables;
      rows = copied.rows;
      await restoreSequences(target, sequences);
      await expectSameCounts(source, target, shape);
    } finally {
      await target.close().catch(() => {});
    }
  } catch (error) {
    rmSync(work, { recursive: true, force: true });
    throw error;
  } finally {
    await source.close().catch(() => {});
  }

  const backup = `${dir}.backup-pg${from}-${stamp()}`;
  try {
    renameSync(dir, backup);
  } catch (error) {
    // Nothing has moved yet, so there is nothing to recover — say what to do
    // and leave the directory exactly as it was. On Windows this is usually
    // something still holding the directory open.
    rmSync(work, { recursive: true, force: true });
    throw new Error(
      `The upgraded copy was ready, but ${dir} could not be moved aside to ${backup}: ${message(error)}. Nothing was changed. Stop anything still using that directory and run this again.`,
    );
  }
  try {
    renameSync(work, dir);
  } catch (error) {
    // The one window where a person could be left without a database at the
    // path they expect. Put the original back if we can, and either way name
    // every directory involved — one somebody cannot find is one that is gone.
    let restored = false;
    try {
      renameSync(backup, dir);
      restored = true;
    } catch {
      /* named below */
    }
    throw new Error(
      restored
        ? `The upgraded copy could not be moved into place, so your PostgreSQL ${from} database was put back at ${dir} and nothing has changed. The upgraded PostgreSQL ${to} copy is at ${work}: delete it, or move it there yourself once whatever was holding the directory is closed. Underlying error: ${message(error)}`
        : `The upgraded copy could not be moved into place, and your PostgreSQL ${from} database could not be put back either. Nothing is lost: it is at ${backup}, and the upgraded PostgreSQL ${to} copy is at ${work}. Rename one of them to ${dir} by hand — the ${from} one if you want the release you were on, the ${to} one for this build. Underlying error: ${message(error)}`,
    );
  }

  return { moved: true, dir, from, to, backup, migrations, tables, rows };
}

/**
 * The engine that can open the old major.
 *
 * Fetched rather than shipped: it is 25 MB of wasm that a fresh install will
 * never open, and every install would pay for it. Fetching it here is the same
 * bargain `stma serve` already makes when it pulls the server package, and it
 * is said out loud for the same reason.
 *
 * Whatever is loaded is then asked what it writes, because the version somebody
 * installed under a name is not evidence of the version they got.
 */
async function loadEngine(
  spec: string,
  major: string,
  entry: string | undefined,
  log: (line: string) => void,
): Promise<EmbeddedEngine> {
  const file = entry ?? process.env[ENGINE_ENV] ?? fetchEngine(spec, major, log);
  let loaded: { PGlite?: unknown };
  try {
    loaded = (await import(pathToFileURL(file).href)) as { PGlite?: unknown };
  } catch (error) {
    throw new Error(
      `Could not load the PostgreSQL ${major} engine from ${file}: ${message(error)}. Install ${spec} and point ${ENGINE_ENV} at its dist/index.js.`,
    );
  }
  const engine = loaded.PGlite as EmbeddedEngine | undefined;
  if (typeof engine !== 'function') {
    throw new Error(`${file} does not export a PGlite constructor, so it is not an engine.`);
  }
  const writes = await majorWrittenBy(engine);
  if (writes !== major) {
    throw new Error(
      `The engine at ${file} writes PostgreSQL ${writes ?? 'an unknown major'}, not ${major}, so it cannot open this directory either. Nothing was touched.`,
    );
  }
  return engine;
}

/**
 * Fetch the pinned engine into a directory nobody else could have prepared.
 *
 * This used a fixed `os.tmpdir()/stma-engine-pg<major>`, imported whatever was
 * already there, and ran npm inside it (audit 2026-09-21): on a shared machine
 * another user could plant a module at that path — or an `.npmrc` that points
 * the fetch elsewhere — and the upgrade would run it as whoever typed the
 * command, with their data directory in reach. The "what major does this write"
 * question comes after the import, so it could not catch that. Now each run
 * gets a fresh `mkdtemp` directory (a random name; mode 0700 on POSIX, the
 * user's own temp on Windows) and the installed tarball's integrity is checked
 * against `ENGINE_INTEGRITY` before the module is loaded. It costs one download
 * per upgrade, and an upgrade is a command somebody types once.
 */
function fetchEngine(spec: string, major: string, log: (line: string) => void): string {
  const home = mkdtempSync(path.join(os.tmpdir(), `stma-engine-pg${major}-`));
  const entry = path.join(home, 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js');

  // npm walks up looking for one, and would install into whatever it found.
  writeFileSync(
    path.join(home, 'package.json'),
    `${JSON.stringify({ name: 'stma-upgrade-engine', version: '0.0.0', private: true }, null, 2)}\n`,
  );
  log(`Fetching ${spec} — the engine that can open PostgreSQL ${major}…`);
  // One command string, not a name plus arguments: Node will not spawn npm.cmd
  // without a shell on Windows, and a shell does not quote the arguments for
  // us. The only interpolation is our own pinned constant and a temp path.
  const result = spawnSync(
    `npm install --prefix "${home}" --no-save --no-audit --no-fund --loglevel=error ${spec}`,
    { shell: true, stdio: 'inherit' },
  );
  if (result.status !== 0 || !existsSync(entry)) {
    throw new Error(
      `Could not fetch ${spec} into ${home}. Install it somewhere yourself and point ${ENGINE_ENV} at its dist/index.js, then run this again. Nothing was touched.`,
    );
  }
  const arrived = installedIntegrity(home);
  if (arrived !== ENGINE_INTEGRITY[major]) {
    throw new Error(
      `The ${spec} that arrived is not the published one this build pins (integrity ${arrived ?? 'unknown'}), so it was not loaded. Check the npm registry this machine uses, or point ${ENGINE_ENV} at a copy you trust. Nothing was touched.`,
    );
  }
  return entry;
}

/** The integrity npm recorded for the engine it just installed, from its own lockfile. */
function installedIntegrity(home: string): string | undefined {
  try {
    const lock = JSON.parse(readFileSync(path.join(home, 'node_modules', '.package-lock.json'), 'utf8')) as {
      packages?: Record<string, { integrity?: unknown }>;
    };
    const integrity = lock.packages?.['node_modules/@electric-sql/pglite']?.integrity;
    return typeof integrity === 'string' ? integrity : undefined;
  } catch {
    return undefined;
  }
}

/** What the old directory says it has already migrated. */
async function readJournal(pg: EmbeddedClient): Promise<JournalRow[]> {
  const present = await pg.query(
    `select 1 from information_schema.tables where table_schema = 'drizzle' and table_name = '__drizzle_migrations'`,
  );
  if (present.rows.length === 0) return [];
  const rows = await pg.query(
    `select id, hash, created_at from "drizzle"."__drizzle_migrations" order by id`,
  );
  return rows.rows.map((r) => ({
    id: Number(r.id),
    hash: String(r.hash),
    created_at: Number(r.created_at),
  }));
}

type Shape = Map<string, string[]>;

/** Every table in the old database and the columns it has, in order. */
async function readShape(pg: EmbeddedClient): Promise<Shape> {
  const stray = await pg.query(
    `select distinct schemaname from pg_tables
       where schemaname not in ('pg_catalog', 'information_schema', 'public', 'drizzle')`,
  );
  if (stray.rows.length > 0) {
    const names = stray.rows.map((r) => String(r.schemaname)).join(', ');
    throw new Error(
      `This directory has tables in ${names}, which this upgrade does not know how to move. Nothing was touched.`,
    );
  }
  const result = await pg.query(
    `select c.table_name, c.column_name
       from information_schema.columns c
       join pg_tables t on t.schemaname = 'public' and t.tablename = c.table_name
      where c.table_schema = 'public'
      order by c.table_name, c.ordinal_position`,
  );
  const shape: Shape = new Map();
  for (const row of result.rows) {
    const table = String(row.table_name);
    const columns = shape.get(table) ?? [];
    columns.push(String(row.column_name));
    shape.set(table, columns);
  }
  return shape;
}

interface SequenceRow {
  schema: string;
  name: string;
  last: string | null;
}

async function readSequences(pg: EmbeddedClient): Promise<SequenceRow[]> {
  const result = await pg.query(
    `select schemaname, sequencename, last_value from pg_sequences
      where schemaname not in ('pg_catalog', 'information_schema')
      order by schemaname, sequencename`,
  );
  return result.rows.map((r) => ({
    schema: String(r.schemaname),
    name: String(r.sequencename),
    last: r.last_value === null || r.last_value === undefined ? null : String(r.last_value),
  }));
}

/**
 * Rebuild the schema by replaying the migrations the old directory recorded.
 *
 * Only those: a directory from an older release is mid-ladder on purpose, and
 * running the rest here would apply this build's later data migrations to rows
 * that have not arrived yet. The journal rows move across as they are, so the
 * boot migrator sees exactly the state the old release left and finishes the
 * ladder itself.
 */
async function replayMigrations(
  pg: EmbeddedClient,
  folder: string,
  journal: JournalRow[],
  log: (line: string) => void,
): Promise<number> {
  await pg.exec('create schema if not exists "drizzle"');
  // The same DDL drizzle-orm creates, because drizzle will read this table on
  // the next boot and must not try to create a different one.
  await pg.exec(
    `create table if not exists "drizzle"."__drizzle_migrations" (
       id SERIAL PRIMARY KEY,
       hash text NOT NULL,
       created_at bigint
     )`,
  );
  if (journal.length === 0) {
    log('The old directory recorded no migrations, so the new one starts empty.');
    return 0;
  }

  const meta = JSON.parse(
    readFileSync(path.join(folder, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { idx: number; when: number; tag: string }[] };
  const byWhen = new Map(meta.entries.map((entry) => [Number(entry.when), entry]));

  for (const row of journal) {
    const entry = byWhen.get(row.created_at);
    if (!entry) {
      throw new Error(
        `The database in this directory has a migration recorded at ${row.created_at} that this build does not ship, so it was written by a newer release. Run that release instead. Nothing was touched.`,
      );
    }
    const file = path.join(folder, `${entry.tag}.sql`);
    const sql = readFileSync(file, 'utf8');
    const hash = createHash('sha256').update(sql).digest('hex');
    if (hash !== row.hash) {
      throw new Error(
        `${entry.tag}.sql in this build is not the file that built this directory — its hash differs from the one recorded. Replaying it would produce a different schema, so nothing was touched.`,
      );
    }
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await pg.exec(trimmed);
    }
    await pg.query(
      `insert into "drizzle"."__drizzle_migrations" (id, hash, created_at) values ($1, $2, $3)`,
      [row.id, row.hash, row.created_at],
    );
  }
  log(`Replayed ${journal.length} migration(s) onto PostgreSQL ${await currentMajor(pg)}.`);
  return journal.length;
}

async function currentMajor(pg: EmbeddedClient): Promise<string> {
  const result = await pg.query('show server_version_num');
  const num = Number(result.rows[0]?.server_version_num ?? 0);
  return String(Math.floor(num / 10000));
}

/** The replay has to have produced the same tables and columns, or stop here. */
async function expectSameShape(
  pg: EmbeddedClient,
  shape: Shape,
  sequences: SequenceRow[],
): Promise<void> {
  const built = await readShape(pg);
  const missing: string[] = [];
  for (const [table, columns] of shape) {
    const made = built.get(table);
    if (!made) {
      missing.push(table);
      continue;
    }
    for (const column of columns) if (!made.includes(column)) missing.push(`${table}.${column}`);
  }
  if (missing.length > 0) {
    throw new Error(
      `Replaying the migrations did not reproduce ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ` and ${missing.length - 8} more` : ''}, so the copy would not hold everything the original does. Nothing was touched.`,
    );
  }
  const builtSequences = new Set((await readSequences(pg)).map((s) => `${s.schema}.${s.name}`));
  const lostSequences = sequences
    .map((s) => `${s.schema}.${s.name}`)
    .filter((name) => !builtSequences.has(name));
  if (lostSequences.length > 0) {
    throw new Error(
      `Replaying the migrations did not reproduce the sequence(s) ${lostSequences.join(', ')}, so the copy would hand out ids the original already used. Nothing was touched.`,
    );
  }
}

/**
 * Move the rows, one table at a time, in PostgreSQL's own COPY text format.
 *
 * Foreign keys are switched off for the load rather than the tables sorted into
 * a safe order: `session_replication_role = replica` is what pg_restore does,
 * and a topological sort would be one more thing able to be subtly wrong about
 * a schema it did not design.
 */
async function copyTables(
  source: EmbeddedClient,
  target: EmbeddedClient,
  shape: Shape,
  log: (line: string) => void,
): Promise<{ tables: number; rows: number }> {
  await target.exec('set session_replication_role = replica');
  let tables = 0;
  let rows = 0;
  try {
    for (const [table, columns] of shape) {
      const list = columns.map(ident).join(', ');
      const from = `"public".${ident(table)} (${list})`;
      const out = await source.query(`copy ${from} to '/dev/blob'`);
      const blob = out.blob;
      if (blob && blob.size > 0) {
        await target.query(`copy ${from} from '/dev/blob'`, [], { blob });
      }
      const counted = await count(source, table);
      tables += 1;
      rows += counted;
      // Only what was there. Fifty tables reporting nothing is fifty lines
      // somebody has to read past to find the two that matter.
      if (counted > 0) log(`  ${table}: ${counted} row(s)`);
    }
  } finally {
    // Never let putting the switch back hide why the copy stopped.
    await target.exec('set session_replication_role = origin').catch(() => {});
  }
  return { tables, rows };
}

async function restoreSequences(pg: EmbeddedClient, sequences: SequenceRow[]): Promise<void> {
  for (const sequence of sequences) {
    if (sequence.last === null) continue;
    await pg.query(
      `select setval('${ident(sequence.schema)}.${ident(sequence.name)}'::regclass, $1::bigint, true)`,
      [sequence.last],
    );
  }
}

async function count(pg: EmbeddedClient, table: string): Promise<number> {
  const result = await pg.query(`select count(*)::int as n from "public".${ident(table)}`);
  return Number(result.rows[0]?.n ?? 0);
}

/** Every table has to hold what it held, or the copy is not the database. */
async function expectSameCounts(
  source: EmbeddedClient,
  target: EmbeddedClient,
  shape: Shape,
): Promise<void> {
  for (const table of shape.keys()) {
    const before = await count(source, table);
    const after = await count(target, table);
    if (before !== after) {
      throw new Error(
        `${table} has ${before} row(s) in the original and ${after} in the copy, so the copy is not the database. Nothing was touched.`,
      );
    }
  }
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Whether `--upgrade-data` was asked for, and about which directory.
 *
 * Three answers rather than two, and the distinction earns its keep: null means
 * nobody asked and this is a normal boot, `{ dir: null }` means a bare flag and
 * the configured directory, and a named directory must be usable **without
 * reading the configuration at all**. Somebody arriving here is holding the
 * refusal message and a path; a boot that demanded DATABASE_URL before it would
 * look at the flag sent them straight into another wall.
 */
export function upgradeTarget(argv: readonly string[]): { dir: string | null } | null {
  const at = argv.indexOf(UPGRADE_FLAG);
  if (at === -1) return null;
  const next = argv[at + 1];
  return { dir: next && !next.startsWith('-') ? next : null };
}

/**
 * The command behind the flag: prints what it is doing, and on failure prints
 * the sentence rather than a stack trace. Returns the process exit code.
 */
export async function runUpgradeCommand(
  dir: string,
  options: Omit<UpgradeOptions, 'dir'> = {},
): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  try {
    const result = await upgradeDataDirectory({ ...options, dir, log });
    if (!result.moved) {
      log(`Nothing to do: ${result.dir} is already PostgreSQL ${result.major}.`);
      return 0;
    }
    log('');
    log(`  Upgraded ${result.dir} from PostgreSQL ${result.from} to ${result.to}.`);
    log(
      `  ${result.migrations} migration(s) replayed, ${result.tables} table(s), ${result.rows} row(s).`,
    );
    log(`  The PostgreSQL ${result.from} copy is kept at ${result.backup}`);
    log('  Nothing deletes it. Remove it yourself once the server has started and you have looked.');
    log('');
    return 0;
  } catch (error) {
    console.error(`\n${message(error)}\n`);
    return 1;
  }
}
