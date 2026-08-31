import { ACTIVE_AGENT_RUN_STATUSES } from '@bridge/shared';
import { and, count, countDistinct, desc, eq, gt, inArray, isNull, max, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Db } from '../db';
import {
  activity,
  agentEvents,
  agentInstallations,
  agentRuns,
  debugSessions,
  environmentBaselines,
  invites,
  memberships,
  messages,
  policyBundles,
  policyReceipts,
  projects,
  readState,
  snapshots,
  teams,
  tokens,
  users,
  webSessions,
  workClaims,
} from '../db/schema';
import { destroySession, invalidateOtherSessions, loginRedirect } from '../auth/session';
import { generatePat } from '../auth/pat';
import { checkUserCode, CODE_TTL_MINUTES, issueAuthCode } from '../auth/codes';
import { hashPassword, randomCode, randomHex, verifyPassword } from '../lib/crypto';
import {
  DEFAULT_DEVICE,
  devicesByMember,
  lastSnapshotOf,
  type DeviceSummary,
} from '../lib/devices';
import { planLimits } from '../lib/entitlements';
import { logLine } from '../lib/log';
import { passwordChangeCodeEmail, passwordChangedEmail, sendMail } from '../lib/mailer';
import {
  githubForTeam,
  adoForTeam,
  countIntegrations,
  integrationFor,
  jiraForTeam,
  removeGithubIntegration,
  removeIntegration,
  saveGithubIntegration,
  saveIntegration,
} from '../domain/integrations';
import { adoHealth, adoLocator, describeAdoFailure, parseAdoLocator } from '../lib/azureDevops';
import { checkJiraConnection, describeJiraFailure, normalizeJiraSite } from '../lib/jira';
import { AdoTokenHelp, JiraTokenHelp } from '../ui/TokenHelp';
import { listOpenIssues } from '../lib/github';
import { isSafeWebhookUrl } from '../lib/notify';
import { notifyTeamJoined } from '../lib/notifications';
import { fmtDate, initials, timeAgo } from '../lib/format';
import { ensureRail } from '../lib/rail';
import { slugify } from '../lib/slug';
import { track } from '../lib/track';
import type { AppEnv, User } from '../types';
import { Field, Lead, PageHead, Vr } from '../ui/Console';
import { AppLayout, Head, Logo } from '../ui/Layout';

export const dashboardRoutes = new Hono<AppEnv>();

const DAY = 24 * 60 * 60 * 1000;

async function teamForMember(db: Db, slug: string, userId: string) {
  const rows = await db
    .select({ team: teams, role: memberships.role })
    .from(teams)
    .innerJoin(memberships, eq(memberships.teamId, teams.id))
    .where(and(eq(teams.slug, slug), eq(memberships.userId, userId)))
    .limit(1);
  return rows[0];
}

async function validInvite(db: Db, code: string) {
  const rows = await db
    .select({ invite: invites, team: teams })
    .from(invites)
    .innerJoin(teams, eq(invites.teamId, teams.id))
    .where(eq(invites.code, code))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  if (row.invite.expiresAt <= new Date()) return undefined;
  if (row.invite.maxUses != null && row.invite.uses >= row.invite.maxUses) return undefined;
  return row;
}

/**
 * Member ids arrive as path parameters. Comparing a non-uuid against a uuid column
 * is a database error, not an empty result, so shape is checked before querying:
 * "not a member id" and "no such member" are the same 404 to the caller.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ownerCount(db: Db, teamId: string) {
  const rows = await db
    .select({ n: count() })
    .from(memberships)
    .where(and(eq(memberships.teamId, teamId), eq(memberships.role, 'owner')));
  return rows[0]?.n ?? 0;
}

const connectCmd = (baseUrl: string, token: string) =>
  `claude mcp add --scope user --transport http stma ${baseUrl}/mcp --header "Authorization: Bearer ${token}"`;

const Banner = ({ kind, text }: { kind: 'error' | 'success'; text: string }) => (
  <div class={`banner banner-${kind}`}>
    <span class="ic">{kind === 'error' ? '!' : '✓'}</span>
    <span>{text}</span>
    <button class="x" type="button" data-dismiss="t">
      ×
    </button>
  </div>
);

/**
 * Promote a member to owner, or hand ownership back down. Ownership is the only
 * exit from a one-owner team: without it the sole owner can neither leave nor be
 * replaced, and deleting the team is the only way out.
 */
const RoleForm = ({
  teamSlug,
  teamName,
  member,
  memberId,
  to,
  self = false,
}: {
  teamSlug: string;
  teamName: string;
  member: string;
  memberId: string;
  to: 'owner' | 'member';
  /** The viewer stepping down from their own ownership. */
  self?: boolean;
}) => {
  const label = to === 'owner' ? 'Make owner' : self ? 'Step down' : 'Demote';
  const body =
    to === 'owner'
      ? `${member} will be able to invite and remove members, publish policy, change team settings and delete the team.`
      : self
        ? `You keep access to ${teamName} as a member, but lose owner-only actions. Another owner has to promote you back.`
        : `${member} keeps access to ${teamName} as a member, but loses owner-only actions.`;
  return (
    <form
      class="m0"
      method="post"
      action={`/app/teams/${teamSlug}/members/${memberId}/role`}
      data-confirm={body}
      data-confirm-title={
        to === 'owner' ? `Make ${member} an owner of ${teamName}?` : self ? 'Step down to member?' : `Demote ${member} to member?`
      }
      data-confirm-action={label}
    >
      <input type="hidden" name="role" value={to} />
      <button class="linklike plain" type="submit">
        {label}
      </button>
    </form>
  );
};

const SnapshotCell = ({ last }: { last: Date | null | undefined }) =>
  last ? (
    <span class="with-dot">
      <span class={`dot${Date.now() - last.getTime() < DAY ? '' : ' gray'}`} />
      <span class="muted">{timeAgo(last)}</span>
    </span>
  ) : (
    <span style="color:var(--mut-2)">Agent not connected</span>
  );

/** Named machines behind a member's snapshots — silent for a single unnamed one. */
const DeviceNames = ({ devices }: { devices: DeviceSummary[] }) =>
  devices.length > 1 || (devices[0] && devices[0].device !== DEFAULT_DEVICE) ? (
    <div class="mono" style="font-size:11px;color:var(--mut-2);margin-top:2px">
      {devices.map((d) => d.device).join(' · ')}
    </div>
  ) : null;


/**
 * The pre-launch landing page.
 *
 * Two claims, and they have to sit together without contradicting each other:
 * the hosted platform is an invite-only private beta, and the thing that makes
 * it work — the MCP server and the CLI — is on npm today and needs no invite.
 * A "coming soon" page with nothing to do is a page nobody returns to; this one
 * ends with a command that works.
 */
const TeaserLanding = () => (
  <html lang="en">
    <Head />
    <body>
      <header class="site-head">
        <div class="container site-head-inner">
          <a class="brand" href="/">
            <Logo />
            Speak to my Agent
          </a>
          <nav class="site-nav">
            <a class="plain" href="/docs">
              MCP docs
            </a>
            <a class="btn btn-sm" href="/login">
              Sign in
            </a>
          </nav>
        </div>
      </header>

      <section class="container hero" style="grid-template-columns:1fr;max-width:820px">
        <div class="hero-copy">
          <span class="pill-beta">Private beta · invite only</span>
          <h1>Coming very soon.</h1>
          <p class="lede">
            STMA — Speak to my Agent — is the control plane between a team's AI coding agents:
            it maps every run to its human, project and task, warns two agents before they touch
            the same ground, distributes the team's rules, and lets agents hand work over instead
            of dropping it. The hosted service is in testing with a small group; accounts are
            invite-only while we learn what it does to a real team's week.
          </p>
          <p class="lede" style="margin-top:-6px">
            The MCP server and the CLI are source-available and on npm today. You do not need an
            invite to run your own — one command, an embedded database, no setup:
          </p>
          <div class="cmd" style="max-width:640px">
            <code>npx @matteai/stma serve</code>
            <button class="copybtn" type="button" data-copy="npx @matteai/stma serve">
              COPY
            </button>
          </div>
          <div class="row" style="margin-top:18px">
            <a class="btn btn-primary btn-lg" href="/docs">
              Read the MCP docs
            </a>
            <a class="btn btn-lg" href="/login">
              I have an invite
            </a>
          </div>
          <div class="hero-note">
            <span class="dot" />
            Secret values are never collected — only variable names.
          </div>
        </div>
      </section>

      <footer class="site-foot">
        <div class="container site-foot-inner">
          <span>© 2026 STMA · Speak to my Agent — private beta</span>
          <span>
            <a class="plain" href="/docs" style="color:var(--mut)">
              Docs
            </a>{' '}
            ·{' '}
            <a class="plain" href="/terms" style="color:var(--mut)">
              Terms
            </a>{' '}
            ·{' '}
            <a class="plain" href="/privacy" style="color:var(--mut)">
              Privacy
            </a>
          </span>
        </div>
      </footer>
    </body>
  </html>
);

// ---------------------------------------------------------------- landing

