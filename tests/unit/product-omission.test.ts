import { expect, it } from "vitest";
import { buildProductSpokenPlan as buildSpokenPlan } from "@/lib/product-spoken-plan";
import { buildSpokenPlan as buildResearchPlan } from "@/domain/spoken/pipeline";
import type { StructuredDocument } from "@/domain/documents/types";

const obligations = [
  "El interesado deberá presentar la declaración.",
  "El pago deberá realizarse antes del 31 de diciembre.",
  "Importe máximo: 25.000 EUR.",
  "No se admitirán solicitudes fuera de plazo.",
  "Artículo 57.1.b).",
  "Límite: 15%.",
  "Plazo: diez días.",
  "Es obligatorio adjuntar el justificante.",
  "Si falta la firma, se rechaza.",
  "Atención: peligro.",
  "Identificador: ABC-XY.",
];
it.each(obligations)("retains repeated semantic content: %s", (text) => {
  const doc: StructuredDocument = {
    id: "repeat",
    source: { name: "repeat.pdf", language: "es" },
    parser: "test",
    parserVersion: "0",
    blocks: [1, 2, 3].map((page, order) => ({
      id: `b${order}`,
      type: "paragraph",
      text,
      page,
      order,
    })),
  };
  const plan = buildSpokenPlan(doc, "listen");
  expect(plan.segments.every((s) => !s.muted && s.text.length > 0)).toBe(true);
});

it("requires an explicit safety decision even for classified layout blocks", () => {
  const doc: StructuredDocument = {
    id: "chrome",
    source: { name: "chrome.pdf", language: "es" },
    parser: "test",
    parserVersion: "0",
    blocks: [1, 2, 3].flatMap((page) => [
      {
        id: `h${page}`,
        type: "page-header" as const,
        text: "Boletín Oficial del Estado",
        page,
        order: 0,
      },
      {
        id: `f${page}`,
        type: "page-footer" as const,
        text: "Pie de página",
        page,
        order: 1,
      },
      {
        id: `n${page}`,
        type: "page-number" as const,
        text: String(page),
        page,
        order: 2,
      },
      { id: `d${page}`, type: "paragraph" as const, text: "---", page, order: 3 },
      ...obligations.map((text, i) => ({
        id: `s${page}-${i}`,
        type: "page-footer" as const,
        text,
        page,
        order: i + 4,
      })),
    ]),
  };
  const plan = buildSpokenPlan(doc, "listen");
  expect(plan.segments.filter((s) => s.muted)).toHaveLength(12);
  expect(
    plan.segments
      .filter((s) => obligations.includes(s.sourceText))
      .every((s) => !s.muted && s.text.length > 0),
  ).toBe(true);
  // Product safety never modifies the input document or frozen Listen behavior.
  expect(
    buildResearchPlan(doc, "listen")
      .segments.filter((s) => obligations.includes(s.sourceText))
      .every((s) => s.muted),
  ).toBe(true);
  expect(buildSpokenPlan(doc, "literal")).toEqual(buildResearchPlan(doc, "literal"));
});
