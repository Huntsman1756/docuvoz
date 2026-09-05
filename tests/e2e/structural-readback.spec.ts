/**
 * Structural readback E2E tests.
 *
 * Validates exported files using independent binary parsing (magic bytes,
 * container atoms, audio parameters). This provides a minimal independent
 * smoke assertion without depending on Mediabunny's Input API (which
 * requires WebCodecs and cannot be loaded via bare module specifier in
 * page.evaluate).
 *
 * For each implemented output (WAV, MP3, M4A) reads:
 *  - format/container validation
 *  - primary audio track existence (container-level)
 *  - duration (where computable from headers)
 *  - codec (where identifiable from container)
 *
 * Full Mediabunny Input API readback should be done in a dedicated
 * integration test harness with proper module resolution.
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

async function exportFormat(page: Page, format: "WAV" | "MP3" | "M4A"): Promise<Buffer> {
  const downloadBtn = page.getByRole("button", { name: /audio/i });
  await expect(downloadBtn).toBeVisible({ timeout: 30_000 });
  await downloadBtn.click();

  await page.getByRole("button", { name: format }).click();

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    page.getByRole("button", { name: "Exportar audio" }).click(),
  ]);

  const path = await download.path();
  expect(path).not.toBeNull();
  return path ? fs.promises.readFile(path) : Buffer.alloc(0);
}

/* ------------------------------------------------------------------ */
/*  WAV structural readback                                            */
/* ------------------------------------------------------------------ */

test("WAV structural readback", async ({ page }) => {
  await loadFixture(page, "Documento simple");
  const buf = await exportFormat(page, "WAV");

  // RIFF header
  expect(buf.subarray(0, 4).toString("ascii")).toBe("RIFF");
  expect(buf.subarray(8, 12).toString("ascii")).toBe("WAVE");

  // Find "fmt " chunk for audio parameters
  let fmtOffset = -1;
  for (let i = 12; i < buf.length - 8; i += 2) {
    if (buf.toString("ascii", i, i + 4) === "fmt ") {
      fmtOffset = i;
      break;
    }
  }
  expect(fmtOffset).toBeGreaterThan(11);

  // Read fmt chunk parameters (after "fmt " + size field)
  const audioFormat = buf.readUInt16LE(fmtOffset + 8);
  const numChannels = buf.readUInt16LE(fmtOffset + 10);
  const sampleRate = buf.readUInt32LE(fmtOffset + 12);
  const bitsPerSample = buf.readUInt16LE(fmtOffset + 22);

  // audioFormat: 1 = PCM integer, 3 = IEEE float (pcm-f32)
  // Mediabunny's WavOutputFormat with pcm-f32 codec produces format 3
  expect([1, 3]).toContain(audioFormat);
  expect(numChannels).toBeGreaterThanOrEqual(1);
  expect(numChannels).toBeLessThanOrEqual(2);
  expect(sampleRate).toBeGreaterThan(0);
  // bitsPerSample: 16 for PCM, 32 for IEEE float
  expect([16, 32]).toContain(bitsPerSample);

  // Find "data" chunk
  let dataOffset = -1;
  for (let i = fmtOffset + 4; i < buf.length - 8; i += 2) {
    if (buf.toString("ascii", i, i + 4) === "data") {
      dataOffset = i;
      break;
    }
  }
  expect(dataOffset).toBeGreaterThan(11);

  const dataLen = buf.readUInt32LE(dataOffset + 4);
  expect(dataLen).toBeGreaterThan(0);

  // Duration = data bytes / (sample rate * channels * bytes per sample)
  const bytesPerSample = bitsPerSample / 8;
  const duration = dataLen / (sampleRate * numChannels * bytesPerSample);
  expect(duration).toBeGreaterThan(0);
  expect(duration).toBeLessThan(120);
});

/* ------------------------------------------------------------------ */
/*  MP3 structural readback                                            */
/* ------------------------------------------------------------------ */

