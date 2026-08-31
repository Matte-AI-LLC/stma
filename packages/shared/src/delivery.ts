import { z } from 'zod';

/**
 * The delivery-flow document: how work is supposed to move in this team, from
 * "where does a change start" to "how does it reach production".
 *
 * Modelled after a real onboarding document — a team lead writes "Jira ticket →
 * branch named after it → PR → approval → merge → stage → UAT → prod" in a
 * markdown file and every new person (and now every agent) is expected to obey
 * it. This schema is that page as data, so STMA can hand agents the same rules
 * as prose, draw them as a picture, and render the matching CI pipeline —
 * three views of one document instead of three documents that drift.
 *
 * It lives in the shared package for the same reason the policy schema does:
 * the server stores and serves it, agents receive it over MCP, and the CLI may
 * grow a `stma flow` verb — one schema, every boundary.
 */

export const TICKET_SYSTEMS = ['jira', 'github', 'azure-boards', 'none'] as const;
export type TicketSystem = (typeof TICKET_SYSTEMS)[number];

export const DEPLOY_TRIGGERS = ['merge', 'tag', 'manual'] as const;
export type DeployTrigger = (typeof DEPLOY_TRIGGERS)[number];

export const MERGE_STRATEGIES = ['merge', 'squash', 'rebase'] as const;
export type MergeStrategy = (typeof MERGE_STRATEGIES)[number];

/** CI providers a flow can render a pipeline for. */
export const FLOW_PROVIDERS = ['azure-devops', 'github-actions'] as const;
export type FlowProvider = (typeof FLOW_PROVIDERS)[number];

export const flowEnvironmentSchema = z.object({
  /** "stage", "uat", "prod" — also the CI environment name. */
  name: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[a-zA-Z0-9._-]+$/, 'letters, digits, dots, dashes'),
  /** What sends a build here: every merge, a version tag, or a person. */
  deployOn: z.enum(DEPLOY_TRIGGERS).default('manual'),
  /** Somebody signs off before the deploy runs (approval gate on the CI environment). */
  approval: z.boolean().default(false),
});
export type FlowEnvironment = z.infer<typeof flowEnvironmentSchema>;

export const deliveryFlowSchema = z.object({
  /** One sentence a newcomer reads first. */
  intro: z.string().trim().max(300).default(''),
  ticket: z
    .object({
      system: z.enum(TICKET_SYSTEMS).default('none'),
      /** Example key, e.g. "PROJ-123" — the shape, not a real ticket. */
      keyPattern: z.string().trim().max(60).default(''),
      /** Work must not start without a ticket. */
      required: z.boolean().default(false),
    })
    .default({}),
  branch: z
    .object({
      /** Naming rule with placeholders: {ticket}, {slug}, {type}. */
      pattern: z.string().trim().min(1).max(120).default('feature/{ticket}-{slug}'),
      /** The branch work forks from and merges back to. */
      from: z.string().trim().min(1).max(60).default('main'),
    })
    .default({}),
  /** Commands that must pass before a PR is opened; also the CI check stage. */
  checks: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  review: z
    .object({
      /** Approvals a PR needs before merge. 0 means none required. */
      approvals: z.number().int().min(0).max(10).default(1),
    })
    .default({}),
  mergeStrategy: z.enum(MERGE_STRATEGIES).default('squash'),
  /** The road to production, in order. Empty means CI-only, no deploys. */
  environments: z.array(flowEnvironmentSchema).max(8).default([]),
  /** Extra house rules that fit no field above. */
  notes: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
});
export type DeliveryFlow = z.infer<typeof deliveryFlowSchema>;

export const EMPTY_DELIVERY_FLOW: DeliveryFlow = deliveryFlowSchema.parse({});

/** "PAY-421" — the shape of a Jira/Azure Boards ticket key, case-tolerant. */
export const TICKET_KEY_RE = /[A-Za-z][A-Za-z0-9]+-\d+/;

/**
 * The flow's branch naming rule as a regex. Placeholders become character
 * classes ({ticket} the ticket shape, everything else a slug segment); the
 * literal parts must match literally. Tolerant of case in the ticket half,
 * because "feature/pay-421-fix" is how the key actually gets typed.
 */
export function branchPatternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const holes = escaped
    .replace(/\\\{ticket\\\}/g, '[A-Za-z][A-Za-z0-9]*-\\d+')
    .replace(/\\\{[a-zA-Z]+\\\}/g, '[A-Za-z0-9._-]+');
  return new RegExp(`^${holes}$`);
}

/**
 * What the delivery flow would say about this run, at the moment starting it is
 * still cheap to change. Advice, never refusal — the same stance as readiness:
 * a gate an agent can route around is worse than a sentence it can read.
 */
export function flowAdvice(
  flow: DeliveryFlow,
  run: { taskKey?: string | null; branch?: string | null },
): string[] {
  const warnings: string[] = [];
  const task = run.taskKey?.trim() ?? '';
  if (flow.ticket.required && flow.ticket.system !== 'none') {
    const ticketish =
      flow.ticket.system === 'github' ? /#\d+/.test(task) : TICKET_KEY_RE.test(task);
    if (!ticketish) {
      const shape =
        flow.ticket.system === 'github' ? '"#42"' : `"${flow.ticket.keyPattern || 'PROJ-123'}"`;
      warnings.push(
        `This team's delivery flow says work starts from a ticket (key like ${shape}) and this run names none. Ask your human which ticket this is, then restart the run with it as the task — the tracker is how the rest of the team finds this work.`,
      );
    }
  }
  const branch = run.branch?.trim();
  if (branch && flow.branch.pattern && !branchPatternToRegex(flow.branch.pattern).test(branch)) {
    warnings.push(
      `Branch "${branch}" does not follow this team's naming rule "${flow.branch.pattern}" (from ${flow.branch.from}). Rename it before opening the PR, or say out loud why this one is an exception.`,
    );
  }
  return warnings;
}
