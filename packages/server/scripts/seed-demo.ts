/**
 * Demo seeder: fills a running STMA instance with a believable fictional
 * organisation ("Test Company", a payments platform) so every screen has real
 * data to explore — a personal fleet with drifting machines, a critical work
 * conflict on the live agent map, policies with a drifted receipt, a failing
 * environment preflight, open and archived debug sessions, and announcements.
 *
 * Everything goes through the real HTTP surfaces (signup, web forms, MCP tools,
 * control-plane APIs) — nothing is written to the database directly, so the
 * seeded state is exactly what the product itself produces.
 *
 *   npx tsx scripts/seed-demo.ts --url https://host --password "<pw>"
 *
 * The target instance must run with SIGNUPS_OPEN=1 and AUTH_2FA=0.
 */
import { setTimeout as sleep } from 'node:timers/promises';

// ---------------------------------------------------------------- options

interface Options {
  url: string;
  password: string;
  /** Re-run against an instance that already holds the demo, under a suffixed slug. */
  force: boolean;
  /** Keep heartbeating the seeded runs for N minutes so the agent map stays live. */
  keepAliveMinutes: number;
}

const USAGE = `Seed a running STMA instance with the "Test Company" demo organisation.

Usage:
  npx tsx scripts/seed-demo.ts --url <base-url> [--password <pw>] [--force] [--keep-alive <minutes>]

Options:
  --url <base-url>       Required. e.g. http://127.0.0.1:3000 or https://stma.example.com
  --password <pw>        Password for every seeded account. Prefer SEED_PASSWORD in the
                         environment — a command line is visible to other processes.
  --force                The demo already exists: seed a second copy under a suffixed
                         slug (test-company-ab12) instead of refusing.
  --keep-alive <min>     After seeding, heartbeat the agent runs for this many minutes so
                         the live agent map keeps showing the conflict (runs go stale
                         AGENT_STALE_MINUTES after their last heartbeat, 3 by default).
  -h, --help             Show this help.

Environment:
  SEED_PASSWORD          Password for every seeded account (alternative to --password).
`;

/** Returns undefined for --help, which is not an error. */
function parseArgs(argv: string[]): Options | undefined {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      if (arg === '-h') flags.add('help');
      continue;
    }
    const eq = arg.indexOf('=');
    const name = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).toLowerCase();
    if (name === 'force' || name === 'help') {
      flags.add(name);
      continue;
    }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) fail(`Missing value for --${name}.`);
    values.set(name, value);
  }

  if (flags.has('help')) {
    process.stdout.write(USAGE);
    return undefined;
  }

  const rawUrl = values.get('url');
  if (!rawUrl) fail(`--url is required.\n\n${USAGE}`);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return fail(`--url is not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail(`--url must be http:// or https:// (got ${url.protocol}).`);
  }

  const password = values.get('password') ?? process.env.SEED_PASSWORD ?? '';
  if (!password) {
    fail('No password. Pass --password "<pw>" or set SEED_PASSWORD. Nothing is hardcoded here.');
  }
  if (password.length < 8 || password.length > 128) {
    fail('The password must be 8-128 characters — the server rejects anything else.');
  }

  const keepAliveRaw = values.get('keep-alive') ?? '0';
  const keepAliveMinutes = Number(keepAliveRaw);
  if (!Number.isFinite(keepAliveMinutes) || keepAliveMinutes < 0 || keepAliveMinutes > 240) {
    fail(`--keep-alive must be a number of minutes between 0 and 240 (got ${keepAliveRaw}).`);
  }

  return {
    url: `${url.origin}${url.pathname}`.replace(/\/+$/, ''),
    password,
    force: flags.has('force'),
    keepAliveMinutes,
  };
}

// ---------------------------------------------------------------- http plumbing

interface Reply {
  method: string;
  path: string;
  status: number;
  body: string;
  location: string | null;
}

interface Jar {
  header(): Record<string, string>;
  store(response: Response): void;
}

