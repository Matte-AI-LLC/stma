/**
 * Azure DevOps, for the delivery-flow "apply" step: push the rendered pipeline
 * file into the repository and register a YAML pipeline that runs it.
 *
 * Transport mirrors lib/github and lib/mailer: the real REST API in normal
 * operation, an in-memory recorder under NODE_ENV=test whose canned answers use
 * Azure's *wire* shapes — so the field mapping is under test, not just the
 * decisions around it.
 *
 * The API root is the literal `https://dev.azure.com`: the org, project and
 * repo are path segments inside it, so a team's connection string can steer
 * *which tenant* is called but never *which host* — no SSRF surface to guard.
 */
import type { Env } from '../env';
import { logLine } from './log';

const API_ROOT = 'https://dev.azure.com';
const API_VERSION = '7.1';

export interface AdoConfig {
  /** Azure DevOps organization name (the segment after dev.azure.com/). */
  organization: string;
  /** Team project inside the organization. */
  project: string;
  /** Git repository inside the project. */
  repo: string;
  /** Personal access token with Code read/write and Build read/execute. */
  token: string;
}

export type AdoResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * "org/project/repo", with a pasted URL tolerated. Three segments exactly —
 * Azure DevOps needs all three to address a repository, and guessing a missing
 * one would write a pipeline into the wrong place.
 */
export function parseAdoLocator(
  input: string,
): { organization: string; project: string; repo: string } | null {
  const cleaned = input
    .trim()
    .replace(/^https?:\/\/dev\.azure\.com\//i, '')
    .replace(/\/_git\//, '/')
    .replace(/\/+$/, '');
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length !== 3) return null;
  const valid = /^[^\s/]{1,120}$/;
  if (!parts.every((p) => valid.test(p))) return null;
  return { organization: parts[0]!, project: parts[1]!, repo: parts[2]! };
}

export const adoLocator = (c: Pick<AdoConfig, 'organization' | 'project' | 'repo'>): string =>
  `${c.organization}/${c.project}/${c.repo}`;

// ------------------------------------------------------------------ memory mode

interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
  at: Date;
}

const calls: RecordedCall[] = [];
const CALL_CAP = 200;
/** Paths (repo file paths) the fake pretends already exist in the repository. */
let existingFiles: string[] = [];
/** Branches the fake repository has. Empty array = an uninitialized repository. */
let existingBranches: string[] = ['main'];
/** Pipelines already registered — a POST for one of these names fails like Azure's does. */
let existingPipelines: Array<{ id: number; name: string }> = [];

export const adoOutbox = {
  all(): readonly RecordedCall[] {
    return calls;
  },
  pushes(): RecordedCall[] {
    return calls.filter((c) => c.method === 'POST' && c.path.includes('/pushes'));
  },
  pipelines(): RecordedCall[] {
    return calls.filter((c) => c.method === 'POST' && /\/pipelines\?/.test(c.path));
  },
  seedFiles(paths: string[]): void {
    existingFiles = paths;
  },
  seedBranches(names: string[]): void {
    existingBranches = names;
  },
  seedPipelines(pipelines: Array<{ id: number; name: string }>): void {
    existingPipelines = pipelines;
  },
  clear(): void {
    calls.length = 0;
    existingFiles = [];
    existingBranches = ['main'];
    existingPipelines = [];
  },
};

// --------------------------------------------------------------------- requests

