import type { DeliveryFlow, FlowProvider } from '@bridge/shared';
import { FLOW_PROVIDERS, MERGE_STRATEGIES, TICKET_SYSTEMS } from '@bridge/shared';
import { and, desc, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { loginRedirect } from '../auth/session';
import {
  deliverySetups,
  deliverySetupReceipts,
  projects,
  providerObservations,
  repositoryBindings,
} from '../db/schema';
import { projectForTeam, teamForUser } from '../domain/access';
import {
  AGENT_SETUP_MODES,
  agentSetupManifest,
  renderAgentSetupMarkdown,
  type AgentSetupGovernance,
  type AgentSetupMode,
} from '../domain/agentSetup';
import { receiveSetupReceipt, setupReceiptSchema } from '../domain/setupReceipts';
import {
  archiveDeliveryFlow,
  flowBrief,
  listDeliveryFlows,
  parseFlowDocument,
  pipelineIsScaffold,
  renderPipeline,
  saveDeliveryFlow,
  type FlowRow,
} from '../domain/delivery';
import {
  adoForTeam,
  githubForTeam,
  integrationFor,
  jiraForTeam,
  saveIntegration,
} from '../domain/integrations';
import { effectivePolicy } from '../domain/policies';
import {
  FLOW_TEMPLATES,
  flowForRecommendation,
  recommendTemplate,
  templateByKey,
  type WizardAnswers,
} from '../domain/flowTemplates';
import { adoLocator, describeAdoFailure, setupPipeline, type AdoHealth } from '../lib/azureDevops';
import { environmentsToLines, flowFromForm, listToLines } from '../lib/flowForm';
import { timeAgo } from '../lib/format';
import { failed } from '../lib/result';
import { track } from '../lib/track';
import { ensureRail } from '../lib/rail';
import { projectInPath, scopedProjectParam, sectionHref } from '../lib/scope';
import type { AppEnv } from '../types';
import { Band, Field, Inspector, Lead, PageHead, teamTrail, Vr } from '../ui/Console';
import { FlowEmpty, FlowSection, ScopePill } from '../ui/ProductFlow';
import { FlowDiagram } from '../ui/FlowDiagram';
import { AppLayout } from '../ui/Layout';
import { AdoTokenHelp } from '../ui/TokenHelp';

export const deliveryRoutes = new Hono<AppEnv>();

const FLOW_LIMIT = 25;
const PROJECT_LIMIT = 50;

const PROVIDER_LABELS: Record<string, string> = {
  'azure-devops': 'Azure DevOps',
  'github-actions': 'GitHub Actions',
};

const TICKET_LABELS: Record<string, string> = {
  jira: 'Jira',
  github: 'GitHub issues',
  'azure-boards': 'Azure Boards',
  none: 'No tracker',
};

// ------------------------------------------------------------------- wizard

/** The five questions, with every answer the scorer accepts. */
const WIZARD = [
  {
    key: 'tracker',
    q: 'Where does a change start?',
    options: [
      ['jira', 'A Jira ticket'],
      ['azure-boards', 'An Azure Boards work item (workflow rule only)'],
      ['github', 'A GitHub issue'],
      ['none', 'Someone just starts — no tracker'],
    ],
  },
  {
    key: 'provider',
    q: 'Where should CI run?',
    options: [
      ['azure-devops', 'Azure DevOps Pipelines'],
      ['github-actions', 'GitHub Actions'],
    ],
  },
  {
    key: 'teamSize',
    q: 'How many people touch this code?',
    options: [
      ['solo', 'Just me'],
      ['small', '2–5 people'],
      ['large', '6 or more'],
    ],
  },
  {
    key: 'protection',
    q: 'What stands between a change and the main branch?',
    options: [
      ['checks', 'Passing checks are enough'],
      ['review', 'Checks plus one review'],
      ['strict', 'Checks plus several approvals'],
    ],
  },
  {
    key: 'release',
    q: 'How do changes reach the people using them?',
    options: [
      ['continuous', 'Every merge ships'],
      ['preview', 'Every pull request gets a preview; merge ships'],
      ['staged', 'Through stage/UAT with sign-off'],
      ['progressive', 'Through a canary or blue/green rollout'],
      ['release', 'As versioned releases, on a schedule'],
      ['gitops', 'A GitOps controller reconciles desired state'],
    ],
  },
] as const;

function wizardAnswers(query: (k: string) => string | undefined): WizardAnswers | null {
  const picked: Record<string, string> = {};
  for (const step of WIZARD) {
    const value = query(step.key);
    if (!value || !step.options.some(([v]) => v === value)) return null;
    picked[step.key] = value;
  }
  return picked as unknown as WizardAnswers;
}

interface AgentSetupSource {
  document: DeliveryFlow;
  name: string;
  templateKey: string;
  provider: FlowProvider;
  version?: number;
  project?: string | null;
}

type FlowListing = Awaited<ReturnType<typeof listDeliveryFlows>>;

const agentModeFrom = (value: string | undefined): AgentSetupMode =>
  AGENT_SETUP_MODES.includes(value as AgentSetupMode)
    ? (value as AgentSetupMode)
    : 'propose-then-apply';

const providerFrom = (value: string | undefined): FlowProvider =>
  FLOW_PROVIDERS.includes(value as FlowProvider) ? (value as FlowProvider) : 'azure-devops';

/** Resolve only sources a member can already open on the Delivery page. */
function agentSetupSource(
  query: (key: string) => string | undefined,
  flows: FlowListing,
  teamProjects: { id: string; name: string }[],
): { source: AgentSetupSource } | { error: string } {
  const flowId = query('flow');
  if (flowId) {
    const selected = flows.find((row) => row.flow.id === flowId);
    if (!selected) return { error: 'That delivery flow is not available in this team.' };
    return {
      source: {
        document: parseFlowDocument(selected.flow.document),
        name: selected.flow.name,
        templateKey: selected.flow.templateKey,
        provider: providerFrom(selected.flow.provider),
        version: selected.flow.version,
        project: selected.projectName,
      },
    };
  }

  const explicit = templateByKey(query('template') ?? '');
  const answers = query('wizard') ? wizardAnswers(query) : null;
  const recommendation = answers ? recommendTemplate(answers) : null;
  const template = explicit ?? recommendation?.template;
  if (!template) {
    return {
      error: 'Choose a blueprint or open a published flow before preparing an agent setup pack.',
    };
  }
  const requestedProject = query('agentProject')?.trim() ?? '';
  const project = requestedProject
    ? teamProjects.find((candidate) => candidate.name === requestedProject)?.name
    : null;
  if (requestedProject && !project) {
    return { error: `Project "${requestedProject}" is not available in this team.` };
  }
  return {
    source: {
      document:
        answers && recommendation && !explicit
          ? flowForRecommendation(recommendation.template, answers)
          : template.document,
      name: template.name,
      templateKey: template.key,
      provider: answers?.provider ?? providerFrom(query('provider')),
      project,
    },
  };
}

async function governanceSnapshot(
  db: AppEnv['Variables']['db'],
  userId: string,
  team: string,
  project?: string | null,
): Promise<AgentSetupGovernance> {
  const result = await effectivePolicy(db, userId, {
    team,
    project: project ?? undefined,
  });
  if ('error' in result) throw new Error(result.error);
  return {
    scope: project ? 'project' : 'team',
    project: project ?? undefined,
    hash: result.hash,
    document: result.document,
    sources: result.sources.map((source) => ({
      scope: source.scope,
      version: source.version,
      hash: source.hash,
    })),
  };
}

// ----------------------------------------------------------------- rendering

const CopyBlock = ({
  label,
  content,
  maxHeight,
}: {
  label: string;
  content: string;
  maxHeight?: string;
}) => (
  <div style="display:flex;flex-direction:column;gap:6px;min-width:0">
    <div class="row" style="justify-content:space-between">
      <span class="overline">{label}</span>
      <button class="copybtn onlight" type="button" data-copy={content}>
        COPY
      </button>
    </div>
    <div class="cmd" style={maxHeight ? `max-height:${maxHeight};overflow:auto` : undefined}>
      <code>{content}</code>
    </div>
  </div>
);

type AgentSourceField = { name: string; value: string };

const AgentSetupCard = ({
  slug,
  page,
  sourceFields,
  projects: availableProjects,
  scopeLocked,
  project,
  mode,
  includeGovernance,
  markdown,
  manifest,
}: {
  slug: string;
  /** The delivery page's own address: previewing must not move the reader out of a project. */
  page: string;
  sourceFields: AgentSourceField[];
  projects: { id: string; name: string }[];
  scopeLocked: boolean;
  project?: string | null;
  mode: AgentSetupMode;
  includeGovernance: boolean;
  markdown?: string;
  manifest?: ReturnType<typeof agentSetupManifest>;
}) => (
  <div id="agent-setup-pack" class="flow-section">
    <div>
      <div class="card-title">Send this flow to an agent</div>
      <div class="card-note">
        Generate an English Markdown setup pack. It asks the agent to inspect the repository, report
        missing logins and permissions, show a concrete plan, and return a completion receipt
        without ever collecting secret values.
      </div>
    </div>
    {manifest && (
      <dl class="flow-facts">
        <dt>Scope</dt>
        <dd>
          <ScopePill workspace={slug} project={manifest.project} />
        </dd>
        <dt>Version</dt>
        <dd>
          {manifest.flowVersion ?? 'Unpublished blueprint'} · {manifest.template}
        </dd>
        <dt>Flow hash</dt>
        <dd>
          <code>{manifest.flowHash}</code>
        </dd>
        <dt>Governance</dt>
        <dd>
          {manifest.policyHash ? (
            <code>{manifest.policyHash}</code>
          ) : (
            'Not included — existing workspace policy still applies'
          )}
        </dd>
      </dl>
    )}
    <p class="small muted">
      Scope and hashes above describe the last rendered selection. After changing options, preview
      again to review the exact pack before downloading.
    </p>
    <form method="get" action={page} style="display:flex;flex-direction:column;gap:12px">
      {sourceFields.map((field) => (
        <input type="hidden" name={field.name} value={field.value} />
      ))}
      <div class="row" style="align-items:flex-start;gap:14px;flex-wrap:wrap">
        <Field
          id="agent-project"
          label={scopeLocked ? 'Stored target scope' : 'Target scope'}
          required
          help={
            scopeLocked
              ? 'A published flow keeps its stored scope.'
              : 'Pick the project this unpublished blueprint will be prepared for.'
          }
        >
          {scopeLocked ? (
            <>
              <input type="hidden" name="agentProject" value={project ?? ''} />
              <span
                id="agent-project"
                class="pill pill-muted"
                aria-describedby="agent-project-help"
              >
                {project ? `Project: ${project}` : 'Team-wide'}
              </span>
            </>
          ) : (
            <select
              class="in"
              id="agent-project"
              name="agentProject"
              aria-describedby="agent-project-help"
            >
              <option value="" selected={!project}>
                Team-wide
              </option>
              {availableProjects.map((candidate) => (
                <option value={candidate.name} selected={candidate.name === project}>
                  Project: {candidate.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <fieldset style="border:0;padding:0;margin:0">
        <legend>Agent authority</legend>
        <div class="flow-modes">
          <label class="flow-mode">
            <input type="radio" name="agentMode" value="plan-only" checked={mode === 'plan-only'} />{' '}
            Plan only<p>Read and propose. No repository or provider writes.</p>
          </label>
          <label class="flow-mode">
            <input
              type="radio"
              name="agentMode"
              value="propose-then-apply"
              checked={mode === 'propose-then-apply'}
            />{' '}
            Propose, then apply<p>Show the plan. Wait for explicit human approval before writes.</p>
          </label>
        </div>
      </fieldset>
      <Field
        id="agent-governance"
        label="Governance protocol"
        required
        help="Effective governance is an exact snapshot for the target scope: team policy for team-wide, or team policy merged with project additions. Individual rules cannot be cherry-picked here."
      >
        <select
          class="in"
          id="agent-governance"
          name="agentGovernance"
          required
          aria-describedby="agent-governance-help"
        >
          <option value="none" selected={!includeGovernance}>
            Do not include governance
          </option>
          <option value="effective" selected={includeGovernance}>
            Include effective governance for this exact scope
          </option>
        </select>
      </Field>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <button class="btn btn-sm" type="submit" name="agent" value="preview">
          Preview instructions
        </button>
        <button
          class="btn btn-sm btn-primary"
          type="submit"
          formaction={`/app/teams/${slug}/delivery/agent-setup.md`}
          name="download"
          value="1"
        >
          Download agent setup .md
        </button>
      </div>
    </form>
    <p class="small">
      Downloading this pack grants no permission and proves no installation. The agent must ask for
      missing logins, show a plan and respect your approval boundary.{' '}
      <a href={`/app/teams/${slug}/delivery/receipts`}>
        Return a receipt and compare provider evidence
      </a>
      .
    </p>
    {markdown ? (
      <CopyBlock
        label="Agent setup Markdown · scroll to inspect"
        content={markdown}
        maxHeight="520px"
      />
    ) : null}
  </div>
);

/**
 * The designer dialog, prefilled from whichever document the page opened on —
 * or, after a refused publish, from what was actually typed.
 *
 * A refusal is usually one malformed line at the end of a long environment list,
 * and it used to redirect to this page with the reason in a band and the dialog
 * closed over an empty form. Every field here is already a string derived from
 * the document, so a refusal can hand the posted strings back instead, which is
 * the only version of this that works: the typed document may not parse, so
 * there is nothing else to re-render it from.
 */
const DesignDialog = ({
  slug,
  teamProjects,
  document,
  templateKey,
  provider,
  name,
  flow,
  scopeProject,
  refused,
}: {
  slug: string;
  teamProjects: { id: string; name: string }[];
  document: DeliveryFlow;
  templateKey: string;
  provider: string;
  name: string;
  /** Editing this flow; absent means creating a new one. */
  flow?: FlowRow;
  /** The project the page is inside: a new flow starts scoped to it, and saving returns to it. */
  scopeProject?: { id: string; slug: string };
  /** A publish this page refused: what was posted, and why it was refused. */
  refused?: { typed: Record<string, unknown>; error: string };
}) => {
  /** What was typed, or the document's own value when nothing was refused. */
  const was = (field: string, fallback: string): string =>
    refused ? String(refused.typed[field] ?? '') : fallback;
  const chose = (field: string, value: string, fallback: boolean): boolean =>
    refused ? String(refused.typed[field] ?? '') === value : fallback;
  return (
  // Open, because a person whose work is in here must not have to find it again.
  <dialog id="design-flow" class="formdlg wide" open={Boolean(refused)}>
    <h3>{flow ? `Edit ${flow.name}` : 'Design a delivery flow'}</h3>
    <p class="dlgsub">
      This becomes four things at once: the brief agents read over MCP, the picture on this page,
      the CI pipeline, and an English setup pack you can hand to an agent. Publish it once and all
      four start from the same contract.
    </p>
    {refused ? <div class="banner banner-error">{refused.error}</div> : null}
    <form method="post" action={`/app/teams/${slug}/delivery`}>
      {flow ? <input type="hidden" name="flowId" value={flow.id} /> : null}
      {scopeProject ? <input type="hidden" name="scope_project" value={scopeProject.slug} /> : null}
      <input type="hidden" name="templateKey" value={was('templateKey', templateKey)} />
      <Field id="df-name" label="Flow name" required>
        <input class="in" id="df-name" name="name" required maxlength={80} value={was('name', name)} />
      </Field>
      <div class="row" style="align-items:flex-start;gap:14px;flex-wrap:wrap">
        <Field
          id="df-scope"
          label="Scope"
          help="A project flow replaces the workspace default for that project only."
        >
          <select class="in" id="df-scope" name="scope" aria-describedby="df-scope-help">
            <option value="" selected={chose('scope', '', flow ? !flow.projectId : !scopeProject)}>
              Every project (workspace default)
            </option>
            {teamProjects.map((p) => (
              <option value={p.id} selected={chose('scope', p.id, flow ? flow.projectId === p.id : scopeProject?.id === p.id)}>
                Project: {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field id="df-provider" label="CI provider" required>
          <select class="in" id="df-provider" name="provider">
            <option value="azure-devops" selected={chose('provider', 'azure-devops', provider === 'azure-devops')}>
              Azure DevOps
            </option>
            <option value="github-actions" selected={chose('provider', 'github-actions', provider === 'github-actions')}>
              GitHub Actions
            </option>
          </select>
        </Field>
      </div>
      <Field id="df-intro" label="One-line intro">
        <input class="in" id="df-intro" name="intro" maxlength={300} value={was('intro', document.intro)} />
      </Field>
      <div class="row" style="align-items:flex-start;gap:14px;flex-wrap:wrap">
        <Field id="df-ticket" label="Ticket tracker">
          <select class="in" id="df-ticket" name="ticketSystem">
            {TICKET_SYSTEMS.map((system) => (
              <option value={system} selected={chose('ticketSystem', system, system === document.ticket.system)}>
                {TICKET_LABELS[system]}
              </option>
            ))}
          </select>
        </Field>
        <Field id="df-ticketkey" label="Key looks like" help="An example shape, e.g. PROJ-123.">
          <input
            class="in"
            id="df-ticketkey"
            name="ticketKeyPattern"
            maxlength={60}
            value={was('ticketKeyPattern', document.ticket.keyPattern)}
            aria-describedby="df-ticketkey-help"
          />
        </Field>
      </div>
      <label class="checkrow">
        <input
          type="checkbox"
          name="ticketRequired"
          value="on"
          checked={refused ? refused.typed.ticketRequired === 'on' : document.ticket.required}
        />
        <span>
          <span class="checkrow-label">Work must not start without a ticket</span>
          <span class="checkrow-note">Agents are told so in exactly those words.</span>
        </span>
      </label>
      <div class="row" style="align-items:flex-start;gap:14px;flex-wrap:wrap">
        <Field
          id="df-branchpat"
          label="Branch naming"
          required
          help="Placeholders: {ticket}, {slug}, {type}."
        >
          <input
            class="in"
            id="df-branchpat"
            name="branchPattern"
            required
            maxlength={120}
            value={was('branchPattern', document.branch.pattern)}
            aria-describedby="df-branchpat-help"
          />
        </Field>
        <Field id="df-branchfrom" label="Branches from" required>
          <input
            class="in"
            id="df-branchfrom"
            name="branchFrom"
            required
            maxlength={60}
            value={was('branchFrom', document.branch.from)}
          />
        </Field>
      </div>
      <Field
        id="df-checks"
        label="Required checks"
        help="One command per line — these become the CI check stage."
      >
        <textarea
          class="in"
          id="df-checks"
          name="checks"
          rows={3}
          aria-describedby="df-checks-help"
        >
          {was('checks', listToLines(document.checks))}
        </textarea>
      </Field>
      <div class="row" style="align-items:flex-start;gap:14px;flex-wrap:wrap">
        <Field id="df-approvals" label="PR approvals" required>
          <input
            class="in"
            id="df-approvals"
            name="approvals"
            type="number"
            min="0"
            max="10"
            style="width:110px"
            value={was('approvals', String(document.review.approvals))}
          />
        </Field>
        <Field id="df-merge" label="Merge strategy" required>
          <select class="in" id="df-merge" name="mergeStrategy">
            {MERGE_STRATEGIES.map((strategy) => (
              <option value={strategy} selected={chose('mergeStrategy', strategy, strategy === document.mergeStrategy)}>
                {strategy}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field
        id="df-envs"
        label="Environments, in order"
        help="One per line: name = pull-request | merge | tag | manual, optionally “, approval”, then => and the real deploy command. Example: uat = manual, approval => ./scripts/deploy uat. Reference CI secrets by name; never paste secret values."
      >
        <textarea
          class="in"
          id="df-envs"
          name="environments"
          rows={3}
          aria-describedby="df-envs-help"
        >
          {was('environments', environmentsToLines(document.environments))}
        </textarea>
      </Field>
      <Field id="df-notes" label="House rules" help="One per line; they ride the brief verbatim.">
        <textarea class="in" id="df-notes" name="notes" rows={2} aria-describedby="df-notes-help">
          {was('notes', listToLines(document.notes))}
        </textarea>
      </Field>
      <div class="dialog-actions">
        <button class="btn" type="button" data-close-dialog="t">
          Cancel
        </button>
        <button class="btn btn-primary" type="submit">
          {flow ? 'Publish changes' : 'Publish flow'}
        </button>
      </div>
    </form>
  </dialog>
  );
};

// ---------------------------------------------------------------------- page

// Two addresses, one page: the workspace's flows, and the flow in effect in one
// project. The `?project=` filter the path form replaces still answers.
deliveryRoutes.get('/app/teams/:slug/delivery', (c) => renderDelivery(c));
deliveryRoutes.get('/app/teams/:slug/projects/:project/delivery', (c) => renderDelivery(c));

/** The page, drawn for a GET or handed back by a publish this page refused. */
export async function renderDelivery(
  c: Context<AppEnv>,
  refused?: { typed: Record<string, unknown>; error: string },
) {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await teamForUser(db, user.id, c.req.param('slug') ?? '');
  if (!found) return c.notFound();
  const { team, role } = found;
  const isOwner = role === 'owner';

  const flows = await listDeliveryFlows(db, team.id, FLOW_LIMIT);
  const active = flows.filter((row) => row.flow.status === 'active');
  const teamProjects = await db
    .select({ id: projects.id, name: projects.name, slug: projects.slug })
    .from(projects)
    .where(eq(projects.teamId, team.id))
    .orderBy(projects.name)
    .limit(PROJECT_LIMIT);
  const selectedFlow = flows.find((row) => row.flow.id === c.req.query('flow'));

  // Inside a project the first question is "which flow does an agent here get, and
  // is it ours or everybody's". Same precedence `activeFlowFor` serves over MCP:
  // the project's own active flow, otherwise the workspace default. Derived from
  // the list already loaded, so the page and `get_workflow` cannot disagree about
  // which rows exist.
  // A refusal re-renders in the scope the form was posted for: a POST has no
  // query string of its own to come back to.
  const projectQuery = refused
    ? String(refused.typed.scope_project ?? '').trim()
    : scopedProjectParam(c);
  const scopeProject = projectQuery ? await projectForTeam(db, team.id, projectQuery) : undefined;
  // Named in the path the project is the page's identity: a spelling that matches
  // nothing is a wrong address. As `?project=` it was a filter and stays one.
  const inPath = projectInPath(c);
  if (inPath && !scopeProject) return c.notFound();
  // A refused publish answers with a page, and a page needs chrome: without this
  // the designer came back saying "no workspace yet" beside the workspace's flows.
  if (refused) await ensureRail(db, user, team.slug, scopeProject?.slug ?? null);
  const workspaceFlow = active.find((row) => row.flow.projectId === null);
  const ownFlow = scopeProject ? active.find((row) => row.flow.projectId === scopeProject.id) : undefined;
  const inEffect = ownFlow ?? workspaceFlow;
  const withOwnFlow = new Set(active.map((row) => row.flow.projectId).filter(Boolean));
  const inheriting = teamProjects.filter((p) => !withOwnFlow.has(p.id)).length;
  /** This page's own address, so a flow, the wizard or a preview opens where the reader is. */
  const here = sectionHref(team.slug, inPath ? scopeProject!.slug : null, 'delivery');
  // Only the filter form needs to carry the project; the path form already does.
  const scopeQuery = scopeProject && !inPath ? `&project=${encodeURIComponent(scopeProject.slug)}` : '';
  const home = `/app/teams/${team.slug}`;
  const ado = await adoForTeam(db, team.id, selectedFlow?.flow.projectId);
  const github = await githubForTeam(db, team.id, selectedFlow?.flow.projectId);
  const jira = await jiraForTeam(db, team.id);
  const adoRow = await integrationFor(
    db,
    team.id,
    'azure-devops',
    undefined,
    selectedFlow?.flow.projectId,
  );
  const adoLastCheck = (adoRow?.config as { lastCheck?: AdoHealth } | null)?.lastCheck;

  const answers = c.req.query('wizard') ? wizardAnswers((k) => c.req.query(k)) : null;
  const recommended = answers ? recommendTemplate(answers) : null;
  const explicitTemplate = templateByKey(c.req.query('template') ?? '');
  const selectedTemplate = explicitTemplate ?? recommended?.template;
  const recommendedDocument =
    answers && recommended && !explicitTemplate
      ? flowForRecommendation(recommended.template, answers)
      : undefined;
  const showWizard = Boolean(c.req.query('wizard')) || flows.length === 0;

  // What the designer dialog opens on, in order of specificity.
  const draft = selectedFlow
    ? {
        document: parseFlowDocument(selectedFlow.flow.document),
        templateKey: selectedFlow.flow.templateKey,
        provider: selectedFlow.flow.provider,
        name: selectedFlow.flow.name,
        flow: selectedFlow.flow,
      }
    : selectedTemplate
      ? {
          document: recommendedDocument ?? selectedTemplate.document,
          templateKey: selectedTemplate.key,
          provider: answers?.provider ?? 'azure-devops',
          name: selectedTemplate.name,
          flow: undefined,
        }
      : {
          document: FLOW_TEMPLATES[0]!.document,
          templateKey: FLOW_TEMPLATES[0]!.key,
          provider: 'azure-devops',
          name: FLOW_TEMPLATES[0]!.name,
          flow: undefined,
        };

  const detailDocument = selectedFlow ? parseFlowDocument(selectedFlow.flow.document) : undefined;
  const detailPipeline =
    selectedFlow && detailDocument
      ? renderPipeline(detailDocument, selectedFlow.flow.provider as FlowProvider, {
          name: selectedFlow.flow.name,
          version: selectedFlow.flow.version,
        })
      : undefined;
  const detailBrief =
    selectedFlow && detailDocument
      ? flowBrief(detailDocument, {
          name: selectedFlow.flow.name,
          team: team.slug,
          project: selectedFlow.projectName,
        })
      : undefined;
  const detailIsScaffold = detailPipeline ? pipelineIsScaffold(detailPipeline) : false;
  const missingDeployCommands = detailDocument
    ? detailDocument.environments.filter((environment) => !environment.command)
    : [];
  const missingChecks = detailDocument ? detailDocument.checks.length === 0 : false;

  const agentMode = agentModeFrom(c.req.query('agentMode'));
  const agentIncludeGovernance = c.req.query('agentGovernance') === 'effective';
  const requestedAgentProject = c.req.query('agentProject')?.trim() || null;
  const agentProject = selectedFlow
    ? selectedFlow.projectName
    : teamProjects.some((project) => project.name === requestedAgentProject)
      ? requestedAgentProject
      : null;
  const agentSourceFields: AgentSourceField[] = selectedFlow
    ? [{ name: 'flow', value: selectedFlow.flow.id }]
    : explicitTemplate
      ? [
          { name: 'template', value: explicitTemplate.key },
          { name: 'provider', value: draft.provider },
        ]
      : answers && recommended
        ? [
            { name: 'wizard', value: '1' },
            { name: 'tracker', value: answers.tracker },
            { name: 'provider', value: answers.provider },
            { name: 'teamSize', value: answers.teamSize },
            { name: 'protection', value: answers.protection },
            { name: 'release', value: answers.release },
          ]
        : [];
  let agentMarkdown: string | undefined;
  let agentManifest: ReturnType<typeof agentSetupManifest> | undefined;
  let agentPreviewError: string | undefined;
  if (agentSourceFields.length) {
    const resolved = agentSetupSource((key) => c.req.query(key), flows, teamProjects);
    if ('error' in resolved) {
      agentPreviewError = resolved.error;
    } else {
      const governance = agentIncludeGovernance
        ? await governanceSnapshot(db, user.id, team.slug, resolved.source.project)
        : undefined;
      const context = {
        name: resolved.source.name,
        team: team.slug,
        project: resolved.source.project,
        templateKey: resolved.source.templateKey,
        provider: resolved.source.provider,
        version: resolved.source.version,
        mode: agentMode,
        governance,
      };
      agentManifest = agentSetupManifest(resolved.source.document, context);
      if (c.req.query('agent') === 'preview')
        agentMarkdown = renderAgentSetupMarkdown(resolved.source.document, context);
    }
  }

  const notice = c.req.query('ok');
  const failure = c.req.query('error');

  return c.html(
    <AppLayout
      user={user}
      active="delivery"
      title={`Delivery — ${team.name}`}
      strip={
        <>
          <Lead text="Delivery flow" live={active.length > 0} />
          <Vr />
          <span>
            {active.length} active · {flows.length - active.length} archived
          </span>
          {ado ? (
            <>
              <span class="dim">·</span>
              <span>Azure DevOps connected</span>
            </>
          ) : null}
        </>
      }
      scope={
        <>
          <span class="chip">
            team <b>{team.slug}</b>
          </span>
          <a class="chip" href={`/app/teams/${team.slug}`}>
            integrations
          </a>
        </>
      }
      head={
        <PageHead
          trail={
            scopeProject
              ? teamTrail(
                  team,
                  { label: 'Projects', href: `${home}/projects` },
                  { label: scopeProject.name, href: `${home}/projects/${encodeURIComponent(scopeProject.slug)}` },
                  { label: 'Delivery' },
                )
              : teamTrail(team, { label: 'Delivery' })
          }
          title={scopeProject ? `Delivery in ${scopeProject.name}` : 'Delivery'}
          sub="How work moves here, written once: agents get a brief or a portable setup pack, people see a picture, and CI receives an explicitly labelled scaffold until real deploy commands exist."
          actions={
            isOwner ? (
              <button class="btn btn-sm btn-primary" type="button" data-open-dialog="#design-flow">
                {selectedFlow ? 'Edit this flow' : 'Design a flow'}
              </button>
            ) : undefined
          }
        />
      }
      keys={[{ k: 'W', label: 'wizard asks five questions' }]}
      keysNote="publishing a flow for a scope archives the previous one — the record stays"
    >
      {failure ? (
        <div class="banner banner-error">
          <span class="ic">!</span>
          <span>{failure}</span>
          <button class="x" type="button" data-dismiss="t">
            ×
          </button>
        </div>
      ) : null}
      {notice ? (
        <div class="banner banner-success">
          <span class="ic">✓</span>
          <span>{notice}</span>
          <button class="x" type="button" data-dismiss="t">
            ×
          </button>
        </div>
      ) : null}
      {agentPreviewError ? (
        <div class="banner banner-error">
          <span class="ic">!</span>
          <span>{agentPreviewError}</span>
        </div>
      ) : null}

      {scopeProject ? (
        <div class="card" id="flow-in-effect">
          <div class="card-head">
            <div>
              <div class="card-title">In effect in {scopeProject.name}</div>
              <div class="card-note">
                {inEffect
                  ? ownFlow
                    ? `This project's own flow. It replaces the workspace default here and nowhere else.`
                    : `Inherited from the workspace: ${scopeProject.name} has no flow of its own, so agents here get the default every project gets.`
                  : `Nothing: neither ${scopeProject.name} nor the workspace has published a flow, so get_workflow tells an agent to follow the repository's own conventions.`}
              </div>
            </div>
            <div class="row" style="gap:8px;flex-wrap:wrap">
              {inEffect ? (
                <span class={`pill ${ownFlow ? 'pill-own' : 'pill-member'}`} style="text-transform:none;letter-spacing:0">
                  {ownFlow ? 'this project only' : 'from the workspace'}
                </span>
              ) : null}
              {inEffect ? (
                <a class="btn btn-sm" href={`${here}?flow=${inEffect.flow.id}${scopeQuery}`}>
                  Open {inEffect.flow.name} v{inEffect.flow.version}
                </a>
              ) : null}
              {isOwner && !ownFlow ? (
                <button class="btn btn-sm btn-primary" type="button" data-open-dialog="#design-flow">
                  Give this project its own flow
                </button>
              ) : null}
              <a class="btn btn-sm" href={sectionHref(team.slug, null, 'delivery')}>
                All workspace flows
              </a>
            </div>
          </div>
        </div>
      ) : null}

      {selectedFlow ? (
        <div class="row" style="justify-content:space-between;flex-wrap:wrap">
          <a class="btn btn-sm" href={here}>
            ← Delivery overview
          </a>
          <span class="muted small">
            Blueprint library and the full flow list live on the overview; this page stays focused
            on the selected flow.
          </span>
        </div>
      ) : null}

      {showWizard ? (
        <div class="card card-pad" style="display:flex;flex-direction:column;gap:16px">
          <div>
            <div class="card-title">Not sure what to set up?</div>
            <div class="card-note">
              Five questions, one recommendation, and the reasons for it — then adjust anything in
              the designer before publishing.
            </div>
          </div>
          <form method="get" action={here} class="stack" style="gap:14px">
            <input type="hidden" name="wizard" value="1" />
            <div class="row" style="align-items:flex-start;gap:22px;flex-wrap:wrap">
              {WIZARD.map((step) => (
                <fieldset style="border:none;margin:0;padding:0;min-width:210px">
                  <legend class="overline" style="margin-bottom:8px">
                    {step.q}
                  </legend>
                  {step.options.map(([value, label]) => (
                    <label class="checkrow" style="margin-bottom:4px">
                      <input
                        type="radio"
                        name={step.key}
                        value={value}
                        checked={
                          answers
                            ? (answers as unknown as Record<string, string>)[step.key] === value
                            : false
                        }
                      />
                      <span>
                        <span class="checkrow-label">{label}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
              ))}
            </div>
            <button class="btn btn-primary" type="submit" style="align-self:flex-start">
              Recommend a template
            </button>
          </form>
          {recommended ? (
            <div
              class="card card-pad"
              style="background:var(--green-bg);border-color:var(--green-line);display:flex;flex-direction:column;gap:10px"
            >
              <div class="row" style="justify-content:space-between;flex-wrap:wrap">
                <div>
                  <div class="card-title">{recommended.template.name}</div>
                  <div class="card-note">{recommended.template.oneLiner}</div>
                </div>
                {isOwner ? (
                  <button
                    class="btn btn-sm btn-primary"
                    type="button"
                    data-open-dialog="#design-flow"
                  >
                    Use this template
                  </button>
                ) : (
                  <span class="muted small">Ask a team owner to publish it.</span>
                )}
              </div>
              <span class="small" style="color:var(--txt-2)">
                Why: it {recommended.reasons.join(', it ')}.
              </span>
              <FlowDiagram flow={recommended.template.document} />
            </div>
          ) : c.req.query('wizard') ? (
            <span class="muted small">Answer all five to get a recommendation.</span>
          ) : null}
        </div>
      ) : null}

      {!selectedFlow ? (
        <div class="card">
          <div class="card-head">
            <div>
              <div class="card-title">Blueprint library</div>
              <div class="card-note">
                Eight research-backed starting points — pick one, adjust it in the designer,
                publish.
              </div>
            </div>
            {!showWizard ? (
              <a class="btn btn-sm" href={`${here}?wizard=1`}>
                Open the wizard
              </a>
            ) : null}
          </div>
          <div
            class="card-pad"
            style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px"
          >
            {FLOW_TEMPLATES.map((template) => (
              <div
                class="card card-pad"
                style={`display:flex;flex-direction:column;gap:8px${selectedTemplate?.key === template.key ? ';border-color:var(--green)' : ''}`}
              >
                <div
                  class="row"
                  style="justify-content:space-between;align-items:flex-start;gap:8px"
                >
                  <div class="card-title">{template.name}</div>
                  <span class="pill pill-muted">{template.category}</span>
                </div>
                <span class="small" style="color:var(--txt-2)">
                  {template.oneLiner}
                </span>
                <span class="muted small">{template.whenToUse}</span>
                <a
                  class="btn btn-sm"
                  style="align-self:flex-start;margin-top:auto"
                  href={`${here}?template=${template.key}${c.req.query('wizard') ? '&wizard=1' : ''}#template-preview`}
                >
                  Preview
                </a>
              </div>
            ))}
          </div>
          {selectedTemplate && !selectedFlow ? (
            <div
              id="template-preview"
              class="card-pad"
              style="border-top:1px solid var(--line-2);display:flex;flex-direction:column;gap:12px;scroll-margin-top:12px"
            >
              <div class="row" style="justify-content:space-between;flex-wrap:wrap">
                <div>
                  <div class="card-title">{selectedTemplate.name}</div>
                  <div class="card-note">{selectedTemplate.whenToUse}</div>
                </div>
                {isOwner ? (
                  <button
                    class="btn btn-sm btn-primary"
                    type="button"
                    data-open-dialog="#design-flow"
                  >
                    Use this template
                  </button>
                ) : null}
              </div>
              <FlowDiagram flow={selectedTemplate.document} />
              <AgentSetupCard
                slug={team.slug}
                page={here}
                sourceFields={agentSourceFields}
                projects={teamProjects}
                scopeLocked={false}
                project={agentProject}
                mode={agentMode}
                includeGovernance={agentIncludeGovernance}
                markdown={agentMarkdown}
                manifest={agentManifest}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {!selectedFlow ? (
        <div class="card">
          <div class="card-head">
            <div>
              <div class="card-title">Published flows</div>
              <div class="card-note">
                The team's answer to "how does work move here" — one active flow per scope.
              </div>
            </div>
            <span class="mono muted">{flows.length}</span>
          </div>
          {flows.length === 0 ? (
            <div class="empty">
              <h2>No flow published yet</h2>
              <p>
                Until an owner publishes one, agents asking <code>get_workflow</code> are told to
                follow the repository's own conventions — which is exactly the ambiguity this page
                removes.
              </p>
            </div>
          ) : (
            <div class="scroll-x">
              <table class="tbl">
                <tr>
                  <th>Flow</th>
                  <th>Applies to</th>
                  <th>Provider</th>
                  <th>Template</th>
                  <th>Version</th>
                  <th>Status</th>
                  <th>Updated</th>
                </tr>
                {flows.map((row) => (
                  <tr>
                    <td class="name">
                      <a href={`${here}?flow=${row.flow.id}${scopeQuery}`}>
                        {row.flow.name}
                      </a>
                    </td>
                    <td class="muted">
                      {row.projectName ? (
                        `${row.projectName} only`
                      ) : row.flow.status === 'active' ? (
                        `every project without its own flow (${inheriting} of ${teamProjects.length})`
                      ) : (
                        'every project without its own flow'
                      )}
                    </td>
                    <td class="muted">{PROVIDER_LABELS[row.flow.provider] ?? row.flow.provider}</td>
                    <td class="mono muted small">{row.flow.templateKey}</td>
                    <td class="mono">v{row.flow.version}</td>
                    <td>
                      {row.flow.status === 'active' ? (
                        <span class="pill pill-active">active</span>
                      ) : (
                        <span class="pill pill-muted">archived</span>
                      )}
                    </td>
                    <td class="muted" style="white-space:nowrap">
                      {timeAgo(row.flow.updatedAt)}
                    </td>
                  </tr>
                ))}
              </table>
            </div>
          )}
        </div>
      ) : null}

      {selectedFlow && detailDocument && detailPipeline && detailBrief ? (
        <div class="card">
          <div class="card-head">
            <div>
              <div class="card-title">
                {selectedFlow.flow.name} · v{selectedFlow.flow.version}
              </div>
              <div class="card-note">
                {selectedFlow.projectName
                  ? `Applies to ${selectedFlow.projectName} only.`
                  : 'Applies to every project without its own flow.'}{' '}
                {PROVIDER_LABELS[selectedFlow.flow.provider]} · by {selectedFlow.author ?? '—'}
              </div>
            </div>
            {isOwner && selectedFlow.flow.status === 'active' ? (
              <form
                method="post"
                action={`/app/teams/${team.slug}/delivery/${selectedFlow.flow.id}/archive`}
                class="m0"
                data-confirm="Archive this flow? Agents asking get_workflow stop receiving it; the record stays on this page."
              >
                <button class="btn btn-sm" type="submit">
                  Archive
                </button>
              </form>
            ) : null}
          </div>
          <div class="card-pad" style="display:flex;flex-direction:column;gap:18px">
            <FlowDiagram flow={detailDocument} />
            <div style="border:1px solid var(--line-2);border-radius:8px;padding:14px;display:flex;flex-direction:column;gap:9px">
              <div class="row" style="justify-content:space-between;gap:10px;flex-wrap:wrap">
                <div>
                  <div class="card-title">Pipeline readiness</div>
                  <div class="card-note">
                    What is complete in the stored flow — not what STMA assumes about your
                    repository.
                  </div>
                </div>
                <span class={`pill ${detailIsScaffold ? 'pill-owner' : 'pill-active'}`}>
                  {detailIsScaffold ? 'scaffold' : 'pipeline content ready'}
                </span>
              </div>
              <div class="factrow">
                <span class={missingChecks ? 'n' : 'y'}>{missingChecks ? '!' : '✓'}</span>
                <span>
                  {missingChecks
                    ? 'No required checks configured — CI would only print a placeholder.'
                    : `${detailDocument.checks.length} required check${detailDocument.checks.length === 1 ? '' : 's'} configured.`}
                </span>
              </div>
              <div class="factrow">
                <span
                  class={
                    detailDocument.ticket.system === 'none' ||
                    (detailDocument.ticket.system === 'github' && github) ||
                    (detailDocument.ticket.system === 'jira' && jira)
                      ? 'y'
                      : 'w'
                  }
                >
                  {detailDocument.ticket.system === 'none' ||
                  (detailDocument.ticket.system === 'github' && github) ||
                  (detailDocument.ticket.system === 'jira' && jira)
                    ? '✓'
                    : '!'}
                </span>
                <span>
                  {detailDocument.ticket.system === 'none'
                    ? 'No ticket tracker required by this flow.'
                    : detailDocument.ticket.system === 'github'
                      ? github
                        ? `GitHub issues connected to ${github.repo}.`
                        : 'GitHub issues is declared but no repository connection is configured.'
                      : detailDocument.ticket.system === 'jira'
                        ? jira
                          ? `Jira connected to ${jira.site}.`
                          : 'Jira is declared but no connection is configured.'
                        : 'Azure Boards is recorded as a workflow rule only; live work-item integration is not available yet.'}{' '}
                  {detailDocument.ticket.system !== 'none' &&
                  !(
                    (detailDocument.ticket.system === 'github' && github) ||
                    (detailDocument.ticket.system === 'jira' && jira)
                  ) ? (
                    <a href={`/app/teams/${team.slug}?tab=integrations`}>Review integrations</a>
                  ) : null}
                </span>
              </div>
              <div class="factrow">
                <span class={missingDeployCommands.length > 0 ? 'n' : 'y'}>
                  {missingDeployCommands.length > 0 ? '!' : '✓'}
                </span>
                <span>
                  {detailDocument.environments.length === 0
                    ? 'CI-only flow — no deployment environments declared.'
                    : missingDeployCommands.length > 0
                      ? `Missing deploy command for ${missingDeployCommands.map((environment) => environment.name).join(', ')}.`
                      : `Every deployment environment has a real command.`}
                </span>
              </div>
              {detailDocument.environments.some((environment) => environment.approval) ? (
                <div class="factrow">
                  <span class="w">!</span>
                  <span>
                    Approval gates are declared, but required reviewers/checks must also be
                    configured in{' '}
                    {selectedFlow.flow.provider === 'azure-devops'
                      ? 'Azure DevOps Environments'
                      : 'GitHub Environments'}
                    .
                  </span>
                </div>
              ) : null}
              {isOwner && detailIsScaffold ? (
                <button
                  class="btn btn-sm"
                  type="button"
                  data-open-dialog="#design-flow"
                  style="align-self:flex-start"
                >
                  Complete missing fields
                </button>
              ) : null}
            </div>
            <AgentSetupCard
              slug={team.slug}
              page={here}
              sourceFields={agentSourceFields}
              projects={teamProjects}
              scopeLocked
              project={selectedFlow.projectName}
              mode={agentMode}
              includeGovernance={agentIncludeGovernance}
              markdown={agentMarkdown}
              manifest={agentManifest}
            />
            <CopyBlock label="Agent brief — what get_workflow serves" content={detailBrief} />
            <CopyBlock
              label={`${detailIsScaffold ? 'Pipeline scaffold' : 'Pipeline'} — ${detailPipeline.path}`}
              content={detailPipeline.yaml}
            />
            {detailIsScaffold ? (
              <div class="banner banner-warn" style="margin:0">
                <span class="ic">!</span>
                <span>
                  This is a scaffold, not a working pipeline:{' '}
                  {missingChecks ? 'required checks are missing' : ''}
                  {missingChecks && missingDeployCommands.length > 0 ? ', and ' : ''}
                  {missingDeployCommands.length > 0
                    ? `deploy commands are missing for ${missingDeployCommands.map((environment) => environment.name).join(', ')}`
                    : ''}
                  . You may commit it explicitly, but STMA will not describe that as completed
                  setup.
                </span>
              </div>
            ) : null}
            {selectedFlow.flow.provider === 'azure-devops' ? (
              ado ? (
                <div style="display:flex;flex-direction:column;gap:10px">
                  {/* The connection's last known state, so a dead PAT is learned
                      here and not three screens later inside the apply. */}
                  {adoLastCheck && !adoLastCheck.ok ? (
                    <div class="banner banner-warn" style="margin:0">
                      <span class="ic">!</span>
                      <span>
                        The last connection check failed ({timeAgo(new Date(adoLastCheck.at))}).{' '}
                        {describeAdoFailure(adoLastCheck.error ?? 'request_failed')} Update it on
                        the <a href={`/app/teams/${team.slug}`}>team page</a>, or re-test:
                      </span>
                      {isOwner ? (
                        <form
                          method="post"
                          action={`/app/teams/${team.slug}/integrations/azure-devops`}
                          class="m0"
                        >
                          <input type="hidden" name="action" value="test" />
                          <input type="hidden" name="return_to" value="delivery" />
                          <button class="btn btn-sm" type="submit">
                            Test again
                          </button>
                        </form>
                      ) : null}
                    </div>
                  ) : null}
                  <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:10px">
                    <span class="small" style="color:var(--txt-2)">
                      Connected to <b class="mono">{adoLocator(ado)}</b>
                      {adoLastCheck?.ok
                        ? adoLastCheck.empty
                          ? ` — verified ${timeAgo(new Date(adoLastCheck.at))}; the repository is empty, so committing creates `
                          : ` — verified ${timeAgo(new Date(adoLastCheck.at))}; committing writes `
                        : ' — committing writes '}
                      <span class="mono">{detailPipeline.path}</span>
                      {adoLastCheck?.ok && adoLastCheck.empty ? (
                        <>
                          {' '}
                          as the first commit on{' '}
                          <span class="mono">{detailDocument.branch.from}</span>
                        </>
                      ) : (
                        <>
                          {' '}
                          to <span class="mono">{detailDocument.branch.from}</span>
                        </>
                      )}{' '}
                      and registers the pipeline.
                    </span>
                    {isOwner ? (
                      <form
                        method="post"
                        action={`/app/teams/${team.slug}/delivery/${selectedFlow.flow.id}/apply`}
                        class="m0"
                        data-confirm={
                          detailIsScaffold
                            ? `This commits a pipeline scaffold to ${adoLocator(ado)} on branch ${detailDocument.branch.from} and registers it. It still contains placeholders. Continue?`
                            : `This commits the validated pipeline to ${adoLocator(ado)} on branch ${detailDocument.branch.from} and registers it. Continue?`
                        }
                        data-confirm-title={
                          detailIsScaffold ? 'Commit this scaffold?' : 'Apply this pipeline?'
                        }
                        data-confirm-action={
                          detailIsScaffold ? 'Commit scaffold' : 'Apply pipeline'
                        }
                      >
                        {detailIsScaffold ? (
                          <input type="hidden" name="mode" value="scaffold" />
                        ) : null}
                        <button class="btn btn-sm btn-primary" type="submit">
                          {detailIsScaffold ? 'Commit pipeline scaffold' : 'Apply pipeline'}
                        </button>
                      </form>
                    ) : (
                      <span class="muted small">
                        Only an owner can {detailIsScaffold ? 'commit the scaffold' : 'apply it'}.
                      </span>
                    )}
                  </div>
                </div>
              ) : isOwner ? (
                /* The PAT is asked for where it is needed: at the moment of
                   applying. The same handler as the team page's card, told to
                   come back here. */
                <div style="display:flex;flex-direction:column;gap:10px;border:1px solid var(--line-2);border-radius:8px;padding:14px">
                  <div>
                    <div class="card-title">
                      Connect Azure DevOps to{' '}
                      {detailIsScaffold ? 'commit this scaffold' : 'apply this pipeline'}
                    </div>
                    <div class="card-note">
                      Needs a PAT with <b>Code read &amp; write</b> and{' '}
                      <b>Build read &amp; execute</b>. The connection is verified the moment you
                      save it.{' '}
                      {detailIsScaffold
                        ? 'The generated YAML still has missing fields called out above; you can also copy it into '
                        : 'The pipeline has real checks and deploy commands and can be applied after verification; its file is '}
                      <span class="mono">{detailPipeline.path}</span>.
                    </div>
                  </div>
                  <AdoTokenHelp />
                  <form
                    method="post"
                    action={`/app/teams/${team.slug}/integrations/azure-devops`}
                    style="display:flex;flex-direction:column;gap:10px"
                  >
                    <input type="hidden" name="return_to" value="delivery" />
                    <input type="hidden" name="flow_id" value={selectedFlow.flow.id} />
                    <input
                      class="in"
                      type="text"
                      name="locator"
                      aria-label="Azure DevOps repository, as organization/project/repo"
                      placeholder="organization/project/repo — or paste the repo URL"
                    />
                    <input
                      class="in"
                      type="password"
                      name="token"
                      autocomplete="off"
                      aria-label="Azure DevOps personal access token"
                      placeholder="Personal access token"
                    />
                    <button
                      class="btn btn-sm btn-primary"
                      type="submit"
                      name="action"
                      value="save"
                      style="align-self:flex-start"
                    >
                      Connect and verify
                    </button>
                  </form>
                </div>
              ) : (
                <span class="muted small">
                  No Azure DevOps connection yet — a team owner can connect one here or on the{' '}
                  <a href={`/app/teams/${team.slug}`}>team page</a>. Until then, copy the YAML above
                  into <span class="mono">{detailPipeline.path}</span> yourself.
                </span>
              )
            ) : (
              <span class="muted small">
                {detailIsScaffold ? (
                  <>
                    Commit the scaffold above as <span class="mono">{detailPipeline.path}</span>{' '}
                    only after completing the missing fields — GitHub can otherwise show a green
                    workflow that deployed nothing.
                  </>
                ) : (
                  <>
                    Commit the ready workflow as <span class="mono">{detailPipeline.path}</span>.
                    GitHub picks it up from the file alone, so there is no separate registration
                    step.
                  </>
                )}
              </span>
            )}
          </div>
        </div>
      ) : null}

      {isOwner ? (
        <DesignDialog
          slug={team.slug}
          teamProjects={teamProjects}
          document={draft.document}
          templateKey={draft.templateKey}
          provider={draft.provider}
          name={draft.name}
          flow={draft.flow}
          scopeProject={scopeProject}
          refused={refused}
        />
      ) : null}
    </AppLayout>,
    // The address did not change and the publish did not happen, so this is not
    // a 200 for a page somebody asked for.
    refused ? 422 : 200,
  );
}

deliveryRoutes.get('/app/teams/:slug/delivery/agent-setup.md', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await teamForUser(db, user.id, c.req.param('slug'));
  if (!found) return c.notFound();
  const flows = await listDeliveryFlows(db, found.team.id, FLOW_LIMIT);
  const teamProjects = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.teamId, found.team.id))
    .orderBy(projects.name)
    .limit(PROJECT_LIMIT);
  const resolved = agentSetupSource((key) => c.req.query(key), flows, teamProjects);
  if ('error' in resolved) return c.text(resolved.error, 400);
  const governance =
    c.req.query('agentGovernance') === 'effective'
      ? await governanceSnapshot(db, user.id, found.team.slug, resolved.source.project)
      : undefined;
  const setupContext = {
    name: resolved.source.name,
    team: found.team.slug,
    project: resolved.source.project,
    templateKey: resolved.source.templateKey,
    provider: resolved.source.provider,
    version: resolved.source.version,
    mode: agentModeFrom(c.req.query('agentMode')),
    governance,
  };
  const manifest = agentSetupManifest(resolved.source.document, setupContext);
  const projectId = teamProjects.find((p) => p.name === resolved.source.project)?.id ?? null;
  await db
    .insert(deliverySetups)
    .values({ id: manifest.setupId, teamId: found.team.id, projectId, manifest })
    .onConflictDoNothing();
  const markdown = renderAgentSetupMarkdown(resolved.source.document, setupContext);
  const fileKey =
    resolved.source.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'delivery';
  return c.body(markdown, 200, {
    'content-type': 'text/markdown; charset=utf-8',
    'content-disposition': `attachment; filename="stma-${found.team.slug}-${fileKey}-agent-setup.md"`,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  });
});

async function renderReceipts(
  c: Context<AppEnv>,
  options: { error?: string; receipt?: string } = {},
) {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const access = await teamForUser(db, user.id, c.req.param('slug')!);
  if (!access) return c.notFound();
  await ensureRail(db, user, access.team.slug);
  const receipts = await db
    .select({
      id: deliverySetupReceipts.id,
      receipt: deliverySetupReceipts.receipt,
      tokenId: deliverySetupReceipts.tokenId,
      at: deliverySetupReceipts.createdAt,
      manifest: deliverySetups.manifest,
      projectId: deliverySetups.projectId,
    })
    .from(deliverySetupReceipts)
    .innerJoin(deliverySetups, eq(deliverySetupReceipts.setupId, deliverySetups.id))
    .where(eq(deliverySetups.teamId, access.team.id))
    .orderBy(desc(deliverySetupReceipts.createdAt))
    .limit(50);
  const selected = receipts.find((row) => row.id === c.req.query('receipt')) ?? receipts[0];
  const parsed = setupReceiptSchema.safeParse(selected?.receipt);
  const report = parsed.success ? parsed.data : undefined;
  const manifest = selected?.manifest as ReturnType<typeof agentSetupManifest> | undefined;
  const facts =
    report?.commitSha && report.repositoryId && selected?.projectId
      ? await db
          .select({
            fact: providerObservations,
            repo: repositoryBindings.fullName,
            provider: repositoryBindings.provider,
          })
          .from(providerObservations)
          .innerJoin(repositoryBindings, eq(repositoryBindings.id, providerObservations.bindingId))
          .where(
            and(
              eq(repositoryBindings.teamId, access.team.id),
              eq(repositoryBindings.repositoryId, report.repositoryId),
              eq(providerObservations.projectId, selected.projectId),
              eq(providerObservations.commitSha, report.commitSha.toLowerCase()),
            ),
          )
          .orderBy(desc(providerObservations.observedAt))
          .limit(20)
      : [];
  return c.html(
    <AppLayout
      user={user}
      title="Delivery receipts"
      active="receipts"
      bleed
      band={
        options.error ? (
          <Band kind="warn" tag="Report not saved">
            {options.error}
          </Band>
        ) : undefined
      }
      head={
        <PageHead
          trail={teamTrail(access.team, { label: 'Delivery', href: `/app/teams/${access.team.slug}/delivery` }, { label: 'Receipts' })}
          title="Delivery receipts"
          sub="What the agent reported and what a provider observed are different claims."
          actions={
            <a class="btn" href={`/app/teams/${access.team.slug}/delivery`}>
              Back to Delivery
            </a>
          }
        />
      }
      inspector={
        <Inspector>
          <FlowSection title="Provider-observed facts">
            {facts.length ? (
              facts.map(({ fact, repo, provider }) => (
                <div class="flow-record">
                  <b>
                    {fact.subjectId} · {fact.state}
                  </b>
                  <p>
                    {provider} · {repo}
                  </p>
                  <dl class="flow-facts">
                    <dt>Commit</dt>
                    <dd>
                      <code>{fact.commitSha}</code>
                    </dd>
                    <dt>Observed</dt>
                    <dd>{fact.observedAt.toISOString()}</dd>
                    <dt>Received</dt>
                    <dd>{fact.receivedAt.toISOString()}</dd>
                    <dt>Attempt</dt>
                    <dd>{fact.attempt}</dd>
                  </dl>
                </div>
              ))
            ) : (
              <p>
                No provider evidence matches this report's exact repository, commit and project.
                Unknown is not success.
              </p>
            )}
            <p class="small">
              Even a successful run does not prove all branch rules, reviews or environment
              approvals. Human approval is never inferred from a report.
            </p>
            <a href={`/app/teams/${access.team.slug}/repositories`}>Read provider evidence</a>
          </FlowSection>
        </Inspector>
      }
      keysNote="A returned receipt is not permission to merge or deploy"
    >
      <FlowSection title="Record an agent report">
        <details open={!selected || Boolean(options.error)}>
          <summary>
            {selected ? 'Record another report' : 'Paste the compact report returned by your agent'}
          </summary>
          <form method="post" class="authform">
            <Field id="setup-receipt" label="Compact schemaVersion 2 JSON receipt" required>
              <textarea class="in" id="setup-receipt" name="receipt" required rows={8}>
                {options.receipt}
              </textarea>
            </Field>
            <button class="btn" type="submit">
              Record report (not approval)
            </button>
            <p class="small">
              Reports must match the issued flow, effective policy and execution mode. Changed packs
              are refused: generate a fresh pack, then return a matching receipt.
            </p>
          </form>
        </details>
      </FlowSection>
      <FlowSection title="Agent-reported actions">
        {selected && report ? (
          <>
            <dl class="flow-facts">
              <dt>Reported</dt>
              <dd>{selected.at.toISOString()}</dd>
              <dt>Submitted via</dt>
              <dd>
                {selected.tokenId ? 'Authenticated agent credential' : 'Human console submission'}
              </dd>
              <dt>Status</dt>
              <dd>{report.status} · unverified</dd>
              <dt>Scope</dt>
              <dd>
                {manifest?.team} / {manifest?.project ?? 'workspace'}
              </dd>
              <dt>Mode</dt>
              <dd>{manifest?.mode}</dd>
              <dt>Version</dt>
              <dd>{manifest?.flowVersion ?? 'Blueprint'}</dd>
              <dt>Repo writes</dt>
              <dd>{report.repositoryWrites ? 'Agent says yes' : 'Agent says no'}</dd>
              <dt>Provider writes</dt>
              <dd>{report.providerWrites ? 'Agent says yes' : 'Agent says no'}</dd>
              <dt>Policy hash</dt>
              <dd>
                <code>{report.policyHash ?? 'Not included'}</code>
              </dd>
            </dl>
            <details class="flow-record">
              <summary>Exact returned JSON</summary>
              <pre>{JSON.stringify(report, null, 2)}</pre>
            </details>
          </>
        ) : (
          <FlowEmpty title="No report returned yet">
            <p>
              Download a setup pack, give it to your agent and return its compact receipt.
              Downloading alone changes nothing at the provider.
            </p>
          </FlowEmpty>
        )}
      </FlowSection>
      <FlowSection title="Receipt history">
        {receipts.map((row) => (
          <div class="flow-record">
            <a href={`/app/teams/${access.team.slug}/delivery/receipts?receipt=${row.id}`}>
              Unverified report · {row.at.toISOString()}
            </a>
          </div>
        ))}
        <p class="small">
          Latest 50 retained reports. A previously accepted report is historical, not a continuing
          assertion that the current flow or policy is unchanged.
        </p>
      </FlowSection>
    </AppLayout>,
  );
}
deliveryRoutes.get('/app/teams/:slug/delivery/receipts', (c) => renderReceipts(c));
deliveryRoutes.post('/app/teams/:slug/delivery/receipts', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const access = await teamForUser(c.get('db'), user.id, c.req.param('slug'));
  if (!access) return c.notFound();
  const body = await c.req.parseBody();
  const fail = (error: string, status: 400 | 409 = 400) => {
    c.status(status);
    return renderReceipts(c, { error, receipt: String(body.receipt ?? '').slice(0, 100_000) });
  };
  let value: unknown;
  try {
    value = JSON.parse(String(body.receipt));
  } catch {
    return fail('Invalid JSON receipt. Your input is preserved; nothing was recorded.');
  }
  const setupId = (value as { setupId?: unknown } | null)?.setupId;
  if (typeof setupId !== 'string')
    return fail('Missing setup ID. Use the ID from the downloaded pack.');
  const [setup] = await c
    .get('db')
    .select()
    .from(deliverySetups)
    .where(and(eq(deliverySetups.id, setupId), eq(deliverySetups.teamId, access.team.id)));
  if (!setup)
    return fail('Setup unavailable in this workspace. Check the exact pack and scope.', 409);
  const result = await receiveSetupReceipt(c.get('db'), user.id, value);
  if ('error' in result) return fail(result.error!, 409);
  return c.redirect(`/app/teams/${access.team.slug}/delivery/receipts`, 303);
});

// ---------------------------------------------------------------- write paths

// `project` is the slug the page wrote into `scope_project`, which it only writes
// after resolving a real project of this team, so the project's own address is safe.
const back = (slug: string, msg: string, ok = false, flowId?: string, project?: string): string =>
  `${sectionHref(slug, project ?? null, 'delivery')}?${ok ? 'ok' : 'error'}=${encodeURIComponent(msg)}${
    flowId ? `&flow=${flowId}` : ''
  }`;

deliveryRoutes.post('/app/teams/:slug/delivery', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const slug = c.req.param('slug');
  const db = c.get('db');
  const form = await c.req.parseBody();
  const returnProject = String(form.scope_project ?? '').trim() || undefined;
  /**
   * A refused publish hands the designer back with every line still in it. The
   * usual refusal is one malformed environment line at the end of a long list.
   *
   * Only for somebody who has a designer, though: a member's page does not draw
   * the dialog at all, so handing them the page would answer 422 with nothing
   * on it that explains why. They keep the band, which is what they can read.
   */
  const membership = await teamForUser(db, user.id, slug);
  const typed = form as Record<string, unknown>;
  const refuse = (error: string) =>
    membership?.role === 'owner'
      ? renderDelivery(c, { typed, error })
      : c.redirect(back(slug, error, false, undefined, returnProject), 302);
  const parsed = flowFromForm(typed);
  if (failed(parsed)) return refuse(parsed.error);
  const scope = String(form.scope ?? '').trim();
  const result = await saveDeliveryFlow(db, user.id, {
    team: slug,
    project: scope || undefined,
    name: String(form.name ?? ''),
    templateKey: String(form.templateKey ?? 'custom') || 'custom',
    provider: String(form.provider ?? 'azure-devops'),
    document: parsed.document,
    flowId: String(form.flowId ?? '').trim() || undefined,
  });
  // saveDeliveryFlow's transaction can return from either branch, so use the
  // discriminant directly here rather than widening that nested union through
  // the generic failed() helper.
  if ('error' in result) return refuse(result.error);
  void track(db, {
    teamId: result.flow.teamId,
    projectId: result.flow.projectId,
    userId: user.id,
    action: 'delivery_flow_published',
    detail: `${result.flow.name} v${result.flow.version} · ${scope || 'team-wide'} · ${result.flow.provider}`,
  });
  return c.redirect(
    back(
      slug,
      `Published "${result.flow.name}" v${result.flow.version}. Agents receive it from get_workflow now.`,
      true,
      result.flow.id,
      returnProject,
    ),
    302,
  );
});

deliveryRoutes.post('/app/teams/:slug/delivery/:id/archive', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const slug = c.req.param('slug');
  const db = c.get('db');
  const result = await archiveDeliveryFlow(db, user.id, slug, c.req.param('id'));
  if (failed(result)) return c.redirect(back(slug, result.error), 302);
  void track(db, {
    teamId: result.flow.teamId,
    projectId: result.flow.projectId,
    userId: user.id,
    action: 'delivery_flow_archived',
    detail: result.flow.name,
  });
  return c.redirect(back(slug, `Archived "${result.flow.name}".`, true), 302);
});

/**
 * Commit the rendered Azure DevOps pipeline and register it. Placeholder
 * output is accepted only through the explicitly labelled scaffold action;
 * the legacy `/apply` route name remains for compatibility. This is the one
 * place STMA writes into a team's repository, so it is owner-only, confirmed
 * in the browser, and logged with exactly what it did.
 */
deliveryRoutes.post('/app/teams/:slug/delivery/:id/apply', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const slug = c.req.param('slug');
  const db = c.get('db');
  const found = await teamForUser(db, user.id, slug);
  if (!found || found.role !== 'owner') return c.notFound();

  const flows = await listDeliveryFlows(db, found.team.id, FLOW_LIMIT);
  const target = flows.find((row) => row.flow.id === c.req.param('id'));
  if (!target) return c.redirect(back(slug, 'That flow is not in this team.'), 302);
  if (target.flow.provider !== 'azure-devops') {
    return c.redirect(
      back(
        slug,
        'Only Azure DevOps flows can be applied from here — GitHub Actions runs from the committed file alone.',
        false,
        target.flow.id,
      ),
      302,
    );
  }
  const ado = await adoForTeam(db, found.team.id, target.flow.projectId);
  if (!ado) {
    return c.redirect(
      back(slug, 'Connect Azure DevOps on the team page first.', false, target.flow.id),
      302,
    );
  }
  const document = parseFlowDocument(target.flow.document);
  const pipeline = renderPipeline(document, 'azure-devops', {
    name: target.flow.name,
    version: target.flow.version,
  });
  const form = await c.req.parseBody();
  const scaffold = pipelineIsScaffold(pipeline);
  if (scaffold && form.mode !== 'scaffold') {
    return c.redirect(
      back(
        slug,
        'This pipeline still contains placeholder deploy steps or checks. STMA refused to treat it as a working setup; use the explicitly labelled “Commit pipeline scaffold” action if you only want the draft file.',
        false,
        target.flow.id,
      ),
      302,
    );
  }
  const result = await setupPipeline(c.get('env'), ado, {
    path: pipeline.path,
    content: pipeline.yaml,
    branch: document.branch.from,
    message: `Add ${pipeline.path} from the STMA delivery flow "${target.flow.name}" (v${target.flow.version})`,
    pipelineName: `stma-${target.flow.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')}`,
  });
  if (!result.ok) {
    // Remember the verdict where the page reads it, so the warning survives the redirect.
    await saveIntegration(db, {
      teamId: found.team.id,
      userId: user.id,
      provider: 'azure-devops',
      locator: adoLocator(ado),
      token: ado.token,
      config: { lastCheck: { ok: false, at: new Date().toISOString(), error: result.error } },
    });
    return c.redirect(back(slug, describeAdoFailure(result.error), false, target.flow.id), 302);
  }
  await saveIntegration(db, {
    teamId: found.team.id,
    userId: user.id,
    provider: 'azure-devops',
    locator: adoLocator(ado),
    token: ado.token,
    config: {
      lastCheck: {
        ok: true,
        at: new Date().toISOString(),
        defaultBranch: document.branch.from,
        empty: false,
      },
    },
  });
  void track(db, {
    teamId: found.team.id,
    projectId: target.flow.projectId,
    userId: user.id,
    action: scaffold ? 'delivery_scaffold_committed' : 'delivery_flow_applied',
    detail: `${target.flow.name} → ${adoLocator(ado)} (${result.value.updated ? 'updated' : 'created'} ${pipeline.path}${result.value.pipelineId ? `, pipeline #${result.value.pipelineId}` : ''}${scaffold ? ', scaffold only' : ''})`,
  });
  const message =
    `${result.value.updated ? 'Updated' : 'Committed'} ${scaffold ? 'pipeline scaffold ' : ''}${pipeline.path} on ${document.branch.from}` +
    (result.value.pipelineId
      ? ` and registered pipeline #${result.value.pipelineId}${result.value.pipelineUrl ? ` — ${result.value.pipelineUrl}` : ''}.`
      : '.') +
    (result.value.note ? ` ${result.value.note}` : '');
  return c.redirect(back(slug, message, true, target.flow.id), 302);
});
