const REMOTE_PROTOCOLS = new Set([
  'git:',
  'git+http:',
  'git+https:',
  'git+ssh:',
  'http:',
  'https:',
  'ssh:',
]);

export function normalizeRepositoryPath(raw: string): string {
  return raw
    .replaceAll('\\', '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\.git$/i, '')
    .replace(/\/+$/g, '')
    .toLowerCase();
}

export function urlRepositoryIdentity(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!REMOTE_PROTOCOLS.has(url.protocol)) return null;
    const path = normalizeRepositoryPath(url.pathname);
    if (!url.hostname || !path) return null;
    // URL already removes standard HTTP(S) ports. Do the equivalent for the
    // standard SSH port so ssh://host:22/x and git@host:x are aliases.
    const port = url.protocol === 'ssh:' && url.port === '22' ? '' : url.port;
    return `${url.hostname.toLowerCase()}${port ? `:${port}` : ''}/${path}`;
  } catch {
    return null;
  }
}

export function scpRepositoryIdentity(raw: string): string | null {
  // Do not mistake a Windows drive path for git's user@host:path spelling.
  if (/^[a-z]:[\\/]/i.test(raw)) return null;
  // An identity this module already produced for a remote on its own port —
  // host:port/path, no scheme, no user — must come back unchanged. Read as scp
  // syntax it would turn the port into a directory (host/8443/path), and a
  // stored identity would stop matching the remote it was made from: every run
  // start in a project bound to such a remote was refused as the wrong
  // repository. A real scp path whose first directory is all digits and that
  // names no user is the rarer reading, and it still converges with itself.
  const ported = /^(\[[^\]]+\]|[^@:/\s]+):(\d{1,5})\/(.+)$/.exec(raw);
  if (ported) {
    const portedPath = normalizeRepositoryPath(ported[3]!);
    return portedPath ? `${ported[1]!.toLowerCase()}:${ported[2]}/${portedPath}` : null;
  }
  const match = /^(?:[^@/\s]+@)?(\[[^\]]+\]|[^:/\s]+):(.+)$/.exec(raw);
  if (!match) return null;
  const path = normalizeRepositoryPath(match[2]!);
  return path ? `${match[1]!.toLowerCase()}/${path}` : null;
}

/**
 * Stable repository identity used by legacy project resolution.
 *
 * Network remotes retain host/owner/repository while transport-only spelling
 * differences disappear. Thus HTTPS, SSH URL and SCP syntax for one remote
 * converge, but github.com/acme/api and github.com/other/api never collapse to
 * the same basename. A hostless owner/repository value retains both segments.
 * A historical bare value such as `api` deliberately stays `api`: without a
 * verified provider binding there is no evidence that it belongs to any one
 * host or owner, so existing evidence is never silently relabelled.
 */
export function canonicalRepositoryIdentity(raw: string): string {
  const value = raw.trim();
  if (!value) return value;
  return (
    urlRepositoryIdentity(value) ??
    scpRepositoryIdentity(value) ??
    normalizeRepositoryPath(value)
  );
}
