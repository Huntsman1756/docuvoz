import type { RuleMatch, RuleResult, SpokenRule } from "./core";

/**
 * Identifier verbalization (ISIN, LEI).
 *
 * These only fire when an explicit context keyword ("ISIN", "LEI") appears
 * in the same segment, to avoid false positives on arbitrary alphanumerics.
 * Letters are spoken by their Spanish names; digits are spoken as digits,
 * preserving the exact identifier content.
 */

const LETTER_NAMES: Readonly<Record<string, string>> = {
  A: "a",
  B: "be",
  C: "ce",
  D: "de",
  E: "e",
  F: "efe",
  G: "ge",
  H: "hache",
  I: "i",
  J: "jota",
  K: "k",
  L: "ele",
  M: "eme",
  N: "ene",
  O: "o",
  P: "pe",
  Q: "cu",
  R: "ere",
  S: "ese",
  T: "te",
  U: "u",
  V: "uve",
  W: "uve doble",
  X: "equis",
  Y: "i griega",
  Z: "zeta",
};
const DIGIT_WORDS = [
  "cero",
  "uno",
  "dos",
  "tres",
  "cuatro",
  "cinco",
  "seis",
  "siete",
  "ocho",
  "nueve",
];

function spell(code: string): string {
  return [...code]
    .map((ch) => (/\d/.test(ch) ? DIGIT_WORDS[Number(ch)] : LETTER_NAMES[ch]))
    .join(" ");
}

function contextualIdentifierRule(id: string, context: RegExp, code: RegExp): SpokenRule {
  return {
    id,
    valuePreserving: true,
    apply(text: string): RuleResult {
      if (!context.test(text)) return { text, matches: [] };
      const matches: RuleMatch[] = [];
      const re = new RegExp(code.source, "gi");
      let out = "";
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const replacement = spell(m[0].toUpperCase());
        matches.push({
          ruleId: id,
          source: m[0],
          replacement,
          index: m.index,
          valuePreserving: true,
        });
        out += text.slice(last, m.index) + replacement;
        last = m.index + m[0].length;
      }
      out += text.slice(last);
      return { text: out, matches };
    },
  };
}

export const isinRule: SpokenRule = contextualIdentifierRule(
  "isin",
  /\bISIN\b/i,
  /(?<![A-Z0-9])[A-Z]{2}[A-Z0-9]{10}(?![A-Z0-9])/i,
);

export const leiRule: SpokenRule = contextualIdentifierRule(
  "lei",
  /\bLEI\b/i,
  /(?<![A-Z0-9])[A-Z0-9]{20}(?![A-Z0-9])/i,
);
