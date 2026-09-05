/**
 * Document → audiobook export engine.
 *
 * Uses Mediabunny for encoding. Reuses the existing speech cache (shared
 * with playback) so no TTS is re-synthesized during export.
 *
 * Memory model: decodes one chunk at a time, feeding it to the encoder
 * immediately. Only one AudioBuffer is live at any moment (plus whatever
 * Mediabunny buffers internally). This bounds memory usage for long
 * documents.
 */

import {
  Output,
  WavOutputFormat,
  Mp3OutputFormat,
  Mp4OutputFormat,
  AudioBufferSource,
  BufferTarget,
  Quality,
} from "mediabunny";
import type { ExportFormat, ExportMetadata, ExportProgress } from "./types";
import { ensureEncoders } from "./encoders";

/** Decode a Blob to an AudioBuffer via the Web Audio API. */
async function decodeToBuffer(blob: Blob, ctx: AudioContext): Promise<AudioBuffer> {
  const bytes = await blob.arrayBuffer();
  return await new Promise<AudioBuffer>((resolve, reject) => {
    const maybe = ctx.decodeAudioData(bytes, resolve, reject) as unknown;
    if (maybe instanceof Promise) maybe.then(resolve, reject);
  });
}

function createOutputFormat(format: ExportFormat): Output["format"] {
  switch (format) {
    case "wav":
      return new WavOutputFormat();
    case "mp3":
      return new Mp3OutputFormat({ xingHeader: true });
    case "m4a":
      return new Mp4OutputFormat({ fastStart: "in-memory" });
  }
}

function createCodecName(format: ExportFormat): "pcm-f32" | "mp3" | "aac" {
  switch (format) {
    case "wav":
      return "pcm-f32";
    case "mp3":
      return "mp3";
    case "m4a":
      return "aac";
  }
}

function createQuality(format: ExportFormat): Quality {
  switch (format) {
    case "wav":
      return new Quality("very-high");
    case "mp3":
      return new Quality("high");
    case "m4a":
      return new Quality("high");
  }
}

/**
 * Export a document's speech chunks to a single audio file.
 *
 * @param total - Total number of chunks.
 * @param getBlob - Supplier for chunk blobs (shared with playback cache).
 * @param opts - Format, metadata, signal, progress.
 * @returns A Blob containing the encoded audio file.
 */
export async function exportDocumentAudio(
  total: number,
  getBlob: (index: number) => Promise<Blob>,
  opts: {
    format?: ExportFormat;
    metadata?: ExportMetadata;
    onProgress?: (p: ExportProgress) => void;
    isCancelled?: () => boolean;
    signal?: AbortSignal;
  } = {},
): Promise<Blob> {
  if (total <= 0) throw new Error("nothing_to_export");

  const format = opts.format ?? "wav";

  // Ensure WASM encoders are registered (lazy, one-time)
  await ensureEncoders();

  const AudioCtx: typeof AudioContext =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  let output: Output | null = null;

  try {
    // Decode first chunk to verify it works and to pre-warm the AudioContext
    const firstBlob = await getBlob(0);
    if (opts.isCancelled?.()) throw new ExportCancelledError();
    const firstBuffer = await decodeToBuffer(firstBlob, ctx);

    // Create Mediabunny output
    const target = new BufferTarget();
    output = new Output({
      format: createOutputFormat(format),
      target,
    });

    const source = new AudioBufferSource({
      codec: createCodecName(format),
      quality: createQuality(format),
    });

    output.addAudioTrack(source, {
      languageCode: "spa",
      name: opts.metadata?.title ?? "Audio",
    });

    // Set metadata
    if (opts.metadata) {
      output.setMetadataTags({
        title: opts.metadata.title,
        artist: opts.metadata.author,
        album: opts.metadata.title,
      });
    }

    await output.start();

    // Feed first buffer
    await source.add(firstBuffer);
    opts.onProgress?.({ done: 1, total });

    // Process remaining chunks one at a time (bounded memory)
    for (let i = 1; i < total; i++) {
      if (opts.isCancelled?.()) throw new ExportCancelledError();

      const blob = await getBlob(i);
      if (opts.isCancelled?.()) throw new ExportCancelledError();

      const buf = await decodeToBuffer(blob, ctx);
      await source.add(buf);

      opts.onProgress?.({ done: i + 1, total });
    }

    source.close();
    await output.finalize();

    const buffer = target.buffer;
    if (!buffer) throw new Error("export_failed_no_output");

    return new Blob([buffer], { type: getMimeType(format) });
  } catch (err) {
    if (output) void output.cancel().catch(() => undefined);
    throw err;
  } finally {
    if (output) void output.cancel().catch(() => undefined);
    void ctx.close().catch(() => undefined);
  }
}

function getMimeType(format: ExportFormat): string {
  switch (format) {
    case "wav":
      return "audio/wav";
    case "mp3":
      return "audio/mpeg";
    case "m4a":
      return "audio/mp4";
  }
}

export class ExportCancelledError extends Error {
  constructor() {
    super("export_cancelled");
    this.name = "AbortError";
  }
}

export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
