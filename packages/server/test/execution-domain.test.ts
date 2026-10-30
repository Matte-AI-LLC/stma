import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { EXECUTION_PERMISSION_PROFILE, EXECUTION_RUNTIME, type ExecutionClaimDto, type ExecutionResult } from '@bridge/shared';
import { connectDb, type Db } from '../src/db';
import { agentInstallations, agentRuns, debugSessions, executionAttemptGrants, executionAttempts, executionJobs, executionTargets, handoffs, memberships, projects, teams, tokens, users, workerInstances, workItems, workLinks, workProjectCounters } from '../src/db/schema';
import { loadEnv } from '../src/env';
import { createApp } from '../src/app';
import { generatePat } from '../src/auth/pat';
import { writeAssignment } from '../src/domain/assignments';
import { finishAgentRun, startAgentRun } from '../src/domain/agents';
import { registerFleetTools } from '../src/mcp/fleet';
import { cancelExecution, claimExecution, configureExecutionTarget, dispatchExecution, getExecution, heartbeatExecution, reportExecutionEvent, setExecutionTargetEnabled } from '../src/domain/execution';
import { agentPrincipal, humanPrincipal } from '../src/domain/workTypes';
import { sha256hex } from '../src/lib/crypto';
import type { AgentGrant } from '../src/lib/grants';
import { guardExecutionHttp, managedResourceRefusal, resolveExecutionCredential, withExecutionRequest } from '../src/lib/executionSecurity';
import { withEntitlements } from '../src/lib/entitlements';
import { setSecurityPrincipal, withSecurityHooks } from '../src/lib/securityHooks';

let db: Db;
let close: () => Promise<void>;
let dir: string;
let userId: string;
let teamId: string;
let projectId: string;
const env = loadEnv({ nodeEnv: 'test', databaseUrl: undefined, hosted: false });
const ok = <T>(value: ExecutionResult<T>): T => { if (value && typeof value === 'object' && 'error' in value) throw new Error(JSON.stringify(value)); return value as T; };
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'stma-execution-domain-'));
  ({ db, close } = await connectDb({ ...env, pgliteDir: dir }));
  userId = (await db.insert(users).values({ username: 'execution-owner' }).returning())[0]!.id;
  teamId = (await db.insert(teams).values({ name: 'Execution', slug: 'execution', createdBy: userId }).returning())[0]!.id;
  await db.insert(memberships).values({ teamId, userId, role: 'owner' });
  projectId = (await db.insert(projects).values({ teamId, name: 'api', slug: 'api', repositoryIdentity: 'github.com/acme/api', createdBy: userId }).returning())[0]!.id;
});
afterAll(async () => { await close?.(); if (dir && path.resolve(dir).startsWith(path.resolve(tmpdir()) + path.sep)) rmSync(dir, { recursive: true, force: true }); });

