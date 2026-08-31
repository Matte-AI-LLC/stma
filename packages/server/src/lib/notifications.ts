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
 * - **Own actions** — the actor is removed from the recipient list at enqueue time.
 *
 * Sending is best-effort throughout: every entry point swallows its own failures,
 * because a notification is the least important thing happening in the request that
 * triggered it.
 */
import {
  and,
  asc,
  count,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lte,
  ne,
  or,
} from 'drizzle-orm';
import type { Db } from '../db';
import {
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
import { logLine } from './log';
import { activityEmail, type MailMessage, sendMail } from './mailer';
import { deliverWebhook } from './notify';
import { redactSecrets } from './redact';

// ------------------------------------------------------------------ preferences

export const NOTIFICATION_KINDS = [
  'session_reply',
  'session_resolved',
  'team_joined',
  'announcement',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface NotificationPrefs {
  sessionReply: boolean;
  sessionResolved: boolean;
  teamJoined: boolean;
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
  // Announcements reach every member at once — opt in rather than drown people.
  announcements: false,
  webhookUrl: null,
};

const PREF_OF: Record<NotificationKind, keyof NotificationPrefs> = {
  session_reply: 'sessionReply',
  session_resolved: 'sessionResolved',
  team_joined: 'teamJoined',
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
    .values(requests.map((r) => ({ ...r, notBefore })))
    // The coalescing step. The unique index covers pending rows only, so a second
    // event for a thread this person is already owed an email about is dropped —
    // the pending row's `sinceAt` window already includes it.
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

// -------------------------------------------------------------------- delivery

const HOUR = 60 * 60 * 1000;
/** Rows handled per sweep — a burst is spread over ticks instead of blocking one. */
const BATCH = 100;
/** How many new messages one email looks at. Beyond this the count says "many". */
const MESSAGE_WINDOW = 20;
const EXCERPT = 280;
const TITLE = 90;

type QueueRow = typeof notificationQueue.$inferSelect;
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
  if ((await stillMembers(db, team.id, [row.userId])).length === 0) {
    return { ok: false, reason: 'not_member' };
  }
  return {
    ok: true,
    mail: activityEmail({
      subject: `You are on the ${team.name} team in STMA`,
      lead: `Your account was added to ${team.name}. Your agent can now compare environments with your teammates' machines and answer their debug sessions — point it at the team and it will find the rest.`,
      actionLabel: 'Open the team',
      actionUrl: `${env.baseUrl}/app/teams/${team.slug}`,
      manageUrl: `${env.baseUrl}/app/notifications`,
    }),
    chat: `You were added to the ${team.name} team in STMA — ${env.baseUrl}/app/teams/${team.slug}`,
  };
}

/** One instance at a time per database — the sweep is not re-entrant. */
const sweeping = new Set<Db>();

/**
 * Deliver every queued notification that is due. Returns how many were actually
 * emailed. Exported so tests (and a self-host script) can drive it directly;
 * lib/cleanup runs it on a timer.
 */
export async function flushNotificationsOnce(
  db: Db,
  env: Env,
  now: Date = new Date(),
): Promise<number> {
  if (sweeping.has(db)) return 0;
  sweeping.add(db);
  try {
    const due = await db
      .select()
      .from(notificationQueue)
      .where(and(eq(notificationQueue.status, 'pending'), lte(notificationQueue.notBefore, now)))
      .orderBy(asc(notificationQueue.notBefore))
      .limit(BATCH);
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
      const settle = async (status: string, reason: string | null) => {
        await db
          .update(notificationQueue)
          .set({ status, reason, sentAt: status === 'sent' ? now : null })
          .where(eq(notificationQueue.id, row.id));
        if (status !== 'sent') {
          logLine({ evt: 'notify', a: 'skip', kind: row.kind, why: reason });
        }
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
      let failure = '';
      if (user.email) {
        const result = await sendMail(env, { to: user.email, ...built.mail });
        if (result.ok) arrived = true;
        else failure = result.error.slice(0, 100);
      }
      if (webhookUrl) {
        const posted = await deliverWebhook(
          webhookUrl,
          built.chat,
          env.nodeEnv === 'production',
        );
        if (posted.ok) arrived = true;
        else failure = failure || `webhook: ${posted.error}`;
      }
      if (arrived) {
        budget.set(row.userId, (budget.get(row.userId) ?? 0) + 1);
        delivered += 1;
        await settle('sent', null);
        logLine({
          evt: 'notify',
          a: 'send',
          kind: row.kind,
          u: user.username,
          via: [user.email ? 'mail' : null, webhookUrl ? 'chat' : null].filter(Boolean).join('+'),
        });
      } else {
        // No retry: an hour-old "new reply" is noise, and sendMail already logged why.
        await settle('failed', failure.slice(0, 200));
      }
    }
    return delivered;
  } finally {
    sweeping.delete(db);
  }
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
  if (opts.recipientId === opts.actorId) return;
  await safely('enqueue', async () => {
    const prefs = await notificationPrefsForMany(db, [opts.recipientId]);
    if (!prefs.get(opts.recipientId)?.sessionReply) return;
    await enqueue(db, env, [
      {
        userId: opts.recipientId,
        kind: 'session_reply',
        coalesceKey: `session:${opts.sessionId}`,
        teamId: opts.teamId,
        sessionId: opts.sessionId,
        sinceAt: opts.at,
      },
    ]);
  });
}
