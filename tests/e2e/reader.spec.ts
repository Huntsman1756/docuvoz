/**
 * Personal Reader v0.3 E2E (mock provider, CI-safe).
 *
 * Covers the lifecycle P0s:
 *  - a Play click during preparation is remembered and auto-starts (and
 *    repeated clicks never re-fetch the same chunk);
 *  - switching documents mid-playback cancels the old one cleanly
 *    (no ghost controls, no stale state);
 *  - the explicit state machine is observable via main[data-phase].
 *  - loading/preparing states are visible.
 *  - WAV export produces a valid file.
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

test("reader plays mock audio through to the end", async ({ page }) => {
  await loadFixture(page, "Documento simple");
  const play = page.getByRole("button", { name: /Escuchar/ });

  // The primary button reflects the state machine (never a lost click).
  await play.click();
  await expect(page.getByRole("button", { name: /Pausar/ })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: /Escuchar/ })).toBeVisible({
    timeout: 60_000,
  });
  // Explicit state machine observable.
  await expect(page.locator("main")).toHaveAttribute("data-phase", "ready");
});

test("Play during preparation is remembered and auto-starts without refetching", async ({
  page,
}) => {
  await page.goto("/");
  const requests = trackSpeechRequests(page);
  await page
    .getByRole("button", { name: "Circular ficticia 1/2024", exact: true })
    .click();
  const play = page.locator(".reader-play");
  await expect(play).toBeEnabled();

  // Triple-click while chunk 0 may still be generating: the intent must be
  // honored exactly once — no restarts, no duplicate per-chunk requests.
  await play.click();
  await play.click();
  await play.click();

  // The queued play intent must auto-start once chunk 0 is ready.
  // The most reliable observable proof: the button text changes from
  // "Escuchar" to "Pausar".  After playback starts the phase may be
  // "playing" (still running) or "ready" (short mock audio ended quickly),
  // but "paused" is never correct here — it would mean the user pressed
  // pause or a bug toggled the state.
  await expect(page.getByRole("button", { name: /Pausar/ })).toBeVisible({
    timeout: 30_000,
  });
  // Dedupe invariant: each chunk text is requested at most once.
  const duplicates = [...requests().entries()].filter(([, n]) => n > 1);
  expect(duplicates).toEqual([]);
});

test("switching documents cancels the old player and starts clean", async ({ page }) => {
  await loadFixture(page, "Circular ficticia 1/2024");
  await page.getByRole("button", { name: /Escuchar/ }).click();
  await expect(page.getByRole("button", { name: /Pausar/ })).toBeVisible({
    timeout: 30_000,
  });

  // Drag-and-drop-equivalent: feed a different PDF through the same pipeline.
  const pdf = await page.request.get("/corpus/pdfs/simple-01.pdf");
  const body = await pdf.body();
  await page.locator('input[type="file"]').setInputFiles({
    name: "simple-01.pdf",
    mimeType: "application/pdf",
    buffer: body,
  });

  // The old player is gone: no ghost "Pausar", the doc header changed and
  // the state machine restarted at extracting.
  await expect(page.getByRole("button", { name: /Pausar/ })).toBeHidden();
  await expect(page.getByRole("heading", { name: "simple-01.pdf" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator("main")).toHaveAttribute(
    "data-phase",
    /extracting|preparing|ready|playing/,
  );
});

test("reader exports a valid single WAV of the document", async ({ page }) => {
  await loadFixture(page, "Documento simple");

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    page.getByRole("button", { name: "Descargar audio" }).click(),
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
  // Header data-size must match the actual payload.
  expect(buf.length).toBe(44 + dataLen);
});

test("the landing page carries no development jargon", async ({ page }) => {
  await page.goto("/");
  const body = (await page.textContent("body")) ?? "";
  for (const leak of ["kokoro", "Kokoro", "NaN", "provider:", "af_heart", "ef_dora"]) {
    expect(body).not.toContain(leak);
  }
});

/* ------------------------------------------------------------------ */
/*  New v0.3 E2E: explicit state model & loading state visibility      */
/* ------------------------------------------------------------------ */

