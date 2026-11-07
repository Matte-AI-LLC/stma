import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { EXECUTION_CHILD_TOOLS } from '@bridge/shared';
import {
  agentInstallations, agentReadState, debugSessions, executionJobs, handoffs, memberships, messages,
  tokens, webSessions, workAssignmentQuestions, workItems, workLinks,
} from '../src/db/schema';
import { loadEnv } from '../src/env';
import { startServer, type StartedServer } from '../src/server';
import { seedWorkQuestionFixture, type QuestionFixture } from './fixtures/workQuestions';

const env = loadEnv({ port: 0, host: '127.0.0.1', nodeEnv: 'test', devMode: true, databaseUrl: undefined, hosted: false });
let srv: StartedServer;
let dir: string;
let id = 0;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'stma-work-questions-'));
  srv = await startServer({ ...env, pgliteDir: dir });
});
afterAll(async () => {
  await srv?.close();
  if (dir && path.resolve(dir).startsWith(path.resolve(tmpdir()) + path.sep)) rmSync(dir, { recursive: true, force: true });
});

const seed = () => seedWorkQuestionFixture(srv.db, env);
const thread = (f: QuestionFixture) => `/app/sessions/${f.sessionId}`;
const read = (f: QuestionFixture, suffix = '') => fetch(srv.url + thread(f) + suffix, { headers: { cookie: 'sid=' + f.leadSid } });
const fields = (f: QuestionFixture, body = 'Which boundary did you inspect?') =>
  ({ body, mode: 'work_question', expected_work_link_id: f.linkId, request_id: randomUUID() });
