# Payments API: real two-device acceptance fixture

This dependency-free ESM project is the executable baseline for STMA's real human acceptance lab.
It models a payment aggregate and one PostgreSQL migration, and runs on Node.js 20 or newer.
The baseline is intentionally small enough that a person can review every resulting line.

```bash
cd examples/payments-api
npm test
```

That command must pass before either device starts. The fixture does not connect to a database,
make a network request, read credentials, or deploy anything.

## Reproduce an environment-dependent failure

```bash
npm run check:environment --prefix examples/payments-api
```

Run this command from the repository root. Without the environment variable name `STMA_HUMAN_LAB`,
it exits with status 1 and names the missing requirement. When the name is present, it actually
runs a create/authorize/capture smoke against the payment domain and exits successfully. It never
reads or prints the variable's value; use the harmless value `1` for this lab.

This is a deliberate fixture-only environment gate, not a requirement of the underlying payment
domain or a real payment-provider connection. Keep both devices on the same SHA: A has the name,
B initially does not; collect the real snapshots, diagnose the difference, add the name to B's
test environment, and rerun the exact same command. Save both exit statuses and outputs. Ensure
the actual agent/check command inherits the intended test-shell environment.

`npm test` remains independent of the caller's sentinel: its subprocess tests exercise absent,
present and empty values in isolated environments, including a check that values are never echoed.

## What the lab proves

[`scenario/agent-claims.json`](scenario/agent-claims.json) defines two independent tasks performed
by two real agents on two physical devices:

- Device A (`PAY-201`) adds idempotent payment-attempt tracking.
- Device B (`PAY-202`) adds bounded refunds.

Both tasks claim `src/domain/payment.js`, `migrations/**`, and the logical `payments-db` migration
chain. STMA must warn Device B about the live overlap and rank the migration collision critical.
Each task also claims its own new test file: `test/payment-attempts.test.js` for PAY-201 and
`test/refunds.test.js` for PAY-202. Those paths do not overlap, so there remain exactly three shared
claims. Four scope items and three path claims fit the committed policy budget; baseline tests
remain unchanged.
The project policy also requires a human decision before migration work. Neither signal is a file
lock: the acceptance criterion is that the real agent stops before editing and reports the exact
reason to its human.

The committed [policy](.stma/policy.json) adds one safe environment probe:
`STMA_HUMAN_LAB`. Snapshots send the variable's **name only**, never its value. Leave it absent on
Device B for the first preflight, confirm that STMA reports a critical missing-name violation, then
set it and retry. OS/shell differences should remain visible as non-blocking context.

## Safety boundary

Use a throwaway STMA team or project and separately revocable, project-scoped connection prompts
for the two installations. Work only on `human-lab/*` branches. Do not merge the experiment into
the product's `main` branch and do not point either task at a production deployment. Tokens never
belong in this repository, a command argument, a prompt generator, or a screenshot.

The project must exist before STMA can mint an exact-project prompt. If `payments-api` is absent,
an owner first creates/binds it from Repositories or publishes the committed project policy under
that exact name; only then create the two connection prompts. Do not solve the bootstrap by leaving
the test agents team-scoped.

## Generate the prompts

Run these commands from the repository root. The helper accepts labels only and never accepts a
token:

```bash
npm run human-lab:check
npm run human-lab:prompt -- bundle --team TEAM --device-a DEVICE_A --device-b DEVICE_B
```

The bundle command writes a new temporary directory containing eight stage prompts, a run sheet,
and a results file initialized to `NOT_RUN`. It generates one unique namespace for all three lab
branches. Optional `--run LABEL --out NEW_DIRECTORY` chooses the namespace and a new output path;
an existing output directory is never overwritten. Preparing a bundle performs no enrollment,
server request, git operation, or human acceptance test. Human-decision files are templates, not
approval. Never place credentials in this output.

Individual prompts remain available; use the same `--run LABEL` on all of them when selecting a
unique branch namespace:

```bash
npm run human-lab:prompt -- baseline --team <TEAM_SLUG> --project payments-api --device <DEVICE_A>
npm run human-lab:prompt -- device-a --team <TEAM_SLUG> --project payments-api --device <DEVICE_A>
npm run human-lab:prompt -- device-b --team <TEAM_SLUG> --project payments-api --device <DEVICE_B>
```

First paste the STMA-generated one-time connection prompt into each agent. Then paste the generated
baseline/task prompt for that machine. Do not combine the two: the enrollment prompt is secret and
single-use; the task prompt is reproducible and contains no credential.

## Expected order

1. Both devices check out the same clean commit. Device A has the `STMA_HUMAN_LAB` name; Device B
   deliberately does not.
2. Device A runs the baseline prompt and pushes a snapshot. The owner verifies that
   `.stma/policy.json` is the effective `payments-api` policy and promotes Device A's snapshot as
   the project baseline.
3. Device A runs the `device-a` prompt. It must confirm the policy receipt, pass preflight, report
   that migration work needs approval, and stop before editing.
4. Before approving A, Device B runs the `device-b` prompt while A's run is still active.
   It must report the critical collision and the missing environment-variable name, then make no
   edit. Keep A's lease alive while waiting; repeat the observation if its lease expired.
   Close B's blocked run after recording the observation.
5. The human approves `PAY-201` only. Device A implements, tests, pushes its branch, and calls
   `handoff_work` with an honest brief.
6. Set `STMA_HUMAN_LAB` on Device B, push a fresh snapshot, and rerun preflight. Accept Device A's
   handoff, inspect the remote/dirty worktree, reclaim the offered scope, run all tests, and complete
   the handoff lifecycle.
7. Land `PAY-201` only on a throwaway `human-lab/integration` branch. Start `PAY-202` again from the
   new base. It should now have no live collision but may report stale-ground evidence. The human
   approves it and requires migration `003_refunds.sql`, not a second `002`.
8. Device B implements, tests, pushes, and hands the branch back to Device A for the final review.
   The final integration branch must pass every baseline, PAY-201, and PAY-202 test.

Capture the run IDs, policy hash/result, preflight summaries, critical conflict owner/task, handoff
session IDs, branch SHAs, and final test output. A green unit test without those product records is
not a pass for this lab. A VM does not replace two physical devices, and two devices operated by
one person do not prove independent-user usability or multi-user authorization.
