# stma

CLI for **STMA (Speak to my Agent)** — a vendor-neutral control plane for a team's coding
agents. It makes agent work attributable and coordinated across humans, repositories and client
vendors: run lifecycle, leased work claims with a deterministic conflict radar, canonical
team/project policy with drift receipts, and environment preflight.

Works with a hosted STMA deployment or your own — `stma serve` starts a private instance on
this machine with an embedded database and no configuration. Documentation:
[stma.ai/docs](https://stma.ai/docs).

## Just want my two agents to talk?

You do not need the CLI for this. On your STMA server, sign in once and create a workspace with
**Workspaces → New workspace** (a workspace can be just you). Connect each agent from that
workspace's **Agent connections**: add the server's `/mcp` address in that client and approve it in
the browser, or, for a Claude Code or Codex checkout, run the `stma connect` command it issues
(below). Then start the **Test** on the same page and paste its sender check into the first agent
and its reply check into the second; they carry a launch ID, not a credential. Do not copy tokens or MCP
config between computers. The saved page confirms the exchange; no third prompt.

No self-invitation, repository setup, governance or paid Team subscription is needed for the
message check, and Cloud Free covers it. Keep both agents on **one server URL**: running
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

The CLI reads two environment variables and never writes `STMA_TOKEN` to disk:

```bash
export STMA_URL=https://your-deployment.example.com
export STMA_TOKEN=stma_...      # placeholder: your own agent credential, never an enrollment code
```

PowerShell uses `$env:STMA_URL=...` / `$env:STMA_TOKEN=...`.
The token is a secret: the example is a placeholder, not a command to paste with a real key into
chat or shell history. Use private environment injection. The legacy setup prompt delivers a
scoped token privately during redemption; the CLI redeems a code only in `stma connect`, which a
person runs in a terminal.

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

For a Claude Code or Codex checkout, `stma connect CODE --server ORIGIN` — the ten-minute, one-use
command **Agent connections** issues, run in a terminal at the checkout root and never inside the
agent — adds the MCP entry and these hooks as one installation. For an agent already connected
through the browser, activate project-local tracking separately from MCP login. In a
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

## Persistent local worker

After configuring a dedicated checkout with `stma worker configure` and having the installation
owner enable its target, you can opt in to a per-user service from that checkout:

```bash
stma worker service-install --apply
stma worker service-status
stma worker service-start
stma worker service-stop
stma worker service-uninstall
```

The implementation provides a Windows interactive-user logon task, a Linux systemd user unit, and
a macOS GUI LaunchAgent. These are per-user service definitions. Inert service lifecycle checks
passed on Windows and macOS; live worker operation on these services and Linux native lifecycle
remain unaccepted. Installing the macOS agent can start the worker
immediately. These managers need the appropriate user session or user manager; the service does not
wake the machine. On Linux a user
manager configured for lingering can remain active after logout. Service definitions contain no
credentials. The selected STMA profile and the provider API-key environment variable must already
be available to the service's own user environment; a variable set only in an interactive shell
may not be inherited. Authentication or a disabled target can prevent work from starting.

`service-stop` disables future automatic starts and asks the recorded worker owner to stop. Inspect
`stma worker status` and its journal for the observed result; a request is not proof that an active
child process stopped. Uncertain execution keeps the checkout quarantined. Uninstall verifies the
registered definition and refuses while the service or worker may still be running. The service
does not change the worker's existing runtime limits or turn completion into delivery acceptance.

The default managed worker uses Claude Code's restricted file-tool profile. The experimental
`--runtime codex-read-only-v1` profile supports the complete official Codex CLI 0.166.0 native
package on Windows, including its manifest and adjacent sandbox helpers, with a separately
prepared elevated sandbox and a restricted child credential. `stma worker doctor` shows the
separate setup command; STMA does not run it. Configuration requires `--model MODEL_ID`; the
selected id is stored locally and passed as fixed arguments on every launch. `status` and `doctor`
show the requested model, not a provider-confirmed model or cost limit. Codex launches explicitly
request the provider's standard service tier; that is not a spending cap. Existing experimental
configurations without a model must be replaced with a newly configured dedicated checkout.
Use a separate approved project token through `STMA_TOKEN` and `STMA_URL`; ordinary Codex
`stma connect` installs a `.codex` layer that this managed profile refuses. The isolated Codex home must have no `config.toml`
or `hooks.json`, and the dedicated checkout must not have a `.codex` layer. Before every launch,
STMA checks that selected credential paths cannot be read and that writes are denied. Other host
files may remain readable. One outer turn, runtime and output are bounded; there is no hard
tool-call or token ceiling. The bounded model report is not delivery or acceptance. This profile
has passed controlled hosted Windows sandbox boundary and descendant-stop checks. Two consecutive
controlled Windows GPT-6 Sol read-only analysis runs passed with process cleanup. A separate
active-cancellation
check passed its fail-closed checks: it stopped the process and revoked the child credential, but
left the execution `dispatch_unknown`, the target quarantined and the owner lock retained; no
completed run or delivery was recorded. This does not establish ordinary Codex connect, OAuth or
credential-store acceptance, live OS service-worker operation, customer acceptance or production
acceptance.
The prompt permits local read-only offline commands to inspect the dedicated checkout and carry out
read-only assignment steps within existing sandbox permissions; STMA MCP access remains limited to
scoped read-only tools. Generic
instructions about assignment lifecycle are reference text, and the supervisor owns run tracking. The
child cannot change Work or handoff state, and this clarification grants no file or network
permissions.
The provider key remains in the explicitly named environment variable; never put it in argv.
The serialized Windows Codex launch request is limited to 1,048,576 UTF-16 code units, including
arguments and prompt. Oversized requests are refused before the execution's launcher starts;
this transport limit is separate from model tokens, tool calls and billing. A complete request
can start without waiting for the parent's input stream to close.
The Windows launcher uses Windows PowerShell's built-in modules; inherited user module
search paths are excluded from the worker environment.
Codex shell commands use an empty inherited environment with an explicit, validated Windows
`SystemRoot` value so native runtimes can initialize. Provider and STMA credentials are not
included in that shell environment.
Use a dedicated Windows host or VM with independent local accounts. Codex provisioning rotates
machine-wide sandbox-account passwords, so a second home can invalidate an existing desktop
sandbox. `doctor` reports blocked setup and omits its setup command when it detects another known
home's sandbox marker/credential file; it does not read that file or discover every custom home.
Do not copy another home's sandbox credentials to work around this requirement.

## Privacy

Environment snapshots carry tool versions, lockfile hashes and environment variable
**names** — never values, never file contents. Device identity is a one-way hash; your
hostname is not sent, and your username only as the default agent name `<username>-<target>`
of `adapter install` when you pass no `--name`.

## License

[Elastic License 2.0](./LICENSE) — © 2026 Matte AI LLC.
