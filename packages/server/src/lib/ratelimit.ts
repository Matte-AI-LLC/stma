import { BlockList, isIP } from 'node:net';
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
 * It counts `trustedProxyHops` entries in from the right. A count alone could
 * not tell a proxy from a client, which the next review found (2026-09-21): the
 * origin still answers on its own address, and a request sent there arrives one
 * entry short, so one trusted hop landed on the entry the client typed —
 * measured on production, a forged address was logged as the caller's. With
 * `trustedProxyCidrs` a hop is stepped over only when the address that
 * appended it is on the list.
 *
 * Out of range clamps to the rightmost: a misconfigured hop count should group
 * more traffic together, never make the key forgeable. (The comment said so
 * before and the code clamped to the leftmost; both now say the same thing.)
 */
export const clientIp = (c: Context<AppEnv>): string => {
  const chain = (c.req.header('x-forwarded-for') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (chain.length === 0) return c.env.incoming?.socket?.remoteAddress ?? 'unknown';
  const env = c.get('env');
  return clientFromChain(chain, env?.trustedProxyHops ?? 0, trustedProxies(env?.trustedProxyCidrs));
};

/** The address to count, from a non-empty forwarding chain. Exported for the tests. */
export function clientFromChain(chain: readonly string[], hops: number, trusted?: BlockList): string {
  if (!trusted) {
    const index = chain.length - 1 - hops;
    return chain[index >= 0 ? index : chain.length - 1]!;
  }
  let index = chain.length - 1;
  for (let step = 0; step < hops && index > 0 && isTrustedAddress(chain[index]!, trusted); step++) {
    index -= 1;
  }
  return chain[index]!;
}

const proxyLists = new Map<string, BlockList>();

/** One BlockList per distinct configuration, built on first use. */
export function trustedProxies(cidrs: readonly string[] | undefined): BlockList | undefined {
  if (!cidrs || cidrs.length === 0) return undefined;
  const key = cidrs.join(',');
  let list = proxyLists.get(key);
  if (!list) {
    list = new BlockList();
    for (const cidr of cidrs) {
      const [address, prefix] = cidr.split('/');
      list.addSubnet(address!, Number(prefix), isIP(address!) === 6 ? 'ipv6' : 'ipv4');
    }
    proxyLists.set(key, list);
  }
  return list;
}

function isTrustedAddress(entry: string, trusted: BlockList): boolean {
  // Proxies write bare addresses; tolerate brackets and an IPv4 address
  // written in its IPv6-mapped form, and trust nothing that is not an address.
  const bare = entry.replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare)?.[1];
  const address = mapped ?? bare;
  const family = isIP(address);
  if (!family) return false;
  return trusted.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

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
