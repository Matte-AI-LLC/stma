import { deliveryFlowSchema, type DeliveryFlow, type TicketSystem } from '@bridge/shared';

/**
 * The built-in delivery templates: opinionated starting points, in code rather
 * than the database, because they are product content — reviewed like code,
 * versioned like code, identical on every instance.
 *
 * Each carries the full flow document (the designer opens on it) and a `fit`
 * block the wizard scores against. The scoring must stay boring: a template is
 * a recommendation somebody can read the reason for, not a model.
 */

export interface WizardAnswers {
  tracker: TicketSystem;
  teamSize: 'solo' | 'small' | 'large';
  protection: 'checks' | 'review' | 'strict';
  release: 'continuous' | 'staged' | 'release';
}

export interface FlowTemplate {
  key: string;
  name: string;
  oneLiner: string;
  whenToUse: string;
  document: DeliveryFlow;
  fit: {
    tracker: TicketSystem[];
    teamSize: WizardAnswers['teamSize'][];
    release: WizardAnswers['release'][];
  };
}

const parse = (doc: unknown): DeliveryFlow => deliveryFlowSchema.parse(doc);

export const FLOW_TEMPLATES: FlowTemplate[] = [
  {
    key: 'ticket-gated',
    name: 'Ticket-gated delivery',
    oneLiner: 'Jira ticket → branch → PR → approval → merge → stage → UAT → prod.',
    whenToUse:
      'A team where every change answers to a ticket and production is reached through named environments with sign-off. The classic enterprise flow, written down.',
    document: parse({
      intro: 'Every change starts as a ticket and reaches production through stage and UAT.',
      ticket: { system: 'jira', keyPattern: 'PROJ-123', required: true },
      branch: { pattern: 'feature/{ticket}-{slug}', from: 'main' },
      checks: ['npm ci', 'npm test'],
      review: { approvals: 1 },
      mergeStrategy: 'squash',
      environments: [
        { name: 'stage', deployOn: 'merge', approval: false },
        { name: 'uat', deployOn: 'manual', approval: true },
        { name: 'prod', deployOn: 'manual', approval: true },
      ],
      notes: [
        'The PR title carries the ticket key, so the tracker links itself.',
        'UAT sign-off belongs to the person who owns the ticket, not the person who wrote the code.',
      ],
    }),
    fit: {
      tracker: ['jira', 'azure-boards'],
      teamSize: ['small', 'large'],
      release: ['staged'],
    },
  },
  {
    key: 'trunk-pr',
    name: 'Trunk + PR validation',
    oneLiner: 'Short branches off main, checks on every PR, deploy on merge, tag for production.',
    whenToUse:
      'A team shipping continuously from one branch. Protection comes from the checks and one review, not from long-lived environments.',
    document: parse({
      intro: 'Main is always releasable; branches live hours, not weeks.',
      ticket: { system: 'github', keyPattern: '#42', required: false },
      branch: { pattern: '{type}/{slug}', from: 'main' },
      checks: ['npm ci', 'npm test', 'npm run typecheck'],
      review: { approvals: 1 },
      mergeStrategy: 'squash',
      environments: [
        { name: 'staging', deployOn: 'merge', approval: false },
        { name: 'production', deployOn: 'tag', approval: true },
      ],
      notes: ['A change too big for one reviewer to read is two changes.'],
    }),
    fit: {
      tracker: ['github', 'none'],
      teamSize: ['small', 'large'],
      release: ['continuous'],
    },
  },
  {
    key: 'release-train',
    name: 'Release train',
    oneLiner: 'Work lands on develop, QA rides the train, tags cut the release.',
    whenToUse:
      'A product released on a schedule rather than on every merge — mobile apps, versioned APIs, anything a customer installs.',
    document: parse({
      intro: 'Merges land on develop; a tagged release is the only road to production.',
      ticket: { system: 'jira', keyPattern: 'PROJ-123', required: false },
      branch: { pattern: 'feature/{ticket}-{slug}', from: 'develop' },
      checks: ['npm ci', 'npm test'],
      review: { approvals: 2 },
      mergeStrategy: 'merge',
      environments: [
        { name: 'qa', deployOn: 'merge', approval: false },
        { name: 'production', deployOn: 'tag', approval: true },
      ],
      notes: ['Nothing merges to develop in the two days before a train leaves.'],
    }),
    fit: {
      tracker: ['jira', 'azure-boards', 'github'],
      teamSize: ['large'],
      release: ['release'],
    },
  },
  {
    key: 'solo-ci',
    name: 'Solo CI',
    oneLiner: 'Push, checks run, done — the smallest pipeline that still catches you.',
    whenToUse:
      'One person, or a project with no deploy target yet. The value is the checks running somewhere that is not your machine.',
    document: parse({
      intro: 'Checks on every push; no environments until there is somewhere to deploy.',
      ticket: { system: 'none', keyPattern: '', required: false },
      branch: { pattern: '{slug}', from: 'main' },
      checks: ['npm ci', 'npm test'],
      review: { approvals: 0 },
      mergeStrategy: 'merge',
      environments: [],
      notes: [],
    }),
    fit: {
      tracker: ['none', 'github'],
      teamSize: ['solo'],
      release: ['continuous', 'release', 'staged'],
    },
  },
];

export const templateByKey = (key: string): FlowTemplate | undefined =>
  FLOW_TEMPLATES.find((t) => t.key === key);

/**
 * Score every template against the wizard's answers and say why the winner won.
 *
 * Plain additive scoring with the tracker weighted highest — the tracker is the
 * answer people are least willing to change for a template. Deterministic
 * tie-break by catalog order, so the same answers always recommend the same
 * template and a test can pin it.
 */
export function recommendTemplate(answers: WizardAnswers): {
  template: FlowTemplate;
  reasons: string[];
} {
  let best = FLOW_TEMPLATES[0]!;
  let bestScore = -1;
  for (const template of FLOW_TEMPLATES) {
    let score = 0;
    if (template.fit.tracker.includes(answers.tracker)) score += 3;
    if (template.fit.teamSize.includes(answers.teamSize)) score += 2;
    if (template.fit.release.includes(answers.release)) score += 2;
    // Strict protection nudges toward templates that already demand review.
    if (answers.protection === 'strict' && template.document.review.approvals >= 2) score += 1;
    if (answers.protection === 'checks' && template.document.review.approvals === 0) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = template;
    }
  }
  const reasons: string[] = [];
  if (best.fit.tracker.includes(answers.tracker)) {
    reasons.push(
      answers.tracker === 'none'
        ? 'works without a ticket tracker'
        : `is built around a ${answers.tracker === 'github' ? 'GitHub issues' : answers.tracker === 'jira' ? 'Jira' : 'Azure Boards'} tracker`,
    );
  }
  if (best.fit.release.includes(answers.release)) {
    reasons.push(
      answers.release === 'continuous'
        ? 'ships on every merge'
        : answers.release === 'staged'
          ? 'reaches production through named environments'
          : 'cuts releases by tag',
    );
  }
  if (best.fit.teamSize.includes(answers.teamSize)) {
    reasons.push(
      answers.teamSize === 'solo'
        ? 'is sized for one person'
        : `is sized for a ${answers.teamSize} team`,
    );
  }
  return { template: best, reasons };
}
