import type { DeliveryFlow, FlowProvider, PolicyDocument } from '@bridge/shared';
import { pipelineIsScaffold, renderPipeline } from './delivery';
import { fingerprintJson } from '../lib/canonical';

/** The authority a downloaded setup pack gives the receiving agent. */
export const AGENT_SETUP_MODES = ['plan-only', 'propose-then-apply'] as const;
export type AgentSetupMode = (typeof AGENT_SETUP_MODES)[number];

export interface AgentSetupGovernance {
  scope: 'team' | 'project';
  project?: string;
  hash: string;
  document: PolicyDocument;
  sources: Array<{ scope: string; version: number; hash: string }>;
}

export interface AgentSetupContext {
  name: string;
  team: string;
  project?: string | null;
  templateKey: string;
  provider: FlowProvider;
  version?: number;
  mode: AgentSetupMode;
  governance?: AgentSetupGovernance;
}

export function agentSetupManifest(flow: DeliveryFlow, context: AgentSetupContext) {
  const contract = { schemaVersion: 2, receiptSchemaVersion: 2, team: context.team,
    project: context.project ?? null, provider: context.provider, template: context.templateKey,
    flowVersion: context.version ?? null, flowHash: fingerprintJson(flow),
    policyHash: context.governance?.hash ?? null, mode: context.mode,
    allowedActions: context.mode === 'plan-only' ? ['read', 'propose'] : ['read', 'propose', 'apply_after_explicit_human_approval'],
  };
  return { ...contract, setupId: fingerprintJson(contract) };
}

const quoted = (value: string): string => JSON.stringify(value);

/** A Markdown fence longer than any run of backticks in user-controlled content. */
const fenceFor = (content: string, minimum = 3): string => {
  const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((match) => match[0].length));
  return '`'.repeat(Math.max(minimum, longest + 1));
};

const codeBlock = (language: string, content: string): string => {
  const fence = fenceFor(content);
  return `${fence}${language}\n${content}\n${fence}`;
};

const inlineCode = (value: string): string => {
  const fence = fenceFor(value, 1);
  return `${fence}${value}${fence}`;
};

const providerName = (provider: FlowProvider): string =>
  provider === 'github-actions' ? 'GitHub Actions' : 'Azure DevOps Pipelines';

const triggerWords: Record<DeliveryFlow['environments'][number]['deployOn'], string> = {
  'pull-request': 'each pull request',
  merge: 'a merge to the base branch',
  tag: 'a version tag',
  manual: 'an explicit manual action',
};

function providerPreflight(provider: FlowProvider): string[] {
  if (provider === 'github-actions') {
    return [
      'Run `gh auth status` without `--show-token`. Inspect remote names with `git remote`; if a remote URL is needed, redact URL userinfo before it reaches output or the completion receipt.',
      'Confirm the signed-in GitHub account can push workflow files to this repository.',
      'Identify whether repository environment, required-reviewer, Actions secret, or branch-protection changes are required.',
      'If login is missing, tell the user to complete `gh auth login` in their own trusted terminal or browser. Do not run the interactive login for them and do not ask them to paste a token into chat.',
    ];
  }
  return [
    'Run `az account show`, `az devops configure --list`, and `git remote` without changing authentication state. If a remote URL is needed, redact URL userinfo before it reaches output or the completion receipt.',
    'Confirm the signed-in identity can read the target Azure DevOps organization, project, and repository before proposing a write.',
    'Identify whether Azure DevOps Environment approvals, variable-group entries, service connections, or branch policies are required.',
    'If login is missing, prefer Microsoft Entra authentication and tell the user to complete `az login` in their own trusted terminal or browser. Use a PAT only when the organization or account requires it; tell the user the exact scopes needed and have them enter it through the `az devops login --organization <url>` prompt in their trusted terminal. Never place the PAT in a command, shell history, environment dump, chat, or this file.',
  ];
}

