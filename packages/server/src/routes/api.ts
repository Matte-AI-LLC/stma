import { AGENT_CLIENT_TYPES, AGENT_ROLES, type AgentClientType, type AgentRole } from '@bridge/shared';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { invites, messages, repositoryBindings, teams, tokens, users } from '../db/schema';
import { z } from 'zod/v3';
import { generatePat, mcpAuth } from '../auth/pat';
import {
  clearLoginFailures,
  LOGIN_FAIL_WINDOW_MS,
  loginGate,
  lockedMessage,
  recordLoginFailure,
} from '../auth/attempts';
import { failedSignInsEmail, sendMail } from '../lib/mailer';
import { recordRunOutcome, revokeAgentInstallation } from '../domain/agents';
import { recordProviderObservation } from '../domain/providerEvidence';
import { observeAdoBuild } from '../domain/adoEvidence';
import { claimInviteMembership } from '../domain/invites';
import {
  createAgentEnrollment,
  previewAgentEnrollment,
  redeemAgentEnrollment,
} from '../domain/enrollments';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../lib/crypto';
import { reservedUsername } from '../lib/admin';
import { emailIsFree, isEmail, maskEmail, normalizeEmail, usernameFromEmail } from '../lib/email';
import { logLine } from '../lib/log';
import { notifyTeam } from '../lib/notify';
import { notifyAnnouncement, notifyMemberJoined, notifyTeamJoined } from '../lib/notifications';
import { redactSecrets } from '../lib/redact';
import { normalizeDeviceLabel } from '../lib/devices';
import { getAnnouncementsSession } from '../lib/sessions';
import { track } from '../lib/track';
import type { AppEnv } from '../types';

export const apiRoutes = new Hono<AppEnv>();

/**
 * One-time agent activation. The short-lived code in the copied prompt is
 * exchanged for the long-lived, server-scoped PAT the client stores locally.
 */
/** Read-only: what `stma connect` shows its human before it asks y/N. */
apiRoutes.post('/api/agent-enrollments/preview', async (c) => {
  let body: { code?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'send JSON: {"code":"stma_enroll_..."}' }, 400);
  }
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  const preview =
    code.startsWith('stma_enroll_') && code.length <= 100
      ? await previewAgentEnrollment(c.get('db'), code)
      : null;
  c.header('Cache-Control', 'no-store');
  if (!preview) {
    return c.json({ error: 'invalid, expired, already used or revoked enrollment code' }, 404);
  }
  return c.json({ ok: true, endpoint: `${c.get('env').baseUrl}/mcp`, ...preview });
});