/** Cookie jar per persona, so each browser session is genuinely separate. */
function cookieJar(): Jar {
  const cookies = new Map<string, string>();
  return {
    header(): Record<string, string> {
      if (!cookies.size) return {};
      return { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') };
    },
    store(response) {
      for (const line of response.headers.getSetCookie()) {
        const [keyValue] = line.split(';');
        const separator = keyValue!.indexOf('=');
        cookies.set(keyValue!.slice(0, separator), keyValue!.slice(separator + 1));
      }
    },
  };
}

let baseUrl = '';
/** Flipped once the first row exists, so a pre-flight failure does not imply a half-seed. */
let wroteSomething = false;

async function request(
  method: string,
  path: string,
  init: { headers?: Record<string, string>; body?: string; jar?: Jar } = {},
): Promise<Reply> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...(init.headers ?? {}), ...(init.jar?.header() ?? {}) },
      body: init.body,
      redirect: 'manual',
    });
  } catch (err) {
    return fail(
      `${method} ${path} could not reach ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  init.jar?.store(response);
  return {
    method,
    path,
    status: response.status,
    body: await response.text(),
    location: response.headers.get('location'),
  };
}

const get = (path: string, jar?: Jar) => request('GET', path, { jar });

/** Browser form post (what the dashboard UI itself sends). */
const form = (path: string, fields: Record<string, string>, jar?: Jar) =>
  request('POST', path, {
    jar,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });

/** Control-plane / inbound-hook JSON post. */
const postJson = (path: string, body: unknown, token?: string) =>
  request('POST', path, {
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

/** Every unexpected result ends here: loud, with the response that caused it. */
class SeedFailure extends Error {
  constructor(
    message: string,
    readonly reply?: Reply,
  ) {
    super(message);
    this.name = 'SeedFailure';
  }
}

function fail(message: string, reply?: Reply): never {
  throw new SeedFailure(message, reply);
}

function expectStatus(reply: Reply, status: number, what: string): Reply {
  if (reply.status !== status) fail(`${what} (expected HTTP ${status})`, reply);
  return reply;
}

function expectRedirect(reply: Reply, what: string, to?: string): Reply {
  if (reply.status !== 302) fail(`${what} (expected a 302 redirect)`, reply);
  if (to !== undefined && reply.location !== to) {
    fail(`${what} — redirected to "${reply.location}" instead of "${to}"`, reply);
  }
  return reply;
}

function expectJson<T>(reply: Reply, what: string): T {
  expectStatus(reply, 200, what);
  try {
    return JSON.parse(reply.body) as T;
  } catch {
    return fail(`${what} — response was not JSON`, reply);
  }
}

function expectContains(reply: Reply, needle: string, what: string): void {
  if (!reply.body.includes(needle)) fail(`${what} — "${needle}" is missing from the page`, reply);
}

// ---------------------------------------------------------------- MCP plumbing

interface McpReply {
  result?: { content?: Array<{ text?: string }>; isError?: boolean };
  error?: { message?: string };
}

let rpcId = 0;

/** One MCP tool call over stateless Streamable HTTP, exactly as an agent makes it. */
async function mcp(token: string, tool: string, args: Record<string, unknown>): Promise<string> {
  const reply = await request('POST', '/mcp', {
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++rpcId,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  });
  const json = expectJson<McpReply>(reply, `MCP ${tool}`);
  if (json.error) fail(`MCP ${tool} returned a protocol error: ${json.error.message}`, reply);
  const text = json.result?.content?.[0]?.text ?? '';
  if (json.result?.isError) fail(`MCP ${tool} failed: ${text}`, reply);
  return text;
}

/** Same, for the tools that answer with a JSON document. */
async function mcpJson<T>(token: string, tool: string, args: Record<string, unknown>): Promise<T> {
  const text = await mcp(token, tool, args);
  try {
    return JSON.parse(text) as T;
  } catch {
    return fail(`MCP ${tool} did not return JSON:\n${text.slice(0, 400)}`);
  }
}

async function mcpInitialize(token: string, client: string): Promise<void> {
  const reply = await request('POST', '/mcp', {
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++rpcId,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: client, version: 'seed-demo' },
      },
    }),
  });
  expectStatus(reply, 200, `MCP handshake for ${client}`);
}

// ---------------------------------------------------------------- scenario data

const REPO_PAYMENTS = 'payments-api';
const REPO_STOREFRONT = 'storefront-web';
const REPO_INFRA = 'platform-infra';

/** The lockfile every machine is *supposed* to have (matches the baseline). */
const LOCK_GOOD = 'b7d41e05c9f2a6183d47ce0b28aa15f3c6d90e74';
/** What you get after an accidental `npm install` on an old branch. */
const LOCK_DRIFTED = '2c58a91f6b0d34e7cc1a8f52d09b7e63a4185fd0';

/** Ayse's MacBook: the machine that matches the payments-api baseline. */
const AYSE_MACBOOK = {
  os: { platform: 'darwin', release: '24.5.0', arch: 'arm64' },
  shell: '/bin/zsh',
  runtimes: { node: '22.14.0', python: '3.12.7', java: '21.0.4' },
  packageManagers: { npm: '10.9.2', pnpm: '9.15.4' },
  lockfiles: [
    { path: 'package-lock.json', hash: LOCK_GOOD },
    { path: 'services/ledger/poetry.lock', hash: '5a0c7fe2318d94b6ac71e0f5d382b91c47ea6d08' },
  ],
  envVarNames: [
    'PATH',
    'HOME',
    'SHELL',
    'LANG',
    'TZ',
    'NODE_ENV',
    'DATABASE_URL',
    'PAYMENTS_WEBHOOK_SECRET',
    'STRIPE_API_BASE',
    'AWS_REGION',
  ],
  git: {
    branch: 'feat/refunds-ledger',
    sha: '9f4c2ab',
    dirtyFiles: ['src/payments/refund.ts', 'db/migrations/0042_refunds_ledger.sql'],
    aheadBehind: 'ahead 2, behind 0',
  },
  locale: 'en_US.UTF-8',
  timezone: 'Europe/Istanbul',
};

/**
 * Ayse's Linux desktop: same person, same repo, three deliberate drifts —
 * older node, a missing required env var name, a different lockfile hash.
 */
const AYSE_LINUX = {
  os: { platform: 'linux', release: '6.8.0-45-generic', arch: 'x64' },
  shell: '/usr/bin/bash',
  runtimes: { node: '20.11.1', python: '3.11.9', java: '17.0.11' },
  packageManagers: { npm: '10.2.4', pnpm: '9.15.4' },
  lockfiles: [
    { path: 'package-lock.json', hash: LOCK_DRIFTED },
    { path: 'services/ledger/poetry.lock', hash: '5a0c7fe2318d94b6ac71e0f5d382b91c47ea6d08' },
  ],
  envVarNames: [
    'PATH',
    'HOME',
    'SHELL',
    'LANG',
    'TZ',
    'NODE_ENV',
    'DATABASE_URL',
    'STRIPE_API_BASE',
    'AWS_REGION',
    'NVM_DIR',
  ],
  git: {
    branch: 'feat/refunds-ledger',
    sha: 'c07d61e',
    dirtyFiles: [],
    aheadBehind: 'ahead 0, behind 6',
  },
  locale: 'en_US.UTF-8',
  timezone: 'Europe/Istanbul',
};

const GORKEM_MACBOOK = {
  os: { platform: 'darwin', release: '24.5.0', arch: 'arm64' },
  shell: '/bin/zsh',
  runtimes: { node: '22.14.0', python: '3.12.7' },
  packageManagers: { npm: '10.9.2', pnpm: '9.15.4' },
  lockfiles: [{ path: 'package-lock.json', hash: LOCK_GOOD }],
  envVarNames: [
    'PATH',
    'HOME',
    'SHELL',
    'LANG',
    'TZ',
    'NODE_ENV',
    'DATABASE_URL',
    'PAYMENTS_WEBHOOK_SECRET',
    'STRIPE_API_BASE',
  ],
  git: { branch: 'main', sha: 'a41f7c9', dirtyFiles: [], aheadBehind: 'ahead 0, behind 0' },
  locale: 'en_US.UTF-8',
  timezone: 'Europe/Istanbul',
};

const MERT_MACBOOK = {
  os: { platform: 'darwin', release: '23.6.0', arch: 'arm64' },
  shell: '/bin/zsh',
  runtimes: { node: '20.11.1', bun: '1.1.29' },
  packageManagers: { npm: '10.2.4', pnpm: '9.12.3' },
  lockfiles: [
    { path: 'pnpm-lock.yaml', hash: 'd93b1a4c7e58026fb1cd9a370e46f8215b7c0da9' },
    { path: 'package-lock.json', hash: LOCK_DRIFTED },
  ],
  envVarNames: [
    'PATH',
    'HOME',
    'SHELL',
    'LANG',
    'TZ',
    'NODE_ENV',
    'DATABASE_URL',
    'STRIPE_API_BASE',
    'VITE_CHECKOUT_API',
  ],
  git: {
    branch: 'feat/partial-refunds',
    sha: '4b81d0f',
    dirtyFiles: ['src/routes/checkout/+page.server.ts'],
    aheadBehind: 'ahead 1, behind 3',
  },
  locale: 'en_US.UTF-8',
  timezone: 'Europe/Istanbul',
};

const DENIZ_WSL = {
  os: { platform: 'linux', release: '5.15.153.1-microsoft-standard-WSL2', arch: 'x64' },
  shell: '/usr/bin/bash',
  runtimes: { node: '20.19.0', python: '3.11.9', terraform: '1.9.5' },
  packageManagers: { npm: '10.8.2' },
  lockfiles: [
    { path: 'package-lock.json', hash: LOCK_GOOD },
    { path: 'infra/terraform/.terraform.lock.hcl', hash: 'ff2a7c19b6ed40538a1c0d97be24f5613cc8a0d2' },
  ],
  envVarNames: [
    'PATH',
    'HOME',
    'SHELL',
    'LANG',
    'TZ',
    'AWS_REGION',
    'AWS_PROFILE',
    'TF_WORKSPACE',
    'KUBECONFIG',
    'WSL_DISTRO_NAME',
  ],
  git: {
    branch: 'chore/payments-db-parameter-group',
    sha: '6ed2f18',
    dirtyFiles: ['infra/terraform/payments/db.tf'],
    aheadBehind: 'ahead 1, behind 0',
  },
  locale: 'en_US.UTF-8',
  timezone: 'Europe/Istanbul',
};

/** The golden environment for payments-api, published by the team lead. */
const PAYMENTS_BASELINE = {
  os: { platform: 'darwin', arch: 'arm64' },
  runtimes: { node: '22.14.0', python: '3.12.7' },
  packageManagers: { npm: '10.9.2' },
  lockfiles: [
    { path: 'package-lock.json', hash: LOCK_GOOD },
    { path: 'services/ledger/poetry.lock', hash: '5a0c7fe2318d94b6ac71e0f5d382b91c47ea6d08' },
  ],
  envVarNames: [
    'PATH',
    'HOME',
    'NODE_ENV',
    'DATABASE_URL',
    'PAYMENTS_WEBHOOK_SECRET',
    'STRIPE_API_BASE',
  ],
  git: { branch: 'main', sha: 'a41f7c9', dirtyFiles: [] },
  timezone: 'Europe/Istanbul',
};

// ---------------------------------------------------------------- people

interface Person {
  label: string;
  email: string;
  /** Filled in from the server (redeem response / whoami) — never assumed. */
  username: string;
  jar: Jar;
  /** Machine name -> personal access token. */
  tokens: Record<string, string>;
  /** Convenience: the token of the person's primary machine. */
  token: string;
}

function person(label: string, email: string): Person {
  return { label, email, username: '', jar: cookieJar(), tokens: {}, token: '' };
}

let stepNo = 0;
function step(title: string): void {
  stepNo += 1;
  process.stdout.write(`\n[${stepNo}] ${title}\n`);
}

const done = (line: string): void => void process.stdout.write(`    ${line}\n`);

// ---------------------------------------------------------------- seeding

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) return; // --help
  baseUrl = opts.url;

  const suffix = opts.force ? `-${Math.random().toString(36).slice(2, 6)}` : '';
  const domain = 'test-company.dev';
  const teamName = opts.force ? `Test Company ${suffix.slice(1)}` : 'Test Company';
  const teamSlug = `test-company${suffix}`;

  const gorkem = person('team lead', `gorkem${suffix}@${domain}`);
  const ayse = person('backend', `ayse${suffix}@${domain}`);
  const mert = person('frontend', `mert${suffix}@${domain}`);
  const deniz = person('infra', `deniz${suffix}@${domain}`);
  const teammates = [ayse, mert, deniz];

  process.stdout.write(`Seeding "${teamName}" into ${baseUrl}\n`);

  // -------------------------------------------------------------- 1. probe
  step('Checking the instance');
  const health = await get('/health');
  expectStatus(health, 200, 'GET /health');
  if (!health.body.includes('"ok":true')) fail('GET /health did not report ok', health);

  const signupPage = await get('/signup');
  if (signupPage.status !== 200) {
    fail(
      'Signups look closed on this instance (GET /signup did not render the form). ' +
        'Start the target with SIGNUPS_OPEN=1 (and AUTH_2FA=0) before seeding.',
      signupPage,
    );
  }

  // Nothing exposes the auth configuration, so the login page is the only pre-flight
  // signal: it offers password recovery only when email sign-in codes are enabled.
  // Checking here means an AUTH_2FA=1 instance fails before a single row is written.
  const loginPage = await get('/login');
  expectStatus(loginPage, 200, 'GET /login');
  if (loginPage.body.includes('href="/forgot"')) {
    fail(
      'This instance looks like it has email sign-in codes on (AUTH_2FA=1). The seeded ' +
        'teammates could never sign in to mint their machine tokens. Set AUTH_2FA=0 on the ' +
        'target and re-run.',
    );
  }
  done(`reachable, signups open, sign-in codes off, seeding as ${gorkem.email}`);

  // -------------------------------------------------------------- 2. owner + team
  step('Creating the owner account and the team');
  const signup = await form(
    '/auth/local/signup',
    { email: gorkem.email, password: opts.password },
    gorkem.jar,
  );
  if (signup.status === 404) {
    fail('Signup is disabled on this instance (SIGNUPS_OPEN=0). Enable it, then re-run.', signup);
  }
  expectRedirect(signup, 'Owner signup');
  if (signup.location !== '/app') {
    fail(
      `The owner account could not be created — most likely ${gorkem.email} already exists, ` +
        'which means this instance was seeded before. Re-run with --force to seed a second ' +
        'copy under a suffixed slug, or wipe the existing demo team first.',
      signup,
    );
  }

  wroteSomething = true;

  const createTeam = await form('/app/teams', { name: teamName }, gorkem.jar);
  expectRedirect(createTeam, 'Team creation');
  if (createTeam.location !== `/app/teams/${teamSlug}`) {
    // The server silently suffixes a taken slug; refuse rather than half-duplicate.
    const stray = createTeam.location?.replace('/app/teams/', '') ?? '';
    if (stray) await form(`/app/teams/${stray}/delete`, {}, gorkem.jar);
    fail(
      `The slug "${teamSlug}" is already taken on this instance (the server offered ` +
        `"${stray}" instead, which has been deleted again). Re-run with --force to use a ` +
        'suffixed slug.',
      createTeam,
    );
  }

  const ownerToken = await createToken(gorkem, 'gorkem-macbook');
  gorkem.token = ownerToken;
  await mcpInitialize(ownerToken, 'claude-code');
  const who = await mcpJson<{ username: string; teams: Array<{ slug: string; role: string }> }>(
    ownerToken,
    'whoami',
    {},
  );
  gorkem.username = who.username;
  if (!who.teams.some((t) => t.slug === teamSlug && t.role === 'owner')) {
    fail(`whoami does not show ${who.username} as owner of ${teamSlug}: ${JSON.stringify(who)}`);
  }
  done(`owner ${gorkem.username} owns /app/teams/${teamSlug}`);

  // -------------------------------------------------------------- 3. teammates
  step('Inviting the three teammates (create_invite -> terminal redeem)');
  const invite = await mcpJson<{ code: string }>(ownerToken, 'create_invite', {
    team: teamSlug,
    max_uses: 5,
    expires_days: 14,
  });
  if (!invite.code) fail('create_invite returned no code');

  for (const teammate of teammates) {
    const redeem = await postJson('/api/invites/redeem', {
      code: invite.code,
      email: teammate.email,
      password: opts.password,
    });
    const redeemed = expectJson<{ username: string; token: string; team: { slug: string } }>(
      redeem,
      `Invite redemption for ${teammate.email}`,
    );
    if (redeemed.team.slug !== teamSlug) {
      fail(`${teammate.email} joined "${redeemed.team.slug}" instead of "${teamSlug}"`, redeem);
    }
    teammate.username = redeemed.username;
    teammate.tokens['cli'] = redeemed.token;

    // Sign in so each machine can get its own named token, the way a human would.
    const login = await form(
      '/auth/local/login',
      { email: teammate.email, password: opts.password },
      teammate.jar,
    );
    expectRedirect(login, `Sign-in for ${teammate.email}`);
    if (login.location !== '/app') {
      fail(
        `Sign-in for ${teammate.email} did not land on /app but on "${login.location}". ` +
          'If this instance has AUTH_2FA=1, seeding cannot complete — set AUTH_2FA=0.',
        login,
      );
    }
  }
  done(`joined: ${teammates.map((t) => t.username).join(', ')}`);

  step('Issuing per-machine personal access tokens');
  ayse.tokens['macbook'] = await createToken(ayse, `${ayse.username}-macbook`);
  ayse.tokens['linux-desktop'] = await createToken(ayse, `${ayse.username}-linux-desktop`);
  ayse.token = ayse.tokens['macbook']!;
  mert.tokens['macbook'] = await createToken(mert, `${mert.username}-macbook`);
  mert.token = mert.tokens['macbook']!;
  deniz.tokens['wsl'] = await createToken(deniz, `${deniz.username}-wsl`);
  deniz.token = deniz.tokens['wsl']!;
  gorkem.tokens['macbook'] = ownerToken;
  for (const teammate of teammates) await mcpInitialize(teammate.token, 'claude-code');
  done('gorkem-macbook, ayse-macbook, ayse-linux-desktop, mert-macbook, deniz-wsl');

  // -------------------------------------------------------------- 4. snapshots
  step('Pushing environment snapshots (including Ayse\'s two-machine fleet)');
  await mcp(gorkem.token, 'get_snapshot_checklist', {});
  await push(gorkem.token, teamSlug, REPO_PAYMENTS, 'macbook', GORKEM_MACBOOK);
  await push(ayse.tokens['macbook']!, teamSlug, REPO_PAYMENTS, 'macbook', AYSE_MACBOOK);
  await push(ayse.tokens['linux-desktop']!, teamSlug, REPO_PAYMENTS, 'linux-desktop', AYSE_LINUX);
  await push(mert.token, teamSlug, REPO_STOREFRONT, 'macbook', MERT_MACBOOK);
  await push(deniz.token, teamSlug, REPO_INFRA, 'wsl', DENIZ_WSL);

  const fleet = await mcpJson<{ totalDifferences: number; summary: string[] }>(
    ayse.tokens['macbook']!,
    'compare_env',
    { team: teamSlug, device: 'macbook', their_device: 'linux-desktop' },
  );
  if (fleet.totalDifferences < 3) {
    fail(`Ayse's own two machines only differ in ${fleet.totalDifferences} places — expected 3+`);
  }
  const crossCheck = await mcpJson<{ totalDifferences: number }>(mert.token, 'compare_env', {
    team: teamSlug,
    teammate: ayse.username,
  });
  done(
    `5 snapshots; ayse macbook vs linux-desktop: ${fleet.totalDifferences} differences, ` +
      `mert vs ayse: ${crossCheck.totalDifferences}`,
  );

  // -------------------------------------------------------------- 5. policy + baseline
  step('Publishing the team and payments-api policies, and the environment baseline');
  const teamPolicy = await postJson(
    '/api/control/policies',
    {
      team: teamSlug,
      document: {
        guidance: [
          'Ship behind a feature flag: main is deployed to staging on every merge.',
          'Never touch another agent\'s branch — open a debug session instead.',
        ],
        permissions: {
          deny: ['read secret values', 'push to main', 'run terraform apply'],
          requireApproval: ['schema migrations', 'changes under infra/'],
        },
        requiredChecks: ['npm test', 'npm run typecheck'],
        protectedPaths: ['db/migrations/**', 'infra/terraform/**', '.github/workflows/**'],
        environment: {
          requiredEnvVarNames: ['DATABASE_URL', 'PAYMENTS_WEBHOOK_SECRET'],
          runtimes: { node: '22.14.0' },
        },
      },
    },
    ownerToken,
  );
  expectJson(teamPolicy, 'Publishing the team policy');

  const projectPolicy = await postJson(
    '/api/control/policies',
    {
      team: teamSlug,
      project: REPO_PAYMENTS,
      document: {
        guidance: [
          'Refund migrations must be backwards compatible for one release.',
          'Every webhook consumer change needs a replay test against the ledger fixtures.',
        ],
        permissions: {
          deny: ['delete rows from refunds_ledger'],
          requireApproval: ['changes to the refunds contract'],
        },
        requiredChecks: ['npm test -- payments', 'npm run migrate:check'],
        protectedPaths: ['db/migrations/**', 'src/payments/contracts/**'],
        environment: {
          requiredEnvVarNames: ['STRIPE_API_BASE'],
          runtimes: { node: '22.14.0' },
        },
      },
    },
    ownerToken,
  );
  expectJson(projectPolicy, 'Publishing the payments-api policy');

  const baseline = await postJson(
    '/api/control/environment-baselines',
    { team: teamSlug, project: REPO_PAYMENTS, snapshot: PAYMENTS_BASELINE },
    ownerToken,
  );
  expectJson(baseline, 'Setting the payments-api environment baseline');
  done('team policy + payments-api policy + payments-api baseline');

  // -------------------------------------------------------------- 6. debug sessions
  step('Opening debug sessions (one live thread, two archived answers)');
  const live = await mcpJson<{ sessionId: string }>(mert.token, 'open_session', {
    team: teamSlug,
    repo: REPO_STOREFRONT,
    title: 'Checkout confirm returns 502, but only on my machine',
    kind: 'question',
    via: 'cursor',
    body:
      'Every checkout confirm on my laptop fails with a 502 from the payments API. Staging is fine, ' +
      'CI is green, and Ayse cannot reproduce it. Same branch (feat/partial-refunds), same .env.local ' +
      'template as last week.\n\n' +
      'Ruled out so far: the flag is on, the API container is up (docker ps), and curl against ' +
      '/v1/health returns 200. Only /v1/refunds fails.',
  });

  // open_session takes no attachments, so the log excerpt follows as its own message.
  await mcp(mert.token, 'post_message', {
    session_id: live.sessionId,
    kind: 'note',
    via: 'cursor',
    body: 'Full trace from one failing confirm, straight out of the dev server:',
    attachments: [
      {
        name: 'checkout-502.log',
        content:
          'POST /api/checkout/confirm 502 (1243ms)\n' +
          '  at PaymentsClient.confirm (src/lib/payments-client.ts:88:15)\n' +
          '  at async confirmCheckout (src/routes/checkout/+page.server.ts:41:20)\n' +
          '  cause: FetchError: request to http://127.0.0.1:8787/v1/refunds failed, reason: socket hang up\n' +
          '  upstream: payments-api 2.13.4 (node v20.11.1)',
      },
    ],
  });

  await mcp(ayse.tokens['macbook']!, 'post_message', {
    session_id: live.sessionId,
    kind: 'hypothesis',
    via: 'claude-code',
    body:
      'Your upstream banner says node v20.11.1 — the payments API needs 22.14 since we moved the ' +
      'webhook verifier to the built-in WebCrypto helpers. On 20.x it throws while parsing the ' +
      'signature header and the socket is closed before a response is written, which is exactly the ' +
      'socket hang up you see.\n\n' +
      'Second suspicion: compare_env says PAYMENTS_WEBHOOK_SECRET is not set on your machine at all, ' +
      'and the verifier fails closed when it is missing.',
  });

  await mcp(mert.token, 'post_message', {
    session_id: live.sessionId,
    kind: 'info-request',
    via: 'cursor',
    body:
      'Plausible. Two things before I rebuild the container: which node line is pinned for local dev ' +
      '(the README still says 20 LTS), and where do I get a working value for the webhook variable ' +
      '— is the staging one safe for local use, or do I need my own from the dashboard?',
  });

  await mcp(deniz.token, 'post_message', {
    session_id: live.sessionId,
    kind: 'note',
    via: 'codex',
    body:
      'For what it is worth, the staging payments-api runs node 22.14.0 (see the image tag in ' +
      'infra/terraform/payments/service.tf), so local dev on 20.x is drifting from every deployed ' +
      'environment. I can add a preflight to the dev script this week.',
  });

  const refunds = await mcpJson<{ sessionId: string }>(ayse.tokens['macbook']!, 'open_session', {
    team: teamSlug,
    repo: REPO_PAYMENTS,
    title: 'Refund webhooks retry forever after migration 0042',
    kind: 'question',
    via: 'claude-code',
    body:
      'Since 0042_refunds_ledger.sql landed on staging, every refund webhook is redelivered until ' +
      'the provider gives up (roughly 40 attempts per event). The ledger row is written each time, ' +
      'so refunds_ledger has duplicates for the same provider event id.',
  });

  await mcp(ayse.tokens['macbook']!, 'post_message', {
    session_id: refunds.sessionId,
    kind: 'note',
    via: 'claude-code',
    body: 'Consumer log for one event, from the staging pod:',
    attachments: [
      {
        name: 'refunds-consumer.log',
        content:
          '2026-08-14T09:12:44.118Z warn  refunds.webhook  retry 7 evt_3PkQ2mLxTn idempotency=null\n' +
          '2026-08-14T09:12:44.402Z error refunds.webhook  duplicate ledger row for evt_3PkQ2mLxTn\n' +
          '2026-08-14T09:12:44.404Z error refunds.webhook  responded 500 in 286ms',
      },
    ],
  });

  await mcp(deniz.token, 'post_message', {
    session_id: refunds.sessionId,
    kind: 'hypothesis',
    via: 'codex',
    body:
      'The provider retries whenever we answer with a 5xx, so the duplicate write and the retry storm ' +
      'are the same bug seen from two sides. My guess is the new idempotency column landed nullable ' +
      'and the consumer treats NULL as "not processed yet".',
  });

  await mcp(ayse.tokens['macbook']!, 'post_message', {
    session_id: refunds.sessionId,
    kind: 'answer',
    via: 'claude-code',
    body:
      'Confirmed. 0042 adds refunds_ledger.idempotency_key as nullable with no unique index, and the ' +
      'consumer only skips an event when the column is non-null. Existing rows were never backfilled, ' +
      'so every redelivery inserts again and the 500 from the duplicate write keeps the retry loop alive.',
  });

  await mcp(ayse.tokens['macbook']!, 'resolve_session', {
    session_id: refunds.sessionId,
    via: 'claude-code',
    root_cause:
      'Migration 0042 added refunds_ledger.idempotency_key as a nullable column without a unique ' +
      'index, and the webhook consumer treated NULL as "not yet processed". Every checkout refund ' +
      'redelivery inserted a second ledger row, the duplicate write answered 500, and the 500 made ' +
      'the provider retry — a loop that only ended when the provider gave up.',
    fix:
      'Migration 0043 backfills idempotency_key from the provider event id, sets it NOT NULL and adds ' +
      'a unique index; the consumer now answers 200 on a duplicate instead of 500. Shipped in PR #318 ' +
      'together with a replay test over the ledger fixtures.',
  });

  const bundle = await mcpJson<{ sessionId: string }>(mert.token, 'open_session', {
    team: teamSlug,
    repo: REPO_STOREFRONT,
    title: 'Vite serves a stale checkout bundle after switching branches',
    kind: 'question',
    via: 'cursor',
    body:
      'After switching from main to feat/partial-refunds the dev server keeps serving the old checkout ' +
      'chunk — the new partial-refund fields never render until I delete node_modules/.vite by hand.',
  });

  await mcp(gorkem.token, 'post_message', {
    session_id: bundle.sessionId,
    kind: 'answer',
    via: 'claude-code',
    body:
      'Known trap: Vite keeps its dependency cache keyed by the resolved dependency graph, not by the ' +
      'lockfile, so a branch switch that changes pnpm-lock.yaml leaves a stale optimized bundle behind. ' +
      'Add --force to the dev script rather than deleting the cache manually.',
  });

  await mcp(mert.token, 'resolve_session', {
    session_id: bundle.sessionId,
    via: 'cursor',
    root_cause:
      'The Vite dependency cache in node_modules/.vite survived the branch switch, so the checkout ' +
      'route kept loading the optimized bundle built from the main-branch dependency graph.',
    fix:
      'The dev script now runs "vite dev --force" and CI wipes node_modules/.vite when pnpm-lock.yaml ' +
      'changes (PR #204). Documented in storefront-web/README.md under "switching branches".',
  });
  done('1 open thread (5 messages, 1 log attached) + 2 resolved sessions with root cause and fix');

  // -------------------------------------------------------------- 7. announcements
  step('Broadcasting announcements (agent tool + inbound CI hooks)');
  await mcp(gorkem.token, 'announce', {
    team: teamSlug,
    repo: REPO_PAYMENTS,
    via: 'claude-code',
    body:
      'payments-api 2.14.0 is on staging: partial refunds are live behind the partial_refunds flag. ' +
      'package-lock.json changed — run npm ci before your next branch, and note that local dev now ' +
      'requires node 22.14.0.',
  });
  await mcp(deniz.token, 'announce', {
    team: teamSlug,
    repo: REPO_INFRA,
    via: 'codex',
    body:
      'Maintenance tonight 22:00 UTC: rotating the payments DB parameter group. Expect one ~30s ' +
      'failover on staging; production is untouched. I will post here when it is done.',
  });

  const teamPage = await get(`/app/teams/${teamSlug}`, gorkem.jar);
  expectStatus(teamPage, 200, 'Loading the team page');
  const inboundToken = /\/api\/hooks\/announce\/([A-Za-z0-9_-]+)/.exec(teamPage.body)?.[1];
  if (!inboundToken) {
    fail('Could not read the inbound hook token from the team page', teamPage);
  }
  const ciHook = await postJson(`/api/hooks/announce/${inboundToken}`, {
    repo: REPO_STOREFRONT,
    text: 'build #1482 green on main (3m12s) and deployed to staging — 214 tests, 0 flakes',
  });
  expectJson(ciHook, 'Posting to the inbound CI hook');
  const ghHook = await request('POST', `/api/hooks/github/${inboundToken}`, {
    headers: { 'content-type': 'application/json', 'x-github-event': 'push' },
    body: JSON.stringify({
      ref: 'refs/heads/main',
      pusher: { name: gorkem.username },
      repository: { name: REPO_PAYMENTS },
      commits: [{}, {}, {}],
      head_commit: { message: 'feat(refunds): partial refunds behind a flag\n\nCloses PAY-418' },
    }),
  });
  expectJson(ghHook, 'Posting a GitHub push event to the inbound hook');
  done('2 agent announcements + 1 CI hook + 1 GitHub push event');

  // -------------------------------------------------------------- 8. agent runs
  step('Registering agents, starting runs and colliding on the refunds migration');
  const ayseAgent = await registerInstallation(
    ayse.tokens['macbook']!,
    'ayse-claude',
    'claude-code',
    'seed-demo-ayse-macbook',
  );
  const mertAgent = await registerInstallation(
    mert.token,
    'mert-cursor',
    'cursor',
    'seed-demo-mert-macbook',
  );
  const denizAgent = await registerInstallation(
    deniz.token,
    'deniz-codex',
    'codex',
    'seed-demo-deniz-wsl',
  );

  const ayseClaims: Claim[] = [
    { resourceType: 'migration', resourceKey: 'payments-db', access: 'write' },
    { resourceType: 'path', resourceKey: 'db/migrations/**', access: 'write' },
    { resourceType: 'path', resourceKey: 'src/payments/**', access: 'write' },
  ];
  const mertClaims: Claim[] = [
    { resourceType: 'migration', resourceKey: 'payments-db', access: 'write' },
    { resourceType: 'path', resourceKey: 'src/payments/contracts/refund.ts', access: 'write' },
  ];
  const denizClaims: Claim[] = [
    { resourceType: 'migration', resourceKey: 'payments-db', access: 'write' },
    { resourceType: 'config', resourceKey: 'terraform/payments', access: 'write' },
  ];

  const ayseRun = await startRun(ayse.tokens['macbook']!, {
    installationId: ayseAgent,
    team: teamSlug,
    project: REPO_PAYMENTS,
    taskKey: 'PAY-418',
    intent: 'Backfill the refunds ledger idempotency key and add the unique index',
    repo: REPO_PAYMENTS,
    branch: 'feat/refunds-ledger',
    baseSha: 'a41f7c9',
    claims: ayseClaims,
  });
  if (ayseRun.conflicts.length !== 0) {
    fail(`Ayse's run should start clean but reported ${ayseRun.conflicts.length} conflicts`);
  }
  if (!ayseRun.policy) fail('Ayse\'s run start returned no effective policy — publish order is wrong');

  // Same project, same migration chain: this is the collision the map must show.
  const mertRun = await startRun(mert.token, {
    installationId: mertAgent,
    team: teamSlug,
    project: REPO_PAYMENTS,
    taskKey: 'PAY-421',
    intent: 'Extend the refunds contract with partial amounts for the storefront',
    repo: REPO_PAYMENTS,
    branch: 'feat/partial-refunds',
    baseSha: 'a41f7c9',
    claims: mertClaims,
  });
  if (!mertRun.conflicts.some((conflict) => conflict.severity === 'critical')) {
    fail(
      `Mert's overlapping run did not produce a critical conflict: ${JSON.stringify(mertRun.conflicts)}`,
    );
  }

  // Deniz works in another project: the same claim shapes stay isolated.
  const denizRun = await startRun(deniz.token, {
    installationId: denizAgent,
    team: teamSlug,
    project: REPO_INFRA,
    taskKey: 'INFRA-77',
    intent: 'Rotate the payments DB parameter group and re-plan the staging workspace',
    repo: REPO_INFRA,
    branch: 'chore/payments-db-parameter-group',
    baseSha: '6ed2f18',
    claims: denizClaims,
  });
  if (denizRun.conflicts.length !== 0) {
    fail(
      'Deniz runs in platform-infra and must stay isolated, but the server reported ' +
        `${denizRun.conflicts.length} conflicts`,
    );
  }
  if (!mertRun.policy || !denizRun.policy) {
    fail('A run started without an effective policy — the policies were published too late');
  }
  done(
    `3 runs; mert vs ayse -> ${mertRun.conflicts.length} conflicts ` +
      `(${mertRun.conflicts[0]?.severity}), deniz isolated`,
  );

  // -------------------------------------------------------------- 9. receipts + preflight
  step('Recording policy receipts (one clean, one drifted) and running preflight');
  const cleanReceipt = expectJson<{ receipt: { drift: boolean } }>(
    await postJson(
      `/api/agent/runs/${ayseRun.run.id}/policy-receipt`,
      { expectedHash: ayseRun.policy!.hash, reportedHash: ayseRun.policy!.hash },
      ayse.tokens['macbook']!,
    ),
    'Recording the matching policy receipt',
  );
  if (cleanReceipt.receipt.drift) fail('The matching receipt was recorded as drifted');

  // Every run start records a receipt with an empty reportedHash, which counts as drift —
  // so the isolated run gets an honest one too, leaving exactly one deliberate drift.
  expectJson<{ receipt: { drift: boolean } }>(
    await postJson(
      `/api/agent/runs/${denizRun.run.id}/policy-receipt`,
      { expectedHash: denizRun.policy!.hash, reportedHash: denizRun.policy!.hash },
      deniz.token,
    ),
    'Recording the infra policy receipt',
  );

  // A stale local copy of the policy: the hash the agent applied differs from the served one.
  const staleHash = 'c3d9'.repeat(16);
  const driftedReceipt = expectJson<{ receipt: { drift: boolean; expectedHash: string } }>(
    await postJson(
      `/api/agent/runs/${mertRun.run.id}/policy-receipt`,
      { expectedHash: staleHash, reportedHash: staleHash },
      mert.token,
    ),
    'Recording the drifted policy receipt',
  );
  if (!driftedReceipt.receipt.drift) fail('The stale receipt was not flagged as drift');
  if (driftedReceipt.receipt.expectedHash === staleHash) {
    fail('The server accepted a client-supplied expected hash — it should stay authoritative');
  }

  const goodPreflight = expectJson<{ status: string }>(
    await postJson(
      '/api/agent/environment/preflight',
      {
        team: teamSlug,
        project: REPO_PAYMENTS,
        runId: ayseRun.run.id,
        snapshot: AYSE_MACBOOK,
      },
      ayse.tokens['macbook']!,
    ),
    'Preflight from the machine that matches the baseline',
  );
  if (goodPreflight.status === 'critical') {
    fail(`Ayse's MacBook should pass preflight but came back ${goodPreflight.status}`);
  }

  const badPreflight = expectJson<{
    status: string;
    policyViolations: { missingEnvVarNames: string[]; runtimeMismatches: unknown[] };
  }>(
    await postJson(
      '/api/agent/environment/preflight',
      {
        team: teamSlug,
        project: REPO_PAYMENTS,
        runId: mertRun.run.id,
        snapshot: MERT_MACBOOK,
      },
      mert.token,
    ),
    'Preflight from the diverging machine',
  );
  if (badPreflight.status !== 'critical') {
    fail(`Mert's preflight should be critical, got "${badPreflight.status}"`);
  }
  done(
    `receipts: 2 clean / 1 drifted; preflight: ${goodPreflight.status} (ayse) vs ` +
      `${badPreflight.status} (mert, missing ${badPreflight.policyViolations.missingEnvVarNames.join(', ')})`,
  );

  // Heartbeat last so presence is as fresh as possible when the owner looks.
  // Claims are resent every time: a heartbeat without them does not renew the lease.
  const runs: SeededRun[] = [
    {
      id: ayseRun.run.id,
      token: ayse.tokens['macbook']!,
      status: 'active',
      claims: ayseClaims,
    },
    { id: mertRun.run.id, token: mert.token, status: 'blocked', claims: mertClaims },
    { id: denizRun.run.id, token: deniz.token, status: 'active', claims: denizClaims },
  ];
  await heartbeat(runs);

  // -------------------------------------------------------------- 10. verification
  step('Verifying the seeded instance through the same pages the owner will open');
  const agentsPage = await get('/app/agents', gorkem.jar);
  expectStatus(agentsPage, 200, 'Loading /app/agents');
  expectContains(agentsPage, 'critical', 'The live agent map shows no critical conflict');
  for (const name of ['ayse-claude', 'mert-cursor', 'deniz-codex']) {
    expectContains(agentsPage, name, 'The live agent map is missing an agent');
  }

  // The control plane is the only place the applied policy hash is visible, and it is
  // where the drifted receipt shows up as a run carrying a hash nobody published.
  const activeRuns = expectJson<{ runs: Array<{ id: string; policyHash: string | null }> }>(
    await request('GET', `/api/agent/runs/active?team=${teamSlug}`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    }),
    'Listing the active agent runs',
  );
  if (activeRuns.runs.length !== 3) {
    fail(`Expected 3 active runs, the server reports ${activeRuns.runs.length}`);
  }
  const mertActive = activeRuns.runs.find((r) => r.id === mertRun.run.id);
  const ayseActive = activeRuns.runs.find((r) => r.id === ayseRun.run.id);
  if (mertActive?.policyHash !== staleHash) {
    fail(`Mert's run should carry the stale policy hash, it carries ${mertActive?.policyHash}`);
  }
  if (ayseActive?.policyHash !== ayseRun.policy!.hash) {
    fail(`Ayse's run should carry the published policy hash, it carries ${ayseActive?.policyHash}`);
  }

  const activityPage = await get(`/app/teams/${teamSlug}/activity`, gorkem.jar);
  expectStatus(activityPage, 200, 'Loading the activity feed');
  for (const action of ['push_snapshot', 'announce', 'open_session', 'resolve_session']) {
    expectContains(activityPage, action, 'The activity feed is missing an action');
  }
  for (const p of [gorkem, ayse, mert, deniz]) {
    expectContains(activityPage, p.username, 'The activity feed does not mention every teammate');
  }

  const sessionsPage = await get('/app/sessions', gorkem.jar);
  expectStatus(sessionsPage, 200, 'Loading the open sessions list');
  expectContains(sessionsPage, 'Checkout confirm returns 502', 'The open session is missing');
  expectContains(sessionsPage, 'Announcements', 'The announcements channel is missing');

  const liveThread = await get(`/app/sessions/${live.sessionId}`, gorkem.jar);
  expectStatus(liveThread, 200, 'Loading the open session thread');
  expectContains(liveThread, 'checkout-502.log', 'The attached log is missing from the thread');
  expectContains(liveThread, 'kind-hypothesis', 'The typed message kinds did not survive');

  const archivePage = await get('/app/sessions?status=resolved', gorkem.jar);
  expectStatus(archivePage, 200, 'Loading the resolved sessions list');
  expectContains(archivePage, 'Refund webhooks retry forever', 'A resolved session is missing');
  expectContains(archivePage, 'stale checkout bundle', 'A resolved session is missing');

  const comparePage = await get(
    `/app/teams/${teamSlug}/compare?a=${ayse.username}@macbook&b=${ayse.username}@linux-desktop`,
    gorkem.jar,
  );
  expectStatus(comparePage, 200, 'Loading the personal-fleet comparison');
  expectContains(comparePage, 'differs', 'The two-machine comparison shows no differences');
  expectContains(comparePage, '20.11.1', 'The comparison does not show the node drift');

  const archive = await mcpJson<{ results: Array<{ title: string }> }>(
    gorkem.token,
    'search_past_issues',
    { team: teamSlug, query: 'checkout' },
  );
  if (archive.results.length < 2) {
    fail(`search_past_issues("checkout") returned ${archive.results.length} results, expected 2+`);
  }

  const projectList = await mcpJson<{ projects: Array<{ slug: string }> }>(
    gorkem.token,
    'list_projects',
    { team: teamSlug },
  );
  const slugs = projectList.projects.map((p) => p.slug);
  for (const repo of [REPO_PAYMENTS, REPO_STOREFRONT, REPO_INFRA]) {
    if (!slugs.includes(repo)) fail(`Project "${repo}" is missing: ${slugs.join(', ')}`);
  }
  done('agent map, activity feed, sessions, fleet compare, archive search and projects all check out');

  // -------------------------------------------------------------- summary
  const team = `${baseUrl}/app/teams/${teamSlug}`;
  process.stdout.write(`
================================================================
  Demo organisation seeded.

  Sign in as   ${gorkem.email}   (password: the one you supplied)
  Sign-in page ${baseUrl}/login
  Team         ${team}

  Owner access token (shown once, treat it like a password):
    ${ownerToken}

  Created
    1 team ......... ${teamName} (${teamSlug}), owner ${gorkem.username}
    4 people ....... ${[gorkem, ayse, mert, deniz].map((p) => `${p.username} (${p.label})`).join(', ')}
                   — the last three joined by redeeming an invite from the terminal
    8 tokens ....... 5 machine tokens + 3 issued by the terminal onboarding
    3 projects ..... ${REPO_PAYMENTS}, ${REPO_STOREFRONT}, ${REPO_INFRA}
    5 snapshots .... incl. ${ayse.username}'s macbook + linux-desktop fleet (${fleet.totalDifferences} differences)
    2 policies ..... team-wide and ${REPO_PAYMENTS}
    1 baseline ..... ${REPO_PAYMENTS}: preflight ${goodPreflight.status} (ayse) / ${badPreflight.status} (mert)
    3 agent runs ... ${mertRun.conflicts.length} live conflicts on the refunds migration, ${REPO_INFRA} isolated
    3 receipts ..... two clean, one reporting a stale policy hash (drift)
    3 sessions ..... 1 open (5 messages), 2 resolved with root cause and fix
    4 announcements. 2 from agents, 1 CI hook, 1 GitHub push event

  Worth opening
    ${baseUrl}/app/agents                 critical conflict, live
    ${team}/activity   everyone's trail
    ${baseUrl}/app/sessions               open thread + archive
    ${team}/compare?a=${ayse.username}@macbook&b=${ayse.username}@linux-desktop

  Note: the live agent map is presence based. The three runs go stale a few
  minutes (AGENT_STALE_MINUTES, 3 by default) after their last heartbeat and
  then disappear from /app/agents. Re-run with --keep-alive <minutes> to hold
  them open while you explore. Everything else is permanent.
================================================================
`);

  if (opts.keepAliveMinutes > 0) {
    const until = Date.now() + opts.keepAliveMinutes * 60_000;
    process.stdout.write(
      `Keeping the ${runs.length} agent runs alive for ${opts.keepAliveMinutes} minute(s). Ctrl+C to stop.\n`,
    );
    while (Date.now() < until) {
      await sleep(Math.min(45_000, Math.max(1_000, until - Date.now())));
      await heartbeat(runs);
      const left = Math.max(0, Math.round((until - Date.now()) / 60_000));
      process.stdout.write(`    heartbeat sent, ~${left} minute(s) left\n`);
    }
    process.stdout.write('Keep-alive finished; the runs will go stale shortly.\n');
  }
}

