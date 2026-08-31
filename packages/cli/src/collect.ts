import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs';
import path from 'node:path';

/**
 * What is actually installed on this machine, across ecosystems.
 *
 * The collector used to report node and npm and nothing else, which meant a
 * Python or Go team got a diff of two lines and a lockfile hash — the weakest
 * possible version of the product, shown to most of the market. Version skew is
 * version skew whatever the language; there was no reason for the answer to be
 * node-shaped.
 *
 * Probes are chosen from what the repository looks like rather than run as a
 * fixed battery: a Go repo should not pay for a Ruby probe, and a snapshot that
 * takes three seconds is a snapshot agents stop taking. Everything is best
 * effort — a missing binary is a missing line, never an error.
 */

export interface Probe {
  /** Key in the snapshot's runtimes/packageManagers map. */
  key: string;
  command: string;
  args: string[];
  /** Pull a bare version out of whatever the tool prints. */
  parse?: (raw: string) => string | undefined;
}

/** First dotted version in the output — covers "go version go1.22.1 …", "Python 3.12.4", "v20.11.0". */
export const firstVersion = (raw: string): string | undefined =>
  /(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/.exec(raw)?.[1];

const bare = (raw: string): string | undefined => firstVersion(raw) ?? raw.split(/\r?\n/)[0]?.trim();

/** Runtimes, keyed by the marker files that make them worth probing. */
const RUNTIME_PROBES: Array<{ when: string[]; probes: Probe[] }> = [
  {
    when: ['*'],
    probes: [{ key: 'git', command: 'git', args: ['--version'], parse: firstVersion }],
  },
  {
    when: ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py', 'setup.cfg', '.python-version', 'tox.ini'],
    probes: [
      { key: 'python', command: 'python3', args: ['--version'], parse: firstVersion },
      { key: 'python', command: 'python', args: ['--version'], parse: firstVersion },
    ],
  },
  { when: ['go.mod', 'go.work'], probes: [{ key: 'go', command: 'go', args: ['version'], parse: firstVersion }] },
  {
    when: ['Cargo.toml'],
    probes: [{ key: 'rust', command: 'rustc', args: ['--version'], parse: firstVersion }],
  },
  {
    when: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle'],
    probes: [{ key: 'java', command: 'java', args: ['-version'], parse: firstVersion }],
  },
  {
    when: ['Gemfile', '.ruby-version', 'Rakefile'],
    probes: [{ key: 'ruby', command: 'ruby', args: ['--version'], parse: firstVersion }],
  },
  {
    when: ['composer.json'],
    probes: [{ key: 'php', command: 'php', args: ['--version'], parse: firstVersion }],
  },
  {
    when: ['global.json', '*.csproj', '*.fsproj', '*.sln'],
    probes: [{ key: 'dotnet', command: 'dotnet', args: ['--version'], parse: bare }],
  },
  {
    when: ['mix.exs'],
    probes: [{ key: 'elixir', command: 'elixir', args: ['--version'], parse: firstVersion }],
  },
  {
    when: ['pubspec.yaml'],
    probes: [{ key: 'dart', command: 'dart', args: ['--version'], parse: firstVersion }],
  },
  {
    // Containers are where "works on my machine" hides once the languages match.
    when: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'],
    probes: [{ key: 'docker', command: 'docker', args: ['--version'], parse: firstVersion }],
  },
];

const PM_PROBES: Array<{ when: string[]; probes: Probe[] }> = [
  { when: ['pnpm-lock.yaml'], probes: [{ key: 'pnpm', command: 'pnpm', args: ['--version'], parse: bare }] },
  { when: ['yarn.lock'], probes: [{ key: 'yarn', command: 'yarn', args: ['--version'], parse: bare }] },
  { when: ['bun.lockb', 'bun.lock'], probes: [{ key: 'bun', command: 'bun', args: ['--version'], parse: bare }] },
  {
    when: ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py'],
    probes: [
      { key: 'pip', command: 'pip3', args: ['--version'], parse: firstVersion },
      { key: 'pip', command: 'pip', args: ['--version'], parse: firstVersion },
    ],
  },
  { when: ['poetry.lock'], probes: [{ key: 'poetry', command: 'poetry', args: ['--version'], parse: firstVersion }] },
  { when: ['uv.lock'], probes: [{ key: 'uv', command: 'uv', args: ['--version'], parse: firstVersion }] },
  { when: ['Gemfile'], probes: [{ key: 'bundler', command: 'bundle', args: ['--version'], parse: firstVersion }] },
  { when: ['composer.json'], probes: [{ key: 'composer', command: 'composer', args: ['--version'], parse: firstVersion }] },
  { when: ['Cargo.toml'], probes: [{ key: 'cargo', command: 'cargo', args: ['--version'], parse: firstVersion }] },
  { when: ['pom.xml'], probes: [{ key: 'maven', command: 'mvn', args: ['--version'], parse: firstVersion }] },
  {
    when: ['build.gradle', 'build.gradle.kts', 'gradlew'],
    probes: [{ key: 'gradle', command: 'gradle', args: ['--version'], parse: firstVersion }],
  },
  { when: ['mix.exs'], probes: [{ key: 'mix', command: 'mix', args: ['--version'], parse: firstVersion }] },
];

/**
 * Lockfiles worth hashing. A lockfile hash is the single highest-signal line in
 * a diff — two machines with the same hash installed the same tree — so this
 * list is the one place breadth pays off most.
 */
export const LOCKFILE_NAMES = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'npm-shrinkwrap.json',
  'bun.lockb',
  'bun.lock',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'pdm.lock',
  'requirements.txt',
  'go.sum',
  'Cargo.lock',
  'Gemfile.lock',
  'composer.lock',
  'packages.lock.json',
  'gradle.lockfile',
  'mix.lock',
  'pubspec.lock',
  'flake.lock',
];

