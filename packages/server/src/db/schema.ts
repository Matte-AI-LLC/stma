import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    githubId: bigint('github_id', { mode: 'number' }).unique(),
    /** Display name across attribution, compare labels and URLs — derived from the email. */
    username: text('username').notNull().unique(),
    /** scrypt hash for local (email+password) accounts; null for OAuth/dev users. */
    passwordHash: text('password_hash'),
    displayName: text('display_name'),
    /**
     * Login identity for local accounts, always stored lowercase+trimmed (lib/email).
     * Nullable because dev/OAuth accounts predate it; unique among the rows that have one.
     */
    email: text('email'),
    /**
     * When this address was proved, by entering a code mailed to it.
     *
     * Null means nobody has ever shown they can read it. That is the difference
     * between an account somebody can get back into and one where a typo at
     * signup is a permanent lockout: with email codes on, both the second factor
     * and the reset go to this address and nowhere else. Rows that predate the
     * column are left null and are told once, rather than being asserted as
     * proved by a migration that cannot know.
     */
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    /**
     * Which access-code cohort this account came through — never the code.
     *
     * The beta's door (`auth/accessCodes.ts`) matched a label and then wrote it
     * to one stdout line and nowhere else, so the only record of which wave
     * somebody arrived in expired with Log Analytics at thirty days. A beta that
     * runs longer than a month could not answer its own first question.
     *
     * Three states, and the difference between the first two matters:
     * `null` means no code was asked for at all (self-host, dev, or an account
     * older than the door), the empty string means a code matched that the
     * operator named no cohort for, and anything else is the label they typed.
     * The parser turns `CODE:` into no label rather than an empty one, so the
     * empty string is a value configuration cannot produce and the two silences
     * can never be confused. `cohortOf` writes it and `describeCohort` reads it.
     *
     * Written once, at signup, by the only door that checks a code — so
     * `created_at` is also when the cohort was redeemed, and there is no second
     * timestamp to keep honest.
     */
    signupCohort: text('signup_cohort'),
    avatarUrl: text('avatar_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_unique').on(t.email).where(sql`email is not null`)],
);

/** Persisted security requirements must be present in the running composition. */
export const appExtensionRequirements = pgTable('app_extension_requirements', {
  name: text('name').primaryKey(),
});

/**
 * Single-use email confirmation codes: sign-in second factor and password-change
 * confirmation. The row *is* the pending challenge — the browser only carries its id.
 */
export const authCodes = pgTable(
  'auth_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'login' | 'password_change'; validated in auth/codes. */
    purpose: text('purpose').notNull(),
    /** sha256 of the 6-digit code — the code itself only exists in the email. */
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('auth_codes_user_purpose').on(t.userId, t.purpose)],
);

export const teams = pgTable('teams', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdBy: uuid('created_by').references(() => users.id),
  /** Optional Slack/Discord incoming-webhook URL for session notifications. */
  webhookUrl: text('webhook_url'),
  /** Entitlement plan id; limits resolved in lib/entitlements. */
  plan: text('plan').notNull().default('free'),
  /**
   * What an hour of this team's engineering time is worth, in cents.
   *
   * Nullable and never guessed. The savings ledger reports minutes until
   * somebody sets it, because a currency figure derived from a number nobody
   * supplied is exactly the kind of claim that destroys trust in the whole
   * ledger — and minutes are already the honest unit.
   */
  hourlyCostCents: integer('hourly_cost_cents'),
  /** Secret path segment for inbound announce/github hooks. */
  inboundToken: text('inbound_token').unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    /**
     * Canonical origin (host/owner/repository), independent of the human-facing
     * name. Null means legacy/unverified and is never guessed into a remote.
     */
    repositoryIdentity: text('repository_identity'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('projects_team_slug').on(t.teamId, t.slug),
    uniqueIndex('projects_team_repository_identity')
      .on(t.teamId, t.repositoryIdentity)
      .where(sql`repository_identity is not null`),
  ],
);

export const memberships = pgTable(
  'memberships',
  {
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] })],
);

export const invites = pgTable('invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id')
    .notNull()
    .references(() => teams.id, { onDelete: 'cascade' }),
  code: text('code').notNull().unique(),
  createdBy: uuid('created_by').references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  uses: integer('uses').notNull().default(0),
  maxUses: integer('max_uses'),
  /**
   * What its holder joins as. Defaulted, so every invite written before this
   * column existed means what it meant when it was written: member.
   */
  role: text('role').notNull().default('member'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tokens = pgTable(
  'tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /**
     * Authorization boundary carried by this credential.
     *
     * Existing tokens migrate as `personal`, preserving the historical contract
     * that a PAT follows all of its owner's memberships. Tokens minted by the
     * agent-enrollment flow are explicit: one team, one project, or (only when
     * the user deliberately asks for it) the same personal/cross-team reach.
     */
    scope: text('scope').notNull().default('personal'),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    /** First characters of the token, for display purposes only. */
    prefix: text('prefix').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    /** New enrollments have no working authority until whoami confirms client loading. */
    setupExpiresAt: timestamp('setup_expires_at', { withTimezone: true }),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    /**
     * OAuth access tokens are deliberately short-lived and refreshed by the MCP
     * client. Null preserves the historical until-revoked PAT contract.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** Exact MCP resource URI this OAuth token may reach; null for legacy PATs. */
    audience: text('audience'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'tokens_scope_target',
      sql`(${t.scope} = 'personal' and ${t.teamId} is null and ${t.projectId} is null)
          or (${t.scope} = 'team' and ${t.teamId} is not null and ${t.projectId} is null)
          or (${t.scope} = 'project' and ${t.teamId} is not null and ${t.projectId} is not null)`,
    ),
  ],
);

