#!/usr/bin/env node
/**
 * The gate the release train runs before it publishes anything.
 *
 * Two questions, both of which have cost somebody an afternoon somewhere:
 *   1. Do all four manifests agree? (`npm run version:check`)
 *   2. Does the git tag being released name that same version?
 *      (`npm run version:check -- v0.11.0`)
 *
 * The second is the one that matters at release time. npm publishes whatever
 * package.json says regardless of the tag that triggered the run, so a tag/
 * manifest mismatch does not fail — it silently publishes the wrong number, and
 * a published version can never be reused. Failing here costs a re-tag; failing
 * later costs a version.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFESTS } from './manifests.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const versions = MANIFESTS.map((rel) => ({
  rel,
  version: JSON.parse(readFileSync(path.join(root, rel), 'utf8')).version,
}));

const distinct = [...new Set(versions.map((v) => v.version))];
if (distinct.length !== 1) {
  console.error('Manifests disagree about the version:');
  for (const { rel, version } of versions) console.error(`  ${version}\t${rel}`);
  console.error('\nFix with: npm run version:set -- <version>');
  process.exit(1);
}

const version = distinct[0];
const tag = process.argv[2];
if (tag) {
  const wanted = tag.replace(/^v/, '');
  if (wanted !== version) {
    console.error(`Tag ${tag} does not name the version in the manifests (${version}).`);
    console.error(`Either re-tag as v${version}, or bump with: npm run version:set -- ${wanted}`);
    process.exit(1);
  }
  console.log(`ok: ${tag} matches all four manifests (${version}).`);
} else {
  console.log(`ok: all four manifests are ${version}.`);
}
