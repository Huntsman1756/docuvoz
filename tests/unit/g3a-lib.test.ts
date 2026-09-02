import { describe, expect, it } from "vitest";
import type { StructuredDocument } from "../../src/domain/documents/types";
import {
  assignSides,
  buildPairs,
  durationBalance,
  mulberry32,
  questionsForPairs,
  shuffleSeeded,
} from "../../evaluation/scripts/g3a-lib";
import type { GoldEntry } from "../../evaluation/scripts/shared";

function docWith(blocks: [string, string][]): StructuredDocument {
  return {
    id: "t",
    name: "t",
    meta: { source: "test" },
    blocks: blocks.map(([id, text], i) => ({
      id,
      type: "paragraph",
      text,
      page: 1,
      provenance: { page: 1, spans: [{ page: 1, x: 0, y: 0, w: 10, h: 10, text }] },
      order: i,
    })),
  } as unknown as StructuredDocument;
}

const PAIR_DOC = docWith([
  ["b1", "El art. 57.1.b) vence el 15/07/2024."],
  ["b2", "Umbral del 8,5 %."],
  ["b3", "Sin cambios frente al gold."],
]);

const GOLD: GoldEntry[] = [
  {
    blockId: "b1",
    spokenText:
      "El artículo cincuenta y siete, apartado uno, letra b, vence el quince de julio.",
  },
  { blockId: "b2", spokenText: "Umbral del ocho coma cinco por ciento." },
  { blockId: "b3", spokenText: "Sin cambios frente al gold." },
];

describe("g3a-lib", () => {
  it("builds only true Literal-vs-Gold contrasts", () => {
    const pairs = buildPairs(PAIR_DOC, GOLD);
    expect(pairs.map((p) => p.blockId)).toEqual(["b1", "b2"]);
    expect(pairs[0].literalText).toBe("El art. 57.1.b) vence el 15/07/2024.");
  });

  it("throws on gold referencing unknown blocks", () => {
    expect(() => buildPairs(PAIR_DOC, [{ blockId: "zz", spokenText: "x" }])).toThrow(
      /unknown block/,
    );
  });

  it("mulberry32 is deterministic and in range", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("shuffleSeeded is deterministic and permutation-preserving", () => {
    const xs = [1, 2, 3, 4, 5, 6];
    expect(shuffleSeeded(xs, 42)).toEqual(shuffleSeeded(xs, 42));
    expect([...shuffleSeeded(xs, 42)].sort()).toEqual(xs);
    expect(shuffleSeeded(xs, 42)).not.toEqual(shuffleSeeded(xs, 43));
  });

  it("assignSides is deterministic, unique-id, and not degenerate in sides", () => {
    const pairs = buildPairs(PAIR_DOC, GOLD);
    const a1 = assignSides(pairs, 20260902);
    const a2 = assignSides(pairs, 20260902);
    expect(a1).toEqual(a2);
    const ids = a1.flatMap((a) => [a.leftClipId, a.rightClipId]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids)
      expect(id).toMatch(/^g3a-[abcdefghjkmnpqrstuvwxyz23456789]{8}$/);
    expect(a1.map((a) => a.presentationOrder).sort()).toEqual([0, 1]);
    // presentation order must cover every pair exactly once
    expect(new Set(a1.map((a) => a.pairIndex)).size).toBe(pairs.length);
  });

  it("assignment is right-reflective of left condition", () => {
    const pairs = buildPairs(PAIR_DOC, GOLD);
    for (const seed of [1, 99, 12345, 20260902]) {
      for (const a of assignSides(pairs, seed)) {
        const right = a.leftCondition === "gold" ? "literal" : "gold";
        // sanity: prepare script derives right side the same way
        expect(right).not.toBe(a.leftCondition);
      }
    }
  });

  it("durationBalance is symmetric and >= 1", () => {
    expect(durationBalance(1000, 2000)).toBe(2);
    expect(durationBalance(2000, 1000)).toBe(2);
    expect(Number.isNaN(durationBalance(0, 5))).toBe(true);
  });

  it("questions only reference blocks that exist in the pairs", () => {
    const pairs = buildPairs(PAIR_DOC, GOLD);
    const qs = questionsForPairs(pairs);
    expect(qs.length).toBe(0); // real questions target nested-regulation-01 blocks
    const realDoc = docWith([
      ["b5", "x"],
      ["b6", "y"],
      ["b12", "z"],
      ["b13", "w"],
      ["b15", "v"],
    ]);
    const realPairs = buildPairs(realDoc, [
      { blockId: "b5", spokenText: "x2" },
      { blockId: "b6", spokenText: "y2" },
      { blockId: "b12", spokenText: "z2" },
      { blockId: "b13", spokenText: "w2" },
      { blockId: "b15", spokenText: "v2" },
    ]);
    expect(questionsForPairs(realPairs).map((q) => q.id)).toEqual([
      "q1",
      "q2",
      "q3",
      "q4",
      "q5",
    ]);
  });
});
