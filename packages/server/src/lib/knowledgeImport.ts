import {
  KNOWLEDGE_IMPORT_MAX_BYTES,
  KNOWLEDGE_IMPORT_MAX_FILES,
  KNOWLEDGE_ITEM_MAX_BYTES,
} from '@bridge/shared';
import { redactSecrets } from './redact';

export interface KnowledgeImportCandidate {
  path: string;
  content: string | Uint8Array;
  /** The selecting client must resolve links and disclose this fact. */
  symlink?: boolean;
  mediaType?: string;
}
export interface ValidatedKnowledgeImport {
  path: string;
  text: string;
  byteSize: number;
  preview: string;
}

const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'txt']);
const TEXT_MEDIA_TYPES = new Set(['text/plain', 'text/markdown']);

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function safeRelativeTextPath(raw: string): string | null {
  const value = raw.trim();
  if (
    !value ||
    value.length > 500 ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.startsWith('//') ||
    /^[a-z][a-z0-9+.-]*:/i.test(value)
  ) {
    return null;
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  const extension = segments.at(-1)?.split('.').at(-1)?.toLowerCase();
  return extension && TEXT_EXTENSIONS.has(extension) ? value : null;
}

function looksBinary(text: string): boolean {
  if (text.includes('\0')) return true;
  let controls = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) controls += 1;
  }
  return controls > Math.max(2, Math.floor(text.length / 100));
}

/**
 * Validate bytes supplied by a selecting client. This function never opens a
 * path or URL: path selection/symlink resolution remains on the client side.
 */
export function validateKnowledgeImports(
  candidates: readonly KnowledgeImportCandidate[],
): { files: ValidatedKnowledgeImport[]; totalBytes: number } | { error: string } {
  if (candidates.length === 0) return { error: 'Select at least one text or Markdown file.' };
  if (candidates.length > KNOWLEDGE_IMPORT_MAX_FILES) {
    return { error: `Import accepts at most ${KNOWLEDGE_IMPORT_MAX_FILES} files per batch.` };
  }

  const files: ValidatedKnowledgeImport[] = [];
  let totalBytes = 0;
  for (const candidate of candidates) {
    const safePath = safeRelativeTextPath(candidate.path);
    if (!safePath) {
      return {
        error:
          `"${candidate.path}" is not an allowed relative .md, .markdown or .txt path. ` +
          'URLs, absolute paths, traversal and backslashes are rejected.',
      };
    }
    if (candidate.symlink) {
      return { error: `"${safePath}" is a symlink; select the resolved file explicitly.` };
    }
    if (candidate.mediaType && !TEXT_MEDIA_TYPES.has(candidate.mediaType.toLowerCase())) {
      return { error: `"${safePath}" is not UTF-8 text or Markdown.` };
    }

    let text: string;
    let bytes: Uint8Array;
    try {
      if (typeof candidate.content === 'string') {
        if (hasUnpairedSurrogate(candidate.content)) throw new TypeError('invalid unicode');
        text = candidate.content;
        bytes = encoder.encode(text);
      } else {
        bytes = candidate.content;
        text = decoder.decode(bytes);
      }
    } catch {
      return { error: `"${safePath}" is not valid UTF-8 text.` };
    }
    if (bytes.byteLength === 0) return { error: `"${safePath}" is empty.` };
    if (bytes.byteLength > KNOWLEDGE_ITEM_MAX_BYTES) {
      return {
        error: `"${safePath}" is ${bytes.byteLength} bytes; one item may be at most ${KNOWLEDGE_ITEM_MAX_BYTES} bytes.`,
      };
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > KNOWLEDGE_IMPORT_MAX_BYTES) {
      return {
        error: `Import is ${totalBytes} bytes; one batch may be at most ${KNOWLEDGE_IMPORT_MAX_BYTES} bytes.`,
      };
    }
    if (looksBinary(text)) return { error: `"${safePath}" looks like binary data, not text.` };
    if (redactSecrets(text) !== text) {
      return {
        error:
          `"${safePath}" looks like it contains a credential or secret and was not stored. ` +
          'Remove it and review the preview; this heuristic cannot guarantee finding every secret.',
      };
    }
    files.push({
      path: safePath,
      text,
      byteSize: bytes.byteLength,
      preview: text.slice(0, 2_000),
    });
  }
  return { files, totalBytes };
}

export function validateNativeKnowledgeBody(
  body: string,
): { text: string; byteSize: number } | { error: string } {
  if (hasUnpairedSurrogate(body)) return { error: 'Knowledge body is not valid UTF-8 text.' };
  const bytes = encoder.encode(body);
  if (bytes.byteLength === 0) return { error: 'Knowledge body cannot be empty.' };
  if (bytes.byteLength > KNOWLEDGE_ITEM_MAX_BYTES) {
    return {
      error: `Knowledge body is ${bytes.byteLength} bytes; the limit is ${KNOWLEDGE_ITEM_MAX_BYTES} bytes.`,
    };
  }
  if (looksBinary(body)) return { error: 'Knowledge body looks like binary data, not text.' };
  if (redactSecrets(body) !== body) {
    return {
      error:
        'Knowledge body looks like it contains a credential or secret and was not stored. Review and remove it first.',
    };
  }
  return { text: body, byteSize: bytes.byteLength };
}
