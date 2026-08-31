import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, fingerprintJson, policyDocumentSchema } from '@bridge/shared';
import { fingerprintJson as serverFingerprintJson } from '../src/lib/canonical';
import { gitBlobHash } from '../../cli/src/hash';
import { applyPolicy, appliedPolicyHash, managedPolicyBlock } from '../../cli/src/policy';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sampleDocument = () =>
  policyDocumentSchema.parse({
    guidance: ['Prefer small diffs'],
    permissions: { deny: ['git push --force'], requireApproval: ['database migrations'] },
    requiredChecks: ['npm test'],
    protectedPaths: ['infra/**', '.github/workflows/**'],
    environment: {
      requiredEnvVarNames: ['DATABASE_URL', 'STRIPE_KEY'],
      runtimes: { node: '22.11.0' },
    },
  });

describe('shared canonical fingerprint', () => {
  it('is independent of object key order', () => {
    const a = { one: 1, nested: { x: [1, 2, { deep: true }], y: 'z' } };
    const b = { nested: { y: 'z', x: [1, 2, { deep: true }] }, one: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(fingerprintJson(a)).toBe(fingerprintJson(b));
    expect(fingerprintJson(a)).toBe(fingerprintJson(a));
  });

  it('matches the server-side implementation', () => {
    const document = sampleDocument();
    expect(serverFingerprintJson(document)).toBe(fingerprintJson(document));
  });

  it('changes when the document is modified — the drift signal', () => {
    const document = sampleDocument();
    const modified = { ...document, guidance: [...document.guidance, 'Skip the test suite'] };
    expect(fingerprintJson(modified)).not.toBe(fingerprintJson(document));
  });
});

describe('managed policy block', () => {
  it('renders protected paths and environment expectations for every target', () => {
    const block = managedPolicyBlock(sampleDocument(), 'abcdef0123456789');
    expect(block.startsWith('<!-- STMA:BEGIN managed policy -->\n')).toBe(true);
    expect(block.endsWith('<!-- STMA:END managed policy -->\n')).toBe(true);
    expect(block).toContain('### Protected paths — do not modify without owner approval');
    expect(block).toContain('- infra/**');
    expect(block).toContain('- .github/workflows/**');
    expect(block).toContain('### Environment');
    expect(block).toContain('- Required env var: DATABASE_URL');
    expect(block).toContain('- Required env var: STRIPE_KEY');
    expect(block).toContain('- Expected node version: 22.11.0');
    expect(block).toContain('### Never');
    expect(block).toContain('### Required checks');
  });

  it('omits empty sections', () => {
    const block = managedPolicyBlock(policyDocumentSchema.parse({ guidance: ['Be careful'] }), 'ff00');
    expect(block).not.toContain('### Protected paths');
    expect(block).not.toContain('### Environment');
  });
});

describe('policy receipts report what was actually applied', () => {
  it('recomputes the server hash from the persisted document when unmodified', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'stma-policy-'));
    temporaryRoots.push(root);
    const document = sampleDocument();
    const serverHash = fingerprintJson(document);
    const reportedHash = applyPolicy(root, document, serverHash, 'claude-code');
    expect(reportedHash).toBe(serverHash);
    expect(readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toContain('STMA managed policy');
  });

  it('reports a diverging hash after the applied document is tampered with', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'stma-policy-'));
    temporaryRoots.push(root);
    const document = sampleDocument();
    const serverHash = fingerprintJson(document);
    applyPolicy(root, document, serverHash, 'claude-code');
    const file = path.join(root, '.stma', 'effective-policy.json');
    const persisted = JSON.parse(readFileSync(file, 'utf8'));
    persisted.document.permissions.deny = [];
    writeFileSync(file, JSON.stringify(persisted, null, 2), 'utf8');
    expect(appliedPolicyHash(root)).not.toBe(serverHash);
    expect(appliedPolicyHash(root)).toBe(fingerprintJson(persisted.document));
  });
});

describe('git blob hash', () => {
  it('matches git hash-object for the known vector', () => {
    expect(gitBlobHash(Buffer.from('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('matches the well-known empty blob hash', () => {
    expect(gitBlobHash(Buffer.from(''))).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });
});
