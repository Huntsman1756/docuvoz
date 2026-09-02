import { getServerRuntime } from "@/server/config";
import { SPOKEN_ENGINE_VERSION } from "@/domain/spoken/version";

export const dynamic = "force-dynamic";

/**
 * Non-secret runtime descriptor. The client uses these defaults to compute
 * identical cache keys; nothing here reveals credentials.
 */
export async function GET(): Promise<Response> {
  try {
    const { config } = getServerRuntime();
    const isNan = config.SPEECH_PROVIDER === "nan";
    return Response.json({
      ok: true,
      provider: isNan ? "nan" : "mock",
      model: isNan ? config.NAN_TTS_MODEL : "mock-v1",
      voice: isNan ? config.NAN_TTS_VOICE : "mock",
      speed: config.SPEECH_DEFAULT_SPEED,
      format: isNan ? config.NAN_TTS_FORMAT : "wav",
      maxTextChars: config.SPEECH_MAX_TEXT_CHARS,
      spokenEngineVersion: SPOKEN_ENGINE_VERSION,
    });
  } catch {
    return Response.json({ ok: false, error: "misconfigured" }, { status: 500 });
  }
}