function governanceSection(governance?: AgentSetupGovernance): string {
  if (!governance) {
    return `## Governance protocol

No STMA governance policy was included by the user. This does **not** remove repository-local rules. Read and obey every applicable \`AGENTS.md\`, \`CLAUDE.md\`, contribution guide, protected-path rule, and provider policy before proposing changes.`;
  }

  const sourceSummary =
    governance.sources.length === 0
      ? 'No active policy bundle was published for this scope when the pack was generated.'
      : governance.sources
          .map(
            (source) =>
              `- ${inlineCode(source.scope)} v${source.version} — ${inlineCode(source.hash)}`,
          )
          .join('\n');
  const document = JSON.stringify(governance.document, null, 2);
  const scopeLabel =
    governance.scope === 'project' ? `project ${governance.project}` : 'the whole team';

  return `## Governance protocol

The user explicitly included the effective STMA policy for ${scopeLabel}.

- Effective policy hash: ${inlineCode(governance.hash)}
- Snapshot scope: ${inlineCode(governance.scope === 'project' ? `project:${governance.project}` : 'team')}
- This is a static snapshot. If the agent has STMA access, compare this hash with the current \`get_policy\` result immediately before implementation. If it changed, stop and ask the user to generate a fresh pack.
- Do not cherry-pick convenient rules. Team and project policy have already been merged for this exact scope.
- A deny rule is binding. A require-approval rule requires a human decision at the moment the protected action is ready.
- Treat \`guidance\` as operating guidance, never as permission to weaken another restriction. Run every \`requiredChecks\` entry before claiming completion and call out every touched \`protectedPaths\` match in the plan.
- \`requiredEnvVarNames\` contains names only: verify presence without printing values. Treat \`runtimes\` as version constraints to verify.
- In \`changeBudget\`, \`0\` means "no STMA limit was set", not "zero changes allowed". A positive value is a cap for one run. If the proposed work exceeds it, split the work or ask for a human decision.
- \`autonomy.requireApprovalFor\` applies to write claims of those resource types; read-only discovery is not a protected write.
- If this policy and a repository-local instruction differ, follow the more restrictive rule. If "more restrictive" is ambiguous, stop and ask the user.

### Policy sources

${sourceSummary}

### Exact effective policy document

${codeBlock('json', document)}`;
}

/**
 * The delivery document as an English handoff a user can give to any coding
 * agent. It grants no credentials and performs no write: the receiving agent
 * has to discover the repository, report missing access, show a plan, and earn
 * approval before implementation.
 */
