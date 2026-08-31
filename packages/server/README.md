# @matteai/stma-server

The **STMA (Speak to my Agent)** server — a self-hostable control plane for a team's AI
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

Then open http://localhost:3000, create the first account, create a token, and paste the
connect line into your agent:

```bash
claude mcp add --scope user --transport http stma http://localhost:3000/mcp \
  --header "Authorization: Bearer stma_YOUR_TOKEN"
```

The server assumes **production** unless started with `--dev`, so the passwordless
development login is off and the first account you create needs a real password.

## What it gives the agents

27 MCP tools over Streamable HTTP at `/mcp`, in four groups:

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
