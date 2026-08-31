import { policyDocumentSchema, type PolicyDocument } from '@bridge/shared';

/**
 * Policy as a form rather than a JSON file on somebody's laptop.
 *
 * Publishing used to mean writing `.stma/policy.json` by hand and running the
 * CLI — which put the team's rulebook behind a tool only the person who set the
 * project up has installed. The document is a handful of string lists; a
 * textarea per list is a truer editor for it than a file, and the owner can see
 * what the agents will actually receive while editing it.
 *
 * One item per line, because that is how people write lists. Blank lines and
 * surrounding whitespace are dropped rather than becoming empty rules.
 */
export const linesToList = (raw: unknown): string[] =>
  String(raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

export const listToLines = (values: readonly string[]): string => values.join('\n');

/** Blank means "no budget", which is not the same as a budget of zero. */
export const toCount = (raw: unknown): number => {
  const value = Number(String(raw ?? '').trim());
  return Number.isInteger(value) && value > 0 ? value : 0;
};

/** `node=22.14.0`, one per line. A line without `=` is a runtime with no pin. */
export function linesToRuntimes(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of linesToList(raw)) {
    const eq = line.indexOf('=');
    const name = (eq === -1 ? line : line.slice(0, eq)).trim();
    const version = eq === -1 ? '' : line.slice(eq + 1).trim();
    if (name) out[name] = version;
  }
  return out;
}

export const runtimesToLines = (runtimes: Record<string, string>): string =>
  Object.entries(runtimes)
    .map(([name, version]) => (version ? `${name}=${version}` : name))
    .join('\n');

/** Form body → a validated policy document, or the reason it is not one. */
export function policyFromForm(
  form: Record<string, unknown>,
): { document: PolicyDocument } | { error: string } {
  const parsed = policyDocumentSchema.safeParse({
    guidance: linesToList(form.guidance),
    permissions: {
      deny: linesToList(form.deny),
      requireApproval: linesToList(form.requireApproval),
    },
    requiredChecks: linesToList(form.requiredChecks),
    protectedPaths: linesToList(form.protectedPaths),
    environment: {
      requiredEnvVarNames: linesToList(form.requiredEnvVarNames),
      runtimes: linesToRuntimes(form.runtimes),
    },
    autonomy: { requireApprovalFor: linesToList(form.requireApprovalFor) },
    changeBudget: {
      maxScopeItems: toCount(form.maxScopeItems),
      maxPaths: toCount(form.maxPaths),
    },
  });
  if (!parsed.success) {
    // Say which field, not "invalid input" — the owner is looking at seven boxes.
    const issue = parsed.error.issues[0];
    const where = issue?.path.join('.') || 'the document';
    return { error: `${where}: ${issue?.message ?? 'is not valid'}` };
  }
  return { document: parsed.data };
}

/** True when the owner cleared every box — publishing that is almost never meant. */
export const isEmptyPolicy = (document: PolicyDocument): boolean =>
  document.guidance.length === 0 &&
  document.permissions.deny.length === 0 &&
  document.permissions.requireApproval.length === 0 &&
  document.requiredChecks.length === 0 &&
  document.protectedPaths.length === 0 &&
  document.environment.requiredEnvVarNames.length === 0 &&
  Object.keys(document.environment.runtimes).length === 0 &&
  document.autonomy.requireApprovalFor.length === 0 &&
  document.changeBudget.maxScopeItems === 0 &&
  document.changeBudget.maxPaths === 0;
