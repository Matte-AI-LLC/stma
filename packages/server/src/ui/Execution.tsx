import type { ExecutionDetailDto, ExecutionJobDto, ExecutionTargetDto } from '@bridge/shared';
import type { Child } from 'hono/jsx';

const readinessLabel: Record<ExecutionTargetDto['readiness'], string> = {
  available: 'Ready',
  busy: 'Busy',
  offline: 'Offline',
  disabled: 'Disabled',
  quarantined: 'Quarantined',
  needs_auth: 'Needs authentication',
};

const stateLabel: Record<ExecutionJobDto['state'], string> = {
  queued: 'Queued · no process start observed',
  leased: 'Worker claimed · process start not observed',
  starting: 'Starting · process start not yet observed',
  running: 'Running · worker observed the session',
  needs_input: 'Needs input · the worker stopped for a human step',
  cancel_requested: 'Cancellation requested · process stop not confirmed',
  succeeded: 'Turn finished · worker-reported; acceptance is separate',
  failed: 'Worker-reported failure',
  cancelled: 'Cancelled · see the event for the stop report',
  dispatch_unknown: 'Execution status unknown · checkout quarantined',
  lost: 'Worker lease lost · checkout quarantined',
};

const activeState = (state: ExecutionJobDto['state']) =>
  ['queued', 'leased', 'starting', 'running'].includes(state);

const age = (value: string | null) => {
  if (!value) return 'never';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
};

const TargetCard = ({
  target,
  userId,
  workspaceOwner,
  back,
}: {
  target: ExecutionTargetDto;
  userId: string;
  workspaceOwner: boolean;
  back: Child;
}) => {
  const canEnable = target.owner_id === userId && !target.enabled && !target.quarantined;
  const canDisable = target.enabled && (target.owner_id === userId || workspaceOwner);
  const exact = `Enable the configured target "${target.installation_name}"?\nProject: ${target.project_name}\nCheckout: ${target.checkout_path}\nRuntime: ${target.runtime} ${target.runtime_version}\nPermission profile: ${target.permission_profile}\nLimits: ${target.max_runtime_seconds} seconds, requested CLI turn limit ${target.max_turns}, one job at a time.\nThe worker runs as this OS user and receives the explicitly selected API credential. This is not an OS sandbox. The foreground worker does not wake the machine or use cloud fallback.`;
  return (
    <article class="card card-pad" data-execution-target={target.id} style="display:flex;flex-direction:column;gap:12px;min-width:0;overflow-wrap:anywhere">
      <div class="row" style="justify-content:space-between;align-items:flex-start;flex-wrap:wrap">
        <div>
          <div class="card-title">{target.installation_name}</div>
          <div class="card-note">{readinessLabel[target.readiness]} · {target.reason}</div>
        </div>
        <span class={`pill ${target.readiness === 'available' ? 'pill-owner' : 'pill-muted'}`}>
          {readinessLabel[target.readiness]}
        </span>
      </div>
      <dl class="flow-facts">
        <dt>Project</dt><dd>{target.project_name}</dd>
        <dt>Checkout declared by CLI</dt><dd><code>{target.checkout_path}</code></dd>
        <dt>Runtime</dt><dd><code>{target.runtime}</code> · {target.runtime_version}</dd>
        <dt>Permission profile</dt><dd><code>{target.permission_profile}</code></dd>
        <dt>Limits</dt><dd>{target.max_runtime_seconds}s · requested CLI turn limit {target.max_turns} · 1 concurrent job</dd>
        <dt>Worker heartbeat</dt><dd>{age(target.last_seen)}</dd>
      </dl>
      {canEnable ? (
        <form method="post" action={`/app/execution-targets/${target.id}/enable`} data-confirm={exact} data-confirm-title="Enable this execution target?" data-confirm-action="Enable target">
          {back}
          <button class="btn btn-primary" style="white-space:normal;height:auto;min-height:38px" type="submit">Enable after reviewing this target</button>
        </form>
      ) : canDisable ? (
        <form method="post" action={`/app/execution-targets/${target.id}/disable`} data-confirm={`Disable ${target.installation_name} in ${target.project_name}? This blocks new claims and requests cancellation of queued or active jobs. A cancellation request does not prove a process stopped.`} data-confirm-title="Disable execution target?" data-confirm-action="Disable target">
          {back}
          <button class="btn btn-danger" type="submit">Disable target</button>
        </form>
      ) : target.enabled ? (
        <p class="small muted m0">Enabled by this installation's owner. Only that person can enable it; a workspace owner can disable it.</p>
      ) : (
        <p class="small muted m0">Disabled. Only this installation's owner can enable it.</p>
      )}
      <p class="small muted m0">
        Readiness requires a recent worker heartbeat. An ordinary MCP connection does not make this target ready.
        This foreground worker runs as the same OS user, without an OS sandbox, and starts no service or machine wake-up.
      </p>
    </article>
  );
};

