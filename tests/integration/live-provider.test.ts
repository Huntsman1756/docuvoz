/**
 * OPT-IN live provider test. It NEVER runs in CI: set RUN_LIVE_PROVIDER=1
 * plus a valid NAN_BASE_URL / NAN_API_KEY to exercise the real endpoint from
 * a local machine. Keep it honest — this validates wiring, not licensing.
 */
import { describe, expect, it } from "vitest";
import { NanSpeechProvider } from "@/adapters/speech-providers/nan-provider";
import { loadConfig } from "@/server/config";

const enabled = process.env.RUN_LIVE_PROVIDER === "1";

describe.skipIf(!enabled)("live NaN provider", () => {
  it("synthesizes a short Spanish phrase", async () => {
    const config = loadConfig();
    if (config.SPEECH_PROVIDER !== "nan") {
      throw new Error("run with SPEECH_PROVIDER=nan to test the live provider");
    }
    const provider = new NanSpeechProvider({
      baseUrl: config.NAN_BASE_URL as string,
      apiKey: config.NAN_API_KEY as string,
      timeoutMs: config.SPEECH_TIMEOUT_MS,
    });
    const started = Date.now();
    const result = await provider.synthesize({
      text: "El artículo cinco, apartado dos, letra be.",
      settings: {
        provider: "nan",
        model: config.NAN_TTS_MODEL,
        voice: config.NAN_TTS_VOICE,
        speed: 1,
        format: config.NAN_TTS_FORMAT,
      },
    });
    const ms = Date.now() - started;
    expect(result.audio.byteLength).toBeGreaterThan(1000);
    console.info(`live provider latency: ${ms} ms, ${result.audio.byteLength} bytes`);
  }, 60_000);
});