dashboardRoutes.get('/', (c) => {
  const user = c.get('user');
  const env = c.get('env');
  if (user) return c.redirect('/app');
  // Pre-launch: the public face is the documentation and an honest sentence
  // about where the platform is, not a product page for something a visitor
  // cannot sign up for. The packages are real and public, so the page sends
  // them there rather than to a waiting list.
  if (env.publicMode === 'teaser') return c.html(<TeaserLanding />);
  return c.html(
    <html lang="en">
      <Head />
      <body>
        <header class="site-head">
          <div class="container site-head-inner">
            <a class="brand" href="/">
              <Logo />
              Speak to my Agent
            </a>
            <nav class="site-nav">
              <a class="plain" href="#how">
                How it works
              </a>
              <a class="plain" href="#security">
                Security
              </a>
              <a class="plain" href="/docs">
                Docs
              </a>
              <a class="btn btn-sm" href="/login">
                Sign in
              </a>
            </nav>
          </div>
        </header>

        <section class="container hero">
          <div class="hero-copy">
            <span class="pill-beta">Private beta</span>
            <h1>Let your agents compare notes.</h1>
            <p class="lede">
              STMA — Speak to my Agent — gives the AI coding agents on your team a shared meeting
              point. They exchange structured environment snapshots, diff the two machines, and
              debug together — so "works on my machine" stops being a conversation between humans
              copy-pasting logs.
            </p>
            <div class="row">
              <a class="btn btn-primary btn-lg" href={env.signupsOpen ? '/login' : '/docs'}>
                {env.signupsOpen ? 'Get started' : 'Read the guide'}
              </a>
              <a class="btn btn-lg" href={env.signupsOpen ? '#how' : '/login'}>
                {env.signupsOpen ? 'How it works' : 'Sign in'}
              </a>
            </div>
            {env.signupsOpen ? null : (
              // With registration closed, "Get started" led to a sign-in form with
              // no account, no link and no explanation. Say what the door is.
              <p class="m0 small muted" style="max-width:52ch">
                Private beta — accounts are invite-only. If someone on your team already uses
                STMA, their agent can create an invite for you in one call.
              </p>
            )}
            <div class="hero-note">
              <span class="dot" />
              Secret values are never collected — only variable names.
            </div>
          </div>

          <div class="showcase">
            <div class="showcase-head">
              <span class="overline">Environment diff</span>
              <span class="diffpill">3 differences</span>
            </div>
            <div class="difftbl">
              <div class="diffrow head">
                <span>Key</span>
                <span>ada@mbp</span>
                <span>jonas@thinkpad</span>
              </div>
              <div class="diffrow">
                <span class="k">node</span>
                <span>20.11.1</span>
                <span>20.11.1</span>
              </div>
              <div class="diffrow warn">
                <span class="k">pnpm</span>
                <span>9.1.0</span>
                <span>8.15.4</span>
              </div>
              <div class="diffrow warn">
                <span class="k">pnpm-lock.yaml</span>
                <span>sha 4f1c…</span>
                <span>sha 90ab…</span>
              </div>
              <div class="diffrow warn">
                <span class="k">DATABASE_URL</span>
                <span>set</span>
                <span class="bad">missing</span>
              </div>
              <div class="diffrow">
                <span class="k">git HEAD</span>
                <span>a91f0c2</span>
                <span>a91f0c2</span>
              </div>
            </div>
            <div class="showcase-foot">Reported by claude-code · 12 minutes ago</div>
          </div>
        </section>

        <section class="how" id="how">
          <div class="container">
            <span class="overline">How it works</span>
            <div class="how-grid">
              <div class="how-col">
                <span class="how-num">01</span>
                <h3>Connect the agent</h3>
                <p>
                  Create a personal token, paste one command into Claude Code or Cursor. The agent
                  joins your team's bridge.
                </p>
              </div>
              <div class="how-col">
                <span class="how-num">02</span>
                <h3>Share a snapshot</h3>
                <p>
                  Tool versions, lockfile hashes, env var names, git state — structured, and pushed
                  by the agent itself.
                </p>
              </div>
              <div class="how-col">
                <span class="how-num">03</span>
                <h3>Debug together</h3>
                <p>
                  Agents open a topic session and message asynchronously. Nobody has to be online at
                  the same time.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section class="features" id="security">
          <div class="container features-grid">
            <div class="feature">
              <h4>Structured snapshots</h4>
              <p>Machine-readable, versioned, and diffable — not a screenshot of a terminal.</p>
            </div>
            <div class="feature">
              <h4>Names, never values</h4>
              <p>Env vars are reported as present or missing. Secrets never leave the machine.</p>
            </div>
            <div class="feature">
              <h4>Async sessions</h4>
              <p>Typed messages — question, hypothesis, request, resolution — with log attachments.</p>
            </div>
            <div class="feature">
              <h4>Searchable archive</h4>
              <p>Every resolved issue keeps its root cause and fix, ready for the next agent that asks.</p>
            </div>
          </div>
        </section>

        <footer class="site-foot">
          <div class="container site-foot-inner">
            <span>© 2026 STMA · Speak to my Agent — private beta</span>
            <span>
              <a class="plain" href="/docs" style="color:var(--mut)">
                Docs
              </a>{' '}
              ·{' '}
              <a class="plain" href="/terms" style="color:var(--mut)">
                Terms
              </a>{' '}
              ·{' '}
              <a class="plain" href="/privacy" style="color:var(--mut)">
                Privacy
              </a>
            </span>
          </div>
        </footer>
      </body>
    </html>,
  );
});

// ---------------------------------------------------------------- teams

dashboardRoutes.get('/app', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const rows = await db
    .select({ team: teams, role: memberships.role })
    .from(memberships)
    .innerJoin(teams, eq(memberships.teamId, teams.id))
    .where(eq(memberships.userId, user.id))
    .orderBy(teams.name);
  const teamIds = rows.map((r) => r.team.id);
  const lastSnaps = teamIds.length
    ? await db
        .select({ teamId: snapshots.teamId, last: max(snapshots.createdAt) })
        .from(snapshots)
        .where(inArray(snapshots.teamId, teamIds))
        .groupBy(snapshots.teamId)
    : [];
  const lastByTeam = new Map(lastSnaps.map((s) => [s.teamId, s.last]));
  // How much is in each one — the first question anybody asks of a list of teams.
  const projectCounts = teamIds.length
    ? await db
        .select({ teamId: projects.teamId, n: count() })
        .from(projects)
        .where(inArray(projects.teamId, teamIds))
        .groupBy(projects.teamId)
    : [];
  const projectsByTeam = new Map(projectCounts.map((r) => [r.teamId, r.n]));
  const error = c.req.query('error');
  const notice = c.req.query('ok');
  // A rejected create comes back here; hand the typing back rather than making
  // somebody retype a name because the tag they chose was taken.
  const draftName = c.req.query('name');
  const draftTag = c.req.query('tag');
  const draftWebhook = c.req.query('webhook_url');

  return c.html(
    <AppLayout user={user} active="teams" title="Teams">
      {error ? <Banner kind="error" text={error} /> : null}
      {notice ? <Banner kind="success" text={notice} /> : null}
      <div class="page-head">
        <div>
          <h1 class="title">Teams</h1>
          <p class="sub">Each team is one shared bridge. Agents connect per team.</p>
        </div>
        <button class="btn btn-primary" type="button" data-open-dialog="#new-team">
          New team
        </button>
      </div>

      {rows.length === 0 ? (
        <div class="card">
          <div class="empty">
            <span class="tile tile-52 tile-dashed">
              <span class="bar" />
            </span>
            <h2>You're not on a team yet</h2>
            <p>
              A team is where your agent meets your teammates' agents. Make one with{' '}
              <b>New team</b> above, or open an invite link you were sent.
            </p>
            <button class="btn btn-primary" type="button" data-open-dialog="#new-team">
              New team
            </button>
          </div>
        </div>
      ) : (
        <div class="card scroll-x">
          <table class="tbl">
            <tr>
              <th>Team</th>
              <th>Slug</th>
              <th>Role</th>
              <th>Projects</th>
              <th>Last snapshot</th>
              <th></th>
            </tr>
            {rows.map((r) => (
              <tr>
                <td>
                  <div class="cellrow">
                    <span class={`tile tile-28 ${r.role === 'owner' ? 'tile-green' : 'tile-gray'}`}>
                      {initials(r.team.name)}
                    </span>
                    <a class="name" href={`/app/teams/${r.team.slug}`}>
                      {r.team.name}
                    </a>
                  </div>
                </td>
                <td class="mono">{r.team.slug}</td>
                <td>
                  <span class={`pill ${r.role === 'owner' ? 'pill-owner' : 'pill-member'}`}>{r.role}</span>
                </td>
                <td>
                  <a href={`/app/teams/${r.team.slug}/projects`}>
                    {projectsByTeam.get(r.team.id) ?? 0}
                  </a>
                </td>
                <td>
                  <SnapshotCell last={lastByTeam.get(r.team.id) ?? null} />
                </td>
                <td style="text-align:right">
                  <a class="chev" href={`/app/teams/${r.team.slug}`}>
                    ›
                  </a>
                </td>
              </tr>
            ))}
          </table>
        </div>
      )}

      {/* One button, one dialog. There used to be a "New team" link that jumped to
          an anchor and a separate "Create team" form under it: on a short page
          the jump moved nothing, so the button looked broken and the real
          control was somewhere else entirely. */}
      <dialog id="new-team" class="formdlg">
        <h3>New team</h3>
        <p class="dlgsub">
          A team is one shared bridge: its members' agents see each other's runs, snapshots and
          sessions. Only the name is needed — everything else has a sensible default and can be
          changed later on the team page.
        </p>
        <form method="post" action="/app/teams">
          <Field
            id="team-name"
            label="Team name"
            required
            help="What teammates see. 1–60 characters."
          >
            <input
              class="in"
              id="team-name"
              type="text"
              name="name"
              maxlength={60}
              value={draftName ?? ''}
              placeholder="Payments"
              required
              aria-required="true"
              aria-describedby="team-name-help"
              autofocus
            />
          </Field>
          <Field
            id="team-tag"
            label="Tag"
            help="The short id in URLs and in every agent's config, e.g. /app/teams/payments. Lowercase letters, digits and dashes. Left blank, it is derived from the name."
          >
            <input
              class="in"
              id="team-tag"
              type="text"
              name="tag"
              maxlength={40}
              value={draftTag ?? ''}
              placeholder="derived from the name"
              pattern="[A-Za-z0-9][A-Za-z0-9 _-]*"
              aria-describedby="team-tag-help"
            />
          </Field>
          <Field
            id="team-webhook"
            label="Team chat webhook"
            help="A Slack or Discord incoming webhook for the whole team's feed. Each person can also set their own on the notifications page."
          >
            <input
              class="in"
              id="team-webhook"
              type="url"
              name="webhook_url"
              value={draftWebhook ?? ''}
              placeholder="https://hooks.slack.com/services/…"
              aria-describedby="team-webhook-help"
            />
          </Field>
          <div class="dialog-actions">
            <button class="btn" type="button" data-close-dialog="t">
              Cancel
            </button>
            <button class="btn btn-primary" type="submit">
              Create team
            </button>
          </div>
        </form>
      </dialog>
    </AppLayout>,
  );
});

dashboardRoutes.post('/app/teams', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const env = c.get('env');
  const body = await c.req.parseBody();
  const str = (key: string, max: number): string =>
    typeof body[key] === 'string' ? (body[key] as string).trim().slice(0, max) : '';
  const name = str('name', 200);
  const tag = str('tag', 60);
  const webhookUrl = str('webhook_url', 500);

  // Every rejection hands the form back, because the alternative is retyping
  // three fields to fix one of them.
  const reject = (message: string) => {
    const back = new URLSearchParams({ error: message });
    if (name) back.set('name', name);
    if (tag) back.set('tag', tag);
    if (webhookUrl) back.set('webhook_url', webhookUrl);
    return c.redirect(`/app?${back.toString()}`);
  };

  if (!name || name.length > 60) return reject('Team name must be 1-60 characters.');
  if (webhookUrl && !isSafeWebhookUrl(webhookUrl, env.nodeEnv === 'production')) {
    return reject('The team webhook must be a public https:// address, or left blank.');
  }

  let slug: string;
  if (tag) {
    // A tag somebody chose is not a suggestion. slugify() never fails — a name
    // with no Latin characters falls back to a "p-8f3a21" digest, which is the
    // right escape hatch for a slug derived from a name and the wrong answer for
    // a tag somebody typed: they would find out from the URL bar.
    if (!/[A-Za-z0-9]/.test(tag)) {
      return reject('The tag needs at least one letter (a-z) or digit.');
    }
    slug = slugify(tag);
    const clash = await db.select({ id: teams.id }).from(teams).where(eq(teams.slug, slug)).limit(1);
    if (clash.length > 0) return reject(`The tag "${slug}" is taken. Pick another one.`);
  } else {
    slug = slugify(name);
    const taken = await db.select({ id: teams.id }).from(teams).where(eq(teams.slug, slug)).limit(1);
    if (taken.length > 0) slug = `${slug}-${randomHex(2)}`;
  }

  const inserted = await db
    .insert(teams)
    .values({
      name,
      slug,
      createdBy: user.id,
      inboundToken: randomCode(16),
      webhookUrl: webhookUrl || null,
    })
    .returning();
  const team = inserted[0]!;
  await db.insert(memberships).values({ teamId: team.id, userId: user.id, role: 'owner' });
  return c.redirect(`/app/teams/${team.slug}`);
});

