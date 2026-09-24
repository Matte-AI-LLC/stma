import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * What each tool does to the world, in the words MCP clients read (2026-09-24).
 *
 * Claude's connector directory refuses a tool that has no title and no
 * `readOnlyHint` or `destructiveHint`, and the hosted Claude apps act on them: a
 * read-only tool runs without asking, a destructive one asks every time. Claude
 * Code does not use them for permissions, so nothing here changes what a coding
 * agent in a connected checkout is asked.
 *
 * The rule is Anthropic's sentence taken literally, "destructiveHint: true for
 * tools that modify or delete data": every tool that writes is marked destructive.
 * In STMA a write is something a teammate sees (a message, a claim, an
 * assignment, a snapshot another machine is compared against), and asking first
 * is the right default for that in a chat. MCP's own reading, where an additive
 * write is not destructive, would let a chat post to the whole team unasked.
 * Bookkeeping a read leaves behind (a thread's read marker, a Knowledge context
 * manifest, a pending credential's confirmation) does not make a tool a write.
 *
 * `openWorldHint` says whether the tool reaches a system outside STMA: a tracker
 * read or comment, a team webhook, an email. MCP defaults it to true, so every
 * entry states it. `idempotentHint` is set only where a repeat is answered as a
 * replay by construction.
 *
 * A tool cannot register without an entry and a title: `requireAnnotations`
 * throws when the server is built, and layers.test.ts holds these keys to the
 * pinned tool list.
 */
export type ToolHints =
  | { readOnlyHint: true; openWorldHint: boolean }
  | { readOnlyHint: false; destructiveHint: true; openWorldHint: boolean; idempotentHint?: true };

const read = (openWorld = false): ToolHints => ({ readOnlyHint: true, openWorldHint: openWorld });
const write = (openWorld = false, idempotent = false): ToolHints => ({
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: openWorld,
  ...(idempotent ? { idempotentHint: true as const } : {}),
});

export const TOOL_ANNOTATIONS: Readonly<Record<string, ToolHints>> = {
  // identity and projects
  whoami: read(),
  list_teammates: read(),
  list_projects: read(),
  onboard_repo: read(),
  create_invite: write(),
  // snapshots and environment
  get_snapshot_checklist: read(),
  push_snapshot: write(),
  get_snapshot: read(),
  compare_env: read(),
  check_environment: write(),
  // sessions: opening, posting, resolving and announcing reach the team's
  // webhook and its members' email
  list_sessions: read(),
  get_session: read(),
  inbox: read(),
  search_past_issues: read(),
  open_session: write(true),
  post_message: write(true),
  resolve_session: write(true),
  announce: write(true),
  // fleet: start_run reads the task from GitHub, Jira or ClickUp, finishing
  // comments on it, and a handoff or an assignment notifies people
  start_run: write(true),
  update_run: write(),
  finish_run: write(true),
  list_active_agents: read(),
  get_policy: read(),
  get_workflow: read(),
  get_evidence: read(),
  list_issues: read(true),
  list_clickup_tasks: read(true),
  handoff_work: write(true),
  assign_work: write(true),
  update_handoff: write(false, true),
  launch_check: write(false, true),
  record_delivery_receipt: write(),
  // knowledge hub
  get_knowledge_context: read(),
  search_knowledge: read(),
  get_knowledge: read(),
  report_knowledge_receipt: write(),
  propose_knowledge: write(),
};

/**
 * Makes every later `registerTool` on this server carry its entry above, and
 * refuse to register without one. Called once, right after the server is made,
 * so the core, fleet and Knowledge modules need not remember it.
 */
export function requireAnnotations(server: McpServer): void {
  const register = server.registerTool.bind(server) as (
    name: string,
    config: { title?: string; annotations?: Record<string, unknown> },
    callback: unknown,
  ) => ReturnType<McpServer['registerTool']>;
  server.registerTool = ((name: string, config: { title?: string; annotations?: Record<string, unknown> }, callback: unknown) => {
    const hints = TOOL_ANNOTATIONS[name];
    if (!hints) {
      throw new Error(`MCP tool "${name}" has no entry in mcp/annotations.ts. Say what it does to the world before it can register.`);
    }
    if (!config.title) throw new Error(`MCP tool "${name}" has no title.`);
    return register(name, { ...config, annotations: { title: config.title, ...hints, ...config.annotations } }, callback);
  }) as McpServer['registerTool'];
}
