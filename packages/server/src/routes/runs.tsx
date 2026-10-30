import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { loginRedirect } from '../auth/session';
import type { Db } from '../db';
import { agentRuns, projects } from '../db/schema';
import { teamForUser } from '../domain/access';
import { evidenceForRun } from '../domain/evidence';
import { evidenceMarkdown, evidencePullRequestBlock, membersOnly } from '../domain/evidenceSummary';
import { eventsForRun } from '../domain/fleetReaders';
import { EVIDENCE_NOT_INCLUDED, evidenceAllowed } from '../lib/entitlements';
import { isCanonicalUuid } from '../lib/ids';
import { ensureRail } from '../lib/rail';
import { sectionHref } from '../lib/scope';
import { timeAgo } from '../lib/format';
import type { AppEnv } from '../types';
import { PageHead, teamTrail, type Crumb } from '../ui/Console';
import {
  DeliveredCommit,
  EvidenceChecks,
  EvidenceNext,
  Handovers,
  PolicyKnowledge,
  ProviderFacts,
  ReviewIdentity,
} from '../ui/Evidence';
import { AppLayout } from '../ui/Layout';

/**
 * A run's own page: its evidence for as long as the run exists.
 *
 * The evidence pack was only ever drawn in the agent map's inspector, and the
 * map is presence: it holds live runs and each agent's newest ended one for a
 * day. A reviewer opening a pull request two days after the agent finished, the
 * person page's run list and the handoff thread all pointed at a run the map
 * could no longer draw, and it said so ("That exact run is no longer active").
 * This page reads the same `evidenceForRun` the map and `get_evidence` read, so
 * the three cannot tell different stories, and keeps it reachable afterwards.
 *
 * Two things it deliberately is not. It is not a merge gate: the pack's own
 * verdict line says evidence is not permission. And it is not a share link:
 * the address sits under the workspace (`/app/teams/:slug/…`), so membership —
 * and, in an organization-managed workspace, the identity layer's role check,
 * which resolves the workspace from that same prefix — decides who reads it.
 * "Copy as Markdown" and "Copy for a pull request" are how a member takes it
 * to a pull request, and the page says only workspace members can open the
 * link; nothing here posts anywhere.
 */
export const runsRoutes = new Hono<AppEnv>();

async function runForMember(db: Db, slug: string, runId: string, userId: string) {
  // The id is compared in its canonical spelling only; any other spelling of
  // the same row is a 404, as on thread pages (audit 2026-09-21).
  if (!isCanonicalUuid(runId)) return undefined;
  const access = await teamForUser(db, userId, slug);
  if (!access) return undefined;
  const [row] = await db
    .select({ run: agentRuns, projectSlug: projects.slug, projectName: projects.name })
    .from(agentRuns)
    .leftJoin(projects, eq(projects.id, agentRuns.projectId))
    .where(and(eq(agentRuns.id, runId.toLowerCase()), eq(agentRuns.teamId, access.team.id)))
    .limit(1);
  return row ? { access, ...row } : undefined;
}

// The sentence lives beside `evidenceAllowed`, so the hosted composition's
// organization project console prints it without importing a route module.
export { EVIDENCE_NOT_INCLUDED } from '../lib/entitlements';

export const runHref = (team: string, runId: string) => `/app/teams/${team}/runs/${runId}`;

