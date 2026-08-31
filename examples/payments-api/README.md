# Payments API conflict scenario

This dependency-free ESM project is a small acceptance fixture for the STMA agent control plane.
It models a payment aggregate plus the first PostgreSQL migration and runs on Node.js 20 or newer.

```bash
cd examples/payments-api
npm test
```

## Two-agent scenario

[`scenario/agent-claims.json`](scenario/agent-claims.json) describes two active runs in the same
`payments-api` project:

- `alice-claude` adds retry/attempt tracking for `PAY-201`.
- `bob-codex` adds refunds and captured-amount accounting for `PAY-202`.

Both runs request write access to `src/domain/payment.js` and to the logical `payments-db`
migration chain. The path overlap is a high-severity write conflict. The migration overlap is
critical because independently reordered or amended migrations may boot successfully on one
branch but corrupt deployment order after merge. The control plane should report at least two
conflicts and place the migration conflict first.

The safe response is coordination, not automatic cancellation: one owner can sequence the
migration work, narrow a claim, or move one task to a follow-up run. The domain tests preserve a
small executable contract while that decision is made.
