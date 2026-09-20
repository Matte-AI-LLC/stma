import type { Hono } from 'hono';
import type { Db } from './db';
import type { Env } from './env';
import type { AppEnv } from './types';
import type { SecurityHooks } from './lib/securityHooks';

/**
 * Optional lifecycle hooks for an operator-specific server composition.
 *
 * The public server owns the deterministic collaboration core. A hosted
 * operator may need to react to a small number of domain events (for example,
 * reconciling a licensed human-seat quantity) without importing operator code
 * into the public bundle. Keeping the contract here and the implementation in
 * the operator's entrypoint makes that boundary mechanical.
 */
export interface AppLifecycleHooks extends SecurityHooks {
  resolveEntitlements?: import('./lib/entitlements').EntitlementResolver;
  /** Runs after a committed membership insert or delete. */
  teamMemberCountChanged?: (input: { db: Db; teamId: string }) => Promise<void>;
  /**
   * Lets a composed identity system keep operator actions from bypassing its
   * membership source of truth. Core workspaces allow these changes.
   */
  beforeAdminMembershipChange?: (input: {
    db: Db;
    teamId: string;
    action: 'add' | 'role' | 'remove';
  }) => Promise<{ ok: true } | { ok: false; message: string }>;
  /** May stop deletion when an external resource must be dealt with first. */
  beforeTeamDelete?: (input: {
    db: Db;
    teamId: string;
  }) => Promise<{ ok: true } | { ok: false; message: string }>;
}

export const NOOP_LIFECYCLE_HOOKS: AppLifecycleHooks = {};

/** Capabilities exposed by a composed distribution, independent of metering. */
export interface AppCapabilities {
  managedBilling: boolean;
  organizationSecurity: boolean;
}

export const NO_APP_CAPABILITIES: AppCapabilities = { managedBilling: false, organizationSecurity: false };

export interface AppExtensionDependencies {
  db: Db;
  env: Env;
}

/** A route module supplied by a composed distribution of the server. */
export interface AppExtension {
  name: string;
  capabilities?: Partial<AppCapabilities>;
  register: (app: Hono<AppEnv>, deps: AppExtensionDependencies) => void;
}
