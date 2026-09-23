import { snapshotSchema, type PolicyDocument } from '@bridge/shared';
import { and, count, desc, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { loginRedirect } from '../auth/session';
import { agentRuns, environmentChecks, policyReceipts, projects, snapshots, users } from '../db/schema';
import { projectForTeam, teamForUser } from '../domain/access';
import { recentAgentEvents } from '../domain/fleetReaders';
import {
  activeBaselines,
  recentEnvironmentChecks,
  setEnvironmentBaseline,
} from '../domain/environments';
import { EMPTY_POLICY, policyScopes, publishPolicy, recentPolicyReceipts } from '../domain/policies';
import { policyOrigins, type OriginRule, type PolicyOrigins, type RuleOrigin } from '../lib/policyOrigin';
import { recentPolicyViolations } from '../domain/violations';
import { renderPolicyEditor } from './policyEditor';
import { cheapestWith, effectiveLimits } from '../lib/entitlements';
import { timeAgo } from '../lib/format';
import { isEmptyPolicy, policyFromForm } from '../lib/policyForm';
import { failed } from '../lib/result';
import { projectInPath, scopedProjectParam, sectionHref } from '../lib/scope';
import { track } from '../lib/track';
import type { AppEnv } from '../types';
import { Lead, PageHead, ProjectScope, scopedTrail, Vr } from '../ui/Console';
import { AppLayout } from '../ui/Layout';

export const governanceRoutes = new Hono<AppEnv>();

/** Every list on this page is a bounded window — governance must never become a load source. */
const RECEIPT_LIMIT = 25;
const CHECK_LIMIT = 25;
const BASELINE_LIMIT = 25;
const EVENT_LIMIT = 50;
const VIOLATION_LIMIT = 25;
/** A stopped attempt is news for a day; after that it is history on the card, not an alarm on the strip. */
const VIOLATION_ALERT_MS = 24 * 60 * 60 * 1000;
const SCOPE_LIMIT = 12;
const PROJECT_LIMIT = 50;
/** Snapshots offered as a baseline candidate — newest first, never a full scan. */
const SNAPSHOT_LIMIT = 40;

const short = (hash: string | null | undefined): string => (hash ? hash.slice(0, 12) : '—');

const CHECK_PILL: Record<string, string> = {
  critical: 'pill pill-danger',
  warning: 'pill pill-warn',
  ok: 'pill pill-active',
  no_baseline: 'pill pill-muted',
};

const CHECK_LABEL: Record<string, string> = {
  critical: 'critical',
  warning: 'warning',
  ok: 'ok',
  no_baseline: 'no baseline',
};

/** One labelled block of policy rules; says so plainly when a section is empty. */
const Rules = ({ label, items }: { label: string; items: string[] }) => (
  <div class="step">
    <span class="steplabel">{label}</span>
    {items.length === 0 ? (
      <span class="muted small">none</span>
    ) : (
      <div class="row" style="flex-wrap:wrap;gap:6px">
        {items.map((item) => (
          <span class="pill pill-member pill-rule">{item}</span>
        ))}
      </div>
    )}
  </div>
);

/** The merged document exactly as an agent in this scope receives it. */
const PolicyDoc = ({ document }: { document: PolicyDocument }) => (
  <div style="display:flex;flex-direction:column;gap:16px">
    <div class="step">
      <span class="steplabel">Guidance</span>
      {document.guidance.length === 0 ? (
        <span class="muted small">none</span>
      ) : (
        document.guidance.map((line) => (
          <p class="m0 small" style="color:var(--txt-2)">
            {line}
          </p>
        ))
      )}
    </div>
    <Rules label="Denied" items={document.permissions.deny} />
    <Rules label="Requires approval" items={document.permissions.requireApproval} />
    <Rules label="Required checks" items={document.requiredChecks} />
    <Rules label="Protected paths" items={document.protectedPaths} />
    <Rules label="Required env vars" items={document.environment.requiredEnvVarNames} />
    <Rules
      label="Runtimes"
      items={Object.entries(document.environment.runtimes).map(
        ([runtime, version]) => `${runtime} ${version}`,
      )}
    />
  </div>
);

/**
 * The same document, with every rule filed under where it comes from. A project
 * page answers "is this ours or everybody's" — the question that decides where
 * to go to change it. `only` draws one origin: the workspace page lists what a
 * project adds without repeating the workspace's rules in every card.
 */
const PolicyByOrigin = ({ origins, only }: { origins: PolicyOrigins; only?: RuleOrigin }) => {
  const sections = origins.sections
    .map((section) => ({
      ...section,
      rules: only ? section.rules.filter((rule) => rule.origin === only) : section.rules,
    }))
    .filter((section) => !only || section.rules.length > 0);
  const Group = ({ origin, rules }: { origin: RuleOrigin; rules: OriginRule[] }) =>
    rules.length === 0 ? null : (
      <div class="origin-row">
        {only ? null : (
          <span class={`origin origin-${origin}`}>
            {origin === 'workspace' ? 'from the workspace' : 'this project only'}
          </span>
        )}
        <div class="row" style="flex-wrap:wrap;gap:6px">
          {rules.map((rule) => (
            <span
              class={`pill pill-rule ${origin === 'project' ? 'pill-own' : 'pill-member'}`}
              title={rule.note}
            >
              {rule.text}
              {rule.note ? <span class="origin-note"> · {rule.note}</span> : null}
            </span>
          ))}
        </div>
      </div>
    );
  return (
    <div style="display:flex;flex-direction:column;gap:16px">
      {sections.map((section) => (
        <div class="step">
          <span class="steplabel">{section.label}</span>
          {section.rules.length === 0 ? (
            <span class="muted small">none</span>
          ) : (
            <>
              <Group origin="workspace" rules={section.rules.filter((rule) => rule.origin === 'workspace')} />
              <Group origin="project" rules={section.rules.filter((rule) => rule.origin === 'project')} />
            </>
          )}
        </div>
      ))}
    </div>
  );
};

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Human-readable line for one append-only agent event. The known types get a
 * sentence; anything written later still renders through the generic fallback.
 */
function eventDetail(type: string, detail: unknown): string {
  if (!detail || typeof detail !== 'object') return '';
  const d = detail as Record<string, unknown>;
  if (type === 'run_started') {
    return [d.repo, d.branch].filter(Boolean).join(' · ');
  }
  if (type === 'policy_violation') {
    return [d.outcome, d.path, d.rule].filter(Boolean).join(' · ');
  }
  if (type === 'run_finished') {
    return [d.status, d.detail].filter(Boolean).join(' · ');
  }
  if (type === 'conflicts_detected') {
    const others = Array.isArray(d.otherRunIds) ? d.otherRunIds.length : 0;
    return [
      plural(Number(d.count ?? 0), 'overlapping claim'),
      d.highestSeverity,
      `against ${plural(others, 'run')}`,
    ]
      .filter(Boolean)
      .join(' · ');
  }
  if (type === 'ground_acknowledged') {
    // The agent restated ground it had just been told moved: what lets the write
    // guard allow the edit it refused with stale_ground.
    const claims = Array.isArray(d.claims) ? (d.claims as { resourceKey?: unknown }[]) : [];
    const keys = claims.map((claim) => String(claim?.resourceKey ?? '')).filter(Boolean);
    return ['acknowledged moved ground', keys.slice(0, 3).join(', ') + (keys.length > 3 ? ` +${keys.length - 3}` : '')]
      .filter(Boolean)
      .join(' · ');
  }
  if (type === 'pr_opened' || type === 'pr_merged' || type === 'pr_closed') {
    return [`PR #${d.number ?? '?'}`, d.title].filter(Boolean).join(' · ');
  }
  if (type === 'ci_completed') {
    return [d.workflow, d.conclusion].filter(Boolean).join(' · ');
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(d)) {
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length > 0) parts.push(`${key}: ${value.length}`);
      continue;
    }
    if (typeof value === 'object') continue;
    parts.push(`${key}: ${String(value)}`);
  }
  return parts.join(' · ').slice(0, 160);
}

