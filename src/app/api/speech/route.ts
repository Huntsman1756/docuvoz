import { NextRequest } from "next/server";
import { clientKeyFromHeaders, handleSpeech } from "@/server/api/speech-handler";
import { getServerRuntime } from "@/server/config";
import { FileAudioCache } from "@/infrastructure/cache/file-audio-cache";
import { SlidingWindowRateLimiter } from "@/server/rate-limit";
import { createLogger } from "@/infrastructure/logging/logger";

// Speech synthesis is a side-effectful proxy call: never static, never cached
// by Next itself.
export const dynamic = "force-dynamic";

let limiter: SlidingWindowRateLimiter | null = null;
let cache: FileAudioCache | null = null;

function runtime() {
  const { config, provider, engines } = getServerRuntime();
  limiter ??= new SlidingWindowRateLimiter(config.API_RATE_LIMIT_PER_MINUTE);
  cache ??= new FileAudioCache(config.SPEECH_CACHE_DIR);
  return { config, provider, engines, limiter, cache };
}

/**
 * Read the request body incrementally, counting actual received bytes.
 * Rejects immediately when the accumulated byte count exceeds `maxBytes`.
 *
 * This defends against:
 *  - missing Content-Length (streamed/chunked body)
 *  - lying small Content-Length (header says 100, body sends 1 GB)
 *  - oversized JSON payloads that would OOM during parse
 *
 * Uses the Web Streams API (ReadableStream) available in Node 18+ and
 * all modern browsers.
 */
async function readBodyBounded(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        reader.cancel().catch(() => undefined);
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw error;
    // Stream aborted (client disconnect) or other read error
    throw error;
  }
  // Concatenate all chunks into a single Uint8Array
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

class BodyTooLargeError extends Error {
  constructor() {
    super("body_too_large");
    this.name = "BodyTooLargeError";
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const { config, provider, engines, limiter, cache } = runtime();
  const logger = createLogger({ component: "api.speech" });

  // Accept only application/json for speech requests
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return toResponse({
      status: 415,
      headers: { "content-type": "application/json" },
      body: { error: "unsupported_media_type" },
    });
  }

  // Incremental body read with byte counting — replaces the old
  // Content-Length-only check. Rejects while streaming, not after.
  let rawBody: Uint8Array;
  try {
    rawBody = await readBodyBounded(request.body, config.API_MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return toResponse({
        status: 413,
        headers: { "content-type": "application/json" },
        body: { error: "too_large" },
      });
    }
    return toResponse({
      status: 400,
      headers: { "content-type": "application/json" },
      body: { error: "invalid_request" },
    });
  }

  // Decode and parse JSON from the bounded buffer
  let raw: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
    raw = JSON.parse(text);
  } catch {
    return toResponse({
      status: 400,
      headers: { "content-type": "application/json" },
      body: { error: "invalid_request" },
    });
  }

  const result = await handleSpeech(
    raw,
    clientKeyFromHeaders(request.headers),
    { config, provider, engines, cache, limiter, logger },
    request.signal,
  );
  return toResponse(result);
}

function toResponse(result: {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
  audio?: Uint8Array;
}): Response {
  const body =
    result.audio ?? (result.body !== undefined ? JSON.stringify(result.body) : undefined);
  return new Response(body as BodyInit, {
    status: result.status,
    headers: result.headers,
  });
}