/** A durable coding-agent installation owned by a human user. */
export const agentInstallations = pgTable(
  'agent_installations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * Enrollment-created installations are bound one-to-one to the credential
     * that activated them. Legacy CLI/manual registrations stay null.
     */
    tokenId: uuid('token_id').references(() => tokens.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    /** Human-chosen machine label. Null only on pre-enrollment/legacy installations. */
    deviceLabel: text('device_label'),
    clientType: text('client_type').notNull().default('generic'),
    clientVersion: text('client_version'),
    /**
     * What this agent is for — 'reviewer', 'tester', 'implementer'. A label, not a
     * permission: it tells a human reading the map why two agents on one task are
     * not a mistake. Validated against AGENT_ROLES in shared.
     */
    role: text('role'),
    /** Locally generated one-way device identifier; never a hostname or username. */
    deviceFingerprint: text('device_fingerprint').notNull(),
    capabilities: jsonb('capabilities').notNull().default([]),
    /**
     * Set on a checkout-local adapter: the MCP installation it listens for and
     * acts beside. `stma adapter activate` authorizes its own installation, so
     * without this nothing says the hooks in a checkout and the agent working
     * there are the same seat. Same owner only and never a chain — both held by
     * `domain/companions.ts`, because a CHECK cannot see another row. It moves
     * no authority: the adapter hears what is addressed to its companion and is
     * named beside it; it cannot accept that work or touch the companion's runs.
     */
    companionOf: uuid('companion_of').references((): AnyPgColumn => agentInstallations.id, {
      onDelete: 'set null',
    }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('agent_installations_token_unique').on(t.tokenId).where(sql`token_id is not null`),
    uniqueIndex('agent_installations_user_device_name').on(
      t.userId,
      t.deviceFingerprint,
      t.name,
    ),
    index('agent_installations_companion').on(t.companionOf).where(sql`companion_of is not null`),
    check('agent_installations_companion_not_self', sql`${t.companionOf} is null or ${t.companionOf} <> ${t.id}`),
  ],
);

/**
 * A short-lived, single-use grant handed to one new coding-agent installation.
 *
 * The copied prompt contains the enrollment code, never a long-lived PAT. On
 * redemption the code is consumed atomically, a scoped PAT is minted and one
 * durable installation is bound to it. The code itself is stored only as a
 * hash, exactly like a PAT.
 */
export const agentEnrollments = pgTable(
  'agent_enrollments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull().unique(),
    codePrefix: text('code_prefix').notNull(),
    name: text('name').notNull(),
    deviceLabel: text('device_label').notNull(),
    clientType: text('client_type').notNull().default('generic'),
    role: text('role'),
    scope: text('scope').notNull(),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    installationId: uuid('installation_id').references(() => agentInstallations.id, {
      onDelete: 'set null',
    }),
    /**
     * The pairing the human chose on a local adapter's consent screen, carried to
     * redemption. It is a choice, not yet a fact: redemption re-checks it and
     * drops it rather than minting a link to an agent that was revoked meanwhile.
     */
    companionOf: uuid('companion_of').references(() => agentInstallations.id, {
      onDelete: 'set null',
    }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'agent_enrollments_scope_target',
      sql`(${t.scope} = 'personal' and ${t.teamId} is null and ${t.projectId} is null)
          or (${t.scope} = 'team' and ${t.teamId} is not null and ${t.projectId} is null)
          or (${t.scope} = 'project' and ${t.teamId} is not null and ${t.projectId} is not null)`,
    ),
    index('agent_enrollments_user_created').on(t.userId, t.createdAt),
    index('agent_enrollments_expires').on(t.expiresAt),
  ],
);

/** Public MCP OAuth clients registered automatically by Claude/Codex. */
export const oauthClients = pgTable('oauth_clients', {
  id: text('id').primaryKey(),
  clientName: text('client_name').notNull(),
  clientUri: text('client_uri'),
  redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
});

/** Single-use, PKCE-bound authorization codes. Only the code hash is stored. */
export const oauthAuthorizationCodes = pgTable(
  'oauth_authorization_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    codeHash: text('code_hash').notNull().unique(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    enrollmentId: uuid('enrollment_id')
      .notNull()
      .references(() => agentEnrollments.id, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    resource: text('resource').notNull(),
    scope: text('scope').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('oauth_authorization_codes_expires').on(t.expiresAt)],
);

/**
 * Rotating public-client refresh tokens. Each generation is retained so reuse
 * of an already-spent token can revoke the whole credential family.
 */
export const oauthRefreshTokens = pgTable(
  'oauth_refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull().unique(),
    tokenId: uuid('token_id')
      .notNull()
      .references(() => tokens.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    resource: text('resource').notNull(),
    scope: text('scope').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('oauth_refresh_tokens_token').on(t.tokenId),
    index('oauth_refresh_tokens_client').on(t.clientId),
  ],
);

