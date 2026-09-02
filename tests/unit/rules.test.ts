import { describe, expect, it } from "vitest";
import { applyRules } from "@/domain/spoken/rules/core";
import {
  currencyRule,
  percentageRule,
  basisPointsRule,
} from "@/domain/spoken/rules/money";
import {
  numbersRule,
  slashCitationsRule,
  rangesRule,
  ordinalsRule,
} from "@/domain/spoken/rules/numbers";
import { settlementRule } from "@/domain/spoken/rules/settlement";
import {
  articleRule,
  keywordReferenceRule,
  provisionAbbrevRule,
} from "@/domain/spoken/rules/legal-references";
import {
  numericDateRule,
  isoDateRule,
  hyphenDateRule,
} from "@/domain/spoken/rules/dates";
import { isinRule, leiRule } from "@/domain/spoken/rules/identifiers";
import { acronymsRule, abbreviationsRule } from "@/domain/spoken/rules/abbreviations";
import { LISTEN_RULES } from "@/domain/spoken/rules";

const run = (text: string): string => applyRules(LISTEN_RULES, text).text;
const one = (rule: Parameters<typeof applyRules>[0][number], text: string): string =>
  rule.apply(text).text;

describe("numbers", () => {
  it("verbalizes integers", () => {
    expect(one(numbersRule, "hay 42 entidades")).toBe("hay cuarenta y dos entidades");
  });
  it("keeps ambiguous numbers untouched", () => {
    expect(one(numbersRule, "12.34 y 99.9")).toBe("12.34 y 99.9");
  });
  it("does not cut into alphanumeric tokens", () => {
    expect(one(numbersRule, "T20 y A100")).toBe("T20 y A100");
  });
});

describe("money rules", () => {
  it("currency with cents", () => {
    expect(one(currencyRule, "1.234.567,89 €")).toBe(
      "un millón doscientos treinta y cuatro mil quinientos sesenta y siete euros con ochenta y nueve céntimos",
    );
  });
  it("currency whole", () => {
    expect(one(currencyRule, "500.000 EUR")).toBe("quinientos mil euros");
  });
  it("millions phrasing", () => {
    expect(run("47.408 millones de euros")).toBe(
      "cuarenta y siete mil cuatrocientos ocho millones de euros",
    );
  });
  it("cents only", () => {
    expect(one(currencyRule, "0,50 €")).toBe("cincuenta céntimos");
  });
  it("percentages", () => {
    expect(one(percentageRule, "del 8,5 %")).toBe("del ocho coma cinco por ciento");
    expect(one(percentageRule, "12%")).toBe("doce por ciento");
  });
  it("basis points", () => {
    expect(one(basisPointsRule, "incrementado en 25 pb")).toBe(
      "incrementado en veinticinco puntos básicos",
    );
    expect(one(basisPointsRule, "en 30 p. b.")).toBe("en treinta puntos básicos");
  });
});

describe("legal references", () => {
  it("nested article with letter", () => {
    expect(one(articleRule, "recogidas en el art. 57.1.b) de la Ley 47/2003")).toBe(
      "recogidas en el artículo cincuenta y siete, apartado uno, letra be de la Ley 47/2003",
    );
  });
  it("article with section level", () => {
    expect(one(articleRule, "en el artículo 5.2 del texto refundido")).toBe(
      "en el artículo cinco, apartado dos del texto refundido",
    );
  });
  it("keyword + roman numeral", () => {
    expect(one(keywordReferenceRule, "sección (IV) ")).toBe("sección cuatro ");
  });
  it("keyword + letter", () => {
    expect(one(keywordReferenceRule, "apartado b)")).toBe("apartado be");
  });
  it("provision abbreviations", () => {
    expect(one(provisionAbbrevRule, "según la D. A. 3.ª")).toBe(
      "según la disposición adicional 3.ª",
    );
  });
});

describe("dates", () => {
  it("slash dates become written format", () => {
    expect(one(numericDateRule, "antes del día 15/07/2024 y")).toBe(
      "antes del día 15 de julio de 2024 y",
    );
  });
  it("hyphen dates", () => {
    expect(one(hyphenDateRule, "balance auditado a 31-12-2023")).toBe(
      "balance auditado a 31 de diciembre de 2023",
    );
  });
  it("ISO dates", () => {
    expect(one(isoDateRule, "publicado el 2024-07-15.")).toBe(
      "publicado el 15 de julio de 2024.",
    );
  });
  it("invalid combinations are preserved", () => {
    expect(one(numericDateRule, "31/02/2024")).toBe("31/02/2024");
  });
});

describe("settlement and identifiers", () => {
  it("T+n", () => {
    expect(one(settlementRule, "plazo de T+2 días")).toBe("plazo de T más dos días");
  });
  it("ISIN only with context", () => {
    expect(one(isinRule, "emitió el ISIN ES0123456789 en 2024")).toContain(
      "e ese cero uno dos tres cuatro cinco seis siete ocho nueve",
    );
    expect(one(isinRule, "el código ES0123456789 no tiene contexto")).toBe(
      "el código ES0123456789 no tiene contexto",
    );
  });
  it("LEI only with context", () => {
    const out = one(leiRule, "contraparte con LEI VAVR88822QQ763F4A823.");
    expect(out).toContain("uve a uve ere ocho ocho ocho dos dos");
    expect(out).not.toContain("VAVR88822QQ763F4A823");
  });
});

describe("acronyms and abbreviations", () => {
  it("BOE is spelled out", () => {
    expect(one(acronymsRule, "publicada en el BOE núm. 288")).toBe(
      "publicada en el B O E núm. 288",
    );
  });
  it("UE in parentheses is spelled out", () => {
    expect(one(acronymsRule, "Reglamento (UE) 2017/1129")).toBe(
      "Reglamento (U E) 2017/1129",
    );
  });
  it("núm. expands to número", () => {
    expect(one(abbreviationsRule, "BOE núm. 288")).toBe("BOE número 288");
  });
  it("ordinals", () => {
    expect(one(ordinalsRule, "1.º Las entidades")).toBe("primero. Las entidades");
    expect(one(ordinalsRule, "disposición adicional 3ª")).toBe(
      "disposición adicional tercera",
    );
  });
  it("slash citations become paused numbers", () => {
    expect(one(slashCitationsRule, "Ley 47/2003")).toBe("Ley 47, 2003");
  });
  it("en-dash ranges become 'a'", () => {
    expect(one(rangesRule, "entre 10–15 años")).toBe("entre 10 a 15 años");
  });
});

describe("full Listen pipeline spot checks", () => {
  it("reads a dense regulatory sentence deterministically", () => {
    const out = run(
      "Las entidades deberán remitir la información antes del día 15/07/2024, a más tardar, con un umbral de 1.234.567,89 € (8,5 % del total).",
    );
    expect(out).toContain("deberán");
    expect(out).toContain("a más tardar");
    expect(out).toContain("quince de julio de dos mil veinticuatro");
    expect(out).toContain(
      "un millón doscientos treinta y cuatro mil quinientos sesenta y siete euros con ochenta y nueve céntimos",
    );
    expect(out).toContain("ocho coma cinco por ciento");
    expect(out).not.toMatch(/(?<![0-9])15(?![0-9])\d/);
  });
  it("is stable across runs", () => {
    const text = "Artículo 5. Plazo: 10 días, ratio del 2,5 % y 30 pb.";
    expect(run(text)).toBe(run(text));
  });
});
