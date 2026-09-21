import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  connectDb,
  dataDirectoryMajor,
  embeddedMajor,
  type EmbeddedClient,
  type EmbeddedEngine,
} from '../src/db';
import * as schema from '../src/db/schema';
import {
  ENGINE_FOR_MAJOR,
  UPGRADE_FLAG,
  upgradeDataDirectory,
  upgradeTarget,
} from '../src/db/upgrade';
import { loadEnv } from '../src/env';
import { defaultMigrationsDir } from '../src/paths';

/**
 * Taking somebody's data across a PostgreSQL major, and the promise that
 * nothing is lost on the way.
 *
 * The sibling file owns the refusal: a directory this build cannot open is
 * answered with a sentence rather than "PGlite failed to initialize properly".
 * This one owns the way out of it. A real PostgreSQL 17 directory is built here
 * — the engine that shipped until 2026-09-14, the real migrations, real rows —
 * and then upgraded, because a migration test that only checks the directory
 * opens afterwards proves nothing about the rows.
 *
 * The 17 engine is a devDependency under an alias (`pglite-pg17`), so it is in
 * the lockfile and in CI and nowhere near the published package. There is no
 * `skipIf` here on purpose: a test that quietly does not run is how the Windows
 * ACL bugs reached a real desktop.
 */

const require = createRequire(import.meta.url);
/** The engine that can open 17, resolved the way an operator would point at one. */
const ENGINE = require.resolve('pglite-pg17');

const roots: string[] = [];
const scratch = (name: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), `stma-${name}-`));
  roots.push(dir);
  return dir;
};

/** One real 17 database, built once and copied per test — migrations are slow. */
let master = '';
let seventeen = '';
let current = '';

async function oldEngine(): Promise<EmbeddedEngine> {
  const loaded = (await import(pathToFileURL(ENGINE).href)) as { PGlite: EmbeddedEngine };
  return loaded.PGlite;
}

beforeAll(async () => {
  current = (await embeddedMajor()) ?? '';
  expect(current, 'this build reports the major it writes').toMatch(/^\d+$/);

  const Old = await oldEngine();
  master = scratch('pg17-master');
  const client = new Old(master) as EmbeddedClient;
  // The 0.3 engine is a different copy of the package, so the type cannot be
  // shared. Drizzle only ever calls query/exec/transaction, which both have —
  // this is exactly the pairing that shipped in every release up to 0.13.
  const db = drizzlePglite(client as unknown as PGlite, { schema });
  await migratePglite(db, { migrationsFolder: defaultMigrationsDir });

  const [user] = await db
    .insert(schema.users)
    .values({ username: 'ada', email: 'ada@example.test', displayName: 'Ada L' })
    .returning();
  const [team] = await db
    .insert(schema.teams)
    .values({ name: 'Parcel Desk', slug: 'parcel-desk', createdBy: user.id, plan: 'team' })
    .returning();
  await db.insert(schema.memberships).values({ teamId: team.id, userId: user.id, role: 'owner' });
  const [session] = await db
    .insert(schema.debugSessions)
    .values({
      teamId: team.id,
      title: 'Works on my machine',
      openedBy: user.id,
      context: { device: 'desktop', node: '20.19.0' },
    })
    .returning();
  await db.insert(schema.messages).values({
    sessionId: session.id,
    authorId: user.id,
    kind: 'handoff',
    // Everything COPY's text format has to escape, in one string.
    body: 'a tab\there, a \\ backslash and a\nline break',
    payload: { resume: { branch: 'lab/a1', steps: ['pull', 'run the suite'] } },
  });
  await client.close();

  seventeen = dataDirectoryMajor(master) ?? '';
  expect(seventeen, 'the old engine wrote a real data directory').toMatch(/^\d+$/);
  expect(seventeen, 'and it is not the one this build writes').not.toBe(current);
}, 180_000);

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** A pristine copy of the 17 database, at a path with no other directories beside it. */
const aSeventeenDirectory = (name: string): string => {
  const parent = scratch(name);
  const dir = path.join(parent, 'data');
  cpSync(master, dir, { recursive: true });
  return dir;
};

const siblings = (dir: string): string[] =>
  readdirSync(path.dirname(dir)).filter((entry) => entry !== path.basename(dir));

it('pins the engine it fetches to the one this suite proves', () => {
  const manifest = JSON.parse(
    readFileSync(path.join(path.dirname(ENGINE), '..', 'package.json'), 'utf8'),
  ) as { name: string; version: string };
  // The alias exists so the suite runs the same engine the command downloads.
  // If the pin moves without this moving, the test stops proving the shipped path.
  expect(ENGINE_FOR_MAJOR[seventeen]).toBe(`${manifest.name}@${manifest.version}`);
});

