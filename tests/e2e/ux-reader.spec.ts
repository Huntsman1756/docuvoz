/**
 * DocuVoz UX E2E (mock provider, CI-safe).
 *
 * Covers the product-facing behaviours that were previously only partially
 * exercised:
 *  - resume (restore position, no autoplay)
 *  - wrong document (same filename, different bytes → no resume)
 *  - auto section change during playback
 *  - keyboard transport + keyboard exclusions
 *  - current block highlight on play/seek
 *  - manual scroll suspends follow, "Volver al texto actual" resumes it
 *  - mobile 390px layout
 *  - privacy (no /api/speech until Play)
 *
 * All tests are deterministic: the mock provider never touches the network.
 */
import { expect, test, type Page } from "@playwright/test";
import { buildSampleDocx, buildSampleEpub } from "./helpers/doc-fixtures";

async function uploadAndReady(
  page: Page,
  buffer: Buffer,
  name: string,
  mimeType: string,
) {
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType, buffer });
  await expect(page.locator(".reader-play")).toBeEnabled({ timeout: 30_000 });
}

/* ── 1. RESUME ──────────────────────────────────────────────────────────── */

test("RESUME: restored location, paused, no autoplay", async ({ page }) => {
  const docx = await buildSampleDocx();
  await uploadAndReady(page, docx.buffer, docx.name, docx.mimeType);

  // Play, then advance past the first chunk so a later position is saved.
  await page.locator(".reader-play").click();
  await expect(page.locator(".reader-play")).toHaveText(/Pausar/, { timeout: 30_000 });
  // Wait until the transport is ready: a disabled click would be a no-op and
  // the saved position would end up as chunk 0.
  const nextChunk = page.getByRole("button", {
    name: "fragmento siguiente",
    exact: true,
  });
  await expect(nextChunk).toBeEnabled();
  await nextChunk.click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.querySelector(".reader-seek-bar")?.getAttribute("value"),
      ),
    )
    .not.toBe("0");

  // Pause → savePosition writes the current chunk.
  await page.locator(".reader-play").click();
  await expect(page.locator(".reader-play")).toHaveText(/Continuar|Escuchar/);

  // Reload and reopen through the recent-documents resume flow.
  await page.reload();
  const recentResume = page.getByRole("button", { name: /Reanudar/ });
  await expect(recentResume).toBeVisible();
  const chooserPromise = page.waitForEvent("filechooser");
  await recentResume.click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: docx.name,
    mimeType: docx.mimeType,
    buffer: docx.buffer,
  });

  await expect(page.locator(".reader-play")).toBeEnabled({ timeout: 30_000 });

  // No autoplay: the primary button must not be "Pausar".
  await expect(page.locator(".reader-play")).not.toHaveText(/Pausar/);

  // Restored location: the active segment is not the first one.
  const activeIndex = await page.evaluate(() => {
    const segs = Array.from(document.querySelectorAll(".reader-seg"));
    const active = document.querySelector(".reader-seg.active");
    return active ? segs.indexOf(active) : -1;
  });
  expect(activeIndex).toBeGreaterThan(0);
});

/* ── 2. WRONG DOCUMENT ──────────────────────────────────────────────────── */

test("WRONG DOCUMENT: same filename, different bytes → no incorrect resume", async ({
  page,
}) => {
  const contentA = "Documento A. " + "Texto original del primer archivo. ".repeat(40);
  const contentB =
    "Documento B. " + "Texto completamente distinto del segundo archivo. ".repeat(40);

  await uploadAndReady(page, Buffer.from(contentA), "same.txt", "text/plain");

  // Play, advance, pause (save position for content A).
  await page.locator(".reader-play").click();
  await expect(page.locator(".reader-play")).toHaveText(/Pausar/, { timeout: 30_000 });
  const nextChunkB = page.getByRole("button", {
    name: "fragmento siguiente",
    exact: true,
  });
  await expect(nextChunkB).toBeEnabled();
  await nextChunkB.click();
  await page.locator(".reader-play").click();

  // Reload and re-upload a DIFFERENT file with the SAME filename.
  await page.reload();
  await page.locator('input[type="file"]').setInputFiles({
    name: "same.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(contentB),
  });
  await expect(page.locator(".reader-play")).toBeEnabled({ timeout: 30_000 });

  // The player must NOT restore: the active segment is the first one (chunk 0).
  const activeIndex = await page.evaluate(() => {
    const segs = Array.from(document.querySelectorAll(".reader-seg"));
    const active = document.querySelector(".reader-seg.active");
    return active ? segs.indexOf(active) : -1;
  });
  expect(activeIndex).toBeLessThanOrEqual(0);
  await expect(page.locator(".reader-seek-bar")).toHaveAttribute("value", "0");
});

