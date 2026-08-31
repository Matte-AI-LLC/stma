// Concurrency probe: many agents on one team, all claiming overlapping scopes,
// while the live agent map is rendered repeatedly. The map recomputes conflicts
// in memory across every claim in every team the viewer belongs to, so this is
// where a quadratic cost would show up first. Deliberately modest — the target
// is a shared staging instance, not a victim.
//
//   node scripts/load-probe.mjs <baseUrl> [agents] [heartbeats]
//
// Baseline against the staging instance (single replica, Burstable B1ms
// Postgres), 2026-08-22 — every agent firing at the same instant, which is
// harsher than real teams but the shape a CI fleet would have:
//
//   15 agents:  run start p50 1.0s · heartbeat p50 0.26s · map 99ms · 0 errors
//   40 agents:  run start p50 2.4s · heartbeat p50 1.2s  · map 170ms · 0 errors
//
// The read path holds up — the live agent map recomputes every conflict on each
// render and still answered in 170ms with 40 runs and ~140 claims. The write
// path is what queues, and the server-side percentiles on /admin/ops match the
// client numbers, so it is the database and not the network. Re-measure here
// before changing replica count or database tier.

const base = (process.argv[2] ?? '').replace(/\/$/, '');
const AGENTS = Number(process.argv[3] ?? 15);
const BEATS = Number(process.argv[4] ?? 4);
if (!base) throw new Error('usage: node load-probe.mjs <baseUrl> [agents] [heartbeats]');

const stamp = Date.now().toString(36);
const email = `load-${stamp}@test-company.dev`;
const password = `load-${stamp}-pw`;
let cookie = '';
let token = '';

const timings = new Map();
function record(label, ms, ok) {
  const t = timings.get(label) ?? { ms: [], errors: 0 };
  t.ms.push(ms);
  if (!ok) t.errors += 1;
  timings.set(label, t);
}
async function timed(label, fn) {
  const started = performance.now();
  let ok = true;
  try {
    return await fn();
  } catch (error) {
    ok = false;
    throw error;
  } finally {
    record(label, performance.now() - started, ok);
  }
}
const pct = (arr, p) => {
  const sorted = [...arr].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] ?? 0);
};

async function form(path, body) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: base,
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const kv = line.split(';')[0];
    if (kv.startsWith('sid=')) cookie = kv;
  }
  return res;
}

const api = async (path, body, method = 'POST') => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(json).slice(0, 160)}`);
  return json;
};

// ---- setup ------------------------------------------------------------------
const signup = await form('/auth/local/signup', { email, password });
if (signup.status !== 302) throw new Error(`signup: ${signup.status}`);
await form('/app/teams', { name: `Load ${stamp}` });
const team = `load-${stamp}`;
const tokRes = await fetch(`${base}/app/tokens`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, cookie },
  body: new URLSearchParams({ name: 'load-probe' }),
});
token = /stma_[0-9a-f]{40}/.exec(await tokRes.text())?.[0] ?? '';
if (!token) throw new Error('no token');
console.log(`team ${team} · ${AGENTS} agents · ${BEATS} heartbeats each\n`);

// ---- run --------------------------------------------------------------------
const mapSamples = [];
const renderMap = async (phase) => {
  const started = performance.now();
  const res = await fetch(`${base}/app/agents`, { headers: { cookie } });
  const body = await res.text();
  const ms = Math.round(performance.now() - started);
  mapSamples.push({ phase, ms, criticals: (body.match(/pill-danger">critical/g) ?? []).length });
  return ms;
};

console.log(`agent map, empty: ${await renderMap('empty')} ms`);

const agents = await Promise.all(
  Array.from({ length: AGENTS }, async (_, i) => {
    const { installation } = await timed('register', () =>
      api('/api/agent/installations/register', {
        name: `load-agent-${i}`,
        clientType: 'generic',
        deviceFingerprint: `load-${stamp}-${i}-fingerprint`,
      }),
    );
    return { i, installationId: installation.id };
  }),
);

const runs = await Promise.all(
  agents.map(async ({ i, installationId }) => {
    // Half collide on one migration, half spread across their own paths, so the
    // matrix has hot and cold regions. Several claims each, so the conflict matrix has real width — the map
    // compares every live claim against every other.
    const claims =
      i % 2 === 0
        ? [
            { resourceType: 'migration', resourceKey: 'payments-db', access: 'write' },
            { resourceType: 'path', resourceKey: 'db/migrations/**', access: 'write' },
            { resourceType: 'contract', resourceKey: 'payments-openapi', access: 'write' },
            { resourceType: 'path', resourceKey: `src/shared/mod-${i % 5}/**`, access: 'write' },
          ]
        : [
            { resourceType: 'path', resourceKey: `src/mod-${i}/**`, access: 'write' },
            { resourceType: 'config', resourceKey: `svc-${i % 7}`, access: 'write' },
            { resourceType: 'path', resourceKey: `src/shared/mod-${i % 5}/**`, access: 'read' },
          ];
    const started = await timed('run start', () =>
      api('/api/agent/runs/start', {
        installationId,
        team,
        project: 'payments-api',
        taskKey: `LOAD-${i}`,
        claims,
      }),
    );
    return started.run.id;
  }),
);
console.log(`agent map, ${runs.length} live runs: ${await renderMap('loaded')} ms`);

for (let beat = 0; beat < BEATS; beat++) {
  await Promise.all(
    runs.map((runId) =>
      timed('heartbeat', () => api(`/api/agent/runs/${runId}/heartbeat`, { status: 'active' })),
    ),
  );
  await renderMap(`beat ${beat + 1}`);
}

await Promise.all(
  runs.map((runId) => timed('finish', () => api(`/api/agent/runs/${runId}/finish`, {}))),
);
console.log(`agent map, after finish: ${await renderMap('finished')} ms\n`);

// ---- report -----------------------------------------------------------------
console.log('endpoint          n     p50     p95     max   errors');
for (const [label, t] of timings) {
  console.log(
    `${label.padEnd(16)} ${String(t.ms.length).padStart(3)}  ${String(pct(t.ms, 50)).padStart(5)}ms ${String(pct(t.ms, 95)).padStart(5)}ms ${String(Math.round(Math.max(...t.ms))).padStart(5)}ms  ${String(t.errors).padStart(5)}`,
  );
}
console.log('\nagent map render');
for (const s of mapSamples) {
  console.log(`  ${s.phase.padEnd(12)} ${String(s.ms).padStart(5)}ms  ${s.criticals} critical`);
}

const errors = [...timings.values()].reduce((n, t) => n + t.errors, 0);
console.log(`\ntotal errors: ${errors}`);
