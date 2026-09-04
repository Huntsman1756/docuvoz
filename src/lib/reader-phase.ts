/**
 * Pure reader-phase derivation (unit-testable).
 *
 * Used by the Reader component to compute its product-facing state from the
 * raw extraction phase, player state, and preparation progress.
 */
import type { PlayerState } from "@/lib/speech-player";

export type ReaderPhase =
  | "empty"
  | "loading"
  | "extracting"
  | "preparing"
  | "ready"
  | "playing"
  | "paused"
  | "exporting"
  | "error";

/** User-facing label for every reader phase. */
export const PHASE_LABELS: Record<ReaderPhase, string> = {
  empty: "",
  loading: "Cargando PDF…",
  extracting: "Analizando documento…",
  preparing: "Preparando audio…",
  ready: "Listo para escuchar",
  playing: "Reproduciendo",
  paused: "En pausa",
  exporting: "Generando audio para descarga…",
  error: "Error",
};

/**
 * Derive the reader phase from the underlying phase and player state.
 *
 * The returned phase determines everything the UI renders — buttons, labels,
 * progress bars, and text body.  No boolean magic lives in the JSX.
 *
 * Parameters:
 *   rawPhase  — the document lifecycle phase ("empty" | "loading" | "extracting" | "ready" | "error")
 *   playerState — the player's own state
 *   preparing — true while chunks are still being prepared
 *   firstReady — true when the first chunk is available (prepared >= 1 or player != idle)
 *   queuedPlay — true when the user requested Play before audio was ready
 *   exporting  — true during WAV export
 *   errorText  — non-null when an error is displayed (and not during extract/load)
 */
export function deriveReaderPhase(
  rawPhase: "empty" | "loading" | "extracting" | "ready" | "error",
  playerState: PlayerState,
  preparing: boolean,
  firstReady: boolean,
  queuedPlay: boolean,
  exporting: boolean,
  errorText: string | null,
): ReaderPhase {
  if (exporting) return "exporting";
  if (errorText && rawPhase !== "extracting" && rawPhase !== "loading") return "error";
  if (rawPhase === "empty") return "empty";
  if (rawPhase === "loading") return "loading";
  if (rawPhase === "extracting") return "extracting";
  if (playerState === "playing") return "playing";
  if (playerState === "paused") return "paused";
  if (playerState === "error") return "error";
  // While chunks are still being prepared, keep showing "preparing"
  // even if the player is idle (nothing playing yet).
  if (rawPhase === "ready" && preparing) return "preparing";
  if (rawPhase === "ready" && firstReady && !queuedPlay) return "ready";
  // Queued play or still loading the first chunk → preparing
  if (rawPhase === "ready") return "preparing";
  return "ready";
}
