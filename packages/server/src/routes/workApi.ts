import { WORK_DETAIL_SECTIONS, WORK_ERROR_STATUS, type WorkDetailSection } from '@bridge/shared';
import { eq } from 'drizzle-orm';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { mcpAuth } from '../auth/pat';
import { projects } from '../db/schema';
import { workAccess } from '../domain/workAccess';
import { agentPrincipal, workError, type WorkRefusalError, type WorkResult } from '../domain/workTypes';
import { isCanonicalUuid } from '../lib/ids';
import {
  createWorkReply,
  filterOf,
  getWorkReply,
  listWorkReply,
  recordWorkEvidenceReply,
  submitWorkReply,
  updateWorkReply,
  workChangesReply,
  workContextReply,
} from '../mcp/work';
import type { AppEnv } from '../types';

/**
 * Native Work over REST, for a bearer credential: the same eight doors as the
 * MCP tools, calling the same reply functions with the same principal, so one
 * command answers the same on both and a request id retried across them is one
 * mutation. Every bearer is an agent principal, a person's own token included;
 * there is no decision route here, because a decision is a person's, made from
 * a browser session.
 *
 * Path ids are canonical uuids only. Errors are `{ error: { code, message,
 * retryable, ... } }` with the status `WORK_ERROR_STATUS` names.
 */

export const workApiRoutes = new Hono<AppEnv>();

/**
 * Authenticate once. The control routes register the same middleware on every
 * `/api/agent/*` path, and a Hono sub-app's middleware reaches whatever the
 * parent app mounts beside it; this one runs only when nothing has yet, so the
 * routes are protected whichever order the app mounts them in.
 */
const authenticated: MiddlewareHandler<AppEnv> = async (c, next) =>
  c.get('mcpGrant') ? next() : mcpAuth(c, next);

workApiRoutes.use('/api/agent/projects/:projectId/work', authenticated);
workApiRoutes.use('/api/agent/projects/:projectId/work/*', authenticated);
workApiRoutes.use('/api/agent/work/:workId', authenticated);
workApiRoutes.use('/api/agent/work/:workId/*', authenticated);

const PROJECT_NOT_VISIBLE = 'No project with that id is visible to this principal.';
const NOT_VISIBLE = 'No work with that id is visible to this principal.';

const principalOf = (c: Context<AppEnv>) => agentPrincipal(c.get('mcpUser').id, c.get('mcpGrant'));

function refused(c: Context<AppEnv>, error: WorkRefusalError) {
  c.header('Cache-Control', 'no-store');
  return c.json({ error }, WORK_ERROR_STATUS[error.code] as 400);
}

function answer(c: Context<AppEnv>, result: WorkResult<Record<string, unknown>>) {
  if ('error' in result) return refused(c, result.error as WorkRefusalError);
  c.header('Cache-Control', 'no-store');
  return c.json(result);
}

