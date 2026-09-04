/**
 * Live Edge TTS/Ximena smoke test.
 *
 * Verifies the full playback pipeline with a real Edge TTS voice.
 */
import { expect, test } from "@playwright/test";

test("Edge TTS/Ximena: playback smoke test", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "DocuVoz" })).toBeVisible();

  // Load fixture
  await page.getByRole("button", { name: "Documento simple", exact: true }).click();
  await expect(page.getByRole("button", { name: /Escuchar/ })).toBeVisible();

  // Select Edge engine
  await page.getByRole("button", { name: "Opciones avanzadas" }).click();
  await page.getByLabel("motor de voz", { exact: true }).selectOption("edge");
  await page.getByLabel("voz", { exact: true }).selectOption("es-ES-XimenaNeural");

  // Click Play
  await page.getByRole("button", { name: /Escuchar/ }).click();

  // Wait for playback to start (Edge TTS may take time)
  // Use the transport bar play/pause button which is more reliable
  const transportPause = page.locator(".reader-transport-play");
  await expect(transportPause).toBeVisible({ timeout: 90_000 });

  // Immediately pause (don't wait - audio may be short)
  await transportPause.click();

  // Verify paused state (button shows play icon ▶)
  await expect(transportPause).toHaveText("▶");

  // Resume
  await transportPause.click();
  await page.waitForTimeout(500);

  // Change speed
  await page.getByLabel("velocidad de reproducción").selectOption("1.5");
  await page.waitForTimeout(500);

  // Verify still in a valid state
  const phase = await page.locator("main").getAttribute("data-phase");
  expect(["playing", "paused", "ready"]).toContain(phase);

  // Document switch
  const pdf = await page.request.get("/corpus/pdfs/simple-01.pdf");
  const body = await pdf.body();
  await page.locator('input[type="file"]').setInputFiles({
    name: "simple-01.pdf",
    mimeType: "application/pdf",
    buffer: body,
  });
  await expect(page.getByRole("heading", { name: "simple-01.pdf" })).toBeVisible({
    timeout: 30_000,
  });

  // No AbortError
  const abortErrors = errors.filter(
    (e) => e.includes("AbortError") || e.includes("signal is aborted"),
  );
  expect(abortErrors).toHaveLength(0);
});
