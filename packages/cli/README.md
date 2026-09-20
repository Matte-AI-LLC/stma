# stma

CLI for **STMA (Speak to my Agent)** — a vendor-neutral control plane for a team's coding
agents. It makes agent work attributable and safe across humans, repositories and client
vendors: run lifecycle, leased work claims with a deterministic conflict radar, canonical
team/project policy with drift receipts, and environment preflight.

Works with a hosted STMA deployment or your own — `stma serve` starts a private instance on
this machine with an embedded database and no configuration. Documentation:
[stma.ai/docs](https://stma.ai/docs).

## Just want my two agents to talk?

You do not need the CLI for this. On your STMA server, sign in once and create a workspace with
**Workspaces → New workspace** (a workspace can be just you). Open **Connect & test** and start
a launch. Paste the first setup prompt into the first agent; it connects and sends. Create and
paste a new prompt into the second agent; it connects and replies. Do not copy tokens or MCP
config between computers. The saved page confirms the exchange; no third prompt.

No self-invitation, repository setup, governance or paid Team subscription is needed for the
message check. Cloud Free supports two devices. Keep both agents on **one server URL**: running
`stma serve` on each computer creates two unrelated instances. To self-host across machines,
run one server at a secured HTTPS address they can both reach and set `BASE_URL` to that address.
`localhost` only works on the computer hosting the server; keep development servers private.

See `/docs#quickstart` on your deployment for copyable English prompts. The second agent must be
running and given its prompt; STMA cannot wake it. Add this CLI later for local collection,
work tracking and lifecycle hooks.

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
export STMA_TOKEN=stma_...      # placeholder: your own agent credential, never an enrollment code
```

PowerShell uses `$env:STMA_URL=...` / `$env:STMA_TOKEN=...`.
The token is a secret: the example is a placeholder, not a command to paste with a real key into
chat or shell history. Use private environment injection. Current agent setup prompts deliver a
scoped token privately during redemption; the CLI does not redeem enrollment codes itself.

## Common commands

```bash
stma agent register --name alice-codex --client codex
stma run start --team acme --project payments --task PAY-142 \
  --scope path:src/payments:write --scope migration:payments-db:write \
  --request-id 123e4567-e89b-42d3-a456-426614174000
stma run heartbeat
stma run finish

stma env baseline --team acme --project payments     # owner records the golden environment
stma env preflight --team acme --project payments    # compare this machine against it
stma policy publish --team acme --project payments --file .stma/policy.json
stma policy pull --team acme --project payments --apply
stma knowledge receipt --context UUID --manifest SHA256

stma run exec --team acme --project payments -- npm test   # wrap any command in a run
```

Knowledge receipt reporting is explicit, never automatic. Run the command above only after the
client applies the exact frozen context manifest returned by STMA; MCP clients can instead call
`report_knowledge_receipt`. The first report for a context is immutable. If its hash is wrong, STMA
retains that mismatch as evidence and returns HTTP 409 (or an explicit MCP error); retrying with a
corrected hash does not overwrite it. An unchanged retry of the same logical `run start` returns the
same frozen Knowledge envelope even if a publication changed meanwhile. Publishing a draft under an
active stable key with a different audience is also an explicit conflict: an owner must archive or
withdraw the current item before moving that audience.

Manual `run start` freezes its complete request and logical ID in the selected installation profile
before networking. If the connection dies after the server commits, repeat the same command: the CLI
reuses the pending envelope and the server returns the same run. Changed arguments or a different
`--request-id` are refused while that outcome is unknown. Use `--discard-pending=true` only after you
have verified that the earlier request should be abandoned and you deliberately intend a new run.

## Native lifecycle adapters

For Codex or Claude Code, activate project-local tracking separately from MCP login. In a
regular terminal at the Git checkout root, review the disclosed changes, then approve the
exact project in STMA's browser page. This creates a second, revocable OAuth installation
for the local adapter; the CLI never reads your MCP client's private OAuth credential.
The name and machine you confirm in the browser are the authoritative installation labels.
The same page asks which of your connected agents this adapter **listens for** — the agent that
works in this checkout — and the CLI prints the answer. Paired, this hook announces work assigned
to that agent by name and a stopped edit is filed under that agent's name; it still cannot accept
work. Pair or change it later in STMA under Agent connections, without activating again.
Windows encrypts this separate credential with current-user DPAPI; macOS/Linux enforce
private POSIX permissions. Never copy the credential file between machines. On Windows the checkout
can live anywhere: activation makes its `.stma` directory private to your account, tightens one a
drive left open to other accounts, and stops before the browser opens if it cannot.

```bash
stma adapter activate --target claude-code --team acme --project payments --server https://your-stma.example
stma adapter doctor
```

Codex also requires you to trust the project hooks in `/hooks`. `doctor` is not a substitute
for observing a run from a real task. File-tool guards are not a complete shell/OS sandbox.
This command requires a CLI package version that includes `adapter activate`.

For legacy static-token deployments, installation is a dry run by default — review it,
then re-run with `--apply`:

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