// ---------------------------------------------------------------- step helpers

/** Mint a named personal access token through the dashboard form. */
async function createToken(p: Person, name: string): Promise<string> {
  const reply = await form('/app/tokens', { name }, p.jar);
  expectStatus(reply, 200, `Creating token "${name}" for ${p.email}`);
  const token = /stma_[0-9a-f]{40}/.exec(reply.body)?.[0];
  if (!token) fail(`The token page for "${name}" did not show a new stma_ token`, reply);
  return token;
}

async function push(
  token: string,
  team: string,
  repo: string,
  device: string,
  snapshot: unknown,
): Promise<void> {
  const text = await mcp(token, 'push_snapshot', { team, repo, device, snapshot });
  if (!text.includes('Snapshot stored')) {
    fail(`push_snapshot for ${repo}/${device} did not confirm storage: ${text.slice(0, 300)}`);
  }
}

async function registerInstallation(
  token: string,
  name: string,
  clientType: string,
  fingerprint: string,
): Promise<string> {
  const reply = await postJson(
    '/api/agent/installations/register',
    {
      name,
      clientType,
      clientVersion: '2026.8.0',
      deviceFingerprint: fingerprint,
      capabilities: ['wrapper', 'claims', 'preflight', 'policy'],
    },
    token,
  );
  const json = expectJson<{ installation: { id: string } }>(reply, `Registering agent "${name}"`);
  return json.installation.id;
}