test("MP3 structural readback", async ({ page }) => {
  await loadFixture(page, "Documento simple");
  const buf = await exportFormat(page, "MP3");

  // Valid MP3: starts with ID3v2 tag or MPEG frame sync word
  const hasId3v2 = buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33;
  const hasFrameSync = buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
  expect(hasId3v2 || hasFrameSync).toBe(true);

  // If ID3v2, verify version and skip to find first frame
  let frameOffset = 0;
  if (hasId3v2) {
    const version = buf[3];
    expect(version).toBeGreaterThanOrEqual(2); // ID3v2.2+
    const size = (buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9];
    frameOffset = 10 + size;
    // Frame must exist after ID3v2 tag
    expect(frameOffset).toBeLessThan(buf.length - 4);
    expect(buf[frameOffset]).toBe(0xff);
    expect(buf[frameOffset + 1] & 0xe0).toBe(0xe0);
  }

  // Scan for first valid MPEG frame header
  let foundFrame = false;
  for (let i = frameOffset; i < Math.min(buf.length - 4, frameOffset + 2048); i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
      // Parse MPEG header
      const mpegVersion = (buf[i + 1] >> 3) & 0x03;
      const layer = (buf[i + 1] >> 1) & 0x03;
      const bitrateIndex = (buf[i + 2] >> 4) & 0x0f;
      const sampleRateIndex = (buf[i + 2] >> 2) & 0x03;

      // Valid MPEG1 Layer III
      expect(mpegVersion).toBe(3); // MPEG1
      expect(layer).toBe(1); // Layer III
      expect(bitrateIndex).toBeGreaterThan(0);
      expect(bitrateIndex).toBeLessThan(15);
      expect(sampleRateIndex).toBeLessThan(3);
      foundFrame = true;
      break;
    }
  }
  expect(foundFrame).toBe(true);
});

/* ------------------------------------------------------------------ */
/*  M4A structural readback                                            */
/* ------------------------------------------------------------------ */

