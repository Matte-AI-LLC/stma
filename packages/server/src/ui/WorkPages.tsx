import { randomUUID } from 'node:crypto';
import { WORK_ARTIFACT_KINDS, WORK_PRIORITIES, WORK_RISK_TIERS } from '@bridge/shared';
import type { Child } from 'hono/jsx';
import { timeAgo } from '../lib/format';
import { connectionsHref } from '../lib/scope';
import { PERSON_BLOCKER_KINDS, CRITERION_KINDS, EDIT_SPARE_ROWS, PROVIDERS, rowField, type CriterionRow } from '../lib/workForm';
import type { WorkExecutionRow } from '../lib/workExecution';
import type { QueueRow, WorkQueue } from '../lib/workQueue';
import type { User } from '../types';
import { Band, Field, PageHead, teamTrail, scopedTrail } from './Console';
import { FlowEmpty } from './ProductFlow';
import { AppLayout } from './Layout';

/**
 * The Work pages: the project's list, the workspace queue, the New work form and
 * one work item in detail. Server-rendered like every other console page, and
 * pure: each takes the data a route already read and draws it. Nothing here
 * reads the database or decides who may do what; the route passes in what the
 * domain said (`next_actions`, `may_decide`) and the page shows exactly that.
 *
 * Words matter more than usual here. A criterion that reads "pass" is a claim
 * about evidence, so every result is said beside whose word it is; "ready for
 * review" is never "accepted"; and an agent's state is only ever what a record
 * says (sent, accepted, reported), never "running" because nothing was observed
 * that would justify the word.
 */

// ---------------------------------------------------------------------------
// Addresses and small vocabulary.
// ---------------------------------------------------------------------------

export const workIndexHref = (team: string, project: string): string =>
  `/app/teams/${team}/projects/${encodeURIComponent(project)}/work`;
export const workItemHref = (team: string, project: string, key: string): string =>
  `${workIndexHref(team, project)}/${encodeURIComponent(key)}`;

export const STATE_LABEL: Record<string, string> = {
  draft: 'Draft',
  ready: 'Ready',
  in_progress: 'In progress',
  in_review: 'In review',
  accepted: 'Accepted',
  cancelled: 'Cancelled',
};
const STATE_PILL: Record<string, string> = {
  draft: 'pill-muted',
  ready: 'pill-info',
  in_progress: 'pill-warn',
  in_review: 'pill-open',
  accepted: 'pill-active',
  cancelled: 'pill-muted',
};
export const StatePill = ({ state }: { state: string }) => (
  <span class={`pill ${STATE_PILL[state] ?? 'pill-muted'}`}>{STATE_LABEL[state] ?? state}</span>
);

const RESULT_PILL: Record<string, string> = {
  pass: 'pill-active',
  fail: 'pill-danger',
  unknown: 'pill-muted',
  stale: 'pill-warn',
  inconclusive: 'pill-warn',
};
const RESULT_LABEL: Record<string, string> = {
  pass: 'Passes',
  fail: 'Fails',
  unknown: 'Unknown',
  stale: 'Stale',
  inconclusive: 'Inconclusive',
};

const REASON_TEXT: Record<string, string> = {
  no_delivery: 'No delivery has been submitted.',
  delivery_for_older_revision: 'The delivery is for an older contract revision.',
  no_evidence: 'Nothing has been reported for it.',
  older_than_max_age: 'The evidence is older than the rule allows.',
  unversioned: 'The artifact names no exact version, so it cannot count.',
  reported_inconclusive: 'The report says it is inconclusive.',
  no_verified_binding: 'No verified repository of this provider is bound to the project, so STMA cannot observe this check.',
  repository_not_bound:
    'No verified binding of this provider is the repository the commit was delivered in, so STMA cannot observe this check on it. A check of another repository holding the same commit does not count.',
  no_code_artifact: 'The delivery has no code artifact to check.',
  not_observed: 'The provider has not reported it for this commit.',
  conflicting_observations: 'The observations disagree.',
  provider_state_unknown: 'The provider reports a state that is neither a pass nor a failure.',
  observations_truncated: 'More provider facts match the delivered commits than one read holds, so the one that decides may not be among them.',
  source_deleted: 'The checkpoint the evidence names no longer exists, so it cannot stand for the delivery.',
};

const PROVENANCE_TEXT: Record<string, string> = {
  agent_reported: "Reported by the agent (STMA did not verify it)",
  stma_observed: 'Observed by STMA',
  provider_observed: 'Observed by the provider',
  human_decision: 'Checked by a person, in a decision',
};

const EVIDENCE_VALIDITY: Record<string, { label: string; tone: string; detail: string }> = {
  current: {
    label: 'Current',
    tone: 'pill-active',
    detail: 'Current evidence row; its assertion is reported separately.',
  },
  stale: { label: 'Stale', tone: 'pill-warn', detail: 'This row no longer counts for readiness.' },
  unavailable: {
    label: 'Unavailable',
    tone: 'pill-muted',
    detail: 'The source this row names is no longer available.',
  },
  superseded: {
    label: 'Superseded',
    tone: 'pill-muted',
    detail: 'A later report replaces this row for readiness.',
  },
  withdrawn: {
    label: 'Withdrawn',
    tone: 'pill-muted',
    detail: 'This row was withdrawn and is excluded from readiness.',
  },
};

export const WHY_TEXT: Record<string, string> = {
  not_accepted: 'not accepted yet',
  reopened_since: 'was accepted, then reopened',
  revision_below_required: 'accepted at a contract revision below the one required',
  acceptance_stale: 'its acceptance is stale, the evidence moved',
  upstream_unmet: 'accepted, but waits on something further up',
};

const PRIORITY_LABEL: Record<string, string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
const RISK_LABEL: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High' };
const ARTIFACT_LABEL: Record<string, string> = {
  code: 'Code',
  document: 'Document',
  research: 'Research',
  analysis: 'Analysis',
};

/** A moment, always in UTC, because a page read by a team in three time zones should not guess. */
const at = (iso: string | null | undefined): string =>
  iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : 'never';
const ago = (iso: string | null | undefined): string => (iso ? (timeAgo(new Date(iso)) ?? at(iso)) : 'never');
const cut = (value: string, max: number) => (value.length > max ? `${value.slice(0, max)}…` : value);

/** A link target from a stored address: http(s) only, whatever a record says. */
const safeHref = (value: string | null | undefined): string | null =>
  value && /^https?:\/\//i.test(value) && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;

// ---------------------------------------------------------------------------
// What a refused write carries back to the page.
// ---------------------------------------------------------------------------

export interface Refused {
  /** Which form on the page was posted: only that one is refilled. */
  formId: string;
  typed: Record<string, string>;
  /** Fields that carry several values (the criteria checkboxes of a decision). */
  many?: Record<string, string[]>;
  code: string;
  message: string;
  fields: string[];
  nextAction?: string;
  /**
   * What the person wrote in the form, repeated in the band. Set only when the
   * form that was sent is not drawn again (the work moved so that it is no
   * longer offered), so a long reason is not lost with it.
   */
  kept?: { label: string; value: string }[];
}

/** The typed values of one form, or the stored ones when nothing was refused for it. */
export class Typed {
  constructor(private readonly refused?: Refused) {}
  private of(formId: string): Refused | null {
    return this.refused?.formId === formId ? this.refused : null;
  }
  v(formId: string, name: string, fallback = ''): string {
    const held = this.of(formId);
    return held && name in held.typed ? held.typed[name]! : fallback;
  }
  on(formId: string, name: string, fallback: boolean): boolean {
    const held = this.of(formId);
    return held ? held.typed[name] === 'on' : fallback;
  }
  /**
   * Several values posted under one name, or null when this form was not the
   * refused one or the refusal does not carry the name: a choice cleared
   * because the evidence moved (`decidedOnOther`) draws the form's own
   * default for the new evidence, not an empty choice nobody made.
   */
  many(formId: string, name: string): string[] | null {
    const held = this.of(formId);
    return held?.many && name in held.many ? held.many[name]! : null;
  }
  /** How many criterion rows a refused form had, or null. */
  rows(formId: string): number | null {
    const held = this.of(formId);
    if (!held) return null;
    let most = -1;
    for (const name of Object.keys(held.typed)) {
      const match = /^c(\d+)_/.exec(name);
      if (match) most = Math.max(most, Number(match[1]));
    }
    return most + 1;
  }
}

/** A criterion row the refused form carried for a criterion the contract no longer has. */
export interface DroppedRow {
  id: string;
  text: string;
}

const ROW_FIELD = /^c(\d+)_(.+)$/;

/**
 * A refused contract form lined up again with the contract as it is now, by
 * criterion id rather than by position.
 *
 * The rows of a refused form come back with every value as it was typed, the
 * hidden id included, while the page around them is the current revision. Paired
 * by position, a row showed one criterion's controls (its required mark, its
 * Remove box) over another's id and text, or over the person's own empty row,
 * and a send after a version conflict wrote what the form carried: a criterion
 * the acceptor had added meanwhile was dropped, one they had removed came back.
 * So each posted row keeps its place and what was typed in it; a criterion added
 * since is put in after the rows that name criteria, with its current values;
 * a row naming a criterion removed since is left out and said (`dropped`), its
 * text with it, so nothing typed is lost and nothing removed is sent back. With
 * no concurrent change nothing moves, so a refusal naming "criterion row 3"
 * still names the row the person sees as row 3.
 */
export function refillCriteria(
  current: readonly CriterionRow[],
  refused: Refused | undefined,
  formId: string,
): { refused: Refused | undefined; rows: (CriterionRow | undefined)[]; count: number; dropped: DroppedRow[] } {
  if (!refused || refused.formId !== formId) {
    return { refused, rows: [...current], count: current.length + EDIT_SPARE_ROWS, dropped: [] };
  }
  const posted = new Map<number, Record<string, string>>();
  const typed: Record<string, string> = {};
  for (const [name, value] of Object.entries(refused.typed)) {
    const match = ROW_FIELD.exec(name);
    if (!match) {
      typed[name] = value;
      continue;
    }
    const index = Number(match[1]);
    posted.set(index, { ...(posted.get(index) ?? {}), [match[2]!]: value });
  }
  const byId = new Map(current.map((row) => [row.id, row]));
  type Entry = { fields: Record<string, string>; row: CriterionRow | undefined };
  const entries: Entry[] = [];
  const seen = new Set<string>();
  const dropped: DroppedRow[] = [];
  const last = posted.size ? Math.max(...posted.keys()) : -1;
  for (let index = 0; index <= last; index++) {
    const fields = posted.get(index) ?? {};
    const id = (fields.id ?? '').trim();
    if (!id) {
      entries.push({ fields, row: undefined });
      continue;
    }
    const row = byId.get(id);
    if (!row || seen.has(id)) {
      if (!row) dropped.push({ id, text: (fields.text ?? '').trim() });
      continue;
    }
    seen.add(id);
    entries.push({ fields, row });
  }
  const added: Entry[] = current
    .filter((row) => !seen.has(row.id))
    .map((row) => ({
      row,
      fields: {
        id: row.id,
        text: row.text,
        ...(row.required ? { required: 'on' } : {}),
        kind: row.kind,
        provider: row.provider,
        subject: row.subject,
        keep: row.keep,
      },
    }));
  const after = entries.reduce((at, entry, index) => (entry.row ? index + 1 : at), 0);
  entries.splice(after, 0, ...added);
  entries.forEach((entry, index) => {
    for (const [name, value] of Object.entries(entry.fields)) typed[rowField(index, name)] = value;
  });
  return {
    refused: { ...refused, typed },
    rows: entries.map((entry) => entry.row),
    count: entries.length,
    dropped,
  };
}

const REFUSAL_TAG: Record<string, string> = {
  VERSION_CONFLICT: 'Changed',
  EVIDENCE_STALE: 'Evidence moved',
  FORBIDDEN: 'Not allowed',
  CONTRACT_CHANGED: 'Contract changed',
};

export const RefusalBand = ({ refused }: { refused: Refused }) => (
  <Band kind={refused.code === 'VERSION_CONFLICT' || refused.code === 'EVIDENCE_STALE' ? 'warn' : 'danger'} tag={REFUSAL_TAG[refused.code] ?? 'Not saved'} keep>
    {refused.message}
    {refused.nextAction ? <> {refused.nextAction}</> : null}
    {refused.fields.length ? (
      <>
        {' '}
        <span class="small muted">Fields: {refused.fields.join(', ')}.</span>
      </>
    ) : null}
    {refused.kept?.length ? (
      <dl class="flow-facts wk-facts">
        {refused.kept.map((entry) => (
          <>
            <dt>{entry.label}</dt>
            <dd class="wk-text">{entry.value}</dd>
          </>
        ))}
      </dl>
    ) : null}
  </Band>
);

/** What a one-shot `?ok=` word says. A closed set: the address never supplies a sentence. */
export const OK_TEXT: Record<string, string> = {
  created: 'Work item created as a draft.',
  patched: 'Saved.',
  unchanged: 'Nothing changed: what you saved is what the work already holds, so nothing was recorded.',
  revised: 'Saved as a new contract revision. Agents working to the old one are named below.',
  ready: 'Marked ready.',
  draft: 'Moved back to draft.',
  started: 'Marked in progress.',
  in_review: 'Moved to review.',
  returned: 'Moved back to in progress.',
  cancelled: 'Cancelled. This does not stop an agent that is already running.',
  reopened: 'Reopened.',
  archived: 'Archived.',
  dependency_added: 'Dependency added.',
  dependency_removed: 'Dependency removed.',
  blocker_set: 'Blocker recorded.',
  blocker_resolved: 'Blocker resolved.',
  assigned: 'Assignment sent. The agent\'s prompt hook will announce it where the hooks are installed.',
  assigned_quiet:
    'Assignment sent. No paired hook will announce it, so tell the agent to read its STMA inbox.',
  assigned_own_hook:
    'Assignment sent. This agent was connected with stma connect, so its own prompt hook announces the work at its next prompt where those hooks are still installed; STMA does not see whether they are.',
  accepted: 'Accepted. This records your decision on this delivery; nothing is merged or deployed by it.',
  changes_requested: 'Changes requested. The work is back in progress.',
  external_attached: 'Tied to the GitHub issue. STMA reads it and never writes to it.',
  external_followed: 'The title and goal now follow the GitHub issue, as a new contract revision.',
  external_followed_review:
    'The title and goal now follow the GitHub issue, as a new contract revision. The work was in review, so it is back in progress and the delivery that waited for a decision no longer counts: a new delivery is needed.',
  external_pending:
    'GitHub has a version that would change the contract. This work is closed, so it waits for you below; nothing was reopened.',
  external_refreshed: 'Read GitHub again and recorded what it says now.',
  external_unchanged: 'Read GitHub again; nothing changed there.',
  external_older: 'GitHub answered with an older version than the one already held, so nothing changed.',
  external_conflict:
    'GitHub answered with different content at the same update time. Nothing changed; decide below which version holds.',
  external_reconciled: 'Took the version from GitHub.',
  external_reconciled_review:
    'Took the version from GitHub as a new contract revision. The work was in review, so it is back in progress and the delivery that waited for a decision no longer counts: a new delivery is needed.',
  external_converted: "The issue is now a reference: the title and goal are STMA's to change again.",
  external_detached: 'Detached. The record and its history stay on the work.',
  replayed: 'This form was sent twice, and only the first was recorded. The page shows the work as it is now.',
};

