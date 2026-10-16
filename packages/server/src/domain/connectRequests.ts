import { AGENT_CLIENT_TYPES, AGENT_ROLES, type AgentClientType, type AgentRole } from '@bridge/shared';
import { normalizeDeviceLabel } from '../lib/devices';

/**
 * What a connect submission has to carry, checked in one place.
 *
 * The one-time connect command and the legacy setup prompt are issued by one
 * door, `POST /app/tokens`, for the forms on a workspace's Agent connections
 * page. The refusal sentences live here with the checks that produce them, so a
 * mistake has one answer however the form was reached; the page decides only
 * where the answer is drawn.
 *
 * The scope is not read here: the handler resolves it from the access field and
 * re-checks the caller's membership before calling anything that writes.
 */

/** Everything the form can get wrong, and nothing it cannot. */
export type ConnectRequest =
  | { error: string }
  | { name: string; device: string; client: AgentClientType; role: AgentRole };

export function readConnectRequest(
  body: Record<string, unknown>,
  /** A connect command, rather than the legacy prompt form on the same page. */
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
  // it can write for. Anything else is answered with the path that does work,
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

/** The command itself: one spelling, because the page prints it and the CLI has to parse it. */
export const connectCommandFor = (code: string, baseUrl: string) =>
  `npx -y @matteai/stma connect ${code} --server ${baseUrl}`;
