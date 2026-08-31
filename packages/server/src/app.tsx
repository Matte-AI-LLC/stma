import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Db } from './db';
import type { Env } from './env';
import { sessionUser } from './auth/session';
import { errorFields, recordErrorEvent, safeErrorPath } from './lib/errors';
import { logLine } from './lib/log';
import { metrics } from './lib/metrics';
import { setHosted } from './lib/entitlements';
import { ensureRail } from './lib/rail';
import { clientIp, rateLimit } from './lib/ratelimit';
import { activityRoutes } from './routes/activity';
import { adminRoutes } from './routes/admin';
import { agentsRoutes } from './routes/agents';
import { savingsRoutes } from './routes/savings';
import { apiRoutes } from './routes/api';
import { authRoutes } from './routes/auth';
import { compareRoutes } from './routes/compare';
import { controlRoutes } from './routes/control';
import { docsRoutes } from './routes/docs';
import { legalRoutes } from './routes/legal';
import { dashboardRoutes } from './routes/dashboard';
import { deliveryRoutes } from './routes/delivery';
import { governanceRoutes } from './routes/governance';
import { mcpRoutes } from './routes/mcp';
import { notificationsRoutes } from './routes/notifications';
import { policyEditorRoutes } from './routes/policyEditor';
import { projectsRoutes } from './routes/projects';
import { sessionsRoutes } from './routes/sessions';
import { streamRoutes } from './routes/stream';
import type { AppEnv } from './types';
import { clientJs } from './ui/client';
import { NotFoundPage, NotFoundPublic } from './ui/NotFound';
import { ASSET_CACHE, ASSET_PATHS, CSS_URL, FAVICON_URL, JS_URL, LEGACY_CACHE, faviconSvg } from './ui/assets';
import { css } from './ui/styles';
import { VERSION } from './version';

/** Reject cross-origin browser form POSTs (MCP uses token auth and is exempt). */
const originGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method === 'POST' && !c.req.path.startsWith('/mcp')) {
    const origin = c.req.header('origin');
    if (origin) {
      const allowed = new Set([new URL(c.get('env').baseUrl).origin]);
      const host = c.req.header('host');
      if (host) {
        allowed.add(`http://${host}`);
        allowed.add(`https://${host}`);
      }
      if (!allowed.has(origin)) {
        return c.text('Cross-origin form submission rejected.', 403);
      }
    }
  }
  await next();
};

