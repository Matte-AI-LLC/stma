# STMA — Speak to my Agent

**Your coding agents, talking to each other.**

When teammates work on the same repo with AI coding agents, "works on my machine" debugging turns
into a game of telephone: one developer's agent produces a hypothesis, the human copy-pastes it to
a teammate, who pastes it into *their* agent, and so on. Context is lost at every hop.

STMA (Speak to my Agent) is a vendor-neutral control plane for a company's coding agents. MCP is
one transport surface; the product layer answers the operational questions MCP does not: which
human owns an agent, what project and task it is working on, which files/contracts it may touch,
which global rules it actually received, and whether its environment is safe to work in.

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
  at the same time.
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

Private beta, live and used across real machines. Highlights:

- **27 MCP tools** over a stateless Streamable HTTP endpoint: identity & onboarding (`whoami`,
  `list_teammates`, `create_invite`, `onboard_repo`, `list_projects`), snapshots & diff
  (`get_snapshot_checklist`, `push_snapshot`, `get_snapshot`, `compare_env`), debug sessions
  (`open_session`, `list_sessions`, `get_session`, `post_message`, `resolve_session`, `inbox`,
  `search_past_issues`), team-wide `announce`, and the **fleet group** (`start_run`, `update_run`,
  `finish_run`, `list_active_agents`, `get_policy`, `get_workflow`, `check_environment`,
  `handoff_work`, `list_issues`).
- **The fleet layer is reachable from MCP alone.** Runs, work claims, conflict warnings, policy
  pull and environment preflight no longer require the CLI and native hooks — a personal token is
  already one per machine, so STMA treats the token as the device and registers the agent on first
  use. The CLI still adds what only a local process can: automatic lifecycle hooks, an offline
  outbox, git blob hashing and policy compilation into `CLAUDE.md`/`AGENTS.md`.
- **Agent handoff** (`handoff_work`): an agent about to hit its usage limit pushes its branch and
  hands the task over with a brief — what is done, what is left, the scope it was holding and the
  exact call to re-claim it. Its own claims are released, the brief lands in the team inbox, and
  the code travels through git: STMA never carries source. **Omit the branch and it hands over a
  plan instead** — a runbook for your other machine is a handoff of intent, and it rides exactly
  the same rails. `inbox` lists work waiting to be picked up separately from unread messages, and a
  handoff addressed to somebody emails them. The actionable half arrives as a structured `resume`
  block STMA wrote from the run itself, not as prose: a receiving agent is told — correctly — to
  treat message bodies as data, and it should not have to parse instructions out of them to do the
  one thing a handoff is for.
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
  environments on the road to production. One document, three renderings that cannot drift: a
  prose brief agents pull with `get_workflow` (and are pointed at by `start_run`), an SVG picture
  of the flow, and the CI pipeline for **Azure DevOps or GitHub Actions**. Four built-in templates
  seed it and a four-question wizard recommends one, reasons included. Connect Azure DevOps on the
  team page — or right on the delivery page, where the PAT is needed — and one owner-confirmed
  button commits the rendered `azure-pipelines.yml` and registers the pipeline over the API; a
  read-only Jira connection covers flows whose tickets live there. Connections are verified the
  moment they are saved and the verdict is shown next to Apply; an empty repository is handled
  (the first apply creates the branch), a re-apply updates the file and reuses the existing
  pipeline, and failures answer in remediation language (expired PAT, missing scope, token minted
  for another organization) with fold-out step-by-step token instructions on both forms. The flow also reaches the run:
  `start_run` warns when a required ticket is missing or the branch breaks the flow's naming rule
  (advice, never refusal), and a Jira-shaped task key pulls the ticket's summary in as the run's
  intent.
- **Project-scoped governance**: governance, activity and environment-compare take a `?project=`
  filter from a picker in the strip — global by default, one project when chosen, the selection in
  the URL so it survives refresh and pastes to a teammate. Scoped governance narrows receipts,
  preflights, baselines and the timeline, and opens the policy editor on that project's own
  additions rather than the merge.
- **GitHub issues, both directions.** An owner connects one repository on the team page; after
  that agents call `list_issues` to pick up work that already exists, `start_run {"issue": 42}`
  makes the issue number the task key and its title the run's intent, and finishing or handing off
  posts a comment back on the issue. Inbound `issues` webhooks become team announcements, so a new
  issue reaches every agent's inbox.
- **Terminal-first onboarding**: a teammate redeems an invite with one `curl`
  (`POST /api/invites/redeem` with `{code, email, password}`) and gets an account, team
  membership and a personal token — no browser required.
