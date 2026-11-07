import { randomUUID } from 'node:crypto';
import { CODEX_EXECUTION_RUNTIME, EXECUTION_RUNTIME } from '@bridge/shared';
import { WORK_QUESTION_BODY_LIMIT, type WorkQuestionThreadItem } from '../domain/workQuestions';

type Composer = { workKey: string; revision: number; linkId: string; recipient: string; runtime?: string };

export const threadMessageId = (id: string) => 'message-' + id;
export const threadMessageHref = (sessionId: string, id: string) =>
  `/app/sessions/${sessionId}?message=${id}#${threadMessageId(id)}`;

function label(item: WorkQuestionThreadItem) {
  switch (item.state) {
    case 'answered': return `Answered for revision ${item.revision}`;
    case 'closed': return 'Assignment closed';
    case 'changed': return 'Work link or revision changed';
    case 'disconnected': return 'Installation disconnected';
    case 'included': return 'Included in context · awaiting reply';
    case 'posted': return 'Posted · awaiting reply';
  }
}

export function WorkQuestionThread({ sessionId, pending, composer }: {
  sessionId: string; pending: WorkQuestionThreadItem[]; composer?: Composer;
}) {
  if (!pending.length && !composer) return null;
  return (
    <section class="card card-pad" id="work-questions">
      <h2 class="h3 m0">Work questions</h2>
      {pending.length ? (
        <ul class="small">
          {pending.map((item) => (
            <li>
              <a href={threadMessageHref(sessionId, item.id)}>{item.workKey} · revision {item.revision}</a>
              {' — '}{label(item)}
            </li>
          ))}
        </ul>
      ) : null}
      {composer?.runtime === CODEX_EXECUTION_RUNTIME ? (
        <p class="small muted">This read-only Codex target cannot answer Work questions. Use the thread for ordinary messages.</p>
      ) : composer ? (
        <form method="post" action={`/app/sessions/${sessionId}/messages`} class="form">
          <input type="hidden" name="mode" value="work_question" />
          <input type="hidden" name="expected_work_link_id" value={composer.linkId} />
          <input type="hidden" name="request_id" value={randomUUID()} />
          <label class="field">
            <span>Ask {composer.recipient} about {composer.workKey}, revision {composer.revision}</span>
            <textarea class="in" name="body" required maxlength={WORK_QUESTION_BODY_LIMIT} rows={3} />
          </label>
          <p class="small muted">
            {composer.runtime === EXECUTION_RUNTIME
              ? 'The question waits in this thread for a current managed attempt to read it.'
              : 'The named installation can read and answer this question through STMA.'}
          </p>
          <button class="btn btn-primary" type="submit">Post Work question</button>
        </form>
      ) : null}
    </section>
  );
}

export function WorkQuestionMessage({ item, messageId, sessionId }: {
  item: WorkQuestionThreadItem; messageId: string; sessionId: string;
}) {
  if (messageId === item.replyId) return (
    <p class="small muted">
      Answer to <a href={threadMessageHref(sessionId, item.id)}>{item.workKey} · revision {item.revision}</a>
    </p>
  );
  const includedAt = item.firstServedAt?.toISOString();
  return (
    <div class="small muted">
      <p>{item.workKey} · revision {item.revision} · for {item.recipient}</p>
      <p><strong>{label(item)}</strong>
        {item.replyId ? <> · <a href={threadMessageHref(sessionId, item.replyId)}>View answer</a></> : null}
        {item.state === 'answered' && !item.replyId ? ' · Answer no longer retained' : null}
      </p>
      {includedAt ? (
        <p title="The server prepared a tool result containing this question for the named installation.">
          Included in context <time datetime={includedAt}>{includedAt.slice(0, 16).replace('T', ' ')} UTC</time>
        </p>
      ) : null}
    </div>
  );
}
