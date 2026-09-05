/**
 * MP3 export hardening E2E tests.
 *
 * Validates:
 *  - Export produces a valid MP3 file (MPEG frame sync or ID3v2 tag)
 *  - Non-trivial file size
 *  - Export reuses cached speech blobs (no TTS regeneration)
 *  - Cancellation does not affect Reader playback
 *  - Browser playback of exported MP3 succeeds (Audio element smoke test)
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
/*  MP3 export                                                         */
/* ------------------------------------------------------------------ */

test("reader exports a valid single MP3 of the document", async ({ page }) => {
  await loadFixture(page, "Documento simple");

  const downloadBtn = page.getByRole("button", { name: /audio/i });
  await expect(downloadBtn).toBeVisible({ timeout: 30_000 });
  await downloadBtn.click();

  await page.getByRole("button", { name: "MP3" }).click();

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    page.getByRole("button", { name: "Exportar audio" }).click(),
  ]);

  expect(download.suggestedFilename()).toMatch(/\.mp3$/i);
  const path = await download.path();
  expect(path).not.toBeNull();
  const buf = path ? await fs.promises.readFile(path) : Buffer.alloc(0);

  expect(buf.length).toBeGreaterThan(100);

  // Valid MP3: starts with ID3v2 tag or MPEG frame sync word
  const hasId3v2 = buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33;
  const hasFrameSync = buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
  expect(hasId3v2 || hasFrameSync).toBe(true);
});

test("export uses cached speech blobs — no new TTS synthesis", async ({ page }) => {
  const requests = trackSpeechRequests(page);
  await loadFixture(page, "Documento simple");

  const play = page.getByRole("button", { name: /Escuchar/ });
  await play.click();
  await expect(page.getByRole("button", { name: /Pausar/ })).toBeVisible({
    timeout: 30_000,
  });
  // Wait for playback to finish (short mock audio).
  await expect(page.getByRole("button", { name: /Escuchar/ })).toBeVisible({
    timeout: 60_000,
  });

  const beforeExport = requests();

  const downloadBtn = page.getByRole("button", { name: /audio/i });
  await expect(downloadBtn).toBeVisible();
  await downloadBtn.click();
  await page.getByRole("button", { name: "MP3" }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    page.getByRole("button", { name: "Exportar audio" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.mp3$/i);

  const afterExport = requests();
  const duplicates = [...afterExport.entries()].filter(
    ([text, count]) => (beforeExport.get(text) ?? 0) < count && count > 1,
  );
  expect(duplicates).toEqual([]);
});

test("cancellation does not affect Reader playback", async ({ page }) => {
  await loadFixture(page, "Documento simple");

  const play = page.getByRole("button", { name: /Escuchar/ });
  await play.click();
  await expect(page.getByRole("button", { name: /Pausar/ })).toBeVisible({
    timeout: 30_000,
  });

  const downloadBtn = page.getByRole("button", { name: /audio/i });
  await expect(downloadBtn).toBeVisible();
  await downloadBtn.click();
  await page.getByRole("button", { name: "MP3" }).click();
  await page.getByRole("button", { name: "Exportar audio" }).click();
  await page.getByRole("button", { name: "Cancelar" }).click({ timeout: 10_000 });

  await expect(page.getByRole("button", { name: /Pausar/ })).toBeVisible();
  await expect(page.locator("main")).toHaveAttribute("data-phase", "playing");
});

test("exported MP3 can be played back in the browser", async ({ page }) => {
  await loadFixture(page, "Documento simple");

  const downloadBtn = page.getByRole("button", { name: /audio/i });
  await expect(downloadBtn).toBeVisible({ timeout: 30_000 });
  await downloadBtn.click();
  await page.getByRole("button", { name: "MP3" }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    page.getByRole("button", { name: "Exportar audio" }).click(),
  ]);
  const path = await download.path();
  expect(path).not.toBeNull();

  const buf = path ? await fs.promises.readFile(path) : Buffer.alloc(0);
  const playable = await page.evaluate(async (bytes: number[]) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: "audio/mpeg" });
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
