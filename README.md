# STMA — Speak to my Agent

**AgentOps for teams that build with coding agents.**

STMA is the operations layer between the coding agents your team runs — Claude Code, Codex, Cursor,
any MCP client — and the people responsible for what they do: a live map of every agent run, a
warning before two agents touch the same file, the team's rules delivered to every run, work
assigned to a named agent or handed over before a usage limit ends a session, environment snapshots
that carry names and never values, and an evidence pack a reviewer can check.

It works the same for one person with a laptop and a desktop as for several people on a project.

## Start here: just me, two computers

1. **Use one STMA server and one account.** Sign in to your existing deployment. On **Workspaces**,
   choose **New workspace** and name it **My workspace**, or use the workspace you already have.
   A “team” is a workspace — it can contain just you. Only its name is required.
2. **Connect your first agent.** For a Claude Code or Codex checkout the fastest way is one terminal
   command: on the project's own **Agents** page (or on **Agent connections**, where you choose the
   project yourself), fill in **Fastest · one terminal command**,
   press **Create connect command** and paste the result into a terminal opened in that checkout
   (`npx -y @matteai/stma connect CODE --server …`). It shows the workspace and project, asks
   `y/N`, then adds the checkout's MCP entry and its local hooks as **one** identity: no browser
   consent, no login step, nothing to pair. Paste it into a terminal, not into the agent: the
   code is a one-use, ten-minute secret, and a careful agent refuses to redeem one. Codex gets one
   STMA identity per machine, because it loads its user configuration in every checkout. For
   any other client use OAuth (published: `@matteai/stma@0.14.0`). If Claude Code already has
   another STMA entry at user scope, the command says so and the hook names the entry its calls
   belong to; remove or scope the other one so the agent cannot mix identities. For
   any other client use OAuth: open **Agent connections**, choose the client and copy its setup
   request into that agent. The request tells the agent to use only Codex or Claude Code's built-in
   MCP command for the displayed address; it contains no credential or installer. Complete the one
   native OAuth flow the client starts. STMA opens in your browser; sign in,
   name the agent `laptop-agent` and machine `laptop`, choose the exact workspace/project, and
   approve. Reload the client once so the running task loads the new tools. The client owns
   credential storage and refresh. No enrollment code, bearer token,
   downloaded installer or hand-edited config is carried through the model conversation.
3. **Connect your other agent.** Copy the matching setup request into the client on the second computer and
   authorize `desktop-agent` / `desktop` separately against the same workspace/project. STMA creates
   a unique installation identity and revocation boundary for each approval. Never copy a token or
   client configuration between machines; there is no need for a second human account. Several
   Claude Code agents on one machine work too: each Git checkout connects as its own agent, so paste
   the same Claude request into each.
4. **See the reply.** Ask the second agent to call `whoami`, read the STMA inbox and reply; ask the
   first agent to check. Authenticated installation origins survive reloads. This proves an exchange,
   not completed work or physical devices. The older one-time setup prompt remains a compatibility
   fallback for clients that cannot complete OAuth, not the recommended path.
5. **Give it work from anywhere.** On the project page choose **Assign work**, pick
   `desktop-agent` and say what to do — or tell `laptop-agent`: "assign the filter change to
   desktop-agent through STMA". The desktop agent finds it in its inbox as assigned to it by name;
   on that machine you say one sentence — "read your STMA inbox and do what is assigned to you" —
   instead of typing the task again. (If that checkout also runs the local adapter and you paired
   it with `desktop-agent` — on the adapter's approval screen, or later under **Agent connections →
   Listens for** — its prompt hook announces the assignment by itself and nobody says anything.)

No repository setup, CLI, project creation, governance or paid Team subscription is needed for
this message check. Cloud Free covers it (connecting agents is never limited by machine) and the
paid Solo plan is optional. “Personal”
credential access means **every workspace this account can reach while the credential is active**,
not “I work alone”; one workspace's **Entire workspace** access is enough and includes its current
and future projects. Existing project-only agents should stay on the same project.

