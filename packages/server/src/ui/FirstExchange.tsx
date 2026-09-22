/**
 * The guide and connection page share one persistent, server-observed launch.
 *
 * It used to be a heading, a paragraph and a bare select beside a button — the
 * one place in the console that still looked like a form nobody designed. The
 * three things a launch observes are drawn as the steps they are, and the
 * choice is a labelled field like every other form here.
 */
export function FirstExchange(props: {
  baseUrl: string;
  teamSlug?: string;
  projectName?: string;
  expanded?: boolean;
}) {
  return (
    <section class="card xchg" id="first-message">
      <div class="xchg-head">
        <span class="overline">First result</span>
        <h3>Two agents, one result</h3>
        <p>
          Start or resume a persistent launch. Authorize each client through the same MCP address,
          then give the two connected agents short sender/reply checks with no credentials or setup
          instructions. STMA confirms the exchange on the launch page.
        </p>
      </div>
      <ol class="xchg-steps">
        <li>
          <b>Authorize</b>
          <span>Each client approves once in the browser, through the one MCP address.</span>
        </li>
        <li>
          <b>Send</b>
          <span>The first agent posts a short check addressed to the second.</span>
        </li>
        <li>
          <b>Reply</b>
          <span>The second answers it, and the launch page confirms the round trip.</span>
        </li>
      </ol>
      <div class="xchg-foot">
        {props.teamSlug ? (
          <form class="xchg-form" method="post" action="/app/launches">
            <input type="hidden" name="team" value={props.teamSlug} />
            {props.projectName && <input type="hidden" name="project" value={props.projectName} />}
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
          <a class="btn btn-primary" href="/app/tokens">
            Choose workspace and launch my agents
          </a>
        )}
        <p class="card-note">
          {props.teamSlug && (
            <>
              Scope: {props.teamSlug} / {props.projectName ?? 'workspace'}.{' '}
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
