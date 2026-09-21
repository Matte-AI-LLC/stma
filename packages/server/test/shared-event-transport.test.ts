import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it } from 'vitest';
import postgres from 'postgres';
import { PGlite } from '@electric-sql/pglite';
import type { NotifyBus } from '../src/db';
import {
  attachChangeTransport,
  publishChange,
  readChangePayload,
  resetSubscribers,
  subscribe,
  subscriberCount,
  transportAttached,
  CHANGE_CHANNEL,
} from '../src/lib/stream';

/**
 * The live channel with more than one replica behind it.
 *
 * Two halves. The transport's own rules — local delivery first, our own
 * notification dropped on the way back in, a bus that refuses, a listener that
 * never answers, a payload some other writer put on the channel — run on every
 * push against a fake `NotifyBus` and against PGlite, which is a real
 * PostgreSQL and therefore really carries the bytes through `pg_notify`.
 *
 * The half that cannot be faked is delivery between two *backends*, and that
 * needs two operating-system processes rather than two servers in one: inside
 * one process `lib/stream`'s subscribers and instance id are shared, so a
 * browser on "A" would hear "B" through a set they have in common and the test
 * would prove nothing. It runs only with a disposable loopback database
 * (`STMA_TRANSPORT_DATABASE_URL`, wired in `postgres-gate.yml`). Two processes
 * on one machine are still not two machines, and this never claims to be
 * device acceptance.
 */

/** A NotifyBus that carries payloads between listeners in memory, in order. */
function fakeBus(): NotifyBus & { listeners: ((payload: string) => void)[]; sent: string[] } {
  const listeners: ((payload: string) => void)[] = [];
  const sent: string[] = [];
  return {
    listeners,
    sent,
    notify: async (channel, payload) => {
      expect(channel).toBe(CHANGE_CHANNEL);
      sent.push(payload);
      for (const listener of [...listeners]) listener(payload);
    },
    listen: async (_channel, onPayload) => {
      listeners.push(onPayload);
      return async () => {
        const at = listeners.indexOf(onPayload);
        if (at >= 0) listeners.splice(at, 1);
      };
    },
  };
}

const collector = (team: string) => {
  const heard: string[] = [];
  return {
    heard,
    sub: { teams: new Set([team]), send: (e: { kind: string }) => heard.push(e.kind) },
  };
};

// ------------------------------------------------------ one process, no server

it('keeps one replica exactly as it was: local fan-out, filtered by team', () => {
  const mine = collector('team-1');
  const theirs = collector('team-2');
  const stop = subscribe(mine.sub);
  const stopTheirs = subscribe(theirs.sub);
  expect(stop).toBeTruthy();
  expect(transportAttached()).toBe(false);
  publishChange('team-1', 'claims');
  publishChange(null, 'run');
  publishChange(undefined, 'run');
  expect(mine.heard).toEqual(['claims']);
  expect(theirs.heard).toEqual([]);
  stop?.();
  stopTheirs?.();
  expect(subscriberCount()).toBe(0);
});

it('sends what it published and drops the copy the database hands back', async () => {
  const bus = fakeBus();
  const stop = await attachChangeTransport(bus);
  expect(transportAttached()).toBe(true);
  const mine = collector('team-1');
  const elsewhere = collector('team-9');
  const subs = [subscribe(mine.sub), subscribe(elsewhere.sub)];

  publishChange('team-1', 'quota');
  await new Promise((r) => setImmediate(r));
  // Exactly once: delivered locally, then the notification that came straight
  // back to this process was recognised as ours.
  expect(mine.heard).toEqual(['quota']);
  expect(elsewhere.heard).toEqual([]);
  expect(bus.sent).toHaveLength(1);
  expect(JSON.parse(bus.sent[0]!)).toMatchObject({ t: 'team-1', k: 'quota' });
  expect(JSON.parse(bus.sent[0]!).i).toEqual(expect.any(String));

  // What another replica sent is delivered, and the team filter still applies.
  const fromElsewhere = (team: string, kind: string) =>
    bus.listeners.forEach((l) => l(JSON.stringify({ i: 'another-replica', t: team, k: kind })));
  fromElsewhere('team-1', 'run');
  fromElsewhere('team-5', 'run');
  expect(mine.heard).toEqual(['quota', 'run']);
  expect(elsewhere.heard).toEqual([]);

  for (const s of subs) s?.();
  await stop();
  expect(transportAttached()).toBe(false);
});

