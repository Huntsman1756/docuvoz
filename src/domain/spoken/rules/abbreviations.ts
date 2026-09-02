import { regexRule, type SpokenRule } from "./core";

/**
 * Conservative abbreviation dictionary for Spanish regulatory text.
 * Only entries that are unambiguous in this domain are expanded.
 * Unknown abbreviations are preserved (fail-safe).
 */
const ABBREVIATIONS: readonly (readonly [string, string])[] = [
  ["núm.", "número"],
  ["núms.", "números"],
  ["apdo.", "apartado"],
  ["apdos.", "apartados"],
  ["pág.", "página"],
  ["págs.", "páginas"],
  ["párr.", "párrafo"],
  ["disp.", "disposición"],
  ["EE.UU.", "Estados Unidos"],
  ["EE. UU.", "Estados Unidos"],
];

function expandAcronym(letters: string): string {
  return [...letters].join(" ");
}

const ACRONYMS = [
  "BOE",
  "BORME",
  "CNMV",
  "CNMC",
  "BCE",
  "BEI",
  "ESMA",
  "EBA",
  "EIOPA",
  "FMI",
  "FROB",
  "AEAT",
  "SEPI",
  "SOCIMI",
  "UCITS",
  "MEF",
  "IPSE",
] as const;

const acronymAlternatives = [...ACRONYMS].sort((a, b) => b.length - a.length).join("|");

/** Acronyms and "(UE)" -> spaced letters so TTS reads them letter by letter. */
export const acronymsRule: SpokenRule = regexRule(
  "acronyms",
  true,
  new RegExp(
    String.raw`(?<![A-Za-z0-9])(${acronymAlternatives}|(?<=\()UE(?=\)))(?![A-Za-z0-9])`,
    "g",
  ),
  (m) => expandAcronym(m[1]),
);

/**
 * Ordinal marker "nº 3" -> "número 3" (numerals are verbalized by the
 * numbers rule later in the pipeline).
 */
export const numeroSignRule: SpokenRule = regexRule(
  "numero-sign",
  true,
  /nº|núm(?=[.\s])/gi,
  () => "número",
);

/** Word-boundary case-insensitive abbreviation expansion. */
export const abbreviationsRule: SpokenRule = {
  id: "abbreviations",
  valuePreserving: true,
  apply(text: string) {
    let out = text;
    const matches = [];
    for (const [from, to] of ABBREVIATIONS) {
      const re = new RegExp(
        `(?<![A-Za-z0-9ÁÉÍÓÚÑáéíóúñ])${from.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        )}(?![A-Za-z0-9])`,
        "g",
      );
      let m: RegExpExecArray | null;
      while ((m = re.exec(out)) !== null) {
        matches.push({
          ruleId: "abbreviations",
          source: m[0],
          replacement: to,
          index: m.index,
          valuePreserving: true,
        });
        out = out.slice(0, m.index) + to + out.slice(m.index + m[0].length);
        re.lastIndex = m.index + to.length;
      }
    }
    return { text: out, matches };
  },
};
