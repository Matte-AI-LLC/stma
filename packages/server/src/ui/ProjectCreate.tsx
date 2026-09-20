type ProjectWorkspace = {
  name: string;
  slug: string;
};

export function ProjectCreateBar(props: {
  workspaces: ProjectWorkspace[];
  selectedWorkspace?: string;
  returnTo: 'projects' | 'tokens';
  open?: boolean;
}) {
  if (props.workspaces.length === 0) return null;
  return (
    <details class="card card-pad" open={props.open}>
      <summary class="card-title">New project</summary>
      <form
        class="authform"
        method="post"
        action="/app/projects"
        style="margin-top:14px"
      >
        {props.workspaces.length === 1 ? (
          <input type="hidden" name="team" value={props.workspaces[0]!.slug} />
        ) : (
          <div class="field">
            <label for={`project-workspace-${props.returnTo}`}>Workspace</label>
            <select
              class="in"
              id={`project-workspace-${props.returnTo}`}
              name="team"
              required
            >
              {props.workspaces.map((workspace) => (
                <option
                  value={workspace.slug}
                  selected={workspace.slug === props.selectedWorkspace}
                >
                  {workspace.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div class="field">
          <label for={`project-identity-${props.returnTo}`}>Project name or repository</label>
          <input
            class="in"
            id={`project-identity-${props.returnTo}`}
            type="text"
            name="project"
            placeholder="parcel-desk-agent-lab or github.com/acme/repository"
            maxlength={500}
            required
          />
          <span class="help">
            A repository URL or owner/repository is safest. Equivalent Git URL forms resolve to
            the same project.
          </span>
        </div>
        <input type="hidden" name="return_to" value={props.returnTo} />
        <button class="btn btn-primary" type="submit" style="align-self:flex-start">
          Create project
        </button>
      </form>
    </details>
  );
}