test("M4A structural readback", async ({ page }) => {
  await loadFixture(page, "Documento simple");
  const buf = await exportFormat(page, "M4A");

  // Valid MP4 container: bytes 4–7 must be "ftyp"
  const ftypAtom = buf.toString("ascii", 4, 8);
  expect(ftypAtom).toBe("ftyp");

  // Primary brand
  const primaryBrand = buf.toString("ascii", 8, 12);
  expect(primaryBrand.length).toBe(4);

  // Scan for moov atom (contains track info)
  let moovOffset = -1;
  for (let i = 0; i < buf.length - 8;) {
    const atomSize = buf.readUInt32BE(i);
    const atomType = buf.toString("ascii", i + 4, i + 8);
    if (atomType === "moov") {
      moovOffset = i;
      break;
    }
    if (atomSize < 8 || i + atomSize > buf.length) break;
    i += atomSize;
  }
  expect(moovOffset).toBeGreaterThan(-1);

  // Scan within moov for trak atom (audio track)
  let trakOffset = -1;
  for (let i = moovOffset + 8; i < buf.length - 8;) {
    const atomSize = buf.readUInt32BE(i);
    const atomType = buf.toString("ascii", i + 4, i + 8);
    if (atomType === "trak") {
      trakOffset = i;
      break;
    }
    if (atomSize < 8 || i + atomSize > buf.length) break;
    i += atomSize;
  }
  expect(trakOffset).toBeGreaterThan(-1);

  // Scan within trak for mdia atom (media info)
  let mdiaOffset = -1;
  for (let i = trakOffset + 8; i < buf.length - 8;) {
    const atomSize = buf.readUInt32BE(i);
    const atomType = buf.toString("ascii", i + 4, i + 8);
    if (atomType === "mdia") {
      mdiaOffset = i;
      break;
    }
    if (atomSize < 8 || i + atomSize > buf.length) break;
    i += atomSize;
  }
  expect(mdiaOffset).toBeGreaterThan(-1);

  // Scan within mdia for minf atom (media information)
  let minfOffset = -1;
  for (let i = mdiaOffset + 8; i < buf.length - 8;) {
    const atomSize = buf.readUInt32BE(i);
    const atomType = buf.toString("ascii", i + 4, i + 8);
    if (atomType === "minf") {
      minfOffset = i;
      break;
    }
    if (atomSize < 8 || i + atomSize > buf.length) break;
    i += atomSize;
  }
  expect(minfOffset).toBeGreaterThan(-1);

  // Scan within minf for stbl atom (sample table)
  let stblOffset = -1;
  for (let i = minfOffset + 8; i < buf.length - 8;) {
    const atomSize = buf.readUInt32BE(i);
    const atomType = buf.toString("ascii", i + 4, i + 8);
    if (atomType === "stbl") {
      stblOffset = i;
      break;
    }
    if (atomSize < 8 || i + atomSize > buf.length) break;
    i += atomSize;
  }
  expect(stblOffset).toBeGreaterThan(-1);

  // Scan within stbl for stsd atom (sample descriptions)
  let stsdOffset = -1;
  for (let i = stblOffset + 8; i < buf.length - 8;) {
    const atomSize = buf.readUInt32BE(i);
    const atomType = buf.toString("ascii", i + 4, i + 8);
    if (atomType === "stsd") {
      stsdOffset = i;
      break;
    }
    if (atomSize < 8 || i + atomSize > buf.length) break;
    i += atomSize;
  }
  expect(stsdOffset).toBeGreaterThan(-1);

  // Within stsd, find the audio sample entry (mp4a)
  let mp4aOffset = -1;
  for (let i = stsdOffset + 16; i < buf.length - 8;) {
    const atomSize = buf.readUInt32BE(i);
    const atomType = buf.toString("ascii", i + 4, i + 8);
    if (atomType === "mp4a" || atomType === "enca") {
      mp4aOffset = i;
      break;
    }
    if (atomSize < 8 || i + atomSize > buf.length) break;
    i += atomSize;
  }
  expect(mp4aOffset).toBeGreaterThan(-1);

  // Audio track confirmed with AAC codec atom
  const codec = buf.toString("ascii", mp4aOffset + 4, mp4aOffset + 8);
  expect(["mp4a", "enca"]).toContain(codec);
});

/* ------------------------------------------------------------------ */
/*  Duration consistency across formats                                */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Duration consistency across formats (strict invariant)             */
/* ------------------------------------------------------------------ */

function wavDurationFromBuf(buf: Buffer): number {
  let fmtOffset = -1;
  for (let i = 12; i < buf.length - 8; i += 2) {
    if (buf.toString("ascii", i, i + 4) === "fmt ") {
      fmtOffset = i;
      break;
    }
  }
  if (fmtOffset < 0) return 0;
  const sampleRate = buf.readUInt32LE(fmtOffset + 12);
  const numChannels = buf.readUInt16LE(fmtOffset + 10);
  const bitsPerSample = buf.readUInt16LE(fmtOffset + 22);
  let dataOffset = -1;
  for (let i = fmtOffset + 4; i < buf.length - 8; i += 2) {
    if (buf.toString("ascii", i, i + 4) === "data") {
      dataOffset = i;
      break;
    }
  }
  if (dataOffset < 0) return 0;
  const dataLen = buf.readUInt32LE(dataOffset + 4);
  const bytesPerSample = bitsPerSample / 8;
  return dataLen / (sampleRate * numChannels * bytesPerSample);
}

