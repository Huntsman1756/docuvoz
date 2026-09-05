import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { buildSpokenPlan } from "@/domain/spoken/pipeline";
import { planChunks } from "@/domain/spoken/speech-plan";
import { loadManifest, loadReference } from "../../evaluation/scripts/shared";
import hashes from "./research-compat-hashes.json";

// Baseline captured against the unchanged research pipeline and checkpoint
// 3f5b73e's actual chunker (transpiled, not copied into the test). All eight
// checkpoint/current chunk arrays matched before these hashes were saved.
it("preserves every historical reference plan and speech chunk byte for byte", () => {
  const actual: Record<string, string> = {};
  for (const entry of loadManifest().entries.filter((e) => e.reference)) {
    const doc = loadReference(entry);
    for (const mode of ["literal", "listen"] as const) {
      const plan = buildSpokenPlan(doc, mode);
      const chunks = planChunks(plan);
      actual[`${entry.id}/${mode}`] = createHash("sha256")
        .update(JSON.stringify({ plan, chunks }))
        .digest("hex");
    }
  }
  expect(actual).toEqual(hashes);
});
