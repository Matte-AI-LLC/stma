import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fingerprintJson, type PolicyDocument } from '@bridge/shared';

export function managedPolicyBlock(document: PolicyDocument, hash: string): string {
  const lines = [
    '<!-- STMA:BEGIN managed policy -->',
    `## STMA managed policy (${hash.slice(0, 12)})`,
    '',
    ...document.guidance.map((rule) => `- ${rule}`),
  ];
  if (document.permissions.deny.length) {
    lines.push('', '### Never', ...document.permissions.deny.map((rule) => `- ${rule}`));
  }
  if (document.permissions.requireApproval.length) {
    lines.push(
      '',
      '### Human approval required',
      ...document.permissions.requireApproval.map((rule) => `- ${rule}`),
    );
  }
  if (document.requiredChecks.length) {
    lines.push('', '### Required checks', ...document.requiredChecks.map((rule) => `- ${rule}`));
  }
  if (document.protectedPaths.length) {
    lines.push(
      '',
      '### Protected paths — do not modify without owner approval',
      ...document.protectedPaths.map((rule) => `- ${rule}`),
    );
  }
  const environment = [
    ...document.environment.requiredEnvVarNames.map((name) => `- Required env var: ${name}`),
    ...Object.entries(document.environment.runtimes).map(
      ([runtime, version]) => `- Expected ${runtime} version: ${version}`,
    ),
  ];
  if (environment.length) {
    lines.push('', '### Environment', ...environment);
  }
  lines.push('<!-- STMA:END managed policy -->');
  return `${lines.join('\n')}\n`;
}

function writeManagedPolicy(file: string, block: string, prefix = ''): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : prefix;
  const marker = /<!-- STMA:BEGIN managed policy -->[\s\S]*?<!-- STMA:END managed policy -->\s*/;
  const next = marker.test(existing)
    ? existing.replace(marker, block)
    : `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}${block}`;
  writeFileSync(file, next, 'utf8');
}

/** Hash of the policy document actually persisted locally — what a receipt should report. */
export function appliedPolicyHash(root: string): string | undefined {
  try {
    const persisted = JSON.parse(
      readFileSync(path.join(root, '.stma', 'effective-policy.json'), 'utf8'),
    ) as { document?: unknown };
    return persisted.document === undefined ? undefined : fingerprintJson(persisted.document);
  } catch {
    return undefined;
  }
}

export function applyPolicy(
  root: string,
  document: PolicyDocument,
  hash: string,
  clientType?: string,
): string | undefined {
  const stmaDir = path.join(root, '.stma');
  mkdirSync(stmaDir, { recursive: true });
  writeFileSync(
    path.join(stmaDir, 'effective-policy.json'),
    `${JSON.stringify({ hash, document }, null, 2)}\n`,
    'utf8',
  );
  const block = managedPolicyBlock(document, hash);
  if (clientType === 'claude-code') {
    writeManagedPolicy(path.join(root, 'CLAUDE.md'), block);
  } else if (clientType === 'cursor') {
    const frontmatter = '---\ndescription: STMA organization and project policy\nalwaysApply: true\n---\n\n';
    writeManagedPolicy(path.join(root, '.cursor', 'rules', 'stma-policy.mdc'), block, frontmatter);
  } else {
    writeManagedPolicy(path.join(root, 'AGENTS.md'), block);
  }
  return appliedPolicyHash(root);
}