apiRoutes.post('/api/agent-enrollments/redeem', async (c) => {
  let body: { code?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'send JSON: {"code":"stma_enroll_..."}' }, 400);
  }
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!code.startsWith('stma_enroll_') || code.length > 100) {
    return c.json({ error: 'invalid, expired, already used or revoked enrollment code' }, 404);
  }
  const terminal = (body as { via?: unknown }).via === 'terminal';
  const redeemed = await redeemAgentEnrollment(c.get('db'), code, terminal);
  if (!redeemed.ok) {
    return c.json({ error: 'invalid, expired, already used or revoked enrollment code' }, 404);
  }
  const { value } = redeemed;
  logLine({
    evt: 'agent_enrollment',
    a: 'redeemed',
    via: terminal ? 'terminal' : 'agent',
    enrollment: value.enrollment.id,
    installation: value.installation.id,
    installationName: value.installation.name,
    device: value.installation.deviceLabel,
    client: value.installation.clientType,
    role: value.installation.role,
    scope: value.enrollment.scope,
    team: value.team?.slug,
    project: value.project?.slug,
    credentialExpiresAt: value.credentialExpiresAt,
    credentialLifetime: value.credentialExpiresAt ? 'time_limited' : 'until_revoked',
  });
  c.header('Cache-Control', 'no-store');
  const endpoint = `${c.get('env').baseUrl}/mcp`;
  const selfRevokeEndpoint = `${c.get('env').baseUrl}/api/agent-enrollments/self-revoke`;
  return c.json({
    ok: true,
    protocolVersion: 2,
    enrollmentId: value.enrollment.id,
    token: value.token,
    endpoint,
    installation: {
      id: value.installation.id,
      name: value.installation.name,
      device: value.installation.deviceLabel,
      clientType: value.installation.clientType,
      role: value.installation.role,
    },
    grant: {
      scope: value.enrollment.scope,
      team: value.team ? { slug: value.team.slug, name: value.team.name } : null,
      project: value.project ? { slug: value.project.slug, name: value.project.name } : null,
    },
    credential: {
      expiresAt: value.credentialExpiresAt?.toISOString() ?? null,
      lifetime: value.credentialExpiresAt ? 'time_limited' : 'until_revoked',
    },
    activation: {
      state: 'awaiting_client',
      expiresAt: value.setupExpiresAt.toISOString(),
      confirmTool: 'whoami',
    },
    // A deliberately flat, exact-equality receipt for generated connection
    // helpers. The nested objects above remain the API's descriptive shape;
    // this block prevents clients from guessing aliases or normalizing null.
    validation: {
      endpoint,
      enrollmentId: value.enrollment.id,
      installationName: value.installation.name,
      device: value.installation.deviceLabel,
      clientType: value.installation.clientType,
      role: value.installation.role ?? 'generalist',
      grantScope: value.enrollment.scope,
      teamSlug: value.team?.slug ?? null,
      projectName: value.project?.name ?? null,
    },
    cleanup: {
      endpoint: selfRevokeEndpoint,
      method: 'POST',
    },
    note:
      'The enrollment code is now consumed. Keep the token value secret, but show the user the HTTP status, non-secret metadata, user-level configuration target and redacted outcome.',
  });
});

/**
 * The route a credential uses to end itself. Two things arrive here and they
 * are not the same event: an agent that redeemed successfully but could not
 * validate or persist its local configuration, and a person running
 * `stma adapter disconnect` on a connection they are done with. Until
 * 2026-09-20 both were written as `self_revoked_after_setup_failure`, so the
 * log said an installer had failed every time somebody tidied up.
 *
 * The bearer can revoke only its own enrollment-bound installation; no target
 * id is accepted from the body. `reason` is a closed set and nothing else, so
 * the caller chooses between two recorded events and can never write a sentence
 * into the operator's log. Absent or unrecognised keeps the old meaning,
 * because an already-shipped installer sends no body at all.
 */
const SELF_REVOKE_ACTIONS = {
  setup_failed: 'self_revoked_after_setup_failure',
  disconnected: 'disconnected_by_user',
} as const;

apiRoutes.post('/api/agent-enrollments/self-revoke', mcpAuth, async (c) => {
  const user = c.get('mcpUser');
  const grant = c.get('mcpGrant');
  if (!grant.installationId) {
    return c.json({ error: 'not_enrollment_connection' }, 409);
  }
  let reason: keyof typeof SELF_REVOKE_ACTIONS = 'setup_failed';
  try {
    const body: unknown = await c.req.json();
    const asked = (body as { reason?: unknown } | null)?.reason;
    if (typeof asked === 'string' && asked in SELF_REVOKE_ACTIONS) {
      reason = asked as keyof typeof SELF_REVOKE_ACTIONS;
    }
  } catch {
    /* No body is the installer's shape, and it means the original reason. */
  }
  const revoked = await revokeAgentInstallation(c.get('db'), user.id, grant.installationId);
  if ('error' in revoked) {
    return c.json({ error: 'connection_not_active' }, 409);
  }
  logLine({
    evt: 'agent_enrollment',
    a: SELF_REVOKE_ACTIONS[reason],
    installation: grant.installationId,
    scope: grant.scope,
    team: grant.teamSlug,
    project: grant.projectSlug,
  });
  c.header('Cache-Control', 'no-store');
  return c.json({ ok: true, installationId: grant.installationId, revoked: true });
});

