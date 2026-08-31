import {
  AGENT_ROLES,
  CLAIM_ACCESS_MODES,
  CLAIM_RESOURCE_TYPES,
  QUOTA_CRITICAL_PCT,
  QUOTA_SOURCES,
  QUOTA_WARNING_PCT,
  snapshotSchema,
  type AgentRole,
  type WorkClaim,
} from '@bridge/shared';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db';
import {
  agentInstallations,
  agentRuns,
  debugSessions,
  messages,
  projects,
  teams,
  users,
} from '../db/schema';
import {
  addAgentEvent,
  claimsForRuns,
  duplicateWork,
  staleGroundFor,
  finishAgentRun,
  heartbeatAgentRun,
  recordRunCost,
  registerAgent,
  runForOwner,
  startAgentRun,
} from '../domain/agents';
import { activeFlowFor, flowBrief, parseFlowDocument, pipelinePath } from '../domain/delivery';
import { environmentPreflight, preflightSummary, recordEnvironmentCheck } from '../domain/environments';
import { commentOnRunIssue, githubForTeam, jiraForTeam } from '../domain/integrations';
import { effectivePolicy, recordPolicyReceipt } from '../domain/policies';
import { getIssue, listOpenIssues } from '../lib/github';
import { getJiraIssue } from '../lib/jira';
import type { Env } from '../env';
import { notifyHandoff } from '../lib/notifications';
import { notifyTeam } from '../lib/notify';
import { MONTH_MS, hitCounter } from '../lib/counters';
import { planLimits } from '../lib/entitlements';
import { findOrCreateProject } from '../lib/projects';
import { redactSecrets } from '../lib/redact';
import { track } from '../lib/track';
import type { Token, User } from '../types';
import { approvalsNeeded, budgetVerdict, findDuplicates, flowAdvice, issueFromTaskKey } from '@bridge/shared';
import { evidenceForRun } from '../domain/evidence';
import { err, failed, requireFeature, resolveTeam, text } from './shared';

/**
 * The fleet half of STMA, over MCP.
 *
 * Until these existed the split ran along the wrong line: everything an agent
 * could reach without installing anything (snapshots, sessions, announcements)
 * was the free half, and everything the product actually charges for (runs,
 * claims, conflicts, policy, preflight) needed a CLI and native hooks. The hook
 * was supposed to be the wedge into the paid core; instead it stopped at the
 * door. These tools put the same domain functions the control API uses behind
 * the transport every agent already speaks.
 *
 * The one thing an MCP client does not have is a CLI-managed installation id.
 * It does not need one: a personal access token is already issued per machine,
 * so the token IS the device. `installationFor` makes that mapping explicit
 * rather than asking an agent to invent a fingerprint.
 */

const claimSchema = z.object({
  type: z.enum(CLAIM_RESOURCE_TYPES).describe('What kind of thing you are claiming.'),
  key: z.string().min(1).max(300).describe('Path, component, migration or contract identifier.'),
  access: z.enum(CLAIM_ACCESS_MODES).default('write').describe('write (default) or read.'),
});

const toWorkClaims = (scope: Array<z.infer<typeof claimSchema>> | undefined): WorkClaim[] =>
  (scope ?? []).map((c) => ({ resourceType: c.type, resourceKey: c.key, access: c.access }));

/** Human-readable collision lines, so the agent does not have to parse a graph. */
const describeConflicts = (conflicts: Array<{
  severity: string;
  reason: string;
  current: { resourceKey: string; resourceType: string };
  existing: { owner: string; agentName: string; resourceKey: string; taskKey?: string | null };
}>) =>
  conflicts.map((c) => ({
    severity: c.severity,
    yours: `${c.current.resourceType}:${c.current.resourceKey}`,
    theirs: c.existing.resourceKey,
    heldBy: `${c.existing.owner} (${c.existing.agentName})`,
    theirTask: c.existing.taskKey ?? null,
    reason: c.reason,
  }));

const conflictAdvice = (n: number, severity?: string) =>
  n === 0
    ? undefined
    : severity === 'critical'
      ? 'STOP and tell your human before writing. Another live run holds the same migration or contract; claims are advisory, so nothing prevents you both from writing it. Coordinate through open_session or announce.'
      : 'Another live run overlaps your scope. Narrow what you touch, or coordinate through open_session before writing.';

/**
 * The installation this token stands for, created on first use. Tokens are
 * already one-per-machine by convention, so the token id is a stable device
 * fingerprint that never leaves the server and is never a hostname.
 */
async function installationFor(
  db: Db,
  user: User,
  token: Token | undefined,
  agent?: string,
  role?: AgentRole,
) {
  const name = agent?.trim() || token?.name || 'mcp-agent';
  const fingerprint = `mcp:${token?.id ?? user.id}`;
  return registerAgent(db, user.id, {
    name: name.slice(0, 80),
    clientType: 'generic',
    deviceFingerprint: fingerprint,
    capabilities: ['mcp'],
    role,
  });
}

/** Runs the caller owns that are still live, newest heartbeat first. */
async function ownRuns(db: Db, userId: string) {
  return db
    .select({ run: agentRuns, installation: agentInstallations })
    .from(agentRuns)
    .innerJoin(agentInstallations, eq(agentRuns.installationId, agentInstallations.id))
    .where(
      and(
        eq(agentInstallations.userId, userId),
        inArray(agentRuns.status, ['starting', 'active', 'waiting', 'blocked']),
      ),
    )
    .orderBy(desc(agentRuns.lastHeartbeatAt));
}

/**
 * What the server would serve this run right now — the fallback expected hash
 * when a receipt was never written at start_run. Reporting the agent's own hash
 * back as the expectation would turn every confirmation into a pass.
 */
async function servedPolicyHash(db: Db, userId: string, runId: string): Promise<string> {
  const rows = await db
    .select({ teamSlug: teams.slug, projectSlug: projects.slug })
    .from(agentRuns)
    .innerJoin(teams, eq(agentRuns.teamId, teams.id))
    .leftJoin(projects, eq(agentRuns.projectId, projects.id))
    .where(eq(agentRuns.id, runId))
    .limit(1);
  const row = rows[0];
  if (!row) return '0'.repeat(64);
  const policy = await effectivePolicy(db, userId, {
    team: row.teamSlug,
    project: row.projectSlug ?? undefined,
  });
  return failed(policy) ? '0'.repeat(64) : policy.hash;
}

