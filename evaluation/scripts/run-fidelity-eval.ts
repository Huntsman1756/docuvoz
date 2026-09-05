/**
 * G4a — critical literal preservation (machine-checkable half of fidelity).
 *
 * INDEPENDENT re-validation of the Listen output: it re-detects critical
 * literals in each segment's source text and checks preservation using only
 * persisted provenance (sourceText, spoken text, transformation records) —
 * deliberately NOT the runtime fidelity verdict — plus, for muted segments,
 * that no meaning-bearing token was silenced.
 *
 * Scope honesty: this proves literals survive, NOT that each transformation
 * is semantically correct to say — that is G4b (human review packet,
 * `npm run g4b:packet`; see ADR-005).
 *
 * Any violation means the gate FAILS and the process exits non-zero:
 * unsafe transformations block progression. Fallbacks are safe but count
 * against engine coverage.
 *
 * Run: npm run eval:fidelity
 */
import { LISTEN_RULES } from "../../src/domain/spoken/rules/index";
import {
  containsAtBoundary,
  findCriticalTokens,
} from "../../src/domain/spoken/critical-tokens";
import { buildSpokenPlan } from "../../src/domain/spoken/pipeline";
import type { SpokenSegment } from "../../src/domain/spoken/types";
import { isPageNumberText } from "../../src/domain/spoken/layout-noise";
import {
  assetPath,
  extractWithBrowserPipeline,
  loadManifest,
  loadReference,
  writeResult,
} from "./shared";
import type { StructuredDocument } from "../../src/domain/documents/types";

const VALUE_PRESERVING = new Map(LISTEN_RULES.map((r) => [r.id, r.valuePreserving]));

const LEGAL_TERM_CATEGORY: Record<string, string> = {
  deberá: "obligations",
  podrá: "permissions",
  "no deberá": "negations",
  "no podrá": "negations",
  "salvo que": "exceptions",
  excepto: "exceptions",
  "sin perjuicio de": "exceptions",
  "no obstante": "exceptions",
  "en ningún caso": "prohibitions",
  "queda prohibido": "prohibitions",
  "siempre que": "conditions",
  "antes de": "deadlines",
  "después de": "deadlines",
  "dentro de": "deadlines",
  "a más tardar": "deadlines",
};

const RULE_CATEGORY: Record<string, string> = {
  numbers: "numbers",
  currencies: "monetary",
  percentages: "percentages",
  "basis-points": "basis-points",
  dates: "dates",
  "dates-iso": "dates",
  "dates-hyphen": "dates",
  "legal-references": "legal-references",
  "keyword-references": "legal-references",
  "roman-headings": "legal-references",
  "provision-abbrev": "legal-references",
  isin: "identifiers",
  lei: "identifiers",
  ordinals: "ordinals",
  time: "times",
  settlement: "settlement",
  ranges: "ranges",
};

interface Violation {
  documentId: string;
  segmentId: string;
  kind: "lost" | "invented" | "muted-meaning";
  token: string;
  source: string;
}

