/**
 * Minimal Personal Reader E2E (mock provider, CI-safe): the two NEW central
 * reader features — playback and single-WAV export. No experimental metrics,
 * no benchmarks: just prove they work end to end.
 */
import { expect, test } from "@playwright/test";
import fs from "node:fs";

async function loadSimpleDoc(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Lector de documentos" })).toBeVisible();
  await page.getByRole("button", { name: "Documento simple", exact: true }).click();
  // Controls appear once the plan/chunks are ready and the primary button is enabled.
  const play = page.getByRole("button", { name: /Escuchar/ });
  await expect(play).toBeVisible();
  await expect(play).toBeEnabled();
}

test("reader plays mock audio through to the end", async ({ page }) => {
  await loadSimpleDoc(page);

  const speech = page.waitForResponse(
    (res) => res.url().includes("/api/speech") && res.request().method() === "POST",
    { timeout: 30_000 },
  );

  await page.getByRole("button", { name: /Escuchar/ }).click();
  const res = await speech;
  expect(res.ok()).toBeTruthy();
  expect(res.headers()["content-type"]).toContain("audio");

  // playing → the control becomes pause; when the (single) chunk finishes it flips back.
  await expect(page.getByRole("button", { name: /Pausar/ })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: /Escuchar/ })).toBeVisible({
    timeout: 60_000,
  });
});

test("reader exports a valid single WAV of the document", async ({ page }) => {
  await loadSimpleDoc(page);

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30_000 }),
    page.getByRole("button", { name: /Descargar audio/ }).click(),
  ]);

  expect(download.suggestedFilename()).toMatch(/\.wav$/i);
  const path = await download.path();
  expect(path).not.toBeNull();
  const buf = path ? await fs.promises.readFile(path) : Buffer.alloc(0);

  // Real WAV container: RIFF....WAVE + a data chunk + non-trivial size.
  expect(buf.length).toBeGreaterThan(44);
  expect(buf.subarray(0, 4).toString("ascii")).toBe("RIFF");
  expect(buf.subarray(8, 12).toString("ascii")).toBe("WAVE");
  expect(buf.toString("ascii", 36, 40)).toBe("data");

  const byteRate = buf.readUInt32LE(28);
  const dataLen = buf.readUInt32LE(40);
  expect(byteRate).toBeGreaterThan(0);
  expect(dataLen).toBeGreaterThan(0);
  // Header data-size must match the actual payload (a well-formed single file).
  expect(buf.length).toBe(44 + dataLen);
});
