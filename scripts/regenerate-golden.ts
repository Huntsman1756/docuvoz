/**
 * Regenerate golden .expected.txt files from the current engine.
 * The output MUST be reviewed by a human before committing: golden files are
 * the contract, the engine is not automatically right.
 *   npx tsx scripts/regenerate-golden.ts
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyRules, LISTEN_RULES } from "../src/domain/spoken/rules/index";

const dir = "tests/fixtures/golden";
for (const file of readdirSync(dir).filter((f) => f.endsWith(".in.txt"))) {
  const source = readFileSync(join(dir, file), "utf8").trim();
  const result = applyRules(LISTEN_RULES, source);
  const out = join(dir, file.replace(/\.in\.txt$/, ".expected.txt"));
  writeFileSync(out, `${result.text}\n`);
  console.log(`--- ${file}`);
  console.log(result.text);
  for (const m of result.matches)
    console.log(`    [${m.ruleId}] "${m.source}" -> "${m.replacement}"`);
}
