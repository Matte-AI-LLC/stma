import { CODEX_EXECUTION_RUNTIME, EXECUTION_RUNTIME } from '@bridge/shared';
import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../db';
import {
  agentInstallations, debugSessions, executionTargets, handoffs, memberships, messages, tokens, users,
  webSessions, workAssignmentQuestions, workItems, workLinks, workProjectCounters,
} from '../db/schema';
import { fingerprintJson } from '../lib/canonical';
import { currentExecutionBinding } from '../lib/executionSecurity';
import { isTokenScope } from '../lib/grants';
import { isCanonicalUuid } from '../lib/ids';
import { redactSecrets } from '../lib/redact';
import { authorizeSecurity, currentSecurityPrincipal, membershipUser, withSecurityPrincipal } from '../lib/securityHooks';
import { sessionForMember } from '../lib/sessions';
import { hasContractAuthority, OPEN_HANDOFF_STATES, workAccess } from './workAccess';
import type { WorkPrincipal } from './workTypes';

export const WORK_QUESTION_BODY_LIMIT = 4_000;
const PENDING_LIMIT = 5;
const EXECUTABLE_WORK_STATES = ['ready', 'in_progress', 'in_review'];
const unavailable = { status: 404, error: 'No current Work question is available in this assignment.' } as const;
type QuestionError = { status: 400 | 403 | 404 | 409 | 429; error: string };
type QuestionResult<T> = T | QuestionError;
type Session = typeof debugSessions.$inferSelect;
type Handoff = typeof handoffs.$inferSelect;
type Agent = Extract<WorkPrincipal, { kind: 'agent' }>;
type Human = Extract<WorkPrincipal, { kind: 'human' }>;
export type ThreadMessage = { m: typeof messages.$inferSelect; author: string | null };

function normalizedBody(value: unknown) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > WORK_QUESTION_BODY_LIMIT || trimmed.includes('\0')) return null;
  const redacted = redactSecrets(trimmed);
  return redacted.length <= WORK_QUESTION_BODY_LIMIT ? redacted : null;
}

function openAssignment(session: Session, offer: Handoff | undefined) {
  return session.status === 'open' && offer?.kind === 'assignment' &&
    (OPEN_HANDOFF_STATES as readonly string[]).includes(offer.state);
}

async function pinnedWork(db: Db, session: Session, offer: Handoff) {
  if (!session.projectId) return undefined;
  const [row] = await db.select({ link: workLinks, work: workItems }).from(workLinks)
    .innerJoin(workItems, and(eq(workItems.id, workLinks.workId), eq(workItems.teamId, workLinks.teamId),
      eq(workItems.projectId, workLinks.projectId)))
    .where(and(eq(workLinks.handoffId, offer.id), eq(workLinks.kind, 'assignment'),
      eq(workLinks.teamId, session.teamId), eq(workLinks.projectId, session.projectId), isNull(workLinks.supersededAt)));
  if (!row || row.link.specRevision === null || row.link.specRevision !== row.work.specRevision ||
      row.work.archivedAt || !EXECUTABLE_WORK_STATES.includes(row.work.state)) return undefined;
  return { ...row, revision: row.link.specRevision };
}

async function activeRecipient(db: Db, session: Session, offer: Handoff) {
  if (!offer.targetInstallationId || !session.projectId) return null;
  const [row] = await db.select({ installation: agentInstallations, token: tokens, target: executionTargets })
    .from(agentInstallations)
    .innerJoin(tokens, and(eq(tokens.id, agentInstallations.tokenId), eq(tokens.userId, agentInstallations.userId)))
    .leftJoin(executionTargets, eq(executionTargets.installationId, agentInstallations.id))
    .where(eq(agentInstallations.id, offer.targetInstallationId));
  if (!row) return null;
  const { token, installation, target } = row;
  if (installation.revokedAt || installation.userId !== offer.targetUserId || token.revokedAt ||
      token.accessMode !== 'standard' || (token.expiresAt && token.expiresAt <= new Date()) ||
      (token.setupExpiresAt && !token.activatedAt) || !isTokenScope(token.scope) ||
      (token.scope !== 'personal' && (token.teamId !== session.teamId ||
        (token.scope === 'project' && token.projectId !== session.projectId))) ||
      (target && (target.teamId !== session.teamId || target.projectId !== session.projectId))) return null;
  return withSecurityPrincipal({
    userId: installation.userId, tokenId: token.id, teamId: token.teamId, projectId: token.projectId,
    path: '/mcp', method: 'POST',
  }, async () => {
    const [member] = await db.select({ id: memberships.userId }).from(memberships)
      .where(and(eq(memberships.teamId, session.teamId), membershipUser(installation.userId)));
    return member && !(await authorizeSecurity(db, 'credential', { session_id: session.id })) ? row : null;
  });
}

