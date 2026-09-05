import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("the real fidelity runner evaluates exactly the historical corpus without writing frozen outputs", () => {
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const write = fs.writeFileSync;
    fs.writeFileSync = function(path, data, ...args) {
      if (String(path).replaceAll('\\\\','/').endsWith('/evaluation/results/fidelity.json')) {
        console.log('CAPTURE_RESULT:' + String(data).replace(/\\n/g,''));
        return;
      }
      return write.call(fs,path,data,...args);
    };
    syncBuiltinESMExports();
    await import('./evaluation/scripts/run-fidelity-eval.ts');
  `;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 15000 },
  );
  expect(result.error?.message ?? result.stderr).toBe("");
  expect(result.status).toBe(0);
  const output = result.stdout
    .split("\n")
    .find((line) => line.startsWith("CAPTURE_RESULT:"));
  expect(output).toBeTruthy();
  const report = JSON.parse(output!.slice("CAPTURE_RESULT:".length));
  expect(report.pass).toBe(true);
  expect(report.fallbacksTotal).toBe(0);
  expect(report.reports.map((r: { documentId: string }) => r.documentId).sort()).toEqual(
    [
      "nested-regulation-01",
      "financial-report-01",
      "extraction-artifacts-01",
      "simple-01",
    ]
      .flatMap((id) => [`ref-${id}`, `browser-${id}`])
      .sort(),
  );
});
