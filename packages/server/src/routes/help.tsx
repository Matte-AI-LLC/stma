import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { AppLayout, Head, Logo } from '../ui/Layout';
import { VERSION } from '../version';

/**
 * `/help` — the page somebody goes to when it went wrong.
 *
 * **Why it is its own page and not a section of `/docs`.** The guide is written
 * for the person who is succeeding, and its troubleshooting table sits at the
 * bottom of the longest page in the product: nobody stuck scrolls a guide. More
 * decisively, the walls that matter most are the ones in front of the login — a
 * refused access code, a six-digit code that never arrived, a lock that refuses
 * the right password — and a person who cannot sign in cannot read anything
 * behind it. So this is public, unauthenticated and short enough to have a URL
 * somebody can be *told*: "go to /help".
 *
 * **Why the README is not the answer either.** It is the first thing a
 * self-hoster reads and the last thing a hosted beta user does; its failures
 * overlap but are not the same set. The README keeps the operator's half (which
 * it now names), this page keeps the person's.
 *
 * **The teaser rule applies, with the same variable `/docs` uses.** Under
 * `SITE_MODE=teaser` a signed-out reader has no account, so they cannot have an
 * enrollment code or a running agent: the two sections about connecting and
 * working are console content and are hidden, table of contents included. The
 * sign-in, self-hosting and "working as intended" sections are always there,
 * because those are precisely the walls a signed-out person hits. Signing in
 * reveals the rest on the same instance — this is not a reduced build.
 *
 * Every entry here was hit by a real person or a real agent in this
 * repository's own rounds, and quotes the message the product actually prints.
 * Nothing is invented to round out a list; where the honest answer is "there is
 * no way to do this yet", it says so.
 */
export const helpRoutes = new Hono<AppEnv>();

/** One wall: the literal thing on screen, then why and what to do about it. */
const Wall = ({ seen, children }: { seen: unknown; children: unknown }) => (
  <tr>
    <td>{seen}</td>
    <td>{children}</td>
  </tr>
);

const Walls = ({ children }: { children: unknown }) => (
  <div class="card scroll-x">
    <table class="tbl">
      <tr>
        <th>What you see</th>
        <th>Why, and what to do</th>
      </tr>
      {children}
    </table>
  </div>
);

