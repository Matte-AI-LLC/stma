/**
 * Per-person email notifications.
 *
 * STMA is asynchronous on purpose: an agent asks, a teammate's agent answers hours
 * later. Without this, the answer sits unread — the team webhook (lib/notify) tells
 * a channel that *something* happened, but nothing reaches the person it happened to.
 *
 * Nothing is emailed from a request handler. An event queues a row in
 * `notification_queue` and returns; a sweep decides later whether that row still
 * deserves an email. Everything that makes this bearable lives in that gap:
 *
 * - **Coalescing** — the queue has one pending row per (user, thread), so five
 *   messages inside the debounce window are one email. A folded-in event writes
 *   nothing at all: the pending row already says "everything in this thread since
 *   `sinceAt`", and the sweep recomputes the list when it sends.
 * - **Bounded delay** — `notBefore` is set once, by the first event. A thread that
 *   keeps talking cannot keep deferring its own notification.
 * - **Read state** — a thread the person already read produces no email.
 * - **Rate cap** — at most `NOTIFY_MAX_PER_HOUR` emails per person per rolling hour,
 *   counted from the queue's own `sent` rows. The MCP loop guard lets an agent post
 *   20 messages per session per hour; the mailbox must be quieter than that.
 * - **Database ownership** — a short row lease lets many app processes sweep without
 *   concurrently sending the same notification; an expired handoff lease is recoverable.
 * - **Critical retry** — a directed handoff retries transient delivery failure with
 *   bounded backoff, at most three total attempts. Routine activity remains one-shot.
 * - **Own actions** — the actor is removed from the recipient list at enqueue time.
 *
 * Sending is best-effort throughout: every entry point swallows its own failures,
 * because a notification is the least important thing happening in the request that
 * triggered it.
 */
import { randomUUID } from 'node:crypto';
import {
  and,
  asc,
  count,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import type { Db } from '../db';
import {
  activity,
  debugSessions,
  memberships,
  messages,
  notificationPrefs,
  notificationQueue,
  readState,
  teams,
  users,
} from '../db/schema';
import type { Env } from '../env';
import { effectiveLimits, planName, withEntitlements } from './entitlements';
import { logLine } from './log';
import { humanMembership } from './seats';
import { activityEmail, type MailMessage, sendMail } from './mailer';
import { deliverWebhook } from './notify';
import { redactSecrets } from './redact';
import { notificationAllowed } from './securityHooks';

// ------------------------------------------------------------------ preferences

export const NOTIFICATION_KINDS = [
  'session_reply',
  'session_resolved',
  'team_joined',
  'member_joined',
  'join_refused',
  'announcement',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface NotificationPrefs {
  sessionReply: boolean;
  sessionResolved: boolean;
  teamJoined: boolean;
  /** Somebody joined a workspace you own, or could not because it is full. */
  memberJoined: boolean;
  announcements: boolean;
  /**
   * Personal Slack/Discord webhook. Not a switch — a second delivery route for
   * whatever the switches above already let through, for people who read chat
   * and not mail. Null when unset.
   */
  webhookUrl: string | null;
}

/** What a person who has never opened the preferences page gets. */
export const NOTIFICATION_DEFAULTS: NotificationPrefs = {
  sessionReply: true,
  sessionResolved: true,
  teamJoined: true,
  memberJoined: true,
  // Announcements reach every member at once — opt in rather than drown people.
  announcements: false,
  webhookUrl: null,
};

const PREF_OF: Record<NotificationKind, keyof NotificationPrefs> = {
  session_reply: 'sessionReply',
  session_resolved: 'sessionResolved',
  team_joined: 'teamJoined',
  // One switch for both: they are the same news to the same person, somebody
  // arriving at a workspace they own, and one of them is only that it is full.
  member_joined: 'memberJoined',
  join_refused: 'memberJoined',
  announcement: 'announcements',
};

const isKind = (k: string): k is NotificationKind => k in PREF_OF;

export async function notificationPrefsForMany(
  db: Db,
  userIds: string[],
): Promise<Map<string, NotificationPrefs>> {
  const map = new Map<string, NotificationPrefs>(
    userIds.map((id) => [id, { ...NOTIFICATION_DEFAULTS }]),
  );
  if (userIds.length === 0) return map;
  const rows = await db
    .select()
    .from(notificationPrefs)
    .where(inArray(notificationPrefs.userId, userIds));
  for (const r of rows) {
    map.set(r.userId, {
      sessionReply: r.sessionReply,
      sessionResolved: r.sessionResolved,
      teamJoined: r.teamJoined,
      memberJoined: r.memberJoined,
      announcements: r.announcements,
      webhookUrl: r.webhookUrl,
    });
  }
  return map;
}

export async function notificationPrefsFor(db: Db, userId: string): Promise<NotificationPrefs> {
  return (await notificationPrefsForMany(db, [userId])).get(userId)!;
}

export async function saveNotificationPrefs(
  db: Db,
  userId: string,
  prefs: NotificationPrefs,
): Promise<void> {
  const now = new Date();
  await db
    .insert(notificationPrefs)
    .values({ userId, ...prefs, updatedAt: now })
    .onConflictDoUpdate({
      target: notificationPrefs.userId,
      set: { ...prefs, updatedAt: now },
    });
}

// ----------------------------------------------------------------- enqueueing

interface QueueRequest {
  userId: string;
  kind: NotificationKind;
  coalesceKey: string;
  teamId: string | null;
  sessionId: string | null;
  sinceAt: Date;
  /** Only directed handoffs retry after a transient delivery failure. */
  critical?: boolean;
}

/** Never throws — callers are request handlers with real work to finish. */
async function safely(what: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    console.warn(`[stma] notification ${what} failed:`, err instanceof Error ? err.message : err);
  }
}

async function enqueue(db: Db, env: Env, requests: QueueRequest[]): Promise<void> {
  if (requests.length === 0) return;
  const notBefore = new Date(Date.now() + Math.max(0, env.notifyDebounceSeconds) * 1000);
  await db
    .insert(notificationQueue)
    .values(requests.map((r) => ({ ...r, critical: r.critical ?? false, notBefore })))
    // The coalescing step. The unique index covers queued and currently claimed
    // rows, so a second event for a thread this person is already owed an email
    // about is dropped — the row's `sinceAt` window already includes it.
    .onConflictDoNothing();
}

/** Of these people, the ones still on the team. */
async function stillMembers(db: Db, teamId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.teamId, teamId), inArray(memberships.userId, ids)));
  return rows.map((r) => r.userId);
}