export const webSessions = pgTable('web_sessions', {
  id: text('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /**
   * Enough to answer "is that one me?", and deliberately no more.
   *
   * The browser and platform as the client stated them, truncated, plus the
   * address it last arrived from and when. A person looking at their own list
   * needs to tell one row from another; "Chrome on Windows" alone cannot
   * separate an intruder from the same person's other laptop, which is the
   * whole question the list exists to answer.
   *
   * This is the session's own data, shown only to the person it belongs to, and
   * it dies with the row — sessions are swept on expiry, so nothing here
   * outlives the access it describes. Do not add a second reader without saying
   * why on the page.
   */
  userAgent: text('user_agent'),
  lastIp: text('last_ip'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
});

export const snapshots = pgTable(
  'snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Repo identifier within the team (e.g. normalized remote URL or name). */
    repo: text('repo'),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    tokenId: uuid('token_id').references(() => tokens.id, { onDelete: 'set null' }),
    /**
     * Which machine of the owner this snapshot describes ("macbook", "win-desktop").
     * Normalized in lib/devices; the addressable key for a personal fleet, so
     * uniqueness ("latest") and retention are per (team, user, device).
     */
    deviceLabel: text('device_label').notNull().default('default'),
    /** Set when the push came from a registered agent installation (device_fingerprint identity). */
    deviceId: uuid('device_id').references(() => agentInstallations.id, { onDelete: 'set null' }),
    data: jsonb('data').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('snapshots_team_user_created').on(t.teamId, t.userId, t.createdAt),
    index('snapshots_team_user_device_created').on(
      t.teamId,
      t.userId,
      t.deviceLabel,
      t.createdAt,
    ),
  ],
);

/** One bounded unit of work performed by an agent installation on behalf of its owner. */
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    installationId: uuid('installation_id')
      .notNull()
      .references(() => agentInstallations.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    taskKey: text('task_key'),
    intent: text('intent'),
    repo: text('repo'),
    branch: text('branch'),
    worktree: text('worktree'),
    baseSha: text('base_sha'),
    headSha: text('head_sha'),
    /**
     * Optional logical start operation identity. Older clients leave both
     * fields null; newer clients can retry a lost response without creating a
     * second run. The hash refuses reuse for different arguments.
     */
    startRequestId: uuid('start_request_id'),
    startRequestHash: text('start_request_hash'),
    status: text('status').notNull().default('starting'),
    policyHash: text('policy_hash'),
    environmentFingerprint: text('environment_fingerprint'),
    /**
     * Runs sharing this key are deliberate parallel attempts at one task, so they
     * are exempt from each other's collision warnings (domain/agents). Null means
     * "this run is on its own", which is what every pre-existing run was.
     */
    attemptGroup: text('attempt_group'),
    /**
     * The vendor allowance this run last reported: percent of the window spent,
     * the derived state, when it resets and what the client calls it. Only the
     * client can know these, so they are reported, never measured here.
     */
    quotaPct: integer('quota_pct'),
    quotaState: text('quota_state'),
    quotaResetsAt: timestamp('quota_resets_at', { withTimezone: true }),
    quotaLabel: text('quota_label'),
    /**
     * Where the number came from: "measured" (the client read it from a real
     * source) or "estimate" (the agent guessed). STMA acts on the first and only
     * records the second — a guessed percentage that triggers a handoff at the
     * wrong moment is worse than no percentage at all.
     */
    quotaSource: text('quota_source'),
    /**
     * What actually became of the change, reported by the forge's webhooks:
     * the PR that carried this run's branch and the last completed CI verdict
     * on it. Written by /api/hooks (github pull_request + workflow_run, ADO
     * service hooks), never inferred — a run with no webhook wired stays null,
     * and null renders as "not linked", not as "fine".
     */
    prNumber: integer('pr_number'),
    prUrl: text('pr_url'),
    prState: text('pr_state'),
    ciState: text('ci_state'),
    /**
     * What this run reported spending, in cents, and whether that number was
     * read from a billing surface or guessed. Same discipline as quota: an
     * estimate is stored and shown as one; only measured figures aggregate.
     */
    costCents: integer('cost_cents'),
    costSource: text('cost_source'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [
    index('agent_runs_team_status_heartbeat').on(t.teamId, t.status, t.lastHeartbeatAt),
    index('agent_runs_installation_started').on(t.installationId, t.startedAt),
    uniqueIndex('agent_runs_installation_start_request')
      .on(t.installationId, t.startRequestId)
      .where(sql`start_request_id is not null`),
  ],
);

/**
 * Immutable client-reported repository observations for one run. A checkpoint
 * is provenance, not provider verification or authority to mutate a checkout.
 */
export const runCheckpoints = pgTable(
  'run_checkpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    installationId: uuid('installation_id')
      .notNull()
      .references(() => agentInstallations.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    repositoryIdentity: text('repository_identity').notNull(),
    commitSha: text('commit_sha').notNull(),
    worktreeClean: boolean('worktree_clean').notNull(),
    tests: jsonb('tests').$type<Array<{ name: string; state: string; detail?: string }>>().notNull(),
    requestId: uuid('request_id').notNull(),
    requestHash: text('request_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('run_checkpoints_run_request').on(t.runId, t.requestId),
    index('run_checkpoints_run_created').on(t.runId, t.createdAt),
    check('run_checkpoints_kind', sql`${t.kind} in ('start', 'delivery', 'tested')`),
  ],
);

/** Append-only, typed metadata trail for an agent run. */
export const agentEvents = pgTable(
  'agent_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    detail: jsonb('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('agent_events_run_created').on(t.runId, t.createdAt)],
);

/** Leased paths/components/contracts an active run expects to read or change. */
export const workClaims = pgTable(
  'work_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    resourceType: text('resource_type').notNull(),
    resourceKey: text('resource_key').notNull(),
    access: text('access').notNull().default('write'),
    /** Declared before work, or observed later from the dirty worktree. */
    source: text('source').notNull().default('planned'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }).notNull(),
    /** When this run last declared it: restating scope rewrites the row, which is how moved ground is acknowledged. */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * When this run first declared it and has held it since. Carried across
     * restatements, so it says who was on the ground first: that run keeps the
     * right of way, and a run that declares the same ground later waits for it.
     * Null on rows older than the column, which therefore yield to nobody.
     */
    firstDeclaredAt: timestamp('first_declared_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('work_claims_run_resource').on(
      t.runId,
      t.resourceType,
      t.resourceKey,
      t.access,
      t.source,
    ),
    index('work_claims_lease').on(t.leaseExpiresAt),
  ],
);

/** Versioned, canonical team/project policy documents. */
export const policyBundles = pgTable(
  'policy_bundles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    scopeKey: text('scope_key').notNull(),
    version: integer('version').notNull(),
    status: text('status').notNull().default('active'),
    document: jsonb('document').notNull(),
    hash: text('hash').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('policy_bundles_team_scope_version').on(t.teamId, t.scopeKey, t.version)],
);