function eventPill(type: string, detail: unknown): string {
  if (type === 'policy_violation') return 'pill pill-danger';
  if (type === 'conflicts_detected') {
    const severity = (detail as { highestSeverity?: string } | null)?.highestSeverity;
    return severity === 'critical' ? 'pill pill-danger' : 'pill pill-warn';
  }
  if (type === 'run_finished') {
    const status = (detail as { status?: string } | null)?.status;
    return status === 'failed' ? 'pill pill-danger' : 'pill pill-active';
  }
  if (type === 'pr_merged') return 'pill pill-active';
  if (type === 'pr_closed') return 'pill pill-warn';
  if (type === 'ci_completed') {
    const conclusion = (detail as { conclusion?: string } | null)?.conclusion;
    return conclusion === 'failure' ? 'pill pill-danger' : 'pill pill-active';
  }
  return 'pill pill-member';
}

/**
 * One page, two addresses: the workspace's governance, and a project's own.
 *
 * `/app/teams/:slug/projects/:project/governance` is what the rail links to;
 * `/app/teams/:slug/governance?project=…` is the address it replaces and still
 * answers. Both run this function — a second render would be a second set of
 * rules about who may read what, which is exactly what this page is about.
 */
const governancePage = async (c: Context<AppEnv>) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await teamForUser(db, user.id, c.req.param('slug') ?? '');
  if (!found) {
    return c.html(
      <AppLayout user={user} active="governance" title="Not found">
        <div class="card card-pad joincard">
          <span class="tile tile-44 tile-gray">×</span>
          <h2 class="title m0">Team not found</h2>
          <p class="m0 sub">Either it does not exist or you are not a member.</p>
          <a class="btn" href="/app" style="align-self:flex-start">
            Back to teams
          </a>
        </div>
      </AppLayout>,
      404,
    );
  }
  const { team, role } = found;
  const isOwner = role === 'owner';

  // The MCP half of governance — get_policy, check_environment — has been gated
  // since the plan reached the product. This page was not, so an agent was
  // refused the rulebook while its human read the whole governance screen next
  // to it. One line in a matrix cannot mean two things depending on which door
  // you come through.
  const limits = (await effectiveLimits(db, team, c.get('env').hosted));
  if (!limits.governance) {
    const [receiptCount, checkCount] = await Promise.all([
      db.select({ n: count() }).from(policyReceipts).innerJoin(agentRuns, eq(policyReceipts.runId, agentRuns.id)).where(eq(agentRuns.teamId, team.id)),
      db.select({ n: count() }).from(environmentChecks).where(eq(environmentChecks.teamId, team.id)),
    ]);
    const receipts = receiptCount[0]?.n ?? 0;
    const checks = checkCount[0]?.n ?? 0;
    const from = cheapestWith((l) => l.governance) ?? 'a paid';
    return c.html(
      <AppLayout user={user} active="governance" title={`Governance — ${team.name}`}>
        <div class="card card-pad joincard">
          <span class="tile tile-44 tile-gray">§</span>
          <h2 class="title m0">Governance</h2>
          <p class="m0 sub">
            One rulebook for {team.name}'s agents, the receipts saying which of them applied it,
            and a preflight that stops a machine before it wastes an hour. Included from the {from}{' '}
            plan up.
          </p>
          {receipts + checks > 0 ? (
            <p class="m0 small muted">
              {receipts > 0 ? `${receipts} policy ${receipts === 1 ? 'receipt' : 'receipts'}` : ''}
              {receipts > 0 && checks > 0 ? ' and ' : ''}
              {checks > 0 ? `${checks} environment ${checks === 1 ? 'check' : 'checks'}` : ''}{' '}
              are already recorded for this team. Turning this on reads them; nothing is being
              thrown away while you decide.
            </p>
          ) : (
            <p class="m0 small muted">
              Nothing recorded yet. Receipts and preflight results appear on their own once agents
              are reading a policy.
            </p>
          )}
        </div>
      </AppLayout>,
      402,
    );
  }

  // Global by default; a project narrows every list on the page to that project.
  // Named in the path it is part of the page's identity, so a spelling that names
  // no project is a wrong address and answers like one — the same 404 the project
  // pages give. As the older `?project=` filter it stays a filter: the page draws
  // the whole team and says the name matched nothing.
  const projectQuery = scopedProjectParam(c);
  const inPath = projectInPath(c);
  const scopeProject = projectQuery
    ? await projectForTeam(db, team.id, projectQuery)
    : undefined;
  if (inPath && !scopeProject) return c.notFound();
  const scopeMissing = Boolean(projectQuery) && !scopeProject;
  const scopeId = scopeProject?.id;

  const scopes = await policyScopes(db, team.id, SCOPE_LIMIT);
  const receipts = await recentPolicyReceipts(db, team.id, RECEIPT_LIMIT, scopeId);
  const baselines = await activeBaselines(db, team.id, BASELINE_LIMIT, scopeId);
  const checks = await recentEnvironmentChecks(db, team.id, CHECK_LIMIT, scopeId);
  const events = await recentAgentEvents(db, team.id, EVENT_LIMIT, scopeId);
  // Its own bounded read rather than a filter over the timeline: fifty busy
  // heartbeats must not push the one row a lead came here for off the page.
  const violations = await recentPolicyViolations(db, team.id, VIOLATION_LIMIT, scopeId);

  // Scoped view of policy: the team base plus this project's override, nothing else.
  const visibleScopes = scopeProject
    ? scopes.filter((s) => s.isTeam || s.bundle.projectId === scopeProject.id)
    : scopes;

  // Origin is derived from the two published documents, never stored.
  const teamScope = scopes.find((s) => s.isTeam);
  const ownScope = scopeProject ? scopes.find((s) => s.bundle.projectId === scopeProject.id) : undefined;
  const teamDocument = teamScope?.own ?? EMPTY_POLICY;
  const projectOrigins = policyOrigins(teamDocument, ownScope?.own);
  const addingProjects = scopes.filter((s) => !s.isTeam);

  // Two different facts, kept apart because they call for different actions:
  // an agent that applied other rules is a breach, an agent that never answered
  // is a gap. Rolling them together made a brand-new team read as a governed
  // team in trouble.
  const drifted = receipts.filter((row) => row.receipt.drift);
  const mismatched = drifted;
  const unreported = receipts.filter((row) => !row.receipt.reportedHash && !row.receipt.drift);
  const confirmed = receipts.filter((row) => row.receipt.reportedHash && !row.receipt.drift);
  const criticals = checks.filter((row) => row.check.status === 'critical');
  const teamProjects = await db
    .select({ id: projects.id, name: projects.name, slug: projects.slug, repositoryIdentity: projects.repositoryIdentity })
    .from(projects)
    .where(eq(projects.teamId, team.id))
    .orderBy(projects.name)
    .limit(PROJECT_LIMIT);

  // Snapshots an owner can promote to a baseline. Bounded, newest first — the
  // CLI can only baseline the machine it runs on, and every one of these is
  // already here with the person and machine it came from.
  const promotable = isOwner
    ? await db
        .select({
          id: snapshots.id,
          repo: snapshots.repo,
          device: snapshots.deviceLabel,
          at: snapshots.createdAt,
          owner: users.username,
          projectName: projects.name,
        })
        .from(snapshots)
        .innerJoin(users, eq(snapshots.userId, users.id))
        .leftJoin(projects, eq(snapshots.projectId, projects.id))
        .where(eq(snapshots.teamId, team.id))
        .orderBy(desc(snapshots.createdAt))
        .limit(SNAPSHOT_LIMIT)
    : [];

  const notice = c.req.query('ok');
  const failure = c.req.query('error');

  const criticalChecks = checks.filter((row) => row.check.status === 'critical');
  const recentViolations = violations.filter(
    (row) => Date.now() - row.event.createdAt.getTime() < VIOLATION_ALERT_MS,
  );
  const needsAttention =
    drifted.length > 0 ||
    unreported.length > 0 ||
    criticalChecks.length > 0 ||
    recentViolations.length > 0;

  return c.html(
    <AppLayout
      user={user}
      active="governance"
      title={`Governance — ${team.name}`}
      strip={
        <>
          <Lead
            text={needsAttention ? 'Attention required' : scopes.length > 0 ? 'Governance healthy' : 'No policy served'}
            live={!needsAttention && scopes.length > 0}
          />
          <Vr />
          {scopeProject ? (
            <span>
              project <b>{scopeProject.name}</b>
            </span>
          ) : (
            <span>
              {scopes.length} {scopes.length === 1 ? 'scope' : 'scopes'}
            </span>
          )}
          {drifted.length > 0 ? (
            <>
              <span class="dim">·</span>
              <span class="bad">{drifted.length} drift</span>
            </>
          ) : null}
          {unreported.length > 0 ? (
            <>
              <span class="dim">·</span>
              <span>{unreported.length} unconfirmed</span>
            </>
          ) : null}
          {criticalChecks.length > 0 ? (
            <>
              <span class="dim">·</span>
              <span class="bad">{criticalChecks.length} preflight critical</span>
            </>
          ) : null}
          {recentViolations.length > 0 ? (
            <>
              <span class="dim">·</span>
              <a class="bad" href="#policy-violations" data-open-details="policy-violations">
                {recentViolations.length} policy {recentViolations.length === 1 ? 'violation' : 'violations'} stopped
              </a>
            </>
          ) : null}
          <Vr />
          <span data-freeze-state="poll 30s">poll 30s</span>
        </>
      }
      scope={
        <>
          <span class="chip">
            team <b>{team.slug}</b>
          </span>
          {/* The picker posts to the workspace address on purpose. Its options carry
              project *ids* — two projects can share a display name — and a GET form
              can only put its value in a query string, so `?project=<id>` is the one
              spelling it can produce. Picking a project is how you leave this one;
              the path form is what a link produces. */}
          <ProjectScope
            path={sectionHref(team.slug, null, 'governance')}
            projects={teamProjects}
            current={scopeProject?.id ?? null}
            allLabel="Global — whole team"
          />
          <a class="chip" href="/app/agents">
            agent map
          </a>
        </>
      }
      head={
        <PageHead
          trail={scopedTrail({ team, project: scopeProject }, 'Governance')}
          title="Governance"
          sub="Whether the rules this team published actually reached the agents — policy, receipts, environment baselines and the run trail."
          actions={
            <>
              <button
                class="btn btn-sm"
                type="button"
                data-freeze="t"
                data-live-label="Freeze view"
                data-frozen-label="Resume live"
              >
                Freeze view
              </button>
              {isOwner ? (
                <>
                  <button
                    class="btn btn-sm"
                    type="button"
                    data-open-dialog="#record-baseline"
                  >
                    Record baseline
                  </button>
                  <a
                    class="btn btn-sm btn-primary"
                    href={`/app/teams/${team.slug}/policy${scopeProject ? `?project=${encodeURIComponent(scopeProject.name)}` : ''}`}
                  >
                    Edit policy
                  </a>
                </>
              ) : null}
              <a class="btn btn-sm" href={`/app/teams/${team.slug}/activity`}>
                Activity
              </a>
              <a class="btn btn-sm" href="/app/agents">
                Live agent map
              </a>
            </>
          }
        />
      }
      keys={[
        { k: 'D', label: 'drift is the first table' },
        { k: 'F', label: 'freeze' },
      ]}
      keysNote="receipts are attestations — the CLI recomputes the hash it actually applied"
    >
      <div data-autorefresh="30" style="display:none"></div>
      {failure ? (
        <div class="banner banner-error">
          <span class="ic">!</span>
          <span>{failure}</span>
          <button class="x" type="button" data-dismiss="t">
            ×
          </button>
        </div>
      ) : null}
      {scopeMissing ? (
        <div class="banner banner-error">
          <span class="ic">!</span>
          <span>
            No project called “{projectQuery}” in this team — showing the whole team instead.
          </span>
          <button class="x" type="button" data-dismiss="t">
            ×
          </button>
        </div>
      ) : null}
      {notice ? (
        <div class="banner banner-success">
          <span class="ic">✓</span>
          <span>{notice}</span>
          <button class="x" type="button" data-dismiss="t">
            ×
          </button>
        </div>
      ) : null}

      <nav class="section-jump" aria-label="Governance sections">
        <a href="#environment-baselines" data-open-details="environment-baselines">
          Baselines <span>{baselines.length}</span>
        </a>
        <a href="#effective-policy" data-open-details="effective-policy">
          Policy <span>{visibleScopes.length}</span>
        </a>
        <a href="#policy-receipts" data-open-details="policy-receipts">
          Receipts <span>{receipts.length}</span>
        </a>
        <a href="#preflight-results" data-open-details="preflight-results">
          Preflights <span>{checks.length}</span>
        </a>
        <a href="#run-timeline" data-open-details="run-timeline">
          Timeline <span>{events.length}</span>
        </a>
      </nav>

      {drifted.length > 0 ? (
        <div class="sumbar">
          <div class="sumbar-left">
            <span class="n">{mismatched.length}</span>
            <span class="t">
              of the last {plural(receipts.length, 'run')} applied a policy other than the one the
              server served. That is the case governance exists to catch: the rules on those
              machines are not the rules you published.
            </span>
          </div>
          <span class="pill pill-danger">drift</span>
        </div>
      ) : null}
      {unreported.length > 0 ? (
        <div class="sumbar">
          <div class="sumbar-left">
            <span class="n">{unreported.length}</span>
            <span class="t">
              {/* Silence is a gap, not a breach — and on a team that has published
                  nothing it is not even a gap. */}
              of the last {plural(receipts.length, 'run')} never confirmed which rules they applied.
              {scopes.length === 0
                ? ' Nothing is published yet, so there is nothing for them to confirm.'
                : ' An agent confirms with update_run {"policy_hash": …} after reading get_policy;' +
                  ' until it does, nobody can say whether the rules reached it.'}
              {confirmed.length > 0 ? ` ${confirmed.length} did confirm.` : ''}
            </span>
          </div>
          <span class="pill pill-warn">unconfirmed</span>
        </div>
      ) : null}
      {criticals.length > 0 ? (
        <div class="sumbar">
          <div class="sumbar-left">
            <span class="n">{criticals.length}</span>
            <span class="t">
              recent {criticals.length === 1 ? 'preflight' : 'preflights'} called a machine
              critically misconfigured for its project.
            </span>
          </div>
          <span class="pill pill-danger">critical</span>
        </div>
      ) : null}

      <details class="card fold-card" id="effective-policy">
        <summary class="card-head">
          <div>
            <div class="card-title">Effective policy</div>
            <div class="card-note">
              {scopeProject
                ? `What an agent in ${scopeProject.name} is handed: the workspace's rules, plus what this project adds. A project can add a rule or tighten one, never remove one.`
                : "What an agent is handed when it starts a run: the workspace's rules reach every project, and a project can add or tighten, never remove."}
              {scopes.length >= SCOPE_LIMIT ? ` First ${SCOPE_LIMIT} scopes only.` : ''}
            </div>
          </div>
          <span class="mono muted">{visibleScopes.length}</span>
        </summary>
        {visibleScopes.length === 0 ? (
          <div class="empty">
            <h2>No policy published yet</h2>
            <p>
              Until a team owner publishes one, every agent starts a run with an empty rulebook:
              nothing denied, nothing requiring approval, no required checks.
            </p>
            {isOwner ? (
              <a
                class="btn btn-primary"
                href={`/app/teams/${team.slug}/policy${scopeProject ? `?project=${encodeURIComponent(scopeProject.name)}` : ''}`}
              >
                Edit policy
              </a>
            ) : (
              <p class="muted small">
                Ask a team owner to publish one — only owners can write policy.
              </p>
            )}
          </div>
        ) : (
          <>
            <div class="scroll-x">
              <table class="tbl">
                <tr>
                  <th>Scope</th>
                  <th>Applies to</th>
                  <th>Version</th>
                  <th>Effective hash</th>
                  <th>Published</th>
                  <th>By</th>
                </tr>
                {visibleScopes.map((scope) => (
                  <tr>
                    <td class="name">{scope.isTeam ? 'Workspace' : scope.label}</td>
                    <td class="muted">
                      {scope.isTeam ? (
                        'every project'
                      ) : (
                        <a href={sectionHref(team.slug, scope.projectSlug ?? scope.label, 'governance')}>
                          {scope.label} only
                        </a>
                      )}
                    </td>
                    <td class="mono">v{scope.bundle.version}</td>
                    <td class="mono">
                      {short(scope.hash)}
                      {/* A project scope is handed the merge, so its own bundle hashes differently. */}
                      {scope.hash === scope.bundle.hash ? null : (
                        <div class="mono muted small">published {short(scope.bundle.hash)}</div>
                      )}
                    </td>
                    <td class="muted" style="white-space:nowrap">
                      {timeAgo(scope.bundle.createdAt)}
                    </td>
                    <td class="muted">{scope.author ?? '—'}</td>
                  </tr>
                ))}
              </table>
            </div>
            {scopeProject ? (
              <div class="card-pad" style="border-top:1px solid var(--line-2)" id="in-effect">
                <div class="row" style="justify-content:space-between;margin-bottom:14px;gap:12px;flex-wrap:wrap">
                  <div>
                    <div class="card-title">In effect in {scopeProject.name}</div>
                    <div class="card-note">
                      {projectOrigins.inherited} from the workspace
                      {teamScope ? ` (v${teamScope.bundle.version})` : ''} ·{' '}
                      {ownScope
                        ? `${projectOrigins.own} this project adds (v${ownScope.bundle.version})`
                        : 'this project adds nothing of its own yet'}
                    </div>
                  </div>
                  <div class="row" style="gap:8px;flex-wrap:wrap">
                    <span class="mono muted small">{short((ownScope ?? teamScope)!.hash)}</span>
                    {isOwner ? (
                      <>
                        <a
                          class="btn btn-sm btn-primary"
                          href={`/app/teams/${team.slug}/policy?project=${encodeURIComponent(scopeProject.slug)}`}
                        >
                          Add for this project only
                        </a>
                        <a class="btn btn-sm" href={`/app/teams/${team.slug}/policy`}>
                          Edit workspace rules
                        </a>
                      </>
                    ) : null}
                  </div>
                </div>
                <PolicyByOrigin origins={projectOrigins} />
              </div>
            ) : (
              visibleScopes.map((scope) => (
                <div class="card-pad" style="border-top:1px solid var(--line-2)">
                  <div class="row" style="justify-content:space-between;margin-bottom:14px;gap:12px;flex-wrap:wrap">
                    <div>
                      <div class="card-title">{scope.isTeam ? 'Workspace rules' : `${scope.label} adds`}</div>
                      <div class="card-note">
                        {scope.isTeam
                          ? `Applies to every project.${addingProjects.length === 0 ? '' : addingProjects.length === 1 ? ' 1 project adds rules of its own.' : ` ${addingProjects.length} projects add rules of their own.`}`
                          : `Applies to ${scope.label} only, on top of the workspace rules above.`}
                      </div>
                    </div>
                    <div class="row" style="gap:8px">
                      <span class="mono muted small">{short(scope.hash)}</span>
                      {scope.isTeam ? null : (
                        <a
                          class="btn btn-sm"
                          href={`${sectionHref(team.slug, scope.projectSlug ?? scope.label, 'governance')}#effective-policy`}
                        >
                          What is in effect there
                        </a>
                      )}
                    </div>
                  </div>
                  {scope.isTeam ? (
                    <PolicyDoc document={scope.document} />
                  ) : (
                    <PolicyByOrigin origins={policyOrigins(teamDocument, scope.own)} only="project" />
                  )}
                </div>
              ))
            )}
          </>
        )}
      </details>

      <details class="card fold-card" id="policy-receipts">
        <summary class="card-head">
          <div>
            <div class="card-title">Policy receipts</div>
            <div class="card-note">
              Per run: the hash the server expected against the one the agent reported applying.
              Last {RECEIPT_LIMIT}.
            </div>
          </div>
          <span class="mono muted">{receipts.length}</span>
        </summary>
        {receipts.length === 0 ? (
          <div class="card-pad muted small">
            No receipts yet — one is written every time an agent starts a run, whether it calls
            <code>start_run</code> over MCP or runs <span class="mono">stma run start</span>.
          </div>
        ) : (
          <div class="scroll-x">
            <table class="tbl">
              <tr>
                <th>Run</th>
                <th>Owner / agent</th>
                <th>Project</th>
                <th>Expected</th>
                <th>Reported</th>
                <th>Result</th>
                <th>When</th>
              </tr>
              {receipts.map((row) => {
                const drift = row.receipt.drift;
                // Silence is neither drift nor agreement. The domain records an
                // unanswered receipt with drift=false, so tying this state to
                // `drift` made every silent agent render as a policy match.
                const never = !row.receipt.reportedHash;
                return (
                  <tr id={`receipt-${row.run.id}`} class={drift || never ? 'warm' : undefined}>
                    <td>
                      <div class="name">
                        {row.run.taskKey ?? row.run.intent?.slice(0, 60) ?? 'run'}
                      </div>
                      <div class="mono muted small">{row.run.branch ?? row.run.id.slice(0, 8)}</div>
                    </td>
                    <td>
                      <div>{row.owner}</div>
                      <div class="mono muted small">{row.agentName}</div>
                    </td>
                    <td class="muted">{row.projectName ?? '—'}</td>
                    <td class="mono">{short(row.receipt.expectedHash)}</td>
                    <td class="mono">{short(row.receipt.reportedHash)}</td>
                    <td>
                      {never ? (
                        <span class="pill pill-warn">not reported</span>
                      ) : drift ? (
                        <span class="pill pill-danger">drift</span>
                      ) : (
                        <span class="muted small">match</span>
                      )}
                    </td>
                    <td class="muted" style="white-space:nowrap">
                      {timeAgo(row.receipt.createdAt)}
                    </td>
                  </tr>
                );
              })}
            </table>
          </div>
        )}
      </details>

      <details class="card fold-card" id="environment-baselines">
        <summary class="card-head">
          <div>
            <div class="card-title">Environment baselines</div>
            <div class="card-note">
              The golden machine each project is checked against. One active baseline per project.
              {baselines.length >= BASELINE_LIMIT ? ` Newest ${BASELINE_LIMIT} shown.` : ''}
            </div>
          </div>
          <span class="mono muted">{baselines.length}</span>
        </summary>
        {baselines.length === 0 ? (
          <div class="empty">
            <h2>No baseline recorded</h2>
            <p>
              Without a baseline a preflight can only check policy rules — it cannot tell an agent
              that this machine drifted from the one the project is known to build on.
            </p>
            {isOwner ? (
              <button class="btn btn-primary" type="button" data-open-dialog="#record-baseline">
                Record a baseline
              </button>
            ) : (
              <p class="muted small">
                Ask a team owner to record one from a machine the project builds on.
              </p>
            )}
          </div>
        ) : (
          <div class="scroll-x">
            <table class="tbl">
              <tr>
                <th>Project</th>
                <th>Fingerprint</th>
                <th>Recorded</th>
                <th>By</th>
              </tr>
              {baselines.map((row) => (
                <tr>
                  <td class="name">{row.projectName}</td>
                  <td class="mono">{short(row.baseline.fingerprint)}</td>
                  <td class="muted" style="white-space:nowrap">
                    {timeAgo(row.baseline.createdAt)}
                  </td>
                  <td class="muted">{row.author ?? '—'}</td>
                </tr>
              ))}
            </table>
          </div>
        )}
      </details>

      <details class="card fold-card" id="preflight-results">
        <summary class="card-head">
          <div>
            <div class="card-title">Preflight results</div>
            <div class="card-note">
              What each machine was told before it started work. Criticals first, then the most
              recent — last {CHECK_LIMIT}.
            </div>
          </div>
          <span class="mono muted">{checks.length}</span>
        </summary>
        {checks.length === 0 ? (
          <div class="card-pad muted small">
            No preflight has run yet — an agent checks in with <code>check_environment</code>
            over MCP, with <span class="mono">stma env preflight</span>, or automatically
            through its run wrapper.
          </div>
        ) : (
          <div class="scroll-x">
            <table class="tbl">
              <tr>
                <th>Status</th>
                <th>Project</th>
                <th>Machine of</th>
                <th>Run</th>
                <th>What differed</th>
                <th>When</th>
              </tr>
              {checks.map((row) => (
                <tr class={row.check.status === 'critical' ? 'warm' : undefined}>
                  <td>
                    <span class={CHECK_PILL[row.check.status] ?? 'pill pill-muted'}>
                      {CHECK_LABEL[row.check.status] ?? row.check.status}
                    </span>
                  </td>
                  <td class="name">{row.projectName}</td>
                  <td>{row.username ?? '—'}</td>
                  <td class="muted">{row.taskKey ?? '—'}</td>
                  <td class="muted">{row.check.summary ?? '—'}</td>
                  <td class="muted" style="white-space:nowrap">
                    {timeAgo(row.check.createdAt)}
                  </td>
                </tr>
              ))}
            </table>
          </div>
        )}
      </details>

      <details class="card fold-card" id="policy-violations" open={violations.length > 0}>
        <summary class="card-head">
          <div>
            <div class="card-title">Policy violations</div>
            <div class="card-note">
              Content a published <code>content:</code> deny rule names. Two kinds, and they answer
              different questions: <b>stopped</b> is an edit the local file guard refused, and{' '}
              <b>in the checkout</b> is what the end-of-run scan found there anyway — which is the
              half a guard on one client's file tools can never see. Who, which rule, which file,
              never the content, which stays on the agent's machine. Last {VIOLATION_LIMIT}.
            </div>
          </div>
          <span class={`mono ${violations.length > 0 ? 'bad' : 'muted'}`}>{violations.length}</span>
        </summary>
        {violations.length === 0 ? (
          <div class="card-pad muted small">
            Nothing stopped, and nothing found. No agent with the STMA hook installed tried to add
            content a <code>content:</code> rule forbids, and the scan each run runs over its own
            checkout when it ends found none there either. That is still not proof nothing landed:
            the scan reads one checkout at the end of one run, so work done elsewhere, or after it,
            is not in it, and an agent connected over MCP only has no hook to run either half. Add
            a rule under <b>Edit policy → Denied</b>, shaped{' '}
            <code>content: "text" in path/** — reason</code>.
          </div>
        ) : (
          <div class="scroll-x">
            <table class="tbl">
              <tr>
                <th>When</th>
                <th>Agent</th>
                <th>Project · task</th>
                <th>Rule</th>
                <th>File</th>
                <th>Outcome</th>
              </tr>
              {violations.map((row) => {
                const detail = (row.event.detail ?? {}) as {
                  rule?: string;
                  path?: string;
                  outcome?: string;
                };
                return (
                  <tr>
                    <td class="muted" style="white-space:nowrap">
                      {timeAgo(row.event.createdAt)}
                    </td>
                    <td>
                      {/* The hook reports, so the run belongs to the local adapter.
                          A lead knows the agent they gave the task to, not its
                          adapter — name that one, and keep who reported it in view. */}
                      <div>
                        <b>{row.companionName ?? row.agentName}</b>
                      </div>
                      <div class="mono muted small">
                        {row.owner}
                        {row.device ? ` · ${row.device}` : ''}
                      </div>
                      {row.companionName ? (
                        <div class="muted small">via its adapter {row.agentName}</div>
                      ) : null}
                    </td>
                    <td class="muted">
                      {row.projectName ?? '—'}
                      <div class="small">{row.run.taskKey ?? row.run.id.slice(0, 8)}</div>
                    </td>
                    <td class="small">{detail.rule ?? '—'}</td>
                    <td class="mono small">{detail.path ?? '—'}</td>
                    <td>
                      {/* An edit that was stopped is a rule working. Content that
                          is in the checkout anyway is the rule being broken, so
                          the two do not get one colour. */}
                      <span class={detail.outcome === 'blocked' ? 'pill pill-warn' : 'pill pill-danger'}>
                        {detail.outcome === 'blocked'
                          ? 'stopped'
                          : detail.outcome === 'present'
                            ? 'in the checkout'
                            : (detail.outcome ?? 'reported')}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </table>
          </div>
        )}
      </details>

      <details class="card fold-card" id="run-timeline">
        <summary class="card-head">
          <div>
            <div class="card-title">Run timeline</div>
            <div class="card-note">
              The append-only trail every run leaves: starts, detected conflicts and finishes. Last{' '}
              {EVENT_LIMIT}.
            </div>
          </div>
          <span class="mono muted">{events.length}</span>
        </summary>
        {events.length === 0 ? (
          <div class="card-pad muted small">
            No runs recorded yet — ask an agent to call <code>start_run</code>. Over MCP that
            needs nothing installed; the CLI and its hooks do it automatically.
          </div>
        ) : (
          <div class="scroll-x">
            <table class="tbl">
              <tr>
                <th>When</th>
                <th>Event</th>
                <th>Run</th>
                <th>Owner / agent</th>
                <th>Project</th>
                <th>Detail</th>
              </tr>
              {events.map((row) => (
                <tr>
                  <td class="muted" style="white-space:nowrap">
                    {timeAgo(row.event.createdAt)}
                  </td>
                  <td>
                    <span class={eventPill(row.event.type, row.event.detail)}>
                      {row.event.type}
                    </span>
                  </td>
                  <td>{row.run.taskKey ?? row.run.id.slice(0, 8)}</td>
                  <td>
                    <div>{row.owner}</div>
                    <div class="mono muted small">{row.companionName ?? row.agentName}</div>
                    {row.companionName ? (
                      <div class="muted small">via its adapter {row.agentName}</div>
                    ) : null}
                  </td>
                  <td class="muted">{row.projectName ?? '—'}</td>
                  <td class="muted small">{eventDetail(row.event.type, row.event.detail)}</td>
                </tr>
              ))}
            </table>
          </div>
        )}
      </details>

      {isOwner ? (
        <dialog id="record-baseline" class="formdlg wide">
          <h3>Record an environment baseline</h3>
          <p class="dlgsub">
            Promote a machine that already works. Preflight compares every other machine against
            it and tells the agent, before it starts, what is different.
          </p>
          {promotable.length === 0 ? (
            <>
              <p class="m0 sub">
                No snapshots in this team yet. A baseline is a real machine, so one has to be
                pushed first — ask an agent to call <code>push_snapshot</code>.
              </p>
              <div class="dialog-actions">
                <button class="btn" type="button" data-close-dialog="t">
                  Close
                </button>
              </div>
            </>
          ) : (
            <form method="post" action={`/app/teams/${team.slug}/baseline`}>
              <div class="field">
                <label>Snapshot to promote</label>
                {/* No default. These are newest first, and after a debugging
                    session the newest snapshot is the machine you were just
                    debugging — the one thing a baseline must never be. The page
                    cannot know which machine works, so it asks instead of
                    guessing, and `required` makes the browser hold the line. */}
                <select class="in" name="snapshot" aria-label="Snapshot to promote" required>
                  <option value="" selected disabled>
                    Choose the machine that works…
                  </option>
                  {promotable.map((s) => (
                    <option value={s.id}>
                      {s.owner}@{s.device}
                      {s.projectName ?? s.repo ? ` · ${s.projectName ?? s.repo}` : ''} ·{' '}
                      {timeAgo(s.at)}
                    </option>
                  ))}
                </select>
                <span class="help">
                  A baseline is the machine that <b>works</b>. Listed newest first, which after a
                  debugging session is usually the broken one — so choose, do not take the top.
                  Showing the {promotable.length} most recent snapshots in this team.
                </span>
              </div>
              <div class="field">
                <label>Project</label>
                <select
                  class="in"
                  name="project"
                  aria-label="Project this baseline applies to"
                >
                  <option value="" selected={!scopeProject}>
                    Use the snapshot's own project
                  </option>
                  {teamProjects.map((p) => (
                    <option value={p.id} selected={p.id === scopeProject?.id}>
                      {p.name}
                      {teamProjects.some((other) => other.id !== p.id && other.name === p.name)
                        ? ` — ${p.repositoryIdentity ? 'repository-bound' : p.slug}`
                        : ''}
                    </option>
                  ))}
                </select>
                <span class="help">
                  Baselines are per project. Recording a second one replaces the active one.
                </span>
              </div>
              <div class="dialog-actions">
                <button class="btn" type="button" data-close-dialog="t">
                  Cancel
                </button>
                <button class="btn btn-primary" type="submit">
                  Record baseline
                </button>
              </div>
            </form>
          )}
        </dialog>
      ) : null}

    </AppLayout>,
  );
};

