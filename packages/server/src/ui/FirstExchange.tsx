/**
 * The test before a first launch exists: two agents, one server-observed exchange.
 *
 * Drawn in the Test section of a workspace's Agent connections page, where it
 * starts the test in that page's scope, and on the guide, where it can only say
 * where that page is. The three things a test observes are drawn as the steps
 * they are, and the choice is a labelled field like every other form here.
 */
export function FirstExchange(props: {
  baseUrl: string;
  teamSlug?: string;
  /** The project's slug when the page is inside one. */
  project?: string;
  expanded?: boolean;
}) {
  return (
    <section class="card xchg" id="first-message">
      <div class="xchg-head">
        <span class="overline">First result</span>
        <h3>Two agents, one result</h3>
        <p>
          Start or resume a persistent launch. Connect each agent through the same MCP address,
          then give the two connected agents short sender/reply checks with no credentials or setup
          instructions. STMA confirms the exchange on the workspace's Agent connections page.
        </p>
      </div>
      <ol class="xchg-steps">
        <li>
          <b>Connect</b>
          <span>Each agent gets its own connection, with its own name and machine.</span>
        </li>
        <li>
          <b>Send</b>
          <span>The first agent posts a short check addressed to the second.</span>
        </li>
        <li>
          <b>Reply</b>
          <span>The second answers it, and the page confirms the round trip.</span>
        </li>
      </ol>
      <div class="xchg-foot">
        {props.teamSlug ? (
          <form class="xchg-form" method="post" action="/app/launches">
            <input type="hidden" name="team" value={props.teamSlug} />
            {props.project && <input type="hidden" name="project" value={props.project} />}
            <div class="field">
              <label for="launch-intent">Who is connecting?</label>
              <select class="in" id="launch-intent" name="intent">
                <option value="my_agents">My agents</option>
                <option value="teammates">With teammates</option>
              </select>
            </div>
            <button class="btn btn-primary" type="submit">
              Launch my agents
            </button>
          </form>
        ) : (
          <a class="btn btn-primary" href="/app/tokens#test">
            Choose workspace and launch my agents
          </a>
        )}
        <p class="card-note">
          {props.teamSlug && (
            <>
              Scope: {props.teamSlug} / {props.project ?? 'workspace'}.{' '}
            </>
          )}
          A teammate signs in with their own account. Your credential is never shared. STMA does
          not wake a sleeping agent; open the second client and give it the reply check. Two
          installation identities do not prove two physical devices or completed work.
        </p>
      </div>
    </section>
  );
}
