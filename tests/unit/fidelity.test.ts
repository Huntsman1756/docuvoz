import { describe, expect, it } from "vitest";
import { findCriticalTokens, containsAtBoundary } from "@/domain/spoken/critical-tokens";
import { validateFidelity } from "@/domain/spoken/fidelity";
import type { RuleMatch } from "@/domain/spoken/rules/core";

const m = (source: string, replacement: string, vp = true): RuleMatch => ({
  ruleId: "test",
  source,
  replacement,
  index: 0,
  valuePreserving: vp,
});

describe("findCriticalTokens", () => {
  it("catches numbers, ordinals, identifiers and legal terms", () => {
    const tokens = findCriticalTokens(
      "El art. 5.2 deberá publicarse el 15/07/2024 con un ISIN ES0123456789, salvo que el 8,5 % (1.º) no podrá aplicarse, a más tardar en 2024.",
    ).map((t) => t.text);
    for (const expected of [
      "deberá",
      "5",
      "2",
      "15",
      "07",
      "2024",
      "ES0123456789",
      "salvo que",
      "8,5",
      "no podrá",
      "a más tardar",
    ]) {
      expect(tokens).toContain(expected);
    }
  });
  it("treats LEI codes as critical literals (regression: detector was inert)", () => {
    const tokens = findCriticalTokens("contraparte con LEI VAVR88822QQ763F4A823.");
    expect(tokens.map((t) => t.text)).toContain("VAVR88822QQ763F4A823");
    // Without value-preserving coverage, dropping the LEI must fail.
    expect(validateFidelity("LEI VAVR88822QQ763F4A823", "LEI eliminado", []).ok).toBe(
      false,
    );
  });
  it("finds negations that are substrings of obligations", () => {
    const tokens = findCriticalTokens("no deberá repetir");
    expect(tokens.filter((t) => t.kind === "legal-term").map((t) => t.text)).toContain(
      "no deberá",
    );
  });
});

describe("containsAtBoundary", () => {
  it("matches digits at numeric boundaries only", () => {
    expect(containsAtBoundary("57.1.b)", "1")).toBe(true);
    expect(containsAtBoundary("57", "7")).toBe(false); // '7' is inside '57'
    expect(containsAtBoundary("57", "57")).toBe(true);
    expect(containsAtBoundary("1234", "23")).toBe(false);
    expect(containsAtBoundary("debera", "deber")).toBe(false);
  });
});

describe("validateFidelity", () => {
  it("passes when literals are verbalized by value-preserving rules", () => {
    const source = "pago de 1.234,56 € antes del 15/07/2024, deberá cumplirlo";
    const spoken =
      "pago de mil doscientos treinta y cuatro euros con cincuenta y seis céntimos antes del quince de julio de dos mil veinticuatro, deberá cumplirlo";
    const matches = [
      m(
        "1.234,56 €",
        "mil doscientos treinta y cuatro euros con cincuenta y seis céntimos",
      ),
      m("15/07/2024", "15 de julio de 2024"),
      m("15", "quince"),
      m("2024", "dos mil veinticuatro"),
    ];
    expect(validateFidelity(source, spoken, matches).ok).toBe(true);
  });

  it("fails when a number vanishes without coverage", () => {
    const result = validateFidelity("pago de 1.234,56 €", "pago de euros", []);
    expect(result.ok).toBe(false);
    expect(result.lost.map((t) => t.text)).toContain("1.234,56");
  });

  it("fails when a legal qualification disappears", () => {
    const result = validateFidelity("no deberá pagar", "podrá pagar", []);
    expect(result.ok).toBe(false);
    expect(result.lost.map((t) => t.text)).toContain("no deberá");
  });

  it("fails when the transformation loses numbers via a NON-value-preserving rule", () => {
    const result = validateFidelity("plazo 30 días", "plazo días", [
      m("30 días", "", false),
    ]);
    expect(result.ok).toBe(false);
  });

  it("invented numbers are rejected", () => {
    const result = validateFidelity(
      "no se aplican excepciones",
      "no se aplican 12 excepciones",
      [],
    );
    expect(result.ok).toBe(false);
    expect(result.invented.map((t) => t.text)).toContain("12");
  });
});
