/**
 * G3a experiment logic (pure, deterministic, unit-tested).
 *
 * Builds Literal-vs-Manual-Gold pairs for blind listening, with seeded
 * randomization of clip labels and side assignment. Blinding correctness
 * lives here, where tests can reach it — not in an ad-hoc script.
 */
import type { StructuredDocument } from "../../src/domain/documents/types";
import type { GoldEntry } from "./shared";

export interface G3aPair {
  blockId: string;
  /** Source text exactly as extracted — the Literal condition. Never mutated. */
  literalText: string;
  /** Human-authored upper bound — the Gold condition. */
  goldText: string;
}

export type G3aCondition = "literal" | "gold";

export interface G3aAssignment {
  /** Index into the pairs array. */
  pairIndex: number;
  leftClipId: string;
  rightClipId: string;
  leftCondition: G3aCondition;
  /** Position in presentation order (shuffled). */
  presentationOrder: number;
}

export function buildPairs(
  doc: StructuredDocument,
  gold: readonly GoldEntry[],
): G3aPair[] {
  const pairs: G3aPair[] = [];
  for (const entry of gold) {
    const block = doc.blocks.find((b) => b.id === entry.blockId);
    if (!block) {
      throw new Error(`gold entry references unknown block ${entry.blockId}`);
    }
    if (entry.spokenText.trim() === block.text.trim()) {
      // A "gold" identical to the source is not a contrast; exclude it.
      continue;
    }
    pairs.push({
      blockId: entry.blockId,
      literalText: block.text,
      goldText: entry.spokenText,
    });
  }
  return pairs;
}

/** Deterministic PRNG (mulberry32). Same seed ⇒ same experiment. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleSeeded<T>(items: readonly T[], seed: number): T[] {
  const rand = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no ambiguous glyphs

function clipIdFrom(rand: () => number): string {
  let s = "";
  for (let i = 0; i < 8; i++) {
    s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  }
  return `g3a-${s}`;
}

/**
 * Assign each pair to left/right clips with a randomized condition side and
 * a randomized presentation order, plus collision-checked opaque clip ids.
 */
export function assignSides(pairs: readonly G3aPair[], seed: number): G3aAssignment[] {
  const rand = mulberry32(seed ^ 0x9e3779b9);
  const used = new Set<string>();
  const makeId = () => {
    for (;;) {
      const id = clipIdFrom(rand);
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  };
  const order = shuffleSeeded(
    pairs.map((_, i) => i),
    seed,
  );
  return order.map((pairIndex, position) => {
    const goldOnLeft = rand() < 0.5;
    return {
      pairIndex,
      leftClipId: makeId(),
      rightClipId: makeId(),
      leftCondition: goldOnLeft ? "gold" : "literal",
      presentationOrder: position,
    };
  });
}

/** Ratio of clip durations for the two conditions of a pair (1 = balanced). */
export function durationBalance(leftMs: number, rightMs: number): number {
  if (leftMs <= 0 || rightMs <= 0) return Number.NaN;
  return Math.round((Math.max(leftMs, rightMs) / Math.min(leftMs, rightMs)) * 100) / 100;
}

export interface ComprehensionQuestion {
  id: string;
  question: string;
  /** Acceptable surface forms (either condition may express them). */
  acceptableAnswers: string[];
  /** Which source block the evidence comes from. */
  blockId: string;
}

/**
 * Objective comprehension items authored against `nested-regulation-01`
 * content (synthetic fixture). They target facts a Good spoken rendering
 * must leave intact: deadline, exception clause, legal reference,
 * obligation modality, monetary threshold.
 */
export const COMPREHENSION_QUESTIONS: readonly ComprehensionQuestion[] = [
  {
    id: "q1",
    question: "¿Cuál era el plazo (fecha y hora) para remitir la información?",
    acceptableAnswers: [
      "15 de julio de 2024 a las 14:00",
      "15/07/2024, 14:00",
      "quince de julio de dos mil veinticuatro, catorce horas",
    ],
    blockId: "b12",
  },
  {
    id: "q2",
    question:
      "¿La exención de las entidades del apartado 3 era incondicional? Si no, ¿qué la revertía?",
    acceptableAnswers: [
      "no, salvo ratio de solvencia superior al 8,5 % durante dos ejercicios consecutivos",
      "not exempt if solvency ratio above 8.5% for two consecutive years",
    ],
    blockId: "b6",
  },
  {
    id: "q3",
    question:
      "¿A qué artículo (y letra) de qué ley remitía la disposición de ámbito de aplicación?",
    acceptableAnswers: [
      "artículo 57.1.b) / art. 57.1.b) de la Ley 47/2003",
      "article 57(1)(b) of Law 47/2003",
    ],
    blockId: "b5",
  },
  {
    id: "q4",
    question:
      "¿La notificación de importes superiores a 500.000 EUR era opcional u obligatoria, y bajo qué condición aplicaba?",
    acceptableAnswers: [
      "obligatoria (deberán), si el contrato se celebró después del 1 de enero de 2024",
      "obligatory, only for contracts concluded after 1 January 2024",
    ],
    blockId: "b15",
  },
  {
    id: "q5",
    question: "Indique el importe máximo del umbral mencionado.",
    acceptableAnswers: [
      "1.234.567,89 euros",
      "un millón doscientos treinta y cuatro mil quinientos sesenta y siete euros con ochenta y nueve céntimos",
    ],
    blockId: "b13",
  },
];

/** Questions whose evidence block actually exists among the pairs. */
export function questionsForPairs(pairs: readonly G3aPair[]): ComprehensionQuestion[] {
  const blocks = new Set(pairs.map((p) => p.blockId));
  return COMPREHENSION_QUESTIONS.filter((q) => blocks.has(q.blockId));
}
