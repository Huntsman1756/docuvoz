import { integerToWords } from "../es-number";
import { regexRule, type SpokenRule } from "./core";

/** "T+1" -> "T más uno", "D+2" -> "D más dos" (settlement conventions). */
export const settlementRule: SpokenRule = regexRule(
  "settlement",
  true,
  /\b([TD])\+(\d{1,2})\b/g,
  (m) => {
    const words = integerToWords(m[2]);
    return words === null ? null : `${m[1]} más ${words}`;
  },
);
