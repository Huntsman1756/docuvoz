/**
 * Voice + language catalog for the Personal Reader.
 *
 * All listed voices are served by the same configured TTS model (currently
 * Kokoro via NaN); selecting a voice only changes the `voice` string sent to the
 * provider, so the existing per-request `voice` override + content-addressed
 * audio cache handle it with no other changes. Defaults mirror NaN's own docs
 * (`af_heart` English, `ef_dora` Spanish).
 */
export type Lang = "es" | "en";

export interface VoiceOption {
  id: string;
  label: string;
}

export const VOICES: Record<Lang, VoiceOption[]> = {
  es: [
    { id: "ef_dora", label: "ef_dora (España · clara)" },
    { id: "em_alex", label: "em_alex (España · hombre)" },
    { id: "em_santa", label: "em_santa (Latinoamérica)" },
  ],
  en: [
    { id: "af_heart", label: "af_heart (US · clara)" },
    { id: "af_bella", label: "af_bella (US)" },
    { id: "bf_emma", label: "bf_emma (UK)" },
  ],
};

export function defaultVoice(lang: Lang): string {
  return VOICES[lang][0].id;
}

export function voicesFor(lang: Lang): VoiceOption[] {
  return VOICES[lang];
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
