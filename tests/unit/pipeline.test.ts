import { describe, expect, it } from "vitest";
import type { StructuredDocument } from "@/domain/documents/types";
import { buildGoldPlan, buildSpokenPlan } from "@/domain/spoken/pipeline";
import { planChunks } from "@/domain/spoken/speech-plan";
import { regexRule, type SpokenRule } from "@/domain/spoken/rules/core";
import { normalizeChromeKey, detectChromeBlocks } from "@/domain/spoken/layout-noise";

function doc(
  blocks: Partial<StructuredDocument["blocks"][number]>[],
): StructuredDocument {
  return {
    id: "test-doc",
    source: { name: "test.pdf", pageCount: 3, language: "es" },
    parser: "test",
    parserVersion: "0",
    blocks: blocks.map((b, i) => ({
      id: b.id ?? `b${i}`,
      type: b.type ?? "paragraph",
      text: b.text ?? "",
      page: b.page ?? 1,
      order: i,
      ...b,
    })),
  };
}

describe("buildSpokenPlan (literal)", () => {
  it("keeps every block including layout noise, untouched", () => {
    const plan = buildSpokenPlan(
      doc([
        { type: "page-header", text: "BOE-header" },
        { text: "Art. 5. Plazo de 30 días." },
        { type: "page-number", text: "3" },
      ]),
      "literal",
    );
    expect(plan.segments).toHaveLength(3);
    expect(plan.segments[1]?.text).toBe("Art. 5. Plazo de 30 días.");
    expect(plan.segments.every((s) => s.transformations.length === 0)).toBe(true);
  });
});

describe("buildSpokenPlan (listen)", () => {
  const sample = doc([
    { type: "heading", text: "CAPÍTULO I. OBJETO" },
    { text: "La entidad deberá aplicar el art. 5.2 del reglamento." },
    { type: "page-header", text: "encabezado repetido" },
    { type: "page-number", text: "2" },
    { text: "1.234,56 euros" },
  ]);

  it("mutes layout noise, transforms content and preserves provenance", () => {
    const plan = buildSpokenPlan(sample, "listen");
    expect(plan.stats.mutedNoise).toBe(2);
    const article = plan.segments.find((s) => s.sourceText.startsWith("La entidad"));
    expect(article?.text).toContain("artículo cinco, apartado dos");
    expect(article?.text).toContain("deberá");
    expect(article?.provenance.pages).toEqual([1]);
    expect(article?.provenance.documentId).toBe("test-doc");
    const money = plan.segments.find((s) => s.sourceText.includes("1.234,56"));
    expect(money?.text).toContain("mil doscientos treinta y cuatro euros");
    const heading = plan.segments.find((s) => s.sourceText.startsWith("CAPÍTULO"));
    expect(heading?.text.endsWith(",")).toBe(true);
  });

  it("never mutates the source document", () => {
    const source = doc([{ text: "art. 5" }]);
    const before = JSON.stringify(source);
    buildSpokenPlan(source, "listen");
    expect(JSON.stringify(source)).toBe(before);
  });

  it("falls back to literal text when the fidelity validator rejects", () => {
    const destroyer: SpokenRule = regexRule("fake-destroyer", false, /30/g, () => "");
    const plan = buildSpokenPlan(
      doc([{ text: "plazo de 30 días, deberá cumplirse" }]),
      "listen",
      {
        rules: [destroyer],
      },
    );
    const segment = plan.segments[0];
    expect(segment?.fallbackApplied).toBe(true);
    expect(segment?.text).toBe("plazo de 30 días, deberá cumplirse");
    expect(segment?.fidelityOk).toBe(false);
    expect(plan.stats.rejected).toBe(1);
  });
});

describe("buildGoldPlan", () => {
  it("maps manual spoken text to source blocks", () => {
    const source = doc([
      { id: "b0", text: "art. 5" },
      { id: "b1", text: "fin" },
    ]);
    const plan = buildGoldPlan(source, [{ blockId: "b0", spokenText: "artículo cinco" }]);
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0]?.provenance.blockIds).toEqual(["b0"]);
    expect(plan.spokenEngineVersion).toBe("manual-gold");
  });
});

describe("repeated chrome detection", () => {
  it("normalizes only case and whitespace (digits stay significant)", () => {
    expect(normalizeChromeKey("Page  3 of 9")).toBe("page 3 of 9");
  });
  it("detects text repeating across many pages but protects headings", () => {
    const blocks = [];
    for (let page = 1; page <= 4; page++) {
      blocks.push({
        id: `h${page}`,
        text: "Boletín Oficial del Estado — sección de pruebas",
        page,
      });
      blocks.push({
        id: `t${page}`,
        text: `Contenido de la página ${page} con sustancia real.`,
        page,
      });
    }
    const muted = detectChromeBlocks(doc(blocks as never));
    expect(muted.size).toBe(4);
    expect([...muted]).toEqual(["h1", "h2", "h3", "h4"]);
  });
});

describe("planChunks", () => {
  it("packs segments and respects max chars", () => {
    const plan = buildSpokenPlan(
      doc([
        { text: "a".repeat(300) },
        { text: "b".repeat(300) },
        { text: "c".repeat(50) },
      ]),
      "literal",
    );
    const chunks = planChunks(plan, 400);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(401);
      expect(chunk.segmentIds.length).toBeGreaterThan(0);
    }
    const covered = new Set(chunks.flatMap((c) => c.segmentIds));
    expect(covered).toEqual(new Set(plan.segments.map((s) => s.id)));
  });

  it("splits an oversized segment at sentence boundaries", () => {
    const sentences = Array.from(
      { length: 12 },
      (_, i) => `Frase número ${i + 1} de prueba.`,
    ).join(" ");
    const plan = buildSpokenPlan(doc([{ text: sentences }]), "literal");
    const chunks = planChunks(plan, 120);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(121);
    const rejoined = chunks.map((c) => c.text).join(" ");
    expect(rejoined.replace(/\s+/g, " ")).toBe(sentences);
  });

  it("skips muted segments", () => {
    const plan = buildSpokenPlan(
      doc([{ text: "hola" }, { type: "page-number", text: "7" }]),
      "listen",
    );
    const chunks = planChunks(plan, 100);
    expect(chunks.every((c) => !c.text.includes("7"))).toBe(true);
  });
});
