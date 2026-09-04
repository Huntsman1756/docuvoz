/**
 * Reader phase state machine — pure function tests.
 *
 * Verifies the explicit reader state model that powers the product UI.
 * Each test exercises the phase transitions that correspond to the P0 bugs:
 *  1. Play before ready → preparing state is visible.
 *  2. Document switching invalidates old state.
 *  3. Export is a distinct phase.
 */
import { describe, expect, it } from "vitest";
import { deriveReaderPhase, PHASE_LABELS, type ReaderPhase } from "@/lib/reader-phase";

/* ------------------------------------------------------------------ */
/*  Label tests                                                        */
/* ------------------------------------------------------------------ */

describe("PHASE_LABELS", () => {
  it("has a label for every phase", () => {
    const phases: ReaderPhase[] = [
      "empty",
      "loading",
      "extracting",
      "preparing",
      "ready",
      "playing",
      "paused",
      "exporting",
      "error",
    ];
    for (const p of phases) {
      expect(PHASE_LABELS[p]).toBeDefined();
      expect(typeof PHASE_LABELS[p]).toBe("string");
    }
  });

  it("shows a product-facing label (no jargon)", () => {
    for (const [phase, label] of Object.entries(PHASE_LABELS)) {
      if (phase === "empty") continue;
      expect(label).not.toContain("phase");
      expect(label).not.toContain("raw");
    }
    expect(PHASE_LABELS.preparing).toMatch(/audio/i);
    expect(PHASE_LABELS.exporting).toMatch(/descarga/i);
  });
});

/* ------------------------------------------------------------------ */
/*  Phase derivation tests                                             */
/* ------------------------------------------------------------------ */

describe("deriveReaderPhase", () => {
  /* ---- empty state ---- */
  it("returns empty when no document is loaded", () => {
    expect(deriveReaderPhase("empty", "idle", false, false, false, false, null)).toBe(
      "empty",
    );
  });

  /* ---- loading state ---- */
  it("returns loading during file read", () => {
    expect(deriveReaderPhase("loading", "idle", false, false, false, false, null)).toBe(
      "loading",
    );
  });

  /* ---- extracting state ---- */
  it("returns extracting during PDF parsing", () => {
    expect(
      deriveReaderPhase("extracting", "idle", false, false, false, false, null),
    ).toBe("extracting");
  });

  /* ---- preparing state (P0: play before ready) ---- */
  it("returns preparing when chunks are still generating", () => {
    expect(deriveReaderPhase("ready", "idle", true, false, false, false, null)).toBe(
      "preparing",
    );
  });

  it("returns preparing when the user clicked Play before chunk 0 was ready", () => {
    // queuedPlay = true, firstReady = false → still preparing
    expect(deriveReaderPhase("ready", "idle", true, false, true, false, null)).toBe(
      "preparing",
    );
    // queuedPlay = true, firstReady = true → still preparing (waiting for more chunks)
    expect(deriveReaderPhase("ready", "idle", true, true, true, false, null)).toBe(
      "preparing",
    );
  });

  it("transitions to ready once all chunks are prepared and no queued play", () => {
    expect(deriveReaderPhase("ready", "idle", false, true, false, false, null)).toBe(
      "ready",
    );
  });

  /* ---- playing / paused states ---- */
  it("returns playing when the player is active", () => {
    expect(deriveReaderPhase("ready", "playing", false, true, false, false, null)).toBe(
      "playing",
    );
  });

  it("returns paused when the player is paused", () => {
    expect(deriveReaderPhase("ready", "paused", false, true, false, false, null)).toBe(
      "paused",
    );
  });

  it("returns ready when the player has ended (ready to replay)", () => {
    expect(deriveReaderPhase("ready", "ended", false, true, false, false, null)).toBe(
      "ready",
    );
  });

  /* ---- exporting state ---- */
  it("returns exporting during WAV download", () => {
    expect(deriveReaderPhase("ready", "playing", false, true, false, true, null)).toBe(
      "exporting",
    );
  });

  /* ---- error state ---- */
  it("returns error when there is an error text and not extracting/loading", () => {
    expect(
      deriveReaderPhase("ready", "idle", false, true, false, false, "some error"),
    ).toBe("error");
    // Error during loading or extracting is superseded by those phases
    expect(
      deriveReaderPhase("loading", "idle", false, false, false, false, "error"),
    ).toBe("loading");
    expect(
      deriveReaderPhase("extracting", "idle", false, false, false, false, "error"),
    ).toBe("extracting");
  });

  /* ---- player error overrides ---- */
  it("returns error when the player reports an error", () => {
    expect(deriveReaderPhase("ready", "error", false, true, false, false, null)).toBe(
      "error",
    );
  });

  /* ---- P0: document switching invalidates old state ---- */
  describe("document switch invalidation", () => {
    it("does not leak old player state after switch", () => {
      // Old document was playing; new document starts with idle player.
      // After beginLoad: rawPhase = "loading", playerState = "idle"
      expect(deriveReaderPhase("loading", "idle", false, false, false, false, null)).toBe(
        "loading",
      );
    });

    it("shows preparing for new document while audio generates", () => {
      // New document loaded, extraction done, audio preparing.
      expect(deriveReaderPhase("ready", "idle", true, false, false, false, null)).toBe(
        "preparing",
      );
    });
  });

  /* ---- no jargon leak ---- */
  it("never returns jargon phases", () => {
    const result = deriveReaderPhase("ready", "idle", true, false, false, false, null);
    expect(["preparing", "ready", "playing", "paused"]).toContain(result);
    expect(["loading", "extracting", "exporting", "error"]).not.toContain(result);
  });
});