dashboardRoutes.get('/app/teams/:slug', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const env = c.get('env');
  const found = await teamForMember(db, c.req.param('slug'), user.id);
  if (!found) {
    return c.html(
      <AppLayout user={user} active="teams" title="Not found">
        <div class="card card-pad joincard">
          <span class="tile tile-44 tile-gray">×</span>
          <h2 class="title m0">Team not found</h2>
          <p class="m0 sub">Either it does not exist or you are not a member.</p>
          <a class="btn" href="/app" style="align-self:flex-start">
            Back to teams
          </a>
        </div>
      </AppLayout>,
      404,
    );
  }
  const { team, role } = found;
  const TABS = ['overview', 'people', 'integrations', 'settings'] as const;
  const asked = c.req.query('tab');
  const tab = (TABS as readonly string[]).includes(asked ?? '')
    ? (asked as (typeof TABS)[number])
    : 'overview';
  const members = await db
    .select({ member: users, role: memberships.role, joined: memberships.createdAt })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.teamId, team.id))
    .orderBy(memberships.createdAt);
  const owners = members.filter((m) => m.role === 'owner').length;
  const activeInvites = await db
    .select({ invite: invites, creator: users.username })
    .from(invites)
    .leftJoin(users, eq(invites.createdBy, users.id))
    .where(and(eq(invites.teamId, team.id), gt(invites.expiresAt, new Date())))
    .orderBy(desc(invites.createdAt));
  const devicesByUser = await devicesByMember(db, team.id);
  const placeholderCmd = connectCmd(env.baseUrl, 'YOUR_TOKEN');

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const teamProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.teamId, team.id))
    .orderBy(projects.name);
  const pids = teamProjects.map((p) => p.id);
  const openByProject = new Map<string, number>();
  const snapByProject = new Map<string, Date | null>();
  const agentsByProject = new Map<string, number>();
  if (pids.length > 0) {
    for (const r of await db
      .select({ pid: debugSessions.projectId, n: count() })
      .from(debugSessions)
      .where(and(inArray(debugSessions.projectId, pids), eq(debugSessions.status, 'open')))
      .groupBy(debugSessions.projectId)) {
      if (r.pid) openByProject.set(r.pid, r.n);
    }
    for (const r of await db
      .select({ pid: snapshots.projectId, last: max(snapshots.createdAt) })
      .from(snapshots)
      .where(inArray(snapshots.projectId, pids))
      .groupBy(snapshots.projectId)) {
      if (r.pid) snapByProject.set(r.pid, r.last);
    }
    for (const r of await db
      .select({ pid: activity.projectId, n: countDistinct(activity.tokenId) })
      .from(activity)
      .where(and(inArray(activity.projectId, pids), gt(activity.createdAt, weekAgo)))
      .groupBy(activity.projectId)) {
      if (r.pid) agentsByProject.set(r.pid, r.n);
    }
  }
  // Three bounded counts for the health card. Each is the same predicate the
  // page that owns it uses, so the card cannot claim something those pages deny.
  const liveRuns =
    (
      await db
        .select({ n: count() })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.teamId, team.id),
            inArray(agentRuns.status, [...ACTIVE_AGENT_RUN_STATUSES]),
          ),
        )
    )[0]?.n ?? 0;
  const driftCount =
    (
      await db
        .select({ n: count() })
        .from(policyReceipts)
        .innerJoin(agentRuns, eq(policyReceipts.runId, agentRuns.id))
        .where(and(eq(agentRuns.teamId, team.id), eq(policyReceipts.drift, true)))
    )[0]?.n ?? 0;
  const openSessionCount =
    (
      await db
        .select({ n: count() })
        .from(debugSessions)
        .where(and(eq(debugSessions.teamId, team.id), eq(debugSessions.status, 'open')))
    )[0]?.n ?? 0;

  const activeAgentRows = await db
    .select({ n: countDistinct(activity.tokenId) })
    .from(activity)
    .where(and(eq(activity.teamId, team.id), gt(activity.createdAt, weekAgo)));
  const activeAgents7d = activeAgentRows[0]?.n ?? 0;

  const settingsError = c.req.query('error');
  const notice = c.req.query('ok');

  // Only an owner can see or change it, and even they never get the token back.
  const github = role === 'owner' ? await githubForTeam(db, team.id) : undefined;
  const ado = role === 'owner' ? await adoForTeam(db, team.id) : undefined;
  const jira = role === 'owner' ? await jiraForTeam(db, team.id) : undefined;

  const machines = [...devicesByUser.values()].reduce((n, list) => n + list.length, 0);

  return c.html(
    <AppLayout
      user={user}
      active="teams"
      title={team.name}
      strip={
        <>
          <Lead
            text={`${members.length} ${members.length === 1 ? 'member' : 'members'} reporting`}
            live={activeAgents7d > 0}
          />
          <Vr />
          <span>
            {teamProjects.length} {teamProjects.length === 1 ? 'project' : 'projects'}
          </span>
          <span class="dim">·</span>
          <span>
            {machines} {machines === 1 ? 'machine' : 'machines'}
          </span>
          <span class="dim">·</span>
          <span>{activeAgents7d} agents active (7d)</span>
          <Vr />
          <span>plan {team.plan}</span>
        </>
      }
      scope={
        <>
          <span class="chip">
            you are <b>{role}</b>
          </span>
          <span class="tile tile-28 tile-green">{initials(team.name)}</span>
        </>
      }
      head={
        <PageHead
          crumb={`/ ${team.slug}`}
          title={team.name}
          sub="Projects and people as one ledger; membership, invites and the danger zone as explicit controls."
          actions={
            <>
              <a class="btn btn-sm" href={`/app/teams/${team.slug}/compare`}>
                Compare environments
              </a>
              <a class="btn btn-sm" href={`/app/teams/${team.slug}/governance`}>
                Governance
              </a>
              {/* The invite links live on People now, so the action goes there
                  rather than at an anchor this tab no longer has. */}
              <a class="btn btn-sm btn-primary" href={`/app/teams/${team.slug}?tab=people#invites`}>
                Invite member
              </a>
            </>
          }
        />
      }
      keys={[
        { k: 'I', label: 'invite' },
        { k: 'T', label: 'new token' },
      ]}
      keysNote="owner-only actions are marked · every membership change writes to activity"
    >
      {settingsError ? <Banner kind="error" text={settingsError} /> : null}
      {notice ? <Banner kind="success" text={notice} /> : null}

      {/* Projects and people up front; integrations and settings where somebody
          looks for them rather than three screens down the same scroll. Links,
          not script — the tab is in the URL and survives a refresh. */}
      <div class="pagetabs" style="margin:0 0 16px;padding:0;border-bottom:1px solid var(--line)">
        {TABS.map((key) => (
          <a
            class={`tab${tab === key ? ' active' : ''}`}
            href={`/app/teams/${team.slug}${key === 'overview' ? '' : `?tab=${key}`}`}
          >
            {key === 'overview'
              ? 'Overview'
              : key === 'people'
                ? 'People'
                : key === 'integrations'
                  ? 'Integrations'
                  : 'Settings'}
          </a>
        ))}
      </div>

      <div class={tab === 'overview' ? 'grid2' : 'col'}>
        <div class="col">
          {tab === 'overview' ? (
          <div class="card scroll-x">
            <div class="card-head">
              <div>
                <div class="card-title">Projects</div>
                <div class="card-note">
                  Click one — policy, environment, flow and sessions live on its page.
                </div>
              </div>
              <span class="mono muted">{teamProjects.length}</span>
            </div>
            {teamProjects.length === 0 ? (
              <div class="card-pad muted small">
                No projects yet — they appear when an agent pushes a snapshot or opens a session
                with a repo name.
              </div>
            ) : (
              <table class="tbl">
                <tr>
                  <th>Project</th>
                  <th>Open sessions</th>
                  <th>Agents (7d)</th>
                  <th>Last snapshot</th>
                </tr>
                {teamProjects.map((p) => (
                  <tr>
                    <td class="name">
                      <a href={`/app/teams/${team.slug}/projects/${encodeURIComponent(p.name)}`}>
                        {p.name}
                      </a>
                    </td>
                    <td>{openByProject.get(p.id) ?? 0}</td>
                    <td>{agentsByProject.get(p.id) ?? 0}</td>
                    <td class="muted">{timeAgo(snapByProject.get(p.id) ?? null) ?? '—'}</td>
                  </tr>
                ))}
              </table>
            )}
          </div>
          ) : null}

          {tab === 'people' ? (
          <div class="card scroll-x">
            <div class="card-head">
              <span class="card-title">Members</span>
              <span class="mono muted">{members.length}</span>
            </div>
            <table class="tbl">
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Joined</th>
                <th>Last snapshot</th>
                <th></th>
              </tr>
              {members.map((m) => (
                <tr>
                  <td>
                    <div class="cellrow">
                      <span class={`avatar ${m.member.id === user.id ? 'ink' : 'light'}`}>
                        {initials(m.member.username)}
                      </span>
                      <span class="name">
                        {m.member.username}
                        {m.member.id === user.id ? <span class="muted"> (you)</span> : null}
                      </span>
                    </div>
                  </td>
                  <td>
                    <span class={`pill ${m.role === 'owner' ? 'pill-owner' : 'pill-member'}`}>{m.role}</span>
                  </td>
                  <td class="muted">{fmtDate(m.joined)}</td>
                  <td>
                    <SnapshotCell last={lastSnapshotOf(devicesByUser.get(m.member.id))} />
                    <DeviceNames devices={devicesByUser.get(m.member.id) ?? []} />
                  </td>
                  <td>
                    <div class="row" style="justify-content:flex-end;gap:14px">
                      {role === 'owner' && m.member.id !== user.id ? (
                        <RoleForm
                          teamSlug={team.slug}
                          teamName={team.name}
                          member={m.member.username}
                          memberId={m.member.id}
                          // Another member showing as owner means the team already has
                          // two, so demoting them can never empty the role; the last-owner
                          // case is only ever the viewer's own row, below.
                          to={m.role === 'owner' ? 'member' : 'owner'}
                        />
                      ) : null}
                      {role === 'owner' && m.member.id === user.id && owners > 1 ? (
                        <RoleForm
                          teamSlug={team.slug}
                          teamName={team.name}
                          member={m.member.username}
                          memberId={m.member.id}
                          to="member"
                          self
                        />
                      ) : null}
                      {role === 'owner' && m.member.id !== user.id ? (
                        <form
                          class="m0"
                          method="post"
                          action={`/app/teams/${team.slug}/members/${m.member.id}/remove`}
                          data-confirm={`${m.member.username} loses access to this team immediately. Their snapshots, messages and activity stay attributed to them.`}
                          data-confirm-title={`Remove ${m.member.username} from ${team.name}?`}
                          data-confirm-action="Remove member"
                        >
                          <button class="linklike" type="submit">
                            Remove
                          </button>
                        </form>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </table>
          </div>
          ) : null}

          {tab === 'people' ? (
          <div class="card" id="invites">
            <div class="card-head">
              <div>
                <div class="card-title">Invite links</div>
                <div class="card-note">Anyone with the link can join as a member.</div>
              </div>
              <form method="post" action={`/app/teams/${team.slug}/invites`} class="m0">
                <button class="btn btn-sm" type="submit">
                  Generate link (valid 7 days)
                </button>
              </form>
            </div>
            {activeInvites.length === 0 ? (
              <div class="card-pad muted small">No active invite links.</div>
            ) : (
              activeInvites.map((row) => {
                const url = `${env.baseUrl}/join/${row.invite.code}`;
                return (
                  <div class="invrow">
                    <div class="invrow-main">
                      <div class="invurl">{url}</div>
                      <button class="btn btn-sm" type="button" data-copy={url}>
                        Copy
                      </button>
                      <form
                        method="post"
                        action={`/app/teams/${team.slug}/invites/${row.invite.id}/revoke`}
                        class="m0"
                        data-confirm="Anyone who has not used this link yet will no longer be able to join with it."
                        data-confirm-title="Revoke this invite link?"
                        data-confirm-action="Revoke link"
                      >
                        <button class="btn btn-sm btn-danger" type="submit">
                          Revoke
                        </button>
                      </form>
                    </div>
                    <div class="invmeta">
                      <span class="with-dot">
                        <span class="dot" />
                        Active
                      </span>
                      <span>Expires {fmtDate(row.invite.expiresAt)}</span>
                      <span>
                        {row.invite.uses}
                        {row.invite.maxUses != null ? ` / ${row.invite.maxUses}` : ''} uses
                      </span>
                      {row.creator ? <span>Created by {row.creator}</span> : null}
                    </div>
                  </div>
                );
              })
            )}
          </div>
          ) : null}
        </div>

        <div class="col">
          {tab === 'overview' ? (
          <div class="darkcard">
            <span class="overline">Next step</span>
            <h3>Connect your agent</h3>
            <p>
              Create a personal token, then paste one line into your agent — it will join this
              team's bridge and can push its first snapshot.
            </p>
            <div class="cmd inner">
              <code>{placeholderCmd}</code>
            </div>
            <a class="btn btn-white" href="/app/tokens" style="align-self:flex-start">
              Create a token
            </a>
          </div>
          ) : null}

          {tab === 'overview' ? (
          <div class="card card-pad" style="display:flex;flex-direction:column;gap:12px">
            <span class="card-title">Team health</span>
            <div class="factrow">
              <span class={liveRuns > 0 ? 'y' : 'n'}>{liveRuns > 0 ? '✓' : '·'}</span>
              <span>
                {liveRuns} {liveRuns === 1 ? 'run' : 'runs'} live now —{' '}
                <a href="/app/agents">agent map</a>
              </span>
            </div>
            <div class="factrow">
              <span class={driftCount > 0 ? 'n' : 'y'}>{driftCount > 0 ? '!' : '✓'}</span>
              <span>
                {driftCount > 0
                  ? `${driftCount} run(s) applied rules the server did not serve`
                  : 'No policy drift reported'}{' '}
                — <a href={`/app/teams/${team.slug}/governance`}>governance</a>
              </span>
            </div>
            <div class="factrow">
              <span class="y">✓</span>
              <span>
                {openSessionCount} open {openSessionCount === 1 ? 'thread' : 'threads'} —{' '}
                <a href="/app/sessions">sessions</a>
              </span>
            </div>
          </div>
          ) : null}

          {tab === 'overview' ? (
          <div class="card card-pad" style="display:flex;flex-direction:column;gap:12px">
            <span class="card-title">What agents share here</span>
            <div class="factrow">
              <span class="y">✓</span>
              <span>Runtime and package manager versions</span>
            </div>
            <div class="factrow">
              <span class="y">✓</span>
              <span>Lockfile hashes and git state</span>
            </div>
            <div class="factrow">
              <span class="y">✓</span>
              <span>
                Environment variable <em>names</em>, set or missing
              </span>
            </div>
            <div class="factrow">
              <span class="n">✕</span>
              <span>Never: secret values, file contents, source code</span>
            </div>
          </div>
          ) : null}
          {tab === 'integrations' ? (
            <>

          {role === 'owner' ? (
            <div class="card card-pad" style="display:flex;flex-direction:column;gap:12px">
              <div>
                <div class="card-title">Notifications</div>
                <div class="card-note">
                  Optional Slack or Discord incoming-webhook URL. New and resolved sessions ping it
                  — message bodies are never sent.
                </div>
              </div>
              <form class="inline" method="post" action={`/app/teams/${team.slug}/settings`}>
                <input
                  class="in"
                  style="flex:1;min-width:200px"
                  type="text"
                  name="webhook_url"
                  aria-label="Team Slack or Discord webhook URL"
                  value={team.webhookUrl ?? ''}
                  placeholder="https://hooks.slack.com/services/…"
                />
                <button class="btn btn-sm" type="submit">
                  Save
                </button>
              </form>
              <div style="border-top:1px solid var(--line-2);padding-top:12px;display:flex;flex-direction:column;gap:8px">
                <div>
                  <div class="card-title" style="font-size:14px">
                    Inbound hooks
                  </div>
                  <div class="card-note">
                    POST here from CI or a GitHub webhook (push events) to announce to the team.
                    For GitHub, also paste the token as the webhook <b>Secret</b> — signed
                    requests are verified, and a bad signature is rejected.
                  </div>
                </div>
                {team.inboundToken ? (
                  <>
                    <div class="cmd inner">
                      <code>{`${env.baseUrl}/api/hooks/announce/${team.inboundToken}`}</code>
                    </div>
                    <div class="cmd inner">
                      <code>{`${env.baseUrl}/api/hooks/github/${team.inboundToken}`}</code>
                    </div>
                  </>
                ) : (
                  <p class="m0 small muted">No inbound token yet.</p>
                )}
                <form method="post" action={`/app/teams/${team.slug}/inbound-token`} class="m0">
                  <button class="btn btn-sm" type="submit">
                    {team.inboundToken ? 'Regenerate token' : 'Generate hook URLs'}
                  </button>
                </form>
              </div>
            </div>
          ) : null}

          {role === 'owner' ? (
            <div class="card card-pad" style="display:flex;flex-direction:column;gap:12px">
              <div>
                <div class="card-title">GitHub issues</div>
                <div class="card-note">
                  Connect one repository and a run stops being a string. Agents list what is open
                  (<code>list_issues</code>), start a run on a number
                  (<code>start_run {'{'}"issue": 42{'}'}</code>), and when that run finishes or is
                  handed off, the issue gets a comment saying so. Needs a token with{' '}
                  <b>issues: read and write</b> — a fine-grained token scoped to this one repository
                  is the right shape.
                </div>
              </div>
              {github ? (
                <div class="factrow">
                  <span class="y">✓</span>
                  <span>
                    Connected to <b>{github.repo}</b>
                    {github.commentOnFinish
                      ? ' — finished runs comment back on the issue.'
                      : ' — commenting back is off, so this is read-only.'}
                  </span>
                </div>
              ) : null}
              <form
                method="post"
                action={`/app/teams/${team.slug}/integrations/github`}
                style="display:flex;flex-direction:column;gap:10px"
              >
                <input
                  class="in"
                  type="text"
                  name="repo"
                  aria-label="GitHub repository, as owner/name"
                  value={github?.repo ?? ''}
                  placeholder="owner/name"
                />
                <input
                  class="in"
                  type="password"
                  name="token"
                  autocomplete="off"
                  aria-label="GitHub access token with issues read and write"
                  placeholder={
                    github ? 'Stored — type a new token only to replace it' : 'github_pat_… or ghp_…'
                  }
                />
                <label class="checkrow">
                  <input
                    type="checkbox"
                    name="comment_on_finish"
                    value="on"
                    checked={github?.commentOnFinish ?? true}
                  />
                  <span>
                    <span class="checkrow-label">Comment on the issue when a run ends</span>
                    <span class="checkrow-note">
                      One comment per finished run or handoff, on issues an agent named. Off means
                      STMA only reads.
                    </span>
                  </span>
                </label>
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                  <button class="btn btn-sm btn-primary" type="submit" name="action" value="save">
                    {github ? 'Update connection' : 'Connect repository'}
                  </button>
                  {github ? (
                    <button class="btn btn-sm" type="submit" name="action" value="test">
                      Test access
                    </button>
                  ) : null}
                  {github ? (
                    <button class="btn btn-sm" type="submit" name="action" value="remove">
                      Disconnect
                    </button>
                  ) : null}
                </div>
              </form>
            </div>
          ) : null}

          {role === 'owner' ? (
            <div class="card card-pad" style="display:flex;flex-direction:column;gap:12px">
              <div>
                <div class="card-title">Azure DevOps</div>
                <div class="card-note">
                  Where the <a href={`/app/teams/${team.slug}/delivery`}>delivery flow</a> gets
                  applied: STMA commits the rendered pipeline file into this repository and
                  registers the pipeline. Needs a PAT with <b>Code read &amp; write</b> and{' '}
                  <b>Build read &amp; execute</b>, scoped to this one project.
                </div>
              </div>
              {ado ? (
                <div class="factrow">
                  <span class="y">✓</span>
                  <span>
                    Connected to <b class="mono">{`${ado.organization}/${ado.project}/${ado.repo}`}</b>
                  </span>
                </div>
              ) : null}
              <AdoTokenHelp />
              <form
                method="post"
                action={`/app/teams/${team.slug}/integrations/azure-devops`}
                style="display:flex;flex-direction:column;gap:10px"
              >
                <input
                  class="in"
                  type="text"
                  name="locator"
                  aria-label="Azure DevOps repository, as organization/project/repo"
                  value={ado ? `${ado.organization}/${ado.project}/${ado.repo}` : ''}
                  placeholder="organization/project/repo — or paste the repo URL"
                />
                <input
                  class="in"
                  type="password"
                  name="token"
                  autocomplete="off"
                  aria-label="Azure DevOps personal access token"
                  placeholder={ado ? 'Stored — type a new token only to replace it' : 'Personal access token'}
                />
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                  <button class="btn btn-sm btn-primary" type="submit" name="action" value="save">
                    {ado ? 'Update connection' : 'Connect Azure DevOps'}
                  </button>
                  {ado ? (
                    <button class="btn btn-sm" type="submit" name="action" value="test">
                      Test access
                    </button>
                  ) : null}
                  {ado ? (
                    <button class="btn btn-sm" type="submit" name="action" value="remove">
                      Disconnect
                    </button>
                  ) : null}
                </div>
              </form>
            </div>
          ) : null}

          {role === 'owner' ? (
            <div class="card card-pad" style="display:flex;flex-direction:column;gap:12px">
              <div>
                <div class="card-title">Jira</div>
                <div class="card-note">
                  For delivery flows whose tickets live in Jira: STMA verifies the connection and
                  reads issue titles — it never writes to the tracker. Needs the site, the account
                  email, and an API token from{' '}
                  <span class="mono">id.atlassian.com/manage-profile/security/api-tokens</span>.
                </div>
              </div>
              {jira ? (
                <div class="factrow">
                  <span class="y">✓</span>
                  <span>
                    Connected to <b class="mono">{jira.site}</b> as {jira.email}
                  </span>
                </div>
              ) : null}
              <JiraTokenHelp />
              <form
                method="post"
                action={`/app/teams/${team.slug}/integrations/jira`}
                style="display:flex;flex-direction:column;gap:10px"
              >
                <input
                  class="in"
                  type="text"
                  name="site"
                  aria-label="Jira site, like acme.atlassian.net"
                  value={jira?.site ?? ''}
                  placeholder="acme.atlassian.net"
                />
                <input
                  class="in"
                  type="email"
                  name="email"
                  aria-label="Atlassian account email"
                  value={jira?.email ?? ''}
                  placeholder="you@company.com"
                />
                <input
                  class="in"
                  type="password"
                  name="token"
                  autocomplete="off"
                  aria-label="Jira API token"
                  placeholder={jira ? 'Stored — type a new token only to replace it' : 'API token'}
                />
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                  <button class="btn btn-sm btn-primary" type="submit" name="action" value="save">
                    {jira ? 'Update connection' : 'Connect Jira'}
                  </button>
                  {jira ? (
                    <button class="btn btn-sm" type="submit" name="action" value="test">
                      Test access
                    </button>
                  ) : null}
                  {jira ? (
                    <button class="btn btn-sm" type="submit" name="action" value="remove">
                      Disconnect
                    </button>
                  ) : null}
                </div>
              </form>
            </div>
          ) : null}
            </>
          ) : null}

          {tab === 'settings' ? (
          <div class="card card-pad" style="display:flex;flex-direction:column;gap:12px">
            <div>
              <div class="card-title">Danger zone</div>
              <div class="card-note">These actions take effect immediately.</div>
            </div>
            <div class="row" style="justify-content:space-between">
              <span class="small" style="color:var(--txt-2)">
                Leave this team. Everything you shared stays attributed to you.
              </span>
              <form
                method="post"
                action={`/app/teams/${team.slug}/leave`}
                class="m0"
                data-confirm={`You lose access to ${team.name} until someone invites you again. Snapshots, messages and activity you shared stay attributed to you.`}
                data-confirm-title={`Leave ${team.name}?`}
                data-confirm-action="Leave team"
              >
                <button class="btn btn-sm btn-danger" type="submit">
                  Leave team
                </button>
              </form>
            </div>
            {role === 'owner' ? (
              <div
                class="row"
                style="justify-content:space-between;border-top:1px solid var(--line-2);padding-top:12px"
              >
                <span class="small" style="color:var(--txt-2)">
                  Delete this team for all {members.length}{' '}
                  {members.length === 1 ? 'member' : 'members'}.
                </span>
                <form
                  method="post"
                  action={`/app/teams/${team.slug}/delete`}
                  class="m0"
                  data-confirm={`Every project, session, snapshot and the activity trail of ${team.name} is permanently deleted for all members. Personal tokens are not touched. This cannot be undone.`}
                  data-confirm-title={`Delete ${team.name}?`}
                  data-confirm-action="Delete team"
                >
                  <button class="btn btn-sm btn-danger" type="submit">
                    Delete team
                  </button>
                </form>
              </div>
            ) : null}
          </div>
          ) : null}
        </div>
      </div>
    </AppLayout>,
  );
});

// ------------------------------------------------------- membership lifecycle

dashboardRoutes.post('/app/teams/:slug/leave', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await teamForMember(db, c.req.param('slug'), user.id);
  if (!found) return c.notFound();
  if (found.role === 'owner' && (await ownerCount(db, found.team.id)) <= 1) {
    return c.redirect(
      `/app/teams/${found.team.slug}?error=${encodeURIComponent(
        'You are the only owner of this team. Delete the team instead, or make another member an owner first.',
      )}`,
    );
  }
  await db
    .delete(memberships)
    .where(and(eq(memberships.teamId, found.team.id), eq(memberships.userId, user.id)));
  await track(db, {
    teamId: found.team.id,
    userId: user.id,
    action: 'member_left',
    detail: `${user.username} left the team`,
  });
  return c.redirect(`/app?ok=${encodeURIComponent(`You left ${found.team.name}.`)}`);
});

/**
 * Promotion and demotion. Only owners may call it, and the team must always keep
 * at least one owner — checked against the database, not the rendered page, so a
 * stale tab or a hand-rolled POST cannot empty the role.
 */
dashboardRoutes.post('/app/teams/:slug/members/:userId/role', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await teamForMember(db, c.req.param('slug'), user.id);
  if (!found) return c.notFound();
  if (found.role !== 'owner') return c.text('Only team owners can change roles.', 403);
  const body = await c.req.parseBody();
  const role = body.role === 'owner' ? 'owner' : body.role === 'member' ? 'member' : null;
  if (!role) return c.notFound();
  const targetId = c.req.param('userId');
  if (!UUID_RE.test(targetId)) return c.notFound();
  const targetRows = await db
    .select({ username: users.username, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(and(eq(memberships.teamId, found.team.id), eq(memberships.userId, targetId)))
    .limit(1);
  const target = targetRows[0];
  if (!target) return c.notFound();
  const back = `/app/teams/${found.team.slug}`;
  if (target.role === role) return c.redirect(back);
  // Demoting the last owner — themselves or anyone else — would leave the team
  // with no one able to invite, remove, publish policy or delete it.
  if (role === 'member' && (await ownerCount(db, found.team.id)) <= 1) {
    return c.redirect(
      `${back}?error=${encodeURIComponent(
        'A team needs at least one owner. Make another member an owner first.',
      )}`,
    );
  }
  await db
    .update(memberships)
    .set({ role })
    .where(and(eq(memberships.teamId, found.team.id), eq(memberships.userId, targetId)));
  const self = targetId === user.id;
  await track(db, {
    teamId: found.team.id,
    userId: user.id,
    action: role === 'owner' ? 'member_promoted' : 'member_demoted',
    detail:
      role === 'owner'
        ? `${target.username} was made an owner by ${user.username}`
        : self
          ? `${user.username} stepped down to member`
          : `${target.username} was demoted to member by ${user.username}`,
  });
  const ok =
    role === 'owner'
      ? `${target.username} is now an owner.`
      : self
        ? `You are now a member of ${found.team.name}.`
        : `${target.username} is now a member.`;
  return c.redirect(`${back}?ok=${encodeURIComponent(ok)}`);
});

dashboardRoutes.post('/app/teams/:slug/members/:userId/remove', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await teamForMember(db, c.req.param('slug'), user.id);
  if (!found) return c.notFound();
  if (found.role !== 'owner') return c.text('Only team owners can remove members.', 403);
  const targetId = c.req.param('userId');
  if (!UUID_RE.test(targetId)) return c.notFound();
  if (targetId === user.id) {
    return c.redirect(
      `/app/teams/${found.team.slug}?error=${encodeURIComponent(
        'You cannot remove yourself. Leave the team or delete it instead.',
      )}`,
    );
  }
  const targetRows = await db
    .select({ username: users.username })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(and(eq(memberships.teamId, found.team.id), eq(memberships.userId, targetId)))
    .limit(1);
  const target = targetRows[0];
  if (!target) return c.notFound();
  await db
    .delete(memberships)
    .where(and(eq(memberships.teamId, found.team.id), eq(memberships.userId, targetId)));
  await track(db, {
    teamId: found.team.id,
    userId: user.id,
    action: 'member_removed',
    detail: `${target.username} was removed by ${user.username}`,
  });
  return c.redirect(
    `/app/teams/${found.team.slug}?ok=${encodeURIComponent(`${target.username} was removed from the team.`)}`,
  );
});

dashboardRoutes.post('/app/teams/:slug/delete', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await teamForMember(db, c.req.param('slug'), user.id);
  if (!found) return c.notFound();
  if (found.role !== 'owner') return c.text('Only team owners can delete a team.', 403);
  const teamId = found.team.id;
  // Explicit ordered deletes: children before the rows they reference, so the
  // wipe is correct regardless of FK cascade configuration.
  await db.transaction(async (tx) => {
    const teamSessionIds = tx
      .select({ id: debugSessions.id })
      .from(debugSessions)
      .where(eq(debugSessions.teamId, teamId));
    await tx.delete(readState).where(inArray(readState.sessionId, teamSessionIds));
    await tx.delete(messages).where(inArray(messages.sessionId, teamSessionIds));
    await tx.delete(debugSessions).where(eq(debugSessions.teamId, teamId));
    await tx.delete(snapshots).where(eq(snapshots.teamId, teamId));
    await tx.delete(activity).where(eq(activity.teamId, teamId));
    await tx.delete(invites).where(eq(invites.teamId, teamId));
    const teamRunIds = tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.teamId, teamId));
    await tx.delete(workClaims).where(inArray(workClaims.runId, teamRunIds));
    await tx.delete(agentEvents).where(inArray(agentEvents.runId, teamRunIds));
    await tx.delete(policyReceipts).where(inArray(policyReceipts.runId, teamRunIds));
    await tx.delete(agentRuns).where(eq(agentRuns.teamId, teamId));
    await tx.delete(policyBundles).where(eq(policyBundles.teamId, teamId));
    await tx.delete(environmentBaselines).where(eq(environmentBaselines.teamId, teamId));
    await tx.delete(projects).where(eq(projects.teamId, teamId));
    await tx.delete(memberships).where(eq(memberships.teamId, teamId));
    await tx.delete(teams).where(eq(teams.id, teamId));
  });
  return c.redirect(`/app?ok=${encodeURIComponent(`Team ${found.team.name} was deleted.`)}`);
});

