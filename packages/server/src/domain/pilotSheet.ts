import { and, desc, eq, gte, inArray, or } from 'drizzle-orm';
import type { Db } from '../db';
import {
  agentInstallations,
  agentRuns,
  debugSessions,
  handoffs,
  launchAttempts,
  memberships,
  messages,
  projects,
  runCheckpoints,
  teams,
  tokens,
  users,
} from '../db/schema';
import type { Env } from '../env';
import { isAdminUser } from '../lib/admin';
import { membershipHistory } from '../lib/memberships';
import { providerFactsForCheckpoint } from './evidence';
import { providerName } from './evidenceSummary';
import { savingsLedger, type SavingsLedger } from './savings';

/**
 * One pilot workspace, read for the operator's weekly report.
 *
 * A pilot is judged on a chain that runs through one workspace over weeks:
 * connected, a first real result, a second use nobody prompted, four weeks of
 * use, payment, a second person or project. The operator console answered
 * almost none of it per workspace. `/admin/usage` totals the whole instance and
 * computes per-workspace rows only to add them up; `/admin/teams/:id` shows
 * members, projects and connections and nothing that happened. So the weekly
 * page a pilot is supposed to produce needed SQL, which in practice means it
 * would not be written.
 *
 * This is a reader over what is already stored, and it writes nothing. It keeps
 * three boundaries the pilot kit depends on:
 *
 *   - The operator's own hand is marked. A handoff the operator dispatched, or
 *     a run on the operator's agent, is not the participant using the product,
 *     and an "unprompted second use" cannot be read off a list that mixes them.
 *   - A handoff and an assignment are different things: one is work moving
 *     between agents with a commit, the other a lead starting somebody.
 *     `/admin/usage` counted both as handoffs.
 *   - What the database cannot know is listed rather than left out: reminders,
 *     the reviewer's decision, how much re-explaining was needed, support
 *     minutes and money. Those belong in the pilot record, and a sheet that
 *     omitted them silently would read as if they were zero.
 *
 * Read by `/admin` only, so `acceptance/tiers.json` lists it under consoleOnly.
 */

const DAY = 24 * 60 * 60 * 1000;
export const PILOT_DEFAULT_DAYS = 28;
/** A pilot's observation window is weeks, not a history scan; runs and handoffs are never swept. */
export const PILOT_MAX_DAYS = 182;
const WORK_ROWS = 50;
const DELIVERY_ROWS = 25;
const RUN_SCAN = 2000;
const LIVE = ['starting', 'active', 'waiting', 'blocked'];

/**
 * `?since=YYYY-MM-DD` (the pilot's first day), clamped; otherwise the four
 * weeks ending today. Every start is a UTC midnight, so the weekly rows are
 * whole days and only the last one — the week today is in — is partial; a start
 * taken from the clock left a trailing week a few seconds long.
 */
export function pilotWindow(since: string | undefined, now = new Date()): { since: Date; days: number } {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const floor = new Date(today - (PILOT_MAX_DAYS - 1) * DAY);
  const parsed = since && /^\d{4}-\d{2}-\d{2}$/.test(since) ? new Date(`${since}T00:00:00.000Z`) : null;
  const start =
    parsed && !Number.isNaN(parsed.getTime()) && parsed < now
      ? parsed < floor
        ? floor
        : parsed
      : new Date(today - (PILOT_DEFAULT_DAYS - 1) * DAY);
  return { since: start, days: Math.max(1, Math.ceil((now.getTime() - start.getTime()) / DAY)) };
}

export interface PilotWork {
  sessionId: string;
  kind: string;
  title: string;
  createdAt: Date;
  from: string;
  fromOperator: boolean;
  to: string | null;
  state: string;
  acceptedAt: Date | null;
  resumedAt: Date | null;
  completedAt: Date | null;
  /** A code handoff that reached resume: STMA refused every resume not on its commit. */
  verifiedResume: boolean;
  checkpoint: { sha: string; failed: string[]; reported: number } | null;
  /** Messages a person typed in the browser: help the participant or the operator gave. */
  browserReplies: number;
}

