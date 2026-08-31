import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, count, eq, gt, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { invites, memberships, messages, teams, tokens, users } from '../db/schema';
import { generatePat } from '../auth/pat';
import { recordRunOutcome } from '../domain/agents';
import { hashPassword, verifyPassword } from '../lib/crypto';
import { emailIsFree, isEmail, maskEmail, normalizeEmail, usernameFromEmail } from '../lib/email';
import { planLimits } from '../lib/entitlements';
import { logLine } from '../lib/log';
import { notifyTeam } from '../lib/notify';
import { notifyAnnouncement, notifyTeamJoined } from '../lib/notifications';
import { redactSecrets } from '../lib/redact';
import { getAnnouncementsSession } from '../lib/sessions';
import { track } from '../lib/track';
import type { AppEnv } from '../types';

export const apiRoutes = new Hono<AppEnv>();

/**
 * Terminal-first onboarding: redeem an invite code with an email+password and
 * receive a personal access token — no browser involved. Creates the account
 * when the email is new; verifies the password when it already exists.
 */
apiRoutes.post('/api/invites/redeem', async (c) => {
  const env = c.get('env');
  if (!env.localAuth) return c.json({ error: 'local accounts are disabled on this server' }, 403);

  let body: { code?: unknown; email?: unknown; password?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'send JSON: {"code","email","password"}' }, 400);
  }
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!code) return c.json({ error: 'missing invite code' }, 400);
  if (!isEmail(email)) return c.json({ error: 'email must be a valid address' }, 400);
  if (password.length < 8 || password.length > 128) {
    return c.json({ error: 'password must be 8-128 characters' }, 400);
  }

  const db = c.get('db');
  const inviteRows = await db
    .select({ invite: invites, team: teams })
    .from(invites)
    .innerJoin(teams, eq(invites.teamId, teams.id))
    .where(and(eq(invites.code, code), gt(invites.expiresAt, new Date())))
    .limit(1);
  const row = inviteRows[0];
  if (!row || (row.invite.maxUses != null && row.invite.uses >= row.invite.maxUses)) {
    logLine({ evt: 'auth', a: 'redeem_fail', em: maskEmail(email), why: 'bad_code' });
    return c.json({ error: 'invite code is invalid, expired or used up' }, 404);
  }

  const existingRows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  let user = existingRows[0];
  if (user) {
    if (!user.passwordHash) {
      logLine({ evt: 'auth', a: 'redeem_fail', u: user.username, why: 'passwordless_account' });
      return c.json(
        { error: 'that email belongs to an account without a password — join via the web instead' },
        409,
      );
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      logLine({ evt: 'auth', a: 'redeem_fail', u: user.username, why: 'wrong_password' });
      return c.json({ error: 'wrong password for existing user' }, 401);
    }
  } else {
    if (!(await emailIsFree(db, email))) {
      return c.json({ error: 'that email is already registered' }, 409);
    }
    try {
      const inserted = await db
        .insert(users)
        .values({
          username: await usernameFromEmail(db, email),
          email,
          passwordHash: await hashPassword(password),
        })
        .returning();
      user = inserted[0]!;
    } catch {
      return c.json({ error: 'that email is already registered' }, 409);
    }
  }
  const username = user.username;

  const already = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.teamId, row.team.id), eq(memberships.userId, user.id)))
    .limit(1);
  if (already.length === 0) {
    const [{ n }] = await db
      .select({ n: count() })
      .from(memberships)
      .where(eq(memberships.teamId, row.team.id));
    if (n >= planLimits(row.team.plan).maxMembers) {
      return c.json(
        { error: `team member limit reached (${planLimits(row.team.plan).maxMembers} on the ${row.team.plan} plan)` },
        403,
      );
    }
  }
  const joined = await db
    .insert(memberships)
    .values({ teamId: row.team.id, userId: user.id, role: 'member' })
    .onConflictDoNothing()
    .returning();
  if (joined.length > 0) {
    await db
      .update(invites)
      .set({ uses: sql`${invites.uses} + 1` })
      .where(eq(invites.id, row.invite.id));
    // Terminal onboarding: the agent got the token, but this is often the only
    // thing that tells the human their account now exists and where it lives.
    await notifyTeamJoined(db, env, { teamId: row.team.id, userId: user.id });
  }

  const pat = generatePat();
  await db.insert(tokens).values({
    userId: user.id,
    name: `${username}-cli`,
    tokenHash: pat.hash,
    prefix: pat.prefix,
  });

  logLine({ evt: 'auth', a: 'redeem', u: username, team: row.team.slug });
  void track(db, { teamId: row.team.id, userId: user.id, action: 'member_joined', detail: username });
  const mcpUrl = `${env.baseUrl}/mcp`;
  return c.json({
    ok: true,
    username,
    email,
    team: { slug: row.team.slug, name: row.team.name },
    token: pat.token,
    note: 'Store this token like a password — it is shown only once.',
    connect: {
      claudeCode: `claude mcp add --scope user --transport http stma ${mcpUrl} --header "Authorization: Bearer ${pat.token}"`,
      cursor: {
        mcpServers: { stma: { url: mcpUrl, headers: { Authorization: `Bearer ${pat.token}` } } },
      },
      firstSteps: 'Call whoami, then get_snapshot_checklist → push_snapshot. Check inbox for open debug sessions.',
    },
  });
});

