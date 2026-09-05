/**
 * Part 2 — real EPUB workflow E2E (real vendored foliate-js parser in the
 * browser, real upload path, mock TTS). Nothing of the document pipeline is
 * mocked: the browser opens the generated EPUB exactly like a user file.
 */
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import { buildSampleEpub, SAMPLE_EPUB_MARKERS as M } from "./helpers/doc-fixtures";

async function uploadSampleEpub(page: Page, name = "docuviz-sample.epub") {
  const fixture = await buildSampleEpub();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "DocuVoz" })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({
    name,
    mimeType: "application/epub+zip",
    buffer: fixture.buffer,
  });
}

/**
 * The Reader's default spoken view is Listen-normalised ("Capítulo 1" →
 * "Capítulo uno"). Structural assertions need the extracted source verbatim,
 * so switch the shared reader to Literal mode.
 */
async function setLiteralMode(page: Page) {
  await page.getByLabel("modo de lectura").selectOption("literal");
}

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

function trackSpeechRequests(page: Page): () => Map<string, number> {
  const counts = new Map<string, number>();
  page.on("request", (req) => {
    if (req.url().includes("/api/speech") && req.method() === "POST") {
      let text = "?";
      try {
        text = String(JSON.parse(req.postData() ?? "")?.text);
      } catch {
        /* ignore */
      }
      counts.set(text, (counts.get(text) ?? 0) + 1);
    }
  });
  return () => counts;
}

test("EPUB upload → detection → metadata → TOC → chapters → play → export", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  const speech = trackSpeechRequests(page);

  await uploadSampleEpub(page);

  // Format detected + title from EPUB metadata (not the filename).
  await expect(page.getByRole("heading", { name: M.title })).toBeVisible({
    timeout: 30_000,
  });
  // Author shown next to the format badge.
  await expect(page.locator(".reader-doc-meta")).toContainText("EPUB");
  await expect(page.locator(".reader-doc-meta")).toContainText(M.author);

  await setLiteralMode(page);

  // First chapter visible with full semantic structure (heading, list, table).
  const text = page.locator(".reader-text");
  await expect(text).toContainText(M.chap1Heading);
  await expect(text).toContainText(M.chap1Text);
  await expect(text).toContainText(M.listItem);
  await expect(text).toContainText(M.tableCell);

  // Source order: chapter 2 after chapter 1, notes at the end.
  const segs = await text.locator(".reader-seg").allTextContents();
  const joined = segs.join("\n");
  expect(joined.indexOf(M.chap1Text)).toBeLessThan(joined.indexOf(M.chap2Text));
  expect(joined.indexOf(M.chap2Text)).toBeLessThan(joined.indexOf(M.chap3Text));
  expect(joined.indexOf(M.chap3Text)).toBeLessThan(joined.indexOf(M.noteText));

  // TOC visible with nested entries (depth > 0 on chapter items).
  await page.getByRole("button", { name: "navegación por capítulos" }).click();
  const toc = page.locator(".reader-toc");
  await expect(toc).toBeVisible();
  await expect(toc.getByRole("button", { name: "Inicio", exact: true })).toBeVisible();
  await expect(
    toc.getByRole("button", { name: "Primera parte", exact: true }),
  ).toBeVisible();
  const nested = toc.getByRole("button", { name: "Capítulo 2", exact: true });
  await expect(nested).toBeVisible();
  // Nested entries are indented deeper than their parent.
  const parentPad = await toc
    .getByRole("button", { name: "Primera parte", exact: true })
    .evaluate((el) => (el as HTMLElement).style.paddingLeft);
  const childPad = await nested.evaluate((el) => (el as HTMLElement).style.paddingLeft);
  expect(parseInt(childPad || "0", 10)).toBeGreaterThan(parseInt(parentPad || "0", 10));

  // Play: preparing/buffering → playing (the button reflects the state
  // machine, proving the EPUB audio actually synthesizes and plays). Mid-
  // playback pause/resume state transitions are covered deterministically at
  // the unit level (buffered-player-new.test.ts:201); the short-lived mock
  // audio makes a stable "paused" label non-deterministic in headless E2E
  // (see reader.spec.ts:76-79), so here we assert the transitions that ARE
  // deterministic: play starts, and cross-chapter seek moves the active
  // section (autoplays if still playing, just seeks if the short chunk ended).
  const play = page.getByRole("button", { name: /Escuchar/ });
  await play.click();
  await expect(page.getByRole("button", { name: /Pausar/ })).toBeVisible({
    timeout: 45_000,
  });

  // Cross-chapter navigation through the TOC (already open from the structure
  // check above): the current section changes.
  await page
    .locator(".reader-toc")
    .getByRole("button", { name: "Capítulo 3", exact: true })
    .click();
  await expect(
    page.locator(".reader-seg.active").filter({ hasText: M.chap3Text }).first(),
  ).toBeVisible({ timeout: 15_000 });
  // The current-section indicator follows the seek. The landed chunk can begin
  // with the previous chapter's trailing segment (chunks are paced for TTS, not
  // split exactly at headings), and the indicator reflects that segment
  // (reader.tsx:153) — so assert it ADVANCED to a chapter at/after ch.2 rather
  // than an exact number. The active-segment check above is the authoritative
  // proof of the cross-chapter jump.
  await expect(page.locator(".reader-toc-toggle")).toContainText(/Capítulo [23]/, {
    timeout: 5_000,
  });

  // Export MP3 and validate it.
  await page.getByRole("button", { name: /audio/i }).click();
  await page.getByRole("button", { name: "MP3" }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 90_000 }),
    page.getByRole("button", { name: "Exportar audio" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.mp3$/i);
  const path = await download.path();
  expect(path).not.toBeNull();
  const buf = path ? await fs.promises.readFile(path) : Buffer.alloc(0);
  const hasId3v2 = buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33;
  const hasFrameSync = buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
  expect(hasId3v2 || hasFrameSync).toBe(true);
  expect(buf.length).toBeGreaterThan(100);

  // Invariants.
  const duplicates = [...speech().entries()].filter(([, n]) => n > 1);
  expect(duplicates, "TTS requests must never duplicate per chunk").toEqual([]);
  const abortish = errors.filter((e) => /AbortError|signal is aborted/i.test(e));
  expect(abortish).toEqual([]);
  expect(errors).toEqual([]);
});

test("EPUB TOC navigation before playback moves the current section", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await uploadSampleEpub(page);
  await expect(page.getByRole("heading", { name: M.title })).toBeVisible({
    timeout: 30_000,
  });

  // Seek through the TOC without playing: active segment + header follow.
  await setLiteralMode(page);
  await page.getByRole("button", { name: "navegación por capítulos" }).click();
  await page
    .locator(".reader-toc")
    .getByRole("button", { name: "Capítulo 2", exact: true })
    .click();
  await expect(
    page.locator(".reader-seg.active").filter({ hasText: M.chap2Text }).first(),
  ).toBeVisible({ timeout: 15_000 });
  expect(errors).toEqual([]);
});

test("corpus EPUB sample loads through the reader's example button", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Aventuras de DocuVoz (EPUB)", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: M.title })).toBeVisible({
    timeout: 30_000,
  });
  // chapter 2 body marker (number-free, identical in Listen and Literal)
  await expect(page.locator(".reader-text")).toContainText("isla de cristal");
});
