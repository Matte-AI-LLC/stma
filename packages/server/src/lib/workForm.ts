import {
  WORK_BLOCKER_KINDS,
  WORK_LIMITS,
  type WorkCriterionInput,
  type WorkEvidenceKind,
  type WorkScope,
} from '@bridge/shared';

/**
 * The Work console's forms, read into the payloads the domain functions take.
 *
 * Nothing here decides anything: a posted form is turned into the same wire
 * shape an agent would send, and the one write path (`domain/work.ts`) judges
 * it. What lives here is the part that is peculiar to a browser form: a
 * checkbox that is absent when it is off, a textarea whose line breaks arrive
 * as CRLF, a row of criteria that the form numbers from zero and the wire
 * numbers after the empty rows have gone, and a rule too rich for the form's
 * four choices that must survive an edit untouched.
 */

/** A form the person got wrong before the domain was even asked. */
export class FormError extends Error {
  constructor(
    message: string,
    readonly fields: string[] = [],
  ) {
    super(message);
  }
}

/** One posted form. Values are strings; a textarea's CRLF becomes LF so a round trip changes nothing. */
export class Form {
  private readonly values = new Map<string, string[]>();

  constructor(body: Record<string, unknown>) {
    for (const [name, value] of Object.entries(body)) {
      const list = (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string');
      this.values.set(
        name,
        list.map((v) => v.replace(/\r\n?/g, '\n')),
      );
    }
  }

  has(name: string): boolean {
    return this.values.has(name);
  }
  /** The last value posted under the name, as sent. */
  get(name: string): string {
    const list = this.values.get(name);
    return list && list.length ? list[list.length - 1]! : '';
  }
  text(name: string): string {
    return this.get(name).trim();
  }
  all(name: string): string[] {
    return this.values.get(name) ?? [];
  }
  checked(name: string): boolean {
    return this.get(name) === 'on';
  }
  /** Every single value posted, for putting a refused form back as it was typed. */
  typed(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, list] of this.values) if (list.length) out[name] = list[list.length - 1]!;
    return out;
  }
}

/** One value per line, trimmed, empties and repeats dropped. */
export function lines(value: string): string[] {
  return [...new Set(value.split('\n').map((line) => line.trim()).filter(Boolean))];
}

/** Comma separated labels. A label may not contain a comma, so the split loses nothing. */
export function labels(value: string): string[] {
  return [...new Set(value.split(',').map((label) => label.trim()).filter(Boolean))];
}

/** `2026-11-03` from a date input to the instant the wire carries, or null for none. */
export function dueAt(value: string): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new FormError('The due date is not a date.', ['due']);
  }
  return `${value}T00:00:00.000Z`;
}

// ---------------------------------------------------------------------------
// Criteria rows.
// ---------------------------------------------------------------------------

/** Rows the New work form offers. Editing offers every existing criterion and two empty rows. */
export const NEW_CRITERIA_ROWS = 8;
export const EDIT_SPARE_ROWS = 2;
/** The most rows a post is scanned for: the schema's own ceiling plus the spare rows. */
const SCAN_ROWS = WORK_LIMITS.criteria + EDIT_SPARE_ROWS;

/** The four things a criterion can ask for, as the form words them. */
export const CRITERION_KINDS = [
  { value: 'agent_report', label: 'Agent report' },
  { value: 'artifact', label: 'Artifact of the delivery' },
  { value: 'human_check', label: 'Human check at the decision' },
  { value: 'provider_observation', label: 'Provider check (a workflow or pipeline)' },
] as const;

export const PROVIDERS = [
  { value: 'github', label: 'GitHub' },
  { value: 'azure-devops', label: 'Azure DevOps' },
] as const;

export interface CriterionRow {
  id: string;
  text: string;
  required: boolean;
  /** One of the four kinds, or `keep` for a rule the form cannot show. */
  kind: string;
  provider: string;
  subject: string;
  /** For `keep`: the stored evidence kinds and rule, carried through the form unchanged. */
  keep: string;
}

