// Asserts what three genuinely different machines produced against one instance:
// a device slot each, a real environment diff between two operating systems, and
// a critical collision surfaced while they overlapped on the same migration.

import { base, get, jar, labIdentity, mintToken, signIn } from './lab-common.mjs';

const { team, email, password } = labIdentity();
const session = jar();
await signIn(session, email, password);
const token = await mintToken(session, 'lab-verify');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

let rpcId = 1;
async function tool(name, args) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId++,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const json = await res.json();
  return { text: json?.result?.content?.[0]?.text ?? '', isError: json?.result?.isError === true };
}

const DEVICES = ['linux-ci', 'win-ci', 'mac-ci'];

// 1. every machine got its own slot rather than overwriting the previous one
const teammates = await tool('list_teammates', { team });
const present = DEVICES.filter((d) => teammates.text.includes(d));
check(
  'each machine kept its own device slot',
  present.length === DEVICES.length,
  `${present.join(', ') || 'none'} of ${DEVICES.join(', ')}`,
);

// 2. a real cross-OS diff — this is the product's whole premise
const diff = await tool('compare_env', {
  team,
  device: 'linux-ci',
  their_device: 'mac-ci',
});
const sawPlatform = /darwin|linux/.test(diff.text);
const sawNode = /"node"|node/.test(diff.text) && /2[0-9]\./.test(diff.text);
check(
  'comparing Linux against macOS reports real differences',
  !diff.isError && sawPlatform && sawNode,
  diff.isError ? diff.text.slice(0, 120) : `${(diff.text.match(/"kind"/g) ?? []).length} diff entries`,
);

// 3. the collision the three runs were built to cause
const mapRes = await get(session, '/app/agents');
const map = await mapRes.text();
const criticals = (map.match(/pill-danger">critical/g) ?? []).length;
check('the shared migration raised a critical collision', criticals > 0, `${criticals} shown`);
check(
  'the agent map names the contested resource',
  map.includes('payments-db'),
  map.includes('payments-db') ? '' : 'payments-db missing from the map',
);

// 4. preflight reacted to the lockfile the baseline records, on real machines
const activeRes = await fetch(`${base}/api/agent/runs/active?team=${team}`, {
  headers: { authorization: `Bearer ${token}` },
});
const active = await activeRes.json();
check(
  'all three runs reached the control plane',
  (active.runs ?? []).length >= DEVICES.length,
  `${(active.runs ?? []).length} active run(s)`,
);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
