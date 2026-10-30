import { redactSecrets } from '../lib/redact';
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

/** One line of plain text somebody else wrote: secrets redacted, whitespace flattened, bounded. */
export function line(value: string | null | undefined, max = 300): string {
  const flat = redactSecrets(value ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The Markdown characters that can start a link, an image, inline HTML, an
 * entity, emphasis, a code span, a table cell, a heading, math or a mention.
 * Hyphens, dots and commas stay as typed: a value here never begins a line,
 * so they cannot form a list or a heading, and escaping them would put a
 * backslash in every task key (`PD\-27`) for nothing.
 */
const MARKDOWN_ACTIVE = /[\\`*_[\]()<>#!|~@&:$]/g;
const ZERO_WIDTH_SPACE = '​';

/**
 * Text somebody else wrote, made inert inside Markdown.
 *
 * A pasted evidence pack lands in a pull request comment, where a task title
 * of `[ok](javascript:...)`, an `<img>`, a heading, a table pipe or an
 * `@org/team` mention would act in the reviewer's tool rather than read as
 * text. CommonMark allows a backslash before any ASCII punctuation, so every
 * active character is escaped and the prose stays readable. GitHub links
 * mentions, issue references and bare addresses after rendering, where the
 * backslash is already gone, so a zero-width space also follows each `@` and
 * `#`, each `://` and each `www.`. Secrets are redacted first, because a test
 * name or an intent is free text the server never scrubbed at write.
 */
export function mdText(value: string | null | undefined, max = 300): string {
  return line(value, max)
    .replace(MARKDOWN_ACTIVE, (char) =>
      char === '@' || char === '#' ? `\\${char}${ZERO_WIDTH_SPACE}` : `\\${char}`,
    )
    .replace(/\\:\/\//g, `\\:${ZERO_WIDTH_SPACE}//`)
    .replace(/\b(www)\./gi, `$1${ZERO_WIDTH_SPACE}.`);
}

/** An identifier (branch, test name, repository, id) as inline code, redacted. */
export function code(value: string | null | undefined): string {
  const flat = line(value, 200).replace(/`/g, "'");
  return flat ? `\`${flat}\`` : 'none';
}

/**
 * The tests a checkpoint carries, one string each. Plain for a page (JSX
 * escapes HTML itself), or with `mdText` for Markdown.
 */
export function reportedTests(
  pack: EvidencePack,
  text: (value: string | null | undefined, max?: number) => string = line,
): string[] {
  return (pack.checkpoint?.tests ?? []).map(
    (test) =>
      `${text(test.name, 120)} ${TEST_STATE[test.state] ?? test.state}${test.detail ? ` (${text(test.detail, 120)})` : ''}`,
  );
}

/** How many reported tests passed, failed and were not run. */
export function testCounts(pack: EvidencePack) {
  const tests = pack.checkpoint?.tests ?? [];
  return {
    total: tests.length,
    passed: tests.filter((test) => test.state === 'passed').length,
    failed: tests.filter((test) => test.state === 'failed').length,
    notRun: tests.filter((test) => test.state === 'not_run').length,
  };
}

/** The one sentence that goes with a run link handed to anybody. */
export const membersOnly = (workspace: string) =>
  `Only members of the ${workspace} workspace can open this run's link. Paste the text for a reviewer outside it.`;

/** What a receipt is, said wherever one is shown. */
export const RECEIPT_IS_NOT_APPROVAL =
  'A receipt records what was served and what the agent reported. It is not compliance, approval or proof the text was followed.';

const checkLine = (check: EvidenceCheck, pack: EvidencePack) =>
  `- **${CHECK_NAMES[check.key] ?? check.key}** (${STATE_WORDS[check.state]}, ${checkSourceWords(check, pack)}): ${mdText(check.detail, 600)}`;

const at = (value: string | null | undefined) => value ?? 'not recorded';

/**
 * The pack as Markdown, in sections named by whose word each one is.
 *
 * Identity first, so a reviewer knows which run, repository and commit the
 * rest is about; then what the agent reported, what STMA observed and what a
 * provider observed, never mixed; then the handover, the policy and Knowledge
 * receipts, and what is still open. A missing fact is named rather than left
 * out, and the last lines repeat the pack's verdict and say who can open the
 * link. Every value somebody else wrote goes through `mdText` or `code`; the
 * only URL left live is STMA's own run page.
 */
export function evidenceMarkdown(pack: EvidencePack, options: { url?: string } = {}): string {
  const run = pack.run;
  const title = mdText(run.task ?? run.intent, 160) || 'untitled run';
  const out: string[] = [];
  out.push(`## STMA evidence: ${title}`);
  out.push('');

  out.push('### Identity');
  out.push(`- Workspace ${code(pack.who.team)}${pack.who.project ? `, project ${code(pack.who.project)}` : ''}`);
  out.push(
    `- Project repository: ${pack.repository.project ? code(pack.repository.project) : 'none bound to this project'}`,
  );
  out.push(`- Run ${code(run.id)}, status ${run.status}, started ${run.startedAt}${run.endedAt ? `, ended ${run.endedAt}` : ', still running'}`);
  out.push(
    `- Agent ${mdText(pack.who.agent, 120)} (${mdText(pack.who.client ?? 'agent', 60)}) for ${mdText(pack.who.owner, 80)}${run.branch ? `, branch ${code(run.branch)}` : ''}`,
  );
  out.push('');

  out.push('### Delivered commit');
  if (pack.checkpoint) {
    const cp = pack.checkpoint;
    out.push(`- Checkpoint ${code(cp.id)} (${cp.kind}, ${cp.worktreeClean ? 'clean worktree' : 'dirty worktree'}), reported by the agent at ${cp.reportedAt}`);
    out.push(
      `- Repository: ${code(cp.repositoryIdentity)}${cp.repositoryMatchesProject ? ' (the project’s repository)' : ' (not the project’s repository)'}`,
    );
    out.push(`- Commit: ${code(cp.commitSha)}`);
  } else {
    out.push('- No delivery or tested checkpoint was reported, so no exact commit identifies this delivery.');
  }
  out.push('');

  const bySource = (source: EvidenceCheck['source']) =>
    pack.checks.filter((check) => check.source === source);

  out.push('### Reported by the agent');
  if (pack.checkpoint) {
    const tests = reportedTests(pack, mdText);
    out.push(
      tests.length === 0
        ? `- Tests: none reported with this checkpoint (at ${pack.checkpoint.reportedAt})`
        : `- Tests reported by the agent: ${tests.join('; ')} (at ${pack.checkpoint.reportedAt})`,
    );
  }
  for (const check of bySource('client_report')) out.push(checkLine(check, pack));
  out.push('');

  out.push('### Observed by STMA');
  const stma = bySource('stma_observation');
  if (stma.length === 0) out.push('- Nothing in this pack is STMA’s own observation.');
  for (const check of stma) out.push(checkLine(check, pack));
  out.push('');

  out.push('### Observed by the provider');
  if (pack.providerFacts.length > 0) {
    for (const row of pack.providerFacts) {
      out.push(
        `- ${providerName(row.provider)} ${row.fact.kind === 'pull_request' ? 'pull request' : 'workflow'} ${code(row.fact.subjectId)}: ${row.fact.state} at this exact commit, observed ${row.fact.observedAt.toISOString()}`,
      );
    }
  }
  out.push(`- ${mdText(pack.provider.detail, 600)}`);
  for (const older of pack.provider.olderCommits) {
    out.push(
      `- Older commit ${code(older.commitSha)}, not this one: ${older.facts
        .map((fact) => `${providerName(fact.provider)} ${code(fact.subjectId)} ${fact.state}, observed ${fact.observedAt}`)
        .join('; ')}`,
    );
  }
  for (const check of bySource('provider_observation')) out.push(checkLine(check, pack));
  out.push('');

  out.push('### Handover');
  if (pack.handovers.length === 0) {
    out.push('- This run’s checkpoints were not handed over to anybody.');
  } else {
    for (const row of pack.handovers) {
      out.push(
        `- ${row.kind === 'assignment' ? 'Assignment' : 'Handoff'} “${mdText(row.title, 160)}” of ${row.checkpointKind} checkpoint ${code(row.checkpointId)} at ${code(row.commitSha)}, ${row.state.replace('_', ' ')}. ` +
          `Receiver: ${row.receiver ? mdText(row.receiver, 120) : row.addressedTo ? `addressed to ${mdText(row.addressedTo, 120)}, not accepted yet` : 'nobody has accepted it'}. ` +
          `Offered ${row.createdAt}; accepted ${at(row.acceptedAt)}; resumed ${at(row.resumedAt)}; completed ${at(row.completedAt)}.`,
      );
    }
    out.push(`- ${pack.handovers[0]!.resumeRule}`);
  }
  out.push('');

  out.push('### Policy and Knowledge');
  if (pack.policy) {
    out.push(
      `- Policy served ${code(pack.policy.expectedHash)} at ${pack.policy.servedAt}; the agent reported ${pack.policy.reportedHash ? code(pack.policy.reportedHash) : 'nothing'}${pack.policy.drift ? ' (a different hash)' : ''}. The policy versions merged into it are not stored per receipt.`,
    );
  } else {
    out.push('- No policy receipt: this run was never served a policy hash.');
  }
  if (pack.knowledge) {
    const k = pack.knowledge;
    out.push(
      `- Knowledge context ${code(k.contextId)}: manifest ${k.manifestHash ? code(k.manifestHash) : 'none'} served at ${k.servedAt}; the agent reported ${k.reportedManifestHash ? code(k.reportedManifestHash) : 'nothing'}${k.clientReportedAt ? ` at ${k.clientReportedAt}` : ''}.`,
    );
    out.push(
      k.versionIds.length === 0
        ? '- Knowledge versions served: none named in the manifest.'
        : `- Knowledge versions served: ${k.versionIds.map((id) => code(id)).join(', ')}${k.versionCount > k.versionIds.length ? `, and ${k.versionCount - k.versionIds.length} more` : ''}${k.stale ? '. At least one is no longer current.' : ''}`,
    );
  } else {
    out.push('- No Knowledge context was linked to this run.');
  }
  out.push(`- ${RECEIPT_IS_NOT_APPROVAL}`);
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
  out.push(`_${pack.verdict} Generated by STMA at ${pack.generatedAt}._`);
  out.push('');
  if (options.url) out.push(`Run page: ${options.url}`);
  out.push(membersOnly(code(pack.who.team)));
  return `${out.join('\n')}\n`;
}

/**
 * The short version for a pull request description or comment: which commit,
 * what the agent said about its tests, what a provider said, what is open,
 * and the link with who can open it. At most twelve lines, so it is pasted
 * whole rather than trimmed by hand.
 */
export function evidencePullRequestBlock(pack: EvidencePack, options: { url?: string } = {}): string {
  const run = pack.run;
  const out: string[] = [];
  out.push(`**STMA evidence**: ${mdText(run.task ?? run.intent, 120) || 'untitled run'} (run ${code(run.id)})`);
  if (pack.checkpoint) {
    const cp = pack.checkpoint;
    out.push(
      `- Commit ${code(`${cp.repositoryIdentity}@${cp.commitSha}`)}, ${cp.kind} checkpoint, ${cp.worktreeClean ? 'clean worktree' : 'dirty worktree'}, reported by the agent${cp.repositoryMatchesProject ? '' : '; not the project’s repository'}`,
    );
    const counts = testCounts(pack);
    out.push(
      counts.total === 0
        ? '- Tests: none reported by the agent'
        : `- Tests reported by the agent: ${counts.passed} passed, ${counts.failed} failed, ${counts.notRun} not run`,
    );
  } else {
    out.push('- No delivery or tested checkpoint, so no exact commit identifies this delivery');
  }
  out.push(
    pack.providerFacts.length > 0
      ? `- Provider at this exact commit: ${pack.providerFacts
          .slice(0, 3)
          .map((row) => `${providerName(row.provider)} ${code(row.fact.subjectId)} ${row.fact.state}`)
          .join('; ')}${pack.providerFacts.length > 3 ? `; ${pack.providerFacts.length - 3} more` : ''}`
      : `- Provider: ${mdText(pack.provider.detail, 300)}`,
  );
  const names = (keys: readonly string[]) => keys.map((key) => CHECK_NAMES[key] ?? key).join(', ');
  if (pack.blocking.length > 0) out.push(`- Needs attention: ${names(pack.blocking)}`);
  if (pack.unconfirmed.length > 0) out.push(`- Unconfirmed: ${names(pack.unconfirmed)}. Unconfirmed is not the same as fine.`);
  out.push(`- ${pack.verdict}`);
  if (options.url) out.push(`- Run page: ${options.url}`);
  out.push(`- ${membersOnly(code(pack.who.team))}`);
  return `${out.join('\n')}\n`;
}
