import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyRules } from "@/domain/spoken/rules";
import { LISTEN_RULES } from "@/domain/spoken/rules";
import { validateFidelity } from "@/domain/spoken/fidelity";

const dir = join(process.cwd(), "tests", "fixtures", "golden");
const inputs = readdirSync(dir).filter((f) => f.endsWith(".in.txt"));

describe("golden: source text -> expected spoken text", () => {
  for (const file of inputs) {
    const name = file.replace(/\.in\.txt$/, "");
    const source = readFileSync(join(dir, file), "utf8").trim();
    const expected = readFileSync(join(dir, `${name}.expected.txt`), "utf8").trim();
    it(name, () => {
      const result = applyRules(LISTEN_RULES, source);
      expect(result.text).toBe(expected);
      const fidelity = validateFidelity(source, result.text, result.matches);
      expect(fidelity.lost).toEqual([]);
      expect(fidelity.invented).toEqual([]);
    });
  }
});
