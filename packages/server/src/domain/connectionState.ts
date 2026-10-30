import { ACTIVE_AGENT_RUN_STATUSES, CLAUDE_APP_CLIENT } from '@bridge/shared';
import { and, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { Db } from '../db';
import {
  agentEvents,
  agentInstallations,
  agentRuns,
  oauthRefreshTokens,
  type tokens,
} from '../db/schema';
import { isLocalAdapter } from './companions';
import { TERMINAL_CONNECT_CAPABILITY } from './enrollments';

/**
 * What STMA can honestly say about one connection, and what it cannot.
 *
 * The Agent connections page used to draw one pill per connection, derived from
 * three columns on the credential. A green "active" next to a row said nothing
 * about whether anything was listening, whether hooks were installed, whether
 * the agent was working or what the person should do next, and a reader took it
 * for all of those (the technical specification's T01). STMA has exactly one
 * kind of evidence: requests that arrived with a credential. It has no process
 * heartbeat, cannot see a checkout and cannot tell whether a client is open. So
 * a connection is described in five separate fields, each with the time it was
 * observed and where the observation came from, and everything STMA cannot see
 * is said to be unknown rather than guessed:
 *
 * 1. authorization: did the client complete sign-in, and is the credential
 *    still good (revoked, setup expired, awaiting the client, authorized,
 *    legacy and unverified, or needs to sign in again);
 * 2. local adapter: is a checkout-local adapter paired with this agent, and is
 *    it only what `stma connect` reported at setup time;
 * 3. last contact: the newest request or heartbeat, named by its source, never
 *    worded as "online";
 * 4. task: what the agent's run last reported, never "running" or "idle";
 * 5. next step: one concrete action from commands that exist, local ones phrased
 *    as "run in a terminal at the checkout root".
 *
 * Nothing here writes. `describeConnection` and `describeWork` are pure so the
 * wording is a table under test; `connectionStates` reads the rows with a
 * constant number of queries. It is `consoleOnly` (acceptance/tiers.json): the
 * Agent connections page, the roster and the project page read it, no tool or
 * hook does.
 */

export type ConnectionKind = 'console' | 'agent' | 'adapter';

export type AuthorizationState =
  | 'revoked'
  | 'setup_expired'
  | 'awaiting_client'
  | 'authorized'
  | 'legacy_unverified'
  | 'sign_in_again';

export type AuthorizationSource =
  | 'revocation'
  | 'enrollment'
  | 'oauth_initialize'
  | 'terminal_initialize'
  | 'whoami'
  | 'oauth_token_expiry';

export type ContactSource = 'authenticated_request' | 'run_heartbeat' | 'oauth_token_issue' | 'activation' | 'none';

export type AdapterState =
  | 'not_applicable'
  | 'installed_by_connect'
  | 'paired'
  | 'not_reported'
  | 'unpaired_adapter';

export type TaskState = 'no_run_reported' | 'run_reported' | 'heartbeat_overdue' | 'waiting_for_person';

export const AUTHORIZATION_LABEL: Record<AuthorizationState, string> = {
  revoked: 'revoked',
  setup_expired: 'setup expired',
  awaiting_client: 'awaiting client',
  authorized: 'authorized',
  legacy_unverified: 'legacy · unverified',
  sign_in_again: 'sign in again',
};

/** Where an authorization observation came from, in a reader's words. */
export const AUTHORIZATION_SOURCE_LABEL: Record<AuthorizationSource, string> = {
  revocation: 'the revocation',
  enrollment: 'the connection record',
  oauth_initialize: "the client's first MCP initialize after OAuth sign-in",
  terminal_initialize: "the client's first MCP initialize after stma connect",
  whoami: 'a whoami call from the client',
  oauth_token_expiry: "the access token's expiry",
};

/** Where a last-contact observation came from. */
export const CONTACT_SOURCE_LABEL: Record<ContactSource, string> = {
  authenticated_request: 'last authenticated request',
  run_heartbeat: 'last run heartbeat',
  oauth_token_issue: 'last OAuth token issue',
  activation: 'first MCP initialize',
  none: 'no request recorded',
};

/** The two things STMA structurally cannot see, named so the page never implies otherwise. */
export const UNKNOWN_CLIENT_OPEN = 'whether the client is open right now';
export const UNKNOWN_HOOKS_ON_DISK = 'whether hooks are present and trusted in the checkout';
export const UNKNOWN_CONSOLE_OPEN = 'whether the Claude app is open right now';

export interface ConnectionToken {
  name: string;
  scope: string;
  audience: string | null;
  setupExpiresAt: Date | null;
  activatedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface ConnectionInstallation {
  clientType: string;
  capabilities: unknown;
  lastSeenAt: Date;
  createdAt: Date;
  revokedAt: Date | null;
  /** The agent this installation listens for, when it is an adapter. */
  companion: { name: string; live: boolean } | null;
}

export interface ConnectionRun {
  name: string | null;
  status: string;
  lastHeartbeatAt: Date;
  /** Set when a paired adapter's hooks own the run rather than the agent itself. */
  viaAdapter?: string;
}

export interface ConnectionInput {
  token: ConnectionToken;
  installation: ConnectionInstallation | null;
  /** The newest refresh grant of an OAuth connection. */
  refresh: { createdAt: Date; live: boolean } | null;
  /** The newest live run this connection (or an adapter paired with it) reported. */
  run: ConnectionRun | null;
  /** The newest heartbeat of any run of this installation, ended or not. */
  newestHeartbeatAt: Date | null;
  /** Live local adapters paired with this connection. */
  adapters: Array<{ name: string; lastSeenAt: Date }>;
  /** The project this connection is bound to, for the optional adapter command. */
  project: { slug: string; name: string } | null;
  teamSlug: string;
  baseUrl: string;
  /** Minutes a run's presence lasts: active, and waiting or blocked. */
  leases: { activeMinutes: number; waitingMinutes: number };
}

export interface NextStep {
  kind: 'console' | 'terminal' | 'client' | 'none';
  text: string;
  /** For `terminal`: the exact command, to run at the checkout root. */
  command?: string;
  /** For `console`: where on this page the action is. */
  href?: string;
}

export interface ConnectionState {
  kind: ConnectionKind;
  authorization: {
    state: AuthorizationState;
    label: string;
    observedAt: Date | null;
    source: AuthorizationSource;
    note: string;
  };
  adapter: { state: AdapterState; observedAt: Date | null; note: string };
  lastContact: { at: Date | null; source: ContactSource };
  task: { state: TaskState; observedAt: Date | null; note: string };
  unknown: string[];
  nextStep: NextStep;
}

const CLIENT_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
};

const clientName = (clientType: string | undefined) => (clientType ? CLIENT_NAMES[clientType] : undefined) ?? 'the client';

/**
 * A value that can be placed in a command typed in any shell, or null.
 *
 * The command is shown with a Copy button and a project's display name is
 * free text that any member's agent can create. POSIX single quotes mean
 * nothing to PowerShell, where `x'; Write-Output y; '` escapes them, so quoting
 * the value is not a defence. Instead only letters, digits, spaces and the
 * characters of slugs, hosts and URLs are allowed; a space is carried in double
 * quotes, which no shell expands when no `$`, backtick, backslash or quote is
 * inside. A value outside that set yields no command at all.
 */
const SAFE_COMMAND_ARG = /^[A-Za-z0-9][A-Za-z0-9 ._:/@-]*$/;
export const safeCommandArg = (value: string): string | null => {
  if (!SAFE_COMMAND_ARG.test(value) || value !== value.trimEnd()) return null;
  return value.includes(' ') ? `"${value}"` : value;
};

/**
 * Whether an installation's `lastSeenAt` is a contact or only its registration.
 * The row is created with `lastSeenAt` set to its creation time, which is not a
 * request; only a later write is one. The roster and the agent inventory print
 * through this so no page shows a registration as a contact.
 */
export const REGISTRATION_WINDOW_MS = 2_000;
export const contactTimeOf = (installation: { lastSeenAt: Date; createdAt: Date }): Date | null =>
  installation.lastSeenAt.getTime() - installation.createdAt.getTime() > REGISTRATION_WINDOW_MS
    ? installation.lastSeenAt
    : null;

/** Which family of connection this is, from the registration alone. */
export function connectionKind(installation: Pick<ConnectionInstallation, 'clientType' | 'capabilities'> | null): ConnectionKind {
  if (installation?.clientType === CLAUDE_APP_CLIENT) return 'console';
  if (installation && isLocalAdapter(installation.capabilities)) return 'adapter';
  return 'agent';
}

const hasCapability = (capabilities: unknown, name: string) =>
  Array.isArray(capabilities) && capabilities.includes(name);

function authorizationOf(input: ConnectionInput, now: Date): ConnectionState['authorization'] {
  const { token, installation, refresh } = input;
  const make = (
    state: AuthorizationState,
    observedAt: Date | null,
    source: AuthorizationSource,
    note: string,
  ) => ({ state, label: AUTHORIZATION_LABEL[state], observedAt, source, note });
  const revokedAt = token.revokedAt ?? installation?.revokedAt ?? null;
  if (revokedAt) {
    return make('revoked', revokedAt, 'revocation', 'Server access was revoked. The local entry, if any, is not removed from here.');
  }
  if (token.setupExpiresAt && !token.activatedAt) {
    return token.setupExpiresAt <= now
      ? make('setup_expired', token.setupExpiresAt, 'enrollment', 'The client never completed sign-in inside the setup window.')
      : make(
          'awaiting_client',
          token.createdAt,
          'enrollment',
          'The connection exists, but the client has not yet made the first MCP request that confirms it.',
        );
  }
  if (token.activatedAt) {
    // An OAuth access token lasts an hour and the client refreshes it. One that
    // expired with no unspent refresh grant behind it cannot be renewed: the
    // client has to sign in again.
    if (token.audience && token.expiresAt && token.expiresAt <= now && !(refresh && refresh.live)) {
      return make(
        'sign_in_again',
        token.expiresAt,
        'oauth_token_expiry',
        'The access token expired and no refresh grant is left, so the client must sign in again.',
      );
    }
    const source: AuthorizationSource = token.audience
      ? 'oauth_initialize'
      : hasCapability(installation?.capabilities, TERMINAL_CONNECT_CAPABILITY)
        ? 'terminal_initialize'
        : 'whoami';
    return make('authorized', token.activatedAt, source, 'The client completed sign-in. This is identity and scope, not proof of repository work.');
  }
  return make(
    'legacy_unverified',
    token.createdAt,
    'enrollment',
    'An older credential that never reported through the verified setup. It works, but STMA never saw the client load it.',
  );
}

function lastContactOf(input: ConnectionInput): ConnectionState['lastContact'] {
  const { token, installation, refresh } = input;
  // Listed in the order that wins a tie, so the one contact a connection has had
  // is called what it was: activation sets `lastUsedAt` in the same instant.
  const candidates: Array<[Date | null | undefined, ContactSource]> = [
    [token.activatedAt, 'activation'],
    [refresh?.createdAt, 'oauth_token_issue'],
    [input.newestHeartbeatAt, 'run_heartbeat'],
    [token.lastUsedAt, 'authenticated_request'],
    // The row is created with `lastSeenAt` set to its creation time, which is a
    // registration, not a request; only a later write is a contact.
    [installation ? contactTimeOf(installation) : null, 'authenticated_request'],
  ];
  let best: { at: Date; source: ContactSource } | null = null;
  for (const [at, source] of candidates) {
    if (at && (!best || at.getTime() > best.at.getTime())) best = { at, source };
  }
  return best ? { at: best.at, source: best.source } : { at: null, source: 'none' };
}

function adapterOf(input: ConnectionInput, kind: ConnectionKind): ConnectionState['adapter'] {
  const { installation } = input;
  if (kind === 'console') {
    return { state: 'not_applicable', observedAt: null, note: 'Not applicable to a console.' };
  }
  if (kind === 'adapter') {
    const companion = installation?.companion;
    return companion?.live
      ? {
          state: 'paired',
          observedAt: null,
          note: `This is the local adapter. It listens for ${companion.name}. Whether its hooks are still on disk is not checked from here.`,
        }
      : {
          state: 'unpaired_adapter',
          observedAt: null,
          note: companion
            ? `It was paired with ${companion.name}, which is revoked. Hooks may still run in the checkout.`
            : 'This local adapter is not paired with an agent, so its hook cannot announce assigned work.',
        };
  }
  if (hasCapability(installation?.capabilities, TERMINAL_CONNECT_CAPABILITY)) {
    return {
      state: 'installed_by_connect',
      observedAt: installation?.createdAt ?? null,
      note: 'Hooks were installed by stma connect at setup time; local files are not checked from here.',
    };
  }
  if (input.adapters.length > 0) {
    const newest = input.adapters.reduce((a, b) => (b.lastSeenAt > a.lastSeenAt ? b : a));
    return {
      state: 'paired',
      observedAt: newest.lastSeenAt,
      note: `Local adapter ${input.adapters.map((a) => a.name).join(', ')} is paired. It last called STMA at the time shown; hooks on disk are not checked from here.`,
    };
  }
  return {
    state: 'not_reported',
    observedAt: null,
    note: 'No local adapter reported. Hooks are optional; without them STMA sees only what this agent sends itself.',
  };
}

function taskOf(input: ConnectionInput, kind: ConnectionKind, now: Date): ConnectionState['task'] {
  if (kind === 'console') {
    return { state: 'no_run_reported', observedAt: null, note: 'A console starts no runs.' };
  }
  const { run } = input;
  if (!run) {
    return { state: 'no_run_reported', observedAt: null, note: 'No active run reported. STMA does not know what the client is doing outside a run.' };
  }
  const waiting = run.status === 'waiting' || run.status === 'blocked';
  const leaseMs = (waiting ? input.leases.waitingMinutes : input.leases.activeMinutes) * 60_000;
  const lapsed = now.getTime() - run.lastHeartbeatAt.getTime() > leaseMs;
  const label = run.name ? `Run "${run.name}"` : 'A run';
  const via = run.viaAdapter ? ` (reported by adapter ${run.viaAdapter})` : '';
  if (lapsed) {
    return {
      state: 'heartbeat_overdue',
      observedAt: run.lastHeartbeatAt,
      note: `${label}${via} stopped reporting; its lease lapses or has lapsed.`,
    };
  }
  if (waiting) {
    return {
      state: 'waiting_for_person',
      observedAt: run.lastHeartbeatAt,
      note: `${label}${via} reported ${run.status}: the agent said it is waiting for a person.`,
    };
  }
  return {
    state: 'run_reported',
    observedAt: run.lastHeartbeatAt,
    note: `${label}${via} reported ${run.status}. This is the agent's own report.`,
  };
}

function nextStepOf(
  input: ConnectionInput,
  kind: ConnectionKind,
  authorization: ConnectionState['authorization'],
  adapter: ConnectionState['adapter'],
  task: ConnectionState['task'],
): NextStep {
  const client = clientName(input.installation?.clientType);
  const isConsole = kind === 'console';
  switch (authorization.state) {
    case 'revoked':
      return isConsole
        ? {
            kind: 'console',
            text: 'Add STMA to Claude again: the earlier connection was revoked and is not restored.',
            href: '#claude-app',
          }
        : { kind: 'console', text: 'Connect again with a fresh connection.', href: '#connect' };
    case 'setup_expired':
      return isConsole
        ? {
            kind: 'console',
            text: 'Add STMA to Claude again; the earlier attempt was never completed.',
            href: '#claude-app',
          }
        : { kind: 'console', text: 'Create a fresh connection; this setup window has ended.', href: '#connect' };
    case 'awaiting_client':
      return {
        kind: 'client',
        text: isConsole
          ? 'Finish adding the connector in Claude; its first request confirms this connection.'
          : `Reload ${client} in that checkout once; its first MCP initialize confirms this connection.`,
      };
    case 'sign_in_again':
      return isConsole
        ? {
            kind: 'client',
            text: 'In Claude, open the STMA connector in your connector settings and sign in again, or remove it and add STMA to Claude again.',
            href: '#claude-app',
          }
        : {
            kind: 'terminal',
            text: 'Sign in again in a terminal at the checkout root: claude mcp login NAME or codex mcp login NAME (NAME is the name your client lists for STMA).',
          };
    default:
      break;
  }
  if (kind === 'console') {
    return { kind: 'none', text: 'This is your console. Ask Claude what is waiting for you in STMA.' };
  }
  if (task.state === 'heartbeat_overdue') {
    return {
      kind: 'terminal',
      text: 'In a terminal at the checkout root, check the local hooks. If the doctor reports a problem it prints the exact repair command.',
      command: 'stma adapter doctor',
    };
  }
  if (adapter.state === 'unpaired_adapter') {
    return { kind: 'console', text: 'Choose the agent this adapter listens for in the row on this page.', href: '#connections' };
  }
  // Hooks exist for Claude Code and Codex only; a Cursor or generic client is not
  // offered a command that would install them for the wrong client. The CLI checks
  // the project by its name, so the name goes in the command; `safeCommandArg`
  // refuses any value a shell could read as more than one word.
  const target = input.installation?.clientType;
  if (kind === 'agent' && adapter.state === 'not_reported' && input.project && (target === 'claude-code' || target === 'codex')) {
    const team = safeCommandArg(input.teamSlug);
    const project = safeCommandArg(input.project.name);
    const server = safeCommandArg(input.baseUrl);
    if (team && project && server) {
      return {
        kind: 'terminal',
        text: 'Optional: to track work and guard edits in a checkout, run this in a terminal at the checkout root.',
        command: `stma adapter activate --target ${target} --team ${team} --project ${project} --server ${server}`,
      };
    }
    return {
      kind: 'none',
      text: "Optional hooks: this project's name has characters a copied command cannot carry safely, so no command is offered here. Type stma adapter activate yourself with the project's name.",
    };
  }
  return { kind: 'none', text: 'Nothing is needed from this page.' };
}

/**
 * The five fields of one connection. Pure: the same input and clock give the
 * same words, which is what lets the wording be asserted as a table.
 */
export function describeConnection(input: ConnectionInput, now: Date = new Date()): ConnectionState {
  const kind = connectionKind(input.installation);
  const authorization = authorizationOf(input, now);
  const adapter = adapterOf(input, kind);
  const task = taskOf(input, kind, now);
  const unknown =
    kind === 'console' ? [UNKNOWN_CONSOLE_OPEN] : [UNKNOWN_HOOKS_ON_DISK, UNKNOWN_CLIENT_OPEN];
  return {
    kind,
    authorization,
    adapter,
    lastContact: lastContactOf(input),
    task,
    unknown,
    nextStep: nextStepOf(input, kind, authorization, adapter, task),
  };
}

// ----------------------------------------------------------------- assigned work

export type WorkStepName = 'sent' | 'accepted' | 'started' | 'waiting_for_person' | 'completed' | 'cancelled' | 'declined';

/** The one label table for a handoff's state: the project card and the roster read it. */
export const WORK_STATE_LABEL: Record<string, string> = {
  offered: 'sent, not yet accepted',
  accepted: 'accepted',
  in_progress: 'in progress',
  needs_attention: 'needs attention',
  completed: 'completed, as reported by the agent',
  cancelled: 'cancelled',
  declined: 'declined',
};

export const WORK_STEP_LABEL: Record<WorkStepName, string> = {
  sent: 'Sent',
  accepted: 'Accepted by the agent',
  started: 'Started',
  waiting_for_person: 'Waiting for a person',
  completed: 'Completed, as reported by the agent',
  cancelled: 'Cancelled by the sender',
  declined: 'Declined',
};

/** The sentence every lifecycle ends with: what STMA could not observe. */
export const WORK_NOT_OBSERVED =
  "Not observed: whether the agent's prompt hook announced this, or whether its client is open. STMA starts no local process.";

export interface WorkInput {
  handoff: {
    kind: string;
    state: string;
    createdAt: Date;
    acceptedAt: Date | null;
    resumedAt: Date | null;
    completedAt: Date | null;
    updatedAt: Date;
  };
  /** When an `agent_events` row `run_named` carried this work's session id: a run was named for it, not that it started. */
  runNamedAt?: Date | null;
  /** The live run of the agent that holds the work, if one was reported. */
  agentRun?: { status: string; lastHeartbeatAt: Date } | null;
  waitingLeaseMinutes?: number;
  now?: Date;
  /** For an assignment: would a paired adapter in the project hear it? Undefined when not asked. */
  hookWillAnnounce?: boolean;
}

export interface WorkStep {
  step: WorkStepName;
  at: Date;
  source: string;
}

export interface WorkDescription {
  steps: WorkStep[];
  /** The honest sentence about the prompt hook; empty when it does not apply. */
  hook: string;
  notObserved: string;
}

/**
 * The life of one piece of dispatched work, from events that were recorded.
 * Each step is present only when the record that proves it is. A step that
 * cannot be proven is absent, and `notObserved` says what STMA never sees.
 */
export function describeWork(input: WorkInput): WorkDescription {
  const { handoff } = input;
  const steps: WorkStep[] = [{ step: 'sent', at: handoff.createdAt, source: 'the handoff record' }];
  if (handoff.acceptedAt) {
    steps.push({ step: 'accepted', at: handoff.acceptedAt, source: 'the agent called update_handoff accept' });
  }
  // Only the agent's own `resume` (or the handoff state it moved to) proves the
  // work started. A `run_named` event is also written on accept, and only renames
  // a run that was already open, so it never reads as a start.
  if (handoff.resumedAt) {
    steps.push({ step: 'started', at: handoff.resumedAt, source: 'the agent called update_handoff resume' });
  } else if (handoff.state === 'in_progress') {
    steps.push({ step: 'started', at: handoff.updatedAt, source: 'the handoff state' });
  }
  const run = input.agentRun;
  const leaseMs = (input.waitingLeaseMinutes ?? 30) * 60_000;
  // A run's own report counts for this work only when the work was accepted and
  // a run was named for this very session. An agent can hold a waiting run for
  // something else, and a sent-but-unaccepted assignment has no run at all.
  const runIsForThisWork =
    Boolean(input.runNamedAt) && ['accepted', 'in_progress'].includes(handoff.state) && Boolean(handoff.acceptedAt);
  const runWaiting =
    run &&
    runIsForThisWork &&
    (run.status === 'waiting' || run.status === 'blocked') &&
    (input.now ?? new Date()).getTime() - run.lastHeartbeatAt.getTime() <= leaseMs;
  if (handoff.state === 'needs_attention') {
    steps.push({ step: 'waiting_for_person', at: handoff.updatedAt, source: 'the handoff was marked needs attention' });
  } else if (runWaiting) {
    steps.push({ step: 'waiting_for_person', at: run!.lastHeartbeatAt, source: `the run named for this work reported ${run!.status}` });
  }
  if (handoff.completedAt) {
    steps.push({ step: 'completed', at: handoff.completedAt, source: 'reported by the agent' });
  } else if (handoff.state === 'cancelled') {
    steps.push({ step: 'cancelled', at: handoff.updatedAt, source: 'the sender cancelled' });
  } else if (handoff.state === 'declined') {
    steps.push({ step: 'declined', at: handoff.updatedAt, source: 'the receiver declined' });
  }
  let hook = '';
  // A statement about the future: only while nothing has accepted the work.
  if (handoff.kind === 'assignment' && handoff.state === 'offered' && input.hookWillAnnounce !== undefined) {
    hook = input.hookWillAnnounce
      ? 'A paired local adapter reaches this project, so its hook can announce the work at the agent\'s next prompt. STMA does not record whether it did.'
      : 'No paired local adapter reaches this project, so the agent finds this only by reading its inbox.';
  }
  return { steps, hook, notObserved: WORK_NOT_OBSERVED };
}

// ----------------------------------------------------------------- the reader

type TokenRow = typeof tokens.$inferSelect;

export interface ConnectionContext {
  teamSlug: string;
  baseUrl: string;
  leases: { activeMinutes: number; waitingMinutes: number };
  projectsById: Map<string, { slug: string; name: string }>;
}

/**
 * The state of every connection in a list, with five queries however long the
 * list is. Only the caller's own tokens are ever passed in: the page reads
 * `connectionsHere`, which filters on the user, and no field here is fetched for
 * anyone else.
 */
export async function connectionStates(
  db: Db,
  list: TokenRow[],
  context: ConnectionContext,
  now: Date = new Date(),
): Promise<Map<string, ConnectionState>> {
  const states = new Map<string, ConnectionState>();
  if (list.length === 0) return states;
  const tokenIds = list.map((token) => token.id);

  const installations = await db
    .select()
    .from(agentInstallations)
    .where(inArray(agentInstallations.tokenId, tokenIds));
  const byToken = new Map(installations.filter((row) => row.tokenId).map((row) => [row.tokenId!, row]));
  const installationIds = installations.map((row) => row.id);

  // Adapters that listen for these agents, and the agents these adapters listen for.
  const companionIds = installations.map((row) => row.companionOf).filter((id): id is string => Boolean(id));
  const relatedWhere = or(
    installationIds.length ? inArray(agentInstallations.companionOf, installationIds) : undefined,
    companionIds.length ? inArray(agentInstallations.id, companionIds) : undefined,
  );
  const related = relatedWhere
    ? await db
        .select({
          id: agentInstallations.id,
          name: agentInstallations.name,
          lastSeenAt: agentInstallations.lastSeenAt,
          companionOf: agentInstallations.companionOf,
          revokedAt: agentInstallations.revokedAt,
        })
        .from(agentInstallations)
        .where(relatedWhere)
    : [];
  const relatedById = new Map(related.map((row) => [row.id, row]));
  const adaptersOf = new Map<string, Array<{ id: string; name: string; lastSeenAt: Date }>>();
  for (const row of related) {
    if (row.companionOf && !row.revokedAt) {
      const own = adaptersOf.get(row.companionOf) ?? [];
      own.push({ id: row.id, name: row.name, lastSeenAt: row.lastSeenAt });
      adaptersOf.set(row.companionOf, own);
    }
  }

  // The newest refresh grant of each OAuth connection, and whether one is unspent.
  const oauthIds = list.filter((token) => token.audience).map((token) => token.id);
  const refreshRows = oauthIds.length
    ? await db
        .select({
          tokenId: oauthRefreshTokens.tokenId,
          newest: sql<Date>`max(${oauthRefreshTokens.createdAt})`,
          live: sql<number>`count(*) filter (where ${oauthRefreshTokens.usedAt} is null and ${oauthRefreshTokens.revokedAt} is null)`,
        })
        .from(oauthRefreshTokens)
        .where(inArray(oauthRefreshTokens.tokenId, oauthIds))
        .groupBy(oauthRefreshTokens.tokenId)
    : [];
  const refreshBy = new Map(
    refreshRows.map((row) => [row.tokenId, { createdAt: new Date(row.newest), live: Number(row.live) > 0 }]),
  );

  // Runs of these installations and of the adapters beside them.
  const runOwnerIds = [...new Set([...installationIds, ...[...adaptersOf.values()].flat().map((a) => a.id)])];
  const liveRuns = runOwnerIds.length
    ? await db
        .select({
          installationId: agentRuns.installationId,
          taskKey: agentRuns.taskKey,
          intent: agentRuns.intent,
          status: agentRuns.status,
          lastHeartbeatAt: agentRuns.lastHeartbeatAt,
        })
        .from(agentRuns)
        .where(
          and(inArray(agentRuns.installationId, runOwnerIds), inArray(agentRuns.status, [...ACTIVE_AGENT_RUN_STATUSES])),
        )
        .orderBy(desc(agentRuns.lastHeartbeatAt))
    : [];
  const heartbeats = runOwnerIds.length
    ? await db
        .select({ installationId: agentRuns.installationId, newest: sql<Date>`max(${agentRuns.lastHeartbeatAt})` })
        .from(agentRuns)
        .where(inArray(agentRuns.installationId, runOwnerIds))
        .groupBy(agentRuns.installationId)
    : [];
  const heartbeatBy = new Map(heartbeats.map((row) => [row.installationId, new Date(row.newest)]));

  for (const token of list) {
    const installation = byToken.get(token.id) ?? null;
    const adapters = installation ? (adaptersOf.get(installation.id) ?? []) : [];
    const owners = installation ? [installation.id, ...adapters.map((a) => a.id)] : [];
    const run = liveRuns.find((row) => owners.includes(row.installationId));
    const newestHeartbeat = owners
      .map((id) => heartbeatBy.get(id))
      .filter((d): d is Date => Boolean(d))
      .reduce<Date | null>((best, d) => (!best || d > best ? d : best), null);
    const companion = installation?.companionOf ? relatedById.get(installation.companionOf) : undefined;
    const adapterName = run && installation && run.installationId !== installation.id
      ? adapters.find((a) => a.id === run.installationId)?.name
      : undefined;
    states.set(
      token.id,
      describeConnection(
        {
          token,
          installation: installation
            ? {
                clientType: installation.clientType,
                capabilities: installation.capabilities,
                lastSeenAt: installation.lastSeenAt,
                createdAt: installation.createdAt,
                revokedAt: installation.revokedAt,
                companion: companion ? { name: companion.name, live: !companion.revokedAt } : null,
              }
            : null,
          refresh: refreshBy.get(token.id) ?? null,
          run: run
            ? {
                name: run.taskKey ?? run.intent,
                status: run.status,
                lastHeartbeatAt: run.lastHeartbeatAt,
                ...(adapterName ? { viaAdapter: adapterName } : {}),
              }
            : null,
          newestHeartbeatAt: newestHeartbeat,
          adapters: adapters.map((a) => ({ name: a.name, lastSeenAt: a.lastSeenAt })),
          project: token.projectId ? (context.projectsById.get(token.projectId) ?? null) : null,
          teamSlug: context.teamSlug,
          baseUrl: context.baseUrl,
          leases: context.leases,
        },
        now,
      ),
    );
  }
  return states;
}

/**
 * The moment a run was named for each session's work, from `run_named` events.
 * It ties an agent's run to this work (so that run's waiting report can count
 * for it); it is not a start, because accept writes it too. Bounded to the
 * sessions asked about.
 */
export async function runNamedFor(db: Db, sessionIds: string[]): Promise<Map<string, Date>> {
  const named = new Map<string, Date>();
  if (sessionIds.length === 0) return named;
  const rows = await db
    .select({ sessionId: sql<string>`${agentEvents.detail}->>'sessionId'`, at: agentEvents.createdAt })
    .from(agentEvents)
    .where(
      and(
        eq(agentEvents.type, 'run_named'),
        isNotNull(agentEvents.detail),
        inArray(sql<string>`${agentEvents.detail}->>'sessionId'`, sessionIds),
      ),
    )
    .orderBy(agentEvents.createdAt)
    .limit(500);
  for (const row of rows) if (!named.has(row.sessionId)) named.set(row.sessionId, row.at);
  return named;
}
