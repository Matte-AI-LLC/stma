import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The public manifests plus the hosted composition when this is the private
 * development tree. The generated public mirror has no ee/ directory, so the
 * optional entry disappears there without changing its release commands.
 */
const manifests = [
  'package.json',
  'packages/shared/package.json',
  'packages/server/package.json',
  'packages/cli/package.json',
];
if (existsSync(fileURLToPath(new URL('../ee/package.json', import.meta.url)))) {
  manifests.push('ee/package.json');
}
export const MANIFESTS = manifests;

/** Packages that are actually published to npm. */
export const PUBLISHED = ['packages/server/package.json', 'packages/cli/package.json'];
