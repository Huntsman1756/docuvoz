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
  const { config, provider } = getServerRuntime();
  limiter ??= new SlidingWindowRateLimiter(config.API_RATE_LIMIT_PER_MINUTE);
  cache ??= new FileAudioCache(config.SPEECH_CACHE_DIR);
  return { config, provider, limiter, cache };
}

export async function POST(request: NextRequest): Promise<Response> {
  const { config, provider, limiter, cache } = runtime();
  const logger = createLogger({ component: "api.speech" });

  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > config.API_MAX_BODY_BYTES) {
    return toResponse({
      status: 413,
      headers: { "content-type": "application/json" },
      body: { error: "too_large" },
    });
  }
  let raw: unknown;
  try {
    raw = await request.json();
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
    { config, provider, cache, limiter, logger },
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
