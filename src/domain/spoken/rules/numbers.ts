import { decimalToWords, integerToWords } from "../es-number";
import { regexRule, type SpokenRule } from "./core";

/**
 * Fallback rule: verbalize any remaining numeric literal not already consumed
 * by a more specific rule. Placed last in the pipeline.
 */
export const numbersRule: SpokenRule = regexRule(
  "numbers",
  true,
  /(?<![0-9A-Za-z.])[0-9]+(?:\.[0-9]{3})*(?:,[0-9]+)?(?![0-9A-Za-z])(?!\.[0-9])/g,
  (m) => {
    const words = decimalToWords(m[0]);
    if (words !== null) return words;
    // Unknown grouping ("12.34" is ambiguous). Preserve the original.
    return null;
  },
);

const ORDINALS_M: Record<string, string> = {
  "1": "primero",
  "2": "segundo",
  "3": "tercero",
  "4": "cuarto",
  "5": "quinto",
  "6": "sexto",
  "7": "séptimo",
  "8": "octavo",
  "9": "noveno",
  "10": "décimo",
  "11": "undécimo",
  "12": "duodécimo",
  "13": "decimotercero",
  "14": "decimocuarto",
  "15": "decimoquinto",
  "16": "decimosexto",
  "17": "decimoséptimo",
  "18": "decimoctavo",
  "19": "decimonoveno",
  "20": "vigésimo",
};
const ORDINALS_F: Record<string, string> = {
  "1": "primera",
  "2": "segunda",
  "3": "tercera",
  "4": "cuarta",
  "5": "quinta",
  "6": "sexta",
  "7": "séptima",
  "8": "octava",
  "9": "novena",
  "10": "décima",
  "11": "undécima",
  "12": "duodécima",
};

export const ordinalsRule: SpokenRule = regexRule(
  "ordinals",
  true,
  /(\d+)(\.?)\s?([ºª°])(?![0-9A-Za-z])/g,
  (m) => {
    const table = m[3] === "ª" ? ORDINALS_F : ORDINALS_M;
    const word = table[m[1]];
    if (word === undefined) return null;
    // "1.º" is the abbreviation of "punto primero": keep the period.
    return m[2] === "." ? `${word}.` : word;
  },
);

/**
 * En-dash / hyphen numeric ranges: "10–15" -> "10 a 15".
 * Keeps the numerals so the numbers rule can verbalize them afterwards.
 * Hyphen-only forms with 1-2 digit operands on both sides are skipped because
 * they are usually date fragments ("01-03-2024").
 */
export const rangesRule: SpokenRule = regexRule(
  "ranges",
  true,
  /(?<![0-9A-Za-z])([0-9]+(?:[.,][0-9]+)?)\s*([–—-])\s*([0-9]+(?:[.,][0-9]+)?)(?![0-9A-Za-z])/g,
  (m) => {
    const dashOnly = m[2] === "-";
    const dateLike = /^\d{1,2}$/.test(m[1]) && /^\d{1,4}$/.test(m[3]);
    if (dashOnly && dateLike) return null;
    return `${m[1]} a ${m[3]}`;
  },
);

/**
 * Clock times: "14:00" -> "14 horas" (exact hour), "14:30" -> "14 horas y 30"
 * (minutes are then verbalized by the numbers rule). Digits are preserved.
 */
export const timeRule: SpokenRule = regexRule(
  "time",
  true,
  /(?<![\d:])(\d{1,2}):([0-5]\d)(?![\d:])/g,
  (m) => (m[2] === "00" ? `${m[1]} horas` : `${m[1]} horas y ${m[2]}`),
);

/**
 * Slash citations typical of EU/Spanish regulations:
 * "47/2003", "2017/1129" -> "47, 2003" (pause; numerals verbalized later).
 * Both numbers are preserved; only the separator becomes prosody.
 */
export const slashCitationsRule: SpokenRule = regexRule(
  "slash-citations",
  true,
  /(?<![0-9A-Za-z])([0-9]{1,4})\/([0-9]{1,4})(?![0-9A-Za-z])/g,
  (m) => `${m[1]}, ${m[2]}`,
);

/**
 * Bare years inside legal text ("Ley 47/2003" handled by slash-citations +
 * numbers). `integerToWords` re-exported for test convenience.
 */
export const __testOnly = { integerToWords };