async function namedAgent(db: Db, principal: Agent, session: Session, offer: Handoff, work: NonNullable<Awaited<ReturnType<typeof pinnedWork>>>, tool: string) {
  if (!principal.installationId || principal.installationId !== offer.targetInstallationId ||
      principal.grant.accessMode === 'analyst' || !(await workAccess(db, principal, session.teamId, work.work.projectId)) ||
      await authorizeSecurity(db, 'tool', { session_id: session.id, tool })) return false;
  const recipient = await activeRecipient(db, session, offer);
  if (!recipient || recipient.installation.userId !== principal.userId || recipient.token.id !== principal.tokenId) return false;
  if (!recipient.target) return !principal.grant.execution;
  const grant = principal.grant.execution;
  const bound = currentExecutionBinding();
  return Boolean(recipient.target.runtime === EXECUTION_RUNTIME && grant && !grant.readonlyChild && bound &&
    bound.target.id === recipient.target.id && bound.job.id === grant.jobId && bound.attempt.id === grant.attemptId &&
    bound.job.handoffId === offer.id && bound.job.sessionId === session.id &&
    bound.job.workId === work.work.id && bound.job.specRevision === work.revision);
}

async function browserSession(db: Db, principal: Human, sessionId: string, lock = false) {
  const proof = currentSecurityPrincipal();
  if (proof?.userId !== principal.userId || !proof.sessionId || proof.tokenId || proof.method !== 'POST') return false;
  // Account deletion removes browser sessions before scrubbing the user row.
  const row = db.select({ id: webSessions.id }).from(webSessions)
    .where(and(eq(webSessions.id, proof.sessionId), eq(webSessions.userId, principal.userId),
      gt(webSessions.expiresAt, sql`clock_timestamp()`)));
  const [live] = await (lock ? row.for('key share') : row);
  return Boolean(live && !(await authorizeSecurity(db, 'browser', { session_id: sessionId })));
}

/** Caller already passed the thread visibility check. Existing foreign-key targets precede Work. */
async function lockThread(db: Db, principal: WorkPrincipal, sessionId: string) {
  if (principal.kind === 'agent' && principal.tokenId) {
    await db.select({ id: tokens.id }).from(tokens).where(eq(tokens.id, principal.tokenId)).for('key share');
  }
  await db.select({ id: users.id }).from(users).where(eq(users.id, principal.userId)).for('key share');
  const [session] = await db.select().from(debugSessions).where(eq(debugSessions.id, sessionId)).for('no key update');
  if (!session?.projectId || session.status !== 'open') return undefined;
  const [offer] = await db.select().from(handoffs).where(eq(handoffs.sessionId, sessionId)).for('no key update');
  if (!offer || !openAssignment(session, offer)) return undefined;
  // Work corrections lock the project counter FOR UPDATE before replacing links.
  // The managed fence will take UPDATE itself. Acquire that mode here to avoid upgrading.
  await db.select({ id: workProjectCounters.projectId }).from(workProjectCounters)
    .where(eq(workProjectCounters.projectId, session.projectId)).for(principal.kind === 'agent' && principal.grant.execution ? 'update' : 'key share');
  const work = await pinnedWork(db, session, offer);
  return work ? { session, offer, work } : undefined;
}

async function isNamedOnAssignment(db: Db, sessionId: string, installationId: string) {
  const [row] = await db.select({ id: handoffs.id }).from(handoffs)
    .where(and(eq(handoffs.sessionId, sessionId), eq(handoffs.targetInstallationId, installationId),
      eq(handoffs.kind, 'assignment'), inArray(handoffs.state, OPEN_HANDOFF_STATES)));
  return Boolean(row);
}

