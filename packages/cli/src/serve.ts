import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from './version.js';

/**
 * One command, no infrastructure.
 *
 * Trying STMA used to mean an invite to the hosted instance or a decision to
 * self-host — a Postgres, a Docker command, an environment file. That is a
 * strange amount of setup to ask of somebody who has not seen the product work
 * yet, and it is the reason the free tier was theoretical.
 *
 * `stma serve` boots a real instance on this machine with an embedded database
 * and no configuration, keeps its data in one place across directories, and
 * prints the three steps to a connected agent. The server is a separate package
 * so the CLI stays small for the people who only want the CLI; if it is not
 * installed we fetch it the same way npx would.
 */

const SERVER_PACKAGE = '@matteai/stma-server';

/**
 * Which server to fetch: the one that shipped with this CLI.
 *
 * Both packages are published by the same tag, so the matching version always
 * exists — and asking for `latest` instead would mean a CLI installed months
 * ago silently pulling a server built against a newer client, which is the one
 * skew this repository can actually prevent rather than merely report. The
 * unpinned name stays as the fallback for a build whose version is not a
 * release (someone running a checkout they built themselves).
 */
export function serverSpec(version: string = VERSION): string {
  return /^\d+\.\d+\.\d+$/.test(version) ? `${SERVER_PACKAGE}@${version}` : SERVER_PACKAGE;
}

export interface ServeOptions {
  port: number;
  host: string;
  dataDir: string;
}

/** Where a standalone instance keeps its database, so any directory finds it again. */
export const defaultDataDir = (): string => path.join(os.homedir(), '.stma', 'data');

/**
 * The server's entry point, if this machine already has it: installed next to
 * the CLI, or sitting in the monorepo during development. Returns null when it
 * has to be fetched.
 */
export function resolveServerEntry(): string | null {
  const require = createRequire(import.meta.url);
  try {
    const manifest = require.resolve(`${SERVER_PACKAGE}/package.json`);
    const entry = path.join(path.dirname(manifest), 'dist', 'index.js');
    if (existsSync(entry)) return entry;
  } catch {
    /* not installed */
  }
  // Development: packages/cli/{src,dist} → packages/server/dist
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.resolve(here, '../../server/dist/index.js'),
    path.resolve(here, '../../../server/dist/index.js'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Environment for a local instance: embedded database, local accounts, no cloud. */
export function serveEnv(options: ServeOptions): NodeJS.ProcessEnv {
  const base = `http://${options.host === '0.0.0.0' ? 'localhost' : options.host}:${options.port}`;
  return {
    ...process.env,
    NODE_ENV: 'production',
    HOST: options.host,
    PORT: String(options.port),
    BASE_URL: base,
    EMBEDDED_DB: '1',
    PGLITE_DIR: options.dataDir,
    // Local accounts with open signup: the person who runs this is the person
    // who should get the first account. Dev auth is deliberately NOT enabled —
    // a passwordless login form is not a thing to hand somebody by default,
    // even on localhost.
    AUTH_LOCAL: '1',
    SIGNUPS_OPEN: '1',
    AUTH_2FA: '0',
  };
}

export function connectSnippet(base: string): string {
  return `claude mcp add --scope user --transport http stma ${base}/mcp --header "Authorization: Bearer stma_YOUR_TOKEN"`;
}

async function waitForHealth(base: string, child: ChildProcess): Promise<boolean> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return true;
    } catch {
      /* still booting */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

export async function serve(options: ServeOptions): Promise<void> {
  const base = `http://${options.host === '0.0.0.0' ? 'localhost' : options.host}:${options.port}`;
  const entry = resolveServerEntry();
  const env = serveEnv(options);

  const child = entry
    ? spawn(process.execPath, [entry], { env, stdio: ['ignore', 'inherit', 'inherit'] })
    : // No local copy: fetch it once, exactly as npx would. Said out loud, because
      // a command that silently downloads a server is not a command anyone should trust.
      (console.log(`Fetching ${serverSpec()} (first run only)…`),
      spawn('npx', ['-y', serverSpec()], {
        env,
        stdio: ['ignore', 'inherit', 'inherit'],
        shell: process.platform === 'win32',
      }));

  const stop = () => {
    child.kill('SIGINT');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', (code) => process.exit(code ?? 0));

  const healthy = await waitForHealth(base, child);
  if (!healthy) {
    console.error(
      child.exitCode !== null
        ? `\nThe server exited before it was ready.${entry ? '' : `\nIf ${SERVER_PACKAGE} could not be fetched, install it once: npm i -g ${SERVER_PACKAGE}`}`
        : `\nThe server did not answer ${base}/health in 90s. Something else may be on port ${options.port} — try --port.`,
    );
    return;
  }

  console.log(
    [
      '',
      `  STMA is running at ${base}`,
      '',
      `  1. Create your account   ${base}/signup`,
      `  2. Create a token        ${base}/app/tokens`,
      '  3. Connect your agent:',
      '',
      `     ${connectSnippet(base)}`,
      '',
      `  Guide  ${base}/docs`,
      `  Data   ${options.dataDir}`,
      '  Stop   Ctrl+C',
      '',
    ].join('\n'),
  );
}