it('costs a local page nothing when the transport is broken — which is what the poll covers', async () => {
  const broken: NotifyBus = {
    notify: async () => {
      throw new Error('connection terminated unexpectedly');
    },
    listen: async () => async () => {},
  };
  const stop = await attachChangeTransport(broken);
  const mine = collector('team-1');
  const unsubscribe = subscribe(mine.sub);
  // Publishing is void and is called from inside domain writes: a database
  // refusing NOTIFY must not reach the request that was doing real work.
  expect(() => publishChange('team-1', 'session')).not.toThrow();
  await new Promise((r) => setImmediate(r));
  expect(mine.heard).toEqual(['session']);
  unsubscribe?.();
  await stop();
});

it('starts without a transport rather than refusing to boot when the listener cannot subscribe', async () => {
  const refusing: NotifyBus = {
    notify: async () => {},
    listen: async () => {
      throw new Error('no connection to the database');
    },
  };
  const stop = await attachChangeTransport(refusing);
  expect(transportAttached()).toBe(false);
  const mine = collector('team-1');
  const unsubscribe = subscribe(mine.sub);
  publishChange('team-1', 'activity');
  expect(mine.heard).toEqual(['activity']);
  unsubscribe?.();
  await stop();
});

it('comes up poll-only rather than hanging the boot on a listener that never answers', async () => {
  let resolveListen: ((stop: () => Promise<void>) => void) | undefined;
  let stopped = false;
  const silent: NotifyBus = {
    notify: async () => {},
    listen: async () =>
      new Promise((resolve) => {
        resolveListen = resolve;
      }),
  };
  const started = Date.now();
  const stop = await attachChangeTransport(silent, 40);
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(transportAttached()).toBe(false);
  const mine = collector('team-1');
  const unsubscribe = subscribe(mine.sub);
  publishChange('team-1', 'run');
  expect(mine.heard).toEqual(['run']);
  unsubscribe?.();

  // A subscription that answers late is still cleaned up, not leaked.
  const disposing = stop();
  resolveListen?.(async () => {
    stopped = true;
  });
  await disposing;
  expect(stopped).toBe(true);
  expect(transportAttached()).toBe(false);
});

it('drops a payload it did not write, instead of waking every page on the instance', async () => {
  expect(readChangePayload('not json')).toBeUndefined();
  expect(readChangePayload('null')).toBeUndefined();
  expect(readChangePayload('"a string"')).toBeUndefined();
  expect(readChangePayload(JSON.stringify({ i: 'x', t: '', k: 'run' }))).toBeUndefined();
  // `kind` reaches the browser as an event name, so it is checked against the
  // closed set rather than passed along.
  expect(readChangePayload(JSON.stringify({ i: 'x', t: 'team-1', k: 'reload' }))).toBeUndefined();
  expect(readChangePayload(JSON.stringify({ i: 'x', t: 'team-1', k: 'run' }))).toEqual({
    i: 'x',
    t: 'team-1',
    k: 'run',
  });

  const bus = fakeBus();
  const stop = await attachChangeTransport(bus);
  const mine = collector('team-1');
  const unsubscribe = subscribe(mine.sub);
  for (const junk of ['{', '{"t":"team-1"}', JSON.stringify({ i: 'x', t: 'team-1', k: 'drop' })]) {
    for (const listener of bus.listeners) listener(junk);
  }
  expect(mine.heard).toEqual([]);
  unsubscribe?.();
  await stop();
  resetSubscribers();
});

