export type SupportedMcpClient = 'codex' | 'claude-code';

export interface McpConnectPromptInput {
  baseUrl: string;
  client: SupportedMcpClient;
  teamSlug?: string;
  projectSlug?: string;
  projectName?: string;
}

const normalizeAliasPart = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * A readable per-scope alias avoids one global `stma` entry replacing another
 * project. Codex keeps MCP servers in its user config, so this is also the one
 * Codex identity per machine. For Claude Code it is only the legacy
 * machine-wide name the checkout request refuses to stack on top of.
 */
export function mcpServerAlias(input: Pick<McpConnectPromptInput, 'teamSlug' | 'projectSlug'>) {
  const scope = normalizeAliasPart(input.projectSlug || input.teamSlug || '');
  return scope ? `stma-${scope}` : 'stma';
}

/**
 * Claude Code stores an MCP OAuth login under `<server name>|<hash of type, url
 * and headers>`: not under the scope or the directory, and `claude mcp login`
 * revokes that key's previous tokens before it starts. Two agents that share a
 * name therefore share one STMA installation, and the second login disconnects
 * the first. Each Git checkout (clone or worktree) derives its own name, and
 * adds it at local scope, which Claude Code attaches to the repository root.
 *
 * The name is the checkout folder (readable at consent) plus four hex digits of
 * the root path's Git blob hash, so same-named folders elsewhere on the machine
 * still differ. Both spellings print `stma-<folder, at most 20>-<4 hex>`; each is
 * stable for one checkout in its own shell, which is all a presence check needs.
 */
export const CLAUDE_CHECKOUT_ALIAS_POSIX =
  'top="$(git rev-parse --show-toplevel)" && name="$(basename "$top" | tr "[:upper:]" "[:lower:]" | tr -cs "a-z0-9" "-" | cut -c1-20 | sed "s/^-*//; s/-*$//")" && echo "stma-${name:-checkout}-$(printf "%s\\n" "$top" | git hash-object --stdin | cut -c1-4)"';

export const CLAUDE_CHECKOUT_ALIAS_POWERSHELL =
  "$top = git rev-parse --show-toplevel; if ($LASTEXITCODE -ne 0) { throw 'Not inside a Git checkout.' }; $name = (Split-Path -Leaf $top).ToLower() -replace '[^a-z0-9]+', '-'; if ($name.Length -gt 20) { $name = $name.Substring(0, 20) }; $name = $name.Trim('-'); if (-not $name) { $name = 'checkout' }; \"stma-$name-\" + ($top | git hash-object --stdin).Substring(0, 4)";

