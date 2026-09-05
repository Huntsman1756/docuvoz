/**
 * Part 3 — real DOCX workflow E2E (real mammoth.js + DOMPurify in the browser,
 * real upload path, mock TTS). Nothing of the document pipeline is mocked.
 *
 * DOCX carries no title metadata, so an uploaded file is titled by its
 * filename (unlike EPUB, whose dc:title wins — see epub-adapter.ts:258). The
 * example-button path instead titles it from the manifest entry.
 */
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import { buildSampleDocx, SAMPLE_DOCX_MARKERS as M } from "./helpers/doc-fixtures";

async function uploadSampleDocx(page: Page, name = "docuviz-sample.docx") {
  const fixture = await buildSampleDocx();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "DocuVoz" })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({
    name,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: fixture.buffer,
  });
}

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

test("DOCX upload → detection → structure → TOC → play → export", async ({ page }) => {
  const errors = trackPageErrors(page);
  const speech = trackSpeechRequests(page);

  await uploadSampleDocx(page);

  // Filename title + format badge (mammoth has no title metadata).
  await expect(page.locator(".reader-doc-name")).toContainText("docuviz-sample.docx", {
    timeout: 30_000,
  });
  await expect(page.locator(".reader-doc-meta")).toContainText("DOCX");

  await setLiteralMode(page);

  // Every semantic element survives mammoth → sanitize → block extraction.
  const text = page.locator(".reader-text");
  await expect(text).toContainText(M.title); // Heading 1
  await expect(text).toContainText(M.h2); // Heading 2
  await expect(text).toContainText(M.para1); // paragraph
  await expect(text).toContainText(M.bullet1); // unordered list
  await expect(text).toContainText(M.nested); // nested (indented) item
  await expect(text).toContainText(M.numbered1); // ordered list
  await expect(text).toContainText(M.tableCell1); // table cell
  await expect(text).toContainText(M.tableCell2); // numeric table cell
  await expect(text).toContainText(M.linkText); // hyperlink text
  await expect(text).toContainText(M.footnoteText); // inlined footnote
  await expect(text).toContainText(M.textboxText); // text-box (mc:Fallback)

  // Source order is preserved end to end.
  const joined = (await text.locator(".reader-seg").allTextContents()).join("\n");
  expect(joined.indexOf(M.title)).toBeLessThan(joined.indexOf(M.para1));
  expect(joined.indexOf(M.para1)).toBeLessThan(joined.indexOf(M.tableCell2));
  expect(joined.indexOf(M.tableCell2)).toBeLessThan(joined.indexOf(M.footnoteText));

  // TOC is synthesized from headings and lists the H2 sections.
  await page.getByRole("button", { name: "navegación por capítulos" }).click();
  const toc = page.locator(".reader-toc");
  await expect(toc.getByRole("button", { name: M.title, exact: true })).toBeVisible();
  await expect(toc.getByRole("button", { name: M.h2, exact: true })).toBeVisible();
  await expect(
    toc.getByRole("button", { name: M.tableHeading, exact: true }),
  ).toBeVisible();

  // Play: the DOCX audio actually synthesizes and plays.
  await page.getByRole("button", { name: /Escuchar/ }).click();
  await expect(page.getByRole("button", { name: /Pausar/ })).toBeVisible({
    timeout: 45_000,
  });

  // Export MP3 and validate the container.
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

test("corpus DOCX sample loads through the reader's example button", async ({ page }) => {
  await page.goto("/");
  await page
    .locator(".reader-examples button", { hasText: "Informe semestral (DOCX)" })
    .click();
  await expect(page.locator(".reader-doc-name")).toContainText(
    "Informe semestral (DOCX)",
    {
      timeout: 30_000,
    },
  );
  // Number-free marker, identical under Listen and Literal.
  await expect(page.locator(".reader-text")).toContainText(M.para1);
});