it('knows how to open the major below the one it writes', () => {
  // The rule that would have caught 2026-09-14, held by a mechanism rather than
  // by memory: PGlite hides its PostgreSQL major inside its own minor, so a
  // release that moves it looks like a routine bump. Raising the pin again is
  // therefore this test going red until the major being left behind has an
  // engine named for it, and the way across keeps working one step at a time.
  const below = String(Number(current) - 1);
  expect(
    ENGINE_FOR_MAJOR[below],
    `no engine is pinned for PostgreSQL ${below}, which the previous release wrote`,
  ).toMatch(/^@electric-sql\/pglite@\d+\.\d+\.\d+$/);
  // And never one for the major this build already opens by itself.
  expect(ENGINE_FOR_MAJOR[current]).toBeUndefined();
});

it('leaves a directory this build already wrote alone', async () => {
  const parent = scratch('fresh');
  const dir = path.join(parent, 'data');
  const opened = await connectDb(loadEnv({ nodeEnv: 'test', databaseUrl: undefined, pgliteDir: dir }));
  await opened.close();

  const result = await upgradeDataDirectory({ dir, log: () => {} });
  expect(result.moved, 'a fresh install pays nothing for this').toBe(false);
  expect(siblings(dir), 'and gains no backup, no work directory').toEqual([]);
  expect(dataDirectoryMajor(dir)).toBe(current);

  // Still the same database, still openable.
  const again = await connectDb(loadEnv({ nodeEnv: 'test', databaseUrl: undefined, pgliteDir: dir }));
  await again.close();
});

it('refuses a directory that nothing wrote, rather than making one', async () => {
  const dir = path.join(scratch('empty'), 'nothing-here');
  await expect(upgradeDataDirectory({ dir, log: () => {} })).rejects.toThrow(
    /no PostgreSQL data directory/,
  );
  expect(existsSync(dir)).toBe(false);
});

it('upgrades a 17 directory, keeps every row, and keeps the 17 copy', async () => {
  const dir = aSeventeenDirectory('upgrade');
  expect(dataDirectoryMajor(dir)).toBe(seventeen);

  // Before the command, boot refuses — the sentence the sibling file owns.
  await expect(
    connectDb(loadEnv({ nodeEnv: 'test', databaseUrl: undefined, pgliteDir: dir })),
  ).rejects.toThrow(/--upgrade-data/);

  const result = await upgradeDataDirectory({ dir, engineEntry: ENGINE, log: () => {} });
  if (!result.moved) throw new Error('the upgrade reported nothing to do');
  expect(result.from).toBe(seventeen);
  expect(result.to).toBe(current);
  expect(result.migrations, 'every migration the old directory recorded').toBeGreaterThan(40);
  expect(result.rows, 'the rows that were there').toBeGreaterThanOrEqual(5);
  expect(dataDirectoryMajor(dir)).toBe(current);

  // The database opens on the normal boot path, which also runs the migrator
  // against the journal that came across: a journal one row out would either
  // re-run a migration onto tables that exist, or skip one.
  const opened = await connectDb(loadEnv({ nodeEnv: 'test', databaseUrl: undefined, pgliteDir: dir }));
  const users = await opened.db.select().from(schema.users);
  expect(users).toHaveLength(1);
  expect(users[0].username).toBe('ada');
  expect(users[0].email).toBe('ada@example.test');

  const teams = await opened.db.select().from(schema.teams);
  expect(teams[0].slug).toBe('parcel-desk');
  expect(teams[0].plan).toBe('team');
  expect(teams[0].createdBy, 'the foreign key still points at the same row').toBe(users[0].id);

  const sessions = await opened.db.select().from(schema.debugSessions);
  expect(sessions[0].context).toEqual({ device: 'desktop', node: '20.19.0' });
  expect(sessions[0].createdAt, 'a timestamp comes back a timestamp').toBeInstanceOf(Date);

  const messages = await opened.db.select().from(schema.messages);
  expect(messages[0].body, 'tabs, backslashes and newlines survive COPY').toBe(
    'a tab\there, a \\ backslash and a\nline break',
  );
  expect(messages[0].payload).toEqual({
    resume: { branch: 'lab/a1', steps: ['pull', 'run the suite'] },
  });
  expect(messages[0].sessionId).toBe(sessions[0].id);

  await opened.db.insert(schema.messages).values({
    sessionId: sessions[0].id,
    authorId: users[0].id,
    body: 'after the upgrade',
  });

  // The journal's own sequence has to be past the rows that came across. It is
  // the only serial in the database and nothing else would notice it was wrong
  // — until the next release's first migration, which does not set `id` and
  // would collide on the primary key on somebody else's machine.
  await opened.db.execute(
    sql`insert into "drizzle"."__drizzle_migrations" ("hash", "created_at") values ('probe', 1)`,
  );
  await opened.db.execute(sql`delete from "drizzle"."__drizzle_migrations" where hash = 'probe'`);
  await opened.close();

  // And the old database is still there, beside the new one, still 17, still
  // complete. Beside it, because a rename onto another volume is not atomic.
  expect(path.dirname(result.backup)).toBe(path.dirname(dir));
  expect(path.basename(result.backup)).toMatch(new RegExp(`^data\\.backup-pg${seventeen}-`));
  expect(dataDirectoryMajor(result.backup)).toBe(seventeen);
  const Old = await oldEngine();
  const back = new Old(result.backup) as EmbeddedClient;
  const kept = await back.query('select username from users');
  expect(kept.rows).toEqual([{ username: 'ada' }]);
  await back.close();

  // Nothing half-finished left beside it.
  expect(siblings(dir).filter((entry) => entry.includes('.upgrading-'))).toEqual([]);

  // And running it again is a no-op rather than a second backup.
  const twice = await upgradeDataDirectory({ dir, engineEntry: ENGINE, log: () => {} });
  expect(twice.moved).toBe(false);
  expect(siblings(dir).filter((entry) => entry.includes('.backup-'))).toHaveLength(1);
}, 300_000);