const CHECKOUT_ALIAS_RE = /^stma-([a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?)-[0-9a-f]{4}$/;

/** The checkout folder a Claude Code OAuth registration names, for a consent-form default. */
export function claudeCheckoutAgentName(clientName: string): string | undefined {
  const server = /^Claude Code \((.+)\)$/.exec(clientName)?.[1];
  return server ? CHECKOUT_ALIAS_RE.exec(server)?.[1] : undefined;
}

export function mcpConnectPrompt(input: McpConnectPromptInput): string {
  const mcpUrl = `${input.baseUrl.replace(/\/+$/, '')}/mcp`;
  const alias = mcpServerAlias(input);
  const desiredAccess = input.projectName && input.teamSlug
    ? `Project only — ${input.projectName} in workspace ${input.teamSlug}`
    : input.teamSlug
      ? `Entire workspace — ${input.teamSlug}`
      : 'the exact project or workspace I choose in the STMA browser page';

  const rules = (names: string) => `
This message is my explicit request to add this one persistent MCP server entry. Use only this client's built-in MCP management command; do not edit its raw config file directly. Do not download or execute an installer, add an Authorization header, ask me for a token or enrollment code, or install hooks/file guards.

Limit every inspection and change to ${names}. Do not list, inspect, remove or treat any differently named MCP entry as a blocker, even if another entry uses the same URL or old authentication. Never display raw MCP configuration or command output that could contain headers or credentials.`;

  if (input.client === 'codex') {
    return `Connect this Codex client to STMA.

Server name: ${alias}
Streamable HTTP URL (clickable): <${mcpUrl}>
Desired access in the STMA consent screen: ${desiredAccess}
${rules(`the exact server name ${alias}`)}

Check only whether ${alias} already exists, with its output suppressed. If it exists, stop and tell me it was left untouched so I can review it in the client's own MCP settings. Do not replace or authenticate an existing entry from this request.

Safe presence check:
codex mcp get ${alias} >/dev/null 2>&1

If the entry is absent, run Codex's built-in command:
codex mcp add ${alias} --url "${mcpUrl}"

Some Codex builds start OAuth during mcp add. If that command already opens the STMA browser flow or reports a successful login, complete that one flow and do not start a second one. Only when mcp add merely saves the entry without starting OAuth, run:
codex mcp login ${alias}

The native OAuth flow should open STMA in my browser. Do not approve the browser consent on my behalf: pause so I can review the agent name, machine, client reported by OAuth and exact access, then click Allow connection.

After the native command reports a successful login, do not run "codex mcp status" and do not launch a nested or non-interactive "codex exec" to test it. This running task may not hot-load a newly added MCP server. Tell me once to reload or restart this Codex task, then stop. In the reloaded task, when I ask to check STMA, call the newly loaded STMA whoami tool directly and report the workspace, project scope and non-secret installation identity. If this Codex build cannot add or authenticate a remote OAuth MCP server, stop and tell me the exact unsupported step; do not fall back to a custom installer or copied token.

Codex keeps this entry in its user configuration, so every Codex task on this machine shares this one STMA identity.`;
  }

  return `Connect this Claude Code agent to STMA, as the agent for this Git checkout.

Remote HTTP URL (clickable): <${mcpUrl}>
Desired access in the STMA consent screen: ${desiredAccess}
${rules(`the checkout server name you compute below and the machine-wide name ${alias}`)}

Each Git checkout (clone or worktree) is its own STMA agent. Claude Code stores an MCP login under the server's name and signs out any earlier login under that name, so the name must be unique to this checkout, and the entry is added at local scope so no other checkout on this machine loads it. It is fine to paste this same request into every Claude Code agent: each derives its own name.

Before changing configuration, check whether this Claude Code build supports direct native OAuth login:
claude mcp help login >/dev/null 2>&1

If that check fails, stop before adding anything. Report the installed "claude --version" and tell me to run "claude update", then paste this request again. Do not update the client automatically and do not send me to a /mcp menu from a desktop chat.

From inside the Git checkout this agent works in, compute the checkout server name. If your command tool runs bash or zsh (including Git Bash on Windows), run:
${CLAUDE_CHECKOUT_ALIAS_POSIX}

If it runs PowerShell, run:
${CLAUDE_CHECKOUT_ALIAS_POWERSHELL}

If Git reports this is not a repository, stop and tell me which checkout to open. Otherwise use the printed name, exactly, wherever SERVER_NAME appears below, and note the checkout path that "git rev-parse --show-toplevel" prints.

Earlier STMA setup requests added the machine-wide name ${alias}, which loads in every checkout. Check it with its output suppressed:
claude mcp get ${alias} >/dev/null 2>&1

If it exists, stop: this checkout would load two STMA identities. Tell me it was left untouched and that I decide between keeping that single machine-wide agent and removing it myself with "claude mcp remove --scope user ${alias}". Do not remove it.

Check whether SERVER_NAME already exists, with its output suppressed:
claude mcp get SERVER_NAME >/dev/null 2>&1

If it exists, stop and tell me this checkout is already connected and was left untouched. Do not replace or authenticate an existing entry from this request.

If it is absent, run Claude Code's built-in command at local scope from inside this checkout:
claude mcp add --transport http --scope local SERVER_NAME "${mcpUrl}"

Local scope attaches the entry to this repository root; it loads in this checkout and its subfolders only. It does not broaden the access enforced by STMA: the browser-approved project or workspace remains the server-side boundary.

Before starting authentication, check whether your command environment has an interactive terminal: in bash or zsh with [ -t 0 ] && [ -t 1 ], in PowerShell with -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected.

If that check succeeds, run Claude Code's native OAuth command:
claude mcp login SERVER_NAME

If that check fails, do not attempt login from the non-interactive tool shell and do not report it as an OAuth or server failure. Tell me once to open a regular terminal in this checkout, showing me the checkout path you noted, and to run exactly "claude mcp login SERVER_NAME" there. The entry is local to this checkout, so the login must run inside it or one of its subfolders. On Windows, tell me to type "claude.cmd" instead of "claude" in that command: Windows PowerShell refuses the npm-installed claude.ps1 under its default execution policy, claude.cmd is not subject to it, and I must never be asked to change the execution policy for this. This is the only manual command in the supported fallback; do not ask me to add the server again, paste a URL, token, code or configuration.

The native OAuth flow should open STMA in my browser. Do not approve the browser consent on my behalf: pause so I can review the agent name, machine, client reported by OAuth and exact access, then click Allow connection.

After the native command reports a successful login, do not launch a nested or non-interactive Claude process to test it. This running task may not hot-load a newly added MCP server. Tell me once to reload or restart this Claude Code task in this checkout, then stop. In the reloaded task, when I ask to check STMA, call the newly loaded STMA whoami tool directly and report the workspace, project scope and non-secret installation identity. If an interactive Claude Code login cannot authenticate the remote OAuth MCP server, stop and tell me the exact unsupported step; do not fall back to a custom installer or copied token.`;
}
