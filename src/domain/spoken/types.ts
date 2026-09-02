import type { SegmentProvenance } from "@/domain/provenance/provenance";

export type SpokenMode = "literal" | "listen";

export interface TransformationRecord {
  ruleId: string;
  /** Consumed source substring. */
  source: string;
  /** Spoken replacement. */
  replacement: string;
}

export interface SpokenSegment {
  id: string;
  /** Text exactly as extracted from the document. Never mutated. */
  sourceText: string;
  /** Text handed to the TTS provider. */
  text: string;
  provenance: SegmentProvenance;
  transformations: TransformationRecord[];
  /** Result of the fidelity validation for this segment. */
  fidelityOk: boolean;
  /** True when transformations were rejected and literal text is used. */
  fallbackApplied: boolean;
  /** True when the segment is pure layout noise and will not be spoken. */
  muted?: boolean;
  /** Why a segment was muted (only present when `muted`). */
  mutedBy?: "layout-classification" | "repeat-detector";
}

export interface PlanStats {
  blocksTotal: number;
  segments: number;
  mutedNoise: number;
  transformed: number;
  unchanged: number;
  rejected: number;
  ruleHits: Record<string, number>;
}

export interface SpokenPlan {
  documentId: string;
  mode: SpokenMode;
  spokenEngineVersion: string;
  segments: SpokenSegment[];
  stats: PlanStats;
}

/** Chunk handed to the TTS provider; keeps references to its segments. */
export interface SpeechChunk {
  id: string;
  text: string;
  segmentIds: string[];
}

export interface GoldEntry {
  blockId: string;
  spokenText: string;
}
