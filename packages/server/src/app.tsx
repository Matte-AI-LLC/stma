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
import { setHosted, setUnmetered, withEntitlements } from './lib/entitlements';
import { SecurityRefusal, withSecurityHooks } from './lib/securityHooks';
import { ensureRail } from './lib/rail';
import { clientIp, fromAnthropic, rateLimit } from './lib/ratelimit';
import { activityRoutes } from './routes/activity';
import { adminRoutes } from './routes/admin';
import { agentsRoutes } from './routes/agents';
import { savingsRoutes } from './routes/savings';
import { apiRoutes } from './routes/api';
import { authRoutes } from './routes/auth';
import { compareRoutes } from './routes/compare';
import { controlRoutes } from './routes/control';
import { docsRoutes } from './routes/docs';
import { helpRoutes } from './routes/help';
import { legalRoutes } from './routes/legal';
import { launchRoutes } from './routes/launch';
import { knowledgeRoutes } from './routes/knowledge';
import { repositoriesRoutes } from './routes/repositories';
import { attentionRoutes } from './routes/attention';
import { dashboardRoutes } from './routes/dashboard';
import { deliveryRoutes } from './routes/delivery';
import { governanceRoutes } from './routes/governance';
import { mcpRoutes } from './routes/mcp';
import { notificationsRoutes } from './routes/notifications';
import { oauthRoutes } from './routes/oauth';
import { policyEditorRoutes } from './routes/policyEditor';
import { projectsRoutes } from './routes/projects';
import { rosterRoutes } from './routes/roster';
import { sessionsRoutes } from './routes/sessions';
import { streamRoutes } from './routes/stream';
import type { AppEnv } from './types';
import {
  NO_APP_CAPABILITIES,
  NOOP_LIFECYCLE_HOOKS,
  type AppExtension,
  type AppLifecycleHooks,
} from './extensions';
import { clientJs } from './ui/client';
import { NotFoundPage, NotFoundPublic } from './ui/NotFound';
import {
  ASSET_CACHE,
  ASSET_PATHS,
  CSS_URL,
  FAVICON_URL,
  FONT_MONO_URL,
  FONT_SANS_URL,
  JS_URL,
  LEGACY_CACHE,
  faviconSvg,
  fontMono,
  fontSans,
  stylesheet,
} from './ui/assets';
import { VERSION } from './version';
import { connectorAsset } from './lib/connectorAsset';
import { formTargetSources } from './lib/csp';

