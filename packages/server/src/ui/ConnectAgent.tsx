import type { AgentClientType } from '@bridge/shared';
import { TERMINAL_CONNECT_TTL_MINUTES } from '../domain/enrollments';
import { grantLabel, type TokenScope } from '../lib/grants';

/**
 * Connecting a checkout from a workspace's Agent connections page.
 *
 * One page connects agents (2026-09-27, the owner's word: two connect screens
 * and a connections page outside every workspace were one too many). It is drawn
 * for a GET and again for the POST that answers with a one-time command, so the
 * form and the command are components rather than markup in two handlers that
 * would drift apart inside a release: what the command does, how long the code
 * lives, which clients it supports.
 *
 * Nothing here touches the database. The rules behind the form live in
 * `domain/connectRequests.ts`, which the POST handler calls.
 */

export interface ConnectTeam {
  id: string;
  name: string;
  projects: { id: string; name: string }[];
}

/**
 * The project the command will be scoped to, when the page is inside one.
 *
 * The id travels as a hidden field because the form posts to the one door that
 * issues connections. That door re-checks the caller's membership and that the
 * project belongs to one of their workspaces, so the field can only choose what
 * the person could have chosen on the page anyway.
 */
export interface ConnectHere {
  team: { name: string };
  project: { id: string; name: string };
}

/** What was typed into a refused submission, so the page can hand it back. */
export interface ConnectTyped {
  name?: string;
  device?: string;
  client?: string;
  access?: string;
}

/**
 * The form. `here` fixes the project: inside a project the address already chose
 * it, and a picker there would offer to connect an agent to some other project.
 * Without it the caller passes the workspace and the person picks one of its
 * projects.
 */
export const ConnectCheckoutForm = ({
  action,
  here,
  teams,
  preferredAccess,
  typed,
  context,
  projectsHref,
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
  /** Where a project is created, for a workspace that has none yet. */
  projectsHref?: string;
  /** Two forms can share a page, so ids must not collide. */
  idPrefix?: string;
}) => {
  const choices = (teams ?? []).filter((team) => team.projects.length > 0);
  return (
    <div class="card card-pad" style="display:flex;flex-direction:column;gap:16px">
      <div>
        <span class="overline">Fastest · one terminal command</span>
        <div class="card-title" style="margin-top:4px">Connect a Claude Code or Codex checkout</div>
        <div class="card-note">
          Choose the {here ? 'agent' : 'project'} here, where you are already signed in, and get one
          command. You run it in a terminal inside the checkout; no browser consent, no login step
          and no model handles the code. It adds the MCP entry for that checkout, installs the
          ignored local hooks and file guard, and gives the agent and its hooks <b>one</b> identity,
          so assigned work reaches the prompt hook with nothing to pair. The credential is stored in
          the client's own configuration (Claude Code: that checkout's local entry; Codex: its user{' '}
          <code>config.toml</code>) and, protected for your OS user, in <code>~/.stma</code>. It is
          scoped to {here ? <b>{here.project.name}</b> : 'the project you choose'} and you can revoke
          it below. Other clients use the OAuth path.
        </div>
      </div>
      {!here && choices.length === 0 ? (
        <p class="m0 muted">
          This workspace has no project yet, and a command is issued for one project because its
          hooks belong to one checkout.{' '}
          {projectsHref ? <a href={projectsHref}>Create the project</a> : 'Create the project'} first,
          or connect through OAuth below; the first agent that reports a snapshot also creates it.
        </p>
      ) : (
        <form class="authform" method="post" action={action}>
          {context}
          <input type="hidden" name="mode" value="terminal" />
          {here ? <input type="hidden" name="access" value={`project:${here.project.id}`} /> : null}
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
                Claude Code · one agent per checkout
              </option>
              <option value="codex" selected={typed?.client === 'codex'}>
                Codex · one agent per machine
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
                Access: <b>project only, {here.project.name}</b>, in <b>{here.team.name}</b>. The
                command is issued for this project because its hooks belong to this checkout.
              </span>
            </div>
          ) : (
            <div class="field">
              <label for={`${idPrefix}-access`}>Project</label>
              <select class="in" id={`${idPrefix}-access`} name="access" required>
                {choices.map((team) =>
                  team.projects.map((project) => (
                    <option
                      value={`project:${project.id}`}
                      selected={(typed?.access ?? preferredAccess) === `project:${project.id}`}
                    >
                      {project.name}
                    </option>
                  )),
                )}
              </select>
              <span class="help">
                One project, because the hooks belong to one checkout. Create the project first if
                it is not listed.
              </span>
            </div>
          )}
          <button class="btn btn-primary" type="submit" style="align-self:flex-start">
            Create connect command
          </button>
        </form>
      )}
    </div>
  );
};

/**
 * The one-time command, shown once, on the page that asked for it.
 *
 * It is the reason the POST answers with a page instead of a redirect: nothing
 * stores the code, so a redirect would lose it.
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