// ---------------------------------------------------------------- inbound hooks

async function teamByInboundToken(c: Context<AppEnv>) {
  const token = c.req.param('token') ?? '';
  if (!token) return undefined;
  const rows = await c
    .get('db')
    .select()
    .from(teams)
    .where(eq(teams.inboundToken, token))
    .limit(1);
  return rows[0];
}

async function postAnnouncement(
  c: Context<AppEnv>,
  team: typeof teams.$inferSelect,
  via: string,
  body: string,
) {
  const db = c.get('db');
  const channel = await getAnnouncementsSession(db, team.id, null);
  const posted = await db
    .insert(messages)
    .values({
      sessionId: channel.id,
      authorId: null,
      kind: 'announcement',
      via,
      body: redactSecrets(body.slice(0, 2000)),
    })
    .returning({ at: messages.createdAt });
  await notifyAnnouncement(db, c.get('env'), {
    sessionId: channel.id,
    teamId: team.id,
    actorId: null,
    at: posted[0]!.at,
  });
  notifyTeam(c.get('env'), team, `Announcement in ${team.slug}: ${body.slice(0, 140)}`);
  void track(db, { teamId: team.id, action: 'announce', detail: `${via}: ${body.slice(0, 140)}` });
}

/** Generic CI hook: POST {"text": "...", "repo": "optional"} */
apiRoutes.post('/api/hooks/announce/:token', async (c) => {
  const team = await teamByInboundToken(c);
  if (!team) return c.json({ error: 'unknown hook token' }, 404);
  let body: { text?: unknown; repo?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'send JSON: {"text","repo?"}' }, 400);
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return c.json({ error: 'missing text' }, 400);
  const repo = typeof body.repo === 'string' && body.repo.trim() ? `[${body.repo.trim()}] ` : '';
  await postAnnouncement(c, team, 'hook', `${repo}${text}`);
  return c.json({ ok: true });
});