async function fixture() {
  const pat = generatePat();
  const token = (await db.insert(tokens).values({ userId, name: 'worker fixture', tokenHash: pat.hash, prefix: pat.prefix, scope: 'project', teamId, projectId }).returning())[0]!;
  const installation = (await db.insert(agentInstallations).values({ userId, tokenId: token.id, name: randomUUID(), deviceFingerprint: randomUUID(), clientType: 'claude-code' }).returning())[0]!;
  const grant: AgentGrant = { tokenId: token.id, scope: 'project', teamId, teamSlug: 'execution', teamName: 'Execution', projectId, projectSlug: 'api', projectName: 'api', installationId: installation.id,
    installationName: installation.name, deviceLabel: null, companionInstallationId: null, clientType: 'claude-code' };
  const configured = ok(await configureExecutionTarget(db, userId, grant, { checkout_path: `C:/dedicated/${installation.id}`, checkout_fingerprint: sha256hex(installation.id), runtime: EXECUTION_RUNTIME,
    runtime_version: 'fixture', permission_profile: EXECUTION_PERMISSION_PROFILE, max_runtime_seconds: 300, max_turns: 5, dedicated: true }));
  const target = configured.target;
  const human = humanPrincipal(userId);
  ok(await setExecutionTargetEnabled(db, human, target.id, true));
  const assignment = await db.transaction(tx => writeAssignment(tx as unknown as Db, env, { team: { id: teamId, slug: 'execution' }, project: { id: projectId, name: 'api', repositoryIdentity: 'github.com/acme/api' },
    agent: { installationId: installation.id, name: installation.name, ownerId: userId, owner: 'execution-owner', client: 'claude-code', device: null, role: null, projectId, adapters: 0, lastSeenAt: new Date() },
    assignedBy: { id: userId, username: 'execution-owner', tokenId: null, via: null }, task: 'Inspect fixture', brief: 'Read the fixture.', steps: [], branch: null, scope: [] }, { sessionId: randomUUID(), handoffId: randomUUID() }));
  const dispatched = ok(await dispatchExecution(db, human, { target_id: target.id, session_id: assignment.sessionId, request_id: randomUUID() }));
  return { pat: pat.token, grant, target, human, assignment, job: dispatched.job, workerId: randomUUID() };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function claim(f: Fixture) { return ok(await claimExecution(db, userId, f.grant, { target_id: f.target.id, worker_id: f.workerId })) as ExecutionClaimDto; }
const lease = (f: Fixture, c: ExecutionClaimDto) => ({ target_id: f.target.id, worker_id: f.workerId, attempt_id: c.attempt.id, fence: c.attempt.fence });
async function childGrant(f: Fixture, c: ExecutionClaimDto) {
  const found = await resolveExecutionCredential(db, sha256hex(c.attempt_token));
  expect(found).not.toBeNull();
  return { ...f.grant, execution: found!.execution };
}
const report = (f: Fixture, c: ExecutionClaimDto, state: 'starting'|'running'|'succeeded'|'cancelled'|'needs_input', stopped = false) => reportExecutionEvent(db, userId, f.grant, {
  ...lease(f, c), event_id: randomUUID(), state, provider_session_id: c.attempt.provider_session_id, checkout_fingerprint: f.target.checkout_fingerprint,
  process_stopped: stopped, reason: state === 'needs_input' ? 'permission_required' : state === 'starting' ? 'spawn_intent' : state === 'running' ? 'session_observed' : state === 'cancelled' ? 'cancelled' : 'turn_completed',
});

it('lets only one worker claim and refuses a second dispatch for the active assignment', async () => {
  const f = await fixture();
  const claims = await Promise.all([claim(f), claimExecution(db, userId, f.grant, { target_id: f.target.id, worker_id: randomUUID() })]);
  expect(claims.filter(c => 'job' in c && c.job !== null)).toHaveLength(1);
  const again = await dispatchExecution(db, f.human, { target_id: f.target.id, session_id: f.assignment.sessionId, request_id: randomUUID() });
  expect(again).toMatchObject({ error: { code: 'ALREADY_DISPATCHED' } });
});

it('uses one run for MCP and hook start and refuses broad credentials on that run and session', async () => {
  const f = await fixture(); const c = await claim(f); const grant = await childGrant(f, c);
  const input = { installationId: f.grant.installationId!, team: 'execution', project: 'api', repositoryIdentity: 'github.com/acme/api', claims: [] };
  const first = await withExecutionRequest(db, grant, tx => startAgentRun(tx, userId, input, 15, projectId, grant));
  expect(first).not.toHaveProperty('error');
  const second = await withExecutionRequest(db, grant, tx => startAgentRun(tx, userId, { ...input, requestId: randomUUID(), intent: 'An attempted second run' }, 15, projectId, grant));
  expect((second as any).run.id).toBe((first as any).run.id);
  expect((await db.select().from(agentRuns).where(eq(agentRuns.installationId, f.grant.installationId!)))).toHaveLength(1);
  expect(await managedResourceRefusal(db, f.grant, { runId: (first as any).run.id })).toBeTruthy();
  expect(await managedResourceRefusal(db, { ...f.grant, installationId: null, scope: 'personal' }, { sessionId: f.assignment.sessionId })).toBeTruthy();
  expect(await guardExecutionHttp(db, f.grant, '/mcp', 'POST', null)).toContain('worker-only');
  expect(await guardExecutionHttp(db, grant, '/api/agent/worker/claim', 'POST', null)).toContain('cannot operate');
  expect(await guardExecutionHttp(db, grant, `/api/agent/runs/${randomUUID()}/heartbeat`, 'POST', {})).toContain('own bound run');
  await withExecutionRequest(db, grant, tx => finishAgentRun(tx, (first as any).run.id, userId, 'completed'));
  const app = createApp({ db, env });
  const closedRun=(await db.select().from(agentRuns).where(eq(agentRuns.id,(first as any).run.id)))[0]!;
  const heartbeat = await app.request(`/api/agent/runs/${closedRun.id}/heartbeat`, { method:'POST',headers:{'x-forwarded-for':'127.0.0.1',authorization:`Bearer ${c.attempt_token}`,'content-type':'application/json'},body:JSON.stringify({status:'active'}) });
  expect(heartbeat.status).toBe(200);
  expect(await heartbeat.json()).toEqual({ok:true,closed:true,runId:closedRun.id,status:'completed'});
  expect((await db.select().from(agentRuns).where(eq(agentRuns.id,closedRun.id)))[0]).toEqual(closedRun);
  const foreign = await app.request(`/api/agent/runs/${randomUUID()}/heartbeat`, { method:'POST',headers:{'x-forwarded-for':'127.0.0.1',authorization:`Bearer ${c.attempt_token}`,'content-type':'application/json'},body:'{}' });
  expect(foreign.status).toBe(403);
  const stopped = await app.request(`/api/agent/runs/${(first as any).run.id}/finish`, { method: 'POST', headers: { 'x-forwarded-for':'127.0.0.1', authorization:`Bearer ${c.attempt_token}`, 'content-type':'application/json' }, body:JSON.stringify({status:'completed'}) });
  expect(stopped.status).toBe(200);
  expect(await stopped.json()).toMatchObject({ok:true,runId:(first as any).run.id,status:'completed',replayed:true});
});

it('fences both real HTTP MCP and hook mutation when lease expires; never claims again', async () => {
  const f = await fixture(); const c = await claim(f);
  await db.update(executionAttempts).set({ leaseExpiresAt: new Date(0) }).where(eq(executionAttempts.id, c.attempt.id));
  const app = createApp({ db, env });
  const hook = await app.request('/api/agent/runs/start', { method: 'POST', headers: { 'x-forwarded-for': '127.0.0.1', authorization: `Bearer ${c.attempt_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ installationId: f.grant.installationId, team: 'execution', project: 'api', claims: [] }) });
  expect(hook.status).toBe(403);
  const mcp = await app.request('/mcp', { method: 'POST', headers: { 'x-forwarded-for': '127.0.0.1', authorization: `Bearer ${c.attempt_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'start_run', arguments: {} } }) });
  expect(mcp.status).toBe(403);
  expect(ok(await claimExecution(db, userId, f.grant, { target_id: f.target.id, worker_id: randomUUID() }))).toEqual({ job: null });
  const detail = ok(await getExecution(db, f.human, f.job.id));
  expect(detail.job.state).toBe('lost'); expect(detail.target.quarantined).toBe(true);
  expect(await resolveExecutionCredential(db, sha256hex(c.attempt_token))).toBeNull();
});