/**
 * Terminal-first onboarding: redeem an invite code with email+password and
 * receive a team-scoped credential — no browser involved. Agent identity fields
 * additionally bind it to one installation. Creates the account when the email
 * is new; verifies the password when it already exists.
 */
apiRoutes.post('/api/invites/redeem', async (c) => {
  const env = c.get('env');
  if (!env.localAuth) return c.json({ error: 'local accounts are disabled on this server' }, 403);

  let body: {
    code?: unknown;
    email?: unknown;
    password?: unknown;
    agent_name?: unknown;
    device?: unknown;
    client?: unknown;
    role?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'send JSON: {"code","email","password"}' }, 400);
  }
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  const rawAgentName = typeof body.agent_name === 'string' ? body.agent_name.trim() : '';
  const agentName = rawAgentName.slice(0, 80);
  const device = normalizeDeviceLabel(typeof body.device === 'string' ? body.device : undefined);
  const wantsAgent = Boolean(body.agent_name || body.device || body.client || body.role);
  const client =
    typeof body.client === 'string' && (AGENT_CLIENT_TYPES as readonly string[]).includes(body.client)
      ? (body.client as AgentClientType)
      : 'generic';
  const role =
    typeof body.role === 'string' && (AGENT_ROLES as readonly string[]).includes(body.role)
      ? (body.role as AgentRole)
      : 'generalist';
  if (!code) return c.json({ error: 'missing invite code' }, 400);
  if (!isEmail(email)) return c.json({ error: 'email must be a valid address' }, 400);
  if (password.length < 8 || password.length > 128) {
    return c.json({ error: 'password must be 8-128 characters' }, 400);
  }
  if (wantsAgent && (!agentName || !device)) {
    return c.json({ error: 'agent_name and a valid device are both required to connect an agent' }, 400);
  }
  if (rawAgentName.length > 80) {
    return c.json({ error: 'agent_name must be 80 characters or fewer' }, 400);
  }
  if (
    typeof body.client === 'string' &&
    !(AGENT_CLIENT_TYPES as readonly string[]).includes(body.client)
  ) {
    return c.json({ error: `client must be one of: ${AGENT_CLIENT_TYPES.join(', ')}` }, 400);
  }
  if (typeof body.role === 'string' && !(AGENT_ROLES as readonly string[]).includes(body.role)) {
    return c.json({ error: `role must be one of: ${AGENT_ROLES.join(', ')}` }, 400);
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
  const existingUser = existingRows[0];
  let username: string;
  let newUser: { username: string; email: string; passwordHash: string } | undefined;
  if (existingUser) {
    if (!existingUser.passwordHash) {
      logLine({ evt: 'auth', a: 'redeem_fail', u: existingUser.username, why: 'passwordless_account' });
      return c.json(
        { error: 'that email belongs to an account without a password — join via the web instead' },
        409,
      );
    }
    // Everything the sign-in form does around a password, this door has to do
    // too. It was the only other place in the tree that verifies one, and it had
    // none of it: no lockout, so an invite holder could guess a teammate's
    // password without limit; no notice, so the account holder was never told;
    // and no second factor, so a hit returned a working credential while the
    // front door would have asked for an emailed code. The lock is checked
    // before the password and enforced even when the password turns out to be
    // right, for the same reason it is at the form — a throttle a correct guess
    // walks through is not one.
    const gate = await loginGate(db, email);
    if (gate.locked) {
      logLine({ evt: 'auth', a: 'redeem_locked', em: maskEmail(email) });
      return c.json({ error: lockedMessage(gate.resetAt) }, 429);
    }
    if (!(await verifyPassword(password, existingUser.passwordHash))) {
      const failed = await recordLoginFailure(db, email);
      logLine({
        evt: 'auth',
        a: 'redeem_fail',
        u: existingUser.username,
        why: 'wrong_password',
        n: failed.attempts,
      });
      if (failed.justLocked) {
        // The row was found by this address, so mailing it reaches the account
        // holder and reveals nothing a guesser did not already supply.
        void sendMail(env, {
          to: email,
          ...failedSignInsEmail(env.baseUrl, Math.round(LOGIN_FAIL_WINDOW_MS / 60_000)),
        });
      }
      return c.json(
        { error: failed.locked ? lockedMessage(failed.resetAt) : 'wrong password for existing user' },
        failed.locked ? 429 : 401,
      );
    }
    await clearLoginFailures(db, email);
    username = existingUser.username;
  } else {
    if (!(await emailIsFree(db, email))) {
      return c.json({ error: 'that email is already registered' }, 409);
    }
    username = await usernameFromEmail(db, email, (name) => reservedUsername(c.get('env'), name));
    newUser = { username, email, passwordHash: await hashPassword(password) };
  }

  let claimed: Awaited<ReturnType<typeof claimInviteMembership>>;
  try {
    claimed = existingUser
      ? await claimInviteMembership(db, { code, userId: existingUser.id })
      : await claimInviteMembership(db, { code, newUser: newUser! });
  } catch (error) {
    // A same-email request may have won while this request was hashing the
    // password. Preserve the existing conflict contract; surface unrelated DB
    // failures instead of disguising them as an account collision.
    const raced = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (!existingUser && raced[0]) {
      return c.json({ error: 'that email is already registered' }, 409);
    }
    throw error;
  }

  if (!claimed.ok) {
    if (claimed.reason === 'member_limit') {
      return c.json(
        { error: `team member limit reached (${claimed.maxMembers} on the ${claimed.plan} plan)` },
        403,
      );
    }
    // An emailed invitation is redeemable only by an account whose address is
    // that one and confirmed, and an account made here is never confirmed:
    // the browser, which can take the code, is where it is accepted.
    if (claimed.reason === 'wrong_address' || claimed.reason === 'unconfirmed') {
      return c.json(
        {
          error:
            claimed.reason === 'wrong_address'
              ? 'this invitation was emailed to a different address'
              : 'this invitation was emailed to one address: open it in a browser and confirm that address to accept it',
        },
        403,
      );
    }
    logLine({ evt: 'auth', a: 'redeem_fail', em: maskEmail(email), why: 'bad_code_race' });
    return c.json({ error: 'invite code is invalid, expired or used up' }, 404);
  }
  if (claimed.joined) {
    // Terminal onboarding: the agent got the token, but this is often the only
    // thing that tells the human their account now exists and where it lives.
    await notifyTeamJoined(db, env, { teamId: claimed.team.id, userId: claimed.userId });
    await notifyMemberJoined(db, env, { teamId: claimed.team.id, userId: claimed.userId });
    await c.get('lifecycle').teamMemberCountChanged?.({ db, teamId: claimed.team.id });
  }

  let activated: Awaited<ReturnType<typeof redeemAgentEnrollment>> | undefined;
  if (wantsAgent) {
    const enrollment = await createAgentEnrollment(db, {
      userId: claimed.userId,
      name: agentName,
      deviceLabel: device!,
      clientType: client,
      role,
      scope: 'team',
      teamId: claimed.team.id,
    });
    activated = await redeemAgentEnrollment(db, enrollment.code);
    if (!activated.ok) throw new Error('Fresh teammate agent enrollment could not be activated');
  }
  const pat = activated?.ok ? null : generatePat();
  if (pat) {
    // Backward-compatible terminal clients that send only code/email/password
    // still receive a PAT, but it is team-scoped instead of silently following
    // every future membership. The current generated prompt always supplies an
    // agent identity and gets the stronger one-token/one-installation path.
    await db.insert(tokens).values({
      userId: claimed.userId,
      name: `${username}-cli`,
      scope: 'team',
      teamId: claimed.team.id,
      tokenHash: pat.hash,
      prefix: pat.prefix,
    });
  }

  logLine({ evt: 'auth', a: 'redeem', u: username, team: claimed.team.slug });
  if (claimed.joined) {
    void track(db, {
      teamId: claimed.team.id,
      userId: claimed.userId,
      action: 'member_joined',
      detail: username,
    });
  }
  const mcpUrl = `${env.baseUrl}/mcp`;
  const token = activated?.ok ? activated.value.token : pat!.token;
  c.header('Cache-Control', 'no-store');
  return c.json({
    ok: true,
    username,
    email,
    team: { slug: claimed.team.slug, name: claimed.team.name },
    token,
    installation: activated?.ok
      ? {
          id: activated.value.installation.id,
          name: activated.value.installation.name,
          device: activated.value.installation.deviceLabel,
          clientType: activated.value.installation.clientType,
          role: activated.value.installation.role,
        }
      : null,
    grant: { scope: 'team', team: claimed.team.slug, project: null },
    credential: {
      expiresAt: activated?.ok ? activated.value.credentialExpiresAt?.toISOString() ?? null : null,
      lifetime:
        activated?.ok && activated.value.credentialExpiresAt ? 'time_limited' : 'until_revoked',
    },
    note: 'Store this token like a password — it is shown only once.',
    connect: activated?.ok
      ? {
          endpoint: mcpUrl,
          firstSteps:
            'Install the token once in this client\'s user-level Authorization header, call whoami, then get_snapshot_checklist → push_snapshot. Check inbox for open debug sessions.',
        }
      : {
          // Compatibility response for terminal clients that did not send an
          // agent identity. Keep the only plaintext secret in `token` above;
          // never repeat it inside an argv-ready command or config fragment.
          claudeCode: `Semantically merge mcpServers.stma into ~/.claude.json with type=http, url=${mcpUrl}, and Authorization="Bearer [USE_TOP_LEVEL_TOKEN]". Never put the token in argv or shell history.`,
          cursor: {
            mcpServers: {
              stma: {
                url: mcpUrl,
                headers: { Authorization: 'Bearer [USE_TOP_LEVEL_TOKEN]' },
              },
            },
          },
          secretHandling:
            'Consume the top-level token only inside one local process that validates and atomically merges configuration; never print it or pass it through argv, environment, clipboard or a response file.',
          firstSteps:
            'Call whoami, then get_snapshot_checklist → push_snapshot. Check inbox for open debug sessions.',
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
  // Redacted, and without the body on the webhook at all.
  //
  // `messages.body` above is scrubbed; these two were not, so a secret pasted
  // into an announcement was cleaned inside STMA and then posted verbatim to
  // the team's Slack channel and written into the activity feed, which the
  // page renders and the CSV exports. The webhook also contradicted its own
  // contract — notifyTeam is documented to carry event metadata and never
  // message bodies, and every other caller honours that.
  notifyTeam(c.get('env'), team, `New announcement in ${team.slug} (via ${via}).`);
  void track(db, {
    teamId: team.id,
    action: 'announce',
    detail: `${via}: ${redactSecrets(body.slice(0, 140))}`,
  });
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
  // GitHub supports an HMAC secret, so URL secrecy is not an adequate fallback:
  // a copied proxy log or browser history entry must not be enough to forge a
  // push, issue or workflow outcome. Generic CI systems that cannot sign use
  // the separate /announce hook whose contract is explicitly token-only.
  const raw = await c.req.text();
  const signature = c.req.header('x-hub-signature-256');
  if (!signature || !validGithubSignature(raw, signature, team.inboundToken ?? '')) {
    logLine({
      evt: 'auth',
      a: 'github_hook_fail',
      team: team.slug,
      why: signature ? 'bad_signature' : 'missing_signature',
    });
    return c.json(
      { error: signature ? 'X-Hub-Signature-256 mismatch' : 'X-Hub-Signature-256 required' },
      401,
    );
  }
  const event = c.req.header('x-github-event') ?? 'unknown';
  if (!['push', 'issues', 'pull_request', 'workflow_run'].includes(event)) {
    return c.json({ ok: true, ignored: event });
  }
  let p: {
    ref?: string;
    action?: string;
    pusher?: { name?: string };
    repository?: { id?: number; name?: string; full_name?: string };
    commits?: unknown[];
    head_commit?: { message?: string };
    issue?: { number?: number; title?: string; html_url?: string; user?: { login?: string } };
    sender?: { login?: string };
    pull_request?: {
      number?: number;
      title?: string;
      html_url?: string;
      merged?: boolean;
      updated_at?: string;
      head?: { ref?: string; sha?: string };
    };
    workflow_run?: {
      id?: number;
      run_attempt?: number;
      head_sha?: string;
      updated_at?: string;
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
    await recordProviderObservation(c.get('db'), team.id, 'github', { repositoryId: p.repository?.id?.toString(), deliveryId: c.req.header('x-github-delivery'), subjectId: `pr:${pr.number}`, commitSha: pr.head?.sha, kind: 'pull_request', state, observedAt: pr.updated_at });
    const outcome = await recordRunOutcome(c.get('db'), team.id, {
      branch: headBranch,
      repoName: p.repository?.full_name ?? p.repository?.name,
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
      repoName: p.repository?.full_name ?? p.repository?.name,
      ci: { conclusion, workflow: wr.name },
    });
    await recordProviderObservation(c.get('db'), team.id, 'github', { repositoryId: p.repository?.id?.toString(), deliveryId: c.req.header('x-github-delivery'), subjectId: wr.id ? `workflow:${wr.id}` : undefined, commitSha: wr.head_sha, kind: 'workflow', state: conclusion, attempt: wr.run_attempt, observedAt: wr.updated_at });
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
const adoHookPayload = z.object({
  eventType: z.string().max(100).optional(),
  resource: z.object({
    id: z.number().int().positive().optional(),
    pullRequestId: z.number().int().positive().optional(),
    title: z.string().optional(), status: z.string().optional(),
    sourceRefName: z.string().optional(), sourceBranch: z.string().optional(),
    result: z.string().optional(),
    repository: z.object({ id: z.string().optional(), name: z.string().optional(), webUrl: z.string().optional() }).optional(),
    definition: z.object({ name: z.string().optional() }).optional(),
  }).optional(),
});
apiRoutes.on('POST', ['/api/hooks/azure-devops/:token', '/api/hooks/azure-devops/:token/:binding'], async (c) => {
  const team = await teamByInboundToken(c);
  if (!team) return c.json({ error: 'unknown hook token' }, 404);
  let p: {
    eventType?: string;
    resource?: {
      id?: number;
      pullRequestId?: number;
      title?: string;
      status?: string;
      sourceRefName?: string;
      repository?: { id?: string; name?: string; webUrl?: string };
      result?: string;
      sourceBranch?: string;
      definition?: { name?: string };
    };
  };
  try {
    p = adoHookPayload.parse(await c.req.json());
  } catch {
    return c.json({ error: 'invalid payload' }, 400);
  }
  const eventType = p.eventType ?? '';
  const resource = p.resource ?? {};

  // Scoped hooks support ADO's minimal build.complete payload (no repository
  // or commit fields). Never follow resource.url or trust its result/SHA.
  const scopedBinding = c.req.param('binding');
  if (scopedBinding && !z.string().uuid().safeParse(scopedBinding).success)
    return c.json({ error: 'unknown repository binding' }, 404);
  if (eventType === 'build.complete' && (scopedBinding || resource.repository?.id)) {
    const [binding] = await c.get('db').select().from(repositoryBindings).where(and(
      eq(repositoryBindings.teamId, team.id), eq(repositoryBindings.provider, 'azure-devops'),
      scopedBinding ? eq(repositoryBindings.id, scopedBinding) : eq(repositoryBindings.repositoryId, resource.repository!.id!),
    ));
    if (!binding) return c.json({ ok: true, evidence: { recorded: false, reason: 'repository_not_verified' } });
    if (!z.number().int().positive().max(2_147_483_647).safeParse(resource.id).success)
      return c.json({ error: 'a numeric build ID is required' }, 400);
    const evidence = await observeAdoBuild(c.get('db'), c.get('env'), team.id, binding.id, resource.id!);
    return c.json({ ok: true, evidence }, evidence.reason === 'provider_unavailable' ? 503 : 200);
  }
  if (scopedBinding) return c.json({ ok: true, ignored: eventType || 'unknown' });

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
