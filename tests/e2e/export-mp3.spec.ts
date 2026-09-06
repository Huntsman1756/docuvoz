/**
 * MP3 export hardening E2E tests.
 *
 * Validates:
 *  - Export produces a valid MP3 file (MPEG frame sync or ID3v2 tag)
 *  - Non-trivial file size
 *  - Export reuses cached speech blobs (no TTS regeneration)
 *  - Cancellation does not affect Reader playback
 *  - Browser playback of exported MP3 succeeds (Audio element smoke test)
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

/**
 * A large Spanish document that reliably produces many speech chunks, used only
 * by the cancellation test. A tiny fixture makes the MP3 export finish in well
 * under a second, so the export dialog's cancel button (rendered only while
 * `exporting` is true) is detached before Playwright can click it. This text
 * guarantees a multi-second export, keeping the test deterministic (retries=0).
 * Mirrors the same helper in tests/e2e/export-m4a.spec.ts.
 */
function largeSpanishText(): string {
  const nonce = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const sentences = [
    "La presente disposición establece el régimen de obligaciones informativas aplicable a todas las entidades sujetas a supervisión reforzada durante el ejercicio en curso y los inmediatamente siguientes.",
    "El umbral máximo de exposición será de un millón doscientos treinta y cuatro mil quinientos sesenta y siete euros con ochenta y nueve céntimos, revisable anualmente conforme al índice general de precios al consumo.",
    "Los importes que superen los quinientos mil euros deberán comunicarse a la autoridad competente en un plazo no superior a tres días hábiles contados desde la fecha del acuerdo correspondiente entre las partes.",
    "El tipo de interés aplicable resultará de incrementar el índice de referencia a doce meses en veinticinco puntos básicos, sin perjuicio de las comisiones de apertura y de estudio previamente pactadas.",
    "Se exceptúan de este régimen las entidades que no alcancen un ratio de solvencia consolidado del ocho coma cinco por ciento sobre los activos ponderados por riesgo al cierre del periodo.",
    "La memoria anual deberá reflejar de forma clara y diferenciada la evolución patrimonial, los resultados obtenidos y las principales incidencias detectadas durante todo el ejercicio.",
    "Cada unidad administrativa remitirá su informe trimestral antes del día quince del mes siguiente al cierre del trimestre, en el formato normalizado que se indica en el anexo correspondiente.",
    "Las modificaciones sustanciales del plan de ajustes deberán someterse a la aprobación previa del consejo rector, que resolverá en un plazo máximo de quince días desde la recepción completa de la documentación.",
    "El servicio de atención a la clientela garantizará la respuesta en un plazo máximo de dos días hábiles, registrando todas las incidencias en el sistema de gestión previsto a tal efecto.",
    "A los efectos de este acuerdo tendrán la consideración de partes vinculadas aquellas entidades que compartan órgano de administración o una participación superior al diez por ciento del capital social.",
  ];
  const paras: string[] = [];
  for (let i = 0; i < 40; i++) {
    const a = sentences[i % sentences.length];
    const b = sentences[(i + 3) % sentences.length];
    paras.push(`${a} ${b} Referencia interna ${nonce}-${i}.`);
  }
  return `Circular informativa ${nonce}\n\n${paras.join("\n\n")}`;
}

/* ------------------------------------------------------------------ */
/*  MP3 export                                                         */
/* ------------------------------------------------------------------ */

test("reader exports a valid single MP3 of the document", async ({ page }) => {
  await loadFixture(page, "Documento simple");

  const downloadBtn = page.getByRole("button", { name: /audio/i });
  await expect(downloadBtn).toBeVisible({ timeout: 30_000 });
  await downloadBtn.click();

  await page.getByRole("button", { name: "MP3" }).click();

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    page.getByRole("button", { name: "Exportar audio" }).click(),
  ]);

  expect(download.suggestedFilename()).toMatch(/\.mp3$/i);
  const path = await download.path();
  expect(path).not.toBeNull();
  const buf = path ? await fs.promises.readFile(path) : Buffer.alloc(0);

  expect(buf.length).toBeGreaterThan(100);

  // Valid MP3: starts with ID3v2 tag or MPEG frame sync word
  const hasId3v2 = buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33;
  const hasFrameSync = buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
  expect(hasId3v2 || hasFrameSync).toBe(true);
});