it('leaves the original openable by 17 when the upgrade fails part way', async () => {
  const dir = aSeventeenDirectory('interrupted');

  // A real failure with a real cause: the migration files this build ships are
  // not the ones that built the directory. The replay gets part way — the work
  // directory exists and has tables in it — and then the hash check stops it.
  const edited = path.join(scratch('edited-migrations'), 'drizzle');
  cpSync(defaultMigrationsDir, edited, { recursive: true });
  const twentieth = readdirSync(edited)
    .filter((name) => name.endsWith('.sql'))
    .sort()[20];
  const file = path.join(edited, twentieth);
  writeFileSync(file, `${readFileSync(file, 'utf8')}\n-- edited after the fact\n`);

  await expect(
    upgradeDataDirectory({ dir, engineEntry: ENGINE, migrationsDir: edited, log: () => {} }),
  ).rejects.toThrow(/is not the file that built this directory/);

  // The original is exactly where it was, and the old engine still opens it.
  expect(dataDirectoryMajor(dir)).toBe(seventeen);
  expect(siblings(dir), 'no backup was taken, no work directory was left').toEqual([]);
  const Old = await oldEngine();
  const client = new Old(dir) as EmbeddedClient;
  const users = await client.query('select username, email from users');
  expect(users.rows).toEqual([{ username: 'ada', email: 'ada@example.test' }]);
  await client.close();
}, 300_000);

it('asks the engine what it writes instead of trusting where it came from', async () => {
  const dir = aSeventeenDirectory('wrong-engine');
  // This build's own engine, handed over as if it were the old one.
  const mine = require.resolve('@electric-sql/pglite');
  await expect(
    upgradeDataDirectory({ dir, engineEntry: mine, log: () => {} }),
  ).rejects.toThrow(new RegExp(`writes PostgreSQL ${current}, not ${seventeen}`));
  expect(dataDirectoryMajor(dir)).toBe(seventeen);
  expect(siblings(dir)).toEqual([]);
}, 120_000);

it('reads the directory off the command line, and says when it was not given one', () => {
  expect(upgradeTarget(['node', 'index.js']), 'a normal boot').toBeNull();
  expect(upgradeTarget(['node', 'index.js', UPGRADE_FLAG, '/data'])).toEqual({ dir: '/data' });
  // Asked, but not told where: the caller uses the configured directory. It has
  // to be a different answer from "not asked", or a named directory would have
  // to go through the configuration to be read at all.
  expect(upgradeTarget(['node', 'index.js', UPGRADE_FLAG])).toEqual({ dir: null });
  // A flag after the flag is another flag, not a directory called "--dev".
  expect(upgradeTarget(['node', 'index.js', UPGRADE_FLAG, '--dev'])).toEqual({ dir: null });
});
