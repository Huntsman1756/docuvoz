import { decimalToWords, integerToWords, splitLiteral } from "../es-number";
import { regexRule, type RuleMatch, type RuleResult, type SpokenRule } from "./core";

/**
 * Money amounts in Spanish notation followed by the unit:
 * "1.234.567,89 €", "9.923,47 euros", "250 EUR", "0,50 €".
 * Cents are verbalized as integers ("cincuenta y seis céntimos"); amounts
 * over one trillion are preserved untouched (out of supported range).
 */
export const currencyRule: SpokenRule = {
  id: "currencies",
  valuePreserving: true,
  apply(text: string): RuleResult {
    const matches: RuleMatch[] = [];
    const re =
      /(?<![0-9A-Za-z,.])(\d+(?:\.\d{3})*(?:,\d{1,2})?)\s*(?:€|euros?|EUR)(?![0-9A-Za-z])/g;
    let out = "";
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const parts = splitLiteral(m[1]);
      if (parts === null) continue;
      const [intRaw, decRaw] = parts;
      const intWords = integerToWords(intRaw);
      if (intWords === null) continue;
      const units = /\b(?:millones|millón|billones|billón)$/.test(intWords)
        ? `${intWords} de euros`
        : `${intWords} euros`;
      let replacement: string;
      if (decRaw !== undefined && decRaw !== "") {
        const centsWords = integerToWords(decRaw);
        if (centsWords === null) continue;
        replacement =
          intRaw === "0"
            ? `${centsWords} céntimos`
            : `${intWords} euros con ${centsWords} céntimos`;
        if (/\b(?:millones|millón|billones|billón)$/.test(intWords)) {
          replacement = `${intWords} de euros con ${centsWords} céntimos`;
        }
      } else {
        replacement = units;
      }
      matches.push({
        ruleId: "currencies",
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

/** "3,5 %" and "50%" -> "tres coma cinco por ciento", "cincuenta por ciento". */
export const percentageRule: SpokenRule = regexRule(
  "percentages",
  true,
  /(?<![0-9A-Za-z])(\d+(?:\.\d{3})*(?:,\d+)?)\s*%(?![0-9A-Za-z])/g,
  (m) => {
    const words = decimalToWords(m[1]);
    return words === null ? null : `${words} por ciento`;
  },
);

/** "25 pb", "25 p. b.", "50 bps" -> "veinticinco puntos básicos". */
export const basisPointsRule: SpokenRule = regexRule(
  "basis-points",
  true,
  /(?<![0-9A-Za-z])(\d+(?:,\d+)?)\s*(?:p\.\s?b\.|p\.b\.|bps|pb)(?![0-9A-Za-z])/gi,
  (m) => {
    const words = decimalToWords(m[1]);
    return words === null ? null : `${words} puntos básicos`;
  },
);
