import { test, expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { buildSampleEpub, buildDocx, SAMPLE_EPUB_MARKERS } from "./helpers/doc-fixtures";

// Visual-review screenshots are test artifacts, not documentation. They write
// to a gitignored output directory so a routine `npm run test:e2e` never dirties
// the tracked docs/screenshots PNGs. To regenerate the intentional
// documentation shots, copy the selected captures into docs/screenshots manually.
const SHOTS = join(process.cwd(), "test-results", "screenshots");
const VIEWPORTS = [
  { name: "desktop-1440x900", width: 1440, height: 900 },
  { name: "desktop-1920x1080", width: 1920, height: 1080 },
  { name: "mobile-390", width: 390, height: 844 },
] as const;

async function uploadEpub(page: Page) {
  const fixture = await buildSampleEpub();
  await page.locator('input[type="file"]').setInputFiles({
    name: fixture.name,
    mimeType: "application/epub+zip",
    buffer: fixture.buffer,
  });
  await expect(
    page.getByRole("heading", { level: 2, name: SAMPLE_EPUB_MARKERS.title }),
  ).toBeVisible({ timeout: 30_000 });
}

async function capture(page: Page, file: string) {
  await page.screenshot({ path: join(SHOTS, `${file}.png`), fullPage: true });
}

test.describe("visual review — reader states across viewports", () => {
  for (const vp of VIEWPORTS) {
    test(`reader renders and screenshots at ${vp.name}`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: vp.width, height: vp.height });

      await page.goto("/");
      await expect(page.locator(".reader-hero")).toBeVisible({ timeout: 30_000 });
      await capture(page, `${vp.name}-01-empty`);

      await uploadEpub(page);
      await expect(page.locator(".reader-play")).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(".reader-play")).toBeEnabled();
      await capture(page, `${vp.name}-02-listening`);

      await page.locator('[aria-label="modo de lectura"]').selectOption("literal");
      await expect(page.locator(".reader-seg").first()).toBeVisible({ timeout: 15_000 });
      await page.locator(".reader-toc-toggle").click();
      await expect(page.locator(".reader-toc")).toBeVisible({ timeout: 10_000 });
      await capture(page, `${vp.name}-03-literal-toc`);

      await page.locator(".reader-toc-toggle").click();
      await page.locator(".reader-play").click();
      await capture(page, `${vp.name}-04-playing`);
    });
  }

  test("lab diagnostics panel screenshots at desktop-1440x900", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/lab");
    const docx = await buildDocx({
      name: "advertencia.docx",
      items: [{ type: "para", text: "Contenido legible del informe." }],
      raw:
        `<w:p><w:pPr><w:pStyle w:val="EstiloFantasmaSinDefinir"/></w:pPr>` +
        `<w:r><w:t>Párrafo con estilo ausente.</w:t></w:r></w:p>`,
    });
    await page.locator('input[type="file"]').setInputFiles({
      name: docx.name,
      mimeType: docx.mimeType,
      buffer: docx.buffer,
    });
    await expect(page.locator('[data-testid="parser-diagnostics"]')).toBeVisible({
      timeout: 30_000,
    });
    await capture(page, "desktop-1440x900-05-lab");
  });
});
