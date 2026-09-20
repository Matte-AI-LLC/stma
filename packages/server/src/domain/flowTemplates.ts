import {
  deliveryFlowSchema,
  type DeliveryFlow,
  type FlowProvider,
  type TicketSystem,
} from '@bridge/shared';

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
  provider: FlowProvider;
  teamSize: 'solo' | 'small' | 'large';
  protection: 'checks' | 'review' | 'strict';
  release: 'continuous' | 'preview' | 'staged' | 'progressive' | 'release' | 'gitops';
}

export interface FlowTemplate {
  key: string;
  category: 'Foundational' | 'Continuous' | 'Controlled' | 'Specialized';
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
    key: 'trunk-pr',
    category: 'Continuous',
    name: 'Trunk-based continuous deployment',
    oneLiner: 'Short PR → fast checks → merge to main → production.',
    whenToUse:
      'A web service that can ship small changes continuously. Main stays releasable, branches live for hours rather than days, and a green merge deploys.',
    document: parse({
      intro: 'Main is always releasable; small changes deploy as soon as their checks pass.',
      ticket: { system: 'github', keyPattern: '#42', required: false },
      branch: { pattern: '{type}/{slug}', from: 'main' },
      checks: ['npm ci', 'npm test', 'npm run typecheck'],
      review: { approvals: 1 },
      mergeStrategy: 'squash',
      environments: [{ name: 'production', deployOn: 'merge', approval: false }],
      notes: [
        'Branches live for hours, not days; split a change before it becomes difficult to review.',
        'Incomplete user-facing work ships dark behind a feature flag.',
      ],
    }),
    fit: {
      tracker: ['github', 'none', 'jira', 'azure-boards'],
      teamSize: ['small', 'large'],
      release: ['continuous'],
    },
  },
  {
    key: 'preview-cd',
    category: 'Continuous',
    name: 'PR preview → production',
    oneLiner: 'Short branch → checks → isolated preview → review → merge → production.',
    whenToUse:
      'A web product where design, QA or a customer needs to see every change before merge. Each pull request gets a disposable environment.',
    document: parse({
      intro: 'Every pull request gets a disposable preview; merging the reviewed change deploys production.',
      ticket: { system: 'github', keyPattern: '#42', required: false },
      branch: { pattern: '{type}/{slug}', from: 'main' },
      checks: ['npm ci', 'npm test', 'npm run typecheck'],
      review: { approvals: 1 },
      mergeStrategy: 'squash',
      environments: [
        { name: 'preview', deployOn: 'pull-request', approval: false },
        { name: 'production', deployOn: 'merge', approval: false },
      ],
      notes: [
        'The preview is isolated per pull request and is removed when the pull request closes.',
        'Production deploys only from the protected main branch.',
      ],
    }),
    fit: {
      tracker: ['github', 'none'],
      teamSize: ['small', 'large'],
      release: ['preview'],
    },
  },
  {
    key: 'staged-promotion',
    category: 'Controlled',
    name: 'Staged environment promotion',
    oneLiner: 'PR → checks → staging on merge → approved production promotion.',
    whenToUse:
      'A service that should deploy often but still needs a named staging environment and an auditable production decision.',
    document: parse({
      intro: 'A green merge deploys staging; the same change reaches production after an explicit sign-off.',
      ticket: { system: 'github', keyPattern: '#42', required: false },
      branch: { pattern: '{type}/{slug}', from: 'main' },
      checks: ['npm ci', 'npm test', 'npm run typecheck'],
      review: { approvals: 1 },
      mergeStrategy: 'squash',
      environments: [
        { name: 'staging', deployOn: 'merge', approval: false },
        { name: 'production', deployOn: 'merge', approval: true },
      ],
      notes: [
        'Promote the same artifact that passed staging; do not rebuild it for production.',
        'The production environment owns the approval and its audit trail.',
      ],
    }),
    fit: {
      tracker: ['github', 'none'],
      teamSize: ['small', 'large'],
      release: ['staged'],
    },
  },
  {
    key: 'progressive-delivery',
    category: 'Controlled',
    name: 'Progressive delivery',
    oneLiner: 'PR → checks → staging → canary → production, with observed promotion.',
    whenToUse:
      'A user-facing service where blast radius matters. A small production cohort receives the change before the full rollout.',
    document: parse({
      intro: 'A release expands from staging to a canary cohort and only then to the full production fleet.',
      ticket: { system: 'github', keyPattern: '#42', required: false },
      branch: { pattern: '{type}/{slug}', from: 'main' },
      checks: ['npm ci', 'npm test', 'npm run typecheck'],
      review: { approvals: 1 },
      mergeStrategy: 'squash',
      environments: [
        { name: 'staging', deployOn: 'merge', approval: false },
        { name: 'canary', deployOn: 'merge', approval: false },
        { name: 'production', deployOn: 'merge', approval: true },
      ],
      notes: [
        'Automated health checks decide whether the canary may advance.',
        'Stop promotion and roll forward or route traffic back when service health regresses.',
        'Use feature flags when code deployment and feature exposure must move independently.',
      ],
    }),
    fit: {
      tracker: ['github', 'jira', 'azure-boards', 'none'],
      teamSize: ['small', 'large'],
      release: ['progressive'],
    },
  },
  {
    key: 'gitops-promotion',
    category: 'Specialized',
    name: 'GitOps environment promotion',
    oneLiner: 'Build artifact → update desired state in Git → controller reconciles environments.',
    whenToUse:
      'A Kubernetes or declarative platform where CI should publish an artifact and change Git, while a controller owns cluster credentials and reconciliation.',
    document: parse({
      intro: 'CI publishes an immutable artifact and updates desired state in Git; the GitOps controller performs the deployment.',
      ticket: { system: 'jira', keyPattern: 'PROJ-123', required: false },
      branch: { pattern: '{type}/{slug}', from: 'main' },
      checks: ['npm ci', 'npm test', 'docker build -t "$IMAGE" .'],
      review: { approvals: 1 },
      mergeStrategy: 'squash',
      environments: [
        { name: 'staging', deployOn: 'merge', approval: false },
        { name: 'production', deployOn: 'merge', approval: true },
      ],
      notes: [
        'Keep desired-state manifests in a separate repository when application and deployment ownership differ.',
        'CI updates the desired-state revision; it does not receive direct cluster credentials.',
        'The controller reports and reconciles drift between Git and the live environment.',
      ],
    }),
    fit: {
      tracker: ['jira', 'azure-boards', 'github', 'none'],
      teamSize: ['small', 'large'],
      release: ['gitops'],
    },
  },
  {
    key: 'ticket-gated',
    category: 'Controlled',
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
    key: 'release-train',
    category: 'Specialized',
    name: 'Release train',
    oneLiner: 'Work lands on main, QA rides the train, tags cut the release.',
    whenToUse:
      'A product released on a schedule rather than on every merge — mobile apps, versioned APIs, anything a customer installs.',
    document: parse({
      intro: 'Merges keep main releasable; a tagged release is the only road to production.',
      ticket: { system: 'jira', keyPattern: 'PROJ-123', required: false },
      branch: { pattern: 'feature/{ticket}-{slug}', from: 'main' },
      checks: ['npm ci', 'npm test'],
      review: { approvals: 2 },
      mergeStrategy: 'merge',
      environments: [
        { name: 'qa', deployOn: 'merge', approval: false },
        { name: 'production', deployOn: 'tag', approval: true },
      ],
      notes: [
        'Main stays releasable between trains; incomplete customer-facing work remains behind feature flags.',
        'Cut the train from a known green commit and promote that same artifact through QA and production.',
      ],
    }),
    fit: {
      tracker: ['jira', 'azure-boards', 'github', 'none'],
      teamSize: ['solo', 'small', 'large'],
      release: ['release'],
    },
  },
  {
    key: 'solo-ci',
    category: 'Foundational',
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
      release: ['continuous'],
    },
  },
];

