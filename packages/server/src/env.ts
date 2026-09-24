import { isIP } from 'node:net';

export interface Env {
  nodeEnv: string;
  port: number;
  host: string;
  /** Public origin without trailing slash, e.g. https://bridge.example.com */
  baseUrl: string;
  databaseUrl?: string;
  /**
   * Connections this process's pool may open, beside the one the LISTEN
   * channel holds and the one migrations take at boot.
   *
   * Ten is right for a server that is the only one talking to its database, and
   * wrong the moment there are several: the connection budget is the real
   * ceiling on replica count, and it is arithmetic rather than a guess. On
   * 2026-09-23 production went to at most four replicas against a Burstable
   * B1ms whose `max_connections` is 50, which a rolling deploy can meet with
   * both revisions at full width — eight replicas at once. At four each that is
   * 40 plus the listeners, and it fits; at ten each it would not.
   */
  databasePoolMax: number;
  pgliteDir: string;
  migrationsDir?: string;
  github?: { clientId: string; clientSecret: string };
  /** Customer-facing ClickUp OAuth app. Personal API tokens are never requested by the UI. */
  clickup?: { clientId: string; clientSecret: string };
  /** Passwordless dev login form. Auto-enabled outside production when GitHub OAuth is not configured. */
  devMode: boolean;
  /** Username+password accounts (default on; AUTH_LOCAL=0 disables). */
  localAuth: boolean;
  /** Whether new local accounts can be created (SIGNUPS_OPEN=0 closes signup). */
  signupsOpen: boolean;
  /**
   * Access codes that a private beta hands out, from `SIGNUP_ACCESS_CODES`
   * (comma separated, `code:label` to name a cohort in the log).
   *
   * Set, signup asks for one and refuses without it. Unset, signup behaves as
   * it always has, so a self-hosted instance and `npm run dev` are untouched.
   *
   * A cohort code, deliberately not a one-use invite: a team invite already
   * exists for joining a workspace, and this is the earlier door — somebody who
   * has no account and no workspace yet. Codes are compared in constant time
   * and only ever come from configuration, never from the database, so the page
   * cannot leak anything but the strings an operator typed.
   */
  signupAccessCodes: Array<{ code: string; label?: string }>;
  /**
   * Every workspace gets every feature, whatever its plan says (`BETA_UNMETERED=1`).
   *
   * The private beta sells nothing, so metering it would only produce refusals
   * nobody can pay their way out of. This is deliberately a separate switch from
   * `hosted`: the instance stays hosted — audit, identity composition and the
   * operator surfaces all behave as they will when billing turns on — and only
   * the ceilings lift. Turning it off restores the matrix with no data to unwind,
   * which is why the beta does not simply write a plan onto every team.
   *
   * One ceiling stays, by decision (2026-09-21): the age limit on history.
   * Activity and the agent run trail keep their plan's retention, because
   * lifting it would turn the day this is unset into the day months of history
   * are deleted. `historyRetentionDays` in `lib/cleanup.ts` holds the rule.
   */
  betaUnmetered: boolean;
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
   * How many proxies of our own stand in front of this instance.
   *
   * `X-Forwarded-For` is a list each proxy appends to, so its LEFTMOST entry is
   * whatever the client sent and its rightmost is the address the nearest proxy
   * actually saw. Reading the leftmost, which is what this did until 2026-09-20,
   * let anyone give every request a fresh identity and walk through every
   * per-IP limit in the table — including the one brake on guessing a private
   * beta access code.
   *
   * 0 means "trust only what the nearest proxy appended", which is never
   * forgeable and is right for a direct-to-origin deployment. Each extra hop
   * walks one entry further left, past a proxy we know is there: behind
   * Cloudflare in front of Container Apps the chain ends `…, client, cf-edge`,
   * so 1 is the real client. Set it too high and the limiter groups a whole
   * proxy's traffic together, which is coarse; set it too low and nothing is
   * forgeable either. Both failure directions are safe, which is why the
   * default is 0 rather than a guess about somebody's topology.
   */
  trustedProxyHops: number;
  /**
   * Which addresses may be one of those hops (TRUSTED_PROXY_CIDRS,
   * comma-separated CIDRs; `cloudflare` stands for Cloudflare's published
   * ranges). Empty keeps the count alone.
   *
   * A count cannot tell a proxy from a client. The Container App's own address
   * still answers, and a request sent straight to it arrives one entry short:
   * with one hop trusted, the limiter then read the entry the client typed —
   * measured on production 2026-09-21, a forged address went into the log as
   * the caller's. With a list, a hop is stepped over only when the address that
   * appended it is on the list, so a direct request is counted against the
   * address that actually connected.
   */
  trustedProxyCidrs: string[];
  /**
   * Where a person writes when the product goes wrong. Empty means the instance
   * has no support channel and nothing offers one.
   *
   * Defaulted for the hosted service and for nobody else: a self-hosted instance
   * telling its users to email our address would send us mail we cannot act on
   * and send its own operator none. `SUPPORT_EMAIL` sets it either way.
   */
  supportEmail: string;
  /**
   * Where a data-protection request goes: access, correction, deletion,
   * portability, objection — the GDPR and KVKK doors. Same rule as
   * `supportEmail` and for the same reason: defaulted for the hosted service
   * only, because on an instance somebody else runs, the controller is that
   * operator and our address would take requests we cannot answer.
   * `PRIVACY_EMAIL` sets it either way.
   */
  privacyEmail: string;
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
   * How far back `/admin/ops` can look at load: five-minute rollups older than
   * this are purged. 0 disables the age purge (the row cap still applies).
   * Deliberately not a plan attribute — it describes the instance, not a tenant.
   */
  loadRetentionDays: number;
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
  /** Waiting/blocked runs keep their claims this long while a human responds. */
  agentWaitingLeaseMinutes: number;
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
  /**
   * Invitation emails this whole server sends in a UTC day (INVITE_EMAILS_PER_DAY,
   * default 50), on top of twenty per account.
   *
   * An invitation goes to an address nobody here has proved anything about,
   * through the same mail account that carries every sign-in code and password
   * reset. A provider plan has a daily allowance, and invitations spending it
   * would stop people signing in. Past the ceiling the invitation is still
   * created and the owner copies its link instead, so nothing is lost.
   */
  inviteEmailsPerDay: number;
  /**
   * Hosted Knowledge Hub engineering guardrails. These are configurable safety
   * ceilings, not commercial plan entitlements; self-hosted instances do not
   * apply them.
   */
  knowledgeHostedMaxBytes: number;
  knowledgeHostedMaxDrafts: number;
  knowledgeHostedMaxPublished: number;
  knowledgeHostedMaxVersions: number;
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
 * `SIGNUP_ACCESS_CODES` — `code` or `code:label`, comma separated.
 *
 * The label names the cohort, so an operator can tell which wave a beta account
 * came from without the code itself ever being written down next to it. It is
 * stored on the account that redeems it (`users.signup_cohort`) and read by
 * `/admin/beta`.
 *
 * `CODE:` with nothing after it yields **no label at all**, never an empty one —
 * `auth/accessCodes.ts` uses the empty string to mean "came through the door,
 * and the operator named no wave", and that only works while configuration
 * cannot produce it.
 */
function parseAccessCodes(raw: string | undefined): Env['signupAccessCodes'] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [code, label] = entry.split(':').map((part) => part.trim());
      return { code: code ?? '', label: label || undefined };
    })
    .filter((row) => row.code.length >= 6)
    .slice(0, 32);
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
/**
 * Where the embedded database lives when nobody said.
 *
 * Named rather than written twice because `--upgrade-data` has to answer the
 * same question without loading the rest of the configuration: somebody reading
 * the data-directory refusal has a path and a shell, and a production boot that
 * demands DATABASE_URL before it will look at a flag is another dead end.
 */
