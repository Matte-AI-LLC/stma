import { Hono } from 'hono';
import { loginRedirect } from '../auth/session';
import { mailTransport } from '../lib/mailer';
import {
  notificationPrefsFor,
  saveNotificationPrefs,
  type NotificationPrefs,
} from '../lib/notifications';
import { deliverWebhook, isSafeWebhookUrl } from '../lib/notify';
import type { AppEnv, User } from '../types';
import { AppLayout } from '../ui/Layout';

export const notificationsRoutes = new Hono<AppEnv>();

const Banner = ({ kind, text }: { kind: 'error' | 'success'; text: string }) => (
  <div class={`banner banner-${kind}`}>
    <span class="ic">{kind === 'error' ? '!' : '✓'}</span>
    <span>{text}</span>
    <button class="x" type="button" data-dismiss="t">
      ×
    </button>
  </div>
);

/** The preferences that are on/off; the webhook is a destination, not a switch. */
type PrefSwitch = Exclude<keyof NotificationPrefs, 'webhookUrl'>;

/** One switch, in the order a person meets these events. */
const SWITCHES: { field: PrefSwitch; name: string; label: string; note: string }[] = [
  {
    field: 'sessionReply',
    name: 'session_reply',
    label: 'Replies in my threads',
    note: 'A teammate or their agent posts in a session you opened or already answered in.',
  },
  {
    field: 'sessionResolved',
    name: 'session_resolved',
    label: 'A thread I am in gets resolved',
    note: 'Someone recorded the root cause and the fix — usually the answer you were waiting for.',
  },
  {
    field: 'teamJoined',
    name: 'team_joined',
    label: 'I am added to a team',
    note: 'Confirms the invite landed, including when your agent redeemed it from a terminal.',
  },
  {
    field: 'announcements',
    name: 'announcements',
    label: 'Team announcements',
    note: 'Every broadcast to the whole team. Off by default — busy teams announce a lot.',
  },
];

const NotificationsPage = (props: {
  user: User;
  prefs: NotificationPrefs;
  canSend: boolean;
  maxPerHour: number;
  notice?: string;
  error?: string;
}) => {
  const { user, prefs, canSend, maxPerHour, notice, error } = props;
  return (
    <AppLayout user={user} active="tokens" title="Notifications">
      {notice ? <Banner kind="success" text={notice} /> : null}
      {error ? <Banner kind="error" text={error} /> : null}
      <div class="page-head">
        <div>
          <h1 class="title">Notifications</h1>
          <p class="sub">
            STMA answers asynchronously — your teammate's agent replies the next time it runs. These
            are what tell you it happened, by email or in your chat client.
          </p>
        </div>
      </div>

      {user.email || prefs.webhookUrl ? null : (
        <div class="banner banner-warn">
          <span class="ic">!</span>
          <span>
            This account has no email address and no personal webhook, so nothing can be sent. Add a
            webhook below, or ask an operator to set an address.
          </span>
        </div>
      )}
      {canSend ? null : (
        <div class="banner banner-warn">
          <span class="ic">!</span>
          <span>
            This instance has no mail provider configured (RESEND_API_KEY is unset), so notification
            emails are recorded and dropped. Your choices below are saved and will apply the moment
            a provider is set up.
          </span>
        </div>
      )}

      <form method="post" action="/app/notifications" class="m0">
        <div class="card card-pad" style="display:flex;flex-direction:column;gap:14px">
          <div>
            <div class="card-title">Tell me when…</div>
            <div class="card-note">
              {user.email && prefs.webhookUrl ? (
                <>
                  Sent to <b>{user.email}</b> and to your personal webhook.
                </>
              ) : user.email ? (
                <>
                  Sent to <b>{user.email}</b>.
                </>
              ) : prefs.webhookUrl ? (
                <>
                  Sent to <b>your personal webhook</b> — this account has no email address.
                </>
              ) : (
                <>
                  <b>Nowhere to send these yet</b> — this account has no email address and no
                  personal webhook.
                </>
              )}{' '}
              Never for your own actions, never for a thread you have already read, and never more
              than {maxPerHour} an hour — a runaway agent cannot fill your inbox.
            </div>
          </div>
          {SWITCHES.map((s) => (
            <label class="checkrow">
              <input type="checkbox" name={s.name} value="on" checked={prefs[s.field]} />
              <span>
                <span class="checkrow-label">{s.label}</span>
                <span class="checkrow-note">{s.note}</span>
              </span>
            </label>
          ))}
          <button class="btn btn-primary" type="submit" style="align-self:flex-start">
            Save preferences
          </button>
        </div>
      </form>

      <form method="post" action="/app/notifications/webhook" class="m0">
        <div class="card card-pad" style="display:flex;flex-direction:column;gap:12px">
          <div>
            <div class="card-title">Send it to my chat instead — or as well</div>
            <div class="card-note">
              A Slack or Discord incoming webhook that is yours, not the team's. It receives exactly
              what the switches above let through, as one line with a link. The team webhook on the
              team page is the channel-level feed of everything; this one is only your events.
            </div>
          </div>
          <input
            class="in"
            type="url"
            name="webhook_url"
            aria-label="Your personal Slack or Discord webhook URL"
            placeholder="https://hooks.slack.com/services/… or https://discord.com/api/webhooks/…"
            value={prefs.webhookUrl ?? ''}
          />
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-primary" type="submit" name="action" value="save">
              Save webhook
            </button>
            <button class="btn" type="submit" name="action" value="test">
              Send a test
            </button>
            {prefs.webhookUrl ? (
              <button class="btn" type="submit" name="action" value="remove">
                Remove
              </button>
            ) : null}
          </div>
        </div>
      </form>

      <div class="card card-pad">
        <div class="card-title">What is deliberately not notified</div>
        <div class="card-note">
          Snapshots, agent heartbeats, environment checks and new sessions you are not part of stay
          in the app and the activity feed. A team owner can point a Slack or Discord webhook at the
          team page for a channel-level feed of everything.
        </div>
      </div>
    </AppLayout>
  );
};

