import type { projects, providerObservations, repositoryBindings } from '../db/schema';
import type { User } from '../types';
import { timeAgo } from '../lib/format';
import { Band, Field, Inspector, PageHead } from './Console';
import { AppLayout } from './Layout';
import { FlowEmpty, FlowSection, ScopePill } from './ProductFlow';

export const RepositoryFlow = ({
  user,
  slug,
  owner,
  connections,
  bindings,
  projectList,
  facts,
  selectedId,
  error,
  values,
}: {
  user: User;
  slug: string;
  owner: boolean;
  connections: { id: string; repo: string; provider: string }[];
  bindings: (typeof repositoryBindings.$inferSelect)[];
  projectList: (typeof projects.$inferSelect)[];
  facts: { fact: typeof providerObservations.$inferSelect; repo: string }[];
  selectedId?: string;
  error?: string;
  values?: Record<string, string>;
}) => {
  const selected = bindings.find((row) => row.id === selectedId) ?? bindings[0];
  const selectedFacts = facts.filter(({ fact }) => fact.bindingId === selected?.id);
  const base = `/app/teams/${slug}/repositories`;
  const ambiguous = (binding: typeof repositoryBindings.$inferSelect) =>
    bindings.filter(
      (other) => other.provider === binding.provider && other.projectId === binding.projectId,
    ).length > 1;
  return (
    <AppLayout
      user={user}
      title="Repository connections"
      active="repositories"
      bleed
      strip={
        <>
          <span class="flow-status">Repository evidence</span>
          <span>
            {connections.length} connections · {bindings.length} bindings
          </span>
        </>
      }
      scope={<ScopePill workspace={slug} />}
      head={
        <PageHead
          crumb={`${slug} · repositories`}
          title="Repository connections"
          sub="A connection holds provider credentials. A binding ties one exact repository to one project. Evidence is a third, separate claim."
          actions={
            owner ? (
              <a class="btn btn-primary" href="#bind-repository">
                Bind a repository
              </a>
            ) : undefined
          }
        />
      }
      band={
        error ? (
          <Band kind="warn" tag="Not changed">
            {error}
          </Band>
        ) : undefined
      }
      inspector={
        <Inspector>
          {selected ? (
            <>
              <FlowSection
                title={`${selected.fullName} → ${projectList.find((p) => p.id === selected.projectId)?.name ?? 'no project'}`}
              >
                <dl class="flow-facts">
                  <dt>Provider</dt>
                  <dd>{selected.provider}</dd>
                  <dt>Repository ID</dt>
                  <dd>{selected.repositoryId}</dd>
                  <dt>Identity read</dt>
                  <dd>{selected.verifiedAt?.toISOString() ?? 'Not observed'}</dd>
                  <dt>Permissions</dt>
                  <dd>Not exhaustively checked. A successful read proves only that read.</dd>
                </dl>
                {ambiguous(selected) && (
                  <p>
                    Multiple repositories are bound to this project. Select an exact repository in
                    agent calls; nothing is guessed.
                  </p>
                )}
              </FlowSection>
              <FlowSection title="Read one exact result">
                <form method="post" action={`${base}/verify`}>
                  <input type="hidden" name="binding" value={selected.id} />
                  <Field
                    id="provider-run"
                    label={
                      selected.provider === 'github'
                        ? 'GitHub Actions run ID'
                        : 'Azure DevOps build ID'
                    }
                    required
                  >
                    <input
                      class="in"
                      id="provider-run"
                      name="run"
                      type="number"
                      min="1"
                      required
                      value={values?.run}
                    />
                  </Field>
                  <button class="btn" type="submit">
                    Re-check this result
                  </button>
                </form>
                <p class="small">
                  Read-only. Does not rerun, approve or deploy. An expired credential is only
                  reported when a provider read actually fails.
                </p>
              </FlowSection>
              <FlowSection title="Evidence">
                {selectedFacts.length ? (
                  selectedFacts.map(({ fact }) => (
                    <div class="flow-record">
                      <b>
                        {fact.subjectId} · {fact.state}
                      </b>
                      <dl class="flow-facts">
                        <dt>Commit</dt>
                        <dd>
                          <code>{fact.commitSha}</code>
                        </dd>
                        <dt>Source</dt>
                        <dd>
                          {selected.provider} · {fact.kind} · attempt {fact.attempt}
                        </dd>
                        <dt>Observed</dt>
                        <dd>
                          {fact.observedAt.toISOString()} ({timeAgo(fact.observedAt)})
                        </dd>
                        <dt>Received</dt>
                        <dd>{fact.receivedAt.toISOString()}</dd>
                        <dt>Scope</dt>
                        <dd>
                          {projectList.find((p) => p.id === fact.projectId)?.name ??
                            'Unavailable project'}
                          {fact.projectId !== selected.projectId ? ' · historical binding' : ''}
                        </dd>
                      </dl>
                    </div>
                  ))
                ) : (
                  <p>
                    No exact provider observations yet. Unknown does not mean failing or passing.
                  </p>
                )}
                <p class="small">
                  One result is not all required checks, reviews or environment approvals. Refresh
                  does not make an old observation new.
                </p>
              </FlowSection>
              {owner && (
                <FlowSection title="Change binding">
                  <form method="post" action={`${base}/rebind`}>
                    <input type="hidden" name="binding" value={selected.id} />
                    <input type="hidden" name="expectedProject" value={selected.projectId ?? ''} />
                    <Field id="rebind-project" label="Project" required>
                      <select class="in" id="rebind-project" name="project">
                        {projectList.map((p) => (
                          <option value={p.id} selected={p.id === selected.projectId}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <button
                      class="btn"
                      type="submit"
                      data-confirm={`Move ${selected.fullName} to the selected project? Existing evidence keeps its original scope; new observations use the new project.`}
                    >
                      Change project binding
                    </button>
                  </form>
                  <p class="small">
                    Only an owner may change this mapping. Existing evidence keeps its original
                    scope.
                  </p>
                </FlowSection>
              )}
            </>
          ) : (
            <FlowSection title="Nothing bound">
              <p>
                Connect a provider, then bind an exact repository. This page will show only observed
                facts, never assumed permissions.
              </p>
            </FlowSection>
          )}
        </Inspector>
      }
      keysNote="Provider connection ≠ repository binding ≠ verified outcome"
    >
      <div class="flow-columns">
        <FlowSection title="Providers">
          <p>
            Multiple connections are supported. Connecting one does not create a project binding.
          </p>
          {connections.map((row) => (
            <div class="flow-record">
              <b>{row.provider}</b>
              <p>{row.repo}</p>
              <span class="flow-status">Credential stored</span>
              {owner && (
                <form method="post" action={`${base}/disconnect`}>
                  <input type="hidden" name="id" value={row.id} />
                  <button
                    class="btn"
                    type="submit"
                    data-confirm="Disconnect this connection and its bindings? Provider credentials are not revoked at the provider."
                  >
                    Disconnect this connection
                  </button>
                </form>
              )}
            </div>
          ))}
          {!connections.length && (
            <FlowEmpty title="No provider connections">
              <p>Add a credential with the minimum read permissions you need.</p>
            </FlowEmpty>
          )}
          <p>
            <a href={`/app/teams/${slug}?tab=integrations`}>Add or update a provider connection</a>
          </p>
        </FlowSection>
        <FlowSection title="Exact project bindings">
          {bindings.length ? (
            <div class="scroll-x">
              <table class="tbl">
                <thead>
                  <tr>
                    <th>Repository · provider</th>
                    <th>Project</th>
                    <th>Binding</th>
                  </tr>
                </thead>
                <tbody>
                  {bindings.map((row) => (
                    <tr>
                      <td>
                        <a href={`${base}?binding=${row.id}`}>{row.fullName}</a>
                        <div class="small">
                          {row.provider} · ID {row.repositoryId}
                        </div>
                      </td>
                      <td>{projectList.find((p) => p.id === row.projectId)?.name ?? 'None'}</td>
                      <td>
                        {ambiguous(row)
                          ? 'Exact repo required'
                          : row.verifiedAt
                            ? 'Identity observed'
                            : 'Unverified'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <FlowEmpty title="Provider connected is not repository bound">
              <p>Choose an existing project and exact repository below.</p>
            </FlowEmpty>
          )}
          {owner && (
            <div id="bind-repository">
              {connections.some((c) => c.provider !== 'jira') && projectList.length ? (
                <form method="post" action={`${base}/bind`}>
                  <h3>Bind an exact repository</h3>
                  <Field id="binding-connection" label="Connection" required>
                    <select class="in" id="binding-connection" name="connection">
                      {connections
                        .filter((c) => c.provider !== 'jira')
                        .map((c) => (
                          <option value={c.id} selected={c.id === values?.connection}>
                            {c.provider} · {c.repo}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field
                    id="binding-repo"
                    label="GitHub owner/repo or Azure org/project/repo"
                    required
                  >
                    <input
                      class="in"
                      id="binding-repo"
                      name="repo"
                      maxlength={200}
                      required
                      value={values?.repo}
                    />
                  </Field>
                  <Field id="binding-project" label="Existing project" required>
                    <select class="in" id="binding-project" name="project">
                      {projectList.map((p) => (
                        <option value={p.id} selected={p.id === values?.project}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <button class="btn" type="submit">
                    Verify repository identity and bind
                  </button>
                  <p class="small">
                    Read-only provider verification. No pipeline is created and no code is changed.
                  </p>
                </form>
              ) : (
                <p>
                  Add a provider connection and <a href={`/app/teams/${slug}`}>create a project</a>{' '}
                  before binding.
                </p>
              )}
            </div>
          )}
        </FlowSection>
      </div>
    </AppLayout>
  );
};
