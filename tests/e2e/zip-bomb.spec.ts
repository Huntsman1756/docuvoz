/**
 * Part 6 (e2e layer) — archive resource-exhaustion guard in the browser.
 *
 * An EPUB whose central directory declares more entries than the hard limit
 * must be rejected quickly by the pre-parse guard (zip-limits.ts) BEFORE any
 * decompression: the Reader shows a clear error state, nothing crashes, and the
 * page stays interactive (a valid document still loads right after).
 */
import { expect, test, type Page } from "@playwright/test";
import { buildSampleEpub, SAMPLE_EPUB_MARKERS as E } from "./helpers/doc-fixtures";

// A valid EPUB skeleton carrying one entry past the 10 000-entry cap. Built
// once; the guard inspects only the central directory (no decompression).
async function buildEntryBomb(): Promise<Buffer> {
  const extra: Record<string, string> = {};
  for (let i = 0; i < 10_001; i++) extra[`OEBPS/padding-${i}.txt`] = "x";
  const fixture = await buildSampleEpub({ extraEntries: extra });
  return fixture.buffer;
}

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

test("over-limit EPUB is rejected with a clear error, UI stays alive", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  const bomb = await buildEntryBomb();

  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles({
    name: "bomb.epub",
    mimeType: "application/epub+zip",
    buffer: bomb,
  });

  // A bounded, explicit error state — not a hang and not an uncaught throw.
  await expect(page.locator("main")).toHaveAttribute("data-phase", "error", {
    timeout: 30_000,
  });
  await expect(page.locator(".reader")).toContainText(
    /demasiados elementos|máximo admitido/,
  );
  expect(errors).toEqual([]);

  // The upload control survived: a valid document loads cleanly afterwards.
  const good = await buildSampleEpub();
  await page.locator('input[type="file"]').setInputFiles({
    name: "good.epub",
    mimeType: "application/epub+zip",
    buffer: good.buffer,
  });
  await expect(page.locator(".reader-doc-name")).toContainText(E.title, {
    timeout: 30_000,
  });
  await expect(page.locator(".reader-text")).toContainText(E.chap1Text, {
    timeout: 30_000,
  });
  expect(errors).toEqual([]);
});

test("over-limit EPUB rejection is fast (central-directory guard, no decompress)", async ({
  page,
}) => {
  const bomb = await buildEntryBomb();
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles({
    name: "bomb.epub",
    mimeType: "application/epub+zip",
    buffer: bomb,
  });

  // Well under any real decompression cost: the guard trips almost instantly.
  const started = Date.now();
  await expect(page.locator("main")).toHaveAttribute("data-phase", "error", {
    timeout: 15_000,
  });
  expect(Date.now() - started).toBeLessThan(15_000);
});