function mp3DurationFromBuf(buf: Buffer): number {
  const SR = [44100, 48000, 32000];
  const BR = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  let offset = 0;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const size = (buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9];
    offset = 10 + size;
  }
  let totalFrames = 0;
  let sampleRate = 44100;
  for (let i = offset; i < buf.length - 4; i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
      const mv = (buf[i + 1] >> 3) & 0x03;
      const layer = (buf[i + 1] >> 1) & 0x03;
      const sr = (buf[i + 2] >> 2) & 0x03;
      const br = (buf[i + 2] >> 4) & 0x0f;
      if (mv === 3 && layer === 1 && sr < 3 && br > 0 && br < 15) {
        sampleRate = SR[sr];
        const bitrate = BR[br] * 1000;
        const frameSize = Math.floor((144 * bitrate) / sampleRate);
        totalFrames++;
        i += frameSize - 1;
      }
    }
  }
  return totalFrames > 0 ? (totalFrames * 1152) / sampleRate : 0;
}

function m4aDurationFromBuf(buf: Buffer): number {
  // Scan the entire file for the mdhd atom directly.
  // mdhd header: 4-byte size + "mdhd" + 1-byte version + 3-byte flags + data.
  // version 0: timescale at +20, duration(uint32) at +24.
  // version 1: timescale at +28, duration(uint64) at +32.
  for (let i = 0; i < buf.length - 16; i++) {
    if (buf.toString("ascii", i + 4, i + 8) !== "mdhd") continue;
    const version = buf[i + 8];
    let timescale: number;
    let duration: bigint;
    if (version === 0) {
      timescale = buf.readUInt32BE(i + 20);
      duration = BigInt(buf.readUInt32BE(i + 24));
    } else if (version === 1) {
      timescale = buf.readUInt32BE(i + 28);
      duration = buf.readBigUInt64BE(i + 32);
    } else {
      continue;
    }
    if (timescale > 0 && duration > BigInt(0)) {
      return Number(duration) / timescale;
    }
  }
  return 0;
}

test("all three formats produce non-trivial audio with strict duration tolerance", async ({
  page,
}) => {
  await loadFixture(page, "Documento simple");

  const wavBuf = await exportFormat(page, "WAV");
  const mp3Buf = await exportFormat(page, "MP3");
  const m4aBuf = await exportFormat(page, "M4A");

  // All must be non-trivial size (at least 1 KB)
  expect(wavBuf.length).toBeGreaterThan(1000);
  expect(mp3Buf.length).toBeGreaterThan(1000);
  expect(m4aBuf.length).toBeGreaterThan(1000);

  // MP3 and M4A should be smaller than WAV (lossy compression)
  expect(mp3Buf.length).toBeLessThan(wavBuf.length);
  expect(m4aBuf.length).toBeLessThan(wavBuf.length);

  // Measure durations
  const wavDur = wavDurationFromBuf(wavBuf);
  const mp3Dur = mp3DurationFromBuf(mp3Buf);
  const m4aDur = m4aDurationFromBuf(m4aBuf);

  expect(wavDur).toBeGreaterThan(0);
  expect(mp3Dur).toBeGreaterThan(0);
  expect(m4aDur).toBeGreaterThan(0);

  // Strict duration invariant: |A − B| ≤ max(0.5s, 2% of reference)
  const tolerance = (a: number, b: number) => Math.max(0.5, 0.02 * Math.max(a, b));

  expect(
    Math.abs(wavDur - mp3Dur),
    `WAV−MP3: |${wavDur.toFixed(2)} − ${mp3Dur.toFixed(2)}| = ${Math.abs(wavDur - mp3Dur).toFixed(3)}s`,
  ).toBeLessThanOrEqual(tolerance(wavDur, mp3Dur));

  expect(
    Math.abs(wavDur - m4aDur),
    `WAV−M4A: |${wavDur.toFixed(2)} − ${m4aDur.toFixed(2)}| = ${Math.abs(wavDur - m4aDur).toFixed(3)}s`,
  ).toBeLessThanOrEqual(tolerance(wavDur, m4aDur));

  expect(
    Math.abs(mp3Dur - m4aDur),
    `MP3−M4A: |${mp3Dur.toFixed(2)} − ${m4aDur.toFixed(2)}| = ${Math.abs(mp3Dur - m4aDur).toFixed(3)}s`,
  ).toBeLessThanOrEqual(tolerance(mp3Dur, m4aDur));
});
