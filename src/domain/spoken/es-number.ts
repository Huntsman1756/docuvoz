/**
 * Deterministic Spanish number verbalization (cardinals).
 *
 * Covers 0 .. 999_999_999_999_999 (up to billones). Out-of-range or malformed
 * input returns `null` so callers can preserve the original text, which is
 * the conservative behavior required by the fidelity policy.
 *
 * Conventions implemented (see docs/spoken-representation.md):
 * - 1.000 -> "mil" (not "un mil")
 * - 1.000.000 -> "un millón"; 2.000.000 -> "dos millones"
 * - 501/701/901 -> "quinientos y uno" / "setecientos y uno" / "novecientos y uno"
 * - 21..29 -> combined forms ("veintidós", "veintiséis", ...)
 * - 31..99 -> "treinta y uno" style
 * - Decimals: integer part as cardinal + " coma " + digit-by-digit decimals
 *   (preserves trailing zeros, e.g. 1,50 -> "uno coma cinco cero").
 */

const UNITS = [
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
] as const;

const TEENS = [
  "diez",
  "once",
  "doce",
  "trece",
  "catorce",
  "quince",
  "dieciséis",
  "diecisiete",
  "dieciocho",
  "diecinueve",
] as const;

const TWENTIES = [
  "veinte",
  "veintiuno",
  "veintidós",
  "veintitrés",
  "veinticuatro",
  "veinticinco",
  "veintiséis",
  "veintisiete",
  "veintiocho",
  "veintinueve",
] as const;

const TENS = [
  "",
  "",
  "",
  "treinta",
  "cuarenta",
  "cincuenta",
  "sesenta",
  "setenta",
  "ochenta",
  "noventa",
] as const;

const HUNDREDS = [
  "",
  "ciento",
  "doscientos",
  "trescientos",
  "cuatrocientos",
  "quinientos",
  "seiscientos",
  "setecientos",
  "ochocientos",
  "novecientos",
] as const;

const AND_HUNDREDS: ReadonlySet<number> = new Set([5, 7, 9]);

function underOneHundred(n: number): string {
  if (n < 10) return UNITS[n];
  if (n < 20) return TEENS[n - 10];
  if (n < 30) return TWENTIES[n - 20];
  const tens = Math.floor(n / 10);
  const unit = n % 10;
  return unit === 0 ? TENS[tens] : `${TENS[tens]} y ${UNITS[unit]}`;
}

function underOneThousand(n: number): string {
  if (n < 100) return underOneHundred(n);
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (n === 100) return "cien";
  if (rest === 0) return HUNDREDS[hundreds];
  if (rest === 1 && AND_HUNDREDS.has(hundreds)) {
    return `${HUNDREDS[hundreds]} y uno`;
  }
  return `${HUNDREDS[hundreds]} ${underOneHundred(rest)}`;
}

function underOneMillion(n: number): string {
  if (n < 1000) return underOneThousand(n);
  const thousands = Math.floor(n / 1000);
  const rest = n % 1000;
  const thousandsPart = thousands === 1 ? "mil" : `${underOneThousand(thousands)} mil`;
  return rest === 0 ? thousandsPart : `${thousandsPart} ${underOneThousand(rest)}`;
}

/** Verbalize a non-negative integer given as a plain digit string. */
export function integerToWords(digits: string): string | null {
  if (!/^\d+$/.test(digits)) return null;
  const stripped = digits.replace(/^0+(?=\d)/, "");
  if (stripped.length > 15) return null;
  const value = Number(stripped);
  if (!Number.isSafeInteger(value)) return null;
  return wordsFromNumber(value);
}

function wordsFromNumber(value: number): string | null {
  if (value < 1_000_000) return underOneMillion(value);
  const scale: { size: number; one: string; many: string }[] = [
    { size: 1_000_000_000_000, one: "un billón", many: "billones" },
    { size: 1_000_000, one: "un millón", many: "millones" },
  ];
  for (const s of scale) {
    if (value >= s.size) {
      const count = Math.floor(value / s.size);
      const rest = value % s.size;
      const countWords = count === 1 ? s.one : `${underOneMillion(count)} ${s.many}`;
      return rest === 0 ? countWords : `${countWords} ${wordsFromNumber(rest)}`;
    }
  }
  return underOneMillion(value);
}

const DECIMAL_DIGITS = UNITS;

/**
 * Verbalize a Spanish decimal literal. Accepts thousands grouping with ".",
 * decimal separator "," (or "." when unambiguous), e.g. "1.234,56", "3,5",
 * "0,50". Returns null for ambiguous/unsupported forms.
 */
export function decimalToWords(raw: string): string | null {
  const parts = splitLiteral(raw);
  if (parts === null) return null;
  const [intRaw, decRaw] = parts;
  const intWords = integerToWords(intRaw);
  if (intWords === null) return null;
  if (decRaw === undefined || decRaw === "") return intWords;
  const decWords = [...decRaw].map((d) => DECIMAL_DIGITS[Number(d)]).join(" ");
  return `${intWords} coma ${decWords}`;
}

/**
 * Split a Spanish numeric literal into integer digits and decimal digits.
 * Accepted: "1234", "1.234.567", "1234,56", "1.234,56".
 * Rejected (ambiguous): "12.34", "1.2", any dot not forming a 3-digit group.
 */
export function splitLiteral(raw: string): [string, string | undefined] | null {
  const m = /^(\d+)((?:\.\d{3})*)(?:,(\d+))?$/.exec(raw);
  if (!m) return null;
  const intDigits = m[1] + m[2].replaceAll(".", "");
  return [intDigits, m[3]];
}
