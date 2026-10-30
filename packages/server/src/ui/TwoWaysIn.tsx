import {
  BOTH_DOORS,
  CLAUDE_APP_BOUNDARY,
  CLAUDE_APP_SUMMARY,
  CLAUDE_APP_TERM,
  CODING_AGENT_SUMMARY,
  CODING_AGENT_TERM,
  claudeConnectorLink,
} from '../lib/entry';

/**
 * The two ways into STMA, as two cards (the technical specification's T02).
 *
 * "Add STMA to Claude" and "connect an agent to a project" are different things
 * with different consequences, and one page used to offer only the second while
 * listing the first as if it were an agent. The cards name each in the words
 * `lib/entry.ts` holds for every surface, say what the door is not, and send
 * the person to the one action that begins it. Drawn on the Agent connections
 * page, on the account-level chooser and on the empty workspace list.
 *
 * The door a person arrived through is not drawn here: the address carries it
 * as a fragment (`#claude-app` or `#connect`), and the browser scrolls to it.
 */
export const TwoWaysIn = ({
  baseUrl,
  connectHref = '#connect',
  connectLabel = 'Connect a coding agent',
  connectDialog,
  claudeHref,
}: {
  baseUrl: string;
  /** Where the coding-agent card leads: the connect section of the page. */
  connectHref?: string;
  connectLabel?: string;
  /** Instead of a link, open this dialog (the empty workspace list has to make a workspace first). */
  connectDialog?: string;
  /** Where "how it works" for the Claude app is read; this page's own section by default. */
  claudeHref?: string;
}) => (
  <div class="twodoors" id="two-ways-in">
    <section class="card card-pad" aria-labelledby="door-claude-app">
      <span class="overline">Door 1</span>
      <h2 id="door-claude-app" class="card-title" style="margin:4px 0">
        {CLAUDE_APP_TERM}
      </h2>
      <p class="m0">
        {CLAUDE_APP_SUMMARY} {CLAUDE_APP_BOUNDARY}
      </p>
      <div class="row" style="margin-top:12px">
        <a class="btn btn-primary" href={claudeConnectorLink(baseUrl)} target="_blank" rel="noopener">
          Add STMA to Claude
        </a>
        <a class="btn" href={claudeHref ?? '#claude-app'}>
          How it works
        </a>
      </div>
    </section>
    <section class="card card-pad" aria-labelledby="door-coding-agent">
      <span class="overline">Door 2</span>
      <h2 id="door-coding-agent" class="card-title" style="margin:4px 0">
        Coding agent in a checkout
      </h2>
      <p class="m0">
        {CODING_AGENT_SUMMARY} A {CODING_AGENT_TERM} is the agent that does the work: stma connect
        installs its hooks, and you can assign it work.
      </p>
      <div class="row" style="margin-top:12px">
        {connectDialog ? (
          <button class="btn btn-primary" type="button" data-open-dialog={connectDialog}>
            {connectLabel}
          </button>
        ) : (
          <a class="btn btn-primary" href={connectHref}>
            {connectLabel}
          </a>
        )}
      </div>
    </section>
    <p class="small muted m0" style="grid-column:1 / -1">
      {BOTH_DOORS}
    </p>
  </div>
);