// ---------------------------------------------------------------------------
// The tabs, shared by the native list and the dispatched ledger.
// ---------------------------------------------------------------------------

const TABS = [
  { key: 'mine', label: 'Mine' },
  { key: 'needs_decision', label: 'Needs decision' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'ready', label: 'Ready' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'in_review', label: 'In review' },
  { key: 'all', label: 'All' },
] as const;

export function tabHref(base: string, tab: string, extra: { archived?: boolean; cursor?: string | null } = {}): string {
  const query = new URLSearchParams();
  if (tab !== 'all') query.set('tab', tab);
  if (extra.archived) query.set('archived', '1');
  if (extra.cursor) query.set('cursor', extra.cursor);
  const text = query.toString();
  return text ? `${base}?${text}` : base;
}

export const WorkTabs = ({
  base,
  active,
  counts,
  dispatched,
  archived,
}: {
  base: string;
  active: string;
  counts: Record<string, number>;
  dispatched: number;
  archived?: boolean;
}) => (
  <nav class="tabs wk-tabs" aria-label="Work views">
    {TABS.map((tab) => (
      <a
        class={`tab${active === tab.key ? ' active' : ''}`}
        href={tabHref(base, tab.key, { archived })}
        aria-current={active === tab.key ? 'page' : undefined}
      >
        {tab.label}
        <span class="tab-n">{counts[tab.key] ?? 0}</span>
      </a>
    ))}
    <a
      class={`tab${active === 'dispatched' ? ' active' : ''}`}
      href={`${base}?tab=dispatched`}
      title="Assignments and handoffs still open in this project"
      aria-current={active === 'dispatched' ? 'page' : undefined}
    >
      {/* The count is the open ones and the ledger lists every stage, so the
          tab says which in words: a title is never seen on a touch screen. */}
      Dispatched
      <span class="tab-n">{dispatched} open</span>
    </a>
  </nav>
);

// ---------------------------------------------------------------------------
// The project's list.
// ---------------------------------------------------------------------------

export interface ListItem {
  id: string;
  key: string;
  state: string;
  title: string;
  owner: string | null;
  acceptor: string | null;
  priority: string;
  due_at: string | null;
  labels: string[];
  archived: boolean;
  flags: {
    blocked: boolean;
    needs_decision: boolean;
    stale_evidence: boolean;
    acceptance_stale: boolean;
    external_change_pending: boolean;
    dependency_changed: boolean;
  };
  updated_at: string;
}

/** What the list adds beside the domain's rows, read in batches by the route. */
export interface RowExtras {
  /** The agent side from recorded events: "sent to X, not accepted", "accepted by X", "run active". */
  agents: string[];
  /** Why it is blocked, in words, when it is. */
  waiting: string;
  /** Evidence freshness in words. */
  evidence: string;
}

export interface WorkListProps {
  managedAnalyst?: boolean;
  user: User;
  team: { slug: string; name: string };
  project: { slug: string; name: string };
  tab: string;
  archived: boolean;
  items: ListItem[];
  nextCursor: string | null;
  counts: Record<string, number>;
  dispatched: number;
  extras: Map<string, RowExtras>;
  ok?: string;
}

const EMPTY_TAB: Record<string, string> = {
  mine: 'Nothing is yours yet. Work you own or accept appears here.',
  needs_decision: 'Nothing is waiting for a decision.',
  blocked: 'Nothing is blocked.',
  ready: 'Nothing is ready and waiting to start.',
  in_progress: 'Nothing is in progress.',
  in_review: 'Nothing is in review.',
  all: 'No unarchived work is in this project.',
};