it('carries the payload through a real PostgreSQL LISTEN/NOTIFY, not only through a fake', async () => {
  // PGlite is PostgreSQL — the same server, compiled to wasm — so this proves
  // the bytes survive `pg_notify` and come back out of a `LISTEN` subscription
  // parseable, with the channel name and the self-drop doing their jobs. What
  // it cannot prove is delivery between two backends, because it has one: that
  // is the leg below, against postgres:16 with two processes.
  const engine = new PGlite();
  const bus: NotifyBus = {
    notify: async (channel, payload) => {
      await engine.query('select pg_notify($1, $2)', [channel, payload]);
    },
    listen: async (channel, onPayload) => {
      const stop = await engine.listen(channel, onPayload);
      return () => stop();
    },
  };
  const stop = await attachChangeTransport(bus);
  const mine = collector('team-7');
  const unsubscribe = subscribe(mine.sub);

  // Ours: delivered locally once, and the copy PostgreSQL hands back is dropped.
  publishChange('team-7', 'policy');
  await new Promise((r) => setTimeout(r, 300));
  expect(mine.heard).toEqual(['policy']);

  // Another replica's, written straight onto the channel by the database.
  await engine.query('select pg_notify($1, $2)', [
    CHANGE_CHANNEL,
    JSON.stringify({ i: 'another-replica', t: 'team-7', k: 'run' }),
  ]);
  const deadline = Date.now() + 5_000;
  while (mine.heard.length < 2 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(mine.heard).toEqual(['policy', 'run']);

  unsubscribe?.();
  await stop();
  await engine.close();
});

// ------------------------------------------------ two processes, one database

const url = process.env.STMA_TRANSPORT_DATABASE_URL;
const replicas: ChildProcess[] = [];

afterAll(() => {
  for (const child of replicas) child.kill();
});

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The installed `tsx`, found by walking up rather than asked of `npx` — npx
 * would try to *fetch* a missing one and turn a broken checkout into a hang.
 */
function tsxBin(): string {
  const name = process.platform === 'win32' ? 'tsx.cmd' : 'tsx';
  let dir = here;
  for (let up = 0; up < 6; up += 1) {
    const candidate = path.join(dir, 'node_modules', '.bin', name);
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('tsx is not installed in this checkout');
}

/** Boot one replica in its own process and wait for it to say where it is. */
async function replica(): Promise<string> {
  const helper = path.join(here, 'helpers', 'replica.ts');
  const child = spawn(tsxBin(), [helper], {
    env: { ...process.env, REPLICA_DATABASE_URL: url, REPLICA_PORT: '0', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  replicas.push(child);
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return await new Promise<string>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`replica never said READY: ${stderr}`)), 90_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const ready = /READY (\S+)/.exec(out);
      if (!ready) return;
      clearTimeout(timer);
      resolve(ready[1]!);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`replica exited with ${code}: ${stderr}`));
    });
  });
}

it.skipIf(!url)(
  'lets a browser on one replica hear what another replica did',
  async () => {
    const parsed = new URL(url!);
    if (
      !['localhost', '127.0.0.1'].includes(parsed.hostname) ||
      !parsed.pathname.startsWith('/stma_transport_')
    )
      throw new Error('Transport tests require a disposable loopback stma_transport_* database.');
    const probe = postgres(url!, { max: 1 });
    try {
      const rows = await probe`select count(*)::int as n from information_schema.tables where table_schema in ('public', 'drizzle')`;
      if (rows[0]?.n !== 0)
        throw new Error('Transport database must be empty. No existing data was removed.');
    } finally {
      await probe.end();
    }

    // Sequentially: the second boot meets the first one's advisory lock, which
    // is the other thing two replicas starting together have to survive.
    const a = await replica();
    const b = await replica();
    expect(a).not.toBe(b);

    const form = (origin: string, pathname: string, body: Record<string, string>, jar = '') =>
      fetch(origin + pathname, {
        method: 'POST',
        headers: { cookie: jar, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body),
        redirect: 'manual',
      });

    const login = await form(a, '/auth/dev', { username: 'transport-owner' });
    const cookie = login.headers
      .getSetCookie()
      .map((item) => item.split(';')[0])
      .join('; ');
    expect(cookie).toBeTruthy();
    expect((await form(a, '/app/teams', { name: 'Transport Lab' }, cookie)).status).toBe(302);

    const controller = new AbortController();
    const res = await fetch(`${a}/app/stream`, {
      headers: { accept: 'text/event-stream', cookie },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const readUntil = async (marker: string, budgetMs = 20_000) => {
      const deadline = Date.now() + budgetMs;
      let buffer = '';
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes(marker)) return buffer;
      }
      return buffer;
    };
    expect(await readUntil('event: ready')).toContain('event: ready');

    // The session cookie was minted by A and is read by B: one database.
    const page = await fetch(`${b}/app/teams/transport-lab?tab=integrations`, {
      headers: { cookie },
    });
    expect(page.status).toBe(200);
    const token = /\/api\/hooks\/announce\/([A-Za-z0-9_-]+)/.exec(await page.text())?.[1];
    expect(token).toBeTruthy();

    // A write that lands entirely on B. The only thing the two share is
    // PostgreSQL, so anything the browser hears now crossed it.
    const announced = await fetch(`${b}/api/hooks/announce/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'the other replica did something' }),
    });
    expect(announced.status).toBe(200);

    const pushed = await readUntil('event: change');
    expect(pushed).toContain('event: change');
    expect(pushed).toMatch(/"kinds":\[[^\]]*"(activity|announcement|session)"/);

    controller.abort();
    await reader.cancel().catch(() => {});
  },
  180_000,
);
