import type { AgentClientType } from '@bridge/shared';
import { TERMINAL_CONNECT_TTL_MINUTES } from '../domain/enrollments';
import { grantLabel, type TokenScope } from '../lib/grants';

/**
 * Connecting a checkout, wherever the person happens to be standing.
 *
 * There are two doors onto the same act now — the account's Agent connections
 * page and a project's Agents page — and a second copy of this markup would
 * drift inside a release: the two would disagree about what the command does,
 * how long the code lives, or which clients it supports. So the form and the
 * one-time command are one component each, parameterised by the only thing that
 * differs: whether the address has already decided the project.
 *
 * Nothing here touches the database. The rules behind the form live in
 * `domain/connectRequests.ts`, which both POST handlers call.
 */

export interface ConnectTeam {
  id: string;
  name: string;
  projects: { id: string; name: string }[];
}

/**
 * The workspace and project the command will be scoped to, when the page already
 * knows them. Names only: the ids travel in the address this posts to, never in
 * a field, so there is nothing here for a browser to change.
 */
export interface ConnectHere {
  team: { name: string };
  project: { name: string };
}

/** What was typed into a refused submission, so the page can hand it back. */
export interface ConnectTyped {
  name?: string;
  device?: string;
  client?: string;
}

/**
 * The form. `here` fixes the project — on a project's Agents page the address
 * already chose it, and a picker there would offer to connect an agent to some
 * other project. Without it the caller passes every workspace and the person picks.
 */
export const ConnectCheckoutForm = ({
  action,
  here,
  teams,
  preferredAccess,
  typed,
  context,
  idPrefix = 'tc',
}: {
  action: string;
  here?: ConnectHere;
  teams?: ConnectTeam[];
  /** `project:<id>` of the option to open on, when the page offers a choice. */
  preferredAccess?: string;
  typed?: ConnectTyped;
  /** Hidden fields the answering page needs to come back to where this was posted. */
  context?: unknown;
  /** Two forms can share a page, so ids must not collide. */
  idPrefix?: string;
}) => (
  <div class="card card-pad" style="display:flex;flex-direction:column;gap:16px">
    <div>
      <span class="overline">Fastest · one terminal command</span>
      <div class="card-title" style="margin-top:4px">Connect a Claude Code or Codex checkout</div>
      <div class="card-note">
        Choose the access here, where you are already signed in, and get one command. You run
        it in a terminal inside the checkout; no browser consent, no login step and no model
        handles the code. It adds the MCP entry for that checkout, installs the ignored local
        hooks and file guard, and gives the agent and its hooks <b>one</b> identity, so
        assigned work reaches the prompt hook with nothing to pair. The credential is stored in
        the client's own configuration (Claude Code: that checkout's local entry; Codex: its
        user <code>config.toml</code>) and, protected for your OS user, in <code>~/.stma</code>;
        it is scoped to {here ? <b>{here.project.name}</b> : 'what you choose below'} and
        revocable from Agent connections. Other clients use the OAuth path there.
      </div>
    </div>
    <form class="authform" method="post" action={action}>
      {context}
      <input type="hidden" name="mode" value="terminal" />
      <div class="field">
        <label for={`${idPrefix}-name`}>Agent name</label>
        <input
          class="in"
          id={`${idPrefix}-name`}
          type="text"
          name="name"
          placeholder="claude-backend"
          value={typed?.name}
          maxlength={80}
          required
        />
        <span class="help">What teammates see on runs, and the name a lead assigns work to.</span>
      </div>
      <div class="field">
        <label for={`${idPrefix}-device`}>Machine</label>
        <input
          class="in"
          id={`${idPrefix}-device`}
          type="text"
          name="device"
          placeholder="windows-desktop"
          value={typed?.device}
          maxlength={60}
          required
        />
      </div>
      <div class="field">
        <label for={`${idPrefix}-client`}>Client</label>
        <select class="in" id={`${idPrefix}-client`} name="client" required>
          <option value="claude-code" selected={typed?.client !== 'codex'}>
            Claude Code — one agent per checkout
          </option>
          <option value="codex" selected={typed?.client === 'codex'}>
            Codex — one agent per machine
          </option>
        </select>
        <span class="help">
          Claude Code keeps the entry with the checkout. Codex loads its user configuration in
          every checkout, so it gets one STMA identity per machine and the command refuses a
          second one; its hooks also need your trust in <code>/hooks</code>.
        </span>
      </div>
      {here ? (
        <div class="field">
          <span class="help m0">
            Access: <b>project only — {here.project.name}</b>, in <b>{here.team.name}</b>. The
            command is issued for this project because its hooks belong to this checkout.
          </span>
        </div>
      ) : (
        <div class="field">
          <label for={`${idPrefix}-access`}>Access</label>
          <select class="in" id={`${idPrefix}-access`} name="access" required>
            {(teams ?? []).map((team) => (
              <optgroup label={team.name}>
                {team.projects.map((project) => (
                  <option
                    value={`project:${project.id}`}
                    selected={preferredAccess === `project:${project.id}`}
                  >
                    Project only — {project.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <span class="help">
            One project, because the hooks belong to one checkout. Create the project first if it
            is not listed.
          </span>
        </div>
      )}
      <button class="btn btn-primary" type="submit" style="align-self:flex-start">
        Create connect command
      </button>
    </form>
  </div>
);

/**
 * The one-time command, shown once, wherever it was asked for.
 *
 * It is the reason both POST handlers answer with a page instead of a redirect:
 * nothing stores the code, so a redirect would lose it.
 */
export const ConnectCommand = ({
  command,
  agent,
  device,
  client,
  scope,
  teamSlug,
  projectName,
}: {
  command: string;
  agent: string;
  device: string;
  client: AgentClientType;
  scope: TokenScope;
  teamSlug?: string | null;
  projectName?: string | null;
}) => (
  <div class="reveal" id="terminal-connect">
    <div class="reveal-head">
      <span class="ic">✓</span>
      <div>
        <div class="reveal-title">Run this in a terminal, inside the checkout</div>
        <div class="reveal-sub">
          Paste it yourself, in a terminal opened at the Git checkout the agent works in. Do
          not paste it into the agent: the code is a one-use secret and a careful agent will
          refuse it. It is shown only now, works once and expires in{' '}
          {TERMINAL_CONNECT_TTL_MINUTES} minutes. The command shows the workspace and project
          and asks before it connects anything.
        </div>
      </div>
    </div>
    <div class="cmd setup-prompt">
      <code>{command}</code>
      <button class="copybtn solid" type="button" data-copy={command}>
        Copy command
      </button>
    </div>
    <div class="small" style="color:var(--green-ink)">
      Connects <b>{agent}</b> on <b>{device}</b> with access:{' '}
      <b>{grantLabel({ scope, teamSlug: teamSlug ?? null, projectName: projectName ?? null })}</b>.
      Afterwards restart {client === 'codex' ? 'Codex' : 'Claude Code'} in that folder.
    </div>
  </div>
);
