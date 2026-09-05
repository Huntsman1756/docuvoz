/**
 * G4b — semantic fidelity human review packet.
 *
 * Listens with the EYES: every transformation the deterministic engine
 * performs on the corpus + golden fixtures, listed as source→spoken with
 * the rule class, for a human to mark "says the right thing?" — no LLM
 * judge, no heuristics. Because Listen is deterministic, exhaustive review
 * of this packet is tractable; a single "N" verdict is a defect and blocks
 * G4B.
 *
 *   npm run g4b:packet
 * Output: evaluation/experiments/g4b/review-packet.csv (verdict columns left
 * empty ON PURPOSE — only a human fills them; regenerate before review,
 * never after starting).
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyRules, LISTEN_RULES } from "../../src/domain/spoken/rules";
import { buildSpokenPlan } from "../../src/domain/spoken/pipeline";
import type { TransformationRecord } from "../../src/domain/spoken/types";
import { ROOT, loadManifest, loadReference } from "./shared";

const OUT_DIR = join(ROOT, "evaluation", "experiments", "g4b");

interface PacketRow {
  id: string;
  origin: "golden" | "corpus";
  constructionClasses: string;
  sourceText: string;
  spokenText: string;
  transformations: string;
}

function summarize(t: readonly TransformationRecord[]): string {
  return t.map((x) => `${x.ruleId}[${x.source} -> ${x.replacement}]`).join(" | ");
}

function collectGoldenRows(): PacketRow[] {
  const dir = join(ROOT, "tests", "fixtures", "golden");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".in.txt"))
    .map((file) => {
      const name = file.replace(/\.in\.txt$/, "");
      const source = readFileSync(join(dir, file), "utf8").trim();
      const result = applyRules(LISTEN_RULES, source);
      return {
        id: `golden:${name}`,
        origin: "golden" as const,
        constructionClasses: [...new Set(result.matches.map((m) => m.ruleId))].join(","),
        sourceText: source,
        spokenText: result.text,
        transformations: summarize(result.matches),
      };
    })
    .filter((r) => r.transformations.length > 0);
}

function collectCorpusRows(): PacketRow[] {
  const rows: PacketRow[] = [];
  for (const entry of loadManifest().entries) {
    if (!entry.reference) continue; // reader-sample fixtures (EPUB/DOCX) have no eval reference
    const plan = buildSpokenPlan(loadReference(entry), "listen");
    for (const segment of plan.segments) {
      if (
        segment.muted ||
        segment.fallbackApplied ||
        segment.transformations.length === 0
      ) {
        continue;
      }
      rows.push({
        id: `corpus:${entry.id}:${segment.id}`,
        origin: "corpus",
        constructionClasses: [
          ...new Set(segment.transformations.map((t) => t.ruleId)),
        ].join(","),
        sourceText: segment.sourceText,
        spokenText: segment.text,
        transformations: summarize(segment.transformations),
      });
    }
  }
  return rows;
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function main(): void {
  const rows = [...collectGoldenRows(), ...collectCorpusRows()];
  mkdirSync(OUT_DIR, { recursive: true });
  const header = [
    "id",
    "origin",
    "construction_classes",
    "source_text",
    "spoken_text",
    "transformations",
    "verdict_y_n",
    "note",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.origin,
        r.constructionClasses,
        r.sourceText,
        r.spokenText,
        r.transformations,
        "",
        "",
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  const path = join(OUT_DIR, "review-packet.csv");
  writeFileSync(path, lines.join("\n") + "\n");
  const byClass = new Map<string, number>();
  for (const r of rows) {
    for (const c of r.constructionClasses.split(",")) {
      byClass.set(c, (byClass.get(c) ?? 0) + 1);
    }
  }
  console.log(`[g4b:packet] ${rows.length} rows -> ${path}`);
  console.log(
    "[g4b:packet] classes: " +
      [...byClass.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([c, n]) => `${c}=${n}`)
        .join(", "),
  );
  console.log("[g4b:packet] G4B stays OPEN until every row has a human verdict.");
}

main();