/** Timing-safe check of GitHub's `X-Hub-Signature-256: sha256=<hex>` header. */
function validGithubSignature(rawBody: string, header: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(header.replace(/^sha256=/, ''), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** GitHub webhook (push events) → team announcement. */
apiRoutes.post('/api/hooks/github/:token', async (c) => {
  const team = await teamByInboundToken(c);
  if (!team) return c.json({ error: 'unknown hook token' }, 404);
  // Verify against the raw body bytes when GitHub sends a signature (webhook
  // "secret" = this team's inbound token); URL secrecy remains the baseline.
  const raw = await c.req.text();
  const signature = c.req.header('x-hub-signature-256');
  if (signature && !validGithubSignature(raw, signature, team.inboundToken ?? '')) {
    logLine({ evt: 'auth', a: 'github_hook_fail', team: team.slug, why: 'bad_signature' });
    return c.json({ error: 'X-Hub-Signature-256 mismatch' }, 401);
  }
  const event = c.req.header('x-github-event') ?? 'unknown';
  if (!['push', 'issues', 'pull_request', 'workflow_run'].includes(event)) {
    return c.json({ ok: true, ignored: event });
  }
  let p: {
    ref?: string;
    action?: string;
    pusher?: { name?: string };
    repository?: { name?: string; full_name?: string };
    commits?: unknown[];
    head_commit?: { message?: string };
    issue?: { number?: number; title?: string; html_url?: string; user?: { login?: string } };
    sender?: { login?: string };
    pull_request?: {
      number?: number;
      title?: string;
      html_url?: string;
      merged?: boolean;
      head?: { ref?: string };
    };
    workflow_run?: {
      head_branch?: string;
      conclusion?: string;
      name?: string;
    };
  };
  try {
    p = JSON.parse(raw);
  } catch {
    return c.json({ error: 'invalid payload' }, 400);
  }

  // An issue opening or closing is work appearing and disappearing, which is
  // exactly what an agent reading its inbox should know before it picks
  // something up. Edits and label churn are noise and stay out.
  if (event === 'issues') {
    const action = p.action ?? '';
    if (!['opened', 'closed', 'reopened'].includes(action)) {
      return c.json({ ok: true, ignored: `issues.${action}` });
    }
    const number = p.issue?.number;
    if (!number) return c.json({ error: 'invalid payload' }, 400);
    const repoName = p.repository?.name ?? 'repo';
    const who = p.sender?.login ?? p.issue?.user?.login ?? 'someone';
    const title = (p.issue?.title ?? '').slice(0, 140);
    await postAnnouncement(
      c,
      team,
      'github',
      `[${repoName}] issue #${number} ${action} by ${who}: "${title}"${action === 'opened' ? ' — an agent can pick it up with start_run {"issue":' + number + '}' : ''}`,
    );
    return c.json({ ok: true });
  }

  // The outcome half: a PR opening/merging or CI completing on a branch a run
  // declared writes the verdict onto that run — "the change merged" as a fact
  // in the trail, not a sentence in a retro. Unknown branches answer linked:
  // false rather than erroring, because most branches never had a run.
  if (event === 'pull_request') {
    const action = p.action ?? '';
    if (!['opened', 'closed', 'reopened'].includes(action)) {
      return c.json({ ok: true, ignored: `pull_request.${action}` });
    }
    const pr = p.pull_request;
    const headBranch = pr?.head?.ref;
    if (!pr?.number || !headBranch) return c.json({ error: 'invalid payload' }, 400);
    const state = action === 'closed' ? (pr.merged ? 'merged' : 'closed') : 'open';
    const outcome = await recordRunOutcome(c.get('db'), team.id, {
      branch: headBranch,
      repoName: p.repository?.name,
      pr: { number: pr.number, url: pr.html_url ?? '', state, title: pr.title },
    });
    return c.json({ ok: true, linked: outcome.linked });
  }

  if (event === 'workflow_run') {
    if (p.action !== 'completed') return c.json({ ok: true, ignored: `workflow_run.${p.action}` });
    const wr = p.workflow_run;
    const conclusion = wr?.conclusion;
    // Cancelled and skipped runs say nothing about the change.
    if (!wr?.head_branch || (conclusion !== 'success' && conclusion !== 'failure')) {
      return c.json({ ok: true, ignored: `workflow_run.${conclusion ?? 'unknown'}` });
    }
    const outcome = await recordRunOutcome(c.get('db'), team.id, {
      branch: wr.head_branch,
      repoName: p.repository?.name,
      ci: { conclusion, workflow: wr.name },
    });
    return c.json({ ok: true, linked: outcome.linked });
  }

  const branch = (p.ref ?? '').replace('refs/heads/', '');
  const repoName = p.repository?.name ?? 'repo';
  const n = Array.isArray(p.commits) ? p.commits.length : 0;
  const headline = (p.head_commit?.message ?? '').split('\n')[0]?.slice(0, 120) ?? '';
  await postAnnouncement(
    c,
    team,
    'github',
    `[${repoName}] push to ${branch} by ${p.pusher?.name ?? 'someone'}: ${n} commit${n === 1 ? '' : 's'}${headline ? ` — "${headline}"` : ''}`,
  );
  return c.json({ ok: true });
});

/**
 * Azure DevOps service hooks, for the same outcome linkage: point
 * `git.pullrequest.created`, `git.pullrequest.updated` and `build.complete`
 * subscriptions at this URL. Auth is the per-team secret URL, the same
 * baseline every inbound hook here starts from — ADO offers no HMAC header
 * to verify on top of it the way GitHub does.
 */
apiRoutes.post('/api/hooks/azure-devops/:token', async (c) => {
  const team = await teamByInboundToken(c);
  if (!team) return c.json({ error: 'unknown hook token' }, 404);
  let p: {
    eventType?: string;
    resource?: {
      pullRequestId?: number;
      title?: string;
      status?: string;
      sourceRefName?: string;
      repository?: { name?: string; webUrl?: string };
      result?: string;
      sourceBranch?: string;
      definition?: { name?: string };
    };
  };
  try {
    p = await c.req.json();
  } catch {
    return c.json({ error: 'invalid payload' }, 400);
  }
  const eventType = p.eventType ?? '';
  const resource = p.resource ?? {};

  if (eventType === 'git.pullrequest.created' || eventType === 'git.pullrequest.updated') {
    const number = resource.pullRequestId;
    const branch = (resource.sourceRefName ?? '').replace('refs/heads/', '');
    if (!number || !branch) return c.json({ error: 'invalid payload' }, 400);
    // ADO answers status on the PR itself: active while open, completed once
    // merged, abandoned when closed without merging.
    const status = resource.status ?? 'active';
    const state = status === 'completed' ? 'merged' : status === 'abandoned' ? 'closed' : 'open';
    const url = resource.repository?.webUrl
      ? `${resource.repository.webUrl}/pullrequest/${number}`
      : '';
    const outcome = await recordRunOutcome(c.get('db'), team.id, {
      branch,
      repoName: resource.repository?.name,
      pr: { number, url, state, title: resource.title },
    });
    return c.json({ ok: true, linked: outcome.linked });
  }

  if (eventType === 'build.complete') {
    const branch = (resource.sourceBranch ?? '').replace('refs/heads/', '');
    const result = resource.result ?? '';
    if (!branch) return c.json({ error: 'invalid payload' }, 400);
    // partiallySucceeded is a failure someone configured not to look like one.
    if (!['succeeded', 'failed', 'partiallySucceeded'].includes(result)) {
      return c.json({ ok: true, ignored: `build.${result || 'unknown'}` });
    }
    const outcome = await recordRunOutcome(c.get('db'), team.id, {
      branch,
      repoName: resource.repository?.name,
      ci: {
        conclusion: result === 'succeeded' ? 'success' : 'failure',
        workflow: resource.definition?.name,
      },
    });
    return c.json({ ok: true, linked: outcome.linked });
  }

  return c.json({ ok: true, ignored: eventType || 'unknown' });
});
