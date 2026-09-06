import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  buildSampleDocx,
  buildSampleEpub,
  SAMPLE_HTML,
  SAMPLE_MARKDOWN,
  SAMPLE_TXT,
  type FixtureFile,
} from "./helpers/doc-fixtures";

declare global {
  interface Window {
    audioProbe: () => { pending: number; audible: number; rates: number[] };
  }
}

for (const format of ["pdf", "epub", "docx", "txt", "md", "html"]) {
  test(`${format}: native audio pause, paused seek, resume, rate, playing seek, export and switch`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const records: {
        context: BaseAudioContext;
        node: AudioBufferSourceNode;
        when: number;
        offset: number;
        stopped: boolean;
        finished: boolean;
      }[] = [];
      const create = AudioContext.prototype.createBufferSource;
      AudioContext.prototype.createBufferSource = function () {
        const node = create.call(this);
        const record = {
          context: this,
          node,
          when: Infinity,
          offset: 0,
          stopped: false,
          finished: false,
        };
        records.push(record);
        const start = node.start.bind(node),
          stop = node.stop.bind(node);
        node.start = (when = 0, offset = 0, duration?) => {
          record.when = when;
          record.offset = offset;
          start(when, offset, duration);
        };
        node.stop = (when = 0) => {
          record.stopped = true;
          stop(when);
        };
        node.addEventListener("ended", () => {
          record.finished = true;
        });
        return node;
      };
      window.audioProbe = () => {
        const pending = records.filter(
          (r) => !r.stopped && !r.finished && Number.isFinite(r.when),
        );
        const audible = pending.filter(
          (r) =>
            r.context.currentTime >= r.when &&
            r.context.currentTime <
              r.when +
                ((r.node.buffer?.duration ?? 0) - r.offset) / r.node.playbackRate.value,
        );
        return {
          pending: pending.length,
          audible: audible.length,
          rates: audible.map((r) => r.node.playbackRate.value),
        };
      };
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const requests = new Map<string, number>();
    page.on("request", (r) => {
      if (r.url().endsWith("/api/speech") && r.method() === "POST") {
        const text = JSON.parse(r.postData() ?? "{}").text;
        requests.set(text, (requests.get(text) ?? 0) + 1);
      }
    });
    await page.goto("/");
    let fixture: FixtureFile;
    if (format === "epub") fixture = await buildSampleEpub();
    else if (format === "docx") fixture = await buildSampleDocx();
    else if (format === "pdf")
      fixture = {
        name: "controls.pdf",
        mimeType: "application/pdf",
        buffer: readFileSync("public/corpus/pdfs/nested-regulation-01.pdf"),
      };
    else
      fixture = {
        name: `controls.${format}`,
        mimeType: format === "html" ? "text/html" : "text/plain",
        buffer: Buffer.from(
          format === "html"
            ? SAMPLE_HTML
            : format === "md"
              ? SAMPLE_MARKDOWN
              : SAMPLE_TXT,
        ),
      };
    await page.locator('input[type="file"]').setInputFiles(fixture);
    await expect(page.locator(".reader-play")).toBeEnabled();
    await page.getByRole("button", { name: "Opciones avanzadas" }).click();
    // Set speed before playback creates the AudioContext.
    await page
      .getByLabel("velocidad de reproducción", { exact: true })
      .selectOption("1.5");
    await page.locator(".reader-play").click();
    await expect
      .poll(() => page.evaluate(() => window.audioProbe().rates))
      .toEqual([1.5]);
    await page.locator(".reader-play").click();
    await expect.poll(() => page.evaluate(() => window.audioProbe().pending)).toBe(0);
    const nextChunk = page.getByRole("button", { name: "fragmento siguiente", exact: true });
    await expect(nextChunk).toBeEnabled();
    await nextChunk.click();
    await expect(page.locator("main")).toHaveAttribute("data-phase", "paused");
    expect(await page.evaluate(() => window.audioProbe().pending)).toBe(0);
    await page.locator(".reader-play").click();
    await expect.poll(() => page.evaluate(() => window.audioProbe().audible)).toBe(1);
    for (const rate of ["0.75", "2"]) {
      await page
        .getByLabel("velocidad de reproducción", { exact: true })
        .selectOption(rate);
      await expect
        .poll(() => page.evaluate(() => window.audioProbe().rates))
        .toEqual([Number(rate)]);
    }
    await page.getByRole("button", { name: "fragmento anterior", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.audioProbe().audible)).toBe(1);
    await page.getByRole("button", { name: "descargar audio", exact: true }).click();
    await page.getByRole("button", { name: "MP3", exact: true }).click();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Exportar audio", exact: true }).click();
    expect((await downloadPromise).suggestedFilename()).toMatch(/\.mp3$/);
    expect([...requests.values()].every((n) => n === 1)).toBe(true);
    await page.locator('input[type="file"]').setInputFiles({
      name: "replacement.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Documento nuevo, sin audio anterior."),
    });
    await expect.poll(() => page.evaluate(() => window.audioProbe().pending)).toBe(0);
    expect(errors).toEqual([]);
  });
}
