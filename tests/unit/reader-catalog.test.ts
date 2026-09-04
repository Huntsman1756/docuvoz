/**
 * Reader catalog routing rules (pure, no DOM): engine choice per language,
 * voice fallbacks across engine switches.
 */
import { describe, expect, it } from "vitest";
import { defaultVoice, resolveEngine, voicesFor } from "@/lib/voices";

describe("resolveEngine", () => {
  it("keeps the standard engine when edge is not configured", () => {
    expect(resolveEngine("auto", "es", ["default"])).toBe("default");
    expect(resolveEngine("edge", "es", ["default"])).toBe("default");
  });
  it("prefers edge for Spanish and standard for English under auto", () => {
    expect(resolveEngine("auto", "es", ["default", "edge"])).toBe("edge");
    expect(resolveEngine("auto", "en", ["default", "edge"])).toBe("default");
  });
  it("honors explicit choices when available", () => {
    expect(resolveEngine("default", "es", ["default", "edge"])).toBe("default");
    expect(resolveEngine("edge", "en", ["default", "edge"])).toBe("edge");
  });
});

describe("voice catalogs", () => {
  it("edge Spanish voices are Edge neural ids", () => {
    for (const v of voicesFor("es", "edge")) {
      expect(v.id).toMatch(/^[a-z]{2}-[A-Z]{2}-[A-Za-z0-9]+Neural$/);
    }
  });
  it("standard voices stay in the current free list", () => {
    expect(defaultVoice("es", "default")).toBe("ef_dora");
    expect(defaultVoice("en", "default")).toBe("af_heart");
  });
  it("labels never leak provider brands", () => {
    const labels = [
      ...voicesFor("es"),
      ...voicesFor("en"),
      ...voicesFor("es", "edge"),
      ...voicesFor("en", "edge"),
    ].map((v) => v.label);
    for (const l of labels) expect(l).not.toMatch(/kokoro|nan|msedge|edge/i);
  });
});