**One shared address matters.** Two separate `localhost` servers cannot see each other. To
self-host, [start one instance](#try-it-in-one-command), make it reachable at a secured HTTPS
address from both machines, and set `BASE_URL` to that address before connecting clients. Keep
development servers private. The hosted service is a private beta: creating an account needs an
access code, and everything is switched on for the accounts that have one. Without a code, use
your existing account, ask the instance owner, or self-host — the self-host path needs no
invitation and is not a reduced product.

STMA does not wake a sleeping agent. MCP is client-initiated: the server cannot start local commands
or inspect repository files, and receives local data only when the client chooses to send it in a
tool call. Ask the second agent to read and reply, then ask the first to check. After that first
result, add repository context, other people or work tracking only when needed. The
[in-app guide](https://stma.ai/docs#quickstart) explains each optional next step; use
`/docs#quickstart` on your own deployment for its correct MCP address.

## Beyond the first reply

The console calls teams **workspaces**; API fields and `/app/teams/...` URLs stay compatible.
The hierarchy is **workspace → project → scoped agent connection**: every project belongs to one
workspace, and a project-only connection is accepted only for that exact pair. Where the client
keeps its MCP entry (Codex user configuration, a Claude Code checkout) decides which local tasks
load it, never the server-side project grant. Plans also belong to workspaces, not accounts; one person can have
different roles in several workspaces on different plans.
**Needs attention** collects bounded handoffs, overlap events and missing policy reports.
Management tools live under **Manage workspace**. A handoff needs explicit `update_handoff`
accept/resume/complete actions; a chat reply cannot silently clear it.

Evidence distinguishes agent reports from provider observations. Policy hash matching does not
prove compliance, and `completed` does not prove CI passed. Delivery `.md` downloads carry immutable
schema-v2 setup IDs; `record_delivery_receipt` validates scope, mode and hashes but never treats an
agent report as human approval. Repositories supports exact project bindings and read-only GitHub
workflow verification. Single-workflow success is not all required checks.

Run readiness is advisory: approvals, change budgets, duplicate work and overlapping claims are
warnings an agent and its human must act on, not a technical lock. Immutable `start`, `delivery` and
`tested` checkpoints bind a client-reported repository identity and commit to a run. Provider facts
turn green only when they match the newest delivery/test checkpoint exactly; a clean checkpoint is
still a client report, not permission to merge or deploy.

Provider credentials require reversible storage. Self-host operators can configure
`STMA_INTEGRATION_KEYS` (JSON key-version to 64-hex-character key) and
`STMA_INTEGRATION_ACTIVE_KEY` for AES-256-GCM encryption with workspace/provider/locator binding.
Keep keys outside the database. Without configuration, legacy self-host storage remains plaintext;
set `STMA_INTEGRATION_REQUIRE_ENCRYPTION=1` to refuse unencrypted new writes. Rotation reads old
versions while writing the active version. For PostgreSQL, run
`npx tsx scripts/rotate-integration-secrets.ts` for a read-only dry run. Applying requires `--apply`
and `--confirm-database=<exact name>`, a backup, and all old key versions. No credentials are printed.

Activity/event age limits and row caps differ from snapshot/session retention. “No age expiry”
is not unlimited history. User-submitted messages/attachments may contain code or secrets; the
snapshot collector's omission of values is not a guarantee about all submitted content.

STMA (Speak to my Agent) is a vendor-neutral control plane for a company's coding agents. MCP is
one transport surface; the product layer answers the operational questions MCP does not: which
human owns an agent, what project and task it is working on, which files/contracts it may touch,
which global rules it actually received, and whether its environment is safe to work in.

The identity, onboarding, scope, governance, delivery and offboarding state machines are mapped in
[PRODUCT_FLOWS.md](PRODUCT_FLOWS.md). It is the change checklist for avoiding dead ends and
cross-scope drift.

- **Environment snapshots** — agents push structured snapshots (tool versions, lockfile hashes,
  env var *names*, git state). Secret values are never collected. Snapshots are stored **per
  machine**, so one person's laptop and desktop each keep their own slot and history.
- **Automatic env diff** — one tool call compares two environments and reports the differences
  that usually explain "works on my machine" — a teammate's machine, or **your own two
  machines** (personal fleet: `compare_env` with `device` + `their_device`).
- **Debug sessions** — topic-based rooms where agents exchange typed messages (question,
  hypothesis, info-request, resolution) asynchronously, with humans in the loop.
- **Plain MCP over HTTP** — works with any MCP-capable agent (Claude Code, Cursor, ...). No local
  daemon, no NAT issues; everything is persisted server-side so teammates never need to be online
  at the same time. Calls originate from the client: STMA cannot wake an agent, execute a local
  command or read repository files by itself.
- **Live Agent Map** — active runs are attributed to a human, client, team, project, task, branch
  and leased work scope. Overlapping writes are surfaced before agents silently invalidate each
  other's work.
- **Canonical policy control plane** — team and project policy is merged deterministically,
  fingerprinted, acknowledged by each run, and compiled locally to `AGENTS.md`, `CLAUDE.md`, or a
  Cursor rule.
- **Environment preflight** — a project baseline is compared with the agent machine before work;
  only environment variable names are collected, never values. Names come from the machine and
  from the repository's *local* dotenv files; committed templates like `.env.example` are skipped,
  because a file that is identical everywhere can only mask the key that differs. A snapshot that
  reports no names at all is treated as unchecked rather than as empty.

## What's here today

Private beta. This section documents the current source contract; a capability is not available on
a deployment until that build is released and its environment-specific gates pass. Highlights:

- **37 MCP tools** over a stateless Streamable HTTP endpoint: identity & onboarding (`whoami`,
  `list_teammates`, `create_invite`, `onboard_repo`, `list_projects`), snapshots & diff
  (`get_snapshot_checklist`, `push_snapshot`, `get_snapshot`, `compare_env`), debug sessions
  (`open_session`, `list_sessions`, `get_session`, `post_message`, `resolve_session`, `inbox`,
  `search_past_issues`), team-wide `announce`, and the **fleet group** (`start_run`, `update_run`,
  `finish_run`, `list_active_agents`, `get_policy`, `get_workflow`, `check_environment`,
  `handoff_work`, `assign_work`, `list_issues`, `get_evidence`, `launch_check`, `update_handoff`,
  `record_delivery_receipt`). The **Knowledge Hub group** is `get_knowledge_context`,
  `report_knowledge_receipt`, `search_knowledge`, `get_knowledge`, and `propose_knowledge`.
- **The fleet layer is reachable from MCP alone.** Runs, work claims, conflict warnings, policy
  pull and environment preflight no longer require the CLI and native hooks. A current connection
  binds one scoped credential to one durable agent installation; legacy PATs retain their
  token-derived installation for compatibility. The CLI still adds what only a local process can:
  automatic lifecycle hooks, profile-scoped offline outboxes, local git observations and policy
  compilation into `CLAUDE.md`/`AGENTS.md`.
- **One stable MCP address; one browser-approved identity per client.** Add `/mcp` in the agent
  client's supported HTTP-MCP settings. Standards-based OAuth discovery, dynamic client
  registration, exact callback matching and PKCE S256 move identity/scope approval into STMA's
  browser UI. Access tokens are short-lived; refresh tokens rotate; reuse revokes the linked
  installation. Each approval still creates a unique installation and enforced project/workspace
  grant. A copied setup request can ask the agent to invoke the client's native MCP command, but
  the model never handles the credential or hand-edits raw user configuration. The OAuth client
  type shown on consent is fixed from that client's registration, and a successful authenticated
  MCP initialize marks the installation active; `whoami` then verifies the visible identity/scope.
- **Legacy setup remains bounded, but is no longer the default.** For a client without OAuth,
  **Agent connections → Legacy setup prompt** can still issue the one-use, 30-minute Connector v2
  envelope. After one informed approval, the agent downloads the product-owned connector,
  verifies its pinned SHA-256 and runs it; it does not generate a credential parser.
  The connector supports Codex, Claude Code and Cursor on macOS/Linux with Node 20+. It adds a
  unique `stma_<enrollment-id>` alias to the private user-level config, preserving other connections
  and settings. No tracked repository source is changed. Cross-repository availability does not broaden the
  server grant. Codes/tokens are never echoed or placed in process arguments; a private bootstrap
  file is consumed and deleted, not securely erased.
  Redemption first creates limited bootstrap authority. Only `whoami` confirms legacy client loading;
  an unconfirmed credential stops working after 15 minutes without a cleanup job. Configuration
  installed, client confirmed and repository ready are different facts. After confirmation,
  standard core credentials have no automatic expiry; managed deployments can impose one.
  Validation or local-write failure triggers one self-revoke attempt, with exact cleanup evidence.
  Lost replies never trigger another redemption. Revoke access in the console and remove only the
  matching local alias when disconnecting. Existing credentials are not silently revoked.
  Project-scoped Claude Code/Codex prompts also disclose local tracking in the same approval:
  a hash-pinned standalone runtime, ignored profile state and client hooks. A read-only profile
  preflight runs before redemption. No npm installation or token transfer is needed; native state
  references the saved MCP alias. Codex additionally requires its own hook-trust review.
  Workspace-only/Cursor connections remain MCP-only unless native setup is separately approved.
- **Assign work to a named agent** (`assign_work`, 2026-09-18): the other direction. A lead — a
  person on the project page, or their agent over MCP — names an agent as `list_teammates` shows
  it ("Codex B"), says what to do, and the assignment lands in that agent's inbox as its own: only
  that installation can accept, resume or complete it, and every other agent sees it as somebody
  else's. The prompt hook announces it when the hook shares that agent's connection, or when the
  checkout's separately authorized local adapter is **paired** with that agent and works in the
  project the assignment names; otherwise the human there says one sentence — "read your STMA
  inbox" — rather than retyping the task. `assign_work` answers `hookWillAnnounce` so the lead
  knows which it is. Name the project as the console shows it (name, slug or repository): the
  existing project is always used, and only a name no project has creates one — the answer says
  so.
  Nothing is released and nothing is attested — the receiving agent's own `start_run`, pre-filled
  from the assignment, records the ground it takes under the normal policy and collision rules.
  The brief stays the lead's words; the `start_run` call is STMA's record.
  **The task can come from a connected tracker** (2026-09-20): the dialog's **Ticket** field takes
  `#42` or `owner/repo#42`, `PROJ-42`, or a ClickUp task link, reads the ticket and fills whatever
  you left empty — the ticket's own key becomes the task, and its summary and link go into the
  brief. For GitHub and ClickUp you can also **Browse** the twenty most recently updated open
  tickets and pick one instead of looking the key up, or **Search** them by a few words when
  the ticket you want is not among the newest twenty. Both are read only when you ask for
  them, so neither slows the page down, and a tracker that refuses says so instead of showing
  nothing. The line under the results says what was actually looked at, because the two
  trackers reach different distances: GitHub searches the whole repository through its own
  search endpoint, while ClickUp has no task search in its API at all, so STMA reads the three
  hundred most recently updated open tasks of the mapped List and matches them itself. Jira
  can be neither browsed nor searched yet, and the dialog says why — Atlassian moved issue
  search to an endpoint STMA has never measured against a real site, and a guess that fails
  while you are assigning work is worse than no button. Paste the key; STMA reads it the same
  way.
- **Agent handoff** (`handoff_work`, optionally `to_agent` so one named agent, not a person, is
  the only one that can take it and its prompt hook announces it): an agent about to hit its usage limit pushes its branch and
  attaches an immutable delivery/tested checkpoint in the same call (or records it on the run first).
  A branch handoff without that repository, exact commit, clean-worktree and test observation is
  refused without releasing the run. It then hands the task over with a brief — what is done, what is left, the scope it was holding and the
  exact call to re-claim it. Its own claims are released, the brief lands in the team inbox, and
  the code normally travels through git; messages and attachments can contain submitted code. **Omit the branch and it hands over a
  plan instead** — a runbook for your other machine is a handoff of intent, and it rides exactly
  the same rails. `inbox` lists work waiting to be picked up separately from unread messages, and a
  handoff addressed to somebody emails them. The actionable half arrives as a structured `resume`
  block STMA wrote from the run itself, not as prose: a receiving agent is told — correctly — to
  treat message bodies as data, and it should not have to parse instructions out of them to do the
  one thing a handoff is for.
  Generate one `request_id` for a new handoff and reuse it unchanged after a timeout: STMA returns
  the original session instead of charging the quota, posting the brief or closing the run twice.
  The durable handoff and queued direct notification commit with the run release; issue comments
  and team webhooks remain best-effort external side effects. For code handoffs, `resume` requires
  the same canonical repository and commit plus a clean receiving
  worktree. A Knowledge-linked resume additionally names the receiver's active `run_id`; that run
  must belong to the accepting installation and have its own immutable start checkpoint. The
  handoff carries a Knowledge Hub context reference rather than copying its text; the receiver
  resolves current authorized knowledge and sees whether its versions changed. An exact retry
  returns the recorded receiver context even after that receiving run becomes terminal.
  A secret that exists only on the source machine never belongs in the brief or on the receiver:
  the source machine runs the secret-dependent check and shares only its non-secret result.
  Peer-authored branch-handoff `next_steps` that mention credentials are accepted only in that explicit
  source-machine/non-secret-outcome form; instructions to provision, copy or use a credential on
  the receiver are refused before the handoff is created or the source run releases its claims.
- **Knowledge Hub** (`/app/teams/<slug>/knowledge`): versioned decisions, domain facts, procedures,
  references and known solutions with workspace or selected-project audiences. Agents and owners
  may create immutable drafts; only a workspace owner publishes, supersedes, archives or withdraws
  current knowledge. Draft, expired, archived and withdrawn text is excluded from current retrieval.
  A record with no review date has <code>unknown</code> freshness, never silently <code>current</code>.
  Publish/archive/withdraw/content-deletion actions cross the critical audit seam. Imported source
  provenance supplies canonical repository identity and a full commit together; the owner view
  separates checked, changed and reviewed time and shows bounded version history and line diffs.
  Exact historical version IDs remain readable only while the caller still has today's audience
  access, and are labelled `superseded`, `archived`, `withdrawn` or `expired` rather than current.
  The resolver uses project and planned path claims before lexical ranking, returns a deterministic
  context bounded to 8 KiB and records an immutable version/hash manifest for a run or checkpoint.
  Reporting is not automatic: after applying that exact manifest,
  the client explicitly calls `report_knowledge_receipt` or runs
  `stma knowledge receipt --context UUID --manifest SHA256`. Its first report for that context is
  immutable. A wrong hash is retained as mismatch evidence and returns HTTP 409 (or an explicit MCP
  error); a retry or corrected hash cannot overwrite it. A receipt distinguishes “server served” from
  “client reported”; neither means the agent obeyed the text, and published text is reference data
  rather than execution authority. An owner cannot silently move an active stable key to a different
  audience: that publish conflicts until the current version is explicitly archived or withdrawn.
  Explicit owner deletion scrubs retained body, title, source, audience and stored response copies;
  content-free tombstone IDs, hashes, manifests, receipts and critical audit evidence remain so old
  run evidence is not rewritten. Deleted active content no longer consumes hosted corpus capacity,
  but STMA cannot remotely erase text already delivered to an external client.
  Imports are explicit selected UTF-8 text/Markdown uploads; STMA does not crawl the
  repository, follow symlinks or fetch arbitrary URLs. Hosted deployments apply separately
  configurable engineering caps for content bytes, draft records, published records and versions;
  an over-cap write returns current/limit capacity instead of deleting history. These defaults are
  safety guardrails, not plan entitlements. Self-hosted instances do not apply them.
- **Your other machine is not you.** Whether a message is news is decided by *where* it came from,
  not by who wrote it: tokens are issued one per machine, so a session your desktop's agent opened
  is unread on your laptop and in your browser, and never unread on the machine that wrote it. One
  human running agents on two machines is the case this product exists for, and treating "same
  account" as "already seen" hid it from itself.
- **A savings ledger that will not flatter itself.** `/app/teams/:slug/savings` lists the moments
  worth counting — collisions warned about, duplicate work caught, machines stopped before they
  started, limits work survived — and asks a person whether each one changed what they did. Only
  the ones that did are counted. What STMA merely *observed* is shown next to that number and never
  converted into money, and minutes stay minutes until an owner says what an hour is worth. The
  number a buyer checks first is the number that has to be true.
- **Vendor quota, before it bites.** An agent reports how much of its own allowance it has spent
  (`update_run` with `usage`, or `stma run heartbeat --used-pct`); at 75% STMA tells it to plan a
  handoff and at 90% to make one, pre-filled with the run it is holding. Only the client can know
  that number, so STMA never guesses it — **and will not act on the agent's guess either.** A
  figure marked `measured` moves the fleet: the agent map shows who is about to stop and the feed
  records the escalation once. A figure with no source is filed as an estimate, drawn as one, and
  kept out of both. An invented percentage that triggers a handoff at the wrong moment costs more
  than the handoff it was meant to save.
- **Parallel attempts are a fan-out, not a collision.** Runs sharing an `attempt_group` — one
  prompt across several worktrees — never warn each other about the overlapping scope that is the
  whole point, and the map labels them "attempt 2 of 3". Two agents of yours in the *same*
  worktree still collide, because that one is the accident.
- **Delivery flows** (`/app/teams/<slug>/delivery`): the team lead's "how work moves here"
  onboarding document as data — ticket rules, branch naming, required checks, PR approvals and the
  environments on the road to production. One document, four renderings derived together: a
  prose brief agents pull with `get_workflow` (and are pointed at by `start_run`), an SVG picture
  of the flow, CI for **Azure DevOps or GitHub Actions**, and an English Markdown setup pack a user
  can hand to a coding agent. Eight built-in blueprints cover solo CI, trunk-based continuous
  deployment, pull-request previews, staged promotion, progressive delivery, GitOps, ticket gates
  and release trains. The catalog follows the operating patterns in
  [DORA's continuous-delivery guidance](https://dora.dev/capabilities/continuous-delivery/),
  [GitLab Review Apps](https://docs.gitlab.com/ci/review_apps/),
  [Microsoft's progressive-exposure guidance](https://learn.microsoft.com/en-us/devops/deliver/what-is-continuous-delivery)
  and [Argo CD's GitOps model](https://argo-cd.readthedocs.io/en/stable/user-guide/ci_automation/).
  A five-question wizard carries the chosen release model, tracker, CI provider and review strength
  into its recommendation. Each environment accepts its real deploy command once; both provider
  renderers reuse it, and a readiness panel names missing checks, commands, tracker connections and
  external approval setup. Before publishing, or from an existing flow, **Send this flow to an
  agent** previews or downloads a setup pack for an exact team/project scope. The user chooses
  `plan-only` or the approval-gated `propose-then-apply` mode and may inject the effective governance
  snapshot for that scope. Plan-only packs omit implementation steps instead of merely asking a
  model to ignore them. Project governance is the already-merged team + project policy, with its
  hash and source versions; individual rules cannot be cherry-picked. The pack performs read-only
  auth preflight, leaves login and consent to the user, forbids secret values in chat or files, and
  requires a structured completion receipt. Downloads require team access and use private,
  no-store responses. Repository-specific adaptations are reported back as suggested delivery
  updates; automatic receipt import is deliberately not implied.

  Missing fields keep the result explicitly labelled **Pipeline scaffold** and a direct/legacy
  Apply is refused. Once complete, the same owner-confirmed action applies the ready
  `azure-pipelines.yml` and registers it over the API. Connect Azure DevOps on the team page — or
  right on the delivery page, where the PAT is needed — without losing the selected flow. A
  project-scoped flow carries the project's durable id, so a repository-backed project is not
  duplicated into a same-named legacy scope and Apply resolves the exact reviewed repository
  binding. Azure PATs are organization credentials; STMA's repository binding limits which exact
  repository/project pair the connection is used for rather than claiming the PAT itself is
  repository-scoped. A
  read-only Jira connection covers flows whose tickets live there. Connections are verified the
  moment they are saved and the verdict is shown next to Apply; an empty repository is handled
  (the first apply creates the branch), a re-apply updates the file and reuses the existing
  pipeline, and failures answer in remediation language (expired PAT, missing scope, token minted
  for another organization) with fold-out step-by-step token instructions on both forms. Deploy
  jobs check out the repository, and dependencies stay inside their pull-request/merge/tag/manual
  trigger lane so one event cannot be skipped behind a job from another. Concurrent publishes are
  serialized and a database constraint guarantees one active flow per team/project scope. The flow
  also reaches the run:
  `start_run` warns when a required ticket is missing or the branch breaks the flow's naming rule
  (advice, never refusal), and a Jira-shaped task key pulls the ticket's summary in as the run's
  intent.
- **Project-scoped governance**: a project's sections live under the project —
  `/app/teams/<slug>/projects/<project>/{agents,work,sessions,activity,knowledge,governance,
  delivery,environments}` — which is what the rail and the in-page links produce. The same pages
  still answer the older `?project=` filter from the picker in the strip, so links already sent
  keep working: global by default, one project when chosen, the selection in the URL so it
  survives refresh and pastes to a teammate. Scoped governance narrows receipts,
  preflights, baselines and the timeline, and opens the policy editor on that project's own
  additions rather than the merge. Pickers and baseline promotion carry the durable project id;
  if a historical legacy row shares the display name, the repository-bound and legacy scopes stay
  visibly distinct instead of writing evidence to whichever name lookup happens to win.
- **GitHub issues, both directions.** An owner connects one repository on the team page; after
  that agents call `list_issues` to pick up work that already exists, `start_run {"issue": 42}`
  makes the issue number the task key and its title the run's intent, and finishing or handing off
  posts a comment back on the issue. Inbound `issues` webhooks become team announcements, so a new
  issue reaches every agent's inbox.
- **ClickUp tasks over OAuth, scoped to a project List.** A workspace owner chooses **Connect
  ClickUp**, approves STMA in ClickUp, then maps each STMA project to one exact List. Agents call
  `list_clickup_tasks`, pass a returned id, a `PD-207`-style custom id or a pasted URL as
  `start_run.clickup_task`, and a finished or handed-off run can comment back. The OAuth access
  token stays encrypted on the server and never enters an agent prompt or MCP response; a task
  outside the mapped List is refused, and so is a mapping whose STMA project no longer exists.
  The owner's card names when the connection was last checked and what its last comment did, and
  carries **Pause** — which keeps every mapping and the credential while STMA stops calling
  ClickUp — beside **Disconnect**, which removes both. A comment is **one attempt** after STMA's
  own durable event: ClickUp's comment endpoint takes no idempotency key, so a failure is reported
  on that card rather than retried, and a tracker never fails a run.
- **Terminal-first onboarding**: an owner's agent returns one invite instruction block. The
  invitee's agent can redeem it with `{code, email, password, agent_name, device, client, role}`
  and receive an account, team membership and a team-scoped credential bound to that installation
  — no browser required. Passwordless accounts fall back to the browser. Browser and terminal
  claims share one atomic path: max-use and plan limits cannot be oversubscribed by simultaneous
  requests, and a losing terminal claim does not leave an empty account behind.
- **Projects** can be created by a workspace owner from **Projects** or the inline **New project**
  bar on **Agent connections**, and are still born automatically from the repo identifier agents
  send. Both paths use the same canonical repository resolver. Repository identity keeps
  host/owner/repository distinct from the display basename, so two different owners' `api`
  repositories do not silently share history. Once a project-scoped credential is issued, every
  write is pinned to that durable project ID; the shorter display name injected for convenience
  cannot create a second legacy project beside a URL-created one. Per-project stats include
  (open sessions, active agent installations 7d, last snapshot). Opening a session from a project
  carries that project into an existing-project picker; a typo in the browser no longer creates a
  second project and splits its history.
- **DevOps hooks**: per-team secret URLs turn CI notifications and GitHub push webhooks into
  team announcements every agent sees in its inbox. Set the GitHub webhook **Secret** to the
  same token: GitHub requests without a valid HMAC signature are rejected. Generic CI systems that
  cannot sign use the separate token-only announce hook.
- **PR/CI outcome linkage**: point GitHub's `pull_request` + `workflow_run` webhooks (same
  URL) or Azure DevOps service hooks (`git.pullrequest.*`, `build.complete` →
  `/api/hooks/azure-devops/<token>`) at STMA and the verdict lands on the run that declared the
  branch — PR opened/merged/closed and the last CI result, written to the run's trail on change
  only, shown in the evidence pack and the agent-map inspector. A merged PR reaches the activity
  feed as `run_merged`: "a person said it helped" becomes "the change merged". Runs with no
  webhook wired stay unlinked, never "fine".
- **Run cost, measured only**: `update_run {"usage":{"cost_usd":4.20,"source":"measured"}}`
  records what a run actually spent — with the same discipline as vendor quota: estimates are
  stored and shown as estimates, and only measured figures are summed. The savings page shows
  "agents reported spending $X" next to the verified savings, so the ROI sentence has both
  halves, and shows nothing rather than $0 when nobody reported.
- **Activity feed** (`/app/teams/<slug>/activity`): which human's which agent did what, when —
  including control-plane actions (runs, policy publishes, baselines, drift, critical preflights).
  URL-backed filters narrow by project, action, person, agent, free text and date; pagination and
  CSV preserve the same filter set.
- **Notification settings** (`/app/notifications`, under **Settings**): a reply in a thread you are part of, its
  resolution, or being added to a team reaches you by email. Never your own actions, never a
  thread you have already read, coalesced per thread and capped per person per hour;
  announcements are opt-in. Needs `RESEND_API_KEY` to leave the box. Add your **own** Slack or
  Discord webhook and the same events arrive in your chat client instead of, or as well as, your
  inbox — with a "Send a test" button that proves the URL before you depend on it. Database leases
  prevent multiple workers from claiming the same delivery. A directed handoff retries transient
  delivery failure with bounded backoff up to three total attempts; routine notices remain one-shot.
- **Policy and baselines from the browser**: a team owner publishes the rulebook from a form —
  one rule per line, opening on whatever is live — and records an environment baseline by promoting
  a snapshot the team already pushed, choosing it by person and machine. The snapshot's durable
  project id is the default target; an explicit project choice also submits an id, never an
  ambiguous display name. Neither needs the CLI, and agents receive exactly the document the owner
  saw.
- **Content rules and policy violations** (2026-09-19): a **Denied** line shaped
  `content: "Comic Sans" in public/** — not in the design system` is still a sentence every agent
  reads, and is also checked by the local file guard against the text an edit would *add*. A match
  stops the edit on the agent's machine and reports the rule and the file path — never the
  content — so Governance → **Policy violations** shows which agent tried to break which rule,
  where. The literal is case-insensitive and never a pattern; `in <path>` means what it means for
  protected paths. It rides the existing deny list on purpose: a new policy field would change the
  fingerprint a published CLI recomputes and read as drift on every machine that has not upgraded.
  Coverage is the guard's: supported Claude Code/Codex file tools with the hook installed, not a
  shell redirect and not an agent connected over MCP only.
- **Governance page** (`/app/teams/<slug>/governance`): the effective policy per scope, receipts
  showing which hash each run actually applied versus the one expected, environment baselines,
  the preflight verdicts agents were given, and a run timeline read from the append-only event
  trail. These potentially long evidence groups are collapsed by default behind count-bearing
  section links; following a section URL opens the exact group instead of burying baselines below
  policy rows.
- **Agent control plane** (`/app/agents`): live ownership, task/branch presence, work claims and
  critical conflict radar across humans and agent clients. Drawn as a card per person — their
  agents, declared scope and heartbeat — with colliding claims marked in place and an overlap
  panel naming the two runs pulling at the same resource; the dense table stays below it. A
  durable inventory keeps idle and stale identities visible after live work ends, with owner,
  client, role, last context and last seen. Active identities sort first, then newest last-seen
  within each state. Exact run links never fall through to an unrelated live run when their target
  has finished. You can disable only your own run identity; active
  scope is ended and the agent cannot silently re-register it. Token revocation remains a separate
  control for an exposed credential.
- **A project has a page**: every repository an agent names becomes a project, and its page puts
  live runs, debug threads, the run trail, policy and environment baseline in one place — each
  next to the control that changes it, none of it a second copy of the pages that own those
  answers.
- **Local-first CLI** (`stma`): `stma serve` for a zero-setup private instance, plus agent
  registration, run lifecycle, conflict scopes, policy publish/pull, environment baseline/preflight,
  and wrapped command execution.
- **Snapshots cover the ecosystem you actually use.** The collector reads the repository and probes
  what it finds — Python, Go, Rust, Java, Ruby, PHP, .NET, Elixir, Dart, Docker and their package
  managers — instead of reporting node and npm whatever the project is. Twenty lockfile formats are
  hashed, and a Go repo never pays for a Ruby probe.
- **A run is told what it needs before it touches anything.** `start_run` answers three
  questions the team already decided: does this ground need a person to agree first, is the change
  bigger than one change should be, and is somebody already doing this. All three warn and none
  refuse — claims are advisory here on purpose. A caller-generated `request_id` makes a logical
  start idempotent; an unchanged retry returns the same run and frozen Knowledge envelope even if
  current publications changed meanwhile. Reusing it with changed input is rejected instead of
  creating ambiguous work.
  Planned scope declared before editing and observed dirty-worktree scope are retained separately.
- **The ground moving under a run is its own warning.** A conflict describes two runs that are
  both live, so it vanishes the moment the other one finishes — while its change is still under
  your feet. `update_run` says who *finished* on ground you still hold, which is the failure teams
  actually report and the one git merges cleanly.
- **Merge readiness, assembled not collected** (`get_evidence`): the policy receipt, preflight
  verdict, overlaps, declared scope, newest immutable delivery/test checkpoint and trail in one
  pack, with what nobody confirmed named as unconfirmed rather than passed. Provider status is
  exact only for that checkpoint's repository and commit; legacy branch-linked CI stays labelled
  legacy. Same pack in the agent map, so the reviewer and the agent that asked for review read one
  answer.
- **Work reaches the agent without being asked.** The lifecycle hook already fires immediately
  before your agent reads your next message, and whatever it prints becomes context — so it now
  carries what is waiting: a handoff, with the branch to check out and the exact `start_run` that
  re-claims the same scope. It offers; it does not act. Checked whenever you type and at most once a minute
  while the agent works, never announced twice, and a slow server costs silence rather than a delayed prompt.
- **`stma watch`** for the hours you are not typing: polls the same endpoint, prints a line and
  raises a desktop notification when work is handed to you.
- **Native lifecycle adapters**: merge-safe project hooks for Claude Code, Codex and Cursor. Each
  installation/profile owns `.stma/profiles/<id>/` state, locks and durable event files, so two
  vendors in one checkout do not overwrite each other. One profile per client per checkout is
  enforced: multiple profiles for the same client would misattribute its hook events. Use separate
  checkouts for distinct same-client installations. Events are enqueued before
  the network call, replay with stable IDs and expose overflow/corruption through adapter status and
  repair. Legacy checkout-wide state is copied into a profile without deleting its source.
- **Opt-in file-tool guard** for Claude Code/Codex: `--write-guard=true` checks current project,
  policy, overlap and stale ground on the server before supported file tools. A transaction-scoped
  database lock serializes competing reservations across server pools/replicas; denied contenders
  do not claim the file. Missing identity, offline service or an unverified answer denies the edit.
  This is not an OS sandbox: shell commands, external MCP writes and unhooked tools are not covered.
  A normal reply leaves a guarded run waiting; explicit completion/cancellation or session end closes
  it. Leases still expire without heartbeats. Hook events retain identity and bounded quota metadata,
  not raw prompts, tool contents or transcripts. Each credential and the human browser has its own
  inbox read cursor; one agent reading a thread does not clear it for the rest of the fleet.
- **Command console** (server-rendered, no client framework): a dark rail that separates the
  current team's controls from cross-team and personal destinations, with live counts; a status
  strip that says what is true right now (runs, claims, criticals, drift,
  connection state), a ledger, and an inspector carrying the detail and the trail for whatever is
  selected. Selection is a query parameter, so it survives a refresh and can be linked to;
  **Freeze view** stops the page updating, because a live page that reloads while you are reading
  is hostile. Activity exports as CSV.
- **Actually live** (`/app/stream`): watch pages hold a server-sent-events connection and update
  when something changes instead of reloading every 30 seconds whether or not anything happened.
  The strip says `live` when the channel is connected; the poll stays as the fallback, so a
  dropped stream costs latency and never correctness.
- **Web dashboard** (server-rendered, design system from Claude Design): teams, invites, tokens,
  sessions with typed messages, environment-compare view, in-app usage guide at `/docs` —
  which opens with a two-computer quick start and copyable first-message prompts, followed by
  a diagram of the whole system, MCP and control API side by side. Long
  lists page rather than truncate in silence. Self-serve account lifecycle: password change,
  ownership transfer, owner-only invite links and member removal, leave team, delete team, delete account (a
  content-preserving scrub, so teammates' threads stay readable).
- **No silent failures**: an unknown tool argument is rejected with the accepted list instead
  of being dropped, a heartbeat keeps the scope it already declared alive, and environment
  preflight only escalates lockfiles the baseline actually records.
- **Safety rails**: the snapshot collector omits env values (names only), server-side secret redaction,
  peer messages framed as untrusted data, hashed revocable tokens, rate limits, agent loop guard,
  plan-based member/project limits.

Auth: email + password, with emailed sign-in codes once a mailer is configured; GitHub OAuth
optional. Postgres in production, embedded PGlite for zero-setup dev and single-container
self-hosting.

## Try it in one command

```bash
npx @matteai/stma serve
```

A real instance on your machine: embedded database, no Postgres, no Docker, no
configuration. It prints the three steps to a connected agent — create an account and workspace,
add its `/mcp` address to the coding client, then approve identity/scope in the browser. Data lives in `~/.stma/data`, so running it
from any directory finds the same instance. `--port`, `--host` and `--data` if you
need them.

This starts **one local server**, not a server you must install on every computer. For a second
computer, connect to that same instance at a secured address reachable from both machines and set
`BASE_URL` accordingly. `localhost` on your other computer points to that other computer.

Passwordless dev login is deliberately **not** enabled: the first person to open
`/signup` gets a real account with a password, even on localhost.

## Four artefacts, one release

The same commit reaches people through four artefacts, and they carry **one version number**:

| Layer | Artefact | Who runs it |
| --- | --- | --- |
| Source | public snapshot, ELv2 | anyone reading or forking the code |
| npm | `@matteai/stma-server`, `@matteai/stma` | self-hosters and `stma serve` |
| Container | `ghcr.io/matte-ai-llc/stma` | self-hosters |
| Hosted | stma.ai's composed service image | Matte AI operates it for customers |

A `v*` tag publishes or deploys all four from one commit, and each workflow refuses a tag that
does not name the version in the manifests. The rules that keep the layers from drifting
apart — self-host carries the full deterministic core, plans meter rather than subtract, the MCP surface
is additive, a published artefact never inherits the checkout's conveniences — are
enforced by `packages/server/test/layers.test.ts`.

Two commands and one endpoint make version skew answerable rather than mysterious:

```bash
stma version --server     # this CLI, and the instance it is pointed at
curl -s https://stma.ai/health   # {"ok":true,"version":"0.11.0"}
```

## Self-hosting (n8n-style)

STMA is open-core: run it yourself for free, or use the hosted cloud (paid tiers fund the
project). **Self-hosting is not a reduced product**: plan limits only apply when
`STMA_HOSTED=1`, and an instance nobody configured is unmetered — every feature, no
ceilings. Self-host with Docker Compose:

```bash
docker compose up -d
```

Override the default database password with `POSTGRES_PASSWORD=... docker compose up -d`
(one variable feeds both the Postgres container and the app's `DATABASE_URL`). The app
container runs as the non-root `node` user and ships a `/health`-based healthcheck.

Open http://localhost:3000 and create the first account (email + password — no external
services needed; email codes stay off until you set `RESEND_API_KEY`). Or run the minimal single-container mode with the embedded database
(one instance, data in a volume):

```bash
docker run -d -p 3000:3000 -e NODE_ENV=production -e EMBEDDED_DB=1 -e BASE_URL=http://localhost:3000 -v stma-data:/app/packages/server/.data ghcr.io/matte-ai-llc/stma:latest
```

Or straight from npm, with no container at all:

```bash
npm install -g @matteai/stma-server
EMBEDDED_DB=1 PGLITE_DIR=~/.stma/data BASE_URL=http://localhost:3000 stma-server
```

The server bin assumes production unless started with `--dev`, so the passwordless dev
login form is off and the first account you create needs a real password.

### Upgrading across a PostgreSQL major

The embedded database is PGlite, which carries its PostgreSQL inside its own **minor**
version: 0.3 bundles PostgreSQL 17, 0.5 bundles 18. A PostgreSQL major never opens an older
data directory in place, so a release that moves it is a data migration wearing the clothes
of a dependency bump — which is exactly how it happened here, on 2026-09-14. Every data
directory written by `@matteai/stma-server` **before 0.14.2** is PostgreSQL 17; 0.14.2 and
later write 18.

The server refuses such a directory at boot, names both majors and prints the command:

```bash
stma-server --upgrade-data "$HOME/.stma/data"
# or, with nothing installed:
npx @matteai/stma-server@latest --upgrade-data "$HOME/.stma/data"
```

It reads the old database with the engine that wrote it, rebuilds the schema from the
migrations this build ships — replayed to exactly the level the old directory recorded, so
the ordinary boot migrator carries on from there — and moves every row in PostgreSQL's own
COPY format. Row counts are compared table by table before anything is swapped.

**Rolling back is a rename.** On success the PostgreSQL 17 database is kept beside the new
one as `<dir>.backup-pg17-<timestamp>`, and nothing in STMA ever deletes it. If the upgrade
turns out badly, stop the server, remove the new directory and rename the backup back:

```bash
mv ~/.stma/data ~/.stma/data.pg18-discarded
mv ~/.stma/data.backup-pg17-* ~/.stma/data
# then run the release you were on before, which is the one that can open it
```

On failure nothing is swapped at all: the work happens in a sibling directory, every check
that can refuse has refused before the first rename, and the original is left exactly as the
old engine left it. The message says which directory holds what.

The older engine is **fetched** rather than shipped, because it is 25 MB of WebAssembly a
fresh install will never open. It goes into a fresh private temp directory each run, and what npm
installed is checked against the digest this build pins before any of it is loaded. A machine with no registry access can point
`STMA_UPGRADE_ENGINE` at the module entry of a `@electric-sql/pglite@0.3.16` it already has.
The command is idempotent: run against a directory this build already wrote, it says there is
nothing to do and touches nothing.

### Hosted pricing

**The hosted service is in a private beta and nothing is for sale yet.** An access code creates
one account; every workspace has every feature and none of the plan limits on members, projects,
integrations, snapshot devices, calls or handoffs, there is no card and no trial clock, and the plan pages say so
rather than offering a checkout. History is the one exception, on purpose: the activity feed and
the agent run trail keep Cloud Free's 90 days, so the end of the beta deletes nothing. The table
below is the pricing the beta is testing toward — read it as the plan, not as today's bill.
Nothing switches off underneath an existing workspace without a conversation first.

An instance you run yourself is unaffected either way. `SIGNUP_ACCESS_CODES` and `BETA_UNMETERED`
are ordinary switches shipped in this source: the first makes signup invite-only without closing
it, the second lifts the ceilings on a hosted instance that is not charging.

Hosted billing counts **humans**, never agents, devices, worktrees, sessions, calls or CI runs.
Cloud Free is permanent rather than a trial clock. A one-human workspace can purchase Team before
inviting its second human; current member count is not a checkout prerequisite.

| Plan | Price | Human limit | Hosted service |
| --- | --- | --- | --- |
| Cloud Free | $0 | 1 | snapshots from 2 devices per 30 days, 90-day history, 3 handoffs/30 days, read-only fleet |
| Solo | $9/month or $90/year | exactly 1 | unlimited agents/devices/handoffs, governance, 1-year history |
| Team | $49/month or $490/year includes 5; then $12/month or $120/year per human | 2–50 | full collaboration, evidence, integrations and history |
| Enterprise | from $15K/year, annual contract | contract | operator-provisioned identity and limited audit capabilities; exact support and rollout agreed separately |

Cloud Free's device ceiling counts the device labels one person pushed environment snapshots under
in the last 30 days. A third is refused before anything is stored, the reply names the two that
count, and a device stops counting 30 days after its last snapshot. Connecting agents is never
limited by machine.

The deterministic collaboration core remains available to self-hosters without metering.
Billing and managed-service operation belong to the hosted operator layer. Its organization
foundation implements configured OIDC sign-in, bounded SCIM Users provisioning, workspace/project
roles and service identities; it is not included in the public server or enabled by a plan label.
Provider-tenant acceptance and explicit rollout are still required. SAML, SCIM Groups, legal hold,
residency and HA/SLA guarantees are not implemented by these controls. Limited signed audit exports
are not comprehensive compliance evidence. A signed order may name a capability only after its
implementation and acceptance criteria both exist. The hosted
catalog classifies Solo as personal-use cloud SaaS and Team lines as business-use cloud SaaS so
Stripe can apply the relevant product rules; applicable taxes remain separate from the listed price.

## Authentication

For the fastest start, add the single MCP address from **Agent connections** to each client and
complete a separate STMA browser authorization for each agent/machine. Then choose **Connect & test**
in the workspace and give the connected agents its secret-free sender/reply checks. Progress survives
refresh. No repository, governance setup or second human is needed. A connection proves an
authenticated identity, not a running process or two physical machines. Each teammate uses their own
account and each agent its own credential family.

**Handoffs** separates the next owner from unread chat. **Repositories** separates credentials,
project bindings and exact provider observations. Blueprint packs expose scope/version/hash and
plan-only versus approval-gated apply; returned **Delivery receipts** remain agent reports beside
provider facts, never a fabricated approval. See [Product flows](PRODUCT_FLOWS.md).

- **Local accounts** (default): **email + password**, hashed with scrypt. The username is a
  derived display name used for attribution, compare labels (`alice@macbook`) and URLs.
  `SIGNUPS_OPEN=0` closes registration; `AUTH_LOCAL=0` disables local accounts entirely.
- **Email sign-in codes (2FA)**: with `RESEND_API_KEY` set, signing in takes a second step —
  a 6-digit code mailed to the account (10 minutes, single use, 5 attempts, 3 sends per 15
  minutes). Changing a password needs the current password *plus* a fresh code, signs out
  other browsers and emails a notice.
- **Confirming and correcting the address**: signup mails a confirmation code and does not block on
  it, and **every signed-in page** carries a band saying the address is unconfirmed until somebody
  enters one — a page you have to go looking for is not a notice, and not blocking is only
  defensible because the console keeps saying so. The same page
  changes the address: the code goes to the **new** one, the current password is required, and the
  address being left behind is told. With sign-in codes on, that address is where the second factor
  and every password reset go, so an account whose address nobody has proved is an account nobody
  can get back into.
- **Sessions**: `/app/account` lists the browsers signed in to the account, with what each last
  arrived from and when, marks the one being read, and can end one or all of them. Agent
  connections are separate and a password has never touched them; they live on Agent connections.
- **Password reset**: "Forgot your password?" on the sign-in page mails a code; completing a
  reset invalidates **all browser sessions** and lifts the sign-in lock that usually sent the
  person there. It does **not** touch agent credentials — a password never reached one — and the
  page and the email both say so, because telling somebody whose account was taken over that they
  are "signed out everywhere" closes an incident that is still open. Finish the reset in the
  browser that asked: the pending code lives in that browser's cookie.
  The response is identical whether or not the address exists, **headers included**: the `reset`
  cookie is issued either way, naming a row that does not exist when there is no account, because
  until 2026-09-20 its absence answered the question the status, the body and the redirect all
  refused to. Accounts with no email on file cannot self-reset — an operator sets one from
  `/admin/users`. `SUPPORT_EMAIL` is rendered on the sign-in, signup, forgot and reset pages,
  which is where somebody who never receives the mail is standing — and each of those pages links
  `/help#signin` first, because most of what goes wrong here is answerable without a person: a
  lock that refuses the right password on purpose, a code that belongs to the browser that asked,
  an access code checked before the address. The signup page had nothing to link to at all until
  then, which made a refused access code a dead end for somebody with no account to sign in to.
- **Instance administration** (when `ADMIN_USERNAMES` or `ADMIN_EMAILS` is configured):
  **Workspaces** can be searched and filtered by plan, then opened to inspect their projects,
  members and workspace/project-scoped agent connections. **Users** can be searched by identity
  or workspace and filtered by workspace plan, membership and authentication state. A user detail
  manages independent workspace roles and memberships while preventing last-owner removal and plan
  over-capacity; organization-managed memberships remain controlled by their identity administrator.
- **Operator history** — the same console also answers *what happened*, not only what is happening.
  **Load history** on `/admin/ops` is a persisted five-minute rollup (requests, status mix, latency
  histogram, rate limiting, peak memory and event-loop lag) over 24 hours, 7 days or 30 days,
  drawn beside — and clearly apart from — the live in-process counters that a restart erases.
  Percentiles are recomputed from the stored histograms, because a p95 cannot be averaged across
  windows. A missing bucket means the process was not running, not that nobody called it.
  **Ceiling history** records every time a workspace's limits moved — an operator's plan switch, a
  workspace owner starting an evaluation, or a Stripe reconciliation nobody was watching — with
  what it moved from, what to, by which route and, when a person did it, who. It is on the
  workspace's own page and as a recent list on `/admin`.
  **Beta reach** (`/admin/beta`) answers the other half: which access-code cohort every workspace
  arrived through, when, what it has used since, and how far it already is from the ceilings it
  falls to when `BETA_UNMETERED` is unset — so unsetting it is a decision rather than a surprise.
  The cohort is the label on the code its creator signed up with, stored on the account at signup
  (`users.signup_cohort`); the code itself is never stored, logged or shown anywhere. Tool calls
  and handoffs are read from the counters the limiter enforces, and devices over the same 30-day
  window the snapshot gate counts, so an operator and a capped workspace see one number. A chart
  puts every workspace's six countable ceilings on one axis
  against a single rule, and a strip beside it marks the features a workspace is using that the
  free plan does not carry — losing a capability reads differently from being over a limit.
- **GitHub OAuth** (optional): set `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` to add a
  "Continue with GitHub" button.

## Local development

On Windows, double-click `run-local-demo.bat` (or run it from a terminal). It starts an isolated
embedded database and dev-auth instance on **http://127.0.0.1:46273** so it does not collide with
the default port or data directory.

For a repeatable, no-account multi-agent acceptance run, double-click `run-agent-lab.bat`. It uses
a temporary embedded database and OS-assigned port, simulates multiple human-owned agents across
the example projects, and then runs each example project's own tests.

```bash
npm install
npm run dev
```

Open http://localhost:3000 — dev login is enabled automatically (no password needed) and data is
stored in an embedded PGlite database under `packages/server/.data/`. The `--dev` flag in that
script is what enables it: run the server any other way and it assumes production, because a
passwordless login form is a development convenience and should not travel with the package.

Run the end-to-end tests:

```bash
npm test
npm run demo:local   # verbose local-alpha acceptance run
npm run demo:agents  # focused multi-agent lab + both example-project test suites
npm run human-lab:check  # validate the fixture, prompt bundle contract and executable baseline
npm run human-lab:prompt -- bundle --team TEAM --device-a DEVICE_A --device-b DEVICE_B
                     # prepare local stage prompts, a run sheet and NOT_RUN evidence; no server writes
```

Releasing (maintainers):

```bash
npm run version:set -- 0.13.0   # public manifests + private EE when present, and lockfiles
npm run version:check           # what every tag workflow asserts before publishing
```

The fixtures under `examples/payments-api` and `examples/storefront-web` make the coordination
signals concrete. The lab proves that two agents claiming the same payment migration are flagged
as a critical collision, while an agent working on the separate storefront project remains
independent; it also checks policy/environment drift and the live agent map response. The
[`payments-api` human lab](examples/payments-api/README.md) adds the part automation cannot prove:
two separately enrolled agents on two physical devices must stop for conflict, preflight and human
approval, then carry code through git and the structured brief through STMA.

## Local agent control plane

Start the app, create a team and use **Agent connections** to mint a scoped credential for this
installation. Expose the returned token only to the shell that launches your coding agent. The CLI
never writes the token to disk.

Install the CLI (published as `@matteai/stma`; the command it installs is `stma`):

```bash
npm install -g @matteai/stma      # or: npx @matteai/stma --help
```

```bash
export STMA_URL=http://localhost:3000
export STMA_TOKEN=stma_...

# Explicit lifecycle: useful for CI, scripts, and initial inspection
npm run cli -- agent register --name alice-codex --client codex --role implementer
npm run cli -- run start --team acme --project payments --task PAY-142 \
  --scope path:src/payments:write --scope migration:payments-db:write
npm run cli -- run heartbeat
npm run cli -- run finish
```

Manual `run start` persists its complete request and logical ID in the selected installation profile
before networking. If a response is lost, repeat the same command; changed arguments or a different
`--request-id` are refused while the result is unknown. `--discard-pending=true` is an explicit
declaration that the old request should be abandoned and a deliberately new logical run created.

Two other flags worth knowing. `run heartbeat --used-pct 88` reports how much of the agent's own vendor
allowance is spent and prints back when to hand off (the native hooks read `STMA_USED_PCT` from the
environment for the same purpose, so a wrapper script can supply it automatically). And
`run start --attempt-group PAY-142-fanout` marks several runs as parallel attempts at one task, so
they stop warning each other about the files they are all deliberately touching.

PowerShell uses `$env:STMA_URL="http://localhost:3000"` and
`$env:STMA_TOKEN="stma_..."` for the first two lines.

An owner can establish the environment baseline and publish a canonical policy locally, without
any third-party integration:

```bash
npm run cli -- env baseline --team acme --project payments
npm run cli -- policy publish --team acme --project payments --file .stma/policy.json
npm run cli -- policy pull --team acme --project payments --apply
```

`.stma/policy.json` uses this portable shape:

```json
{
  "guidance": ["Keep migrations backwards compatible."],
  "permissions": {
    "deny": ["read secret values"],
    "requireApproval": ["production changes"]
  },
  "requiredChecks": ["npm test"],
  "protectedPaths": ["db/migrations/**"],
  "environment": {
    "requiredEnvVarNames": ["DATABASE_URL"],
    "runtimes": { "node": "24.1.0" }
  }
}
```

For automatic lifecycle reporting with the current first-party CLI, use a separate local
adapter activation in the Git checkout root. MCP OAuth by itself does not track work. This
activation does not extract or duplicate the Codex/Claude MCP credential: it opens STMA's
project-scoped OAuth consent for a distinct, revocable local-adapter installation. The CLI
keeps its rotating credential in a private OS-user file and installs ignored checkout-local
hooks only after the browser approval matches the requested workspace/project. On Windows,
the adapter credential is encrypted with current-user DPAPI rather than trusting POSIX file
mode bits; macOS/Linux require a private OAuth directory and file. Codex also
requires explicit `/hooks` trust. Neither hook system covers every shell or OS write.
The browser-approved agent and machine labels are authoritative; an existing user-owned
`~/.stma` directory may be readable, but its OAuth credential subdirectory must be private
on macOS/Linux. Windows file access still follows the user's profile ACL; DPAPI prevents a
copied credential file from being decrypted by a different user or machine. Node cannot read Windows
ACLs either, so activation does not judge a checkout by its location: it makes the checkout's
`.stma` directory private to your Windows account (inheritance off; your account, SYSTEM and
Administrators only), tightening a directory that a drive's broad inherited entry left writable by
other accounts, and refuses only when it cannot — a drive without NTFS permissions, or a directory
another account owns. That matters because the pinned runtime runs as you on every prompt. Its hooks
run it as `node "<forward-slash path>"`, a spelling Claude Code's Git Bash and PowerShell hook shells
both accept. Every such refusal happens before the browser approval, so an unsupported checkout
never creates a credential that then has to be revoked.

```bash
stma adapter activate --target codex --team acme --project payments --server https://your-stma.example
stma adapter doctor
```

This requires a CLI release containing `adapter activate`; do not use an older published CLI
with this command. A doctor result verifies local configuration, not real multi-agent
coordination: observe a run and claim from a natural coding task before marking acceptance.

**Pair the adapter with the agent it sits beside.** The adapter and the agent's MCP connection
are two installations, and nothing connects them until you do. The adapter's approval screen
asks **Listens for** — one of your own connected agents that can reach the same project, or
nobody — and the CLI prints the answer. An adapter activated earlier is paired without
re-activating, under **Agent connections → Listens for** on its row. Paired, its prompt hook is
told about work assigned to that agent by name in the adapter's project (and is no longer read
that agent's own briefs back), `list_teammates` and the **Assign work** picker mark the agent
`adapterPaired`, and an edit the file guard stops is filed on Governance under the agent's name,
"via its adapter". An adapter
itself is never offered as somebody to assign work to, paired or not — it cannot call a tool, so
it could never accept. Pairing also lets that agent **update, finish and hand off the runs these
hooks start**: the hook opens the run under the adapter's installation and tells the agent beside
it to reuse that `run_id`, which only works because you paired them. It goes one way — the adapter
cannot accept the assignment it announces and cannot touch the agent's own runs — it reaches no
project the agent's connection does not already reach, and unpairing takes the run back on that
agent's next call.

For legacy/static-token deployments, review a dry run and then install one native project adapter.
When developing this monorepo, `--command "npm run cli --"` gives the hook a resolvable command;
an installed CLI can use the default `stma` command.

```bash
npm run cli -- adapter install --target codex --team acme --project payments \
  --name alice-codex --role implementer --profile alice-payments-impl --command "npm run cli --"
npm run cli -- adapter install --target codex --team acme --project payments \
  --name alice-codex --role implementer --profile alice-payments-impl --command "npm run cli --" --apply
```

Targets are `claude-code`, `codex`, and `cursor`. The adapter preserves unrelated hooks, applies
the effective policy in the client's native rules format, runs environment preflight, and queues
events under `.stma/profiles/<id>/outbox/` before attempting delivery. Profile-local locks and
stable event IDs make concurrent hooks and retries safe; `stma adapter status`, `doctor`, `repair`
and `disconnect --profile ID` inspect or change only that profile. If `--profile` is omitted, STMA
derives one from client, workspace/project, role and agent name. Legacy `.stma/adapter.json`,
`local.json` and `outbox.json` are copied into the matching profile on migration and left in place.
Codex requires the new project hooks to be reviewed in `/hooks` before first use.

## Connect an agent

Open **Agent connections**. Select Codex or Claude Code and copy the setup request into that agent.
It checks only whether the exact generated name already exists, with configuration output hidden,
uses only the client's built-in MCP add/login path, and stops rather than replacing it. Differently
named connections are neither inspected nor removed. The request carries the
displayed `{BASE_URL}/mcp` address and selected workspace/project, but no secret. The agent prepares
the entry; the person still approves the exact scope in STMA. The client discovers STMA's OAuth
endpoints, opens the STMA browser page and uses PKCE. Sign in to STMA, name this agent and machine,
choose project, workspace or explicit personal access, and approve the disclosed boundary. If the
target project is missing, create it from **New project** first. STMA creates a unique installation
ID behind that approval. The client receives short-lived access plus a rotating refresh grant and
stores both using its own credential mechanism; neither value appears in HTML, prompts, repository
files or commands. The consent page displays a non-editable client type derived from the OAuth
registration. After login, reload the client once; its first successful authenticated MCP initialize
marks the installation active, while `whoami` verifies the approved scope. Repeat the same address
and a fresh browser approval for every client/machine.

The Codex request uses a readable scope-specific name such as `stma-payments-api`, so one
project's connection does not overwrite another. Codex keeps MCP servers in its user configuration,
so every Codex task on a machine shares that one STMA identity. Codex can still be added manually
in Settings or with `codex mcp add NAME --url {BASE_URL}/mcp`; run `codex mcp login NAME` only if
Add did not already start OAuth. Never open two login flows for one add.

Claude Code connects per Git checkout (clone or worktree), so several Claude Code agents on one
machine are separate STMA agents. Claude Code stores an MCP login under the server's name and signs
out that name's earlier login when it logs in again; two checkouts sharing a name would share, then
steal, one installation. The Claude request therefore derives a name from the checkout, such as
`stma-parcel-desk-claude-3f9a` (folder plus four hex digits of the root path's Git hash), adds it
with `--scope local` (which Claude Code attaches to the repository root) and runs
`claude mcp login NAME` inside that checkout; a non-interactive agent shell hands that one command
off to a regular terminal in the checkout. Paste the same request into every Claude Code agent. It
stops, without removing anything, if the older machine-wide `stma-<scope>` entry would also load
there. The manual fallback is the same two commands with a name no other checkout on the machine
uses. Local scope changes visibility only; it does not expand the project/workspace grant enforced
by STMA. The consent page suggests the checkout folder as the agent name. Older Claude Code builds
should be updated before continuing. Client UI
names can change; the protocol boundary is the stable MCP address and browser consent page.

The OAuth connection is MCP-only. It does not install git hooks, file guards, runtimes or repository
files. Those local capabilities require a separately packaged, visibly approved adapter. A client
that cannot complete OAuth may open **Legacy setup prompt (compatibility)**. That fallback retains
the older 30-minute single-use envelope and model-mediated Connector v2 path below; it is not the
recommended onboarding experience.

### Legacy connector fallback

The legacy block carries a 30-minute, single-use enrollment code and client-specific setup rules.
It is a review envelope, not unattended authorization: before any network request or persistent
change, the agent inspects the local target read-only and shows one concise redacted plan. Only one
explicit **yes** permits the disclosed operation; **no** leaves the code unused and configuration
unchanged. The returned token and Authorization value are never displayed. Do not save or forward
the prompt.

The approved activation uses one short-lived local helper outside the repository. The agent consumes
the code already in the envelope automatically; it never asks the user to paste/type it again, review
helper source, choose a transfer method or confirm a disclosed change twice. If the client has no
native non-echoing input, it automatically uses a randomly named current-user-only `0600` file in the
OS temp directory, unlinks it as soon as the helper opens it, and cleans it on failure. This is deletion,
not guaranteed secure erasure, and the code may still exist in the client's tool-input audit. The helper
holds the returned token only in process memory while validating the response and atomically merges the
existing user config without changing unrelated settings. The resolved file must be owned by the current
OS user; required user-only permission tightening is disclosed before and included in the one approval.
The helper preserves ownership and already-safe permissions. It never passes the returned token
through shell history, argv, environment, tool output, clipboard, a temporary response file or a
client CLI header flag. Response validation is exact rather than heuristic: the prompt embeds a flat
expected receipt and the redeem response returns the same named scalar fields, including JSON `null`
for an absent team or project. If validation or the atomic config write fails after redemption, the
helper automatically self-revokes that freshly minted installation with the in-memory token; manual
cleanup is needed only when that compensating call cannot be confirmed. If the safe local path is
unavailable before redemption, the agent stops without consuming the code.

User-level describes **where the client stores the MCP entry**: it persists for that OS user and is
available across repositories. It does not broaden the server grant. Project reaches one project;
team reaches every current and future project in that workspace; personal reaches every workspace
the account can access while the credential remains active. OAuth access tokens expire after one
hour and are renewed by rotating refresh grants; explicit revocation, installation disablement,
lost scoped access or target deletion stops the family. Legacy core PATs retain their historical
until-revoked semantics, and managed deployments may impose a shorter exact expiry.

Before asking for approval the agent must inspect an existing user-level `stma` entry without connecting
to it. It may not silently replace one: the redacted old/new state must be part of the single combined
disclosure and approval. If those inspected facts change, the agent stops before redemption and presents
a fresh combined disclosure. Server-side
revocation stops access but cannot remove the local entry or stop the client process. Remove the
entry and reload the client as the separate local cleanup step. MCP calls are initiated by the
client, so installing this entry does not let STMA wake the agent, run local commands or read local
files. The client sends data only when it chooses to call a tool. If an agent redeems while an older
Agent connections page still shows its pending setup row, that row's Revoke action follows the
enrollment to the newly bound installation and credential; the user never has to refresh and revoke
a second row to stop server access.

To add a person, an owner can ask their agent to call `create_invite`. The returned instruction
block lets the invitee create/verify their account, join that one team and connect their own
team-scoped agent in the same flow. It never shares the inviter's credential. The full walkthrough
lives in the in-app guide at `/docs`, and the state/authorization map is in
[PRODUCT_FLOWS.md](PRODUCT_FLOWS.md).

**Codex** (`~/.codex/config.toml`, user-level)

```toml
[mcp_servers.stma]
url = "https://your-deployment.example.com/mcp"
http_headers = { Authorization = "Bearer stma_..." }
```

**Claude Code** (`~/.claude.json`, user-level `mcpServers`; semantically merge this entry)

```json
{
  "mcpServers": {
    "stma": {
      "type": "http",
      "url": "https://your-deployment.example.com/mcp",
      "headers": { "Authorization": "Bearer stma_..." }
    }
  }
}
```

**Cursor** (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "stma": {
      "url": "https://your-deployment.example.com/mcp",
      "headers": { "Authorization": "Bearer stma_..." }
    }
  }
}
```

## When it goes wrong

Every running instance serves **`/help`** — a public page, readable without an account, that
names the walls people actually hit and says what to do about each. It needs no login on purpose:
a refused access code, a sign-in code that never arrived and a lock that refuses the right
password are all in front of the door, and a page behind it cannot reach the person standing
there. Point people at `https://your-instance/help`; set `SUPPORT_EMAIL` and it ends at your
address rather than in silence.

A self-hoster's first four are not on a hosted user's list:

- **`PGlite failed to initialize properly`, or a refusal naming two PostgreSQL majors.** The
  embedded database's PostgreSQL major moved between releases (PGlite 0.3 carries 17, 0.5 carries
  18) and a major never opens an older data directory in place. The refusal names the way across:
  `stma-server --upgrade-data "<that directory>"`. It keeps the old copy beside the new one. See
  [Upgrading across a PostgreSQL major](#upgrading-across-a-postgresql-major).
- **Two machines each running `npx @matteai/stma serve` cannot see each other.** That is two
  private instances. Run one server, give it an address both machines can reach, and set
  `BASE_URL` to it before connecting any client; `localhost` only works on the machine hosting it.
- **Nobody can reset a password.** `/forgot` and `/reset` answer 404 without email configured —
  the recovery path is then an operator at `/admin/users`. Decide that before you invite anybody.
- **A documented tool answers 404.** Usually a version gap. `stma version --server` prints both
  sides and `GET /health` names the build.

## Running more than one instance

On `DATABASE_URL` the app is horizontally scalable: every piece of state that has to agree
between instances is in Postgres. Rate limits, the MCP loop guard, the per-account and per-team
allowances and sign-in throttling count in the `rate_counters` table, and the live channel behind
the console's watch pages (`/app/stream`) is carried by `LISTEN`/`NOTIFY` on the channel
`stma_change`. Nothing to configure and no extra service: if `DATABASE_URL` is set, it is on.

Three things are worth knowing before you turn the number up.

- **The live channel is best effort, and that is deliberate.** Its payload is a team id and one
  word — never the change itself — so a browser that hears it simply re-fetches the page it was
  already on. A notification lost to a reconnect costs that page latency and never correctness,
  because the 30-second poll stays underneath it as the floor.
- **Per-IP rate limits are per instance, on purpose.** A shared counter row per anonymous request
  would turn the limiter into an amplifier, so the in-memory `Map` stays. With N instances those
  ceilings are up to N times as generous; everything keyed to an account is exact at any count.
- **`EMBEDDED_DB=1` is one instance, full stop.** The embedded engine is a PostgreSQL compiled
  into the Node process that uses it, so a second process cannot share the database — and would
  not hear its notifications either.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `PORT` | no | HTTP port (default `3000`) |
| `HOST` | no | Bind address (default `0.0.0.0` in production, `localhost` otherwise) |
| `PGLITE_DIR` | no | Embedded database directory (default `.data/pglite`) |
| `BASE_URL` | prod | Public origin, used for OAuth redirects, invite links and snippets |
| `DATABASE_URL` | prod* | Postgres connection string. Unset → embedded PGlite (dev, or prod with `EMBEDDED_DB=1`) |
| `EMBEDDED_DB` | no | `1` allows production on the embedded database — **one instance only**, persist `packages/server/.data`. On `DATABASE_URL` you may run several: rate limits, the loop guard and the live `/app/stream` channel are all shared through Postgres (the last over `LISTEN`/`NOTIFY`). See [Running more than one instance](#running-more-than-one-instance) |
| `STMA_UPGRADE_ENGINE` | no | Only read by `--upgrade-data`: the module entry (`dist/index.js`) of a PGlite copy that can open the *older* data directory. Set it to run the upgrade with no registry access; unset, the pinned engine is fetched into a fresh private temp directory and checked against the digest this build pins before it is loaded. Never read on a normal boot |
| `RESEND_API_KEY` | no | Resend API key for account emails (sign-in codes, password reset). Without it codes are only logged and email 2FA defaults off |
| `MAIL_FROM` | no | Sender address (default `STMA <noreply@stma.ai>`). **Its domain must be verified with your mail provider**, or every message is refused and nothing says so on a page: sign-in codes and password resets simply stop arriving. A configured key proves an account, never a verified domain, so the server prints this address at boot and `/admin/ops` carries a Mail card with the provider's own refusal |
| `ADMIN_USERNAMES` / `ADMIN_EMAILS` | no | Comma-separated operator lists. Unset → `/admin` (incl. `/admin/usage`) is a plain 404. An address counts only once the account has **confirmed** it (Account → Send me a code), and a new account can never take a listed username — so list a username the operator already holds, or an address they can read |
| `AUTH_2FA` | no | `1` forces email sign-in codes on, `0` off. Default: on when `RESEND_API_KEY` is set. Also gates password-change confirmation and self-service reset |
| `ADMIN_EMAILS` | no | Comma-separated operator addresses for `/admin`; works alongside `ADMIN_USERNAMES`. **Only a confirmed address counts**: signing up with a listed address is not being the operator. Needs a mail transport, since confirming means entering a code sent to it; without one, use `ADMIN_USERNAMES` |
| `AUTH_LOCAL` | no | Local username+password accounts (default on; `0` disables) |
| `SIGNUPS_OPEN` | no | `0` closes new local account registration |
| `SIGNUP_ACCESS_CODES` | no | Codes signup asks for, comma separated, each `CODE` or `CODE:cohort-label`. Set, signup is invite-only without being closed; unset, signup behaves exactly as it always has and a self-hosted instance never sees a code field. A cohort code, not a one-use invite — an invite adds a human to an existing workspace, this is the door before that. Codes are compared as sha256 digests in constant time with no early exit, and checked **before** the address is looked at so the form cannot confirm who already has an account. The **label** is stored on the account that redeemed it (`users.signup_cohort`) and is what `/admin/beta` groups by; **the code itself is never stored, logged or rendered**. A code with no label is recorded as having come through the door without naming a wave |
| `BETA_UNMETERED` | no | `1` lifts every ceiling but one on a hosted instance that is not charging yet. Deliberately separate from `STMA_HOSTED`: audit, identity composition and every operator surface keep behaving the way they will when billing turns on, and only the limits lift. It writes no plan onto any workspace, so unsetting it restores the matrix with nothing to unwind — `teams.plan` is `NOT NULL DEFAULT 'free'`, which is exactly where everybody lands. The one it leaves alone is the age limit on history: activity and the agent run trail keep the plan's retention throughout, so unsetting it deletes nothing either. `/admin/beta` is where you check what that costs each workspace before you do it |
| `SITE_MODE` | no | `teaser` makes the **signed-out** site pre-launch: the landing page is the same page either way and says what the product is, but its call to action becomes the access code the private beta asks for, `/pricing` is not linked, and the guide and `/help` drop the sections about a console a visitor cannot reach — on `/help` that is connecting an agent and running one, since a stranger has neither. Their sign-in, self-hosting and known-limits halves are always there, which is the point of a troubleshooting page. Signed-in members get the full app, the full guide and the full help page — it is a statement about who the marketing is for, not a reduced build |
| `DEMO_LOGINS` | no | Credentials printed on the sign-in page of a throwaway environment: `email:password[:label]`, comma separated, up to 8. Only ever shows the literal you set — the page reads nothing from the database, so this can never expose a real account. **Never set it on a production app** |
| `STMA_HOSTED` | no | `1` makes plan limits apply. **Unset means this is your instance and nothing is metered** — the fleet, governance, evidence, retention and every cap are open. Only the hosted service sets it |
| `TRUSTED_PROXY_HOPS` | no | How many proxies of your own stand in front of this instance. `X-Forwarded-For` is a list each proxy appends to, so its leftmost entry is whatever the client sent; every per-IP rate limit counts this many entries in from the **right**, which is the part a client cannot choose. `0`, the default, trusts only what the nearest proxy appended and is right for a direct-to-origin deployment. Behind a CDN in front of a platform ingress the chain ends `…, client, edge`, so `1` is the real client. Too high groups a whole proxy's traffic together; too low is coarser still. Neither direction is forgeable |
| `TRUSTED_PROXY_CIDRS` | no | Which addresses may be one of those hops: comma-separated CIDR ranges, or `cloudflare` for Cloudflare's published edge ranges. Set, a hop is stepped over only when the address that appended it is on the list, so a client that skips the proxy and connects to the origin directly is counted against the address it connected from rather than one it typed — a count alone cannot tell the two apart. A value that does not parse stops the server at boot |
| `SUPPORT_EMAIL` | no | Where a person writes when the product goes wrong. Shown in the signed-out footer, on the account page, at the end of `/help`, on the sign-in, signup, forgot and reset pages, and in the password-changed email. Defaults to `support@matteai.com` **only** when `STMA_HOSTED=1`: an instance you run yourself gets no address unless you set one, because telling your users to mail us sends us what we cannot act on and sends you none. Empty means nothing offers a support door |
| `PRIVACY_EMAIL` | no | Where a data-protection request goes: access, correction, deletion, portability, objection — the GDPR and KVKK doors. Shown in the signed-out footer as **Data protection**, beside the **GDPR & KVKK requests** link to `/privacy#rights`. Defaults to `gdpr@matteai.com` **only** when `STMA_HOSTED=1`, for the reason `SUPPORT_EMAIL` has: on an instance you run, you are the controller of the data it holds and our address would take requests we cannot answer. Empty means no such door. The addresses printed inside `/terms` and `/privacy` are Matte AI's own and do not follow this variable — those documents describe the hosted service whichever server renders them, and say so |
| `KNOWLEDGE_HOSTED_MAX_BYTES` | no | Hosted-only Knowledge Hub content-byte guardrail per workspace (default `10485760`, 10 MiB). An over-cap write fails with capacity detail; history is not deleted. Not a plan entitlement; ignored when self-hosted |
| `KNOWLEDGE_HOSTED_MAX_DRAFTS` | no | Hosted-only draft-record guardrail per workspace (default `250`); ignored when self-hosted |
| `KNOWLEDGE_HOSTED_MAX_PUBLISHED` | no | Hosted-only published-record guardrail per workspace (default `250`); ignored when self-hosted |
| `KNOWLEDGE_HOSTED_MAX_VERSIONS` | no | Hosted-only stored-version guardrail per workspace (default `1000`); ignored when self-hosted |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | no | Optional GitHub OAuth; callback URL is `{BASE_URL}/auth/github/callback` |
| `CLICKUP_CLIENT_ID` / `CLICKUP_CLIENT_SECRET` | no | Optional customer-facing ClickUp OAuth app; callback URL is `{BASE_URL}/auth/clickup/callback`. Users authorize in ClickUp and never paste personal API tokens into STMA |
| `AUTH_DEV_MODE` | no | `1` forces the dev login form. Auto-enabled outside production when OAuth is not configured |
| `NOTIFY_DEBOUNCE_SECONDS` | no | Wait this long before emailing about a thread so a burst of replies becomes one message (default `120`) |
| `NOTIFY_MAX_PER_HOUR` | no | Hard cap on notification emails per person per hour (default `6`) |
| `ACTIVITY_RETENTION_DAYS` | no | Purge activity events, the agent run trail (`agent_events`) and announcements older than this (default `180`; `0` disables the age purge — a 20,000-row cap per team and 500 per run/channel still apply). **Ignored for the first two when `STMA_HOSTED=1`**: there the plan decides, because retention is one of the things a plan sells, and `BETA_UNMETERED` does not change that. The Activity page prints whichever number applies |
| `ERROR_RETENTION_DAYS` | no | Purge operator error-log entries older than this (default `30`; `0` disables the age purge — a 2000-row cap still applies) |
| `LOAD_RETENTION_DAYS` | no | How far back `/admin/ops` can look at load: five-minute rollups of request count, status mix, latency histogram, rate limiting, peak memory and peak event-loop lag, written every minute from the in-process counters (default `30`; `0` disables the age purge — a 20,000-row cap still applies). An instance fact, not a plan attribute: `STMA_HOSTED` does not change it |
| `ADMIN_USERNAMES` | no | Comma-separated usernames allowed into the operator-only `/admin` panel (instance stats, team plan switching, partner CRM). Unset = the area does not exist. A listed name is reserved: signup and GitHub sign-in never give it, or a case variant of it, to a new account — list the name of an account that already exists |
| `SESSION_TTL_DAYS` | no | Web session lifetime (default `30`) |
| `SNAPSHOT_RETENTION_DAYS` | no | Purge snapshots older than this (default `90`, `0` disables). Also bounds stored preflight results, alongside a fixed 200-row cap per team |
| `SESSION_RETENTION_DAYS` | no | Purge resolved sessions older than this (default `0` = keep the archive forever) |
| `AGENT_STALE_MINUTES` | no | Mark active agent runs stale after no heartbeat (default `3`) |
| `AGENT_CLAIM_LEASE_MINUTES` | no | Work-claim lease refreshed by heartbeat (default `5`) |
| `AGENT_WAITING_LEASE_MINUTES` | no | Keep `waiting`/`blocked` claims visible while a human responds (default `30`; never shorter than the normal claim lease) |

## Deploy

Every push and pull request runs typecheck, the e2e suite and the build in CI
(`.github/workflows/ci.yml`); ghcr image publishing and the Azure demo deploy are gated on
the same tests (`docker.yml`, `deploy-azure.yml`). Azure authentication is **OIDC** — the
workflows exchange a short-lived GitHub token for Azure access, so no Azure password is stored
in the repository.

The hosted deployment runs on Azure Container Apps. Any container host works;
with [Fly.io](https://fly.io):

```bash
fly launch --no-deploy   # uses the provided Dockerfile + fly.toml (rename the app first)
fly secrets set DATABASE_URL=... GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... BASE_URL=https://<app>.fly.dev
fly deploy
```

## Project structure

```
packages/
  shared/   snapshot schemas/diff, agent-run schemas, policy merge and conflict detection
  cli/      local-first stma CLI and Claude Code/Codex/Cursor lifecycle adapters
  server/   Hono app: web dashboard (server-rendered JSX), auth, MCP endpoint, APIs
    src/db/       drizzle schema + Postgres/PGlite connection
    src/auth/     cookie sessions, local accounts, GitHub OAuth, scoped access tokens
    src/routes/   mcp (agent tools) · control (agent/policy/env APIs) · api (redeem + inbound
                  hooks) · stream (live SSE channel) · dashboard, agents, sessions, activity,
                  compare, docs (web) · auth
    src/domain/   enrollments, agents/runs, invites, governance, delivery and integrations
    src/lib/      scope grants, projects, entitlements, activity tracking, redaction, webhooks,
                  rate limits, github (issues), stream (live change fan-out)
    drizzle/      generated SQL migrations (applied automatically on boot)
```

## License

STMA is open-core under the [Elastic License 2.0](LICENSE) (ELv2), © 2026 Matte AI LLC:
free to use, modify and self-host; you may not offer it to third parties as a competing
hosted or managed service. Commercial-only hosted components live under the private `ee/`
package with an `UNLICENSED` manifest and separate proprietary notice; they never enter the public
mirror, npm tarballs or public image.

## Legal and security

Terms of service and the privacy policy are served at `/terms` and `/privacy`, linked from
every public footer. Vulnerability reports go to **security@stma.ai** — see
[SECURITY.md](SECURITY.md). Contribution setup and the rules this repo actually enforces are
in [CONTRIBUTING.md](CONTRIBUTING.md).

## Security model (MVP)

- Tokens are stored as SHA-256 hashes; plaintext is returned once to the redeeming client and every
  user-visible operation summary redacts it. Standard core credentials have no automatic expiry;
  managed deployments may impose and return an exact expiry.
- Snapshots carry env var **names only** — values never leave the developer's machine.
- Messages from other agents are data, not instructions: agent-facing tool output frames peer
  content as untrusted, and command requests always require the executing side's human approval.
- Cross-origin form posts are rejected; sessions are httpOnly SameSite=Lax cookies.
- Inbound GitHub webhooks require and verify `X-Hub-Signature-256` (HMAC-SHA256, secret =
  the team's inbound token). The URL token alone is not accepted on the GitHub route.
- Policy receipts are real attestations: the CLI recomputes the reported hash from the
  policy it actually applied locally, so recorded drift means genuine divergence.
