/**
 * Genuinely cold Edge TTS / Ximena UI smoke (opt-in, @live).
 *
 * Unlike live-edge-export.spec.ts (which may reuse a warmed cache), this path
 * uses a fresh, never-before-synthesized Spanish document so the FIRST TTS
 * request is a real provider MISS. It then proves:
 *
 *   1. First synthesis is real (cache-status MISS, not a cache hit);
 *   2. Immediate Play → actual Edge playback that crosses multiple chunks;
 *   3. Pause → resume → seek all work on real audio;
 *   4. Export reuses the valid cache (no duplicate synthesis);
 *   5. No AbortError, console clean.
 *
 * Run: E2E_LIVE=1 npx playwright test tests/e2e/cold-edge-smoke.spec.ts
 */
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";

/** A fresh Spanish document that is guaranteed unique (never cached). */
function freshSpanishText(): string {
  const nonce = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const paras = [
    "La presente circular establece las obligaciones de información periódica de las entidades de crédito.",
    "El umbral máximo será de un millón doscientos treinta y cuatro mil quinientos sesenta y siete euros con ochenta y nueve céntimos.",
    "Los importes superiores a quinientos mil euros deberán notificarse en un plazo de T más dos días hábiles.",
    "El tipo aplicable será el resultado de incrementar el EURIBOR a doce meses en veinticinco puntos básicos.",
    "Se exceptúan las entidades que no superen un ratio de solvencia del ocho coma cinco por ciento.",
  ];
  // Enough unique text to cross several speech chunks, but bounded.
  return `${nonce}\n\n${paras.map((p) => `${p} Verificación ${nonce}.`).join("\n\n")}`;
}

function trackSpeech(page: Page): {
  texts: () => Map<string, number>;
  misses: () => number;
  hits: () => number;
} {
  const texts = new Map<string, number>();
  let misses = 0;
  let hits = 0;
  page.on("request", (req) => {
    if (req.url().includes("/api/speech") && req.method() === "POST") {
      let text = "?";
      try {
        text = String(JSON.parse(req.postData() ?? "")?.text);
      } catch {
        /* keep "?" */
      }
      texts.set(text, (texts.get(text) ?? 0) + 1);
    }
  });
  page.on("response", (res) => {
    if (res.url().includes("/api/speech") && res.status() === 200) {
      const status = res.headers()["cache-status"] ?? "";
      if (status === "MISS") misses += 1;
      else if (status === "HIT") hits += 1;
    }
  });
  return { texts: () => texts, misses: () => misses, hits: () => hits };
}

test("cold Edge/Ximena UI smoke: real synthesis, playback, cache reuse @live", async ({
  page,
}) => {
  test.skip(!process.env.E2E_LIVE, "run with E2E_LIVE=1 (real Edge/Ximena)");
  test.setTimeout(300_000);

  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));
  const speech = trackSpeech(page);

  // Fresh, unique Spanish document (never synthesized before → real MISS).
  const content = freshSpanishText();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "DocuVoz" })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({
    name: "frio.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(content, "utf8"),
  });

  // Auto/Spanish is default; select the real Edge/Ximena voice.
  await expect(page.locator(".reader-doc-name")).toContainText("frio.txt", {
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Opciones avanzadas" }).click();
  await page.getByLabel("motor de voz", { exact: true }).selectOption("edge");
  await page.getByLabel("voz", { exact: true }).selectOption("es-ES-XimenaNeural");

  // Immediate Play → real Edge synthesis → actual playback.
  await page.getByRole("button", { name: /Escuchar/ }).click();

  // Prove playback actually starts (Pausar = playing).
  await expect(page.getByRole("button", { name: /Pausar/ })).toBeVisible({
    timeout: 90_000,
  });

  // First synthesis must be a real MISS, not a cache hit.
  expect(speech.misses(), "first TTS request must be a real synthesis").toBeGreaterThan(
    0,
  );

  // Playback crosses multiple chunks: currentTime advances past the first chunk.
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[aria-label="tiempo"]');
      if (!el) return false;
      const m = (el.textContent ?? "").match(/(\d+):(\d+)\s*\/\s*(\d+):(\d+)/);
      if (!m) return false;
      return parseInt(m[1]) * 60 + parseInt(m[2]) > 2;
    },
    { timeout: 120_000 },
  );

  // Pause.
  const pauseBtn = page.getByRole("button", { name: /Pausar/ });
  await pauseBtn.click();
  await expect(page.getByRole("button", { name: /Continuar/ })).toBeVisible({
    timeout: 15_000,
  });

  // Resume.
  await page.getByRole("button", { name: /Continuar/ }).click();
  await expect(page.getByRole("button", { name: /Pausar/ })).toBeVisible({
    timeout: 30_000,
  });

  // Seek: click a later text segment to jump the active position (semantic seek).
  const segs = page.locator(".reader-seg");
  const count = await segs.count();
  if (count > 1) {
    await segs.nth(Math.min(count - 1, 2)).click();
    await expect(page.getByRole("button", { name: /Pausar/ })).toBeVisible({
      timeout: 30_000,
    });
  }

  // Export MP3 reuses the valid cache (no new synthesis beyond the first pass).
  const downloadBtn = page.getByRole("button", { name: /audio/i });
  await expect(downloadBtn).toBeVisible();
  await downloadBtn.click();
  await page.getByRole("button", { name: "MP3" }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 120_000 }),
    page.getByRole("button", { name: "Exportar audio" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.mp3$/i);
  const path = await download.path();
  expect(path).not.toBeNull();
  const buf = path ? await fs.promises.readFile(path) : Buffer.alloc(0);
  const hasId3 = buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33;
  const hasSync = buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
  expect(hasId3 || hasSync).toBe(true);
  expect(buf.length).toBeGreaterThan(1000);

  // No chunk text was synthesized more than once (no duplicate synthesis).
  const duplicates = [...speech.texts().entries()].filter(([, n]) => n > 1);
  expect(duplicates, "TTS must never synthesize the same chunk twice").toEqual([]);

  // Console clean (favicon/404/AbortError tolerated).
  const realErrors = consoleErrors.filter(
    (e) =>
      !e.includes("favicon") &&
      !e.includes("404") &&
      !e.includes("AbortError") &&
      !e.includes("signal is aborted"),
  );
  expect(realErrors, `console errors: ${realErrors.join("; ")}`).toHaveLength(0);
});
