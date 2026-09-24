import { AGENT_ROLES, CLAUDE_APP_CLIENT, type AgentClientType, type AgentRole } from '@bridge/shared';
import { createHash } from 'node:crypto';
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { agentEnrollments, agentInstallations, memberships, oauthAuthorizationCodes, oauthClients, oauthRefreshTokens, projects, teams, tokens } from '../db/schema';
import type { Db } from '../db';
import { revokeAgentInstallation } from '../domain/agents';
import { companionCandidates, isLocalAdapterClient, resolveCompanion } from '../domain/companions';
import { createAgentEnrollment, redeemAgentEnrollmentByIdInTransaction } from '../domain/enrollments';
import { generatePat } from '../auth/pat';
import { randomHex, sha256hex } from '../lib/crypto';
import { normalizeDeviceLabel } from '../lib/devices';
import type { TokenScope } from '../lib/grants';
import { logLine } from '../lib/log';
import { claudeCheckoutAgentName } from '../lib/mcpConnectPrompt';
import { authorizeSecurity, membershipUser, SecurityRefusal, setSecurityPrincipal } from '../lib/securityHooks';
import { AppLayout } from '../ui/Layout';
import type { AppEnv, User } from '../types';

export const oauthRoutes = new Hono<AppEnv>();

const OAUTH_SCOPE = 'stma';
const AUTHORIZATION_CODE_TTL_MS = 5 * 60_000;
const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
/**
 * A refresh token presented again this soon after it was spent is a retry, not
 * a theft (2026-09-24). Claude's hosted connectors give a refresh thirty
 * seconds; when the rotation committed and the response was lost, the retry
 * used to read as reuse and revoke the connection, and the person reconnected
 * by hand. It is answered like the first request now, with a fresh pair. Only
 * the newest access token is ever live, as before; the refresh token answered
 * the first time stays usable until one of the two is spent, and spending
 * either retires the other for good. Outside the window, or once a later
 * refresh token has been spent, a spent token is still reuse and still revokes
 * everything. The window is measured from the spend and a replay does not move it.
 */
export const REFRESH_REPLAY_GRACE_MS = 2 * 60_000;
const CLIENT_ID_RE = /^stma_client_[a-f0-9]{48}$/;
const CODE_RE = /^stma_oauth_code_[a-f0-9]{64}$/;
const REFRESH_RE = /^stma_refresh_[a-f0-9]{64}$/;
const PKCE_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RegisteredClient = typeof oauthClients.$inferSelect;
type OAuthParams = {
  responseType: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
  scope: string;
  resource: string;
};
type ConnectionTeam = {
  id: string;
  name: string;
  slug: string;
  role: string;
  projects: Array<{ id: string; name: string; slug: string }>;
};

const stringValue = (value: unknown, max = 2048): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';
const opaqueStringValue = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.slice(0, max) : '';

function resourceUri(c: Context<AppEnv>): string {
  return `${c.get('env').baseUrl}/mcp`;
}

function protectedResource(c: Context<AppEnv>) {
  return {
    resource: resourceUri(c),
    authorization_servers: [c.get('env').baseUrl],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'STMA agent coordination',
  };
}

oauthRoutes.get('/.well-known/oauth-protected-resource', (c) => c.json(protectedResource(c)));
oauthRoutes.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(protectedResource(c)));

oauthRoutes.get('/.well-known/oauth-authorization-server', (c) => {
  const base = c.get('env').baseUrl;
  return c.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    scopes_supported: [OAUTH_SCOPE],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });
});

function validRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 2048) return false;
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === 'https:') return true;
    return (
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

oauthRoutes.post('/oauth/register', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return oauthJsonError(c, 'invalid_client_metadata', 'Send a JSON client registration.', 400);
  }
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  const grantTypes = Array.isArray(body.grant_types) ? body.grant_types : ['authorization_code'];
  const responseTypes = Array.isArray(body.response_types) ? body.response_types : ['code'];
  if (
    redirectUris.length < 1 ||
    redirectUris.length > 12 ||
    !redirectUris.every(validRedirectUri) ||
    !grantTypes.every((value) => ['authorization_code', 'refresh_token'].includes(String(value))) ||
    !grantTypes.includes('authorization_code') ||
    responseTypes.length !== 1 ||
    responseTypes[0] !== 'code' ||
    ![undefined, 'none'].includes(body.token_endpoint_auth_method as undefined | string)
  ) {
    return oauthJsonError(c, 'invalid_client_metadata', 'Only public authorization-code clients with exact HTTP loopback or HTTPS callbacks are supported.', 400);
  }
  const clientName = stringValue(body.client_name, 120) || 'MCP client';
  const clientUri = stringValue(body.client_uri, 2048) || null;
  if (clientUri && !validRedirectUri(clientUri)) {
    return oauthJsonError(c, 'invalid_client_metadata', 'client_uri must be HTTPS or an HTTP loopback URL.', 400);
  }
  const id = `stma_client_${randomHex(24)}`;
  await c.get('db').insert(oauthClients).values({
    id,
    clientName,
    clientUri,
    redirectUris: redirectUris as string[],
  });
  logLine({ evt: 'mcp_oauth', a: 'client_registered', client: id.slice(0, 24), name: clientName });
  c.header('Cache-Control', 'no-store');
  return c.json({
    client_id: id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: clientName,
    ...(clientUri ? { client_uri: clientUri } : {}),
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }, 201);
});