/** Everyone who opened the thread or posted in it — minus the actor and ex-members. */
async function threadParticipants(
  db: Db,
  opts: { sessionId: string; teamId: string; actorId: string | null; openedBy: string | null },
): Promise<string[]> {
  const authors = await db
    .selectDistinct({ id: messages.authorId })
    .from(messages)
    .where(eq(messages.sessionId, opts.sessionId));
  const ids = new Set<string>();
  if (opts.openedBy) ids.add(opts.openedBy);
  for (const a of authors) if (a.id) ids.add(a.id);
  if (opts.actorId) ids.delete(opts.actorId);
  return stillMembers(db, opts.teamId, [...ids]);
}

/** Everyone on the team — minus the actor. */
async function teamAudience(db: Db, teamId: string, actorId: string | null): Promise<string[]> {
  const rows = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(eq(memberships.teamId, teamId));
  return rows.map((r) => r.userId).filter((id) => id !== actorId);
}

interface SessionEvent {
  sessionId: string;
  teamId: string;
  actorId: string | null;
  kind: NotificationKind;
  at: Date;
}

async function queueSessionEvent(db: Db, env: Env, opts: SessionEvent): Promise<void> {
  const rows = await db
    .select({ kind: debugSessions.kind, openedBy: debugSessions.openedBy })
    .from(debugSessions)
    .where(eq(debugSessions.id, opts.sessionId))
    .limit(1);
  const session = rows[0];
  if (!session) return;
  // The announcements channel is a broadcast, not a thread. Whatever tool wrote
  // into it, the announcements switch is the one that governs the email.
  const kind: NotificationKind = session.kind === 'announcements' ? 'announcement' : opts.kind;
  const audience =
    kind === 'announcement'
      ? await teamAudience(db, opts.teamId, opts.actorId)
      : await threadParticipants(db, { ...opts, openedBy: session.openedBy });
  const prefs = await notificationPrefsForMany(db, audience);
  await enqueue(
    db,
    env,
    audience
      .filter((id) => prefs.get(id)?.[PREF_OF[kind]])
      .map((userId) => ({
        userId,
        kind,
        coalesceKey: `session:${opts.sessionId}`,
        teamId: opts.teamId,
        sessionId: opts.sessionId,
        sinceAt: opts.at,
      })),
  );
}