/** Reject cross-origin browser form POSTs. Token-authenticated machine endpoints are exempt. */
const originGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const machineEndpoint = c.req.path.startsWith('/mcp') || [
    '/oauth/register',
    '/oauth/token',
    '/oauth/revoke',
  ].includes(c.req.path);
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method) && !machineEndpoint) {
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

export function createApp(
  deps: { db: Db; env: Env },
  options: {
    extensions?: readonly AppExtension[];
    lifecycle?: AppLifecycleHooks;
  } = {},
) {
  const app = new Hono<AppEnv>();
  for (const kind of ['connector', 'agent-runtime'] as const) {
    const artifact = connectorAsset(kind);
    app.get(artifact.path, (c) => {
      c.header('Content-Type', 'text/javascript; charset=utf-8');
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
      return c.body(artifact.source);
    });
  }
  const capabilities = (options.extensions ?? []).reduce(
    (all, extension) => ({ ...all, ...extension.capabilities }),
    { ...NO_APP_CAPABILITIES },
  );

  // Whether plan limits apply at all. Set here rather than read per request:
  // it describes the instance, and every limit check would otherwise need an
  // environment threaded into it for a value that never varies.
  setHosted(deps.env.hosted);
  setUnmetered(deps.env.betaUnmetered);

  app.use('*', async (c, next) => {
    c.set('db', deps.db);
    c.set('env', deps.env);
    c.set('lifecycle', options.lifecycle ?? NOOP_LIFECYCLE_HOOKS);
    c.set('capabilities', capabilities);
    await withSecurityHooks(options.lifecycle ?? {}, () => withEntitlements(options.lifecycle?.resolveEntitlements, next, deps.env.hosted, deps.env.betaUnmetered));
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
        const grant = c.get('mcpGrant');
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
          installation: grant?.installationId,
          scope: grant?.scope,
          team: grant?.teamSlug,
          project: grant?.projectSlug,
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
  app.use('/api/agent-enrollments/*', rateLimit({ windowMs: 60_000, max: 20, key: clientIp }));
  // Ten times the ceiling for Anthropic's egress block, which carries every
  // claude.ai user's registrations and refreshes (`ANTHROPIC_EGRESS`).
  app.use('/oauth/*', rateLimit({ windowMs: 60_000, max: (c) => (fromAnthropic(c) ? 600 : 60), key: clientIp }));
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
  /*
   * …and not only a page. The activity CSV carried no directive at all, on a
   * `.csv` address, and stma.ai sits behind a CDN that caches by extension when
   * the origin says nothing: measured 2026-09-21, a `.csv` path outside `/app`
   * answered MISS then HIT, and `/admin` is not bypassed at all. The one thing
   * keeping a member's export from being served to the next anonymous request
   * was a zone rule this repository cannot see. So anything answered to a
   * signed-in request, and anything under `/app` or `/admin` whoever asked, is
   * `private, no-store` unless its handler chose otherwise — the hashed assets
   * and the setup pack say what they want and keep it.
   */
  app.use('*', async (c, next) => {
    await next();
    const privatePath = /^\/(?:app|admin)(?:\/|$)/.test(c.req.path);
    if (!c.get('user') && !privatePath) return;
    if ((c.res.headers.get('content-type') ?? '').startsWith('text/html')) {
      c.res.headers.set('cache-control', 'no-store');
    } else if (!c.res.headers.has('cache-control')) {
      c.res.headers.set('cache-control', 'private, no-store');
    }
  });

  /**
   * The second layer, which this app has never had.
   *
   * There is no XSS here today: nothing renders unescaped HTML, no markdown
   * renderer is a dependency, and every `href` is app-relative or a mailto.
   * That is exactly why these belong in — the only thing standing between a
   * future `href={someStoredUrl}` and a `javascript:` payload is the review
   * that catches it, and a header costs nothing to have been there first.
   *
   * The policy is what this app actually is: one external script from its own
   * origin, no inline script anywhere, and `style="…"` attributes on nearly
   * every page, which is why styles keep `unsafe-inline` and scripts do not.
   * `frame-ancestors` rather than only X-Frame-Options because the former is
   * what modern browsers read; the latter stays for the ones that do not.
   * Clickjacking was already survivable — the session cookie is SameSite=Lax,
   * so a cross-site frame renders signed out — which makes this belt beside a
   * brace rather than a fix.
   *
   * HSTS only in production, and only over TLS: asserting it from a local
   * http server would pin a developer's own browser to https on localhost.
   */
  const csp = (formTargets: readonly string[] = []) =>
    [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      // `form-action` also governs the redirect that answers a form, not only
      // where the form posts (Chromium enforces it on every hop), and three
      // forms here are answered with a redirect off this origin: OAuth consent
      // to the client's callback, Checkout and the billing portal to Stripe.
      // With `'self'` alone all three stopped at the browser from the day this
      // header landed (audit 2026-09-21), so a page with such a form names the
      // one destination it sends people on to (`formTargets`) and nothing else
      // does.
      ["form-action 'self'", ...formTargets].join(' '),
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self'",
    ].join('; ');
  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('x-content-type-options', 'nosniff');
    c.res.headers.set('referrer-policy', 'same-origin');
    c.res.headers.set('x-frame-options', 'DENY');
    c.res.headers.set('content-security-policy', csp(formTargetSources(c.get('formTargets'))));
    if (deps.env.nodeEnv === 'production' && new URL(c.req.url).protocol === 'https:') {
      c.res.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
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
  app.get(CSS_URL, (c) => c.body(stylesheet, 200, cssHeaders(ASSET_CACHE)));
  app.get(JS_URL, (c) => c.body(clientJs, 200, jsHeaders(ASSET_CACHE)));
  app.get(FAVICON_URL, (c) => c.body(faviconSvg, 200, svgHeaders(ASSET_CACHE)));
  // Only ever at a content-hashed path: a font has no page already in a browser
  // asking for an old unhashed name, so there is no compatibility shim to keep.
  const fontHeaders = { 'content-type': 'font/woff2', 'cache-control': ASSET_CACHE };
  app.get(FONT_SANS_URL, (c) => c.body(new Uint8Array(fontSans), 200, fontHeaders));
  app.get(FONT_MONO_URL, (c) => c.body(new Uint8Array(fontMono), 200, fontHeaders));
  app.get('/style.css', (c) => c.body(stylesheet, 200, cssHeaders(LEGACY_CACHE)));
  app.get('/app.js', (c) => c.body(clientJs, 200, jsHeaders(LEGACY_CACHE)));
  app.get('/favicon.svg', (c) => c.body(faviconSvg, 200, svgHeaders(LEGACY_CACHE)));
  // Health is also the version handshake. It was already the one endpoint every
  // deploy script, container healthcheck and `stma serve` boot poll calls, so
  // naming the build here means a client can tell an old server from a broken
  // one without a second round trip — and an operator can answer "which build
  // is actually running" without az or docker.
  app.get('/health', async (c) => {
    await deps.db.execute(sql`select 1`);
    return c.json({ ok: true, version: VERSION, buildSha: /^[a-f0-9]{40}$/.test(process.env.STMA_BUILD_SHA ?? '') ? process.env.STMA_BUILD_SHA : null });
  });

  app.route('/', authRoutes);
  app.route('/', apiRoutes);
  app.route('/', controlRoutes);
  app.route('/', docsRoutes);
  app.route('/', helpRoutes);
  app.route('/', legalRoutes);
  app.route('/', launchRoutes);
  app.route('/', knowledgeRoutes);
  app.route('/', repositoriesRoutes);
  app.route('/', attentionRoutes);
  app.route('/', mcpRoutes);
  app.route('/', sessionsRoutes);
  app.route('/', streamRoutes);
  app.route('/', notificationsRoutes);
  app.route('/', oauthRoutes);
  app.route('/', policyEditorRoutes);
  app.route('/', projectsRoutes);
  app.route('/', rosterRoutes);
  app.route('/', compareRoutes);
  app.route('/', activityRoutes);
  app.route('/', governanceRoutes);
  app.route('/', deliveryRoutes);
  app.route('/', agentsRoutes);
  app.route('/', savingsRoutes);
  app.route('/', adminRoutes);
  app.route('/', dashboardRoutes);

  // Operator-specific routes are composed into a separate entrypoint. The
  // public bundle only carries this interface, never an import of those files.
  for (const extension of options.extensions ?? []) extension.register(app, deps);

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
    if (err instanceof SecurityRefusal) return c.text(err.message, 403);
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
