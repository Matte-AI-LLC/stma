import { Hono } from 'hono';
import { loginRedirect } from '../auth/session';
import { teamForUser } from '../domain/access';
import {
  readAttention,
  type AttentionItem,
  type AttentionReading,
  type AttentionState,
} from '../domain/attention';
import type { AppEnv } from '../types';
import { PageHead, teamTrail } from '../ui/Console';
import { AppLayout } from '../ui/Layout';

/**
 * A bounded read model. Every link on this page is an inspection link: nothing
 * here accepts, resumes, cancels or starts anything, so there is no form and no
 * button, and each of those actions keeps its own authorization where it lives.
 */
export const attentionRoutes = new Hono<AppEnv>();

const SECTIONS: Array<{ state: AttentionState; title: string; note: string }> = [
  { state: 'needs_action', title: 'Needs action now', note: 'Something is open that a person can resolve.' },
  { state: 'waiting', title: 'Waiting on someone', note: 'Work is in someone else\'s hands. Nothing to do unless it has waited too long.' },
  { state: 'advisory', title: 'Worth a look', note: 'Not a problem so far. Shown so silence is not mistaken for a clean bill.' },
];

const Row = ({ item }: { item: AttentionItem }) => {
  const responsible = item.person.filter((entry) => entry.role !== 'sender');
  const sender = item.person.find((entry) => entry.role === 'sender');
  return (
    <div class="card card-pad">
      <b>{item.problem}</b>
      <dl class="flow-facts" style="margin-top:8px">
        <dt>Project</dt>
        <dd>{item.project ?? 'not tied to a project'}</dd>
        {item.runIds.length > 0 ? (
          <>
            <dt>{item.runIds.length > 1 ? 'Runs' : 'Run'}</dt>
            <dd>{item.runIds.map((id) => id.slice(0, 8)).join(' and ')}</dd>
          </>
        ) : null}
        <dt>Person</dt>
        <dd>
          {responsible.length > 0
            ? responsible.map((entry) => `${entry.label} (${entry.role})`).join(', ')
            : item.kind === 'handoff'
              ? 'not assigned to a person'
              : 'unknown'}
          {sender ? ` · sent by ${sender.label}` : ''}
        </dd>
        <dt>Why open</dt>
        <dd>{item.why}</dd>
        <dt>Next step</dt>
        <dd>{item.nextStep}</dd>
      </dl>
      <p style="margin-bottom:0">
        {item.links.map((link, index) => (
          <>
            {index > 0 ? ' · ' : ''}
            <a href={link.href}>{link.label}</a>
          </>
        ))}
      </p>
    </div>
  );
};

/** The bounds, in words: a list that stops at N must never read as a total. */
function boundsSentence(reading: AttentionReading): string {
  const { limits } = reading;
  const parts: string[] = [];
  parts.push(
    limits.runs.truncated
      ? `the ${limits.runs.limit} most recently active live runs (there are more)`
      : `${limits.runs.read} live run${limits.runs.read === 1 ? '' : 's'}`,
  );
  parts.push(
    limits.handoffs.more
      ? `the ${limits.handoffs.limit} newest open handoffs (more than ${limits.handoffs.limit} match)`
      : `${limits.handoffs.shown} open handoff${limits.handoffs.shown === 1 ? '' : 's'}`,
  );
  return `This page read ${parts.join(' and ')}.`;
}

attentionRoutes.get('/app/teams/:slug/attention', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const access = await teamForUser(db, user.id, c.req.param('slug'));
  if (!access) return c.notFound();
  const reading = await readAttention(db, { userId: user.id, team: access.team });
  const { limits } = reading;
  const clipped: string[] = [];
  if (limits.overlaps.total > limits.overlaps.shown)
    clipped.push(`Showing ${limits.overlaps.shown} of ${limits.overlaps.total} overlapping run pairs, most severe first.`);
  if (limits.receipts.total > limits.receipts.shown)
    clipped.push(`Showing ${limits.receipts.shown} of ${limits.receipts.total} policy reports.`);
  if (limits.handoffs.more)
    clipped.push(`Showing the ${limits.handoffs.limit} newest open handoffs; more than ${limits.handoffs.limit} match.`);
  if (limits.runs.truncated)
    clipped.push(`Only the ${limits.runs.limit} most recently active live runs were read, so an overlap with an older run, or the policy report of an older run, can be missing.`);

  return c.html(
    <AppLayout user={user} title="Needs your attention" active="attention">
      <PageHead
        trail={teamTrail(access.team, { label: 'Needs attention' })}
        title="Needs your attention"
        sub="Overlaps between live runs, handoffs still waiting and policy reports that differ, each with the project, the run, the person when a record names one, and one next step."
        actions={
          <a class="btn btn-sm" href={`/app/teams/${access.team.slug}`}>
            Workspace overview
          </a>
        }
      />
      <section class="readiness-stack">
        <p>
          {access.team.name} · a bounded view of retained observations. {boundsSentence(reading)} This
          is not a global safety verdict or a notification subscription, and nothing on it changes
          anything: accepting, resuming and cancelling happen where they always did, under their own
          permissions.
        </p>
        {clipped.map((line) => (
          <p class="muted">{line}</p>
        ))}
        {SECTIONS.map((section) =>
          reading.groups[section.state].length > 0 ? (
            <>
              <h2 style="margin:8px 0 0">{section.title}</h2>
              <p class="muted" style="margin:0">
                {section.note}
              </p>
              {reading.groups[section.state].map((item) => (
                <Row item={item} />
              ))}
            </>
          ) : null,
        )}
        {reading.readOnlyOverlaps.pairs > 0 ? (
          <p class="muted">
            {reading.readOnlyOverlaps.pairs === 1
              ? '1 pair of live runs overlaps where one only reads the ground.'
              : `${reading.readOnlyOverlaps.pairs} pairs of live runs overlap where one only reads the ground.`}{' '}
            A read holds nothing, so nobody needs to stop. The agent map shows them.
          </p>
        ) : null}
        {reading.items.length === 0 ? (
          <p>
            Nothing needs action in the part of the workspace this page reads ({limits.runs.read} live
            run{limits.runs.read === 1 ? '' : 's'} read; handoffs: up to {limits.handoffs.limit}).
            Telemetry that was never reported cannot appear here.
          </p>
        ) : null}
        <p class="muted">
          {reading.ended === 0
            ? `No overlap reported in the last ${reading.endedDays} days involves a run that has since ended.`
            : `${reading.ended} run${reading.ended === 1 ? '' : 's'} that reported an overlap in the last ${reading.endedDays} days ${reading.ended === 1 ? 'has' : 'have'} since ended. No action. `}
          {reading.ended > 0 ? (
            <>
              <a href={`/app/teams/${access.team.slug}/governance`}>Open Governance (read only)</a> ·{' '}
              <a href={`/app/handoffs?team=${access.team.slug}`}>Open Dispatched (read only)</a>
            </>
          ) : null}
        </p>
        <p class="muted">
          An agent connected but nothing happens? Run <code>stma adapter doctor</code> in its checkout
          and paste the output (it prints no environment values), or open{' '}
          <a href={`/app/teams/${access.team.slug}/connections`}>Agent connections</a>.
        </p>
        <p>
          <a href={`/app/teams/${access.team.slug}/repositories`}>Check repository connections</a> ·{' '}
          <a href={`/app/teams/${access.team.slug}`}>Workspace overview</a>
        </p>
      </section>
    </AppLayout>,
  );
});