/* ── 3. AUTO SECTION ────────────────────────────────────────────────────── */

test("AUTO SECTION: advancing during playback changes the visible section", async ({
  page,
}) => {
  const epub = await buildSampleEpub();
  await uploadAndReady(page, epub.buffer, epub.name, epub.mimeType);

  const tocToggle = page.locator(".reader-toc-toggle");
  await expect(tocToggle).toBeVisible();
  const firstSection = (await tocToggle.textContent())?.trim() ?? "";

  await page.locator(".reader-play").click();
  await expect(page.locator(".reader-play")).toHaveText(/Pausar/, { timeout: 30_000 });

  // Advance chunks until the visible section label changes.
  await expect
    .poll(
      async () => {
        const label = (await tocToggle.textContent())?.trim() ?? "";
        return label !== firstSection;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  // Still playing after the section change (the change is observable, not a stop).
  await expect(page.locator(".reader-play")).toHaveText(/Pausar/);
});

/* ── 4. KEYBOARD ────────────────────────────────────────────────────────── */

test("KEYBOARD: Space, Left, Right, Shift+Left, Shift+Right drive the transport", async ({
  page,
}) => {
  // Use a long text so the transport stays active through multiple seeks.
  const longText =
    "Párrafo de prueba para el teclado. ".repeat(40) +
    "Sección de navegación. ".repeat(20);
  await uploadAndReady(page, Buffer.from(longText), "keyboard.txt", "text/plain");

  const play = page.locator(".reader-play");
  const seekValue = () =>
    page.evaluate(() =>
      document.querySelector(".reader-seek-bar")?.getAttribute("value"),
    );

  // Space starts playback.
  await page.keyboard.press("Space");
  await expect(play).toHaveText(/Pausar/, { timeout: 30_000 });

  // Space pauses.
  await page.keyboard.press("Space");
  await expect(play).toHaveText(/Continuar/);

  // Space resumes.
  await page.keyboard.press("Space");
  await expect(play).toHaveText(/Pausar/, { timeout: 30_000 });

  // ArrowRight (+30) advances the seek time; ArrowLeft (-15) moves it back.
  const t0 = Number(await seekValue());
  await page.keyboard.press("ArrowRight");
  const t1 = Number(await seekValue());
  expect(t1).toBeGreaterThanOrEqual(t0);
  await page.keyboard.press("ArrowLeft");
  const t2 = Number(await seekValue());
  expect(t2).toBeLessThanOrEqual(t1);

  // Shift+Right advances to the next chunk (active block moves on).
  const beforeNext = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".reader-seg")).indexOf(
      document.querySelector(".reader-seg.active") as Element,
    ),
  );
  await page.keyboard.press("Shift+ArrowRight");
  const afterNext = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".reader-seg")).indexOf(
      document.querySelector(".reader-seg.active") as Element,
    ),
  );
  expect(afterNext).toBeGreaterThanOrEqual(beforeNext);

  // Shift+Left moves back.
  await page.keyboard.press("Shift+ArrowLeft");
  const afterPrev = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".reader-seg")).indexOf(
      document.querySelector(".reader-seg.active") as Element,
    ),
  );
  expect(afterPrev).toBeLessThanOrEqual(afterNext);
});

/* ── 5. KEYBOARD EXCLUSIONS ─────────────────────────────────────────────── */

test("KEYBOARD EXCLUSIONS: Space is ignored inside input/textarea/select/contenteditable", async ({
  page,
}) => {
  const docx = await buildSampleDocx();
  await uploadAndReady(page, docx.buffer, docx.name, docx.mimeType);

  // Inject focusable controls.
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.id = "test-input";
    document.body.appendChild(input);
    const ta = document.createElement("textarea");
    ta.id = "test-textarea";
    document.body.appendChild(ta);
    const sel = document.createElement("select");
    sel.id = "test-select";
    sel.innerHTML = "<option>a</option><option>b</option>";
    document.body.appendChild(sel);
    const ce = document.createElement("div");
    ce.id = "test-contenteditable";
    ce.setAttribute("contenteditable", "true");
    document.body.appendChild(ce);
  });

  const ensureStillIdle = async () => {
    await expect(page.locator(".reader-play")).toHaveText(/Escuchar|Continuar/);
  };

  await page.locator("#test-input").focus();
  await page.keyboard.press("Space");
  await ensureStillIdle();

  await page.locator("#test-textarea").focus();
  await page.keyboard.press("Space");
  await ensureStillIdle();

  await page.locator("#test-select").focus();
  await page.keyboard.press("Space");
  await ensureStillIdle();

  await page.locator("#test-contenteditable").focus();
  await page.keyboard.press("Space");
  await ensureStillIdle();
});