export interface PilotDelivery {
  runId: string;
  task: string | null;
  agent: string;
  owner: string;
  operator: boolean;
  kind: string;
  commitSha: string;
  clean: boolean;
  failed: string[];
  passed: number;
  /** "GitHub workflow success", one per current provider subject at this exact commit. */
  provider: string[];
  repositoryMatches: boolean;
  at: Date;
}

export interface PilotWeek {
  from: Date;
  to: Date;
  runs: number;
  operatorRuns: number;
  people: number;
  agents: number;
  handoffs: number;
  assignments: number;
  resumed: number;
  verifiedResumes: number;
  completed: number;
}

export interface PilotSheet {
  team: { id: string; name: string; slug: string; createdAt: Date };
  window: { since: Date; until: Date; days: number };
  people: { username: string; role: string; joinedAt: Date; operator: boolean }[];
  connections: {
    name: string;
    client: string;
    device: string | null;
    owner: string;
    operator: boolean;
    createdAt: Date;
    lastUsedAt: Date | null;
    revoked: boolean;
  }[];
  launches: {
    by: string;
    intent: string;
    createdAt: Date;
    firstConnectedAt: Date | null;
    secondConnectedAt: Date | null;
    exchangeConfirmedAt: Date | null;
    firstRealResultAt: Date | null;
  }[];
  work: PilotWork[];
  workTotals: {
    handoffs: number;
    assignments: number;
    byOperator: number;
    resumed: number;
    verifiedResumes: number;
    completed: number;
    cancelledOrDeclined: number;
  };
  deliveries: PilotDelivery[];
  warnings: SavingsLedger;
  weeks: PilotWeek[];
  expansion: {
    access: { at: Date; action: string; who: string; role: string | null; source: string }[];
    projects: { name: string; createdAt: Date }[];
  };
  runsScanned: number;
  runsTruncated: boolean;
}

/** Things a pilot is judged on that STMA does not see. Named on the page and in the export. */
export const PILOT_NOT_RECORDED = [
  'Founder reminders, and whether a use was prompted: needed to call a second use unprompted.',
  'Whether a need arose at all: NO_OPPORTUNITY and DID_NOT_RETURN look identical here.',
  "The reviewer's decision and which fact changed it; the evidence pack records no human decision.",
  'How much the receiver had to be told again, and help given outside the product.',
  'Support minutes, by kind.',
  'The commercial offer shown, and whether money was collected (Stripe status is on /admin/billing).',
  'Consent to quote the participant.',
] as const;

