/**
 * Part 12 (e2e layer) — the /lab parser-diagnostics panel surfaces real parser
 * warnings in the browser. A DOCX that references an undefined paragraph style
 * makes mammoth emit a genuine warning; it must appear in the diagnostics
 * panel (never in the spoken content) and be clearable.
 */
import { expect, test } from "@playwright/test";
import { buildDocx } from "./helpers/doc-fixtures";

const PANEL = '[data-testid="parser-diagnostics"]';

test("undefined DOCX style warning appears in the /lab diagnostics panel", async ({
  page,
}) => {
  // One real paragraph + a paragraph with an undefined style reference.
  const fixture = await buildDocx({
    name: "advertencia.docx",
    items: [{ type: "para", text: "Contenido legible del informe." }],
    raw:
      `<w:p><w:pPr><w:pStyle w:val="EstiloFantasmaSinDefinir"/></w:pPr>` +
      `<w:r><w:t>Parrafo con estilo ausente.</w:t></w:r></w:p>`,
  });

  await page.goto("/lab");
  await page.locator('input[type="file"]').setInputFiles({
    name: fixture.name,
    mimeType: fixture.mimeType,
    buffer: fixture.buffer,
  });

  // The panel appears and carries the real mammoth warning.
  await expect(page.locator(PANEL)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(PANEL)).toContainText("EstiloFantasmaSinDefinir");
  await expect(
    page.locator(`${PANEL} li[data-diag-level="warning"]`).first(),
  ).toBeVisible();

  // Clearing empties the store and hides the panel.
  await page.locator(`${PANEL} button`, { hasText: "clear" }).click();
  await expect(page.locator(PANEL)).toBeHidden();
});

test("the parser warning never leaks into the reader's spoken content", async ({
  page,
}) => {
  const fixture = await buildDocx({
    name: "advertencia.docx",
    items: [{ type: "para", text: "Contenido legible del informe." }],
    raw:
      `<w:p><w:pPr><w:pStyle w:val="EstiloFantasmaSinDefinir"/></w:pPr>` +
      `<w:r><w:t>Parrafo con estilo ausente.</w:t></w:r></w:p>`,
  });

  // The Reader page uses the same adapter; the style id must never be spoken.
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles({
    name: fixture.name,
    mimeType: fixture.mimeType,
    buffer: fixture.buffer,
  });
  await expect(page.locator(".reader-text")).toContainText(
    "Contenido legible del informe.",
    {
      timeout: 30_000,
    },
  );
  const body = (await page.locator(".reader-text").textContent()) ?? "";
  expect(body).not.toContain("EstiloFantasmaSinDefinir");
});
