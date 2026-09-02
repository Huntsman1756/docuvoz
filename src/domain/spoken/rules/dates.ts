import { regexRule, type SpokenRule } from "./core";

const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
] as const;

export function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * Numeric dates -> written-out format (keeping digits). The numbers rule
 * verbalizes the digits later, so this rule only fixes the *format*:
 * "12/03/2025" -> "12 de marzo de 2025", ISO "2025-03-12" likewise.
 * Only real calendar dates are matched; anything ambiguous is preserved.
 */
export const numericDateRule: SpokenRule = regexRule(
  "dates",
  true,
  /(?<![0-9A-Za-z])(\d{1,2})[\/](0?[1-9]|1[0-2])[\/](\d{4})(?![0-9A-Za-z])/g,
  (m) => {
    const day = Number(m[1]);
    const month = Number(m[2]);
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(Number(m[3]), month)) {
      return null;
    }
    return `${day} de ${MONTHS[month - 1]} de ${m[3]}`;
  },
);

export const isoDateRule: SpokenRule = regexRule(
  "dates-iso",
  true,
  /(?<![0-9A-Za-z])(\d{4})-(0[1-9]|1[0-2])-(3[01]|[12]\d|0[1-9])(?![0-9A-Za-z-])/g,
  (m) => {
    const day = Number(m[3]);
    const month = Number(m[2]);
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(Number(m[1]), month)) {
      return null;
    }
    return `${day} de ${MONTHS[month - 1]} de ${m[1]}`;
  },
);

/** Dates with a hyphen separator: "12-03-2025" -> "12 de marzo de 2025". */
export const hyphenDateRule: SpokenRule = regexRule(
  "dates-hyphen",
  true,
  /(?<![0-9A-Za-z])(\d{1,2})-(0?[1-9]|1[0-2])-(\d{4})(?![0-9A-Za-z-])/g,
  (m) => {
    const day = Number(m[1]);
    const month = Number(m[2]);
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(Number(m[3]), month)) {
      return null;
    }
    return `${day} de ${MONTHS[month - 1]} de ${m[3]}`;
  },
);
