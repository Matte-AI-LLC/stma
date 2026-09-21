/**
 * ClickUp OAuth and task transport.
 *
 * A customer connects with ClickUp's browser OAuth flow. STMA never asks them
 * to paste a personal token. Tests use the in-memory transport so authorization,
 * list selection, task reads and comments are covered without external traffic.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Env } from '../env';
import { logLine } from './log';

const API_ROOT = 'https://api.clickup.com/api/v2';
const AUTHORIZE_ROOT = 'https://app.clickup.com/api';
const MAX_LISTS = 100;
const MAX_TASKS = 20;
/**
 * ClickUp's page size for a List's tasks. Not a choice — the endpoint takes a
 * `page` index and hands back a hundred rows at a time, with `last_page` on the
 * final one.
 */
const CLICKUP_PAGE = 100;
/**
 * How far back a search reads, and therefore the only honest thing the page can
 * claim about it.
 *
 * **ClickUp's v2 API has no text parameter for tasks at any endpoint** —
 * neither `/list/{id}/task` nor the workspace's filtered `/team/{id}/task`
 * takes one — so a search here is STMA reading pages and matching them in its
 * own process. Three pages: it covers the workspace this was asked for (a few
 * hundred open tasks) while staying three bounded calls on a lead's click, and
 * a list longer than that is still reachable by pasting the task's link. A page
 * that says `last_page` ends the loop, so most workspaces pay for one call.
 */
export const CLICKUP_SEARCH_PAGES = 3;
export const CLICKUP_SEARCH_SCAN = CLICKUP_SEARCH_PAGES * CLICKUP_PAGE;

export interface ClickupWorkspace {
  id: string;
  name: string;
}

export interface ClickupList {
  id: string;
  name: string;
  path: string;
}

export interface ClickupTask {
  id: string;
  customId: string | null;
  name: string;
  url: string;
  status: string;
  updatedAt: string | null;
}

export interface ClickupConfig {
  workspaceId: string;
  workspaceName: string;
  token: string;
  listId: string;
  listName: string;
  projectId: string;
  commentOnFinish: boolean;
}

export type ClickupResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ClickupPendingAuthorization {
  token: string;
  userId: string;
  teamId: string;
  teamSlug: string;
  workspaces: ClickupWorkspace[];
  expiresAt: number;
}

