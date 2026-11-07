import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  CODEX_EXECUTION_RUNTIME, CODEX_PERMISSION_PROFILE, EXECUTION_PERMISSION_PROFILE, EXECUTION_RUNTIME,
} from '@bridge/shared';
import { generatePat } from '../../src/auth/pat';
import type { Db } from '../../src/db';
import { agentInstallations, memberships, projects, teams, tokens, users, webSessions } from '../../src/db/schema';
import { claimExecution, configureExecutionTarget, dispatchExecution, setExecutionTargetEnabled } from '../../src/domain/execution';
import { createWork, updateWork } from '../../src/domain/work';
import { humanPrincipal } from '../../src/domain/workTypes';
import type { Env } from '../../src/env';
import { randomHex, sha256hex } from '../../src/lib/crypto';
import { resolveExecutionCredential } from '../../src/lib/executionSecurity';
import type { AgentGrant } from '../../src/lib/grants';
import { withSecurityPrincipal } from '../../src/lib/securityHooks';

export async function seedWorkQuestionFixture(db: Db, env: Env, clientType = 'claude-code') {
  const slug = randomUUID().slice(0, 8);
  const [lead, receiver] = await db.insert(users).values([
    { username: 'question-lead-' + slug }, { username: 'question-receiver-' + slug },
  ]).returning();
  const [team] = await db.insert(teams).values({ name: 'Question fixture', slug: 'questions-' + slug, createdBy: lead!.id }).returning();
  const [project, otherProject] = await db.insert(projects).values([
    { name: 'Question fixture', slug: 'questions', teamId: team!.id, repositoryIdentity: 'github.com/example/questions' },
    { name: 'Other fixture', slug: 'other', teamId: team!.id },
  ]).returning();
  await db.insert(memberships).values([
    { userId: lead!.id, teamId: team!.id, role: 'owner' },
    { userId: receiver!.id, teamId: team!.id, role: 'member' },
  ]);
  const leadSid = randomHex(32);
  const memberSid = randomHex(32);
  await db.insert(webSessions).values([
    { id: leadSid, userId: lead!.id, expiresAt: new Date(Date.now() + 3_600_000) },
    { id: memberSid, userId: receiver!.id, expiresAt: new Date(Date.now() + 3_600_000) },
  ]);
  async function connection(name: string, opts: { foreign?: boolean; companionOf?: string; analyst?: boolean } = {}) {
    const pat = generatePat();
    const bound = opts.foreign ? otherProject! : project!;
    const [token] = await db.insert(tokens).values({ userId: receiver!.id, name, tokenHash: pat.hash,
      prefix: pat.prefix, scope: 'project', teamId: team!.id, projectId: bound.id,
      ...(opts.analyst ? { accessMode: 'analyst' } : {}) }).returning();
    const [installation] = await db.insert(agentInstallations).values({ userId: receiver!.id, tokenId: token!.id,
      name, clientType, deviceFingerprint: randomUUID(), companionOf: opts.companionOf }).returning();
    const grant: AgentGrant = {
      tokenId: token!.id, scope: 'project', teamId: team!.id, teamSlug: team!.slug, teamName: team!.name,
      projectId: bound.id, projectSlug: bound.slug, projectName: bound.name, installationId: installation!.id,
      installationName: name, deviceLabel: null, companionInstallationId: opts.companionOf ?? null, clientType,
    };
    return { pat: pat.token, tokenId: token!.id, installationId: installation!.id, grant };
  }
  const agent = await connection('Named fixture');
  const human = humanPrincipal(lead!.id);
  const created = await createWork(db, human, {
    request_id: randomUUID(), project: project!.id, owner: lead!.username, acceptor: lead!.username,
    contract: { title: 'Scoped Work question', goal: 'Inspect the fixture.', artifact_kind: 'code' },
    criteria: [{ text: 'Report the fixture result.' }],
  });
  assert.ok(!('error' in created), JSON.stringify('error' in created ? created.error : null));
  const ready = await updateWork(db, human, {
    work_id: created.work_id, request_id: randomUUID(), expected_version: created.version,
    operation: 'transition', payload: { to: 'ready' },
  });
  assert.ok(!('error' in ready));
  const assigned = await updateWork(db, human, {
    work_id: created.work_id, request_id: randomUUID(), expected_version: ready.version,
    operation: 'assign', payload: { to_agent: agent.grant.installationName, expected_spec_revision: ready.spec_revision },
  }, { env, assignee: agent.installationId });
  assert.ok(!('error' in assigned), JSON.stringify('error' in assigned ? assigned.error : null));
  const sessionId = String(assigned.session_id);
  const handoffId = String(assigned.assignment_id);
  const linkId = String(assigned.link_id);
  const workId = created.work_id;
  const assignedVersion = assigned.version;
  const asBrowser = <T>(fn: () => T) => withSecurityPrincipal({
    userId: lead!.id, sessionId: leadSid, method: 'POST', path: `/app/sessions/${sessionId}/messages`,
  }, fn);
  async function correctLink(on: Db = db) {
    const corrected = await updateWork(on, human, {
      work_id: workId, request_id: randomUUID(), expected_version: assignedVersion,
      operation: 'link', payload: { kind: 'assignment', target_id: handoffId, replaces_link_id: linkId, reason: 'Correct the fixture link.' },
    });
    assert.ok(!('error' in corrected), JSON.stringify('error' in corrected ? corrected.error : null));
  }
  async function configure(readOnly = false) {
    const result = await configureExecutionTarget(db, receiver!.id, agent.grant, {
      checkout_path: 'C:/dedicated/' + slug, checkout_fingerprint: sha256hex(slug),
      runtime: readOnly ? CODEX_EXECUTION_RUNTIME : EXECUTION_RUNTIME, runtime_version: 'fixture',
      permission_profile: readOnly ? CODEX_PERMISSION_PROFILE : EXECUTION_PERMISSION_PROFILE,
      max_runtime_seconds: 300, max_turns: readOnly ? 1 : 5, dedicated: true,
    });
    assert.ok(!('error' in result), JSON.stringify('error' in result ? result.error : null));
    const enabled = await setExecutionTargetEnabled(db, humanPrincipal(receiver!.id), result.target.id, true);
    assert.ok(!('error' in enabled));
    return result.target;
  }
  async function managed(targetId: string) {
    const queued = await dispatchExecution(db, human, { target_id: targetId, session_id: sessionId, request_id: randomUUID() });
    assert.ok(!('error' in queued), JSON.stringify('error' in queued ? queued.error : null));
    const claim = await claimExecution(db, receiver!.id, agent.grant, { target_id: targetId, worker_id: randomUUID() });
    assert.ok(!('error' in claim) && 'attempt_token' in claim, JSON.stringify('error' in claim ? claim.error : null));
    const attempt = await resolveExecutionCredential(db, sha256hex(claim.attempt_token));
    assert.ok(attempt);
    return { ...claim, grant: { ...agent.grant, execution: attempt.execution } };
  }
  return { lead: lead!, receiver: receiver!, team: team!, project: project!, otherProject: otherProject!,
    leadSid, memberSid, agent, human, workId, revision: assigned.spec_revision,
    sessionId, handoffId, linkId, asBrowser, connection, correctLink, configure, managed };
}
export type QuestionFixture = Awaited<ReturnType<typeof seedWorkQuestionFixture>>;