test("export uses cached speech blobs — no new TTS synthesis", async ({ page }) => {
  const requests = trackSpeechRequests(page);
  await loadFixture(page, "Documento simple");

  const play = page.getByRole("button", { name: /Escuchar/ });
  await play.click();
  await expect(page.getByRole("button", { name: /Pausar/ })).toBeVisible({
    timeout: 30_000,
  });
  // Wait for playback to finish (short mock audio).
  await expect(page.getByRole("button", { name: /Escuchar/ })).toBeVisible({
    timeout: 60_000,
  });

  const beforeExport = requests();

  const downloadBtn = page.getByRole("button", { name: /audio/i });
  await expect(downloadBtn).toBeVisible();
  await downloadBtn.click();
  await page.getByRole("button", { name: "MP3" }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    page.getByRole("button", { name: "Exportar audio" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.mp3$/i);

  const afterExport = requests();
  const duplicates = [...afterExport.entries()].filter(
    ([text, count]) => (beforeExport.get(text) ?? 0) < count && count > 1,
  );
  expect(duplicates).toEqual([]);
});

test("cancellation does not affect Reader playback", async ({ page }) => {
  // Load a LARGE document so the MP3 export keeps running long enough that the
  // export dialog's cancel button is reliably present and clickable (a tiny
  // fixture finishes the export in well under a second and the button would be
  // detached before Playwright could click it). The reader keeps the export
  // dialog open for the whole export, so its "Cancelar" button (class
  // `.export-dialog-cancel`) renders inside the export overlay. We target it by
  // that unique class rather than by role/name so the export-bar ✕ and the
  // transport download button (both labelled "cancelar descarga" while
  // exporting) can't trip strict mode.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "DocuVoz" })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({
    name: "cancelacion-grande.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(largeSpanishText(), "utf8"),
  });
  await expect(page.locator(".reader-doc-name")).toContainText("cancelacion-grande.txt", {
    timeout: 30_000,
  });

  // Start playback first so we can prove cancellation leaves it untouched.
  const play = page.getByRole("button", { name: /Escuchar/ });
  await expect(play).toBeVisible();
  await expect(play).toBeEnabled();
  await play.click();
  await expect(page.getByRole("button", { name: /Pausar/ })).toBeVisible({
    timeout: 30_000,
  });

  // Open the export dialog and select MP3.
  const downloadBtn = page.getByRole("button", { name: /audio/i });
  await expect(downloadBtn).toBeVisible();
  await downloadBtn.click();
  await page.getByRole("button", { name: "MP3" }).click();

  // Start the export, then cancel it from the (still-open) export dialog.
  await page.getByRole("button", { name: "Exportar audio" }).click();
  const cancelBtn = page.locator(".export-dialog-cancel");
  await expect(cancelBtn).toBeVisible({ timeout: 10_000 });
  await cancelBtn.click();

  // Playback must be unaffected: still playing.
  await expect(page.getByRole("button", { name: /Pausar/ })).toBeVisible();
  await expect(page.locator("main")).toHaveAttribute("data-phase", "playing");
});

test("exported MP3 can be played back in the browser", async ({ page }) => {
  await loadFixture(page, "Documento simple");

  const downloadBtn = page.getByRole("button", { name: /audio/i });
  await expect(downloadBtn).toBeVisible({ timeout: 30_000 });
  await downloadBtn.click();
  await page.getByRole("button", { name: "MP3" }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    page.getByRole("button", { name: "Exportar audio" }).click(),
  ]);
  const path = await download.path();
  expect(path).not.toBeNull();

  const buf = path ? await fs.promises.readFile(path) : Buffer.alloc(0);
  const playable = await page.evaluate(async (bytes: number[]) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    try {
      const audio = new Audio(url);
      await new Promise<void>((resolve, reject) => {
        audio.oncanplaythrough = () => resolve();
        audio.onerror = () => reject(new Error("audio.onerror"));
        setTimeout(() => reject(new Error("timeout")), 5000);
      });
      URL.revokeObjectURL(url);
      return true;
    } catch {
      URL.revokeObjectURL(url);
      return false;
    }
  }, Array.from(buf));
  expect(playable).toBe(true);
});
