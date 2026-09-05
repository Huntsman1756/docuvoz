/**
 * Part 10 — parse-to-first-render performance (browser, mock TTS).
 *
 * Measures the wall-clock from upload to the first rendered block for each
 * format, including a deliberately large EPUB to show the pipeline scales.
 * Timings are logged for the report and guarded by a loose ceiling that would
 * catch pathological regressions or a frozen UI without being flaky.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  buildEpub,
  buildSampleEpub,
  buildSampleDocx,
  SAMPLE_TXT,
  SAMPLE_MARKDOWN,
  SAMPLE_HTML,
  type EpubChapter,
} from "./helpers/doc-fixtures";

async function parseToRenderMs(page: Page, name: string, mime: string, buffer: Buffer) {
  await page.goto("/");
  await page.waitForTimeout(300);
  const t0 = Date.now();
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name, mimeType: mime, buffer });
  await page.locator(".reader-doc-name").waitFor({ timeout: 30_000 });
  return Date.now() - t0;
}

function bigEpub(): EpubChapter[] {
  return Array.from({ length: 20 }, (_, i) => ({
    file: `c${i}.xhtml`,
    title: `Capítulo ${i + 1}`,
    body:
      `<h1>Capítulo ${i + 1}</h1>` +
      Array.from(
        { length: 8 },
        (_, p) =>
          `<p>Párrafo ${p + 1} del capítulo ${i + 1}, con texto suficiente para medir de forma representativa el análisis del documento en el navegador.</p>`,
      ).join(""),
  }));
}

test("parse-to-render stays well within budget for every format", async ({ page }) => {
  test.setTimeout(120_000);
  const epub = await buildSampleEpub();
  const docx = await buildSampleDocx();
  const large = await buildEpub({
    name: "grande.epub",
    title: "Documento grande",
    authors: ["Ana Ejemplo"],
    language: "es",
    version: 3,
    toc: null,
    chapters: bigEpub(),
  });

  const t = {
    epub: await parseToRenderMs(page, "s.epub", "application/epub+zip", epub.buffer),
    docx: await parseToRenderMs(page, "s.docx", docx.mimeType, docx.buffer),
    markdown: await parseToRenderMs(
      page,
      "s.md",
      "text/markdown",
      Buffer.from(SAMPLE_MARKDOWN, "utf8"),
    ),
    html: await parseToRenderMs(
      page,
      "s.html",
      "text/html",
      Buffer.from(SAMPLE_HTML, "utf8"),
    ),
    txt: await parseToRenderMs(
      page,
      "s.txt",
      "text/plain",
      Buffer.from(SAMPLE_TXT, "utf8"),
    ),
    largeEpub: await parseToRenderMs(
      page,
      "grande.epub",
      "application/epub+zip",
      large.buffer,
    ),
  };
  console.log("PARSE_MS " + JSON.stringify(t));

  // Loose regression guards (real values are ~sub-second; samples are tiny).
  expect(t.epub).toBeLessThan(8_000);
  expect(t.docx).toBeLessThan(8_000);
  expect(t.markdown).toBeLessThan(8_000);
  expect(t.html).toBeLessThan(8_000);
  expect(t.txt).toBeLessThan(8_000);
  // A 20-chapter EPUB still parses promptly.
  expect(t.largeEpub).toBeLessThan(12_000);

  // The large document actually rendered all its content (not truncated).
  // Literal mode keeps "Capítulo 20" verbatim (Listen would say "veinte").
  await page.locator('[aria-label="modo de lectura"]').selectOption("literal");
  await expect(page.locator(".reader-text")).toContainText("Capítulo 20");
});
