import { WORKSPACE_WORK_ITEM_LIMIT, WORKSPACE_WORK_PROJECT_LIMIT, WORKSPACE_WORK_VIEWS, type WorkspaceWorkOverviewData } from '../lib/workspaceWorkOverview';
import { timeAgo } from '../lib/format';

const labels = { open: 'Open work', needs_decision: 'Needs a decision', blocked: 'Blocked', ready: 'Ready', in_progress: 'In progress' };

export const WorkspaceWorkOverview = ({ teamSlug, data }: { teamSlug: string; data: WorkspaceWorkOverviewData }) => {
  const projectHref = (slug: string) => `/app/teams/${encodeURIComponent(teamSlug)}/projects/${encodeURIComponent(slug)}/work`;
  return (
    <section id="workspace-work" class="card scroll-x" style="margin-bottom:16px" aria-label="Workspace work overview">
      <div class="card-head">
        <div>
          <div class="card-title">Work across projects</div>
          <div class="card-note">Open the work to inspect its contract, delivery and evidence. Acceptance remains a human decision.</div>
        </div>
        <a class="btn btn-sm" href={`/app/teams/${encodeURIComponent(teamSlug)}/work`}>Open Work queue</a>
      </div>
      <div class="card-pad">
        <div class="row" style="flex-wrap:wrap;gap:12px">
          <span><b>{data.totals.open}</b> open</span>
          <span><b>{data.totals.ready}</b> ready</span>
          <span><b>{data.totals.in_progress}</b> in progress</span>
          <span><b>{data.totals.in_review}</b> in review</span>
        </div>
        <p class="small muted">Archived and closed work is excluded. Oldest updates appear first; an old update alone does not prove an agent has stopped.</p>
        {data.projectsTruncated ? <p class="small muted">This overview covers the first {WORKSPACE_WORK_PROJECT_LIMIT} projects by name. Open other projects from the project list for their work.</p> : null}
        <nav class="row" style="flex-wrap:wrap;gap:8px" aria-label="Workspace work views">
          {WORKSPACE_WORK_VIEWS.map((view) => <a class={`btn btn-sm${view === data.view ? ' btn-primary' : ''}`}
            aria-current={view === data.view ? 'page' : undefined}
            href={`/app/teams/${encodeURIComponent(teamSlug)}?work_view=${view}#workspace-work`}>{labels[view]}</a>)}
        </nav>
      </div>
      {data.items.length ? <table class="tbl">
        <thead><tr><th>Project / work</th><th>State</th><th>Owner</th><th>Last update</th></tr></thead>
        <tbody>{data.items.map((item) => <tr>
          <td class="name"><div class="small muted">{item.projectName}</div>
            <a href={`${projectHref(item.projectSlug)}/${encodeURIComponent(item.key)}`}>{item.key} · {item.title}</a>
            {item.blocked ? <div class="small">Blocked: {item.waiting}</div> : null}
          </td>
          <td>{item.state.replaceAll('_', ' ')}</td><td>{item.owner ?? 'Unassigned'}</td>
          <td class="muted">{timeAgo(item.updatedAt) ?? '—'}</td>
        </tr>)}</tbody>
      </table> : <p class="card-pad small muted">No work matches this view. Open a project to create work or inspect its history.</p>}
      {data.moreItems ? <p class="card-pad small muted">Showing the oldest {WORKSPACE_WORK_ITEM_LIMIT} matching items. Use the project links below for the complete lists.</p> : null}
      {data.projects.length ? <details class="card-pad"><summary>Work by project ({data.projectCount})</summary>
        <table class="tbl"><thead><tr><th>Project</th><th>Open</th><th>Ready</th><th>In progress</th><th>In review</th></tr></thead>
          <tbody>{data.projects.map((project) => <tr><td><a href={projectHref(project.slug)}>{project.name}</a></td>
            <td>{project.open}</td><td>{project.ready}</td><td>{project.in_progress}</td><td>{project.in_review}</td></tr>)}</tbody>
        </table>
      </details> : null}
    </section>
  );
};
