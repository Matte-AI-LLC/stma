/**
 * Jira, for delivery flows whose tickets live there: verify a connection and
 * read one issue, nothing more. STMA never writes to Jira — the flow tells
 * agents how tickets relate to branches; it does not manage the tracker.
 *
 * Transport mirrors lib/github: real API normally, an in-memory recorder under
 * NODE_ENV=test answering in Jira's wire shape.
 *
 * **Two API generations, one connection form** (2026-08-31). Atlassian
 * deprecated scopeless API tokens (the old ones expired March–May 2026); the
 * tokens people can mint now are *scoped*, and a scoped token is refused by
 * `https://{site}.atlassian.net` basic auth — it only answers on
 * `https://api.atlassian.com/ex/jira/{cloudId}`. Same email+token basic auth,
 * different front door. So the connection check tries the site host first
 * (legacy tokens still exist) and falls back to the cloud-id door, resolving
 * the cloudId from the site's public `/_edge/tenant_info`; whichever door
 * answered is stored on the integration row so later calls go straight there.
 *
 * SSRF surface stays closed: the site must match `*.atlassian.net`,
 * `api.atlassian.com` is a literal, and a cloudId is only ever a UUID.
 */
import type { Env } from '../env';
import { logLine } from './log';

export interface JiraConfig {
  /** "acme.atlassian.net" — host only. */
  site: string;
  /** Atlassian account email the API token belongs to. */
  email: string;
  token: string;
  /** Set when the token is a scoped one: calls go via api.atlassian.com/ex/jira. */
  cloudId?: string;
}