notificationsRoutes.get('/app/notifications', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const env = c.get('env');
  return c.html(
    <NotificationsPage
      user={user}
      prefs={await notificationPrefsFor(c.get('db'), user.id)}
      canSend={mailTransport(env) === 'resend'}
      maxPerHour={env.notifyMaxPerHour}
      notice={c.req.query('ok')}
      error={c.req.query('err')}
    />,
  );
});

notificationsRoutes.post('/app/notifications', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const body = await c.req.parseBody();
  // An unchecked box submits nothing at all, so presence is the whole answer.
  const on = (name: string) => typeof body[name] === 'string' && body[name] !== '';
  const current = await notificationPrefsFor(c.get('db'), user.id);
  await saveNotificationPrefs(c.get('db'), user.id, {
    sessionReply: on('session_reply'),
    sessionResolved: on('session_resolved'),
    teamJoined: on('team_joined'),
    announcements: on('announcements'),
    // This form does not contain the webhook field; carrying it through is what
    // stops "save preferences" from silently deleting a destination.
    webhookUrl: current.webhookUrl,
  });
  return c.redirect(`/app/notifications?ok=${encodeURIComponent('Notification preferences saved.')}`);
});

/**
 * The personal webhook: save it, test it, or remove it. Testing is not a
 * nicety — an incoming-webhook URL is a long opaque string that fails silently
 * when wrong, and a notification route nobody has proven is worse than none.
 */
notificationsRoutes.post('/app/notifications/webhook', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const env = c.get('env');
  const body = await c.req.parseBody();
  const action = typeof body.action === 'string' ? body.action : 'save';
  const raw = typeof body.webhook_url === 'string' ? body.webhook_url.trim() : '';
  const prefs = await notificationPrefsFor(c.get('db'), user.id);
  const back = (query: string) => c.redirect(`/app/notifications?${query}`);

  if (action === 'remove') {
    await saveNotificationPrefs(c.get('db'), user.id, { ...prefs, webhookUrl: null });
    return back(`ok=${encodeURIComponent('Personal webhook removed.')}`);
  }
  if (!raw) {
    return back(`err=${encodeURIComponent('Paste the webhook URL your chat app gave you first.')}`);
  }
  if (!isSafeWebhookUrl(raw, env.nodeEnv === 'production')) {
    return back(
      `err=${encodeURIComponent('That is not a webhook URL this server will post to. It must be https and public.')}`,
    );
  }
  if (action === 'test') {
    const posted = await deliverWebhook(
      raw,
      `STMA test from ${user.username} — if you can read this, your notifications will arrive here.`,
      env.nodeEnv === 'production',
    );
    if (!posted.ok) {
      return back(
        `err=${encodeURIComponent(`Your chat app rejected the test (${posted.error}). Check the URL and try again.`)}`,
      );
    }
    // A test that works is also a save: nobody wants to prove the URL and then
    // discover it was never stored.
    await saveNotificationPrefs(c.get('db'), user.id, { ...prefs, webhookUrl: raw });
    return back(`ok=${encodeURIComponent('Test delivered, and the webhook is saved.')}`);
  }
  await saveNotificationPrefs(c.get('db'), user.id, { ...prefs, webhookUrl: raw });
  return back(`ok=${encodeURIComponent('Personal webhook saved.')}`);
});
