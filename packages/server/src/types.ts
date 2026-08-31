import type { HttpBindings } from '@hono/node-server';
import type { Db } from './db';
import type { tokens, users } from './db/schema';
import type { Env } from './env';
import type { RailCounts } from './lib/rail';

export type User = typeof users.$inferSelect & {
  /** Computed when the web session loads: listed in ADMIN_USERNAMES or ADMIN_EMAILS. */
  isAdmin?: boolean;
  /**
   * Navigation counts, attached for signed-in HTML page loads only. Carried on
   * the user rather than passed through twenty call sites, because the rail is
   * chrome: it has to look the same on every page or it reads as broken.
   */
  rail?: RailCounts;
};
export type Token = typeof tokens.$inferSelect;

export type AppEnv = {
  Bindings: HttpBindings;
  Variables: {
    db: Db;
    env: Env;
    /** Web session user (cookie auth); null when not signed in. */
    user: User | null;
    /** Token-authenticated user on /mcp routes. */
    mcpUser: User;
    /** The personal access token row used to authenticate this /mcp request. */
    mcpToken?: Token;
    /** JSON-RPC method / tool name of the current /mcp request, for access logs. */
    mcpTool?: string;
  };
};
