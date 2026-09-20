import { describe, expect, it } from 'vitest';
import { canonicalProjectName, snapshotsShareProject } from '../src/lib/projects';

describe('canonical repository identity', () => {
  it('retains host, owner and repository while converging transport aliases', () => {
    const aliases = [
      'https://GitHub.com/Acme/API.git/',
      'http://github.com/acme/api',
      'ssh://git@github.com:22/ACME/API.git',
      'git@GITHUB.COM:Acme/API.git/',
      'git://github.com/acme/api.git',
    ];
    expect(aliases.map(canonicalProjectName)).toEqual(
      aliases.map(() => 'github.com/acme/api'),
    );
  });

  it('gives an identity back unchanged, port included', () => {
    // A stored identity is canonicalized again wherever it is compared. With a
    // port in it the second pass used to read "host:8443/team/repo" as scp
    // syntax and answer "host/8443/team/repo".
    const remotes = [
      'https://git.corp.example:8443/Team/Ledger.git',
      'ssh://git@bitbucket.corp.example:7999/PAY/ledger.git',
      'git://127.0.0.1:9419/stma-lab/parcel-desk-agent-lab.git',
      'http://[::1]:3000/acme/api.git',
      'https://github.com/acme/api.git',
      'git@github.com:acme/api.git',
      'acme/api',
      'api',
    ];
    for (const remote of remotes) {
      const once = canonicalProjectName(remote);
      expect(canonicalProjectName(once), remote).toBe(once);
    }
    expect(canonicalProjectName('https://git.corp.example:8443/Team/Ledger.git')).toBe('git.corp.example:8443/team/ledger');
    expect(canonicalProjectName('ssh://git@bitbucket.corp.example:7999/PAY/ledger.git')).toBe('bitbucket.corp.example:7999/pay/ledger');
    // A user makes it scp syntax, where what follows the colon is a path.
    expect(canonicalProjectName('git@host.example:2024/archive.git')).toBe('host.example/2024/archive');
  });

  it('does not merge different owners or guess a bare legacy basename', () => {
    expect(canonicalProjectName('acme/api')).toBe('acme/api');
    expect(canonicalProjectName('other/api')).toBe('other/api');
    expect(canonicalProjectName('acme/api')).not.toBe(canonicalProjectName('other/api'));
    expect(canonicalProjectName('api')).toBe('api');
    expect(canonicalProjectName('api')).not.toBe(
      canonicalProjectName('https://github.com/acme/api.git'),
    );
  });

  it('uses the same identity fallback for legacy snapshots without project ids', () => {
    expect(
      snapshotsShareProject(
        { projectId: null, repo: 'git@github.com:acme/api.git' },
        { projectId: null, repo: 'https://GITHUB.com/ACME/API/' },
      ),
    ).toBe(true);
    expect(
      snapshotsShareProject(
        { projectId: null, repo: 'https://github.com/acme/api' },
        { projectId: null, repo: 'https://github.com/other/api' },
      ),
    ).toBe(false);
    expect(
      snapshotsShareProject(
        { projectId: null, repo: 'api' },
        { projectId: null, repo: 'https://github.com/acme/api' },
      ),
    ).toBe(false);
  });
});