export const policyReceipts = pgTable('policy_receipts', {
  runId: uuid('run_id')
    .primaryKey()
    .references(() => agentRuns.id, { onDelete: 'cascade' }),
  expectedHash: text('expected_hash').notNull(),
  reportedHash: text('reported_hash'),
  drift: boolean('drift').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Stable Knowledge Hub identity. Draft and published content lives only in the
 * immutable version table; these pointers are the small mutable lifecycle head.
 */
export const knowledgeItems = pgTable(
  'knowledge_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    stableKey: text('stable_key').notNull(),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    state: text('state').notNull().default('active'),
    currentVersionId: uuid('current_version_id').references(
      (): AnyPgColumn => knowledgeVersions.id,
      { onDelete: 'set null' },
    ),
    draftVersionId: uuid('draft_version_id').references(
      (): AnyPgColumn => knowledgeVersions.id,
      { onDelete: 'set null' },
    ),
    /** Incremented by every pointer/lifecycle CAS; content rows are never updated. */
    generation: integer('generation').notNull().default(0),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('knowledge_items_team_key').on(t.teamId, t.stableKey),
    index('knowledge_items_team_state').on(t.teamId, t.state, t.updatedAt),
    check('knowledge_items_state', sql`${t.state} in ('active', 'archived', 'withdrawn', 'deleted')`),
  ],
);

/** Immutable Knowledge Hub content/source/audience revision. */
export const knowledgeVersions = pgTable(
  'knowledge_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => knowledgeItems.id, { onDelete: 'cascade' }),
    /** Duplicated for SQL-first tenant filtering; the domain verifies it against the item. */
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    /** Every draft/publish append advances revision; publication numbers only published copies. */
    revision: integer('revision').notNull(),
    publication: integer('publication'),
    status: text('status').notNull(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    bodyHash: text('body_hash').notNull(),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    publisherId: uuid('publisher_id').references(() => users.id, { onDelete: 'set null' }),
    audienceType: text('audience_type').notNull(),
    sourceType: text('source_type').notNull(),
    sourceUri: text('source_uri'),
    sourceRepository: text('source_repository'),
    sourceCommit: text('source_commit'),
    sourcePath: text('source_path'),
    /** Source observation, source change and owner review are intentionally distinct facts. */
    sourceCheckedAt: timestamp('source_checked_at', { withTimezone: true }),
    sourceChangedAt: timestamp('source_changed_at', { withTimezone: true }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    /** Persistent diagnostic; content stays immutable while resolution metadata may advance. */
    conflictsWithVersionId: uuid('conflicts_with_version_id').references(
      (): AnyPgColumn => knowledgeVersions.id,
      { onDelete: 'set null' },
    ),
    conflictReason: text('conflict_reason'),
    conflictDetectedAt: timestamp('conflict_detected_at', { withTimezone: true }),
    conflictResolvedAt: timestamp('conflict_resolved_at', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    reviewAfter: timestamp('review_after', { withTimezone: true }),
    supersedesVersionId: uuid('supersedes_version_id').references(
      (): AnyPgColumn => knowledgeVersions.id,
      { onDelete: 'set null' },
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('knowledge_versions_item_revision').on(t.itemId, t.revision),
    uniqueIndex('knowledge_versions_item_publication')
      .on(t.itemId, t.publication)
      .where(sql`publication is not null`),
    index('knowledge_versions_team_status').on(t.teamId, t.status, t.publishedAt),
    check('knowledge_versions_status', sql`${t.status} in ('draft', 'published')`),
    check(
      'knowledge_versions_publication_shape',
      sql`(${t.status} = 'draft' and ${t.publication} is null and ${t.publisherId} is null and ${t.publishedAt} is null)
          or (${t.status} = 'published' and ${t.publication} is not null and ${t.publisherId} is not null and ${t.publishedAt} is not null)`,
    ),
    check(
      'knowledge_versions_audience',
      sql`${t.audienceType} in ('workspace_members', 'selected_projects')`,
    ),
    check('knowledge_versions_source', sql`${t.sourceType} in ('native', 'import')`),
    check(
      'knowledge_versions_conflict_shape',
      sql`(${t.conflictsWithVersionId} is null and ${t.conflictReason} is null and ${t.conflictDetectedAt} is null)
          or (${t.conflictsWithVersionId} is not null and ${t.conflictReason} is not null and ${t.conflictDetectedAt} is not null)`,
    ),
  ],
);

/** Project audiences are rows, never a JSON list checked after retrieval. */
export const knowledgeAudienceProjects = pgTable(
  'knowledge_audience_projects',
  {
    versionId: uuid('version_id')
      .notNull()
      .references(() => knowledgeVersions.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.versionId, t.projectId] }),
    index('knowledge_audience_team_project').on(t.teamId, t.projectId, t.versionId),
  ],
);

/** Immutable resolver output; KH-3 will attach these manifests to runs/handoffs. */
export const knowledgeContexts = pgTable(
  'knowledge_contexts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    tokenId: uuid('token_id').references(() => tokens.id, { onDelete: 'set null' }),
    runId: uuid('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    checkpointId: uuid('checkpoint_id').references(() => runCheckpoints.id, {
      onDelete: 'set null',
    }),
    query: text('query'),
    purpose: text('purpose').notNull().default('retrieval'),
    resolverVersion: text('resolver_version').notNull(),
    manifest: jsonb('manifest').$type<Record<string, unknown>>().notNull(),
    /** Exact server-produced envelope for retry-safe context delivery. */
    response: jsonb('response').$type<Record<string, unknown>>(),
    byteSize: integer('byte_size').notNull(),
    truncated: boolean('truncated').notNull().default(false),
    omittedCount: integer('omitted_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('knowledge_contexts_team_created').on(t.teamId, t.createdAt),
    uniqueIndex('knowledge_contexts_run_start')
      .on(t.runId)
      .where(sql`purpose = 'run_start' and run_id is not null`),
    check(
      'knowledge_contexts_purpose',
      sql`${t.purpose} in ('retrieval', 'run_start', 'handoff_resume')`,
    ),
  ],
);

/**
 * Delivery evidence, not compliance: server-served and client-reported moments
 * are separate facts and a missing report is never promoted into success.
 */
export const knowledgeReceipts = pgTable(
  'knowledge_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contextId: uuid('context_id')
      .notNull()
      .references(() => knowledgeContexts.id, { onDelete: 'cascade' }),
    tokenId: uuid('token_id').references(() => tokens.id, { onDelete: 'set null' }),
    installationId: uuid('installation_id').references(() => agentInstallations.id, {
      onDelete: 'set null',
    }),
    runId: uuid('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    servedAt: timestamp('served_at', { withTimezone: true }).notNull().defaultNow(),
    reportedAt: timestamp('reported_at', { withTimezone: true }),
    reportedManifestHash: text('reported_manifest_hash'),
  },
  (t) => [index('knowledge_receipts_context').on(t.contextId, t.servedAt)],
);

/** Project golden-environment snapshots used by run preflight. */
export const environmentBaselines = pgTable(
  'environment_baselines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    data: jsonb('data').notNull(),
    fingerprint: text('fingerprint').notNull(),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('environment_baselines_project_active').on(t.projectId, t.active, t.createdAt)],
);

/**
 * One recorded environment-preflight decision, so "this machine was told it was
 * misconfigured" leaves a trace an owner can read afterwards (/app/teams/:slug/governance).
 *
 * `details` keeps a compact, already-derived shape — per-section difference counts and the
 * policy violations — never the machine's environment values, which stay on the machine
 * exactly as they do for snapshots.
 */