interface DocReport {
  documentId: string;
  tier: "reference" | "browser";
  segments: number;
  muted: number;
  fallbacks: number;
  preserved: Record<string, number>;
  violations: Violation[];
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function checkSegment(segment: SpokenSegment, report: DocReport): void {
  if (segment.muted) {
    const tokens = findCriticalTokens(segment.sourceText);
    const numbers = tokens.filter((t) => t.kind === "number" || t.kind === "ordinal");
    const meaningful = tokens.filter(
      (t) => t.kind === "legal-term" || t.kind === "isin" || t.kind === "lei",
    );
    // Muting geometry-classified page chrome that carries only page numbers
    // (or short repeated headers with dates) is intended behavior; a repeat
    // detector that silences legal meaning, or chrome carrying a legal term /
    // identifier, is a violation.
    const safeChrome =
      segment.mutedBy === "layout-classification" &&
      !meaningful.some((t) => t.kind === "legal-term");
    const pageChrome = isPageNumberText(segment.sourceText) || safeChrome;
    if (meaningful.length > 0 || (numbers.length > 0 && !pageChrome)) {
      report.violations.push({
        documentId: report.documentId,
        segmentId: segment.id,
        kind: "muted-meaning",
        token: meaningful[0]?.text ?? numbers[0]?.text ?? "?",
        source: segment.sourceText.slice(0, 80),
      });
    }
    return;
  }

  const preserved = report.preserved;
  for (const token of findCriticalTokens(segment.sourceText)) {
    if (token.kind === "legal-term") {
      if (containsAtBoundary(segment.text, token.text)) {
        bump(preserved, LEGAL_TERM_CATEGORY[token.text] ?? "legal-terms");
      } else {
        report.violations.push({
          documentId: report.documentId,
          segmentId: segment.id,
          kind: "lost",
          token: token.text,
          source: segment.sourceText.slice(0, 80),
        });
      }
      continue;
    }
    if (containsAtBoundary(segment.text, token.text)) {
      bump(preserved, `${token.kind}-verbatim`);
      continue;
    }
    const covered = segment.transformations.some(
      (t) =>
        containsAtBoundary(t.source, token.text) &&
        VALUE_PRESERVING.get(t.ruleId) === true,
    );
    if (covered) {
      const rule = segment.transformations.find((t) =>
        containsAtBoundary(t.source, token.text),
      );
      bump(preserved, RULE_CATEGORY[rule?.ruleId ?? ""] ?? token.kind);
    } else {
      report.violations.push({
        documentId: report.documentId,
        segmentId: segment.id,
        kind: "lost",
        token: token.text,
        source: segment.sourceText.slice(0, 80),
      });
    }
  }

  for (const token of findCriticalTokens(segment.text)) {
    const exists =
      containsAtBoundary(segment.sourceText, token.text) ||
      segment.transformations.some((t) => containsAtBoundary(t.replacement, token.text));
    if (!exists) {
      report.violations.push({
        documentId: report.documentId,
        segmentId: segment.id,
        kind: "invented",
        token: token.text,
        source: segment.sourceText.slice(0, 80),
      });
    }
  }
}

function evaluate(doc: StructuredDocument, tier: DocReport["tier"]): DocReport {
  const plan = buildSpokenPlan(doc, "listen");
  const report: DocReport = {
    documentId: doc.id,
    tier,
    segments: plan.segments.length,
    muted: plan.segments.filter((s) => s.muted).length,
    fallbacks: plan.segments.filter((s) => s.fallbackApplied).length,
    preserved: {},
    violations: [],
  };
  for (const segment of plan.segments) {
    checkSegment(segment, report);
  }
  return report;
}

async function main(): Promise<void> {
  const manifest = loadManifest();
  const reports: DocReport[] = [];

  for (const entry of manifest.entries) {
    // Product-only EPUB/DOCX samples have no research reference. Keep the
    // historical PDF evaluation cohort identical to extraction/spoken runners.
    if (!entry.reference) continue;
    reports.push(evaluate(loadReference(entry), "reference"));
    const browserDoc = await extractWithBrowserPipeline(
      assetPath(entry.pdf),
      `browser-${entry.id}`,
      `${entry.id}.pdf`,
    );
    reports.push(evaluate(browserDoc, "browser"));
  }

  const violations = reports.flatMap((r) => r.violations);
  const totalFallbacks = reports.reduce((a, r) => a + r.fallbacks, 0);
  const result = {
    generatedAt: new Date().toISOString(),
    gate: "G4A_CRITICAL_LITERAL_PRESERVATION (semantic fidelity is G4b, human-reviewed)",
    pass: violations.length === 0,
    assertion:
      "No critical literal may vanish from a spoken segment without value-preserving coverage; no muted segment may carry legal meaning; no literal may be invented.",
    method:
      "Independent recomputation from persisted provenance (does not trust the runtime fidelity verdict).",
    fallbacksTotal: totalFallbacks,
    note: "Fallbacks are safe (literal text spoken) but indicate missing rule coverage.",
    reports,
  };
  const path = writeResult("fidelity.json", result);
  console.log(
    `[eval:fidelity] wrote ${path} — ${violations.length} violation(s), ${totalFallbacks} safe fallback(s)`,
  );
  for (const v of violations) {
    console.error(
      `  VIOLATION [${v.kind}] ${v.documentId}/${v.segmentId}: "${v.token}" in "${v.source}"`,
    );
  }
  if (!result.pass) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