export async function postWorkQuestion(db: Db, principal: Human, sessionId: string, input: {
  body: unknown; linkId: unknown; requestId: unknown;
}): Promise<QuestionResult<{ messageId: string; at: Date; teamId: string; projectId: string; replayed: boolean }>> {
  const body = normalizedBody(input.body);
  if (!body || !isCanonicalUuid(sessionId) || !isCanonicalUuid(input.linkId) || !isCanonicalUuid(input.requestId)) {
    return { status: 400, error: 'Enter a question of up to 4,000 characters and reload the assignment before trying again.' };
  }
  const linkId = input.linkId.toLowerCase();
  const requestId = input.requestId.toLowerCase();
  return db.transaction(async (tx) => {
    if (!(await sessionForMember(tx, sessionId, principal.userId)) || !(await browserSession(tx, principal, sessionId, true))) return unavailable;
    const current = await lockThread(tx, principal, sessionId);
    if (!current || current.work.link.id !== linkId) return { status: 409, error: 'The assignment or Work revision changed. Reload the thread before asking.' };
    if (!(await browserSession(tx, principal, sessionId))) return unavailable;
    const { session, offer, work } = current;
    const access = await workAccess(tx, principal, session.teamId, work.work.projectId);
    if (!access || !hasContractAuthority(principal, access, work.work)) return unavailable;
    const recipient = await activeRecipient(tx, session, offer);
    if (!recipient) return { status: 409, error: 'The named installation cannot currently receive a Work question.' };
    if (recipient.target?.runtime === CODEX_EXECUTION_RUNTIME) return { status: 409, error: 'This read-only Codex target cannot answer Work questions.' };

    const [old] = await tx.select({ m: messages, recipient: workAssignmentQuestions.recipientInstallationId })
      .from(workAssignmentQuestions).innerJoin(messages, eq(messages.id, workAssignmentQuestions.questionMessageId))
      .where(and(eq(workAssignmentQuestions.assignmentLinkId, linkId), eq(workAssignmentQuestions.requestId, requestId)));
    const scope = { teamId: session.teamId, projectId: work.work.projectId };
    if (old) {
      if (old.m.authorId !== principal.userId || old.m.sessionId !== session.id || old.m.kind !== 'question' ||
          old.m.body !== body || old.recipient !== recipient.installation.id) {
        return { status: 409, error: 'This request was already used for a different question.' };
      }
      return { ...scope, messageId: old.m.id, at: old.m.createdAt, replayed: true };
    }
    const pending = await tx.select({ id: workAssignmentQuestions.questionMessageId }).from(workAssignmentQuestions)
      .where(and(eq(workAssignmentQuestions.assignmentLinkId, linkId), isNull(workAssignmentQuestions.answeredAt))).limit(PENDING_LIMIT);
    if (pending.length >= PENDING_LIMIT) return { status: 409, error: 'This assignment already has five questions awaiting replies.' };
    const [message] = await tx.insert(messages).values({ sessionId: session.id, authorId: principal.userId, kind: 'question',
      via: 'web', body, createdAt: sql`clock_timestamp()` }).returning({ id: messages.id, at: messages.createdAt });
    await tx.insert(workAssignmentQuestions).values({ questionMessageId: message!.id, assignmentLinkId: linkId,
      recipientInstallationId: recipient.installation.id, requestId });
    return { ...scope, messageId: message!.id, at: message!.at, replayed: false };
  });
}

