import { ACTIVE_AGENT_RUN_STATUSES } from '@bridge/shared';
import { Hono } from 'hono';
import { loginRedirect } from '../auth/session';
import { teamForUser } from '../domain/access';
import { recentAgentEvents } from '../domain/fleetReaders';
import { recentPolicyReceipts } from '../domain/policies';
import { pendingHandoffs } from '../lib/sessions';
import type { AppEnv } from '../types';
import { PageHead, teamTrail } from '../ui/Console';
import { AppLayout } from '../ui/Layout';

/** A bounded read model: inspection links are never approval buttons. */
export const attentionRoutes = new Hono<AppEnv>();
attentionRoutes.get('/app/teams/:slug/attention', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const access = await teamForUser(db, user.id, c.req.param('slug'));
  if (!access) return c.notFound();
  const [offers, events, receipts] = await Promise.all([
    pendingHandoffs(db, [access.team.id], { userId: user.id }, 10),
    recentAgentEvents(db, access.team.id, 50),
    recentPolicyReceipts(db, access.team.id, 20),
  ]);
  // A retained collision remains part of evidence, but it stops being an
  // actionable inbox item when the run that observed it has ended. Otherwise
  // this page can never become clear even after both people resolve their work.
  const conflicts = events.filter(
    (row) =>
      row.event.type === 'conflicts_detected' &&
      ACTIVE_AGENT_RUN_STATUSES.includes(
        row.run.status as (typeof ACTIVE_AGENT_RUN_STATUSES)[number],
      ),
  );
  const uniqueConflicts = [
    ...new Map([...conflicts].reverse().map((row) => [row.event.runId, row])).values(),
  ].slice(0, 10);
  // The agent map only contains live runs. Keeping a finished run in this inbox
  // made an exact-looking link silently fall back to the first unrelated live
  // run. Historical gaps remain on Governance; Needs attention contains only
  // items whose target can still be selected and acted on.
  const missing = receipts.filter(
    (row) =>
      ACTIVE_AGENT_RUN_STATUSES.includes(
        row.run.status as (typeof ACTIVE_AGENT_RUN_STATUSES)[number],
      ) && (row.receipt.drift || !row.receipt.reportedHash),
  );
  return c.html(
    <AppLayout user={user} title="Needs your attention" active="attention">
      <PageHead
        trail={teamTrail(access.team, { label: 'Needs attention' })}
        title="Needs your attention"
        sub="Actionable handoffs, live scope conflicts and policy receipts that still have a live run to inspect."
        actions={
          <a class="btn btn-sm" href={`/app/teams/${access.team.slug}`}>
            Workspace overview
          </a>
        }
      />
      <section class="readiness-stack">
        <p>
          {access.team.name} · retained observations only. This is not a global safety verdict or a
          notification subscription.
        </p>
        {offers.map((offer) => (
          <div class="card card-pad">
            <b>{offer.title}</b>
            <p>
              {offer.state} · {offer.from ?? 'former member'} ·{' '}
              {offer.legacy
                ? 'Legacy brief: request a new tracked handoff.'
                : 'Use update_handoff to accept, resume, complete or ask for attention. Chat replies do not change its state.'}
            </p>
            <a href={`/app/sessions/${offer.sessionId}`}>Review this handoff</a>
          </div>
        ))}
        {uniqueConflicts.map((row) => (
          <div class="card card-pad">
            <b>Recorded scope overlap</b>
            <p>
              A retained event reports an overlap. Inspect both runs before deciding whether it
              remains unresolved.
            </p>
            <a href={`/app/agents?run=${row.event.runId}`}>Inspect the run</a>
          </div>
        ))}
        {missing.map((row) => (
          <div class="card card-pad">
            <b>{row.receipt.drift ? 'Reported policy hash differs' : 'Policy hash not reported'}</b>
            <p>
              Run {row.run.taskKey ?? row.run.id} · {row.projectName ?? 'team-wide'} ·{' '}
              {row.agentName}. A matching hash would not by itself prove compliance.
            </p>
            <a href={`/app/agents?run=${row.run.id}`}>Review evidence</a>
          </div>
        ))}
        {!offers.length && !uniqueConflicts.length && !missing.length && (
          <p>
            No action identified in this bounded view. Missing or trimmed telemetry can still hide
            issues.
          </p>
        )}
        <p>
          <a href={`/app/teams/${access.team.slug}/repositories`}>Check repository connections</a> ·{' '}
          <a href={`/app/teams/${access.team.slug}`}>Workspace overview</a>
        </p>
      </section>
    </AppLayout>,
  );
});