dashboardRoutes.post('/app/teams/:slug/settings', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const env = c.get('env');
  const found = await teamForMember(db, c.req.param('slug'), user.id);
  if (!found || found.role !== 'owner') return c.notFound();
  const body = await c.req.parseBody();
  const raw = typeof body.webhook_url === 'string' ? body.webhook_url.trim().slice(0, 500) : '';
  if (raw && !isSafeWebhookUrl(raw, env.nodeEnv === 'production')) {
    return c.redirect(
      `/app/teams/${found.team.slug}?error=${encodeURIComponent('Webhook URL must be a public https:// address.')}`,
    );
  }
  await db.update(teams).set({ webhookUrl: raw || null }).where(eq(teams.id, found.team.id));
  return c.redirect(`/app/teams/${found.team.slug}`);
});

/**
 * Connect, test or disconnect the team's GitHub repository.
 *
 * "Test access" is a real request against the repository rather than a format
 * check: a token that cannot read the issues fails silently at exactly the
 * moment an agent needed it, and an owner deserves to learn that here.
 */
dashboardRoutes.post('/app/teams/:slug/integrations/github', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const env = c.get('env');
  const found = await teamForMember(db, c.req.param('slug'), user.id);
  if (!found || found.role !== 'owner') return c.notFound();
  const body = await c.req.parseBody();
  const action = typeof body.action === 'string' ? body.action : 'save';
  const slug = found.team.slug;
  const back = (query: string) => c.redirect(`/app/teams/${slug}?${query}`);
  const existing = await githubForTeam(db, found.team.id);

  if (action === 'remove') {
    await removeGithubIntegration(db, found.team.id);
    void track(db, {
      teamId: found.team.id,
      userId: user.id,
      action: 'integration_removed',
      detail: 'github',
    });
    return back(`ok=${encodeURIComponent('GitHub repository disconnected.')}`);
  }

  if (action === 'test') {
    if (!existing) return back(`error=${encodeURIComponent('Connect a repository first.')}`);
    const issues = await listOpenIssues(env, existing, 1);
    return issues.ok
      ? back(
          `ok=${encodeURIComponent(`${existing.repo} is reachable — ${issues.value.length > 0 ? `newest open issue is #${issues.value[0]!.number}` : 'nothing open right now'}.`)}`,
        )
      : back(
          `error=${encodeURIComponent(`GitHub refused the request (${issues.error}). Check the repository name and that the token can read its issues.`)}`,
        );
  }

  const repo = typeof body.repo === 'string' ? body.repo : '';
  // An empty token field on an existing connection means "keep the one you have" —
  // the field is a password input that never renders its value back.
  const typed = typeof body.token === 'string' ? body.token.trim() : '';
  const token = typed || existing?.token || '';
  const saved = await saveGithubIntegration(db, {
    teamId: found.team.id,
    userId: user.id,
    repo,
    token,
    commentOnFinish: typeof body.comment_on_finish === 'string' && body.comment_on_finish !== '',
  });
  if (!saved.ok) return back(`error=${encodeURIComponent(saved.error)}`);
  void track(db, {
    teamId: found.team.id,
    userId: user.id,
    action: 'integration_saved',
    detail: `github: ${saved.repo}`,
  });
  return back(
    `ok=${encodeURIComponent(`Connected to ${saved.repo}. Ask an agent to call list_issues to confirm.`)}`,
  );
});