it('cancellation revokes child immediately, distinguishes requested and confirmed, and is idempotent', async () => {
  const f = await fixture(); const c = await claim(f);
  ok(await report(f, c, 'starting')); ok(await report(f, c, 'running'));
  expect(ok(await cancelExecution(db, f.human, f.job.id)).job.state).toBe('cancel_requested');
  expect(ok(await cancelExecution(db, f.human, f.job.id)).job.state).toBe('cancel_requested');
  expect(await resolveExecutionCredential(db, sha256hex(c.attempt_token))).toBeNull();
  expect(ok(await heartbeatExecution(db, userId, f.grant, lease(f,c))).cancel_requested).toBe(true);
  expect(ok(await report(f,c,'cancelled',true)).state).toBe('cancelled');
  expect((await report(f,c,'succeeded',true))).toMatchObject({ error: { code: 'STALE_ATTEMPT' } });
});

it('quarantines ambiguous termination and refuses reconfiguration or re-enable', async () => {
  const f = await fixture(); const c = await claim(f);
  ok(await report(f,c,'starting')); ok(await cancelExecution(db,f.human,f.job.id));
  expect(ok(await report(f,c,'cancelled',false)).state).toBe('dispatch_unknown');
  ok(await setExecutionTargetEnabled(db,f.human,f.target.id,false));
  expect(await setExecutionTargetEnabled(db,f.human,f.target.id,true)).toMatchObject({ error: { code: 'QUARANTINED' } });
  expect(ok(await claimExecution(db,userId,f.grant,{target_id:f.target.id,worker_id:randomUUID()}))).toEqual({job:null});
});

