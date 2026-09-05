/**
 * Part 9 — lazy-loading proof.
 *
 * The heavyweight per-format parsers (foliate/JSZip, mammoth, markdown-it, …)
 * must NOT bloat the initial page. On the empty Reader the initial JS stays
 * small; each format pulls its parser as new chunks ONLY when a document of
 * that type is opened; and plain TXT — which needs no third-party parser — pulls
 * essentially nothing new. Measured via the browser Resource Timing API.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  buildSampleEpub,
  buildSampleDocx,
  SAMPLE_TXT,
  SAMPLE_MARKDOWN,
} from "./helpers/doc-fixtures";

const jsResources = (page: Page) =>
  page.evaluate(() => {
    const out: Record<string, number> = {};
    const entries = performance.getEntriesByType(
      "resource",
    ) as PerformanceResourceTiming[];
    for (const e of entries) {
      if (/\.js(\?|$)/.test(e.name)) out[e.name] = Math.round(e.transferSize);
    }
    return out;
  });

/** Bytes of JS chunks fetched that were not present in `before`. */
function newBytes(before: Record<string, number>, after: Record<string, number>): number {
  return Object.keys(after)
    .filter((u) => !(u in before))
    .reduce((a, u) => a + (after[u] ?? 0), 0);
}

async function loadAndWait(page: Page, name: string, mime: string, buffer: Buffer) {
  await page.goto("/");
  await page.waitForTimeout(500);
  const before = await jsResources(page);
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name, mimeType: mime, buffer });
  await page.locator(".reader-doc-name").waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1000);
  return newBytes(before, await jsResources(page));
}

test("the initial Reader does not carry the document parsers", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(1500);
  const total = Object.values(await jsResources(page)).reduce((a, b) => a + b, 0);
  // Parsers excluded (mammoth alone is >100 KB): the baseline must stay lean.
  expect(total).toBeLessThan(350_000);
});

test("each format lazy-loads its parser on demand; plain TXT needs none", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const epub = await buildSampleEpub();
  const docx = await buildSampleDocx();

  const epubBytes = await loadAndWait(
    page,
    "a.epub",
    "application/epub+zip",
    epub.buffer,
  );
  const docxBytes = await loadAndWait(page, "b.docx", docx.mimeType, docx.buffer);
  const mdBytes = await loadAndWait(
    page,
    "c.md",
    "text/markdown",
    Buffer.from(SAMPLE_MARKDOWN, "utf8"),
  );
  const txtBytes = await loadAndWait(
    page,
    "d.txt",
    "text/plain",
    Buffer.from(SAMPLE_TXT, "utf8"),
  );

  // Substantial parser payload fetched per format (well beyond route noise).
  expect(epubBytes, "EPUB parser should load lazily").toBeGreaterThan(20_000);
  expect(docxBytes, "DOCX parser should load lazily").toBeGreaterThan(20_000);
  expect(mdBytes, "Markdown parser should load lazily").toBeGreaterThan(20_000);
  // TXT has no third-party parser: it reuses the existing bundle.
  expect(txtBytes, "TXT should not pull a heavyweight parser").toBeLessThan(15_000);
});