interface Claim {
  resourceType: 'path' | 'component' | 'contract' | 'migration' | 'config';
  resourceKey: string;
  access: 'read' | 'write';
}

interface StartedRun {
  run: { id: string };
  conflicts: Array<{ severity: string; reason: string }>;
  policy: { hash: string } | null;
}

interface SeededRun {
  id: string;
  token: string;
  status: 'active' | 'waiting' | 'blocked';
  claims: Claim[];
}

async function startRun(token: string, body: Record<string, unknown>): Promise<StartedRun> {
  const reply = await postJson('/api/agent/runs/start', body, token);
  return expectJson<StartedRun>(reply, `Starting run ${String(body.taskKey)}`);
}

/**
 * Renew presence for every seeded run. The claims go along on purpose: a
 * heartbeat without them refreshes the run but not the claim leases, and an
 * expired lease drops the conflict off the live agent map.
 */
async function heartbeat(runs: SeededRun[]): Promise<void> {
  for (const run of runs) {
    const reply = await postJson(
      `/api/agent/runs/${run.id}/heartbeat`,
      { status: run.status, claims: run.claims },
      run.token,
    );
    expectJson(reply, `Heartbeating run ${run.id}`);
  }
}

try {
  await main();
} catch (err) {
  if (err instanceof SeedFailure) {
    process.stderr.write(`\nFAILED: ${err.message}\n`);
    const reply = err.reply;
    if (reply) {
      process.stderr.write(`  ${reply.method} ${reply.path} -> HTTP ${reply.status}\n`);
      if (reply.location) process.stderr.write(`  location: ${reply.location}\n`);
      const body = reply.body.trim();
      if (body) process.stderr.write(`  body: ${body.slice(0, 900)}\n`);
    }
    if (wroteSomething) {
      process.stderr.write(
        '\nThe instance is half-seeded and nothing was rolled back — inspect it (or delete the ' +
          'demo team from its team page) before re-running.\n',
      );
    }
  } else {
    process.stderr.write(
      `\nFAILED: unexpected error\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
  }
  process.exitCode = 1;
}
