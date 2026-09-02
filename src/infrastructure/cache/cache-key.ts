import type { SpeechSettings } from "@/domain/speech/types";
import { SPOKEN_ENGINE_VERSION } from "@/domain/spoken/version";

/**
 * Deterministic cache key covering everything that affects audio bytes:
 * spoken text, provider, model, voice, speed, format and the spoken engine
 * version. Changing a normalization rule bumps SPOKEN_ENGINE_VERSION, which
 * makes obsolete audio unreachable without explicit invalidation.
 *
 * Runs on WebCrypto so the browser and the server compute identical keys
 * (client-side IndexedDB pre-check + server-side filesystem cache).
 */
export async function computeAudioCacheKey(
  text: string,
  settings: SpeechSettings,
): Promise<string> {
  const material = JSON.stringify({
    t: text,
    p: settings.provider,
    m: settings.model,
    v: settings.voice,
    s: settings.speed,
    f: settings.format,
    e: SPOKEN_ENGINE_VERSION,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
