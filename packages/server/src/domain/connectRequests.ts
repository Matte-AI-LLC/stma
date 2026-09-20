import { AGENT_CLIENT_TYPES, AGENT_ROLES, type AgentClientType, type AgentRole } from '@bridge/shared';
import type { Db } from '../db';
import { normalizeDeviceLabel } from '../lib/devices';
import { createAgentEnrollment, TERMINAL_CONNECT_TTL_MINUTES } from './enrollments';

/**
 * What a terminal-connect submission has to carry, checked in one place.
 *
 * Two pages issue this command now — the account's Agent connections page and a
 * project's Agents page — and each of them refusing in its own words is how the
 * same mistake comes to have two answers. The refusal sentences live here with
 * the checks that produce them; the pages decide only where the answer is drawn.
 *
 * The scope is not read from the form: `POST /app/tokens` resolves it from the
 * access picker and a project's Agents page takes it from the address, and both
 * have already proved the caller's membership before calling this.
 */

/** Everything the form can get wrong, and nothing it cannot. */
export type ConnectRequest =
  | { error: string }
  | { name: string; device: string; client: AgentClientType; role: AgentRole };

export function readConnectRequest(
  body: Record<string, unknown>,
  /** A connect command, rather than the legacy OAuth/prompt form on the same page. */
  opts: { terminal: boolean },
): ConnectRequest {
  const name =
    typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : '';
  const device = normalizeDeviceLabel(typeof body.device === 'string' ? body.device : undefined);
  if (!name || !device) {
    return { error: 'Name one agent and one machine before creating a prompt.' };
  }
  const client =
    typeof body.client === 'string' && (AGENT_CLIENT_TYPES as readonly string[]).includes(body.client)
      ? (body.client as AgentClientType)
      : 'generic';
  // A connect command installs that client's own hooks, so there are exactly two
  // it can write for. Anything else is answered with the path that does work —
  // never with a silent fallback to a client whose hooks would never be written.
  if (opts.terminal && client !== 'claude-code' && client !== 'codex') {
    return {
      error: 'A connect command supports Claude Code and Codex. Use the OAuth path for another client.',
    };
  }
  const role =
    typeof body.role === 'string' && (AGENT_ROLES as readonly string[]).includes(body.role)
      ? (body.role as AgentRole)
      : 'generalist';
  return { name, device, client, role };
}

/**
 * The one enrollment a connect command carries: project-scoped, short-lived
 * because it is pasted rather than stored.
 *
 * `POST /app/tokens` still calls `createAgentEnrollment` itself, because its one
 * form also issues personal- and team-scoped legacy prompts and this would be a
 * second branch in it rather than one fewer. Here the scope is not a choice.
 */
export async function issueConnectCommand(
  db: Db,
  input: {
    userId: string;
    name: string;
    device: string;
    client: AgentClientType;
    role: AgentRole;
    teamId: string;
    projectId: string;
  },
) {
  return createAgentEnrollment(db, {
    userId: input.userId,
    name: input.name,
    deviceLabel: input.device,
    clientType: input.client,
    role: input.role,
    scope: 'project',
    teamId: input.teamId,
    projectId: input.projectId,
    ttlMinutes: TERMINAL_CONNECT_TTL_MINUTES,
  });
}

/** The command itself: one spelling, because both pages print it and the CLI has to parse it. */
export const connectCommandFor = (code: string, baseUrl: string) =>
  `npx -y @matteai/stma connect ${code} --server ${baseUrl}`;
