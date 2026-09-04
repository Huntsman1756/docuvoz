/**
 * Provider extension point (Personal Reader v0.3).
 *
 * This file documents the architectural extension points for adding a second
 * TTS provider (e.g. a high-quality Spanish provider) without changing the
 * reader UI architecture.
 *
 * ─────────────────────────────────────────────────────────────────────
 * HOW TO ADD A NEW PROVIDER
 *
 * 1. Create an adapter in src/adapters/speech-providers/
 *
 *    class MyProvider implements SpeechProvider {
 *      readonly name = "my-provider";
 *      async synthesize(request: SpeechRequest): Promise<SpeechResult> { … }
 *    }
 *
 * 2. Wire it into the engine registry in src/server/config.ts
 *
 *    In createEngines(), add a conditional block similar to the Edge TTS
 *    provider:
 *
 *    if (config.MY_PROVIDER_ENABLED) {
 *      engines.push({
 *        id: "my-provider",
 *        label: "Mi Proveedor",
 *        provider: pace(config, new MyProvider({ ... })),
 *        model: "my-model",
 *        defaultVoice: "my-default-voice",
 *        format: "mp3",
 *      });
 *    }
 *
 * 3. Add the engine to the client catalog in src/lib/voices.ts
 *
 *    - Add a VOICES entry per language.
 *    - Extend ENGINES registry with the new engine info.
 *    - Optionally add resolution rules (e.g. "Spanish → my-provider when
 *      configured, English → default").
 *
 * 4. Add environment variables (if opt-in):
 *    - MY_PROVIDER_ENABLED (boolean flag)
 *    - MY_PROVIDER_BASE_URL, MY_PROVIDER_API_KEY, etc.
 *
 * ─────────────────────────────────────────────────────────────────────
 * LANGUAGE-BASED ROUTING (future)
 *
 * The resolveEngine() function in src/lib/voices.ts is the intended place
 * for language-based provider selection:
 *
 *   export function resolveEngine(choice, lang, available): EngineId {
 *     if (choice !== "auto" && available.includes(choice)) return choice;
 *     // New routing policy:
 *     if (lang === "es" && available.includes("premium-es"))
 *       return "premium-es";
 *     if (lang === "en" && available.includes("premium-en"))
 *       return "premium-en";
 *     return "default";
 *   }
 *
 * The reader UI does not need to change — it already shows the engine
 * picker when multiple engines are available, and hides the picker when
 * only one engine exists.
 *
 * ─────────────────────────────────────────────────────────────────────
 * CURRENT ARCHITECTURE
 *
 * Providers → PacedProvider (concurrency, retries, interval) → EngineRuntime
 *
 * Each engine has:
 *   - id: opaque client-facing identifier ("default", "premium", ...)
 *   - label: product-facing label (never a provider brand)
 *   - provider: the SpeechProvider instance (wrapped by PacedProvider)
 *   - model: server-side model name (internal)
 *   - defaultVoice: voice used when client omits override
 *   - format: container format the engine produces (wav, mp3, ...)
 *
 * The client only sees engine ids and labels. Provider names, models, and
 * credential details stay in /lab and server logs.
 *
 * ─────────────────────────────────────────────────────────────────────
 * DESIGN DECISIONS
 *
 * - No provider selection in the personal reader UI. Engine selection (if
 *   multiple engines are available) is coarse-grained ("Estándar" / "Premium")
 *   and label-based. This prevents exposing provider brands to the product.
 *
 * - Voice catalogs are per-language in voices.ts. Each engine has its own
 *   voice list. Changing engine automatically changes the available voices.
 *
 * - Cache keys are content-addressed (SHA-256 of text + settings). Switching
 *   providers does NOT invalidate existing cache entries — they remain valid
 *   for future use under their original settings.
 *
 * - No fake providers. If a provider requires credentials/config, it must be
 *   explicitly enabled. The UI only shows engines that the server reports as
 *   available (via /api/health).
 */

import type { EngineId } from "@/lib/voices";

/**
 * Engine info that the server registry exposes to the client.
 * Kept here so tests can import the interface without importing the server.
 */
export interface ProviderEngineInfo {
  id: EngineId;
  label: string;
  /** Product-facing description (used in tooltips, never in primary controls). */
  description?: string;
}

/**
 * Validation that a provider configuration is usable.
 * Call this from the server's createEngines() or from an opt-in check.
 */
export function validateProviderConfig(
  enabled: boolean,
  requiredKeys: Record<string, string | undefined>,
): string[] {
  const issues: string[] = [];
  if (!enabled) return issues;
  for (const [key, value] of Object.entries(requiredKeys)) {
    if (!value) issues.push(`${key} is required when provider is enabled`);
  }
  return issues;
}
