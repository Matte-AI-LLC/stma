import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { WorkClaim } from '@bridge/shared';

/** One client-supplied file name → a checkout-relative path, or a refusal. */
function checkoutRelativePath(root: string, canonicalRoot: string, name: string): string {
  if (/[\0\r\n*?\[\]]/.test(name)) throw new Error('unsupported_path');
  const lexicalRoot = path.resolve(root);
  const inputPath = path.isAbsolute(name) && name.startsWith(lexicalRoot + path.sep)
    ? path.relative(lexicalRoot, name) : name;
  let file = path.resolve(canonicalRoot, inputPath);
  // macOS reports /private/var from cwd but clients may send /var paths.
  // Resolve an external parent alias without following the final file itself.
  if (path.isAbsolute(inputPath) && !file.startsWith(canonicalRoot + path.sep)) {
    let ancestor = path.dirname(file);
    const tail = [path.basename(file)];
    while (true) {
      try { file = path.join(realpathSync(ancestor), ...tail); break; }
      catch (error: any) {
        if (error.code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw error;
        tail.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor);
      }
    }
  }
  const relative = path.relative(canonicalRoot, file).replaceAll('\\', '/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('outside_checkout');
  if (/^(?:\.git|\.stma|\.codex|\.claude|\.cursor)(?:\/|$)/i.test(relative)) throw new Error('coordination_config_requires_owner');
  let current = file;
  while (current !== canonicalRoot) {
    try {
      const state = lstatSync(current);
      if (state.isSymbolicLink() || (state.isFile() && state.nlink !== 1)) throw new Error('aliased_path');
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    current = path.dirname(current);
  }
  return relative;
}

/** Extract only paths. File contents, patches, tool responses and prompt bodies
 * must never enter the durable hook outbox or the coordination request. */
export function fileToolClaims(root: string, payload: Record<string, unknown>): WorkClaim[] {
  const input = payload.tool_input as Record<string, unknown> | undefined;
  const name = payload.tool_name;
  let names: string[] = [];
  if (name === 'apply_patch' && typeof input?.command === 'string') {
    names = [...input.command.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map((m) => m[1]!);
  } else if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(String(name))) {
    const file = input?.file_path ?? input?.notebook_path;
    if (typeof file === 'string') names = [file];
  }
  if (!names.length || names.length > 200) throw new Error('unrecognized_file_operation');
  const canonicalRoot = realpathSync(root);
  return [...new Set(names.map((name) => checkoutRelativePath(root, canonicalRoot, name)))]
    .map((resourceKey) => ({ resourceType: 'path', resourceKey, access: 'write' }));
}

/** A bound on what one edit can make the guard scan; a content rule is a literal, so this is linear. */
export const MAX_SCANNED_CHARS = 2_000_000;

/**
 * The text an edit would ADD, per file — for the local content-rule check and
 * for nothing else.
 *
 * This is the one place the guard looks at content, so the boundary is stated
 * where it can be read: the returned text is evaluated in this process against
 * the team's `content:` deny rules and then dropped. It is never written to the
 * outbox, never logged and never sent; a violation report carries the rule's
 * own published words and the file path, which the server already holds as a
 * claim. Only added text is collected, because removing a forbidden thing must
 * not be stopped by the rule that forbids it.
 */
export function fileToolAddedText(
  root: string,
  payload: Record<string, unknown>,
): Array<{ path: string; text: string }> {
  const input = payload.tool_input as Record<string, unknown> | undefined;
  const name = String(payload.tool_name);
  const canonicalRoot = realpathSync(root);
  const added = new Map<string, string[]>();
  const add = (file: unknown, text: unknown) => {
    if (typeof file !== 'string' || typeof text !== 'string' || text.length === 0) return;
    const key = checkoutRelativePath(root, canonicalRoot, file);
    added.set(key, [...(added.get(key) ?? []), text]);
  };
  if (name === 'apply_patch' && typeof input?.command === 'string') {
    let current: string | null = null;
    for (const line of input.command.split(/\r?\n/)) {
      const header = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
      if (header) {
        // A move lands its added lines at the destination; a delete adds nothing.
        current = header[1] === 'Delete File' ? null : header[2]!;
        continue;
      }
      if (current && line.startsWith('+') && !line.startsWith('+++')) add(current, line.slice(1));
    }
  } else if (name === 'Write') {
    add(input?.file_path, input?.content);
  } else if (name === 'Edit') {
    add(input?.file_path, input?.new_string);
  } else if (name === 'MultiEdit') {
    for (const edit of Array.isArray(input?.edits) ? input.edits : []) {
      add(input?.file_path, (edit as Record<string, unknown> | null)?.new_string);
    }
  } else if (name === 'NotebookEdit') {
    add(input?.notebook_path, input?.new_source);
  }
  return [...added].map(([file, parts]) => ({
    path: file,
    text: parts.join('\n').slice(0, MAX_SCANNED_CHARS),
  }));
}

/** A bound on one scan: a run that rewrote a lockfile must not stall a finish. */
export const MAX_SCANNED_FILES = 400;

/**
 * What this run actually put in the checkout, per file, as added text.
 *
 * The guard above sees one edit at a time, through the file tools of a client
 * that has the hook installed. A shell redirect, an MCP-only agent, an editor,
 * `git apply`, a generator — none of it passes through there, and the
 * governance page could only ever say what was *stopped*. That is an honest
 * limit and it was written down, but it left a lead unable to answer the one
 * question a content rule exists for: is the forbidden thing in the branch.
 *
 * So this asks git, once, at the end of the run. Same boundary as the guard:
 * the text is evaluated in this process and dropped, and only the rule's own
 * published words and the file path are ever reported. Added lines only,
 * because removing a forbidden thing must not be reported as adding it, and a
 * renamed file's content moving is not new content.
 *
 * `since` is the commit the run started from, so the answer is this run's work
 * rather than the whole branch's history. Committed and uncommitted changes
 * both count — what is in the checkout is what the next person sees — and so
 * do new untracked files, which is where a generator's output usually lands.
 */
export function checkoutAddedText(
  root: string,
  since: string,
  run: (args: string[]) => string,
): Array<{ path: string; text: string }> {
  if (!/^[0-9a-f]{7,40}$/i.test(since)) return [];
  const added = new Map<string, string[]>();
  const push = (file: string, text: string) => {
    if (!text) return;
    const key = file.replaceAll('\\', '/');
    if (added.size >= MAX_SCANNED_FILES && !added.has(key)) return;
    added.set(key, [...(added.get(key) ?? []), text]);
  };

  // One diff covering commits and the working tree: `git diff <since>` with no
  // second revision compares that commit against what is on disk now.
  let file: string | null = null;
  for (const line of run(['diff', '--unified=0', '--no-color', '--no-ext-diff', since]).split(/\r?\n/)) {
    const header = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (header) {
      file = header[1] === '/dev/null' ? null : header[1]!;
      continue;
    }
    if (file && line.startsWith('+') && !line.startsWith('+++')) push(file, line.slice(1));
  }

  // Untracked files are not in any diff, and a file a generator wrote is the
  // case this whole function exists for.
  for (const name of run(['ls-files', '--others', '--exclude-standard', '-z']).split('\0')) {
    if (!name) continue;
    try {
      const body = readFileSync(path.join(root, name), 'utf8');
      push(name, body.slice(0, MAX_SCANNED_CHARS));
    } catch {
      // Unreadable, binary, gone since the listing: not this function's problem.
    }
  }

  return [...added].map(([file, parts]) => ({
    path: file,
    text: parts.join('\n').slice(0, MAX_SCANNED_CHARS),
  }));
}

export function hookSessionIdentity(payload: Record<string, unknown>): string {
  for (const key of ['session_id', 'conversation_id', 'conversationId', 'thread_id', 'threadId']) {
    const id = payload[key];
    if (typeof id === 'string' && id.length > 0 && id.length <= 300) {
      // Only distinguish child agents when the client actually supplies the id.
      return JSON.stringify([id, typeof payload.agent_id === 'string' ? payload.agent_id : null]);
    }
  }
  throw new Error('Client did not report a session identity; tracking is unavailable.');
}

export function retainedHookPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(['session_id', 'conversation_id', 'conversationId', 'thread_id', 'threadId', 'agent_id', 'hook_event_name']
    .filter((key) => typeof payload[key] === 'string' && (payload[key] as string).length <= 300)
    .map((key) => [key, payload[key]]));
}

export function nativeHookContext(target: string, event: string, notice: string): Record<string, unknown> {
  if (target === 'cursor') return { continue: true, user_message: notice };
  if (event === 'UserPromptSubmit' || event === 'PostToolUse') return { hookSpecificOutput: { hookEventName: event, additionalContext: notice } };
  return { systemMessage: notice };
}
