import type { SpokenRule } from "./core";
import { abbreviationsRule, acronymsRule, numeroSignRule } from "./abbreviations";
import { hyphenDateRule, isoDateRule, numericDateRule } from "./dates";
import { isinRule, leiRule } from "./identifiers";
import {
  articleRule,
  keywordReferenceRule,
  provisionAbbrevRule,
  romanHeadingRule,
} from "./legal-references";
import { basisPointsRule, currencyRule, percentageRule } from "./money";
import {
  numbersRule,
  ordinalsRule,
  rangesRule,
  slashCitationsRule,
  timeRule,
} from "./numbers";
import { settlementRule } from "./settlement";

/**
 * Ordered rule pipeline for Listen mode.
 *
 * Order matters: more specific patterns must consume their spans before the
 * generic numbers rule verbalizes the remaining digits.
 */
export const LISTEN_RULES: readonly SpokenRule[] = [
  abbreviationsRule,
  numeroSignRule,
  acronymsRule,
  provisionAbbrevRule,
  articleRule,
  keywordReferenceRule,
  romanHeadingRule,
  numericDateRule,
  isoDateRule,
  hyphenDateRule,
  currencyRule,
  percentageRule,
  basisPointsRule,
  settlementRule,
  ordinalsRule,
  timeRule,
  slashCitationsRule,
  rangesRule,
  leiRule,
  isinRule,
  numbersRule,
];

export {
  abbreviationsRule,
  acronymsRule,
  articleRule,
  basisPointsRule,
  currencyRule,
  hyphenDateRule,
  isinRule,
  keywordReferenceRule,
  leiRule,
  numericDateRule,
  numbersRule,
  ordinalsRule,
  percentageRule,
  provisionAbbrevRule,
  rangesRule,
  romanHeadingRule,
  settlementRule,
  slashCitationsRule,
};
export type { SpokenRule, RuleMatch, RuleResult } from "./core";
export { applyRules, regexRule } from "./core";
