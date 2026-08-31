/**
 * The GitHub Issues half of the DevOps track.
 *
 * A run has always carried a `task` string, which was honest but inert: the
 * agent typed "PAY-421" and nothing anywhere knew what that was. Meanwhile the
 * way people actually pick up work is from an issue. This closes both
 * directions with the smallest surface that could work — a team token and one
 * repository, no OAuth app, no webhook registration:
 *
 *  - **issue → run**: `list_issues` shows what is open, and `start_run` can take
 *    an issue number instead of a made-up task key, pulling the title in as the
 *    intent so the map says what the work is.
 *  - **run → issue**: when a run that names an issue finishes or hands off, the
 *    issue gets a comment saying so. That is the line a human reads on Monday.
 *
 * Transport mirrors lib/mailer: the real API in normal operation, an in-memory
 * recorder under NODE_ENV=test, so the suite exercises every decision here
 * without a network call or a real token.
 */
import type { Env } from '../env';
import { logLine } from './log';

const API_ROOT = 'https://api.github.com';
/** GitHub's own cap is 100; ours is smaller because this is a picker, not a mirror. */
export const ISSUE_PAGE_SIZE = 20;

export interface GithubConfig {
  /** "owner/name". */
  repo: string;
  token: string;
}

export interface GithubIssue {
  number: number;
  title: string;
  url: string;
  labels: string[];
  updatedAt: string;
  body?: string;
}

export type GithubResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type GithubTransport = 'api' | 'memory';

export function githubTransport(env: Env): GithubTransport {
  return env.nodeEnv === 'test' ? 'memory' : 'api';
}

/** "owner/name", lowercase-insensitive, no leading URL or trailing slash. */
export function normalizeRepo(input: string): string | null {
  const cleaned = input
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(cleaned) ? cleaned : null;
}

/**
 * The issue a task key points at, if it points at one.
 *
 * Accepts what people actually type: "#42", "owner/repo#42", and a pasted issue
 * URL. A bare number is deliberately NOT an issue reference — "421" is a
 * perfectly ordinary internal ticket id, and guessing would make STMA comment
 * on a stranger's issue.
 */
export function parseIssueRef(
  taskKey: string | null | undefined,
  defaultRepo: string,
): { repo: string; number: number } | null {
  const key = taskKey?.trim();
  if (!key) return null;
  const url = /github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/issues\/(\d+)/i.exec(key);
  if (url) return { repo: url[1]!, number: Number(url[2]) };
  const qualified = /^([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)#(\d+)$/.exec(key);
  if (qualified) return { repo: qualified[1]!, number: Number(qualified[2]) };
  const short = /^#(\d+)$/.exec(key);
  if (short && defaultRepo) return { repo: defaultRepo, number: Number(short[1]) };
  return null;
}

// ------------------------------------------------------------------ memory mode

interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
  at: Date;
}

const calls: RecordedCall[] = [];
let seeded: GithubIssue[] = [];
const CALL_CAP = 200;

/**
 * What the memory transport did and what it will answer. The delivery record
 * for tests, same role `mailOutbox` plays for email.
 */
export const githubOutbox = {
  all(): readonly RecordedCall[] {
    return calls;
  },
  comments(): RecordedCall[] {
    return calls.filter((c) => c.method === 'POST' && c.path.includes('/comments'));
  },
  seedIssues(issues: GithubIssue[]): void {
    seeded = issues;
  },
  clear(): void {
    calls.length = 0;
    seeded = [];
  },
};

// --------------------------------------------------------------------- requests

async function request<T>(
  env: Env,
  config: GithubConfig,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<GithubResult<T>> {
  if (githubTransport(env) === 'memory') {
    calls.push({ method, path, body, at: new Date() });
    if (calls.length > CALL_CAP) calls.splice(0, calls.length - CALL_CAP);
    // Answers in GitHub's wire shape, not ours, so the mapping below is under
    // test too — a fake that returns the already-parsed type would have hidden
    // exactly the field-name bug it exists to catch.
    if (method === 'GET' && path.includes('/issues?')) {
      return { ok: true, value: seeded.map(toRaw) as unknown as T };
    }
    const single = /\/issues\/(\d+)$/.exec(path);
    if (method === 'GET' && single) {
      const found = seeded.find((i) => i.number === Number(single[1]));
      return found
        ? { ok: true, value: toRaw(found) as unknown as T }
        : { ok: false, error: 'http_404' };
    }
    return { ok: true, value: {} as T };
  }

  try {
    const res = await fetch(`${API_ROOT}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${config.token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'stma',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      // The token and the repo are the two things that are ever wrong here, and
      // GitHub answers both with a 404 to avoid confirming private repos exist.
      logLine({ evt: 'github', a: 'error', status: res.status, path });
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

interface RawIssue {
  number: number;
  title: string;
  html_url: string;
  updated_at: string;
  body?: string | null;
  pull_request?: unknown;
  labels?: Array<{ name?: string } | string>;
}

/** The inverse of `toIssue`, for the memory transport's canned answers. */
const toRaw = (issue: GithubIssue): RawIssue => ({
  number: issue.number,
  title: issue.title,
  html_url: issue.url,
  updated_at: issue.updatedAt,
  body: issue.body ?? null,
  labels: issue.labels,
});

const toIssue = (raw: RawIssue): GithubIssue => ({
  number: raw.number,
  title: raw.title,
  url: raw.html_url,
  updatedAt: raw.updated_at,
  body: raw.body ?? undefined,
  labels: (raw.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
});

/**
 * Open issues, newest activity first. Pull requests are filtered out: GitHub
 * returns them from the issues endpoint, and offering an agent a PR as work to
 * pick up is how you get an agent trying to "implement" a review.
 */
export async function listOpenIssues(
  env: Env,
  config: GithubConfig,
  limit = ISSUE_PAGE_SIZE,
): Promise<GithubResult<GithubIssue[]>> {
  const path = `/repos/${config.repo}/issues?state=open&sort=updated&direction=desc&per_page=${Math.min(limit, ISSUE_PAGE_SIZE)}`;
  const res = await request<RawIssue[]>(env, config, 'GET', path);
  if (!res.ok) return res;
  const rows = Array.isArray(res.value) ? res.value : [];
  return { ok: true, value: rows.filter((r) => !r.pull_request).map(toIssue) };
}

export async function getIssue(
  env: Env,
  config: GithubConfig,
  number: number,
  repo?: string,
): Promise<GithubResult<GithubIssue>> {
  const res = await request<RawIssue>(env, config, 'GET', `/repos/${repo ?? config.repo}/issues/${number}`);
  return res.ok ? { ok: true, value: toIssue(res.value) } : res;
}

export async function commentOnIssue(
  env: Env,
  config: GithubConfig,
  number: number,
  body: string,
  repo?: string,
): Promise<GithubResult<true>> {
  const res = await request<unknown>(
    env,
    config,
    'POST',
    `/repos/${repo ?? config.repo}/issues/${number}/comments`,
    { body: body.slice(0, 60_000) },
  );
  return res.ok ? { ok: true, value: true } : res;
}
