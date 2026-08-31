import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';

/**
 * Personal fleet: one human, many machines. Snapshots are keyed by
 * (team, user, device), so a MacBook and a Windows desktop coexist and can be
 * diffed against each other.
 */

let srv: StartedServer;
let dataDir: string;
let aliceToken: string;
let bobToken: string;
let aliceJar: ReturnType<typeof jar>;
const TEAM_PATH = '/app/teams/fleet-team';

function jar() {
  const cookies = new Map<string, string>();
  return {
    header(): Record<string, string> {
      return cookies.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {};
    },
    store(res: Response) {
      for (const line of res.headers.getSetCookie()) {
        const [kv] = line.split(';');
        const i = kv!.indexOf('=');
        cookies.set(kv!.slice(0, i), kv!.slice(i + 1));
      }
    },
  };
}

async function devLogin(username: string) {
  const j = jar();
  const res = await fetch(`${srv.url}/auth/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username }),
    redirect: 'manual',
  });
  j.store(res);
  expect(res.status).toBe(302);
  return j;
}

async function mintToken(j: ReturnType<typeof jar>, name: string) {
  const res = await fetch(`${srv.url}/app/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...j.header() },
    body: new URLSearchParams({ name }),
  });
  const pat = /stma_[0-9a-f]{40}/.exec(await res.text())?.[0];
  expect(pat).toBeTruthy();
  return pat!;
}

let rpcId = 1;
async function callTool(pat: string, name: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${pat}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId++,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  const json = (await res.json()) as any;
  return json.result as { isError?: boolean; content: Array<{ type: string; text: string }> };
}

const toolText = (r: { content: Array<{ text: string }> }): string => r.content[0]!.text;
const toolJson = (r: { content: Array<{ text: string }> }): any => JSON.parse(toolText(r));

const snapshotOf = (over: Record<string, unknown> = {}) => ({
  os: { platform: 'linux', arch: 'x64' },
  runtimes: { node: '24.1.0' },
  packageManagers: { npm: '11.0.0' },
  lockfiles: [{ path: 'package-lock.json', hash: 'aaa111' }],
  envVarNames: ['PATH', 'HOME', 'NVM_DIR'],
  git: { branch: 'main', sha: 'abc123', dirtyFiles: [] },
  timezone: 'Europe/Istanbul',
  ...over,
});

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'bridge-fleet-test-'));
  srv = await startServer(
    loadEnv({
      port: 0,
      host: 'localhost',
      nodeEnv: 'test',
      devMode: true,
      databaseUrl: undefined,
      pgliteDir: dataDir,
    }),
  );

  aliceJar = await devLogin('alice');
  const createRes = await fetch(`${srv.url}/app/teams`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...aliceJar.header() },
    body: new URLSearchParams({ name: 'Fleet Team' }),
    redirect: 'manual',
  });
  expect(createRes.headers.get('location')).toBe(TEAM_PATH);

  await fetch(`${srv.url}${TEAM_PATH}/invites`, {
    method: 'POST',
    headers: aliceJar.header(),
    redirect: 'manual',
  });
  const teamHtml = await (
    await fetch(`${srv.url}${TEAM_PATH}?tab=people`, { headers: aliceJar.header() })
  ).text();
  const code = /\/join\/([A-Za-z0-9_-]+)/.exec(teamHtml)?.[1];
  expect(code).toBeTruthy();

  const bobJar = await devLogin('bob');
  const joinRes = await fetch(`${srv.url}/join/${code}`, {
    method: 'POST',
    headers: bobJar.header(),
    redirect: 'manual',
  });
  expect(joinRes.status).toBe(302);

  aliceToken = await mintToken(aliceJar, 'laptop-claude');
  bobToken = await mintToken(bobJar, 'cli-bob');
});

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

it('keeps one snapshot slot per device', async () => {
  const mac = await callTool(aliceToken, 'push_snapshot', {
    repo: 'demo',
    device: 'macbook',
    snapshot: snapshotOf(),
  });
  expect(mac.isError).toBeFalsy();
  expect(toolText(mac)).toContain('as device "macbook"');

  const win = await callTool(aliceToken, 'push_snapshot', {
    repo: 'demo',
    device: 'win-desktop',
    snapshot: snapshotOf({
      os: { platform: 'win32', arch: 'x64' },
      runtimes: { node: '20.11.0' },
      envVarNames: ['PATH', 'HOME'],
    }),
  });
  expect(win.isError).toBeFalsy();
  // The second machine must not evict the first, and the ack points at the fleet.
  expect(toolText(win)).toContain('as device "win-desktop"');
  expect(toolText(win)).toContain('macbook');
  expect(toolText(win)).toContain('their_device');

  const fromMac = toolJson(await callTool(aliceToken, 'get_snapshot', { device: 'macbook' }));
  expect(fromMac.device).toBe('macbook');
  expect(fromMac.snapshot.runtimes.node).toBe('24.1.0');
  expect(fromMac.devices).toEqual(expect.arrayContaining(['macbook', 'win-desktop']));

  const fromWin = toolJson(await callTool(aliceToken, 'get_snapshot', { device: 'win-desktop' }));
  expect(fromWin.device).toBe('win-desktop');
  expect(fromWin.snapshot.runtimes.node).toBe('20.11.0');

  // list_teammates surfaces the fleet so an agent can discover what to compare.
  const teammates = toolJson(await callTool(aliceToken, 'list_teammates'));
  const alice = teammates.members.find((m: any) => m.username === 'alice');
  expect(alice.devices.map((d: any) => d.device).sort()).toEqual(['macbook', 'win-desktop']);
  expect(alice.devices.every((d: any) => d.lastSnapshotAt)).toBe(true);
  expect(alice.lastSnapshotAt).toBeTruthy();
  expect(teammates.hint).toContain('their_device');
});

