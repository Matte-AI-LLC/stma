export interface Env {
  nodeEnv: string;
  port: number;
  host: string;
  /** Public origin without trailing slash, e.g. https://bridge.example.com */
  baseUrl: string;
  databaseUrl?: string;
  pgliteDir: string;
  migrationsDir?: string;
  github?: { clientId: string; clientSecret: string };
  /** Passwordless dev login form. Auto-enabled outside production when GitHub OAuth is not configured. */
  devMode: boolean;
  /** Username+password accounts (default on; AUTH_LOCAL=0 disables). */
  localAuth: boolean;
  /** Whether new local accounts can be created (SIGNUPS_OPEN=0 closes signup). */
  signupsOpen: boolean;
  /**
   * What a stranger sees.
   *
   * `full` is the product site. `teaser` is the pre-launch face: the landing
   * page says the platform is an invite-only private beta and points at the MCP
   * documentation, and the guide drops the sections about the console a visitor
   * cannot reach. It changes **nothing** for a signed-in member — an invitee on
   * the same instance gets the whole app and the whole guide — because this is a
   * statement about who the marketing is for, not a second product.
   */
  publicMode: 'full' | 'teaser';
  /**
   * Is this the hosted service, or somebody's own instance?
   *
   * Plan limits only mean anything on the first. Self-host is deliberately
   * full-featured — ELv2 already stops a competing hosted service, so crippling
   * the copy somebody runs themselves would only punish the honest reading of
   * the licence, and the tier matrix says so in its first column. Default false,
   * because an instance nobody configured is somebody's own.
   */
  hosted: boolean;
  /**
   * Demo credentials printed on the sign-in page, for a throwaway environment
   * where hunting for them is the friction.
   *
   * Deliberately a literal from configuration rather than anything read out of
   * the database. The page can therefore only ever show the strings somebody
   * typed into this variable — if it were set on the wrong app by accident it
   * would leak those strings and nothing else, never a real account. Passwords
   * are hashed and unreadable anyway; this is the shape that keeps it that way
   * when somebody later wants to "just show the seeded users".
   */
  demoLogins: Array<{ email: string; password: string; note?: string }>;
  /** EMBEDDED_DB=1 allows running production on the embedded PGlite store (single-instance self-host). */
  embeddedDb: boolean;
  sessionTtlDays: number;
  /** Snapshots older than this are purged. 0 disables the purge. */
  snapshotRetentionDays: number;
  /** Resolved sessions older than this are purged. 0 (default) keeps the archive forever. */
  sessionRetentionDays: number;
  /** Operator error-log entries older than this are purged. 0 disables the age purge (the row cap still applies). */
  errorRetentionDays: number;
  /**
   * How long the app remembers *what happened*: the team activity feed, the
   * append-only agent run trail behind the governance page, and the announcements
   * channel. 0 disables the age purge (the row caps still apply).
   */
  activityRetentionDays: number;
  /** Active agent runs without a heartbeat become stale after this many minutes. */
  agentStaleMinutes: number;
  /** Work-claim leases are renewed by run heartbeats. */
  agentClaimLeaseMinutes: number;
  /**
   * Usernames allowed into the operator /admin area (ADMIN_USERNAMES, comma-separated,
   * case-insensitive). Stored trimmed and lowercased; empty list disables /admin entirely.
   */
  adminUsernames: string[];
  /**
   * Email addresses allowed into /admin (ADMIN_EMAILS, comma-separated, case-insensitive).
   * Checked alongside adminUsernames — either list grants access.
   */
  adminEmails: string[];
  /** Resend API key. Without it the mailer falls back to the in-memory transport. */
  resendApiKey?: string;
  /** RFC 5322 From header for outgoing mail. */
  mailFrom: string;
  /**
   * Email one-time-code confirmation on sign-in and password change.
   * AUTH_2FA=1 forces it on, AUTH_2FA=0 off; by default it follows RESEND_API_KEY.
   */
  twoFactor: boolean;
  /**
   * Notification debounce: messages landing in one thread inside this window
   * become a single email. Also the longest a notification is held back.
   */
  notifyDebounceSeconds: number;
  /** Hard ceiling on notification emails per user per rolling hour. */
  notifyMaxPerHour: number;
}

/**
 * `DEMO_LOGINS` — `email:password` pairs, comma separated, optionally with a
 * label after a second colon: `ada@x.dev:hunter2:owner,bo@x.dev:hunter2:member`.
 *
 * Nothing here is looked up. Whatever is parsed out is exactly what the sign-in
 * page prints, which is the property that makes this safe to have at all: the
 * page cannot be tricked into showing an account it was not handed.
 */
function parseDemoLogins(raw: string | undefined): Env['demoLogins'] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [email, password, note] = entry.split(':').map((part) => part.trim());
      return { email: email ?? '', password: password ?? '', note: note || undefined };
    })
    .filter((row) => row.email !== '' && row.password !== '')
    .slice(0, 8);
}