it('a proven stopped needs-input attempt releases occupancy but never retains child authority', async () => {
  const f = await fixture(); const c = await claim(f);
  expect(ok(await report(f,c,'needs_input',true)).state).toBe('needs_input');
  expect(await resolveExecutionCredential(db,sha256hex(c.attempt_token))).toBeNull();
  const again = ok(await dispatchExecution(db,f.human,{target_id:f.target.id,session_id:f.assignment.sessionId,request_id:randomUUID()}));
  const next = await claim(f);
  expect(next.job.id).toBe(again.job.id); expect(next.attempt.id).not.toBe(c.attempt.id);
  expect(ok(await getExecution(db,f.human,f.job.id)).target.quarantined).toBe(false);
});

it('worker event replay is exact, a foreign planned session cannot report running, and success does not accept work', async () => {
  const f = await fixture(); const c = await claim(f);
  const event = { ...lease(f,c), event_id: randomUUID(), state:'starting' as const, provider_session_id:c.attempt.provider_session_id, checkout_fingerprint:f.target.checkout_fingerprint, process_stopped:false, reason:'spawn_intent' as const };
  expect(ok(await reportExecutionEvent(db,userId,f.grant,event)).state).toBe('starting');
  expect(ok(await reportExecutionEvent(db,userId,f.grant,event)).state).toBe('starting');
  expect(await reportExecutionEvent(db,userId,f.grant,{...event,detail:'different'})).toMatchObject({error:{code:'REQUEST_REUSED'}});
  expect(await reportExecutionEvent(db,userId,f.grant,{...event,event_id:randomUUID(),state:'running',provider_session_id:randomUUID()})).toMatchObject({error:{code:'CORRELATION_MISMATCH'}});
  ok(await report(f,c,'running')); ok(await report(f,c,'succeeded',true));
  expect(ok(await getExecution(db,f.human,f.job.id))).toMatchObject({ job:{state:'succeeded'}, acceptance:'separate',result_provenance:'worker_reported' });
});

it('revoked installation and changed entitlements stop queued work before claim', async () => {
  const revoked = await fixture();
  await db.update(tokens).set({ revokedAt:new Date() }).where(eq(tokens.id,revoked.grant.tokenId));
  expect(await claimExecution(db,userId,revoked.grant,{target_id:revoked.target.id,worker_id:revoked.workerId})).toMatchObject({error:{code:'FORBIDDEN'}});
  const downgraded = await fixture();
  const response = await withEntitlements(async (_db,_team,base)=>({...base,fleet:'readonly'}),()=>claimExecution(db,userId,downgraded.grant,{target_id:downgraded.target.id,worker_id:downgraded.workerId}),true,false);
  expect(ok(response)).toEqual({job:null});
  expect(ok(await getExecution(db,downgraded.human,downgraded.job.id)).job.state).toBe('cancelled');
});

