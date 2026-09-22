# STMA product flows and authorization contract

This is the map of how people, coding agents, teams, projects, governance and delivery fit
together. Read it before changing authentication, onboarding, navigation, authorization, agent
identity, project selection, governance, delivery or billing. The repository's developer guide
remains authoritative for implementation and release mechanics; this file is the product-flow
contract shared by humans and coding agents.

The goal is not to describe every screen. It is to make dead ends, ambiguous ownership and scope
leaks visible before code ships.

The returned flow design is implemented using the existing console, not a separate demo runtime.
Canonical paths: workspace **Connect & test**, **Handoffs**, **Repositories**, **Delivery receipts**,
**Knowledge**, and the hosted **Evaluation** / **Organizations** surfaces. State labels describe
evidence, not optimism.

## The model in one picture

```text
Person / account
  ├─ Membership ───────────────► Team ───────────────► Project
  │    role: owner | member       │                      │
  │                               ├─ team policy         ├─ project policy additions
  │                               ├─ people/invites      ├─ snapshots/sessions/runs
  │                               ├─ announcements       └─ project delivery flow
  │                               ├─ team delivery flow
  │                               └─ scoped Knowledge Hub
  │
  ├─ Browser-approved MCP OAuth grant
  │    client + machine + personal | one team | one project
  │                         │ PKCE code exchange
  │                         ▼
  ├─ Agent credential (short access + rotating refresh, hashes stored)
  │                         │ one-to-one
  │                         ▼
  └─ Agent installation (stable agent + machine + client + visible role)
                            │
                            └─ Run ─► claims, checkpoints, policy/knowledge receipts,
                                      preflight, events, provider outcome
```

The hierarchy is deliberate: **workspace (internally `team`) → project → project-scoped
credential/installation**. A project cannot float between workspaces, and a project-scoped agent
is authorized only for the workspace/project pair embedded in its credential. A person sits beside
that hierarchy through one membership per workspace; plans belong to the workspace, not to the
person. The same person can therefore be an owner on a Team workspace and a member on a Free
workspace without acquiring a single global "user plan."

The nouns are deliberately separate:

- A **person** signs in and owns memberships, credentials and installations.
- A **seat** is a human membership counted by the hosted plan. Agents, machines, worktrees, runs
  and calls are never seats.
- A **membership** grants a person access to one team. Its role is `owner` or `member`.
- An **invite** adds a human membership. Only an owner may create or revoke one. It carries the
  role its holder joins as, `member` or `owner`, chosen where the link is made rather than where
  it is used: the person clicking it has no say in which one it is, so the join page states what an
  owner invitation grants before it is accepted, and the owner's list labels every link. An agent
  creating an invite over MCP can only create a member one.
- An **OAuth authorization grant** is browser-approved client, installation and scope state. Its
  one-use code is bound to an exact client, callback, MCP resource and PKCE challenge.
- An **agent enrollment** is the shared one-use server transition underneath OAuth and the legacy
  connector fallback. Its raw activation secret is used only by the legacy path.
- An **agent credential** is the server-enforced authority used at MCP/control boundaries. OAuth
  access is short-lived and renewed with rotating refresh grants; legacy PATs keep their historical
  until-revoked behavior. A managed deployment may impose a shorter exact lifetime.
- An **agent installation** is one durable agent identity on one machine. Its role such as
  `reviewer` or `implementer` is descriptive, not a permission.
- A **project** is the canonical team-local identity of a repository/workstream. It is normally
  born from a canonical host/owner/repository identity supplied by an agent; its display name is
  not the repository identity.
- A **run** is a leased declaration of intent and work scope by one installation.
- A **checkpoint** is an immutable client report of repository identity, commit, clean/dirty state
  and optional test results at start, delivery or tested time. It is not provider verification.
- A **knowledge item** has immutable draft/published versions and an explicit workspace or
  selected-project audience. A **knowledge context** freezes the exact versions served to a run or
  checkpoint; its receipt records client provenance, not compliance.

Do not collapse these concepts in copy, schema or counters. In particular, a token is not a seat,
an agent role is not a team role, and a selected team is not merely onboarding decoration.

These are the public-core defaults. An operator-provisioned organization adds a separate identity
and authorization boundary; see F10 below. Its service memberships are excluded from human seat
counts. Do not let coarse compatibility roles override organization/workspace permissions.

## Credential scopes

New browser authorizations default to the narrowest useful boundary. Existing pre-enrollment tokens
and legacy setup prompts remain compatible.

| Scope | Team reach | Project reach | Intended use |
| --- | --- | --- | --- |
| `project` | exactly one team | exactly one existing project | default for a repo-specific agent |
| `team` | exactly one team | all current and future projects in that team | agent that coordinates across a team |
| `personal` | every membership the owner can reach while the credential is active | all reachable projects | explicit cross-team personal fleet |

Authorization is the intersection of credential scope and the human's current membership/role:

- Removing a human from a team invalidates that person's team/project credentials immediately.
- Deleting the target team/project invalidates its scoped credentials through database cascades.
- A project credential cannot name another team/project, create a team invitation, mutate another
  installation's run or read a team GitHub integration connected to another project.
- A project credential does not use team-wide Jira enrichment because Jira connections do not yet
  carry a project mapping.
- A project credential may see the team member directory and the announcement channel. Those are
  coordination primitives, not project records. Its project-tagged announcement can reach the
  team for the same reason.
- A project credential sees only Knowledge Hub records whose selected-project audience includes
  that project. Workspace-member knowledge is not automatically exposed to project credentials.
- Owner-only operations remain owner-only at both web and MCP boundaries. A personal/team token
  does not turn a `member` into an owner.
- Explicit conflicting arguments are refused before tool dispatch. Omitted team/project arguments
  are filled from the credential so least privilege does not add repeated prompt friction.
- A bound installation cannot be renamed by a tool argument and cannot update, finish or hand off
  another installation's run. The one exception is the explicit adapter pairing below: an agent may
  act on the runs of a local adapter its owner paired with it, and on no others.

User-level configuration and server authority are different boundaries. User-level means the MCP
entry persists for that OS user and is available to the client across repositories. It never changes
the selected `project`, `team` or `personal` server grant. MCP is client-initiated: installing the
entry does not let STMA wake the client, execute local commands or read repository files. STMA sees
local data only when the client deliberately includes it in a tool call.

## Entry points and navigation

