import {
  containsAtBoundary,
  findCriticalTokens,
  type CriticalToken,
} from "./critical-tokens";
import type { RuleMatch } from "./rules/core";

export interface FidelityResult {
  ok: boolean;
  /** Critical literals that vanished without value-preserving coverage. */
  lost: CriticalToken[];
  /** Numeric literals in the output that do not exist in the source. */
  invented: CriticalToken[];
}

/**
 * Validate that a transformation preserved every critical literal.
 *
 * A token is preserved when it appears verbatim (word boundary) in the
 * output, or when a *value-preserving* rule match consumed a span containing
 * it. Legal qualification terms must always appear verbatim: no rule is
 * allowed to absorb them.
 *
 * The check is intentionally asymmetric: it proves literals survive
 * (TRACEABLE + PRESERVED). It does NOT claim semantic faithfulness.
 */
export function validateFidelity(
  source: string,
  spoken: string,
  matches: readonly RuleMatch[],
): FidelityResult {
  const lost: CriticalToken[] = [];
  for (const token of findCriticalTokens(source)) {
    if (containsAtBoundary(spoken, token.text)) continue;
    if (token.kind === "legal-term") {
      lost.push(token);
      continue;
    }
    const covered = matches.some(
      (m) => m.valuePreserving && containsAtBoundary(m.source, token.text),
    );
    if (!covered) lost.push(token);
  }

  const invented: CriticalToken[] = [];
  const sourceTokens = findCriticalTokens(source);
  for (const token of findCriticalTokens(spoken)) {
    const exists =
      containsAtBoundary(source, token.text) ||
      matches.some((m) => containsAtBoundary(m.replacement, token.text));
    const coveredBySource = sourceTokens.some((s) => s.text === token.text);
    if (!exists && !coveredBySource) invented.push(token);
  }

  return { ok: lost.length === 0 && invented.length === 0, lost, invented };
}
