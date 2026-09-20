/**
 * Server-side secret scrubbing (defense in depth — agents are instructed not to
 * send secrets in the first place). Applied to message bodies, attachments,
 * errors and the final structured-log serialization.
 */
export function redactSecrets(text: string): string {
  return (
    text
      // STMA activation codes and join links are credentials too. The generated
      // prompts carry them once, but a pasted session/error must not retain them.
      .replace(/\bstma_enroll_[0-9a-f]{40}\b/gi, '[REDACTED]')
      .replace(/(\/join\/)[A-Za-z0-9_-]{12}(?=$|[^A-Za-z0-9_-])/g, '$1[REDACTED]')
      .replace(
        /(STMA_(?:ENROLLMENT|INVITE)_CODE["']?\s*[:=]\s*["']?)[A-Za-z0-9_-]{8,}/gi,
        '$1[REDACTED]',
      )
      // Well-known token shapes (incl. our own PATs)
      .replace(
        /\b(?:stma_[0-9a-f]{40}|sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
        '[REDACTED]',
      )
      // JSON/log fragments may carry escaped quotes or backslashes inside a
      // quoted value. Consume the complete quoted scalar before the generic
      // unquoted fallback so a suffix cannot survive the first escaped quote.
      .replace(
        /((?:api[_-]?key|secret|token|passw(?:or)?d|authorization|bearer|(?:invite|enrollment)[_-]?code)["']?\s*[:=]\s*)"(?:\\.|[^"\\])*"/gi,
        '$1"[REDACTED]"',
      )
      .replace(
        /((?:api[_-]?key|secret|token|passw(?:or)?d|authorization|bearer|(?:invite|enrollment)[_-]?code)["']?\s*[:=]\s*)'(?:\\.|[^'\\])*'/gi,
        "$1'[REDACTED]'",
      )
      // Unquoted headers/log pairs can contain an auth scheme or whitespace
      // inside the secret. Once a sensitive key begins, mask the rest of that
      // line rather than leaking a suffix after the first word.
      .replace(
        /(\b(?:api[_-]?key|secret|token|passw(?:or)?d|authorization|bearer|(?:invite|enrollment)[_-]?code)["']?\s*[:=]\s*)(?!["']|\[REDACTED\])[^\r\n]+/gi,
        '$1[REDACTED]',
      )
  );
}
