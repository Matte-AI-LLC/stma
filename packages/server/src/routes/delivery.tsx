import type { DeliveryFlow, FlowProvider } from '@bridge/shared';
import { MERGE_STRATEGIES, TICKET_SYSTEMS } from '@bridge/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { loginRedirect } from '../auth/session';
import { projects } from '../db/schema';
import { teamForUser } from '../domain/access';
import {
  archiveDeliveryFlow,
  flowBrief,
  listDeliveryFlows,
  parseFlowDocument,
  pipelinePath,
  renderPipeline,
  saveDeliveryFlow,
  type FlowRow,
} from '../domain/delivery';
import { adoForTeam, integrationFor, saveIntegration } from '../domain/integrations';
import {
  FLOW_TEMPLATES,
  recommendTemplate,
  templateByKey,
  type WizardAnswers,
} from '../domain/flowTemplates';
import { adoLocator, describeAdoFailure, setupPipeline, type AdoHealth } from '../lib/azureDevops';
import { environmentsToLines, flowFromForm, listToLines } from '../lib/flowForm';
import { timeAgo } from '../lib/format';
import { failed } from '../lib/result';
import { track } from '../lib/track';
import type { AppEnv } from '../types';
import { Field, Lead, PageHead, Vr } from '../ui/Console';
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

