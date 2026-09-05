/**
 * Compatibility regression: the multi-format reader fixtures (EPUB/DOCX) have
 * no extraction/statistical reference export, so the research evaluation
 * scripts skip any corpus entry without `reference`. This must only ever
 * exclude those new reader samples — never a pre-existing reference-based
 * corpus item — otherwise the G2/G3/G4B sample count silently shrinks.
 */
import { describe, expect, it } from "vitest";
import { loadManifest } from "../../evaluation/scripts/shared";

/** The historical research fixtures, all of which carry a reference export. */
const RESEARCH_FIXTURES = [
  "nested-regulation-01",
  "financial-report-01",
  "extraction-artifacts-01",
  "simple-01",
] as const;

describe("evaluation corpus compatibility", () => {
  const manifest = loadManifest();
  const entries = manifest.entries;

  it("every pre-existing research fixture still has a reference export", () => {
    const ids = new Set(entries.map((e) => e.id));
    for (const id of RESEARCH_FIXTURES) {
      expect(ids.has(id), `research fixture ${id} must remain in the corpus`).toBe(true);
    }
    for (const id of RESEARCH_FIXTURES) {
      const entry = entries.find((e) => e.id === id);
      expect(
        entry?.reference,
        `research fixture ${id} must keep its reference`,
      ).toBeTruthy();
    }
  });

  it("only the reader-sample fixtures (EPUB/DOCX) are reference-less", () => {
    const referenceLess = entries
      .filter((e) => !e.reference)
      .map((e) => e.id)
      .sort();
    expect(referenceLess).toEqual(["sample-docx-01", "sample-epub-01"]);
  });

  it("the eval filter (skip !reference) yields exactly the research fixtures", () => {
    const evaluated = entries
      .filter((e) => e.reference)
      .map((e) => e.id)
      .sort();
    expect(evaluated).toEqual([...RESEARCH_FIXTURES].sort());
  });

  it("no reference-based fixture is accidentally dropped by the skip filter", () => {
    const evaluated = new Set(entries.filter((e) => e.reference).map((e) => e.id));
    for (const id of RESEARCH_FIXTURES) {
      expect(evaluated.has(id)).toBe(true);
    }
    // Reference-less reader samples never enter a research evaluation.
    const evaluatedIds = [...evaluated];
    expect(evaluatedIds).not.toContain("sample-epub-01");
    expect(evaluatedIds).not.toContain("sample-docx-01");
  });
});