const send = (f: QuestionFixture, data = fields(f), sid = f.leadSid) => fetch(srv.url + thread(f) + '/messages', {
  method: 'POST', headers: { cookie: 'sid=' + sid, origin: srv.url },
  body: new URLSearchParams(data), redirect: 'manual',
});
function messageId(res: Response) {
  expect(res.status).toBe(303);
  const location = res.headers.get('location')!;
  const match = /#message-([a-f0-9-]{36})$/.exec(location);
  expect(match).toBeTruthy();
  return match![1]!;
}
async function recorded(questionId: string) {
  const [row] = await srv.db.select().from(workAssignmentQuestions).where(eq(workAssignmentQuestions.questionMessageId, questionId));
  return row;
}
async function rpc(pat: string, method: string, params: unknown = {}) {
  const res = await fetch(srv.url + '/mcp', {
    method: 'POST', headers: { authorization: 'Bearer ' + pat, 'content-type': 'application/json',
      accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  return { status: res.status, rpc: await res.json() as any };
}
async function tool(pat: string, name: string, args: Record<string, unknown>) {
  const { status, rpc: response } = await rpc(pat, 'tools/call', { name, arguments: args });
  const text = response.result?.content?.[0]?.text ?? response.error?.message ?? response.error ?? '';
  let data: any;
  try { data = JSON.parse(text); } catch { data = null; }
  return { text, data, failed: status !== 200 || !!response.result?.isError || !!response.error };
}

it('tracks a browser ask and one exact agent answer without changing the Work or scheduling execution', async () => {
  const f = await seed();
  const before = await srv.db.select().from(workItems).where(eq(workItems.id, f.workId));
  const form = await (await read(f)).text();
  expect(form).toContain('Ask Named fixture about');
  expect(form).toContain(`name="expected_work_link_id" value="${f.linkId}"`);
  const request = fields(f);
  const [a, b] = await Promise.all([send(f, request), send(f, request)]);
  const questionId = messageId(a);
  expect(messageId(b)).toBe(questionId);
  expect((await send(f, { ...request, body: 'Changed' })).status).toBe(409);
  expect(await (await read(f)).text()).toContain('Posted · awaiting reply');
  expect((await recorded(questionId))?.firstServedAt).toBeNull();

  const sameUser = await f.connection('Other installation');
  const companion = await f.connection('Companion', { companionOf: f.agent.installationId });
  const foreign = await f.connection('Other project', { foreign: true });
  const analyst = await f.connection('Analyst', { analyst: true });
  const session_id = f.sessionId;
  const reply = { session_id, reply_to_message_id: questionId, body: '  The requested boundary.  ', via: 'fixture' };
  for (const wrong of [sameUser, companion, foreign, analyst]) {
    expect((await tool(wrong.pat, 'post_message', reply)).failed).toBe(true);
    expect((await tool(wrong.pat, 'get_session', { session_id, work_question_id: questionId })).failed).toBe(true);
  }
  const otherRead = await tool(sameUser.pat, 'get_session', { session_id });
  expect(otherRead.data.messages).toContainEqual(expect.objectContaining({ body: request.body }));
  expect(otherRead.text).not.toContain('work_question');
  expect((await tool(f.agent.pat, 'inbox', {})).failed).toBe(false);
  expect((await tool(f.agent.pat, 'post_message', { session_id, body: 'Ordinary answer', kind: 'answer' })).failed).toBe(false);
  expect((await recorded(questionId))?.firstServedAt).toBeNull();
  expect((await tool(f.agent.pat, 'post_message', reply)).text).toContain('get_session');
  expect((await send(f, fields(f), f.memberSid)).status).toBe(404);
  await srv.db.update(memberships).set({ role: 'owner' }).where(and(eq(memberships.teamId, f.team.id),
    eq(memberships.userId, f.receiver.id)));
  expect((await send(f, request, f.memberSid)).status).toBe(409);

  const include = await tool(f.agent.pat, 'get_session', { session_id });
  expect(include.data.messages).toContainEqual(expect.objectContaining({
    body: request.body,
    work_question: { id: questionId, work_id: f.workId, spec_revision: f.revision, awaiting_reply: true },
  }));
  const first = (await recorded(questionId))!.firstServedAt;
  expect(first).toBeInstanceOf(Date);
  const readAgain = await tool(f.agent.pat, 'get_session', { session_id, work_question_id: questionId.toUpperCase() });
  expect(readAgain.data.messages).toHaveLength(1);
  expect((await recorded(questionId))?.firstServedAt).toEqual(first);
  const answers = await Promise.all([tool(f.agent.pat, 'post_message', reply), tool(f.agent.pat, 'post_message', reply)]);
  expect(answers.map((answer) => answer.data?.replayed).sort()).toEqual([false, true]);
  expect(answers[0]?.data.message_id).toBe(answers[1]?.data.message_id);
  expect((await tool(f.agent.pat, 'post_message', { ...reply, body: 'Changed answer' })).text).toContain('different answer');
  const page = await (await read(f)).text();
  expect(page).toContain('Answered for revision');
  expect(page).toContain('Included in context');
  expect(page).toContain(`id="message-${answers[0]?.data.message_id}"`);
  expect(page).toContain('View answer');
  expect(await srv.db.select().from(workItems).where(eq(workItems.id, f.workId))).toEqual(before);
  expect(await srv.db.select().from(executionJobs).where(eq(executionJobs.sessionId, session_id))).toHaveLength(0);
});

it('stamps only questions in the final tool result and leaves the normal cursor alone on an exact read', async () => {
  const f = await seed();
  const questionId = messageId(await send(f, fields(f, 'Q'.repeat(1_000))));
  // The old body/attachment/resume estimate would include this question. Its
  // tracking metadata pushes it across the 90,000-character cutoff.
  await srv.db.insert(messages).values([20_000, 20_000, 20_000, 20_000, 8_920].map((size, i) => ({
    sessionId: f.sessionId, authorId: f.lead.id, kind: 'note', body: 'N'.repeat(size),
    createdAt: new Date(Date.now() + 10 + i),
  })));
  const session_id = f.sessionId;
  const countBound = await tool(f.agent.pat, 'get_session', { session_id, max_messages: 1 });
  expect(countBound.data.pending_work_questions).toEqual([questionId]);
  expect(countBound.data.messages).toHaveLength(1);
  expect((await recorded(questionId))?.firstServedAt).toBeNull();
  const sizeBound = await tool(f.agent.pat, 'get_session', { session_id });
  expect(sizeBound.data.pending_work_questions).toEqual([questionId]);
  expect(sizeBound.data.messages).toHaveLength(5);
  expect(sizeBound.text).not.toContain('Q'.repeat(1_000));
  expect((await recorded(questionId))?.firstServedAt).toBeNull();
  const cursor = () => srv.db.select().from(agentReadState).where(and(eq(agentReadState.tokenId, f.agent.tokenId),
    eq(agentReadState.sessionId, session_id)));
  const seen = await cursor();
  const exact = await tool(f.agent.pat, 'get_session', { session_id, work_question_id: questionId });
  expect(exact.data.messages).toMatchObject([{ body: 'Q'.repeat(1_000), work_question: { id: questionId } }]);
  expect((await recorded(questionId))?.firstServedAt).toBeInstanceOf(Date);
  expect(await cursor()).toEqual(seen);

  const other = await seed();
  const otherId = messageId(await send(other));
  const foreign = await tool(f.agent.pat, 'get_session', { session_id, work_question_id: otherId });
  const absent = await tool(f.agent.pat, 'get_session', { session_id, work_question_id: randomUUID() });
  expect(foreign.text).toBe(absent.text);
});

it('keeps the five-question cap and a permanent answered tombstone after message deletion', async () => {
  const f = await seed();
  const initial = Array.from({ length: 4 }, (_, i) => fields(f, 'Pending ' + i));
  const questions = [];
  for (const request of initial) questions.push(messageId(await send(f, request)));
  const overflow = await Promise.all([send(f), send(f)]);
  expect(overflow.map((res) => res.status).sort()).toEqual([303, 409]);
  expect(messageId(await send(f, initial[0]))).toBe(questions[0]);
  const session_id = f.sessionId;
  const work_question_id = questions[0]!;
  await tool(f.agent.pat, 'get_session', { session_id, work_question_id });
  const reply = { session_id, reply_to_message_id: work_question_id, body: 'Permanent answer' };
  const answered = await tool(f.agent.pat, 'post_message', reply);
  expect(answered.failed).toBe(false);
  await srv.db.delete(messages).where(eq(messages.id, answered.data.message_id));
  expect(await recorded(work_question_id)).toMatchObject({ answeredAt: expect.any(Date), replyMessageId: null });
  expect((await tool(f.agent.pat, 'post_message', reply)).text).toContain('no longer retained');
  expect((await tool(f.agent.pat, 'post_message', { ...reply, body: 'Replacement' })).text).toContain('different answer');
  expect((await (await read(f)).text())).toContain('Answer no longer retained');
  const spare = messageId(await send(f, fields(f, 'Uses the opened slot')));
  await srv.db.delete(agentInstallations).where(eq(agentInstallations.id, f.agent.installationId));
  expect((await recorded(work_question_id))?.recipientInstallationId).toBe(f.agent.installationId);
  expect((await (await read(f)).text())).toContain('Disconnected installation');
  await srv.db.delete(messages).where(eq(messages.id, spare));
  expect(await recorded(spare)).toBeUndefined();
  const removed = await fetch(srv.url + '/app/teams/' + f.team.slug + '/delete', {
    method: 'POST', headers: { cookie: 'sid=' + f.leadSid, origin: srv.url }, redirect: 'manual',
  });
  expect(removed.status).toBe(302);
  expect(await recorded(work_question_id)).toBeUndefined();

  const detached = await seed();
  const removedLinkQuestion = messageId(await send(detached));
  await srv.db.delete(workLinks).where(eq(workLinks.id, detached.linkId));
  expect(await recorded(removedLinkQuestion)).toBeUndefined();
  expect((await (await read(detached)).text())).toContain('Which boundary did you inspect?');
});

it('refuses stale forms, corrected links, expired target proofs and resolved threads', async () => {
  const f = await seed();
  const stale = fields(f);
  const questionId = messageId(await send(f));
  const args = { session_id: f.sessionId, work_question_id: questionId };
  await srv.db.update(tokens).set({ expiresAt: new Date(0) }).where(eq(tokens.id, f.agent.tokenId));
  expect((await send(f, stale)).status).toBe(409);
  await srv.db.update(tokens).set({ expiresAt: null, setupExpiresAt: new Date(Date.now() + 60_000) })
    .where(eq(tokens.id, f.agent.tokenId));
  expect((await send(f, stale)).status).toBe(409);
  await srv.db.update(tokens).set({ setupExpiresAt: null }).where(eq(tokens.id, f.agent.tokenId));
  await tool(f.agent.pat, 'get_session', args);
  expect((await recorded(questionId))?.firstServedAt).toBeInstanceOf(Date);
  await f.correctLink();
  expect((await send(f, stale)).status).toBe(409);
  expect((await tool(f.agent.pat, 'get_session', args)).failed).toBe(true);
  expect((await tool(f.agent.pat, 'post_message', { session_id: f.sessionId, reply_to_message_id: questionId, body: 'Stale' })).failed).toBe(true);
  expect((await (await read(f)).text())).toContain('Work link or revision changed');

  const closed = await seed();
  const posted = messageId(await send(closed));
  await srv.db.update(debugSessions).set({ status: 'resolved' }).where(eq(debugSessions.id, closed.sessionId));
  expect((await send(closed)).status).toBe(409);
  expect((await (await read(closed)).text())).toContain('Assignment closed');
  expect((await recorded(posted))?.firstServedAt).toBeNull();
  await srv.db.update(webSessions).set({ expiresAt: new Date(0) }).where(eq(webSessions.id, closed.leadSid));
  expect((await send(closed)).status).toBe(302);
});

it('requires a current Claude attempt on a managed assignment and withholds the form for read-only Codex', async () => {
  const f = await seed();
  const target = await f.configure();
  const questionId = messageId(await send(f));
  const args = { session_id: f.sessionId, work_question_id: questionId };
  expect((await tool(f.agent.pat, 'get_session', args)).failed).toBe(true);
  const child = await f.managed(target.id);
  expect((await rpc(child.attempt_token, 'tools/list')).rpc.result.tools.map((item: { name: string }) => item.name).sort())
    .toEqual([...EXECUTION_CHILD_TOOLS].sort());
  expect((await rpc((await f.connection('Ordinary')).pat, 'tools/list')).rpc.result.tools).toHaveLength(49);
  expect((await tool(child.attempt_token, 'get_session', args)).failed).toBe(false);
  expect((await tool(child.attempt_token, 'post_message', {
    session_id: f.sessionId, reply_to_message_id: questionId, body: 'Managed answer',
  })).failed).toBe(false);
  expect((await recorded(questionId))?.answeredAt).toBeInstanceOf(Date);
  await srv.db.update(handoffs).set({ state: 'cancelled' }).where(eq(handoffs.id, f.handoffId));
  expect((await tool(child.attempt_token, 'get_session', args)).failed).toBe(true);

  const codex = await seedWorkQuestionFixture(srv.db, env, 'codex');
  await codex.configure(true);
  const html = await (await read(codex)).text();
  expect(html).toContain('This read-only Codex target cannot answer Work questions');
  expect(html).not.toContain('name="mode" value="work_question"');
  expect((await send(codex)).status).toBe(409);
});