export async function postWorkAnswer(db: Db, principal: Agent, sessionId: string, input: {
  questionId: unknown; body: unknown; via?: string; kind?: string; attachments?: unknown;
}, charge: (db: Db) => Promise<boolean>): Promise<QuestionResult<{
  messageId: string; questionId: string; at: Date; teamId: string; projectId: string; replayed: boolean;
}>> {
  const body = normalizedBody(input.body);
  const via = input.via ? redactSecrets(input.via.trim()) || null : null;
  if (!body || (input.kind !== undefined && input.kind !== 'answer') || input.attachments !== undefined || via?.includes('\0')) {
    return { status: 400, error: 'A Work answer needs up to 4,000 characters, kind answer, and no attachments.' };
  }
  if (!isCanonicalUuid(input.questionId) || !isCanonicalUuid(sessionId) || !principal.installationId) return unavailable;
  const questionId = input.questionId.toLowerCase();
  const digest = fingerprintJson({ body, via });
  return db.transaction(async (tx) => {
    if (!(await sessionForMember(tx, sessionId, principal.userId)) ||
        !(await isNamedOnAssignment(tx, sessionId, principal.installationId!))) return unavailable;
    const current = await lockThread(tx, principal, sessionId);
    if (!current || !(await namedAgent(tx, principal, current.session, current.offer, current.work, 'post_message'))) return unavailable;
    const { session, work } = current;
    const [question] = await tx.select({ q: workAssignmentQuestions }).from(workAssignmentQuestions)
      .innerJoin(messages, eq(messages.id, workAssignmentQuestions.questionMessageId))
      .where(and(eq(workAssignmentQuestions.questionMessageId, questionId), eq(messages.sessionId, session.id),
        eq(messages.kind, 'question'), eq(workAssignmentQuestions.assignmentLinkId, work.link.id),
        eq(workAssignmentQuestions.recipientInstallationId, principal.installationId!)))
      .for('update', { of: workAssignmentQuestions });
    if (!question) return unavailable;
    const { q } = question;
    const scope = { questionId, teamId: session.teamId, projectId: work.work.projectId };
    if (q.answeredAt) {
      if (q.answerFingerprint !== digest) return { status: 409, error: 'This question already has a different answer.' };
      if (!q.replyMessageId) return { status: 409, error: 'This question was already answered. The answer is no longer retained.' };
      return { ...scope, messageId: q.replyMessageId, at: q.answeredAt, replayed: true };
    }
    if (!q.firstServedAt) return { status: 409, error: 'Read this Work question with get_session before answering.' };
    if (!(await charge(tx))) return { status: 429, error: 'Session loop guard: stop posting and check with your human before continuing.' };
    const [message] = await tx.insert(messages).values({ sessionId: session.id, authorId: principal.userId,
      tokenId: principal.tokenId, kind: 'answer', via, body, createdAt: sql`clock_timestamp()` })
      .returning({ id: messages.id, at: messages.createdAt });
    await tx.update(workAssignmentQuestions).set({ replyMessageId: message!.id,
      answerFingerprint: digest, answeredAt: sql`(select ${messages.createdAt} from ${messages} where ${messages.id} = ${message!.id})` })
      .where(eq(workAssignmentQuestions.questionMessageId, questionId));
    return { ...scope, messageId: message!.id, at: message!.at, replayed: false };
  });
}

export interface WorkQuestionContext {
  metadata: Map<string, { id: string; work_id: string; spec_revision: number; awaiting_reply: boolean }>;
  pending: string[];
  exact?: ThreadMessage;
}

/** The builder materializes the final result before we persist inclusion for its actual messages. */
export async function withWorkQuestionContext<T>(db: Db, principal: Agent, sessionId: string,
  input: { exactId?: string; candidates: string[] },
  build: (context: WorkQuestionContext) => { result: T; included: string[] },
): Promise<T | undefined> {
  if (!principal.installationId || principal.grant.accessMode === 'analyst' ||
      !isCanonicalUuid(sessionId) || (input.exactId !== undefined && !isCanonicalUuid(input.exactId))) return undefined;
  const exactId = input.exactId?.toLowerCase();
  if (!(await isNamedOnAssignment(db, sessionId, principal.installationId))) return undefined;
  return db.transaction(async (tx) => {
    const current = await lockThread(tx, principal, sessionId);
    if (!current || !(await namedAgent(tx, principal, current.session, current.offer, current.work, 'get_session'))) return undefined;
    const { session, work } = current;
    const scope = and(eq(workAssignmentQuestions.assignmentLinkId, work.link.id),
      eq(workAssignmentQuestions.recipientInstallationId, principal.installationId!),
      eq(messages.sessionId, session.id), eq(messages.kind, 'question'));
    const selected = exactId ? eq(messages.id, exactId) : or(
      input.candidates.length ? inArray(messages.id, input.candidates) : undefined,
      isNull(workAssignmentQuestions.answeredAt),
    );
    const rows = await tx.select({ q: workAssignmentQuestions, m: messages, author: users.username })
      .from(workAssignmentQuestions).innerJoin(messages, eq(messages.id, workAssignmentQuestions.questionMessageId))
      .leftJoin(users, eq(users.id, messages.authorId)).where(and(scope, selected))
      .orderBy(asc(messages.createdAt), asc(messages.id)).limit(input.candidates.length + PENDING_LIMIT);
    if (exactId && !rows.length) return undefined;
    const metadata = new Map(rows.map(({ q }) => [q.questionMessageId, { id: q.questionMessageId, work_id: work.work.id,
      spec_revision: work.revision, awaiting_reply: q.answeredAt === null }]));
    const pending = exactId ? [] : rows.filter(({ q }) => !q.answeredAt).map(({ q }) => q.questionMessageId);
    const { result, included } = build({ metadata, pending, ...(exactId ? { exact: rows[0]! } : {}) });
    const ids = new Set(included);
    const stamps = rows.filter(({ q }) => !q.firstServedAt && ids.has(q.questionMessageId)).map(({ q }) => q.questionMessageId);
    if (stamps.length) {
      if (!(await namedAgent(tx, principal, session, current.offer, work, 'get_session'))) return undefined;
      await tx.update(workAssignmentQuestions).set({ firstServedAt: sql`clock_timestamp()` })
        .where(and(inArray(workAssignmentQuestions.questionMessageId, stamps), isNull(workAssignmentQuestions.firstServedAt)));
    }
    return result;
  });
}

