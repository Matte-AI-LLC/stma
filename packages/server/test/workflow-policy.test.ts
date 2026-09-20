import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = path.resolve(__dirname, '../../..');

describe('repository workflow policy', () => {
  it('dispatches staging after a GITHUB_TOKEN auto-merge', () => {
    const workflow = readFileSync(path.join(repo, '.github/workflows/auto-merge.yml'), 'utf8');

    // GitHub intentionally suppresses both the push event and the resulting
    // closed event when GITHUB_TOKEN performs the merge. The trusted workflow
    // that enabled auto-merge must remain alive, verify the merge actor, and
    // use the workflow_dispatch exception. Human merges keep the push path.
    expect(workflow).toContain('cancel-in-progress: true');
    expect(workflow).toContain('gh pr view "$PR_URL" --json state,mergedBy');
    // GitHub's GraphQL actor login is currently `app/github-actions`; retain
    // the legacy REST-style spelling, but never succeed silently for an
    // unknown actor because that can leave main ahead of staging.
    expect(workflow).toContain('"app/github-actions"|"github-actions[bot]")');
    expect(workflow).toContain('gh workflow run deploy-staging.yml --ref main');
    expect(workflow).toContain('staging dispatch was not confirmed');
    expect(workflow).toMatch(/staging dispatch was not confirmed[\s\S]*?exit 1/);
  });
});
