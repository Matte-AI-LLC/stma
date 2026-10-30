import {
  CHECK_NAMES,
  RECEIPT_IS_NOT_APPROVAL,
  STATE_WORDS,
  checkSourceWords,
  providerName,
  reportedTests,
  type EvidencePack,
} from '../domain/evidenceSummary';
import type { EvidenceCheck } from '../domain/evidence';

/**
 * The evidence pack's checks, each with where it came from in words.
 *
 * The map's inspector printed the raw source (`client_report · reported · …`),
 * which is exact and reads like a log line to the person deciding. The words
 * are the ones the Markdown summary uses, so a reviewer who pastes the summary
 * and one who reads the page are told the same thing.
 */
export const EvidenceChecks = ({ pack, only }: { pack: EvidencePack; only?: EvidenceCheck['source'] }) => (
  <>
    {pack.checks.filter((check) => !only || check.source === only).map((check) => (
      <div class="check">
        <span class={check.state === 'ok' ? 'y' : check.state === 'attention' ? 'n' : 'w'}>
          {check.state === 'ok' ? '✓' : check.state === 'attention' ? '!' : '?'}
        </span>
        <span>
          <b>{CHECK_NAMES[check.key] ?? check.key}</b>
          {' · '}
          {checkSourceWords(check, pack)}
          <span style="display:block">{check.detail}</span>
          <small class="muted" style="display:block">
            {STATE_WORDS[check.state]}
            {check.observedAt ? ` · as of ${check.observedAt}` : ''}
            {check.limitations?.map((limit) => (
              <span style="display:block">{limit}</span>
            ))}
          </small>
        </span>
      </div>
    ))}
  </>
);

/** What to look at first — never a verdict. */
export const EvidenceNext = ({ pack }: { pack: EvidencePack }) => (
  <span class="muted small">
    {pack.blocking.length > 0
      ? `Needs attention first: ${pack.blocking.map((key) => CHECK_NAMES[key] ?? key).join(', ')}.`
      : pack.unconfirmed.length > 0
        ? `Nothing failing, but unconfirmed: ${pack.unconfirmed.map((key) => CHECK_NAMES[key] ?? key).join(', ')}. Unconfirmed is not the same as fine.`
        : 'No recorded failure in the checks shown. Missing evidence is not approval.'}
  </span>
);

/** The delivered commit and the tests the agent reported with it. */
export const DeliveredCommit = ({ pack }: { pack: EvidencePack }) => {
  const checkpoint = pack.checkpoint;
  if (!checkpoint) {
    return (
      <p class="small muted m0">
        No delivery or tested checkpoint was reported, so no exact commit identifies this delivery.
        Provider results are not attached to a branch or a moving run head.
      </p>
    );
  }
  const tests = reportedTests(pack);
  const failed = checkpoint.tests.some((test) => test.state === 'failed');
  return (
    <div style="display:flex;flex-direction:column;gap:8px">
      <div class="check">
        <span class={checkpoint.worktreeClean && checkpoint.repositoryMatchesProject ? 'y' : 'n'}>
          {checkpoint.worktreeClean && checkpoint.repositoryMatchesProject ? '✓' : '!'}
        </span>
        <span>
          <span class="mono">{checkpoint.commitSha}</span> in{' '}
          <span class="mono">{checkpoint.repositoryIdentity}</span>
          <small class="muted" style="display:block">
            {checkpoint.kind} checkpoint · {checkpoint.worktreeClean ? 'clean worktree' : 'dirty worktree'} ·
            reported by the agent at {checkpoint.reportedAt}
            {checkpoint.repositoryMatchesProject ? '' : ' · not the project’s repository'}
          </small>
        </span>
      </div>
      <div class="check">
        <span class={failed ? 'n' : tests.length ? 'y' : 'w'}>{failed ? '!' : tests.length ? '✓' : '?'}</span>
        <span>
          {tests.length === 0 ? 'No test result was reported with this checkpoint.' : `Tests reported by the agent: ${tests.join('; ')}`}
        </span>
      </div>
    </div>
  );
};

const PROVIDER_STATE_MARK: Record<EvidencePack['provider']['state'], { cls: string; mark: string }> = {
  observed: { cls: 'y', mark: '✓' },
  no_checkpoint: { cls: 'w', mark: '?' },
  repository_mismatch: { cls: 'n', mark: '!' },
  not_connected: { cls: 'w', mark: '?' },
  connection_failing: { cls: 'n', mark: '!' },
  older_commit_only: { cls: 'w', mark: '?' },
  no_observation: { cls: 'w', mark: '?' },
};

/**
 * Why the provider line says what it says: nothing connected, a connection
 * whose last check failed, a result for an older commit only, or a result
 * that has not arrived. Results for an older commit are listed as that
 * commit's, never as this one's.
 */
export const ProviderStatus = ({ pack }: { pack: EvidencePack }) => {
  const mark = PROVIDER_STATE_MARK[pack.provider.state];
  return (
    <div class="check">
      <span class={mark.cls}>{mark.mark}</span>
      <span>
        {pack.provider.detail}
        {pack.provider.olderCommits.map((older) => (
          <small class="muted" style="display:block">
            Older commit <span class="mono">{older.commitSha}</span>, not this one:{' '}
            {older.facts
              .map((fact) => `${providerName(fact.provider)} ${fact.subjectId} ${fact.state}, observed ${fact.observedAt}`)
              .join('; ')}
          </small>
        ))}
        {pack.provider.connections.map((connection) => (
          <small class="muted" style="display:block">
            {providerName(connection.provider)} · {connection.fullName}
            {connection.lastCheck
              ? ` · last check ${connection.lastCheck.ok ? 'passed' : 'failed'}${connection.lastCheck.at ? ` at ${connection.lastCheck.at}` : ''}`
              : ' · never checked from STMA'}
          </small>
        ))}
      </span>
    </div>
  );
};