/**
 * The Azure DevOps and Jira connections, same shape as GitHub's: owner-only,
 * empty token means keep the stored one, and the token never renders back.
 * A *new* provider counts against the plan's maxIntegrations; updating or
 * removing an existing one never does.
 */
async function integrationRoomFor(
  db: Db,
  hosted: boolean,
  teamId: string,
  plan: string | null,
  provider: 'azure-devops' | 'jira',
): Promise<string | null> {
  const existing = await integrationFor(db, teamId, provider);
  if (existing) return null;
  const allowance = planLimits(plan, hosted).maxIntegrations;
  if (allowance === null) return null;
  const used = await countIntegrations(db, teamId);
  if (used < allowance) return null;
  return `This team's ${plan ?? 'free'} plan connects ${allowance} provider${allowance === 1 ? '' : 's'} and ${used} ${used === 1 ? 'is' : 'are'} already connected. Disconnect one first, or upgrade.`;
}

dashboardRoutes.post('/app/teams/:slug/integrations/azure-devops', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const env = c.get('env');
  const found = await teamForMember(db, c.req.param('slug'), user.id);
  if (!found || found.role !== 'owner') return c.notFound();
  const body = await c.req.parseBody();
  const action = typeof body.action === 'string' ? body.action : 'save';
  // The same form lives on the team page and the delivery page (where the PAT
  // is needed at the moment of applying); come back to whichever sent it.
  const dest =
    body.return_to === 'delivery'
      ? `/app/teams/${found.team.slug}/delivery`
      : `/app/teams/${found.team.slug}`;
  const back = (query: string) => c.redirect(`${dest}?${query}`);
  const existing = await integrationFor(db, found.team.id, 'azure-devops');

  if (action === 'remove') {
    await removeIntegration(db, found.team.id, 'azure-devops');
    void track(db, { teamId: found.team.id, userId: user.id, action: 'integration_removed', detail: 'azure-devops' });
    return back(`ok=${encodeURIComponent('Azure DevOps disconnected.')}`);
  }
  if (action === 'test') {
    const config = await adoForTeam(db, found.team.id);
    if (!config) return back(`error=${encodeURIComponent('Connect Azure DevOps first.')}`);
    const health = await adoHealth(env, config);
    // The verdict is stored, not just flashed: the delivery page shows the
    // connection's last known state next to the Apply button.
    await saveIntegration(db, {
      teamId: found.team.id,
      userId: user.id,
      provider: 'azure-devops',
      locator: adoLocator(config),
      token: config.token,
      config: { lastCheck: health },
    });
    return health.ok
      ? back(
          `ok=${encodeURIComponent(
            health.empty
              ? `${adoLocator(config)} is reachable. The repository is empty — applying a flow will create the branch with the pipeline file as its first commit.`
              : `${adoLocator(config)} is reachable — default branch ${health.defaultBranch}.`,
          )}`,
        )
      : back(`error=${encodeURIComponent(describeAdoFailure(health.error ?? 'request_failed'))}`);
  }

  const parsed = parseAdoLocator(typeof body.locator === 'string' ? body.locator : '');
  if (!parsed) {
    return back(
      `error=${encodeURIComponent('The repository must look like organization/project/repo — all three, or a pasted dev.azure.com URL.')}`,
    );
  }
  const typed = typeof body.token === 'string' ? body.token.trim() : '';
  const token = typed || existing?.token || '';
  if (!token) return back(`error=${encodeURIComponent('A personal access token is required.')}`);
  const full = await integrationRoomFor(db, env.hosted, found.team.id, found.team.plan, 'azure-devops');
  if (full) return back(`error=${encodeURIComponent(full)}`);
  // Verify at the moment of saving — a connection that fails three days later
  // at apply time is this exact check, deferred to the worst moment. A failed
  // check still saves (retyping a 90-character locator is the wrong penance);
  // the message and the stored health say plainly what is wrong.
  const health = await adoHealth(env, { ...parsed, token });
  await saveIntegration(db, {
    teamId: found.team.id,
    userId: user.id,
    provider: 'azure-devops',
    locator: adoLocator(parsed),
    token,
    config: { lastCheck: health },
  });
  void track(db, {
    teamId: found.team.id,
    userId: user.id,
    action: 'integration_saved',
    detail: `azure-devops: ${adoLocator(parsed)} (${health.ok ? 'verified' : health.error})`,
  });
  if (!health.ok) {
    return back(
      `error=${encodeURIComponent(`Saved, but the connection check failed. ${describeAdoFailure(health.error ?? 'request_failed')}`)}`,
    );
  }
  return back(
    `ok=${encodeURIComponent(
      health.empty
        ? `Connected to ${adoLocator(parsed)} and verified. The repository is empty — applying a flow will create the branch with the pipeline file as its first commit.`
        : `Connected to ${adoLocator(parsed)} and verified — default branch ${health.defaultBranch}. Apply a delivery flow when ready.`,
    )}`,
  );
});

