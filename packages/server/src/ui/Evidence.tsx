import {
  CHECK_NAMES,
  STATE_WORDS,
  checkSourceWords,
  providerName,
  reportedTests,
  type EvidencePack,
} from '../domain/evidenceSummary';

/**
 * The evidence pack's checks, each with where it came from in words.
 *
 * The map's inspector printed the raw source (`client_report · reported · …`),
 * which is exact and reads like a log line to the person deciding. The words
 * are the ones the Markdown summary uses, so a reviewer who pastes the summary
 * and one who reads the page are told the same thing.
 */
export const EvidenceChecks = ({ pack }: { pack: EvidencePack }) => (
  <>
    {pack.checks.map((check) => (
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

/** The delivered commit and what each side said about it. */
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
      {pack.providerFacts.length === 0 ? (
        <div class="check">
          <span class="w">?</span>
          <span>
            No provider observation of this exact commit.
            <small class="muted" style="display:block">
              {checkpoint.repositoryMatchesProject
                ? 'Either no GitHub or Azure DevOps repository is connected and bound to this project, or none has reported on this commit yet. A branch or an older commit is never used instead.'
                : pack.providerCoverage}
            </small>
          </span>
        </div>
      ) : (
        pack.providerFacts.map((row) => (
          <div class="check">
            <span class={['failure', 'closed'].includes(row.fact.state) ? 'n' : ['success', 'merged'].includes(row.fact.state) ? 'y' : 'w'}>
              {['failure', 'closed'].includes(row.fact.state) ? '!' : ['success', 'merged'].includes(row.fact.state) ? '✓' : '?'}
            </span>
            <span>
              {providerName(row.provider)} {row.fact.kind === 'pull_request' ? 'pull request' : 'workflow'}{' '}
              <span class="mono">{row.fact.subjectId}</span>: {row.fact.state}
              <small class="muted" style="display:block">
                observed by {providerName(row.provider)} at {row.fact.observedAt.toISOString()} · {row.fullName} ·
                attempt {row.fact.attempt}
              </small>
            </span>
          </div>
        ))
      )}
    </div>
  );
};