export const environmentChecks = pgTable(
  'environment_checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** The run this preflight guarded, when the agent passed one. */
    runId: uuid('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    /** 'ok' | 'warning' | 'critical' | 'no_baseline' — the preflight verdict. */
    status: text('status').notNull(),
    fingerprint: text('fingerprint').notNull(),
    baselineFingerprint: text('baseline_fingerprint'),
    /** One human-readable line for the governance table. */
    summary: text('summary'),
    details: jsonb('details'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('environment_checks_team_created').on(t.teamId, t.createdAt),
    index('environment_checks_project_created').on(t.projectId, t.createdAt),
  ],
);

export const debugSessions = pgTable(
  'debug_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    /** 'debug' | 'announcements' (one pinned channel per team). */
    kind: text('kind').notNull().default('debug'),
    title: text('title').notNull(),
    status: text('status').notNull().default('open'),
    openedBy: uuid('opened_by').references(() => users.id),
    context: jsonb('context'),
    resolution: jsonb('resolution'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    /** At most one announcements channel per team — makes the lazy-create race safe. */
    uniqueIndex('debug_sessions_team_announcements')
      .on(t.teamId)
      .where(sql`kind = 'announcements'`),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => debugSessions.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => users.id),
    tokenId: uuid('token_id').references(() => tokens.id, { onDelete: 'set null' }),
    kind: text('kind').notNull().default('note'),
    /** Self-reported agent name, e.g. "claude-code" or "cursor". */
    via: text('via'),
    body: text('body').notNull(),
    attachments: jsonb('attachments'),
    /**
     * Structured content STMA generated itself — today the handoff's resume block
     * (branch, task, scope, the exact start_run call). Kept out of `body` because
     * a reader must be able to tell what a person typed from what the server
     * recorded: the first is data, the second is safe to act on.
     */
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('messages_session_created').on(t.sessionId, t.createdAt)],
);

/** Durable onboarding observations, separate from the bounded activity feed. */
export const launchAttempts = pgTable('launch_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  intent: text('intent').notNull().default('my_agents'),
  sessionId: uuid('session_id').references(() => debugSessions.id, { onDelete: 'set null' }),
  firstInstallationId: uuid('first_installation_id').references(() => agentInstallations.id, { onDelete: 'set null' }),
  secondInstallationId: uuid('second_installation_id').references(() => agentInstallations.id, { onDelete: 'set null' }),
  firstConnectedAt: timestamp('first_connected_at', { withTimezone: true }),
  secondConnectedAt: timestamp('second_connected_at', { withTimezone: true }),
  exchangeConfirmedAt: timestamp('exchange_confirmed_at', { withTimezone: true }),
  firstRealResultAt: timestamp('first_real_result_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('launch_owner_scope').on(t.userId, t.teamId, t.projectId)]);

/** An offer is not accepted merely because somebody asks a question in chat. */
export const handoffs = pgTable('handoffs', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().unique().references(() => debugSessions.id, { onDelete: 'cascade' }),
  offeredBy: uuid('offered_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  targetUserId: uuid('target_user_id').references(() => users.id, { onDelete: 'set null' }),
  /**
   * Set when the brief was assigned to one named agent rather than offered to a
   * person or to the team. Only that installation may accept, resume or complete
   * it: a lead who said "Codex B, take this" has already decided who, and a
   * second agent on the same account taking it instead is exactly the race the
   * name was meant to prevent.
   */
  targetInstallationId: uuid('target_installation_id').references(() => agentInstallations.id, {
    onDelete: 'set null',
  }),
  /** `handoff` (an agent stopping) or `assignment` (a lead starting somebody). */
  kind: text('kind').notNull().default('handoff'),
  acceptedBy: uuid('accepted_by').references(() => users.id, { onDelete: 'set null' }),
  installationId: uuid('installation_id').references(() => agentInstallations.id, { onDelete: 'set null' }),
  checkpointId: uuid('checkpoint_id').references(() => runCheckpoints.id, { onDelete: 'set null' }),
  knowledgeContextId: uuid('knowledge_context_id').references(() => knowledgeContexts.id, {
    onDelete: 'set null',
  }),
  /** Receiver-scoped context resolved once on resume, retained for exact replay. */
  resumedKnowledgeContextId: uuid('resumed_knowledge_context_id').references(
    () => knowledgeContexts.id,
    { onDelete: 'set null' },
  ),
  state: text('state').notNull().default('offered'),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  resumedAt: timestamp('resumed_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('handoff_state').on(t.state, t.updatedAt),
  check('handoffs_kind', sql`${t.kind} in ('handoff', 'assignment')`),
]);

/** Retry receipts are scoped to the issuing credential and retained with the session. */
export const handoffRequests = pgTable('handoff_requests', {
  tokenId: uuid('token_id').notNull().references(() => tokens.id, { onDelete: 'cascade' }),
  requestKey: text('request_key').notNull(),
  requestHash: text('request_hash').notNull(),
  sessionId: uuid('session_id').notNull().references(() => debugSessions.id, { onDelete: 'cascade' }),
  response: jsonb('response').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.tokenId, t.requestKey] })]);

export const activity = pgTable(
  'activity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    tokenId: uuid('token_id').references(() => tokens.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    detail: text('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('activity_team_created').on(t.teamId, t.createdAt)],
);

