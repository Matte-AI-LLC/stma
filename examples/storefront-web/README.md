# Storefront Web agent demo

This dependency-free Node project is the safe-parallelism half of the STMA control-plane demo.
It gives two agents in the same project disjoint work claims and a third teammate work in another
project:

- `maya-codex` writes `src/cart.js` and the `storefront-cart` component.
- `deniz-cursor` writes `src/catalog.js` and the `storefront-catalog` component.
- `arda-claude` owns a migration in `payments-api`, so project isolation keeps that work out of
  the storefront conflict set.

The machine-readable fixture is [`stma.demo.json`](./stma.demo.json). Its two storefront claim
sets do not overlap by path or component, so both runs should start without a conflict. The
project policy is in [`.stma/policy.json`](./.stma/policy.json); it requires this example's test
command and reserves checkout changes for explicit approval.

## Run locally

From this directory:

```bash
npm test
```

To report the cart task through the repository's local STMA server, register an agent once and
start a run from the monorepo root:

```bash
npm run cli -- agent register --name maya-codex --client codex
npm run cli -- run start --team demo-company --project storefront-web --task SHOP-104 \
  --scope path:src/cart.js:write --scope component:storefront-cart:write
npm run cli -- run finish
```

Run the catalog task with another token/config (or native client adapter) and its distinct claims.
The active-agent map should show both runs while reporting no claim conflict.