function oauthJsonError(
  c: Context<AppEnv>,
  error: string,
  description: string,
  status: 400 | 401,
) {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  return c.json({ error, error_description: description }, status);
}

function queryParams(c: Context<AppEnv>): OAuthParams {
  return {
    responseType: stringValue(c.req.query('response_type'), 32),
    clientId: stringValue(c.req.query('client_id'), 256),
    redirectUri: stringValue(c.req.query('redirect_uri'), 2048),
    codeChallenge: stringValue(c.req.query('code_challenge'), 256),
    codeChallengeMethod: stringValue(c.req.query('code_challenge_method'), 32),
    state: opaqueStringValue(c.req.query('state'), 1024),
    scope: stringValue(c.req.query('scope'), 256),
    resource: stringValue(c.req.query('resource'), 2048),
  };
}

function bodyParams(body: Record<string, unknown>): OAuthParams {
  return {
    responseType: stringValue(body.response_type, 32),
    clientId: stringValue(body.client_id, 256),
    redirectUri: stringValue(body.redirect_uri, 2048),
    codeChallenge: stringValue(body.code_challenge, 256),
    codeChallengeMethod: stringValue(body.code_challenge_method, 32),
    state: opaqueStringValue(body.state, 1024),
    scope: stringValue(body.scope, 256),
    resource: stringValue(body.resource, 2048),
  };
}

async function authorizeRequest(
  c: Context<AppEnv>,
  params: OAuthParams,
): Promise<{ ok: true; client: RegisteredClient; scope: string } | { ok: false; message: string }> {
  if (
    params.responseType !== 'code' ||
    !CLIENT_ID_RE.test(params.clientId) ||
    params.codeChallengeMethod !== 'S256' ||
    !PKCE_RE.test(params.codeChallenge) ||
    params.resource !== resourceUri(c)
  ) {
    return { ok: false, message: 'The MCP client sent an invalid OAuth request.' };
  }
  const scopes = new Set(params.scope.split(/\s+/).filter(Boolean));
  if (!scopes.has(OAUTH_SCOPE) || [...scopes].some((scope) => ![OAUTH_SCOPE, 'offline_access'].includes(scope))) {
    return { ok: false, message: 'The MCP client requested an unsupported access scope.' };
  }
  const [client] = await c.get('db').select().from(oauthClients).where(eq(oauthClients.id, params.clientId)).limit(1);
  if (!client || !client.redirectUris.includes(params.redirectUri)) {
    return { ok: false, message: 'The MCP client or its callback is not registered.' };
  }
  return { ok: true, client, scope: OAUTH_SCOPE };
}

async function connectionTeams(c: Context<AppEnv>, userId: string): Promise<ConnectionTeam[]> {
  const db = c.get('db');
  const teamRows = await db
    .select({ id: teams.id, name: teams.name, slug: teams.slug, role: memberships.role })
    .from(teams)
    .innerJoin(memberships, eq(memberships.teamId, teams.id))
    .where(membershipUser(userId))
    .orderBy(teams.name);
  if (!teamRows.length) return [];
  const projectRows = await db
    .select({ id: projects.id, teamId: projects.teamId, name: projects.name, slug: projects.slug })
    .from(projects)
    .where(inArray(projects.teamId, teamRows.map((team) => team.id)))
    .orderBy(projects.name);
  return teamRows.map((team) => ({
    ...team,
    projects: projectRows
      .filter((project) => project.teamId === team.id)
      .map(({ id, name, slug }) => ({ id, name, slug })),
  }));
}

/**
 * Where the hosted Claude apps come back to after consent
 * (claude.com/docs/connectors/building/authentication). claude.com is listed
 * beside claude.ai because Anthropic's earlier guidance named it too.
 */
const HOSTED_CLAUDE_CALLBACKS = new Set([
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
]);

/** The device label of a Claude app connection, which has no machine of its own. */
const HOSTED_CLAUDE_DEVICE = 'claude.ai';

/**
 * A client that returns only to Anthropic's callback is the Claude apps' hosted
 * connector, whatever it calls itself: a code sent there can only be redeemed
 * by Anthropic. It registers as plain "Claude", which the name rule below read
 * as Claude Code, so the first real connection from claude.ai (2026-09-24) was
 * asked for a machine and named "claude-code-agent".
 */
function isHostedClaude(client: RegisteredClient): boolean {
  return client.redirectUris.length > 0 && client.redirectUris.every((uri) => HOSTED_CLAUDE_CALLBACKS.has(uri));
}