export const templateByKey = (key: string): FlowTemplate | undefined =>
  FLOW_TEMPLATES.find((t) => t.key === key);

/** Apply the wizard's explicit answers to the recommended starting document. */
export function flowForRecommendation(
  template: FlowTemplate,
  answers: WizardAnswers,
): DeliveryFlow {
  const approvals =
    answers.protection === 'checks' ? 0 : answers.protection === 'review' ? 1 : 2;
  const keyPattern =
    answers.tracker === 'github'
      ? '#42'
      : answers.tracker === 'none'
        ? ''
        : template.document.ticket.keyPattern || 'PROJ-123';
  return deliveryFlowSchema.parse({
    ...template.document,
    ticket: {
      ...template.document.ticket,
      system: answers.tracker,
      keyPattern,
      required: answers.tracker === 'none' ? false : template.document.ticket.required,
    },
    review: { approvals },
  });
}

/**
 * Score every template against the wizard's answers and say why the winner won.
 *
 * Plain additive scoring with the release model weighted highest: preview,
 * progressive and GitOps answers must not collapse back into a generic PR flow.
 * The tracker remains the strongest secondary signal. Deterministic
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
    if (template.fit.release.includes(answers.release)) score += 4;
    if (template.fit.tracker.includes(answers.tracker)) score += 3;
    if (template.fit.teamSize.includes(answers.teamSize)) score += 2;
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
    const releaseReason: Record<WizardAnswers['release'], string> = {
      continuous: 'ships on every merge',
      preview: 'creates a deployable preview for every pull request',
      staged: 'reaches production through named environments',
      progressive: 'limits blast radius with a progressive rollout',
      release: 'cuts releases by tag',
      gitops: 'lets a GitOps controller reconcile desired state',
    };
    reasons.push(releaseReason[answers.release]);
  }
  if (best.fit.teamSize.includes(answers.teamSize)) {
    reasons.push(
      answers.teamSize === 'solo'
        ? 'is sized for one person'
        : `is sized for a ${answers.teamSize} team`,
    );
  }
  reasons.push(
    `will render for ${answers.provider === 'github-actions' ? 'GitHub Actions' : 'Azure DevOps'}`,
  );
  return { template: best, reasons };
}
