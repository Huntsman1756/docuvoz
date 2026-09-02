/**
 * Spoken-transformation evaluation (input to gate G3b).
 *
 * Runs the deterministic engine over every fixture (reference documents, so
 * inputs are stable) and reports transformation activity: what rules fire,
 * how much stays unchanged, how much is rejected by the fidelity gate — and,
 * where a Manual Gold file exists, the agreement between the engine and the
 * human-authored upper bound.
 *
 * Agreement is a lexical proxy (word-level Dice). It says "the machine
 * approach produced similar words", NOT "it sounds as good" — that judgment
 * is the human part of G3b (evaluation/results/g3b.csv).
 *
 * Run: npm run eval:spoken
 */
import { buildSpokenPlan } from "../../src/domain/spoken/pipeline";
import {
  diceSimilarity,
  loadGold,
  loadManifest,
  loadReference,
  normalizeText,
  writeResult,
} from "./shared";

interface FixtureSpoken {
  fixtureId: string;
  category: string;
  stats: {
    blocksTotal: number;
    segments: number;
    transformed: number;
    unchanged: number;
    rejected: number;
    mutedNoise: number;
  };
  transformedRatio: number;
  rejectedRatio: number;
  ruleHits: Record<string, number>;
  ruleCoverage: { fired: number; total: number };
  goldAgreement: {
    entries: number;
    meanSimilarity: number | null;
    exactMatches: number;
    details: { blockId: string; similarity: number; listen: string; gold: string }[];
  };
}

async function main(): Promise<void> {
  const manifest = loadManifest();
  const { LISTEN_RULES } = await import("../../src/domain/spoken/rules/index");
  const fixtures: FixtureSpoken[] = [];

  for (const entry of manifest.entries) {
    if (!entry.reference) continue;
    const doc = loadReference(entry);
    const plan = buildSpokenPlan(doc, "listen");
    const spoken = plan.segments.filter((s) => !s.muted);
    const transformed = spoken.filter((s) => s.transformations.length > 0).length;
    const rejected = spoken.filter((s) => s.fallbackApplied).length;

    const gold = loadGold(entry);
    const details: FixtureSpoken["goldAgreement"]["details"] = [];
    let exact = 0;
    if (gold) {
      for (const g of gold) {
        const segment = plan.segments.find((s) => s.provenance.blockIds[0] === g.blockId);
        if (!segment) continue;
        const sim = diceSimilarity(g.spokenText, segment.text);
        if (normalizeText(g.spokenText) === normalizeText(segment.text)) exact += 1;
        details.push({
          blockId: g.blockId,
          similarity: round(sim),
          listen: segment.text,
          gold: g.spokenText,
        });
      }
    }

    fixtures.push({
      fixtureId: entry.id,
      category: entry.category,
      stats: { ...plan.stats },
      transformedRatio: round(transformed / Math.max(1, spoken.length)),
      rejectedRatio: round(rejected / Math.max(1, spoken.length)),
      ruleHits: plan.stats.ruleHits,
      ruleCoverage: {
        fired: Object.keys(plan.stats.ruleHits).length,
        total: LISTEN_RULES.length,
      },
      goldAgreement: {
        entries: gold?.length ?? 0,
        meanSimilarity:
          details.length > 0
            ? round(details.reduce((a, d) => a + d.similarity, 0) / details.length)
            : null,
        exactMatches: exact,
        details,
      },
    });
  }

  const withGold = fixtures.filter((f) => f.goldAgreement.entries > 0);
  const result = {
    generatedAt: new Date().toISOString(),
    gate: "G3b (automatic proxy component)",
    question:
      "How much of the Manual Gold improvement does the deterministic engine capture? (lexical agreement only; human A/B still required)",
    fixtures,
    summary: {
      meanGoldAgreement:
        withGold.length > 0
          ? round(
              withGold.reduce((a, f) => a + (f.goldAgreement.meanSimilarity ?? 0), 0) /
                withGold.length,
            )
          : null,
      totalRejected: fixtures.reduce((a, f) => a + f.stats.rejected, 0),
    },
  };
  const path = writeResult("spoken.json", result);
  console.log(`[eval:spoken] wrote ${path}`);
  for (const f of fixtures) {
    console.log(
      `  ${f.fixtureId}: transformed=${f.stats.transformed}/${f.stats.segments} ` +
        `rejected=${f.stats.rejected} rules=${f.ruleCoverage.fired}/${f.ruleCoverage.total} ` +
        `gold=${f.goldAgreement.meanSimilarity ?? "n/a"}`,
    );
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
