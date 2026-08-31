# Contributing

Thanks for looking. STMA is open-core under the [Elastic License 2.0](LICENSE):
you can run it, modify it and self-host it; you cannot offer it to third parties
as a competing hosted service.

## Getting it running

```bash
npm install
npm run dev      # embedded PGlite, dev login, http://localhost:3000
npm test         # the whole suite, ~30s, no external services
```

There is no database to install and no account to create — dev mode signs you in.
On Windows, `run-local-demo.bat` starts an isolated instance on its own port and
data directory.

To fill an instance with a believable organisation to click through:

```bash
SEED_PASSWORD=... npm run seed:demo -w @matteai/stma-server -- --url http://localhost:3000
```

## The rules that matter here

1. **Docs move with the code, in the same change.** If behaviour changes, update
   whichever of these it touches: `README.md`, `ROADMAP.md`, the in-app guide
   (`packages/server/src/routes/docs.tsx`), `docs/deploy-azure.md`, `CLAUDE.md`.
   Documentation that lags the code is worse than none.
2. **Tests before deploy.** `npm run typecheck` and `npm test` must be green. A bug
   fix needs a test that fails without the fix — several defects in this codebase
   were "fixed" twice because the first fix had no such test.
3. **Migrations**: edit `packages/server/src/db/schema.ts`, run
   `npx drizzle-kit generate` in `packages/server`, commit the generated SQL. They
   apply automatically on boot.
4. **Never commit secrets.** `.env.azure` and anything matching `.env.*` is
   gitignored. Personal access tokens use the `stma_` prefix. "It only works on my
   laptop" is not an exemption — a token in a commit outlives the instance it opened.
5. **Stay inside the design system** (`packages/server/src/ui/styles.ts`). UI copy
   is English.
6. **Everything in this repository is written to be read publicly.** Company-internal
   material — pricing work, cost models, competitive reads, infrastructure
   runbooks — lives in a separate private repository and never lands here, not even
   as a path in a comment. The public tree is built from an explicit allowlist
   (`scripts/public-tree.mjs`) and a scan refuses identifiers that must not ship.

## Things worth knowing before you change agent-facing code

The MCP tools have a house style: **errors instruct**. "Push your own snapshot
first" beats "400 Bad Request". Nothing may fail silently — unknown tool arguments
are refused with the accepted list rather than dropped, because an agent that gets
"ok" believes the call did what it asked.

Claims, policy receipts and preflight results are signals a human acts on. A false
alarm costs more than a missing one: a radar nobody trusts is worse than no radar.

## Pull requests

Small and focused. Explain what breaks without the change. CI runs typecheck,
tests and the build on every push; a nightly job runs the same suite on Linux,
Windows and macOS, plus a lab that drives three real machines against a live
instance.

Security issues go to **security@stma.ai**, not to a public issue — see
[SECURITY.md](SECURITY.md).
