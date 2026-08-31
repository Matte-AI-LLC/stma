// Creates the throwaway org the multi-machine lab runs against: an account, a
// team, a personal token, a project policy and an environment baseline. The
// baseline deliberately records a lockfile hash that no runner will match, so
// preflight has something true to say on every machine.

import { base, form, jar, labIdentity, mask, mintToken, output } from './lab-common.mjs';

const { team, email, password } = labIdentity();
mask(password);
const stamp = team.replace(/^lab-/, '');

const session = jar();

const signup = await form(session, '/auth/local/signup', { email, password });
if (signup.status !== 302) {
  throw new Error(
    `signup failed (${signup.status}) — staging needs SIGNUPS_OPEN=1: ${await signup.text()}`,
  );
}

const created = await form(session, '/app/teams', { name: `Lab ${stamp}` });
if (created.status !== 302) throw new Error(`team create failed: ${created.status}`);

const token = await mintToken(session, 'lab-bootstrap');

const api = async (path, body) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
};

await api('/api/control/policies', {
  team,
  project: 'payments-api',
  document: {
    guidance: ['Keep migrations backwards compatible.'],
    permissions: { deny: ['read secret values'], requireApproval: ['production changes'] },
    requiredChecks: ['npm test'],
    protectedPaths: ['db/migrations/**'],
    environment: { requiredEnvVarNames: ['PATH'], runtimes: { node: '22.14.0' } },
  },
});

// A hash no runner can reproduce: preflight must react to the lockfile it
// records, and stay quiet about the ones it does not.
await api('/api/control/environment-baselines', {
  team,
  project: 'payments-api',
  snapshot: {
    os: { platform: 'linux', arch: 'x64' },
    runtimes: { node: '22.14.0' },
    packageManagers: { npm: '11.0.0' },
    lockfiles: [{ path: 'package-lock.json', hash: 'baseline0000000000000000000000000000lab' }],
    envVarNames: ['PATH', 'HOME'],
    git: { branch: 'main', sha: 'lab-baseline', dirtyFiles: [] },
    timezone: 'Europe/Istanbul',
  },
});

output('team', team);

console.log(`provisioned team ${team} for ${email}`);