dashboardRoutes.post('/app/teams/:slug/integrations/jira', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const env = c.get('env');
  const found = await teamForMember(db, c.req.param('slug'), user.id);
  if (!found || found.role !== 'owner') return c.notFound();
  const body = await c.req.parseBody();
  const action = typeof body.action === 'string' ? body.action : 'save';
  const back = (query: string) => c.redirect(`/app/teams/${found.team.slug}?${query}`);
  const existing = await integrationFor(db, found.team.id, 'jira');

  if (action === 'remove') {
    await removeIntegration(db, found.team.id, 'jira');
    void track(db, { teamId: found.team.id, userId: user.id, action: 'integration_removed', detail: 'jira' });
    return back(`ok=${encodeURIComponent('Jira disconnected.')}`);
  }
  if (action === 'test') {
    const config = await jiraForTeam(db, found.team.id);
    if (!config) return back(`error=${encodeURIComponent('Connect Jira first.')}`);
    const check = await checkJiraConnection(env, config);
    await saveIntegration(db, {
      teamId: found.team.id,
      userId: user.id,
      provider: 'jira',
      locator: config.site,
      token: config.token,
      config: {
        email: config.email,
        // Which API door answered: a scoped token's cloudId is remembered so
        // issue reads go straight there instead of re-failing the site door.
        ...(check.ok && check.value.cloudId ? { cloudId: check.value.cloudId } : {}),
        lastCheck: { ok: check.ok, at: new Date().toISOString(), ...(check.ok ? {} : { error: check.error }) },
      },
    });
    return check.ok
      ? back(
          `ok=${encodeURIComponent(
            `${config.site} answered — the token belongs to ${check.value.displayName}.${check.value.cloudId ? ' (Scoped token detected; calls route via api.atlassian.com.)' : ''}`,
          )}`,
        )
      : back(`error=${encodeURIComponent(describeJiraFailure(check.error, config.token))}`);
  }

  const site = normalizeJiraSite(typeof body.site === 'string' ? body.site : '');
  if (!site) {
    return back(
      `error=${encodeURIComponent('The site must be a *.atlassian.net host, like acme.atlassian.net.')}`,
    );
  }
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!email.includes('@')) return back(`error=${encodeURIComponent('The Atlassian account email is required.')}`);
  const typed = typeof body.token === 'string' ? body.token.trim() : '';
  const token = typed || existing?.token || '';
  if (!token) return back(`error=${encodeURIComponent('An API token is required.')}`);
  const full = await integrationRoomFor(db, env.hosted, found.team.id, found.team.plan, 'jira');
  if (full) return back(`error=${encodeURIComponent(full)}`);
  // Same rule as Azure DevOps: verify while the person is still at the form.
  const check = await checkJiraConnection(env, { site, email, token });
  await saveIntegration(db, {
    teamId: found.team.id,
    userId: user.id,
    provider: 'jira',
    locator: site,
    token,
    config: {
      email,
      ...(check.ok && check.value.cloudId ? { cloudId: check.value.cloudId } : {}),
      lastCheck: { ok: check.ok, at: new Date().toISOString(), ...(check.ok ? {} : { error: check.error }) },
    },
  });
  void track(db, {
    teamId: found.team.id,
    userId: user.id,
    action: 'integration_saved',
    detail: `jira: ${site} (${check.ok ? 'verified' : check.error})`,
  });
  if (!check.ok) {
    return back(
      `error=${encodeURIComponent(`Saved, but the connection check failed. ${describeJiraFailure(check.error, token)}`)}`,
    );
  }
  return back(
    `ok=${encodeURIComponent(
      `Connected to ${site} and verified — the token belongs to ${check.value.displayName}.${check.value.cloudId ? ' (Scoped token detected; calls route via api.atlassian.com.)' : ''}`,
    )}`,
  );
});

dashboardRoutes.post('/app/teams/:slug/inbound-token', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await teamForMember(db, c.req.param('slug'), user.id);
  if (!found || found.role !== 'owner') return c.notFound();
  await db
    .update(teams)
    .set({ inboundToken: randomCode(16) })
    .where(eq(teams.id, found.team.id));
  return c.redirect(`/app/teams/${found.team.slug}`);
});

dashboardRoutes.post('/app/teams/:slug/invites', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await teamForMember(db, c.req.param('slug'), user.id);
  if (!found) return c.notFound();
  await db.insert(invites).values({
    teamId: found.team.id,
    code: randomCode(9),
    createdBy: user.id,
    expiresAt: new Date(Date.now() + 7 * DAY),
  });
  return c.redirect(`/app/teams/${found.team.slug}`);
});

dashboardRoutes.post('/app/teams/:slug/invites/:id/revoke', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await teamForMember(db, c.req.param('slug'), user.id);
  if (!found) return c.notFound();
  await db
    .update(invites)
    .set({ expiresAt: new Date() })
    .where(and(eq(invites.id, c.req.param('id')), eq(invites.teamId, found.team.id)));
  return c.redirect(`/app/teams/${found.team.slug}`);
});

