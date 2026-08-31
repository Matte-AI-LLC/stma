import {
  DEPLOY_TRIGGERS,
  MERGE_STRATEGIES,
  TICKET_SYSTEMS,
  deliveryFlowSchema,
  type DeliveryFlow,
  type DeployTrigger,
  type FlowEnvironment,
} from '@bridge/shared';
import { linesToList, listToLines } from './policyForm';

/**
 * The delivery-flow designer as form fields, following lib/policyForm: lists
 * are one item per line, and the parser answers with *which field* is wrong.
 *
 * Environments use one line per environment — `stage = merge`,
 * `uat = manual, approval` — because a table of dynamic rows needs client
 * scripting this app does not have, and a line per row is how the person who
 * wrote the original onboarding document typed it anyway.
 */

export function linesToEnvironments(
  raw: unknown,
): { environments: FlowEnvironment[] } | { error: string } {
  const environments: FlowEnvironment[] = [];
  for (const line of linesToList(raw)) {
    const [left, ...flags] = line.split(',').map((part) => part.trim());
    const eq = left!.indexOf('=');
    const name = (eq === -1 ? left! : left!.slice(0, eq)).trim();
    const trigger = eq === -1 ? 'manual' : left!.slice(eq + 1).trim();
    if (!DEPLOY_TRIGGERS.includes(trigger as DeployTrigger)) {
      return {
        error: `environments: "${line}" — the part after = must be one of ${DEPLOY_TRIGGERS.join(', ')}.`,
      };
    }
    const unknownFlag = flags.find((f) => f && f !== 'approval');
    if (unknownFlag) {
      return { error: `environments: "${line}" — the only flag after the comma is "approval".` };
    }
    environments.push({
      name,
      deployOn: trigger as DeployTrigger,
      approval: flags.includes('approval'),
    });
  }
  return { environments };
}

export const environmentsToLines = (environments: readonly FlowEnvironment[]): string =>
  environments
    .map((env) => `${env.name} = ${env.deployOn}${env.approval ? ', approval' : ''}`)
    .join('\n');

export function flowFromForm(
  form: Record<string, unknown>,
): { document: DeliveryFlow } | { error: string } {
  const envs = linesToEnvironments(form.environments);
  if ('error' in envs) return envs;
  const ticketSystem = String(form.ticketSystem ?? 'none');
  if (!TICKET_SYSTEMS.includes(ticketSystem as (typeof TICKET_SYSTEMS)[number])) {
    return { error: `ticket: unknown tracker "${ticketSystem}".` };
  }
  const mergeStrategy = String(form.mergeStrategy ?? 'squash');
  if (!MERGE_STRATEGIES.includes(mergeStrategy as (typeof MERGE_STRATEGIES)[number])) {
    return { error: `merge: unknown strategy "${mergeStrategy}".` };
  }
  const approvals = Number(String(form.approvals ?? '').trim() || '0');
  const parsed = deliveryFlowSchema.safeParse({
    intro: String(form.intro ?? '').trim(),
    ticket: {
      system: ticketSystem,
      keyPattern: String(form.ticketKeyPattern ?? '').trim(),
      required: form.ticketRequired === 'on' || form.ticketRequired === true,
    },
    branch: {
      pattern: String(form.branchPattern ?? '').trim() || 'feature/{ticket}-{slug}',
      from: String(form.branchFrom ?? '').trim() || 'main',
    },
    checks: linesToList(form.checks),
    review: { approvals: Number.isInteger(approvals) && approvals >= 0 ? approvals : 0 },
    mergeStrategy,
    environments: envs.environments,
    notes: linesToList(form.notes),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join('.') || 'the flow';
    return { error: `${where}: ${issue?.message ?? 'is not valid'}` };
  }
  return { document: parsed.data };
}

export { listToLines };
