import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';
import { teams } from '../src/db/schema';

/**
 * One route serves two events that are not the same thing: an installer that
 * redeemed and then could not persist its configuration, and a person running
 * `stma adapter disconnect` on a connection they are done with. Until
 * 2026-09-20 both wrote `self_revoked_after_setup_failure`, so the operator's
 * log reported an installer failure every time somebody tidied up and a real
 * failure could not be told from a tidy-up.
 *
 * Its own server because `/api/agent-enrollments/*` is rate limited per IP and
 * this reads the route four times; sharing a server means sharing that budget
 * with whatever ran before, and a test that passes alone is not a test.
 */
let srv: StartedServer;
let dataDir: string;
let rpcId = 1;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-disconnect-reason-'));
  srv = await startServer(
    loadEnv({ port: 0, host: '127.0.0.1', nodeEnv: 'test', devMode: true, databaseUrl: undefined, pgliteDir: dataDir }),
  );
});

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function jar() {
  const cookies = new Map<string, string>();
  return {
    header: (): Record<string, string> =>
      cookies.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {},
    store(response: Response) {
      for (const line of response.headers.getSetCookie()) {
        const [pair] = line.split(';');
        const at = pair!.indexOf('=');
        cookies.set(pair!.slice(0, at), pair!.slice(at + 1));
      }
    },
  };
}

it('records a deliberate disconnect as one, and a silent caller as the failed setup it used to mean', async () => {
  const cookies = jar();
  cookies.store(
    await fetch(`${srv.url}/auth/dev`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'disconnect-owner' }),
      redirect: 'manual',
    }),
  );
  const post = (pathname: string, body: Record<string, string>) =>
    fetch(`${srv.url}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...cookies.header() },
      body: new URLSearchParams(body),
      redirect: 'manual',
    });
  expect((await post('/app/teams', { name: 'Disconnect Lab' })).status).toBe(302);
  const [team] = await srv.db.select().from(teams).where(eq(teams.slug, 'disconnect-lab'));

  /** Connect an agent, end it the way `body` says, and return what was logged. */
  const revokeWith = async (name: string, body?: Record<string, unknown>) => {
    const page = await (await post('/app/tokens', { name, device: 'desk', access: `team:${team!.id}`, client: 'codex', role: 'generalist' })).text();
    const code = /stma_enroll_[0-9a-f]{40}/.exec(page)?.[0];
    expect(code, 'the page shows the one-time code once').toBeTruthy();
    const { token } = (await (
      await fetch(`${srv.url}/api/agent-enrollments/redeem`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      })
    ).json()) as { token: string };
    // A bootstrap credential is not live until the real client confirms it.
    const confirm = await fetch(`${srv.url}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: 'whoami', arguments: {} } }),
    });
    expect(confirm.status).toBe(200);

    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const response = await fetch(`${srv.url}/api/agent-enrollments/self-revoke`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect(response.status).toBe(200);
      const actions = output.mock.calls
        .map((call) => {
          try {
            return JSON.parse(String(call[0])) as { evt?: string; a?: string };
          } catch {
            return null;
          }
        })
        .filter((line) => line?.evt === 'agent_enrollment')
        .map((line) => line!.a);
      // The credential is dead either way. Only the recorded reason differs.
      const after = await fetch(`${srv.url}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(after.status).toBe(401);
      return actions;
    } finally {
      output.mockRestore();
    }
  };

  expect(await revokeWith('tidied-up', { reason: 'disconnected' })).toContain('disconnected_by_user');
  expect(await revokeWith('installer-failed', { reason: 'setup_failed' })).toContain('self_revoked_after_setup_failure');
  // A shipped installer sends no body at all, so no body keeps the old meaning.
  expect(await revokeWith('older-installer')).toContain('self_revoked_after_setup_failure');
  // The set is closed: the caller chooses between two recorded events and can
  // never write a sentence of its own into the operator's log.
  expect(await revokeWith('made-up-reason', { reason: 'because I felt like it' })).toContain('self_revoked_after_setup_failure');
});