export type JiraResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Host only, cloud sites only. Returns null rather than guessing. */
export function normalizeJiraSite(input: string): string | null {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  return /^[a-z0-9][a-z0-9-]*\.atlassian\.net$/.test(cleaned) ? cleaned : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ------------------------------------------------------------------ memory mode

interface RecordedCall {
  method: string;
  path: string;
  /** Which front door the fake was called through. */
  base: 'site' | 'cloudid';
  at: Date;
}

const calls: RecordedCall[] = [];
const CALL_CAP = 200;
/** When set, the fake answers auth requests the way Jira answers a wrong credential. */
let authFails = false;
/** When set, the fake behaves like a scoped token: site-host auth fails, cloud-id works. */
let scopedOnly = false;

export const jiraOutbox = {
  all(): readonly RecordedCall[] {
    return calls;
  },
  seedAuthFailure(fail: boolean): void {
    authFails = fail;
  },
  seedScopedToken(scoped: boolean): void {
    scopedOnly = scoped;
  },
  clear(): void {
    calls.length = 0;
    authFails = false;
    scopedOnly = false;
  },
};

/** The cloudId the memory transport hands out. */
export const FAKE_CLOUD_ID = '11111111-2222-3333-4444-555555555555';

// --------------------------------------------------------------------- requests

const baseUrl = (config: JiraConfig): string =>
  config.cloudId
    ? `https://api.atlassian.com/ex/jira/${config.cloudId}`
    : `https://${config.site}`;

async function request<T>(
  env: Env,
  config: JiraConfig,
  path: string,
): Promise<JiraResult<T>> {
  const base: 'site' | 'cloudid' = config.cloudId ? 'cloudid' : 'site';
  if (env.nodeEnv === 'test') {
    calls.push({ method: 'GET', path, base, at: new Date() });
    if (calls.length > CALL_CAP) calls.splice(0, calls.length - CALL_CAP);
    if (authFails) return { ok: false, error: 'bad_token' };
    // A scoped token is turned away at the site door and welcomed at the other.
    if (scopedOnly && base === 'site') return { ok: false, error: 'bad_token' };
    if (path === '/rest/api/3/myself') {
      // Jira's wire shape.
      return {
        ok: true,
        value: { displayName: 'Test Person', emailAddress: config.email } as unknown as T,
      };
    }
    const issue = /\/rest\/api\/3\/issue\/([A-Z][A-Z0-9]+-\d+)/.exec(path);
    if (issue) {
      return {
        ok: true,
        value: {
          key: issue[1],
          fields: { summary: `Seeded summary for ${issue[1]}`, status: { name: 'To Do' } },
        } as unknown as T,
      };
    }
    return { ok: false, error: 'http_404' };
  }

  try {
    const res = await fetch(`${baseUrl(config)}${path}`, {
      headers: {
        accept: 'application/json',
        authorization: `Basic ${Buffer.from(`${config.email}:${config.token}`).toString('base64')}`,
        'user-agent': 'stma',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      logLine({ evt: 'jira', a: 'error', status: res.status, base, path: path.slice(0, 120) });
      return {
        ok: false,
        error:
          res.status === 404
            ? 'not_found_or_no_access'
            : res.status === 401 || res.status === 403
              ? 'bad_token'
              : `http_${res.status}`,
      };
    }
    return { ok: true, value: (await res.json()) as T };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 120) : 'request_failed' };
  }
}

/**
 * The site's cloud id, from its public tenant-info endpoint. Anonymous by
 * design on Atlassian's side, so this can run before any credential is right.
 */
export async function resolveCloudId(env: Env, site: string): Promise<string | null> {
  if (env.nodeEnv === 'test') return FAKE_CLOUD_ID;
  try {
    const res = await fetch(`https://${site}/_edge/tenant_info`, {
      headers: { accept: 'application/json', 'user-agent': 'stma' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { cloudId?: string };
    return body.cloudId && UUID_RE.test(body.cloudId) ? body.cloudId : null;
  } catch {
    return null;
  }
}

/**
 * Soft fingerprint: personal API tokens have started with "ATATT" since 2022.
 * Old tokens without the prefix still exist, so this may only soften wording,
 * never block — a "looks wrong" that refuses a working credential is worse
 * than no check.
 */
export const looksLikeUserApiToken = (token: string): boolean => token.startsWith('ATATT');

/**
 * The admin-key trap, named. Creating a key on admin.atlassian.com hands back
 * an Organization ID next to it — which reads like progress and is a
 * completely different credential (org user-management API, cannot touch
 * issues). Seen live 2026-08-31: the very first person to connect Jira walked
 * into it.
 */
export const ADMIN_KEY_HINT =
  ' Also: this token does not look like a personal API token (those start with "ATATT"). If the page that created it showed an Organization ID next to it, that was an admin API key from admin.atlassian.com — a different credential that cannot read Jira. Use id.atlassian.com → Security → API tokens instead.';

/** The remediation sentence for a Jira failure — same role as describeAdoFailure. */
export function describeJiraFailure(error: string, token?: string): string {
  if (error === 'bad_token') {
    return (
      'Jira refused the credentials on both API doors (the site host and api.atlassian.com). The token must be a personal API token from id.atlassian.com (Security → API tokens) — scoped ones work, but need the Jira app with at least read:jira-user and read:jira-work — used with the email of the Atlassian account that created it. A Jira password or an SSO login does not work here.' +
      (token !== undefined && !looksLikeUserApiToken(token) ? ADMIN_KEY_HINT : '')
    );
  }
  if (error === 'not_found_or_no_access') {
    return 'The site answered but this account cannot see it. Check the site name, and that this Atlassian account has access to this Jira site.';
  }
  if (error === 'request_failed' || error.includes('timeout') || error.includes('abort')) {
    return 'Jira did not answer in time — usually transient. Try again.';
  }
  return `Jira refused the request (${error}).`;
}

/**
 * Who this token is — run on save, on the Test button, and before trusting the
 * connection anywhere. Tries the legacy site door first, then the scoped-token
 * door; says which one answered so the caller can store it and skip the dance
 * next time.
 */
export async function checkJiraConnection(
  env: Env,
  config: JiraConfig,
): Promise<JiraResult<{ displayName: string; cloudId?: string }>> {
  // A stored cloudId means the scoped door already proved itself once.
  if (config.cloudId) {
    const scoped = await request<{ displayName?: string }>(env, config, '/rest/api/3/myself');
    return scoped.ok
      ? { ok: true, value: { displayName: scoped.value.displayName ?? 'unknown', cloudId: config.cloudId } }
      : scoped;
  }
  const direct = await request<{ displayName?: string }>(env, config, '/rest/api/3/myself');
  if (direct.ok) {
    return { ok: true, value: { displayName: direct.value.displayName ?? 'unknown' } };
  }
  if (direct.error !== 'bad_token') return direct;
  // The site door said no. If this is a scoped token, the other door will say
  // yes to the very same credentials.
  const cloudId = await resolveCloudId(env, config.site);
  if (!cloudId) return direct;
  const scoped = await request<{ displayName?: string }>(
    env,
    { ...config, cloudId },
    '/rest/api/3/myself',
  );
  if (!scoped.ok) return direct;
  logLine({ evt: 'jira', a: 'scoped_token_detected', site: config.site });
  return {
    ok: true,
    value: { displayName: scoped.value.displayName ?? 'unknown', cloudId },
  };
}

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  url: string;
}

export async function getJiraIssue(
  env: Env,
  config: JiraConfig,
  key: string,
): Promise<JiraResult<JiraIssue>> {
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) return { ok: false, error: 'not_an_issue_key' };
  const res = await request<{ key: string; fields?: { summary?: string; status?: { name?: string } } }>(
    env,
    config,
    `/rest/api/3/issue/${key}?fields=summary,status`,
  );
  if (!res.ok) return res;
  return {
    ok: true,
    value: {
      key: res.value.key,
      summary: res.value.fields?.summary ?? '',
      status: res.value.fields?.status?.name ?? '',
      // People land on the site, whichever API door the token uses.
      url: `https://${config.site}/browse/${res.value.key}`,
    },
  };
}