export async function pilotSheet(
  db: Db,
  env: Pick<Env, 'adminUsernames' | 'adminEmails'>,
  teamId: string,
  window: { since: Date; days: number },
  now = new Date(),
): Promise<PilotSheet | null> {
  const [team] = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
  if (!team) return null;
  const since = window.since;

  const memberRows = await db
    .select({ user: users, role: memberships.role, joinedAt: memberships.createdAt })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.teamId, teamId))
    .orderBy(users.username);
  const operatorIds = new Set(
    memberRows.filter((row) => isAdminUser(env, row.user)).map((row) => row.user.id),
  );
  // An operator may act in a workspace without being a member of it (an
  // assignment through /admin, a removed account); ask the users table too.
  const isOperator = async (ids: string[]) => {
    const unknown = [...new Set(ids)].filter((id) => !memberRows.some((row) => row.user.id === id));
    if (unknown.length > 0) {
      const extra = await db.select().from(users).where(inArray(users.id, unknown));
      for (const user of extra) if (isAdminUser(env, user)) operatorIds.add(user.id);
    }
  };

  const connectionRows = await db
    .select({
      name: tokens.name,
      installationName: agentInstallations.name,
      client: agentInstallations.clientType,
      device: agentInstallations.deviceLabel,
      owner: users.username,
      ownerId: users.id,
      createdAt: tokens.createdAt,
      lastUsedAt: tokens.lastUsedAt,
      tokenRevokedAt: tokens.revokedAt,
      installationRevokedAt: agentInstallations.revokedAt,
    })
    .from(tokens)
    .innerJoin(users, eq(users.id, tokens.userId))
    .leftJoin(agentInstallations, eq(agentInstallations.tokenId, tokens.id))
    .where(eq(tokens.teamId, teamId))
    .orderBy(desc(tokens.createdAt))
    .limit(50);

  const launchRows = await db
    .select({ launch: launchAttempts, by: users.username })
    .from(launchAttempts)
    .innerJoin(users, eq(users.id, launchAttempts.userId))
    .where(eq(launchAttempts.teamId, teamId))
    .orderBy(desc(launchAttempts.createdAt))
    .limit(20);

  // Work: everything created in the window, plus anything that moved in it.
  const workRows = await db
    .select({
      offer: handoffs,
      title: debugSessions.title,
      from: users.username,
      checkpointSha: runCheckpoints.commitSha,
      checkpointTests: runCheckpoints.tests,
    })
    .from(handoffs)
    .innerJoin(debugSessions, eq(debugSessions.id, handoffs.sessionId))
    .innerJoin(users, eq(users.id, handoffs.offeredBy))
    .leftJoin(runCheckpoints, eq(runCheckpoints.id, handoffs.checkpointId))
    .where(
      and(
        eq(debugSessions.teamId, teamId),
        or(gte(handoffs.createdAt, since), gte(handoffs.updatedAt, since)),
      ),
    )
    .orderBy(desc(handoffs.createdAt))
    .limit(WORK_ROWS);
  await isOperator(workRows.map((row) => row.offer.offeredBy));
  const targetIds = [
    ...new Set(
      workRows.flatMap((row) => [row.offer.targetInstallationId, row.offer.installationId]).filter((id): id is string => Boolean(id)),
    ),
  ];
  const targets = targetIds.length
    ? await db
        .select({ id: agentInstallations.id, name: agentInstallations.name, device: agentInstallations.deviceLabel })
        .from(agentInstallations)
        .where(inArray(agentInstallations.id, targetIds))
    : [];
  const targetName = new Map(targets.map((row) => [row.id, `${row.name}${row.device ? ` on ${row.device}` : ''}`]));
  const targetUserIds = [...new Set(workRows.map((row) => row.offer.targetUserId).filter((id): id is string => Boolean(id)))];
  const targetUsers = targetUserIds.length
    ? await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, targetUserIds))
    : [];
  const userName = new Map(targetUsers.map((row) => [row.id, row.username]));
  const sessionIds = workRows.map((row) => row.offer.sessionId);
  const browserRows = sessionIds.length
    ? await db
        .select({ sessionId: messages.sessionId })
        .from(messages)
        .where(and(inArray(messages.sessionId, sessionIds), eq(messages.via, 'web')))
    : [];
  const browserReplies = new Map<string, number>();
  for (const row of browserRows) browserReplies.set(row.sessionId, (browserReplies.get(row.sessionId) ?? 0) + 1);

  const work: PilotWork[] = workRows.map((row) => {
    const tests = row.checkpointTests ?? [];
    return {
      sessionId: row.offer.sessionId,
      kind: row.offer.kind,
      title: row.title,
      createdAt: row.offer.createdAt,
      from: row.from,
      fromOperator: operatorIds.has(row.offer.offeredBy),
      to:
        (row.offer.targetInstallationId && targetName.get(row.offer.targetInstallationId)) ??
        (row.offer.installationId && targetName.get(row.offer.installationId)) ??
        (row.offer.targetUserId && userName.get(row.offer.targetUserId)) ??
        null,
      state: row.offer.state,
      acceptedAt: row.offer.acceptedAt,
      resumedAt: row.offer.resumedAt,
      completedAt: row.offer.completedAt,
      verifiedResume: Boolean(row.offer.checkpointId && row.offer.resumedAt),
      checkpoint: row.checkpointSha
        ? {
            sha: row.checkpointSha,
            failed: tests.filter((test) => test.state === 'failed').map((test) => test.name),
            reported: tests.length,
          }
        : null,
      browserReplies: browserReplies.get(row.offer.sessionId) ?? 0,
    };
  });
  const inWindow = work.filter((row) => row.createdAt >= since);

  // Delivery: the newest delivery/tested checkpoint of each run that reported one in the window.
  const checkpointRows = await db
    .select({
      checkpoint: runCheckpoints,
      run: agentRuns,
      agent: agentInstallations.name,
      ownerId: agentInstallations.userId,
      owner: users.username,
      projectRepositoryIdentity: projects.repositoryIdentity,
    })
    .from(runCheckpoints)
    .innerJoin(agentRuns, eq(agentRuns.id, runCheckpoints.runId))
    .innerJoin(agentInstallations, eq(agentInstallations.id, agentRuns.installationId))
    .innerJoin(users, eq(users.id, agentInstallations.userId))
    .leftJoin(projects, eq(projects.id, agentRuns.projectId))
    .where(
      and(
        eq(runCheckpoints.teamId, teamId),
        inArray(runCheckpoints.kind, ['delivery', 'tested']),
        gte(runCheckpoints.createdAt, since),
      ),
    )
    .orderBy(desc(runCheckpoints.createdAt))
    .limit(DELIVERY_ROWS * 4);
  await isOperator(checkpointRows.map((row) => row.ownerId));
  const newestPerRun = new Map<string, (typeof checkpointRows)[number]>();
  for (const row of checkpointRows) if (!newestPerRun.has(row.run.id)) newestPerRun.set(row.run.id, row);
  const deliveries: PilotDelivery[] = [];
  for (const row of [...newestPerRun.values()].slice(0, DELIVERY_ROWS)) {
    const facts = await providerFactsForCheckpoint(db, row.run, row.projectRepositoryIdentity, row.checkpoint);
    deliveries.push({
      runId: row.run.id,
      task: row.run.taskKey ?? row.run.intent,
      agent: row.agent,
      owner: row.owner,
      operator: operatorIds.has(row.ownerId),
      kind: row.checkpoint.kind,
      commitSha: row.checkpoint.commitSha,
      clean: row.checkpoint.worktreeClean,
      failed: row.checkpoint.tests.filter((test) => test.state === 'failed').map((test) => test.name),
      passed: row.checkpoint.tests.filter((test) => test.state === 'passed').length,
      provider: facts.facts.map(
        (fact) => `${providerName(fact.provider)} ${fact.fact.kind === 'pull_request' ? 'pull request' : 'workflow'} ${fact.fact.state}`,
      ),
      repositoryMatches: facts.repositoryMatches,
      at: row.checkpoint.createdAt,
    });
  }

  // The weekly series is read from runs and handoffs, which no sweep removes.
  const runRows = await db
    .select({
      startedAt: agentRuns.startedAt,
      lastHeartbeatAt: agentRuns.lastHeartbeatAt,
      installationId: agentRuns.installationId,
      userId: agentInstallations.userId,
    })
    .from(agentRuns)
    .innerJoin(agentInstallations, eq(agentInstallations.id, agentRuns.installationId))
    .where(and(eq(agentRuns.teamId, teamId), gte(agentRuns.lastHeartbeatAt, since)))
    .orderBy(desc(agentRuns.startedAt))
    .limit(RUN_SCAN + 1);
  const runsTruncated = runRows.length > RUN_SCAN;
  const runs = runRows.slice(0, RUN_SCAN);
  await isOperator(runs.map((row) => row.userId));
  const weeks: PilotWeek[] = [];
  for (let from = since.getTime(); from < now.getTime(); from += 7 * DAY) {
    const to = Math.min(from + 7 * DAY, now.getTime());
    const within = (at: Date | null) => Boolean(at && at.getTime() >= from && at.getTime() < to);
    const started = runs.filter((row) => within(row.startedAt));
    const active = runs.filter(
      (row) => row.startedAt.getTime() < to && row.lastHeartbeatAt.getTime() >= from,
    );
    const participant = active.filter((row) => !operatorIds.has(row.userId));
    weeks.push({
      from: new Date(from),
      to: new Date(to),
      runs: started.filter((row) => !operatorIds.has(row.userId)).length,
      operatorRuns: started.filter((row) => operatorIds.has(row.userId)).length,
      people: new Set(participant.map((row) => row.userId)).size,
      agents: new Set(participant.map((row) => row.installationId)).size,
      handoffs: work.filter((row) => row.kind === 'handoff' && within(row.createdAt)).length,
      assignments: work.filter((row) => row.kind === 'assignment' && within(row.createdAt)).length,
      resumed: work.filter((row) => within(row.resumedAt)).length,
      verifiedResumes: work.filter((row) => row.verifiedResume && within(row.resumedAt)).length,
      completed: work.filter((row) => within(row.completedAt)).length,
    });
  }

  const access = (await membershipHistory(db, { teamId, limit: 200 }))
    .filter((row) => row.at >= since)
    .map((row) => ({
      at: row.at,
      action: row.action,
      who: row.subjectUsername ?? row.subjectLabel ?? 'former account',
      role: row.nextRole ?? row.previousRole ?? null,
      source: row.source,
    }));
  const newProjects = await db
    .select({ name: projects.name, createdAt: projects.createdAt })
    .from(projects)
    .where(and(eq(projects.teamId, teamId), gte(projects.createdAt, since)))
    .orderBy(projects.createdAt);

  return {
    team: { id: team.id, name: team.name, slug: team.slug, createdAt: team.createdAt },
    window: { since, until: now, days: window.days },
    people: memberRows.map((row) => ({
      username: row.user.username,
      role: row.role,
      joinedAt: row.joinedAt,
      operator: operatorIds.has(row.user.id),
    })),
    connections: connectionRows.map((row) => ({
      name: row.installationName ?? row.name,
      client: row.client ?? 'credential',
      device: row.device,
      owner: row.owner,
      operator: operatorIds.has(row.ownerId),
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      revoked: Boolean(row.tokenRevokedAt || row.installationRevokedAt),
    })),
    launches: launchRows.map((row) => ({
      by: row.by,
      intent: row.launch.intent,
      createdAt: row.launch.createdAt,
      firstConnectedAt: row.launch.firstConnectedAt,
      secondConnectedAt: row.launch.secondConnectedAt,
      exchangeConfirmedAt: row.launch.exchangeConfirmedAt,
      firstRealResultAt: row.launch.firstRealResultAt,
    })),
    work,
    workTotals: {
      handoffs: inWindow.filter((row) => row.kind === 'handoff').length,
      assignments: inWindow.filter((row) => row.kind === 'assignment').length,
      byOperator: inWindow.filter((row) => row.fromOperator).length,
      resumed: work.filter((row) => row.resumedAt && row.resumedAt >= since).length,
      verifiedResumes: work.filter((row) => row.verifiedResume && row.resumedAt! >= since).length,
      completed: work.filter((row) => row.completedAt && row.completedAt >= since).length,
      cancelledOrDeclined: inWindow.filter((row) => row.state === 'cancelled' || row.state === 'declined').length,
    },
    deliveries,
    warnings: await savingsLedger(db, teamId, window.days),
    weeks,
    expansion: { access, projects: newProjects },
    runsScanned: runs.length,
    runsTruncated,
  };
}

