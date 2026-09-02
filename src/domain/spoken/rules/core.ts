/**
 * Rule contract.
 *
 * A rule is a pure text-to-text transformation over one segment. It reports
 * every replacement it made together with the exact matched source substring.
 * The fidelity validator uses those matches to prove that critical literals
 * were consumed by a *value-preserving* rule rather than silently dropped.
 */

export interface RuleMatch {
  ruleId: string;
  /** Exact substring of the rule input that was replaced. */
  source: string;
  /** Replacement text. */
  replacement: string;
  /** Index of the match within the rule input text. */
  index: number;
  /** Copy of the owning rule's valuePreserving flag at match time. */
  valuePreserving: boolean;
}

export interface RuleResult {
  text: string;
  matches: RuleMatch[];
}

export interface SpokenRule {
  /** Stable identifier, e.g. "currencies". Appears in transformation logs. */
  readonly id: string;
  /**
   * Whether this rule provably preserves literal values (numbers, dates,
   * amounts). Only value-preserving rules can "cover" critical tokens when
   * the token disappears from the visible output.
   */
  readonly valuePreserving: boolean;
  apply(text: string): RuleResult;
}

/** Build a regex-replacement rule that records all matches. */
export function regexRule(
  id: string,
  valuePreserving: boolean,
  pattern: RegExp,
  replacer: (match: RegExpExecArray) => string | null,
): SpokenRule {
  return {
    id,
    valuePreserving,
    apply(text: string): RuleResult {
      const re = new RegExp(
        pattern.source,
        pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
      );
      const matches: RuleMatch[] = [];
      let out = "";
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) {
          re.lastIndex += 1;
          continue;
        }
        const replacement = replacer(m);
        if (replacement === null || replacement === m[0]) continue;
        matches.push({
          ruleId: id,
          source: m[0],
          replacement,
          index: m.index,
          valuePreserving,
        });
        out += text.slice(last, m.index) + replacement;
        last = m.index + m[0].length;
      }
      out += text.slice(last);
      return { text: out, matches };
    },
  };
}

/** Chain rules left to right, accumulating matches. */
export function applyRules(rules: readonly SpokenRule[], text: string): RuleResult {
  let current = text;
  const all: RuleMatch[] = [];
  for (const rule of rules) {
    const result = rule.apply(current);
    all.push(...result.matches);
    current = result.text;
  }
  return { text: current, matches: all };
}