// ---------------------------------------------------------------- join

dashboardRoutes.get('/join/:code', async (c) => {
  const code = c.req.param('code');
  const user = c.get('user');
  if (!user) return c.redirect(`/login?next=${encodeURIComponent(`/join/${code}`)}`);
  const db = c.get('db');
  const row = await validInvite(db, code);
  if (!row) {
    return c.html(
      <AppLayout user={user} title="Invite">
        <div class="card card-pad joincard">
          <span class="overline">Team invitation</span>
          <span class="tile tile-44 tile-gray" style="font:500 20px/1 var(--sans)">
            ×
          </span>
          <h2 class="title m0" style="font-size:20px">
            This invite link is no longer valid
          </h2>
          <p class="m0" style="color:var(--txt-2)">
            It expired, was revoked, or has been used the maximum number of times. Ask a team owner
            for a fresh link.
          </p>
          <a class="btn" href="/app" style="align-self:flex-start">
            Back to teams
          </a>
        </div>
      </AppLayout>,
      404,
    );
  }
  const already = await teamForMember(db, row.team.slug, user.id);
  if (already) return c.redirect(`/app/teams/${row.team.slug}`);
  const memberCount =
    (await db.select({ n: count() }).from(memberships).where(eq(memberships.teamId, row.team.id)))[0]
      ?.n ?? 0;
  const creator = row.invite.createdBy
    ? (
        await db
          .select({ username: users.username })
          .from(users)
          .where(eq(users.id, row.invite.createdBy))
          .limit(1)
      )[0]?.username
    : undefined;

  return c.html(
    <AppLayout user={user} title="Join team">
      <div class="card card-pad joincard">
        <span class="overline">Team invitation</span>
        <div class="join-team">
          <span class="tile tile-44 tile-green">{initials(row.team.name)}</span>
          <div>
            <div class="join-name">{row.team.name}</div>
            <div class="mono muted">
              {row.team.slug} · {memberCount} {memberCount === 1 ? 'member' : 'members'}
            </div>
          </div>
        </div>
        <p class="m0" style="color:var(--txt-2)">
          {creator ? `${creator} invited you` : 'You were invited'} to join as a{' '}
          <b style="color:var(--ink)">member</b>. You'll be able to share environment snapshots and
          join debug sessions with this team.
        </p>
        <div class="row">
          <form method="post" action={`/join/${code}`} class="m0">
            <button class="btn btn-primary" type="submit">
              Join team
            </button>
          </form>
          <a class="btn" href="/app">
            Decline
          </a>
        </div>
        <span class="mono muted small">
          Link expires {fmtDate(row.invite.expiresAt)} · used {row.invite.uses}
          {row.invite.maxUses != null ? ` of ${row.invite.maxUses}` : ''} times
        </span>
      </div>
    </AppLayout>,
  );
});

dashboardRoutes.post('/join/:code', async (c) => {
  const code = c.req.param('code');
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const row = await validInvite(db, code);
  if (!row) return c.redirect(`/join/${code}`);
  const already = await teamForMember(db, row.team.slug, user.id);
  if (!already) {
    const memberCountRows = await db
      .select({ n: count() })
      .from(memberships)
      .where(eq(memberships.teamId, row.team.id));
    if ((memberCountRows[0]?.n ?? 0) >= planLimits(row.team.plan).maxMembers) {
      return c.redirect(
        `/app?error=${encodeURIComponent(`Team member limit reached (${planLimits(row.team.plan).maxMembers} on the ${row.team.plan} plan).`)}`,
      );
    }
  }
  const inserted = await db
    .insert(memberships)
    .values({ teamId: row.team.id, userId: user.id, role: 'member' })
    .onConflictDoNothing()
    .returning();
  if (inserted.length > 0) {
    await db
      .update(invites)
      .set({ uses: sql`${invites.uses} + 1` })
      .where(eq(invites.id, row.invite.id));
    await notifyTeamJoined(db, c.get('env'), { teamId: row.team.id, userId: user.id });
  }
  return c.redirect(`/app/teams/${row.team.slug}`);
});

// ---------------------------------------------------------------- tokens

const TokensPage = (props: {
  devices: Map<string, string>;
  user: User;
  list: (typeof tokens.$inferSelect)[];
  newToken?: string;
  baseUrl: string;
  /** Email confirmation is on: the password change needs a code from the inbox. */
  confirmByEmail?: boolean;
  error?: string;
  notice?: string;
}) => {
  const { user, list, devices, newToken, baseUrl, confirmByEmail, error, notice } = props;
  const tokenValue = newToken ?? 'stma_YOUR_TOKEN';
  const claudeCmd = connectCmd(baseUrl, tokenValue);
  const tryCmd = 'Ask your agent to call the whoami tool — it should reply with your username and teams.';
  const cursorJson = JSON.stringify(
    {
      mcpServers: {
        stma: {
          url: `${baseUrl}/mcp`,
          headers: { Authorization: `Bearer ${tokenValue}` },
        },
      },
    },
    null,
    2,
  );
  return (
    <AppLayout user={user} active="tokens" title="Tokens">
      {error ? <Banner kind="error" text={error} /> : null}
      {notice ? <Banner kind="success" text={notice} /> : null}
      <PageHead
        title="Personal access tokens"
        sub="One token per machine keeps snapshots attributable and easy to revoke. Account settings moved to their own page."
        actions={
          <form class="inline m0" method="post" action="/app/tokens">
            <input
              class="in"
              style="width:200px"
              type="text"
              name="name"
              placeholder="e.g. work-laptop"
            />
            <button class="btn btn-primary" type="submit">
              New token
            </button>
          </form>
        }
      />

      {newToken ? (
        <div class="reveal">
          <div class="reveal-head">
            <span class="ic">✓</span>
            <div>
              <div class="reveal-title">Token created</div>
              <div class="reveal-sub">Copy it now — this is the only time it will be shown.</div>
            </div>
          </div>
          <div class="reveal-row">
            <div class="tokenbox">{newToken}</div>
            <button class="copybtn solid" type="button" data-copy={newToken}>
              Copy token
            </button>
          </div>
        </div>
      ) : null}

      {list.length === 0 ? (
        <div class="card">
          <div class="empty">
            <h2>No tokens yet</h2>
            <p>
              Your agent needs one token to reach the bridge. It takes about a minute — create one
              above, then paste the connect block below into your agent.
            </p>
          </div>
        </div>
      ) : (
        <div class="card scroll-x">
          <table class="tbl">
            <tr>
              <th>Name</th>
              <th>Token</th>
              <th class="hide-sm">Machine it reports as</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Status</th>
              <th></th>
            </tr>
            {list.map((t) => (
              <tr style={t.revokedAt ? 'color:var(--mut-2)' : ''}>
                <td class="name">{t.name}</td>
                <td class="mono">{t.prefix}••••••••</td>
                <td class="mono muted hide-sm">
                  {/* Not the token's name — the device label the snapshots it pushed
                      carry. The two differ the moment somebody renames a token, and
                      the one that matters for a diff is this one. */}
                  {devices.get(t.id) ?? 'not yet'}
                </td>
                <td class="muted">{fmtDate(t.createdAt)}</td>
                <td class="muted">{timeAgo(t.lastUsedAt) ?? '—'}</td>
                <td>
                  {t.revokedAt ? (
                    <span class="pill pill-muted">
                      <span class="dot gray" />
                      revoked
                    </span>
                  ) : (
                    <span class="pill pill-active">
                      <span class="dot" />
                      active
                    </span>
                  )}
                </td>
                <td style="text-align:right">
                  {t.revokedAt ? null : (
                    <form
                      class="m0"
                      method="post"
                      action={`/app/tokens/${t.id}/revoke`}
                      data-confirm={`The agent using "${t.name}" loses access immediately and stops pushing snapshots. Existing snapshots and sessions are kept.`}
                      data-confirm-title={`Revoke "${t.name}"?`}
                      data-confirm-action="Revoke token"
                    >
                      <button class="linklike" type="submit">
                        Revoke
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </table>
        </div>
      )}

      <div class="card">
        <div style="padding:16px 18px 0;display:flex;flex-direction:column;gap:14px">
          <div>
            <div class="card-title">Connect your agent</div>
            <div class="card-note">
              Paste the block for the tool you use. Treat the token like a password — it never
              belongs in the repo.
            </div>
          </div>
          <div class="tabs" data-tabs="t">
            <button class="tab active" type="button" data-tab="claude">
              Claude Code
            </button>
            <button class="tab" type="button" data-tab="cursor">
              Cursor
            </button>
            <button class="tab" type="button" data-tab="other">
              Other MCP client
            </button>
          </div>
        </div>
        <div class="card-pad">
          <div data-tab-panel="claude" class="active">
            <div class="step">
              <span class="steplabel">1 · Add the bridge</span>
              <div class="cmd">
                <code>{claudeCmd}</code>
                <button class="copybtn" type="button" data-copy={claudeCmd}>
                  COPY
                </button>
              </div>
            </div>
            <div class="step">
              <span class="steplabel">2 · Try it</span>
              <p class="m0 small" style="color:var(--txt-3)">
                {tryCmd}
              </p>
            </div>
          </div>
          <div data-tab-panel="cursor">
            <div class="step">
              <span class="steplabel">Add to ~/.cursor/mcp.json</span>
              <div class="cmd">
                <code>{cursorJson}</code>
                <button class="copybtn" type="button" data-copy={cursorJson}>
                  COPY
                </button>
              </div>
            </div>
          </div>
          <div data-tab-panel="other">
            <div class="step">
              <span class="steplabel">Streamable HTTP endpoint</span>
              <div class="cmd">
                <code>{`${baseUrl}/mcp`}</code>
                <button class="copybtn" type="button" data-copy={`${baseUrl}/mcp`}>
                  COPY
                </button>
              </div>
            </div>
            <div class="step">
              <span class="steplabel">Authorization header</span>
              <div class="cmd">
                <code>{`Authorization: Bearer ${tokenValue}`}</code>
                <button class="copybtn" type="button" data-copy={`Authorization: Bearer ${tokenValue}`}>
                  COPY
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="card card-pad" style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap">
        <div>
          <div class="card-title">Everything else about you</div>
          <div class="card-note">
            This page is machines. Your password and the end of the road live on Account; what
            STMA emails you lives on Notifications.
          </div>
        </div>
        <div class="acts">
          <a class="btn" href="/app/account">
            Account
          </a>
          <a class="btn" href="/app/notifications">
            Notifications
          </a>
        </div>
      </div>
    </AppLayout>
  );
};


// ---------------------------------------------------------------- account

const AccountPage = (props: {
  user: User;
  confirmByEmail: boolean;
  error?: string;
  notice?: string;
}) => {
  const { user, confirmByEmail, error, notice } = props;
  return (
    <AppLayout user={user} active="account" title="Account">
      {error ? <Banner kind="error" text={error} /> : null}
      {notice ? <Banner kind="success" text={notice} /> : null}
      <PageHead
        crumb="/ account"
        title="Account"
        sub="Your sign-in and the end of the road. Tokens live on their own page, one per machine."
      />
      {user.passwordHash ? (
        <div class="card card-pad" style="display:flex;flex-direction:column;gap:14px">
          <div>
            <div class="card-title">Account</div>
            <div class="card-note">
              Change the password for <b>{user.email ?? user.username}</b>. Other signed-in browser
              sessions are signed out; agent tokens keep working.
            </div>
          </div>
          {confirmByEmail ? (
            <form class="inline m0" method="post" action="/app/account/password/code">
              <button class="btn" type="submit">
                Email me a confirmation code
              </button>
              <span class="help">
                Required to change the password. The code is valid for {CODE_TTL_MINUTES} minutes.
              </span>
            </form>
          ) : null}
          <form class="authform" method="post" action="/app/account/password" style="max-width:360px">
            <div class="field">
              <label>Current password</label>
              <input
                class="in"
                type="password"
                name="current_password"
                autocomplete="current-password"
                required
              />
            </div>
            <div class="field">
              <label>New password</label>
              <input
                class="in"
                type="password"
                name="new_password"
                autocomplete="new-password"
                minlength={8}
                required
              />
              <span class="help">At least 8 characters.</span>
            </div>
            <div class="field">
              <label>Repeat new password</label>
              <input
                class="in"
                type="password"
                name="new_password_confirm"
                autocomplete="new-password"
                minlength={8}
                required
              />
            </div>
            {confirmByEmail ? (
              <div class="field">
                <label>Confirmation code</label>
                <input
                  class="in"
                  type="text"
                  name="code"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxlength={6}
                  placeholder="000000"
                  required
                />
                <span class="help">The 6 digits we emailed you.</span>
              </div>
            ) : null}
            <button class="btn btn-primary" type="submit" style="align-self:flex-start">
              Change password
            </button>
          </form>
        </div>
      ) : null}

      <div class="card card-pad" style="display:flex;flex-direction:column;gap:12px">
        <div>
          <div class="card-title">Danger zone</div>
          <div class="card-note">
            Deleting your account signs you out everywhere, revokes all tokens and removes you from
            every team. Messages and snapshots you shared stay with their teams, attributed to a
            deleted account.
          </div>
        </div>
        <form
          method="post"
          action="/app/account/delete"
          class="m0"
          data-confirm="All your browser sessions, personal tokens, agent registrations and team memberships are removed and your username is scrubbed. Content you shared with teams stays. This cannot be undone."
          data-confirm-title="Delete your account?"
          data-confirm-action="Delete account"
        >
          <button class="btn btn-danger" type="submit" style="align-self:flex-start">
            Delete account
          </button>
        </form>
      </div>
    </AppLayout>
  );
};

dashboardRoutes.get('/app/account', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  return c.html(
    <AccountPage
      user={user}
      confirmByEmail={c.get('env').twoFactor}
      error={c.req.query('error')}
      notice={c.req.query('ok')}
    />,
  );
});

dashboardRoutes.get('/app/tokens', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const list = await db
    .select()
    .from(tokens)
    .where(eq(tokens.userId, user.id))
    .orderBy(desc(tokens.createdAt));
  // What each token reports as, from the snapshots it actually pushed. Bounded by
  // this person's own tokens, and grouped rather than fetched row by row.
  const devices = new Map<string, string>();
  if (list.length > 0) {
    for (const row of await db
      .select({ tokenId: snapshots.tokenId, label: max(snapshots.deviceLabel) })
      .from(snapshots)
      .where(
        inArray(
          snapshots.tokenId,
          list.map((t) => t.id),
        ),
      )
      .groupBy(snapshots.tokenId)) {
      if (row.tokenId && row.label) devices.set(row.tokenId, row.label);
    }
  }
  return c.html(
    <TokensPage
      user={user}
      list={list}
      devices={devices}
      baseUrl={c.get('env').baseUrl}
      confirmByEmail={c.get('env').twoFactor}
      error={c.req.query('error')}
      notice={c.req.query('ok')}
    />,
  );
});

dashboardRoutes.post('/app/tokens', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const body = await c.req.parseBody();
  const name =
    typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 60) : 'token';
  const pat = generatePat();
  await db.insert(tokens).values({ userId: user.id, name, tokenHash: pat.hash, prefix: pat.prefix });
  const list = await db
    .select()
    .from(tokens)
    .where(eq(tokens.userId, user.id))
    .orderBy(desc(tokens.createdAt));
  // The token is shown once, so this POST answers with a page rather than a
  // redirect — and a page draws the rail.
  await ensureRail(db, user);
  return c.html(
    <TokensPage
      user={user}
      list={list}
      // A token minted a second ago has pushed nothing, so nothing to look up.
      devices={new Map()}
      newToken={pat.token}
      baseUrl={c.get('env').baseUrl}
      confirmByEmail={c.get('env').twoFactor}
    />,
  );
});

dashboardRoutes.post('/app/tokens/:id/revoke', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  await db
    .update(tokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(tokens.id, c.req.param('id')), eq(tokens.userId, user.id)));
  return c.redirect('/app/tokens');
});

