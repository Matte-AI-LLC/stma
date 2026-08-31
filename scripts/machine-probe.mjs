#!/usr/bin/env node
// Collects a real environment snapshot from the machine it runs on and drives one
// agent lifecycle against a live STMA instance. This is what an agent following
// get_snapshot_checklist actually does, so running it on genuinely different
// machines is the only way to prove the cross-machine promise end to end.
//
//   STMA_URL=... STMA_TOKEN=... node scripts/machine-probe.mjs --team <slug> \
//     --device <label> [--project payments-api] [--claim migration:payments-db:write]
//     [--heartbeats 3] [--interval 15]
//
// Nothing here reads a secret value: env vars contribute names only.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const base = (process.env.STMA_URL ?? '').replace(/\/$/, '');
const token = process.env.STMA_TOKEN ?? '';
const team = flag('team');
const device = flag('device');
const project = flag('project', 'payments-api');
const claimSpec = flag('claim');
const heartbeats = Number(flag('heartbeats', '0'));
const interval = Number(flag('interval', '15'));

if (!base || !token || !team || !device) {
  console.error('need STMA_URL, STMA_TOKEN, --team and --device');
  process.exit(2);
}

const sh = (cmd, cmdArgs) => {
  try {
    return execFileSync(cmd, cmdArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
};

/** git's own blob id, computed without shelling out so every platform agrees. */
const gitBlobHash = (file) => {
  const buf = readFileSync(file);
  const h = createHash('sha1');
  h.update(`blob ${buf.length}\0`);
  h.update(buf);
  return h.digest('hex');
};

// ---- collect ---------------------------------------------------------------

const lockfiles = [];
for (const path of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) {
  if (existsSync(path)) lockfiles.push({ path, hash: gitBlobHash(path) });
}

const runtimes = {};
const nodeVersion = process.version.replace(/^v/, '');
runtimes.node = nodeVersion;
for (const [name, cmd, cmdArgs] of [
  ['python', 'python3', ['--version']],
  ['go', 'go', ['version']],
]) {
  const out = sh(cmd, cmdArgs);
  const match = out && /(\d+\.\d+(\.\d+)?)/.exec(out);
  if (match) runtimes[name] = match[1];
}

const packageManagers = {};
const npmVersion = sh('npm', ['--version']);
if (npmVersion) packageManagers.npm = npmVersion;

// Names only — never values. Drop the noisy per-run CI keys so a cross-machine
// diff shows real differences instead of runner bookkeeping.
const envVarNames = Object.keys(process.env)
  .filter((name) => !/^(GITHUB_|RUNNER_|ACTIONS_|INPUT_|STMA_)/.test(name))
  .sort()
  .slice(0, 400);

const snapshot = {
  os: { platform: os.platform(), arch: os.arch(), release: os.release() },
  shell: process.env.SHELL ?? process.env.ComSpec ?? undefined,
  runtimes,
  packageManagers,
  lockfiles,
  envVarNames,
  git: {
    branch: sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']),
    sha: sh('git', ['rev-parse', 'HEAD']),
    dirtyFiles: (sh('git', ['status', '--porcelain']) ?? '')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(3))
      .slice(0, 100),
  },
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  collectedAt: new Date().toISOString(),
};

console.log(
  `[${device}] ${snapshot.os.platform}/${snapshot.os.arch} node ${nodeVersion}` +
    ` · ${lockfiles.length} lockfile(s) · ${envVarNames.length} env names`,
);

// ---- talk to the instance ---------------------------------------------------

let rpcId = 1;
async function tool(name, toolArgs) {
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
      params: { name, arguments: toolArgs },
    }),
  });
  const json = await res.json();
  const text = json?.result?.content?.[0]?.text ?? JSON.stringify(json);
  if (json?.result?.isError) throw new Error(`${name} failed: ${text}`);
  return text;
}

const api = async (path, body, method = 'POST') => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
};

await tool('push_snapshot', { team, repo: project, device, snapshot });
console.log(`[${device}] snapshot pushed`);

if (claimSpec) {
  const [resourceType, resourceKey, access] = claimSpec.split(':');
  const { installation } = await api('/api/agent/installations/register', {
    name: `probe-${device}`,
    clientType: 'generic',
    clientVersion: 'machine-probe',
    deviceFingerprint: createHash('sha256').update(`${device}\0${team}`).digest('hex').slice(0, 32),
    capabilities: ['claims', 'preflight'],
  });
  const started = await api('/api/agent/runs/start', {
    installationId: installation.id,
    team,
    project,
    taskKey: flag('task', 'LAB-1'),
    intent: `cross-platform probe from ${device}`,
    claims: [{ resourceType, resourceKey, access: access ?? 'write' }],
  });
  const runId = started.run.id;
  const conflicts = started.conflicts ?? [];
  console.log(
    `[${device}] run ${runId} claiming ${claimSpec}` +
      (conflicts.length ? ` — ${conflicts.length} conflict(s) already` : ' — first in'),
  );

  const preflight = await api('/api/agent/environment/preflight', { team, project, snapshot });
  console.log(`[${device}] preflight: ${preflight.status}`);

  // Hold the scope open so the other machines overlap with it in real time.
  for (let i = 0; i < heartbeats; i++) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    const beat = await api(`/api/agent/runs/${runId}/heartbeat`, { status: 'active' });
    console.log(
      `[${device}] heartbeat ${i + 1}/${heartbeats}` +
        ` — ${(beat.conflicts ?? []).length} conflict(s) live`,
    );
  }
}

console.log(`[${device}] done`);