/**
 * A message landed in a thread, or a thread was resolved: everyone who opened it or
 * posted in it hears about it. Never the person who did it.
 *
 * `at` is the stored `created_at` of the message that triggered this, so the window
 * starts exactly at that message and never reaches back over older ones.
 */
export async function notifySessionActivity(
  db: Db,
  env: Env,
  opts: {
    sessionId: string;
    teamId: string;
    actorId: string | null;
    kind: 'session_reply' | 'session_resolved';
    at: Date;
  },
): Promise<void> {
  await safely('enqueue', () => queueSessionEvent(db, env, opts));
}

/** A team-wide announcement. Off by default — this one is opt-in per person. */
export async function notifyAnnouncement(
  db: Db,
  env: Env,
  opts: { sessionId: string; teamId: string; actorId: string | null; at: Date },
): Promise<void> {
  await safely('enqueue', () => queueSessionEvent(db, env, { ...opts, kind: 'announcement' }));
}

/**
 * Someone's account was added to a team — including when they redeemed the invite
 * themselves from a terminal, where nothing else tells the human it worked.
 */
export async function notifyTeamJoined(
  db: Db,
  env: Env,
  opts: { teamId: string; userId: string },
): Promise<void> {
  await safely('enqueue', async () => {
    const prefs = await notificationPrefsFor(db, opts.userId);
    if (!prefs.teamJoined) return;
    await enqueue(db, env, [
      {
        userId: opts.userId,
        kind: 'team_joined',
        coalesceKey: `team:${opts.teamId}`,
        teamId: opts.teamId,
        sessionId: null,
        sinceAt: new Date(),
      },
    ]);
  });
}

/** The workspace's owners, minus whoever did it. */
async function teamOwners(db: Db, teamId: string, actorId: string | null): Promise<string[]> {
  const rows = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.teamId, teamId), eq(memberships.role, 'owner')));
  return rows.map((r) => r.userId).filter((id) => id !== actorId);
}

/**
 * The window a membership notification covers. A minute of slack, because the
 * membership row is stamped by the database's clock and this by the process's,
 * and the email lists everybody who arrived inside it.
 */
const JOIN_WINDOW_SLACK_MS = 60_000;

async function queueOwnerEvent(
  db: Db,
  env: Env,
  opts: { teamId: string; userId: string; kind: 'member_joined' | 'join_refused' },
): Promise<void> {
  const owners = await teamOwners(db, opts.teamId, opts.userId);
  const prefs = await notificationPrefsForMany(db, owners);
  const sinceAt = new Date(Date.now() - JOIN_WINDOW_SLACK_MS);
  await enqueue(
    db,
    env,
    owners
      .filter((id) => prefs.get(id)?.memberJoined)
      .map((userId) => ({
        userId,
        kind: opts.kind,
        // A burst of people accepting on the same morning is one email.
        coalesceKey: `${opts.kind === 'member_joined' ? 'members' : 'refused'}:${opts.teamId}`,
        teamId: opts.teamId,
        sessionId: null,
        sinceAt,
      })),
  );
}

/**
 * Somebody joined a workspace: its owners hear about it.
 *
 * Until 2026-09-24 the only email a join produced went to the person joining,
 * so an owner learned who had come in from the activity feed, if they looked.
 * On a paid Team every join is also a seat on their bill, and they are the one
 * person who can undo a link that went further than they meant.
 */
export async function notifyMemberJoined(
  db: Db,
  env: Env,
  opts: { teamId: string; userId: string },
): Promise<void> {
  await safely('enqueue', () => queueOwnerEvent(db, env, { ...opts, kind: 'member_joined' }));
}

/**
 * Somebody accepted an invitation to a workspace that is at its plan's member
 * limit. The refusal is on their screen, but they cannot fix it: the owner can,
 * and before this the owner never found out it had happened.
 */
export async function notifyJoinRefused(
  db: Db,
  env: Env,
  opts: { teamId: string; userId: string },
): Promise<void> {
  await safely('enqueue', () => queueOwnerEvent(db, env, { ...opts, kind: 'join_refused' }));
}

// -------------------------------------------------------------------- delivery

