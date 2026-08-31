import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
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
    avatarUrl: text('avatar_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_unique').on(t.email).where(sql`email is not null`)],
);

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
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('projects_team_slug').on(t.teamId, t.slug)],
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tokens = pgTable('tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  /** First characters of the token, for display purposes only. */
  prefix: text('prefix').notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A durable coding-agent installation owned by a human user. */
export const agentInstallations = pgTable(
  'agent_installations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
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
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('agent_installations_user_device_name').on(
      t.userId,
      t.deviceFingerprint,
      t.name,
    ),
  ],
);

export const webSessions = pgTable('web_sessions', {
  id: text('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('work_claims_run_resource').on(
      t.runId,
      t.resourceType,
      t.resourceKey,
      t.access,
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
    /** 'github', 'azure-devops' or 'jira' — one connection of each kind per team. */
    provider: text('provider').notNull().default('github'),
    /**
     * The human-readable locator, whatever "where" means for the provider:
     * github "owner/name", azure-devops "org/project/repo", jira the site host.
     */
    repo: text('repo').notNull(),
    token: text('token').notNull(),
    /** Post a comment on the issue when a run that names it finishes or hands off. */
    commentOnFinish: boolean('comment_on_finish').notNull().default(true),
    /** Provider extras that are not the locator or the secret (jira: { email }). */
    config: jsonb('config'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('team_integrations_team_provider').on(t.teamId, t.provider)],
);

/**
 * A team's delivery flows: the "how work moves here" document, per team or per
 * project. One *active* flow per scope — the domain archives the previous one
 * on save rather than a partial unique index, because Postgres treats NULL
 * project ids as distinct and the team-wide scope is exactly that NULL.
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
  (t) => [index('delivery_flows_team').on(t.teamId, t.status)],
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
    /** Why a row was skipped or failed: read, pref_off, no_email, rate_capped, … */
    reason: text('reason'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** At most one pending email per (user, thread) — coalescing enforced by the database. */
    uniqueIndex('notification_queue_pending')
      .on(t.userId, t.coalesceKey)
      .where(sql`status = 'pending'`),
    index('notification_queue_due').on(t.status, t.notBefore),
    index('notification_queue_user_sent').on(t.userId, t.sentAt),
  ],
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