interface StoredCriterion {
  id: string;
  text: string;
  required: boolean;
  evidence_kinds: readonly string[];
  verification_rule: unknown;
}

/**
 * A stored criterion as a form row. A rule the four choices can say exactly (one
 * selector, all of one, no age limit, no narrowing) becomes that choice; anything
 * richer is carried as `keep`, so opening a work item to change its title does
 * not flatten a rule somebody wrote with `any`, a time limit or two selectors.
 */
export function rowFromCriterion(criterion: StoredCriterion): CriterionRow {
  const base = { id: criterion.id, text: criterion.text, required: criterion.required, provider: '', subject: '' };
  const rule = criterion.verification_rule as {
    mode?: string;
    max_age_seconds?: number;
    selectors?: { source: string; provider?: string; subject?: string; artifact_kind?: string }[];
  } | null;
  const keep = JSON.stringify({ evidence_kinds: criterion.evidence_kinds, verification_rule: criterion.verification_rule });
  const single = rule?.selectors?.length === 1 ? rule.selectors[0]! : null;
  const plain =
    single !== null &&
    (rule?.mode ?? 'all') === 'all' &&
    rule?.max_age_seconds === undefined &&
    criterion.evidence_kinds.length === 1 &&
    criterion.evidence_kinds[0] === single.source &&
    single.artifact_kind === undefined;
  if (plain && single.source !== 'provider_observation') return { ...base, kind: single.source, keep: '' };
  if (plain && single.source === 'provider_observation') {
    return { ...base, kind: single.source, provider: single.provider ?? 'github', subject: single.subject ?? '', keep: '' };
  }
  return { ...base, kind: 'keep', keep };
}

/** A blank row for the form, in the order it is posted. */
export const blankRow = (): CriterionRow => ({
  id: '',
  text: '',
  required: true,
  kind: 'agent_report',
  provider: 'github',
  subject: '',
  keep: '',
});

const field = (index: number, name: string) => `c${index}_${name}`;

/** The name a row's control carries in the posted form. */
export const rowField = field;

/**
 * Read the posted rows into wire criteria. A row with no text and no id is an
 * empty row and is skipped; `wireToRow` remembers which form row each wire
 * criterion came from, so a refusal that names `criteria[1]` can say "criterion
 * row 3" instead of a position the person never saw.
 */
export function parseCriteriaRows(form: Form): { criteria: WorkCriterionInput[]; wireToRow: number[] } {
  const criteria: WorkCriterionInput[] = [];
  const wireToRow: number[] = [];
  for (let index = 0; index < SCAN_ROWS; index++) {
    const text = form.text(field(index, 'text'));
    const id = form.text(field(index, 'id'));
    if (!text && !id) continue;
    if (form.checked(field(index, 'remove'))) continue;
    const kind = form.text(field(index, 'kind')) || 'agent_report';
    const criterion: Record<string, unknown> = {
      ...(id ? { id } : {}),
      text,
      required: form.checked(field(index, 'required')),
    };
    if (kind === 'keep') {
      let kept: { evidence_kinds?: WorkEvidenceKind[]; verification_rule?: unknown };
      try {
        kept = JSON.parse(form.get(field(index, 'keep')));
      } catch {
        throw new FormError(`Criterion row ${index + 1}: the rule that was kept is unreadable. Reload the page.`);
      }
      criterion.evidence_kinds = kept.evidence_kinds;
      criterion.verification_rule = kept.verification_rule;
    } else if (kind === 'provider_observation') {
      criterion.evidence_kinds = ['provider_observation'];
      criterion.verification_rule = {
        mode: 'all',
        selectors: [
          {
            source: 'provider_observation',
            provider: form.text(field(index, 'provider')) || 'github',
            subject: form.text(field(index, 'subject')),
          },
        ],
      };
    } else {
      criterion.evidence_kinds = [kind];
    }
    criteria.push(criterion as unknown as WorkCriterionInput);
    wireToRow.push(index);
  }
  return { criteria, wireToRow };
}