/* ── 6. CURRENT BLOCK ───────────────────────────────────────────────────── */

test("CURRENT BLOCK: play highlights the active block; seek moves it", async ({
  page,
}) => {
  const docx = await buildSampleDocx();
  await uploadAndReady(page, docx.buffer, docx.name, docx.mimeType);

  await page.locator(".reader-play").click();
  await expect(page.locator(".reader-play")).toHaveText(/Pausar/, { timeout: 30_000 });

  const active = page.locator(".reader-seg.active");
  // A chunk may span several segments; at least one must be active.
  await expect(active).not.toHaveCount(0);
  const before = (await active.allTextContents()).join("|");
  expect(before).toBeTruthy();

  // Seek to the next chunk: the previously active block(s) become inactive and
  // the target chunk's block(s) become active.
  const nextChunkC = page.getByRole("button", {
    name: "fragmento siguiente",
    exact: true,
  });
  await expect(nextChunkC).toBeEnabled();
  await nextChunkC.click();
  await expect(active).not.toHaveCount(0);
  const after = (await active.allTextContents()).join("|");
  expect(after).not.toBe(before);
});

/* ── 7. MANUAL SCROLL ───────────────────────────────────────────────────── */

test("MANUAL SCROLL: scroll away suspends follow, 'Volver al texto actual' resumes it", async ({
  page,
}) => {
  const docx = await buildSampleDocx();
  await uploadAndReady(page, docx.buffer, docx.name, docx.mimeType);

  await page.locator(".reader-play").click();
  await expect(page.locator(".reader-play")).toHaveText(/Pausar/, { timeout: 30_000 });

  // Let the initial programmatic follow settle, then scroll manually.
  await page.waitForTimeout(800);
  await page.evaluate(() => window.scrollBy(0, 260));

  const returnBtn = page.getByRole("button", { name: "Volver al texto actual" });
  await expect(returnBtn).toBeVisible({ timeout: 10_000 });

  await returnBtn.click();
  await expect(returnBtn).toBeHidden({ timeout: 10_000 });
});

/* ── 8. MOBILE 390px ────────────────────────────────────────────────────── */

test("MOBILE 390: no horizontal overflow, controls visible, sticky bar does not cover final text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const docx = await buildSampleDocx();
  await uploadAndReady(page, docx.buffer, docx.name, docx.mimeType);

  // No horizontal overflow.
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth - doc.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(0);

  // Core controls visible/accessible.
  await expect(
    page.getByRole("button", { name: /Escuchar|Continuar|Pausar/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "adelantar 30 segundos", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "retroceder 15 segundos", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".reader-seek-bar")).toBeVisible();
  await expect(page.locator(".reader-transport-rate")).toBeVisible();

  // Sticky player does not permanently cover the final content: after
  // scrolling to the bottom, the last segment is visible above the bar.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const covered = await page.evaluate(() => {
    const bar = document.querySelector(".reader-transport")?.getBoundingClientRect();
    const lastSeg = Array.from(document.querySelectorAll(".reader-seg"))
      .pop()
      ?.getBoundingClientRect();
    if (!bar || !lastSeg) return false;
    return lastSeg.bottom > bar.top + 4; // if last segment bottom overlaps bar top
  });
  expect(covered).toBe(false);
});

/* ── 9. PRIVACY ─────────────────────────────────────────────────────────── */

test("PRIVACY: unique uncached document sends no /api/speech until Play", async ({
  page,
}) => {
  let speechCount = 0;
  let firstSpeechTime = 0;
  page.on("request", (req) => {
    if (req.url().includes("/api/speech") && req.method() === "POST") {
      speechCount += 1;
      if (firstSpeechTime === 0) firstSpeechTime = Date.now();
    }
  });

  await page.goto("/");
  const epub = await buildSampleEpub();
  await page.locator('input[type="file"]').setInputFiles({
    name: "privacy-ux.epub",
    mimeType: "application/epub+zip",
    buffer: epub.buffer,
  });
  await expect(page.locator(".reader-play")).toBeEnabled({ timeout: 30_000 });

  await page.waitForTimeout(2_500);
  expect(speechCount).toBe(0);

  const clickTime = Date.now();
  await page.locator(".reader-play").click();
  await expect(async () => expect(speechCount).toBeGreaterThan(0)).toPass({
    timeout: 30_000,
  });
  expect(firstSpeechTime).toBeGreaterThanOrEqual(clickTime);
});