it('compares two of your own machines', async () => {
  const res = await callTool(aliceToken, 'compare_env', {
    device: 'macbook',
    their_device: 'win-desktop',
  });
  expect(res.isError).toBeFalsy();
  const cmp = toolJson(res);
  expect(cmp.mode).toBe('own-devices');
  expect(cmp.a).toMatchObject({ username: 'alice', device: 'macbook' });
  expect(cmp.b).toMatchObject({ username: 'alice', device: 'win-desktop' });
  expect(cmp.identical).toBe(false);
  const summary = (cmp.summary as string[]).join('\n');
  expect(summary).toContain('runtimes.node');
  expect(summary).toContain('alice@macbook=24.1.0');
  expect(summary).toContain('alice@win-desktop=20.11.0');
  expect(summary).toContain('NVM_DIR');
  expect(summary).toContain('os.platform');

  // Same machine on both sides is a dead end — say so.
  const same = await callTool(aliceToken, 'compare_env', {
    device: 'macbook',
    their_device: 'macbook',
  });
  expect(same.isError).toBe(true);
  expect(toolText(same)).toContain('same snapshot');

  // Self-compare without picking both machines explains the shape.
  const vague = await callTool(aliceToken, 'compare_env', { device: 'macbook' });
  expect(vague.isError).toBe(true);
  expect(toolText(vague)).toContain('their_device');
  expect(toolText(vague)).toContain('win-desktop');
});

it('keeps the teammate comparison working unchanged', async () => {
  // Bob pushes without a device label: the slot falls back to his token name.
  const push = await callTool(bobToken, 'push_snapshot', {
    repo: 'demo',
    snapshot: snapshotOf({
      runtimes: { node: '18.20.0' },
      lockfiles: [{ path: 'package-lock.json', hash: 'bbb222' }],
    }),
  });
  expect(toolText(push)).toContain('Snapshot stored');
  expect(toolText(push)).toContain('as device "cli-bob"');

  const legacy = await callTool(aliceToken, 'compare_env', { teammate: 'bob' });
  expect(legacy.isError).toBeFalsy();
  const cmp = toolJson(legacy);
  expect(cmp.mode).toBe('teammate');
  expect(cmp.a.username).toBe('alice');
  expect(cmp.b.username).toBe('bob');
  const summary = (cmp.summary as string[]).join('\n');
  expect(summary).toContain('alice=');
  expect(summary).not.toContain('alice@');
  expect(summary).toContain('bob=18.20.0');

  // ...and the teammate lookup by username alone still resolves the newest snapshot.
  const snap = toolJson(await callTool(aliceToken, 'get_snapshot', { username: 'bob' }));
  expect(snap.snapshot.runtimes.node).toBe('18.20.0');
  expect(snap.device).toBe('cli-bob');

  // My machine against one of theirs.
  const pinned = toolJson(
    await callTool(aliceToken, 'compare_env', {
      teammate: 'bob',
      device: 'win-desktop',
      their_device: 'cli-bob',
    }),
  );
  expect(pinned.a).toMatchObject({ username: 'alice', device: 'win-desktop' });
  expect(pinned.b).toMatchObject({ username: 'bob', device: 'cli-bob' });
  expect((pinned.summary as string[]).join('\n')).toContain('alice@win-desktop=');
});

it('lists known devices when an unknown one is requested', async () => {
  const mine = await callTool(aliceToken, 'get_snapshot', { device: 'macbok' });
  expect(mine.isError).toBe(true);
  expect(toolText(mine)).toContain('Known devices');
  expect(toolText(mine)).toContain('macbook');
  expect(toolText(mine)).toContain('win-desktop');

  const theirs = await callTool(aliceToken, 'get_snapshot', { username: 'bob', device: 'nope' });
  expect(theirs.isError).toBe(true);
  expect(toolText(theirs)).toContain('cli-bob');

  const cmp = await callTool(aliceToken, 'compare_env', { teammate: 'bob', their_device: 'nope' });
  expect(cmp.isError).toBe(true);
  expect(toolText(cmp)).toContain('Known devices');
});