| User intent | Primary entry | Context carried forward | Successful destination |
| --- | --- | --- | --- |
| Create a workspace | `/app` | signed-in person | team overview |
| Create a project | Projects or Agent connections → New project | exact workspace + repository identity | project page or selected project access |
| Add a human | team → People or owner agent `create_invite` | exact team | joined team |
| Connect an agent | Agent connections, team overview, or project page | client-specific native setup request with stable MCP URL; browser-selected team/project | OAuth installation |
| First two-agent result | workspace → Connect & test | durable launch ID, exact scope, own account | server-observed send/reply |
| See live work | Agent map | current team/project filters | selected run inspector |
| Discuss or hand off | Sessions / `inbox` | team/project/run | durable thread or handoff queue |
| Recover a handoff | Work (`/app/handoffs`, or the project's `…/projects/<project>/work`) → session inspector | named human + accepting installation | explicit next action, no browser impersonation |
| Publish rules | team → Governance | exact team/project | effective policy + receipts |
| Define delivery | team → Delivery | exact team/project | published flow + setup pack/pipeline |
| Change plan | team → Plan | exact billable team | Checkout/Portal/current plan |
| Remove access | People, Agent connections, Agent map, Account | exact membership/token/install | revoked or deleted state |
| Get unstuck | `/help`, linked from every signed-out footer, the four password pages and the account menu | none — deliberately, the page is public | the wall named in the product's own words, with its next action |

**Every write that adds, re-roles or removes a workspace membership leaves an operator-readable
row** naming the workspace, the person, the roles on both sides, the door it came through and who
acted — separate from the team activity feed, which is the same events written for the workspace's
own members and swept by that workspace's retention. Two removals are deliberately shaped: an
account deleting itself is recorded without naming the subject, because the username is scrubbed at
that person's request and the row answers "this workspace lost a member and why" without undoing
it; and deleting a workspace removes every membership in it and leaves no row at all, because the
record lives inside that workspace and the console says so rather than implying completeness.

A team-scoped URL is authoritative. The rail must not silently switch it to the newest membership.
A project's sections are addressed under the project —
`/app/teams/<workspace>/projects/<project>/{agents,work,sessions,activity,knowledge,governance,
delivery,environments}` — and that is the form the rail and in-page links produce. The earlier
`?project=` / `?team=` filter form of the same pages must keep answering and must not be
redirected away: published links are a contract. Named in the path a project is the page's
identity, so an unknown one is a 404; named as a filter it stays a filter and the page says the
name matched nothing. A GET form that selects a project submits to the workspace address, because
a form can only write a query string.
A narrow screen keeps workspace identity and a labelled Menu button above the task; the expanded
menu retains every destination. Without JavaScript, all navigation remains visible.
A project deep link must preserve its project into the destination picker. A form must return to the
tab/page that owns it. Empty states must contain the next valid action.
**`/help` carries no scope and requires no session**, because the walls it answers first are the
ones in front of the login and a page behind it cannot reach the person standing there. Under
`SITE_MODE=teaser` it hides the same class of content the guide does — connecting and running an
agent, neither of which a signed-out stranger can have — and never hides the sign-in, self-hosting
or known-limits halves. Its table of contents may not point at a section that is not rendered. It
ends at `SUPPORT_EMAIL` where the instance has one, and says plainly that it has none where it does
not; it must never end in silence.

## F0 — First account and first team

**Actor:** a new human.

1. The person signs up with email/password, or an allowed identity provider.
2. They land in `/app`.
3. They create a team or redeem an invitation.
4. The team creator becomes its owner.
5. A one-person team overview prioritizes connecting agents and links to `/docs#quickstart`.
   “Team” is explained as a workspace, not the paid Team subscription. Other people, projects,
   governance and delivery are optional next steps, not activation prerequisites.

Success means the person has at least one membership and can name where an agent should work.

Guards and dead ends:

- Agent connections with zero memberships do not create a credential that can reach nothing. The
  page sends the person back to teams.
- Closed signup and invite-only states must explain which invitation or owner action is needed.
- **The hosted signup form says that creating an account accepts the Terms**, and links them and
  the Privacy Policy. An instance somebody else runs shows neither line and neither do its
  documents claim to bind its users: `/terms` and `/privacy` describe the hosted service, and
  where `STMA_HOSTED` is unset they carry a note saying that this server's own operator is the
  controller and its own terms apply.
- A sole owner cannot leave/delete their account while the team would be orphaned; ownership must
  be transferred or the team deleted.

## F0a — Account recovery

**Actor:** a person who cannot sign in. This flow exists only where email codes do
(`RESEND_API_KEY`, or `AUTH_2FA=1`); without a mailbox to deliver to, `/forgot` and `/reset` answer
404 and the operator escape hatch at `/admin/users` is the recovery path.

1. `/forgot` takes the address and answers **one thing regardless of outcome** — same status, same
   redirect, same body and the same `Set-Cookie`. An address with an account gets a six-digit code
   by email; one without gets a cookie naming a row that does not exist. Neither the response nor
   its headers may reveal which happened.
2. `/reset` takes that code and a new password, **in the browser that asked**, because the pending
   code's id is held in that browser's cookie and nowhere else. The pages say so.
3. Completing a reset writes the hash, ends **every browser session**, and clears the sign-in
   failure counter for that address — failing to sign in is how most people arrive here, and a
   product that says "password updated" and then "too many attempts" has contradicted itself one
   screen apart.
4. The account is emailed that its password changed, with the reset link, the Agent connections
   link and the support address.

Authorization invariants:

- **A reset proves a mailbox, not a device.** It ends browser sessions and leaves agent
  credentials, installations and pinned hooks untouched, because a password never reached one.
  Every surface that mentions it says this: a person whose account was taken over must not be told
  the incident is closed while an attacker's agent still holds workspace access.
- **Codes are single-use, ten minutes, five attempts, three sends per fifteen minutes**, stored as
  digests, and the login and reset challenges use separate cookies filtered by purpose, so one
  flow's code can never complete the other.
- **Every password check costs the same**, whether or not the address has an account. A handler
  that skips the hash on a miss answers by timing what the copy refuses to answer.
- **Every door that takes a password enforces the same lock.** The per-account throttle, the
  "somebody is guessing" email and the second factor belong to the password, not to the sign-in
  form. There are four such doors and they share **one** counter, so five guesses is five guesses
  across all of them rather than five at each: the sign-in form, `/api/invites/redeem`, and the
  two on `/app/account` that ask for the current password before changing it or moving the
  address. The last two matter although they sit behind a session, because `/app/*` carries no
  per-IP limit at all and what the password still buys there is permanence — lock the owner out,
  or redirect every future reset.
- **An emailed code never reaches the operator log.** Each code email puts its six digits in the
  subject on purpose, so the log line carries a stable `kind` (`login_code`, `password_reset_code`,
  …) and never the subject. A second factor readable by whoever can read the logs is not one, and
  the same rule governs every screen an operator sees.
- **A mail outage is visible to the operator even though it is invisible to the person.** `/forgot`
  must answer the same thing whether or not the send succeeded, so the neutral answer is a
  deliberate dead end for the reader — which makes it the operator's job to notice. Sending never
  throws, so it never reaches the error log; the operator console carries its own record instead,
  with the provider's own words and no subject line.
- **A neutral answer still has to leave somewhere to go.** Because no response here may say what
  happened, the *page* is where the honest "and if that did not work" belongs. All four password
  pages — sign in, signup, forgot, reset — link `/help#signin` before the support address, and the
  link renders whether or not the instance has an address. `SUPPORT_EMAIL` follows the rule it
  always did and renders only when set.

## F0b — Proving and correcting the address, and ending a session

**Actor:** the account's owner, signed in. Everything here lives on `/app/account`.

1. **Signup mails a confirmation code and does not block on it.** `users.email_verified_at` stays
   null until somebody enters that code, and **every signed-in page says so** until it is entered,
   not only `/app/account` — the console band is what makes not blocking defensible, because a page
   nobody opens is not a notice. A gate would turn a mail-provider outage into "nobody can sign
   up"; the window this closes is the month-long session the person already holds, in which they
   can confirm or correct the address unaided. The signup mail stays unawaited and its failure is
   silent *to the person*, who is signed in and reading that band, and loud to the operator, who is
   the one who can fix it.
2. **Changing the address mails the code to the NEW one**, and requires the current password. The
   account moves only when that code is entered, and the address being left behind is told, because
   losing the recovery channel is how an account is quietly taken over.
3. **Sessions are listed with the browser, the address they last arrived from and when**, one of
   them marked as the one being read. Each can be ended, and "sign out everywhere" ends all of them
   including the current one.

Authorization invariants:

- **A session id is never rendered.** The id IS the cookie value, so a list of ids would print every
  other browser's live credential into the HTML of this one. Rows are named by a digest, resolved
  against this user's own sessions on the way back in.
- **A password proves the right to redirect recovery.** Changing the address needs it for the same
  reason changing the password does: a borrowed session must not be able to move where the account's
  codes go.
- **An address arrives confirmed only by a code that reached it.** Nothing else sets
  `email_verified_at`, and a migration does not assert it for rows that predate the column. A
  confirmation code counts only beside the address it was mailed to, and every other writer of the
  address — an operator setting it, GitHub moving it — leaves it unconfirmed.
- **An operator is proved, not typed.** `/admin` opens for a listed username the account already
  held, or for a listed address the account has confirmed. Signing up with a listed address, or as
  a listed name, or with a GitHub login that differs from one only in case, makes nobody an
  operator: a new account is never given a listed name.
- **Session facts die with the session.** The browser string, the address and the last-seen time are
  the session's own data, shown only to its owner, and swept with the row on expiry.

Still open, deliberately:

- **A reset does not end agent access**, because a forgotten password is not always a compromise and
  revoking every teammate's agent would be its own outage. The pages and both emails say so plainly
  and link to Agent connections; the alternative remains a decision, not an oversight.
- **A code still belongs to the browser that asked.** The reset mail carries a link that makes the
  device reading it into that browser, which covers the case that mattered; looking the code up by
  address instead would put an address field back on an unauthenticated page.

## F1 — Invite and join a human

**Actor:** an owner, then the invited human. An agent may carry the instructions but never owns the
membership.

### Browser path

1. Owner opens Team → People and creates a revocable, expiring invitation.
2. Invitee opens `/join/:code`, signs in or signs up, reviews the team and joins.
3. One transaction checks expiry, use limit, hosted human limit and duplicate membership.
4. The invitee lands on that team.
5. The new member creates their own agent connection; the inviter's credential is never shared.

### Agent-assisted invitation

1. An owner's agent calls `create_invite` and returns the invitation block.
2. The invitee pastes it into their agent, sees the origin/workspace and approves opening the link.
3. Sign-in and membership consent happen in the browser. The agent never collects a password or
   MFA code, generates a credential helper or installs MCP as a side effect of human membership.
4. After observed membership confirmation, the new member creates their own project-scoped
   connection through the versioned Connector flow above.

Success means one confirmed human membership. Agent installation and client confirmation remain
separate outcomes. The backwards-compatible terminal redemption API remains available for existing
integrations, but the generated invitation no longer routes end users through it.

Guards and dead ends:

- Web and MCP invite creation are owner-only.
- An expired, revoked, exhausted or capacity-blocked invitation writes no partial membership.
- A losing concurrent redemption does not leave an empty account behind.
- If terminal agent activation fails after membership commits, the invite may already be consumed;
  do not blindly retry. Sign in with that account, confirm membership and create a fresh scoped agent
  prompt from Agent connections.
- The generated instruction has browser fallback for passwordless accounts and interactive-login
  constraints.

## F2 — Connect an existing member's agent

### Terminal path (Claude Code or Codex checkout)

**Actor:** a signed-in member at a terminal inside one Git checkout. No model takes part.

1. On Agent connections the member names the agent and machine, picks **one project** and
   creates a connect command. The enrollment code is shown once, stored hash-only, single-use and
   expires after ten minutes. A workspace-wide or personal choice is refused: the hooks belong to
   one checkout.
2. `stma connect CODE --server ORIGIN` refuses, before anything is spent, a directory that is not
   the checkout root, a missing Claude Code CLI, an existing local profile or MCP entry, and a
   checkout that cannot take the pinned runtime.
3. It asks `POST /api/agent-enrollments/preview`, which **does not consume** the code, and prints
   server, workspace, owner, project, agent, machine, checkout path and exactly what it will add.
   It then requires `y` at an interactive terminal. Without a TTY it stops with the code unused.
   A person handed a stranger's command therefore sees whose workspace their agent would join.
4. Redemption (`via: terminal`) mints one project-scoped credential bound to one installation.
   For Claude Code the CLI runs the client's own `claude mcp add --scope local`. Codex's CLI cannot
   take a static header, so the CLI appends one uniquely named table to the user `config.toml`
   (append-only, parsed before and after, owner-only on POSIX) and **refuses a second entry for
   the same endpoint**: Codex loads that file in every checkout, so two entries would be two
   identities in one session. Codex hooks still need the human's `/hooks` trust. The CLI keeps the same bearer protected
   for the OS user under `~/.stma` (DPAPI on Windows), pins the hook runtime and installs ignored
   project-local hooks. **The agent and its hooks are one installation**: assigned work reaches
   the prompt hook, a stopped edit names the agent, and the run the hook opens is one the agent
   may update. There is nothing to pair.
5. Setup authority is bounded exactly like every enrollment: fifteen minutes until the real client
   initializes. The CLI reports *confirmed* only when a route that stays closed during pending
   setup answers; `claude mcp get` makes the real Claude binary initialize at once, while Codex
   confirms when the human next starts it. For this path a successful MCP `initialize` from the configured client is the
   confirmation; the legacy model-run installer still needs its explicit `whoami`.
6. Any failure after redemption rolls back the hooks and the MCP entry and self-revokes the
   credential, reporting whether revocation was confirmed.

**Invariants.** The code is never placed in a prompt and the page says not to paste it into an
agent. The command refuses a second entry for the same server and names any other `/mcp` entry
the checkout will load; the prompt hook names the entry its calls belong to, because two STMA
servers in one session are two identities. The hook announces an assignment once per client
session, not once per checkout, so a restarted session hears it again; one already accepted is
announced as already accepted. Preview discloses nothing a holder of the 160-bit code could not learn by redeeming it.
The bearer sits in the client's own configuration in plain text; that is the accepted cost of
skipping OAuth, bounded by project-only scope and one-click revocation.

### OAuth path (any client)

**Actor:** a signed-in team member and one coding-agent client.

1. The person opens Agent connections directly or follows a team/project “Connect agent” link.
2. If the project does not exist, a workspace owner creates it from the inline New project bar;
   successful creation returns with that project available for authorization.
3. They add the fixed `{BASE_URL}/mcp` Streamable HTTP endpoint in their coding client. There is no
   per-agent URL, setup envelope, bearer value or model-executed installer.
4. The client discovers protected-resource and authorization-server metadata, dynamically registers
   an exact callback and starts Authorization Code + PKCE S256 with the exact MCP resource indicator.
5. STMA opens in the human's browser. After sign-in, the page names the requesting client and return
   host. The client type is displayed read-only from its registered OAuth metadata; a form value
   cannot relabel a Codex callback as Claude. The person names the agent and machine, chooses
   descriptive role and `project`, `team` or explicit `personal` access, then allows or denies.
   No authorization code is issued before allow.
6. The one-use authorization code is stored only as a hash and bound to client, callback, resource,
   scope and PKCE challenge. The token endpoint atomically consumes it and creates one durable
   installation plus one credential family.
7. The client receives a one-hour access token and rotating refresh token and stores them using its
   own credential mechanism. Secrets never appear in STMA HTML, prompts, terminal commands,
   repository files or logs. A refresh rotates access and refresh values together.
8. The first successful authenticated MCP `initialize` confirms OAuth client loading within the
   existing 15-minute setup window and updates last-seen state before its response is released.
   Legacy connector credentials still require `whoami`. Confirmation is idempotent and cannot revive
   expired or revoked access. After reload, `whoami` verifies the visible identity and scope; project
   connections also read effective policy.
9. Reusing an already-rotated refresh token is treated as theft/replay: STMA revokes the entire
   credential family, disables the linked installation and releases its active runs/claims.
10. OAuth revocation and the console Revoke action disable the same token/installation boundary.
    Client-local removal remains a separate client action; server revocation cannot stop a process.
11. This connection grants MCP access only. Local runtime, git hooks, collision guard and file guard
    require a separately packaged and visibly approved adapter. OAuth success is never described as
    repository readiness or local enforcement.

Success means the client can call `whoami` and the reported username, unique installation, scope,
team/project and endpoint match the browser approval. No model handled a credential or raw config
content. A setup request may invoke the client's supported MCP command; browser authority stays human.

Guards and dead ends:

- Agent connections leads with a copy-ready Codex or Claude Code request. It may invoke only that
  client's built-in MCP add/login command. It contains no token, enrollment code, downloaded helper,
  raw config edit or hook installation. Codex uses a readable scope-specific alias, so one project's
  entry does not replace another; Codex keeps it in user configuration, so one machine has one Codex
  identity per scope. Claude Code stores a login under the server name and a repeated login under
  that name revokes the earlier one, so its request derives a per-checkout name (folder plus a short
  Git hash of the root path) and adds it at local scope, which attaches to the repository root:
  each clone or worktree is its own agent, and one request can be pasted into every Claude agent.
  Presence is checked with output suppressed; an existing exact name stops for review. Claude also
  stops if the older machine-wide scope alias would load beside the checkout entry, and never
  removes it. Other names are not inspected or removed. Codex uses the OAuth flow started by Add
  or an explicit Login, never both. Claude's direct command is capability-checked before config is
  changed, and its login fallback runs inside the checkout. The person, never the agent, approves
  STMA's browser consent.
- One browser approval is for exactly one agent in one checkout on one machine. Another checkout,
  client or machine repeats OAuth against the same MCP URL and receives a different installation id.
  The consent client type comes from the product part of the registered client name, never from a
  folder name inside the server name.
- Redirect URIs must match registration exactly; non-loopback callbacks require HTTPS. Authorization
  codes expire after five minutes and cannot be replayed. Access is audience-bound to exact `/mcp`.
- Unknown/revoked tokens and expired access return a Bearer challenge pointing to the protected
  resource metadata so the client can authenticate or refresh using the standard flow.
- Empty or port-zero `BASE_URL` values cannot generate blank activation URLs in local/test mode.
- Revoking either the credential or its bound installation disables both sides of the connection.
- Server revocation does not edit local client configuration or stop its process. Full disconnect
  also removes the local MCP entry and reloads the client.
- OAuth machine endpoints do not rely on browser cookies and are exempt from browser-form origin
  checks; the human consent POST remains same-origin protected and revalidates every hidden field.
- Legacy Connector v2 and direct token creation remain compatibility paths. The connector is closed
  under **Legacy setup prompt**; direct token creation is not presented in the UI and stays personal.

## F3 — Solo, multiple agents, multiple machines

**Actor:** one human; any number of separately connected agents and devices.

### Minimum activation path: two computers, one reply

1. One reachable server URL, one account, one workspace. **New workspace** needs only a name.
2. Open **Connect & test** and start/resume a durable launch for this human, exact scope and intent.
   Its ID survives reloads and is not a credential.
3. Each client is separately authorized against the same `/mcp` address through F2. Use distinct
   names/device labels and the same scope; no invitation to oneself or duplicated account.
4. The launch exposes two short, secret-free prompts. They carry only the launch ID and send/reply
   action; they do not install MCP, mutate configuration or contain credentials.
5. First agent: `whoami`, then `launch_check {launch_id, action:"send"}`. The server creates one
   greeting atomically; repeated calls cannot duplicate it.
6. Second agent: `whoami`, then `launch_check {launch_id, action:"reply"}`. Its authenticated
   installation must differ. My-agents launches require the same human; teammate launches still
   require current membership and an intersecting credential scope.
7. The page checks progress for at most two minutes while visible, then pauses. No third agent
   prompt is required. Use Refresh status to resume. Raw credentials never appear in the launch URL.

**Success:** a real cross-installation greeting/reply, with one human and no project, repository
write, snapshot, run, policy or invitation required. Cloud Free supports this two-device path;
being a solo user does not require the paid Solo or Team plan. The endpoint/username/installation
check in F2 proves connection, not message delivery or autonomous agent wake-up.

**Guards:** two separate localhost instances cannot communicate. Self-hosters need one secured
address reachable from both machines and matching `BASE_URL` before authorization. A stopped agent
is not woken remotely: the user invokes the receiving agent. Personal access means cross-membership,
not “solo”; team scope is sufficient here. Existing project-only connections keep their exact
project scope; the guide must never suggest broadening access to make the check pass. Launch-check
prompts contain no credential. Legacy connector envelopes remain distinct single-use secrets.

### Expand only when needed

For scoped repository work and multiple roles:

```text
Human
  ├─ laptop / implementer / project A credential
  ├─ laptop / reviewer    / project A credential
  ├─ desktop / generalist / team credential
  └─ CI or cross-team personal connection only when deliberately needed
```

Each box is a separate connection. Two agents on one laptop are separate installations because
they can hold different runs, roles and scopes. One agent copied to two machines is also two
installations because snapshots, unread origin and revocation must distinguish them.

Native lifecycle hooks mirror that boundary locally: each connection owns a profile under
`.stma/profiles/<id>/`, including adapter configuration, state, outbox event files and locks.
Installing, repairing or disconnecting one profile must preserve unrelated client hooks and other
profiles. Events are durably enqueued before delivery and replay with stable IDs; a full or corrupt
outbox is visible rather than silently discarded. Legacy checkout-wide files are copied into the
matching profile without deleting the source.
One profile per client per checkout is enforced; two same-client profiles would both consume every
hook and corrupt attribution. Actual reported session and child-agent IDs distinguish conversations;
missing session identity is unavailable, never silently merged. Do not infer a device or subagent ID.
Inbox cursors belong to credentials, separately from the browser. PostgreSQL timestamp precision is
preserved when marking the last actually returned message read; a later message stays unread.

The Agent map groups installations under their human owner. Snapshots use the human-chosen machine
label, not an inferred hostname. Messages written on one installation remain unread to another
installation and to the browser; “same account” does not mean “already seen.”

That label is also what hosted Cloud Free's device ceiling counts: the distinct labels one person
pushed snapshots under in the last 30 days, at most two. A `push_snapshot` from a third is refused
before anything is stored or a project is created, and the reply names the two that count. A device
that already counts is never refused by the ceiling. A device stops counting 30 days after its last snapshot, so a
replaced machine frees its slot on its own; nothing needs to be deleted. Connections are never limited
by machine, and self-hosted instances, paid plans, an active Team evaluation and the private beta
count nothing. A count that would add a device is taken again under the workspace lock, so two new
machines cannot both take the last slot.

Parallel work uses separate runs. Deliberate parallel attempts require an explicit shared
`attempt_group`, the same owner and distinct worktrees. Same task alone does not suppress overlap;
two agents in the same worktree still collide. Lease expiry means coverage is lost, not proof of safety.

## F4 — Project creation and project-scoped work

**Actor:** a workspace owner through the console, or a member's agent through a repository-aware
tool call.

1. Before connecting a project-scoped agent, an owner may create the project from **Projects** or
   the inline **New project** bar on **Agent connections**. A repository URL or owner/repository
   identifier is preferred; successful creation returns to the calling page and selects the project.
2. Alternatively, the agent obtains the canonical repository identifier from the origin remote.
3. Manual creation and `push_snapshot`, `open_session` or `start_run` call the same resolver.
4. Equivalent URL, case and `.git` variants collapse to one host/owner/repository identity. Two
   repositories with the same basename under different owners remain distinct; the display name
   gains a deterministic suffix when needed.
5. The project page now offers project-filtered views and a preselected project connection link.
6. A project credential omits repeated team/project arguments; the server injects its target.
7. Writes made with that credential resolve the embedded durable project ID, not the injected
   display name. Manual URL creation followed by an omitted `repo`/`project` therefore remains one
   project across snapshots, sessions, runs, policy and baselines.
8. Delivery's project picker submits that durable ID as well. Name/slug inputs from older clients
   resolve an existing project before lazy creation, so a repository-backed project and its flow
   cannot split into two visually identical scopes. Azure Apply then resolves the one explicit
   project/repository binding; ambiguity or no binding fails closed. `assign_work` and a
   `handoff_work` made without a run resolve the project they name the same way: the display
   name of a repository-bound project is that project, never a new name-only sibling beside it.
9. Console scope pickers, project links, policy editing and baseline promotion also submit the
   durable ID. If historical repository-bound and legacy rows share a display name, the UI labels
   them separately; a promoted snapshot defaults to the project ID already stored on that snapshot.

Success means snapshots, sessions, runs, governance, environment comparisons and delivery all use
the same project id.

Guards and dead ends:

- A newly created sibling project triggers a split warning: a typo can partition conflict
  detection and history.
- Legacy projects without provable repository identity are not silently merged into a newly
  identified repository; their existing evidence keeps its original scope.
- Manual creation is owner-only, length-bounded and plan-limited. Other browser forms still choose
  existing projects instead of silently creating one from a typo.
- Cross-project environment comparison is refused.
- A project credential cannot create or discover siblings through tool arguments or direct object
  ids; a missing or deleted embedded project fails closed instead of falling back to lazy creation.

## F5 — Run, governance and collision control

**Actor:** a connected agent; humans publish rules and decide approvals.

1. Before editing, the agent calls `start_run` with task/intent, branch and planned claims. A fresh
   caller-generated `request_id` names this logical start; unchanged retries return the same run,
   including the exact frozen Knowledge envelope, while changed input under that ID is refused.
2. STMA binds the run to the authenticated installation and resolves team/project from its grant.
3. The response includes conflicts, possible duplicate work, the effective policy and its hash,
   delivery-flow advice, approval needs and change-budget warnings. These are explicitly advisory;
   the server does not claim to have prevented a local edit.
4. The agent reads/applies the policy and acknowledges the served hash with `update_run`.
5. Heartbeats renew the lease without silently dropping omitted claims. Planned claims and scope
   observed later from the dirty worktree are retained separately. Environment preflight and
   measured usage can update the run. Active work uses a short stale window; an explicit
   `waiting` or `blocked` heartbeat extends both presence and claims through a longer human-response
   window. This does not require a model to keep running in the background while its user decides.
6. Start, heartbeat and finish may append retry-safe immutable checkpoints. `finish_run` releases
   claims and records the outcome; a concurrent late heartbeat cannot reopen a terminal run or
   revive its lease. Webhooks may later link exact PR/CI facts.

Claims warn; they do not lock. A collision is a fact about two runs, but it is not told to both
the same way: the run that declared the ground first and has held it since keeps the **right of
way**. Its conflict carries `rightOfWay: "yours"`, its advice is to carry on and finish, and the
file guard keeps allowing its edits; the run that declared the same ground later is the one told
to wait, narrow or coordinate, and the one the guard refuses. Restating scope keeps the first
declaration; ground dropped and declared again starts over. Where neither side is provably first
both are treated as the later one. Before this, two agents on one file each stopped for the other
and a run could halt another's edits by declaring its file.

A collision also says **what the holding run is doing and how long it holds the ground for**: the
conflict carries `theirState` and `theirLeaseEndsAt`, and one sentence built from them appears in
the tool reply, in the write guard's refusal, in the hook's explanation and in the agent map's
inspector. A run that stopped to ask a person holds its claims for the longer human-response
window and will not free them by itself, so it is named as such and the advice stops saying wait:
the way through is the other person, not another attempt. Without this an agent could only guess
how long to wait, and it guessed from its own lease. **Both halves can be true of one heartbeat**,
because two runs reaching for the same files in a different order leave each of them first on
some of the ground, and then one collision has to say two opposite things. It says them as two
sentences that each name their own files, and both the tool reply and the local hook build them
from the same function: before that they were written separately and named no ground at all, so
one agent was told "narrow what you touch, or coordinate" by the tool and "you were first, carry
on" by its hook in the same minute. The ground the hook reports as a run's own is what the
checkout has actually changed, whole: a path read out of `git status` keeps every character of
its name, or the run holds ground nobody else can collide with. Governance receipts attest what was served/read; silence is “not
reported,” never a match. A run whose checkout has the local hooks installed files its own receipt
at run start, recomputing the hash from the policy document it received rather than repeating the
number the server sent; it writes nothing into the repository, because saying which rules a run is
under is not the same act as installing them in the repository's rules file. Agent-reported quota/cost estimates are labelled estimates and do not
drive measured automation.

The console has three scopes and the chrome says which one a page is in. The **scope bar** above
every page names the workspace and, inside one, the project; both are pickers, and the person's own
pages sit behind their name at its right. The **rail** lists the sections of that scope and nothing
else: an account page (the workspace list, account, notifications, the person's own connections,
the guide) lists the workspaces and what still spans them; a workspace page lists the workspace's
sections, its rules for every project and its settings; inside a project the rail is that
project's — Overview, Agents, Work, Sessions, Activity, and the rules in effect there — and its
first line is the way back to the workspace. A page is inside a project when its address says so:
in its path, or as the `project` filter of a workspace page or of the agent map, Work and Sessions
lists, which take `team` and `project` and keep them on every link they draw. Rail badges count
what their link opens. Integrations is offered in the rail to owners only, as on the page.

**Agents are found where they work.** Inside a project, **Agents** lists the agents whose
credential can work there — bound to that project, or reaching the whole workspace; one bound to
another project is not listed, because the server would refuse it — with what each is doing now,
the unfinished work given to it and what it last finished there. **Connecting happens on that
page**: the same form the account's Agent connections page carries, with the project taken from
the address rather than offered as a choice, and its one-time command is shown on that page. A
refused request comes back to it with everything that was typed still in the fields. The project
and the workspace come from the address and the member's own proved membership, so nothing a
browser posts can move the grant to another project. The account's connections page is unchanged
and still lists, revokes and pairs every connection.

In the workspace, **People and agents** groups the same rows by person, and a person's name opens
their own page: their role and when they joined, their agents and what each is doing, their live
and recent runs, the assignments and handoffs they sent or were given, and a page of their trail.
Every card links to the page that owns the fact — the agent map for a run, the thread for a brief,
Activity for the log — and the page derives none of them itself. Any member may read it about any
other member, which is the boundary the team directory and the agent map already draw; a username
that is not a member of that workspace is the same 404 as one that does not exist. These pages
read; only the project's connect form writes, and a local adapter is never listed as an agent.

**Their sessions are the sessions list, narrowed.** The threads card on a person's page is a slice
of `/app/sessions?person=‹username›` — one reader, one definition, the same rows in the same order
— rather than a second query that could answer differently from the page it links to. The filter
answers **opened or wrote in**, and a message one of their agents posted counts, because every MCP
write carries the owning human as its author. Two kinds of thread stay out: dispatched work, which
is work rather than conversation and is listed once, as work; and the workspace's announcements
channel, which is created by whoever first triggered it and belongs to nobody. The filter needs a
workspace to name a membership in, and answers the same 404 for a name that is not a member here,
for a name that is nobody, and for a request that names no workspace at all.

**Rules are defined in the workspace and added to in a project, and the page says which is
which.** Policy, Knowledge and Delivery each reach a project two ways. Inside a project:
Governance files every rule in effect under *from the workspace* or *this project only* (a runtime
the project replaces and a budget it tightens name what they replaced); Knowledge lists the records
that reach that project, labelled the same way, and counts without listing the records addressed
to other projects; Delivery names the one flow in effect and whether it is the project's own or the
workspace default. An owner is offered **Add for this project only** there, and the workspace's own
rules are edited from the workspace. On the workspace's pages every rulebook, record and flow says
who it applies to: every project, or the projects named. A project can add a rule or tighten one
and never remove one: that is the merge agents are already served, and origin is derived on read
from the two published documents, never stored. A write made inside a project returns inside it.
The project's own page sums the three up on one card, **Rules in effect here**.

**The way back.** An action returns to the page it was started on, in the scope it was started
in, and says what happened there. A connection started from a project's Agents page shows its
command on a page that is still that project's, and a refused request returns to the same scope
rather than to the account's list. A result is said once: the address parameter that carried the
band is removed as soon as the page has drawn it, so a refresh, a bookmark or a pasted link does
not announce again something that happened earlier; selection and filters (`run`, `scope`,
`project`, `team`, `tab`, `flow`) are address state and stay. What was typed is not lost either: a
policy publish that is refused (a malformed `content:` line, an empty rulebook, a plan limit) hands
the editor back with every field as typed, in the scope it was typed for, with the reason above
the fields, and writes nothing. Somebody who is not an owner has no editor and is sent to the
governance page with the reason. There is no agent map, work list or
sessions list that mixes every workspace any more: **All workspaces** lists each workspace with
what is working now, the work still open and the unread sessions, each number a link into that
workspace's own page. The old addresses still answer.

The line above every page title is a trail whose steps are links: workspace, then the section,
then the record, with the page itself last and not a link. The scope graph is capped in width, not
in height, so it grows with a wide screen instead of shrinking. Savings is no longer a rail
destination; its page still answers its address.

Console navigation keeps these evidence levels visible: Governance groups are collapsed by
default with count-bearing deep links, Activity filters are URL state and carry into CSV, and
Needs attention links only to a still-live exact run. If that run expires before inspection, Agent
map says the target is gone and does not silently select another agent. Notification delivery is
a personal setting, not an inbox destination. Agent inventory is the map's Identities tab and
sorts active identities first, then newest seen within each state. The scope graph above the
ledger is a second rendering of the claims and conflicts the ledger already shows, never a second
evaluation of them: run and scope selection, and the critical-only filter, are URL state, and the
status strip keeps counting the whole workspace while the map is filtered.

## F6 — Sessions, announcements and handoff

The opt-in Claude Code/Codex file guard uses a synchronous PreToolUse decision. The server verifies
installation/run ownership, current membership and project, canonical repository/worktree, policy,
overlap and stale ground under a workspace-scoped transaction advisory lock. Only allowed edits
reserve scope. Start and heartbeat claim publications use the same lock. This is not a filesystem
mutex, arbitrary-shell parser or remote-command gateway. Offline/unknown file checks deny; normal
MCP readiness remains advisory. Protected-path decisions require an owner policy/workflow change;
a chat "yes" is not a server approval receipt. There is no general approval-token bypass API.
Stop leaves guarded work waiting, SessionEnd closes it, and inactive leases expire. Each work
completion/handoff should close its own run without closing another installation's run.

**Actor:** people and their agents across time, machines and vendors.

- Debug sessions are project-aware durable conversations. Peer message bodies and attachments are
  untrusted data, never executable instructions.
- Announcements are a team-wide coordination channel. CI/webhooks and project agents may publish
  project-tagged announcements there.
- **A thread message is conversation.** `open_session`, `post_message` and the browser form write
  `question`, `answer`, `hypothesis`, `info-request`, `resolution` or `note`; a `handoff` is written
  only by `handoff_work` or `assign_work` and an announcement only by `announce`, so no message can
  make a thread read as work waiting in somebody's inbox, outside the handoff allowance and its
  checks. What a teammate typed reaches another agent's prompt hook quoted and on one line, and a
  desktop notification as data, never as script.
- `inbox` separates unread conversations from pending handoffs. For an agent a brief is never an
  unread reply — it is work, and the handoff queue carries it — and a thread that carries
  dispatched work counts as unread only for the agents it involves: the one it names, the one that
  accepted it, and whoever wrote in it. Other agents in the project are not told that somebody
  else's assignment has "unread replies". A browser reads threads as threads and is unaffected.
- `handoff_work` may name the receiving **agent** (`to_agent`, resolved exactly like `assign_work`,
  with `to`/`device` to disambiguate): the handoff then carries `target_installation_id`, only
  that installation can accept, resume or complete it, `/api/agent/news` sends it only there, and
  the prompt hook announces it as handed over by name — the sender chose, so the receiving human is
  told, not asked. Without `to_agent` it is offered to a person (`to`) or the team as before.
- A resume that comes after the receiver's first commit is still provable. HEAD has moved, so
  what it observes can never match the handed-over commit again; where the same repository and a
  clean worktree are reported and only the commit differs, the immutable start checkpoint of the
  receiving run (the one named by `run_id`, else the installation's only live run in the project)
  is accepted as the proof, and the reply says `basis: "receiving_run_start"`. A run that began
  elsewhere, another repository or a dirty worktree is refused as before. The accept reply of a
  handoff that carries code says the resume belongs before the first change.
- A hook-owned run is one branch: when the checkout switches branches, the hooks close that run
  and start another on the new branch, so a handoff received on a different branch resumes from
  a run whose start checkpoint is the handed-over commit. The write guard refuses `stale_ground`
  only until the run re-declares the claim after the report; the `update_run` report itself keeps
  naming what moved.
- `handoff_work` writes a structured resume block derived from the run, releases its claims and
  closes it. A branch handoff must reference an immutable delivery/tested checkpoint recorded on
  that run, either earlier or atomically in the handoff call; otherwise it is refused and the run
  keeps its claims. Code normally moves through git; submitted messages and attachments may contain code.
- A caller-generated `request_id` makes creation retry-safe per credential. Reusing it with changed
  arguments is refused. Offer, brief, quota count, run close/scope release and direct-notification
  queue commit atomically; provider comments and team webhooks are best-effort after commit.
- `update_handoff` explicitly moves `offered → accepted → in_progress → completed`, with
  `declined`, `cancelled` and `needs_attention` exits. Every successful reply carries `next`, the
  exact call that moves the work on and what it must carry, and a call made out of order is
  refused with the call that is missing (`complete` before `resume` names `resume`). Repository
  verification is one report of three fields: where a checkpoint needs it an incomplete report is
  refused and the missing field named; where there is nothing to verify, as in an assignment, it
  is answered with a `verificationNote` instead of a refusal. A `run_id` that names a run which is
  no longer live is refused with the agent's own live run in that project named, and `update_run`
  answers the same way rather than only offering `start_run`: the usual reason to be holding a
  dead run id is that the hooks replaced the run a minute ago on a branch switch, and "start a new
  one" turns that into two live runs in one project, which is the one state in which a resume can
  no longer tell which run is doing the work. Acceptance is serialized to one installation;
  replay is idempotent. A reply or session resolution does not close a tracked handoff.
  Released ground stays on the record as `released`: it holds nobody up and no heartbeat renews
  it, the agent map draws it faded, the evidence pack still lists it, and an agent that began
  before the release is told the ground moved, whether or not the releasing run has ended. On
  accept or resume a run nobody named takes the name of the work.
  Reporting work `completed` frees the ground the completing installation's run held: a guarded
  Stop keeps claims for the waiting lease so a human can approve something, but completed work
  holds nothing, or the next agent sent to the same file is stopped by a collision with no work
  behind it. The run stays live and its next guarded edit or declared scope holds ground again.
  It applies when that installation has exactly one live run in the project, or names it with
  `run_id`; a retry of `complete` releases nothing.
- A **Denied** policy line shaped `content: "text" in path/** — reason` is also evaluated by the
  local file guard, after the server has cleared the path, against the text the edit would *add*.
  A match denies the tool call locally and reports to `POST /api/agent/runs/:id/policy-violations`
  only the rule — which must be one the run's current effective policy publishes — and the
  checkout-relative path. The content never leaves the machine and the endpoint has no field for
  it. Reports are recorded when they change (same run, rule and path within ten minutes is one
  moment), attributed to the reporting installation — shown beside the agent it is paired with,
  "via its adapter", when it is a paired local adapter — under Governance → Policy violations
  and written to the activity feed. The literal is case-insensitive and never a pattern.
  When a run the hooks own ends, the checkout is read once against the same rules and anything
  found there is recorded as **in the checkout** rather than **stopped**: an edit the guard refused
  is a rule working, and content that is in the branch anyway is a rule being broken. The scan
  covers what that run added, commits and working tree together, including files no tool touched.
  Content still never leaves the machine — a report carries the rule's published words and a path
  and has no field for anything else. It is not proof that nothing landed: one checkout, at the end
  of one run, and an agent connected over MCP only has no hook to run either half.
- **Assign work** can take the task from a connected tracker. With one connected, the dialog grows
  a **Ticket** field, and which tracker a reference belongs to is read off its shape: `#42`,
  `owner/repo#42` and a github.com issue URL are GitHub, `PROJ-42` is Jira, a ClickUp link or
  `clickup:` prefix is ClickUp. A reference fills whatever the lead left
  empty. The tracker's own key becomes the task, so the run, the ledger line and the ticket say one
  thing, and the summary plus the link go into the brief, which is what the receiving agent is
  given to read. A brief the lead did write keeps its first line, because that line becomes the run
  intent. Shape is decided before connection, so a reference to a tracker that is not connected is
  refused as what it is rather than as nonsense, and the help names only the shapes this project
  can actually read. A tracker that refuses is named in the band: `start_run` lets a tracker
  failure pass in silence so a run never dies because Jira blinked, but here a person typed the
  reference and is waiting to see the ticket's own words. Nothing is dispatched by any refusal.
- **The lead can pick the ticket instead of going to find its key.** Beside the **Ticket** field,
  each browsable tracker connected to the project offers a **Browse** link; it is a link, so the
  selection survives a refresh, the back button undoes it and the list needs no script. Drawing
  the project page still fetches nothing — the list is read only when somebody clicks for it — and
  it is bounded to the twenty most recently updated open tickets, which the page says in words so
  a short list is not mistaken for everything. Choosing one fills the **Ticket** field with a
  reference the paste path already understands and marks the chosen row, so a pick and a paste end
  in the same place: the form is read by the same handler, which fetches the ticket again and
  builds the same task and brief. A tracker that refuses is named where the list would have been,
  never answered with an empty list. A refused assignment carries the reference back into the
  field.
- **And the lead can type a few words instead of scrolling a list.** Beside the field a search
  box asks the same tracker for tickets matching what was typed; with more than one browsable
  tracker connected it also names which one it is asking. It is the same link-shaped selection
  (`?pick=<tracker>&q=<words>`) reached by a GET form of its own inside the dialog, so a search
  survives a refresh, the back button undoes it, choosing a result keeps it, and no script is
  involved. Drawing the page still fetches nothing: a search is read on the search.
  **The line under the results says what was actually looked at**, because the two trackers do
  not reach the same distance. GitHub has a search endpoint, so GitHub searches every open
  issue in the connected repository and STMA bounds only the twenty rows it draws. ClickUp's
  API has no text parameter for tasks at any endpoint, so STMA reads the three hundred most
  recently updated open tasks of the mapped List and matches them in its own process; a task
  older than that window is reachable by pasting its link, and the page says so rather than
  leaving it to be discovered. What a person typed is words, never a query: punctuation a
  provider would read as syntax is dropped before the call, so a typed `:` or leading `-`
  cannot become a qualifier, a negation or a refused request. Nothing matched and nothing is
  open are different answers and are said differently. A tracker that refuses a search is
  named where its rows would have been, exactly as when browsing.
  **Browsing and searching are GitHub and ClickUp only**: Jira keeps the paste field and the
  dialog says it can be neither browsed nor searched here yet, because Atlassian moved issue
  search to a newer endpoint that STMA has not measured against a real site and a guessed call
  would fail on the lead's critical path rather than in a test.
- `assign_work` (and **Assign work** on the project page) is the other direction: a member names
  one connected agent as `list_teammates` lists it and dispatches a task to it. **Any member may
  dispatch, and any member may read the whole People and agents roster.** Neither path reads a
  role: the browser one resolves with `teamForUser` and the MCP one through `resolveTeam`, both
  membership-only, and `agentRoster` takes no viewer at all. That is deliberate and it is the
  product's position rather than an oversight, because a lead who is not an owner has to be able
  to hand work out; restricting it would put the human back in the middle of the flow this exists
  to remove. It is worth reading twice before adding somebody to a workspace, since policy,
  delivery, baseline and project creation sitting beside it are owner-only, so the boundary is
  not where the neighbouring writes would suggest. A role between owner and member is open work,
  not a promise. The record is a
  handoff of kind `assignment` addressed to that installation, not only to its owner. Only the
  named installation may accept, resume or complete it; its owner may decline; the sender may
  cancel. Other agents' inboxes list it as assigned to somebody else, and `/api/agent/news` — the
  prompt-hook nudge — delivers it only to the named installation and to a local adapter **paired**
  with it (below) whose reach includes the assignment's project; adapter consent is project-only,
  so an adapter hears assignments in its own project and not one filed elsewhere or in no project.
  With neither on that machine, the human there asks the agent once to read its inbox;
  `assign_work` answers `hookWillAnnounce` for the project it was given, and the project page's
  "adapter paired" label answers for that page. The project is named as the console shows it —
  name, slug, repository or id — and the existing project is always the one used; only a
  spelling that names no project creates one, and the answer then carries `projectNote`. The
  project page's form files under the project on screen, whose URL is its slug, and answers on that
  page: a band names the task and the agent it went to, and **Assigned work** lists what was
  dispatched there with its state and, for the sender, **Cancel**. Cancelling answers where it was
  pressed and says the named agent will not be told. A thread that carries an assignment or a
  handoff is dispatched work, not an open session: cancelling or completing the work leaves the
  thread open, so counted as one it never closed. Its page links back to the project. An assignment finishes no run and
  releases no claim; it carries no source checkpoint, and the receiving agent's own `start_run`,
  pre-filled in the resume block, is where scope, policy and collisions apply. Steps that direct
  the receiver to obtain, copy or use a credential are refused before anything is written. A
  web-created and an MCP-created assignment are the same record.
- **Adapter pairing.** A checkout-local adapter is its own installation, never the MCP agent's. Its
  owner may pair it with one of their own agents (`agent_installations.companion_of`): on the
  adapter's OAuth consent screen, which asks **Listens for** with no default, or later on Agent
  connections, per row. Invariants: only an installation issued to the first-party local-adapter
  OAuth client may listen (a `companion` field on any other client's consent is ignored); the
  agent must belong to the same user, be live, be credential-bound, not itself be an adapter, and
  have reach that overlaps the adapter's (personal, the same workspace, or the same project); many
  adapters may name one agent, an adapter names at most one, and no chain can form. A consent-time
  choice is re-checked at token exchange and dropped — not fatal — if it no longer holds. A refused
  choice re-renders the consent form with the entries kept; it never strands the waiting CLI.
  Effects, all of them about who is *told* and *named*: `/api/agent/news` treats the adapter and
  its agent as one seat (assignments to the agent are delivered, the agent's own briefs are not
  read back, and unread is counted with the agent's read cursor because an adapter never opens a
  thread); adapters, paired or not, are excluded from `list_teammates` and the Assign work picker,
  which mark the agent `adapterPaired`; Governance and the run timeline show the agent's name
  with "via its adapter" and keep the reporting adapter's name visible. The pairing shown is the
  current one, resolved on read like every other name. **One authority moves, in one direction:**
  the named agent may `update_run`, `finish_run`, `handoff_work` and `check_environment` on runs
  owned by an adapter that listens for it, because the hooks start the run under the adapter's
  installation and tell that agent to reuse its `run_id`. It is read per call from the stored
  pairing, so unpairing or re-pointing an adapter refuses the agent from its next call, with no
  grandfathering, and never moves the run's recorded installation. A *named* `run_id` may therefore
  be a paired adapter's; an *omitted* one still resolves only to a run the credential started
  itself, because one agent identity may be paired with an adapter in every checkout on a machine.
  With no run of its own the agent is told which run its hooks own, never to start another.
  Nothing else moves: the adapter cannot accept, resume or complete the assignment it announces,
  cannot act on the agent's own runs (the column lives on the adapter and points at the agent, so
  the edge has no reverse), and reaches no team or project the credential's own scope does not
  already allow — scope is checked first. Another agent of the same owner, another adapter of the
  same owner and another person's agent are all refused, and the refusal names pairing as the way
  out. Revoking the agent leaves a
  dead pairing the connections page flags; revoking the adapter ends it.
- The delivery/test checkpoint travels as an immutable reference for code handoffs. Resume succeeds only
  when the receiver reports the same canonical repository and exact commit from a clean worktree;
  mismatch or local changes keep the handoff out of progress. Branchless intent handoffs have no
  repository checkpoint because there is no code to transfer. No checkout command is generated from a peer-supplied branch. Structured peer
  data is not execution authority.
- A source-only credential is never copied, disclosed or recreated on the receiver. The source
  machine runs the secret-dependent validation and passes only a non-secret outcome through the brief.
- A handoff carries a Knowledge Hub context/version reference rather than copying its body. Resume
  re-resolves current knowledge through the receiver's current grant, reports version changes and
  never mutates the sender's historical manifest. For a Knowledge-linked resume, the accepting
  installation must name its own active run with an immutable start checkpoint at the observed
  checkout, or — when that run began elsewhere, as on a stale copy of the branch — whose newest
  clean checkpoint is exactly the observed repository and commit; the new context is bound to the
  run and to the checkpoint that proved it. An exact resume replay returns that recorded context, including after the receiving
  run becomes terminal, instead of resolving a later publication.
- Directed-handoff notifications are claimed through a database lease. Transient delivery failure
  retries with bounded backoff up to three total attempts; routine notices remain one-shot, and a
  retry cannot create a second handoff.
- Revoked recipients or removed memberships render as needing attention; sender cancellation and a
  new offer are the explicit reassignment path. Access revocation does not kill a local process.
- Legacy briefs remain labelled legacy; they are not backfilled as completed.

Azure DevOps `build.complete` is only a wake-up hint. A binding-scoped hook or owner read-back uses
the stored connection to fetch the build, then stores a fact only when build ID, repository ID,
commit SHA and time validate. Hook-claimed result, SHA and URL are ignored. `partiallySucceeded`
is failure; incomplete outcomes remain unknown. One build is not reconciliation of required
policies, reviews or environment approvals.

## F6a — Knowledge Hub context across runs

**Actor:** agents may propose; workspace owners publish; authorized agents and members retrieve.

1. An owner or agent writes native Markdown/structured text, or explicitly uploads one selected
   UTF-8 text/Markdown file. The server does not crawl a repository, follow symlinks or fetch URLs.
2. Every proposal is an immutable draft. Drafts are absent from current retrieval; an agent
   credential cannot publish merely because it created the proposal.
3. An owner reviews and publishes with a compare-and-swap expectation. Publishing a new version
   supersedes the previous current version without rewriting history. Archive and withdraw remove
   it from current retrieval; expiry does the same without declaring the text false. A missing
   review date renders freshness as `unknown`, not `current`. Publish/archive/withdraw cross the
   critical audit seam. A different audience on the same stable key does not silently move an active
   publication: the persistent conflict names the opposing version and reason until an owner
   explicitly archives or withdraws the current item. An owner can also declare an explicit opposing
   published version while drafting; an unresolved live conflict cannot publish.
4. Retrieval applies tenant, membership, credential and audience predicates in the SQL query, for
   search totals/snippets as well as direct IDs. Workspace audience is not a shortcut around a
   project credential's boundary.
5. `get_knowledge_context` first prefers records whose imported source path overlaps the run's
   planned path claims, then applies deterministic lexical ranking. It returns no more than 8 KiB,
   records the selected paths/reasons and makes budget omissions visible. Run/checkpoint linkage
   freezes the manifest, response envelope and resolver version.
6. Applying context does not report it automatically. The client explicitly calls
   `report_knowledge_receipt` or runs
   `stma knowledge receipt --context UUID --manifest SHA256`. Its first report for that context is
   immutable: a wrong hash remains retained mismatch evidence and returns HTTP 409 (or an explicit
   MCP error), and a later retry cannot replace it. “Server served” and “client reported” remain
   separate; neither is behavioral attestation, approval or permission to execute commands embedded
   in the text.

7. A current stable key or item ID reads the current record. An exact authorized historical version
   ID reads that immutable version with an availability label; current audience access is always
   rechecked. Owners see bounded history, line diffs, source checked/changed/reviewed timestamps and
   unresolved conflict diagnostics.
8. Explicit owner deletion crosses the critical audit seam and scrubs body, title, source, audience
   and retained context-response copies. Stable tombstone IDs, hashes, manifests and receipts remain
   for immutable evidence; deleted active content releases hosted corpus capacity. Text already sent
   to an external client cannot be recalled.

Hosted writes also check separately configurable content-byte, draft, published-record and version
guardrails. Exceeding one returns current/limit capacity and keeps old history; these engineering
defaults are not package entitlements and are not applied to self-hosted instances.

No current result means no authorized current match, not an invitation to use an inaccessible,
expired or withdrawn version. Exact historical access remains subject to current authorization.

## F7 — Governance-aware delivery setup

Downloaded packs register a deterministic schema-v2 setup identity binding workspace/project,
flow version/hash, execution mode and optional effective-policy hash. `record_delivery_receipt`
accepts compact schema-v2 JSON only for the issued scope and current published flow/policy.
Plan-only reports cannot claim writes or implementation completion. A receipt remains an assertion;
it is never human approval, provider verification or permission to deploy. Previews alone do not
register receipts. User-triggered GitHub workflow readback is available from Repositories.

Repository connections and exact project bindings are separate. Multiple connections never pick an
arbitrary default. Project-scoped tools resolve an exact binding; only an unambiguous single legacy
connection may use the documented name-matching fallback. Provider observations include repository ID,
commit SHA, event/subject identity, attempt and observed time. Replays and stale attempts do not replace
newer facts. The evidence pack attaches provider results only to the newest immutable delivery/test
checkpoint with the same bound repository and exact commit. Mutable run head and legacy branch linkage
cannot make a new commit green. One workflow success is not all required checks. A new commit needs
fresh observations.

Evidence schema v2 preserves `ok/attention/unknown`, adding provenance, subject, coverage, observation
time and limitations. A matching reported policy hash is not compliance; a completed run is not
verified delivery. Unknown history is never turned green. MCP and the inspector share one evaluator.

The Needs attention page composes bounded handoffs, recorded overlaps and missing/hash-drift receipts;
its review links do not approve anything. New launch cohorts are durable and sequential. Historical
feature-use totals remain independent retained-window counts, not a funnel.

**Actor:** an owner defines/publishes; a coding agent may implement a generated setup pack.

1. Owner chooses the exact team/project target and answers the delivery wizard.
2. A blueprint produces one flow document: triggers, environments, checks, review strength,
   tracker and deploy commands.
3. Readiness names every scaffold/missing field. A scaffold cannot masquerade as a complete
   pipeline.
4. Publishing serializes per team/project scope and archives the previous active flow.
5. The owner may connect a provider for direct apply, or download an English agent setup pack.
6. For an agent pack, the owner chooses `plan-only` or approval-gated `propose-then-apply` and
   chooses whether the effective policy for that exact scope is embedded.
7. The agent performs read-only auth preflight, asks the user for interactive login/consent, keeps
   secrets out of files/chat, proposes repository/provider writes and returns a structured receipt.

Governance injection belongs here because the setup changes a repository/provider. The basic agent
connection prompt does not carry arbitrary policy text; it only verifies identity/scope and, for a
project credential, fetches the current effective policy from the server.

## F8 — Hosted plan and billing lifecycle

**Actor:** a team owner and the hosted operator composition.

The public deterministic core knows entitlements and self-hosting remains unmetered. Hosted billing
is composed through the private operator layer; core code must not import it.

1. Owner opens the current team's Plan page.
2. Checkout creates the first Solo/Team subscription. A one-human workspace may buy Team before
   inviting the second human; current membership is not a purchase prerequisite. Team entitlement
   then permits the documented 2–50-human collaboration range.
3. In-app changes own plan/interval/seat arithmetic; signed webhooks are authoritative.
4. Membership changes synchronize billed human quantity. Agents/devices never affect quantity.
5. Portal handles supported billing-account operations. Enterprise remains contract-scoped; copy
   must not promise an unimplemented identity/audit/residency feature.
6. An operator may **give** a workspace Solo, Team or Enterprise, with no end date or through a last
   day. This is entitlement state, not billing state, so it lives in the core beside the workspace's
   own plan and never writes it. While it lasts it decides every limit, whatever the workspace's own
   plan or a subscription says; the Plan page marks it current, labels it complimentary with its
   last day, and offers no checkout or plan change, while keeping the portal for a subscription
   that predates it. It ends by the clock: nothing is written then, the workspace is on its own plan
   again — including how long its history is kept — and checkout returns. An evaluation cannot be
   started while one runs. Every give, change and revoke is in the operator's ceiling history; the
   operator's note is shown to the operator only.

Failure must leave the current entitlement intact and say that no charge was made when Checkout did
not start. Billing state never belongs in the public package or public database migrations.

## F9 — Revocation, removal and deletion

| Action | Authority | Required effect |
| --- | --- | --- |
| Revoke pending enrollment | owning human | code can never activate |
| Revoke agent credential | owning human | bound installation and its active claims stop |
| Disable installation | owning human | bound credential is revoked; active runs become stale |
| Remove member | team owner | membership ends; scoped tokens fail auth immediately |
| Leave team | member/non-sole owner | same access loss; team data remains attributed |
| Delete project/team | authorized owner | scoped credentials cascade; content follows deletion contract |
| Delete account | account owner, if invariants permit | browser sessions/tokens/installations/memberships removed; retained authored content scrubbed |
| Pause a tracker integration | workspace owner | STMA stops calling that provider for the workspace — reads and writes — while the credential and every project mapping are kept; the owner's own connection test is the one call that still goes out |
| Remove one project mapping | workspace owner | that project resolves no tracker; the connection and the other mappings are untouched |
| Disconnect a tracker integration | workspace owner | encrypted credential and every mapping deleted, without needing the decryption key; the owner is told where to revoke the app at the provider |

Every destructive screen must name scope and consequence before confirmation. Revocation cannot be
undone by re-registering the same fingerprint or replaying an enrollment. Server-side revocation
does not erase a credential-bearing local MCP entry, stop the local process or reload the client;
the responsible human must perform that local cleanup to disconnect fully.

## F10 — Operator-provisioned organization identity

**Distribution:** hosted organization-security capability only; absent from the public server.
**Prerequisite:** operator provisioning and a configured, tested OIDC provider, not merely an
Enterprise plan. Engineering can use a test tenant; a paying customer is not a prerequisite.

1. An authorized operator creates an organization with its own domain. An owner verifies the
   DNS TXT challenge and provisions exact immutable IdP identities. Email equality alone never
   links an existing account: first linking requires both its STMA session and the assigned IdP.
2. The owner explicitly attaches a workspace only after provisioning its existing members.
   Organizations do not absorb a person's unrelated memberships. Legacy personal PATs cannot
   reach an attached workspace; new scoped agent prompts require the organization's authority.
3. Validate OIDC sign-in before enforcing SSO. PKCE, state, browser binding, nonce, issuer,
   audience and signature are validated. Existing links pin issuer and subject-claim mapping.
   The request includes `openid email profile`; Entra `oid` depends on `profile`, while email is
   never promoted into the immutable authorization key.
   Changed IdP mappings need an owner-authorized reset and fresh linking, not email auto-linking.
4. Organization roles and workspace roles are distinct. Workspace admin/operator may use broad
   collaboration; policy publisher, auditor and billing admin have narrow surfaces. A project
   operator uses the organization page and exact assigned-project enrollment, not a broad console.
   Identity admins cannot assign or change privileged workspace roles; organization owners can.
5. SSO enforcement protects managed workspace web/API/MCP access, aggregate reads and enrollment.
   Ordinary password sessions keep personal workspaces usable but cannot enter an SSO workspace.
   Agent credentials are independently scoped, versioned, expiring grants; they never confer
   human billing/identity administration or permission for future unreviewed MCP tools.
6. After enforced SSO, rotate a dedicated expiring SCIM token and provision **Users**. Only the
   documented equality filters and active/displayName PATCH operations are supported; Groups,
   PUT, arbitrary role changes and privileged-user deprovisioning are not supported.
7. Deactivation removes access only in that organization, revokes credentials, unused enrollment
   codes and SSO proofs, and releases STMA run leases. It does not kill a local OS process.
   Reactivation does not revive tokens or workspace memberships; explicit reassignment is needed.
   It removes the membership in **every** attached workspace, and unlike the console and the
   operator area it does **not** refuse when that takes a workspace's last owner: deprovisioning a
   leaver must succeed, and an organization owner can reassign an ownerless workspace while a
   terminated person holding a live credential cannot be undone by anybody. Each removal is
   recorded per workspace under one group, carrying the role it removed — which is what
   reassignment needs — and marked when it left no owner behind.
8. Service identities use explicit project grants and their own one-time prompts, no browser
   login and no human seat. Policy/role changes require fresh enrollment instead of upgrading
   already issued credentials. The final active organization owner cannot be removed.

Organization audit exports cover identity/admin events only. The export's stated coverage is
derived from the actions the server actually writes rather than listed separately, so it can
neither over- nor under-claim; membership changes are deliberately outside it and belong to the
operator's own record. Optional signatures and a hash chain
do not establish complete action coverage, legal hold or protection from a compromised operator.
Provider-tenant acceptance and deployed recovery/deprovision testing remain release gates. SAML,
SCIM Groups, data-residency promises and HA/SLA are not supplied by this foundation.

## Returned-design recovery contracts

- Connect & test resumes the same launch. Its primary first/second-agent prompts contain only the
  durable launch ID and exactly one `launch_check` send/reply action. Existing connected agents use
  them directly. A closed legacy fallback may combine an enrollment with that same bounded action;
  reissue revokes the old unused code and reload never reveals its secret again.
- A browser may cancel its sender's handoff or decline an offer addressed to its human. It cannot
  accept/resume/complete as an installation. A resolved chat is not a completed handoff.
- Repository connection, exact project binding and provider evidence are separate. Moving a
  binding is owner-only with a stale-form check; existing observations keep original project
  scope. Recheck reads an exact run, never triggers a build/approval/deployment. Errors retain input.
- Blueprint scope/version/hash are the last rendered selection; preview again after changing
  options. The download endpoint computes the manifest from submitted options. Plan-only forbids
  writes; propose-then-apply requires human approval. Neither choice bypasses effective governance.
- Receipts retain their original manifest and show reports beside exact provider facts. Invalid or
  stale reports preserve the entered JSON but are not saved as accepted receipts. Historical
  reports never assert that today's flow, policy, required checks or approvals are unchanged.
- Evaluation is 14 days, 3 humans, 1 project, once **per account**, no card/automatic charge.
  Expiry retains data, reads, revocation and completion of existing work. Team still starts at 2 humans.
- Run and checkpoint retries retain their original logical operation. A terminal run cannot be
  revived by a late heartbeat, and a reused request ID with changed facts is an error. Retrying an
  unchanged logical run start returns its original frozen Knowledge envelope rather than resolving
  whatever happens to be current at retry time.
- Knowledge context manifests remain immutable. Handoff resume may produce a new receiver context
  and a version diff, but it never rewrites which versions the sender was served.

## Flow-to-test matrix

| Contract | Primary regression coverage |
| --- | --- |
| browser sign-up/team/invite/token/MCP | `packages/server/test/e2e.test.ts` |
| one-use enrollment + project/team enforcement | `packages/server/test/scoped-enrollment.test.ts` |
| terminal connect: ten-minute project-only command, non-consuming preview, initialize confirms, legacy path unchanged | `packages/server/test/terminal-connect.test.ts` |
| one human, two enrollments, first reply on Cloud Free + quick-start entry points | `packages/server/test/quick-start.test.ts` |
| persistent launch replay, lifecycle acceptance, exact provider facts, receipt scope, encryption rotation and concurrent project/policy writes | `packages/server/test/product-readiness.test.ts` |
| generated setup prompt and URL correctness | `packages/server/test/findings-2026-08-25.test.ts` |
| account/team removal and destructive invariants | `packages/server/test/account-hygiene.test.ts` |
| personal multi-machine snapshots | `packages/server/test/personal-fleet.test.ts` |
| Cloud Free device ceiling: third label refused before a project exists, counted label accepted, 30-day window, second count before storing, paid and self-host uncounted, beta ledger counts it | `packages/server/test/plans.test.ts`, `packages/server/test/beta-access.test.ts` |
| real two-device stop/approve/handoff behavior | `examples/payments-api`, human-run acceptance required |
| MCP run/claims/policy lifecycle | `packages/server/test/mcp-fleet.test.ts` |
| idempotent run/checkpoint lifecycle and terminal races | `packages/server/test/run-reliability.test.ts` |
| exact checkpoint handoff + Knowledge context/receipt integration | `packages/server/test/checkpoint-knowledge-integration.test.ts` |
| Knowledge draft/publish/lifecycle, ACL and bounded retrieval | `packages/server/test/knowledge.test.ts` |
| profile-local adapters, locks, replay, migration and repair | `packages/server/test/adapters.test.ts` |
| leased notification ownership and bounded critical retry | `packages/server/test/notifications.test.ts` |
| live agent identity and conflict map | `packages/server/test/live-fleet.test.ts` |
| unread origin and handoff queues | `packages/server/test/personal-inbox.test.ts`, `packages/server/test/news.test.ts` |
| named-agent assignments: name resolution, installation addressing, lifecycle enforcement, hook wording, browser form; the named project (display name, repository, id, a same-named legacy sibling, a new name, project pages by slug); adapter pairing at consent and on Agent connections, the paired hook hearing only its own project, picker exclusion, violation attribution, the 0041 backfill | `packages/server/test/assignments.test.ts` |
| content rules: grammar, added-text extraction, browser publish, unpublished-rule refusal, governance evidence; shipped runtime stops a real edit | `packages/server/test/content-rules.test.ts`, `packages/server/test/multi-device-topology.test.ts` |
| project policy/preflight receipts | `packages/server/test/governance.test.ts`, `packages/server/test/readiness-e2e.test.ts` |
| delivery wizard/render/apply/setup packs | `packages/server/test/delivery.test.ts` |
| tracker integrations: GitHub issue gating, ClickUp OAuth connect/map/pause/disconnect, both ClickUp id spaces on the wire, a mapping whose project is gone, one-attempt comment delivery and its replay safety, and nothing of a token, title or body reaching the activity feed or its CSV | `packages/server/test/integrations.test.ts` |
| core/private/public packaging boundary | `packages/server/test/layers.test.ts` |

## Change protocol for humans and agents

Before changing a flow:

1. Name the actor, entry point, target team/project and credential scope.
2. Trace both the happy path and every rejection path through UI, API/MCP and database state.
3. Check direct identifiers (`session_id`, `run_id`, `installation_id`) as well as friendly names;
   name-based guards alone are not an authorization boundary.
4. Check concurrent/replayed requests. Invitations, enrollment redemption and active-flow publish
   require atomic invariants.
5. Check the zero state, expired state, revoked state, removed-member state and deleted-target state.
6. Keep secrets out of prompts, URLs, logs, repositories, HTML after activation and test fixtures.
   Operational logs may correlate authenticated installation, enforced scope, record IDs and
   lifecycle states; they must not copy session/task bodies, enrollment codes or credentials.
7. Add/update one end-to-end regression and this map when the state machine changes.
8. Update README, ROADMAP, in-app docs and `CLAUDE.md` in the same change.
9. Run typecheck, all core tests, build, private-layer tests/build when present, and the public-tree
   export/secret scan before release.

Review questions:

- Can this action succeed but leave the user nowhere useful to go?
- Can a selected team/project be lost on redirect, tab change or copied URL?
- Can a member perform an owner action through another transport?
- Can a scoped token reach another target by omitting a field or supplying a direct id?
- Can two machines overwrite one identity, snapshot or unread cursor?
- Can one prompt/token silently become two installations?
- Can pasting a prompt be mistaken for consent to a network request or persistent user-level change?
- Can an existing `stma` entry be replaced without a separate, redacted disclosure and approval?
- Does user-level cross-repository availability stay distinct from the enforced server grant?
- Can an agent treat peer text or generated Markdown as authority the user did not grant?
- Can a scaffold, estimate, absent receipt or missing integration be displayed as success?
- Can a client-reported checkpoint or Knowledge receipt be displayed as provider evidence,
  compliance or human approval?
- Does revocation stop all linked paths, including REST, MCP and active runs?
- Does the copy promise a feature or entitlement the implementation does not provide?

## Known boundaries, not hidden promises

- Existing direct-created PATs are personal compatibility credentials. The current UI creates
  one-use scoped enrollments; removing the compatibility path requires a separately versioned API
  migration.
- Setup prompts are reviewed consent envelopes, not unattended installers. Operations remain visible
  with only secrets redacted; the client initiates every MCP call, and STMA cannot wake it or inspect
  local files by itself.
- Jira is team-connected and has no project mapping, so project credentials deliberately receive no
  Jira ticket enrichment.
- ClickUp is connected by a workspace owner through ClickUp OAuth. A connection alone grants no
  agent-visible task target: each STMA project must be mapped to one exact ClickUp List. Project
  credentials resolve only their fixed project's mapping; a team/personal credential must name a
  project unless exactly one binding exists — and a mapping counts only while its STMA project
  still exists, so a mapping left pointing at a deleted project resolves to nothing rather than
  becoming the workspace's implicit one. `start_run.clickup_task` accepts either of ClickUp's id
  spaces — the native id or the workspace's own `PD-207` custom id, decided by shape — verifies the
  returned task is still inside that List, and records `clickup:<native-id>`: the native id is what
  ClickUp guarantees, while a custom prefix is a per-space setting an administrator can change, and
  a task key is read back long after it was written. The provider token never enters MCP output.
  Finish/handoff comments are **one attempt**, best effort after STMA's own durable event, and do
  not roll it back; STMA's own retries never repeat one, because every terminal call is idempotent
  by request id and a replay skips the tracker entirely. An owner may **pause** a connection: every
  mapping and the credential are kept and STMA makes no ClickUp call for that workspace — reads and
  writes both — until it is resumed, and the owner's own connection test is the one call that still
  goes out, because it is how they decide whether to resume. Disconnect deletes the encrypted local
  token and every mapping; the owner is also told where to revoke the OAuth app in ClickUp.
  Connecting, disconnecting and changing what a connection may touch are recorded in the workspace's
  critical audit as `integration_connected`, `integration_disconnected` and
  `integration_scope_changed`, whose subject is the provider and its locator — never the credential,
  and never a task, list or message.
- Announcements and the member directory are team-level coordination surfaces visible to project
  credentials; other project data is filtered.
- CI/headless service identities use the operator-provisioned lifecycle in F10; a copied human
  credential is not a service identity. The public core alone does not supply that lifecycle.
- Enterprise identity, audit export and residency controls are not implied until their signed scope,
  code, acceptance tests and operational runbooks exist.
- Knowledge Hub v1 is workspace/project scoped, lexical and explicitly authored/imported. It does
  not provide organization-wide publication, connectors, OCR, semantic retrieval, automatic chat
  ingestion or a guarantee that published reference text is true or followed. Hosted corpus
  guardrails bound an unpriced service surface; they do not define customer-plan capacity.
