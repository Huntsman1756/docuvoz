/**
 * Part 13 — document-switch race E2E (multi-format).
 *
 * Switching documents while a previous one is still playing must destroy the
 * old player cleanly: no leaked AbortError, no ghost content or controls from
 * the discarded document, and the surviving document behaves correctly. This
 * extends the PDF-only switches in reader.spec.ts to real EPUB/DOCX/TXT.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  buildSampleEpub,
  buildSampleDocx,
  SAMPLE_TXT,
  SAMPLE_EPUB_MARKERS as E,
  SAMPLE_DOCX_MARKERS as D,
} from "./helpers/doc-fixtures";

type Feed = { name: string; mimeType: string; buffer: Buffer };

async function feed(page: Page, f: Feed) {
  await page.locator('input[type="file"]').setInputFiles({
    name: f.name,
    mimeType: f.mimeType,
    buffer: f.buffer,
  });
}

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

function trackSpeech(page: Page): {
  counts: () => Map<string, number>;
  reset: () => void;
} {
  let counts = new Map<string, number>();
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
  return {
    counts: () => counts,
    reset: () => {
      counts = new Map();
    },
  };
}

const play = (page: Page) => page.locator(".reader-play");

test("switching EPUB → DOCX → TXT mid-playback leaves a clean final document", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  const speech = trackSpeech(page);
  await page.goto("/");

  const epub = await buildSampleEpub();
  const docx = await buildSampleDocx();
  const docName = page.locator(".reader-doc-name");

  // 1. EPUB loads and starts playing.
  await feed(page, {
    name: "a.epub",
    mimeType: "application/epub+zip",
    buffer: epub.buffer,
  });
  await expect(docName).toContainText(E.title, { timeout: 30_000 });
  await play(page).click();
  await expect(play(page)).toContainText(/Pausar/, { timeout: 45_000 });

  // 2. Swap to DOCX while audio is still running.
  await feed(page, {
    name: "b.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: docx.buffer,
  });
  await expect(docName).toContainText("b.docx", { timeout: 30_000 });

  // 3. Swap again to TXT before DOCX finishes preparing.
  await feed(page, {
    name: "c.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(SAMPLE_TXT, "utf8"),
  });
  await expect(docName).toContainText("c.txt", { timeout: 30_000 });

  // No ghost content from the discarded documents.
  const text = page.locator(".reader-text");
  await expect(text).toBeVisible();
  const joined = (await text.locator(".reader-seg").allTextContents()).join("\n");
  expect(joined).not.toContain(E.chap1Text);
  expect(joined).not.toContain(D.para1);
  expect(joined).toContain("Tercer párrafo final.");

  // The discarded EPUB is no longer the loaded document.
  await expect(docName).not.toContainText(E.title);

  // No leaked cancellation errors from the churn.
  const abortish = errors.filter((e) => /AbortError|signal is aborted/i.test(e));
  expect(abortish).toEqual([]);

  // The survivor actually synthesizes on play (not a stuck/dead player). The
  // per-chunk dedup invariant under normal playback is asserted in reader.spec
  // and the multi-format specs; here rapid teardown can legitimately produce
  // an abort→refetch of the same chunk, so we check for cross-document ghost
  // fetches instead — a discarded document re-entering the stream.
  speech.reset();
  await play(page).click();
  await expect(play(page)).toContainText(/Pausar/, { timeout: 45_000 });
  const spoken = [...speech.counts().keys()].join("\n");
  expect(spoken).not.toContain(E.chap1Text);
  expect(spoken).not.toContain(D.para1);
});

test("rapid re-upload of the same document settles on it, playable, error-free", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await page.goto("/");

  const epub = await buildSampleEpub();
  const one: Feed = {
    name: "same.epub",
    mimeType: "application/epub+zip",
    buffer: epub.buffer,
  };
  const docName = page.locator(".reader-doc-name");

  // Fire three uploads back-to-back for the same file.
  await feed(page, one);
  await feed(page, one);
  await feed(page, one);

  await expect(docName).toContainText(E.title, { timeout: 30_000 });
  await expect(page.locator(".reader-text")).toContainText(E.chap1Text, {
    timeout: 30_000,
  });

  // No leaked cancellation errors from the back-to-back teardowns.
  const abortish = errors.filter((e) => /AbortError|signal is aborted/i.test(e));
  expect(abortish).toEqual([]);

  // Exactly one live player survived the three teardowns (no ghost controls),
  // and a single click drives it to playing. (Per-chunk dedup under normal
  // playback is covered by reader.spec and the multi-format specs.)
  await expect(page.locator(".reader-play")).toHaveCount(1);
  await play(page).click();
  await expect(play(page)).toContainText(/Pausar/, { timeout: 45_000 });
});