/** Operator-only design-partner CRM (the /admin area); never shown to teams. */
export const crmContacts = pgTable('crm_contacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  org: text('org'),
  /** Email address or handle — whatever reaches the person. */
  contact: text('contact'),
  /** Pipeline stage; validated in routes/admin against CRM_STATUSES. */
  status: text('status').notNull().default('lead'),
  source: text('source'),
  notes: text('notes'),
  nextActionAt: timestamp('next_action_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Operator-only error log powering /admin/ops. Written by the app error handler and
 * the process-level exception monitor; never shown to teams.
 *
 * userId/teamSlug are deliberately plain text columns without foreign keys: an error
 * record must never block deleting the user or team it happens to mention, and it
 * must survive them. Message and stack are redacted (lib/redact) before insert.
 */
export const errorEvents = pgTable(
  'error_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    /** 'http' (request handler) | 'unhandled' (process-level). Validated in lib/errors. */
    kind: text('kind').notNull().default('http'),
    method: text('method'),
    path: text('path'),
    status: integer('status'),
    message: text('message').notNull(),
    stack: text('stack'),
    userId: text('user_id'),
    teamSlug: text('team_slug'),
    requestId: text('request_id'),
  },
  (t) => [index('error_events_at').on(t.at.desc())],
);

/**
 * One closed five-minute bucket of load, so `/admin/ops` can answer "was last
 * Tuesday worse than today" and not only "what is this process doing now".
 *
 * Everything else about load lives in `lib/metrics` as a ring in one process's
 * memory: it dies with the container, and a second replica would tell a
 * different story. This is the record.
 *
 * **Five minutes**, chosen against the two neighbours. One minute is 43,200 rows
 * a month to re-answer a question the live ring already answers for the last
 * hour. One hour is 720 rows, but a five-minute outage disappears into a
 * twelfth of a bar and "when did it spike" stops having an answer. Five minutes
 * is 8,640 rows a month and keeps the shape of a spike.
 *
 * **The latency histogram is stored, not a percentile.** A p95 cannot be
 * averaged, summed or rolled up into an hour — the only honest way to answer
 * p95-over-a-day is to add the histograms and recompute, which is what
 * `percentileFrom` does. Storing a mean and calling it p95 is the mistake this
 * column exists to refuse.
 *
 * **One row per process per bucket.** `instance` is a boot id, so the writer is
 * correct with the single replica this app is pinned to today and does not
 * silently become wrong with two: a second replica adds its own row, and every
 * reader groups by bucket and sums — counts add, histograms add element-wise,
 * peaks take a max. Two restarts in one bucket also show as two rows, which is
 * how the history records a restart without a second table.
 */
export const loadSamples = pgTable(
  'load_samples',
  {
    /** Boot id of the reporting process — new on every start, so a restart is visible. */
    instance: text('instance').notNull(),
    /** Start of the bucket, UTC, always a multiple of LOAD_BUCKET_MS. */
    bucketAt: timestamp('bucket_at', { withTimezone: true }).notNull(),
    /** Minutes of the five this process observed; below five the bucket is partial. */
    minutes: integer('minutes').notNull().default(0),
    requests: integer('requests').notNull().default(0),
    redirects: integer('redirects').notNull().default(0),
    clientErrors: integer('client_errors').notNull().default(0),
    serverErrors: integer('server_errors').notNull().default(0),
    rateLimited: integer('rate_limited').notNull().default(0),
    /** One count per LATENCY_BUCKETS index in lib/metrics; that array is the row's meaning. */
    latency: jsonb('latency').$type<number[]>().notNull(),
    /** Worst event-loop lag sampled in the bucket, ms. */
    loopLagMaxMs: integer('loop_lag_max_ms').notNull().default(0),
    /** Peak resident set size, in MB rather than bytes: integer holds 2.1 GB of bytes. */
    rssMb: integer('rss_mb').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.instance, t.bucketAt] }),
    index('load_samples_bucket').on(t.bucketAt.desc()),
  ],
);

/**
 * When a workspace's ceiling moved, and who moved it.
 *
 * The operator question this answers is a customer saying "this used to work".
 * Until now a plan switch reached stdout and nothing else, and the Stripe
 * webhook — the writer for every change nobody made by hand — reached the
 * billing log and nothing else either.
 *
 * Every ceiling in this product today is a function of exactly two things:
 * `teams.plan`, and the EE evaluation that overrides the whole limit set for 14
 * days without touching that column. So there are two `field` values and two
 * writers, and `lib/ceilings` owns both; a test refuses any other write to
 * `teams.plan`. Membership add/role/removal are deliberately *not* here: they
 * spend a ceiling rather than move one, they already reach the team activity
 * feed, and routine membership churn would bury the handful of rows an operator
 * opens this table to find.
 *
 * `previous`/`next` are text because the fields they describe are not one type —
 * a plan id and an evaluation window are both best read as the words a person
 * would say. `detail` is written only by this codebase and never from a request
 * body, for the same reason `field` and `source` are closed sets: a log a caller
 * can write sentences into is not a log.
 */
/**
 * A plan an operator gave a workspace, beside the plan it has.
 *
 * It rides beside `teams.plan` the way the EE evaluation does rather than
 * writing the column, and that is the whole design: `setTeamPlan` stays the one
 * writer of `teams.plan`, what Stripe or an operator set there is untouched
 * while the grant lasts, and when a dated grant ends the workspace is simply
 * back on its own plan with nothing to unwind and nothing to sweep —
 * `lib/planGrants` compares `ends_at` with the clock on every read.
 *
 * One row per workspace: giving again replaces it, and the history of every
 * give, change and revoke is in `ceiling_changes` under the field `grant`.
 * `ends_at` null means no end date. It is the first instant the grant no longer
 * applies, so a grant "through 31 December" ends at 1 January 00:00 UTC.
 */
export const planGrants = pgTable(
  'plan_grants',
  {
    teamId: uuid('team_id')
      .primaryKey()
      .references(() => teams.id, { onDelete: 'cascade' }),
    plan: text('plan').notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    /** The operator's own words about why, shown only on /admin and never logged. */
    note: text('note'),
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
    /** Their username as it read then, so a deleted account still names the grant. */
    grantedByLabel: text('granted_by_label'),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Free is the floor every workspace already stands on; granting it would be
    // a row that changes nothing and reads like it did something.
    check('plan_grants_plan', sql`${t.plan} in ('solo', 'team', 'enterprise')`),
  ],
);

export const ceilingChanges = pgTable(
  'ceiling_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    /** The workspace's slug when it happened — a workspace can be renamed afterwards. */
    teamSlug: text('team_slug').notNull(),
    /** 'plan' | 'evaluation' | 'grant'. Validated in lib/ceilings. */
    field: text('field').notNull(),
    previous: text('previous'),
    next: text('next'),
    /** 'operator' | 'billing' | 'owner'. Validated in lib/ceilings. */
    source: text('source').notNull(),
    /** Null when no human did it — a Stripe webhook has no actor. */
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    /** Their username as it read then, so a deleted account still names the change. */
    actorLabel: text('actor_label'),
    /** The exact route or event that carried it. */
    route: text('route').notNull(),
    detail: text('detail'),
  },
  (t) => [
    index('ceiling_changes_at').on(t.at.desc()),
    index('ceiling_changes_team').on(t.teamId, t.at.desc()),
  ],
);

