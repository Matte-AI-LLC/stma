# stma

CLI for **STMA (Speak to my Agent)** — a vendor-neutral control plane for a team's coding
agents. It makes agent work attributable and safe across humans, repositories and client
vendors: run lifecycle, leased work claims with a deterministic conflict radar, canonical
team/project policy with drift receipts, and environment preflight.

Works with a hosted STMA deployment or your own — `stma serve` starts a private instance on
this machine with an embedded database and no configuration. Documentation:
[stma.ai/docs](https://stma.ai/docs).

## Install

```bash
npm install -g @matteai/stma
# or run it without installing
npx @matteai/stma --help
```

The package is scoped (`@matteai/stma`) because the bare `stma` name is blocked by npm's
similarity check — the installed command is still `stma`.

## Configure

The CLI reads two environment variables and never writes your token to disk:

```bash
export STMA_URL=https://your-deployment.example.com
export STMA_TOKEN=stma_...      # personal access token from the dashboard
```

PowerShell uses `$env:STMA_URL=...` / `$env:STMA_TOKEN=...`.

## Common commands

```bash
stma agent register --name alice-codex --client codex
stma run start --team acme --project payments --task PAY-142 \
  --scope path:src/payments:write --scope migration:payments-db:write
stma run heartbeat
stma run finish

stma env baseline --team acme --project payments     # owner records the golden environment
stma env preflight --team acme --project payments    # compare this machine against it
stma policy publish --team acme --project payments --file .stma/policy.json
stma policy pull --team acme --project payments --apply

stma run exec --team acme --project payments -- npm test   # wrap any command in a run
```

## Native lifecycle adapters

Install merge-safe project hooks so runs start, heartbeat and finish automatically. The
install is a dry run by default — review it, then re-run with `--apply`:

```bash
stma adapter install --target claude-code --team acme --project payments --name alice-claude
stma adapter install --target claude-code --team acme --project payments --name alice-claude --apply
```

Targets: `claude-code`, `codex`, `cursor`. Existing hooks in your client config are
preserved; only STMA's own entries are replaced. Lifecycle events are queued in a bounded
local outbox when the server is unreachable.

## Privacy

Environment snapshots carry tool versions, lockfile hashes and environment variable
**names** — never values, never file contents. Device identity is a one-way hash; your
hostname and username are not sent.

## License

[Elastic License 2.0](./LICENSE) — © 2026 Matte AI LLC.
