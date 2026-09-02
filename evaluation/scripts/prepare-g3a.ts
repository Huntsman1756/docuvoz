/**
 * Build the G3a blind listening kit (product hypothesis: Gold vs Literal).
 *
 *   npm run g3a:prepare -- --dry-run                 # offline plan (no audio)
 *   RUN_LIVE_PROVIDER=1 SPEECH_PROVIDER=nan ... \
 *     npm run g3a:prepare                            # real audio stimuli
 *
 * Outputs under evaluation/experiments/g3a/:
 *   manifest.json      blinded stimulus manifest (committed)
 *   answer-sheet.csv   blinded ratings + preference per pair (committed)
 *   questions.csv      objective comprehension items (committed)
 *   private/key.json   condition mapping + answer key (gitignored)
 *   audio/             generated clips (gitignored; deterministic to rebuild)
 *
 * Audio refuses to come from the mock provider: a tone is not a listening
 * stimulus. Dry-run produces everything except audio so pairing, blinding
 * and balance can be reviewed offline; the experiment itself still requires
 * real audio + human ears (G3A stays OPEN until the sheet is filled).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createProvider, loadConfig } from "../../src/server/config";
import type { SpeechRequest } from "../../src/domain/speech/types";
import { ROOT, loadGold, loadManifest, loadReference, readWavDurationMs } from "./shared";
import {
  assignSides,
  buildPairs,
  durationBalance,
  questionsForPairs,
  type G3aAssignment,
  type G3aPair,
} from "./g3a-lib";

const FIXTURE = "nested-regulation-01";
const OUT_DIR = join(ROOT, "evaluation", "experiments", "g3a");

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function writeCsv(path: string, header: string[], rows: string[][]): void {
  const lines = [header.join(",")];
  for (const row of rows) lines.push(row.map(csvEscape).join(","));
  writeFileSync(path, lines.join("\n") + "\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  let seed = 20260902;
  const seedIdx = argv.indexOf("--seed");
  if (seedIdx >= 0 && argv[seedIdx + 1]) seed = Number(argv[seedIdx + 1]);
  if (!Number.isInteger(seed)) throw new Error("--seed must be an integer");

  const entry = loadManifest().entries.find((e) => e.id === FIXTURE);
  if (!entry) throw new Error(`fixture ${FIXTURE} missing from corpus manifest`);
  const gold = loadGold(entry);
  if (!gold || gold.length === 0) throw new Error(`fixture ${FIXTURE} has no gold file`);
  const pairs: G3aPair[] = buildPairs(loadReference(entry), gold);
  if (pairs.length === 0) throw new Error("no Literal-vs-Gold contrast pairs");
  const assignments: G3aAssignment[] = assignSides(pairs, seed);
  const questions = questionsForPairs(pairs);

  const config = loadConfig();
  const ext = config.NAN_TTS_FORMAT;
  let provider: ReturnType<typeof createProvider> | null = null;
  if (!dryRun) {
    if (config.SPEECH_PROVIDER !== "nan" || process.env.RUN_LIVE_PROVIDER !== "1") {
      console.error(
        "[g3a:prepare] refusing to generate audio: real stimuli require\n" +
          "  RUN_LIVE_PROVIDER=1 SPEECH_PROVIDER=nan + credentials (mock tones are not\n" +
          "  listening stimuli). For the offline plan use: --dry-run",
      );
      process.exit(2);
    }
    provider = createProvider(config);
    console.log(
      `[g3a:prepare] provider=nan pacing=${config.SPEECH_REQUESTS_PER_MINUTE}/min ` +
        `format=${ext} — this consumes real quota.`,
    );
  }

  const audioDir = join(OUT_DIR, "audio");
  const privateDir = join(OUT_DIR, "private");
  mkdirSync(audioDir, { recursive: true });
  mkdirSync(privateDir, { recursive: true });

  interface ClipRow {
    clipId: string;
    pair: number;
    blockId: string;
    side: "left" | "right";
    condition: "literal" | "gold";
    text: string;
    file: string | null;
    audioMs: number | null;
  }
  const clips: ClipRow[] = [];
  for (const a of assignments) {
    const pair = pairs[a.pairIndex];
    const rightCondition = a.leftCondition === "gold" ? "literal" : "gold";
    for (const [clipId, side, condition, text] of [
      [
        a.leftClipId,
        "left",
        a.leftCondition,
        a.leftCondition === "gold" ? pair.goldText : pair.literalText,
      ],
      [
        a.rightClipId,
        "right",
        rightCondition,
        rightCondition === "gold" ? pair.goldText : pair.literalText,
      ],
    ] as const) {
      let file: string | null = null;
      let audioMs: number | null = null;
      if (provider) {
        file = `${clipId}.${ext}`;
        const settings: SpeechRequest["settings"] = {
          provider: "nan",
          model: config.NAN_TTS_MODEL,
          voice: config.NAN_TTS_VOICE,
          speed: config.SPEECH_DEFAULT_SPEED,
          format: config.NAN_TTS_FORMAT,
        };
        const result = await provider.synthesize({ text, settings });
        writeFileSync(join(audioDir, file), result.audio);
        audioMs = readWavDurationMs(result.audio);
        console.log(`  ${clipId} (${condition}) → ${file} ${audioMs ?? "?"}ms`);
      }
      clips.push({
        clipId,
        pair: a.pairIndex,
        blockId: pair.blockId,
        side,
        condition,
        text,
        file,
        audioMs,
      });
    }
  }

  // Balance report (duration where measurable, chars always).
  const balance = assignments.map((a) => {
    const left = clips.find((c) => c.clipId === a.leftClipId)!;
    const right = clips.find((c) => c.clipId === a.rightClipId)!;
    return {
      pair: a.pairIndex,
      charRatio:
        Math.round(
          (Math.max(left.text.length, right.text.length) /
            Math.min(left.text.length, right.text.length)) *
            100,
        ) / 100,
      durationRatio:
        left.audioMs && right.audioMs
          ? durationBalance(left.audioMs, right.audioMs)
          : null,
    };
  });
  const outOfRange = balance.filter(
    (b) => b.durationRatio !== null && b.durationRatio > 2.0,
  );
  if (outOfRange.length > 0) {
    console.warn(
      `[g3a:prepare] WARN pairs with duration ratio > 2.0 (not matched audio): ${outOfRange.map((b) => b.pair).join(", ")}`,
    );
  }

  const audioSeconds = clips.reduce((s, c) => s + (c.audioMs ?? 0), 0) / 1000 / 2; // per condition
  if (provider) {
    console.log(
      `[g3a:prepare] ${pairs.length} pairs, ${clips.length} clips, ` +
        `≈${(audioSeconds / 60).toFixed(1)} min per condition` +
        (audioSeconds / 60 < 8
          ? " — BELOW the 8–12 min target; extend the gold file by hand and rerun"
          : ""),
    );
  } else {
    console.log(
      `[g3a:prepare] ${pairs.length} pairs, ${clips.length} clips (no audio in dry-run)`,
    );
  }

  const targetTotalSeconds = clips.reduce((s, c) => s + (c.audioMs ?? 0), 0) / 1000;

  writeFileSync(
    join(OUT_DIR, "manifest.json"),
    JSON.stringify(
      {
        experiment: "G3a — Literal vs Manual Gold (blind paired comparison)",
        fixture: FIXTURE,
        seed,
        generatedAt: new Date().toISOString(),
        status: provider
          ? "AUDIO GENERATED — awaiting human sessions"
          : "DRY-RUN — audio not generated (G3A remains OPEN)",
        audioFormat: provider ? ext : null,
        audioSecondsPerCondition: provider ? Math.round(targetTotalSeconds / 2) : null,
        ratingScale:
          "comprehension/followability/confidence: 1 worst..5 best; fatigue: 1 least fatiguing..5 most fatiguing",
        balanceReport: balance,
        stimuli: clips.map((c) => ({
          clipId: c.clipId,
          file: c.file,
          audioMs: c.audioMs,
          // The condition is deliberately NOT in the blinded manifest when
          // clips exist... but texts are public (synthetic fixture), so the
          // manifest documents pairing structure; blinding is operational:
          // evaluators see only clip ids + answer sheet, never this file.
          pair: c.pair,
          side: c.side,
          text: c.text,
        })),
      },
      null,
      2,
    ) + "\n",
  );

  writeFileSync(
    join(privateDir, "key.json"),
    JSON.stringify(
      {
        notice:
          "PRIVATE — do not give to evaluators; reveal only after sessions are complete",
        seed,
        clips: clips.map((c) => ({
          clipId: c.clipId,
          pair: c.pair,
          side: c.side,
          condition: c.condition,
          blockId: c.blockId,
        })),
        answerKey: questions.map((q) => ({
          id: q.id,
          acceptableAnswers: q.acceptableAnswers,
        })),
      },
      null,
      2,
    ) + "\n",
  );

  writeCsv(
    join(OUT_DIR, "answer-sheet.csv"),
    [
      "presentation_order",
      "pair",
      "left_clip",
      "right_clip",
      "comprehension_left_1_5",
      "comprehension_right_1_5",
      "followability_left_1_5",
      "followability_right_1_5",
      "fatigue_left_1_5",
      "fatigue_right_1_5",
      "confidence_left_1_5",
      "confidence_right_1_5",
      "preference_left_right_or_none",
      "notes",
    ],
    assignments.map((a) => [
      String(a.presentationOrder),
      String(a.pairIndex),
      a.leftClipId,
      a.rightClipId,
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ]),
  );

  writeCsv(
    join(OUT_DIR, "questions.csv"),
    ["question_id", "question", "evaluator_answer", "correct_y_n"],
    questions.map((q) => [q.id, q.question, "", ""]),
  );

  console.log(
    `[g3a:prepare] wrote manifest.json, answer-sheet.csv, questions.csv (blinded) + private/key.json`,
  );
  if (!provider) {
    console.log(
      "[g3a:prepare] DRY-RUN: G3A stays OPEN. Generate real clips with credentials, then run PROTOCOL.md sessions.",
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