function clientTypeFor(client: RegisteredClient): AgentClientType {
  if (isHostedClaude(client)) return CLAUDE_APP_CLIENT;
  // Clients append the MCP server name, e.g. "Claude Code (stma-parcel-desk-codex-3f9a)".
  // A per-checkout server name carries a folder name, so only the product part may decide.
  const name = client.clientName.split('(')[0]!.toLowerCase();
  if (name.includes('claude')) return 'claude-code';
  if (name.includes('codex') || name.includes('chatgpt')) return 'codex';
  if (name.includes('cursor')) return 'cursor';
  return 'generic';
}

/**
 * The consent screen. A function because the POST draws it too: a pairing that
 * cannot hold is answered on the form the human is looking at, with what they
 * typed still in it — a bare 400 would leave `stma adapter activate` waiting on
 * a callback that is never coming.
 */
async function consentPage(
  c: Context<AppEnv>,
  user: User,
  client: RegisteredClient,
  params: OAuthParams,
  entered: { error?: string; name?: string; device?: string; access?: string; companion?: string } = {},
) {
  // Allow and Cancel are both answered by a redirect to this client's callback,
  // which `form-action 'self'` stopped in the browser (`lib/csp.ts`). The URI was
  // checked against the client's registration before this page was drawn.
  c.set('formTargets', [params.redirectUri]);
  const choices = await connectionTeams(c, user.id);
  const inferredClient = clientTypeFor(client);
  // The Claude apps are a person's console across workspaces, not an agent in
  // one checkout: no machine to name, and Personal is the scope a chat that is
  // asked "what are my agents doing" needs. Project only stays one click away.
  const hostedClaude = inferredClient === CLAUDE_APP_CLIENT;
  // A per-checkout Claude Code server name carries the checkout folder; offer it
  // as the default so two agents on one machine do not both arrive as "claude-code-agent".
  const checkoutName = inferredClient === 'claude-code' ? claudeCheckoutAgentName(client.clientName) : undefined;
  const redirectHost = new URL(params.redirectUri).host;
  const preferred =
    entered.access ??
    (hostedClaude
      ? 'personal'
      : choices[0]?.projects[0]
        ? `project:${choices[0].projects[0].id}`
        : choices[0]
          ? `team:${choices[0].id}`
          : 'personal');
  // Where a workspace created from this page sends its maker back to: this same
  // request, which is still valid, so the client that is waiting gets its code.
  const retry = `/oauth/authorize?${new URLSearchParams({
    response_type: params.responseType,
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: params.codeChallengeMethod,
    state: params.state,
    scope: params.scope,
    resource: params.resource,
  })}`;
  // Only the first-party local adapter is asked who it sits beside. Every other
  // client *is* the agent, and has nobody to listen for.
  const localAdapter = isLocalAdapterClient(client.clientName);
  const companions = localAdapter ? await companionCandidates(c.get('db'), user.id) : [];
  // The adapter's name is what "via its adapter …" shows a lead. The generic
  // default ("agent-agent") says nothing there; the target the CLI registered
  // under does.
  const adapterTarget = localAdapter ? /\(([a-z0-9-]{1,40})\)/.exec(client.clientName)?.[1] : undefined;
  const defaultName = hostedClaude
    ? CLAUDE_APP_CLIENT
    : localAdapter
      ? `${adapterTarget ?? 'checkout'}-local-adapter`
      : (checkoutName ?? `${inferredClient === 'generic' ? 'agent' : inferredClient}-agent`);
  c.header('Cache-Control', 'no-store');
  return c.html(
    <AppLayout user={user} active="tokens" title="Authorize agent connection">
      <div class="card card-pad" style="display:flex;flex-direction:column;gap:18px;max-width:760px">
        <div>
          <span class="overline">MCP authorization</span>
          <h1 style="margin:6px 0 8px">Connect this agent to STMA</h1>
          <p class="m0 muted">
            <b>{client.clientName}</b> will return to <code>{redirectHost}</code>. STMA will
            issue a short-lived access token and a rotating refresh token. The client stores them;
            they are never placed in a prompt or repository.
          </p>
          {hostedClaude ? (
            <p class="muted" style="margin:8px 0 0">
              This is the Claude app: one connection for your account on the web, desktop and
              phone. Claude can read your workspaces and, when you ask, write for you, and it asks
              you before each write unless you change that in Claude. It is your console, so it is
              not offered as an agent to give work to.
            </p>
          ) : null}
        </div>
        {entered.error ? (
          <div class="banner banner-error"><span class="ic">!</span><span>{entered.error}</span></div>
        ) : null}
        {choices.length === 0 ? (
          // Somebody who signed up on the way here has no workspace yet, and a
          // banner telling them to make one somewhere else lost the request that
          // was waiting for them. The workspace is made by the one form that
          // makes workspaces, which then sends them back to this request.
          <form class="card card-pad" method="post" action="/app/teams" style="display:flex;flex-direction:column;gap:10px">
            <b>Create your first workspace</b>
            <span class="muted">
              A connection belongs to a workspace, and you are not in one yet. Name it and you come
              straight back here to finish connecting.
            </span>
            <input type="hidden" name="next" value={retry} />
            <div class="row">
              <input class="in" name="name" aria-label="Workspace name" placeholder="Workspace name" maxlength={60} required />
              <button class="btn btn-primary" type="submit">Create workspace</button>
            </div>
          </form>
        ) : null}
        <form class="authform" method="post" action="/oauth/authorize">
          {Object.entries({
            response_type: params.responseType,
            client_id: params.clientId,
            redirect_uri: params.redirectUri,
            code_challenge: params.codeChallenge,
            code_challenge_method: params.codeChallengeMethod,
            state: params.state,
            scope: params.scope,
            resource: params.resource,
          }).map(([name, value]) => <input type="hidden" name={name} value={value} />)}
          <div class="field">
            <label for="oauth-agent-name">Agent name</label>
            <input class="in" id="oauth-agent-name" name="name" value={entered.name ?? defaultName} maxlength={80} required />
            <span class="help">
              {checkoutName ? 'Suggested from the checkout this Claude Code agent connects from. ' : ''}
              The stable identity teammates see on runs and handoffs.
            </span>
          </div>
          {hostedClaude ? null : (
            <div class="field">
              <label for="oauth-device">Machine</label>
              <input class="in" id="oauth-device" name="device" placeholder="guest-macbook" value={entered.device ?? ''} maxlength={60} required />
              <span class="help">A readable label only; STMA does not infer or upload your hostname.</span>
            </div>
          )}
          <div class="field">
            <label>Client reported by OAuth</label>
            <div><code>{inferredClient}</code></div>
            <span class="help">
              Fixed from the connecting client's registration. It cannot be changed on this screen.
            </span>
          </div>
          <div class="field">
            <label for="oauth-access">Access</label>
            <select class="in" id="oauth-access" name="access" required>
              {choices.map((team) => (
                <optgroup label={team.name}>
                  <option value={`team:${team.id}`} selected={preferred === `team:${team.id}`}>Entire workspace — {team.slug}</option>
                  {team.projects.map((project) => (
                    <option value={`project:${project.id}`} selected={preferred === `project:${project.id}`}>Project only — {project.name}</option>
                  ))}
                </optgroup>
              ))}
              <option value="personal" selected={preferred === 'personal'}>Personal — all current workspace memberships</option>
            </select>
            <span class="help">
              {hostedClaude
                ? 'Personal follows your memberships, which is what a chat that answers across workspaces needs. A workspace or a project keeps it to one.'
                : 'Project only is the default and least-privilege choice.'}
            </span>
          </div>
          {localAdapter ? (
            <div class="field">
              <label for="oauth-companion">Listens for</label>
              {/* No default, like the baseline dialog: the page cannot know which
                  agent works in this checkout, and a guess from two similar
                  names is how the wrong agent gets named on a violation. */}
              <select class="in" id="oauth-companion" name="companion" aria-describedby="oauth-companion-help" required>
                <option value="" selected={entered.companion === undefined} disabled>Choose the agent that works in this checkout…</option>
                {companions.map((agent) => (
                  <option value={agent.installationId} selected={entered.companion === agent.installationId}>
                    {agent.name}{agent.device ? ` · ${agent.device}` : ''} · {agent.client} · {agent.access}
                  </option>
                ))}
                <option value="none" selected={entered.companion === 'none'}>Nobody — install the hooks without pairing</option>
              </select>
              <span class="help" id="oauth-companion-help">
                This connection is the STMA CLI's local adapter, a separate installation from your
                agent's MCP connection. Paired, its prompt hook tells that agent about work assigned
                to it by name, an edit the file guard stops is filed under that agent's name,
                "via its adapter", and that agent may update, finish and hand off the runs these
                hooks start in this checkout. It must be one of your own agents that can reach the
                project chosen above. That is all it moves, and it moves it one way: the adapter
                cannot accept work or touch the agent's own runs. You can change it later on Agent
                connections, which takes the run back on that agent's next call.
                {companions.length === 0
                  ? ' None of your connected agents can be paired yet: connect the agent\'s MCP first, or pair later.'
                  : ''}
              </span>
            </div>
          ) : null}
          <details><summary>Agent role (optional)</summary>
            <div class="field" style="margin-top:10px">
              <label for="oauth-role">Role</label>
              <select class="in" id="oauth-role" name="role">
                {AGENT_ROLES.map((role) => <option value={role} selected={role === 'generalist'}>{role}</option>)}
              </select>
            </div>
          </details>
          <div class="banner banner-info">
            <span class="ic">i</span>
            {localAdapter ? (
              <span>This approves the STMA CLI's local adapter for one checkout. The CLI installs the project-local hooks it described in your terminal; STMA's server installs nothing, and this does not authorize repository edits.</span>
            ) : (
              <span>This grants STMA MCP access only. It does not install local hooks or file guards and does not authorize repository edits.</span>
            )}
          </div>
          <div class="row">
            <button class="btn btn-primary" type="submit" name="decision" value="allow" disabled={choices.length === 0}>Allow connection</button>
            <button class="btn" type="submit" name="decision" value="deny">Cancel</button>
          </div>
        </form>
      </div>
    </AppLayout>,
    entered.error ? 400 : 200,
  );
}

