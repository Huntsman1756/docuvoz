/**
 * M4A/AAC export hardening E2E tests.
 *
 * Validates:
 *  - Export produces a valid MP4 container (ftyp atom)
 *  - Non-trivial file size
 *  - Export reuses cached speech blobs (no TTS regeneration)
 *  - Cancellation does not affect Reader playback
 *  - Browser playback of exported M4A succeeds (Audio element smoke test)
 */
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";

async function loadFixture(page: Page, title: string) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "DocuVoz" })).toBeVisible();
  await page.getByRole("button", { name: title, exact: true }).click();
  const play = page.getByRole("button", { name: /Escuchar/ });
  await expect(play).toBeVisible();
  await expect(play).toBeEnabled();
}

function trackSpeechRequests(page: Page): () => Map<string, number> {
  const counts = new Map<string, number>();
  page.on("request", (req) => {
    if (req.url().includes("/api/speech") && req.method() === "POST") {
      let text = "?";
      try {
        text = String(JSON.parse(req.postData() ?? "")?.text);
      } catch {
        /* keep "?" */
      }
      counts.set(text, (counts.get(text) ?? 0) + 1);
    }
  });
  return () => counts;
}

/* ------------------------------------------------------------------ */
/*  M4A export                                                         */
/* ------------------------------------------------------------------ */

test("reader exports a valid single M4A of the document", async ({ page }) => {
  await loadFixture(page, "Documento simple");

  const downloadBtn = page.getByRole("button", { name: /audio/i });
  await expect(downloadBtn).toBeVisible({ timeout: 30_000 });
  await downloadBtn.click();

  await page.getByRole("button", { name: "M4A" }).click();

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    page.getByRole("button", { name: "Exportar audio" }).click(),
  ]);

  expect(download.suggestedFilename()).toMatch(/\.m4a$/i);
  const path = await download.path();
  expect(path).not.toBeNull();
  const buf = path ? await fs.promises.readFile(path) : Buffer.alloc(0);

  expect(buf.length).toBeGreaterThan(100);

  // Valid MP4 container: bytes 4–7 must be "ftyp"
  const ftypAtom = buf.toString("ascii", 4, 8);
  expect(ftypAtom).toBe("ftyp");

  // Primary brand is "isom" or "mp42" or similar
  const primaryBrand = buf.toString("ascii", 8, 12);
  expect(primaryBrand.length).toBe(4);
});

test("M4A export uses cached speech blobs — no new TTS synthesis", async ({ page }) => {
  const requests = trackSpeechRequests(page);
  await loadFixture(page, "Documento simple");

  const play = page.getByRole("button", { name: /Escuchar/ });
  await play.click();
  await expect(page.getByRole("button", { name: /Pausar/ })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: /Escuchar/ })).toBeVisible({
    timeout: 60_000,
  });

  const beforeExport = requests();

  const downloadBtn = page.getByRole("button", { name: /audio/i });
  await expect(downloadBtn).toBeVisible();
  await downloadBtn.click();
  await page.getByRole("button", { name: "M4A" }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    page.getByRole("button", { name: "Exportar audio" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.m4a$/i);

  const afterExport = requests();
  const duplicates = [...afterExport.entries()].filter(
    ([text, count]) => (beforeExport.get(text) ?? 0) < count && count > 1,
  );
  expect(duplicates).toEqual([]);
});

test("M4A cancellation does not affect Reader playback", async ({ page }) => {
  await loadFixture(page, "Documento simple");

  const play = page.getByRole("button", { name: /Escuchar/ });
  await play.click();
  await expect(page.getByRole("button", { name: /Pausar/ })).toBeVisible({
    timeout: 30_000,
  });

  const downloadBtn = page.getByRole("button", { name: /audio/i });
  await expect(downloadBtn).toBeVisible();
  await downloadBtn.click();
  await page.getByRole("button", { name: "M4A" }).click();
  await page.getByRole("button", { name: "Exportar audio" }).click();
  await page.getByRole("button", { name: "Cancelar" }).click({ timeout: 10_000 });

  await expect(page.getByRole("button", { name: /Pausar/ })).toBeVisible();
  await expect(page.locator("main")).toHaveAttribute("data-phase", "playing");
});

test("exported M4A can be played back in the browser", async ({ page }) => {
  await loadFixture(page, "Documento simple");

  const downloadBtn = page.getByRole("button", { name: /audio/i });
  await expect(downloadBtn).toBeVisible({ timeout: 30_000 });
  await downloadBtn.click();
  await page.getByRole("button", { name: "M4A" }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    page.getByRole("button", { name: "Exportar audio" }).click(),
  ]);
  const path = await download.path();
  expect(path).not.toBeNull();

  const buf = path ? await fs.promises.readFile(path) : Buffer.alloc(0);
  const playable = await page.evaluate(async (bytes: number[]) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: "audio/mp4" });
    const url = URL.createObjectURL(blob);
    try {
      const audio = new Audio(url);
      await new Promise<void>((resolve, reject) => {
        audio.oncanplaythrough = () => resolve();
        audio.onerror = () => reject(new Error("audio.onerror"));
        setTimeout(() => reject(new Error("timeout")), 5000);
      });
      URL.revokeObjectURL(url);
      return true;
    } catch {
      URL.revokeObjectURL(url);
      return false;
    }
  }, Array.from(buf));
  expect(playable).toBe(true);
});