async function request<T>(
  env: Env,
  config: AdoConfig,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<AdoResult<T>> {
  if (env.nodeEnv === 'test') {
    calls.push({ method, path, body, at: new Date() });
    if (calls.length > CALL_CAP) calls.splice(0, calls.length - CALL_CAP);
    // Wire shapes, as Azure sends them. An empty repository has no defaultBranch
    // field at all — measured against a fresh project 2026-08-31.
    if (method === 'GET' && /\/git\/repositories\/[^/?]+\?/.test(path)) {
      return {
        ok: true,
        value: {
          id: 'ado-repo-0000',
          name: config.repo,
          ...(existingBranches[0] ? { defaultBranch: `refs/heads/${existingBranches[0]}` } : {}),
          webUrl: `https://dev.azure.com/${config.organization}/${config.project}/_git/${config.repo}`,
        } as unknown as T,
      };
    }
    if (method === 'GET' && path.includes('/refs?')) {
      const filter = /filter=heads\/([^&]+)/.exec(path)?.[1];
      const wanted = filter ? decodeURIComponent(filter) : undefined;
      const refs = existingBranches
        .filter((b) => !wanted || b === wanted)
        .map((b) => ({ name: `refs/heads/${b}`, objectId: 'a'.repeat(40) }));
      return { ok: true, value: { value: refs, count: refs.length } as unknown as T };
    }
    if (method === 'GET' && path.includes('/items?')) {
      const wanted = /path=([^&]+)/.exec(path)?.[1] ?? '';
      const decoded = decodeURIComponent(wanted);
      return existingFiles.includes(decoded)
        ? { ok: true, value: { path: decoded } as unknown as T }
        : { ok: false, error: 'http_404' };
    }
    if (method === 'POST' && path.includes('/pushes')) {
      return { ok: true, value: { pushId: 1 } as unknown as T };
    }
    if (method === 'GET' && /\/pipelines\?/.test(path)) {
      return {
        ok: true,
        value: {
          value: existingPipelines.map((p) => ({
            id: p.id,
            name: p.name,
            _links: {
              web: {
                href: `https://dev.azure.com/${config.organization}/${config.project}/_build?definitionId=${p.id}`,
              },
            },
          })),
        } as unknown as T,
      };
    }
    if (method === 'POST' && /\/pipelines\?/.test(path)) {
      const name = (body as { name?: string } | undefined)?.name ?? 'pipeline';
      if (existingPipelines.some((p) => p.name === name)) {
        // Azure refuses a duplicate definition name with a 400.
        return { ok: false, error: 'http_400' };
      }
      return {
        ok: true,
        value: {
          id: 7,
          name,
          _links: {
            web: {
              href: `https://dev.azure.com/${config.organization}/${config.project}/_build?definitionId=7`,
            },
          },
        } as unknown as T,
      };
    }
    return { ok: true, value: {} as T };
  }

  try {
    const res = await fetch(`${API_ROOT}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        // PATs ride basic auth with an empty username.
        authorization: `Basic ${Buffer.from(`:${config.token}`).toString('base64')}`,
        'user-agent': 'stma',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logLine({ evt: 'ado', a: 'error', status: res.status, path: path.slice(0, 120) });
      return {
        ok: false,
        error:
          res.status === 404
            ? 'not_found_or_no_access'
            : res.status === 401 || res.status === 203
              ? // 203: Azure's way of serving a sign-in page to a bad PAT.
                'bad_token'
              : res.status === 403
                ? // Token accepted, this operation refused: a scope is missing.
                  'missing_scope'
                : `http_${res.status}`,
      };
    }
    return { ok: true, value: (await res.json()) as T };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 120) : 'request_failed' };
  }
}

const base = (c: AdoConfig): string =>
  `/${encodeURIComponent(c.organization)}/${encodeURIComponent(c.project)}/_apis`;

/**
 * The remediation sentence for an Azure DevOps failure — one place, because the
 * same code surfaces on the team page, the delivery page and the apply result,
 * and DevOps PATs fail in ways the raw status does not explain. Each branch
 * names the fix, not just the fault.
 */
export function describeAdoFailure(error: string): string {
  if (error === 'bad_token') {
    return 'The token was refused — invalid, expired, or revoked (Azure answers a sign-in page, not a 401, so this also covers a mistyped PAT). Create a new one under User settings → Personal access tokens and update the connection.';
  }
  if (error === 'missing_scope') {
    return 'The token works but lacks a scope this step needs: Code (Read & Write) to commit the pipeline file, Build (Read & Execute) to register the pipeline. Edit the PAT’s scopes, or create a new one with both.';
  }
  if (error === 'not_found_or_no_access') {
    return 'Organization, project or repository not found with this token. Check the organization/project/repo spelling — and note a PAT is minted for ONE organization unless "All accessible organizations" was chosen, so a token from another org answers exactly like a wrong name.';
  }
  if (error.startsWith('branch ')) {
    return `${error}.`;
  }
  if (error === 'request_failed' || error.includes('timeout') || error.includes('abort')) {
    return 'Azure DevOps did not answer in time — usually transient. Try again; if it persists, check dev.azure.com status.';
  }
  return `Azure DevOps refused the request (${error}).`;
}

/** The all-zero object id git uses for "this ref does not exist yet". */
const ZERO_SHA = '0'.repeat(40);

interface RawRepo {
  id: string;
  name: string;
  defaultBranch?: string;
  webUrl?: string;
}

interface RawRefs {
  value: Array<{ name: string; objectId: string }>;
}

/**
 * The connection check: run on save, on the Test button, and shown on the
 * delivery page. An empty repository is a state, not an error — a brand-new
 * Azure DevOps project's repo has no branches at all, and the first apply is
 * expected to create one.
 */
export async function checkAdoConnection(
  env: Env,
  config: AdoConfig,
): Promise<AdoResult<{ repoId: string; defaultBranch: string | null; empty: boolean }>> {
  const repo = await request<RawRepo>(
    env,
    config,
    'GET',
    `${base(config)}/git/repositories/${encodeURIComponent(config.repo)}?api-version=${API_VERSION}`,
  );
  if (!repo.ok) return repo;
  const defaultBranch = repo.value.defaultBranch?.replace('refs/heads/', '') ?? null;
  return {
    ok: true,
    value: { repoId: repo.value.id, defaultBranch, empty: defaultBranch === null },
  };
}

/** What the connection said last time anyone asked — stored on the integration row. */
export interface AdoHealth {
  ok: boolean;
  at: string;
  error?: string;
  defaultBranch?: string | null;
  empty?: boolean;
}

export async function adoHealth(env: Env, config: AdoConfig): Promise<AdoHealth> {
  const check = await checkAdoConnection(env, config);
  return check.ok
    ? {
        ok: true,
        at: new Date().toISOString(),
        defaultBranch: check.value.defaultBranch,
        empty: check.value.empty,
      }
    : { ok: false, at: new Date().toISOString(), error: check.error };
}

/**
 * Push one file and register the pipeline that runs it. Four calls, in order,
 * each of which can fail on its own — the result says how far it got, because
 * "the file landed but the pipeline did not" calls for a different next step
 * than "the token was wrong".
 */
export async function setupPipeline(
  env: Env,
  config: AdoConfig,
  input: { path: string; content: string; branch: string; message: string; pipelineName: string },
): Promise<
  AdoResult<{ pushed: boolean; updated: boolean; pipelineId: number | null; pipelineUrl: string | null; note?: string }>
> {
  const repo = await request<RawRepo>(
    env,
    config,
    'GET',
    `${base(config)}/git/repositories/${encodeURIComponent(config.repo)}?api-version=${API_VERSION}`,
  );
  if (!repo.ok) return repo;

  const refs = await request<RawRefs>(
    env,
    config,
    'GET',
    `${base(config)}/git/repositories/${repo.value.id}/refs?filter=heads/${encodeURIComponent(input.branch)}&api-version=${API_VERSION}`,
  );
  if (!refs.ok) return refs;
  const ref = refs.value.value.find((r) => r.name === `refs/heads/${input.branch}`);
  const repoIsEmpty = !repo.value.defaultBranch;
  let branchCreated = false;
  let oldObjectId: string;
  if (ref) {
    oldObjectId = ref.objectId;
  } else if (repoIsEmpty) {
    // A brand-new Azure DevOps project ships an uninitialized repository — no
    // branches at all. Pushing against the zero id creates the branch with this
    // commit as its first, which is exactly what "apply the flow" should mean
    // on day zero. Found live 2026-08-31 on a fresh sample project.
    oldObjectId = ZERO_SHA;
    branchCreated = true;
  } else {
    // Branch missing but the repository has history: creating it silently from
    // nothing would orphan the pipeline file. Name what does exist instead.
    const fallback = repo.value.defaultBranch!.replace('refs/heads/', '');
    return {
      ok: false,
      error: `branch "${input.branch}" not found — the repository's default branch is "${fallback}". Point the flow's "branches from" at an existing branch, or create "${input.branch}" first`,
    };
  }

  // Add or edit? Azure refuses an "add" of a file that exists and an "edit" of
  // one that does not, so ask first. A branch being created has nothing in it.
  const existing = branchCreated
    ? { ok: false as const, error: 'http_404' }
    : await request<unknown>(
        env,
        config,
        'GET',
        `${base(config)}/git/repositories/${repo.value.id}/items?path=${encodeURIComponent(input.path)}&versionDescriptor.version=${encodeURIComponent(input.branch)}&api-version=${API_VERSION}`,
      );
  const changeType = existing.ok ? 'edit' : 'add';

  const push = await request<{ pushId: number }>(
    env,
    config,
    'POST',
    `${base(config)}/git/repositories/${repo.value.id}/pushes?api-version=${API_VERSION}`,
    {
      refUpdates: [{ name: `refs/heads/${input.branch}`, oldObjectId }],
      commits: [
        {
          comment: input.message,
          changes: [
            {
              changeType,
              item: { path: `/${input.path.replace(/^\//, '')}` },
              newContent: { content: input.content, contentType: 'rawtext' },
            },
          ],
        },
      ],
    },
  );
  if (!push.ok) return push;

  const pipeline = await request<{ id: number; _links?: { web?: { href?: string } } }>(
    env,
    config,
    'POST',
    `${base(config)}/pipelines?api-version=${API_VERSION}`,
    {
      name: input.pipelineName,
      configuration: {
        type: 'yaml',
        path: `/${input.path.replace(/^\//, '')}`,
        repository: { id: repo.value.id, name: config.repo, type: 'azureReposGit' },
      },
    },
  );
  const branchNote = branchCreated
    ? ` The repository was empty, so "${input.branch}" was created with this file as its first commit.`
    : '';
  if (!pipeline.ok) {
    // The file is in. The common cause is a re-apply — the pipeline already
    // exists — so go and look for one with this name before shrugging.
    const listed = await request<{ value: Array<{ id: number; name: string; _links?: { web?: { href?: string } } }> }>(
      env,
      config,
      'GET',
      `${base(config)}/pipelines?api-version=${API_VERSION}`,
    );
    const reused = listed.ok
      ? listed.value.value.find((p) => p.name === input.pipelineName)
      : undefined;
    if (reused) {
      logLine({ evt: 'ado', a: 'pipeline_reused', repo: adoLocator(config), pipeline: reused.id });
      return {
        ok: true,
        value: {
          pushed: true,
          updated: changeType === 'edit',
          pipelineId: reused.id,
          pipelineUrl: reused._links?.web?.href ?? null,
          note: `Pipeline #${reused.id} already existed for this flow and picked the new file up.${branchNote}`,
        },
      };
    }
    logLine({ evt: 'ado', a: 'pipeline_create_failed', why: pipeline.error });
    return {
      ok: true,
      value: {
        pushed: true,
        updated: changeType === 'edit',
        pipelineId: null,
        pipelineUrl: null,
        note: `The pipeline file was ${changeType === 'edit' ? 'updated' : 'committed'}, but registering the pipeline failed: ${describeAdoFailure(pipeline.error)}${branchNote}`,
      },
    };
  }
  logLine({ evt: 'ado', a: 'pipeline_setup', repo: adoLocator(config), pipeline: pipeline.value.id });
  return {
    ok: true,
    value: {
      pushed: true,
      updated: changeType === 'edit',
      pipelineId: pipeline.value.id,
      pipelineUrl: pipeline.value._links?.web?.href ?? null,
      note: branchNote || undefined,
    },
  };
}
