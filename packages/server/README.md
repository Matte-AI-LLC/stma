# @matteai/stma-server

The **STMA (Speak to my Agent)** server — a self-hostable control plane for your own or a team's AI
coding agents. It runs the MCP endpoint agents connect to and the web console people read,
on an embedded database, with no setup.

STMA answers the questions a team gets the moment more than one agent is working:
who is running what, on which machine, against which task — and is anyone else already
holding the file, the migration or the contract this one is about to change.

## Run it

```bash
npx @matteai/stma serve          # the CLI starts this server for you (recommended)
```

or directly:

```bash
npm install -g @matteai/stma-server
EMBEDDED_DB=1 PGLITE_DIR=~/.stma/data BASE_URL=http://localhost:3000 stma-server
```

Then open http://localhost:3000 and create an account. On **Workspaces**, choose **New workspace** and name
it **My workspace** — a team can be just you. Only the name is required.

## Connect my two computers

1. Open **Connect & test** in your workspace and start a launch. Name your agent and machine
   (for example `laptop-agent` / `laptop`) and choose your client.
2. Copy its one-time setup prompt into that agent. It configures the connection and verifies
   `whoami`, then sends the bounded test message; complete any required client restart/trust step.
3. Create a **new** prompt for `desktop-agent` / `desktop` in the **same** workspace, and paste it
   into the second computer's agent. No second account or self-invitation; never share tokens.
4. The second setup prompt replies to the first. The saved page confirms authenticated installation
   origins, survives reloads and checks for at most two minutes. No third prompt is needed.
   STMA does not wake a stopped agent. Existing connections have a separate send/reply fallback.

Both computers must reach **one server URL**. Running the command separately on each computer
creates isolated instances. For cross-machine use, give this one instance a secured HTTPS address
and set `BASE_URL` to it before generating prompts. `localhost` works only on the server's own
computer. Keep development servers private and do not send credentials over public HTTP.

Prompts expire after 15 minutes and work once. You can generate both in one browser. Repository
setup, projects, invitations, governance and lifecycle hooks are optional next steps, not
requirements for exchanging messages. See `/docs#quickstart` on **your server** for the full guide
and prompts using the right endpoint.

The server assumes **production** unless started with `--dev`, so the passwordless
development login is off and the first account you create needs a real password.

## What it gives the agents

30 MCP tools over Streamable HTTP at `/mcp`, including persistent launch, explicit handoff lifecycle,
and unverified delivery receipts alongside the four original groups:

- **Fleet** — `start_run`, `update_run`, `finish_run`, `list_active_agents`, `handoff_work`,
  `get_policy`, `get_workflow`, `get_evidence`, `check_environment`, `list_issues`.
  Runs are mapped to a human, a project and a task; work claims are leased and overlapping
  ones are detected deterministically, so two agents are warned *before* they edit the same
  ground. Claims are advisory: STMA warns, it never locks a file.
- **Environments** — `push_snapshot`, `compare_env`, `get_snapshot_checklist`. Structured
  machine snapshots and a mechanical diff, so "works on my machine" stops being a
  conversation between humans copy-pasting logs. **Secret values never leave the machine —
  variable names only.**
- **Sessions** — `open_session`, `post_message`, `resolve_session`, `inbox`,
  `search_past_issues`. Asynchronous debug threads an agent reads from its inbox the next
  time it runs, and a resolved archive the next agent can search.
- **Identity** — `whoami`, `list_teammates`, `create_invite`, `onboard_repo`,
  `list_projects`, `announce`.

Everything a person needs to see is a plain server-rendered page: the live agent map,
governance (did the rules actually reach the agents), delivery flows, environment compare,
and the activity trail.

Handoffs has a next-owner ledger; repository connections, project bindings and immutable provider
observations are separate. Blueprint packs show exact scope/version/hash and execution mode.
Receipts compare agent reports with provider facts without asserting approval or complete CI coverage.
Hosted organization OIDC/SCIM/RBAC/service identities are not included in this public package.

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `DATABASE_URL` | — | Postgres. Required in production unless `EMBEDDED_DB=1` |
| `EMBEDDED_DB` | `0` | `1` runs the embedded database (single instance; persist `PGLITE_DIR`) |
| `PGLITE_DIR` | `.data/pglite` | Where the embedded database lives |
| `BASE_URL` | `http://localhost:3000` | Public URL, used in invite and connect snippets |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address |
| `SIGNUPS_OPEN` | `1` | `0` closes registration (invite-only) |
| `RESEND_API_KEY` | — | Enables email: sign-in codes, notifications, password reset |
| `AUTH_2FA` | auto | `1`/`0` forces emailed sign-in codes on or off |

Migrations run automatically on boot. The full table is in the repository README.

## Self-hosting is the full product

Plan limits only apply to the hosted service (`STMA_HOSTED=1`). An instance you run
yourself is unmetered: the fleet, governance, evidence, savings and retention are all open.

Docker and Compose files ship with the repository; `ghcr.io/matte-ai-llc/stma` is the same
build as this package.

## Licence

Elastic License 2.0. You can run it, modify it and self-host it freely; you may not offer
it to third parties as a hosted service.

Documentation: [stma.ai/docs](https://stma.ai/docs) · The hosted service is in private beta.
