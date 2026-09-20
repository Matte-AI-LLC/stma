import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';
import { metrics } from './metrics';

/**
 * Who to count this request against.
 *
 * `X-Forwarded-For` is a list each proxy appends to, so the leftmost entry is
 * whatever the client typed and the rightmost is the address the nearest proxy
 * actually saw. This read the leftmost until 2026-09-20, which meant every
 * per-IP limit in `app.tsx` could be walked through by sending a different
 * `X-Forwarded-For` each time — including the one volumetric brake on guessing
 * a private beta access code, which is checked before the email is even looked
 * at and has no per-account counter behind it. The repository's own
 * `auth-hardening.test.ts` proves the mechanism: it sends a fresh
 * `x-forwarded-for` per attempt precisely so the per-IP limiter does not fire.
 *
 * Now it counts `trustedProxyHops` entries in from the right. Out of range
 * clamps to the rightmost rather than falling back to the left: a misconfigured
 * hop count should group more traffic together, never make the key forgeable.
 */
export const clientIp = (c: Context<AppEnv>): string => {
  const chain = (c.req.header('x-forwarded-for') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (chain.length === 0) return c.env.incoming?.socket?.remoteAddress ?? 'unknown';
  const hops = c.get('env')?.trustedProxyHops ?? 0;
  return chain[Math.max(0, chain.length - 1 - hops)]!;
};

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
