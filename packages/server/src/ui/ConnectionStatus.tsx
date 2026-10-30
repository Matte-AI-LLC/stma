import {
  AUTHORIZATION_SOURCE_LABEL,
  CONTACT_SOURCE_LABEL,
  WORK_STEP_LABEL,
  type ConnectionState,
  type WorkDescription,
} from '../domain/connectionState';
import { CLAUDE_APP_TERM } from '../lib/entry';
import { timeAgo } from '../lib/format';

/**
 * One connection, in five separate facts.
 *
 * A single green pill told a reader that something was connected, listening,
 * working and healthy, and STMA knows none of the last three. Each line here
 * names what was observed, when, and from what; what STMA cannot see is listed,
 * not hinted at. The words idle, online, offline, running and healthy are not
 * used for a connection or a run: STMA has no process heartbeat, only requests
 * that arrived with a credential. `connection-state.test.ts` fails on them.
 */

const When = ({ at, fallback }: { at: Date | null; fallback: string }) =>
  at ? (
    <time datetime={at.toISOString()} title={at.toISOString()}>
      {timeAgo(at)}
    </time>
  ) : (
    <span>{fallback}</span>
  );

const AUTH_PILL: Record<string, string> = {
  authorized: 'pill-active',
  sign_in_again: 'pill-warn',
};

const ADAPTER_WORDS: Record<string, string> = {
  not_applicable: 'not applicable',
  installed_by_connect: 'installed by stma connect',
  paired: 'paired',
  not_reported: 'none reported',
  unpaired_adapter: 'adapter not paired',
};

const TASK_WORDS: Record<string, string> = {
  no_run_reported: 'no run reported',
  run_reported: 'run reported',
  heartbeat_overdue: 'heartbeat overdue',
  waiting_for_person: 'waiting for a person',
};

export const ConnectionStatus = ({ state }: { state: ConnectionState }) => {
  const { authorization, adapter, lastContact, task, nextStep } = state;
  const isConsole = state.kind === 'console';
  const kindWords =
    isConsole ? CLAUDE_APP_TERM : state.kind === 'adapter' ? 'Local adapter' : 'Coding agent';
  return (
    <div data-connection-kind={state.kind}>
      <dl class="cstate">
        <dt>Kind</dt>
        <dd>{kindWords}</dd>
        <dt>Authorization</dt>
        <dd title={authorization.note}>
          <span class={`pill ${AUTH_PILL[authorization.state] ?? 'pill-muted'}`}>{authorization.label}</span>{' '}
          {authorization.observedAt ? (
            <>
              <When at={authorization.observedAt} fallback="" /> · from {AUTHORIZATION_SOURCE_LABEL[authorization.source]}
            </>
          ) : null}
        </dd>
        {isConsole ? null : (
          <>
            <dt>Local adapter</dt>
            <dd>
              {ADAPTER_WORDS[adapter.state]}
              {adapter.observedAt ? (
                <>
                  {' '}
                  · <When at={adapter.observedAt} fallback="" />
                </>
              ) : null}
              <span class="cstate-note">{adapter.note}</span>
            </dd>
          </>
        )}
        <dt>Last contact</dt>
        <dd>
          <When at={lastContact.at} fallback="never recorded" />
          {lastContact.at ? ` · ${CONTACT_SOURCE_LABEL[lastContact.source]}` : null}
        </dd>
        {isConsole ? null : (
          <>
            <dt>Task</dt>
            <dd>
              {TASK_WORDS[task.state]}
              {task.observedAt ? (
                <>
                  {' '}
                  · <When at={task.observedAt} fallback="" />
                </>
              ) : null}
              <span class="cstate-note">{task.note}</span>
            </dd>
          </>
        )}
        <dt>Next step</dt>
        <dd>
          {nextStep.href ? <a href={nextStep.href}>{nextStep.text}</a> : nextStep.text}
          {nextStep.command ? (
            <span class="cstate-cmd">
              <code>{nextStep.command}</code>
              <button class="copybtn" type="button" data-copy={nextStep.command}>
                Copy
              </button>
            </span>
          ) : null}
        </dd>
      </dl>
      <details class="cstate-unknown">
        <summary>What STMA cannot see</summary>
        <ul>
          {state.unknown.map((item) => (
            <li>Unknown: {item}.</li>
          ))}
        </ul>
        <p class="small muted m0">
          STMA records requests that arrive with this connection's credential. It has no process
          heartbeat and cannot read a checkout.
        </p>
      </details>
    </div>
  );
};

/**
 * The recorded life of one piece of dispatched work. Steps appear only when the
 * record that proves them exists; the sentence about the hook says what is not
 * known. `notObserved` adds the standing line, so a list of rows can print it
 * once instead of per row.
 */
export const WorkSteps = ({
  work,
  notObserved = false,
}: {
  work: WorkDescription;
  notObserved?: boolean;
}) => (
  <div>
    <ol class="wsteps">
      {work.steps.map((step) => (
        <li title={`${step.at.toISOString()} · ${step.source}`}>
          {WORK_STEP_LABEL[step.step]} {timeAgo(step.at) ?? ''}
        </li>
      ))}
    </ol>
    {work.hook ? <p class="wsteps-note">{work.hook}</p> : null}
    {notObserved ? <p class="wsteps-note">{work.notObserved}</p> : null}
  </div>
);