type QuestionState = 'posted' | 'included' | 'answered' | 'closed' | 'changed' | 'disconnected';
export interface WorkQuestionThreadItem {
  id: string;
  replyId: string | null;
  firstServedAt: Date | null;
  workKey: string;
  revision: number;
  recipient: string;
  state: QuestionState;
}

export async function readWorkQuestionThread(db: Db, principal: Human, session: Session, offer: Handoff, visibleIds: string[]) {
  const open = openAssignment(session, offer);
  const work = open ? await pinnedWork(db, session, offer) : undefined;
  const recipient = work ? await activeRecipient(db, session, offer) : null;
  const access = work ? await workAccess(db, principal, session.teamId, work.work.projectId) : null;
  const mayAsk = Boolean(access && work && hasContractAuthority(principal, access, work.work));
  const composer = work && mayAsk && recipient ? {
    workKey: work.work.displayKey, revision: work.revision, linkId: work.link.id, recipient: recipient.installation.name,
    runtime: recipient.target?.runtime,
  } : undefined;
  const rows = await db.select({
    q: workAssignmentQuestions, key: workItems.displayKey, revision: workLinks.specRevision, recipientName: agentInstallations.name,
  }).from(workAssignmentQuestions)
    .innerJoin(workLinks, eq(workLinks.id, workAssignmentQuestions.assignmentLinkId))
    .innerJoin(workItems, eq(workItems.id, workLinks.workId))
    .innerJoin(messages, eq(messages.id, workAssignmentQuestions.questionMessageId))
    .leftJoin(agentInstallations, eq(agentInstallations.id, workAssignmentQuestions.recipientInstallationId))
    .where(and(eq(messages.sessionId, session.id), eq(workLinks.handoffId, offer.id), or(
      visibleIds.length ? or(inArray(workAssignmentQuestions.questionMessageId, visibleIds),
        inArray(workAssignmentQuestions.replyMessageId, visibleIds)) : undefined,
      work ? and(eq(workAssignmentQuestions.assignmentLinkId, work.link.id), isNull(workAssignmentQuestions.answeredAt)) : undefined,
      // When there is no current work or visible message there is nothing to hydrate.
      sql`false`,
    )))
    .orderBy(asc(messages.createdAt), asc(messages.id)).limit(visibleIds.length + PENDING_LIMIT);
  const byMessage = new Map<string, WorkQuestionThreadItem>();
  const pending: WorkQuestionThreadItem[] = [];
  for (const { q, key, revision, recipientName } of rows) {
    if (revision === null) continue;
    const state: QuestionState = q.answeredAt ? 'answered' : !open ? 'closed' : q.assignmentLinkId !== work?.link.id
      ? 'changed' : !recipient || recipient.installation.id !== q.recipientInstallationId ? 'disconnected'
      : q.firstServedAt ? 'included' : 'posted';
    const item = { id: q.questionMessageId, replyId: q.replyMessageId, firstServedAt: q.firstServedAt,
      workKey: key, revision, recipient: recipientName ?? 'Disconnected installation', state };
    byMessage.set(item.id, item);
    if (item.replyId) byMessage.set(item.replyId, item);
    if (state === 'posted' || state === 'included') pending.push(item);
  }
  return { byMessage, pending, composer };
}