const HOUR = 60 * 60 * 1000;
/** Rows handled per sweep — a burst is spread over ticks instead of blocking one. */
const BATCH = 100;
/** Longer than the two sequential transport timeouts (10s mail + 5s webhook). */
const DELIVERY_LEASE_MS = 60_000;
const CRITICAL_MAX_ATTEMPTS = 3;
const CRITICAL_RETRY_BASE_MS = 30_000;
/** How many new messages one email looks at. Beyond this the count says "many". */
const MESSAGE_WINDOW = 20;
const EXCERPT = 280;
const TITLE = 90;

type QueueRow = typeof notificationQueue.$inferSelect;

const leaseExpired = (now: Date) =>
  or(isNull(notificationQueue.leaseUntil), lte(notificationQueue.leaseUntil, now));

const hasAttemptsLeft = () =>
  or(
    and(eq(notificationQueue.critical, true), lt(notificationQueue.attempts, CRITICAL_MAX_ATTEMPTS)),
    and(eq(notificationQueue.critical, false), lt(notificationQueue.attempts, 1)),
  );

/**
 * Claim a bounded due batch in one transaction. `skip locked` lets another
 * process take different rows while guaranteeing that it cannot send these.
 * A crashed critical delivery becomes eligible after its lease; routine rows
 * remain single-attempt and are terminalised instead of being sent twice.
 */
async function claimDueNotifications(
  db: Db,
  now: Date,
  leaseOwner: string,
): Promise<QueueRow[]> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;

    // A routine notification is deliberately single-attempt. Critical rows also
    // stop after the third claimed attempt, including attempts whose worker died.
    await tx
      .update(notificationQueue)
      .set({
        status: 'failed',
        reason: sql<string>`coalesce(${notificationQueue.reason}, 'delivery_lease_expired_after_final_attempt')`,
        leaseOwner: null,
        leaseUntil: null,
      })
      .where(
        and(
          eq(notificationQueue.status, 'sending'),
          leaseExpired(now),
          or(
            and(eq(notificationQueue.critical, true), gte(notificationQueue.attempts, CRITICAL_MAX_ATTEMPTS)),
            and(eq(notificationQueue.critical, false), gte(notificationQueue.attempts, 1)),
          ),
        ),
      );

    const candidates = await tx
      .select({ id: notificationQueue.id })
      .from(notificationQueue)
      .where(
        and(
          lte(notificationQueue.notBefore, now),
          hasAttemptsLeft(),
          or(
            eq(notificationQueue.status, 'pending'),
            and(eq(notificationQueue.status, 'sending'), leaseExpired(now)),
          ),
        ),
      )
      .orderBy(asc(notificationQueue.notBefore), asc(notificationQueue.createdAt))
      .limit(BATCH)
      .for('update', { skipLocked: true });
    if (candidates.length === 0) return [];

    return tx
      .update(notificationQueue)
      .set({
        status: 'sending',
        attempts: sql<number>`${notificationQueue.attempts} + 1`,
        leaseOwner,
        leaseUntil: new Date(now.getTime() + DELIVERY_LEASE_MS),
        reason: sql<string | null>`case
          when ${notificationQueue.status} = 'sending'
            then coalesce(${notificationQueue.reason}, 'delivery_lease_expired_retrying')
          else ${notificationQueue.reason}
        end`,
      })
      .where(inArray(notificationQueue.id, candidates.map((candidate) => candidate.id)))
      .returning();
  });
}

/**
 * One notification, rendered for both routes it can take. `chat` is the same
 * news in one line — a chat client shows no subject and no button, so the link
 * has to be in the sentence.
 */
type Built =
  | { ok: true; mail: Omit<MailMessage, 'to'>; chat: string }
  | { ok: false; reason: string };

/** One line, no control characters, bounded — peer text never gets to sprawl. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const article = (word: string): string => (/^[aeiou]/i.test(word) ? 'an' : 'a');

/** "alice", or "claude-code · alice" when an agent posted for them. */
function attribution(username: string | null | undefined, via: string | null): string {
  const who = username ?? 'a teammate';
  return via ? `${via} · ${who}` : who;
}

