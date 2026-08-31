import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * What this CLI calls itself — same trick as the server's `src/version.ts`, and
 * for the same reason: `src/version.ts` and the bundled `dist/index.js` are both
 * one directory below the package root, so no build step has to inject it.
 *
 * It is sent on every request as `x-stma-client`, which is what makes a support
 * question answerable. "The CLI says 0.11.0 and the server says 0.9.3" is a
 * diagnosis; "it does not work" is not.
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

/** The header every STMA client sends, so a server can see its version mix. */
export const CLIENT_HEADER = 'x-stma-client';

export const clientHeaders = (): Record<string, string> => ({ [CLIENT_HEADER]: `stma/${VERSION}` });