/**
 * What a process that was told nothing should assume it is.
 *
 * `devMode` is on whenever NODE_ENV is not production, which is right for a
 * checkout and wrong for everything else — and "everything else" now includes
 * an npm package a stranger installed. `npx @matteai/stma-server` with no
 * environment used to boot with the passwordless dev login form enabled,
 * because a default written for `npm run dev` reached a layer it was never
 * meant to. The CLI already refuses to do this (`stma serve` sets NODE_ENV and
 * deliberately never sets AUTH_DEV_MODE); the server's own bin had no such rule.
 *
 * So the bin assumes production and development says so out loud, with a flag
 * rather than an env prefix because `npm run dev` has to work on Windows too.
 * Anything that sets NODE_ENV itself — the Dockerfile, compose, the demo
 * scripts, the tests — is untouched.
 */
export function bootNodeEnv(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): string {
  if (env.NODE_ENV) return env.NODE_ENV;
  return argv.includes('--dev') ? 'development' : 'production';
}

export function loadEnv(overrides: Partial<Env> = {}): Env {
  const e = process.env;
  const nodeEnv = e.NODE_ENV ?? 'development';
  const port = Number(e.PORT ?? 3000);
  const github =
    e.GITHUB_CLIENT_ID && e.GITHUB_CLIENT_SECRET
      ? { clientId: e.GITHUB_CLIENT_ID, clientSecret: e.GITHUB_CLIENT_SECRET }
      : undefined;
  const devMode = e.AUTH_DEV_MODE === '1' || (!github && nodeEnv !== 'production');
  const resendApiKey = e.RESEND_API_KEY || undefined;
  const csv = (v: string | undefined) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

  const env: Env = {
    nodeEnv,
    port,
    host: e.HOST ?? (nodeEnv === 'production' ? '0.0.0.0' : 'localhost'),
    baseUrl: (e.BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, ''),
    databaseUrl: e.DATABASE_URL || undefined,
    pgliteDir: e.PGLITE_DIR ?? '.data/pglite',
    migrationsDir: e.MIGRATIONS_DIR || undefined,
    github,
    devMode,
    localAuth: e.AUTH_LOCAL !== '0',
    signupsOpen: e.SIGNUPS_OPEN !== '0',
    publicMode: e.SITE_MODE === 'teaser' ? 'teaser' : 'full',
    hosted: e.STMA_HOSTED === '1',
    demoLogins: parseDemoLogins(e.DEMO_LOGINS),
    embeddedDb: e.EMBEDDED_DB === '1',
    sessionTtlDays: Number(e.SESSION_TTL_DAYS ?? 30),
    snapshotRetentionDays: Number(e.SNAPSHOT_RETENTION_DAYS ?? 90),
    sessionRetentionDays: Number(e.SESSION_RETENTION_DAYS ?? 0),
    errorRetentionDays: Number(e.ERROR_RETENTION_DAYS ?? 30),
    activityRetentionDays: Number(e.ACTIVITY_RETENTION_DAYS ?? 180),
    agentStaleMinutes: Number(e.AGENT_STALE_MINUTES ?? 3),
    agentClaimLeaseMinutes: Number(e.AGENT_CLAIM_LEASE_MINUTES ?? 5),
    adminUsernames: csv(e.ADMIN_USERNAMES),
    adminEmails: csv(e.ADMIN_EMAILS),
    resendApiKey,
    mailFrom: e.MAIL_FROM || 'STMA <noreply@stma.ai>',
    twoFactor: e.AUTH_2FA === '1' ? true : e.AUTH_2FA === '0' ? false : Boolean(resendApiKey),
    notifyDebounceSeconds: Number(e.NOTIFY_DEBOUNCE_SECONDS ?? 120),
    notifyMaxPerHour: Number(e.NOTIFY_MAX_PER_HOUR ?? 6),
    ...overrides,
  };

  if (env.nodeEnv === 'production' && !env.databaseUrl && !env.embeddedDb) {
    throw new Error(
      'DATABASE_URL is required in production. For single-instance self-hosting without Postgres, set EMBEDDED_DB=1 and mount a volume for the data directory.',
    );
  }
  if (env.nodeEnv === 'production' && !env.databaseUrl && env.embeddedDb) {
    console.warn(
      '[stma] Embedded database mode: single instance only — persist the data directory (default packages/server/.data) with a volume.',
    );
  }
  if (env.nodeEnv === 'production' && env.devMode) {
    console.warn('[stma] WARNING: dev login is enabled in production — anyone can sign in as anyone.');
  }
  if (env.localAuth && !env.twoFactor && env.nodeEnv !== 'test') {
    console.warn(
      '[stma] WARNING: email sign-in codes are off — a leaked password is enough to sign in. Set RESEND_API_KEY (or AUTH_2FA=1 with a working mailer) to enable them.',
    );
  }
  return env;
}