// ---------------------------------------------------------------- account

const accountBack = (c: Context<AppEnv>, msg: string, ok = false) =>
  c.redirect(`/app/tokens?${ok ? 'ok' : 'error'}=${encodeURIComponent(msg)}`);

/** Email a fresh password-change code to the signed-in account. */
dashboardRoutes.post('/app/account/password/code', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const env = c.get('env');
  if (!env.twoFactor) return accountBack(c, 'This server does not use email confirmation codes.');
  if (!user.passwordHash) return accountBack(c, 'This account has no password to change.');
  if (!user.email) {
    return accountBack(
      c,
      'Your account has no email address yet — ask an operator to set one before changing the password.',
    );
  }
  const issued = await issueAuthCode(c.get('db'), user.id, 'password_change');
  if (!issued.ok) {
    return accountBack(c, 'Too many codes requested. Wait a few minutes, then try again.');
  }
  const sent = await sendMail(env, {
    to: user.email,
    ...passwordChangeCodeEmail(issued.code, CODE_TTL_MINUTES),
  });
  if (!sent.ok) {
    logLine({ evt: 'auth', a: 'pwchange_code_fail', u: user.username, why: sent.error });
    return accountBack(c, 'We could not email the confirmation code. Try again in a minute.');
  }
  logLine({ evt: 'auth', a: 'pwchange_code', u: user.username });
  return accountBack(c, `Code sent. It is valid for ${CODE_TTL_MINUTES} minutes.`, true);
});

dashboardRoutes.post('/app/account/password', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const env = c.get('env');
  const db = c.get('db');
  const back = (msg: string, ok = false) => accountBack(c, msg, ok);
  if (!user.passwordHash) return back('This account has no password to change.');
  const body = await c.req.parseBody();
  const current = typeof body.current_password === 'string' ? body.current_password : '';
  const next = typeof body.new_password === 'string' ? body.new_password : '';
  const confirm = typeof body.new_password_confirm === 'string' ? body.new_password_confirm : '';
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!(await verifyPassword(current, user.passwordHash))) {
    return back('Current password is incorrect.');
  }
  if (next.length < 8 || next.length > 128) return back('New password must be 8-128 characters.');
  if (next !== confirm) return back('New passwords do not match.');

  // Same second factor as sign-in: knowing the current password is not enough.
  if (env.twoFactor) {
    if (!user.email) {
      return back(
        'Your account has no email address yet — ask an operator to set one before changing the password.',
      );
    }
    if (!/^\d{6}$/.test(code)) {
      return back('Enter the 6-digit code we emailed you — request one with "Email me a confirmation code".');
    }
    const result = await checkUserCode(db, user.id, 'password_change', code);
    if (result.status === 'invalid') {
      return back(
        `That code is not right. ${result.attemptsLeft} attempt${result.attemptsLeft === 1 ? '' : 's'} left.`,
      );
    }
    if (result.status !== 'ok') {
      logLine({ evt: 'auth', a: 'pwchange_code_bad', u: user.username, why: result.status });
      return back('That code has expired or was already used. Request a new one.');
    }
  }

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(next) })
    .where(eq(users.id, user.id));
  await invalidateOtherSessions(c, user.id);
  logLine({ evt: 'auth', a: 'pwchange', u: user.username });
  if (user.email) {
    // Best effort: the change already happened, so a failed notice must not undo it.
    void sendMail(env, { to: user.email, ...passwordChangedEmail(env.baseUrl) });
  }
  return back('Password updated. Other browser sessions were signed out.', true);
});

dashboardRoutes.post('/app/account/delete', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const back = (msg: string) => c.redirect(`/app/tokens?error=${encodeURIComponent(msg)}`);

  const ownedTeams = await db
    .select({ teamId: memberships.teamId, name: teams.name })
    .from(memberships)
    .innerJoin(teams, eq(memberships.teamId, teams.id))
    .where(and(eq(memberships.userId, user.id), eq(memberships.role, 'owner')));
  const blocking: string[] = [];
  for (const owned of ownedTeams) {
    if ((await ownerCount(db, owned.teamId)) <= 1) blocking.push(owned.name);
  }
  if (blocking.length > 0) {
    return back(
      `You are the only owner of: ${blocking.join(', ')}. Delete those teams or hand them to another owner first.`,
    );
  }

  const activeRunRows = await db
    .select({ n: count() })
    .from(agentRuns)
    .innerJoin(agentInstallations, eq(agentRuns.installationId, agentInstallations.id))
    .where(
      and(
        eq(agentInstallations.userId, user.id),
        inArray(agentRuns.status, [...ACTIVE_AGENT_RUN_STATUSES]),
      ),
    );
  if ((activeRunRows[0]?.n ?? 0) > 0) {
    return back('You still have active agent runs. Finish or stop them before deleting the account.');
  }

  // Soft deletion: the user row is scrubbed, not removed — messages.authorId,
  // debug_sessions.opened_by and teams/projects/invites.created_by reference
  // users without a cascade, and snapshots would be cascade-deleted. Scrubbing
  // keeps every authored row and page join intact.
  await db.transaction(async (tx) => {
    await tx.delete(webSessions).where(eq(webSessions.userId, user.id));
    await tx
      .update(tokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(tokens.userId, user.id), isNull(tokens.revokedAt)));
    await tx.delete(readState).where(eq(readState.userId, user.id));
    await tx.delete(memberships).where(eq(memberships.userId, user.id));
    const myInstallIds = tx
      .select({ id: agentInstallations.id })
      .from(agentInstallations)
      .where(eq(agentInstallations.userId, user.id));
    const myRunIds = tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(inArray(agentRuns.installationId, myInstallIds));
    await tx.delete(workClaims).where(inArray(workClaims.runId, myRunIds));
    await tx.delete(agentEvents).where(inArray(agentEvents.runId, myRunIds));
    await tx.delete(policyReceipts).where(inArray(policyReceipts.runId, myRunIds));
    await tx.delete(agentRuns).where(inArray(agentRuns.installationId, myInstallIds));
    await tx.delete(agentInstallations).where(eq(agentInstallations.userId, user.id));
    await tx
      .update(users)
      .set({
        username: `deleted-${user.id}`,
        passwordHash: null,
        githubId: null,
        displayName: null,
        email: null,
        avatarUrl: null,
      })
      .where(eq(users.id, user.id));
  });
  await destroySession(c);
  return c.redirect('/');
});