helpRoutes.get('/help', (c) => {
  const env = c.get('env');
  const user = c.get('user');
  // The same rule as the guide: a stranger pre-launch is here for the half they
  // can actually reach, and a table of contents may not point at a section that
  // is not there.
  const showConsole = Boolean(user) || env.publicMode === 'full';
  const support = env.supportEmail;

  const body = (
    <>
      <div class="docgrid">
        <nav class="sidetoc">
          <a href="#signin">Getting in</a>
          {showConsole ? <a href="#connect">Connecting an agent</a> : null}
          {showConsole ? <a href="#working">Connected, nothing moves</a> : null}
          <a href="#selfhost">Your own server</a>
          <a href="#expected">Working as intended</a>
          <a href="#ask">Still stuck</a>
        </nav>
        <div class="doc-col" style="max-width:none">
          <div>
            <h1 class="title" style="font-size:30px">
              When it goes wrong
            </h1>
            <p class="sub" style="max-width:66ch">
              Find the message you are looking at. Each entry says why it happens and the exact
              thing to type or click. For how the product works, read the{' '}
              <a href="/docs">guide</a> instead.
            </p>
          </div>

          <section class="doc-section" id="signin">
            <h2>Getting in</h2>
            <p class="m0">
              This is the half of the product that stands in front of the door, which is why the
              page you are reading needs no account. If you are locked out, everything here can be
              done from where you are.
            </p>
            <Walls>
              <Wall
                seen={
                  <code>That access code is not valid. Check the email that invited you to the beta.</code>
                }
              >
                The code is compared against the ones this instance was configured with, and it is
                checked <em>before</em> your address is looked at — so this answer says nothing
                about whether you already have an account. Re-copy the whole code from the
                invitation, watching for a trailing space; it is case-sensitive. A code belongs to
                a whole group and is never used up, so "somebody else already used it" is not the
                cause. If the mail carried a link, open that instead: it fills the field for you.
              </Wall>
              <Wall seen="There is no Create account link, and /signup sends you to the sign-in page.">
                Registration is closed on this instance. During the private beta that is the
                normal state: you get in with an access code once the door is open, or with an
                invitation from somebody who already has a workspace here — their agent can make
                one with <code>create_invite</code>.
              </Wall>
              <Wall seen={<code>An account with that email already exists — sign in instead.</code>}>
                One account per address. <a href="/login">Sign in</a>; if the password is gone,{' '}
                <a href="/forgot">reset it</a>.
              </Wall>
              <Wall seen="The six-digit sign-in code never arrives.">
                The code is emailed, and the six digits are in the <b>subject line</b> on purpose —
                a phone's notification preview is enough, you do not have to open the message.
                Check spam. Use <b>Send another code</b> on the verification page rather than
                signing in again. If nothing arrives at all, the instance's mail is the suspect,
                not your account.
              </Wall>
              <Wall
                seen={
                  <code>
                    Too many sign-in codes were requested for this account. Wait a few minutes, then
                    try again.
                  </code>
                }
              >
                Three sends per fifteen minutes. Wait it out and sign in once; pressing resend
                again only extends the queue you are in.
              </Wall>
              <Wall
                seen={
                  <>
                    <code>That code is not right. 2 attempts left.</code> then{' '}
                    <code>That code has expired or was already used.</code>
                  </>
                }
              >
                A code is single-use, ten minutes, five attempts. Go back to{' '}
                <a href="/login">sign in</a> for a fresh one, and type the newest mail's code — an
                older message in the inbox is the usual reason the digits do not match.
              </Wall>
              <Wall
                seen={
                  <code>Too many sign-in attempts for this email address. Try again after 14:05 UTC.</code>
                }
              >
                Five wrong passwords for one address in fifteen minutes locks it, and the{' '}
                <em>right</em> password is refused too — a lock a correct guess walks through is
                not a lock. It is a fixed window, so further attempts do not push the time back.
                Either wait until the time shown, or{' '}
                <a href="/forgot">reset your password</a>: completing a reset clears the lock,
                because failing to sign in is how most people arrive at the reset form.
              </Wall>
              <Wall seen="The reset code arrived on your phone, but you asked for it on your laptop.">
                A reset code belongs to the browser that asked for it, and that is held in a
                cookie. The reset email carries a link: open it on the device you are reading it
                on and finish there. Or ask for a fresh code from the browser you want to use.
              </Wall>
              <Wall
                seen={
                  <>
                    <code>/forgot</code> and <code>/reset</code> answer 404.
                  </>
                }
              >
                Self-service reset needs a mailbox to deliver to, and this instance has email
                switched off. On a server somebody you know runs, ask them — the operator can
                reset an account from the admin console.
              </Wall>
              <Wall seen="You reset the password and the connected agents kept working.">
                Deliberate, and every surface says so: a password never reached an agent
                credential, and revoking every teammate's agent over a forgotten password would be
                its own outage. If you think somebody else got into the account, also revoke the
                connections from <b>Agent connections</b> — that is the half a reset does not do.
              </Wall>
              <Wall seen={<code>invite code is invalid, expired or used up</code>}>
                The invitation expired, ran out of uses, or the workspace is at its member limit.
                Ask the owner for a fresh one: it is on their team page under <b>People</b>.
              </Wall>
            </Walls>
          </section>

          {showConsole ? (
            <section class="doc-section" id="connect">
              <h2>Connecting an agent</h2>
              <p class="m0">
                Before you answer <code>[y/N]</code>, read the five lines{' '}
                <code>stma connect</code> prints — server, workspace, project, agent and device,
                and the checkout path. Two of the most common problems on this list are visible
                there and nowhere else. If a checkout is already half-connected and you are not
                sure what state it is in, <code>stma adapter doctor</code> says so before you
                change anything.
              </p>
              <Walls>
                <Wall
                  seen={
                    <code>
                      Run this in a regular interactive terminal so you can confirm it. Nothing was
                      connected and the code is unused.
                    </code>
                  }
                >
                  The command was given to the agent instead of typed into a terminal. It asks{' '}
                  <code>y/N</code> at a real terminal before it spends the code, and an agent
                  session has no terminal to ask at — so nothing happened and the code is still
                  good. Open a normal terminal, <code>cd</code> into the checkout, and paste it
                  there. The refusal is the design, not a limitation: the code is a one-use secret
                  and must never go into a prompt. Asked to run it, a real agent refused and told
                  its human the same thing.
                </Wall>
                <Wall
                  seen={
                    <code>
                      This code is invalid, expired, already used or revoked. Create a new command
                      under Agent connections.
                    </code>
                  }
                >
                  A connect code is project-only, one use and ten minutes. Make a new one on{' '}
                  <a href="/app/tokens">Agent connections</a> and paste it inside that window.
                </Wall>
                <Wall
                  seen={
                    <code>Run this at the root of the Git checkout the agent works in. Nothing was connected.</code>
                  }
                >
                  Claude Code attaches a local MCP entry to the git root, so connecting from a
                  subfolder would leave an entry the agent never loads. Move to the folder{' '}
                  <code>git rev-parse --show-toplevel</code> prints and run the same command
                  again.
                </Wall>
                <Wall
                  seen={
                    <code>
                      Claude Code already connects to https://… here as "stma". A second entry for
                      the same server would give one session two STMA identities.
                    </code>
                  }
                >
                  There is already an STMA entry this checkout loads — usually a machine-wide one
                  added earlier. Either keep using it, or remove it with{' '}
                  <code>claude mcp remove NAME</code> and connect again. Nothing is removed for
                  you.
                </Wall>
                <Wall seen="The agent asks permission for an STMA server you did not just connect, and the work lands nowhere.">
                  The same cause seen from the agent's side: the checkout loads a second STMA
                  entry, and an agent given a bare tool name picks one of them — which is a real
                  agent's behaviour here, not a hypothetical. Do not grant it. Name the server
                  instead — the alias is on the <code>Will add</code> line of the connect output —
                  and remove or scope the other entry. The preview warns before it touches anything
                  (<code>Also loads MCP server …</code>), which is one of the five lines worth
                  reading.
                </Wall>
                <Wall
                  seen={
                    <code>
                      This checkout already has local profile … Run "stma adapter disconnect
                      --profile … --apply" first.
                    </code>
                  }
                >
                  A previous attempt left hooks and a profile behind. Run exactly what it says,
                  then connect again. <code>stma adapter status</code> lists what is there;{' '}
                  <code>No adapter profiles installed.</code> is what clean looks like.
                </Wall>
                <Wall seen={<code>Claude Code was not found on PATH.</code>}>
                  Install it, or connect that client through the browser instead from{' '}
                  <a href="/app/tokens">Agent connections</a>.
                </Wall>
                <Wall
                  seen={
                    <code>
                      Not confirmed yet: start Claude Code in this folder within 15 minutes so it
                      loads the entry, or the pending credential expires.
                    </code>
                  }
                >
                  <b>Not a failure.</b> The credential stays pending until the client itself
                  reaches STMA once. Start the client in that same folder and check its MCP list;
                  the row named <code>stma-FOLDER-XXXX</code> should read connected. On Codex,
                  also open <code>/hooks</code> and trust this project's hooks — until you do,
                  nothing is tracked or guarded.
                </Wall>
                <Wall seen="MCP calls answer 401.">
                  Access lasts an hour and the client refreshes it on its own; a revoked
                  installation, a membership you lost or a deleted project cannot be refreshed.
                  Use the client's own Authenticate action first. If that fails, remove the
                  connection in the client, add the same <code>/mcp</code> address again and
                  approve a fresh installation. Never paste a setup code or an{' '}
                  <code>Authorization</code> header as a workaround.
                </Wall>
                <Wall seen={<code>OAuth access token has expired</code>}>
                  Inside a Claude Code session, that is Claude's own login, not STMA. Type{' '}
                  <code>/login</code>.
                </Wall>
                <Wall
                  seen={
                    <>
                      Windows:{' '}
                      <code>… cannot be loaded because running scripts is disabled on this system</code>
                    </>
                  }
                >
                  PowerShell's default policy blocks npm's <code>.ps1</code> shims. Add{' '}
                  <code>.cmd</code>: <code>stma.cmd</code>, <code>npx.cmd</code>,{' '}
                  <code>claude.cmd</code>. Do not change the execution policy to get past this.
                </Wall>
                <Wall seen="Windows: antivirus stops stma adapter disconnect part-way and the connection is still there.">
                  Measured once, on this project's own Windows desktop: Kaspersky's behaviour
                  monitor flagged the published CLI running from the npx cache while it started
                  PowerShell to unlock a stored credential. The process died before it sent
                  anything, so the server connection stayed live and only the client's entry was
                  removed. <b>Revoke the connection in the browser</b>, on{' '}
                  <a href="/app/tokens">Agent connections</a> — that is the half that actually
                  stops access — then remove the client entry by hand. Both Windows helper scripts
                  were rewritten to avoid the shape that was flagged; whether a published build
                  still trips the same scanner <b>has not been verified</b>.
                </Wall>
                <Wall seen="Codex: the hooks never fire and MCP calls are refused.">
                  Codex refuses MCP calls under its non-interactive approval policy, and project
                  hooks need explicit trust. Use interactive Codex, approve the calls, and trust
                  the hooks in <code>/hooks</code>. Codex also keeps one STMA identity per
                  machine, because it loads its user config in every checkout — a second entry for
                  the same server is refused rather than silently replacing the first.
                </Wall>
              </Walls>
            </section>
          ) : null}

          {showConsole ? (
            <section class="doc-section" id="working">
              <h2>Connected, but nothing moves</h2>
              <Walls>
                <Wall seen="You assign work, say “continue” to the agent, and it answers “continue with what?”">
                  Two causes, both measured. The server may have been asleep: an instance that
                  scales to zero takes twenty to forty-five seconds to wake, the prompt hook waits
                  2.5 seconds for news and then stays silent rather than blocking you — so load
                  any page of the app in your browser first, then prompt again. Or the checkout is
                  running hooks from a CLI older than 0.14.2, which checked at most once a minute
                  and so missed an assignment made just after the agent's last tool call. Re-pin
                  that checkout with <code>stma adapter repair --pin-runtime --apply</code>. In
                  the meantime, one sentence does the job: <i>read your STMA inbox and do the work
                  assigned to you</i>.
                </Wall>
                <Wall seen="A freshly connected agent opens with “7 debug sessions have unread replies”.">
                  Old assignments addressed to other agents were being counted as this agent's
                  unread mail — measured on four agents at once. Fixed, but the fix is in the
                  hooks, so a checkout connected with an older CLI still shows it:{' '}
                  <code>stma adapter repair --pin-runtime --apply</code>.
                </Wall>
                <Wall seen="The agent sits for a minute or two before its first STMA call.">
                  That is your client's permission mode, not STMA. The same hook text walked
                  straight through in one session's auto-approve mode and stopped to ask in
                  another's default mode.
                </Wall>
                <Wall seen={<code>STMA stopped this file edit: work_conflict.</code>}>
                  Another live run declared that file first, and the run that was there first
                  keeps the right of way. The message names who holds it and what they are doing.
                  If it says that run has stopped to ask a person, waiting will not free the
                  ground — talk to their human or open a session. Do not route around the guard
                  with a shell command: it only sees the client's file tools, so going around it
                  hides the collision instead of resolving it.
                </Wall>
                <Wall seen={<code>STMA stopped this file edit: stale_ground.</code>}>
                  Another run finished on ground yours still holds, so what your agent read may
                  already be gone. Fetch or pull as you direct, then tell the agent to{' '}
                  <b>re-declare its scope</b> with <code>update_run</code> — re-declaring is what
                  acknowledges that the ground moved — and retry the edit.
                </Wall>
                <Wall seen={<code>STMA stopped this file edit: policy_content_denied</code>}>
                  Your workspace published a <code>content:</code> rule and the text this edit
                  would add matches it. The text never left the machine; only the rule, the path
                  and the outcome are recorded, on <b>Governance</b>. Make a change that does not
                  contain it.
                </Wall>
                <Wall
                  seen={
                    <>
                      <code>update_handoff</code> keeps being refused, or{' '}
                      <code>Resume commit mismatch</code>.
                    </>
                  }
                >
                  The order is <b>accept → resume → complete</b>, and <code>complete</code> before{' '}
                  <code>resume</code> is refused. Every reply now carries a <code>next</code>{' '}
                  field with the exact call to make — agents used to find the order by being
                  refused, 48 times in one lab round. Resume belongs <i>before</i> the agent
                  changes anything in the checkout; after your own first commit it still works,
                  because the run's own start checkpoint is accepted as the proof. What is still
                  refused is a run that began in a different repository, or a dirty worktree — and
                  the refusal names the way out.
                </Wall>
                <Wall
                  seen={
                    <>
                      <code>handoff_work</code> is refused and the run keeps its claims.
                    </>
                  }
                >
                  Two causes, both fail-closed on purpose. If the next steps tell the receiver to
                  create or copy a credential, rewrite them so the <em>sending</em> machine runs
                  the credential-dependent check and passes on only its non-secret result —
                  nothing in a brief may move a secret between machines. If the handoff carries a
                  branch, record a delivery or tested checkpoint for that exact commit first; a
                  handoff of intent, with no branch, needs none.
                </Wall>
                <Wall seen={<code>Only NAME on DEVICE can accept this</code>}>
                  Working as designed: work assigned by name can be accepted only by the agent it
                  names. Send the instruction to that agent, or cancel and re-assign from the
                  project page's <b>Assigned work</b> card — cancelling is shown there now, which
                  it was not when somebody first reported a cancel that had in fact worked.
                </Wall>
                <Wall seen="The agent worked and pushed, but STMA recorded nothing — no run, no claims, an empty agent map.">
                  A browser-authorized MCP connection offers an agent the tools; it does not make
                  it use them during an ordinary request, and it installs no hooks. Measured: an
                  agent found <code>whoami</code> and tried to run it as a shell command. Connect
                  that checkout with <code>stma connect</code> instead — the same installation
                  serves the agent and its hooks, and the hook opens the run whether or not the
                  model remembers to.
                </Wall>
                <Wall seen={<code>unknown_or_inactive_run</code>}>
                  Harmless: the agent closed its own run before the hook did. It is silent in
                  current builds, so seeing it means the checkout runs older hooks —{' '}
                  <code>stma adapter repair --pin-runtime --apply</code>.
                </Wall>
                <Wall
                  seen={
                    <>
                      <code>STMA outbox is full</code> or{' '}
                      <code>Outbox corruption detected</code>
                    </>
                  }
                >
                  Queued events could not be delivered. <code>stma adapter status --profile ID</code>{' '}
                  shows what is pending, then{' '}
                  <code>stma adapter repair --profile ID --apply</code>.
                </Wall>
                <Wall seen="429 responses.">
                  A rate limit. Wait a minute — and look at what the agent was repeating, because
                  this is usually a loop rather than real traffic.
                </Wall>
                <Wall
                  seen={
                    <>
                      Governance shows <code>?</code> against a run's policy receipt.
                    </>
                  }
                >
                  That means <b>not reported</b>, not drift. A run that never answered is
                  unconfirmed; only a run reporting a different hash is a deviation. The product
                  keeps the two apart on purpose, because claiming a rule was followed that nobody
                  confirmed is the worst thing a readiness report can do.
                </Wall>
              </Walls>
            </section>
          ) : null}

          <section class="doc-section" id="selfhost">
            <h2>Your own server</h2>
            <Walls>
              <Wall
                seen={
                  <>
                    <code>PGlite failed to initialize properly</code>, or{' '}
                    <code>The database in … was written by PostgreSQL 17, and this build's embedded engine is PostgreSQL 18.</code>
                  </>
                }
              >
                The embedded database's PostgreSQL major moved between releases, and a major
                version never opens an older data directory in place. Either run the release that
                last opened that directory, or move it aside and start with an empty one.{' '}
                <b>Nothing moves your data for you</b>, and there is no export/import path yet —
                that is an open decision, not a missing feature. Newer builds refuse with the
                sentence above instead of the bare PGlite error.
              </Wall>
              <Wall seen="Two machines each ran the server and cannot see each other.">
                <code>npx @matteai/stma serve</code> on each machine is two private instances, not
                a connection. Run <em>one</em> server, give it an address both machines can reach,
                and set <code>BASE_URL</code> to that address before connecting any client.{' '}
                <code>localhost</code> only works on the machine hosting it.
              </Wall>
              <Wall seen="A tool or endpoint described in the guide answers 404.">
                Usually a version gap rather than a bug: the guide ships with the server, and your
                CLI may be older or newer. <code>stma version --server</code> prints both sides,
                and <code>GET /health</code> names the build on any instance.
              </Wall>
              <Wall seen={<code>stma: command not found</code>}>
                Installing from a source checkout needs the build first — there is no{' '}
                <code>prepack</code> step, so packing without building produces a tarball with no{' '}
                <code>dist</code>. Either build first, or install the published package:{' '}
                <code>npm i -g @matteai/stma</code>.
              </Wall>
              <Wall seen="Nobody can reset a password on your instance.">
                Password reset needs email configured. Without it the recovery path is the
                operator's: an admin can reset an account from the admin console. Plan for that
                before you invite anyone.
              </Wall>
            </Walls>
          </section>

          <section class="doc-section" id="expected">
            <h2>Working as intended</h2>
            <p class="m0 sub" style="max-width:72ch">
              Each of these has been reported as a bug by somebody testing the product. They are
              deliberate, and knowing which is which saves an hour.
            </p>
            <div class="card card-pad" style="display:flex;flex-direction:column;gap:10px">
              <div class="factrow">
                <span class="y">✓</span>
                <span>
                  <em>STMA cannot wake your agent.</em> Every call is started by a client that is
                  already running. A closed agent did not ignore a handoff — it never heard about
                  it. Open the client and ask it to check its STMA inbox.
                </span>
              </div>
              <div class="factrow">
                <span class="y">✓</span>
                <span>
                  <em>A work claim is a warning, not a lock.</em> Two agents can still edit the
                  same file. STMA tells them, names who was there first, and records it.
                </span>
              </div>
              <div class="factrow">
                <span class="y">✓</span>
                <span>
                  <em>Snapshots carry variable names, not values.</em> A diff can tell you a
                  machine is missing a variable; it can never tell you what to set it to. And a
                  snapshot that reported no variable names at all is shown as{' '}
                  <b>unchecked</b>, not as everything missing.
                </span>
              </div>
              <div class="factrow">
                <span class="y">✓</span>
                <span>
                  <em>The file guard only sees one client's file tools.</em> A shell redirect, an
                  editor, <code>git apply</code> or an agent connected by MCP alone all walk past
                  it. "A rule stopped this" is evidence; "nothing got through another way" is not,
                  and the page that reports a violation says so next to the count.
                </span>
              </div>
              <div class="factrow">
                <span class="y">✓</span>
                <span>
                  <em>Revoking ends access, not the process.</em> The agent stops being able to
                  reach STMA. It keeps running, and its saved connection stays in the client until
                  somebody removes it there.
                </span>
              </div>
              <div class="factrow">
                <span class="y">✓</span>
                <span>
                  <em>A ticket or branch-name warning is advice.</em> If your workspace has a
                  delivery flow, starting a run on a branch that breaks its pattern warns and
                  never refuses. Do not rename a branch because of it; correct the flow's pattern,
                  or ignore it.
                </span>
              </div>
            </div>
          </section>

          <section class="doc-section" id="ask">
            <h2>Still stuck</h2>
            <p class="m0">
              {support ? (
                <>
                  Write to <a href={`mailto:${support}`}>{support}</a>, from the address on the
                  account.
                </>
              ) : (
                <>
                  This instance publishes no support address, so the person who runs it is the one
                  to ask. If that is you, set <code>SUPPORT_EMAIL</code> and it will appear here
                  and on the sign-in pages.
                </>
              )}{' '}
              Include the exact message, what you typed or clicked just before it, and the version
              below. Never include a password, a six-digit code, a setup code or a token: none of
              them helps answer the question, and an email is the wrong place for all four.
            </p>
            <p class="m0 small muted">
              This instance is running <b>v{VERSION}</b>. <code>GET /health</code> reports the same
              string, and <code>stma version --server</code> prints it next to your CLI's. The full
              guide is at <a href="/docs">/docs</a>; its{' '}
              <a href="/docs#troubleshooting">troubleshooting table</a> covers the MCP surface in
              more detail than this page does.
            </p>
          </section>
        </div>
      </div>
    </>
  );

  // Signed in: keep the console shell so the way back does not disappear —
  // somebody who is stuck should not also lose their navigation.
  if (user) {
    return c.html(
      <AppLayout user={user} title="Help">
        {body}
      </AppLayout>,
    );
  }

  return c.html(
    <html lang="en">
      <Head title="Help" />
      <body>
        <header class="site-head">
          <div class="container site-head-inner">
            <a class="brand" href="/">
              <Logo />
              Speak to my Agent
            </a>
            <nav class="site-nav">
              <a class="plain" href="/docs">
                Docs
              </a>
              <a class="btn btn-sm" href="/login">
                Sign in
              </a>
            </nav>
          </div>
        </header>

        <main class="container page">{body}</main>

        <footer class="site-foot">
          <div class="container site-foot-inner">
            <span>© 2026 STMA · Speak to my Agent — private beta · v{VERSION}</span>
            <span>
              <a class="plain" href="/docs" style="color:var(--mut)">
                Docs
              </a>{' '}
              ·{' '}
              <a class="plain" href="/help" style="color:var(--mut)">
                Help
              </a>{' '}
              ·{' '}
              <a class="plain" href="/terms" style="color:var(--mut)">
                Terms
              </a>{' '}
              ·{' '}
              <a class="plain" href="/privacy" style="color:var(--mut)">
                Privacy
              </a>
            </span>
          </div>
        </footer>
      </body>
    </html>,
  );
});