export const WorkListPage = (p: WorkListProps) => {
  const base = workIndexHref(p.team.slug, p.project.slug);
  return (
    <AppLayout
      user={p.user}
      active="work"
      title={`Work in ${p.project.name}`}
      head={
        <PageHead
          trail={scopedTrail({ team: p.team, project: p.project }, 'Work')}
          title="Work"
          sub="Durable units of work for this project: a contract, who owns and accepts it, the agents and runs that touch it, and the evidence for what was delivered. A person decides; evidence never accepts anything by itself."
          actions={
            <>
              <a class="btn btn-primary" href={`${base}/new`}>
                New work
              </a>
              <a class="btn" href={`${base}/export.json`}>
                Export JSON
              </a>
              {p.managedAnalyst && <a class="btn" href={base.replace(/\/work$/, '/analyst')}>Analyze work</a>}
            </>
          }
        />
      }
      keysNote="Live: the list reloads when work in this workspace changes"
    >
      <div data-autorefresh="30" style="display:none"></div>
      <div class="wk-stack">
        {p.ok && OK_TEXT[p.ok] ? (
          <Band kind="info" tag="Done">
            {OK_TEXT[p.ok]}
          </Band>
        ) : null}
        <WorkTabs base={base} active={p.tab} counts={p.counts} dispatched={p.dispatched} archived={p.archived} />
        {p.items.length === 0 ? (
          <FlowEmpty
            title={p.tab === 'all' && p.archived ? 'No work is in this project.' : EMPTY_TAB[p.tab] ?? 'Nothing here.'}
          >
            <p>
              A work item starts as a draft. It becomes ready once it has an owner, an acceptor, a goal, a target kind and at
              least one criterion.
            </p>
            <a class="btn btn-sm btn-primary" href={`${base}/new`}>
              New work
            </a>
            <p class="small muted">
              {p.archived ? (
                <a href={tabHref(base, p.tab)}>Hide archived</a>
              ) : (
                <a href={tabHref(base, p.tab, { archived: true })}>Show archived</a>
              )}
            </p>
          </FlowEmpty>
        ) : (
          <div class="card">
            <div class="scroll-x">
              <table class="tbl wk-tbl">
                <thead>
                  <tr>
                    <th>Work</th>
                    <th>State</th>
                    <th>Owner / acceptor</th>
                    <th>Agents</th>
                    <th>Waiting on</th>
                    <th>Evidence</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {p.items.map((item) => {
                    const extra = p.extras.get(item.id);
                    return (
                      <tr>
                        <td>
                          <a class="mono" href={workItemHref(p.team.slug, p.project.slug, item.key)}>
                            {item.key}
                          </a>
                          <div class="name">
                            <a href={workItemHref(p.team.slug, p.project.slug, item.key)}>{item.title}</a>
                          </div>
                          <div class="wk-flags">
                            {item.archived ? <span class="pill pill-muted">Archived</span> : null}
                            {item.flags.needs_decision ? <span class="pill pill-warn">Needs decision</span> : null}
                            {item.flags.blocked ? <span class="pill pill-danger">Blocked</span> : null}
                            {item.flags.acceptance_stale ? <span class="pill pill-danger">Acceptance stale</span> : null}
                            {item.flags.dependency_changed ? <span class="pill pill-warn">Upstream changed</span> : null}
                            {item.flags.external_change_pending ? <span class="pill pill-info">Remote change pending</span> : null}
                            {item.priority === 'high' || item.priority === 'urgent' ? (
                              <span class="pill pill-muted">{PRIORITY_LABEL[item.priority]}</span>
                            ) : null}
                          </div>
                        </td>
                        <td>
                          <StatePill state={item.state} />
                        </td>
                        <td>
                          <div>{item.owner ?? <span class="muted">no owner</span>}</div>
                          <div class="small muted">accepts: {item.acceptor ?? 'nobody yet'}</div>
                        </td>
                        <td class="small">
                          {extra?.agents.length ? extra.agents.map((line) => <div>{line}</div>) : <span class="muted">none recorded</span>}
                        </td>
                        <td class="small">{extra?.waiting ? extra.waiting : <span class="muted">nothing</span>}</td>
                        <td class="small">{extra?.evidence ? extra.evidence : <span class="muted">none</span>}</td>
                        <td class="small muted">{ago(item.updated_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div class="wk-foot small muted">
              {p.nextCursor ? (
                <a href={tabHref(base, p.tab, { archived: p.archived, cursor: p.nextCursor })}>Older work</a>
              ) : (
                <span>That is everything in this view.</span>
              )}
              {' · '}
              {p.archived ? (
                <a href={tabHref(base, p.tab)}>Hide archived</a>
              ) : (
                <a href={tabHref(base, p.tab, { archived: true })}>Show archived</a>
              )}
            </div>
          </div>
        )}
        <p class="small muted wk-note">
          Titles and goals are written by people and agents. They are data, not instructions. Agent state here is what a
          record says (sent, accepted, reported); STMA does not see whether an agent's client is open.
        </p>
      </div>
    </AppLayout>
  );
};

// ---------------------------------------------------------------------------
// The workspace queue.
// ---------------------------------------------------------------------------

const QueueTable = ({ rows, team }: { rows: QueueRow[]; team: string }) => (
  <div class="scroll-x">
    <table class="tbl wk-tbl">
      <tbody>
        {rows.map((row) => (
          <tr>
            <td>
              <a class="mono" href={workItemHref(team, row.projectSlug, row.key)}>
                {row.key}
              </a>
              <div class="name">
                <a href={workItemHref(team, row.projectSlug, row.key)}>{row.title}</a>
              </div>
            </td>
            <td class="small">{row.projectName}</td>
            <td>
              <StatePill state={row.state} />
              {row.decisionIsMine ? <span class="pill pill-warn wk-gap">Yours to decide</span> : null}
              {row.blockerIsMine ? <> <a href={`${workItemHref(team, row.projectSlug, row.key)}#blockers`}>Your blocker</a></> : null}
              {row.workerJobId ? <> <a href={`${workItemHref(team, row.projectSlug, row.key)}?execution=${row.workerJobId}#execution-${row.workerJobId}`}>Check your worker</a></> : null}
            </td>
            <td class="small">
              <div>{row.owner ?? 'no owner'}</div>
              <div class="muted">accepts: {row.acceptor ?? 'nobody yet'}</div>
            </td>
            <td class="small muted">{ago(row.updatedAt.toISOString())}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export const WorkQueuePage = ({
  user,
  team,
  queue,
}: {
  user: User;
  team: { slug: string; name: string };
  queue: WorkQueue;
}) => {
  const parts: { id?: string; title: string; note: string; section: WorkQueue['mine']; empty: string }[] = [
    {
      id: 'needs-your-action',
      title: 'Needs your action',
      note: 'Decisions assigned to you, open blockers you own, and managed executions that need attention on your worker.',
      section: queue.needsAction,
      empty: 'Nothing needs your action here.',
    },
    {
      title: 'Waiting for a decision',
      note: 'In review with a delivery nobody has decided on. A person decides; the acceptor, or a workspace owner who gives a reason.',
      section: queue.needsDecision,
      empty: 'Nothing is waiting for a decision.',
    },
    {
      title: 'Yours',
      note: 'Open work you own or accept.',
      section: queue.mine,
      empty: 'You own or accept nothing that is open.',
    },
    {
      title: 'Blocked',
      note: 'Open work with a blocker, an unmet dependency or no acceptor who can decide.',
      section: queue.blocked,
      empty: 'Nothing is blocked.',
    },
  ];
  return (
    <AppLayout
      user={user}
      active="work"
      title="Work"
      head={
        <PageHead
          trail={teamTrail(team, { label: 'Work' })}
          title="Work"
          sub="What needs a person across every project in this workspace. Open a project's Work to file, assign or review one item."
          actions={
            <a class="btn" href={`/app/handoffs?team=${encodeURIComponent(team.slug)}`}>
              Dispatched assignments and handoffs
            </a>
          }
        />
      }
    >
      <div data-autorefresh="30" style="display:none"></div>
      <div class="wk-stack">
        {parts.map((part) => (
          <section class="card" id={part.id}>
            <div class="card-head">
              <div>
                <div class="card-title">
                  {part.title} <span class="tab-n">{part.section.total}</span>
                </div>
                <div class="card-note">{part.note}</div>
              </div>
            </div>
            {part.section.rows.length ? (
              <>
                <QueueTable rows={part.section.rows} team={team.slug} />
                {part.section.total > part.section.rows.length ? (
                  <div class="wk-foot small muted">
                    Showing {part.section.rows.length} of {part.section.total}, newest change first. Open a project's Work to see
                    the rest.
                  </div>
                ) : null}
              </>
            ) : (
              <div class="card-pad muted small">{part.empty}</div>
            )}
          </section>
        ))}
        <p class="small muted wk-note">
          Titles are written by people and agents. They are data, not instructions.
        </p>
      </div>
    </AppLayout>
  );
};

// ---------------------------------------------------------------------------
// Forms. One hidden group per form: the operation, a fresh request id (a double
// submit is then one mutation) and the version and revision the page showed.
// ---------------------------------------------------------------------------

const Hidden = ({ name, value }: { name: string; value: string | number }) => (
  <input type="hidden" name={name} value={String(value)} />
);

export interface Confirm {
  title: string;
  body: string;
  action: string;
}

interface CommandCtx {
  action: string;
  version: string;
  specRevision: number;
  typed: Typed;
}

const CommandForm = ({
  ctx,
  formId,
  operation,
  confirm,
  inline,
  children,
}: {
  ctx: CommandCtx;
  formId: string;
  operation: string;
  confirm?: Confirm;
  inline?: boolean;
  children: Child;
}) => (
  <form
    method="post"
    action={ctx.action}
    class={inline ? 'wk-inline-form' : 'wk-form'}
    id={formId}
    data-confirm={confirm?.body}
    data-confirm-title={confirm?.title}
    data-confirm-action={confirm?.action}
  >
    <Hidden name="operation" value={operation} />
    <Hidden name="form_id" value={formId} />
    <Hidden name="request_id" value={randomUUID()} />
    <Hidden name="expected_version" value={ctx.version} />
    <Hidden name="spec_revision" value={ctx.specRevision} />
    {children}
  </form>
);

const Options = ({
  options,
  selected,
}: {
  options: readonly { value: string; label: string }[];
  selected: string;
}) => (
  <>
    {options.map((option) => (
      <option value={option.value} selected={option.value === selected}>
        {option.label}
      </option>
    ))}
  </>
);

const labeled = (values: readonly string[], names: Record<string, string>) =>
  values.map((value) => ({ value, label: names[value] ?? value }));

const PRIORITY_OPTIONS = labeled(WORK_PRIORITIES, PRIORITY_LABEL);
const RISK_OPTIONS = labeled(WORK_RISK_TIERS, RISK_LABEL);
const ARTIFACT_OPTIONS = [
  { value: '', label: 'Not chosen yet (needed before ready)' },
  ...labeled(WORK_ARTIFACT_KINDS, ARTIFACT_LABEL),
];

export interface ContractValues {
  title: string;
  goal: string;
  non_goals: string;
  scope_paths: string;
  risk_tier: string;
  artifact_kind: string;
  independent: boolean;
}

/** A rule too rich for the four choices, in words, so "keep" says what it keeps. */
function ruleWords(rule: unknown): string {
  const r = rule as {
    mode?: string;
    max_age_seconds?: number;
    selectors?: { source: string; provider?: string; subject?: string; artifact_kind?: string }[];
  } | null;
  if (!r?.selectors?.length) return 'a custom rule';
  const parts = r.selectors.map(selectorWords);
  const joined = r.selectors.length > 1 ? `${r.mode === 'any' ? 'any of' : 'all of'}: ${parts.join('; ')}` : parts[0]!;
  const age = r.max_age_seconds ? `, evidence no older than ${Math.round(r.max_age_seconds / 3600)} h` : '';
  return `${joined}${age}`;
}

function selectorWords(s: { source: string; provider?: string; subject?: string; artifact_kind?: string }): string {
  switch (s.source) {
    case 'agent_report':
      return 'an agent report';
    case 'artifact':
      return s.artifact_kind ? `a ${s.artifact_kind} artifact` : 'an artifact of the delivery';
    case 'human_check':
      return 'a human check at the decision';
    case 'provider_observation':
      return `${s.provider ?? 'provider'} check "${cut(s.subject ?? '', 80)}"`;
    default:
      return s.source;
  }
}

const CriteriaRows = ({
  formId,
  rows,
  count,
  typed,
  dropped = [],
}: {
  formId: string;
  rows: readonly (CriterionRow | undefined)[];
  count: number;
  typed: Typed;
  /** Rows of a refused form whose criterion the contract no longer has (`refillCriteria`). */
  dropped?: readonly DroppedRow[];
}) => (
  <div class="wk-crits">
    {dropped.length ? (
      <p class="small wk-tight">
        Removed from the contract since you opened this form, so not kept here as{' '}
        {dropped.length === 1 ? 'a criterion' : 'criteria'}:{' '}
        {dropped.map((row, index) => (
          <>
            {index ? '; ' : ''}
            <span class="mono">{row.id}</span>
            {row.text ? <> (what you had: {cut(row.text, 160)})</> : null}
          </>
        ))}
        . Add {dropped.length === 1 ? 'it' : 'them'} again as a new criterion if still needed.
      </p>
    ) : null}
    {Array.from({ length: count }, (_, index) => {
      const row = rows[index];
      const f = (name: string) => rowField(index, name);
      const id = typed.v(formId, f('id'), row?.id ?? '');
      const kind = typed.v(formId, f('kind'), row?.kind ?? 'agent_report');
      const keep = typed.v(formId, f('keep'), row?.keep ?? '');
      return (
        <fieldset class="wk-crit">
          <legend>
            Criterion {index + 1}
            {id ? <span class="mono muted"> · {id}</span> : null}
          </legend>
          <Hidden name={f('id')} value={id} />
          <Hidden name={f('keep')} value={keep} />
          <div class="field">
            <label for={`${formId}-${f('text')}`}>
              What must be true{' '}
              <span class={`fmark ${row?.id ? 'fmark-req' : 'fmark-opt'}`}>{row?.id ? 'required' : 'optional'}</span>
            </label>
            <textarea class="in" id={`${formId}-${f('text')}`} name={f('text')} rows={2} maxlength={1000}>
              {typed.v(formId, f('text'), row?.text ?? '')}
            </textarea>
          </div>
          <div class="wk-crit-row">
            <label class="wk-check">
              <input type="checkbox" name={f('required')} checked={typed.on(formId, f('required'), row?.required ?? true)} />
              Required for acceptance
            </label>
            <div class="field">
              <label for={`${formId}-${f('kind')}`}>Evidence</label>
              <select class="in" id={`${formId}-${f('kind')}`} name={f('kind')}>
                <Options
                  options={[
                    ...CRITERION_KINDS,
                    ...(kind === 'keep' || row?.kind === 'keep'
                      ? [{ value: 'keep', label: 'Keep the current rule' }]
                      : []),
                  ]}
                  selected={kind}
                />
              </select>
            </div>
          </div>
          <div class="wk-crit-row">
            <div class="field">
              <label for={`${formId}-${f('provider')}`}>Provider (provider check only)</label>
              <select class="in" id={`${formId}-${f('provider')}`} name={f('provider')}>
                <Options options={PROVIDERS} selected={typed.v(formId, f('provider'), row?.provider || 'github')} />
              </select>
            </div>
            <div class="field">
              <label for={`${formId}-${f('subject')}`}>Workflow or pipeline name (provider check only)</label>
              <input
                class="in"
                id={`${formId}-${f('subject')}`}
                name={f('subject')}
                maxlength={200}
                value={typed.v(formId, f('subject'), row?.subject ?? '')}
                placeholder="the exact name the provider reports"
              />
            </div>
          </div>
          {kind === 'keep' && keep ? (
            <p class="small muted wk-tight">
              Kept as is: {(() => {
                try {
                  return ruleWords((JSON.parse(keep) as { verification_rule?: unknown }).verification_rule);
                } catch {
                  return 'a custom rule';
                }
              })()}
              .
            </p>
          ) : null}
          {row?.id ? (
            <label class="wk-check small">
              <input type="checkbox" name={f('remove')} checked={typed.on(formId, f('remove'), false)} />
              Remove this criterion. Its id is never reused, so old evidence keeps its meaning.
            </label>
          ) : null}
        </fieldset>
      );
    })}
  </div>
);

const ContractFields = ({
  formId,
  typed,
  values,
  ownedBy,
}: {
  formId: string;
  typed: Typed;
  values: ContractValues;
  /** The tracker record that owns the title and goal, when one does: they are shown, not edited. */
  ownedBy?: string | null;
}) => (
  <>
    <Field
      id={`${formId}-title`}
      label="Title"
      required
      help={ownedBy ? `Follows ${ownedBy}. Change it on GitHub, then read the issue again.` : 'What this work is, in a line. At most 200 characters.'}
    >
      <input
        class="in"
        id={`${formId}-title`}
        name="title"
        required
        maxlength={200}
        readonly={Boolean(ownedBy)}
        aria-describedby={`${formId}-title-help`}
        // A field the tracker owns cannot be edited, so it shows what is held:
        // refilled from a refused form it would carry a stale value the person
        // cannot change, and every resend would be refused for it.
        value={ownedBy ? values.title : typed.v(formId, 'title', values.title)}
      />
    </Field>
    <Field
      id={`${formId}-goal`}
      label="Goal"
      help={ownedBy ? `Follows the description of ${ownedBy}.` : 'What done looks like, in the words of someone who will read the delivery.'}
    >
      <textarea
        class="in"
        id={`${formId}-goal`}
        name="goal"
        rows={4}
        maxlength={4000}
        readonly={Boolean(ownedBy)}
        aria-describedby={`${formId}-goal-help`}
      >
        {ownedBy ? values.goal : typed.v(formId, 'goal', values.goal)}
      </textarea>
    </Field>
    <Field id={`${formId}-non_goals`} label="Non-goals" help="What this work deliberately does not do.">
      <textarea class="in" id={`${formId}-non_goals`} aria-describedby={`${formId}-non_goals-help`} name="non_goals" rows={2} maxlength={2000}>
        {typed.v(formId, 'non_goals', values.non_goals)}
      </textarea>
    </Field>
    <Field id={`${formId}-scope_paths`} label="Paths in scope" help="One path or glob per line. Agents are told these; nothing here enforces them.">
      <textarea class="in" id={`${formId}-scope_paths`} aria-describedby={`${formId}-scope_paths-help`} name="scope_paths" rows={3}>
        {typed.v(formId, 'scope_paths', values.scope_paths)}
      </textarea>
    </Field>
    <div class="flow-form-row">
      <Field id={`${formId}-artifact_kind`} label="What it delivers">
        <select class="in" id={`${formId}-artifact_kind`} name="artifact_kind">
          <Options options={ARTIFACT_OPTIONS} selected={typed.v(formId, 'artifact_kind', values.artifact_kind)} />
        </select>
      </Field>
      <Field id={`${formId}-risk_tier`} label="Risk">
        <select class="in" id={`${formId}-risk_tier`} name="risk_tier">
          <Options options={RISK_OPTIONS} selected={typed.v(formId, 'risk_tier', values.risk_tier)} />
        </select>
      </Field>
    </div>
    <label class="wk-check">
      <input type="checkbox" name="independent" checked={typed.on(formId, 'independent', values.independent)} />
      Accept only by somebody who did not deliver or run any of it (an independent acceptor)
    </label>
  </>
);

export interface Member {
  username: string;
  role: string;
}

const PeopleSelect = ({
  id,
  name,
  members,
  selected,
  none,
  describedBy,
}: {
  id: string;
  name: string;
  members: Member[];
  selected: string;
  none?: string;
  /** The id of the Field's help, so it is announced with the control. */
  describedBy?: string;
}) => (
  <select class="in" id={id} name={name} aria-describedby={describedBy}>
    {none ? (
      <option value="" selected={selected === ''}>
        {none}
      </option>
    ) : null}
    {/* The member list is bounded. The person the field holds is always an
        option, so a browser never submits somebody else in their place: a
        select whose value is missing from its options sends its first one. */}
    {selected && !members.some((member) => member.username === selected) ? (
      <option value={selected} selected>
        {selected}
      </option>
    ) : null}
    {members.map((member) => (
      <option value={member.username} selected={member.username === selected}>
        {member.username}
        {member.role === 'owner' ? ' (owner)' : ''}
      </option>
    ))}
  </select>
);

// ---------------------------------------------------------------------------
// New work.
// ---------------------------------------------------------------------------

export interface NewWorkProps {
  user: User;
  team: { slug: string; name: string };
  project: { slug: string; name: string };
  members: Member[];
  refused?: Refused;
}

export const NewWorkPage = (p: NewWorkProps) => {
  const base = workIndexHref(p.team.slug, p.project.slug);
  const typed = new Typed(p.refused);
  const id = 'new';
  const blank: ContractValues = {
    title: '',
    goal: '',
    non_goals: '',
    scope_paths: '',
    risk_tier: 'medium',
    artifact_kind: '',
    independent: false,
  };
  const count = typed.rows(id) ?? 8;
  return (
    <AppLayout
      user={p.user}
      active="work"
      title="New work"
      head={
        <PageHead
          trail={[...scopedTrail({ team: p.team, project: p.project }, 'Work').slice(0, -1), { label: 'Work', href: base }, { label: 'New' }]}
          title="New work"
          sub="File a draft. It becomes ready, and can be assigned or delivered against, once it has an owner, an acceptor, a goal, a target kind and at least one criterion. Every field can be changed later; a change to the contract is a new revision."
        />
      }
    >
      {p.refused ? <RefusalBand refused={p.refused} /> : null}
      <form method="post" action={base} class="wk-form card card-pad" id={id}>
        <Hidden name="form_id" value={id} />
        <Hidden name="request_id" value={randomUUID()} />
        <h2 class="wk-h">Contract</h2>
        <ContractFields formId={id} typed={typed} values={blank} />
        <h2 class="wk-h">People and coordination</h2>
        <div class="flow-form-row">
          <Field id={`${id}-owner`} label="Owner" help="Changes the contract with the acceptor. Defaults to you.">
            <PeopleSelect
              id={`${id}-owner`}
              describedBy={`${id}-owner-help`}
              name="owner"
              members={p.members}
              selected={typed.v(id, 'owner', p.user.username)}
            />
          </Field>
          <Field id={`${id}-acceptor`} label="Acceptor" help="Decides on the delivery. Needed before the work is ready.">
            <PeopleSelect
              id={`${id}-acceptor`}
              describedBy={`${id}-acceptor-help`}
              name="acceptor"
              members={p.members}
              selected={typed.v(id, 'acceptor', '')}
              none="Nobody yet"
            />
          </Field>
        </div>
        <div class="flow-form-row">
          <Field id={`${id}-priority`} label="Priority">
            <select class="in" id={`${id}-priority`} name="priority">
              <Options options={PRIORITY_OPTIONS} selected={typed.v(id, 'priority', 'normal')} />
            </select>
          </Field>
          <Field id={`${id}-due`} label="Due date (UTC)">
            <input class="in" id={`${id}-due`} name="due" type="date" value={typed.v(id, 'due', '')} />
          </Field>
        </div>
        <Field id={`${id}-labels`} label="Labels" help="Separated by commas. At most 10.">
          <input class="in" id={`${id}-labels`} aria-describedby={`${id}-labels-help`} name="labels" value={typed.v(id, 'labels', '')} />
        </Field>
        <h2 class="wk-h">Acceptance criteria</h2>
        <p class="small muted wk-tight">
          Each criterion says what must be true and what evidence can show it. Leave unused rows empty. A provider check names
          the exact workflow or pipeline a connected repository reports; an agent's own report never satisfies it.
        </p>
        <CriteriaRows formId={id} rows={[]} count={count} typed={typed} />
        <div class="wk-actions">
          <button class="btn btn-primary" type="submit">
            File as draft
          </button>
          <a class="btn" href={base}>
            Cancel
          </a>
        </div>
      </form>
      <ImportForm base={base} members={p.members} user={p.user} typed={typed} />
    </AppLayout>
  );
};

/**
 * Filing a draft from a GitHub issue. Its own form, because a title is optional
 * here (the issue can supply it) and required in the contract form above. The
 * criteria are added afterwards, on the work item, like any other edit.
 */
const ImportForm = ({ base, members, user, typed }: { base: string; members: Member[]; user: User; typed: Typed }) => {
  const id = 'import';
  return (
    <form method="post" action={base} class="wk-form card card-pad" id={id}>
      <Hidden name="form_id" value={id} />
      <Hidden name="request_id" value={randomUUID()} />
      <h2 class="wk-h">Or start from a GitHub issue</h2>
      <p class="small muted wk-tight">
        Reads the issue through the workspace's GitHub connection. STMA never writes to the issue, and closing it on GitHub is
        never an acceptance here. Add the acceptance criteria on the work item once it is filed.
      </p>
      <Field id={`${id}-issue`} label="Issue" required help="#42 for this project's repository, owner/repo#42, or the issue's address.">
        <input class="in" id={`${id}-issue`} aria-describedby={`${id}-issue-help`} name="external_issue" required maxlength={300} value={typed.v(id, 'external_issue', '')} />
      </Field>
      <Field id={`${id}-mode`} label="How the work follows it">
        <select class="in" id={`${id}-mode`} name="external_mode">
          <Options
            options={[
              { value: 'reference', label: `${MODE_WORDS.reference!.label}: ${MODE_WORDS.reference!.note}` },
              { value: 'external_authoritative', label: `${MODE_WORDS.external_authoritative!.label}: the title and goal follow the issue` },
              { value: 'imported_native', label: `${MODE_WORDS.imported_native!.label}: copied once, not followed` },
            ]}
            selected={typed.v(id, 'external_mode', 'reference')}
          />
        </select>
      </Field>
      <Field
        id={`${id}-title`}
        label="Title"
        help="Leave it empty to use the issue's title. When the issue is the source of truth, leave it empty: the issue owns it."
      >
        <input class="in" id={`${id}-title`} aria-describedby={`${id}-title-help`} name="title" maxlength={200} value={typed.v(id, 'title', '')} />
      </Field>
      <div class="flow-form-row">
        <Field id={`${id}-owner`} label="Owner" help="Defaults to you.">
          <PeopleSelect id={`${id}-owner`} describedBy={`${id}-owner-help`} name="owner" members={members} selected={typed.v(id, 'owner', user.username)} />
        </Field>
        <Field id={`${id}-acceptor`} label="Acceptor">
          <PeopleSelect id={`${id}-acceptor`} name="acceptor" members={members} selected={typed.v(id, 'acceptor', '')} none="Nobody yet" />
        </Field>
      </div>
      <Field id={`${id}-artifact_kind`} label="What it delivers">
        <select class="in" id={`${id}-artifact_kind`} name="artifact_kind">
          <Options options={ARTIFACT_OPTIONS} selected={typed.v(id, 'artifact_kind', '')} />
        </select>
      </Field>
      <div class="wk-actions">
        <button class="btn" type="submit">
          File from the issue
        </button>
      </div>
    </form>
  );
};

// ---------------------------------------------------------------------------
// One work item.
// ---------------------------------------------------------------------------

type Rec = Record<string, any>;

export interface ExecutionRow {
  linkId: string;
  kind: string;
  pinned: number | null;
  superseded: boolean;
  correctionReason: string | null;
  at: string;
  title: string;
  lines: string[];
  href: string | null;
  dispatchHref?: string;
}

const MANAGED_STATE_LABEL: Record<WorkExecutionRow['state'], string> = {
  queued: 'Queued',
  leased: 'Claimed by worker',
  starting: 'Spawn intent recorded',
  running: 'Runtime session observed by worker',
  needs_input: 'Human step needed',
  cancel_requested: 'Cancellation requested',
  succeeded: 'Turn finished · worker reported success',
  failed: 'Worker reported a failure',
  cancelled: 'Cancelled',
  dispatch_unknown: 'Execution status unknown',
  lost: 'Worker lease lost',
};

function executionObservation(row: WorkExecutionRow) {
  if (row.capacityReconciliation) return 'A human recorded verification that the process stopped and released the capacity slot. This is separate from a worker stop report.';
  if (row.state === 'cancel_requested') return 'Waiting for a worker stop report. The process may still be running.';
  if (row.state === 'dispatch_unknown' || row.state === 'lost') return 'Process ownership is unresolved. Inspect the worker machine.';
  if (!row.attemptId) return row.state === 'cancelled'
    ? 'Cancelled before claim. No attempt was created.' : 'Waiting for the worker to claim this request.';
  if (row.workerReportedStopped) return row.observedStartAt
    ? 'The worker reported the process stopped.' : 'The worker reported no process remains. No runtime start was recorded.';
  return row.observedStartAt ? null : 'The worker has yet to report a runtime session.';
}

const WorkExecutionHistory = ({ execution, team, project, revision }: {
  execution: DetailProps['managedExecution']; team: string; project: string; revision: number;
}) => (
  <section class="card-pad wk-prose" id="managed-execution">
    <h3 class="wk-h3">Managed execution</h3>
    <p class="small muted wk-tight">A queue request, a worker observation and a delivery each have their own record.</p>
    {execution.rows.length ? (
      <ul class="wk-rows">
        {execution.rows.map((row) => {
          const observation = executionObservation(row);
          return (
            <li class="wk-row" id={`execution-${row.id}`} data-execution-state={row.state}>
              <b>{MANAGED_STATE_LABEL[row.state]}</b>{' · '}{row.target}{' · '}<code>{row.runtime}</code>
              <div class="small muted">
                Queued {at(row.queuedAt)} · contract revision {row.specRevision ?? 'unavailable'}
                {row.specRevision !== revision ? ` · current revision ${revision}` : ''}
              </div>
              <div class="small muted">Worker last contacted STMA {row.lastWorkerContact ? ago(row.lastWorkerContact) : 'never'}.</div>
              {row.observedStartAt ? <div class="small">Worker observed runtime start {at(row.observedStartAt)}.</div> : null}
              {observation ? <div class="small">{observation}</div> : null}
              {row.capacityReconciliation ? <div class="small">
                Verified by {row.capacityReconciliation.actor.label} · {at(row.capacityReconciliation.attestedAt)}
                {' · '}{row.capacityReconciliation.reason}
              </div> : null}
              {row.checkoutQuarantined ? <div class="small">Checkout is currently quarantined; releasing capacity does not make it ready.</div> : null}
              {row.lastEvent ? <div class="small muted">Latest event {row.lastEvent.reason.replace(/_/g, ' ')} · {at(row.lastEvent.at)}</div> : null}
              <div class="small">
                <a href={`/app/sessions/${row.sessionId}`}>Assignment thread</a>
                {row.runId ? <> · <a href={`/app/teams/${team}/runs/${row.runId}`}>Run and checkpoints</a></> : null}
                {' · '}<a href={`${connectionsHref(team, project)}?execution=${row.id}#managed-execution`}>
                  {row.canCancel ? 'Inspect or cancel execution' : 'Inspect execution'}
                </a>
              </div>
            </li>
          );
        })}
      </ul>
    ) : <p class="small muted wk-tight">No managed execution is visible for this work.</p>}
    {execution.more ? <p class="small muted wk-tight">This list shows up to five executions. <a href={`${connectionsHref(team, project)}#managed-execution`}>Browse managed execution</a>.</p> : null}
  </section>
);

export interface AgentChoice {
  installationId: string;
  label: string;
}

export interface DetailProps {
  user: User;
  team: { slug: string; name: string };
  project: { slug: string; name: string };
  /** The domain's reply for this work, compact plus the detail sections. */
  work: Rec;
  /** `readEvidence`: readiness, the manifest, the four decision snapshot values and `may_decide`. */
  evidence: Rec;
  execution: ExecutionRow[];
  managedExecution: { rows: WorkExecutionRow[]; more: boolean };
  /** The stored criteria as form rows, so the edit form keeps rules it cannot show. */
  criteriaRows: CriterionRow[];
  members: Member[];
  agents: AgentChoice[] | null;
  isAuthority: boolean;
  /** The contract's scope paths as the form edits them. */
  scopePaths: string;
  independent: boolean;
  refused?: Refused;
  ok?: string;
}

const Card = ({ title, note, actions, children, id }: { title: string; note?: string; actions?: Child; children: Child; id?: string }) => (
  <section class="card" id={id}>
    <div class="card-head">
      <div>
        <div class="card-title">{title}</div>
        {note ? <div class="card-note">{note}</div> : null}
      </div>
      {actions ? <div class="wk-head-actions">{actions}</div> : null}
    </div>
    {children}
  </section>
);

const Text = ({ value }: { value: string | null | undefined }) =>
  value ? <p class="wk-text">{value}</p> : <p class="muted small wk-tight">Nothing written.</p>;

function artifactLine(artifact: Rec, index: number): { head: string; version: string; exact: boolean; href: string | null } {
  switch (artifact.kind) {
    case 'code':
      return {
        head: `${artifact.repository_identity} @ ${String(artifact.commit_sha).slice(0, 12)}${artifact.branch ? ` (branch label ${artifact.branch})` : ''}`,
        version: `commit ${artifact.commit_sha}`,
        exact: true,
        href: null,
      };
    case 'document': {
      const exact = Boolean(artifact.version_id || artifact.sha256);
      return {
        head: `${artifact.provider ? `${artifact.provider} ` : ''}document ${artifact.document_id ?? ''}`.trim(),
        version: artifact.version_id ? `version ${artifact.version_id}` : artifact.sha256 ? `sha256 ${artifact.sha256}` : 'unversioned',
        exact,
        href: safeHref(artifact.uri),
      };
    }
    default:
      return {
        head: `file ${artifact.name}${artifact.bytes != null ? ` (${artifact.bytes} bytes)` : ''}`,
        version: `sha256 ${artifact.sha256}`,
        exact: true,
        href: null,
      };
  }
}

/**
 * The selectors of a criterion's rule, each with the result readiness gave it.
 * Before there is a delivery readiness reads no selector at all, and the rule
 * must still be shown: a criterion that hides how it will be checked cannot be
 * argued with. Order is the rule's, so the two lists line up.
 */
function selectorsOf(criterion: Rec, read: Rec | undefined): Rec[] {
  const rule: Rec[] = criterion.verification_rule?.selectors ?? [];
  const read_: Rec[] = read?.selectors ?? [];
  return rule.map((selector, index) => ({ ...selector, result: 'unknown', ...(read_.length === rule.length ? read_[index] : {}) }));
}

const RuleSelectors = ({ selectors }: { selectors: Rec[] }) => (
  <ul class="wk-list">
    {selectors.map((s) => (
      <li>
        {selectorWords(s as any)}: <span class={`pill ${RESULT_PILL[s.result] ?? 'pill-muted'}`}>{RESULT_LABEL[s.result] ?? 'Unavailable'}</span>
        {s.detail ? <div class="small muted">{s.detail}</div> : s.reason ? <div class="small muted">{REASON_TEXT[s.reason] ?? s.reason}</div> : null}
      </li>
    ))}
  </ul>
);

/** The three ways a work follows a tracker record, in the words the card and the timeline use. */
const MODE_WORDS: Record<string, { label: string; note: string }> = {
  reference: { label: 'Reference', note: 'Shown beside the work for context. Every field of the work is STMA\'s.' },
  external_authoritative: {
    label: 'Source of truth',
    note: 'The title and goal follow the issue. Criteria, people, priority, due date and the decision stay STMA\'s.',
  },
  imported_native: { label: 'Imported copy', note: 'Copied once when the work was filed. It does not follow the issue.' },
};

const SYNC_WORDS: Record<string, string> = {
  current: 'Up to date as of the last read.',
  external_change_pending: 'GitHub has a version that would change the contract. It waits for a person.',
  conflict: 'GitHub answered with two different versions at the same update time. A person decides which holds.',
  unavailable: 'The GitHub connection it was read through was removed. What is shown is the last read.',
  detached: 'Detached.',
};

/** What a read of the record did, after the sentence that says it was read. */
function externalTail(payload: Rec): string {
  switch (payload.outcome) {
    case 'followed':
      return `, and the title and goal followed it (revision ${payload.revision ?? '?'})`;
    case 'pending':
      return '; a version that would change the contract waits for a person';
    case 'conflict':
      return '; GitHub gave a different version at the same update time';
    case 'unchanged':
      return '; nothing had changed';
    case 'older_ignored':
      return '; GitHub answered with an older version, which was ignored';
    case 'imported':
      return ', filling the contract from it';
    default:
      return '';
  }
}

function eventSentence(type: string, payload: Rec): string {
  switch (type) {
    case 'work_created':
      return 'created the work item';
    case 'work_patched': {
      const changed = Array.isArray(payload.changed) ? payload.changed.map(String) : [];
      const state = payload.state ? `, and moved it from ${payload.state.from} to ${payload.state.to}` : '';
      return payload.revision
        ? `changed the contract (revision ${payload.revision}: ${changed.join(', ') || 'content'})${state}`
        : `changed ${changed.join(', ') || 'its fields'}${state}`;
    }
    case 'work_state_changed':
      return `moved it from ${payload.from} to ${payload.to}${payload.via ? ` (${String(payload.via).replace(/_/g, ' ')})` : ''}`;
    case 'work_reopened':
      return `reopened it (${payload.from} to ${payload.to})`;
    case 'work_archived':
      return 'archived it';
    case 'work_linked':
      return `linked ${payload.kind ?? 'a record'}${payload.pinned_revision ? ` at revision ${payload.pinned_revision}` : ''}`;
    case 'work_link_superseded':
      return 'corrected a link';
    case 'work_assigned':
      return 'assigned it to an agent';
    case 'work_dependency_added':
      return `made it depend on ${payload.depends_on_key ?? 'another work item'}`;
    case 'work_dependency_removed':
      return `removed its dependency on ${payload.depends_on_key ?? 'another work item'}`;
    case 'work_blocker_set':
      return `recorded a blocker (${String(payload.kind ?? 'other').replace(/_/g, ' ')})`;
    case 'work_blocker_resolved':
      return `resolved a blocker (${String(payload.kind ?? 'other').replace(/_/g, ' ')})`;
    case 'work_delivered':
      return `submitted delivery ${payload.sequence ?? ''}`.trim();
    case 'work_evidence_recorded':
      return 'recorded evidence';
    case 'evidence_observed':
      return 'a provider fact arrived for the delivered commit';
    case 'acceptance_stale':
      return 'the evidence moved after the acceptance';
    case 'work_accepted':
      return `accepted the delivery${payload.standing === 'owner_override' ? ' as a workspace owner' : ''}${payload.self_review ? ' (a self review)' : ''}`;
    case 'work_changes_requested':
      return `requested changes${payload.standing === 'owner_override' ? ' as a workspace owner' : ''}`;
    case 'work_external_attached':
      return `tied it to ${payload.remote_id ?? 'a GitHub issue'} as ${MODE_WORDS[payload.mode]?.label.toLowerCase() ?? 'a record'}${externalTail(payload)}`;
    case 'work_external_refreshed':
      return `read ${payload.remote_id ?? 'the GitHub issue'} again${externalTail(payload)}`;
    case 'work_external_reconciled':
      return `took the version of ${payload.remote_id ?? 'the GitHub issue'} that was waiting${payload.reopened ? ', reopening the work' : ''}${payload.revision ? ` (revision ${payload.revision})` : ''}`;
    case 'work_external_converted':
      return `made ${payload.remote_id ?? 'the GitHub issue'} a reference; the title and goal are STMA's again`;
    case 'work_external_detached':
      return `detached ${payload.remote_id ?? 'the GitHub issue'}`;
    default:
      return type.replace(/^work_/, '').replace(/_/g, ' ');
  }
}

const actorWords = (actor: Rec | null | undefined): string => {
  if (!actor) return 'someone';
  if (actor.kind === 'human') return actor.username ?? 'a person';
  if (actor.kind === 'agent') return `${actor.agent ?? 'an agent'}${actor.owner ? ` (for ${actor.owner})` : ''}`;
  return 'STMA';
};

/**
 * What reopening does, said wherever reopening is offered for closed or
 * archived work. Reopening accepted work is not a restore: it returns to in
 * progress and its acceptance stops standing, so work that depends on it
 * waits again until it is accepted again.
 */
const REOPEN_WORDS: Record<string, string> = {
  accepted:
    'Reopening it returns it to in progress and clears its acceptance: work that depends on it waits again until a new delivery is accepted.',
  cancelled: 'Reopening it returns it to draft.',
  draft: 'Reopening it brings it back as a draft.',
};

export const WorkDetailPage = (p: DetailProps) => {
  const { work, evidence } = p;
  const base = workIndexHref(p.team.slug, p.project.slug);
  const key = String(work.key);
  const here = workItemHref(p.team.slug, p.project.slug, key);
  // The contract form is lined up with the current criteria by id before
  // anything reads what was typed, so its rows and their values agree.
  const contractRows = refillCriteria(p.criteriaRows, p.refused, 'edit-contract');
  const typed = new Typed(contractRows.refused);
  const ctx: CommandCtx = { action: `${here}/command`, version: String(work.version), specRevision: Number(work.spec_revision), typed };
  const actions: string[] = work.next_actions ?? [];
  const can = (name: string) => actions.includes(name);
  const flags: Rec = work.flags ?? {};
  const sections: Rec = work.sections ?? {};
  const contract: Rec = sections.contract ?? {};
  const criteria: Rec[] = sections.criteria?.items ?? [];
  const state = String(work.state);
  const archived = Boolean(work.archived);
  const deliveries: Rec[] = sections.deliveries?.items ?? [];
  const current = deliveries.find((d) => d.current) ?? null;
  const deliveryMatches = evidence.delivery_id === (current?.id ?? null) && evidence.version === work.version;
  const readiness: Rec = (deliveryMatches ? evidence.readiness : null) ?? { criteria: [] };
  const byCriterion = new Map<string, Rec>((readiness.criteria as Rec[]).map((c) => [c.id, c]));
  // How many there are, not how many the section's one page held: sequences
  // run 1, 2, 3 with no gap and the newest comes first, so its number is the
  // count. Read off the page, an item delivered eighty times said 49 earlier.
  const deliveryCount = Math.max(Number(deliveries[0]?.sequence ?? 0), deliveries.length);
  // Each section is one page; a list it cut short says so, as the timeline does.
  const moreEvidence = Boolean(sections.evidence?.next_cursor);
  const moreDecisions = Boolean(sections.acceptances?.next_cursor);
  const unmet: Rec[] = work.unmet_dependencies?.items ?? [];
  const storedBlockers: Rec[] = sections.blockers?.items ?? [];
  // Every open blocker, each with its whole reason and next step: the stored
  // ones from the blockers section (fifty a page, the open ones first, and no
  // more than fifty may be open), beside the one STMA derives and stores
  // nowhere. The compact reply's list stops at five and cuts each text at 200
  // characters, and a person who resolved the five shown was refused an accept
  // for blockers the page never drew.
  const openBlockers: Rec[] = [
    ...((work.open_blockers?.items ?? []) as Rec[]).filter((blocker) => blocker.derived),
    ...storedBlockers.filter((blocker) => !blocker.resolved_at).map((blocker) => ({ ...blocker, derived: false })),
  ];
  // Only if the section's one page ended on an open row can there be more
  // open ones than it held; said, so the list never reads as all of them.
  const moreOpenBlockers = Boolean(sections.blockers?.next_cursor) && storedBlockers.length > 0 && !storedBlockers.at(-1)?.resolved_at;
  const acceptances: Rec[] = sections.acceptances?.items ?? [];
  const events: Rec[] = sections.events?.items ?? [];
  const externals: Rec[] = sections.external?.items ?? [];
  const evidenceRows: Rec[] = deliveryMatches ? sections.evidence?.items ?? [] : [];
  const provider: Rec[] = deliveryMatches ? evidence.manifest?.provider_subjects?.items ?? [] : [];
  const mayDecide = deliveryMatches && Boolean(evidence.may_decide);
  // A delivery somebody already decided on is not sent back to review unchanged: it
  // would sit in review with nothing for anyone to decide. Changes mean a new delivery.
  const decidedCurrent = current !== null && acceptances.some((a) => a.delivery_id === current.id);
  // The newest decision on the current delivery (the list is newest first):
  // changes requested, or an acceptance the work was reopened from since.
  const currentDecision: string | null = current ? (acceptances.find((a) => a.delivery_id === current.id)?.decision ?? null) : null;
  const contractEditable = p.isAuthority && can('patch');
  const canResolve = (blocker: Rec) =>
    p.isAuthority || blocker.owner === p.user.username || (blocker.created_by?.kind === 'human' && blocker.created_by?.username === p.user.username);

  return (
    <AppLayout
      user={p.user}
      active="work"
      title={`${key} ${work.title}`}
      head={
        <PageHead
          trail={[...scopedTrail({ team: p.team, project: p.project }, 'Work').slice(0, -1), { label: 'Work', href: base }, { label: key }]}
          title={String(work.title)}
          sub={`${key} · contract revision ${work.spec_revision} · version ${work.version}`}
          actions={
            <a class="btn" href={base}>
              Back to Work
            </a>
          }
        />
      }
    >
      <div class="wk-stack">
        {p.ok && OK_TEXT[p.ok] ? (
          <Band kind="info" tag="Done">
            {OK_TEXT[p.ok]}
          </Band>
        ) : null}
        {p.refused ? <RefusalBand refused={p.refused} /> : null}
        {archived ? (
          <Band kind="info" tag="Archived" keep>
            This work item is archived and read-only. {REOPEN_WORDS[state] ?? 'Reopening it brings it back.'}
          </Band>
        ) : null}
        {mayDecide ? (
          <Band
            kind="warn"
            tag="Decision"
            keep
            actions={
              <a class="btn btn-sm" href="#decision">
                Decide
              </a>
            }
          >
            A delivery is waiting for a decision{work.acceptor === p.user.username ? ' from you' : ''}.
          </Band>
        ) : null}
        {flags.blocked ? (
          <Band kind="warn" tag="Blocked" keep>
            {openBlockers.length || unmet.length ? (
              <>
                {openBlockers.slice(0, 2).map((b) => (
                  <>
                    {String(b.kind).replace(/_/g, ' ')}: {cut(String(b.reason), 120)}.{' '}
                  </>
                ))}
                {unmet.slice(0, 2).map((d) => (
                  <>
                    Waiting on {d.key} ({WHY_TEXT[d.why] ?? d.why}).{' '}
                  </>
                ))}
              </>
            ) : (
              'Something is waiting on this work.'
            )}
            Accepting is refused while it stays blocked.
          </Band>
        ) : null}
        {flags.acceptance_stale ? (
          <Band kind="danger" tag="Acceptance stale" keep>
            This was accepted, and the evidence for that delivery has moved since. The acceptance stays on record unchanged; a
            person decides whether to reopen it.
          </Band>
        ) : null}
        {flags.dependency_changed ? (
          <Band kind="warn" tag="Upstream changed" keep>
            What this work was accepted against has changed: an upstream was reopened, revised or re-accepted, or a dependency was
            added or removed.
          </Band>
        ) : null}
        {flags.contract_changed ? (
          <Band kind="warn" tag="Contract changed" keep>
            An assignment or run was bound to an older contract revision. STMA cannot stop an agent that is working; it will be
            refused if it submits for the old revision.
          </Band>
        ) : null}
        {flags.stale_evidence && !flags.acceptance_stale ? (
          <Band kind="warn" tag="Evidence stale" keep>
            The current delivery's evidence no longer counts: the contract moved past it, or a check aged out. A new delivery
            is needed.
          </Band>
        ) : null}
        {flags.external_change_pending ? (
          <Band kind="info" tag="Remote change" keep>
            A newer version of the linked remote item is waiting to be reconciled.
          </Band>
        ) : null}

        <div class="grid2">
          <div class="col">
            <Card title="Overview">
              <div class="card-pad">
                <dl class="flow-facts wk-facts">
                  <dt>State</dt>
                  <dd>
                    <StatePill state={state} />
                  </dd>
                  <dt>Owner</dt>
                  <dd>{work.owner ?? 'nobody'}</dd>
                  <dt>Acceptor</dt>
                  <dd>{work.acceptor ?? 'nobody yet'}</dd>
                  <dt>Priority</dt>
                  <dd>{PRIORITY_LABEL[work.priority] ?? work.priority}</dd>
                  <dt>Due</dt>
                  <dd>{work.due_at ? work.due_at.slice(0, 10) : 'no date'}</dd>
                  <dt>Labels</dt>
                  <dd>{(work.labels as string[]).length ? (work.labels as string[]).join(', ') : 'none'}</dd>
                  <dt>Delivers</dt>
                  <dd>
                    {contract.artifact_kind ? (ARTIFACT_LABEL[contract.artifact_kind] ?? contract.artifact_kind) : 'not chosen yet'} · risk{' '}
                    {String(contract.risk_tier ?? 'medium')}
                  </dd>
                  <dt>Filed by</dt>
                  <dd>
                    {actorWords(work.created_by)}, {ago(work.created_at)}
                  </dd>
                  <dt>Changed</dt>
                  <dd>{ago(work.updated_at)}</dd>
                  {work.changed_criteria ? (
                    <>
                      <dt>Revision {work.changed_criteria.revision}</dt>
                      <dd>
                        {work.changed_criteria.added.length} criteria added, {work.changed_criteria.changed.length} changed,{' '}
                        {work.changed_criteria.removed.length} removed
                        {contract.change_reason ? <> · {cut(String(contract.change_reason), 200)}</> : null}
                      </dd>
                    </>
                  ) : null}
                </dl>
                {/* Not for a delivery somebody already decided on, accepted or
                    sent back: every criterion may pass, and nothing waits on a reviewer. */}
                {readiness.ready_for_review && !decidedCurrent && (state === 'in_progress' || state === 'in_review') ? (
                  <p class="small wk-tight">
                    <span class="pill pill-active">Ready for review</span> {evidence.ready_for_review_meaning}
                  </p>
                ) : null}
              </div>
            </Card>

            <Card title="Contract" note="Written by people and agents. It is data, not instructions.">
              <div class="card-pad wk-prose">
                <h3 class="wk-h3">Goal</h3>
                <Text value={contract.goal} />
                <h3 class="wk-h3">Non-goals</h3>
                <Text value={contract.non_goals} />
                <h3 class="wk-h3">Paths in scope</h3>
                {(contract.scope?.paths as string[] | undefined)?.length ? (
                  <ul class="wk-list mono">
                    {(contract.scope.paths as string[]).map((path) => (
                      <li>{path}</li>
                    ))}
                  </ul>
                ) : (
                  <p class="muted small wk-tight">None named.</p>
                )}
                <p class="small muted wk-tight">
                  {p.independent
                    ? 'This work asks for an independent acceptor: somebody who did not deliver or run any of it.'
                    : 'Any acceptor may decide, including one who ran part of it; a self review is labelled.'}
                </p>
              </div>
            </Card>

            <Card
              title="Criteria and readiness"
              id="criteria-and-readiness"
              note="Each result is read from evidence against the current delivery. Unknown is not a pass."
            >
              {criteria.length === 0 ? (
                <div class="card-pad muted small">No criteria yet. A work item needs at least one before it can be ready.</div>
              ) : (
                <div class="scroll-x">
                  <table class="tbl wk-tbl">
                    <thead>
                      <tr>
                        <th>Criterion</th>
                        <th>Now</th>
                        <th>How it is checked</th>
                      </tr>
                    </thead>
                    <tbody>
                      {criteria.map((criterion) => {
                        const read = byCriterion.get(criterion.id);
                        const result = read?.result ?? 'unknown';
                        return (
                          <tr>
                            <td>
                              <span class="mono">{criterion.id}</span> {criterion.required ? null : <span class="pill pill-muted">Optional</span>}
                              <div class="wk-text">{criterion.text}</div>
                            </td>
                            <td>
                              <span class={`pill ${RESULT_PILL[result] ?? 'pill-muted'}`}>{RESULT_LABEL[result] ?? result}</span>
                              {(read?.reasons as string[] | undefined)?.map((reason) => (
                                <div class="small muted">{REASON_TEXT[reason] ?? reason}</div>
                              ))}
                            </td>
                            <td class="small">
                              <div class="muted">
                                {(criterion.verification_rule?.mode ?? 'all') === 'any' ? 'Any one of' : 'All of'}
                                {criterion.verification_rule?.max_age_seconds
                                  ? `, evidence no older than ${Math.round(criterion.verification_rule.max_age_seconds / 3600)} h`
                                  : ''}
                                :
                              </div>
                              <RuleSelectors selectors={selectorsOf(criterion, read)} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card
              title="Agents and runs"
              id="execution"
              note="What the records say. STMA does not see whether an agent's client is open or whether its hook announced anything."
            >
              {p.execution.length === 0 ? (
                <div class="card-pad muted small">
                  No run, assignment or handoff is linked to this work. An assignment from here, or an agent starting a run with this
                  work id, links one.
                </div>
              ) : (
                <ul class="wk-rows">
                  {p.execution.map((row) => (
                    <li class={row.superseded ? 'wk-row wk-old' : 'wk-row'}>
                      <div>
                        <span class="pill pill-muted">{row.kind}</span>{' '}
                        {row.href ? <a href={row.href}>{row.title}</a> : <b>{row.title}</b>}
                        {row.dispatchHref ? <> · <a href={row.dispatchHref}>Review execution target</a></> : null}
                        {row.superseded ? <span class="pill pill-muted wk-gap">Corrected</span> : null}
                      </div>
                      {row.lines.map((line) => (
                        <div class="small muted">{line}</div>
                      ))}
                      <div class="small muted">
                        {row.pinned === null
                          ? 'linked after the fact, not bound to a revision'
                          : row.pinned === work.spec_revision
                            ? `bound to the current contract revision ${row.pinned}`
                            : `bound to revision ${row.pinned}; the contract is now revision ${work.spec_revision}`}
                        {' · '}
                        {ago(row.at)}
                        {row.correctionReason ? ` · correction: ${cut(row.correctionReason, 160)}` : ''}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <WorkExecutionHistory execution={p.managedExecution} team={p.team.slug} project={p.project.slug} revision={Number(work.spec_revision)} />
            </Card>

            <Card title="Delivery review" id="delivery-review" note="Review the exact artifact versions, evidence and human decision together.">
              {!deliveryMatches ? (
                <div class="card-pad muted small">The delivery or evidence changed while this page loaded. <a href={`${here}#delivery-review`}>Reload the review</a>.</div>
              ) : null}
              {deliveryMatches && (current ? (
                <div class="card-pad wk-prose">
                  <p class="wk-tight">
                    Delivery {current.sequence}, submitted by {actorWords(current.submitted_by)}, {ago(current.submitted_at)}, for
                    contract revision {current.spec_revision}
                    {current.spec_revision !== work.spec_revision ? (
                      <> <span class="pill pill-warn">older than the current revision</span></>
                    ) : null}
                    .
                  </p>
                  {current.run_id ? <p class="small wk-tight"><a href={`/app/teams/${p.team.slug}/runs/${current.run_id}`}>Run linked to this delivery</a></p> : null}
                  {current.note ? <p class="wk-text small">{current.note}</p> : null}
                  <ul class="wk-rows">
                    {(current.artifacts as Rec[]).map((artifact, index) => {
                      const line = artifactLine(artifact, index);
                      return (
                        <li class="wk-row">
                          <div>
                            <span class="mono">artifacts[{index}]</span> {line.href ? <a href={line.href} rel="noopener noreferrer nofollow">{line.head}</a> : line.head}
                          </div>
                          <div class="small muted">
                            {line.exact ? (
                              <>exact version: <span class="mono" style="overflow-wrap:anywhere">{line.version}</span></>
                            ) : (
                              <span class="pill pill-warn">unversioned</span>
                            )}
                            {!line.exact ? ' a mutable link is never exact-version evidence' : ''}
                          </div>
                          {artifact.checkpoint_id ? <div class="small muted" style="overflow-wrap:anywhere">Reported checkpoint <code>{artifact.checkpoint_id}</code></div> : null}
                          {artifact.note ? <div class="small wk-text">{artifact.note}</div> : null}
                        </li>
                      );
                    })}
                  </ul>
                  <p class="small muted wk-tight">The decision applies to these artifact versions. A newer commit needs a new delivery for review.</p>
                  {deliveryCount > 1 ? (
                    <p class="small muted wk-tight">
                      {deliveryCount - 1} earlier {deliveryCount === 2 ? 'delivery' : 'deliveries'}:{' '}
                      {deliveries
                        .filter((d) => !d.current)
                        .slice(0, 5)
                        .map((d) => `#${d.sequence} (${ago(d.submitted_at)})`)
                        .join(', ')}
                      . Evidence is never carried to a new delivery.
                    </p>
                  ) : null}
                </div>
              ) : (
                <div class="card-pad muted small">
                  No delivery has been submitted. An agent linked to this work submits one, and the work moves to review.
                </div>
              ))}
              {deliveryMatches && current ? <div class="card-pad wk-prose">
                <h3 class="wk-h3">Evidence for this delivery</h3>
                <p class="small muted wk-tight">Assertions, validity and provenance are listed separately. <a href="#criteria-and-readiness">See criteria and readiness</a>.</p>
              </div> : null}
              {deliveryMatches && current && (evidenceRows.length === 0 && provider.length === 0 ? (
                <div class="card-pad muted small">No evidence has been recorded against the current delivery.</div>
              ) : (
                <div class="scroll-x">
                  {evidenceRows.length ? (
                    <table class="tbl wk-tbl wk-evidence-tbl">
                      <thead>
                        <tr>
                          <th>Criterion</th>
                          <th>Says</th>
                          <th>Validity</th>
                          <th>Whose word</th>
                          <th>About</th>
                          <th>When</th>
                        </tr>
                      </thead>
                      <tbody>
                        {evidenceRows.map((row) => (
                          <tr
                            class={
                              (row.validity !== undefined && row.validity !== 'current') || row.withdrawn_at
                                ? 'wk-old'
                                : undefined
                            }
                          >
                            <td class="mono">{row.criterion_id}</td>
                            <td>
                              <span
                                class={`pill ${
                                  row.validity && row.validity !== 'current'
                                    ? 'pill-muted'
                                    : row.assertion === 'pass'
                                      ? 'pill-active'
                                      : row.assertion === 'fail'
                                        ? 'pill-danger'
                                        : 'pill-warn'
                                }`}
                              >
                                {row.assertion}
                              </span>
                              {row.supersedes_id ? <div class="small muted">replaces an earlier report</div> : null}
                              {row.excerpt ? <div class="small wk-text">{row.excerpt}</div> : null}
                            </td>
                            <td class="small">
                              {(() => {
                                const validity = EVIDENCE_VALIDITY[String(row.validity)];
                                return validity ? (
                                  <>
                                    <span class={`pill ${validity.tone}`}>{validity.label}</span>
                                    <div class="muted">{validity.detail}</div>
                                  </>
                                ) : (
                                  <span class="muted">Not provided</span>
                                );
                              })()}
                            </td>
                            <td class="small">
                              {PROVENANCE_TEXT[row.provenance] ?? row.provenance}
                              <div class="muted">{actorWords(row.reported_by)}</div>
                            </td>
                            <td class="small">
                              <span class="mono">{cut(String(row.source_ref), 48)}</span>
                              {row.source_version ? <div class="muted">{cut(String(row.source_version), 40)}</div> : null}
                            </td>
                            <td class="small muted">{ago(row.observed_at ?? row.recorded_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : null}
                  {moreEvidence ? (
                    <p class="small wk-pad wk-tight">
                      These are the newest {evidenceRows.length} evidence rows of the current delivery; more are recorded against
                      it and not listed here. Readiness and a decision read every one of them.
                    </p>
                  ) : null}
                  {provider.length ? (
                    <>
                      <h3 class="wk-h3 wk-pad">Observed by the provider</h3>
                      <table class="tbl wk-tbl">
                        <thead>
                          <tr>
                            <th>Provider</th>
                            <th>Workflow</th>
                            <th>Commit</th>
                            <th>State</th>
                            <th>Seen</th>
                          </tr>
                        </thead>
                        <tbody>
                          {provider.map((fact) => (
                            <tr>
                              <td>{fact.provider}</td>
                              <td class="small">{cut(String(fact.subject_name ?? fact.subject_id), 60)}</td>
                              <td class="mono" style="overflow-wrap:anywhere">{String(fact.commit_sha)}</td>
                              <td>
                                <span class={`pill ${fact.state === 'success' ? 'pill-active' : fact.state === 'failure' ? 'pill-danger' : 'pill-warn'}`}>
                                  {fact.state}
                                </span>
                                {fact.attempt > 1 ? <span class="small muted"> attempt {fact.attempt}</span> : null}
                              </td>
                              <td class="small muted">{ago(fact.observed_at)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <p class="small muted wk-pad wk-tight">
                        A workflow passing is not every required check, and {evidence.manifest?.scope?.providers?.length ? 'only the providers a criterion names are read' : 'no provider is named by a criterion'}.
                      </p>
                    </>
                  ) : null}
                </div>
              ))}
              {mayDecide ? <DecisionPanel p={p} ctx={ctx} current={current} criteria={criteria} byCriterion={byCriterion} /> : null}
              <div class="card-pad wk-prose" id="delivery-decisions">
                <h3 class="wk-h3">Decision history</h3>
                <p class="small muted wk-tight">Each decision keeps the delivery and evidence it was made on.</p>
              </div>
              {acceptances.length === 0 ? (
                <div class="card-pad muted small">Nobody has decided on a delivery of this work yet.</div>
              ) : (
                <ul class="wk-rows">
                  {acceptances.map((a) => (
                    <li class="wk-row">
                      <div>
                        <span class={`pill ${a.decision === 'accept' ? 'pill-active' : 'pill-warn'}`}>
                          {a.decision === 'accept' ? 'Accepted' : 'Changes requested'}
                        </span>{' '}
                        by {a.actor ?? 'a person'}, {ago(a.created_at)}, revision {a.spec_revision}
                        {' · '}delivery {deliveries.find((d) => d.id === a.delivery_id)?.sequence ?? String(a.delivery_id).slice(0, 8)}
                        {a.current ? <span class="pill pill-muted wk-gap">Current</span> : null}
                        {a.current && flags.acceptance_stale ? <span class="pill pill-danger wk-gap">Stale</span> : null}
                      </div>
                      {a.reason ? <div class="small wk-text">{a.reason}</div> : null}
                      {(a.criteria as string[]).length ? <div class="small muted">Not met: {(a.criteria as string[]).join(', ')}</div> : null}
                      <div class="small muted mono">evidence {String(a.evidence_manifest_hash).slice(0, 16)} · epoch {a.evidence_epoch}</div>
                    </li>
                  ))}
                </ul>
              )}
              {moreDecisions ? (
                <p class="small card-pad wk-tight">
                  These are the newest {acceptances.length} decisions; earlier ones are kept and not listed here.
                </p>
              ) : null}
            </Card>

            <Card title="Blockers and dependencies" id="blockers" note="Blockers are recorded with an owner and a next step. A dependency waits on another work item being accepted.">
              <div class="card-pad wk-prose">
                <h3 class="wk-h3">Open blockers</h3>
                {openBlockers.length === 0 ? (
                  <p class="muted small wk-tight">None.</p>
                ) : null}
                {moreOpenBlockers ? (
                  <p class="small wk-tight">More open blockers are recorded than this page lists; resolve these and reload to see the rest.</p>
                ) : null}
                {openBlockers.length === 0 ? null : (
                  <ul class="wk-rows">
                    {openBlockers.map((blocker) => {
                      return (
                        <li class="wk-row">
                          <div>
                            <span class="pill pill-danger">{String(blocker.kind).replace(/_/g, ' ')}</span>{' '}
                            {blocker.derived ? <span class="pill pill-muted">derived by STMA</span> : null}
                          </div>
                          <div class="wk-text">{blocker.reason}</div>
                          <div class="small muted">
                            Next: {blocker.next_action}
                            {blocker.owner ? ` · owner ${blocker.owner}` : ''}
                          </div>
                          {blocker.id && !archived && canResolve(blocker) ? (
                            <CommandForm ctx={ctx} formId={`resolve-${blocker.id}`} operation="resolve_blocker" inline>
                              <Hidden name="blocker_id" value={blocker.id} />
                              <input
                                class="in"
                                name="reason"
                                required
                                maxlength={1000}
                                placeholder="How it was resolved"
                                aria-label="How it was resolved"
                                value={typed.v(`resolve-${blocker.id}`, 'reason', '')}
                              />
                              <button class="btn btn-sm" type="submit">
                                Resolve
                              </button>
                            </CommandForm>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {storedBlockers.filter((b) => b.resolved_at).length ? (
                  <details>
                    <summary class="small">{storedBlockers.filter((b) => b.resolved_at).length} resolved</summary>
                    <ul class="wk-rows">
                      {storedBlockers
                        .filter((b) => b.resolved_at)
                        .map((b) => (
                          <li class="wk-row wk-old">
                            <div>
                              {String(b.kind).replace(/_/g, ' ')}: {cut(String(b.reason), 160)}
                            </div>
                            <div class="small muted">
                              resolved {ago(b.resolved_at)}: {cut(String(b.resolution_reason ?? ''), 160)}
                            </div>
                          </li>
                        ))}
                    </ul>
                  </details>
                ) : null}
                {can('set_blocker') && !archived ? (
                  <details open={p.refused?.formId === 'set-blocker'}>
                    <summary>Record a blocker</summary>
                    <CommandForm ctx={ctx} formId="set-blocker" operation="set_blocker">
                      <div class="flow-form-row">
                        <Field id="set-blocker-kind" label="Kind" required>
                          <select class="in" id="set-blocker-kind" name="kind">
                            <Options
                              options={PERSON_BLOCKER_KINDS.map((kind) => ({ value: kind, label: kind.replace(/_/g, ' ') }))}
                              selected={typed.v('set-blocker', 'kind', 'other')}
                            />
                          </select>
                        </Field>
                        <Field id="set-blocker-owner" label="Owner" help="Who can clear it.">
                          <PeopleSelect
                            id="set-blocker-owner"
                            describedBy="set-blocker-owner-help"
                            name="owner"
                            members={p.members}
                            selected={typed.v('set-blocker', 'owner', '')}
                            none="Nobody named"
                          />
                        </Field>
                      </div>
                      <Field id="set-blocker-reason" label="What is in the way" required>
                        <textarea class="in" id="set-blocker-reason" name="reason" rows={2} required maxlength={1000}>
                          {typed.v('set-blocker', 'reason', '')}
                        </textarea>
                      </Field>
                      <Field id="set-blocker-next" label="Next step" required help="What would clear it, and who does it.">
                        <input class="in" id="set-blocker-next" aria-describedby="set-blocker-next-help" name="next_action" required maxlength={500} value={typed.v('set-blocker', 'next_action', '')} />
                      </Field>
                      <button class="btn" type="submit">
                        Record blocker
                      </button>
                    </CommandForm>
                  </details>
                ) : null}

                <h3 class="wk-h3">Depends on</h3>
                {(sections.dependencies?.depends_on as Rec[] | undefined)?.length ? (
                  <ul class="wk-rows">
                    {(sections.dependencies.depends_on as Rec[]).map((dependency) => (
                      <li class="wk-row">
                        <div>
                          <a href={workItemHref(p.team.slug, p.project.slug, dependency.key)}>{dependency.key}</a>{' '}
                          <StatePill state={dependency.state} />{' '}
                          {dependency.met ? (
                            <span class="pill pill-active">Met</span>
                          ) : (
                            <span class="pill pill-danger">Not met</span>
                          )}
                        </div>
                        <div class="small muted">
                          {dependency.met
                            ? `accepted at revision ${dependency.spec_revision}${dependency.required_spec_revision > 1 ? `, required ${dependency.required_spec_revision} or later` : ''}`
                            : (WHY_TEXT[dependency.why] ?? dependency.why)}
                        </div>
                        {p.isAuthority && !archived && can('add_dependency') ? (
                          <CommandForm ctx={ctx} formId={`remove-${dependency.key}`} operation="remove_dependency" inline>
                            <Hidden name="depends_on" value={dependency.key} />
                            <button class="btn btn-sm" type="submit">
                              Remove dependency
                            </button>
                          </CommandForm>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p class="muted small wk-tight">Depends on nothing.</p>
                )}
                {(sections.dependencies?.depended_on_by as Rec[] | undefined)?.length ? (
                  <p class="small muted wk-tight">
                    Others wait on this:{' '}
                    {(sections.dependencies.depended_on_by as Rec[]).map((d, i) => (
                      <>
                        {i ? ', ' : ''}
                        <a href={workItemHref(p.team.slug, p.project.slug, d.key)}>{d.key}</a>
                      </>
                    ))}
                    .
                  </p>
                ) : null}
                {p.isAuthority && can('add_dependency') && !archived ? (
                  <details open={p.refused?.formId === 'add-dependency'}>
                    <summary>Add a dependency</summary>
                    <CommandForm ctx={ctx} formId="add-dependency" operation="add_dependency">
                      <div class="flow-form-row">
                        <Field id="add-dependency-on" label="Depends on" required help="The key of another work item in this project, like WORK-12.">
                          <input class="in" id="add-dependency-on" aria-describedby="add-dependency-on-help" name="depends_on" required maxlength={60} value={typed.v('add-dependency', 'depends_on', '')} />
                        </Field>
                        <Field id="add-dependency-rev" label="Needs revision" help="Optional: the contract revision it must be accepted at or after.">
                          <input
                            class="in"
                            id="add-dependency-rev"
                            aria-describedby="add-dependency-rev-help"
                            name="required_spec_revision"
                            type="number"
                            min={1}
                            value={typed.v('add-dependency', 'required_spec_revision', '')}
                          />
                        </Field>
                      </div>
                      <button class="btn" type="submit">
                        Add dependency
                      </button>
                    </CommandForm>
                  </details>
                ) : null}
              </div>
            </Card>

            {externals.length || (can('reconcile_external') && !archived && state !== 'cancelled') ? (
              <ExternalCard refs={externals} ctx={ctx} canChange={can('reconcile_external')} state={state} refused={p.refused} />
            ) : null}

            <Card title="Timeline" note="The last 50 events, newest first.">
              {events.length === 0 ? (
                <div class="card-pad muted small">No events.</div>
              ) : (
                <ol class="wk-timeline">
                  {events.map((event) => (
                    <li>
                      <time datetime={event.created_at}>{at(event.created_at)}</time>{' '}
                      <b>{actorWords(event.actor)}</b> {eventSentence(String(event.type), event.payload ?? {})}
                      {event.payload?.reason ? <span class="muted"> ({cut(String(event.payload.reason), 160)})</span> : null}
                      <span class="small muted"> · v{event.version}</span>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          </div>

          <div class="col">
            {!archived ? (
              <Card title="What you can do" note="Only what the server will accept from you now.">
                <div class="card-pad wk-prose">
                  <div class="wk-actions">
                    {can('transition:ready') ? (
                      <CommandForm ctx={ctx} formId="to-ready" operation="transition" inline>
                        <Hidden name="to" value="ready" />
                        <button class="btn btn-primary btn-sm" type="submit">
                          Mark ready
                        </button>
                      </CommandForm>
                    ) : null}
                    {can('transition:draft') ? (
                      <CommandForm ctx={ctx} formId="to-draft" operation="transition" inline>
                        <Hidden name="to" value="draft" />
                        <button class="btn btn-sm" type="submit">
                          Back to draft
                        </button>
                      </CommandForm>
                    ) : null}
                    {can('transition:in_progress') && state === 'ready' ? (
                      <CommandForm ctx={ctx} formId="to-start" operation="transition" inline>
                        <Hidden name="to" value="in_progress" />
                        <button class="btn btn-sm" type="submit">
                          Start it
                        </button>
                      </CommandForm>
                    ) : null}
                    {can('transition:in_review') && !decidedCurrent ? (
                      <CommandForm ctx={ctx} formId="to-review" operation="transition" inline>
                        <Hidden name="to" value="in_review" />
                        <button class="btn btn-sm" type="submit">
                          Move to review
                        </button>
                      </CommandForm>
                    ) : null}
                    {can('transition:in_progress') && state === 'in_review' ? (
                      <CommandForm ctx={ctx} formId="to-return" operation="transition" inline>
                        <Hidden name="to" value="in_progress" />
                        <button class="btn btn-sm" type="submit">
                          Back to in progress
                        </button>
                      </CommandForm>
                    ) : null}
                  </div>
                  {state === 'in_progress' && decidedCurrent ? (
                    <p class="small muted wk-tight">
                      {currentDecision === 'accept'
                        ? 'The current delivery was accepted, and the work was reopened since.'
                        : 'Changes were requested on the current delivery.'}{' '}
                      A new delivery from the agent moves it back to review.
                    </p>
                  ) : null}
                  {!actions.some((a) => a.startsWith('transition:') || a === 'reopen' || a === 'decision') ? (
                    <p class="small muted wk-tight">Nothing moves it from here for you right now.</p>
                  ) : null}
                  {state === 'draft' && !p.isAuthority ? (
                    <p class="small muted wk-tight">The owner, the acceptor or a workspace owner marks a draft ready.</p>
                  ) : null}

                  {can('transition:cancelled') ? (
                    <details open={p.refused?.formId === 'cancel'}>
                      <summary>Cancel this work</summary>
                      <CommandForm
                        ctx={ctx}
                        formId="cancel"
                        operation="transition"
                        confirm={{
                          title: 'Cancel this work?',
                          body: 'Cancelling does not stop an agent that is already running; it only closes the work item. You can reopen it later.',
                          action: 'Cancel the work',
                        }}
                      >
                        <Hidden name="to" value="cancelled" />
                        <Field id="cancel-reason" label="Why" required>
                          <textarea class="in" id="cancel-reason" name="reason" rows={2} required maxlength={1000}>
                            {typed.v('cancel', 'reason', '')}
                          </textarea>
                        </Field>
                        <button class="btn btn-danger btn-sm" type="submit">
                          Cancel the work
                        </button>
                      </CommandForm>
                    </details>
                  ) : null}
                  {can('reopen') ? (
                    <details open={p.refused?.formId === 'reopen'}>
                      <summary>Reopen</summary>
                      <CommandForm ctx={ctx} formId="reopen" operation="reopen">
                        <Field
                          id="reopen-reason"
                          label="Why"
                          required
                          help={state === 'accepted' ? 'It returns to in progress; the old acceptance stays in the history.' : 'A cancelled item returns to draft.'}
                        >
                          <textarea class="in" id="reopen-reason" aria-describedby="reopen-reason-help" name="reason" rows={2} required maxlength={1000}>
                            {typed.v('reopen', 'reason', '')}
                          </textarea>
                        </Field>
                        <button class="btn btn-sm" type="submit">
                          Reopen
                        </button>
                      </CommandForm>
                    </details>
                  ) : null}
                  {can('archive') ? (
                    <details open={p.refused?.formId === 'archive'}>
                      <summary>Archive</summary>
                      <CommandForm
                        ctx={ctx}
                        formId="archive"
                        operation="archive"
                        confirm={{
                          title: 'Archive this work?',
                          body: `An archived work item is read-only and leaves the lists. ${REOPEN_WORDS[state] ?? 'Reopening it brings it back.'}`,
                          action: 'Archive',
                        }}
                      >
                        <Field id="archive-reason" label="Why" help="Optional.">
                          <input class="in" id="archive-reason" aria-describedby="archive-reason-help" name="reason" maxlength={1000} value={typed.v('archive', 'reason', '')} />
                        </Field>
                        <button class="btn btn-sm" type="submit">
                          Archive
                        </button>
                      </CommandForm>
                    </details>
                  ) : null}
                </div>
              </Card>
            ) : can('reopen') ? (
              <Card title="Reopen">
                <div class="card-pad">
                  <CommandForm ctx={ctx} formId="reopen" operation="reopen">
                    <Field id="reopen-reason" label="Why" required help={REOPEN_WORDS[state] ?? 'Reopening it brings it back.'}>
                      <textarea class="in" id="reopen-reason" name="reason" rows={2} required maxlength={1000} aria-describedby="reopen-reason-help">
                        {typed.v('reopen', 'reason', '')}
                      </textarea>
                    </Field>
                    <button class="btn btn-sm" type="submit">
                      Reopen
                    </button>
                  </CommandForm>
                </div>
              </Card>
            ) : null}

            {can('assign') ? (
              <Card
                title="Assign to an agent"
                id="assign-card"
                note="Sends the contract to one named agent, bound to this revision. Starting a run linked to this work is the agent's part."
              >
                <div class="card-pad wk-prose">
                  {p.agents && p.agents.length ? (
                    <CommandForm ctx={ctx} formId="assign" operation="assign">
                      <Field id="assign-agent" label="Agent" required>
                        <select class="in" id="assign-agent" name="agent" required>
                          {/* A refused form whose agent is no longer offered gets an
                              empty choice, selected: a select whose value is missing
                              from its options sends its first one, and the work would
                              go to an agent nobody picked. `required` holds it. */}
                          {typed.v('assign', 'agent', '') && !p.agents.some((agent) => agent.installationId === typed.v('assign', 'agent', '')) ? (
                            <option value="" selected>
                              Choose an agent again
                            </option>
                          ) : null}
                          {p.agents.map((agent) => (
                            <option value={agent.installationId} selected={agent.installationId === typed.v('assign', 'agent', '')}>
                              {agent.label}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field
                        id="assign-brief"
                        label="Brief"
                        help="Leave empty to send the goal and the acceptance criteria. The agent treats this as data from your team."
                      >
                        <textarea class="in" id="assign-brief" aria-describedby="assign-brief-help" name="brief" rows={3} maxlength={8000}>
                          {typed.v('assign', 'brief', '')}
                        </textarea>
                      </Field>
                      <button class="btn btn-primary btn-sm" type="submit">
                        Assign
                      </button>
                    </CommandForm>
                  ) : (
                    <p class="small muted wk-tight">
                      No agent is connected to this project yet.{' '}
                      <a href={connectionsHref(p.team.slug, p.project.slug)}>Connect an agent</a>, then assign from here.
                    </p>
                  )}
                </div>
              </Card>
            ) : null}

            {!archived && state !== 'cancelled' ? (
              <Card title="Edit">
                <div class="card-pad wk-prose">
                  <details open={p.refused?.formId === 'edit-coordination'}>
                    <summary>Priority, due date, labels</summary>
                    <CommandForm ctx={ctx} formId="edit-coordination" operation="patch">
                      <Hidden name="group" value="coordination" />
                      {/* The date the field showed: a due time it cannot show is kept unless the date is changed. */}
                      <Hidden name="due_shown" value={work.due_at ? String(work.due_at).slice(0, 10) : ''} />
                      <div class="flow-form-row">
                        <Field id="edit-coordination-priority" label="Priority">
                          <select class="in" id="edit-coordination-priority" name="priority">
                            <Options options={PRIORITY_OPTIONS} selected={typed.v('edit-coordination', 'priority', String(work.priority))} />
                          </select>
                        </Field>
                        <Field id="edit-coordination-due" label="Due date (UTC)">
                          <input
                            class="in"
                            id="edit-coordination-due"
                            name="due"
                            type="date"
                            value={typed.v('edit-coordination', 'due', work.due_at ? String(work.due_at).slice(0, 10) : '')}
                          />
                        </Field>
                      </div>
                      <Field id="edit-coordination-labels" label="Labels" help="Separated by commas.">
                        <input
                          class="in"
                          id="edit-coordination-labels"
                          aria-describedby="edit-coordination-labels-help"
                          name="labels"
                          value={typed.v('edit-coordination', 'labels', (work.labels as string[]).join(', '))}
                        />
                      </Field>
                      <button class="btn btn-sm" type="submit">
                        Save
                      </button>
                    </CommandForm>
                  </details>
                  {p.isAuthority ? (
                    <details open={p.refused?.formId === 'edit-people'}>
                      <summary>Owner and acceptor</summary>
                      <CommandForm ctx={ctx} formId="edit-people" operation="patch">
                        <Hidden name="group" value="people" />
                        <Field id="edit-people-owner" label="Owner">
                          <PeopleSelect
                            id="edit-people-owner"
                            name="owner"
                            members={p.members}
                            selected={typed.v('edit-people', 'owner', work.owner ?? '')}
                            none="Nobody"
                          />
                        </Field>
                        <Field id="edit-people-acceptor" label="Acceptor" help="Decides on the delivery. Must be a member.">
                          <PeopleSelect
                            id="edit-people-acceptor"
                            describedBy="edit-people-acceptor-help"
                            name="acceptor"
                            members={p.members}
                            selected={typed.v('edit-people', 'acceptor', work.acceptor ?? '')}
                            none="Nobody yet"
                          />
                        </Field>
                        <button class="btn btn-sm" type="submit">
                          Save people
                        </button>
                      </CommandForm>
                    </details>
                  ) : null}
                  {contractEditable ? (
                    <details open={p.refused?.formId === 'edit-contract'}>
                      <summary>Contract and criteria</summary>
                      <CommandForm
                        ctx={ctx}
                        formId="edit-contract"
                        operation="patch"
                        confirm={
                          state === 'accepted' || state === 'in_review'
                            ? {
                                title: 'Change the contract?',
                                body:
                                  state === 'accepted'
                                    ? 'This work is accepted. Changing its contract makes a new revision and reopens it; the old acceptance stays in the history.'
                                    : 'This work is in review. Changing its contract makes a new revision, sends it back to in progress and the current delivery no longer counts.',
                                action: 'Change the contract',
                              }
                            : undefined
                        }
                      >
                        <Hidden name="group" value="contract" />
                        <p class="small muted wk-tight">
                          A change to anything here is a new contract revision. Assignments and runs bound to the old one are named,
                          not stopped.
                          {state === 'accepted' ? ' This work is accepted: changing it reopens it, and you must say why.' : ''}
                          {state === 'in_review' ? ' It is in review: a change sends it back to in progress and the delivery no longer counts.' : ''}
                        </p>
                        <ContractFields
                          formId="edit-contract"
                          ownedBy={externals.find((ref) => !ref.detached_at && ref.mode === 'external_authoritative')?.remote_id ?? null}
                          typed={typed}
                          values={{
                            title: String(contract.title ?? work.title),
                            goal: String(contract.goal ?? ''),
                            non_goals: String(contract.non_goals ?? ''),
                            scope_paths: p.scopePaths,
                            risk_tier: String(contract.risk_tier ?? 'medium'),
                            artifact_kind: String(contract.artifact_kind ?? ''),
                            independent: p.independent,
                          }}
                        />
                        <CriteriaRows
                          formId="edit-contract"
                          rows={contractRows.rows}
                          count={contractRows.count}
                          typed={typed}
                          dropped={contractRows.dropped}
                        />
                        <Field id="edit-contract-change" label="Why" help="Recorded on the revision.">
                          <input class="in" id="edit-contract-change" aria-describedby="edit-contract-change-help" name="change_reason" maxlength={1000} value={typed.v('edit-contract', 'change_reason', '')} />
                        </Field>
                        {state === 'accepted' ? (
                          <Field id="edit-contract-reopen" label="Why reopen" required help="Changing an accepted contract reopens it.">
                            <input class="in" id="edit-contract-reopen" aria-describedby="edit-contract-reopen-help" name="reopen_reason" maxlength={1000} required value={typed.v('edit-contract', 'reopen_reason', '')} />
                          </Field>
                        ) : null}
                        <button class="btn btn-primary btn-sm" type="submit">
                          Save contract
                        </button>
                      </CommandForm>
                    </details>
                  ) : (
                    <p class="small muted wk-tight">
                      The owner, the acceptor or a workspace owner changes the contract.
                    </p>
                  )}
                </div>
              </Card>
            ) : null}
          </div>
        </div>
      </div>
    </AppLayout>
  );
};

// ---------------------------------------------------------------------------
// The tracker record.
// ---------------------------------------------------------------------------

/**
 * What reading an issue that owns the contract does to work in review, said
 * before the click: a newer issue is taken as a new contract revision, which
 * sends the work back to in progress, and the delivery waiting for a decision
 * no longer counts. "Read GitHub again" sounds like a read; here it can be a write.
 */
const IN_REVIEW_FOLLOW =
  'This work is in review. If the issue changed, its title and goal become a new contract revision: the work goes back to in progress and the delivery waiting for a decision no longer counts, so the agent delivers again.';

/** GitHub's own open or closed, said as GitHub's: it is never an STMA acceptance either way. */
const REMOTE_STATE: Record<string, string> = {
  open: 'Open on GitHub.',
  closed: "Closed on GitHub. That is GitHub's state; it is not an acceptance here.",
  unknown: 'GitHub did not say whether it is open.',
};

const SYNC_PILL: Record<string, { label: string; pill: string }> = {
  external_change_pending: { label: 'Change waiting', pill: 'pill-warn' },
  conflict: { label: 'Conflict', pill: 'pill-danger' },
  unavailable: { label: 'Unavailable', pill: 'pill-muted' },
};

const RemoteLink = ({ record }: { record: Rec }) =>
  safeHref(record.remote_url) ? (
    <a href={safeHref(record.remote_url)!} rel="noopener noreferrer nofollow">
      {record.remote_id}
    </a>
  ) : (
    <b>{record.remote_id}</b>
  );

/**
 * The work's tie to a tracker record: what GitHub said when STMA last read it,
 * which mode it is in and, for a person with authority over the work, the five
 * things that can be done to it. No form here writes to GitHub.
 */
function ExternalCard({
  refs,
  ctx,
  canChange,
  state,
  refused,
}: {
  refs: Rec[];
  ctx: CommandCtx;
  canChange: boolean;
  state: string;
  refused?: Refused;
}) {
  const typed = ctx.typed;
  const live = refs.find((record) => !record.detached_at) ?? null;
  const old = refs.filter((record) => record.detached_at);
  return (
    <Card title="External reference" id="external" note="An item in another tracker. STMA reads it and never writes back to it.">
      <div class="card-pad wk-prose">
        {live ? (
          <LiveExternal record={live} ctx={ctx} canChange={canChange} state={state} refused={refused} />
        ) : (
          <p class="small muted wk-tight">This work is not tied to a tracker record.</p>
        )}
        {!live && canChange && state !== 'cancelled' ? (
          <details open={refused?.formId === 'ext-attach'}>
            <summary>Tie it to a GitHub issue</summary>
            <CommandForm
              ctx={ctx}
              formId="ext-attach"
              operation="reconcile_external"
              confirm={
                state === 'in_review' || state === 'ready'
                  ? {
                      title: 'Tie this work to the issue?',
                      body:
                        'If the issue becomes the source of truth and its title or description says something else, the contract changes to match it: a new revision, and work in review goes back to in progress.',
                      action: 'Tie it',
                    }
                  : undefined
              }
            >
              <Hidden name="action" value="attach" />
              <Field id="ext-attach-issue" label="Issue" required help="#42 for this project's repository, owner/repo#42, or the issue's address.">
                <input class="in" id="ext-attach-issue" aria-describedby="ext-attach-issue-help" name="issue" required maxlength={300} value={typed.v('ext-attach', 'issue', '')} />
              </Field>
              <Field id="ext-attach-mode" label="How the work follows it">
                <select class="in" id="ext-attach-mode" name="mode">
                  <Options
                    options={[
                      { value: 'reference', label: 'Reference: shown beside the work, which stays STMA\'s' },
                      { value: 'external_authoritative', label: 'Source of truth: the title and goal follow the issue' },
                    ]}
                    selected={typed.v('ext-attach', 'mode', 'reference')}
                  />
                </select>
              </Field>
              <button class="btn btn-sm" type="submit">
                Tie it
              </button>
            </CommandForm>
          </details>
        ) : null}
        {old.length ? (
          <details>
            <summary>Detached ({old.length})</summary>
            <ul class="wk-rows">
              {old.map((record) => (
                <li class="wk-row wk-old">
                  <div>
                    <RemoteLink record={record} /> <span class="pill pill-muted">{MODE_WORDS[record.mode]?.label ?? record.mode}</span>
                  </div>
                  <div class="small muted">Detached {ago(record.detached_at)}.</div>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </Card>
  );
}

function LiveExternal({
  record,
  ctx,
  canChange,
  state,
  refused,
}: {
  record: Rec;
  ctx: CommandCtx;
  canChange: boolean;
  state: string;
  refused?: Refused;
}) {
  const typed = ctx.typed;
  const remote: Rec | null = record.remote ?? null;
  const pending: Rec | null = record.pending ?? null;
  const sync = SYNC_PILL[record.sync_state];
  const authoritative = record.mode === 'external_authoritative';
  const RefFields = () => <Hidden name="ref_id" value={String(record.id)} />;
  return (
    <>
      <div>
        <span class="pill pill-muted">{record.provider_name ?? record.provider}</span> <RemoteLink record={record} />{' '}
        <span class="pill pill-info">{MODE_WORDS[record.mode]?.label ?? record.mode}</span>
        {sync ? <span class={`pill ${sync.pill} wk-gap`}>{sync.label}</span> : null}
      </div>
      {remote ? (
        <p class="wk-text">
          <b>{remote.title}</b>
        </p>
      ) : null}
      <p class="small muted wk-tight">{MODE_WORDS[record.mode]?.note}</p>
      <p class="small wk-tight">
        {REMOTE_STATE[remote?.state ?? 'unknown'] ?? REMOTE_STATE.unknown}
        {remote?.labels?.length ? <> Labels there: {(remote.labels as string[]).join(', ')}.</> : null}
        {remote?.body_truncated ? <> The description is longer than a goal holds; the rest is on GitHub.</> : null}
      </p>
      <p class="small muted wk-tight">
        {SYNC_WORDS[record.sync_state] ?? record.sync_state} Last read {ago(record.last_observed_at)}; the version shown is GitHub's update
        of {at(remote?.updated_at)}.
      </p>

      {pending ? (
        <div class="wk-tight">
          <p class="small">
            <span class="pill pill-warn">Waiting</span> GitHub's update of {at(pending.updated_at)}: <b>{pending.title}</b>
          </p>
          {canChange ? (
            <details open={refused?.formId === 'ext-accept'}>
              <summary>Take this version</summary>
              <CommandForm
                ctx={ctx}
                formId="ext-accept"
                operation="reconcile_external"
                confirm={
                  authoritative && state === 'accepted'
                    ? {
                        title: 'Take the version from GitHub?',
                        body: 'This work is accepted. Taking a version that changes its title or goal reopens it; the acceptance stays in the history.',
                        action: 'Take it and reopen',
                      }
                    : authoritative && state === 'in_review'
                      ? {
                          title: 'Take the version from GitHub?',
                          body: IN_REVIEW_FOLLOW,
                          action: 'Take it',
                        }
                      : undefined
                }
              >
                <Hidden name="action" value="accept_remote" />
                <RefFields />
                <Hidden name="remote_revision" value={String(pending.remote_revision ?? '')} />
                <Field
                  id="ext-accept-reason"
                  label="Why"
                  required={authoritative && state === 'accepted'}
                  help={authoritative && state === 'accepted' ? 'Taking it reopens the accepted work.' : 'Optional.'}
                >
                  <input
                    class="in"
                    id="ext-accept-reason"
                    aria-describedby="ext-accept-reason-help"
                    name="reason"
                    maxlength={1000}
                    required={authoritative && state === 'accepted'}
                    value={typed.v('ext-accept', 'reason', '')}
                  />
                </Field>
                <button class="btn btn-sm" type="submit">
                  Take this version
                </button>
              </CommandForm>
            </details>
          ) : null}
        </div>
      ) : null}

      {canChange ? (
        <>
          <div class="wk-actions">
            {record.mode !== 'imported_native' && record.connection_available ? (
              <CommandForm
                ctx={ctx}
                formId="ext-refresh"
                operation="reconcile_external"
                inline
                confirm={
                  authoritative && state === 'in_review'
                    ? { title: 'Read GitHub again?', body: IN_REVIEW_FOLLOW, action: 'Read GitHub again' }
                    : undefined
                }
              >
                <Hidden name="action" value="refresh" />
                <RefFields />
                <button class="btn btn-sm" type="submit">
                  Read GitHub again
                </button>
              </CommandForm>
            ) : null}
          </div>
          {!record.connection_available ? (
            <p class="small muted wk-tight">
              The connection it was read through was removed. Detach this record, then tie the issue again through the workspace's
              current GitHub connection.
            </p>
          ) : null}
          {record.mode !== 'reference' ? (
            <details open={refused?.formId === 'ext-convert'}>
              <summary>Make it a reference</summary>
              <CommandForm ctx={ctx} formId="ext-convert" operation="reconcile_external">
                <Hidden name="action" value="convert_to_reference" />
                <RefFields />
                <p class="small muted wk-tight">
                  The issue stays beside the work for context and every field is STMA's to change. Nothing is revised.
                </p>
                <Field id="ext-convert-reason" label="Why" help="Optional.">
                  <input class="in" id="ext-convert-reason" aria-describedby="ext-convert-reason-help" name="reason" maxlength={1000} value={typed.v('ext-convert', 'reason', '')} />
                </Field>
                <button class="btn btn-sm" type="submit">
                  Make it a reference
                </button>
              </CommandForm>
            </details>
          ) : null}
          <details open={refused?.formId === 'ext-detach'}>
            <summary>Detach</summary>
            <CommandForm
              ctx={ctx}
              formId="ext-detach"
              operation="reconcile_external"
              confirm={{
                title: 'Detach the issue?',
                body: 'The work stops following the issue. The record and its history stay on the work, and the contract is not changed.',
                action: 'Detach',
              }}
            >
              <Hidden name="action" value="detach" />
              <RefFields />
              <Field
                id="ext-detach-reason"
                label="Why"
                required={authoritative}
                help={authoritative ? 'The issue owns the title and goal now, so say why it stops.' : 'Optional.'}
              >
                <input class="in" id="ext-detach-reason" aria-describedby="ext-detach-reason-help" name="reason" maxlength={1000} required={authoritative} value={typed.v('ext-detach', 'reason', '')} />
              </Field>
              <button class="btn btn-sm" type="submit">
                Detach
              </button>
            </CommandForm>
          </details>
        </>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// The decision.
// ---------------------------------------------------------------------------

/**
 * Would a human check passed in the decision make this criterion pass: its
 * rule has a human check selector and nothing else in it stands in the way
 * (`all`: every other selector passes; `any`: no other selector fails, since a
 * fail anywhere is the criterion's result). The decision reads the evidence
 * again after the check, so this is what accepting in the same form can do.
 */
function humanCheckCanPass(readiness: Rec | undefined): boolean {
  const selectors: Rec[] = readiness?.selectors ?? [];
  if (!selectors.some((s) => s.source === 'human_check')) return false;
  const others = selectors.filter((s) => s.source !== 'human_check');
  return readiness?.mode === 'any' ? !others.some((s) => s.result === 'fail') : others.every((s) => s.result === 'pass');
}

function DecisionPanel({
  p,
  ctx,
  current,
  criteria,
  byCriterion,
}: {
  p: DetailProps;
  ctx: CommandCtx;
  current: Rec | null;
  criteria: Rec[];
  byCriterion: Map<string, Rec>;
}) {
  const { work, evidence } = p;
  const typed = ctx.typed;
  const id = 'decision';
  const readiness: Rec = evidence.readiness;
  const humanChecks = criteria.filter((c) => (c.verification_rule?.selectors ?? []).some((s: Rec) => s.source === 'human_check'));
  const artifacts: Rec[] = current?.artifacts ?? [];
  const override = work.acceptor !== p.user.username;
  const notPassing = criteria.filter((c) => c.required && (byCriterion.get(c.id)?.result ?? 'unknown') !== 'pass');
  // A criterion whose rule includes a human check cannot pass before a
  // decision: the check is recorded by this form, and the decision reads the
  // evidence again after it. One that a pass recorded here would make pass is
  // not a reason to say accepting is refused.
  const byCheck = notPassing.filter((c) => humanCheckCanPass(byCriterion.get(c.id)));
  const unmet = notPassing.filter((c) => !byCheck.includes(c));
  const one = (n: number, singular: string, plural: string) => (n === 1 ? singular : plural);
  // With more evidence than the review lists, "shown here" would say the
  // decision rests on fewer rows than the manifest it is bound to holds.
  const evidenceCut = Boolean(work.sections?.evidence?.next_cursor);
  return (
    <section class="card-pad wk-prose" id="decision-card">
      <h3 class="wk-h3">Your decision</h3>
      <p class="small muted wk-tight">{
        evidenceCut
          ? 'Recorded against the exact delivery and every row of its evidence, including rows this card does not list. If either moves while you read, the decision is refused and you decide again.'
          : 'Recorded against the exact delivery and evidence shown here. If either moves while you read, the decision is refused and you decide again.'
      }</p>
      <div>
        <p class="small wk-tight">
          {readiness.ready_for_review ? (
            <>
              <span class="pill pill-active">Ready for review</span> {evidence.ready_for_review_meaning}
            </>
          ) : unmet.length === 0 && byCheck.length > 0 ? (
            <>
              <span class="pill pill-warn">Needs your check</span> {byCheck.length} required{' '}
              {one(byCheck.length, 'criterion waits', 'criteria wait')} for a human check. Record a pass for{' '}
              {one(byCheck.length, 'it', 'each')} under Human checks below and you can accept in this same decision; you can also
              request changes.
            </>
          ) : (
            <>
              <span class="pill pill-warn">Not ready</span> {unmet.length} required{' '}
              {one(unmet.length, 'criterion does', 'criteria do')} not pass yet. Accepting is refused until they do; you can still
              request changes.
              {byCheck.length ? (
                <>
                  {' '}
                  {byCheck.length} more {one(byCheck.length, 'waits', 'wait')} for a human check below.
                </>
              ) : null}
            </>
          )}
        </p>
        {override ? (
          <p class="small wk-tight">
            You are deciding as a workspace owner instead of {work.acceptor ?? 'an acceptor'}. A reason is required, and it is
            recorded as an override.
          </p>
        ) : null}
        <form
          method="post"
          action={`${ctx.action.replace(/\/command$/, '/decision')}`}
          class="wk-form"
          id={id}
          data-confirm="Your decision is recorded against the delivery and evidence shown on this page. Nothing is merged or deployed by it."
          data-confirm-title="Record this decision?"
          data-confirm-action="Record decision"
        >
          <Hidden name="form_id" value={id} />
          <Hidden name="request_id" value={randomUUID()} />
          <Hidden name="expected_version" value={ctx.version} />
          <Hidden name="spec_revision" value={ctx.specRevision} />
          <Hidden name="delivery_id" value={String(evidence.delivery_id ?? '')} />
          <Hidden name="evidence_epoch" value={String(evidence.evidence_epoch)} />
          <Hidden name="evidence_manifest_hash" value={String(evidence.evidence_manifest_hash)} />

          {humanChecks.length ? (
            <fieldset class="wk-crit">
              <legend>Human checks</legend>
              <p class="small muted wk-tight">
                These criteria ask a person to look. Say what you checked and on which artifact version; a general "I looked" is not
                a check.
              </p>
              {humanChecks.map((criterion, index) => (
                // A group named by its criterion: every block's controls carry
                // the same three labels, and without the name a screen reader
                // tabbing through hears "Result" twice with nothing saying
                // which criterion each one records. The number is the one a
                // refusal names ("human check 2"), so it is on the page too.
                <div class="wk-check-block" role="group" aria-labelledby={`h${index}_label`}>
                  <Hidden name={`h${index}_criterion`} value={criterion.id} />
                  <div class="wk-text" id={`h${index}_label`}>
                    <span class="small muted">Human check {index + 1}:</span> <span class="mono">{criterion.id}</span> {criterion.text}
                  </div>
                  <div class="wk-crit-row">
                    <div class="field">
                      <label for={`h${index}_assertion`}>Result</label>
                      <select class="in" id={`h${index}_assertion`} name={`h${index}_assertion`}>
                        <Options
                          options={[
                            { value: '', label: 'Not checked' },
                            { value: 'pass', label: 'Pass' },
                            { value: 'fail', label: 'Fail' },
                          ]}
                          selected={typed.v(id, `h${index}_assertion`, '')}
                        />
                      </select>
                    </div>
                    <div class="field">
                      <label for={`h${index}_artifact`}>Artifact you looked at</label>
                      <select class="in" id={`h${index}_artifact`} name={`h${index}_artifact`}>
                        {artifacts.map((artifact, n) => (
                          <option value={`artifacts[${n}]`} selected={typed.v(id, `h${index}_artifact`, 'artifacts[0]') === `artifacts[${n}]`}>
                            {n + 1}. {cut(artifactLine(artifact, n).head, 60)} ({artifactLine(artifact, n).exact ? 'exact version' : 'unversioned'})
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div class="field">
                    <label for={`h${index}_note`}>What you saw</label>
                    <textarea class="in" id={`h${index}_note`} name={`h${index}_note`} rows={2} maxlength={1000}>
                      {typed.v(id, `h${index}_note`, '')}
                    </textarea>
                  </div>
                </div>
              ))}
            </fieldset>
          ) : null}

          <fieldset class="wk-crit">
            <legend>Decision</legend>
            <label class="wk-check">
              <input type="radio" name="decision" value="accept" required checked={typed.v(id, 'decision', '') === 'accept'} />
              Accept this delivery
            </label>
            <label class="wk-check">
              <input type="radio" name="decision" value="request_changes" required checked={typed.v(id, 'decision', '') === 'request_changes'} />
              Request changes
            </label>
          </fieldset>
          <Field
            id="decision-reason"
            label="Reason"
            required={override}
            help={override ? 'Required: you are not the named acceptor.' : 'Required when requesting changes; optional when accepting.'}
          >
            {/* Marked required and required in the browser too: the confirm
                dialog asked "Record this decision?" before a certain refusal. */}
            <textarea class="in" id="decision-reason" aria-describedby="decision-reason-help" name="reason" rows={3} maxlength={1000} required={override}>
              {typed.v(id, 'reason', '')}
            </textarea>
          </Field>
          <fieldset class="wk-crit">
            <legend>Criteria not met (for requested changes)</legend>
            {criteria.map((criterion) => {
              const result = byCriterion.get(criterion.id)?.result ?? 'unknown';
              const held = typed.many(id, 'criteria');
              const picked = held ? held.includes(criterion.id) : criterion.required && result !== 'pass';
              return (
                <label class="wk-check small">
                  <input type="checkbox" name="criteria" value={criterion.id} checked={picked} />
                  <span>
                    <span class="mono">{criterion.id}</span> {cut(String(criterion.text), 120)} <span class="muted">({RESULT_LABEL[result] ?? result})</span>
                  </span>
                </label>
              );
            })}
          </fieldset>
          <button class="btn btn-primary" type="submit">
            Record decision
          </button>
        </form>
      </div>
    </section>
  );
}