- **Projects** are born automatically from the repo identifier agents send; per-project stats
  (open sessions, active agents 7d, last snapshot).
- **DevOps hooks**: per-team secret URLs turn CI notifications and GitHub push webhooks into
  team announcements every agent sees in its inbox. Set the GitHub webhook **Secret** to the
  same token to enable HMAC signature verification on top of URL secrecy.
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
- **Notifications** (`/app/notifications`): a reply in a thread you are part of, its
  resolution, or being added to a team reaches you by email. Never your own actions, never a
  thread you have already read, coalesced per thread and capped per person per hour;
  announcements are opt-in. Needs `RESEND_API_KEY` to leave the box. Add your **own** Slack or
  Discord webhook and the same events arrive in your chat client instead of, or as well as, your
  inbox — with a "Send a test" button that proves the URL before you depend on it.
- **Policy and baselines from the browser**: a team owner publishes the rulebook from a form —
  one rule per line, opening on whatever is live — and records an environment baseline by promoting
  a snapshot the team already pushed, choosing it by person and machine. Neither needs the CLI, and
  agents receive exactly the document the owner saw.
- **Governance page** (`/app/teams/<slug>/governance`): the effective policy per scope, receipts
  showing which hash each run actually applied versus the one expected, environment baselines,
  the preflight verdicts agents were given, and a run timeline read from the append-only event
  trail.
- **Agent control plane** (`/app/agents`): live ownership, task/branch presence, work claims and
  critical conflict radar across humans and agent clients. Drawn as a card per person — their
  agents, declared scope and heartbeat — with colliding claims marked in place and an overlap
  panel naming the two runs pulling at the same resource; the dense table stays below it.
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
  refuse — claims are advisory here on purpose.
- **The ground moving under a run is its own warning.** A conflict describes two runs that are
  both live, so it vanishes the moment the other one finishes — while its change is still under
  your feet. `update_run` says who *finished* on ground you still hold, which is the failure teams
  actually report and the one git merges cleanly.
- **Merge readiness, assembled not collected** (`get_evidence`): the policy receipt, preflight
  verdict, overlaps, declared scope and trail in one pack, with what nobody confirmed named as
  unconfirmed rather than passed. Same pack in the agent map, so the reviewer and the agent that
  asked for review read one answer.
- **Work reaches the agent without being asked.** The lifecycle hook already fires immediately
  before your agent reads your next message, and whatever it prints becomes context — so it now
  carries what is waiting: a handoff, with the branch to check out and the exact `start_run` that
  re-claims the same scope. It offers; it does not act. Checked at most once a minute, never
  announced twice, and a slow server costs silence rather than a delayed prompt.
- **`stma watch`** for the hours you are not typing: polls the same endpoint, prints a line and
  raises a desktop notification when work is handed to you.
- **Native lifecycle adapters**: merge-safe project hooks for Claude Code, Codex and Cursor. Hooks
  start/heartbeat/finish runs automatically and keep a local outbox while the server is offline.