it('rechecks the composition for dispatch and current attempt rather than trusting a stored role', async () => {
  const f = await fixture(); const c = await claim(f); const grant = await childGrant(f,c);
  let denied = false;
  await withSecurityHooks({ authorize: async () => denied ? 'SSO or role was revoked' : null }, async () => {
    setSecurityPrincipal({userId,tokenId:f.grant.tokenId,teamId,projectId,path:'/mcp',method:'POST'});
    await withExecutionRequest(db,grant,async()=>undefined);
    denied = true;
    await expect(withExecutionRequest(db,grant,async()=>{throw new Error('must not reach mutation');})).rejects.toThrow('SSO or role was revoked');
  });
});

it('refuses the old pinned Native Work contract after its revision changes', async () => {
  const f = await fixture(); const c = await claim(f); const grant = await childGrant(f,c);
  const [work] = await db.insert(workItems).values({teamId,projectId,number:BigInt(Date.now()),displayKey:'WORK-fixture',state:'ready',createdByKind:'human',createdById:userId}).returning();
  await db.insert(workProjectCounters).values({teamId,projectId}).onConflictDoNothing();
  await db.update(executionJobs).set({workId:work!.id,specRevision:1}).where(eq(executionJobs.id,f.job.id));
  await db.update(workItems).set({specRevision:2}).where(eq(workItems.id,work!.id));
  await expect(withExecutionRequest(db,grant,async()=>undefined)).rejects.toThrow('contract changed');
});

it('rejects HTTP delivery attribution to a previous run of the same installation and work', async () => {
  const f = await fixture(); const c = await claim(f);
  const [work] = await db.insert(workItems).values({teamId,projectId,number:BigInt(Date.now()),displayKey:'WORK-delivery',state:'ready',createdByKind:'human',createdById:userId}).returning();
  const [previous,current] = await db.insert(agentRuns).values([
    {installationId:f.grant.installationId!,teamId,projectId,status:'completed'},
    {installationId:f.grant.installationId!,teamId,projectId,status:'active'},
  ]).returning();
  for (const run of [previous!,current!]) await db.insert(workLinks).values({workId:work!.id,teamId,projectId,kind:'run',runId:run.id,specRevision:1,createdByKind:'agent',createdById:f.grant.installationId!});
  await db.update(executionJobs).set({workId:work!.id,specRevision:1}).where(eq(executionJobs.id,f.job.id));
  await db.update(executionAttempts).set({runId:current!.id}).where(eq(executionAttempts.id,c.attempt.id));
  const app = createApp({db,env});
  const res = await app.request(`/api/agent/work/${work!.id}/deliveries`, {method:'POST',headers:{'x-forwarded-for':'127.0.0.1',authorization:`Bearer ${c.attempt_token}`,'content-type':'application/json'},
    body:JSON.stringify({work_id:work!.id,run_id:previous!.id,request_id:randomUUID(),expected_version:'1',spec_revision:1,artifacts:[]})});
  expect(res.status).toBe(403);
  expect((await res.json() as any).error).toContain('own bound run');
  const mismatch = await app.request(`/api/agent/work/${work!.id}/deliveries`, {method:'POST',headers:{'x-forwarded-for':'127.0.0.1',authorization:`Bearer ${c.attempt_token}`,'content-type':'application/json'},
    body:JSON.stringify({work_id:randomUUID(),run_id:current!.id})});
  expect(mismatch.status).toBe(403);
  expect((await mismatch.json() as any).error).toContain('another work');
});