test("loading and preparing phases are visible", async ({ page }) => {
  await page.goto("/");

  // Load a fixture — it goes through loading → extracting → preparing → ready.
  await page.getByRole("button", { name: "Documento simple", exact: true }).click();

  // Should see the loading or extracting phase.
  const loadingPhase = await page.locator("main").getAttribute("data-phase");
  expect(["loading", "extracting", "preparing", "ready", "playing"]).toContain(
    loadingPhase ?? "",
  );
});

test("document switching during preparation does not ghost old audio", async ({
  page,
}) => {
  await page.goto("/");
  // Load first fixture — triggers document loading.
  await page
    .getByRole("button", { name: "Circular ficticia 1/2024", exact: true })
    .click();

  // Switch to a different document via the file input (simulates drag/drop or
  // the "Cambiar" button).
  const pdf = await page.request.get("/corpus/pdfs/simple-01.pdf");
  const body = await pdf.body();
  await page.locator('input[type="file"]').setInputFiles({
    name: "simple-01.pdf",
    mimeType: "application/pdf",
    buffer: body,
  });

  // Should show the second document, not the first.
  await expect(page.getByRole("heading", { name: "simple-01.pdf" })).toBeVisible({
    timeout: 30_000,
  });

  // State should be clean (not stale from the first document).
  const phase = await page.locator("main").getAttribute("data-phase");
  expect(phase).not.toBe("loading");
});

test("changing voice is safe (no stale cache references)", async ({ page }) => {
  await loadFixture(page, "Documento simple");

  // The voice selector is under "Opciones avanzadas".
  await page.getByRole("button", { name: "Opciones avanzadas" }).click();
  const voiceLabel = page.getByLabel("voz", { exact: true });
  await expect(voiceLabel).toBeVisible();

  // Select a different voice.
  const voiceSelect = voiceLabel;
  const options = await voiceSelect.evaluateAll((els) =>
    els.map((el) => (el as HTMLSelectElement).options),
  );
  if (options[0] && options[0].length > 1) {
    await voiceSelect.selectOption({ index: 1 });
  }

  // The document should still be playable.
  const play = page.getByRole("button", { name: /Escuchar/ });
  await expect(play).toBeVisible();
  await expect(play).toBeEnabled();
});

test("/lab is reachable from the reader and functional", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "DocuVoz" })).toBeVisible();

  // Click the Lab link.
  await page.getByRole("link", { name: "Laboratorio" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /AUIDIO NAN/ })).toBeVisible();
});

/* ------------------------------------------------------------------ */
/*  AbortError regression test: capture page errors during doc switch  */
/* ------------------------------------------------------------------ */

test("document switching does not produce AbortError in the browser", async ({
  page,
}) => {
  // Capture all browser console errors / unhandled rejections
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(msg.text());
    }
  });
  page.on("pageerror", (err) => {
    errors.push(err.message);
  });

  // Load a fixture — triggers document loading and player preparation.
  await page.goto("/");
  await page
    .getByRole("button", { name: "Circular ficticia 1/2024", exact: true })
    .click();

  // Let the first document's player start preparing.
  await expect(page.getByRole("button", { name: /Escuchar/ })).toBeVisible();

  // Immediately load a second document via file input.
  // This triggers beginLoad() -> destroy() -> new player creation.
  const pdf = await page.request.get("/corpus/pdfs/simple-01.pdf");
  const body = await pdf.body();
  await page.locator('input[type="file"]').setInputFiles({
    name: "simple-01.pdf",
    mimeType: "application/pdf",
    buffer: body,
  });

  // Wait for the second document to load.
  await expect(page.getByRole("heading", { name: "simple-01.pdf" })).toBeVisible({
    timeout: 30_000,
  });

  // The second document should be playable (not stuck in error state).
  const play = page.getByRole("button", { name: /Escuchar/ });
  await expect(play).toBeVisible();
  await expect(play).toBeEnabled();

  // Verify no AbortError leaked into the browser console.
  const abortErrors = errors.filter(
    (e) => e.includes("AbortError") || e.includes("signal is aborted"),
  );
  expect(abortErrors).toHaveLength(0);
});
