import { KNOWLEDGE_KINDS } from '@bridge/shared';
import { asc, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { loginRedirect } from '../auth/session';
import { projects } from '../db/schema';
import {
  deleteKnowledgeContent,
  knowledgeForConsole,
  hostedKnowledgeCapacityLimits,
  proposeKnowledge,
  publishKnowledge,
  searchKnowledge,
  setKnowledgeLifecycle,
} from '../domain/knowledge';
import { validateKnowledgeImports } from '../lib/knowledgeImport';
import { ensureRail } from '../lib/rail';
import { projectInPath, scopedProjectParam, sectionHref } from '../lib/scope';
import type { AppEnv } from '../types';
import { projectForTeam } from '../domain/access';
import { PageHead, teamTrail } from '../ui/Console';
import { AppLayout } from '../ui/Layout';

export const knowledgeRoutes = new Hono<AppEnv>();

const value = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : '');
const projectNames = (raw: unknown): string[] =>
  value(raw)
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

const dateValue = (raw: unknown): string | null | undefined => {
  const input = value(raw);
  if (!input) return null;
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

/**
 * Where a write returns: the page it was made on, in the scope it was made in.
 * A record published from inside a project used to land on the workspace's list,
 * and the way back was the person's to find (navigation contract, rule 2).
 */
const backTo = (slug: string, form: Record<string, unknown>) => (key: string, message: string) => {
  // `scope_project` is only ever written by the page, and only when it resolved a
  // real project of this team, so the project's own address is safe to build here.
  const project = value(form.scope_project);
  return `${sectionHref(slug, project || null, 'knowledge')}?${key}=${encodeURIComponent(message)}`;
};

const audienceFromForm = (form: Record<string, unknown>) =>
  value(form.audience) === 'selected_projects'
    ? ({ type: 'selected_projects', projects: projectNames(form.projects) } as const)
    : ({ type: 'workspace_members' } as const);

/**
 * What a refused write hands back to the page: which form it came from,
 * everything that was typed into it, and why it was refused.
 *
 * The other half of the navigation contract's "no stale values": what you typed
 * is not lost either. The usual refusal here is one unknown project name at the
 * end of a Markdown body somebody spent ten minutes on, and until now that sent
 * them back to an empty form with a band above it.
 */
interface RefusedKnowledge {
  form: 'draft' | 'import';
  typed: Record<string, unknown>;
  error: string;
}

// Two addresses, one page: the workspace's records, and what reaches one project.
// The project form is what the rail links to; the `?project=` filter it replaces
// still answers, because it is in tabs, in messages and in this suite.
knowledgeRoutes.get('/app/teams/:slug/knowledge', (c) => renderKnowledge(c));
knowledgeRoutes.get('/app/teams/:slug/projects/:project/knowledge', (c) => renderKnowledge(c));

export async function renderKnowledge(c: Context<AppEnv>, refused?: RefusedKnowledge) {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const model = await knowledgeForConsole(db, user.id, c.req.param('slug') ?? '');
  if ('error' in model) return c.notFound();
  const isOwner = model.role === 'owner';
  const teamProjects = await db
    .select({ id: projects.id, name: projects.name, slug: projects.slug })
    .from(projects)
    .where(eq(projects.teamId, model.team.id))
    .orderBy(asc(projects.name))
    .limit(100);
  const query = value(c.req.query('q'));
  // A refusal re-renders in the scope the form was posted for, not the scope of
  // the address, because a POST has no query string of its own to come back to.
  const project = refused ? value(refused.typed.scope_project) : scopedProjectParam(c);
  /** What was typed into this form, or nothing when the refusal was the other one. */
  const was = (form: RefusedKnowledge['form'], name: string) =>
    refused?.form === form ? value(refused.typed[name]) : '';
  const searched = query
    ? await searchKnowledge(db, user.id, {
        team: model.team.slug,
        project: project || undefined,
        query,
        page: 1,
        pageSize: 20,
      })
    : null;
  const error = refused?.error ?? c.req.query('error');
  const notice = refused ? undefined : c.req.query('notice');

  // Inside a project the page lists what is in effect THERE: records for the whole
  // workspace and records addressed to this project, each labelled with which it
  // is. A record addressed to other projects is not this project's business and
  // is counted, not listed. Audience is already stored per version; this is a
  // reader's grouping, and what an agent is served is still decided in SQL by
  // `domain/knowledge.ts`.
  const scopeProject = project ? await projectForTeam(db, model.team.id, project) : undefined;
  // In the path the project is the page's identity, so a name that matches nothing
  // is a wrong address, not an empty filter. As `?project=` it stays a filter.
  if (projectInPath(c) && !scopeProject) return c.notFound();
  // A refused write answers with a page, and a page needs chrome. Without this the
  // rail of a refused draft said "no workspace yet" next to the workspace's records.
  if (refused) await ensureRail(db, user, model.team.slug, scopeProject?.slug ?? null);
  const audienceOf = (entry: (typeof model.items)[number]) =>
    entry.current
      ? { type: entry.current.audience.type, projects: entry.current.audience.projects }
      : entry.draft
        ? { type: entry.draft.audienceType, projects: entry.draft.audienceProjects }
        : { type: 'workspace_members', projects: [] as Array<{ id: string; name: string }> };
  const reaches = (entry: (typeof model.items)[number]) => {
    const audience = audienceOf(entry);
    return audience.type !== 'selected_projects' || audience.projects.some((p) => p.id === scopeProject?.id);
  };
  const listed = scopeProject ? model.items.filter(reaches) : model.items;
  const elsewhere = model.items.length - listed.length;
  const slugOf = (id: string) => teamProjects.find((candidate) => candidate.id === id)?.slug;
  const home = `/app/teams/${model.team.slug}`;
  const scopeField = scopeProject ? <input type="hidden" name="scope_project" value={scopeProject.slug} /> : null;

  const ownerForms = isOwner ? (
    <div class="edgrid" style="margin-top:16px">
      <form
        class="card card-pad"
        method="post"
        action={`/app/teams/${model.team.slug}/knowledge/drafts`}
        style="display:flex;flex-direction:column;gap:12px"
      >
        {scopeField}
        <div class="card-title">{scopeProject ? `Add for ${scopeProject.name} only` : 'Write a native draft'}</div>
        {scopeProject ? (
          <p class="small muted m0">
            Starts addressed to this project. Choose Workspace members instead and it reaches every project.
          </p>
        ) : null}
        {refused?.form === 'draft' ? <div class="banner banner-error">{refused.error}</div> : null}
        <div class="field"><label for="kh-key">Stable key</label><input class="in" id="kh-key" name="stable_key" required maxlength={120} placeholder="refund-reference" value={was('draft', 'stable_key')} /></div>
        <div class="field"><label for="kh-title">Title</label><input class="in" id="kh-title" name="title" required maxlength={200} value={was('draft', 'title')} /></div>
        <div class="field"><label for="kh-kind">Kind</label><select class="in" id="kh-kind" name="kind">{KNOWLEDGE_KINDS.map((kind) => <option value={kind} selected={was('draft', 'kind') === kind}>{kind}</option>)}</select></div>
        <div class="field"><label for="kh-audience">Audience</label><select class="in" id="kh-audience" name="audience"><option value="workspace_members" selected={was('draft', 'audience') === 'workspace_members'}>Workspace members</option><option value="selected_projects" selected={refused?.form === 'draft' ? was('draft', 'audience') === 'selected_projects' : Boolean(scopeProject)}>Selected projects only</option></select></div>
        <div class="field"><label for="kh-projects">Existing projects</label><input class="in" id="kh-projects" name="projects" value={refused?.form === 'draft' ? was('draft', 'projects') : scopeProject?.slug} placeholder={teamProjects.map((p) => p.slug).join(', ') || 'Create a project first'} /><span class="help">Comma-separated names/slugs. Required only for selected-project audience; unknown projects are rejected.</span></div>
        <div class="field"><label for="kh-body">Markdown or structured text</label><textarea class="in" id="kh-body" name="body" rows={10} required maxlength={65_536}>{was('draft', 'body')}</textarea><span class="help">Stored and rendered as text. Drafts never appear in current retrieval.</span></div>
        <div class="field"><label for="kh-conflict-version">Conflicts with published version ID (optional)</label><input class="in" id="kh-conflict-version" name="conflicts_with_version_id" value={was('draft', 'conflicts_with_version_id')} /><span class="help">Pair this with a reason. An open conflict blocks publication until the conflicting current item is archived or withdrawn.</span></div>
        <div class="field"><label for="kh-conflict-reason">Conflict reason (optional)</label><input class="in" id="kh-conflict-reason" name="conflict_reason" maxlength={500} value={was('draft', 'conflict_reason')} /></div>
        <div class="row" style="gap:10px"><div class="field" style="flex:1"><label for="kh-review">Review after</label><input class="in" id="kh-review" name="review_after" type="datetime-local" value={was('draft', 'review_after')} /></div><div class="field" style="flex:1"><label for="kh-valid">Valid until</label><input class="in" id="kh-valid" name="valid_until" type="datetime-local" value={was('draft', 'valid_until')} /></div></div>
        <button class="btn btn-primary" type="submit">Save draft for review</button>
      </form>

      <form
        class="card card-pad"
        method="post"
        enctype="multipart/form-data"
        action={`/app/teams/${model.team.slug}/knowledge/imports`}
        style="display:flex;flex-direction:column;gap:12px"
      >
        {scopeField}
        <div class="card-title">{scopeProject ? `Import a file for ${scopeProject.name}` : 'Import one selected file'}</div>
        <p class="small muted m0">The browser uploads the selected UTF-8 text. STMA does not open paths, follow symlinks, scan the repository or fetch URLs.</p>
        {refused?.form === 'import' ? <div class="banner banner-error">{refused.error}</div> : null}
        <div class="field"><label for="khi-file">.md, .markdown or .txt</label><input class="in" id="khi-file" type="file" name="file" accept=".md,.markdown,.txt,text/plain,text/markdown" required />{refused?.form === 'import' ? <span class="help">Everything else you typed is still here, but the file has to be chosen again: a browser will not let a page put a file back into this box.</span> : null}</div>
        <div class="field"><label for="khi-key">Stable key</label><input class="in" id="khi-key" name="stable_key" required maxlength={120} value={was('import', 'stable_key')} /></div>
        <div class="field"><label for="khi-title">Title</label><input class="in" id="khi-title" name="title" required maxlength={200} value={was('import', 'title')} /></div>
        <div class="field"><label for="khi-kind">Kind</label><select class="in" id="khi-kind" name="kind">{KNOWLEDGE_KINDS.map((kind) => <option value={kind} selected={was('import', 'kind') === kind}>{kind}</option>)}</select></div>
        <div class="field"><label for="khi-audience">Audience</label><select class="in" id="khi-audience" name="audience"><option value="workspace_members" selected={was('import', 'audience') === 'workspace_members'}>Workspace members</option><option value="selected_projects" selected={refused?.form === 'import' ? was('import', 'audience') === 'selected_projects' : Boolean(scopeProject)}>Selected projects only</option></select></div>
        <div class="field"><label for="khi-projects">Existing projects</label><input class="in" id="khi-projects" name="projects" value={refused?.form === 'import' ? was('import', 'projects') : scopeProject?.slug} placeholder="payments-api" /></div>
        <div class="field"><label for="khi-repo">Source repository identity</label><input class="in" id="khi-repo" name="repository" maxlength={300} placeholder="owner/repository" value={was('import', 'repository')} /><span class="help">Repository and full commit SHA are supplied together; credential-bearing remotes are rejected and canonicalized.</span></div>
        <div class="field"><label for="khi-commit">Source commit</label><input class="in" id="khi-commit" name="commit" maxlength={64} value={was('import', 'commit')} /></div>
        <button class="btn" type="submit">Validate &amp; save preview draft</button>
      </form>
    </div>
  ) : (
    <div class="card card-pad" style="margin-top:16px"><p class="m0 small muted">Workspace owners review and publish drafts. Members can search current published knowledge.</p></div>
  );
  const records = (
    <div style="margin-top:16px;display:flex;flex-direction:column;gap:12px">
      {listed.length === 0 ? (
        <div class="card card-pad muted">
          {scopeProject ? `Nothing applies to ${scopeProject.name} yet: no workspace-wide record and none addressed to this project.` : 'No knowledge has been proposed yet.'}
        </div>
      ) : null}
      {scopeProject && elsewhere > 0 ? (
        <div class="small muted" id="knowledge-elsewhere">
          {elsewhere} record{elsewhere === 1 ? ' is' : 's are'} addressed to other projects only and not listed here.{' '}
          <a href={`${home}/knowledge`}>All workspace knowledge</a>
        </div>
      ) : null}
      {listed.map((entry) => {
        const { item, owner, current, draft, history, historyTruncated } = entry;
        const audience = audienceOf(entry);
        const others = audience.projects.filter((p) => p.id !== scopeProject?.id);
        return (
        <section class="card card-pad">
          <div class="row" style="justify-content:space-between;gap:12px;align-items:flex-start">
            <div><div class="card-title">{draft?.title ?? current?.title ?? item.stableKey}</div><div class="card-note mono">{item.stableKey} · {item.state} · owner {owner ?? 'deleted account'}</div></div>
            <div class="row" style="gap:6px;flex-wrap:wrap;justify-content:flex-end">
              {audience.type !== 'selected_projects' ? (
                <span class="pill pill-member" title="Served in every project of this workspace.">{scopeProject ? 'from the workspace' : 'every project'}</span>
              ) : scopeProject ? (
                <span class="pill pill-own" title="Addressed to chosen projects, this one among them.">{others.length === 0 ? 'this project only' : `this and ${others.length} other project${others.length === 1 ? '' : 's'}`}</span>
              ) : (
                <span class="pill pill-own" title="Served only in the projects named.">
                  only:{' '}
                  {audience.projects.map((p, index) => (
                    <>
                      {index > 0 ? ', ' : ''}
                      <a href={sectionHref(model.team.slug, slugOf(p.id) ?? p.name, 'knowledge')}>{p.name}</a>
                    </>
                  ))}
                </span>
              )}
              {current ? <span class="pill pill-active">published v{current.version}</span> : null}{draft ? <span class="pill pill-owner">draft r{draft.revision}</span> : null}
            </div>
          </div>
          {current ? (
            <details style="margin-top:12px"><summary>Current published text</summary><pre class="mono small" style="white-space:pre-wrap;overflow-wrap:anywhere">{current.body}</pre><div class="small muted">hash {current.hash} · source {current.source.uri} · audience {current.audience.type}{current.audience.projects.length ? `: ${current.audience.projects.map((p) => p.name).join(', ')}` : ''}</div></details>
          ) : null}
          {draft ? (
            <details open style="margin-top:12px"><summary>Draft preview — not served to agents</summary><pre class="mono small" style="white-space:pre-wrap;overflow-wrap:anywhere">{draft.body}</pre><div class="small muted">hash {draft.bodyHash} · source {draft.sourceUri} · audience {draft.audienceType}{draft.audienceProjects.length ? `: ${draft.audienceProjects.map((p) => p.name).join(', ')}` : ''}</div>{isOwner ? <form method="post" action={`/app/teams/${model.team.slug}/knowledge/${item.id}/publish`} style="margin-top:10px">{scopeField}<input type="hidden" name="draft_version_id" value={draft.id} /><input type="hidden" name="expected_current_version_id" value={item.currentVersionId ?? ''} /><button class="btn btn-primary" type="submit">Publish reviewed draft</button></form> : null}</details>
          ) : null}
          {history.length > 0 ? (
            <details style="margin-top:12px">
              <summary>Version history &amp; bounded line diff ({history.length}{historyTruncated ? '+' : ''})</summary>
              <div style="display:flex;flex-direction:column;gap:10px;margin-top:10px">
                {history.map((version) => (
                  <div class="card card-pad">
                    <div class="row" style="justify-content:space-between;gap:8px"><b>{version.status === 'draft' ? `draft r${version.revision}` : `published v${version.version}`}</b><span class="pill">{version.availability}</span></div>
                    <div class="small muted">hash {version.hash} · {version.source.uri ?? version.source.type} · checked {version.source.checkedAt ?? 'unknown'} · changed {version.source.changedAt ?? 'not observed'} · reviewed {version.source.reviewedAt ?? 'not reviewed'}</div>
                    {version.conflict ? <div class="banner banner-error" style="margin-top:8px">{version.conflict.status} conflict with {version.conflict.withVersionId}: {version.conflict.reason}</div> : null}
                    <details style="margin-top:8px"><summary>Content and changes</summary><pre class="mono small" style="white-space:pre-wrap;overflow-wrap:anywhere">{version.body}</pre><div class="small"><b>Added:</b> {version.diff.added.length ? version.diff.added.join(' ⏎ ') : 'none'}<br/><b>Removed:</b> {version.diff.removed.length ? version.diff.removed.join(' ⏎ ') : 'none'}{version.diff.truncated ? ' · diff truncated' : ''}</div></details>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
          {isOwner && current ? (
            <div class="row" style="margin-top:12px;gap:8px"><form method="post" action={`/app/teams/${model.team.slug}/knowledge/${item.id}/lifecycle`}>{scopeField}<input type="hidden" name="state" value="archived" /><input type="hidden" name="expected_current_version_id" value={item.currentVersionId ?? ''} /><button class="btn btn-sm" type="submit">Archive</button></form><form method="post" action={`/app/teams/${model.team.slug}/knowledge/${item.id}/lifecycle`}>{scopeField}<input type="hidden" name="state" value="withdrawn" /><input type="hidden" name="expected_current_version_id" value={item.currentVersionId ?? ''} /><button class="btn btn-sm btn-danger" type="submit">Withdraw</button></form></div>
          ) : null}
          {isOwner && item.state !== 'deleted' ? (
            <form method="post" action={`/app/teams/${model.team.slug}/knowledge/${item.id}/delete`} style="margin-top:12px" onsubmit="return confirm('Erase all stored text/source copies for this item and leave only tombstone hashes?')">
              {scopeField}
              <input type="hidden" name="expected_generation" value={item.generation} />
              <button class="btn btn-sm btn-danger" type="submit">Erase content &amp; leave tombstone</button>
            </form>
          ) : null}
        </section>
        );
      })}
    </div>
  );

  return c.html(
    <AppLayout
      user={user}
      active="knowledge"
      title={`Knowledge — ${model.team.name}`}
      head={
        <PageHead
          trail={
            scopeProject
              ? teamTrail(
                  model.team,
                  { label: 'Projects', href: `${home}/projects` },
                  { label: scopeProject.name, href: `${home}/projects/${encodeURIComponent(scopeProject.slug)}` },
                  { label: 'Knowledge' },
                )
              : teamTrail(model.team, { label: 'Knowledge' })
          }
          title={scopeProject ? `Knowledge in ${scopeProject.name}` : 'Knowledge Hub'}
          sub={
            scopeProject
              ? `What an agent working in ${scopeProject.name} can be served: records for the whole workspace, plus records addressed to this project. Published text is reference data, never execution authority.`
              : 'Versioned decisions, domain facts, procedures and known solutions. Each record says which projects it applies to. Published text is reference data, never execution authority.'
          }
          actions={
            scopeProject ? (
              <a class="btn btn-sm" href={`${home}/knowledge`}>All workspace knowledge</a>
            ) : (
              <a class="btn btn-sm" href={home}>Back to workspace</a>
            )
          }
        />
      }
    >
      {error ? <div class="banner banner-error">{error}</div> : null}
      {notice ? <div class="banner banner-success">{notice}</div> : null}

      {/* The search carries the project context it searches in, so it posts to the
          workspace address: a GET form writes a query string and nothing else, and
          `?project=` is the spelling this select can produce. Links produce the
          project's own address; a form that picks a project cannot. */}
      <form
        class="card card-pad row"
        method="get"
        action={sectionHref(model.team.slug, null, 'knowledge')}
        style="gap:10px;align-items:flex-end;flex-wrap:wrap"
      >
        <div class="field" style="flex:1;min-width:220px">
          <label for="kh-search">Search current knowledge</label>
          <input class="in" id="kh-search" name="q" value={query} maxlength={200} required />
        </div>
        <div class="field" style="min-width:190px">
          <label for="kh-project">Project context</label>
          <select class="in" id="kh-project" name="project">
            <option value="">Workspace audience only</option>
            {teamProjects.map((candidate) => (
              <option value={candidate.slug} selected={project === candidate.slug}>
                {candidate.name}
              </option>
            ))}
          </select>
        </div>
        <button class="btn btn-primary" type="submit">Search</button>
      </form>

      {searched && !('error' in searched) ? (
        <div class="card card-pad" style="margin-top:16px">
          <div class="card-title">{searched.total} current match{searched.total === 1 ? '' : 'es'}</div>
          {searched.results.length === 0 ? <p class="muted">No current knowledge matched this query.</p> : null}
          {searched.results.map((result) => (
            <div style="padding:12px 0;border-top:1px solid var(--line)">
              <div class="row" style="justify-content:space-between;gap:12px">
                <b>{result.title}</b>
                <span class="mono small">{result.key} · v{result.version}</span>
              </div>
              <p class="small">{result.snippet}</p>
              <span class="small muted">{result.source.uri ?? result.source.type} · owner {result.owner ?? 'deleted account'} · {result.freshness}</span>
            </div>
          ))}
        </div>
      ) : searched && 'error' in searched ? (
        <div class="banner banner-error" style="margin-top:16px">{searched.error}</div>
      ) : null}

      {scopeProject ? records : null}
      {ownerForms}
      {scopeProject ? null : records}
    </AppLayout>,
    // A refused write answers with the page that still holds the work, not 200:
    // the address did not change, and the submission did not succeed.
    refused ? 422 : 200,
  );
}

knowledgeRoutes.post('/app/teams/:slug/knowledge/drafts', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const form = (await c.req.parseBody()) as Record<string, unknown>;
  // A refusal hands the page back with everything still in it; only a success
  // redirects, and only a success has anything to say in a band.
  const refuse = (error: string) => renderKnowledge(c, { form: 'draft', typed: form, error });
  const back = backTo(c.req.param('slug'), form);
  const validUntil = dateValue(form.valid_until);
  const reviewAfter = dateValue(form.review_after);
  if (validUntil === undefined || reviewAfter === undefined) {
    return refuse('Review and validity dates must be valid.');
  }
  const result = await proposeKnowledge(
    c.get('db'),
    user.id,
    {
      team: c.req.param('slug'),
      stableKey: value(form.stable_key),
      kind: value(form.kind) as (typeof KNOWLEDGE_KINDS)[number],
      title: value(form.title),
      body: typeof form.body === 'string' ? form.body : '',
      audience: audienceFromForm(form),
      source: { type: 'native' },
      validUntil,
      reviewAfter,
      conflictsWithVersionId: value(form.conflicts_with_version_id) || null,
      conflictReason: value(form.conflict_reason) || null,
    },
    undefined,
    hostedKnowledgeCapacityLimits(c.get('env')),
  );
  return 'error' in result
    ? refuse(result.error ?? 'Draft was not saved.')
    : c.redirect(back('notice', 'Draft saved. It is not current until an owner publishes it.'));
});

knowledgeRoutes.post('/app/teams/:slug/knowledge/imports', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const form = (await c.req.parseBody()) as Record<string, unknown>;
  // The file itself cannot be handed back — no browser lets a page refill a
  // file input — but the ten fields typed around it can, and losing those was
  // the whole complaint.
  const refuse = (error: string) => renderKnowledge(c, { form: 'import', typed: form, error });
  const back = backTo(c.req.param('slug'), form);
  const file = form.file;
  if (!file || typeof file === 'string' || typeof (file as File).arrayBuffer !== 'function') {
    return refuse('Select one text or Markdown file.');
  }
  const uploaded = file as File;
  const checked = validateKnowledgeImports([
    {
      path: uploaded.name,
      content: new Uint8Array(await uploaded.arrayBuffer()),
      mediaType: uploaded.type || undefined,
    },
  ]);
  if ('error' in checked) return refuse(checked.error);
  const result = await proposeKnowledge(
    c.get('db'),
    user.id,
    {
      team: c.req.param('slug'),
      stableKey: value(form.stable_key),
      kind: value(form.kind) as (typeof KNOWLEDGE_KINDS)[number],
      title: value(form.title),
      body: checked.files[0]!.text,
      audience: audienceFromForm(form),
      source: {
        type: 'import',
        path: checked.files[0]!.path,
        repository: value(form.repository) || undefined,
        commit: value(form.commit) || undefined,
        symlink: false,
      },
    },
    undefined,
    hostedKnowledgeCapacityLimits(c.get('env')),
  );
  return 'error' in result
    ? refuse(result.error ?? 'Import was not saved.')
    : c.redirect(back('notice', 'Import validated and saved as a draft preview. Nothing was published.'));
});

knowledgeRoutes.post('/app/teams/:slug/knowledge/:itemId/publish', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const form = (await c.req.parseBody()) as Record<string, unknown>;
  const back = backTo(c.req.param('slug'), form);
  const result = await publishKnowledge(
    c.get('db'),
    user.id,
    {
      team: c.req.param('slug'),
      itemId: c.req.param('itemId'),
      draftVersionId: value(form.draft_version_id),
      expectedCurrentVersionId: value(form.expected_current_version_id) || null,
    },
    hostedKnowledgeCapacityLimits(c.get('env')),
  );
  return 'error' in result
    ? c.redirect(back('error', result.error ?? 'Publish failed.'))
    : c.redirect(back('notice', `Published version ${result.published.version}.`));
});

knowledgeRoutes.post('/app/teams/:slug/knowledge/:itemId/lifecycle', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const form = (await c.req.parseBody()) as Record<string, unknown>;
  const back = backTo(c.req.param('slug'), form);
  const state = value(form.state);
  if (state !== 'archived' && state !== 'withdrawn') {
    return c.redirect(back('error', 'Unknown lifecycle action.'));
  }
  const result = await setKnowledgeLifecycle(c.get('db'), user.id, {
    team: c.req.param('slug'),
    itemId: c.req.param('itemId'),
    expectedCurrentVersionId: value(form.expected_current_version_id) || null,
    state,
  });
  return 'error' in result
    ? c.redirect(back('error', result.error ?? 'Lifecycle update failed.'))
    : c.redirect(back('notice', `Knowledge ${state}.`));
});

knowledgeRoutes.post('/app/teams/:slug/knowledge/:itemId/delete', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const form = (await c.req.parseBody()) as Record<string, unknown>;
  const back = backTo(c.req.param('slug'), form);
  const expectedGeneration = Number(value(form.expected_generation));
  const result = await deleteKnowledgeContent(c.get('db'), user.id, {
    team: c.req.param('slug'),
    itemId: c.req.param('itemId'),
    expectedGeneration,
  });
  return 'error' in result
    ? c.redirect(back('error', result.error ?? 'Content erasure failed.'))
    : c.redirect(
        back(
          'notice',
          result.replayed
            ? 'Knowledge content was already erased.'
            : 'Knowledge content and retained server response copies were erased; tombstone hashes remain.',
        ),
      );
});
