import { PAT_PREFIX } from '@bridge/shared';
import { and, eq } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { agentInstallations, memberships, projects, teams, tokens, users } from '../db/schema';
import { randomHex, sha256hex } from '../lib/crypto';
import { isTokenScope, type AgentGrant } from '../lib/grants';
import type { AppEnv } from '../types';
import { authorizeSecurity, setSecurityPrincipal } from '../lib/securityHooks';
import { logLine } from '../lib/log';

export function generatePat(): { token: string; hash: string; prefix: string } {
  const token = PAT_PREFIX + randomHex(20);
  return { token, hash: sha256hex(token), prefix: token.slice(0, PAT_PREFIX.length + 6) };
}

function unauthorized(
  c: Context<AppEnv>,
  hint?: string,
  error?: 'invalid_token',
): Response {
  const metadata = `${c.get('env').baseUrl}/.well-known/oauth-protected-resource`;
  c.header(
    'WWW-Authenticate',
    `Bearer realm="stma", resource_metadata="${metadata}", scope="stma"${error ? `, error="${error}"` : ''}`,
  );
  c.header('Cache-Control', 'no-store');
  return c.json(
    {
      error: 'unauthorized',
      hint: hint ?? 'Send an STMA agent credential: Authorization: Bearer stma_...',
    },
    401,
  );
}