/** Does the directory hold any of these markers? `*` always matches; `*.ext` globs the extension. */
export function hasMarker(dir: string, markers: string[], entries?: string[]): boolean {
  if (markers.includes('*')) return true;
  const plain = markers.filter((m) => !m.startsWith('*.'));
  if (plain.some((m) => existsSync(path.join(dir, m)))) return true;
  const globs = markers.filter((m) => m.startsWith('*.')).map((m) => m.slice(1));
  if (globs.length === 0) return false;
  const names = entries ?? safeList(dir);
  return names.some((name) => globs.some((ext) => name.endsWith(ext)));
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function run(dir: string, probe: Probe): string | undefined {
  try {
    const raw = execFileSync(probe.command, probe.args, {
      cwd: dir,
      encoding: 'utf8',
      // `java -version` prints to stderr; merging means one code path for both.
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 4000,
    });
    const text = String(raw).trim();
    return (probe.parse ? probe.parse(text) : text) || undefined;
  } catch (error) {
    // A tool that writes its version to stderr and exits non-zero is still telling
    // us the version — java did exactly this for years.
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    if (stderr) {
      const text = String(stderr).trim();
      const parsed = probe.parse ? probe.parse(text) : text;
      if (parsed) return parsed;
    }
    return undefined;
  }
}

/**
 * Run one group's probes until one answers. Alternatives exist because the same
 * runtime is spelled differently per platform — `python3` on macOS/Linux,
 * `python` on Windows — and reporting "missing" for a machine that has it is a
 * false difference, which is worse than no line at all.
 */
function collectGroup(
  dir: string,
  groups: Array<{ when: string[]; probes: Probe[] }>,
  entries: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const group of groups) {
    if (!hasMarker(dir, group.when, entries)) continue;
    for (const probe of group.probes) {
      if (out[probe.key]) continue;
      const value = run(dir, probe);
      if (value) out[probe.key] = value;
    }
  }
  return out;
}

export interface EcosystemScan {
  runtimes: Record<string, string>;
  packageManagers: Record<string, string>;
  /** Marker files that suggested a probe — useful for explaining an empty result. */
  ecosystems: string[];
}

const ECOSYSTEM_NAMES: Array<[string, string[]]> = [
  ['node', ['package.json']],
  ['python', ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py']],
  ['go', ['go.mod', 'go.work']],
  ['rust', ['Cargo.toml']],
  ['java', ['pom.xml', 'build.gradle', 'build.gradle.kts']],
  ['ruby', ['Gemfile']],
  ['php', ['composer.json']],
  ['dotnet', ['global.json', '*.csproj', '*.fsproj', '*.sln']],
  ['elixir', ['mix.exs']],
  ['dart', ['pubspec.yaml']],
  ['docker', ['Dockerfile', 'docker-compose.yml', 'compose.yaml']],
];

/** Everything this machine has that this repository looks like it needs. */
export function scanEcosystems(dir: string): EcosystemScan {
  const entries = safeList(dir);
  return {
    runtimes: collectGroup(dir, RUNTIME_PROBES, entries),
    packageManagers: collectGroup(dir, PM_PROBES, entries),
    ecosystems: ECOSYSTEM_NAMES.filter(([, markers]) => hasMarker(dir, markers, entries)).map(
      ([name]) => name,
    ),
  };
}

/**
 * Committed templates — `.env.example` and friends — carry the same keys on every
 * machine, so folding them into a snapshot cannot reveal a difference, only hide
 * one: the key that sits in one developer's `.env` and is missing from another's
 * is in the template on both sides, and the diff then reports nothing. Which is
 * the exact case a snapshot exists to catch.
 */
const DOTENV_TEMPLATE = /(^|\.)(example|sample|template|dist|defaults?)$/i;

/** Key names from the repository's LOCAL dotenv files. Names only, never values. */
export function dotenvNames(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/^\.env(?:\..+)?$/.test(entry.name)) continue;
    if (DOTENV_TEMPLATE.test(entry.name)) continue;
    let body: string;
    try {
      body = readFileSync(path.join(dir, entry.name), 'utf8');
    } catch {
      continue;
    }
    for (const line of body.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      if (match) names.push(match[1]!);
    }
  }
  return names;
}
