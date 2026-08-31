/**
 * Server-side secret scrubbing (defense in depth — agents are instructed not to
 * send secrets in the first place). Applied to message bodies and attachments
 * before they are stored.
 */
export function redactSecrets(text: string): string {
  return (
    text
      // Well-known token shapes (incl. our own PATs)
      .replace(
        /\b(?:stma_[0-9a-f]{40}|sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
        '[REDACTED]',
      )
      // key=value / key: value pairs for sensitive-looking keys
      .replace(
        /((?:api[_-]?key|secret|token|passw(?:or)?d|authorization|bearer)["']?\s*[:=]\s*["']?)([^\s"']{4,})/gi,
        '$1[REDACTED]',
      )
  );
}