/** Bearer-token auth for the MCP endpoint. Sets `c.var.mcpUser`. */
export const mcpAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const match = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '');
  if (!match) return unauthorized(c);

  const db = c.get('db');
  const hash = sha256hex(match[1]!);
  const rows = await db
    .select({
      token: tokens,
      user: users,
      teamSlug: teams.slug,
      teamName: teams.name,
      projectSlug: projects.slug,
      projectName: projects.name,
      projectTeamId: projects.teamId,
      installationId: agentInstallations.id,
      installationName: agentInstallations.name,
      installationDeviceLabel: agentInstallations.deviceLabel,
      installationRevokedAt: agentInstallations.revokedAt,
      installationCompanionOf: agentInstallations.companionOf,
    })
    .from(tokens)
    .innerJoin(users, eq(tokens.userId, users.id))
    .leftJoin(teams, eq(tokens.teamId, teams.id))
    .leftJoin(projects, eq(tokens.projectId, projects.id))
    .leftJoin(agentInstallations, eq(agentInstallations.tokenId, tokens.id))
    .where(eq(tokens.tokenHash, hash))
    .limit(1);
  const row = rows[0];
  // "Send a token" is the wrong advice for an agent that just sent one. Only the
  // holder of that exact secret can reach this branch, so naming the revocation
  // discloses nothing — and it is the difference between retrying forever and
  // asking a human for a new token.
  if (row?.token.revokedAt) {
    logLine({
      evt: 'credential',
      a: 'rejected',
      why: 'token_revoked',
      installation: row.installationId,
    });
    return unauthorized(
      c,
      `This token was revoked on ${row.token.revokedAt.toISOString().slice(0, 10)}. ` +
        `Ask your human for a new one at ${c.get('env').baseUrl}/app/tokens.`,
      'invalid_token',
    );
  }
  if (!row) return unauthorized(c, undefined, 'invalid_token');
  if (row.token.expiresAt && row.token.expiresAt <= new Date()) {
    logLine({ evt: 'credential', a: 'rejected', why: 'token_expired', installation: row.installationId });
    return unauthorized(c, 'The OAuth access token expired. The MCP client should refresh it.', 'invalid_token');
  }
  // The first-party local adapter uses the same STMA OAuth resource through
  // scoped REST agent/control operations. Never extend this to app/admin routes.
  const oauthResource = `${c.get('env').baseUrl}/mcp`;
  const adapterPath = c.req.path.startsWith('/api/agent/') || c.req.path.startsWith('/api/control/');
  if (row.token.audience && row.token.audience !== `${c.get('env').baseUrl}${c.req.path}` &&
      !(row.token.audience === oauthResource && adapterPath)) {
    logLine({ evt: 'credential', a: 'rejected', why: 'wrong_audience', installation: row.installationId });
    return unauthorized(c, 'This OAuth access token was not issued for this MCP resource.', 'invalid_token');
  }
  const pendingSetup = row.token.setupExpiresAt && !row.token.activatedAt;
  if (pendingSetup && row.token.setupExpiresAt! <= new Date()) {
    logLine({ evt: 'credential', a: 'rejected', why: 'setup_expired', installation: row.installationId });
    return unauthorized(c, 'Setup was not confirmed in time. Create a fresh connection; this unfinished credential cannot be used.', 'invalid_token');
  }
  if (pendingSetup && c.req.path !== '/mcp' && c.req.path !== '/api/agent/identity' && c.req.path !== '/api/agent-enrollments/self-revoke') {
    return c.json({ error: 'setup_pending', hint: 'Reload the MCP client and call whoami to confirm this installation first.' }, 403);
  }
  if (!isTokenScope(row.token.scope)) {
    return unauthorized(c, 'This token has an invalid access scope. Revoke it and create a new agent connection.', 'invalid_token');
  }
  if (
    (row.token.scope !== 'personal' && (!row.token.teamId || !row.teamSlug)) ||
    (row.token.scope === 'project' &&
      (!row.token.projectId ||
        !row.projectSlug ||
        !row.projectTeamId ||
        row.projectTeamId !== row.token.teamId))
  ) {
    return unauthorized(c, 'This token no longer has a valid team or project scope. Create a new agent connection.', 'invalid_token');
  }
  if (row.token.scope !== 'personal') {
    const membership = await db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, row.user.id),
          eq(memberships.teamId, row.token.teamId!),
        ),
      )
      .limit(1);
    if (!membership[0]) {
      return unauthorized(
        c,
        'This credential owner is no longer a member of its team. Ask a team owner before creating a new connection.',
        'invalid_token',
      );
    }
  }
  if (row.installationId && row.installationRevokedAt) {
    logLine({
      evt: 'credential',
      a: 'rejected',
      why: 'installation_revoked',
      installation: row.installationId,
    });
    return unauthorized(
      c,
      `This agent installation was disabled on ${row.installationRevokedAt.toISOString().slice(0, 10)}. ` +
        `Ask your human for a new connection prompt at ${c.get('env').baseUrl}/app/tokens.`,
      'invalid_token',
    );
  }

  setSecurityPrincipal({ userId: row.user.id, tokenId: row.token.id, teamId: row.token.teamId, projectId: row.token.projectId, path: c.req.path, method: c.req.method });
  const denied = await authorizeSecurity(db, 'credential');
  if (denied) return unauthorized(c, denied, 'invalid_token');
  if (!pendingSetup) {
    await db.update(tokens).set({ lastUsedAt: new Date() }).where(eq(tokens.id, row.token.id));
    if (row.installationId) await db.update(agentInstallations).set({ lastSeenAt: new Date() }).where(eq(agentInstallations.id, row.installationId));
  }
  const grant: AgentGrant = {
    tokenId: row.token.id,
    scope: row.token.scope,
    teamId: row.token.teamId,
    teamSlug: row.teamSlug,
    teamName: row.teamName,
    projectId: row.token.projectId,
    projectSlug: row.projectSlug,
    projectName: row.projectName,
    installationId: row.installationId,
    installationName: row.installationName,
    // Legacy tokens have no first-class installation device; their old token
    // name remains a compatibility fallback.
    deviceLabel:
      row.installationDeviceLabel ?? (row.token.name.split(' · ')[0]?.trim() || null),
    companionInstallationId: row.installationCompanionOf ?? null,
  };
  c.set('mcpUser', row.user);
  c.set('mcpToken', row.token);
  c.set('mcpGrant', grant);
  await next();
};
