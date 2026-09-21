import 'dotenv/config';
import { DATA_DIRECTORY_ERROR } from './db';
import { runUpgradeCommand, upgradeTarget } from './db/upgrade';
import { bootNodeEnv, DEFAULT_PGLITE_DIR, loadEnv } from './env';
import { startServer } from './server';

// Before anything reads it: an installed server nobody configured is not a
// development server. See bootNodeEnv.
process.env.NODE_ENV = bootNodeEnv();

// Not a server start at all: the one command that takes a data directory across
// a PostgreSQL major (db/upgrade.ts). Answered before loadEnv, because the flag
// carries the directory and the person running it has just been told their
// server will not start — asking them for DATABASE_URL first is another wall.
const upgrading = upgradeTarget(process.argv);
if (upgrading) {
  process.exit(
    await runUpgradeCommand(upgrading.dir ?? process.env.PGLITE_DIR ?? DEFAULT_PGLITE_DIR, {
      migrationsDir: process.env.MIGRATIONS_DIR || undefined,
    }),
  );
}

const env = loadEnv();

let url: string;
try {
  ({ url } = await startServer(env));
} catch (error) {
  // The refusal already is the answer. Printing it under a stack trace is how
  // the opaque failure it replaced used to read.
  if (error instanceof Error && error.name === DATA_DIRECTORY_ERROR) {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

const notes = [env.nodeEnv];
if (env.devMode) notes.push('dev auth ON');
if (!env.databaseUrl) notes.push(`pglite: ${env.pgliteDir}`);
console.log(`stma listening on ${url} (${notes.join(', ')})`);
console.log(`  dashboard: ${url}/`);
console.log(`  mcp:       ${url}/mcp`);
