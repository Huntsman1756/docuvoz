import { decimalToWords, integerToWords } from "../es-number";
import { regexRule, type SpokenRule } from "./core";

/**
 * Legal reference verbalization for Spanish regulations.
 *
 * Nested citations such as "artículo 57.1.b)" are read with their structural
 * meaning, following the convention used by Spanish regulators when speaking:
 * level 1 -> "artículo N", level 2 -> "apartado N", level 3 -> "párrafo N",
 * a letter marker -> "letra X". Letters are spelled with their Spanish names
 * so any TTS engine pronounces them correctly.
 */

const LETTER_NAMES: Readonly<Record<string, string>> = {
  a: "a",
  b: "be",
  c: "ce",
  d: "de",
  e: "e",
  f: "efe",
  g: "ge",
  h: "hache",
  i: "i",
  j: "jota",
  k: "k",
  l: "ele",
  m: "eme",
  n: "ene",
  ñ: "eñe",
  o: "o",
  p: "pe",
  q: "cu",
  r: "ere",
  s: "ese",
  t: "te",
  u: "u",
  v: "uve",
  w: "uve doble",
  x: "equis",
  y: "i griega",
  z: "zeta",
};

const ROMAN_VALUES: Readonly<Record<string, number>> = {
  i: 1,
  v: 5,
  x: 10,
  l: 50,
  c: 100,
  d: 500,
  m: 1000,
};

export function romanToInteger(roman: string): number | null {
  const s = roman.toLowerCase();
  if (!/^[ivxlcdm]+$/.test(s) || s.length === 0) return null;
  let acc = 0;
  let i = 0;
  const vals = [...s].map((ch) => ROMAN_VALUES[ch] ?? 0);
  while (i < vals.length) {
    if (i + 1 < vals.length && vals[i] < vals[i + 1]) {
      acc += vals[i + 1] - vals[i];
      i += 2;
    } else {
      acc += vals[i];
      i += 1;
    }
  }
  return acc > 0 ? acc : null;
}

function letterWord(letter: string): string | null {
  return LETTER_NAMES[letter.toLowerCase()] ?? null;
}

/**
 * "art. 57.1.b)", "artículo 5.2.a)", "arts. 10 a 12" (multi-part handled by
 * the numbers/ranges rules; here only single citations are expanded).
 */
export const articleRule: SpokenRule = regexRule(
  "legal-references",
  true,
  /\b(arts?\.|Art(?:[íi]cul[oa]s?)?\.?)\s+(\d+(?:\.\d+){0,2})(?:([.)])\s*)?(?:\(\s*([a-zñ])\s*\)|([a-zñ])\))?/gi,
  (m) => {
    const keyword = /^arts/i.test(m[1]) ? "artículos" : "artículo";
    const levels = m[2].split(".");
    const parts: string[] = [];
    for (let i = 0; i < levels.length; i++) {
      const words = integerToWords(levels[i]);
      if (words === null) return null;
      if (i === 0) parts.push(`${keyword} ${words}`);
      else if (i === 1) parts.push(`apartado ${words}`);
      else parts.push(`párrafo ${words}`);
    }
    const letter = m[4] ?? m[5];
    if (letter !== undefined) {
      const name = letterWord(letter);
      if (name === null) return null;
      parts.push(`letra ${name}`);
    }
    return parts.join(", ");
  },
);

/**
 * Keyword + number references: "apartado 2", "párrafo 3", "letra c)",
 * "número 4", "sección 5", "regla 2", "cifra 3", "ordinal 1".
 */
export const keywordReferenceRule: SpokenRule = regexRule(
  "keyword-references",
  true,
  /\b(apartados?|párrafos?|números?|secci[oó]n(?:es)?|reglas?|cifras?|letras?|incisos?)\s+(?:(\d+(?:\.\d+)*)|\(\s*([ivxlcdm]+)\s*\)|([a-zñ])\)?)(?![0-9A-Za-z])/gi,
  (m) => {
    const keyword = m[1];
    if (m[2] !== undefined) {
      const words = decimalToWords(m[2]);
      return words === null ? null : `${keyword} ${words}`;
    }
    if (m[3] !== undefined) {
      const value = romanToInteger(m[3]);
      if (value === null) return null;
      const words = integerToWords(String(value));
      return words === null ? null : `${keyword} ${words}`;
    }
    const name = m[4] !== undefined ? letterWord(m[4]) : null;
    if (name === null) return null;
    return `${keyword} ${name}`;
  },
);

/**
 * Section/annex headings with roman numerals: "Anexo II", "Título Preliminar"
 * stays untouched; only roman digits are verbalized.
 */
export const romanHeadingRule: SpokenRule = regexRule(
  "roman-headings",
  true,
  /\b(anexos?|títulos?|capítulos?|secci[oó]n(?:es)?|disposiciones?)\s+\(?\s*([ivxlcdm]+)\s*\)?(\.?)(?=\s)/gi,
  (m) => {
    const value = romanToInteger(m[2]);
    if (value === null) return null;
    const words = integerToWords(String(value));
    if (words === null) return null;
    // Re-attach a sentence period but not the parenthesis wrapper.
    return `${m[1]} ${words}${m[3] === "." ? "." : ""} `;
  },
);

/** "disposición adicional 3ª" handled by ordinals; "D.A. 3ª" expanded here. */
export const provisionAbbrevRule: SpokenRule = regexRule(
  "provision-abbrev",
  true,
  /\bD\.\s*(A|T|F)\.\s*(?=\d)/gi,
  (m) =>
    m[1].toUpperCase() === "A"
      ? "disposición adicional "
      : m[1].toUpperCase() === "T"
        ? "disposición transitoria "
        : "disposición final ",
);
