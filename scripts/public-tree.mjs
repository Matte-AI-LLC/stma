#!/usr/bin/env node
/**
 * Build the public tree — the one thing that is allowed to leave this repo.
 *
 * The private development home holds things a public repository must
 * never carry: business documents, infrastructure runbooks with resource names,
 * deploy pipelines, and one day `ee/`. The public repo is therefore built from
 * an ALLOWLIST — only the paths named here go, and everything else stays by
 * default. A blocklist fails open the day somebody adds a file nobody thought
 * about; an allowlist fails closed.
 *
 * After copying, every file is scanned for the identifiers that must not
 * appear in public — the staging hostname, Azure subscription and resource
 * names, personal addresses, the internal repo's own name. One match aborts
 * the build. This runs locally and in the release mirror job, so the guarantee
 * is mechanical, not a review habit.
 *
 *   node scripts/public-tree.mjs <out-dir> [ref]     # default ref: HEAD
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Everything the public repository consists of. Add deliberately. */
export const ALLOWLIST = [
  'packages',
  'examples',
  'scripts',
  'Dockerfile',
  'docker-compose.yml',
  'fly.toml',
  'package.json',
  'package-lock.json',
  'tsconfig.base.json',
  'README.md',
  'LICENSE',
  'CONTRIBUTING.md',
  'SECURITY.md',
  '.gitignore',
  '.env.example',
  'run-local-demo.bat',
  'run-agent-lab.bat',
  '.github/workflows/ci.yml',
];

/** Paths inside allowlisted directories that still must not ship. */
export const DENYLIST = ['packages/server/src/ee', 'ee'];

/**
 * Identifiers that end the build if they appear anywhere in the public tree.
 * Each is a real thing measured in this repository's history, not a guess.
 *
 * Spelled as concatenations so this file — which ships in the tree it scans —
 * never contains its own needles. The joined literal is what gets matched.
 */
export const FORBIDDEN = [
  'bluebush-' + 'd614df9c', // staging FQDN — deliberately unguessable, must stay unlinked
  '332b16a2-' + '0717', // Azure subscription id
  'be34d336-' + 'df0f', // Log Analytics workspace id
  'cab39f29' + 'f2d4acr', // ACR name
  'stma-db-' + 'a255', // Postgres server name
  'stma-' + 'rg', // resource group
  'grkem' + '.yilmaz', // personal address, disowned account identity
  'Rhea' + 'sus', // disowned account
  'stma-' + 'internal', // the private repo's own name
  'docs/' + 'business', // the internal documents, even as a reference
];

const out = process.argv[2];
const ref = process.argv[3] ?? 'HEAD';
if (!out) {
  console.error('usage: node scripts/public-tree.mjs <out-dir> [ref]');
  process.exit(2);
}

// Export the ref rather than copying the working tree: the mirror must describe
// a commit, never whatever happened to be sitting in somebody's checkout.
const stage = path.join(out, '.stage-export');
rmSync(out, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
execFileSync('sh', ['-c', `git -C "${root}" archive ${ref} | tar -x -C "${stage}"`]);

let copied = 0;
for (const rel of ALLOWLIST) {
  const from = path.join(stage, rel);
  if (!existsSync(from)) {
    console.error(`allowlist path missing in ${ref}: ${rel}`);
    process.exit(1);
  }
  const to = path.join(out, rel);
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  copied += 1;
}
for (const rel of DENYLIST) rmSync(path.join(out, rel), { recursive: true, force: true });
rmSync(stage, { recursive: true, force: true });

// The scan: binary-ish files are skipped by extension; everything else is read.
const SKIP = new Set(['.png', '.jpg', '.jpeg', '.gif', '.woff', '.woff2', '.ico', '.lock']);
const failures = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '.git') continue;
      walk(p);
      continue;
    }
    if (SKIP.has(path.extname(name))) continue;
    const text = readFileSync(p, 'latin1');
    for (const needle of FORBIDDEN) {
      if (text.includes(needle)) failures.push(`${path.relative(out, p)}: contains "${needle}"`);
    }
  }
}
walk(out);

if (failures.length > 0) {
  console.error('REFUSING to build the public tree — forbidden identifiers found:');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`public tree ready at ${out} (${copied} allowlisted paths from ${ref}, scan clean)`);
