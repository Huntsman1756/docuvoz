/**
 * Detection of critical literals that must survive any transformation.
 *
 * Used by the fidelity validator (fidelity.ts). Detection is intentionally
 * over-inclusive: extra tokens only make validation stricter, never weaker.
 */

/** Regulatory constructions that must never disappear from speech. */
export const CRITICAL_LEGAL_TERMS: readonly string[] = [
  "no deberá",
  "no podrá",
  "deberá",
  "podrá",
  "salvo que",
  "excepto",
  "sin perjuicio de",
  "siempre que",
  "antes de",
  "después de",
  "a más tardar",
  "dentro de",
  "queda prohibido",
  "no obstante",
  "en ningún caso",
];

export type CriticalTokenKind = "number" | "ordinal" | "legal-term" | "isin" | "lei";

export interface CriticalToken {
  kind: CriticalTokenKind;
  /** Exact source text. */
  text: string;
  index: number;
}

const NUMBER_RE =
  /(?<![0-9A-Za-z])\d+(?:\.\d{3})*(?:,\d+)?(?![0-9A-Za-z])|(?<![0-9A-Za-z])\d+(?:[.-]\d+)+(?![0-9A-Za-z])/g;
const ORDINAL_RE = /\d+\.?\s?[ºª°]/g;
const ISIN_RE = /\b[A-Z]{2}[A-Z0-9]{10}\b/g;
const LEI_RE = /\b[A-Z0-9]{20}\b/g;

function boundaryRegex(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\wáéíóúñü])${escaped}(?![\\wáéíóúñü])`, "g");
}

export function findCriticalTokens(text: string): CriticalToken[] {
  const tokens: CriticalToken[] = [];
  const push = (kind: CriticalTokenKind, re: RegExp) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      tokens.push({ kind, text: m[0], index: m.index });
    }
  };
  push("number", NUMBER_RE);
  push("ordinal", ORDINAL_RE);
  push("isin", ISIN_RE);
  push("lei", LEI_RE);
  for (const term of CRITICAL_LEGAL_TERMS) {
    push("legal-term", boundaryRegex(term));
  }
  return tokens.sort((a, b) => a.index - b.index);
}

/**
 * True when `token` occurs in `haystack` at a word boundary in the numeric
 * sense: the characters immediately around it are not letters or digits.
 * Dots and commas around the token are allowed because Spanish numeric
 * literals embed them ("57.1", "1.234,56").
 */
export function containsAtBoundary(haystack: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![0-9A-Za-z])${escaped}(?![0-9A-Za-z])`).test(haystack);
}
