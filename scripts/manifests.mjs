/**
 * The four manifests that must always carry the same version — the root, the
 * bundled-but-unpublished `shared`, and the two published packages. Shared by
 * set-version.mjs, check-version.mjs and the packaging tests, so "which files
 * count" is answered once.
 */
export const MANIFESTS = [
  'package.json',
  'packages/shared/package.json',
  'packages/server/package.json',
  'packages/cli/package.json',
];

/** Packages that are actually published to npm. */
export const PUBLISHED = ['packages/server/package.json', 'packages/cli/package.json'];
