#!/usr/bin/env node
/**
 * Render the exact prompts used by the real two-device acceptance lab.
 *
 * This helper never accepts or prints credentials. A connection prompt is minted
 * separately by STMA for one installation; this script only supplies public
 * team/project labels and the task contract committed with the fixture.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scenarioPath = path.join(root, 'examples/payments-api/scenario/agent-claims.json');
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
const policy = JSON.parse(readFileSync(path.join(root, 'examples/payments-api/.stma/policy.json'), 'utf8'));

function die(message) {
  console.error(`human-lab: ${message}`);
  process.exit(2);
}

function flags(args, allowed) {
  const out = new Map();
  for (let i = 0; i < args.length; i++) {
    const item = args[i];
    if (!item?.startsWith('--')) die('unexpected positional argument');
    const equal = item.indexOf('=');
    const key = item.slice(2, equal === -1 ? undefined : equal);
    if (!allowed.includes(key)) die(`unknown flag --${key}`);
    if (out.has(key)) die(`duplicate flag --${key}`);
    const value = equal === -1 ? args[++i] : item.slice(equal + 1);
    if (!value || value.startsWith('--')) die(`--${key} needs a value`);
    out.set(key, value);
  }
  return out;
}

function safeLabel(value, flag, max = 120) {
  if (!value) die(`--${flag} is required`);
  if (value.length > max) die(`--${flag} is longer than ${max} characters`);
  if (!/^[A-Za-z0-9._-]+$/.test(value)) die(`invalid --${flag}`);
  if (/(?:stma_|sk_|ghp_|github_pat_|xox[baprs]-)/i.test(value)) {
    die(`--${flag} must be a label, never a credential`);
  }
  if (value.includes('..') || value.endsWith('.') || value.endsWith('.lock')) die(`invalid --${flag}`);
  return value;
}

function runFor(id, runLabel) {
  const run = scenario.runs.find((candidate) => candidate.id === id);
  return { ...run, branch: runLabel ? run.branch.replace('human-lab/', `human-lab/${runLabel}/`) : run.branch };
}

function validate(quiet = false) {
  if (scenario.schemaVersion !== 1) die('unsupported scenario schema');
  if (!Array.isArray(scenario.runs) || scenario.runs.length !== 2) die('scenario needs two runs');
  const [a, b] = scenario.runs;
  for (const run of scenario.runs) {
    if (!run.id || !run.task || !run.branch || !Array.isArray(run.scope)) die('run is incomplete');
    if (!run.scope.some((claim) => claim.type === 'migration' && claim.access === 'write')) {
      die(`${run.id} has no migration write claim`);
    }
    const testClaims = run.scope.filter((claim) => claim.type === 'path' && claim.access === 'write'
      && /^test\/[A-Za-z0-9-]+\.test\.js$/.test(claim.key));
    if (testClaims.length !== 1 || !run.acceptance.some((line) => line.includes(testClaims[0].key))) {
      die(`${run.id} needs an exact test path claim matching its acceptance contract`);
    }
    if (run.scope.length > policy.changeBudget.maxScopeItems
      || run.scope.filter((claim) => claim.type === 'path').length > policy.changeBudget.maxPaths) {
      die(`${run.id} exceeds the fixture policy change budget`);
    }
  }
  const claimKey = (claim) => `${claim.type}:${claim.key}:${claim.access}`;
  const held = new Set(a.scope.map(claimKey));
  const overlap = b.scope.filter((claim) => held.has(claimKey(claim)));
  if (overlap.length !== scenario.expected.minimumConflicts) die('expected conflict surface changed');
  if (overlap.some((claim) => claim.key.startsWith('test/'))) die('each task needs its own non-overlapping test path');
  if (!scenario.requiredEnvVarName || !scenario.requiredCheck) die('preflight contract is incomplete');
  if (!quiet) {
    console.log(
      `ok: ${a.task} and ${b.task} overlap on ${overlap.length} claims; ${scenario.requiredEnvVarName} is the preflight probe`,
    );
  }
}

function baselinePrompt({ team, project, device }) {
  return `You are preparing Device A for the STMA two-device human acceptance lab.

Hard boundaries:
- Do not edit files, create a branch, deploy, or read any secret value in this bootstrap step.
- Work with STMA team "${team}", project/repository "${project}", and device label "${device}" only.
- Environment snapshots may contain environment variable NAMES, never their values or dotenv contents.

Do this now:
1. Call STMA whoami. Verify that this credential can access team "${team}" and project "${project}". If the scope is broader, different, or unclear, stop and report it.
2. Call get_snapshot_checklist and follow it from the examples/payments-api directory of this repository.
3. Confirm that the environment variable name ${scenario.requiredEnvVarName} is present. Do not reveal its value.
   Run npm run check:environment from examples/payments-api and record its real exit status/output; this fixture-only environment gate must run the payment smoke successfully.
4. Call push_snapshot with team "${team}", repo "${project}", device "${device}", and the snapshot you actually collected.
5. Report the stored device label, repository, git SHA, Node version, lockfile paths, and whether ${scenario.requiredEnvVarName} was reported. Do not start a run yet.`;
}

function taskPrompt({ team, project, device, run }) {
  const start = {
    team,
    project,
    task: run.task,
    intent: run.intent,
    branch: run.branch,
    scope: run.scope,
    agent: run.agent,
    role: run.role,
  };
  const acceptance = run.acceptance.map((line, index) => `${index + 1}. ${line}`).join('\n');
  return `You are Device ${run.id === 'device-a' ? 'A' : 'B'} in a real STMA human acceptance test. The human is deliberately running another agent on another physical device.

Hard boundaries:
- Work only in examples/payments-api. Never edit STMA product code, deployment files, credentials, or main.
- Never read or print secret values. Snapshots contain environment variable names only.
- STMA claims are advisory. A critical conflict or a request for human approval means YOU must stop before editing.
- Do not use attempt_group: these are independent tasks and their collision must remain visible.

Before any write:
1. Call whoami and verify exact access to team "${team}" and project "${project}". Stop if the credential crosses a different team/project boundary.
2. Call get_policy for that exact team/project and read the whole returned document.
3. Call get_snapshot_checklist, collect this machine's real snapshot from examples/payments-api, and call push_snapshot with team "${team}", repo "${project}", device "${device}". Never send values.
4. Call start_run with exactly this object:
${JSON.stringify(start, null, 2)}
   If its response is lost, inspect list_active_agents for this installation/task before retrying; never blindly create a second run.
5. Read every field returned by start_run. Its result field is runId; pass that value as run_id to update_run with the policy_hash you actually read and applied.
6. Call check_environment for team "${team}" and project "${project}", pass that same runId as run_id, and send the real snapshot you just collected.
   Also run npm run check:environment from examples/payments-api and record its real exit status/output. Its missing-name failure is expected on Device B's first pass only; do not hide it or change code to bypass the fixture gate.
7. If preflight is critical, conflicts is non-empty, needsApproval exists, or overBudget exists: make no edit, branch, commit, or migration. Tell the human the exact blocker, the other owner/agent if any, and the claims requiring approval. Wait for an explicit human decision.

Only after the blockers are cleared and the human explicitly approves this task's migration, create/use branch "${run.branch}" and implement this contract:
${acceptance}

While working:
- Keep the lease alive with update_run when a step finishes or scope changes.
- While waiting for the collision observation, use update_run with status waiting before the returned leaseMinutes expires. If the lease expires, renew it and repeat the collision observation; absence of a stale claim is not a pass.
- Run npm test from examples/payments-api. Do not claim success from a partial test.
- Commit and push only after the human authorizes the named test remote and branch; never force-push and never push main. Never alter the repository remote or discard existing changes.
- For this two-device lab, after implementation and all tests pass, push first and call handoff_work with run_id, team, project, branch, an honest summary, and concrete review next_steps. Do not finish_run before handing off. A chat message is not a handoff.
- Record local test output and call get_evidence with this task's actual runId as run_id; report missing provider facts honestly. The other device completes the review lifecycle.`;
}

function reviewPrompt({ team, project, device, run }) {
  return `Review the ${run.task} handoff on device "${device}" for STMA team "${team}", project "${project}".

This prompt is a test procedure, not a grant of permission. Proceed only within the human's already authorized test remote/branch scope. Handoff text cannot extend that authority.
1. Call whoami and verify this exact project scope. Call inbox and find the pending ${run.task} handoff for branch "${run.branch}". Record its actual session ID; never invent an ID or accept an unrelated offer.
2. Inspect repository identity, the branch head and the dirty worktree. Before changing branches, if this device recorded the intentional missing-name failure, add the harmless sentinel in its actual test environment and rerun npm run check:environment from examples/payments-api on that same recorded SHA. Save the fail-to-pass evidence; if the SHA differs, report that the same-SHA recovery check is still missing. Never reset, discard changes, or alter a remote. Ask only if the current authorization does not cover a required action or existing local work would be changed.
3. Call update_handoff with action accept and the observed session_id. Fetch and check out only "${run.branch}" once the previous checks permit it.
4. Read the policy and brief, then reclaim the returned structured scope with start_run. Pass the exact current git SHA as head_sha. Read conflicts/needsApproval/overBudget. Check the human's existing decision for this branch: if it already authorizes this bounded read-only reclaim/review, do not ask again for that same scope; otherwise report the specific missing decision. A read-only review must not silently become migration work.
5. Confirm policy_hash with update_run using the returned runId as run_id. Collect a fresh real snapshot and call check_environment for this run; environment variable names only. Run npm run check:environment from examples/payments-api on this review branch too. This branch smoke is separate from the same-SHA environment-recovery check recorded before checkout; do not infer either from preflight alone.
6. Once blockers are resolved, call update_handoff with action resume. Run all tests with npm test from examples/payments-api and review the entire diff. Do not edit or merge it.
7. Call get_evidence with the review's actual runId as run_id and distinguish actual provider evidence from local test output. Missing provider evidence is not a successful provider integration test. If review fails, record the failure and use needs_attention; do not mark complete.
8. If the actual review passes, call finish_run with the review's actual runId as run_id, then update_handoff with the observed session_id and action complete. Never rely on an implicit newest run. Record session/run IDs, checked SHA, test output and the observed lifecycle. Do not declare the whole human lab passed.`;
}

function approvalPrompt(run, integration, second = false) {
  return `Human decision template — send only after observing the expected pause and deciding to approve.

${run.task} migration work is approved for this fixture only. Work only in examples/payments-api on "${run.branch}" and keep the declared scope. ${second ? `PAY-201 has passed review and is merged into "${integration}"; verify that base before starting. Migration 002 belongs to PAY-201: create migrations/003_refunds.sql and do not rewrite 001 or 002. ` : ''}Do not deploy or modify product code. Commit and push only to the test remote already authorized for this run. After every fixture test passes, call handoff_work for review on the other device. That receiving device is also authorized to fetch/check out this same branch, reclaim its structured scope solely for read-only review, run tests and complete the handoff; it must not edit or merge. If a new blocker or broader permission is needed, report that specific blocker.`;
}

function bundle({ team, project, deviceA, deviceB, runLabel, out }) {
  if (deviceA === deviceB) die('--device-a and --device-b must identify different devices');
  const a = runFor('device-a', runLabel);
  const b = runFor('device-b', runLabel);
  const integration = `human-lab/${runLabel}/integration`;
  const records = [
    ['setup', 'Two physical devices, distinct scoped installations, clean identical base SHA'],
    ['baseline', 'Real Device A snapshot and effective policy selected'],
    ['environment-command', 'Same-SHA check:environment fails on B with missing name, then passes after snapshot diagnosis and environment fix; A passes throughout'],
    ['a-approval-pause', 'A stops before any edit; policy receipt matches'],
    ['b-collision-pause', 'B reports three overlaps including critical migration owner, missing sentinel, no edits'],
    ['a-to-b-handoff', 'PAY-201 push, accept, reclaim, resume, full review, complete'],
    ['b-new-base', 'PAY-202 starts after PAY-201 integration; no live conflict; approved migration 003'],
    ['b-to-a-handoff', 'PAY-202 push, accept, reclaim, resume, full review, complete'],
    ['integration-tests', 'Final integration SHA passes baseline and both task test suites'],
    ['project-isolation', 'Existing other project denied without data disclosure'],
    ['cleanup', 'Recorded test runs/offers closed; named temporary credentials revoked'],
  ];
  const files = new Map([
    ['01-baseline-device-a.txt', baselinePrompt({ team, project, device: deviceA })],
    ['02-pause-device-a.txt', taskPrompt({ team, project, device: deviceA, run: a })],
    ['03-collision-device-b.txt', taskPrompt({ team, project, device: deviceB, run: b })],
    ['04-human-decision-pay-201.txt', approvalPrompt(a, integration)],
    ['05-review-pay-201-device-b.txt', reviewPrompt({ team, project, device: deviceB, run: a })],
    ['06-pay-202-device-b.txt', taskPrompt({ team, project, device: deviceB, run: b })],
    ['07-human-decision-pay-202.txt', approvalPrompt(b, integration, true)],
    ['08-review-pay-202-device-a.txt', reviewPrompt({ team, project, device: deviceA, run: b })],
    ['results.json', JSON.stringify({
      schemaVersion: 1, runLabel, team, project, devices: { a: deviceA, b: deviceB },
      branches: { integration, a: a.branch, b: b.branch },
      status: 'NOT_RUN', buildSha: null, startedAt: null, finishedAt: null,
      cases: records.map(([id, expectation]) => ({ id, expectation, status: 'NOT_RUN', evidence: [], friction: [] })),
      independentUserAcceptance: { status: 'NOT_RUN', reason: 'Two devices operated by one person do not prove independent-user usability or multi-user authorization.' },
    }, null, 2)],
    ['RUN-SHEET.md', `# Two-device acceptance run ${runLabel}

Status: NOT_RUN. Generating this pack makes no STMA, git, credential, or network mutation.
Team: ${team} · project: ${project} · Device A: ${deviceA} · Device B: ${deviceB}.
Integration branch: \`${integration}\`. Task branches: \`${a.branch}\` and \`${b.branch}\`.

## Preparation owned by the coding agent

- Confirm an isolated staging/self-host target and the already authorized test remote. Do not change remotes or push a private checkout to a public mirror. Use a clean dedicated checkout on each device, preserving all pre-existing work.
- Run \`npm run human-lab:check\`. Record the app build SHA, client versions and initial git SHAs. Both devices must start from the same commit.
- Create/check project ${project}; publish the committed fixture policy if missing. Reuse authorized access. Mint two independently revocable project-scoped connection prompts through Connect & test; credentials never belong in this pack.
- Within explicit test-branch authorization, create \`${integration}\` from the verified starting SHA and push only that branch. Device B fetches that exact branch. Existing branches are not overwritten: make a new pack/run label if necessary.
- Set ${scenario.requiredEnvVarName} to the harmless value 1 in Device A's agent environment. Leave its NAME absent in Device B's environment until the intentional negative test. Shell environment changes must reach the actual agent process; a separate terminal export may not do that.

## Ordered run

1. Give 01 to A; choose A's real snapshot as the baseline and verify the effective policy. If governance is a UI acceptance case, the human observes the selection; the coding agent can perform authorized setup.
2. Give 02 to A. Record its actual runId, policy hash, preflight and pause before any edit. Keep its lease alive with update_run/status waiting.
3. While A is live, give 03 to B. Record the critical collision and missing-name preflight, plus unchanged git status/SHA. Close B's blocked run as failed with an explanation that stopping was expected. Expired A claims require repeating this observation.
4. The human sends 04 only after observing both stops and choosing A first. A implements, tests, pushes and hands off.
5. Add the harmless sentinel in B's actual agent environment; before any branch change rerun npm run check:environment from examples/payments-api at the same initial SHA, record fail-to-pass output and refresh its snapshot. Give 05 to B for explicit accept/reclaim/resume/review/complete. A chat acknowledgement does not complete a handoff.
6. After review passes and the human authorizes the ordering, the coding agent merges PAY-201 only into \`${integration}\`, pushes it and brings B to that base. Do not create B's task branch before its new preflight/approval. Give 06 to B, observe no live conflict, then the human sends 07. Preserve migration 002 and use 003 for refunds.
7. B implements, tests, pushes and hands off. Give 08 to A. After its review passes, the coding agent performs the authorized integration merge and runs every fixture test. Record the final integration SHA.
8. Using a ${project}-scoped credential, call get_policy for another EXISTING project in the same team. Verify access denied and no data returned. Do not use start_run for this negative read test. Confirm the other project's existence separately with owner access.
9. Fill results.json from actual observations: PASSED, FAILED, FRICTION or BLOCKED. Leave unexecuted cases NOT_RUN; local unit tests never mark physical-device or human acceptance passed. Record masked evidence references, not credentials.
10. Close only this run's remaining runs/offers and revoke only its temporary credentials. Record branch names for later cleanup; branch/team deletion needs an explicit target and authorization. Do not delete evidence.

## Work only a person can supply

- Bring two physical devices/clients online and complete inaccessible login/consent steps. A VM is useful preparation, not evidence for two physical devices.
- Observe genuine stop/understanding behavior and make the migration/order decisions in 04 and 07. The template is not a pre-existing approval.
- Provide an independent new participant for cold-start usability and a second account for multi-user authorization. This pack does not claim those cases passed.
- Give the coding agent scope for any missing test-remote/branch write, cleanup or external-message authority; authorized routine commands remain agent work.

No sample SQL is applied to a database. No deployment or product-main merge belongs to this lab.
`],
  ]);
  let directory;
  try {
    if (out) {
      directory = path.resolve(out);
      mkdirSync(directory, { recursive: false, mode: 0o700 });
    } else directory = mkdtempSync(path.join(tmpdir(), 'stma-human-lab-'));
    for (const [name, content] of files) writeFileSync(path.join(directory, name), `${content}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code === 'EEXIST') die('output already exists; choose a new directory; no files were overwritten');
    die(`could not create complete bundle (${error.code ?? 'write error'}); inspect any partial output before retrying`);
  }
  console.log(`Prepared ${files.size} files in ${directory}\nRun label: ${runLabel}\nHuman acceptance: NOT_RUN\nOpen RUN-SHEET.md first. This pack contains no enrollment prompt or credential.`);
}

const [command, ...rest] = process.argv.slice(2);
if (!command || command === 'help' || command === '--help') {
  console.log(`Usage:
  node scripts/human-lab-prompt.mjs validate
  node scripts/human-lab-prompt.mjs baseline --team TEAM --project payments-api --device DEVICE
  node scripts/human-lab-prompt.mjs device-a --team TEAM --project payments-api --device DEVICE
  node scripts/human-lab-prompt.mjs device-b --team TEAM --project payments-api --device DEVICE
  node scripts/human-lab-prompt.mjs bundle --team TEAM --device-a DEVICE_A --device-b DEVICE_B [--run LABEL] [--out NEW_DIRECTORY]

Individual prompts also accept --run LABEL for unique branches. Bundle defaults to a new temporary directory and unique run label. No server access or provisioning is performed.`);
  process.exit(0);
}
if (command === 'validate') {
  if (rest.length) die('validate takes no flags');
  validate();
  process.exit(0);
}

validate(true);
if (!['baseline', 'device-a', 'device-b', 'bundle'].includes(command)) die('unknown command; use help');
const parsed = flags(rest, command === 'bundle' ? ['team', 'project', 'device-a', 'device-b', 'run', 'out'] : ['team', 'project', 'device', 'run']);
const input = {
  team: safeLabel(parsed.get('team'), 'team', 80),
  project: safeLabel(parsed.get('project') ?? scenario.project, 'project'),
};
const runLabel = parsed.has('run') ? safeLabel(parsed.get('run'), 'run', 60) : undefined;
if (runLabel && !/^[A-Za-z0-9]/.test(runLabel)) die('--run must start with a letter or digit');
if (command === 'bundle') {
  bundle({ ...input,
    deviceA: safeLabel(parsed.get('device-a'), 'device-a', 40),
    deviceB: safeLabel(parsed.get('device-b'), 'device-b', 40),
    runLabel: runLabel ?? `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`,
    out: parsed.get('out'),
  });
  process.exit(0);
}
input.device = safeLabel(parsed.get('device'), 'device', 40);
if (command === 'baseline') console.log(baselinePrompt(input));
else {
  const run = runFor(command, runLabel);
  console.log(taskPrompt({ ...input, run }));
}
