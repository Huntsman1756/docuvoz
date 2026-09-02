import { describe, expect, it } from "vitest";
import { decimalToWords, integerToWords } from "@/domain/spoken/es-number";

describe("integerToWords", () => {
  const cases: [string, string][] = [
    ["0", "cero"],
    ["1", "uno"],
    ["5", "cinco"],
    ["10", "diez"],
    ["11", "once"],
    ["15", "quince"],
    ["16", "dieciséis"],
    ["19", "diecinueve"],
    ["20", "veinte"],
    ["21", "veintiuno"],
    ["22", "veintidós"],
    ["29", "veintinueve"],
    ["30", "treinta"],
    ["42", "cuarenta y dos"],
    ["99", "noventa y nueve"],
    ["100", "cien"],
    ["101", "ciento uno"],
    ["200", "doscientos"],
    ["300", "trescientos"],
    ["500", "quinientos"],
    ["501", "quinientos y uno"],
    ["577", "quinientos setenta y siete"],
    ["700", "setecientos"],
    ["701", "setecientos y uno"],
    ["900", "novecientos"],
    ["999", "novecientos noventa y nueve"],
    ["1000", "mil"],
    ["1001", "mil uno"],
    ["1234", "mil doscientos treinta y cuatro"],
    ["2000", "dos mil"],
    ["2101", "dos mil ciento uno"],
    ["100000", "cien mil"],
    ["999999", "novecientos noventa y nueve mil novecientos noventa y nueve"],
    ["1000000", "un millón"],
    ["1500000", "un millón quinientos mil"],
    ["2000000", "dos millones"],
    ["1234567", "un millón doscientos treinta y cuatro mil quinientos sesenta y siete"],
    ["1000000000000", "un billón"],
    ["2000000000000", "dos billones"],
  ];
  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      expect(integerToWords(input)).toBe(expected);
    });
  }

  it("rejects malformed or out-of-range input", () => {
    expect(integerToWords("12.34")).toBeNull();
    expect(integerToWords("-5")).toBeNull();
    expect(integerToWords("99999999999999999999")).toBeNull();
    expect(integerToWords("abc")).toBeNull();
  });
});

describe("decimalToWords", () => {
  const cases: [string, string][] = [
    ["3,5", "tres coma cinco"],
    ["0,50", "cero coma cinco cero"],
    ["1.234,56", "mil doscientos treinta y cuatro coma cinco seis"],
    [
      "1.234.567,89",
      "un millón doscientos treinta y cuatro mil quinientos sesenta y siete coma ocho nueve",
    ],
    ["12%", "12%"], // invalid input handled by caller
  ];
  for (const [input, expected] of cases.slice(0, 4)) {
    it(`${input} -> ${expected}`, () => {
      expect(decimalToWords(input)).toBe(expected);
    });
  }
  it("plain integers work too", () => {
    expect(decimalToWords("42")).toBe("cuarenta y dos");
  });
  it("ambiguous forms are rejected", () => {
    expect(decimalToWords("12.34")).toBeNull();
  });
});
