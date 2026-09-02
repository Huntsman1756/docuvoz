/**
 * Client-side document audio export (Personal Reader v0.2).
 *
 * Synthesizes the whole document by requesting each Listen chunk from the same
 * /api/speech endpoint the player uses (so provider pacing, retries and the
 * content-addressed cache are all reused), then concatenates the returned PCM
 * WAVs into ONE continuous file. Chunks are not byte-glued blindly: the WAV
 * headers are parsed, their sample format must match, and a single correct
 * header is written over the combined data.
 *
 * Lives in the client bundle (imported only by client components). No server
 * secrets or new routes are involved.
 */

interface PcmWav {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  data: Uint8Array;
}

function parseWav(buf: Uint8Array): PcmWav {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 44 || String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== "RIFF") {
    throw new Error("audio_not_wav");
  }
  let off = 12;
  let fmt: {
    channels: number;
    sampleRate: number;
    bitDepth: number;
    audioFormat: number;
  } | null = null;
  let data: Uint8Array | null = null;
  while (off + 8 <= buf.length) {
    const id = String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
    const size = view.getUint32(off + 4, true);
    if (id === "fmt ") {
      fmt = {
        audioFormat: view.getUint16(off + 8, true),
        channels: view.getUint16(off + 10, true),
        sampleRate: view.getUint32(off + 12, true),
        bitDepth: view.getUint16(off + 16, true),
      };
    } else if (id === "data") {
      data = buf.slice(off + 8, off + 8 + size);
    }
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("audio_malformed_wav");
  if (fmt.audioFormat !== 1) throw new Error("audio_not_pcm"); // PCM only
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitDepth: fmt.bitDepth,
    data,
  };
}

function encodeWav(
  chunksData: Uint8Array[],
  meta: { sampleRate: number; channels: number; bitDepth: number },
): Blob {
  const total = chunksData.reduce((n, c) => n + c.length, 0);
  const bytesPerSample = meta.bitDepth / 8;
  const byteRate = meta.sampleRate * meta.channels * bytesPerSample;
  const buf = new ArrayBuffer(44 + total);
  const view = new DataView(buf);
  const wstr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  wstr(0, "RIFF");
  view.setUint32(4, 36 + total, true);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, meta.channels, true);
  view.setUint32(24, meta.sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, meta.channels * bytesPerSample, true);
  view.setUint16(34, meta.bitDepth, true);
  wstr(36, "data");
  view.setUint32(40, total, true);
  let o = 44;
  for (const c of chunksData) {
    new Uint8Array(buf, o, c.length).set(c);
    o += c.length;
  }
  return new Blob([buf], { type: "audio/wav" });
}

export interface ExportProgress {
  done: number;
  total: number;
}

/**
 * Fetch every chunk (sequentially — the server paces and caches them) and return
 * a single continuous WAV Blob for the whole document.
 */
export async function exportDocumentAudio(
  texts: string[],
  opts: {
    voice?: string;
    signal?: AbortSignal;
    onProgress?: (p: ExportProgress) => void;
  },
): Promise<Blob> {
  if (texts.length === 0) throw new Error("nothing_to_export");
  const pcm: PcmWav[] = [];
  for (let i = 0; i < texts.length; i++) {
    if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const res = await fetch("/api/speech", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: texts[i],
        ...(opts.voice ? { voice: opts.voice } : {}),
        speed: 1,
        format: "wav",
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      let code = "export_failed";
      try {
        code = ((await res.json()) as { error?: string }).error ?? code;
      } catch {
        /* ignore */
      }
      throw new Error(code);
    }
    pcm.push(parseWav(new Uint8Array(await res.arrayBuffer())));
    opts.onProgress?.({ done: i + 1, total: texts.length });
  }
  const ref = pcm[0];
  for (const p of pcm) {
    if (
      p.sampleRate !== ref.sampleRate ||
      p.channels !== ref.channels ||
      p.bitDepth !== ref.bitDepth
    ) {
      throw new Error("export_mixed_formats");
    }
  }
  return encodeWav(
    pcm.map((p) => p.data),
    ref,
  );
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
