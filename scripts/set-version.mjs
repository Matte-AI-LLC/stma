#!/usr/bin/env node
/**
 * One version for all three layers.
 *
 * The repository ships the same code three ways — source under ELv2, two npm
 * packages, and a container image that runs the hosted service — and before
 * this each carried its own number: the image was on v0.10.1, the server
 * package on 0.7.2, the CLI on 0.2.2. Nothing was wrong with any of them
 * individually, which is exactly the problem: given a bug report naming "0.2.2"
 * there was no way to say which server it had talked to, and no way to tell
 * whether the image in production contained the CLI fix that shipped that week.
 *
 * So: one number, written here, and a git tag that must match it (see
 * check-version.mjs, which the release workflows run before publishing
 * anything). The bump is a commit, not a CI side effect — the repository should
 * always say out loud what it published.
 *
 *   node scripts/set-version.mjs 0.11.0     # or v0.11.0
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFESTS } from './manifests.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const raw = process.argv[2];
if (!raw) {
  console.error('usage: node scripts/set-version.mjs <version>   (e.g. 0.11.0)');
  process.exit(2);
}
const version = raw.replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Not a version: ${raw}. Expected MAJOR.MINOR.PATCH, optionally with a -prerelease.`);
  process.exit(2);
}

for (const rel of MANIFESTS) {
  const file = path.join(root, rel);
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  const before = pkg.version;
  pkg.version = version;
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`${rel}: ${before} → ${version}`);
}

// The lockfile records workspace versions too, and a lockfile that disagrees
// with the manifests fails `npm ci` on every runner — the one command every
// workflow starts with.
execFileSync('npm', ['install', '--package-lock-only', '--silent'], { cwd: root, stdio: 'inherit' });
console.log(`\npackage-lock.json updated. Next: commit, then \`git tag v${version} && git push --tags\`.`);