/**
 * Who gained or lost access to a workspace, and who did it.
 *
 * The other half of `ceiling_changes`, and deliberately a second table rather
 * than a `field` value on the first. A ceiling change is (workspace, field,
 * previous, next) and a membership change is (workspace, *person*, previous
 * role, next role): merging them would leave half the columns null in half the
 * rows, and both of the questions an operator actually asks — "what happened to
 * this person" and "what did this workspace lose" — would have to filter on
 * `field` before they could begin. They also differ in volume by an order of
 * magnitude, which is the reason the ceiling table names for keeping membership
 * churn out of it.
 *
 * It is **not** the team activity feed, which already carries member_joined /
 * member_removed / member_promoted for the workspace's own members to read.
 * Different readers, different retention: the feed is swept by age (by plan, on
 * the hosted service), is capped per team, and a team owner deleting their
 * workspace deletes it. This is the operator's, has no age sweep, and can be
 * read across every workspace at once. Both are written where both apply; where
 * only one applies — an account deleting itself writes no feed row in anybody's
 * workspace, an organization deprovisioning writes across several — the gap was
 * the thing worth closing.
 *
 * It **cascades with the workspace**, exactly like `ceiling_changes` and for the
 * same reason: the record explains access *to a workspace*, and once the
 * workspace is gone its absence is the answer. The consequence is stated rather
 * than hidden — deleting a team wipes every membership in it and this table
 * cannot record that, because the rows would be deleted by the same
 * transaction, so `lib/memberships` does not write them and says why.
 */
export const membershipChanges = pgTable(
  'membership_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    /** The workspace's slug when it happened — a workspace can be renamed afterwards. */
    teamSlug: text('team_slug').notNull(),
    /** 'added' | 'role_changed' | 'removed'. Validated in lib/memberships. */
    action: text('action').notNull(),
    /** Whose access moved. Null once the account row itself is gone. */
    subjectId: uuid('subject_id').references(() => users.id, { onDelete: 'set null' }),
    /**
     * Their username as it read then — deliberately null on the one path where
     * the subject asked to be erased. See `lib/memberships`.
     */
    subjectLabel: text('subject_label'),
    /** The role before and after: null on the side where there was no membership. */
    previousRole: text('previous_role'),
    nextRole: text('next_role'),
    /** 'owner' | 'operator' | 'invite' | 'identity' | 'self'. Validated in lib/memberships. */
    source: text('source').notNull(),
    /** Null when no human did it — SCIM deprovisioning has no actor. */
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    actorLabel: text('actor_label'),
    /** The exact route or event that carried it. */
    route: text('route').notNull(),
    /**
     * True when this removal left the workspace with no owner at all. The core
     * console and `/admin` both refuse that; the organization deprovisioning
     * path deliberately does not, so this column is where it shows up.
     */
    leftOwnerless: boolean('left_ownerless').notNull().default(false),
    /**
     * One act that touched several workspaces shares one id, so "what did that
     * one deprovisioning do" is a single query rather than a guess from
     * timestamps.
     */
    groupId: uuid('group_id'),
    detail: text('detail'),
  },
  (t) => [
    index('membership_changes_at').on(t.at.desc()),
    index('membership_changes_team').on(t.teamId, t.at.desc()),
    index('membership_changes_subject').on(t.subjectId, t.at.desc()),
    index('membership_changes_group').on(t.groupId),
  ],
);

/**
 * Per-user email notification switches. A user who never opened the preferences
 * page has no row at all — NOTIFICATION_DEFAULTS in lib/notifications answers for
 * them, so the events that matter arrive without anyone opting in first.
 */
