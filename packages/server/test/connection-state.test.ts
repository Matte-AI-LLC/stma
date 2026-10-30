import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db';
import {
  agentEvents,
  agentInstallations,
  agentRuns,
  handoffs,
  oauthClients,
  oauthRefreshTokens,
  projects,
  teams,
  tokens,
} from '../src/db/schema';
import {
  WORK_NOT_OBSERVED,
  WORK_STATE_LABEL,
  connectionStates,
  contactTimeOf,
  describeConnection,
  describeWork,
  safeCommandArg,
  type ConnectionInput,
  type ConnectionState,
} from '../src/domain/connectionState';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';
import {
  LOOPBACK_CALLBACK,
  connectOAuth,
  devLogin,
  getPage,
  pageText,
  postForm,
  rpc,
  type Jar,
} from './helpers/oauthClient';

/**
 * A connection is five separate facts, and "unknown" is a valid answer
 * (T01, 2026-10-22). The first half is the pure table: the same input and clock
 * give the same words. The second half drives the Agent connections page, the
 * roster and the project page over HTTP with connections in every state.
 */

const NOW = new Date('2026-10-22T12:00:00.000Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);
const hoursAgo = (n: number) => minutesAgo(n * 60);
const hoursAhead = (n: number) => new Date(NOW.getTime() + n * 3_600_000);

// Words a connection or a run must never be called: STMA has no process heartbeat.
const BANNED = /\b(idle|online|offline|healthy|running)\b/i;
const everyWord = (state: ConnectionState) =>
  [
    state.authorization.label,
    state.authorization.note,
    state.adapter.note,
    state.task.note,
    state.nextStep.text,
    state.nextStep.command ?? '',
    ...state.unknown,
  ].join(' \n ');

function base(overrides: Partial<ConnectionInput> = {}, token: Partial<ConnectionInput['token']> = {}, installation: Partial<NonNullable<ConnectionInput['installation']>> | null = {}): ConnectionInput {
  return {
    token: {
      name: 'agent',
      scope: 'project',
      audience: 'https://stma.test/mcp',
      setupExpiresAt: null,
      activatedAt: hoursAgo(5),
      expiresAt: hoursAhead(1),
      revokedAt: null,
      lastUsedAt: hoursAgo(1),
      createdAt: hoursAgo(6),
      ...token,
    },
    installation:
      installation === null
        ? null
        : {
            clientType: 'claude-code',
            capabilities: ['mcp', 'scoped-enrollment', 'oauth'],
            lastSeenAt: hoursAgo(1),
            createdAt: hoursAgo(6),
            revokedAt: null,
            companion: null,
            ...installation,
          },
    refresh: { createdAt: hoursAgo(1), live: true },
    run: null,
    newestHeartbeatAt: null,
    adapters: [],
    project: { slug: 'parcel-api', name: 'parcel-api' },
    teamSlug: 'parcel',
    baseUrl: 'https://stma.test',
    leases: { activeMinutes: 5, waitingMinutes: 30 },
    ...overrides,
  };
}

describe('describeConnection', () => {
  it('a setup the client has not confirmed is awaiting it, with the reload as the next step', () => {
    const state = describeConnection(
      base({ refresh: null }, { activatedAt: null, setupExpiresAt: new Date(NOW.getTime() + 600_000), lastUsedAt: null, createdAt: minutesAgo(3) }, { lastSeenAt: minutesAgo(3), createdAt: minutesAgo(3) }),
      NOW,
    );
    expect(state.kind).toBe('agent');
    expect(state.authorization).toMatchObject({ state: 'awaiting_client', label: 'awaiting client' });
    expect(state.nextStep).toMatchObject({ kind: 'client' });
    expect(state.nextStep.text).toContain('Reload Claude Code in that checkout once');
    expect(state.adapter.state).toBe('not_reported');
    expect(state.lastContact).toEqual({ at: null, source: 'none' });
    expect(everyWord(state)).not.toMatch(/\bconnected\b|healthy|running/i);
  });

  it('a lapsed setup window is setup expired and the next step is a fresh connection', () => {
    const state = describeConnection(
      base({ refresh: null }, { activatedAt: null, setupExpiresAt: minutesAgo(20), lastUsedAt: null, createdAt: minutesAgo(40) }),
      NOW,
    );
    expect(state.authorization).toMatchObject({ state: 'setup_expired', label: 'setup expired' });
    expect(state.nextStep).toMatchObject({ kind: 'console', text: expect.stringContaining('Create a fresh connection'), href: '#connect' });
  });

  it('an expired access token with a live refresh grant is still authorized, and the grant is the last contact', () => {
    const refreshAt = minutesAgo(90);
    const state = describeConnection(
      base({ refresh: { createdAt: refreshAt, live: true } }, { expiresAt: minutesAgo(30), lastUsedAt: null, activatedAt: hoursAgo(5) }, { lastSeenAt: hoursAgo(6), createdAt: hoursAgo(6) }),
      NOW,
    );
    expect(state.authorization.state).toBe('authorized');
    expect(state.authorization.source).toBe('oauth_initialize');
    expect(state.lastContact).toEqual({ at: refreshAt, source: 'oauth_token_issue' });
  });

  it('an expired access token with no refresh grant left must sign in again', () => {
    for (const refresh of [null, { createdAt: hoursAgo(3), live: false }]) {
      const state = describeConnection(base({ refresh }, { expiresAt: minutesAgo(30) }), NOW);
      expect(state.authorization).toMatchObject({ state: 'sign_in_again', label: 'sign in again' });
      expect(state.nextStep.kind).toBe('terminal');
      expect(state.nextStep.text).toContain('claude mcp login NAME or codex mcp login NAME');
      expect(state.nextStep.text).toContain('at the checkout root');
    }
  });

  it('a connection made by stma connect says hooks were installed then, and that local files are not checked', () => {
    const state = describeConnection(
      base(
        { refresh: null },
        { audience: null, expiresAt: null },
        { capabilities: ['mcp', 'scoped-enrollment', 'terminal-connect'], createdAt: hoursAgo(6) },
      ),
      NOW,
    );
    expect(state.authorization.source).toBe('terminal_initialize');
    expect(state.adapter.state).toBe('installed_by_connect');
    expect(state.adapter.note).toContain('local files are not checked from here');
    expect(state.unknown).toEqual(
      expect.arrayContaining([expect.stringContaining('hooks'), expect.stringContaining('client is open')]),
    );
    // With a lapsed run the next step is the doctor, at the checkout root.
    const overdue = describeConnection(
      base(
        { refresh: null, run: { name: 'PD-9', status: 'active', lastHeartbeatAt: minutesAgo(40) } },
        { audience: null, expiresAt: null },
        { capabilities: ['mcp', 'terminal-connect'] },
      ),
      NOW,
    );
    expect(overdue.task.state).toBe('heartbeat_overdue');
    expect(overdue.nextStep).toMatchObject({ kind: 'terminal', command: 'stma adapter doctor' });
    expect(overdue.nextStep.text).toContain('checkout root');
  });

  it('last contact is the newest of the sources, and names which one it was', () => {
    const request = minutesAgo(10);
    const heartbeat = minutesAgo(3);
    const seen = minutesAgo(20);
    const state = describeConnection(
      base(
        { refresh: { createdAt: hoursAgo(1), live: true }, newestHeartbeatAt: heartbeat },
        { lastUsedAt: request },
        { lastSeenAt: seen, createdAt: hoursAgo(6) },
      ),
      NOW,
    );
    expect(state.lastContact).toEqual({ at: heartbeat, source: 'run_heartbeat' });
    const requestWins = describeConnection(
      base({ refresh: null, newestHeartbeatAt: minutesAgo(30) }, { lastUsedAt: request }, { lastSeenAt: seen, createdAt: hoursAgo(6) }),
      NOW,
    );
    expect(requestWins.lastContact).toEqual({ at: request, source: 'authenticated_request' });
    // Nothing recorded at all is "never", not a time.
    const never = describeConnection(base({ refresh: null }, { activatedAt: null, setupExpiresAt: hoursAhead(1), lastUsedAt: null }, null), NOW);
    expect(never.lastContact).toEqual({ at: null, source: 'none' });
  });

  it('a registration is not a request: the creation time of an installation is not a last contact', () => {
    const state = describeConnection(
      base({ refresh: null }, { activatedAt: null, setupExpiresAt: hoursAhead(1), lastUsedAt: null, createdAt: minutesAgo(1) }, { lastSeenAt: minutesAgo(1), createdAt: minutesAgo(1) }),
      NOW,
    );
    expect(state.lastContact.at).toBeNull();
  });

  it('a run is described by what it reported, never as running or idle', () => {
    const fresh = describeConnection(
      base({ run: { name: 'PD-1', status: 'active', lastHeartbeatAt: minutesAgo(2) } }),
      NOW,
    );
    expect(fresh.task.state).toBe('run_reported');
    expect(fresh.task.note).toContain('reported active');
    const overdue = describeConnection(
      base({ run: { name: 'PD-1', status: 'active', lastHeartbeatAt: minutesAgo(12) } }),
      NOW,
    );
    expect(overdue.task.state).toBe('heartbeat_overdue');
    expect(overdue.task.note).toContain('stopped reporting; its lease lapses or has lapsed');
    const waiting = describeConnection(
      base({ run: { name: 'PD-1', status: 'waiting', lastHeartbeatAt: minutesAgo(12) } }),
      NOW,
    );
    // Waiting keeps the longer lease, so twelve minutes is still a person's turn.
    expect(waiting.task.state).toBe('waiting_for_person');
    const blocked = describeConnection(
      base({ run: { name: 'PD-1', status: 'blocked', lastHeartbeatAt: minutesAgo(45) } }),
      NOW,
    );
    expect(blocked.task.state).toBe('heartbeat_overdue');
    const none = describeConnection(base(), NOW);
    expect(none.task.state).toBe('no_run_reported');
    for (const state of [fresh, overdue, waiting, blocked, none]) {
      expect(everyWord(state).replace(/Run "[^"]*"/g, '')).not.toMatch(BANNED);
    }
  });

  it('the Claude app is a console: no adapter, no task, no hooks, nothing to assign', () => {
    const state = describeConnection(
      base({ refresh: { createdAt: hoursAgo(1), live: true } }, { scope: 'personal' }, { clientType: 'claude-app', capabilities: ['mcp', 'oauth'] }),
      NOW,
    );
    expect(state.kind).toBe('console');
    expect(state.adapter.state).toBe('not_applicable');
    expect(state.nextStep.kind).toBe('none');
    expect(state.nextStep.text).toContain('This is your console');
    expect(state.unknown).toHaveLength(1);
    const words = everyWord(state);
    expect(words).not.toMatch(/hook|assign|checkout/i);
    expect(words).not.toMatch(BANNED);
  });

  it('a revoked credential, or a revoked installation behind a live one, is revoked and offers Connect again', () => {
    const byToken = describeConnection(base({}, { revokedAt: minutesAgo(5) }), NOW);
    expect(byToken.authorization).toMatchObject({ state: 'revoked', label: 'revoked' });
    expect(byToken.nextStep).toMatchObject({ kind: 'console', href: '#connect' });
    expect(byToken.nextStep.text).toContain('Connect again');
    const byInstallation = describeConnection(base({}, {}, { revokedAt: minutesAgo(5) }), NOW);
    expect(byInstallation.authorization.state).toBe('revoked');
  });

  it('a credential that never reported through verified setup is legacy and unverified', () => {
    const state = describeConnection(
      base({ refresh: null }, { audience: null, expiresAt: null, activatedAt: null, setupExpiresAt: null }, null),
      NOW,
    );
    expect(state.authorization).toMatchObject({ state: 'legacy_unverified', label: 'legacy · unverified' });
  });

  it('an OAuth agent with no adapter may be offered the optional hooks, only inside a project', () => {
    const state = describeConnection(base(), NOW);
    expect(state.nextStep.kind).toBe('terminal');
    expect(state.nextStep.command).toBe(
      'stma adapter activate --target claude-code --team parcel --project parcel-api --server https://stma.test',
    );
    expect(state.nextStep.text).toContain('Optional');
    const wholeWorkspace = describeConnection(base({ project: null }, { scope: 'team' }), NOW);
    expect(wholeWorkspace.nextStep.kind).toBe('none');
  });

  it('a project name is never a shell: a quote or a semicolon yields no command, a space is double-quoted', () => {
    // Free text any member's agent can create; POSIX single quotes do not protect PowerShell.
    const hostile = [`x'; Write-Output INJECTED; '`, 'a$(whoami)', 'a`b', 'a"b', 'a\\b', 'a;b', 'a&b', 'a|b', 'a\nb'];
    for (const name of hostile) {
      const state = describeConnection(base({ project: { slug: 'parcel-api', name } }), NOW);
      expect(state.nextStep.command, name).toBeUndefined();
      expect(state.nextStep.kind).toBe('none');
      expect(state.nextStep.text).toContain('cannot carry safely');
    }
    const spaced = describeConnection(base({ project: { slug: 'parcel-desk', name: 'Parcel Desk' } }), NOW);
    expect(spaced.nextStep.command).toBe(
      'stma adapter activate --target claude-code --team parcel --project "Parcel Desk" --server https://stma.test',
    );
    // The same refusal for a team slug or a server address that is not plain.
    expect(describeConnection(base({ teamSlug: "x';y" }), NOW).nextStep.command).toBeUndefined();
    expect(describeConnection(base({ baseUrl: 'https://stma.test/?a=1&b=2' }), NOW).nextStep.command).toBeUndefined();
    expect(safeCommandArg('ok-name_1')).toBe('ok-name_1');
    expect(safeCommandArg(' lead')).toBeNull();
    expect(safeCommandArg('trail ')).toBeNull();
  });

  it('only Claude Code and Codex are offered the hook command, not Cursor or an unknown client', () => {
    const codex = describeConnection(base({}, {}, { clientType: 'codex' }), NOW);
    expect(codex.nextStep.command).toContain('--target codex');
    for (const clientType of ['cursor', 'something-else']) {
      const state = describeConnection(base({}, {}, { clientType }), NOW);
      expect(state.nextStep.command, clientType).toBeUndefined();
      expect(state.nextStep.kind).toBe('none');
    }
  });

  it('a console that is revoked, expired or must sign in again is pointed at the Claude app, never a terminal', () => {
    const consoleInstallation = { clientType: 'claude-app', capabilities: ['mcp', 'oauth'] };
    const cases = [
      describeConnection(base({}, { revokedAt: minutesAgo(5) }, consoleInstallation), NOW),
      describeConnection(
        base({ refresh: null }, { activatedAt: null, setupExpiresAt: minutesAgo(20), lastUsedAt: null, createdAt: minutesAgo(40) }, consoleInstallation),
        NOW,
      ),
      describeConnection(base({ refresh: { createdAt: hoursAgo(3), live: false } }, { expiresAt: minutesAgo(10) }, consoleInstallation), NOW),
    ];
    expect(cases.map((c) => c.authorization.state)).toEqual(['revoked', 'setup_expired', 'sign_in_again']);
    for (const state of cases) {
      expect(state.kind).toBe('console');
      expect(state.nextStep.href).toBe('#claude-app');
      expect(state.nextStep.kind).not.toBe('terminal');
      expect(state.nextStep.text).toMatch(/Claude/);
      expect(state.nextStep.text).not.toMatch(/checkout|terminal|\bstma connect\b|codex|mcp login/i);
    }
    // A coding agent in the same states still gets the terminal wording.
    const agent = describeConnection(base({ refresh: { createdAt: hoursAgo(3), live: false } }, { expiresAt: minutesAgo(10) }), NOW);
    expect(agent.nextStep.kind).toBe('terminal');
    expect(agent.nextStep.text).toContain('mcp login');
  });

  it('an installation that never called STMA has a registration, not a last contact', () => {
    const created = hoursAgo(3);
    expect(contactTimeOf({ createdAt: created, lastSeenAt: created })).toBeNull();
    expect(contactTimeOf({ createdAt: created, lastSeenAt: new Date(created.getTime() + 1_500) })).toBeNull();
    const later = minutesAgo(5);
    expect(contactTimeOf({ createdAt: created, lastSeenAt: later })).toEqual(later);
  });

  it('a paired adapter is reported with the time it last called, and an unpaired one asks for a pairing', () => {
    const calledAt = minutesAgo(7);
    const paired = describeConnection(base({ adapters: [{ name: 'parcel-local-adapter', lastSeenAt: calledAt }] }), NOW);
    expect(paired.adapter).toMatchObject({ state: 'paired', observedAt: calledAt });
    expect(paired.adapter.note).toContain('not checked from here');
    const adapter = describeConnection(
      base({}, {}, { capabilities: ['mcp', 'oauth', 'local-adapter'], companion: null }),
      NOW,
    );
    expect(adapter.kind).toBe('adapter');
    expect(adapter.adapter.state).toBe('unpaired_adapter');
    expect(adapter.nextStep).toMatchObject({ kind: 'console', href: '#connections' });
    const orphan = describeConnection(
      base({}, {}, { capabilities: ['mcp', 'oauth', 'local-adapter'], companion: { name: 'gone', live: false } }),
      NOW,
    );
    expect(orphan.adapter.note).toContain('revoked');
  });
});

describe('describeWork', () => {
  const sent = {
    kind: 'assignment',
    state: 'offered',
    createdAt: hoursAgo(3),
    acceptedAt: null,
    resumedAt: null,
    completedAt: null,
    updatedAt: hoursAgo(3),
  };
  const steps = (input: Parameters<typeof describeWork>[0]) => describeWork(input).steps.map((step) => step.step);

  it('an offer proves one thing, that it was sent, and says what is not observed', () => {
    const work = describeWork({ handoff: sent });
    expect(work.steps.map((s) => s.step)).toEqual(['sent']);
    expect(work.notObserved).toBe(WORK_NOT_OBSERVED);
    expect(work.notObserved).toContain('STMA starts no local process');
    expect(WORK_STATE_LABEL.offered).toBe('sent, not yet accepted');
    expect(Object.values(WORK_STATE_LABEL).join(' ')).not.toMatch(/—|waiting for the agent/);
  });

  it('accepted is not started, only the agent\'s resume is, and a run being named never counts', () => {
    const accepted = { ...sent, state: 'accepted', acceptedAt: hoursAgo(2), updatedAt: hoursAgo(2) };
    expect(steps({ handoff: accepted })).toEqual(['sent', 'accepted']);
    const resumed = { ...accepted, state: 'in_progress', resumedAt: hoursAgo(1), updatedAt: hoursAgo(1) };
    expect(steps({ handoff: resumed })).toEqual(['sent', 'accepted', 'started']);
    // `run_named` is written on accept too, and only renames a run that was already open.
    const named = describeWork({ handoff: accepted, runNamedAt: minutesAgo(50) });
    expect(named.steps.map((s) => s.step)).toEqual(['sent', 'accepted']);
  });

  it('needs attention, or the run named for accepted work reporting waiting, is waiting for a person', () => {
    const attention = { ...sent, state: 'needs_attention', acceptedAt: hoursAgo(2), updatedAt: minutesAgo(10) };
    expect(steps({ handoff: attention })).toContain('waiting_for_person');
    const accepted = { ...sent, state: 'accepted', acceptedAt: hoursAgo(2), updatedAt: hoursAgo(2) };
    const waitingRun = { status: 'waiting', lastHeartbeatAt: minutesAgo(1) };
    const live = describeWork({ handoff: accepted, runNamedAt: minutesAgo(90), agentRun: waitingRun, now: NOW });
    expect(live.steps.map((s) => s.step)).toContain('waiting_for_person');
    expect(live.steps.find((s) => s.step === 'waiting_for_person')!.source).toContain('named for this work');
    const lapsed = describeWork({
      handoff: accepted,
      runNamedAt: minutesAgo(90),
      agentRun: { status: 'waiting', lastHeartbeatAt: hoursAgo(5) },
      now: NOW,
    });
    expect(lapsed.steps.map((s) => s.step)).not.toContain('waiting_for_person');
  });

  it('a waiting run that is not tied to this work, or work nobody accepted, proves nothing about it', () => {
    const waitingRun = { status: 'waiting', lastHeartbeatAt: minutesAgo(1) };
    // Sent, not accepted: the target's run in the project is about something else.
    expect(steps({ handoff: sent, agentRun: waitingRun, now: NOW })).toEqual(['sent']);
    expect(steps({ handoff: sent, runNamedAt: minutesAgo(5), agentRun: waitingRun, now: NOW })).toEqual(['sent']);
    // Accepted, but no run was named for this session: the waiting run may be another task.
    const accepted = { ...sent, state: 'accepted', acceptedAt: hoursAgo(2), updatedAt: hoursAgo(2) };
    expect(steps({ handoff: accepted, agentRun: waitingRun, now: NOW })).toEqual(['sent', 'accepted']);
    // A blocked run of a finished piece of work is not drawn either.
    const done = { ...accepted, state: 'completed', completedAt: hoursAgo(1) };
    expect(steps({ handoff: done, runNamedAt: minutesAgo(90), agentRun: waitingRun, now: NOW })).not.toContain('waiting_for_person');
  });

  it('the hook sentence is a statement about the future, so it exists only while the work is unaccepted', () => {
    expect(describeWork({ handoff: sent, hookWillAnnounce: true }).hook).toContain('can announce');
    expect(describeWork({ handoff: sent, hookWillAnnounce: false }).hook).toContain('inbox');
    for (const state of ['accepted', 'in_progress', 'completed', 'cancelled', 'declined', 'needs_attention']) {
      expect(describeWork({ handoff: { ...sent, state }, hookWillAnnounce: true }).hook, state).toBe('');
      expect(describeWork({ handoff: { ...sent, state }, hookWillAnnounce: false }).hook, state).toBe('');
    }
  });

  it('completed is the agent\'s word, and cancelled or declined are said as such', () => {
    const done = {
      ...sent,
      state: 'completed',
      acceptedAt: hoursAgo(2),
      resumedAt: hoursAgo(1),
      completedAt: minutesAgo(5),
      updatedAt: minutesAgo(5),
    };
    const completed = describeWork({ handoff: done });
    expect(completed.steps.at(-1)).toMatchObject({ step: 'completed', source: 'reported by the agent' });
    expect(steps({ handoff: { ...sent, state: 'cancelled', updatedAt: hoursAgo(1) } })).toEqual(['sent', 'cancelled']);
    expect(steps({ handoff: { ...sent, state: 'declined', updatedAt: hoursAgo(1) } })).toEqual(['sent', 'declined']);
  });

  it('says whether a paired adapter reaches the project, and says nothing for a plain handoff', () => {
    expect(describeWork({ handoff: sent, hookWillAnnounce: true }).hook).toContain('can announce the work');
    expect(describeWork({ handoff: sent, hookWillAnnounce: true }).hook).toContain('does not record whether it did');
    expect(describeWork({ handoff: sent, hookWillAnnounce: false }).hook).toContain('No paired local adapter reaches this project');
    expect(describeWork({ handoff: { ...sent, kind: 'handoff' }, hookWillAnnounce: true }).hook).toBe('');
    expect(describeWork({ handoff: sent }).hook).toBe('');
  });
});


// ---------------------------------------------------------------------- pages

describe('the pages', () => {
  let srv: StartedServer;
  let dataDir: string;
  let owner: Jar;
  let member: Jar;
  let stranger: Jar;
  let teamId: string;
  let ownerId: string;
  let alphaId: string;
  let betaId: string;
  let sequence = 0;

  const CONNECTIONS = '/app/teams/fleet-works/connections';
  const ALPHA_CONNECTIONS = '/app/teams/fleet-works/projects/alpha-api/connections';
  const BETA_CONNECTIONS = '/app/teams/fleet-works/projects/beta-api/connections';
  const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#39;|&quot;/g, "'").replace(/\s+/g, ' ');
  /** The cells of the one table row that names this connection. */
  const rowOf = (html: string, name: string) =>
    html.split('<tr').find((part) => new RegExp(`class="name">[^<]*${name}`).test(part)) ?? '';

  async function seed(
    name: string,
    options: {
      projectId?: string | null;
      token?: Partial<typeof tokens.$inferInsert>;
      installation?: Partial<typeof agentInstallations.$inferInsert> | null;
      userId?: string;
    } = {},
  ) {
    sequence += 1;
    const projectId = options.projectId === undefined ? alphaId : options.projectId;
    const [token] = await srv.db
      .insert(tokens)
      .values({
        userId: options.userId ?? ownerId,
        name,
        scope: projectId ? 'project' : 'team',
        teamId,
        projectId,
        tokenHash: `seed-hash-${sequence}-${name}`,
        prefix: 'stma_seed',
        audience: `${srv.url}/mcp`,
        activatedAt: new Date(Date.now() - 3_600_000),
        expiresAt: new Date(Date.now() + 3_600_000),
        ...options.token,
      })
      .returning();
    const [installation] =
      options.installation === null
        ? []
        : await srv.db
            .insert(agentInstallations)
            .values({
              userId: options.userId ?? ownerId,
              tokenId: token!.id,
              name,
              deviceLabel: 'seed-mac',
              deviceFingerprint: `seed:${sequence}:${name}`,
              clientType: 'claude-code',
              capabilities: ['mcp', 'scoped-enrollment', 'oauth'],
              ...options.installation,
            })
            .returning();
    return { token: token!, installation };
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'stma-connection-state-'));
    srv = await startServer(
      loadEnv({ host: '127.0.0.1', port: 0, nodeEnv: 'test', devMode: true, databaseUrl: undefined, pgliteDir: dataDir }),
    );
    owner = await devLogin(srv.url, 'cs-owner');
    member = await devLogin(srv.url, 'cs-member');
    stranger = await devLogin(srv.url, 'cs-stranger');
    expect((await postForm(srv.url, owner, '/app/teams', { name: 'Fleet Works' })).status).toBe(302);
    const [team] = await srv.db.select().from(teams).where(eq(teams.slug, 'fleet-works'));
    teamId = team!.id;
    ownerId = team!.createdBy!;
    const made = async (name: string) =>
      (
        await srv.db
          .insert(projects)
          .values({ teamId, name, slug: name, repositoryIdentity: `github.com/example/${name}` })
          .returning()
      )[0]!.id;
    alphaId = await made('alpha-api');
    betaId = await made('beta-api');
    // A second person in the same workspace.
    expect((await postForm(srv.url, owner, '/app/teams/fleet-works/invites', {})).status).toBe(302);
    const people = await pageText(srv.url, owner, '/app/teams/fleet-works?tab=people');
    const code = /\/join\/([A-Za-z0-9_-]+)/.exec(people)?.[1];
    expect(code, 'invite code').toBeTruthy();
    expect((await postForm(srv.url, member, `/join/${code}`, {})).status).toBe(302);
  }, 120_000);

  afterAll(async () => {
    await srv?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('draws five separate facts for a connection in every state, and no word STMA cannot know', async () => {
    await srv.db.insert(oauthClients).values({
      id: 'cs-client',
      clientName: 'Claude Code (stma-fleet)',
      redirectUris: [LOOPBACK_CALLBACK],
    });
    await seed('seed-awaiting', {
      token: { activatedAt: null, setupExpiresAt: new Date(Date.now() + 600_000), lastUsedAt: null },
    });
    await seed('seed-expired', {
      token: { activatedAt: null, setupExpiresAt: new Date(Date.now() - 600_000), lastUsedAt: null },
    });
    await seed('seed-revoked', { token: { revokedAt: new Date() } });
    await seed('seed-legacy', {
      token: { audience: null, activatedAt: null, setupExpiresAt: null, expiresAt: null },
      installation: null,
    });
    const ok = await seed('seed-ok');
    await srv.db.insert(oauthRefreshTokens).values({
      tokenHash: 'seed-refresh-ok',
      tokenId: ok.token.id,
      clientId: 'cs-client',
      resource: `${srv.url}/mcp`,
      scope: 'stma',
    });
    await seed('seed-signin', { token: { expiresAt: new Date(Date.now() - 600_000) } });
    const terminal = await seed('seed-terminal', {
      token: { audience: null, expiresAt: null },
      installation: { capabilities: ['mcp', 'scoped-enrollment', 'terminal-connect'] },
    });

    const page = await pageText(srv.url, owner, ALPHA_CONNECTIONS);
    const awaiting = rowOf(page, 'seed-awaiting');
    for (const label of ['Authorization', 'Local adapter', 'Last contact', 'Task', 'Next step']) {
      expect(awaiting, label).toContain(`<dt>${label}</dt>`);
    }
    expect(text(awaiting)).toContain('awaiting client');
    expect(text(awaiting)).toContain('Reload Claude Code in that checkout once');
    expect(text(awaiting)).toContain('never recorded');
    expect(text(rowOf(page, 'seed-expired'))).toContain('setup expired');
    expect(text(rowOf(page, 'seed-expired'))).toContain('Create a fresh connection');
    expect(text(rowOf(page, 'seed-revoked'))).toContain('revoked');
    expect(text(rowOf(page, 'seed-revoked'))).toContain('Connect again');
    expect(text(rowOf(page, 'seed-legacy'))).toContain('legacy · unverified');
    expect(text(rowOf(page, 'seed-ok'))).toContain('authorized');
    expect(text(rowOf(page, 'seed-ok'))).toContain('last OAuth token issue');
    expect(text(rowOf(page, 'seed-signin'))).toContain('sign in again');
    expect(text(rowOf(page, 'seed-signin'))).toContain('claude mcp login NAME or codex mcp login NAME');
    expect(text(rowOf(page, 'seed-terminal'))).toContain('installed by stma connect');
    expect(text(rowOf(page, 'seed-terminal'))).toContain('local files are not checked from here');
    // What STMA cannot see is listed, in every row that has a checkout.
    expect(text(rowOf(page, 'seed-terminal'))).toContain('Unknown: whether hooks are present and trusted in the checkout');
    expect(text(rowOf(page, 'seed-terminal'))).toContain('Unknown: whether the client is open right now');

    // Not one of the table's rows says what STMA has no way to observe.
    const rows = page.slice(page.indexOf('<table class="tbl">', page.indexOf('Your connections here')));
    expect(text(rows)).not.toMatch(/\b(idle|online|offline|healthy)\b/i);
    expect(text(rows)).not.toMatch(/\brunning\b/i);

    // A run whose heartbeat stopped is overdue, not running; the network was cut.
    const [run] = await srv.db
      .insert(agentRuns)
      .values({
        installationId: terminal.installation!.id,
        teamId,
        projectId: alphaId,
        taskKey: 'PD-7 Cut cable',
        status: 'active',
      })
      .returning();
    const fresh = text(rowOf(await pageText(srv.url, owner, ALPHA_CONNECTIONS), 'seed-terminal'));
    expect(fresh).toContain('run reported');
    expect(fresh).toContain('PD-7 Cut cable');
    await srv.db
      .update(agentRuns)
      .set({ lastHeartbeatAt: new Date(Date.now() - 40 * 60_000) })
      .where(eq(agentRuns.id, run!.id));
    const stale = text(rowOf(await pageText(srv.url, owner, ALPHA_CONNECTIONS), 'seed-terminal'));
    expect(stale).toContain('heartbeat overdue');
    expect(stale).toContain('stopped reporting; its lease lapses or has lapsed');
    expect(stale).toContain('stma adapter doctor');
    expect(stale).not.toMatch(/\brunning\b/i);
  });

  it('shows a real OAuth connection as authorized by its first initialize, and revoking it ends its access', async () => {
    const connected = await connectOAuth(srv.url, owner, {
      clientName: 'Claude Code (stma-fleet-real)',
      callback: LOOPBACK_CALLBACK,
      state: 'real',
      fields: { name: 'real-agent', device: 'desk', access: `project:${alphaId}` },
    });
    const page = await pageText(srv.url, owner, ALPHA_CONNECTIONS);
    const row = text(rowOf(page, 'real-agent'));
    expect(row).toContain('authorized');
    expect(row).toContain("the client's first MCP initialize after OAuth sign-in");
    expect((await rpc(srv.url, connected.accessToken, 'tools/list')).status).toBe(200);

    const [token] = await srv.db.select().from(tokens).where(eq(tokens.name, 'desk · real-agent'));
    const revoked = await postForm(srv.url, owner, `/app/tokens/${token!.id}/revoke`, {
      back_team: 'fleet-works',
      back_project: 'alpha-api',
    });
    expect(revoked.status).toBe(302);
    const after = text(rowOf(await pageText(srv.url, owner, ALPHA_CONNECTIONS), 'real-agent'));
    expect(after).toContain('revoked');
    expect(after).toContain('Connect again');
    expect((await rpc(srv.url, connected.accessToken, 'tools/list')).status).toBe(401);
  });

  it("keeps a connection to its project, and one person's status from another", async () => {
    // Bound to alpha: absent from beta's connections page and from beta's roster.
    expect(rowOf(await pageText(srv.url, owner, BETA_CONNECTIONS), 'seed-ok')).toBe('');
    expect(rowOf(await pageText(srv.url, owner, ALPHA_CONNECTIONS), 'seed-ok')).not.toBe('');
    const betaRoster = await pageText(srv.url, owner, '/app/teams/fleet-works/projects/beta-api/agents');
    expect(betaRoster).not.toContain('seed-ok');
    const alphaRoster = await pageText(srv.url, owner, '/app/teams/fleet-works/projects/alpha-api/agents');
    expect(alphaRoster).toContain('seed-ok');
    // Nobody has a run for seed-ok: the roster says what it knows, not "idle".
    expect(alphaRoster).toContain('no run reported');
    expect(alphaRoster).not.toContain('>idle<');
    expect(text(alphaRoster)).toContain('Last contact');

    // A second person sees the agents, and none of the owner's authorization,
    // adapter or next-step fields, and none of the owner's connection list.
    const roster = await pageText(srv.url, member, '/app/teams/fleet-works/agents');
    expect(roster).toContain('seed-ok');
    for (const secret of ['Authorization', 'Next step', 'Local adapter', 'awaiting client', 'sign in again', 'first MCP initialize']) {
      expect(roster, secret).not.toContain(secret);
    }
    const theirs = await pageText(srv.url, member, CONNECTIONS);
    expect(theirs).not.toContain('seed-ok');
    expect(theirs).not.toContain('seed-awaiting');
    expect(theirs).toContain('No connections here yet');
  });

  it('tells a non-member nothing', async () => {
    expect((await getPage(srv.url, stranger, CONNECTIONS)).status).toBe(404);
    expect((await getPage(srv.url, stranger, ALPHA_CONNECTIONS)).status).toBe(404);
    expect((await getPage(srv.url, stranger, '/app/teams/fleet-works/agents')).status).toBe(404);
    expect((await getPage(srv.url, stranger, '/app/teams/fleet-works/projects/alpha-api/agents')).status).toBe(404);
  });

  it('reads thirty connections with the same number of queries as three', async () => {
    const bulk: string[] = [];
    for (let i = 0; i < 30; i++) {
      const row = await seed(`bulk-${i}`, { projectId: betaId });
      await srv.db.insert(oauthRefreshTokens).values({
        tokenHash: `bulk-refresh-${i}`,
        tokenId: row.token.id,
        clientId: 'cs-client',
        resource: `${srv.url}/mcp`,
        scope: 'stma',
      });
      bulk.push(row.token.id);
    }
    const list = (await srv.db.select().from(tokens).where(eq(tokens.userId, ownerId))).filter((t) => bulk.includes(t.id));
    expect(list).toHaveLength(30);
    const counted = (db: Db) => {
      const calls = { n: 0 };
      const proxy = new Proxy(db, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop === 'select' && typeof value === 'function') {
            return (...args: unknown[]) => {
              calls.n += 1;
              return value.apply(target, args);
            };
          }
          return value;
        },
      });
      return { proxy, calls };
    };
    const context = {
      teamSlug: 'fleet-works',
      baseUrl: srv.url,
      leases: { activeMinutes: 5, waitingMinutes: 30 },
      projectsById: new Map([[betaId, { slug: 'beta-api', name: 'beta-api' }]]),
    };
    const few = counted(srv.db);
    const small = await connectionStates(few.proxy, list.slice(0, 3), context);
    const many = counted(srv.db);
    const large = await connectionStates(many.proxy, list, context);
    expect(small.size).toBe(3);
    expect(large.size).toBe(30);
    expect(many.calls.n).toBe(few.calls.n);
    expect(many.calls.n).toBeLessThanOrEqual(5);
  });

  it('labels the assigned work on the project page with only what was recorded', async () => {
    const agent = await seed('lifecycle-agent', { projectId: alphaId });
    const assigned = await postForm(srv.url, owner, '/app/teams/fleet-works/projects/alpha-api/assign', {
      agent: agent.installation!.id,
      task: 'PD-31 Label printer',
      brief: 'Make the label printer retry once.',
      steps: '',
      branch: '',
    });
    expect(assigned.status).toBe(302);
    const page = await pageText(srv.url, owner, '/app/teams/fleet-works/projects/alpha-api');
    expect(page).toContain('sent, not yet accepted');
    expect(page).not.toContain('waiting for the agent');
    expect(page).not.toContain('— reported');
    const card = text(page.slice(page.indexOf('id="assigned-work"')));
    expect(card).toContain('Sent');
    expect(card).not.toContain('Accepted by the agent');
    expect(card).toContain("Not observed: whether the agent's prompt hook announced this");
    expect(card).toContain('STMA starts no local process');
    // No adapter is paired, so the sentence says the agent finds it in its inbox.
    expect(card).toContain('No paired local adapter reaches this project');
  });

  it('does not call sent work "Waiting for a person" because its target has an unrelated waiting run', async () => {
    const agent = await seed('lifecycle-busy', { projectId: alphaId });
    // The target is blocked on something else entirely.
    await srv.db.insert(agentRuns).values({
      installationId: agent.installation!.id,
      teamId,
      projectId: alphaId,
      taskKey: 'PD-99 Something else',
      status: 'blocked',
    });
    expect(
      (
        await postForm(srv.url, owner, '/app/teams/fleet-works/projects/alpha-api/assign', {
          agent: agent.installation!.id,
          task: 'PD-32 Barcode retry',
          brief: 'Retry the barcode scan once.',
          steps: '',
          branch: '',
        })
      ).status,
    ).toBe(302);
    const rowFor = (html: string) => {
      // Newest first: this row ends where the earlier assignment's row begins.
      const start = html.indexOf('PD-32');
      const end = html.indexOf('PD-31', start);
      return text(html.slice(start, end > start ? end : start + 2500));
    };
    let page = await pageText(srv.url, owner, '/app/teams/fleet-works/projects/alpha-api');
    expect(rowFor(page)).toContain('Sent');
    expect(rowFor(page)).not.toContain('Waiting for a person');
    // Hook sentence is printed while the work is unaccepted ...
    expect(rowFor(page)).toContain('No paired local adapter reaches this project');

    // Accepted, but no run was named for this work: still not proven to be waiting.
    const [offer] = await srv.db.select().from(handoffs).where(eq(handoffs.targetInstallationId, agent.installation!.id));
    await srv.db
      .update(handoffs)
      .set({ state: 'accepted', acceptedAt: new Date(), installationId: agent.installation!.id, acceptedBy: ownerId, updatedAt: new Date() })
      .where(eq(handoffs.id, offer!.id));
    page = await pageText(srv.url, owner, '/app/teams/fleet-works/projects/alpha-api');
    expect(rowFor(page)).toContain('Accepted by the agent');
    expect(rowFor(page)).not.toContain('Waiting for a person');
    // ... and gone once someone accepted it, since it is a statement about the future.
    expect(rowFor(page)).not.toContain('No paired local adapter reaches this project');

    // A run named for this very work that reports blocked is evidence.
    const [run] = await srv.db.select().from(agentRuns).where(eq(agentRuns.installationId, agent.installation!.id));
    await srv.db.insert(agentEvents).values({
      runId: run!.id,
      type: 'run_named',
      detail: { name: 'PD-32 Barcode retry', sessionId: offer!.sessionId },
    });
    page = await pageText(srv.url, owner, '/app/teams/fleet-works/projects/alpha-api');
    expect(rowFor(page)).toContain('Waiting for a person');
    expect(rowFor(page)).not.toContain('Started');
  });

  it('never shows a project name as a command: a name with a quote gets a sentence, not a Copy button', async () => {
    const hostile = `x'; Write-Output INJECTED; '`;
    const [project] = await srv.db
      .insert(projects)
      .values({ teamId, name: hostile, slug: 'hostile-proj', repositoryIdentity: 'github.com/example/hostile' })
      .returning();
    await seed('hostile-agent', { projectId: project!.id });
    const page = await pageText(srv.url, owner, '/app/teams/fleet-works/projects/hostile-proj/connections');
    expect(rowOf(page, 'hostile-agent')).not.toBe('');
    expect(text(rowOf(page, 'hostile-agent'))).toContain('cannot carry safely');
    expect(page).not.toContain('stma adapter activate --target');
    expect(page).not.toMatch(/data-copy="[^"]*adapter activate/);
    expect(text(page)).toContain('so no codex command is shown');
    // A plain name in the same workspace still gets its command.
    const plain = await pageText(srv.url, owner, ALPHA_CONNECTIONS);
    expect(plain).toContain('stma adapter activate --target claude-code --team fleet-works --project alpha-api');
  });

  it('prints a registration as "never recorded" on the roster, and a real request as a time', async () => {
    const silent = await seed('roster-silent', { projectId: alphaId });
    const contacted = await seed('roster-contacted', { projectId: alphaId });
    await srv.db
      .update(agentInstallations)
      .set({ createdAt: new Date(Date.now() - 3_600_000), lastSeenAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(agentInstallations.id, contacted.installation!.id));
    expect(silent.installation).toBeTruthy();
    for (const path of ['/app/teams/fleet-works/projects/alpha-api/agents', '/app/teams/fleet-works/agents']) {
      const roster = await pageText(srv.url, owner, path);
      expect(text(rowOf(roster, 'roster-silent')), path).toContain('never recorded');
      expect(text(rowOf(roster, 'roster-contacted')), path).toContain('5 min ago');
      expect(text(rowOf(roster, 'roster-contacted')), path).not.toContain('never recorded');
    }
    const map = await pageText(srv.url, owner, '/app/agents?tab=identities');
    expect(text(rowOf(map, 'roster-silent'))).toContain('never recorded');
    expect(text(rowOf(map, 'roster-contacted'))).toContain('5 min ago');
  });
});