const noRunError =
  'No run_id given and you have no active run. Call start_run first — it returns the run_id every other fleet tool needs.';

export function registerFleetTools(
  server: McpServer,
  db: Db,
  user: User,
  env: Env,
  token?: Token,
) {
  const tokenId = token?.id ?? null;
  const teamParam = z
    .string()
    .optional()
    .describe('Team slug. Optional when you belong to exactly one team.');
  const projectParam = z
    .string()
    .max(120)
    .optional()
    .describe(
      'Repository identifier — the last path segment of the origin remote (`git remote get-url origin`), e.g. "payments-api". Do NOT invent one from package.json, the directory name or the repo description: conflict detection is scoped per project, so two agents in the same checkout under two names never warn each other. list_projects shows what this team already calls things.',
    );
  const scopeParam = z
    .array(claimSchema)
    .max(50)
    .optional()
    .describe(
      'What you expect to change. Declaring it is how STMA can warn another agent before you collide — an undeclared scope is invisible to everyone else.',
    );

  // -------------------------------------------------------------- start_run

  server.registerTool(
    'start_run',
    {
      title: 'Start a run and claim your scope',
      description:
        'Announce what you are about to work on and which files/migrations/contracts you expect to touch. Returns a run_id, the team policy you must follow, and any collision with another agent already holding the same ground. Call this BEFORE you start editing, not after.',
      inputSchema: {
        team: teamParam,
        project: projectParam,
        task: z
          .string()
          .max(120)
          .optional()
          .describe(
            'Ticket or task key, e.g. "PAY-421". Write it as "#42" when it is a GitHub issue on the team\'s connected repository — STMA then comments on that issue when the run finishes or is handed off.',
          ),
        issue: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'GitHub issue number to work on. STMA reads its title for you and sets the task key, so the map says what the work actually is. Find them with list_issues.',
          ),
        intent: z
          .string()
          .max(2000)
          .optional()
          .describe('One or two sentences on what you are doing.'),
        branch: z.string().max(300).optional().describe('Git branch you are working on.'),
        base_sha: z.string().max(64).optional().describe('Commit you branched from.'),
        scope: scopeParam,
        agent: z
          .string()
          .max(60)
          .optional()
          .describe("Your agent name as teammates should see it, e.g. 'claude-code'."),
        role: z
          .enum(AGENT_ROLES)
          .optional()
          .describe(
            'What this agent is for — reviewer, tester, implementer, planner, ops. A label teammates read, not a permission.',
          ),
        attempt_group: z
          .string()
          .max(120)
          .optional()
          .describe(
            'Set the same value on every run that is a parallel attempt at ONE task (a fan-out across worktrees). Runs in a group never warn each other about overlapping scope, because that overlap is the plan.',
          ),
        worktree: z
          .string()
          .max(500)
          .optional()
          .describe('Working directory for this attempt. Tells two attempts at one task apart.'),
      },
    },
    async ({ team, project, task, intent, branch, base_sha, scope, agent, role, attempt_group, worktree, issue }) => {
      const resolved = await resolveTeam(db, user.id, team, env.hosted);
      if (failed(resolved)) return err(resolved.error);
      // Claiming ground is the paid half. Reading the map is not — list_active_agents
      // still answers on every plan, which is the whole point of a teaser: the
      // reason to upgrade has to be visible from inside the product.
      const gate = requireFeature(env, resolved.team, (l) => l.fleet === 'full', 'Starting a run');
      if (gate) return err(gate.error);
      const installation = await installationFor(db, user, token, agent, role);

      // An issue number is a better task key than anything an agent invents: it
      // names work a human already wrote down, and it is what the closing
      // comment will be posted against.
      let taskKey = task;
      let intentText = intent;
      let issueUrl: string | null = null;
      if (issue !== undefined) {
        const integration = await githubForTeam(db, resolved.team.id);
        if (!integration) {
          return err(
            'This team has no GitHub repository connected, so an issue number means nothing yet. A team owner connects one on the team page, or pass "task" instead.',
          );
        }
        const found = await getIssue(env, integration, issue);
        if (!found.ok) {
          return err(
            `Could not read issue #${issue} on ${integration.repo} (${found.error}). Check the number with list_issues.`,
          );
        }
        taskKey = `#${issue}`;
        intentText = intent ?? found.value.title;
        issueUrl = found.value.url;
      }
      // A Jira-shaped task key gets the same courtesy when Jira is connected:
      // the ticket's summary becomes the intent nobody typed, and the map says
      // what the work is instead of echoing "PAY-421". A tracker hiccup stays
      // silent — a run must never fail because an issue tracker blinked.
      if (issue === undefined && taskKey && /^[A-Za-z][A-Za-z0-9]+-\d+$/.test(taskKey.trim())) {
        const jira = await jiraForTeam(db, resolved.team.id);
        if (jira) {
          const ticket = await getJiraIssue(env, jira, taskKey.trim().toUpperCase());
          if (ticket.ok) {
            intentText = intent ?? ticket.value.summary;
            issueUrl = ticket.value.url;
          }
        }
      }

      const result = await startAgentRun(
        db,
        user.id,
        {
          installationId: installation.id,
          team: resolved.team.slug,
          project,
          taskKey,
          intent: intentText,
          repo: project,
          branch,
          baseSha: base_sha,
          worktree,
          claims: toWorkClaims(scope),
          attemptGroup: attempt_group,
        },
        env.agentClaimLeaseMinutes,
      );
      if (failed(result)) return err(result.error);

      const declared = toWorkClaims(scope);
      const policy = await effectivePolicy(db, user.id, { team: resolved.team.slug, project });

      // Three things a run should be told at the only moment they are still
      // cheap to act on: whether this ground needs a person, whether the change
      // is bigger than the team said one change should be, and whether somebody
      // is already doing it.
      const readiness = failed(policy)
        ? { approvals: [], budget: { over: [] } }
        : {
            approvals: approvalsNeeded(policy.document, declared),
            budget: budgetVerdict(policy.document, declared),
          };
      const duplicates = await duplicateWork(db, user.id, result.run, {
        taskKey: task ?? null,
        intent: intent ?? null,
      });
      if (duplicates.length > 0) {
        // Recorded, not just answered: "somebody else is already on this" is the
        // most legible economic moment the product has, and until now it existed
        // only in one reply that nobody could count later.
        await addAgentEvent(db, result.run.id, 'duplicates_detected', {
          count: duplicates.length,
          taskKey: task ?? null,
          others: duplicates.slice(0, 3).map((d) => d.owner),
        });
      }
      if (!failed(policy)) {
        await recordPolicyReceipt(db, user.id, result.run.id, policy.hash);
      }
      // One line, not the whole document: the flow rides get_workflow so that
      // a team without one costs this reply nothing. What DOES ride here is the
      // flow's verdict on this run — missing ticket, off-pattern branch — while
      // fixing either is still a rename rather than a rewrite.
      const flowRef = await activeFlowFor(db, resolved.team.id, project);
      const flowWarnings = flowRef
        ? flowAdvice(parseFlowDocument(flowRef.flow.document), { taskKey, branch })
        : [];
      const label = result.run.taskKey ?? result.run.intent ?? result.run.repo ?? 'run';
      void track(db, {
        teamId: result.run.teamId,
        projectId: result.run.projectId,
        userId: user.id,
        tokenId,
        action: 'run_started',
        detail: [
          label,
          result.run.branch,
          result.conflicts.length > 0 ? `${result.conflicts.length} conflicts` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      });
      return text({
        runId: result.run.id,
        team: resolved.team.slug,
        project: project ?? null,
        agent: installation.name,
        role: installation.role ?? null,
        attemptGroup: result.run.attemptGroup,
        task: result.run.taskKey,
        issueUrl,
        leaseMinutes: env.agentClaimLeaseMinutes,
        conflicts: describeConflicts(result.conflicts),
        conflictAdvice: conflictAdvice(result.conflicts.length, result.conflicts[0]?.severity),
        policy:
          'error' in policy
            ? null
            : { hash: policy.hash, document: policy.document, warning: policy.warning },
        projectNote: result.projectSplit,
        needsApproval:
          readiness.approvals.length > 0
            ? {
                claims: readiness.approvals,
                advice:
                  'Your team decided this ground needs a person to agree before it changes. Say what you intend to do there and get your human to confirm before you touch it.',
              }
            : undefined,
        overBudget:
          readiness.budget.over.length > 0
            ? {
                limits: readiness.budget.over,
                advice:
                  'This is larger than the team said one change should be. Split it into smaller runs — a reviewer reads a small change; a big one they skim.',
              }
            : undefined,
        possibleDuplicates:
          duplicates.length > 0
            ? {
                runs: duplicates,
                advice:
                  'Somebody may already be doing this. Go and look before you start — list_active_agents shows what they hold, and open_session is how you ask.',
              }
            : undefined,
        hint: `Keep the run alive with update_run {"run_id":"${result.run.id}"} — leases expire after ${env.agentClaimLeaseMinutes} minutes and your scope stops warning anyone. Call finish_run when you are done.`,
        deliveryHint: flowRef
          ? `This team follows a delivery flow ("${flowRef.flow.name}"). Call get_workflow {"team":"${resolved.team.slug}"${project ? `,"project":${JSON.stringify(project)}` : ''}} before you branch — the branch naming, required checks and the road to production are decided there, not by you.`
          : undefined,
        flowAdvice:
          flowWarnings.length > 0
            ? {
                warnings: flowWarnings,
                advice:
                  'The delivery flow is the team’s published decision about how work moves. These warn; they do not block — but "I knew and went anyway" belongs in a sentence to your human, not in silence.',
              }
            : undefined,
        policyHint:
          'error' in policy
            ? undefined
            : `Read the policy above, then confirm it: update_run {"run_id":"${result.run.id}","policy_hash":"${policy.hash}"}. Until a run confirms, governance records it as unconfirmed — the point of the receipt is that a rule nobody acknowledged is a rule nobody is following.`,
        usageHint: `If you can READ how much of your own allowance is gone, send it: update_run {"run_id":"${result.run.id}","usage":{"used_pct":80,"source":"measured"}}. At ${QUOTA_WARNING_PCT}% STMA tells you to plan a handoff, at ${QUOTA_CRITICAL_PCT}% to make one — so the work moves before you stop, not after. If you cannot read it, omit usage or mark it "estimate": STMA will record your guess and show it as a guess, but it will not tell your team you are running out on the strength of one.`,
      });
    },
  );

  // ------------------------------------------------------------- update_run

  server.registerTool(
    'update_run',
    {
      title: 'Keep your run alive and restate your scope',
      description:
        'Heartbeat. Renews the lease on the scope you claimed and re-checks for collisions. Send it whenever you finish a step, and always when your scope grows. Omitting "scope" renews what you already hold — it never releases it. Report your own remaining allowance in "usage" and STMA will tell you when to hand the work over instead of stopping inside it.',
      inputSchema: {
        run_id: z.string().uuid().optional().describe('From start_run. Defaults to your newest active run.'),
        status: z
          .enum(['active', 'waiting', 'blocked'])
          .optional()
          .describe('active (default), waiting on someone, or blocked.'),
        scope: scopeParam,
        policy_hash: z
          .string()
          .length(64)
          .optional()
          .describe(
            'The `policy.hash` start_run or get_policy handed you, sent back once you have READ and APPLIED that document. This is the receipt governance is built on: without it the run is recorded as unconfirmed, and sending a hash that is not the one the server served is recorded as drift. Send the hash you actually applied, not the one you were given, if they differ.',
          ),
        usage: z
          .object({
            used_pct: z
              .number()
              .min(0)
              .max(100)
              .optional()
              .describe(
                'How much of your current vendor window is spent, 0-100. Send a number you can actually READ — from your client, an API, or an environment variable. If you cannot read one, either omit usage entirely or send source "estimate"; do not invent a plausible figure.',
              ),
            source: z
              .enum(QUOTA_SOURCES)
              .optional()
              .describe(
                '"measured" if you read this from a real source and can name it; "estimate" if it is your own judgement. Defaults to "estimate". Only a measured figure moves the fleet — an invented percentage that triggers a handoff at the wrong moment costs more than the handoff it was meant to save.',
              ),
            resets_at: z
              .string()
              .describe('ISO timestamp when your window resets, if you know it.')
              .optional(),
            label: z
              .string()
              .max(80)
              .optional()
              .describe(
                'What the allowance is called, e.g. "claude 5h window". Name the thing you read, not the thing you assumed.',
              ),
            cost_usd: z
              .number()
              .min(0)
              .max(100_000)
              .optional()
              .describe(
                'Total spend of THIS run so far in USD, if your client exposes it (a billing API, a /cost command, token counts times a price you can cite). Same discipline as used_pct: send only a number you READ, and mark your own guess with source "estimate" — estimates are recorded and shown as estimates, and never added into any total.',
              ),
          })
          .optional()
          .describe(
            'Your own remaining allowance. Only you can know this — STMA never measures it and never guesses it. Sending a real one is what turns "the agent stopped mid-task" into a handoff written while you could still think.',
          ),
      },
    },
    async ({ run_id, status, scope, policy_hash, usage }) => {
      const runId = run_id ?? (await ownRuns(db, user.id))[0]?.run.id;
      if (!runId) return err(noRunError);
      // Confirming the policy is the one thing an MCP-only agent could not do,
      // which meant every one of its runs read as drift forever.
      let policyReceipt: { drift: boolean; expectedHash: string } | undefined;
      if (policy_hash) {
        const recorded = await recordPolicyReceipt(
          db,
          user.id,
          runId,
          // Only a fallback: the receipt written at start_run holds what the
          // server actually served, and that one wins.
          await servedPolicyHash(db, user.id, runId),
          policy_hash,
        );
        if (recorded) policyReceipt = { drift: recorded.drift, expectedHash: recorded.expectedHash };
      }
      const mineRows = await ownRuns(db, user.id);
      const mine = mineRows.find((row) => row.run.id === runId)?.run;
      const result = await heartbeatAgentRun(
        db,
        runId,
        user.id,
        status,
        scope ? toWorkClaims(scope) : undefined,
        env.agentClaimLeaseMinutes,
        usage?.used_pct !== undefined
          ? {
              usedPct: usage.used_pct,
              resetsAt: usage.resets_at,
              label: usage.label,
              source: usage.source ?? 'estimate',
            }
          : undefined,
      );
      if (!result) return err('Unknown or already finished run. Start a new one with start_run.');
      // Cost is bookkeeping, not an escalation: recorded with its source, shown
      // as what it is, and only measured figures ever reach a total.
      let costEcho: { usd: number; source: string } | undefined;
      if (usage?.cost_usd !== undefined) {
        const owned = await runForOwner(db, runId, user.id);
        if (owned) {
          const source = usage.source ?? 'estimate';
          await recordRunCost(db, owned, { usd: usage.cost_usd, source });
          costEcho = { usd: usage.cost_usd, source };
        }
      }
      if (result.quota?.escalated && result.quota.state !== 'ok') {
        void track(db, {
          teamId: result.scope.teamId,
          projectId: result.scope.projectId,
          userId: user.id,
          tokenId,
          action: 'quota_warning',
          detail: `${result.scope.taskKey ?? 'run'} · ${result.quota.state} · ${result.quota.usedPct}% used${result.quota.label ? ` (${result.quota.label})` : ''}`,
        });
      }
      // Conflicts only ever describe runs that are BOTH live, so the moment the
      // other one finishes the warning disappears with it — while the change it
      // made is still sitting under this run's feet. This asks the other
      // question: since I started, who finished on ground I am still holding?
      const held = mine ? await claimsForRuns(db, [runId]) : [];
      const stale = mine
        ? await staleGroundFor(
            db,
            mine,
            held.map((claim) => ({
              resourceType: claim.resourceType as WorkClaim['resourceType'],
              resourceKey: claim.resourceKey,
              access: claim.access as WorkClaim['access'],
            })),
          )
        : [];
      return text({
        runId: result.runId,
        status: result.status,
        cost: costEcho
          ? {
              recordedUsd: costEcho.usd,
              source: costEcho.source,
              note:
                costEcho.source === 'measured'
                  ? 'Recorded as measured — this figure counts in the team’s spend total.'
                  : 'Recorded as your estimate — shown as one, never added into any total.',
            }
          : undefined,
        conflicts: describeConflicts(result.conflicts),
        conflictAdvice: conflictAdvice(result.conflicts.length, result.conflicts[0]?.severity),
        staleContext:
          stale.length > 0
            ? {
                moved: stale.map((entry) => ({
                  resource: `${entry.resourceType}:${entry.resourceKey}`,
                  by: entry.by,
                  agent: entry.agentName,
                  task: entry.taskKey,
                  at: entry.at.toISOString(),
                })),
                advice:
                  'Ground you are holding changed after you started. Git may still merge cleanly — the text does not collide — but what you read may no longer be true. Re-read those files before you write to them, and say so to your human if your plan depended on them.',
              }
            : undefined,
        quota: result.quota
          ? {
              state: result.quota.state,
              usedPct: result.quota.usedPct,
              source: result.quota.source,
              // Say out loud what STMA did with it, so an agent that guessed can
              // see that guessing bought it nothing.
              acted: result.quota.source === 'measured',
              resetsAt: result.quota.resetsAt,
              label: result.quota.label,
            }
          : undefined,
        quotaAdvice: result.quota?.advice,
        handoffCall: result.quota?.handoff,
        policy: policyReceipt
          ? {
              confirmed: !policyReceipt.drift,
              expectedHash: policyReceipt.expectedHash,
              note: policyReceipt.drift
                ? 'That is not the policy this run was served. STMA has recorded the drift and your human will see it on the governance page — re-read get_policy and apply what it returns, or tell them why you did not.'
                : 'Recorded: this run applied the policy the server served.',
            }
          : undefined,
      });
    },
  );

  // ------------------------------------------------------------- finish_run

  server.registerTool(
    'finish_run',
    {
      title: 'Finish a run and release your scope',
      description:
        'Release the files, migrations and contracts you claimed so teammates stop being warned about you. Call it when the work lands, and also when you abandon it.',
      inputSchema: {
        run_id: z.string().uuid().optional().describe('Defaults to your newest active run.'),
        status: z.enum(['completed', 'failed']).optional().describe('completed (default) or failed.'),
        note: z.string().max(2000).optional().describe('What happened, one or two sentences.'),
      },
    },
    async ({ run_id, status, note }) => {
      const runId = run_id ?? (await ownRuns(db, user.id))[0]?.run.id;
      if (!runId) return err(noRunError);
      const result = await finishAgentRun(db, runId, user.id, status ?? 'completed', note);
      if (!result) return err('Unknown run.');
      void track(db, {
        teamId: result.scope.teamId,
        projectId: result.scope.projectId,
        userId: user.id,
        tokenId,
        action: 'run_finished',
        detail: [result.scope.taskKey ?? 'run', result.status].filter(Boolean).join(' · '),
      });
      // If the task was an issue, the issue is where the team will look.
      const commented = await commentOnRunIssue(db, env, {
        teamId: result.scope.teamId,
        taskKey: result.scope.taskKey,
        body: [
          `**${user.username}'s agent ${status === 'failed' ? 'stopped work on' : 'finished'} this** via STMA.`,
          note ? `\n${redactSecrets(note)}` : '',
        ].join(''),
      });
      return text({
        runId: result.runId,
        status: result.status,
        endedAt: result.endedAt,
        issueComment: commented.commented
          ? `commented on ${commented.repo}#${commented.issue}`
          : undefined,
      });
    },
  );

  // ------------------------------------------------------------- list_issues

  server.registerTool(
    'list_issues',
    {
      title: 'Open issues you could pick up',
      description:
        "Open GitHub issues on the team's connected repository, newest activity first. Use it to choose work that exists rather than inventing a task key, then pass the number to start_run as \"issue\". Pull requests are excluded — they are review, not work to pick up.",
      inputSchema: {
        team: teamParam,
        limit: z.number().int().min(1).max(20).optional().describe('How many to return (max 20).'),
      },
    },
    async ({ team, limit }) => {
      const resolved = await resolveTeam(db, user.id, team, env.hosted);
      if (failed(resolved)) return err(resolved.error);
      const integration = await githubForTeam(db, resolved.team.id);
      if (!integration) {
        return err(
          `Team "${resolved.team.slug}" has no GitHub repository connected. A team owner connects one at ${env.baseUrl}/app/teams/${resolved.team.slug} — until then, pass your own "task" string to start_run.`,
        );
      }
      const issues = await listOpenIssues(env, integration, limit);
      if (!issues.ok) {
        return err(
          `Could not read issues on ${integration.repo} (${issues.error}). A team owner may need to re-connect the repository with a token that can read it.`,
        );
      }
      return text({
        team: resolved.team.slug,
        repo: integration.repo,
        issues: issues.value.map((i) => ({
          number: i.number,
          title: i.title,
          labels: i.labels,
          url: i.url,
          updatedAt: i.updatedAt,
        })),
        hint:
          issues.value.length === 0
            ? `Nothing open on ${integration.repo} right now.`
            : 'Pick one and call start_run with {"issue": <number>} — the title becomes the run intent, and finishing or handing off comments back on the issue.',
      });
    },
  );

  // ----------------------------------------------------- list_active_agents

  server.registerTool(
    'list_active_agents',
    {
      title: 'Who else is working right now',
      description:
        'Every live agent run in the team: whose it is, which client, what task and branch, and the scope each one holds. Use it before you pick up work, so you choose something nobody is already inside.',
      inputSchema: { team: teamParam },
    },
    async ({ team }) => {
      const resolved = await resolveTeam(db, user.id, team, env.hosted);
      if (failed(resolved)) return err(resolved.error);
      const rows = await db
        .select({
          run: agentRuns,
          installation: agentInstallations,
          owner: users,
          projectName: projects.name,
        })
        .from(agentRuns)
        .innerJoin(agentInstallations, eq(agentRuns.installationId, agentInstallations.id))
        .innerJoin(users, eq(agentInstallations.userId, users.id))
        .leftJoin(projects, eq(agentRuns.projectId, projects.id))
        .where(
          and(
            eq(agentRuns.teamId, resolved.team.id),
            inArray(agentRuns.status, ['starting', 'active', 'waiting', 'blocked']),
          ),
        )
        .orderBy(desc(agentRuns.lastHeartbeatAt))
        .limit(50);
      const claims = await claimsForRuns(
        db,
        rows.map((r) => r.run.id),
      );
      const byRun = new Map<string, typeof claims>();
      for (const claim of claims) {
        const list = byRun.get(claim.runId) ?? [];
        list.push(claim);
        byRun.set(claim.runId, list);
      }
      return text({
        team: resolved.team.slug,
        activeRuns: rows.map((r) => ({
          runId: r.run.id,
          owner: r.owner.username,
          you: r.owner.id === user.id || undefined,
          agent: r.installation.name,
          client: r.installation.clientType,
          role: r.installation.role ?? undefined,
          project: r.projectName ?? r.run.repo ?? null,
          task: r.run.taskKey ?? null,
          // What the work IS, not just its key — "PAY-421" tells a teammate
          // nothing; the sentence (typed, or pulled from the tracker) does.
          intent: r.run.intent ? r.run.intent.slice(0, 140) : undefined,
          branch: r.run.branch ?? null,
          status: r.run.status,
          attemptGroup: r.run.attemptGroup ?? undefined,
          quota: r.run.quotaState
            ? {
                state: r.run.quotaState,
                usedPct: r.run.quotaPct,
                // Whether the teammate read this or guessed it. Planning around
                // somebody else's guess as if it were a fact is the failure this
                // field exists to prevent.
                source: r.run.quotaSource ?? 'estimate',
              }
            : undefined,
          lastHeartbeatAt: r.run.lastHeartbeatAt.toISOString(),
          scope: (byRun.get(r.run.id) ?? []).map(
            (c) => `${c.access}:${c.resourceType}:${c.resourceKey}`,
          ),
        })),
        hint:
          rows.length === 0
            ? 'Nobody is running right now. Claim your scope with start_run so the next agent can see you.'
            : 'Scope shown is what each run declared. It is advisory — it warns, it does not lock. Runs sharing an attemptGroup are one person\'s parallel attempts at one task, not a collision.',
      });
    },
  );

  // ------------------------------------------------------------- get_policy

  server.registerTool(
    'get_policy',
    {
      title: 'Pull the rules you must follow',
      description:
        'The effective policy for this team and project: protected paths you must not touch without asking, required review, commit conventions, expected runtimes and required environment variable names. Read it before you plan the work, not after you wrote it.',
      inputSchema: { team: teamParam, project: projectParam },
    },
    async ({ team, project }) => {
      const resolved = await resolveTeam(db, user.id, team, env.hosted);
      if (failed(resolved)) return err(resolved.error);
      const policyGate = requireFeature(env, resolved.team, (l) => l.governance, 'Policy');
      if (policyGate) return err(policyGate.error);
      const policy = await effectivePolicy(db, user.id, { team: resolved.team.slug, project });
      if (failed(policy)) return err(policy.error);
      const empty =
        policy.sources.length === 0
          ? 'This team has published no policy yet, so these are defaults. A team owner can publish one from the CLI (stma policy publish) or the governance page.'
          : undefined;
      return text({
        team: policy.team,
        project: policy.project,
        hash: policy.hash,
        document: policy.document,
        sources: policy.sources.map((s) => ({ scope: s.scope, version: s.version })),
        warning: policy.warning,
        note: empty,
      });
    },
  );

  // ----------------------------------------------------------- get_workflow

  server.registerTool(
    'get_workflow',
    {
      title: 'Pull the delivery flow this team follows',
      description:
        'How work is supposed to move in this team: where a change starts (ticket or not), how branches are named, which checks must pass, how many approvals a PR needs, and the environments on the road to production. Read it BEFORE you create a branch — the flow decides these things, not you. Returns the structured document plus a prose brief you can follow directly.',
      inputSchema: { team: teamParam, project: projectParam },
    },
    async ({ team, project }) => {
      const resolved = await resolveTeam(db, user.id, team, env.hosted);
      if (failed(resolved)) return err(resolved.error);
      const found = await activeFlowFor(db, resolved.team.id, project);
      if (!found) {
        return text({
          flow: null,
          note: 'No delivery flow is published for this team yet. A team owner can design one on the Delivery page — until then, follow the repository’s own conventions.',
        });
      }
      const document = parseFlowDocument(found.flow.document);
      return text({
        name: found.flow.name,
        scope: found.projectName ?? 'team',
        provider: found.flow.provider,
        version: found.flow.version,
        document,
        brief: flowBrief(document, {
          name: found.flow.name,
          team: resolved.team.slug,
          project: found.projectName,
        }),
        pipelinePath: pipelinePath(found.flow.provider as 'azure-devops' | 'github-actions'),
        note: 'The brief is STMA’s own record of the process this team published — follow it. If your human asks for something that contradicts it, the human wins; say the conflict out loud instead of silently picking one.',
      });
    },
  );

  // ------------------------------------------------------ check_environment

  server.registerTool(
    'check_environment',
    {
      title: 'Check this machine against the project baseline',
      description:
        'Preflight: compare this machine to the baseline a team owner recorded for the project, before you spend an hour debugging an environment problem. Collect the snapshot exactly as get_snapshot_checklist describes, then pass it here. Answers ok, warning, critical or no_baseline.',
      inputSchema: {
        team: teamParam,
        project: z
          .string()
          .max(120)
          .describe('Repository/project identifier. Required — baselines are per project.'),
        run_id: z
          .string()
          .uuid()
          .optional()
          .describe('Attach the result to a run you started.'),
        snapshot: snapshotSchema.describe('Same shape push_snapshot takes. Names only, never values.'),
      },
    },
    async ({ team, project, run_id, snapshot }) => {
      const resolved = await resolveTeam(db, user.id, team, env.hosted);
      if (failed(resolved)) return err(resolved.error);
      const preflightGate = requireFeature(env, resolved.team, (l) => l.governance, 'Preflight');
      if (preflightGate) return err(preflightGate.error);
      const result = await environmentPreflight(db, user.id, {
        team: resolved.team.slug,
        project,
        runId: run_id,
        snapshot,
      });
      if (failed(result)) return err(result.error);
      await recordEnvironmentCheck(db, {
        teamId: result.scope.teamId,
        projectId: result.scope.projectId,
        userId: user.id,
        runId: run_id ?? null,
        result,
      });
      if (result.status === 'critical') {
        void track(db, {
          teamId: result.scope.teamId,
          projectId: result.scope.projectId,
          userId: user.id,
          tokenId,
          action: 'env_preflight_critical',
          detail: `${project}: ${preflightSummary(result)}`,
        });
      }
      return text({
        status: result.status,
        summary: preflightSummary(result),
        blocking: result.status === 'critical',
        policyViolations: result.policyViolations,
        differences: result.differences,
        // Say what was NOT checked. A snapshot without envVarNames is a snapshot
        // whose environment requirements nobody verified, and silence there reads
        // as a pass.
        unchecked: result.policyViolations.envVarNamesReported
          ? undefined
          : 'This snapshot carried no envVarNames, so the required environment variables were not checked. Names only — never values — are what STMA stores; send them to have the requirement verified.',
        advice:
          result.status === 'critical'
            ? 'Do not start until this is fixed — the baseline says this machine cannot reproduce the project. Tell your human exactly which line differs.'
            : result.status === 'no_baseline'
              ? 'No baseline recorded for this project yet. A team owner can set one from the CLI (stma env baseline) — until then compare_env against a teammate is the next best check.'
              : undefined,
      });
    },
  );

  // ---------------------------------------------------------- get_evidence

  server.registerTool(
    'get_evidence',
    {
      title: 'Why is this change mergeable?',
      description:
        'The merge-readiness pack for one run: what it held, whether it applied the policy it was served, whether its machine matched the project baseline, who it collided with, and its trail. Read it before asking a human to review, and fix what it calls out first. It reports what was recorded — it never guesses, so "unconfirmed" means nobody checked, not that it passed.',
      inputSchema: {
        run_id: z
          .string()
          .uuid()
          .optional()
          .describe('Defaults to your newest active run.'),
      },
    },
    async ({ run_id }) => {
      const runId = run_id ?? (await ownRuns(db, user.id))[0]?.run.id;
      if (!runId) return err(noRunError);
      const pack = await evidenceForRun(db, runId, user.id);
      if (failed(pack)) return err(pack.error);
      // Membership check: the pack names a person, their machine and what they
      // touched, so it stays inside the team it belongs to.
      const resolved = await resolveTeam(db, user.id, pack.who.team, env.hosted);
      if (failed(resolved)) return err('That run is not in one of your teams.');
      const evidenceGate = requireFeature(env, resolved.team, (l) => l.evidence, 'Evidence packs');
      if (evidenceGate) return err(evidenceGate.error);
      return text({
        ...pack,
        hint:
          pack.blocking.length > 0
            ? `Fix these before asking for review: ${pack.blocking.join(', ')}.`
            : pack.unconfirmed.length > 0
              ? `Nothing is failing, but nobody confirmed: ${pack.unconfirmed.join(', ')}. Unconfirmed is not the same as fine.`
              : 'Everything recorded checks out. Say so when you hand this to a reviewer.',
      });
    },
  );

  // ----------------------------------------------------------- handoff_work

  server.registerTool(
    'handoff_work',
    {
      title: 'Hand your work to another agent',
      description:
        'You are about to stop — usage limit, end of day, blocked, or the work needs another pair of hands. If you wrote code, push your branch first. It writes a brief the next agent can act on (what is done, what is left, the branch if there is one, the scope you were holding), releases your claims, and puts it in the team inbox. The code travels through git; STMA carries only the brief. Also the way to send another of your own machines a runbook: omit "branch" and put the plan in next_steps.',
      inputSchema: {
        branch: z
          .string()
          .min(1)
          .max(300)
          .optional()
          .describe('Branch you pushed the work to. Omit only when there is no code to pick up — a runbook, a plan, a decision to carry out.'),
        summary: z
          .string()
          .min(10)
          .max(8000)
          .describe('What is done, what state the code is in, what you learned.'),
        next_steps: z
          .array(z.string().max(500))
          .max(20)
          .optional()
          .describe('Ordered list of what the next agent should do.'),
        reason: z
          .enum(['usage_limit', 'end_of_day', 'blocked', 'escalation', 'other'])
          .optional()
          .describe('Why you are handing off. usage_limit is the common one.'),
        to: z
          .string()
          .max(60)
          .optional()
          .describe('Teammate username to address it to. Omit to offer it to the whole team.'),
        run_id: z
          .string()
          .uuid()
          .optional()
          .describe('Run being handed over. Defaults to your newest active run; its scope is carried into the brief and then released.'),
        team: teamParam,
        project: projectParam,
        via: z.string().max(60).optional().describe('Your agent name, e.g. "codex".'),
      },
    },
    async ({ branch, summary, next_steps, reason, to, run_id, team, project, via }) => {
      const mine = await ownRuns(db, user.id);
      const run = run_id ? mine.find((r) => r.run.id === run_id) : mine[0];
      if (run_id && !run) {
        return err('That run_id is not one of your active runs. Omit it to hand off your newest run, or list yours with list_active_agents.');
      }

      // Team and project come from the run when there is one; the tool still
      // works without a run, because an agent that never called start_run is
      // exactly the one most likely to hit a limit mid-task.
      const resolved = await resolveTeam(db, user.id, team ?? undefined, env.hosted);
      if (failed(resolved)) return err(resolved.error);
      const teamId = run?.run.teamId ?? resolved.team.id;
      if (run && run.run.teamId !== resolved.team.id && team) {
        return err('That run belongs to a different team than the one you named. Omit "team" to use the run\'s own team.');
      }

      let projectId: string | null = run?.run.projectId ?? null;
      let projectName = project ?? run?.run.repo ?? null;
      if (!projectId && projectName) {
        const pr = await findOrCreateProject(db, resolved.team, projectName, user.id);
        if (failed(pr)) return err(pr.error);
        projectId = pr.project.id;
      }

      let recipient: string | null = null;
      let recipientId: string | null = null;
      if (to) {
        const found = await db
          .select({ id: users.id, username: users.username })
          .from(users)
          .where(eq(users.username, to))
          .limit(1);
        if (!found[0]) {
          return err(`No teammate called "${to}". Check the name with list_teammates, or omit "to" to offer the work to the whole team.`);
        }
        recipient = found[0].username;
        recipientId = found[0].id;
      }

      // Charged here rather than at the top: every refusal above this line is
      // the agent's mistake to fix and re-send, and spending an allowance on a
      // typo would make the taster smaller than it says it is.
      const handoffCap = planLimits(resolved.team.plan, env.hosted).maxHandoffsPerMonth;
      if (handoffCap !== null) {
        const spent = await hitCounter(db, 'handoff-month', teamId, MONTH_MS, handoffCap);
        if (spent.exceeded) {
          return err(
            `Team "${resolved.team.slug}" has used its ${handoffCap} handoffs for this 30-day window ` +
              `on the ${resolved.team.plan ?? 'free'} plan (resets ${spent.resetAt.toISOString().slice(0, 10)}). ` +
              'Nothing was written and your run still holds its claims. Push the branch and tell your human ' +
              'what is left — the work is not lost, but STMA did not carry the brief this time.',
          );
        }
      }

      // The scope this run held, carried in the brief so the next agent can
      // claim exactly the same ground rather than guessing at it.
      const held = run ? await claimsForRuns(db, [run.run.id]) : [];
      const scope = held.map((c) => ({
        type: c.resourceType,
        key: c.resourceKey,
        access: c.access,
      }));

      // A handoff with no run, no project and no branch is still a handoff — of
      // intent — so the title falls back to what the human actually wrote.
      const task =
        run?.run.taskKey ??
        projectName ??
        branch ??
        summary.split('\n')[0]!.replace(/^[#>*\s-]+/, '').trim().slice(0, 80);
      const title = `Handoff: ${task}`.slice(0, 200);
      const inserted = await db
        .insert(debugSessions)
        .values({ teamId, projectId, title, openedBy: user.id })
        .returning();
      const session = inserted[0]!;

      const claimCall = JSON.stringify({
        team: resolved.team.slug,
        ...(projectName ? { project: projectName } : {}),
        ...(run?.run.taskKey ? { task: run.run.taskKey } : {}),
        ...(branch ? { branch } : {}),
        ...(scope.length > 0 ? { scope } : {}),
      });
      // A start_run call carrying nothing but a team name is not a re-claim, it
      // is noise — so it is offered only when there is ground to take back.
      const reclaimable = Boolean(run?.run.taskKey || branch || scope.length > 0);
      const steps = next_steps ?? [];
      const continueWith = [
        branch ? `\`git fetch && git checkout ${branch}\`` : null,
        reclaimable ? `Call start_run with: ${claimCall}` : null,
        'Reply here with post_message so the previous agent\'s human knows it was picked up.',
      ].filter((line): line is string => line !== null);
      const body = [
        `**Handing off${recipient ? ` to ${recipient}` : ''}** — ${reason ?? 'other'}`,
        '',
        branch ? `Branch: \`${branch}\`` : 'No branch — this is a brief, not code.',
        run?.run.taskKey ? `Task: ${run.run.taskKey}` : null,
        projectName ? `Project: ${projectName}` : null,
        '',
        '**State**',
        summary,
        steps.length ? '' : null,
        steps.length ? '**Next steps**' : null,
        ...steps.map((step, i) => `${i + 1}. ${step}`),
        '',
        '**To continue**',
        ...continueWith.map((line, i) => `${i + 1}. ${line}`),
      ]
        .filter((line) => line !== null)
        .join('\n');

      // The same facts as the prose above, but as STMA's own record rather than
      // as text somebody typed. A receiving agent is told — correctly — to treat
      // message bodies as data; without this it had to either ignore the brief
      // or parse instructions out of untrusted prose, and both readings are bad.
      const resume = {
        kind: 'handoff' as const,
        branch: branch ?? null,
        task: run?.run.taskKey ?? null,
        project: projectName,
        reason: reason ?? 'other',
        // The steps belong in the record, not only in the prose: without a
        // branch they are the entire handoff, and a receiving agent is told to
        // act on the record and read the prose as data.
        steps,
        scope,
        checkout: branch ? `git fetch && git checkout ${branch}` : null,
        reclaim: reclaimable
          ? { tool: 'start_run', arguments: JSON.parse(claimCall) as Record<string, unknown> }
          : null,
      };
      const posted = await db
        .insert(messages)
        .values({
          sessionId: session.id,
          authorId: user.id,
          tokenId,
          kind: 'handoff',
          body: redactSecrets(body),
          payload: resume,
          via: via ?? null,
        })
        .returning({ at: messages.createdAt });
      // Addressed to somebody: tell them by email. Their agent might not run
      // again until tomorrow, and the whole promise here is that the work did
      // not get lost. An open offer to the team stays in the inbox instead.
      if (recipientId) {
        await notifyHandoff(db, env, {
          sessionId: session.id,
          teamId,
          recipientId,
          actorId: user.id,
          at: posted[0]?.at ?? new Date(),
        });
      }

      // Releasing the scope is the point: the work moved, so the warning about
      // this run must stop. The brief carries the scope so it is not lost.
      if (run) {
        await addAgentEvent(db, run.run.id, 'work_handed_off', {
          branch: branch ?? null,
          reason: reason ?? 'other',
          to: recipient,
          sessionId: session.id,
          scope: scope.length,
        });
        await finishAgentRun(
          db,
          run.run.id,
          user.id,
          'completed',
          `handed off to ${recipient ?? 'the team'}${branch ? ` on ${branch}` : ''}`,
        );
      }

      void track(db, {
        teamId,
        projectId,
        userId: user.id,
        tokenId,
        action: 'work_handoff',
        detail: [task, branch ?? 'no branch', reason ?? 'other', recipient ? `→ ${recipient}` : '→ team']
          .filter(Boolean)
          .join(' · '),
      });
      notifyTeam(
        env,
        resolved.team,
        `Handoff in ${resolved.team.slug}: "${title}"${branch ? ` on ${branch}` : ''}${recipient ? ` → ${recipient}` : ''} — from ${via ? `${via} · ` : ''}${user.username}`,
      );
      // A handoff is exactly the state change somebody watching the issue needs:
      // the work is alive, on a branch, and waiting for the next pair of hands.
      const commented = await commentOnRunIssue(db, env, {
        teamId,
        taskKey: run?.run.taskKey,
        body: [
          `**Handed off${recipient ? ` to ${recipient}` : ' to the team'}** by ${user.username}'s agent via STMA — reason: ${reason ?? 'other'}.`,
          branch ? `\nWork is on \`${branch}\`.` : '\nNo branch — this is a brief, not code.',
          `\n\n${redactSecrets(summary)}`,
          steps.length
            ? `\n\n**Next steps**\n${steps.map((s, i) => `${i + 1}. ${redactSecrets(s)}`).join('\n')}`
            : '',
        ].join(''),
      });

      return text({
        sessionId: session.id,
        team: resolved.team.slug,
        branch: branch ?? null,
        to: recipient,
        steps: steps.length,
        scopeReleased: scope.length,
        runFinished: run?.run.id ?? null,
        pickUpWith: reclaimable ? claimCall : null,
        issueComment: commented.commented
          ? `commented on ${commented.repo}#${commented.issue}`
          : undefined,
        hint: recipient
          ? `${recipient}'s agent will see this next time it calls inbox. Tell your human to ping them if it is urgent.`
          : 'Any teammate\'s agent will see this in its inbox. Tell your human who should pick it up.',
      });
    },
  );
}


/** Argument names accepted by the fleet tools, merged into TOOL_PARAMS. */
export const FLEET_TOOL_PARAMS: Record<string, readonly string[]> = {
  start_run: [
    'team',
    'project',
    'task',
    'intent',
    'branch',
    'base_sha',
    'scope',
    'agent',
    'role',
    'attempt_group',
    'worktree',
    'issue',
  ],
  update_run: ['run_id', 'status', 'scope', 'policy_hash', 'usage'],
  finish_run: ['run_id', 'status', 'note'],
  list_active_agents: ['team'],
  get_evidence: ['run_id'],
  list_issues: ['team', 'limit'],
  get_policy: ['team', 'project'],
  get_workflow: ['team', 'project'],
  check_environment: ['team', 'project', 'run_id', 'snapshot'],
  handoff_work: [
    'branch',
    'summary',
    'next_steps',
    'reason',
    'to',
    'run_id',
    'team',
    'project',
    'via',
  ],
};