async function buildSessionEmail(db: Db, env: Env, row: QueueRow, kind: NotificationKind): Promise<Built> {
  if (!row.sessionId) return { ok: false, reason: 'no_session' };
  const found = await db
    .select({ session: debugSessions, team: teams })
    .from(debugSessions)
    .innerJoin(teams, eq(debugSessions.teamId, teams.id))
    .where(eq(debugSessions.id, row.sessionId))
    .limit(1);
  const hit = found[0];
  if (!hit) return { ok: false, reason: 'gone' };
  if (!(await notificationAllowed(db,{userId:row.userId,teamId:hit.team.id,projectId:hit.session.projectId}))) return {ok:false,reason:'scope_unavailable'};
  if ((await stillMembers(db, hit.team.id, [row.userId])).length === 0) {
    return { ok: false, reason: 'not_member' };
  }

  const read = await db
    .select({ at: readState.lastReadAt })
    .from(readState)
    .where(and(eq(readState.userId, row.userId), eq(readState.sessionId, row.sessionId)))
    .limit(1);
  const lastRead = read[0]?.at ?? null;

  // What this person has not seen yet: posted by someone else, inside the window,
  // and after whatever they last read. Reading the thread cancels the email.
  const fresh = await db
    .select({ m: messages, author: users })
    .from(messages)
    .leftJoin(users, eq(messages.authorId, users.id))
    .where(
      and(
        eq(messages.sessionId, row.sessionId),
        gte(messages.createdAt, row.sinceAt),
        or(isNull(messages.authorId), ne(messages.authorId, row.userId)),
        lastRead ? gt(messages.createdAt, lastRead) : undefined,
      ),
    )
    .orderBy(asc(messages.createdAt))
    .limit(MESSAGE_WINDOW);
  if (fresh.length === 0) return { ok: false, reason: lastRead ? 'read' : 'nothing_new' };

  const latest = fresh[fresh.length - 1]!;
  const who = attribution(latest.author?.username, latest.m.via);
  const title = oneLine(hit.session.title, TITLE);
  const n = fresh.length;
  const many = n === MESSAGE_WINDOW ? `${n}+` : String(n);

  let subject: string;
  let lead: string;
  if (kind === 'session_resolved') {
    subject = `Resolved: "${title}"`;
    lead = `${who} resolved "${title}" in ${hit.team.name}. The root cause and the fix are in the thread, and searchable from now on.`;
  } else if (kind === 'announcement') {
    subject = n === 1 ? `Announcement in ${hit.team.name}` : `${many} announcements in ${hit.team.name}`;
    lead =
      n === 1
        ? `${who} announced something to ${hit.team.name}.`
        : `${many} new announcements in ${hit.team.name}.`;
  } else {
    subject = n === 1 ? `New reply in "${title}"` : `${many} new messages in "${title}"`;
    lead =
      n === 1
        ? `${who} posted ${article(latest.m.kind)} ${latest.m.kind} in "${title}" (${hit.team.name}).`
        : `${many} new messages in "${title}" (${hit.team.name}). The last one is from ${who}.`;
  }

  return {
    ok: true,
    mail: activityEmail({
      subject,
      lead,
      quote: { who, text: oneLine(redactSecrets(latest.m.body), EXCERPT) },
      actionLabel: 'Open the thread',
      actionUrl: `${env.baseUrl}/app/sessions/${row.sessionId}`,
      manageUrl: `${env.baseUrl}/app/notifications`,
    }),
    chat: `${lead} ${env.baseUrl}/app/sessions/${row.sessionId}`,
  };
}

async function buildTeamJoinedEmail(db: Db, env: Env, row: QueueRow): Promise<Built> {
  if (!row.teamId) return { ok: false, reason: 'no_team' };
  const found = await db.select().from(teams).where(eq(teams.id, row.teamId)).limit(1);
  const team = found[0];
  if (!team) return { ok: false, reason: 'gone' };
  if (!(await notificationAllowed(db,{userId:row.userId,teamId:team.id,projectId:null}))) return {ok:false,reason:'scope_unavailable'};
  if ((await stillMembers(db, team.id, [row.userId])).length === 0) {
    return { ok: false, reason: 'not_member' };
  }
  return {
    ok: true,
    mail: activityEmail({
      subject: `You joined ${team.name} in STMA`,
      lead: `Your account was added to the workspace ${team.name}. Connect your own agents to it from Agent connections: each one gets its own connection, and your agents and machines never take a seat.`,
      actionLabel: 'Open the workspace',
      actionUrl: `${env.baseUrl}/app/teams/${team.slug}`,
      manageUrl: `${env.baseUrl}/app/notifications`,
    }),
    chat: `You were added to the workspace ${team.name} in STMA: ${env.baseUrl}/app/teams/${team.slug}`,
  };
}