governanceRoutes.get('/app/teams/:slug/governance', governancePage);
governanceRoutes.get('/app/teams/:slug/projects/:project/governance', governancePage);

// ---------------------------------------------------------------- write paths

/**
 * Where a write returns: this page, in the scope the write was made in.
 *
 * `project` is a slug the handler resolved against this team, never a spelling
 * somebody typed, so building the project's own address out of it cannot answer
 * 404 to a person who just published successfully.
 */
const back = (slug: string, msg: string, ok = false, project?: string): string =>
  `${sectionHref(slug, project, 'governance')}?${ok ? 'ok' : 'error'}=${encodeURIComponent(msg)}`;

/**
 * Publish policy from the browser.
 *
 * This existed only as `stma policy publish --file policy.json`, which put the
 * team's rulebook behind a JSON file on one person's laptop and a CLI the rest
 * of the team may not have installed. It is the same domain call the control
 * API makes, so the owner check, the version bump and the activity entry are
 * one implementation, not two.
 */
governanceRoutes.post('/app/teams/:slug/policy', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const slug = c.req.param('slug');
  const db = c.get('db');
  const found = await teamForUser(db, user.id, slug);
  if (!found) return c.notFound();
  // Same door as the page. A gate on the read and not the write is not a gate.
  if (!(await effectiveLimits(db, found.team, c.get('env').hosted)).governance) return c.notFound();

  const form = await c.req.parseBody();
  const scope = String(form.scope ?? '').trim();
  const project = scope && scope !== 'team' ? scope : undefined;
  const selectedProject = project ? await projectForTeam(db, found.team.id, project) : undefined;
  const projectLabel = selectedProject?.name ?? project ?? 'team';
  const typed = form as Record<string, unknown>;
  const parsed = policyFromForm(typed);
  // A refusal hands the editor back with what was typed (`renderPolicyEditor`): the
  // usual one is a single malformed line at the end of a long rulebook, and a redirect
  // with a band threw the rulebook away with it. Somebody who is not an owner has no
  // editor to be handed; they go to the page they may read, with the reason.
  const refuse = (error: string) =>
    found.role === 'owner'
      ? renderPolicyEditor(c, { typed, error })
      : c.redirect(back(slug, error), 302);
  if (failed(parsed)) return refuse(parsed.error);
  // Publishing an empty document silently removes every rule the agents were
  // following. If that is really the intent it deserves a different gesture.
  if (isEmptyPolicy(parsed.document)) {
    return refuse('Every field was empty — that would publish a rulebook with no rules.');
  }

  const result = await publishPolicy(db, user.id, {
    team: slug,
    project,
    document: parsed.document,
  });
  if ('error' in result) return refuse(result.error);
  void track(db, {
    teamId: result.policy.teamId,
    projectId: result.policy.projectId,
    userId: user.id,
    action: 'policy_published',
    detail: `${projectLabel} v${result.policy.version} · ${short(result.policy.hash)}`,
  });
  return c.redirect(
    back(
      slug,
      `Published ${projectLabel} policy v${result.policy.version} (${short(result.policy.hash)}). Agents receive it on their next run.`,
      true,
      selectedProject?.slug,
    ),
    302,
  );
});