/** Which run, which repository and which commit the rest of the page is about. */
export const ReviewIdentity = ({ pack }: { pack: EvidencePack }) => (
  <div style="display:flex;flex-direction:column;gap:4px" class="small">
    <span>
      Run <span class="mono">{pack.run.id}</span>
    </span>
    <span>
      Project repository:{' '}
      {pack.repository.project ? <span class="mono">{pack.repository.project}</span> : 'none bound to this project'}
    </span>
    {pack.checkpoint ? (
      <>
        <span>
          Checkpoint <span class="mono">{pack.checkpoint.id}</span> ({pack.checkpoint.kind})
        </span>
        <span>
          Commit <span class="mono">{pack.checkpoint.commitSha}</span> in{' '}
          <span class="mono">{pack.checkpoint.repositoryIdentity}</span>
          {pack.repository.matches ? ' · the project’s repository' : ' · not the project’s repository'}
        </span>
      </>
    ) : (
      <span class="muted">No delivery or tested checkpoint names a commit.</span>
    )}
  </div>
);

/** Where this run's checkpoints went, and how far each receiver got. */
export const Handovers = ({ pack }: { pack: EvidencePack }) =>
  pack.handovers.length === 0 ? (
    <p class="small muted m0">This run's checkpoints were not handed over to anybody.</p>
  ) : (
    <>
      {pack.handovers.map((row) => (
        <p class="small m0">
          <a href={`/app/sessions/${row.sessionId}`}>{row.title}</a>
          <span class="muted">
            {' '}
            · {row.kind} of {row.checkpointKind} checkpoint at <span class="mono">{row.commitSha}</span> ·{' '}
            {row.state.replace('_', ' ')}
          </span>
          <small class="muted" style="display:block">
            Receiver:{' '}
            {row.receiver ?? (row.addressedTo ? `addressed to ${row.addressedTo}, not accepted yet` : 'nobody has accepted it')}{' '}
            · offered {row.createdAt} · accepted {row.acceptedAt ?? 'not recorded'} · resumed{' '}
            {row.resumedAt ?? 'not recorded'} · completed {row.completedAt ?? 'not recorded'}
          </small>
        </p>
      ))}
      <p class="small muted m0">{pack.handovers[0]!.resumeRule}</p>
    </>
  );

/** The policy and Knowledge receipts in full, with what a receipt is not. */
export const PolicyKnowledge = ({ pack }: { pack: EvidencePack }) => (
  <div style="display:flex;flex-direction:column;gap:6px" class="small">
    {pack.policy ? (
      <span>
        Policy served <span class="mono">{pack.policy.expectedHash}</span> at {pack.policy.servedAt}; the agent
        reported {pack.policy.reportedHash ? <span class="mono">{pack.policy.reportedHash}</span> : 'nothing'}
        {pack.policy.drift ? ' (a different hash)' : ''}. The policy versions merged into it are not stored
        per receipt.
      </span>
    ) : (
      <span class="muted">No policy receipt: this run was never served a policy hash.</span>
    )}
    {pack.knowledge ? (
      <span>
        Knowledge context <span class="mono">{pack.knowledge.contextId}</span>: manifest{' '}
        <span class="mono">{pack.knowledge.manifestHash ?? 'none'}</span> served at {pack.knowledge.servedAt}; the
        agent reported{' '}
        {pack.knowledge.reportedManifestHash ? <span class="mono">{pack.knowledge.reportedManifestHash}</span> : 'nothing'}.
        {pack.knowledge.versionIds.length > 0 ? (
          <small class="muted" style="display:block">
            Versions served:{' '}
            {pack.knowledge.versionIds.map((id) => (
              <span class="mono">{id} </span>
            ))}
            {pack.knowledge.versionCount > pack.knowledge.versionIds.length
              ? `and ${pack.knowledge.versionCount - pack.knowledge.versionIds.length} more`
              : ''}
          </small>
        ) : null}
      </span>
    ) : (
      <span class="muted">No Knowledge context was linked to this run.</span>
    )}
    <span class="muted">{RECEIPT_IS_NOT_APPROVAL}</span>
  </div>
);

/**
 * What a provider said about the delivered commit, each fact at that exact
 * commit, followed by why the line reads as it does (`ProviderStatus`).
 */
export const ProviderFacts = ({ pack }: { pack: EvidencePack }) => (
  <>
    {pack.providerFacts.map((row) => (
      <div class="check">
        <span class={['failure', 'closed'].includes(row.fact.state) ? 'n' : ['success', 'merged'].includes(row.fact.state) ? 'y' : 'w'}>
          {['failure', 'closed'].includes(row.fact.state) ? '!' : ['success', 'merged'].includes(row.fact.state) ? '✓' : '?'}
        </span>
        <span>
          {providerName(row.provider)} {row.fact.kind === 'pull_request' ? 'pull request' : 'workflow'}{' '}
          <span class="mono">{row.fact.subjectId}</span>: {row.fact.state} at this exact commit
          <small class="muted" style="display:block">
            observed by {providerName(row.provider)} at {row.fact.observedAt.toISOString()} · {row.fullName} ·
            attempt {row.fact.attempt}
          </small>
        </span>
      </div>
    ))}
    <ProviderStatus pack={pack} />
  </>
);