it('normalizes device labels', async () => {
  const messy = await callTool(aliceToken, 'push_snapshot', {
    device: '  MacBook Air!! ',
    snapshot: snapshotOf(),
  });
  expect(toolText(messy)).toContain('as device "macbook-air"');

  const long = await callTool(aliceToken, 'push_snapshot', {
    device: 'z'.repeat(60),
    snapshot: snapshotOf(),
  });
  // Over the cap the label keeps a readable head plus a digest of the whole
  // name, so two long names that share a prefix stay in separate slots instead
  // of one machine reading back the other's environment.
  const longLabel = /as device "([^"]+)"/.exec(toolText(long))?.[1] ?? '';
  expect(longLabel.length).toBeLessThanOrEqual(40);
  expect(longLabel.startsWith('z')).toBe(true);

  const sibling = await callTool(aliceToken, 'push_snapshot', {
    device: `${'z'.repeat(59)}y`,
    snapshot: snapshotOf(),
  });
  const siblingLabel = /as device "([^"]+)"/.exec(toolText(sibling))?.[1] ?? '';
  expect(siblingLabel, 'long labels that share a prefix must not collide').not.toBe(longLabel);

  const junk = await callTool(aliceToken, 'push_snapshot', {
    device: '###',
    snapshot: snapshotOf(),
  });
  expect(junk.isError).toBe(true);
  expect(toolText(junk)).toContain('not a usable device label');

  // No label at all → the token name, which is per machine by convention.
  const implicit = await callTool(aliceToken, 'push_snapshot', { snapshot: snapshotOf() });
  expect(toolText(implicit)).toContain('as device "laptop-claude"');
});

it('binds a snapshot to a registered agent installation', async () => {
  const register = await fetch(`${srv.url}/api/agent/installations/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${aliceToken}` },
    body: JSON.stringify({
      name: 'studio-desktop',
      clientType: 'claude-code',
      deviceFingerprint: 'fingerprint-studio-desktop',
      capabilities: [],
    }),
  });
  expect(register.status).toBe(200);
  const installation = ((await register.json()) as any).installation;

  // The control-plane device name becomes the snapshot's device slot.
  const push = await callTool(aliceToken, 'push_snapshot', {
    installation_id: installation.id,
    snapshot: snapshotOf(),
  });
  expect(push.isError).toBeFalsy();
  expect(toolText(push)).toContain('as device "studio-desktop"');

  // Someone else's installation is not a device you can write to.
  const stolen = await callTool(bobToken, 'push_snapshot', {
    installation_id: installation.id,
    snapshot: snapshotOf(),
  });
  expect(stolen.isError).toBe(true);
  expect(toolText(stolen)).toContain('Unknown or revoked agent installation');
});

it('offers member+device pickers on the web compare page', async () => {
  const page = await fetch(`${srv.url}${TEAM_PATH}/compare`, { headers: aliceJar.header() });
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('alice@macbook');
  expect(html).toContain('alice@win-desktop');
  expect(html).toContain('bob@cli-bob');

  const diff = await fetch(`${srv.url}${TEAM_PATH}/compare?a=alice%40macbook&b=alice%40win-desktop`, {
    headers: aliceJar.header(),
  });
  const diffHtml = await diff.text();
  expect(diffHtml).toContain('alice · macbook');
  expect(diffHtml).toContain('alice · win-desktop');
  expect(diffHtml).toContain('24.1.0');
  expect(diffHtml).toContain('20.11.0');
  expect(diffHtml).toContain('differs');

  // Team page lists the machines behind a member's snapshots.
  const teamHtml = await (
    await fetch(`${srv.url}${TEAM_PATH}?tab=people`, { headers: aliceJar.header() })
  ).text();
  expect(teamHtml).toContain('win-desktop');
});

it('retains snapshots per device, not per user', async () => {
  // 21 pushes from one machine (KEEP_SNAPSHOTS_PER_DEVICE is 20) must not evict
  // the older snapshot of a different machine.
  for (let i = 0; i < 21; i++) {
    const res = await callTool(aliceToken, 'push_snapshot', {
      device: 'macbook',
      snapshot: snapshotOf({ runtimes: { node: `24.1.${i}` } }),
    });
    expect(res.isError).toBeFalsy();
  }
  const win = toolJson(await callTool(aliceToken, 'get_snapshot', { device: 'win-desktop' }));
  expect(win.snapshot.runtimes.node).toBe('20.11.0');
  const mac = toolJson(await callTool(aliceToken, 'get_snapshot', { device: 'macbook' }));
  expect(mac.snapshot.runtimes.node).toBe('24.1.20');
});
