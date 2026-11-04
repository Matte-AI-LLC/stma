import { describe, expect, it } from 'vitest';
import { executionConfigureSchema } from '@bridge/shared';
import type { Db } from '../src/db';
import type { AgentGrant } from '../src/lib/grants';
import { guardExecutionHttp, guardExecutionTool } from '../src/lib/executionSecurity';

const grant = {
  execution: {
    readonlyChild: true,
    targetId: 'target',
    jobId: 'job',
    attemptId: 'attempt',
    fence: 1,
    grantVersion: 1,
    grantId: 'grant',
    sessionId: 'session',
    workId: null,
    specRevision: null,
  },
} as AgentGrant;

describe('read-only execution boundaries', () => {
  it('requires the runtime and its permission profile to match', () => {
    const base = {
      checkout_path: '/dedicated',
      checkout_fingerprint: 'a'.repeat(64),
      runtime_version: 'fixture',
      max_runtime_seconds: 60,
      max_turns: 1,
      dedicated: true,
    };
    expect(
      executionConfigureSchema.safeParse({
        ...base,
        runtime: 'codex-read-only-v1',
        permission_profile: 'sandbox-read-only-v1',
      }).success,
    ).toBe(true);
    expect(
      executionConfigureSchema.safeParse({
        ...base,
        runtime: 'codex-read-only-v1',
        permission_profile: 'restricted-files-v1',
      }).success,
    ).toBe(false);
  });
  it('rejects mutation tools and REST even if the credential is presented directly', async () => {
    const db = {} as Db;
    expect(await guardExecutionTool(db, grant, 'post_message', {})).toMatch(/read-only/);
    expect(await guardExecutionHttp(db, grant, '/api/agent/runs/start', 'POST', {})).toMatch(/read-only/);
    expect(await guardExecutionHttp(db, grant, '/mcp', 'POST', {})).toBeNull();
  });
});
