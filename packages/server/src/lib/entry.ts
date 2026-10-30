/**
 * The two doors into STMA, named once.
 *
 * A person arrives wanting one of two different things, and the product used to
 * treat them as one: a Claude app console (Claude on the web, desktop or phone,
 * talking to STMA as a connector) and a coding agent in a checkout (Claude Code,
 * Codex or Cursor, connected to a project, with local hooks). The first is a
 * person's console across workspaces; the second is an agent that does work
 * under policy. The words, the boundary sentences and the link to Claude's own
 * connector dialog live here, so the guide, the Agent connections page, the
 * consent page and the empty workspace list cannot drift into describing them
 * differently.
 *
 * `entry` is how a door survives sign-in, signup and creating a first
 * workspace. It is a closed set read with `parseEntry`: anything else is dropped,
 * never echoed, and never decides where a redirect goes beyond the two fixed
 * in-app anchors below.
 */

export const ENTRY = ['claude-app', 'coding-client'] as const;
export type Entry = (typeof ENTRY)[number];

/**
 * The closed value, or nothing. The result is a member of the set, not the input
 * that matched it, so a caller can place it in a URL or a form without a second
 * look at what a stranger typed.
 */
export function parseEntry(value: unknown): Entry | undefined {
  return ENTRY.find((known) => known === value);
}

/** Where on a workspace's Agent connections page each door begins. */
export const entryAnchor = (entry: Entry): '#claude-app' | '#connect' =>
  entry === 'claude-app' ? '#claude-app' : '#connect';

/** The two names, as every page spells them. */
export const CLAUDE_APP_TERM = 'Claude app console';
export const CODING_AGENT_TERM = 'coding agent in a checkout';

/** What the Claude app console is not, in the words every surface repeats. */
export const CLAUDE_APP_BOUNDARY =
  'It is not an agent in a checkout: it installs no hooks, has no file guard, and nobody can assign it work.';

export const CLAUDE_APP_SUMMARY =
  'Talk to STMA from Claude on the web, desktop or phone. It reads your workspaces and asks before each write.';

export const CODING_AGENT_SUMMARY =
  'Connect Claude Code, Codex or Cursor to a project with stma connect, then test two agents and hand work over.';

/** Said wherever the first test is explained: the console is not one of its two agents. */
export const CONSOLE_NOT_SECOND_AGENT =
  'The Claude app is your console, not a second agent: use two coding agents connected in checkouts.';

/** One account may use both doors; this is the sentence that says so. */
export const BOTH_DOORS =
  'One account can use both: a Claude app console for asking, and coding agents in checkouts for doing.';

/**
 * Claude's own prefilled "Add custom connector" dialog
 * (claude.com/docs/connectors/building/directory-vs-custom). It fills the form
 * and the person confirms, so the link grants nothing by itself.
 */
export function claudeConnectorLink(baseUrl: string): string {
  return `https://claude.ai/customize/connectors?${new URLSearchParams({
    modal: 'add-custom-connector',
    connectorName: 'STMA',
    connectorUrl: `${baseUrl}/mcp`,
  })}`;
}
