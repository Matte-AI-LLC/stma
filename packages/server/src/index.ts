import 'dotenv/config';
import { bootNodeEnv, loadEnv } from './env';
import { startServer } from './server';

// Before anything reads it: an installed server nobody configured is not a
// development server. See bootNodeEnv.
process.env.NODE_ENV = bootNodeEnv();

const env = loadEnv();
const { url } = await startServer(env);

const notes = [env.nodeEnv];
if (env.devMode) notes.push('dev auth ON');
if (!env.databaseUrl) notes.push(`pglite: ${env.pgliteDir}`);
console.log(`stma listening on ${url} (${notes.join(', ')})`);
console.log(`  dashboard: ${url}/`);
console.log(`  mcp:       ${url}/mcp`);