/**
 * Record an environment baseline from a snapshot the team already pushed.
 *
 * The CLI can only baseline the machine it is sitting on, so recording one
 * meant finding somebody with a working checkout and asking them to run a
 * command. Every snapshot is already here, with the person and the machine it
 * came from — promoting one is both less work and more legible, because the
 * owner can see exactly what they are declaring correct.
 */
governanceRoutes.post('/app/teams/:slug/baseline', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const slug = c.req.param('slug');
  const db = c.get('db');
  const found = await teamForUser(db, user.id, slug);
  if (!found) return c.notFound();
  // Same door as the page. A gate on the read and not the write is not a gate.
  if (!(await effectiveLimits(db, found.team, c.get('env').hosted)).governance) return c.notFound();

  const form = await c.req.parseBody();
  const snapshotId = String(form.snapshot ?? '').trim();
  if (!snapshotId) return c.redirect(back(slug, 'Pick a snapshot to promote.'), 302);

  const rows = await db
    .select({ snap: snapshots, owner: users.username, projectName: projects.name })
    .from(snapshots)
    .innerJoin(users, eq(snapshots.userId, users.id))
    .leftJoin(projects, eq(snapshots.projectId, projects.id))
    .where(and(eq(snapshots.id, snapshotId), eq(snapshots.teamId, found.team.id)))
    .limit(1);
  const chosen = rows[0];
  if (!chosen) return c.redirect(back(slug, 'That snapshot is not in this team.'), 302);

  const requestedProject = String(form.project ?? '').trim();
  const targetProject = requestedProject
    ? await projectForTeam(db, found.team.id, requestedProject)
    : chosen.snap.projectId
      ? await projectForTeam(db, found.team.id, chosen.snap.projectId)
      : chosen.projectName
        ? await projectForTeam(db, found.team.id, chosen.projectName)
        : chosen.snap.repo
          ? await projectForTeam(db, found.team.id, chosen.snap.repo)
          : undefined;
  if (!targetProject) {
    return c.redirect(
      back(slug, 'That snapshot names no project, so there is nothing to baseline. Pick a project.'),
      302,
    );
  }

  const parsedSnapshot = snapshotSchema.safeParse(chosen.snap.data);
  if (!parsedSnapshot.success) {
    return c.redirect(back(slug, 'That snapshot was stored under an older schema and cannot be promoted.'), 302);
  }

  const result = await setEnvironmentBaseline(db, user.id, {
    team: slug,
    project: targetProject.name,
    snapshot: parsedSnapshot.data,
  }, targetProject.id);
  if (failed(result)) return c.redirect(back(slug, result.error), 302);
  void track(db, {
    teamId: result.baseline.teamId,
    projectId: result.baseline.projectId,
    userId: user.id,
    action: 'env_baseline_set',
    detail: `${targetProject.name} · ${short(result.baseline.fingerprint)} · from ${chosen.owner}@${chosen.snap.deviceLabel}`,
  });
  return c.redirect(
    back(
      slug,
      `Baseline for ${targetProject.name} recorded from ${chosen.owner}@${chosen.snap.deviceLabel} (${short(result.baseline.fingerprint)}). Preflight compares against it from now on.`,
      true,
      targetProject.slug,
    ),
    302,
  );
});