it('meters agent dispatch in the domain while empty worker polling remains free', async () => {
  const f = await fixture();
  ok(await cancelExecution(db,f.human,f.job.id));
  const pat=generatePat();
  const lead=(await db.insert(tokens).values({userId,name:'lead',scope:'project',teamId,projectId,tokenHash:pat.hash,prefix:pat.prefix}).returning())[0]!;
  const principal=agentPrincipal(userId,{...f.grant,tokenId:lead.id,installationId:null});
  const denied=await withEntitlements(async(_db,_team,base)=>({...base,fleet:'full',maxToolCallsPerDay:0}),()=>dispatchExecution(db,principal,{target_id:f.target.id,session_id:f.assignment.sessionId,request_id:randomUUID()}),true,false);
  expect(denied).toMatchObject({error:{code:'LIMIT_EXCEEDED'}});
  expect(await withEntitlements(async(_db,_team,base)=>({...base,maxToolCallsPerDay:0}),()=>claimExecution(db,userId,f.grant,{target_id:f.target.id,worker_id:f.workerId}),true,false)).toEqual({job:null});
  expect(await db.select().from(executionJobs).where(eq(executionJobs.targetId,f.target.id))).toHaveLength(1);
});

it('rolls back a child mutation if authority expires before the request can commit', async()=>{
  const f=await fixture(); const c=await claim(f); const grant=await childGrant(f,c);
  await expect(withExecutionRequest(db,grant,async tx=>{
    await tx.update(executionTargets).set({runtimeVersion:'must roll back'}).where(eq(executionTargets.id,f.target.id));
    await tx.update(executionAttemptGrants).set({expiresAt:new Date(0)}).where(eq(executionAttemptGrants.attemptId,c.attempt.id));
  })).rejects.toThrow('expired before this request completed');
  expect((await db.select().from(executionTargets).where(eq(executionTargets.id,f.target.id)))[0]!.runtimeVersion).toBe('fixture');
});

it('an omitted MCP run id cannot select a managed run through a broad personal token',async()=>{
  const f=await fixture(); const c=await claim(f); const grant=await childGrant(f,c);
  const first=await withExecutionRequest(db,grant,tx=>startAgentRun(tx,userId,{installationId:f.grant.installationId!,team:'execution',project:'api',repositoryIdentity:'github.com/acme/api',claims:[]},15,projectId,grant));
  const pat=generatePat(); const token=(await db.insert(tokens).values({userId,name:'broad fixture',tokenHash:pat.hash,prefix:pat.prefix}).returning())[0]!;
  const callbacks=new Map<string,(args:any)=>Promise<any>>();
  registerFleetTools({registerTool:(name:string,_schema:unknown,callback:any)=>callbacks.set(name,callback)} as any,db,(await db.select().from(users).where(eq(users.id,userId)))[0]!,env,token,
    {...f.grant,tokenId:token.id,scope:'personal',installationId:null,teamId:null,projectId:null});
  await callbacks.get('finish_run')!({});
  expect((await db.select().from(agentRuns).where(eq(agentRuns.id,(first as any).run.id)))[0]!.status).toBe('active');
});