export function createApp(deps: { db: Db; env: Env }) {
  const app = new Hono<AppEnv>();

  // Whether plan limits apply at all. Set here rather than read per request:
  // it describes the instance, and every limit check would otherwise need an
  // environment threaded into it for a value that never varies.
  setHosted(deps.env.hosted);

  app.use('*', async (c, next) => {
    c.set('db', deps.db);
    c.set('env', deps.env);
    await next();
  });
  // Access log: one JSON line per request (static assets and health checks excluded).
  // The same call feeds lib/metrics, which backs the /admin/ops load view.
  app.use('*', async (c, next) => {
    const start = Date.now();
    let threw = false;
    try {
      await next();
    } catch (err) {
      threw = true; // handled by app.onError further up; counted as a 500 here
      throw err;
    } finally {
      const p = c.req.path;
      // /app/stream is a long-lived SSE connection: logging it on close would
      // report a five-minute request and drag the latency percentiles on
      // /admin/ops with a number that describes an idle socket, not a page.
      if (!ASSET_PATHS.has(p) && p !== '/health' && p !== '/favicon.ico' && p !== '/app/stream') {
        const ms = Date.now() - start;
        const status = threw ? 500 : c.res.status;
        metrics.recordRequest({ method: c.req.method, path: p, status, ms, tool: c.get('mcpTool') });
        logLine({
          evt: 'http',
          m: c.req.method,
          // Some paths carry a secret (inbound hook tokens, invite codes); those
          // segments are templated away before the line reaches stdout.
          p: safeErrorPath(p),
          s: status,
          ms,
          u: c.get('user')?.username ?? c.get('mcpUser')?.username,
          tool: c.get('mcpTool'),
          ip: clientIp(c),
          // Present only when a STMA client sent it: an old CLI is a fact worth
          // seeing in the logs, and one that never appears in a bug report.
          cli: c.req.header('x-stma-client'),
        });
      }
    }
  });
  app.use('/mcp', bodyLimit({ maxSize: 1024 * 1024 }));
  const formLimit = bodyLimit({ maxSize: 256 * 1024 });
  app.use('*', (c, next) => (c.req.path.startsWith('/mcp') ? next() : formLimit(c, next)));
  app.use('/auth/*', rateLimit({ windowMs: 60_000, max: 30, key: clientIp }));
  app.use('/api/invites/*', rateLimit({ windowMs: 60_000, max: 20, key: clientIp }));
  app.use('/api/hooks/*', rateLimit({ windowMs: 60_000, max: 120, key: clientIp }));
  app.use('/api/agent/*', rateLimit({ windowMs: 60_000, max: 600, key: clientIp }));
  app.use('/api/control/*', rateLimit({ windowMs: 60_000, max: 120, key: clientIp }));
  app.use('*', originGuard);
  app.use('*', sessionUser);

  /**
   * A signed-in page is live state, not a document.
   *
   * These carried no cache directive at all, so a browser was free to keep them
   * — and the back button then restored the page whole, badges included: open a
   * thread, go back, and the unread count it had just cleared was still there.
   * The same gap is a disclosure one at a shared desk, where Back after signing
   * out reads the previous person's console out of the cache.
   *
   * `no-store` rather than `no-cache`: the second still stores the response and
   * only promises to revalidate, which back/forward navigation does not do.
   * Signed-out pages are left alone — they are documents, and they cache well.
   */
  app.use('*', async (c, next) => {
    await next();
    if (!c.get('user')) return;
    if ((c.res.headers.get('content-type') ?? '').startsWith('text/html')) {
      c.res.headers.set('cache-control', 'no-store');
    }
  });

  // Hashed URLs are what pages link to; the plain ones stay for HTML that was
  // already in a browser when this deploy landed.
  const cssHeaders = (cache: string) => ({ 'content-type': 'text/css; charset=utf-8', 'cache-control': cache });
  const jsHeaders = (cache: string) => ({
    'content-type': 'application/javascript; charset=utf-8',
    'cache-control': cache,
  });
  const svgHeaders = (cache: string) => ({ 'content-type': 'image/svg+xml', 'cache-control': cache });
  app.get(CSS_URL, (c) => c.body(css, 200, cssHeaders(ASSET_CACHE)));
  app.get(JS_URL, (c) => c.body(clientJs, 200, jsHeaders(ASSET_CACHE)));
  app.get(FAVICON_URL, (c) => c.body(faviconSvg, 200, svgHeaders(ASSET_CACHE)));
  app.get('/style.css', (c) => c.body(css, 200, cssHeaders(LEGACY_CACHE)));
  app.get('/app.js', (c) => c.body(clientJs, 200, jsHeaders(LEGACY_CACHE)));
  app.get('/favicon.svg', (c) => c.body(faviconSvg, 200, svgHeaders(LEGACY_CACHE)));
  // Health is also the version handshake. It was already the one endpoint every
  // deploy script, container healthcheck and `stma serve` boot poll calls, so
  // naming the build here means a client can tell an old server from a broken
  // one without a second round trip — and an operator can answer "which build
  // is actually running" without az or docker.
  app.get('/health', async (c) => {
    await deps.db.execute(sql`select 1`);
    return c.json({ ok: true, version: VERSION });
  });

  app.route('/', authRoutes);
  app.route('/', apiRoutes);
  app.route('/', controlRoutes);
  app.route('/', docsRoutes);
  app.route('/', legalRoutes);
  app.route('/', mcpRoutes);
  app.route('/', sessionsRoutes);
  app.route('/', streamRoutes);
  app.route('/', notificationsRoutes);
  app.route('/', policyEditorRoutes);
  app.route('/', projectsRoutes);
  app.route('/', compareRoutes);
  app.route('/', activityRoutes);
  app.route('/', governanceRoutes);
  app.route('/', deliveryRoutes);
  app.route('/', agentsRoutes);
  app.route('/', savingsRoutes);
  app.route('/', adminRoutes);
  app.route('/', dashboardRoutes);

  // A URL that is not one. Machine callers get JSON on the shape they already
  // parse; a person gets a page with the way back on it, because a console that
  // knows who you are should not answer a typo with bare text and no exit.
  app.notFound(async (c) => {
    const path = safeErrorPath(c.req.path);
    if (c.req.path.startsWith('/mcp') || c.req.path.startsWith('/api')) {
      return c.json({ error: 'not_found' }, 404);
    }
    const user = c.get('user');
    // The rail is only computed for GETs; a POST to a dead URL would otherwise
    // draw chrome claiming the signed-in user has no team.
    if (user) await ensureRail(deps.db, user);
    return c.html(
      user ? <NotFoundPage user={user} path={path} /> : <NotFoundPublic path={path} />,
      404,
    );
  });

  app.onError(async (err, c) => {
    const { message, stack } = errorFields(err);
    const safePath = safeErrorPath(c.req.path);
    logLine({
      evt: 'error',
      m: c.req.method,
      p: safePath,
      msg: message,
      stack: stack
        ?.split('\n')
        .slice(1, 4)
        .map((s) => s.trim())
        .join(' <- '),
    });
    // Operator console record. Awaited so /admin/ops never misses an error, and
    // swallowed inside recordErrorEvent so a failing insert cannot break the response.
    await recordErrorEvent(deps.db, {
      kind: 'http',
      message,
      stack,
      method: c.req.method,
      path: safePath,
      status: 500,
      userId: c.get('user')?.id ?? c.get('mcpUser')?.id ?? null,
      teamSlug: /^\/app\/teams\/([^/]+)/.exec(c.req.path)?.[1] ?? null,
      requestId: c.req.header('x-request-id') ?? null,
    });
    if (c.req.path.startsWith('/mcp') || c.req.path.startsWith('/api')) {
      return c.json({ error: 'internal_error' }, 500);
    }
    return c.text('Something went wrong. The error has been logged.', 500);
  });

  return app;
}