/** `criteria[2]` on the wire is the third row that had anything in it; say which row of the form. */
export function nameRows(text: string, wireToRow: readonly number[]): string {
  return text.replace(/(?:payload\.)?criteria\[(\d+)\]/g, (_, wire: string) => {
    const row = wireToRow[Number(wire)];
    return row === undefined ? 'a criterion' : `criterion row ${row + 1}`;
  });
}

// ---------------------------------------------------------------------------
// The contract and the people, as the domain takes them.
// ---------------------------------------------------------------------------

/** The contract fields the form owns. Context references are not in it, so a patch leaves them alone. */
function contractFields(form: Form, currentScope?: WorkScope) {
  const paths = lines(form.get('scope_paths'));
  // The form edits one list of the scope. Components and contracts, which an
  // agent or the API may have written, are carried over rather than erased.
  const scope: WorkScope = { ...(currentScope ?? {}), ...(paths.length ? { paths } : {}) };
  if (!paths.length) delete scope.paths;
  return {
    title: form.text('title'),
    goal: form.get('goal'),
    non_goals: form.get('non_goals'),
    scope,
    risk_tier: form.text('risk_tier') || 'medium',
    artifact_kind: form.text('artifact_kind') || null,
    acceptance_policy: { require_independent_acceptor: form.checked('independent') },
  };
}

export function createInput(form: Form, project: string): { input: Record<string, unknown>; wireToRow: number[] } {
  const { criteria, wireToRow } = parseCriteriaRows(form);
  const due = dueAt(form.text('due'));
  const owner = form.text('owner');
  const acceptor = form.text('acceptor');
  // Filed from a GitHub issue: an empty title or goal means "take the issue's",
  // so it is left out rather than sent as an empty string.
  const issue = form.text('external_issue');
  const { title, goal, ...contract } = contractFields(form);
  return {
    wireToRow,
    input: {
      request_id: form.text('request_id'),
      project,
      contract: {
        ...contract,
        ...(title || !issue ? { title } : {}),
        ...(goal.trim() || !issue ? { goal } : {}),
      },
      ...(issue ? { external: { provider: 'github', issue, mode: form.text('external_mode') || 'reference' } } : {}),
      criteria,
      coordination: {
        priority: form.text('priority') || 'normal',
        ...(due ? { due_at: due } : {}),
        labels: labels(form.get('labels')),
      },
      // Left out, the owner is the person filing it; an acceptor named later is allowed.
      ...(owner ? { owner } : {}),
      ...(acceptor ? { acceptor } : {}),
    },
  };
}

/** The operations the console posts through `/command`; `assign` is built by the route (it names an agent). */
export const CONSOLE_OPERATIONS = [
  'patch',
  'transition',
  'reopen',
  'archive',
  'add_dependency',
  'remove_dependency',
  'set_blocker',
  'resolve_blocker',
  'assign',
  'reconcile_external',
] as const;