oauthRoutes.get('/oauth/authorize', async (c) => {
  const params = queryParams(c);
  const checked = await authorizeRequest(c, params);
  if (!checked.ok) return c.text(checked.message, 400);
  const user = c.get('user');
  if (!user) {
    const url = new URL(c.req.url);
    return c.redirect(`/login?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
  }
  return consentPage(c, user, checked.client, params);
});

function redirectOAuth(redirectUri: string, values: Record<string, string>) {
  const target = new URL(redirectUri);
  for (const [key, value] of Object.entries(values)) if (value) target.searchParams.set(key, value);
  return target.toString();
}

oauthRoutes.post('/oauth/authorize', async (c) => {
  const user = c.get('user');
  if (!user) return c.text('Sign in before authorizing this connection.', 401);
  const body = (await c.req.parseBody()) as Record<string, unknown>;
  const params = bodyParams(body);
  const checked = await authorizeRequest(c, params);
  if (!checked.ok) return c.text(checked.message, 400);
  if (body.decision !== 'allow') {
    return c.redirect(redirectOAuth(params.redirectUri, { error: 'access_denied', state: params.state }));
  }
  // The client registration, not an editable browser field, owns this label.
  // It is still self-reported OAuth metadata, but a Codex callback must not be
  // turned into a Claude installation by changing one form value.
  const clientType = clientTypeFor(checked.client);
  // A Claude app connection has no machine, so the page asks for none and the
  // label says where it lives; a posted value cannot rename that either.
  const hostedClaude = clientType === CLAUDE_APP_CLIENT;
  const name = stringValue(body.name, 80);
  const device = hostedClaude ? HOSTED_CLAUDE_DEVICE : normalizeDeviceLabel(stringValue(body.device, 60));
  const requestedRole = stringValue(body.role, 40);
  const role = (AGENT_ROLES as readonly string[]).includes(requestedRole)
    ? (requestedRole as AgentRole)
    : 'generalist';
  if (!name || !device) return c.text('Name this agent and machine before allowing it.', 400);

  const choices = await connectionTeams(c, user.id);
  const access = stringValue(body.access, 128);
  let scope: TokenScope;
  let selectedTeam: ConnectionTeam | undefined;
  let selectedProject: ConnectionTeam['projects'][number] | undefined;
  if (access === 'personal') {
    scope = 'personal';
  } else if (access.startsWith('team:')) {
    scope = 'team';
    selectedTeam = choices.find((team) => team.id === access.slice(5));
  } else if (access.startsWith('project:')) {
    scope = 'project';
    const projectId = access.slice(8);
    selectedTeam = choices.find((team) => team.projects.some((project) => project.id === projectId));
    selectedProject = selectedTeam?.projects.find((project) => project.id === projectId);
  } else {
    return c.text('Choose an access boundary for this connection.', 400);
  }
  if ((scope !== 'personal' && !selectedTeam) || (scope === 'project' && !selectedProject)) {
    return c.text('That workspace or project is no longer available to your account.', 403);
  }

  // Who the adapter listens for. Read only from the first-party adapter's own
  // consent: a forged field on any other client's form must not turn an agent
  // into somebody's ears and take it out of the assign picker.
  let companionOf: string | undefined;
  const requestedCompanion = stringValue(body.companion, 64);
  if (isLocalAdapterClient(checked.client.clientName) && requestedCompanion && requestedCompanion !== 'none') {
    const resolved = UUID_RE.test(requestedCompanion)
      ? await resolveCompanion(c.get('db'), user.id, requestedCompanion, {
          scope,
          teamId: selectedTeam?.id ?? null,
          projectId: selectedProject?.id ?? null,
        })
      : { error: 'Choose one of your own connected agents to pair with.' };
    if ('error' in resolved) {
      return consentPage(c, user, checked.client, params, {
        error: resolved.error,
        name,
        device,
        access,
        companion: requestedCompanion,
      });
    }
    companionOf = resolved.target.installationId;
  }

  try {
    const issued = await createAgentEnrollment(c.get('db'), {
      userId: user.id,
      name,
      deviceLabel: device,
      clientType,
      role,
      scope,
      teamId: selectedTeam?.id,
      projectId: selectedProject?.id,
      companionOf,
    });
    const code = `stma_oauth_code_${randomHex(32)}`;
    await c.get('db').insert(oauthAuthorizationCodes).values({
      codeHash: sha256hex(code),
      clientId: checked.client.id,
      enrollmentId: issued.enrollment.id,
      redirectUri: params.redirectUri,
      resource: params.resource,
      scope: checked.scope,
      codeChallenge: params.codeChallenge,
      expiresAt: new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS),
    });
    logLine({
      evt: 'mcp_oauth',
      a: 'authorized',
      enrollment: issued.enrollment.id,
      client: clientType,
      scope,
      team: selectedTeam?.slug,
      project: selectedProject?.slug,
    });
    return c.redirect(redirectOAuth(params.redirectUri, { code, state: params.state }));
  } catch (error) {
    if (error instanceof SecurityRefusal) return c.text(error.message, 403);
    throw error;
  }
});

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

oauthRoutes.post('/oauth/token', async (c) => {
  const body = (await c.req.parseBody()) as Record<string, unknown>;
  const grantType = stringValue(body.grant_type, 64);
  const clientId = stringValue(body.client_id, 256);
  const resource = stringValue(body.resource, 2048);
  if (!CLIENT_ID_RE.test(clientId) || resource !== resourceUri(c)) {
    return oauthJsonError(c, 'invalid_grant', 'The OAuth client or MCP resource does not match.', 400);
  }
  if (grantType === 'authorization_code') {
    const rawCode = stringValue(body.code, 256);
    const redirectUri = stringValue(body.redirect_uri, 2048);
    const verifier = stringValue(body.code_verifier, 256);
    if (!CODE_RE.test(rawCode) || !PKCE_RE.test(verifier)) {
      return oauthJsonError(c, 'invalid_grant', 'The authorization code or PKCE verifier is invalid.', 400);
    }
    try {
      const exchanged = await c.get('db').transaction(async (tx) => {
        const db = tx as unknown as Db;
        const [authorization] = await db
          .select()
          .from(oauthAuthorizationCodes)
          .where(eq(oauthAuthorizationCodes.codeHash, sha256hex(rawCode)))
          .limit(1);
        if (
          !authorization ||
          authorization.clientId !== clientId ||
          authorization.redirectUri !== redirectUri ||
          authorization.resource !== resource ||
          authorization.expiresAt <= new Date() ||
          authorization.consumedAt ||
          pkceChallenge(verifier) !== authorization.codeChallenge
        ) return null;
        const consumed = await db
          .update(oauthAuthorizationCodes)
          .set({ consumedAt: new Date() })
          .where(and(
            eq(oauthAuthorizationCodes.id, authorization.id),
            isNull(oauthAuthorizationCodes.consumedAt),
            gt(oauthAuthorizationCodes.expiresAt, new Date()),
          ))
          .returning({ id: oauthAuthorizationCodes.id });
        if (!consumed[0]) return null;
        const [enrollment] = await db
          .select({ userId: agentEnrollments.userId })
          .from(agentEnrollments)
          .where(eq(agentEnrollments.id, authorization.enrollmentId))
          .limit(1);
        if (!enrollment) return null;
        // Which client this code was issued to decides whether the installation
        // is marked as a local adapter — the one durable fact that later tells an
        // adapter from an agent on Agent connections and in the assign picker.
        const [registered] = await db
          .select({ clientName: oauthClients.clientName })
          .from(oauthClients)
          .where(eq(oauthClients.id, clientId))
          .limit(1);
        const redeemed = await redeemAgentEnrollmentByIdInTransaction(
          db,
          authorization.enrollmentId,
          enrollment.userId,
          {
            accessExpiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_MS),
            audience: resource,
            localAdapter: Boolean(registered && isLocalAdapterClient(registered.clientName)),
          },
        );
        if (!redeemed.ok) return null;
        const refreshToken = `stma_refresh_${randomHex(32)}`;
        await db.insert(oauthRefreshTokens).values({
          tokenHash: sha256hex(refreshToken),
          tokenId: redeemed.value.tokenId,
          clientId,
          resource,
          scope: authorization.scope,
        });
        await db.update(oauthClients).set({ lastUsedAt: new Date() }).where(eq(oauthClients.id, clientId));
        return { redeemed: redeemed.value, refreshToken, scope: authorization.scope };
      });
      if (!exchanged) return oauthJsonError(c, 'invalid_grant', 'The authorization code is expired, consumed or does not match this client.', 400);
      const expiresIn = Math.max(1, Math.floor(((exchanged.redeemed.credentialExpiresAt?.getTime() ?? Date.now()) - Date.now()) / 1000));
      // Non-secret installation metadata lets Stage distinguish native MCP and
      // checkout-local adapter grants in real multi-device acceptance. Never
      // log either OAuth token, the authorization code, or the PKCE verifier.
      logLine({
        evt: 'mcp_oauth', a: 'token_issued',
        installation: exchanged.redeemed.installation.id,
        installationName: exchanged.redeemed.installation.name,
        device: exchanged.redeemed.installation.deviceLabel,
        client: exchanged.redeemed.installation.clientType,
        scope: exchanged.redeemed.enrollment.scope,
        team: exchanged.redeemed.team?.slug,
        project: exchanged.redeemed.project?.slug,
        oauthClient: clientId.slice(0, 24),
        // The owner's explicit pairing, so evidence can join an adapter to its
        // agent by a server fact instead of by how two installations were named.
        companionOf: exchanged.redeemed.companion?.installationId,
      });
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json({
        access_token: exchanged.redeemed.token,
        token_type: 'Bearer',
        expires_in: expiresIn,
        refresh_token: exchanged.refreshToken,
        scope: exchanged.scope,
      });
    } catch (error) {
      if (error instanceof SecurityRefusal) return oauthJsonError(c, 'invalid_grant', 'The approved STMA access is no longer available.', 400);
      throw error;
    }
  }

  if (grantType === 'refresh_token') {
    const rawRefresh = stringValue(body.refresh_token, 256);
    if (!REFRESH_RE.test(rawRefresh)) return oauthJsonError(c, 'invalid_grant', 'The refresh token is invalid.', 400);
    const rotated = await c.get('db').transaction(async (tx) => {
      const db = tx as unknown as Db;
      const [row] = await db
        .select({ refresh: oauthRefreshTokens, token: tokens })
        .from(oauthRefreshTokens)
        .innerJoin(tokens, eq(oauthRefreshTokens.tokenId, tokens.id))
        .where(eq(oauthRefreshTokens.tokenHash, sha256hex(rawRefresh)))
        .limit(1);
      if (!row || row.refresh.clientId !== clientId || row.refresh.resource !== resource || row.refresh.revokedAt || row.token.revokedAt) return null;
      let replay = Boolean(row.refresh.usedAt) && Date.now() - row.refresh.usedAt!.getTime() <= REFRESH_REPLAY_GRACE_MS;
      if (replay) {
        // Only while the connection has not moved on. A refresh token spent after
        // this one means the client did get its answer, so this is reuse.
        const [later] = await db
          .select({ id: oauthRefreshTokens.id })
          .from(oauthRefreshTokens)
          .where(and(eq(oauthRefreshTokens.tokenId, row.token.id), gt(oauthRefreshTokens.usedAt, row.refresh.usedAt!)))
          .limit(1);
        if (later) replay = false;
      }
      if (row.refresh.usedAt && !replay) {
        const now = new Date();
        await db.update(oauthRefreshTokens).set({ revokedAt: now }).where(eq(oauthRefreshTokens.tokenId, row.token.id));
        await db.update(tokens).set({ revokedAt: now }).where(eq(tokens.id, row.token.id));
        const [installation] = await db
          .select({ id: agentInstallations.id })
          .from(agentInstallations)
          .where(eq(agentInstallations.tokenId, row.token.id))
          .limit(1);
        return {
          kind: 'reuse' as const,
          installationId: installation?.id ?? null,
          tokenId: row.token.id,
          userId: row.token.userId,
        };
      }
      const [installation] = await db
        .select({ id: agentInstallations.id, revokedAt: agentInstallations.revokedAt })
        .from(agentInstallations)
        .where(eq(agentInstallations.tokenId, row.token.id))
        .limit(1);
      const membership = row.token.scope === 'personal'
        ? { userId: row.token.userId }
        : (await db
            .select({ userId: memberships.userId })
            .from(memberships)
            .where(and(
              eq(memberships.userId, row.token.userId),
              eq(memberships.teamId, row.token.teamId!),
            ))
            .limit(1))[0];
      setSecurityPrincipal({
        userId: row.token.userId,
        tokenId: row.token.id,
        teamId: row.token.teamId,
        projectId: row.token.projectId,
        path: '/mcp',
        method: 'POST',
      });
      const securityDenied = await authorizeSecurity(db, 'credential');
      if (!installation || installation.revokedAt || !membership || securityDenied) {
        const now = new Date();
        await db.update(oauthRefreshTokens).set({ revokedAt: now }).where(eq(oauthRefreshTokens.tokenId, row.token.id));
        await db.update(tokens).set({ revokedAt: now }).where(eq(tokens.id, row.token.id));
        return {
          kind: 'access_lost' as const,
          installationId: installation?.id ?? null,
          tokenId: row.token.id,
          userId: row.token.userId,
        };
      }
      if (!replay) {
        const spentAt = new Date();
        const spent = await db
          .update(oauthRefreshTokens)
          .set({ usedAt: spentAt })
          .where(and(eq(oauthRefreshTokens.id, row.refresh.id), isNull(oauthRefreshTokens.usedAt), isNull(oauthRefreshTokens.revokedAt)))
          .returning({ id: oauthRefreshTokens.id });
        if (spent[0]) {
          // A replay answered earlier may have left a second live refresh token
          // whose response the client did not keep. Spending this one retires it,
          // so a connection holds one live refresh token again. It is marked spent
          // before the window began, so presenting it later is reuse at once and
          // never a replay: a token nobody should still hold gets no grace.
          await db
            .update(oauthRefreshTokens)
            .set({ usedAt: new Date(spentAt.getTime() - REFRESH_REPLAY_GRACE_MS - 1_000) })
            .where(and(eq(oauthRefreshTokens.tokenId, row.token.id), isNull(oauthRefreshTokens.usedAt), isNull(oauthRefreshTokens.revokedAt)));
        } else {
          // Another request spent this token a moment ago: the same client racing
          // itself, a proactive refresh beside a reactive one. That is a replay.
          const [again] = await db
            .select({ usedAt: oauthRefreshTokens.usedAt, revokedAt: oauthRefreshTokens.revokedAt })
            .from(oauthRefreshTokens)
            .where(eq(oauthRefreshTokens.id, row.refresh.id))
            .limit(1);
          if (!again?.usedAt || again.revokedAt) return null;
          replay = true;
        }
      }
      const access = generatePat();
      const refreshToken = `stma_refresh_${randomHex(32)}`;
      const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);
      await db.update(tokens).set({ tokenHash: access.hash, prefix: access.prefix, expiresAt }).where(eq(tokens.id, row.token.id));
      await db.insert(oauthRefreshTokens).values({
        tokenHash: sha256hex(refreshToken),
        tokenId: row.token.id,
        clientId,
        resource,
        scope: row.refresh.scope,
      });
      await db.update(oauthClients).set({ lastUsedAt: new Date() }).where(eq(oauthClients.id, clientId));
      return { kind: 'rotated' as const, replay, accessToken: access.token, refreshToken, expiresAt, scope: row.refresh.scope, tokenId: row.token.id };
    });
    if (!rotated) return oauthJsonError(c, 'invalid_grant', 'The refresh token is expired, revoked, reused or does not match this client.', 400);
    if (rotated.kind === 'reuse' || rotated.kind === 'access_lost') {
      if (rotated.installationId) {
        await revokeAgentInstallation(c.get('db'), rotated.userId, rotated.installationId);
      }
      logLine({
        evt: 'mcp_oauth',
        a: rotated.kind === 'reuse' ? 'refresh_reuse_revoked' : 'refresh_access_revoked',
        token: rotated.tokenId,
      });
      return oauthJsonError(
        c,
        'invalid_grant',
        rotated.kind === 'reuse'
          ? 'Refresh-token reuse was detected and this agent connection was revoked.'
          : 'This installation or its approved workspace access is no longer active.',
        400,
      );
    }
    logLine({ evt: 'mcp_oauth', a: rotated.replay ? 'refresh_replayed' : 'token_refreshed', token: rotated.tokenId });
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({
      access_token: rotated.accessToken,
      token_type: 'Bearer',
      expires_in: Math.max(1, Math.floor((rotated.expiresAt.getTime() - Date.now()) / 1000)),
      refresh_token: rotated.refreshToken,
      scope: rotated.scope,
    });
  }
  return oauthJsonError(c, 'unsupported_grant_type', 'Use authorization_code or refresh_token.', 400);
});

oauthRoutes.post('/oauth/revoke', async (c) => {
  const body = (await c.req.parseBody()) as Record<string, unknown>;
  const raw = stringValue(body.token, 256);
  const clientId = stringValue(body.client_id, 256);
  let tokenRow: typeof tokens.$inferSelect | undefined;
  if (raw.startsWith('stma_refresh_')) {
    const [found] = await c.get('db')
      .select({ token: tokens, clientId: oauthRefreshTokens.clientId })
      .from(oauthRefreshTokens)
      .innerJoin(tokens, eq(oauthRefreshTokens.tokenId, tokens.id))
      .where(eq(oauthRefreshTokens.tokenHash, sha256hex(raw)))
      .limit(1);
    if (found && (!clientId || found.clientId === clientId)) tokenRow = found.token;
  } else if (raw.startsWith('stma_')) {
    const [found] = await c.get('db').select().from(tokens).where(eq(tokens.tokenHash, sha256hex(raw))).limit(1);
    if (found) tokenRow = found;
  }
  if (tokenRow) {
    const [installation] = await c.get('db')
      .select({ id: agentInstallations.id })
      .from(agentInstallations)
      .where(eq(agentInstallations.tokenId, tokenRow.id))
      .limit(1);
    if (installation?.id) await revokeAgentInstallation(c.get('db'), tokenRow.userId, installation.id);
    else await c.get('db').update(tokens).set({ revokedAt: new Date() }).where(eq(tokens.id, tokenRow.id));
    await c.get('db').update(oauthRefreshTokens).set({ revokedAt: new Date() }).where(eq(oauthRefreshTokens.tokenId, tokenRow.id));
    logLine({ evt: 'mcp_oauth', a: 'token_revoked', token: tokenRow.id });
  }
  c.header('Cache-Control', 'no-store');
  return c.body(null, 200);
});