/** The four questions, with every answer the scorer accepts. */
const WIZARD = [
  {
    key: 'tracker',
    q: 'Where does a change start?',
    options: [
      ['jira', 'A Jira ticket'],
      ['azure-boards', 'An Azure Boards work item'],
      ['github', 'A GitHub issue'],
      ['none', 'Someone just starts — no tracker'],
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
      ['staged', 'Through stage/UAT with sign-off'],
      ['release', 'As versioned releases, on a schedule'],
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

// ----------------------------------------------------------------- rendering

const CopyBlock = ({ label, content }: { label: string; content: string }) => (
  <div style="display:flex;flex-direction:column;gap:6px;min-width:0">
    <div class="row" style="justify-content:space-between">
      <span class="overline">{label}</span>
      <button class="copybtn onlight" type="button" data-copy={content}>
        COPY
      </button>
    </div>
    <div class="cmd">
      <code>{content}</code>
    </div>
  </div>
);

/** The designer dialog, prefilled from whichever document the page opened on. */
const DesignDialog = ({
  slug,
  teamProjects,
  document,
  templateKey,
  provider,
  name,
  flow,
}: {
  slug: string;
  teamProjects: { name: string }[];
  document: DeliveryFlow;
  templateKey: string;
  provider: string;
  name: string;
  /** Editing this flow; absent means creating a new one. */
  flow?: FlowRow;
}) => (
  <dialog id="design-flow" class="formdlg wide">
    <h3>{flow ? `Edit ${flow.name}` : 'Design a delivery flow'}</h3>
    <p class="dlgsub">
      This becomes three things at once: the brief agents read over MCP, the picture on this
      page, and the CI pipeline. Publish it once and the three cannot drift apart.
    </p>
    <form method="post" action={`/app/teams/${slug}/delivery`}>
      {flow ? <input type="hidden" name="flowId" value={flow.id} /> : null}
      <input type="hidden" name="templateKey" value={templateKey} />
      <Field id="df-name" label="Flow name" required>
        <input class="in" id="df-name" name="name" required maxlength={80} value={name} />
      </Field>
      <div class="row" style="align-items:flex-start;gap:14px;flex-wrap:wrap">
        <Field id="df-scope" label="Scope" help="A project flow replaces the team-wide one for that project only.">
          <select class="in" id="df-scope" name="scope" aria-describedby="df-scope-help">
            <option value="" selected={!flow?.projectId}>
              Team-wide
            </option>
            {teamProjects.map((p) => (
              <option value={p.name}>Project: {p.name}</option>
            ))}
          </select>
        </Field>
        <Field id="df-provider" label="CI provider" required>
          <select class="in" id="df-provider" name="provider">
            <option value="azure-devops" selected={provider === 'azure-devops'}>
              Azure DevOps
            </option>
            <option value="github-actions" selected={provider === 'github-actions'}>
              GitHub Actions
            </option>
          </select>
        </Field>
      </div>
      <Field id="df-intro" label="One-line intro">
        <input class="in" id="df-intro" name="intro" maxlength={300} value={document.intro} />
      </Field>
      <div class="row" style="align-items:flex-start;gap:14px;flex-wrap:wrap">
        <Field id="df-ticket" label="Ticket tracker">
          <select class="in" id="df-ticket" name="ticketSystem">
            {TICKET_SYSTEMS.map((system) => (
              <option value={system} selected={system === document.ticket.system}>
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
            value={document.ticket.keyPattern}
            aria-describedby="df-ticketkey-help"
          />
        </Field>
      </div>
      <label class="checkrow">
        <input type="checkbox" name="ticketRequired" value="on" checked={document.ticket.required} />
        <span>
          <span class="checkrow-label">Work must not start without a ticket</span>
          <span class="checkrow-note">Agents are told so in exactly those words.</span>
        </span>
      </label>
      <div class="row" style="align-items:flex-start;gap:14px;flex-wrap:wrap">
        <Field id="df-branchpat" label="Branch naming" required help="Placeholders: {ticket}, {slug}, {type}.">
          <input
            class="in"
            id="df-branchpat"
            name="branchPattern"
            required
            maxlength={120}
            value={document.branch.pattern}
            aria-describedby="df-branchpat-help"
          />
        </Field>
        <Field id="df-branchfrom" label="Branches from" required>
          <input class="in" id="df-branchfrom" name="branchFrom" required maxlength={60} value={document.branch.from} />
        </Field>
      </div>
      <Field id="df-checks" label="Required checks" help="One command per line — these become the CI check stage.">
        <textarea class="in" id="df-checks" name="checks" rows={3} aria-describedby="df-checks-help">
          {listToLines(document.checks)}
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
            value={String(document.review.approvals)}
          />
        </Field>
        <Field id="df-merge" label="Merge strategy" required>
          <select class="in" id="df-merge" name="mergeStrategy">
            {MERGE_STRATEGIES.map((strategy) => (
              <option value={strategy} selected={strategy === document.mergeStrategy}>
                {strategy}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field
        id="df-envs"
        label="Environments, in order"
        help="One per line: name = merge | tag | manual, optionally “, approval” for a sign-off gate. Example: uat = manual, approval"
      >
        <textarea class="in" id="df-envs" name="environments" rows={3} aria-describedby="df-envs-help">
          {environmentsToLines(document.environments)}
        </textarea>
      </Field>
      <Field id="df-notes" label="House rules" help="One per line; they ride the brief verbatim.">
        <textarea class="in" id="df-notes" name="notes" rows={2} aria-describedby="df-notes-help">
          {listToLines(document.notes)}
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

// ---------------------------------------------------------------------- page

deliveryRoutes.get('/app/teams/:slug/delivery', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await teamForUser(db, user.id, c.req.param('slug'));
  if (!found) return c.notFound();
  const { team, role } = found;
  const isOwner = role === 'owner';

  const flows = await listDeliveryFlows(db, team.id, FLOW_LIMIT);
  const active = flows.filter((row) => row.flow.status === 'active');
  const teamProjects = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.teamId, team.id))
    .orderBy(projects.name)
    .limit(PROJECT_LIMIT);
  const ado = await adoForTeam(db, team.id);
  const adoRow = await integrationFor(db, team.id, 'azure-devops');
  const adoLastCheck = (adoRow?.config as { lastCheck?: AdoHealth } | null)?.lastCheck;

  const selectedFlow = flows.find((row) => row.flow.id === c.req.query('flow'));
  const answers = c.req.query('wizard') ? wizardAnswers((k) => c.req.query(k)) : null;
  const recommended = answers ? recommendTemplate(answers) : null;
  const selectedTemplate = templateByKey(c.req.query('template') ?? '') ?? recommended?.template;
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
          document: selectedTemplate.document,
          templateKey: selectedTemplate.key,
          provider: 'azure-devops',
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
          crumb={`/ ${team.slug} / delivery`}
          title="Delivery"
          sub="How work moves here, written once: agents read it as a brief, people see it as a picture, CI runs it as a pipeline."
          actions={
            isOwner ? (
              <button class="btn btn-sm btn-primary" type="button" data-open-dialog="#design-flow">
                {selectedFlow ? 'Edit this flow' : 'Design a flow'}
              </button>
            ) : undefined
          }
        />
      }
      keys={[{ k: 'W', label: 'wizard asks four questions' }]}
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

      {showWizard ? (
        <div class="card card-pad" style="display:flex;flex-direction:column;gap:16px">
          <div>
            <div class="card-title">Not sure what to set up?</div>
            <div class="card-note">
              Four questions, one recommendation, and the reasons for it — then adjust anything in
              the designer before publishing.
            </div>
          </div>
          <form method="get" action={`/app/teams/${team.slug}/delivery`} class="stack" style="gap:14px">
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
                        checked={answers ? (answers as unknown as Record<string, string>)[step.key] === value : false}
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
            <div class="card card-pad" style="background:var(--green-bg);border-color:var(--green-line);display:flex;flex-direction:column;gap:10px">
              <div class="row" style="justify-content:space-between;flex-wrap:wrap">
                <div>
                  <div class="card-title">{recommended.template.name}</div>
                  <div class="card-note">{recommended.template.oneLiner}</div>
                </div>
                {isOwner ? (
                  <button class="btn btn-sm btn-primary" type="button" data-open-dialog="#design-flow">
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
            <span class="muted small">Answer all four to get a recommendation.</span>
          ) : null}
        </div>
      ) : null}

      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">Templates</div>
            <div class="card-note">
              Opinionated starting points — pick one, adjust it in the designer, publish.
            </div>
          </div>
          {!showWizard ? (
            <a class="btn btn-sm" href={`/app/teams/${team.slug}/delivery?wizard=1`}>
              Open the wizard
            </a>
          ) : null}
        </div>
        <div class="card-pad" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px">
          {FLOW_TEMPLATES.map((template) => (
            <div
              class="card card-pad"
              style={`display:flex;flex-direction:column;gap:8px${selectedTemplate?.key === template.key ? ';border-color:var(--green)' : ''}`}
            >
              <div class="card-title">{template.name}</div>
              <span class="small" style="color:var(--txt-2)">
                {template.oneLiner}
              </span>
              <span class="muted small">{template.whenToUse}</span>
              <a
                class="btn btn-sm"
                style="align-self:flex-start;margin-top:auto"
                href={`/app/teams/${team.slug}/delivery?template=${template.key}${c.req.query('wizard') ? '&wizard=1' : ''}`}
              >
                Preview
              </a>
            </div>
          ))}
        </div>
        {selectedTemplate && !selectedFlow ? (
          <div class="card-pad" style="border-top:1px solid var(--line-2);display:flex;flex-direction:column;gap:12px">
            <div class="row" style="justify-content:space-between;flex-wrap:wrap">
              <div>
                <div class="card-title">{selectedTemplate.name}</div>
                <div class="card-note">{selectedTemplate.whenToUse}</div>
              </div>
              {isOwner ? (
                <button class="btn btn-sm btn-primary" type="button" data-open-dialog="#design-flow">
                  Use this template
                </button>
              ) : null}
            </div>
            <FlowDiagram flow={selectedTemplate.document} />
          </div>
        ) : null}
      </div>

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
                <th>Scope</th>
                <th>Provider</th>
                <th>Template</th>
                <th>Version</th>
                <th>Status</th>
                <th>Updated</th>
              </tr>
              {flows.map((row) => (
                <tr class={selectedFlow?.flow.id === row.flow.id ? 'warm' : undefined}>
                  <td class="name">
                    <a href={`/app/teams/${team.slug}/delivery?flow=${row.flow.id}`}>{row.flow.name}</a>
                  </td>
                  <td class="muted">{row.projectName ?? 'team-wide'}</td>
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

      {selectedFlow && detailDocument && detailPipeline && detailBrief ? (
        <div class="card">
          <div class="card-head">
            <div>
              <div class="card-title">
                {selectedFlow.flow.name} · v{selectedFlow.flow.version}
              </div>
              <div class="card-note">
                {selectedFlow.projectName
                  ? `Applies to project ${selectedFlow.projectName}.`
                  : 'Applies team-wide.'}{' '}
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
            <CopyBlock label="Agent brief — what get_workflow serves" content={detailBrief} />
            <CopyBlock label={`Pipeline — ${detailPipeline.path}`} content={detailPipeline.yaml} />
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
                          ? ` — verified ${timeAgo(new Date(adoLastCheck.at))}; the repository is empty, so applying creates `
                          : ` — verified ${timeAgo(new Date(adoLastCheck.at))}; applying commits `
                        : ' — applying commits '}
                      <span class="mono">{detailPipeline.path}</span>
                      {adoLastCheck?.ok && adoLastCheck.empty ? (
                        <>
                          {' '}as the first commit on <span class="mono">{detailDocument.branch.from}</span>
                        </>
                      ) : (
                        <>
                          {' '}to <span class="mono">{detailDocument.branch.from}</span>
                        </>
                      )}{' '}
                      and registers the pipeline.
                    </span>
                    {isOwner ? (
                      <form
                        method="post"
                        action={`/app/teams/${team.slug}/delivery/${selectedFlow.flow.id}/apply`}
                        class="m0"
                        data-confirm={`This writes a commit to ${adoLocator(ado)} on branch ${detailDocument.branch.from} and creates a pipeline. Continue?`}
                      >
                        <button class="btn btn-sm btn-primary" type="submit">
                          Set up in Azure DevOps
                        </button>
                      </form>
                    ) : (
                      <span class="muted small">Only an owner can apply it.</span>
                    )}
                  </div>
                </div>
              ) : isOwner ? (
                /* The PAT is asked for where it is needed: at the moment of
                   applying. The same handler as the team page's card, told to
                   come back here. */
                <div style="display:flex;flex-direction:column;gap:10px;border:1px solid var(--line-2);border-radius:8px;padding:14px">
                  <div>
                    <div class="card-title">Connect Azure DevOps to apply this flow</div>
                    <div class="card-note">
                      Needs a PAT with <b>Code read &amp; write</b> and <b>Build read &amp;
                      execute</b>. The connection is verified the moment you save it. Until then,
                      the YAML above works copy-pasted into{' '}
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
                  <a href={`/app/teams/${team.slug}`}>team page</a>. Until then, copy the YAML
                  above into <span class="mono">{detailPipeline.path}</span> yourself.
                </span>
              )
            ) : (
              <span class="muted small">
                Commit the YAML above as <span class="mono">{detailPipeline.path}</span> — GitHub
                picks workflows up from the file alone, so there is nothing to register.
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
        />
      ) : null}
    </AppLayout>,
  );
});

// ---------------------------------------------------------------- write paths

const back = (slug: string, msg: string, ok = false, flowId?: string): string =>
  `/app/teams/${slug}/delivery?${ok ? 'ok' : 'error'}=${encodeURIComponent(msg)}${
    flowId ? `&flow=${flowId}` : ''
  }`;

deliveryRoutes.post('/app/teams/:slug/delivery', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const slug = c.req.param('slug');
  const db = c.get('db');
  const form = await c.req.parseBody();
  const parsed = flowFromForm(form as Record<string, unknown>);
  if (failed(parsed)) return c.redirect(back(slug, parsed.error), 302);
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
  if (failed(result)) return c.redirect(back(slug, result.error), 302);
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
 * Apply the flow to Azure DevOps: commit the rendered pipeline file and
 * register the pipeline. The one place STMA writes into a team's repository,
 * which is why it is owner-only, confirmed in the browser, and logged to the
 * activity feed with exactly what it did.
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
      back(slug, 'Only Azure DevOps flows can be applied from here — GitHub Actions runs from the committed file alone.', false, target.flow.id),
      302,
    );
  }
  const ado = await adoForTeam(db, found.team.id);
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
  const result = await setupPipeline(c.get('env'), ado, {
    path: pipeline.path,
    content: pipeline.yaml,
    branch: document.branch.from,
    message: `Add ${pipeline.path} from the STMA delivery flow "${target.flow.name}" (v${target.flow.version})`,
    pipelineName: `stma-${target.flow.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`,
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
    return c.redirect(
      back(slug, describeAdoFailure(result.error), false, target.flow.id),
      302,
    );
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
    action: 'delivery_flow_applied',
    detail: `${target.flow.name} → ${adoLocator(ado)} (${result.value.updated ? 'updated' : 'created'} ${pipeline.path}${result.value.pipelineId ? `, pipeline #${result.value.pipelineId}` : ''})`,
  });
  const message =
    `${result.value.updated ? 'Updated' : 'Committed'} ${pipeline.path} on ${document.branch.from}` +
    (result.value.pipelineId
      ? ` and registered pipeline #${result.value.pipelineId}${result.value.pipelineUrl ? ` — ${result.value.pipelineUrl}` : ''}.`
      : '.') +
    (result.value.note ? ` ${result.value.note}` : '');
  return c.redirect(back(slug, message, true, target.flow.id), 302);
});
