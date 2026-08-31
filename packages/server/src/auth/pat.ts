import { PAT_PREFIX } from '@bridge/shared';
import { eq } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { tokens, users } from '../db/schema';
import { randomHex, sha256hex } from '../lib/crypto';
import type { AppEnv } from '../types';

export function generatePat(): { token: string; hash: string; prefix: string } {
  const token = PAT_PREFIX + randomHex(20);
  return { token, hash: sha256hex(token), prefix: token.slice(0, PAT_PREFIX.length + 6) };
}

function unauthorized(c: Context<AppEnv>, hint?: string): Response {
  c.header('WWW-Authenticate', 'Bearer realm="stma"');
  return c.json(
    {
      error: 'unauthorized',
      hint: hint ?? 'Send a personal access token: Authorization: Bearer stma_...',
    },
    401,
  );
}

/** Bearer-token auth for the MCP endpoint. Sets `c.var.mcpUser`. */
export const mcpAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const match = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '');
  if (!match) return unauthorized(c);

  const db = c.get('db');
  const hash = sha256hex(match[1]!);
  const rows = await db
    .select({ token: tokens, user: users })
    .from(tokens)
    .innerJoin(users, eq(tokens.userId, users.id))
    .where(eq(tokens.tokenHash, hash))
    .limit(1);
  const row = rows[0];
  // "Send a token" is the wrong advice for an agent that just sent one. Only the
  // holder of that exact secret can reach this branch, so naming the revocation
  // discloses nothing — and it is the difference between retrying forever and
  // asking a human for a new token.
  if (row?.token.revokedAt) {
    return unauthorized(
      c,
      `This token was revoked on ${row.token.revokedAt.toISOString().slice(0, 10)}. ` +
        `Ask your human for a new one at ${c.get('env').baseUrl}/app/tokens.`,
    );
  }
  if (!row) return unauthorized(c);

  await db.update(tokens).set({ lastUsedAt: new Date() }).where(eq(tokens.id, row.token.id));
  c.set('mcpUser', row.user);
  c.set('mcpToken', row.token);
  await next();
};