export function commandPayload(
  operation: string,
  form: Form,
  context: { currentScope?: WorkScope } = {},
): { payload: Record<string, unknown>; wireToRow: number[] } {
  const done = (payload: Record<string, unknown>, wireToRow: number[] = []) => ({ payload, wireToRow });
  const reason = form.get('reason').trim();
  switch (operation) {
    case 'patch': {
      const group = form.text('group');
      if (group === 'contract') {
        const { criteria, wireToRow } = parseCriteriaRows(form);
        const change = form.get('change_reason').trim();
        const reopen = form.get('reopen_reason').trim();
        return done(
          {
            contract: contractFields(form, context.currentScope),
            criteria,
            ...(change ? { change_reason: change } : {}),
            ...(reopen ? { reopen_reason: reopen } : {}),
          },
          wireToRow,
        );
      }
      if (group === 'people') {
        const owner = form.text('owner');
        const acceptor = form.text('acceptor');
        return done({ owner: owner || null, acceptor: acceptor || null });
      }
      if (group === 'coordination') {
        // A date field shows only the day. When it still shows the day the page
        // drew, the due date is left out of the patch rather than rewritten as
        // midnight: an agent or the API may have set a time of day, and saving
        // the priority must not move it.
        const typed = form.text('due');
        const unchanged = form.has('due_shown') && typed === form.text('due_shown');
        return done({
          coordination: {
            priority: form.text('priority') || 'normal',
            ...(unchanged ? {} : { due_at: dueAt(typed) }),
            labels: labels(form.get('labels')),
          },
        });
      }
      throw new FormError('That form does not say what it changes. Reload the page.');
    }
    case 'transition':
      return done({ to: form.text('to'), ...(reason ? { reason } : {}) });
    case 'reopen':
      return done({ reason });
    case 'archive':
      return done(reason ? { reason } : {});
    case 'add_dependency': {
      const revision = form.text('required_spec_revision');
      return done({
        depends_on: form.text('depends_on'),
        ...(revision ? { required_spec_revision: Number(revision) } : {}),
      });
    }
    case 'remove_dependency':
      return done({ depends_on: form.text('depends_on'), ...(reason ? { reason } : {}) });
    case 'set_blocker': {
      const owner = form.text('owner');
      return done({
        kind: form.text('kind'),
        reason,
        next_action: form.get('next_action').trim(),
        ...(owner ? { owner } : {}),
      });
    }
    case 'resolve_blocker':
      return done({ blocker_id: form.text('blocker_id'), reason });
    case 'reconcile_external': {
      const action = form.text('action');
      const ref = form.text('ref_id');
      switch (action) {
        case 'attach':
          return done({ action, provider: 'github', issue: form.text('issue'), mode: form.text('mode') || 'reference' });
        case 'refresh':
          return done({ action, ref_id: ref });
        case 'accept_remote':
          return done({ action, ref_id: ref, remote_revision: form.text('remote_revision'), ...(reason ? { reason } : {}) });
        case 'convert_to_reference':
        case 'detach':
          return done({ action, ref_id: ref, ...(reason ? { reason } : {}) });
        default:
          throw new FormError('That form does not say what it does to the tracker record. Reload the page.');
      }
    }
    default:
      throw new FormError('The console does not offer that operation.');
  }
}

/** The blocker kinds a person may record: STMA derives the last one itself. */
export const PERSON_BLOCKER_KINDS = WORK_BLOCKER_KINDS.filter((kind) => kind !== 'acceptor_unavailable');

/**
 * Read the decision form into the wire decision. A human check left at "Not
 * checked" is not sent, so the wire's `human_checks[k]` is not the form's block
 * k: `wireToCheck` remembers which block each one came from, for `nameChecks`.
 */
export function decisionInput(form: Form): { input: Record<string, unknown>; wireToCheck: number[] } {
  const humanChecks: Record<string, unknown>[] = [];
  const wireToCheck: number[] = [];
  for (let index = 0; index < WORK_LIMITS.criteria; index++) {
    const assertion = form.text(`h${index}_assertion`);
    if (!assertion) continue;
    humanChecks.push({
      criterion_id: form.text(`h${index}_criterion`),
      assertion,
      artifact_ref: form.text(`h${index}_artifact`),
      note: form.get(`h${index}_note`).trim(),
    });
    wireToCheck.push(index);
  }
  return {
    input: {
      request_id: form.text('request_id'),
      expected_version: form.text('expected_version'),
      spec_revision: Number(form.text('spec_revision')),
      delivery_id: form.text('delivery_id'),
      evidence_epoch: form.text('evidence_epoch'),
      evidence_manifest_hash: form.text('evidence_manifest_hash'),
      decision: form.text('decision'),
      reason: form.get('reason').trim(),
      criteria: form.all('criteria').map((id) => id.trim()).filter(Boolean),
      human_checks: humanChecks,
    },
    wireToCheck,
  };
}

/**
 * `human_checks[1]` on the wire is the second check that was recorded; say
 * which check of the form, in the numbering the form's own labels use
 * ("human check 3"), not a position the person never saw.
 */
export function nameChecks(text: string, wireToCheck: readonly number[]): string {
  return text.replace(/human_checks\[(\d+)\]/g, (_, wire: string) => {
    const block = wireToCheck[Number(wire)];
    return block === undefined ? 'a human check' : `human check ${block + 1}`;
  });
}
