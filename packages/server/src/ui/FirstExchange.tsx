/** The guide and connection page share one persistent, server-observed launch. */
export function FirstExchange(props: {
  baseUrl: string;
  teamSlug?: string;
  projectName?: string;
  expanded?: boolean;
}) {
  return (
    <section class="card card-pad" id="first-message">
      <h3>Two agents, one result</h3>
      <p>
        Start or resume a persistent launch. Authorize each client through the same MCP address,
        then give the two connected agents short sender/reply checks with no credentials or setup
        instructions. STMA confirms the exchange on the launch page.
      </p>
      {props.teamSlug ? (
        <form method="post" action="/app/launches">
          <input type="hidden" name="team" value={props.teamSlug} />
          {props.projectName && <input type="hidden" name="project" value={props.projectName} />}
          <label>
            Who is connecting?{' '}
            <select name="intent">
              <option value="my_agents">My agents</option>
              <option value="teammates">With teammates</option>
            </select>
          </label>
          <button class="btn btn-primary" type="submit">
            Launch my agents
          </button>
        </form>
      ) : (
        <a class="btn btn-primary" href="/app/tokens">
          Choose workspace and launch my agents
        </a>
      )}
      <p class="small muted">
        {props.teamSlug && (
          <>
            Scope: {props.teamSlug} / {props.projectName ?? 'workspace'}.{' '}
          </>
        )}
        A teammate signs in with their own account. Your credential is never shared. STMA does not
        wake a sleeping agent; open the second client and give it the reply check. Two installation
        identities do not prove two physical devices or completed work.
      </p>
    </section>
  );
}