export const DEFAULT_PGLITE_DIR = '.data/pglite';

export function bootNodeEnv(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): string {
  if (env.NODE_ENV) return env.NODE_ENV;
  return argv.includes('--dev') ? 'development' : 'production';
}

/**
 * Cloudflare's edge ranges, as published at cloudflare.com/ips-v4 and /ips-v6
 * (read 2026-09-21; unchanged since 2021). Re-read them if Cloudflare announces
 * a change: an edge address missing here is counted as the client, which groups
 * that edge's visitors together — coarse, never forgeable.
 */
export const CLOUDFLARE_RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
  '2a06:98c0::/29', '2c0f:f248::/32',
] as const;

/** A list that does not parse stops the boot: a typo here must not quietly trust nobody. */
export function parseProxyCidrs(raw: string | undefined): string[] {
  const entries = (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .flatMap((entry) => (entry === 'cloudflare' ? [...CLOUDFLARE_RANGES] : [entry]));
  for (const entry of entries) {
    const [address, prefix] = entry.split('/');
    const family = isIP(address ?? '');
    const bits = Number(prefix);
    if (!family || !/^\d{1,3}$/.test(prefix ?? '') || bits > (family === 4 ? 32 : 128)) {
      throw new Error(`TRUSTED_PROXY_CIDRS: "${entry}" is not a CIDR range like 203.0.113.0/24 or 2001:db8::/32.`);
    }
  }
  return [...new Set(entries)];
}

export function loadEnv(overrides: Partial<Env> = {}): Env {
  const e = process.env;
  // Read once, before the object is built: two fields below key off it, and an
  // override has to reach them as well as the field it names.
  const hostedInstance = overrides.hosted ?? e.STMA_HOSTED === '1';
  const nodeEnv = e.NODE_ENV ?? 'development';
  const port = Number(e.PORT ?? 3000);
  const configuredBaseUrl = e.BASE_URL?.trim();
  const github =
    e.GITHUB_CLIENT_ID && e.GITHUB_CLIENT_SECRET
      ? { clientId: e.GITHUB_CLIENT_ID, clientSecret: e.GITHUB_CLIENT_SECRET }
      : undefined;
  const clickup =
    e.CLICKUP_CLIENT_ID && e.CLICKUP_CLIENT_SECRET
      ? { clientId: e.CLICKUP_CLIENT_ID, clientSecret: e.CLICKUP_CLIENT_SECRET }
      : undefined;
  const devMode = e.AUTH_DEV_MODE === '1' || (!github && nodeEnv !== 'production');
  const resendApiKey = e.RESEND_API_KEY || undefined;
  const csv = (v: string | undefined) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  const positiveInteger = (name: string, raw: string | undefined, fallback: number) => {
    const parsed = Number(raw ?? fallback);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new Error(`${name} must be a positive integer.`);
    }
    return parsed;
  };

  const env: Env = {
    nodeEnv,
    port,
    host: e.HOST ?? (nodeEnv === 'production' ? '0.0.0.0' : 'localhost'),
    baseUrl: (configuredBaseUrl || `http://localhost:${port}`).replace(/\/+$/, ''),
    databaseUrl: e.DATABASE_URL || undefined,
    databasePoolMax: Math.min(Math.max(Number(e.DATABASE_POOL_MAX) || 10, 1), 100),
    pgliteDir: e.PGLITE_DIR ?? DEFAULT_PGLITE_DIR,
    migrationsDir: e.MIGRATIONS_DIR || undefined,
    github,
    clickup,
    devMode,
    localAuth: e.AUTH_LOCAL !== '0',
    signupsOpen: e.SIGNUPS_OPEN !== '0',
    signupAccessCodes: parseAccessCodes(e.SIGNUP_ACCESS_CODES),
    betaUnmetered: e.BETA_UNMETERED === '1',
    publicMode: e.SITE_MODE === 'teaser' ? 'teaser' : 'full',
    hosted: hostedInstance,
    trustedProxyHops: Math.max(0, Math.min(8, Number(e.TRUSTED_PROXY_HOPS ?? '0') || 0)),
    trustedProxyCidrs: parseProxyCidrs(e.TRUSTED_PROXY_CIDRS),
    supportEmail: (e.SUPPORT_EMAIL ?? (hostedInstance ? 'support@matteai.com' : '')).trim(),
    privacyEmail: (e.PRIVACY_EMAIL ?? (hostedInstance ? 'gdpr@matteai.com' : '')).trim(),
    // Never on the hosted service, whatever the variable says. The panel exists
    // for a throwaway environment where hunting for the test credentials is the
    // friction; on the service people actually sign in to, a list of example
    // accounts under the password box is an invitation to try them. Dropping it
    // here rather than at the template keeps one answer for "is it on", and it
    // reads the same `hosted` the overrides can set rather than the raw
    // variable — otherwise a caller that passes `hosted: true` gets the panel.
    demoLogins: hostedInstance ? [] : parseDemoLogins(e.DEMO_LOGINS),
    embeddedDb: e.EMBEDDED_DB === '1',
    sessionTtlDays: Number(e.SESSION_TTL_DAYS ?? 30),
    snapshotRetentionDays: Number(e.SNAPSHOT_RETENTION_DAYS ?? 90),
    sessionRetentionDays: Number(e.SESSION_RETENTION_DAYS ?? 0),
    errorRetentionDays: Number(e.ERROR_RETENTION_DAYS ?? 30),
    loadRetentionDays: Number(e.LOAD_RETENTION_DAYS ?? 30),
    activityRetentionDays: Number(e.ACTIVITY_RETENTION_DAYS ?? 180),
    agentStaleMinutes: Number(e.AGENT_STALE_MINUTES ?? 3),
    agentClaimLeaseMinutes: Number(e.AGENT_CLAIM_LEASE_MINUTES ?? 5),
    agentWaitingLeaseMinutes: Number(e.AGENT_WAITING_LEASE_MINUTES ?? 30),
    adminUsernames: csv(e.ADMIN_USERNAMES),
    adminEmails: csv(e.ADMIN_EMAILS),
    resendApiKey,
    mailFrom: e.MAIL_FROM || 'STMA <noreply@stma.ai>',
    twoFactor: e.AUTH_2FA === '1' ? true : e.AUTH_2FA === '0' ? false : Boolean(resendApiKey),
    notifyDebounceSeconds: Number(e.NOTIFY_DEBOUNCE_SECONDS ?? 120),
    notifyMaxPerHour: Number(e.NOTIFY_MAX_PER_HOUR ?? 6),
    inviteEmailsPerDay: positiveInteger('INVITE_EMAILS_PER_DAY', e.INVITE_EMAILS_PER_DAY, 50),
    // Conservative engineering defaults keep a not-yet-priced hosted corpus
    // bounded. M01 may later turn reviewed values into commercial entitlements.
    knowledgeHostedMaxBytes: positiveInteger(
      'KNOWLEDGE_HOSTED_MAX_BYTES',
      e.KNOWLEDGE_HOSTED_MAX_BYTES,
      10 * 1024 * 1024,
    ),
    knowledgeHostedMaxDrafts: positiveInteger(
      'KNOWLEDGE_HOSTED_MAX_DRAFTS',
      e.KNOWLEDGE_HOSTED_MAX_DRAFTS,
      250,
    ),
    knowledgeHostedMaxPublished: positiveInteger(
      'KNOWLEDGE_HOSTED_MAX_PUBLISHED',
      e.KNOWLEDGE_HOSTED_MAX_PUBLISHED,
      250,
    ),
    knowledgeHostedMaxVersions: positiveInteger(
      'KNOWLEDGE_HOSTED_MAX_VERSIONS',
      e.KNOWLEDGE_HOSTED_MAX_VERSIONS,
      1_000,
    ),
    ...overrides,
  };

  if (env.nodeEnv === 'production' && !env.databaseUrl && !env.embeddedDb) {
    throw new Error(
      'DATABASE_URL is required in production. For single-instance self-hosting without Postgres, set EMBEDDED_DB=1 and mount a volume for the data directory.',
    );
  }
  if (env.nodeEnv === 'production' && !env.databaseUrl && env.embeddedDb) {
    console.warn(
      `[stma] Embedded database mode: single instance only — persist the data directory (${env.pgliteDir}) with a volume.`,
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
  /**
   * Say which address the mail actually goes out as.
   *
   * A configured key proves an account, never a verified sending domain, and
   * those fail in opposite ways: with no key nothing is sent and the warning
   * above says so, while with a key and an unverified `MAIL_FROM` domain the
   * product looks entirely healthy and every message is refused — sign-in codes
   * and password resets included. Nothing here can check the provider's
   * verification state, so this prints the one fact that makes the question
   * askable, next to the key that makes it matter. `MAIL_FROM` defaults to a
   * domain this deployment may not own.
   */
  if (env.resendApiKey && env.nodeEnv !== 'test') {
    console.log(
      `[stma] Mail: sending as ${env.mailFrom}. Its domain must be verified with the mail provider, or every message is refused and nobody can sign in or reset a password. Failures show on /admin/ops.`,
    );
  }
  // A door open to anyone is a decision, not a mistake — it is what a public
  // beta is — so this states the consequence instead of accusing the operator.
  // The consequence is worth saying at boot: the access code was the one
  // volumetric brake checked before an email is even looked at, and without it
  // account creation is held only by the per-IP limits, which are per replica.
  if (env.hosted && env.signupsOpen && env.signupAccessCodes.length === 0 && env.nodeEnv !== 'test') {
    console.warn(
      '[stma] hosted signup is open to anyone: no SIGNUP_ACCESS_CODES are set. New accounts are held by the shared per-IP signup counter and the per-IP limit on /auth/*. Set codes for an invite-only beta, or SIGNUPS_OPEN=0 to close signup entirely.',
    );
  }
  if (env.betaUnmetered && env.nodeEnv !== 'test') {
    console.warn(
      '[stma] BETA_UNMETERED=1: every workspace has every feature and no plan ceiling except the age limit on history, which stays the plan\'s. Plan limits resume the moment this is unset.',
    );
  }
  if (env.hosted && (e.DEMO_LOGINS ?? '') !== '') {
    console.warn('[stma] DEMO_LOGINS ignored: the hosted service never prints example accounts.');
  }
  return env;
}
