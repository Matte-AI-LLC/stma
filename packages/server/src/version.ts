import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * What this build calls itself.
 *
 * Read from the package manifest rather than baked in by the bundler, because
 * both layouts put it in the same place: this file is one directory below the
 * package root in the checkout (`src/version.ts`), and tsup collapses the whole
 * server into `dist/index.js`, which is also one directory below it. So dev,
 * tests, the npm package and the container image all answer the same way, and
 * nothing has to be generated.
 *
 * It is deliberately not fatal. A version string is diagnostic; an instance
 * that refuses to boot because it could not read its own manifest would be a
 * far worse trade than one that reports `unknown`.
 */
function readVersion(): string {
  try {
    const manifest = fileURLToPath(new URL('../package.json', import.meta.url));
    return (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export const VERSION = readVersion();