export function renderAgentSetupMarkdown(
  flow: DeliveryFlow,
  context: AgentSetupContext,
): string {
  const pipeline = renderPipeline(flow, context.provider, {
    name: context.name,
    version: context.version,
    purpose: 'agent-setup',
  });
  const scaffold = pipelineIsScaffold(pipeline);
  const checks =
    flow.checks.length > 0
      ? flow.checks.map((check) => `- ${inlineCode(check)}`).join('\n')
      : '- No real check command is configured. Discover and propose the repository\'s install, test, typecheck, lint, and build commands.';
  const environments =
    flow.environments.length > 0
      ? flow.environments
          .map(
            (environment, index) =>
              `${index + 1}. **${environment.name}** — triggered by ${triggerWords[environment.deployOn]}${environment.approval ? '; requires a human approval gate' : ''}. Deploy command: ${environment.command ? inlineCode(environment.command) : '**MISSING — discover the deployment target and propose a real command.**'}`,
          )
          .join('\n')
      : 'No deployment environment is declared. Treat this as CI-only unless the user explicitly expands the scope.';
  const notes =
    flow.notes.length > 0
      ? flow.notes.map((note) => `- ${note.replaceAll('\n', '\n  ')}`).join('\n')
      : '- No additional delivery notes.';
  const modeInstruction =
    context.mode === 'plan-only'
      ? 'This is **plan-only**. Do not edit files, change provider settings, create secrets, push commits, or deploy anything. End after the proposed plan, access matrix, risks, and verification plan.'
      : 'This is **propose-then-apply**. Stop after presenting the plan and access matrix. Continue to repository or provider writes only after the user explicitly approves that concrete plan.';
  const executionSequence =
    context.mode === 'plan-only'
      ? `1. **Discover:** map the repository stack, existing CI, deployment targets, current commands, ownership rules, and dirty worktree state.
2. **Access matrix:** report repository, CI provider, deployment target, environment, secret-name, and approval-setting readiness without changing them.
3. **Gap analysis:** compare the discovery result with the delivery contract and injected governance. Call out every placeholder or contradiction.
4. **Plan:** name the exact files, provider settings, environment settings, commands, tests, risks, and rollback steps that a later approved implementation would require.
5. **Approval boundary:** stop here. This pack grants no implementation authority; do not continue to repository writes, external writes, or deployment even if the plan appears routine.
6. **Report:** return the receipt below with \`planned\` if the requested plan is ready or \`blocked\` if discovery/access was insufficient. Leave change lists empty because this mode permits no writes.`
      : `1. **Discover:** map the repository stack, existing CI, deployment targets, current commands, ownership rules, and dirty worktree state.
2. **Access matrix:** report repository, CI provider, deployment target, environment, secret-name, and approval-setting readiness without changing them.
3. **Gap analysis:** compare the discovery result with the delivery contract and injected governance. Call out every placeholder or contradiction.
4. **Plan:** name the exact files, provider settings, environment settings, commands, tests, risks, and rollback steps you propose.
5. **Approval boundary:** wait for explicit user approval of the concrete plan before any repository or external write.
6. **Implement:** make the smallest coherent change. Keep deployment commands project-specific and secret values outside the repository.
7. **Verify:** run the repository checks, validate the pipeline syntax, and verify provider/deployment state with direct evidence. A green placeholder is not success.
8. **Report:** return the completion receipt below with truthful \`complete\`, \`partial\`, or \`blocked\` status. Record every repository-specific change that should be reflected back into the STMA delivery document.`;
  const governanceHash = context.governance?.hash ?? 'not-included';
  const targetScope = context.project ? `project:${context.project}` : 'team';
  const governanceScope = context.governance
    ? context.governance.scope === 'project'
      ? `project:${context.governance.project}`
      : 'team'
    : 'not-included';
  const pipelineCandidate = pipeline.yaml;
  const manifest = agentSetupManifest(flow, context);

  return `---
stma_schema: 1
artifact: "delivery-agent-setup"
team: ${quoted(context.team)}
project: ${context.project ? quoted(context.project) : 'null'}
delivery_name: ${quoted(context.name)}
delivery_version: ${context.version ?? 'null'}
template: ${quoted(context.templateKey)}
provider: ${quoted(context.provider)}
target_scope: ${quoted(targetScope)}
execution_mode: ${quoted(context.mode)}
governance_scope: ${quoted(governanceScope)}
governance_hash: ${quoted(governanceHash)}
---

# Set up ${context.name}

## Immutable setup identity

${codeBlock('json', JSON.stringify(manifest, null, 2))}

This identity binds scope, delivery content, mode and optional policy snapshot. Changing any of them requires a fresh pack. Governance opt-out never disables server authorization or mandatory provider controls. This manifest is not a credential, signature, human approval or proof of implementation.

## Mission

Prepare the repository and ${providerName(context.provider)} configuration for this delivery flow. The document is a contract and a starting point, not proof that the repository, deployment target, credentials, secrets, or external approval settings already exist.

${modeInstruction}

## Non-negotiable operating rules

1. Read every applicable \`AGENTS.md\`, \`CLAUDE.md\`, README, contribution guide, and existing CI/CD file before proposing a change. More specific repository instructions win.
2. Begin with read-only discovery. At minimum inspect \`git status --short\`, \`git branch --show-current\`, \`git remote\`, the project manifests, lockfiles, existing workflow files, deployment documentation, and the current test commands. Never print an unredacted credential-bearing remote URL.
3. Preserve unrelated user changes. Never use destructive Git commands, delete an existing pipeline, overwrite provider settings, or rotate credentials unless the user explicitly scopes and approves that exact action.
4. Never request, echo, copy, or store a password, PAT, API key, cloud credential, private key, or secret value in chat, Markdown, source code, logs, commits, or completion receipts. Refer to secrets by name only.
5. Do not claim that a placeholder deployed successfully. Missing commands, logins, provider settings, approvals, or verification evidence must remain visible as incomplete work.
6. Separate repository writes from external writes. The user must know which files will change and which provider/cloud settings will change before either happens.

## Required access and login preflight

Perform these checks read-only and report each result as \`ready\`, \`missing\`, or \`unknown\`:

${providerPreflight(context.provider).map((line) => `- ${line}`).join('\n')}
- Discover the real deployment target for every environment below. Verify its CLI/session read-only. If authentication or permission is missing, tell the user **which service**, **which account or tenant**, **which permission**, **why it is needed**, and **the exact read-only check that will confirm the login afterward**.
- Do not open an interactive login, consent screen, permission grant, secret-creation flow, or account switch on the user's behalf. Pause for the user to complete it.

## Delivery contract

- Ticket system: **${flow.ticket.system}**${flow.ticket.keyPattern ? `; expected key shape ${inlineCode(flow.ticket.keyPattern)}` : ''}${flow.ticket.required ? '; work must not start without a ticket' : ''}.
- Branch from ${inlineCode(flow.branch.from)} using ${inlineCode(flow.branch.pattern)}.
- Pull requests require **${flow.review.approvals} approval${flow.review.approvals === 1 ? '' : 's'}** and merge by **${flow.mergeStrategy}**.

### Required checks

${checks}

### Environment path

${environments}

### Delivery notes

${notes}

${governanceSection(context.governance)}

## Required execution sequence

${executionSequence}

## Starting pipeline candidate

Target path: ${inlineCode(pipeline.path)}

This candidate is currently **${scaffold ? 'a scaffold with one or more placeholders' : 'content-complete according to the stored delivery document'}**. Repository discovery and external configuration verification are still required.

${codeBlock('yaml', pipelineCandidate)}

## Completion receipt

If this pack was downloaded from a workspace and STMA MCP is connected, submit this compact JSON using \`record_delivery_receipt\` (argument \`receipt\`). Fill in the outcome truthfully. The server checks scope, current flow/policy hashes and mode; it records a report, not an approval. Without STMA access, return it to the human for the Delivery receipts page. A preview-only pack may need to be downloaded before its receipt is registered.

${codeBlock('json', JSON.stringify({ schemaVersion: 2, setupId: manifest.setupId, flowHash: manifest.flowHash, policyHash: manifest.policyHash, status: 'planned', commitSha: null, repositoryId: null, repositoryWrites: false, providerWrites: false }, null, 2))}

Return a filled receipt in this exact shape. Do not put secret values in it.

<!-- STMA_DELIVERY_RECEIPT_START -->
${codeBlock(
    'yaml',
    `schema: 2
setup_id: ${quoted(manifest.setupId)}
flow_hash: ${quoted(manifest.flowHash)}
status: planned | complete | partial | blocked
delivery_name: ${quoted(context.name)}
provider: ${quoted(context.provider)}
pipeline_path: ${quoted(pipeline.path)}
target_scope: ${quoted(targetScope)}
governance_scope_applied: ${quoted(governanceScope)}
governance_hash_applied: ${quoted(governanceHash)}
repository:
  branch: ""
  commit: ""
files_changed: []
checks_run:
  - command: ""
    result: passed | failed | not-run
external_changes: []
manual_settings_remaining: []
missing_access: []
evidence_links: []
rollback: []
delivery_document_updates_suggested: []
notes: []`,
  )}
<!-- STMA_DELIVERY_RECEIPT_END -->
`;
}