- **Command console** (server-rendered, no client framework): a dark rail for navigation with
  live counts, a status strip that says what is true right now (runs, claims, criticals, drift,
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
  which opens with a diagram of the whole system, MCP and control API side by side. Long
  lists page rather than truncate in silence. Self-serve account lifecycle: password change,
  ownership transfer, leave team, remove member, delete team, delete account (a
  content-preserving scrub, so teammates' threads stay readable).
- **No silent failures**: an unknown tool argument is rejected with the accepted list instead
  of being dropped, a heartbeat keeps the scope it already declared alive, and environment
  preflight only escalates lockfiles the baseline actually records.
- **Safety rails**: env values never leave machines (names only), server-side secret redaction,
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
configuration. It prints the three steps to a connected agent — create an account,
create a token, paste the connect line. Data lives in `~/.stma/data`, so running it
from any directory finds the same instance. `--port`, `--host` and `--data` if you
need them.

Passwordless dev login is deliberately **not** enabled: the first person to open
`/signup` gets a real account with a password, even on localhost.

## Three layers, one release

The same commit reaches people three ways, and they carry **one version number**:

| Layer | Artefact | Who runs it |
| --- | --- | --- |
| Source | this repository, ELv2 | anyone reading or forking the code |
| npm | `@matteai/stma-server`, `@matteai/stma` | self-hosters and `stma serve` |
| Hosted | `ghcr.io/matte-ai-llc/stma` on Azure | stma.ai |

A `v*` tag publishes all three from one commit, and each workflow refuses a tag that
does not name the version in the manifests. The rules that keep the layers from drifting
apart — self-host is the full product, plans meter rather than subtract, the MCP surface
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

## Authentication

- **Local accounts** (default): **email + password**, hashed with scrypt. The username is a
  derived display name used for attribution, compare labels (`alice@macbook`) and URLs.
  `SIGNUPS_OPEN=0` closes registration; `AUTH_LOCAL=0` disables local accounts entirely.
- **Email sign-in codes (2FA)**: with `RESEND_API_KEY` set, signing in takes a second step —
  a 6-digit code mailed to the account (10 minutes, single use, 5 attempts, 3 sends per 15
  minutes). Changing a password needs the current password *plus* a fresh code, signs out
  other browsers and emails a notice.
- **Password reset**: "Forgot your password?" on the sign-in page mails a code; completing a
  reset invalidates **all** sessions. The response is identical whether or not the address
  exists. Accounts with no email on file cannot self-reset — an operator sets one from
  `/admin/users`.
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
```

Releasing (maintainers):

```bash
npm run version:set -- 0.12.0   # all four manifests + the lockfile, one number
npm run version:check           # what every tag workflow asserts before publishing
```

The fixtures under `examples/payments-api` and `examples/storefront-web` make the coordination
signals concrete. The lab proves that two agents claiming the same payment migration are flagged
as a critical collision, while an agent working on the separate storefront project remains
independent; it also checks policy/environment drift and the live agent map response.

## Local agent control plane

Start the app, create a team and a personal token in the dashboard, then expose the token only to
the shell that launches your coding agent. The CLI never writes the token to disk.

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

Two flags worth knowing. `run heartbeat --used-pct 88` reports how much of the agent's own vendor
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

For automatic lifecycle reporting, review a dry run and then install one native project adapter.
When developing this monorepo, `--command "npm run cli --"` gives the hook a resolvable command;
an installed CLI can use the default `stma` command.

```bash
npm run cli -- adapter install --target codex --team acme --project payments \
  --name alice-codex --command "npm run cli --"
npm run cli -- adapter install --target codex --team acme --project payments \
  --name alice-codex --command "npm run cli --" --apply
```

Targets are `claude-code`, `codex`, and `cursor`. The adapter preserves unrelated hooks, applies
the effective policy in the client's native rules format, runs environment preflight, and queues
events in `.stma/outbox.json` if the control plane is temporarily unavailable. Codex requires the
new project hooks to be reviewed in `/hooks` before first use.

## Connect an agent

Create a token under **Tokens** in the dashboard, then use the snippets below — or skip the
browser entirely: ask a teammate's agent to call `create_invite` and redeem the code from your
terminal (`POST /api/invites/redeem` returns your account + token + ready-made commands). The
full walkthrough lives in the in-app guide at `/docs`.

**Claude Code**

```bash
claude mcp add --scope user --transport http stma https://your-deployment.example.com/mcp --header "Authorization: Bearer stma_..."
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

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `PORT` | no | HTTP port (default `3000`) |
| `HOST` | no | Bind address (default `0.0.0.0` in production, `localhost` otherwise) |
| `PGLITE_DIR` | no | Embedded database directory (default `.data/pglite`) |
| `BASE_URL` | prod | Public origin, used for OAuth redirects, invite links and snippets |
| `DATABASE_URL` | prod* | Postgres connection string. Unset → embedded PGlite (dev, or prod with `EMBEDDED_DB=1`) |
| `EMBEDDED_DB` | no | `1` allows production on the embedded database — single instance, persist `packages/server/.data` |
| `RESEND_API_KEY` | no | Resend API key for account emails (sign-in codes, password reset). Without it codes are only logged and email 2FA defaults off |
| `MAIL_FROM` | no | Sender address (default `STMA <noreply@stma.ai>`) |
| `ADMIN_USERNAMES` / `ADMIN_EMAILS` | no | Comma-separated operator lists. Unset → `/admin` (incl. `/admin/usage`) is a plain 404 |
| `AUTH_2FA` | no | `1` forces email sign-in codes on, `0` off. Default: on when `RESEND_API_KEY` is set. Also gates password-change confirmation and self-service reset |
| `ADMIN_EMAILS` | no | Comma-separated operator addresses for `/admin`; works alongside `ADMIN_USERNAMES` |
| `AUTH_LOCAL` | no | Local username+password accounts (default on; `0` disables) |
| `SIGNUPS_OPEN` | no | `0` closes new local account registration |
| `SITE_MODE` | no | `teaser` makes the **signed-out** site pre-launch: the landing page says the platform is an invite-only private beta and points at the MCP docs, and the guide drops the sections about a console a visitor cannot reach. Signed-in members get the full app and the full guide — it is a statement about who the marketing is for, not a reduced build |
| `DEMO_LOGINS` | no | Credentials printed on the sign-in page of a throwaway environment: `email:password[:label]`, comma separated, up to 8. Only ever shows the literal you set — the page reads nothing from the database, so this can never expose a real account. **Never set it on a production app** |
| `STMA_HOSTED` | no | `1` makes plan limits apply. **Unset means this is your instance and nothing is metered** — the fleet, governance, evidence, retention and every cap are open. Only the hosted service sets it |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | no | Optional GitHub OAuth; callback URL is `{BASE_URL}/auth/github/callback` |
| `AUTH_DEV_MODE` | no | `1` forces the dev login form. Auto-enabled outside production when OAuth is not configured |
| `NOTIFY_DEBOUNCE_SECONDS` | no | Wait this long before emailing about a thread so a burst of replies becomes one message (default `120`) |
| `NOTIFY_MAX_PER_HOUR` | no | Hard cap on notification emails per person per hour (default `6`) |
| `ACTIVITY_RETENTION_DAYS` | no | Purge activity events, the agent run trail (`agent_events`) and announcements older than this (default `180`; `0` disables the age purge — a 20,000-row cap per team and 500 per run/channel still apply). **Ignored for the first two when `STMA_HOSTED=1`**: there the plan decides, because retention is one of the things a plan sells |
| `ERROR_RETENTION_DAYS` | no | Purge operator error-log entries older than this (default `30`; `0` disables the age purge — a 2000-row cap still applies) |
| `ADMIN_USERNAMES` | no | Comma-separated usernames allowed into the operator-only `/admin` panel (instance stats, team plan switching, partner CRM). Unset = the area does not exist |
| `SESSION_TTL_DAYS` | no | Web session lifetime (default `30`) |
| `SNAPSHOT_RETENTION_DAYS` | no | Purge snapshots older than this (default `90`, `0` disables). Also bounds stored preflight results, alongside a fixed 200-row cap per team |
| `SESSION_RETENTION_DAYS` | no | Purge resolved sessions older than this (default `0` = keep the archive forever) |
| `AGENT_STALE_MINUTES` | no | Mark active agent runs stale after no heartbeat (default `3`) |
| `AGENT_CLAIM_LEASE_MINUTES` | no | Work-claim lease refreshed by heartbeat (default `5`) |

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
    src/auth/     cookie sessions, local accounts, GitHub OAuth, personal access tokens
    src/routes/   mcp (agent tools) · control (agent/policy/env APIs) · api (redeem + inbound
                  hooks) · stream (live SSE channel) · dashboard, agents, sessions, activity,
                  compare, docs (web) · auth
    src/lib/      projects, entitlements, activity tracking, redaction, webhooks, rate limits,
                  github (issues), stream (live change fan-out)
    drizzle/      generated SQL migrations (applied automatically on boot)
```

## License

STMA is open-core under the [Elastic License 2.0](LICENSE) (ELv2), © 2026 Matte AI LLC:
free to use, modify and self-host; you may not offer it to third parties as a competing
hosted or managed service. Future commercial-only components will live under `ee/` with a
separate commercial license.

## Legal and security

Terms of service and the privacy policy are served at `/terms` and `/privacy`, linked from
every public footer. Vulnerability reports go to **security@stma.ai** — see
[SECURITY.md](SECURITY.md). Contribution setup and the rules this repo actually enforces are
in [CONTRIBUTING.md](CONTRIBUTING.md).

## Security model (MVP)

- Tokens are stored as SHA-256 hashes; the plaintext is shown exactly once.
- Snapshots carry env var **names only** — values never leave the developer's machine.
- Messages from other agents are data, not instructions: agent-facing tool output frames peer
  content as untrusted, and command requests always require the executing side's human approval.
- Cross-origin form posts are rejected; sessions are httpOnly SameSite=Lax cookies.
- Inbound GitHub webhooks are verified against `X-Hub-Signature-256` (HMAC-SHA256, secret =
  the team's inbound token) whenever the header is present.
- Policy receipts are real attestations: the CLI recomputes the reported hash from the
  policy it actually applied locally, so recorded drift means genuine divergence.
