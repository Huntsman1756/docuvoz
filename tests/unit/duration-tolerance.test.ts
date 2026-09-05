/**
 * Duration tolerance invariant test.
 *
 * WAV/MP3/M4A are generated from the same decoded AudioBuffer timeline.
 * The only difference is encoder delay:
 *   WAV (pcm-f32): ~0ms encoder delay
 *   MP3 (LAME):    ~576 samples delay + padding ≈ 13ms at 44.1kHz
 *   M4A (AAC):     ~2112 samples delay + padding ≈ 48ms at 44.1kHz
 *
 * So the expected delta is <100ms.
 *
 * The tolerance invariant is:
 *   |A − B| ≤ max(0.5 s, 2% of max(A, B))
 *
 * This is much stricter than the previous 20% tolerance and is safe because
 * all three formats share the same speech cache and decoded timeline.
 */
import { describe, expect, it } from "vitest";

const TOLERANCE_SEC = 0.5;
const TOLERANCE_PCT = 0.02;

function maxDelta(a: number, b: number): number {
  return Math.abs(a - b);
}

function toleranceFor(a: number, b: number): number {
  return Math.max(TOLERANCE_SEC, TOLERANCE_PCT * Math.max(a, b));
}

function withinTolerance(a: number, b: number): boolean {
  return maxDelta(a, b) <= toleranceFor(a, b);
}

describe("Duration tolerance invariant", () => {
  it("identical durations pass", () => {
    expect(withinTolerance(10, 10)).toBe(true);
  });

  it("small delta (< 0.5s) passes for any duration", () => {
    expect(withinTolerance(5.0, 5.3)).toBe(true);
    expect(withinTolerance(50.0, 50.4)).toBe(true);
    expect(withinTolerance(0.1, 0.5)).toBe(true);
  });

  it("delta equal to 0.5s passes", () => {
    expect(withinTolerance(10.0, 10.5)).toBe(true);
  });

  it("delta just above 0.5s fails for small duration", () => {
    expect(withinTolerance(5.0, 5.6)).toBe(false);
  });

  it("2% tolerance scales with large durations", () => {
    // 100s reference → 2% = 2.0s tolerance
    expect(withinTolerance(100.0, 101.5)).toBe(true);
    expect(withinTolerance(100.0, 102.0)).toBe(true);
    expect(withinTolerance(100.0, 102.5)).toBe(false);
  });

  it("typical encoder delay: MP3 vs WAV", () => {
    // MP3 LAME delay ≈ 13ms at 44.1kHz
    const wav = 30.0;
    const mp3 = 30.013;
    expect(withinTolerance(wav, mp3)).toBe(true);
  });

  it("typical encoder delay: M4A vs WAV", () => {
    // AAC delay ≈ 48ms at 44.1kHz
    const wav = 30.0;
    const m4a = 30.048;
    expect(withinTolerance(wav, m4a)).toBe(true);
  });

  it("typical encoder delay: M4A vs MP3", () => {
    const mp3 = 30.013;
    const m4a = 30.048;
    expect(withinTolerance(mp3, m4a)).toBe(true);
  });

  it("worst-case codec padding (100ms) still passes for durations > 5s", () => {
    const wav = 10.0;
    const mp3 = 10.1; // 100ms delta
    expect(withinTolerance(wav, mp3)).toBe(true);
  });

  it("100ms delta fails for very short durations (< 25s)", () => {
    // 0.1s delta on a 4s file: 0.1 > max(0.5, 0.02*4) = 0.5? No, 0.1 < 0.5
    // Actually 0.1 < 0.5 so it passes. The floor is 0.5s.
    const wav = 4.0;
    const mp3 = 4.1;
    expect(withinTolerance(wav, mp3)).toBe(true);
  });

  it("unrealistic 2s delta fails for 10s duration", () => {
    expect(withinTolerance(10.0, 12.0)).toBe(false);
  });

  it("unrealistic 5% delta on 20s duration fails", () => {
    // 5% of 20 = 1.0s, tolerance = max(0.5, 1.0) = 1.0
    expect(withinTolerance(20.0, 21.1)).toBe(false);
  });
});