const day = (at: Date | null | undefined) => (at ? at.toISOString().slice(0, 10) : '-');
const stamp = (at: Date | null | undefined) => (at ? at.toISOString().slice(0, 16).replace('T', ' ') : '-');
const cell = (value: string | null | undefined) => (value ?? '-').replace(/\|/g, '/').replace(/\s+/g, ' ').trim() || '-';

/**
 * The sheet as Markdown, for the weekly one-page report. The report adds what
 * only people know; this is the half the database can answer, with the other
 * half named at the end rather than implied.
 */
export function pilotSheetMarkdown(sheet: PilotSheet, plan: string): string {
  const out: string[] = [];
  const liveRuns = sheet.weeks.reduce((sum, week) => sum + week.runs, 0);
  out.push(`# Pilot sheet: ${sheet.team.name} (${sheet.team.slug})`);
  out.push('');
  out.push(
    `Window ${day(sheet.window.since)} → ${day(sheet.window.until)} (${sheet.window.days} days) · plan ${plan} · workspace created ${day(sheet.team.createdAt)}`,
  );
  out.push('');
  out.push('## People and connections');
  for (const person of sheet.people)
    out.push(`- ${person.username}: ${person.role}, joined ${day(person.joinedAt)}${person.operator ? ' · **operator**' : ''}`);
  for (const connection of sheet.connections)
    out.push(
      `- Agent ${cell(connection.name)} (${cell(connection.client)}${connection.device ? `, ${cell(connection.device)}` : ''}) for ${connection.owner}${connection.operator ? ' (operator)' : ''}, connected ${day(connection.createdAt)}, last used ${day(connection.lastUsedAt)}${connection.revoked ? ', revoked' : ''}`,
    );
  for (const launch of sheet.launches)
    out.push(
      `- Connection test by ${launch.by} (${launch.intent}): opened ${day(launch.createdAt)}, second agent ${day(launch.secondConnectedAt)}, exchange ${day(launch.exchangeConfirmedAt)}, first real result ${day(launch.firstRealResultAt)}`,
    );
  out.push('');
  out.push('## Work handed over and assigned');
  const t = sheet.workTotals;
  out.push(
    `In the window: ${t.handoffs} handoff(s), ${t.assignments} assignment(s) (${t.byOperator} dispatched by the operator); ${t.resumed} resumed, ${t.verifiedResumes} of them on the handed-over commit; ${t.completed} reported complete; ${t.cancelledOrDeclined} cancelled or declined.`,
  );
  out.push('');
  if (sheet.work.length > 0) {
    out.push('| Created | Kind | Title | From | To | Commit | State | Resumed | Completed | Browser replies |');
    out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const row of sheet.work)
      out.push(
        `| ${stamp(row.createdAt)} | ${row.kind} | ${cell(row.title)} | ${cell(row.from)}${row.fromOperator ? ' (operator)' : ''} | ${cell(row.to)} | ${row.checkpoint ? `${row.checkpoint.sha.slice(0, 12)}${row.checkpoint.failed.length ? ` (failing: ${cell(row.checkpoint.failed.join(', '))})` : ''}` : '-'} | ${row.state} | ${row.resumedAt ? `${stamp(row.resumedAt)}${row.verifiedResume ? ' ✓ commit' : ''}` : '-'} | ${stamp(row.completedAt)} | ${row.browserReplies} |`,
      );
    out.push('');
  }
  out.push('## Deliveries');
  if (sheet.deliveries.length === 0) out.push('- No delivery or tested checkpoint was reported in the window.');
  for (const row of sheet.deliveries)
    out.push(
      `- ${stamp(row.at)} · ${cell(row.task ?? 'untitled run')} · ${row.agent} for ${row.owner}${row.operator ? ' (operator)' : ''} · ${row.kind} ${row.commitSha.slice(0, 12)}${row.clean ? '' : ' (dirty)'} · tests: ${row.failed.length ? `failing ${cell(row.failed.join(', '))}` : `${row.passed} passed`} (agent's report) · provider: ${row.provider.length ? row.provider.join(', ') : row.repositoryMatches ? 'no observation of this commit' : 'repository does not match the project'}`,
    );
  out.push('');
  out.push('## Warnings people answered');
  const w = sheet.warnings;
  out.push(
    `${w.observedTotal} moment(s) observed; ${w.answered} answered, ${w.confirmed} helpful and changed behaviour, ${w.rejected} not helpful; ${w.minutesSaved} minute(s) reported saved by those who confirmed.`,
  );
  out.push('');
  out.push('## Weekly');
  out.push('| Week | Runs (participants) | Runs (operator) | People | Agents | Handoffs | Assignments | Resumed (on commit) | Completed |');
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const week of sheet.weeks)
    out.push(
      `| ${day(week.from)} | ${week.runs} | ${week.operatorRuns} | ${week.people} | ${week.agents} | ${week.handoffs} | ${week.assignments} | ${week.resumed} (${week.verifiedResumes}) | ${week.completed} |`,
    );
  if (sheet.runsTruncated) out.push(`Only the newest ${sheet.runsScanned} runs were read; older weeks may be undercounted.`);
  out.push('');
  out.push('## New people and projects');
  if (sheet.expansion.access.length === 0 && sheet.expansion.projects.length === 0)
    out.push('- None in the window.');
  for (const row of sheet.expansion.access)
    out.push(`- ${day(row.at)} · ${row.action} · ${row.who}${row.role ? ` (${row.role})` : ''} · ${row.source}`);
  for (const row of sheet.expansion.projects) out.push(`- ${day(row.createdAt)} · project ${cell(row.name)} created`);
  out.push('');
  out.push('## Not recorded here: write these in the pilot record');
  for (const item of PILOT_NOT_RECORDED) out.push(`- ${item}`);
  out.push('');
  out.push(
    `_Runs, handoffs and checkpoints are never swept; "complete" is the agent's report and provider lines are the provider's observation at the exact commit. ${liveRuns} participant run(s) started in the window._`,
  );
  return `${out.join('\n')}\n`;
}
