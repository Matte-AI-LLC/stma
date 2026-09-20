import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { connectDb, dataDirectoryMajor, embeddedMajor } from '../src/db';
import { loadEnv } from '../src/env';

/**
 * The embedded database's major version is a data-format decision wearing the
 * clothes of a dependency bump.
 *
 * PGlite is a 0.x package, so its MINOR is its major: 0.3 bundles PostgreSQL 17
 * and 0.5 bundles 18. A PostgreSQL major never opens an older data directory in
 * place. Dependabot's grouped minor/patch rule counted that as routine on
 * 2026-09-14 and `@matteai/stma-server@0.14.2` shipped it, so anybody who ran
 * `stma serve` on an earlier release and then upgraded met "PGlite failed to
 * initialize properly" and nothing else.
 *
 * Three things hold that shut now, and this file is one of them: the pin is
 * back, Dependabot is told to leave this package alone, and a directory this
 * build cannot open is answered with a sentence.
 */
const roots: string[] = [];
const scratch = (name: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), `stma-${name}-`));
  roots.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

it('reads which PostgreSQL wrote a directory without opening it', async () => {
  const empty = scratch('pgv-empty');
  // Nothing there yet, and a directory nobody wrote is not an answer.
  expect(dataDirectoryMajor(empty)).toBeUndefined();
  expect(dataDirectoryMajor(path.join(empty, 'does-not-exist'))).toBeUndefined();

  const real = scratch('pgv-real');
  const opened = await connectDb(
    loadEnv({ nodeEnv: 'test', databaseUrl: undefined, pgliteDir: real }),
  );
  await opened.close();

  const wrote = dataDirectoryMajor(real);
  expect(wrote, 'a directory the server made says which major made it').toMatch(/^\d+$/);
  // And the same answer the engine gives for a fresh one, which is what the
  // refusal below compares against.
  expect(await embeddedMajor()).toBe(wrote);
});

it('refuses a data directory written by another PostgreSQL major, and says so', async () => {
  const stale = scratch('pgv-stale');
  const mine = await embeddedMajor();
  expect(mine, 'the embedded engine reports its major').toBeTruthy();

  // A directory from one major older, written the way PostgreSQL writes it.
  // The rest is deliberately empty: the point is that the refusal happens on
  // the version, before anything tries to read a page of somebody's data.
  mkdirSync(path.join(stale, 'base'), { recursive: true });
  writeFileSync(path.join(stale, 'PG_VERSION'), `${Number(mine) - 1}\n`);

  await expect(
    connectDb(loadEnv({ nodeEnv: 'test', databaseUrl: undefined, pgliteDir: stale })),
  ).rejects.toThrow(/written by PostgreSQL \d+, and this build's embedded engine is PostgreSQL \d+/);

  // The sentence has to carry the way out, or it is the opaque failure again
  // with more words.
  await expect(
    connectDb(loadEnv({ nodeEnv: 'test', databaseUrl: undefined, pgliteDir: stale })),
  ).rejects.toThrow(/move it aside to start with an empty one/);

  // And it must not move anything on somebody's behalf while they watch a
  // server fail to start.
  expect(dataDirectoryMajor(stale)).toBe(String(Number(mine) - 1));
});
