import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';
import { metrics } from './metrics';

export const clientIp = (c: Context<AppEnv>): string =>
  c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
  (c.env.incoming?.socket?.remoteAddress ?? 'unknown');

/**
 * Fixed-window in-memory rate limiter. Good enough for a single instance;
 * swap for a shared store when scaling horizontally.
 */
export function rateLimit(opts: {
  windowMs: number;
  max: number;
  key: (c: Context<AppEnv>) => string;
}): MiddlewareHandler<AppEnv> {
  const hits = new Map<string, { count: number; reset: number }>();
  return async (c, next) => {
    const now = Date.now();
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    }
    const key = opts.key(c);
    const entry = hits.get(key);
    if (!entry || entry.reset < now) {
      hits.set(key, { count: 1, reset: now + opts.windowMs });
    } else {
      entry.count += 1;
      if (entry.count > opts.max) {
        c.header('Retry-After', String(Math.max(1, Math.ceil((entry.reset - now) / 1000))));
        metrics.recordRateLimited();
        return c.json({ error: 'rate_limited' }, 429);
      }
    }
    await next();
  };
}