async function body(c: Context<AppEnv>): Promise<Record<string, unknown> | null> {
  const value = (await c.req.json().catch(() => null)) as unknown;
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const notAnObject = () => workError('INVALID_INPUT', 'The body must be a JSON object.');

/** A path id beside the same field in the body must name the same thing. */
function conflicting(value: unknown, pathId: string, field: string): WorkRefusalError | null {
  if (value === undefined || (typeof value === 'string' && value.toLowerCase() === pathId.toLowerCase())) return null;
  return workError('INVALID_INPUT', `${field} in the body names something other than the path.`, { fields: [field] });
}

function integerParam(raw: string | undefined, field: string): number | undefined | WorkRefusalError {
  if (raw === undefined) return undefined;
  if (!/^[0-9]{1,6}$/.test(raw)) return workError('INVALID_INPUT', `${field}: a whole number.`, { fields: [field] });
  return Number(raw);
}

const isRefusal = (value: unknown): value is WorkRefusalError =>
  typeof value === 'object' && value !== null && 'code' in value && 'message' in value;

/** The filter fields as query parameters: `states` comma-separated, `include_archived` true or false. */
function filterFromQuery(c: Context<AppEnv>): Record<string, unknown> {
  const states = c.req.query('states');
  const archived = c.req.query('include_archived');
  return filterOf({
    view: c.req.query('view'),
    states: states === undefined ? undefined : states.split(',').map((state) => state.trim()).filter(Boolean),
    owner: c.req.query('owner'),
    label: c.req.query('label'),
    include_archived: archived === undefined ? undefined : archived === 'true' ? true : archived === 'false' ? false : archived,
  });
}

/** The project of a project path, inside the caller's team, for a create that must name its team. */
async function projectTeam(c: Context<AppEnv>, projectId: string) {
  const [project] = await c
    .get('db')
    .select({ id: projects.id, teamId: projects.teamId })
    .from(projects)
    .where(eq(projects.id, projectId.toLowerCase()))
    .limit(1);
  return project;
}

workApiRoutes.get('/api/agent/projects/:projectId/work', async (c) => {
  const projectId = c.req.param('projectId');
  if (!isCanonicalUuid(projectId)) return refused(c, workError('NOT_FOUND', PROJECT_NOT_VISIBLE));
  const limit = integerParam(c.req.query('limit'), 'limit');
  if (isRefusal(limit)) return refused(c, limit);
  return answer(
    c,
    await listWorkReply(c.get('db'), principalOf(c), projectId, filterFromQuery(c), { cursor: c.req.query('cursor'), limit }),
  );
});

workApiRoutes.post('/api/agent/projects/:projectId/work', async (c) => {
  const projectId = c.req.param('projectId');
  if (!isCanonicalUuid(projectId)) return refused(c, workError('NOT_FOUND', PROJECT_NOT_VISIBLE));
  const input = await body(c);
  if (!input) return refused(c, notAnObject());
  const project = await projectTeam(c, projectId);
  // A project outside this principal's reach answers exactly like one that does
  // not exist, before anything is reserved or locked for it: the create
  // envelope would refuse it too, but in words that tell a real id elsewhere
  // from a made-up one.
  if (!project || !(await workAccess(c.get('db'), principalOf(c), project.teamId, project.id))) {
    return refused(c, workError('NOT_FOUND', PROJECT_NOT_VISIBLE));
  }
  const clash = conflicting(input.project, project.id, 'project');
  if (clash) return refused(c, clash);
  return answer(
    c,
    await createWorkReply(
      c.get('db'),
      principalOf(c),
      { ...input, project: project.id },
      { teamId: project.teamId, hosted: c.get('env').hosted },
    ),
  );
});

workApiRoutes.get('/api/agent/projects/:projectId/work/changes', async (c) => {
  const projectId = c.req.param('projectId');
  if (!isCanonicalUuid(projectId)) return refused(c, workError('NOT_FOUND', PROJECT_NOT_VISIBLE));
  const limit = integerParam(c.req.query('limit'), 'limit');
  if (isRefusal(limit)) return refused(c, limit);
  return answer(
    c,
    await workChangesReply(c.get('db'), principalOf(c), projectId, filterFromQuery(c), {
      afterCursor: c.req.query('after_cursor'),
      limit,
    }),
  );
});

workApiRoutes.get('/api/agent/work/:workId', async (c) => {
  const workId = c.req.param('workId');
  if (!isCanonicalUuid(workId)) return refused(c, workError('NOT_FOUND', NOT_VISIBLE));
  const view = c.req.query('view');
  if (view !== undefined && view !== 'compact' && view !== 'detail') {
    return refused(c, workError('INVALID_INPUT', 'view: compact or detail.', { fields: ['view'] }));
  }
  const sectionLimit = integerParam(c.req.query('section_limit'), 'section_limit');
  if (isRefusal(sectionLimit)) return refused(c, sectionLimit);
  const sections = c.req.query('sections');
  // Per section, `cursor.<section>=...`: the next_cursor a detail reply gave it.
  const cursors = Object.fromEntries(
    WORK_DETAIL_SECTIONS.flatMap((section) => {
      const cursor = c.req.query(`cursor.${section}`);
      return cursor === undefined ? [] : [[section, cursor]];
    }),
  ) as Partial<Record<WorkDetailSection, string>>;
  return answer(
    c,
    await getWorkReply(c.get('db'), principalOf(c), workId, {
      view,
      sections: sections === undefined ? undefined : (sections.split(',').map((section) => section.trim()) as WorkDetailSection[]),
      sectionLimit,
      cursors,
    }),
  );
});

workApiRoutes.post('/api/agent/work/:workId/commands', async (c) => {
  const workId = c.req.param('workId');
  if (!isCanonicalUuid(workId)) return refused(c, workError('NOT_FOUND', NOT_VISIBLE));
  const input = await body(c);
  if (!input) return refused(c, notAnObject());
  const clash = conflicting(input.work_id, workId, 'work_id');
  if (clash) return refused(c, clash);
  return answer(c, await updateWorkReply(c.get('db'), principalOf(c), { ...input, work_id: workId }, c.get('env')));
});

workApiRoutes.post('/api/agent/work/:workId/deliveries', async (c) => {
  const workId = c.req.param('workId');
  if (!isCanonicalUuid(workId)) return refused(c, workError('NOT_FOUND', NOT_VISIBLE));
  const input = await body(c);
  if (!input) return refused(c, notAnObject());
  const clash = conflicting(input.work_id, workId, 'work_id');
  if (clash) return refused(c, clash);
  return answer(c, await submitWorkReply(c.get('db'), principalOf(c), { ...input, work_id: workId }, c.get('env')));
});

workApiRoutes.post('/api/agent/work/:workId/evidence', async (c) => {
  const workId = c.req.param('workId');
  if (!isCanonicalUuid(workId)) return refused(c, workError('NOT_FOUND', NOT_VISIBLE));
  const input = await body(c);
  if (!input) return refused(c, notAnObject());
  const clash = conflicting(input.work_id, workId, 'work_id');
  if (clash) return refused(c, clash);
  return answer(
    c,
    await recordWorkEvidenceReply(c.get('db'), principalOf(c), { ...input, work_id: workId }, c.get('env')),
  );
});

workApiRoutes.get('/api/agent/work/:workId/context', async (c) => {
  const workId = c.req.param('workId');
  if (!isCanonicalUuid(workId)) return refused(c, workError('NOT_FOUND', NOT_VISIBLE));
  const maxBytes = integerParam(c.req.query('max_bytes'), 'max_bytes');
  if (isRefusal(maxBytes)) return refused(c, maxBytes);
  const sections = c.req.query('sections');
  return answer(
    c,
    await workContextReply(c.get('db'), principalOf(c), workId, {
      maxBytes,
      sections: sections === undefined ? undefined : sections.split(',').map((section) => section.trim()),
      continuation: c.req.query('continuation'),
    }),
  );
});
