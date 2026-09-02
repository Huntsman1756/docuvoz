import { LAYOUT_NOISE_TYPES, type StructuredDocument } from "@/domain/documents/types";
import { mergeProvenance } from "@/domain/provenance/provenance";
import { detectChromeBlocks } from "./layout-noise";
import { applyRules, LISTEN_RULES, type SpokenRule } from "./rules";
import { validateFidelity } from "./fidelity";
import type {
  GoldEntry,
  PlanStats,
  SpokenMode,
  SpokenPlan,
  SpokenSegment,
} from "./types";
import { SPOKEN_ENGINE_VERSION } from "./version";

export interface PlanOptions {
  /** Mute repeated page chrome detected heuristically (Listen only). */
  detectChrome?: boolean;
  /** Override the rule set (evaluation experiments and tests only). */
  rules?: readonly SpokenRule[];
}

/**
 * Build the spoken plan for a document. Deterministic: the same document and
 * engine version always produce the same plan. The source document is never
 * mutated.
 */
export function buildSpokenPlan(
  doc: StructuredDocument,
  mode: SpokenMode,
  options: PlanOptions = {},
): SpokenPlan {
  const chrome =
    mode === "listen" && options.detectChrome !== false
      ? detectChromeBlocks(doc)
      : new Set<string>();

  const segments: SpokenSegment[] = [];
  const stats: PlanStats = {
    blocksTotal: doc.blocks.length,
    segments: 0,
    mutedNoise: 0,
    transformed: 0,
    unchanged: 0,
    rejected: 0,
    ruleHits: {},
  };

  let index = 0;
  for (const block of doc.blocks) {
    const classified = LAYOUT_NOISE_TYPES.has(block.type);
    const isNoise = classified || chrome.has(block.id);
    const provenance = mergeProvenance(doc.id, [block]);
    const id = `s${index++}`;

    if (mode === "literal") {
      segments.push({
        id,
        sourceText: block.text,
        text: block.text,
        provenance,
        transformations: [],
        fidelityOk: true,
        fallbackApplied: false,
      });
      continue;
    }

    if (isNoise) {
      stats.mutedNoise += 1;
      segments.push({
        id,
        sourceText: block.text,
        text: "",
        provenance,
        transformations: [
          { ruleId: "layout-noise", source: block.text, replacement: "" },
        ],
        fidelityOk: true,
        fallbackApplied: false,
        muted: true,
        mutedBy: classified ? "layout-classification" : "repeat-detector",
      });
      continue;
    }

    const result = applyRules(options.rules ?? LISTEN_RULES, block.text);

    // Prosodic boundary after headings: TTS engines pause on commas.
    let spoken = result.text;
    if (block.type === "heading" && spoken.length > 0) {
      spoken = `${spoken.replace(/[:.]+$/, "")},`;
      result.matches.push({
        ruleId: "pause",
        source: "",
        replacement: ", ",
        index: spoken.length,
        valuePreserving: true,
      });
    }

    const fidelity = validateFidelity(block.text, spoken, result.matches);
    if (!fidelity.ok) {
      stats.rejected += 1;
      segments.push({
        id,
        sourceText: block.text,
        text: block.text,
        provenance,
        transformations: result.matches.map((m) => ({
          ruleId: m.ruleId,
          source: m.source,
          replacement: m.replacement,
        })),
        fidelityOk: false,
        fallbackApplied: true,
      });
      continue;
    }

    if (result.matches.length === 0) {
      stats.unchanged += 1;
    } else {
      stats.transformed += 1;
      for (const m of result.matches) {
        stats.ruleHits[m.ruleId] = (stats.ruleHits[m.ruleId] ?? 0) + 1;
      }
    }
    segments.push({
      id,
      sourceText: block.text,
      text: spoken,
      provenance,
      transformations: result.matches.map((m) => ({
        ruleId: m.ruleId,
        source: m.source,
        replacement: m.replacement,
      })),
      fidelityOk: true,
      fallbackApplied: false,
    });
  }

  stats.segments = segments.filter((s) => !s.muted).length;
  return {
    documentId: doc.id,
    mode,
    spokenEngineVersion: SPOKEN_ENGINE_VERSION,
    segments,
    stats,
  };
}

/**
 * Manual Gold plan: manually authored spoken representations used only as an
 * experimental upper bound (G3a). Never generated automatically.
 */
export function buildGoldPlan(
  doc: StructuredDocument,
  gold: readonly GoldEntry[],
): SpokenPlan {
  const segments: SpokenSegment[] = [];
  let index = 0;
  for (const entry of gold) {
    const block = doc.blocks.find((b) => b.id === entry.blockId);
    if (!block) continue;
    segments.push({
      id: `g${index++}`,
      sourceText: block.text,
      text: entry.spokenText,
      provenance: mergeProvenance(doc.id, [block]),
      transformations: [],
      fidelityOk: true,
      fallbackApplied: false,
    });
  }
  return {
    documentId: doc.id,
    mode: "listen",
    spokenEngineVersion: "manual-gold",
    segments,
    stats: {
      blocksTotal: doc.blocks.length,
      segments: segments.length,
      mutedNoise: 0,
      transformed: segments.length,
      unchanged: 0,
      rejected: 0,
      ruleHits: {},
    },
  };
}
