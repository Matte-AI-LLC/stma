// One machine's turn in the lab: sign in as the run's throwaway owner, mint a
// token named after this machine (one token per machine is what the product
// tells people to do), then hand off to the probe that does the real work.

import { spawnSync } from 'node:child_process';
import { base, jar, labIdentity, mintToken, signIn } from './lab-common.mjs';

const device = process.argv[2];
if (!device) throw new Error('usage: node scripts/lab-machine.mjs <device> [probe args…]');

const { team, email, password } = labIdentity();
const session = jar();
await signIn(session, email, password);
const token = await mintToken(session, device);

const result = spawnSync(
  process.execPath,
  [
    'scripts/machine-probe.mjs',
    '--team', team,
    '--device', device,
    ...process.argv.slice(3),
  ],
  { stdio: 'inherit', env: { ...process.env, STMA_URL: base, STMA_TOKEN: token } },
);
process.exit(result.status ?? 1);