export const ManagedExecution = ({
  teamSlug,
  teamRole,
  userId,
  targets,
  jobs,
  detail,
  back,
  pageHref,
}: {
  teamSlug: string;
  teamRole: string;
  userId: string;
  targets: ExecutionTargetDto[];
  jobs: ExecutionJobDto[];
  detail?: ExecutionDetailDto;
  back: Child;
  pageHref: string;
}) => (
  <section id="managed-execution" style="display:flex;flex-direction:column;gap:14px">
    <div class="card card-pad">
      <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap">
        <div class="card-title">Managed local execution</div>
        <div class="row" style="flex-wrap:wrap">
          <a class="btn btn-sm" href="/docs#tools-execution">Setup guide</a>
          <a class="btn btn-sm" href={detail ? `${pageHref}?execution=${detail.job.id}#managed-execution` : `${pageHref}#managed-execution`}>Refresh status</a>
        </div>
      </div>
      <p class="m0 small" style="margin-top:8px">
        Configure a dedicated project checkout with <code>stma worker configure</code>. It starts disabled.
        Review the CLI-declared checkout, project, runtime/version, permission profile and limits below before enabling it.
        Worker authentication uses the selected local STMA profile; model inference uses the provider API key named in the local environment.
        The timeout and requested CLI turn limit are operational controls, not a guaranteed dollar cap; provider-reported turn counts may differ. STMA does not measure every BYO provider charge.
      </p>
      <p class="m0 small muted" style="margin-top:8px">
        Current support is Claude Code <code>claude-print-v1</code> with <code>restricted-files-v1</code>:
        scoped Read/Edit/Write/Glob/Grep plus project STMA MCP/hooks; no shell, Git, tests, subagents or web.
        Permission-required operations end as <code>needs_input</code> when stopping is verified; uncertain stops quarantine the checkout.
        The same OS user can access its other files and credentials.
        This is not an OS sandbox. The worker runs in the foreground only, with no service, machine wake-up or cloud fallback.
      </p>
    </div>
    {targets.length ? (
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:12px">
        {targets.map((target) => <TargetCard target={target} userId={userId} workspaceOwner={teamRole === 'owner'} back={back} />)}
      </div>
    ) : (
      <div class="card card-pad">
        <b>No managed target configured for this scope</b>
        <p class="small m0" style="margin-top:6px">Configure a dedicated checkout with the CLI. The registration stays disabled until its installation owner enables it here.</p>
        <ol class="small" style="margin:10px 0 0;padding-left:20px">
          <li>Follow the <a href="/docs#tools-execution">setup guide</a> to connect and configure a dedicated checkout.</li>
          <li>Review and enable its target here, then run <code>stma worker start</code> on that machine.</li>
          <li>Ask the assigning agent to use <code>dispatch_work</code> for the assignment and target. Assigning work alone does not start the worker.</li>
        </ol>
      </div>
    )}
    {jobs.length ? (
      <div class="card scroll-x" id="execution-jobs">
        <div class="card-head"><div><div class="card-title">Recent executions</div><div class="card-note">Newest 30 in this scope. A queued job means it is waiting for its worker, not that Claude started.</div></div></div>
        <table class="tbl">
          <tr><th>Execution</th><th>Target</th><th>Status</th><th>Created</th></tr>
          {jobs.map((job) => {
            const target = targets.find((row) => row.id === job.target_id);
            return <tr>
              <td><a href={`${pageHref}?execution=${job.id}#managed-execution`}><code>{job.id.slice(0, 8)}</code></a> · <a href={`/app/sessions/${job.session_id}`}>assignment</a></td>
              <td>{target?.installation_name ?? 'Managed target'}</td>
              <td>{stateLabel[job.state]}</td>
              <td class="muted">{new Date(job.created_at).toISOString().slice(0, 16).replace('T', ' ')} UTC</td>
            </tr>;
          })}
        </table>
      </div>
    ) : targets.length ? (
      <div class="card card-pad">
        <b>No executions yet</b>
        <p class="small m0" style="margin-top:6px">Once an enabled target is ready, ask the assigning agent to find it with <code>list_execution_targets</code> and call <code>dispatch_work</code> for the assignment. Assigning work alone does not start a worker. Executions and their reported results will appear here.</p>
      </div>
    ) : null}
    {detail ? (
      <div class="card card-pad" id="execution-detail" data-execution={detail.job.id} style="display:flex;flex-direction:column;gap:10px;min-width:0;overflow-wrap:anywhere">
        <div class="card-title">Execution <code>{detail.job.id}</code></div>
        <p class="m0">{stateLabel[detail.job.state]}</p>
        <p class="small muted m0">Target: {detail.target.installation_name} · {detail.target.project_name} · <code>{detail.target.checkout_path}</code></p>
        {detail.attempt?.run_id ? <p class="m0"><a href={`/app/teams/${teamSlug}/runs/${detail.attempt.run_id}`}>Open reported run evidence</a></p> : null}
        <p class="small muted m0">Result provenance: worker reported. This does not create verified delivery evidence or human acceptance.</p>
        {detail.job.state === 'needs_input' ? <p class="small m0">Next step: open the worker machine and handle the provider permission, authentication or quota request. No broader permission is added automatically.</p> : null}
        {detail.job.state === 'cancel_requested' ? <p class="small m0">Cancellation was requested. Wait for a worker stop report; the process may still be running.</p> : null}
        {['dispatch_unknown', 'lost'].includes(detail.job.state) ? <p class="small m0">Inspect the worker machine. If process ownership cannot be verified, use a new dedicated checkout. Deleting the lock or killing a recorded PID is not verified recovery.</p> : null}
        {detail.events.slice(0, 5).map((event) => <div class="small muted">{event.state} · {event.reason} · {new Date(event.created_at).toISOString().slice(0, 16).replace('T', ' ')} UTC{event.detail ? ` · ${event.detail}` : ''}</div>)}
        {detail.can_cancel && activeState(detail.job.state) ? (
          <form method="post" action={`/app/executions/${detail.job.id}/cancel`} data-confirm="Request cancellation of this execution? The request revokes its child STMA credential. It does not prove the local process stopped." data-confirm-title="Request cancellation?" data-confirm-action="Request cancel">
            {back}
            <button class="btn btn-danger" type="submit">Request cancellation</button>
          </form>
        ) : null}
      </div>
    ) : null}
  </section>
);
