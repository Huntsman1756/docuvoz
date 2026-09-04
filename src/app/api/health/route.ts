import { getServerRuntime } from "@/server/config";
import { SPOKEN_ENGINE_VERSION } from "@/domain/spoken/version";

export const dynamic = "force-dynamic";

/**
 * Non-secret runtime descriptor. The client uses these defaults to compute
 * identical cache keys; nothing here reveals credentials. `engines` is the
 * selectable synthesis-engine registry (Personal Reader v0.3): each entry's
 * provider/model/format is exactly what the server folds into the cache key,
 * so the browser can pre-populate IndexedDB under matching keys.
 */
export async function GET(): Promise<Response> {
  try {
    const { config, engines } = getServerRuntime();
    const def = engines[0];
    return Response.json({
      ok: true,
      provider: def.provider.name,
      model: def.model,
      voice: def.defaultVoice,
      speed: config.SPEECH_DEFAULT_SPEED,
      format: def.format,
      maxTextChars: config.SPEECH_MAX_TEXT_CHARS,
      spokenEngineVersion: SPOKEN_ENGINE_VERSION,
      engines: engines.map((e) => ({
        id: e.id,
        label: e.label,
        provider: e.provider.name,
        model: e.model,
        format: e.format,
      })),
    });
  } catch {
    return Response.json({ ok: false, error: "misconfigured" }, { status: 500 });
  }
}
