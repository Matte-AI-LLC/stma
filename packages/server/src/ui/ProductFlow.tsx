import type { Child } from 'hono/jsx';
import { initials } from '../lib/format';

/** Shared grammar of the product-flow design. Every status is supplied by its read model. */
export const FlowSteps = ({
  steps,
  current,
}: {
  steps: { title: string; detail: string; at?: Date | null }[];
  current: number;
}) => (
  <ol class="flow-steps" aria-label="Progress">
    {steps.map((step, i) => (
      <li
        class={i < current ? 'done' : i === current ? 'current' : ''}
        aria-current={i === current ? 'step' : undefined}
      >
        <span class="flow-step-number" aria-hidden="true">
          {i < current ? '✓' : i + 1}
        </span>
        <div>
          <b>{step.title}</b>
          <p>{step.detail}</p>
          {step.at && (
            <time dateTime={step.at.toISOString()}>
              {step.at.toISOString().replace('T', ' ').slice(0, 19)} UTC
            </time>
          )}
        </div>
      </li>
    ))}
  </ol>
);

export const ScopePill = ({
  workspace,
  project,
}: {
  workspace: string;
  project?: string | null;
}) => (
  <span class="flow-scope">
    {workspace} / {project ?? 'workspace'}
  </span>
);

export const FlowSection = ({ title, children }: { title: string; children: Child }) => (
  <section class="flow-section">
    <h2>{title}</h2>
    {children}
  </section>
);

export const Identity = ({
  human,
  agent,
  device,
}: {
  human: string;
  agent?: string | null;
  device?: string | null;
}) => (
  <span class="flow-identity">
    <span class="avatar light" aria-hidden="true">
      {initials(human)}
    </span>
    <span>{human}</span>
    {agent && (
      <>
        <span class="tile tile-28 tile-green" aria-hidden="true">
          {initials(agent)}
        </span>
        <span>{agent}</span>
      </>
    )}
    {device && <span class="flow-device">{device}</span>}
  </span>
);

export const FlowEmpty = ({ title, children }: { title: string; children: Child }) => (
  <div class="flow-empty">
    <h3>{title}</h3>
    {children}
  </div>
);
