import { deliveryFlowSchema, policyDocumentSchema } from '@bridge/shared';
import { describe, expect, it } from 'vitest';
import { renderAgentSetupMarkdown } from '../src/domain/agentSetup';
import { templateByKey } from '../src/domain/flowTemplates';

describe('agent delivery setup Markdown', () => {
  it('turns an unpublished GitHub blueprint into a safe propose-then-apply handoff', () => {
    const flow = templateByKey('preview-cd')!.document;
    const markdown = renderAgentSetupMarkdown(flow, {
      name: 'Preview delivery',
      team: 'payments',
      project: 'checkout-web',
      templateKey: 'preview-cd',
      provider: 'github-actions',
      mode: 'propose-then-apply',
    });

    expect(markdown).toContain('artifact: "delivery-agent-setup"');
    expect(markdown).toContain('execution_mode: "propose-then-apply"');
    expect(markdown).toContain('target_scope: "project:checkout-web"');
    expect(markdown).toContain('governance_scope: "not-included"');
    expect(markdown).toContain('Run `gh auth status`');
    expect(markdown).toContain('without `--show-token`');
    expect(markdown).toContain('Do not run the interactive login for them');
    expect(markdown).toContain('do not ask them to paste a token into chat');
    expect(markdown).toContain('preview** — triggered by each pull request');
    expect(markdown).toContain('MISSING — discover the deployment target');
    expect(markdown).toContain('No STMA governance policy was included by the user.');
    expect(markdown).toContain('STMA_DELIVERY_RECEIPT_START');
    expect(markdown).toContain('.github/workflows/stma-flow.yml');
    expect(markdown).toContain('(an unpublished blueprint)');
    expect(markdown).toContain('Report every repository-specific adaptation');
    expect(markdown).toContain('delivery_document_updates_suggested: []');
    expect(markdown).toContain('6. **Implement:**');
    expect(markdown.match(/^checks_run:/gm)).toHaveLength(1);
  });

  it('makes plan-only authority and an exact project governance snapshot explicit', () => {
    const flow = deliveryFlowSchema.parse({
      ticket: { system: 'jira', keyPattern: 'PAY-123', required: true },
      branch: { pattern: 'feature/{ticket}-{slug}', from: 'main' },
      checks: ['npm test'],
      review: { approvals: 2 },
      mergeStrategy: 'squash',
      environments: [
        { name: 'production', deployOn: 'merge', approval: true, command: './deploy production' },
      ],
    });
    const policy = policyDocumentSchema.parse({
      guidance: ['Keep changes small. A literal ``` fence must stay data.'],
      permissions: {
        deny: ['Never rewrite published migrations.'],
        requireApproval: ['Production environment changes.'],
      },
      requiredChecks: ['npm test'],
      protectedPaths: ['infra/**'],
      environment: {
        requiredEnvVarNames: ['DATABASE_URL'],
        runtimes: { node: '22' },
      },
      autonomy: { requireApprovalFor: ['migration'] },
      changeBudget: { maxScopeItems: 5, maxPaths: 3 },
    });
    const markdown = renderAgentSetupMarkdown(flow, {
      name: 'Payments production',
      team: 'payments',
      project: 'payments-api',
      templateKey: 'ticket-gated',
      provider: 'azure-devops',
      version: 4,
      mode: 'plan-only',
      governance: {
        scope: 'project',
        project: 'payments-api',
        hash: 'effective-hash-123',
        document: policy,
        sources: [
          { scope: 'team', version: 2, hash: 'team-hash' },
          { scope: 'project:payments-id', version: 3, hash: 'project-hash' },
        ],
      },
    });

    expect(markdown).toContain('This is **plan-only**. Do not edit files');
    expect(markdown).toContain('`planned` if the requested plan is ready');
    expect(markdown).not.toContain('6. **Implement:**');
    expect(markdown).toContain('status: planned | complete | partial | blocked');
    expect(markdown).toContain('Run `az account show`');
    expect(markdown).toContain('prefer Microsoft Entra authentication');
    expect(markdown).toContain('`az devops login --organization <url>`');
    expect(markdown).toContain('Effective policy hash: `effective-hash-123`');
    expect(markdown).toContain('Snapshot scope: `project:payments-api`');
    expect(markdown).toContain('`team` v2 — `team-hash`');
    expect(markdown).toContain('`project:payments-id` v3 — `project-hash`');
    expect(markdown).toContain('"Never rewrite published migrations."');
    expect(markdown).toContain('"DATABASE_URL"');
    expect(markdown).toContain('`0` means "no STMA limit was set"');
    expect(markdown).toContain('verify presence without printing values');
    expect(markdown).toContain('read-only discovery is not a protected write');
    expect(markdown).toContain('governance_hash_applied: "effective-hash-123"');
    expect(markdown).toContain('target_scope: "project:payments-api"');
    expect(markdown).toContain('governance_scope_applied: "project:payments-api"');
    // User-controlled policy text cannot close the fenced JSON block early.
    expect(markdown).toContain('````json');
  });
});
