/**
 * Client-side document audio export (Personal Reader v0.3).
 *
 * The export deliberately shares the generation layer with the player: every
 * chunk's Blob comes from `SpeechPlayer.blobFor(i)` (same in-flight dedup,
 * same IndexedDB + server caches), so Download never duplicates work Play
 * already did and vice versa. Cancelling an export stops the loop but leaves
 * in-flight generation alive and cached.
 *
 * Chunks are decoded through WebAudio (so any provider container — PCM WAV,
 * MP3 from the edge engine, ... — works), then resampled to a common rate
 * and encoded once as a 16-bit PCM WAV.
 */

export interface ExportProgress {
  done: number;
  total: number;
}

export class ExportCancelledError extends Error {
  constructor() {
    super("export_cancelled");
    this.name = "AbortError";
  }
}

async function decodeToBuffer(blob: Blob, ctx: AudioContext): Promise<AudioBuffer> {
  const bytes = await blob.arrayBuffer();
  return await new Promise<AudioBuffer>((resolve, reject) => {
    // Callback form kept for Safari; promise form for everyone else.
    const maybe = ctx.decodeAudioData(bytes, resolve, reject) as unknown;
    if (maybe instanceof Promise) maybe.then(resolve, reject);
  });
}

/** Linear-interpolation resample of one channel into `out` at `offset`. */
function resampleChannel(
  input: Float32Array,
  out: Float32Array,
  offset: number,
  inRate: number,
  outRate: number,
): number {
  if (input.length === 0) return offset;
  const ratio = inRate / outRate;
  const count = Math.ceil(input.length / ratio);
  for (let i = 0; i < count; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const frac = pos - i0;
    out[offset + i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return offset + count;
}

function encodePcmWav(channels: Float32Array[], sampleRate: number): Blob {
  const frames = channels[0]?.length ?? 0;
  const channelCount = Math.max(1, channels.length);
  const dataSize = frames * channelCount * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const wstr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  wstr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * 2, true);
  view.setUint16(32, channelCount * 2, true);
  view.setUint16(34, 16, true);
  wstr(36, "data");
  view.setUint32(40, dataSize, true);
  let o = 44;
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channelCount; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][f]));
      view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([buf], { type: "audio/wav" });
}

/**
 * Concatenate every chunk (via the shared blob supplier) into ONE continuous
 * 16-bit PCM WAV.
 */
export async function exportDocumentAudio(
  total: number,
  getBlob: (index: number) => Promise<Blob>,
  opts: {
    onProgress?: (p: ExportProgress) => void;
    isCancelled?: () => boolean;
  } = {},
): Promise<Blob> {
  if (total <= 0) throw new Error("nothing_to_export");
  const AudioCtx: typeof AudioContext =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  try {
    const buffers: AudioBuffer[] = [];
    for (let i = 0; i < total; i++) {
      if (opts.isCancelled?.()) throw new ExportCancelledError();
      buffers.push(await decodeToBuffer(await getBlob(i), ctx));
      // isCancelled may have flipped while awaiting the shared blob.
      if (opts.isCancelled?.()) throw new ExportCancelledError();
      opts.onProgress?.({ done: i + 1, total });
    }
    const sampleRate = Math.max(...buffers.map((b) => b.sampleRate));
    const channels = Math.max(...buffers.map((b) => b.numberOfChannels));
    const totalFrames = buffers.reduce(
      (n, b) => n + Math.ceil((b.length * b.sampleRate) / sampleRate),
      0,
    );
    const out: Float32Array[] = Array.from(
      { length: channels },
      () => new Float32Array(totalFrames),
    );
    let cursor = 0;
    for (const b of buffers) {
      const rb = Math.ceil((b.length * b.sampleRate) / sampleRate);
      const scratch = new Float32Array(rb);
      for (let c = 0; c < channels; c++) {
        // Mono source into a multi-channel mix duplicates to every channel.
        const src = b.numberOfChannels === 1 ? 0 : Math.min(c, b.numberOfChannels - 1);
        scratch.fill(0);
        const used = resampleChannel(
          b.getChannelData(src),
          scratch,
          0,
          b.sampleRate,
          sampleRate,
        );
        out[c].set(scratch.subarray(0, used), cursor);
      }
      cursor += rb;
    }
    return encodePcmWav(out, sampleRate);
  } finally {
    void ctx.close().catch(() => undefined);
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
