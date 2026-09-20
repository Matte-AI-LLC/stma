import { pathClaimsOverlap } from './conflicts';

/**
 * Content rules — the part of a policy a machine can check.
 *
 * Every other line in `permissions.deny` is a sentence an agent reads and is
 * trusted to follow, and nothing can tell afterwards whether it did. "Do not
 * use fonts outside the design system" is exactly that kind of rule: the agent
 * that ignores it leaves no trace STMA can see, because STMA never sees file
 * content — by design, only paths leave the machine.
 *
 * So the check has to run where the content is. A deny line in this shape is
 * still a sentence (an old CLI, or an agent with no hook, reads it as one), and
 * is also something the local file guard can evaluate against the text an edit
 * would add:
 *
 *     content: "Comic Sans" in public/** — not in the design system
 *
 * The quoted text is a case-insensitive literal, never a pattern: an owner's
 * regular expression would run on every teammate's machine on every edit, and a
 * rule that can hang an editor is worse than a rule that cannot express
 * everything. `in <path>` uses the same overlap rule as protected paths, so a
 * path pattern means one thing in this document. Both it and the reason are
 * optional.
 *
 * It lives inside the existing deny list rather than in a new field on purpose:
 * the policy document is fingerprinted, and a published CLI recomputes that
 * fingerprint from the fields *it* knows — a new field would read as drift on
 * every machine that has not upgraded.
 */
export interface ContentRule {
  /** The published deny line, verbatim: what a report names and what a person reads. */
  rule: string;
  /** Case-insensitive literal looked for in the text an edit would add. */
  needle: string;
  /** Limits the rule to matching files; null means every file. */
  pathPattern: string | null;
  reason: string | null;
}

/** A bound, not a feature: a guard that evaluates hundreds of rules per edit is a slow editor. */
export const MAX_CONTENT_RULES = 50;

const CONTENT_RULE_RE =
  /^content:\s*"([^"\r\n]{2,200})"(?:\s+in\s+(\S{1,300}))?(?:\s+(?:—|–|--|-|#)\s*(.{1,300}))?\s*$/i;

/** True for a line that is trying to be a content rule, valid or not — so an editor can refuse a typo instead of publishing it as prose. */
export const looksLikeContentRule = (line: string): boolean => /^content\s*:/i.test(line.trim());

export function parseContentRule(line: string): ContentRule | null {
  const trimmed = line.trim();
  const match = CONTENT_RULE_RE.exec(trimmed);
  if (!match) return null;
  return {
    rule: trimmed,
    needle: match[1]!,
    pathPattern: match[2] ?? null,
    reason: match[3]?.trim() || null,
  };
}

/** The machine-checkable subset of a deny list, in published order. */
export function parseContentRules(deny: readonly string[]): ContentRule[] {
  const rules: ContentRule[] = [];
  for (const line of deny) {
    const rule = parseContentRule(line);
    if (rule) rules.push(rule);
    if (rules.length >= MAX_CONTENT_RULES) break;
  }
  return rules;
}

/**
 * Rules an edit would break: the file is in the rule's ground and the text it
 * adds contains the literal. Only *added* text is ever passed here — removing a
 * forbidden font must not be stopped by the rule that forbids it.
 */
export function matchContentRules(
  rules: readonly ContentRule[],
  file: string,
  addedText: string,
): ContentRule[] {
  if (rules.length === 0 || addedText.length === 0) return [];
  const haystack = addedText.toLowerCase();
  return rules.filter(
    (rule) =>
      haystack.includes(rule.needle.toLowerCase()) &&
      (rule.pathPattern === null || pathClaimsOverlap(file, rule.pathPattern)),
  );
}
