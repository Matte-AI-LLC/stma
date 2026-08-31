import { fileURLToPath } from 'node:url';

// Resolves to packages/server/drizzle both in dev (src/paths.ts) and in the
// bundled build (dist/index.js) — both live one level below the package root.
export const defaultMigrationsDir = fileURLToPath(new URL('../drizzle', import.meta.url));