runsRoutes.get('/app/teams/:slug/runs/:id', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await runForMember(db, c.req.param('slug'), c.req.param('id'), user.id);
  if (!found) return c.notFound();
  const { access, run } = found;
  await ensureRail(db, user, access.team.slug, found.projectSlug ?? null);
  // One decision for every door: this page, its Markdown, the map's inspector
  // and get_evidence all read the same request-local entitlement. 402 rather
  // than 404, as on Governance: the run is the member's to know about, and a
  // page without its checks would read as a pass.
  if (!(await evidenceAllowed(db, access.team, c.get('env').hosted))) {
    return c.html(
      <AppLayout user={user} active="agents" title="Run evidence">
        <div class="card card-pad joincard">
          <h2 class="title m0">Run evidence</h2>
          <p class="m0 sub">{EVIDENCE_NOT_INCLUDED}</p>
        </div>
      </AppLayout>,
      402,
    );
  }
  const pack = await evidenceForRun(db, run.id, user.id);
  if ('error' in pack) return c.notFound();
  const trail = await eventsForRun(db, run.id, 20);
  const self = `${c.get('env').baseUrl}${runHref(access.team.slug, run.id)}`;
  const markdown = evidenceMarkdown(pack, { url: self });
  const pullRequest = evidencePullRequestBlock(pack, { url: self });
  const title = pack.run.task ?? pack.run.intent ?? 'Untitled run';
  const live = ['starting', 'active', 'waiting', 'blocked'].includes(run.status);
  const steps: Crumb[] = found.projectSlug
    ? [
        {
          label: found.projectName ?? found.projectSlug,
          href: `/app/teams/${access.team.slug}/projects/${encodeURIComponent(found.projectSlug)}`,
        },
        { label: 'Agents', href: sectionHref(access.team.slug, found.projectSlug, 'agents') },
        { label: 'Run' },
      ]
    : [{ label: 'Agent map', href: `/app/agents?team=${encodeURIComponent(access.team.slug)}` }, { label: 'Run' }];

  return c.html(
    <AppLayout user={user} active="agents" title={`Run: ${title}`}>
      <PageHead
        trail={teamTrail(access.team, ...steps)}
        title={title}
        sub={`${pack.who.agent} for ${pack.who.owner}${pack.who.project ? ` · ${pack.who.project}` : ''}${pack.run.branch ? ` · ${pack.run.branch}` : ''} · ${live ? run.status : `ended ${timeAgo(run.endedAt ?? run.lastHeartbeatAt) ?? ''} (${run.status})`}`}
        actions={
          <>
            <button class="btn btn-sm btn-primary" type="button" data-copy={markdown}>
              Copy as Markdown
            </button>
            <button class="btn btn-sm" type="button" data-copy={pullRequest}>
              Copy for a pull request
            </button>
            <a class="btn btn-sm" href={`${runHref(access.team.slug, run.id)}/evidence.md`}>
              Download .md
            </a>
            {live ? (
              <a
                class="btn btn-sm"
                href={`/app/agents?run=${run.id}&team=${encodeURIComponent(access.team.slug)}${found.projectSlug ? `&project=${encodeURIComponent(found.projectSlug)}` : ''}`}
              >
                On the map
              </a>
            ) : null}
          </>
        }
      />
      <p class="small muted" style="max-width:var(--measure)">
        {pack.verdict} Each section says whose word it is: what the agent reported, what STMA
        observed, and what a connected provider observed at the exact commit. Copy as Markdown
        keeps those words, so a pull request gets the same answer this page gives; Copy for a
        pull request is the short version.
      </p>
      <p class="small muted" style="max-width:var(--measure)">{membersOnly(access.team.name)}</p>
      <div class="grid2">
        <div class="col">
          <div class="card card-pad" style="display:flex;flex-direction:column;gap:10px">
            <div class="card-title">Identity</div>
            <ReviewIdentity pack={pack} />
          </div>
          <div class="card card-pad" style="display:flex;flex-direction:column;gap:10px">
            <div class="card-title">Delivered commit</div>
            <DeliveredCommit pack={pack} />
          </div>
          <div class="card card-pad" style="display:flex;flex-direction:column;gap:10px">
            <div class="card-title">Reported by the agent</div>
            <EvidenceChecks pack={pack} only="client_report" />
          </div>
          <div class="card card-pad" style="display:flex;flex-direction:column;gap:10px">
            <div class="card-title">Observed by STMA</div>
            {pack.checks.some((check) => check.source === 'stma_observation') ? (
              <EvidenceChecks pack={pack} only="stma_observation" />
            ) : (
              <p class="small muted m0">Nothing in this pack is STMA's own observation.</p>
            )}
          </div>
          <div class="card card-pad" style="display:flex;flex-direction:column;gap:10px">
            <div class="card-title">Observed by the provider</div>
            <ProviderFacts pack={pack} />
            <EvidenceChecks pack={pack} only="provider_observation" />
          </div>
          {/* Its own card, as in the Markdown: this summary reads every check,
              whoever's word it is, so under the provider's heading it would
              read as the provider's. */}
          <div class="card card-pad" style="display:flex;flex-direction:column;gap:10px">
            <div class="card-title">Still open</div>
            <EvidenceNext pack={pack} />
          </div>
        </div>
        <div class="col">
          <div class="card card-pad" style="display:flex;flex-direction:column;gap:10px">
            <div class="card-title">Handover</div>
            <Handovers pack={pack} />
          </div>
          <div class="card card-pad" style="display:flex;flex-direction:column;gap:10px">
            <div class="card-title">Policy and Knowledge</div>
            <PolicyKnowledge pack={pack} />
          </div>
          <div class="card card-pad" style="display:flex;flex-direction:column;gap:10px">
            <div class="card-title">Scope it declared</div>
            {pack.scope.length === 0 ? (
              <p class="small muted m0">No scope was declared, so nobody could be warned about this run.</p>
            ) : (
              pack.scope.map((claim) => (
                <p class="small m0">
                  <span class="mono">{claim.key}</span>
                  <span class="muted">
                    {' '}
                    · {claim.type} · {claim.access ?? 'write'}
                    {'movedTo' in claim ? ` · moved to run ${claim.movedTo.slice(0, 8)} when this run was closed for other work` : ''}
                    {'carriedFrom' in claim && claim.carriedFrom ? ` · carried from run ${claim.carriedFrom.slice(0, 8)}, which declared it` : ''}
                  </span>
                </p>
              ))
            )}
          </div>
          <div class="card card-pad" style="display:flex;flex-direction:column;gap:10px">
            <div class="card-title">Trail</div>
            {trail.length === 0 ? (
              <p class="small muted m0">No events are retained for this run.</p>
            ) : (
              <div class="trail">
                {trail.map((event) => (
                  <div>
                    <span class="at">{timeAgo(event.at)}</span> {event.type.replaceAll('_', ' ')}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>,
  );
});

runsRoutes.get('/app/teams/:slug/runs/:id/evidence.md', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await runForMember(db, c.req.param('slug'), c.req.param('id'), user.id);
  if (!found) return c.notFound();
  if (!(await evidenceAllowed(db, found.access.team, c.get('env').hosted))) {
    c.header('cache-control', 'private, no-store');
    return c.text(EVIDENCE_NOT_INCLUDED, 402);
  }
  const pack = await evidenceForRun(db, found.run.id, user.id);
  if ('error' in pack) return c.notFound();
  const markdown = evidenceMarkdown(pack, {
    url: `${c.get('env').baseUrl}${runHref(found.access.team.slug, found.run.id)}`,
  });
  c.header('content-type', 'text/markdown; charset=utf-8');
  c.header('content-disposition', `attachment; filename="stma-evidence-${found.run.id.slice(0, 8)}.md"`);
  c.header('cache-control', 'private, no-store');
  return c.body(markdown);
});