export const notificationPrefs = pgTable('notification_prefs', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** A message in a session you opened or already posted in. */
  sessionReply: boolean('session_reply').notNull().default(true),
  /** A session you take part in was resolved. */
  sessionResolved: boolean('session_resolved').notNull().default(true),
  /** Your account was added to a team. */
  teamJoined: boolean('team_joined').notNull().default(true),
  /** Team-wide announcements: broadcast to everyone, so off unless asked for. */
  announcements: boolean('announcements').notNull().default(false),
  /**
   * Personal Slack/Discord incoming webhook. The team webhook on `teams` tells a
   * channel that something happened; this one reaches the person it happened to,
   * on the surface they actually watch. Same switches govern both, and the same
   * SSRF guard (lib/notify) applies.
   */
  webhookUrl: text('webhook_url'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Per-team outbound integration credentials. One row per (team, provider).
 *
 * The token is stored as given: it has to be replayable to call the provider,
 * which a hash cannot do. It is write-only from the browser's side — never
 * rendered back, only its tail — and moving it into a key vault is the deferred
 * item this table is named for.
 */
export const teamIntegrations = pgTable(
  'team_integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    /** 'github', 'azure-devops', 'jira' or 'clickup'. */
    provider: text('provider').notNull().default('github'),
    /**
     * The human-readable locator, whatever "where" means for the provider:
     * github "owner/name", azure-devops "org/project/repo", jira host, clickup workspace id.
     */
    repo: text('repo').notNull(),
    token: text('token').notNull(),
    /** Post a comment on the issue when a run that names it finishes or hands off. */
    commentOnFinish: boolean('comment_on_finish').notNull().default(true),
    /** Provider extras not in locator/secret (jira email; clickup name + project/list bindings). */
    config: jsonb('config'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('team_integrations_team_provider_repo').on(t.teamId, t.provider, t.repo)],
);

/** A provider connection can bind multiple exact repositories to projects. */
export const repositoryBindings = pgTable('repository_bindings', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull().references(() => teamIntegrations.id, { onDelete: 'cascade' }),
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  repositoryId: text('repository_id').notNull(),
  fullName: text('full_name').notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
}, (t) => [uniqueIndex('repository_binding_identity').on(t.teamId, t.provider, t.repositoryId)]);

/** Exact provider facts are separate from legacy branch-linked run summaries. */
export const providerObservations = pgTable('provider_observations', {
  id: uuid('id').primaryKey().defaultRandom(),
  bindingId: uuid('binding_id').notNull().references(() => repositoryBindings.id, { onDelete: 'cascade' }),
  /** Scope at observation time. Moving a binding must not move its old evidence. */
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
  deliveryId: text('delivery_id').notNull(),
  subjectId: text('subject_id').notNull(),
  commitSha: text('commit_sha').notNull(),
  kind: text('kind').notNull(),
  state: text('state').notNull(),
  attempt: integer('attempt').notNull().default(1),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('provider_delivery_once').on(t.bindingId, t.deliveryId), index('provider_subject').on(t.bindingId, t.subjectId, t.commitSha)]);

export const deliverySetups = pgTable('delivery_setups', {
  id: text('id').primaryKey(),
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  manifest: jsonb('manifest').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const deliverySetupReceipts = pgTable('delivery_setup_receipts', {
  id: uuid('id').primaryKey().defaultRandom(),
  setupId: text('setup_id').notNull().references(() => deliverySetups.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenId: uuid('token_id').references(() => tokens.id, { onDelete: 'set null' }),
  digest: text('digest').notNull().unique(),
  receipt: jsonb('receipt').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A team's delivery flows: the "how work moves here" document, per team or per
 * project. One *active* flow per scope is enforced in both the domain and the
 * database. The expression index maps the team-wide NULL project to a sentinel
 * UUID so concurrent writers cannot create two active defaults.
 *
 * The document column holds a `deliveryFlowSchema` value; the pipeline YAML and
 * the agent brief are rendered from it on read, never stored — stored copies of
 * a derivable thing are the drift this product exists to catch.
 */
export const deliveryFlows = pgTable(
  'delivery_flows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    /** Null means the flow is the team-wide default. */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    /** Which built-in template it grew from, for attribution and re-prefill. */
    templateKey: text('template_key').notNull(),
    /** Pipeline dialect this flow renders: 'azure-devops' | 'github-actions'. */
    provider: text('provider').notNull().default('azure-devops'),
    document: jsonb('document').notNull(),
    status: text('status').notNull().default('active'),
    version: integer('version').notNull().default(1),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('delivery_flows_team').on(t.teamId, t.status),
    uniqueIndex('delivery_flows_active_scope')
      .on(
        t.teamId,
        sql`coalesce(${t.projectId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      )
      .where(sql`${t.status} = 'active'`),
  ],
);

/**
 * The notification outbox. Nothing is emailed from a request handler: an event
 * queues a row here and the sweep in lib/notifications decides — minutes later —
 * whether it still deserves an email (unread, still wanted, under the cap).
 *
 * The row is also the send log: finished rows stay for a day, and the ones marked
 * `sent` inside the last hour are what the per-user rate cap counts.
 */
export const notificationQueue = pgTable(
  'notification_queue',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Event class; maps 1:1 onto a notification_prefs column. */
    kind: text('kind').notNull(),
    /**
     * Coalescing key. While a row is pending, another event with the same
     * (user, key) folds into it instead of queueing a second email.
     */
    coalesceKey: text('coalesce_key').notNull(),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => debugSessions.id, { onDelete: 'cascade' }),
    /** Lower bound of the events this one email covers. */
    sinceAt: timestamp('since_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Debounce deadline, set once by the first event and never pushed back — a
     * thread that keeps talking cannot defer its own notification indefinitely.
     */
    notBefore: timestamp('not_before', { withTimezone: true }).notNull(),
    /** 'pending' | 'sent' | 'skipped' | 'failed'. Only 'sent' counts against the cap. */
    status: text('status').notNull().default('pending'),
    /** Handoff rows retry; routine activity remains single-attempt. */
    critical: boolean('critical').notNull().default(false),
    attempts: integer('attempts').notNull().default(0),
    /** Database lease shared by every process running the notification sweep. */
    leaseOwner: text('lease_owner'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    /** Why a row was skipped or failed: read, pref_off, no_email, rate_capped, … */
    reason: text('reason'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** At most one pending email per (user, thread) — coalescing enforced by the database. */
    uniqueIndex('notification_queue_pending')
      .on(t.userId, t.coalesceKey)
      .where(sql`status in ('pending', 'sending')`),
    index('notification_queue_due').on(t.status, t.notBefore),
    index('notification_queue_user_sent').on(t.userId, t.sentAt),
  ],
);

/** Agent inbox cursors are per credential, never shared with the human browser. */
export const agentReadState = pgTable(
  'agent_read_state',
  {
    tokenId: uuid('token_id').notNull().references(() => tokens.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').notNull().references(() => debugSessions.id, { onDelete: 'cascade' }),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.tokenId, t.sessionId] })],
);

export const readState = pgTable(
  'read_state',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => debugSessions.id, { onDelete: 'cascade' }),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.sessionId] })],
);

/**
 * Shared fixed-window counters. The rate limiter and the agent loop guard both
 * used to live in a Map on one process, which is why the app was pinned to a
 * single replica — two instances meant two independent budgets, and an agent
 * ping-ponging through a load balancer was only ever half-braked. Postgres is
 * the smallest thing that makes those numbers mean the same on every instance.
 *
 * Deliberately NOT used for unauthenticated, IP-keyed limits: writing a row for
 * every anonymous hit turns the limiter itself into an amplifier.
 */
export const rateCounters = pgTable(
  'rate_counters',
  {
    /** `<bucket>:<subject>:<windowStartMs>` — the window is part of the key. */
    key: text('key').primaryKey(),
    count: integer('count').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('rate_counters_expires').on(t.expiresAt)],
);

/**
 * A human's answer to "did that actually save you anything?"
 *
 * The events themselves are not stored here — they already exist as
 * `agent_events` rows and `environment_checks` rows, and re-recording them would
 * make two sources of truth for the same minute. What did not exist was anywhere
 * to put the only fact the system genuinely cannot observe: whether the warning
 * changed what a person did.
 *
 * That separation is the whole design. "STMA showed a warning" and "the warning
 * saved an hour" are different claims, and a ledger that quietly promotes the
 * first into the second is worth less than no ledger, because the first number
 * anybody checks will be wrong. Same discipline as `agent_runs.quota_source`:
 * measured and claimed are different columns, and only one of them counts.
 */
export const savingConfirmations = pgTable(
  'saving_confirmations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    /** Which kind of event: conflict, duplicate, preflight, handoff. */
    kind: text('kind').notNull(),
    /** The row this confirms — an agent_events id or an environment_checks id. */
    refId: uuid('ref_id').notNull(),
    runId: uuid('run_id').references(() => agentRuns.id, { onDelete: 'cascade' }),
    confirmedBy: uuid('confirmed_by').references(() => users.id),
    /** Did it help at all? A "no" is worth as much as a "yes" and is kept. */
    helpful: boolean('helpful').notNull(),
    /** Did it change what you did? Helpful-but-ignored is not a saving. */
    changedBehaviour: boolean('changed_behaviour').notNull().default(false),
    /** Rework the person says it avoided. Null means they declined to estimate. */
    minutesSaved: integer('minutes_saved'),
    /** Whether an agent actually stopped spending because of it. */
    spendStopped: boolean('spend_stopped').notNull().default(false),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One answer per event. A second visit to the page edits the first rather
    // than adding to the total, or the ledger inflates every time somebody
    // refreshes it.
    uniqueIndex('saving_confirmations_ref_idx').on(t.kind, t.refId),
    index('saving_confirmations_team_idx').on(t.teamId, t.createdAt),
  ],
);