/** Still an owner of the workspace when the email goes out, or it goes to nobody. */
async function stillOwner(db: Db, teamId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.teamId, teamId), eq(memberships.userId, userId)))
    .limit(1);
  return rows[0]?.role === 'owner';
}

/** "ada", "ada and bo", "ada, bo and cy". */
function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

async function buildMemberJoinedEmail(db: Db, env: Env, row: QueueRow): Promise<Built> {
  if (!row.teamId) return { ok: false, reason: 'no_team' };
  const [team] = await db.select().from(teams).where(eq(teams.id, row.teamId)).limit(1);
  if (!team) return { ok: false, reason: 'gone' };
  if (!(await notificationAllowed(db, { userId: row.userId, teamId: team.id, projectId: null }))) {
    return { ok: false, reason: 'scope_unavailable' };
  }
  if (!(await stillOwner(db, team.id, row.userId))) return { ok: false, reason: 'not_owner' };
  // Who is in the workspace now and arrived inside the window: somebody who
  // joined and left again before this went out is not news any more.
  const arrived = await db
    .select({ username: users.username, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(
      and(
        eq(memberships.teamId, team.id),
        gte(memberships.createdAt, row.sinceAt),
        ne(memberships.userId, row.userId),
        humanMembership(),
      ),
    )
    .orderBy(asc(memberships.createdAt))
    .limit(MESSAGE_WINDOW);
  if (arrived.length === 0) return { ok: false, reason: 'nothing_new' };
  const url = `${env.baseUrl}/app/teams/${team.slug}?tab=people`;
  const first = arrived[0]!;
  const lead =
    arrived.length === 1
      ? `${first.username} joined your workspace ${team.name} as ${first.role === 'owner' ? 'an owner' : 'a member'}.`
      : `${arrived.length} people joined your workspace ${team.name}: ${nameList(arrived.map((a) => a.username))}.`;
  return {
    ok: true,
    mail: activityEmail({
      subject:
        arrived.length === 1 ? `${first.username} joined ${team.name}` : `${arrived.length} people joined ${team.name}`,
      lead: `${lead} You can change a role or remove somebody from Members and invites.`,
      actionLabel: 'Open Members and invites',
      actionUrl: url,
      manageUrl: `${env.baseUrl}/app/notifications`,
    }),
    chat: `${lead} ${url}`,
  };
}

async function buildJoinRefusedEmail(db: Db, env: Env, row: QueueRow): Promise<Built> {
  if (!row.teamId) return { ok: false, reason: 'no_team' };
  const [team] = await db.select().from(teams).where(eq(teams.id, row.teamId)).limit(1);
  if (!team) return { ok: false, reason: 'gone' };
  if (!(await notificationAllowed(db, { userId: row.userId, teamId: team.id, projectId: null }))) {
    return { ok: false, reason: 'scope_unavailable' };
  }
  if (!(await stillOwner(db, team.id, row.userId))) return { ok: false, reason: 'not_owner' };
  // Read at send time: an owner who moved to a bigger plan inside the window
  // has already answered this, and a mail saying the workspace is full would
  // be wrong by the time it arrived. The sweep runs outside any request, so
  // the metering this server was started with is passed in rather than read
  // from a module value another server in the same process could have set.
  const limit = (
    await withEntitlements(undefined, () => effectiveLimits(db, team, env.hosted), env.hosted, env.betaUnmetered)
  ).maxMembers;
  const [held] = await db
    .select({ n: count() })
    .from(memberships)
    .where(and(eq(memberships.teamId, team.id), humanMembership()));
  if ((held?.n ?? 0) < limit) return { ok: false, reason: 'room_now' };
  const tried = await db
    .selectDistinct({ username: users.username })
    .from(activity)
    .innerJoin(users, eq(activity.userId, users.id))
    .where(
      and(
        eq(activity.teamId, team.id),
        eq(activity.action, 'join_refused'),
        gte(activity.createdAt, row.sinceAt),
      ),
    )
    .limit(MESSAGE_WINDOW);
  const who = tried.length ? nameList(tried.map((t) => t.username)) : 'Somebody';
  const people = limit === 1 ? '1 person' : `${limit} people`;
  const lead = `${who} tried to join your workspace ${team.name} with an invitation, but it already has the ${people} its ${planName(team.plan)} plan allows. Nobody was added.`;
  const url = `${env.baseUrl}/app/teams/${team.slug}?tab=people`;
  return {
    ok: true,
    mail: activityEmail({
      subject: `${team.name} is full`,
      lead: `${lead} To let them in, move the workspace to a plan with room for more people, or remove somebody.`,
      actionLabel: 'Open Members and invites',
      actionUrl: url,
      manageUrl: `${env.baseUrl}/app/notifications`,
    }),
    chat: `${lead} ${url}`,
  };
}

/**
 * Deliver every queued notification that is due. Returns how many were actually
 * emailed. Exported so tests (and a self-host script) can drive it directly;
 * lib/cleanup runs it on a timer. Ownership lives in the database, so multiple
 * app processes may sweep without delivering the same row concurrently.
 */
export async function flushNotificationsOnce(
  db: Db,
  env: Env,
  now: Date = new Date(),
): Promise<number> {
    const leaseOwner = randomUUID();
    const due = await claimDueNotifications(db, now, leaseOwner);
    if (due.length === 0) return 0;

    const userIds = [...new Set(due.map((r) => r.userId))];
    const people = new Map(
      (await db.select().from(users).where(inArray(users.id, userIds))).map((u) => [u.id, u]),
    );
    const prefs = await notificationPrefsForMany(db, userIds);

    // The rate cap reads its own history: rows this person actually received in
    // the last hour. Kept accurate in memory as we go, so one sweep cannot exceed it.
    const budget = new Map<string, number>(userIds.map((id) => [id, 0]));
    for (const r of await db
      .select({ userId: notificationQueue.userId, n: count() })
      .from(notificationQueue)
      .where(
        and(
          inArray(notificationQueue.userId, userIds),
          eq(notificationQueue.status, 'sent'),
          gte(notificationQueue.sentAt, new Date(now.getTime() - HOUR)),
        ),
      )
      .groupBy(notificationQueue.userId)) {
      budget.set(r.userId, r.n);
    }

    let delivered = 0;
    for (const row of due) {
      const settle = async (
        status: 'pending' | 'sent' | 'skipped' | 'failed',
        reason: string | null,
        retryAt?: Date,
      ) => {
        const settled = await db
          .update(notificationQueue)
          .set({
            status,
            reason,
            sentAt: status === 'sent' ? now : null,
            notBefore: retryAt ?? row.notBefore,
            leaseOwner: null,
            leaseUntil: null,
          })
          .where(
            and(
              eq(notificationQueue.id, row.id),
              eq(notificationQueue.status, 'sending'),
              eq(notificationQueue.leaseOwner, leaseOwner),
            ),
          )
          .returning({ id: notificationQueue.id });
        if (settled.length === 0) {
          logLine({ evt: 'notify', a: 'lease_lost', kind: row.kind });
          return false;
        }
        if (status !== 'sent' && status !== 'pending') {
          logLine({ evt: 'notify', a: 'skip', kind: row.kind, why: reason });
        }
        return true;
      };
      const user = people.get(row.userId);
      if (!user) {
        await settle('skipped', 'no_user');
        continue;
      }
      const webhookUrl = prefs.get(row.userId)?.webhookUrl ?? null;
      // An account with neither an address (dev/OAuth logins predate email
      // identity) nor a personal webhook simply has nowhere to be notified.
      // Not an error.
      if (!user.email && !webhookUrl) {
        await settle('skipped', 'no_destination');
        continue;
      }
      if (!isKind(row.kind)) {
        await settle('skipped', 'unknown_kind');
        continue;
      }
      // Re-checked here as well as at enqueue: preferences can change during the
      // debounce, and the later answer is the one that counts.
      if (!prefs.get(row.userId)?.[PREF_OF[row.kind]]) {
        await settle('skipped', 'pref_off');
        continue;
      }
      const built =
        row.kind === 'team_joined'
          ? await buildTeamJoinedEmail(db, env, row)
          : row.kind === 'member_joined'
            ? await buildMemberJoinedEmail(db, env, row)
            : row.kind === 'join_refused'
              ? await buildJoinRefusedEmail(db, env, row)
              : await buildSessionEmail(db, env, row, row.kind);
      if (!built.ok) {
        await settle('skipped', built.reason);
        continue;
      }
      if ((budget.get(row.userId) ?? 0) >= env.notifyMaxPerHour) {
        // Dropped rather than deferred: a backlog released an hour later is the
        // mailbombing this cap exists to prevent. The unread counts stay in the app.
        await settle('skipped', 'rate_capped');
        continue;
      }
      // Both routes are attempted; one arriving is a delivered notification.
      // A person who reads chat and never opened their mail still hears about
      // the reply, and a broken webhook does not suppress the email.
      let arrived = false;
      const failures: string[] = [];
      if (user.email) {
        const result = await sendMail(env, { to: user.email, ...built.mail });
        if (result.ok) arrived = true;
        else failures.push(`mail: ${result.error.slice(0, 100)}`);
      }
      if (webhookUrl) {
        const posted = await deliverWebhook(
          webhookUrl,
          built.chat,
          env.nodeEnv === 'production',
        );
        if (posted.ok) arrived = true;
        else failures.push(`webhook: ${posted.error}`);
      }
      if (arrived) {
        if (await settle('sent', null)) {
          budget.set(row.userId, (budget.get(row.userId) ?? 0) + 1);
          delivered += 1;
          logLine({
            evt: 'notify',
            a: 'send',
            kind: row.kind,
            u: user.username,
            via: [user.email ? 'mail' : null, webhookUrl ? 'chat' : null].filter(Boolean).join('+'),
          });
        }
      } else {
        const failure = (failures.join('; ') || 'delivery_failed').slice(0, 160);
        if (row.critical && row.attempts < CRITICAL_MAX_ATTEMPTS) {
          const retryAt = new Date(
            now.getTime() + CRITICAL_RETRY_BASE_MS * 2 ** Math.max(0, row.attempts - 1),
          );
          await settle(
            'pending',
            `attempt_${row.attempts}_failed: ${failure}`.slice(0, 200),
            retryAt,
          );
          logLine({
            evt: 'notify',
            a: 'retry',
            kind: row.kind,
            attempt: row.attempts,
            why: failure,
          });
        } else {
          // Routine activity is intentionally single-attempt. A directed
          // handoff reaches this branch only after its third failed attempt.
          await settle(
            'failed',
            `${row.critical ? `attempt_${row.attempts}_failed: ` : ''}${failure}`.slice(0, 200),
          );
        }
      }
    }
    return delivered;
}

/**
 * Work was handed to one named person.
 *
 * A handoff is the first message in a thread nobody else is in yet, so the
 * ordinary thread-participant rule reaches nobody — the only participant is the
 * person who wrote it, and they are always excluded. This one addresses the
 * recipient directly, because "your work is waiting" is the whole point and an
 * agent that only checks its inbox when it next runs may not run until tomorrow.
 *
 * It rides the session-reply preference rather than adding a switch: somebody
 * who turned session email off asked for fewer session emails, and a handoff
 * offered to the whole team stays out of the mail entirely — that is what the
 * inbox is for.
 */
export async function notifyHandoff(
  db: Db,
  env: Env,
  opts: { sessionId: string; teamId: string; recipientId: string; actorId: string | null; at: Date },
): Promise<void> {
  await safely('enqueue', () => queueHandoffNotification(db, env, opts));
}

/** Transactional callers need failures to roll back, not a swallowed error. */
export async function queueHandoffNotification(
  db: Db,
  env: Env,
  opts: { sessionId: string; teamId: string; recipientId: string; actorId: string | null; at: Date },
): Promise<void> {
  if (opts.recipientId === opts.actorId) return;
  const prefs = await notificationPrefsForMany(db, [opts.recipientId]);
  if (!prefs.get(opts.recipientId)?.sessionReply) return;
  const coalesceKey = `session:${opts.sessionId}`;
  await enqueue(db, env, [
    {
      userId: opts.recipientId,
      kind: 'session_reply',
      coalesceKey,
      teamId: opts.teamId,
      sessionId: opts.sessionId,
      sinceAt: opts.at,
      critical: true,
    },
  ]);
  // If a routine reply was already waiting for this same recipient/thread, the
  // insert coalesced into it. Promote that row so the directed handoff does not
  // silently lose its retry contract.
  await db
    .update(notificationQueue)
    .set({ critical: true })
    .where(
      and(
        eq(notificationQueue.userId, opts.recipientId),
        eq(notificationQueue.coalesceKey, coalesceKey),
        or(eq(notificationQueue.status, 'pending'), eq(notificationQueue.status, 'sending')),
      ),
    );
}
