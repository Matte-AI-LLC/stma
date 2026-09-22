import type { HttpBindings } from '@hono/node-server';
import type { Db } from './db';
import type { tokens, users } from './db/schema';
import type { Env } from './env';
import type { AppCapabilities, AppLifecycleHooks } from './extensions';
import type { RailCounts } from './lib/rail';
import type { AgentGrant } from './lib/grants';

export type User = typeof users.$inferSelect & {
  /** Computed when the web session loads: listed in ADMIN_USERNAMES or ADMIN_EMAILS. */
  isAdmin?: boolean;
  organizationSecurity?: boolean;
  /**
   * Navigation counts, attached for signed-in HTML page loads only. Carried on
   * the user rather than passed through twenty call sites, because the rail is
   * chrome: it has to look the same on every page or it reads as broken.
   */
  rail?: RailCounts;
  /**
   * This account has an address nobody has proved they can read, on a server
   * where that address is the second factor and the only way back in.
   *
   * Chrome, like `rail`, and for the same reason: signup deliberately does not
   * block on the confirmation mail, and the entire argument for not blocking is
   * that the console says so until it is fixed. Said on one page it was not a
   * notice, it was a page nobody had a reason to open. Free — `email_verified_at`
   * already arrives with the session's user row, so this costs no query.
   */
  addressUnconfirmed?: boolean;
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
    /** Server-resolved team/project/installation authority carried by that token. */
    mcpGrant: AgentGrant;
    /** JSON-RPC method / tool name of the current /mcp request, for access logs. */
    mcpTool?: string;
    /** Optional reactions supplied by a composed server distribution. */
    lifecycle: AppLifecycleHooks;
    /** Optional surfaces supplied by that composition; not inferred from hosted metering. */
    capabilities: AppCapabilities;
    /**
     * Where this page's forms may be sent on to by the redirect that answers
     * them, beside this origin: the CSP's `form-action` (`lib/csp.ts`). Set by
     * the OAuth consent page and the billing page, and by nothing else.
     */
    formTargets?: string[];
  };
};
