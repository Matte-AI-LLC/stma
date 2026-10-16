import type { evidenceForRun, EvidenceCheck, EvidenceState } from './evidence';

/**
 * The evidence pack in words a reviewer can read and paste.
 *
 * The review offer starts with a sourced summary written for one real decision:
 * which agent did what, which commit the checks ran on, and what is still
 * missing. `evidenceForRun` already assembles every fact; this names where each
 * one came from — reported by the agent, observed by STMA, observed by the
 * provider — because a summary that drops the source turns an agent's claim
 * into a finding. It posts nothing anywhere: a person copies it, and nothing
 * here decides whether a change may merge.
 *
 * Read by console pages only (the run page and the map's inspector), which is
 * why it sits outside the agent-facing surface in `acceptance/tiers.json`.
 */

export type EvidencePack = Exclude<Awaited<ReturnType<typeof evidenceForRun>>, { error: string }>;

const PROVIDER_NAMES: Record<string, string> = {
  github: 'GitHub',
  'azure-devops': 'Azure DevOps',
};

export const providerName = (provider: string | null | undefined): string =>
  (provider && PROVIDER_NAMES[provider]) ?? 'the provider';

/** Where a line came from, in the words a reviewer uses. */
export function sourceWords(source: EvidenceCheck['source'], provider?: string | null): string {
  switch (source) {
    case 'client_report':
      return 'reported by the agent';
    case 'stma_observation':
      return 'observed by STMA';
    case 'provider_observation':
      return `observed by ${providerName(provider)}`;
    case 'human_approval':
      return 'decided by a person';
    default:
      return 'source not recorded';
  }
}

export const CHECK_NAMES: Record<string, string> = {
  policy: 'Policy',
  environment: 'Environment',
  collisions: 'Collisions',
  scope: 'Scope',
  checkpoint: 'Delivered commit',
  knowledge: 'Knowledge',
  outcome: 'Outcome',
};

export const STATE_WORDS: Record<EvidenceState, string> = {
  ok: 'ok',
  attention: 'needs attention',
  unknown: 'unconfirmed',
};

/** The provider of the outcome line, when a provider said anything at all. */
export function outcomeProvider(pack: EvidencePack): string | null {
  return pack.providerFacts[0]?.provider ?? null;
}

/**
 * Whose word one check is, as a reviewer reads it. A check nobody answered
 * keeps the source it would have had (`get_evidence` pins that), but "reported
 * by the agent" beside "this run never reported a policy hash" says the
 * opposite of the line, so a missing answer reads as not reported. The
 * checkpoint line is a report whenever a checkpoint exists, even one that is
 * unconfirmed for want of a passing test; the outcome line's source already
 * says whose status it is.
 */
export function checkSourceWords(check: EvidenceCheck, pack: EvidencePack): string {
  if (check.key === 'outcome') {
    return sourceWords(check.source, check.source === 'provider_observation' ? outcomeProvider(pack) : null);
  }
  if (check.key === 'checkpoint' && pack.checkpoint) return 'reported by the agent';
  if (check.coverage === 'missing') {
    return check.source === 'client_report'
      ? 'not reported by the agent'
      : check.source === 'stma_observation'
        ? 'not observed by STMA'
        : 'not observed';
  }
  return sourceWords(check.source);
}

const TEST_STATE: Record<string, string> = { passed: 'passed', failed: 'failed', not_run: 'not run' };

/** One line of text somebody else wrote, made safe to sit inside Markdown. */
function line(value: string | null | undefined, max = 300): string {
  const flat = (value ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** An identifier (branch, test name, repository) as inline code. */
function code(value: string | null | undefined): string {
  const flat = line(value, 200).replace(/`/g, "'");
  return flat ? `\`${flat}\`` : 'none';
}

export function reportedTests(pack: EvidencePack): string[] {
  return (pack.checkpoint?.tests ?? []).map(
    (test) =>
      `${test.name} ${TEST_STATE[test.state] ?? test.state}${test.detail ? ` (${line(test.detail, 120)})` : ''}`,
  );
}

/**
 * The pack as Markdown. Every section says who the statement is from, a
 * missing fact is named rather than left out, and the last line repeats the
 * pack's own verdict: evidence, not permission.
 */
export function evidenceMarkdown(pack: EvidencePack, options: { url?: string } = {}): string {
  const run = pack.run;
  const title = line(run.task ?? run.intent, 160) || 'untitled run';
  const out: string[] = [];
  out.push(`## STMA evidence: ${title}`);
  out.push('');
  out.push(
    `${line(pack.who.agent)} (${line(pack.who.client ?? 'agent')}) for ${line(pack.who.owner)} · ` +
      `workspace ${code(pack.who.team)}${pack.who.project ? ` · project ${code(pack.who.project)}` : ''}` +
      `${run.branch ? ` · branch ${code(run.branch)}` : ''} · status ${run.status}`,
  );
  out.push(`Started ${run.startedAt}${run.endedAt ? `, ended ${run.endedAt}` : ', still running'}.`);
  out.push('');

  out.push('### Delivered commit');
  if (pack.checkpoint) {
    const cp = pack.checkpoint;
    out.push(`- Repository: ${code(cp.repositoryIdentity)}${cp.repositoryMatchesProject ? '' : ' (not the project’s repository)'}`);
    out.push(
      `- Commit: ${code(cp.commitSha)} (${cp.kind} checkpoint, ${cp.worktreeClean ? 'clean worktree' : 'dirty worktree'}), reported by the agent at ${cp.reportedAt}`,
    );
    const tests = reportedTests(pack);
    out.push(
      tests.length === 0
        ? '- Tests: none reported with this checkpoint'
        : `- Tests reported by the agent: ${tests.join('; ')}`,
    );
  } else {
    out.push('- No delivery or tested checkpoint was reported, so no exact commit identifies this delivery.');
  }
  if (pack.providerFacts.length > 0) {
    for (const row of pack.providerFacts) {
      out.push(
        `- ${providerName(row.provider)} ${row.fact.kind === 'pull_request' ? 'pull request' : 'workflow'} ${code(row.fact.subjectId)}: ${row.fact.state} at this exact commit, observed ${row.fact.observedAt.toISOString()}`,
      );
    }
  } else if (pack.checkpoint) {
    out.push('- No provider observation of this exact commit.');
  }
  out.push('');

  out.push('### Checks');
  for (const check of pack.checks) {
    out.push(
      `- **${CHECK_NAMES[check.key] ?? check.key}** (${STATE_WORDS[check.state]}, ${checkSourceWords(check, pack)}): ${line(check.detail, 600)}`,
    );
  }
  out.push('');

  const attention = pack.checks.filter((check) => check.state === 'attention');
  const unconfirmed = pack.checks.filter((check) => check.state === 'unknown');
  out.push('### Still open');
  if (attention.length === 0 && unconfirmed.length === 0) {
    out.push('- Nothing recorded as failing or unconfirmed in these checks. Missing evidence is not approval.');
  } else {
    if (attention.length > 0)
      out.push(`- Needs attention: ${attention.map((check) => CHECK_NAMES[check.key] ?? check.key).join(', ')}`);
    if (unconfirmed.length > 0)
      out.push(`- Unconfirmed: ${unconfirmed.map((check) => CHECK_NAMES[check.key] ?? check.key).join(', ')}. Unconfirmed is not the same as fine.`);
  }
  out.push('');
  out.push(`_${pack.verdict} Generated by STMA at ${pack.generatedAt}.${options.url ? ` ${options.url}` : ''}_`);
  return `${out.join('\n')}\n`;
}
