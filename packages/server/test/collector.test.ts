import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  LOCKFILE_NAMES,
  dotenvNames,
  firstVersion,
  hasMarker,
  scanEcosystems,
} from '../../cli/src/collect';

/**
 * Snapshot breadth. The collector used to report node and npm whatever the
 * repository was, so a Python or Go team saw the weakest possible diff — which
 * is not a roadmap gap but a smaller addressable market.
 *
 * The probes shell out, so what is asserted here is everything that does NOT
 * depend on which tools this particular machine happens to have: which
 * ecosystems a repository is recognised as, which lockfiles are worth hashing,
 * and that the version parser survives the shapes real tools actually print.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(files: string[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'stma-collect-'));
  roots.push(dir);
  for (const file of files) writeFileSync(path.join(dir, file), 'x');
  return dir;
}

it('recognises a repository by what is in it, not by what the CLI runs on', () => {
  expect(scanEcosystems(repo(['go.mod'])).ecosystems).toEqual(['go']);
  expect(scanEcosystems(repo(['Cargo.toml'])).ecosystems).toEqual(['rust']);
  expect(scanEcosystems(repo(['Gemfile'])).ecosystems).toEqual(['ruby']);
  expect(scanEcosystems(repo(['composer.json'])).ecosystems).toEqual(['php']);
  expect(scanEcosystems(repo(['pyproject.toml'])).ecosystems).toEqual(['python']);
  expect(scanEcosystems(repo(['mix.exs'])).ecosystems).toEqual(['elixir']);
  expect(scanEcosystems(repo(['pubspec.yaml'])).ecosystems).toEqual(['dart']);
  // A polyglot repo is all of them, in one snapshot.
  expect(scanEcosystems(repo(['package.json', 'go.mod', 'Dockerfile'])).ecosystems).toEqual([
    'node',
    'go',
    'docker',
  ]);
  // And an empty directory claims nothing rather than guessing.
  expect(scanEcosystems(repo([])).ecosystems).toEqual([]);
});

it('matches extension markers, which is the only way .NET announces itself', () => {
  expect(scanEcosystems(repo(['Api.csproj'])).ecosystems).toContain('dotnet');
  expect(scanEcosystems(repo(['Solution.sln'])).ecosystems).toContain('dotnet');
  expect(hasMarker(repo(['Api.csproj']), ['*.csproj'])).toBe(true);
  expect(hasMarker(repo(['readme.md']), ['*.csproj'])).toBe(false);
  // '*' is the always-probe marker and must not be confused with a glob.
  expect(hasMarker(repo([]), ['*'])).toBe(true);
});

it('hashes a lockfile for every ecosystem it claims to support', () => {
  const perEcosystem: Record<string, string> = {
    node: 'package-lock.json',
    python: 'poetry.lock',
    go: 'go.sum',
    rust: 'Cargo.lock',
    ruby: 'Gemfile.lock',
    php: 'composer.lock',
    dotnet: 'packages.lock.json',
    java: 'gradle.lockfile',
    elixir: 'mix.lock',
    dart: 'pubspec.lock',
  };
  for (const [ecosystem, lockfile] of Object.entries(perEcosystem)) {
    expect(LOCKFILE_NAMES, `${ecosystem} has no lockfile to hash`).toContain(lockfile);
  }
  // The list is the comparison key, so a duplicate would silently drop a hash.
  expect(new Set(LOCKFILE_NAMES).size).toBe(LOCKFILE_NAMES.length);
});

it('pulls a version out of what tools actually print', () => {
  expect(firstVersion('go version go1.22.1 linux/amd64')).toBe('1.22.1');
  expect(firstVersion('Python 3.12.4')).toBe('3.12.4');
  expect(firstVersion('ruby 3.3.0 (2023-12-25 revision 5124f9ac75) [x86_64-linux]')).toBe('3.3.0');
  expect(firstVersion('rustc 1.77.2 (25ef9e3d8 2024-04-09)')).toBe('1.77.2');
  expect(firstVersion('git version 2.41.0.windows.1')).toBe('2.41.0');
  expect(firstVersion('Docker version 26.1.1, build 4cf5afa')).toBe('26.1.1');
  expect(firstVersion('PHP 8.3.6 (cli) (built: Apr 15 2024)')).toBe('8.3.6');
  // java prints to stderr, in quotes, and calls it 17.0.10
  expect(firstVersion('openjdk version "17.0.10" 2024-01-16')).toBe('17.0.10');
  expect(firstVersion('Bundler version 2.5.9')).toBe('2.5.9');
  // Prerelease suffixes are part of the version — two machines on 1.0.0-rc1 and
  // 1.0.0-rc2 are not on the same thing.
  expect(firstVersion('v1.0.0-rc.2')).toBe('1.0.0-rc.2');
  expect(firstVersion('no numbers here')).toBeUndefined();
});

it('reads local dotenv keys and skips the templates git tracks', () => {
  // The variable that differs between two machines is almost always present in
  // .env.example on both, so a collector that folds the template in reports no
  // difference at exactly the moment there is one.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'stma-dotenv-'));
  roots.push(dir);
  writeFileSync(path.join(dir, '.env'), 'DATABASE_URL=x\nexport REDIS_URL=y\n# STRIPE_KEY=z\n');
  writeFileSync(path.join(dir, '.env.local'), 'LOCAL_ONLY=1\n');
  writeFileSync(path.join(dir, '.env.example'), 'DATABASE_URL=\nSTRIPE_KEY=\nREDIS_URL=\n');
  writeFileSync(path.join(dir, '.env.sample'), 'FROM_SAMPLE=\n');
  writeFileSync(path.join(dir, '.env.template'), 'FROM_TEMPLATE=\n');
  writeFileSync(path.join(dir, 'package.json'), '{}');

  const names = dotenvNames(dir).sort();
  expect(names).toEqual(['DATABASE_URL', 'LOCAL_ONLY', 'REDIS_URL']);
  expect(names).not.toContain('STRIPE_KEY');
  expect(names).not.toContain('FROM_SAMPLE');
  expect(names).not.toContain('FROM_TEMPLATE');
});

it('says nothing rather than throwing when there is no readable directory', () => {
  expect(dotenvNames(path.join(os.tmpdir(), 'stma-does-not-exist-' + Date.now()))).toEqual([]);
});