/** Encrypt the short-lived multi-workspace chooser cookie with the OAuth app secret. */
export function sealClickupPending(env: Env, value: ClickupPendingAuthorization): string {
  if (!env.clickup) throw new Error('ClickUp OAuth is not configured.');
  const key = createHash('sha256').update(env.clickup.clientSecret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

export function openClickupPending(env: Env, sealed: string): ClickupPendingAuthorization | null {
  if (!env.clickup) return null;
  try {
    const raw = Buffer.from(sealed, 'base64url');
    if (raw.length < 29) return null;
    const key = createHash('sha256').update(env.clickup.clientSecret).digest();
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const value = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString()) as ClickupPendingAuthorization;
    return value.expiresAt > Date.now() ? value : null;
  } catch {
    return null;
  }
}

type RecordedCall = { method: string; path: string; body?: unknown; at: Date };
const calls: RecordedCall[] = [];
let seededWorkspaces: ClickupWorkspace[] = [{ id: '1100', name: 'Test workspace' }];
let seededLists: ClickupList[] = [{ id: '2200', name: 'Engineering', path: 'STMA / Engineering' }];
let seededTasks: ClickupTask[] = [];
let seededTaskListId = '2200';
let seededFailure: string | null = null;

export const clickupOutbox = {
  all: (): readonly RecordedCall[] => calls,
  comments: (): readonly RecordedCall[] => calls.filter((c) => c.method === 'POST' && c.path.endsWith('/comment')),
  seed(input: { workspaces?: ClickupWorkspace[]; lists?: ClickupList[]; tasks?: ClickupTask[]; taskListId?: string }) {
    if (input.workspaces) seededWorkspaces = input.workspaces;
    if (input.lists) seededLists = input.lists;
    if (input.tasks) seededTasks = input.tasks;
    if (input.taskListId) seededTaskListId = input.taskListId;
  },
  /**
   * Mirrors `githubOutbox.seedAuthFailure` and `jiraOutbox`'s: a tracker that
   * refuses is a case, not a hope. The call is still recorded, because what a
   * refusal must not do — retry, or be reported as delivered — is only
   * observable if the attempt itself is visible.
   */
  seedFailure(error: string | null): void {
    seededFailure = error;
  },
  clear() {
    calls.length = 0;
    seededWorkspaces = [{ id: '1100', name: 'Test workspace' }];
    seededLists = [{ id: '2200', name: 'Engineering', path: 'STMA / Engineering' }];
    seededTasks = [];
    seededTaskListId = '2200';
    seededFailure = null;
  },
};

export function clickupAuthorizeUrl(env: Env, state: string): string {
  if (!env.clickup) throw new Error('ClickUp OAuth is not configured.');
  const url = new URL(AUTHORIZE_ROOT);
  url.searchParams.set('client_id', env.clickup.clientId);
  url.searchParams.set('redirect_uri', `${env.baseUrl}/auth/clickup/callback`);
  url.searchParams.set('state', state);
  return url.toString();
}

export function normalizeClickupListId(value: string): string | null {
  const input = value.trim();
  const fromUrl = /\/v\/li\/(\d+)/i.exec(input)?.[1] ?? /[?&]list(?:_id)?=(\d+)/i.exec(input)?.[1];
  const id = fromUrl ?? input;
  return /^\d+$/.test(id) ? id : null;
}

export function parseClickupTaskRef(value: string | null | undefined): string | null {
  const input = value?.trim();
  if (!input) return null;
  const fromUrl = /app\.clickup\.com\/t\/([A-Za-z0-9_-]+)/i.exec(input)?.[1];
  const prefixed = /^clickup:([A-Za-z0-9_-]+)$/i.exec(input)?.[1];
  const id = fromUrl ?? prefixed ?? input;
  return /^[A-Za-z0-9_-]{2,64}$/.test(id) ? id : null;
}

/**
 * Which of ClickUp's two id spaces a task reference belongs to, decided by its
 * shape and decided exactly once, here.
 *
 * ClickUp's task endpoint reads a **native** id by default. A workspace's own
 * **custom** id — the `PD-207` its people say out loud — is found only when the
 * call carries `custom_task_ids=true` *together with* `team_id`, and the two
 * lookups are not interchangeable: asking for a custom id without the flag is a
 * 404, which is exactly how `start_run {"clickup_task":"PD-207"}` used to fail.
 *
 * Shape rather than a second parameter, because a task reference arrives from
 * four places (an agent's `clickup_task`, a pasted link, the Assign-work
 * picker, a stored task key) and a flag threaded through all four is a flag
 * that will one day disagree with itself. A custom id is a configured prefix, a
 * hyphen and a number; a native id is lowercase base-36 and can never take that
 * form, so nothing is ambiguous.
 */
const CUSTOM_TASK_ID = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
export const isClickupCustomTaskId = (id: string): boolean => CUSTOM_TASK_ID.test(id);

async function request<T>(
  env: Env,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<ClickupResult<T>> {
  if (env.nodeEnv === 'test') {
    calls.push({ method, path, body, at: new Date() });
    if (seededFailure) return { ok: false, error: seededFailure };
    if (path === '/team') return { ok: true, value: { teams: seededWorkspaces } as T };
    if (/\/space\?/.test(path)) {
      return { ok: true, value: { spaces: [{ id: 'space-1', name: 'STMA' }] } as T };
    }
    if (/\/folder\?/.test(path)) {
      return { ok: true, value: { folders: [{ id: 'folder-1', name: 'Product', lists: seededLists }] } as T };
    }
    if (/\/list\?/.test(path)) return { ok: true, value: { lists: [] } as T };
    if (/\/task\?/.test(path)) {
      // Paged the way ClickUp pages, because the search below depends on it: a
      // fake that answered every page with the whole fixture would report
      // duplicates as matches and would never exercise the stop condition.
      const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? '0');
      const rows = seededTasks.slice(page * CLICKUP_PAGE, (page + 1) * CLICKUP_PAGE);
      return {
        ok: true,
        value: {
          tasks: rows.map(toRaw),
          last_page: (page + 1) * CLICKUP_PAGE >= seededTasks.length,
        } as T,
      };
    }
    const task = /^\/task\/([^/?]+)(?:\?|$)/.exec(path)?.[1];
    if (task && method === 'GET') {
      // The two id spaces are kept apart here exactly as ClickUp keeps them
      // apart: with `custom_task_ids=true` only a custom id answers, without it
      // only a native one. A fake that matched either would pass a caller that
      // forgot the flag, which is the one bug this branch exists to catch.
      const wantsCustom = /[?&]custom_task_ids=true(?:&|$)/.test(path);
      const id = decodeURIComponent(task);
      const found = seededTasks.find((row) => (wantsCustom ? row.customId === id : row.id === id));
      return found
        ? { ok: true, value: { ...toRaw(found), list: { id: seededTaskListId } } as T }
        : { ok: false, error: 'not_found' };
    }
    return { ok: true, value: {} as T };
  }
  try {
    const response = await fetch(`${API_ROOT}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      logLine({ evt: 'clickup', a: 'error', status: response.status, path });
      return {
        ok: false,
        error:
          response.status === 401 || response.status === 403
            ? 'authorization_failed'
            : response.status === 404
              ? 'not_found'
              : response.status === 429
                ? 'rate_limited'
                : `http_${response.status}`,
      };
    }
    return { ok: true, value: (await response.json()) as T };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message.slice(0, 120) : 'request_failed' };
  }
}

export async function exchangeClickupCode(env: Env, code: string): Promise<ClickupResult<string>> {
  if (!env.clickup) return { ok: false, error: 'not_configured' };
  if (env.nodeEnv === 'test') return code ? { ok: true, value: 'pk_test_clickup_oauth' } : { ok: false, error: 'missing_code' };
  try {
    const response = await fetch(`${API_ROOT}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_id: env.clickup.clientId,
        client_secret: env.clickup.clientSecret,
        code,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return { ok: false, error: `http_${response.status}` };
    const body = (await response.json()) as { access_token?: string };
    return body.access_token ? { ok: true, value: body.access_token } : { ok: false, error: 'invalid_response' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message.slice(0, 120) : 'request_failed' };
  }
}

export async function getClickupWorkspaces(env: Env, token: string): Promise<ClickupResult<ClickupWorkspace[]>> {
  const result = await request<{ teams?: Array<{ id?: string; name?: string }> }>(env, token, 'GET', '/team');
  if (!result.ok) return result;
  return {
    ok: true,
    value: (result.value.teams ?? [])
      .filter((row) => row.id && row.name)
      .map((row) => ({ id: String(row.id), name: String(row.name) })),
  };
}

type RawList = { id?: string; name?: string };

export async function listClickupLists(env: Env, token: string, workspaceId: string): Promise<ClickupResult<ClickupList[]>> {
  const spaces = await request<{ spaces?: Array<{ id?: string; name?: string }> }>(env, token, 'GET', `/team/${workspaceId}/space?archived=false`);
  if (!spaces.ok) return spaces;
  const output: ClickupList[] = [];
  for (const space of (spaces.value.spaces ?? []).slice(0, 30)) {
    if (!space.id) continue;
    const [folders, root] = await Promise.all([
      request<{ folders?: Array<{ name?: string; lists?: RawList[] }> }>(env, token, 'GET', `/space/${space.id}/folder?archived=false`),
      request<{ lists?: RawList[] }>(env, token, 'GET', `/space/${space.id}/list?archived=false`),
    ]);
    if (!folders.ok) return folders;
    if (!root.ok) return root;
    for (const list of root.value.lists ?? []) {
      if (list.id && list.name) output.push({ id: String(list.id), name: list.name, path: `${space.name ?? 'Space'} / ${list.name}` });
    }
    for (const folder of folders.value.folders ?? []) {
      for (const list of folder.lists ?? []) {
        if (list.id && list.name) output.push({ id: String(list.id), name: list.name, path: `${space.name ?? 'Space'} / ${folder.name ?? 'Folder'} / ${list.name}` });
      }
    }
    if (output.length >= MAX_LISTS) break;
  }
  return { ok: true, value: output.slice(0, MAX_LISTS) };
}

/**
 * Back into ClickUp's own wire shape, so the memory transport answers what the
 * API answers and `mapTask` below is under test too. A fake that returned the
 * already-mapped type would hide exactly the field-name bug it exists to catch
 * — `custom_id` was invisible until this existed. Same rule the GitHub fake
 * follows.
 */
const toRaw = (task: ClickupTask): Record<string, unknown> => ({
  id: task.id,
  custom_id: task.customId,
  name: task.name,
  url: task.url,
  status: { status: task.status },
  date_updated: task.updatedAt ? String(Date.parse(task.updatedAt)) : null,
});

const mapTask = (raw: any): ClickupTask => ({
  id: String(raw.id),
  customId: raw.custom_id ? String(raw.custom_id) : null,
  name: String(raw.name ?? ''),
  url: String(raw.url ?? `https://app.clickup.com/t/${raw.id}`),
  status: String(raw.status?.status ?? raw.status ?? 'unknown'),
  updatedAt: raw.date_updated ? new Date(Number(raw.date_updated)).toISOString() : raw.updatedAt ?? null,
});

const tasksPath = (listId: string, page: number) =>
  `/list/${listId}/task?archived=false&include_closed=false&page=${page}&order_by=updated&reverse=true`;

export async function listClickupTasks(env: Env, config: ClickupConfig, limit = MAX_TASKS): Promise<ClickupResult<ClickupTask[]>> {
  const result = await request<{ tasks?: unknown[] }>(env, config.token, 'GET', tasksPath(config.listId, 0));
  if (!result.ok) return result;
  return { ok: true, value: (result.value.tasks ?? []).slice(0, Math.min(limit, MAX_TASKS)).map(mapTask) };
}

/**
 * Tasks whose name or key contains every word given, matched here.
 *
 * Every other reader in this file asks ClickUp a question and maps the answer.
 * This one cannot: see `CLICKUP_SEARCH_SCAN` — there is no text parameter to
 * send. So the match is a plain case-insensitive substring over the fields a
 * person would recognise, which is also the honest thing to be: nobody should
 * read this as ClickUp's own relevance ranking. Order is ClickUp's, newest
 * activity first, so the first twenty matches are the twenty freshest.
 *
 * `toLowerCase`, never `toLocaleLowerCase`: this codebase runs on a Turkish
 * locale desktop, where a locale-aware fold turns `I` into `ı` and a search for
 * `INVOICE` stops matching `invoice`.
 */
export async function searchClickupTasks(
  env: Env,
  config: ClickupConfig,
  text: string,
  limit = MAX_TASKS,
): Promise<ClickupResult<ClickupTask[]>> {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!words.length) return { ok: true, value: [] };
  const want = Math.min(limit, MAX_TASKS);
  const found: ClickupTask[] = [];
  for (let page = 0; page < CLICKUP_SEARCH_PAGES; page += 1) {
    const result = await request<{ tasks?: unknown[]; last_page?: boolean }>(env, config.token, 'GET', tasksPath(config.listId, page));
    // A refusal on page two is still a refusal: a partial list presented as the
    // answer would read as "nothing else matched".
    if (!result.ok) return result;
    const rows = (result.value.tasks ?? []).map(mapTask);
    for (const task of rows) {
      const haystack = `${task.name} ${task.customId ?? ''} ${task.id}`.toLowerCase();
      if (words.every((word) => haystack.includes(word))) found.push(task);
      if (found.length >= want) return { ok: true, value: found };
    }
    if (result.value.last_page === true || rows.length < CLICKUP_PAGE) break;
  }
  return { ok: true, value: found };
}

/**
 * One task, by either of ClickUp's id spaces, checked against the mapped List.
 *
 * The List check is the fail-closed half: a task can be moved after it was
 * named, so the exact List is re-read here rather than trusted from whenever
 * the reference was stored.
 */
export async function getClickupTask(env: Env, config: ClickupConfig, taskId: string): Promise<ClickupResult<ClickupTask>> {
  const custom = isClickupCustomTaskId(taskId);
  const result = await request<any>(
    env,
    config.token,
    'GET',
    `/task/${encodeURIComponent(taskId)}?custom_task_ids=${custom}&team_id=${encodeURIComponent(config.workspaceId)}`,
  );
  if (!result.ok) return result;
  if (String(result.value?.list?.id ?? '') !== config.listId) {
    return { ok: false, error: 'task_outside_mapped_list' };
  }
  return { ok: true, value: mapTask(result.value) };
}

export async function commentOnClickupTask(env: Env, config: ClickupConfig, taskId: string, body: string): Promise<ClickupResult<true>> {
  const result = await request<unknown>(env, config.token, 'POST', `/task/${encodeURIComponent(taskId)}/comment`, { comment_text: body, notify_all: false });
  return result.ok ? { ok: true, value: true } : result;
}
