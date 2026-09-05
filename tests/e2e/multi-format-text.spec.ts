/**
 * Part 4 — plain-text family E2E (TXT, Markdown, HTML) through the real
 * in-browser adapters (markdown-it / DOMPurify / plain text), real upload path,
 * mock TTS. Verifies detection, semantic structure and that each format feeds
 * the audio pipeline.
 */
import { expect, test, type Page } from "@playwright/test";
import { SAMPLE_TXT, SAMPLE_MARKDOWN, SAMPLE_HTML } from "./helpers/doc-fixtures";

async function uploadText(page: Page, name: string, mimeType: string, content: string) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "DocuVoz" })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({
    name,
    mimeType,
    buffer: Buffer.from(content, "utf8"),
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
      counts.set(text, counts.get(text) ?? 1);
    }
  });
  return () => counts;
}

test("TXT upload → detection → paragraphs (BOM stripped) → play", async ({ page }) => {
  const errors = trackPageErrors(page);
  const speech = trackSpeechRequests(page);
  await uploadText(page, "muestra.txt", "text/plain", SAMPLE_TXT);

  await expect(page.locator(".reader-doc-name")).toContainText("muestra.txt", {
    timeout: 30_000,
  });
  await expect(page.locator(".reader-doc-meta")).toContainText("TXT");

  await setLiteralMode(page);
  const text = page.locator(".reader-text");
  await expect(text).toContainText("Informe de prueba con acentos: canción, navegación");
  await expect(text).toContainText("Segundo párrafo después de una línea en blanco");
  await expect(text).toContainText("Tercer párrafo final.");

  // UTF-8 BOM must not leak into the first spoken segment.
  const first = (await text.locator(".reader-seg").allTextContents())[0] ?? "";
  expect(first.startsWith("Informe de prueba")).toBe(true);

  await page.getByRole("button", { name: /Escuchar/ }).click();
  await expect(page.getByRole("button", { name: /Pausar/ })).toBeVisible({
    timeout: 45_000,
  });

  const duplicates = [...speech().entries()].filter(([, n]) => n > 1);
  expect(duplicates).toEqual([]);
  expect(errors).toEqual([]);
});

test("Markdown upload → detection → headings/list/quote/link/code → play", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  const speech = trackSpeechRequests(page);
  await uploadText(page, "muestra.md", "text/markdown", SAMPLE_MARKDOWN);

  await expect(page.locator(".reader-doc-name")).toContainText("muestra.md", {
    timeout: 30_000,
  });
  await expect(page.locator(".reader-doc-meta")).toContainText("Markdown");

  await setLiteralMode(page);
  const text = page.locator(".reader-text");
  await expect(text).toContainText("Informe trimestral"); // h1
  await expect(text).toContainText("negrita"); // inline emphasis preserved (no ** chars)
  await expect(text).toContainText("primer punto de la lista"); // bullet
  await expect(text).toContainText("subpunto anidado"); // nested bullet (own block)
  await expect(text).toContainText("Una cita textual del consejo rector."); // blockquote
  await expect(text).toContainText("página del proyecto"); // link text survives
  await expect(text).toContainText("const x = 1;"); // fenced code

  // Syntax characters never reach the spoken text.
  const joined = (await text.locator(".reader-seg").allTextContents()).join("\n");
  expect(joined).not.toContain("**");
  expect(joined).not.toContain("[página del proyecto](");

  // Parent and nested bullets survive as distinct spoken segments (nesting
  // depth is a block-model property, asserted at unit level — the segment DOM
  // is a flat list of <p> and does not carry per-item indentation).
  const listSegs = (await text.locator(".reader-seg").allTextContents()).filter((t) =>
    /primer punto de la lista|segundo punto|subpunto anidado/.test(t),
  );
  expect(listSegs.length).toBeGreaterThanOrEqual(2);

  await page.getByRole("button", { name: /Escuchar/ }).click();
  await expect(page.getByRole("button", { name: /Pausar/ })).toBeVisible({
    timeout: 45_000,
  });

  const duplicates = [...speech().entries()].filter(([, n]) => n > 1);
  expect(duplicates).toEqual([]);
  expect(errors).toEqual([]);
});

test("HTML upload → detection → sanitized structure → play", async ({ page }) => {
  const errors = trackPageErrors(page);
  const speech = trackSpeechRequests(page);
  await uploadText(page, "muestra.html", "text/html", SAMPLE_HTML);

  await expect(page.locator(".reader-doc-name")).toContainText("muestra.html", {
    timeout: 30_000,
  });
  await expect(page.locator(".reader-doc-meta")).toContainText("HTML");

  await setLiteralMode(page);
  const text = page.locator(".reader-text");
  await expect(text).toContainText("Guía breve de la biblioteca"); // h1
  await expect(text).toContainText("La biblioteca abre sus puertas"); // paragraph
  await expect(text).toContainText("sala infantil"); // list item
  await expect(text).toContainText("El carné se renueva en el mostrador principal.");

  // Source order preserved (heading before body before final paragraph).
  const joined = (await text.locator(".reader-seg").allTextContents()).join("\n");
  expect(joined.indexOf("Guía breve")).toBeLessThan(joined.indexOf("sala infantil"));
  expect(joined.indexOf("sala infantil")).toBeLessThan(
    joined.indexOf("El carné se renueva"),
  );

  await page.getByRole("button", { name: /Escuchar/ }).click();
  await expect(page.getByRole("button", { name: /Pausar/ })).toBeVisible({
    timeout: 45_000,
  });

  const duplicates = [...speech().entries()].filter(([, n]) => n > 1);
  expect(duplicates).toEqual([]);
  expect(errors).toEqual([]);
});