it('preserves pinned references on direct deletion while parent cascades remove the whole execution graph',async()=>{
  const constraints = await db.execute(sql`select conname, condeferrable, condeferred from pg_constraint where conname in ('execution_jobs_work_id_work_items_id_fk','execution_attempts_run_id_agent_runs_id_fk','execution_attempts_worker_id_worker_instances_id_fk')`);
  const constraintRows = Array.isArray(constraints) ? constraints : (constraints as unknown as {rows: Record<string,unknown>[]}).rows;
  expect(constraintRows).toHaveLength(3);
  for(const constraint of constraintRows) { expect(constraint.condeferrable).toBe(true); expect(constraint.condeferred).toBe(true); }
  for (const parent of ['target','project','team','user'] as const) {
    const id=randomUUID();
    const person=(await db.insert(users).values({username:`cascade-${id}`}).returning())[0]!;
    const team=(await db.insert(teams).values({slug:id,name:'Cascade',createdBy:userId}).returning())[0]!;
    const project=(await db.insert(projects).values({teamId:team.id,slug:'cascade',name:'Cascade',createdBy:userId}).returning())[0]!;
    const pat=generatePat();
    const token=(await db.insert(tokens).values({userId:person.id,name:'cascade',scope:'project',teamId:team.id,projectId:project.id,tokenHash:pat.hash,prefix:pat.prefix}).returning())[0]!;
    const installation=(await db.insert(agentInstallations).values({userId:person.id,tokenId:token.id,name:'cascade',deviceFingerprint:id}).returning())[0]!;
    const run=(await db.insert(agentRuns).values({installationId:installation.id,teamId:team.id,projectId:project.id,status:'active'}).returning())[0]!;
    const work=(await db.insert(workItems).values({teamId:team.id,projectId:project.id,number:1n,displayKey:'WORK-1',state:'ready',createdByKind:'human',createdById:userId}).returning())[0]!;
    const session=(await db.insert(debugSessions).values({teamId:team.id,projectId:project.id,title:'Cascade assignment',openedBy:userId}).returning())[0]!;
    const handoff=(await db.insert(handoffs).values({sessionId:session.id,offeredBy:userId,targetUserId:person.id,targetInstallationId:installation.id,kind:'assignment'}).returning())[0]!;
    const target=(await db.insert(executionTargets).values({installationId:installation.id,ownerId:person.id,teamId:team.id,projectId:project.id,checkoutPath:`C:/fixture/${id}`,checkoutFingerprint:sha256hex(id),runtime:EXECUTION_RUNTIME,runtimeVersion:'fixture',permissionProfile:EXECUTION_PERMISSION_PROFILE,maxRuntimeSeconds:300,maxTurns:5,enabled:true}).returning())[0]!;
    const workerId=randomUUID(); await db.insert(workerInstances).values({id:workerId,targetId:target.id});
    const job=(await db.insert(executionJobs).values({targetId:target.id,sessionId:session.id,handoffId:handoff.id,workId:work.id,specRevision:1,principalKind:'human',principalId:userId,actorUserId:userId,actorSecurityPrincipal:{userId,path:'/app',method:'POST'},requestId:randomUUID(),requestHash:sha256hex(id),grantVersion:1,maxRuntimeSeconds:300,maxTurns:5,state:'running',assignment:{task:'Cascade',brief:'Fixture',branch:null,repository_identity:null,start_call:{}}}).returning())[0]!;
    const attempt=(await db.insert(executionAttempts).values({jobId:job.id,workerId,fence:1,state:'running',leaseExpiresAt:new Date(Date.now()+60000),deadlineAt:new Date(Date.now()+300000),providerSessionId:randomUUID(),runId:run.id}).returning())[0]!;
    await db.insert(executionAttemptGrants).values({attemptId:attempt.id,parentTokenId:token.id,tokenHash:sha256hex(randomUUID()),expiresAt:new Date(Date.now()+60000)});
    await expect(db.delete(agentRuns).where(eq(agentRuns.id,run.id))).rejects.toThrow();
    await expect(db.delete(workItems).where(eq(workItems.id,work.id))).rejects.toThrow();
    if(parent==='target') await db.delete(executionTargets).where(eq(executionTargets.id,target.id));
    if(parent==='project') await db.delete(projects).where(eq(projects.id,project.id));
    if(parent==='team') await db.delete(teams).where(eq(teams.id,team.id));
    if(parent==='user') await db.delete(users).where(eq(users.id,person.id));
    expect(await db.select().from(executionAttempts).where(eq(executionAttempts.id,attempt.id))).toEqual([]);
    expect(await db.select().from(executionJobs).where(eq(executionJobs.id,job.id))).toEqual([]);
    expect(await db.select().from(workerInstances).where(eq(workerInstances.id,workerId))).toEqual([]);
  }
});
