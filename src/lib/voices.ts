/**
 * Voice + language + engine catalog for the Personal Reader.
 *
 * Engines are addressed by opaque id (server engine registry):
 *   "default" — the standard engine configured on the server
 *               (Kokoro via NaN in real deployments);
 *   "edge" — Microsoft Edge neural voices (free, no key, notably better
 *            Spanish prosody). Present only when the server enables it;
 *            the UI hides the engine picker otherwise.
 * "auto" resolves per language: es prefers edge when available, en stays
 * on the standard engine (Kokoro's English voices are already good).
 *
 * Selecting a voice/engine only changes fields sent to /api/speech; the
 * provider override + content-addressed caches handle the rest.
 */
export type Lang = "es" | "en";
export type EngineId = "default" | "edge";
export type EngineChoice = "auto" | EngineId;

export interface VoiceOption {
  id: string;
  label: string;
}

export interface EngineInfo {
  id: EngineId;
  /** Product-facing label; no provider brands. */
  label: string;
  description: string;
}

export const ENGINES: Record<EngineId, EngineInfo> = {
  default: {
    id: "default",
    label: "Estándar",
    description: "Buena en español e inglés",
  },
  edge: {
    id: "edge",
    label: "Edge TTS",
    description:
      "Servicio online de lectura en voz alta de Edge (no oficial, sin clave; disponibilidad no garantizada)",
  },
};

const KOKORO_VOICES: Record<Lang, VoiceOption[]> = {
  es: [
    { id: "ef_dora", label: "Dora — clara (España)" },
    { id: "em_alex", label: "Alex — hombre (España)" },
    { id: "em_santa", label: "Santa — Latinoamérica" },
  ],
  en: [
    { id: "af_heart", label: "Heart — clear (US)" },
    { id: "af_bella", label: "Bella (US)" },
    { id: "bf_emma", label: "Emma (UK)" },
  ],
};

const EDGE_VOICES: Record<Lang, VoiceOption[]> = {
  es: [
    { id: "es-ES-XimenaNeural", label: "Ximena — mujer (España)" },
    { id: "es-ES-AlvaroNeural", label: "Álvaro — hombre (España)" },
    { id: "es-ES-ElviraNeural", label: "Elvira (España)" },
    { id: "es-MX-JorgeNeural", label: "Jorge — hombre (México)" },
    { id: "es-AR-EloisaNeural", label: "Eloísa (Argentina)" },
  ],
  en: [
    { id: "en-US-AriaNeural", label: "Aria (US)" },
    { id: "en-US-GuyNeural", label: "Guy — hombre (US)" },
    { id: "en-GB-RyanNeural", label: "Ryan (UK)" },
  ],
};

/** Voices the server engine accepts; keep in sync with its allowlist. */
export function voicesFor(lang: Lang, engine: EngineId = "default"): VoiceOption[] {
  return (engine === "edge" ? EDGE_VOICES : KOKORO_VOICES)[lang];
}

export function defaultVoice(lang: Lang, engine: EngineId = "default"): string {
  return voicesFor(lang, engine)[0].id;
}

/**
 * Resolve "auto" to a concrete engine given what the server actually has
 * enabled. edge wins for Spanish only (its advantage); English stays on
 * the standard engine.
 */
export function resolveEngine(
  choice: EngineChoice,
  lang: Lang,
  available: EngineId[],
): EngineId {
  if (choice !== "auto" && available.includes(choice)) return choice;
  if (lang === "es" && available.includes("edge")) return "edge";
  return "default";
}

const ES_MARKERS = [
  " de ",
  " del ",
  " la ",
  " el ",
  " los ",
  " las ",
  " un ",
  " una ",
  " que ",
  " por ",
  " con ",
  " para ",
  " artículo ",
  " disposición ",
  " boletín ",
  " oficial ",
  " ciento ",
  " euros ",
  " ley ",
  " Real ",
  " España ",
  " es ",
  " al ",
  " se ",
];
const EN_MARKERS = [
  " the ",
  " of ",
  " and ",
  " a ",
  " to ",
  " in ",
  " that ",
  " is ",
  " for ",
  " with ",
  " article ",
  " section ",
  " shall ",
  " must ",
  " percent ",
  " united ",
  " this ",
  " from ",
  " be ",
  " on ",
];

/**
 * Lightweight, dependency-free language heuristic for document text. Only needs
 * to pick a sensible voice default; the reader also offers a manual override, so
 * false confidence here is low-cost.
 */
export function detectLanguage(text: string): Lang {
  const hay = ` ${text.toLowerCase().replace(/\s+/g, " ")} `;
  const score = (markers: string[]) =>
    markers.reduce((n, m) => n + (hay.split(m).length - 1), 0);
  const es = score(ES_MARKERS);
  const en = score(EN_MARKERS);
  // Also credit accented Spanish characters.
  const accents = (hay.match(/[áéíóúñ¿¡]/g) || []).length;
  return es + accents * 2 >= en ? "es" : "en";
}
