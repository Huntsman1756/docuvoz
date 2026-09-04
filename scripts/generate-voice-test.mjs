import { writeFileSync } from "node:fs";
import { buildPdf } from "./pdf-writer.mjs";

/**
 * Voice comparison test PDF (v0.3 dogfood).
 *
 * Contains the critical-token fragment plus a bit of filler so Listen
 * processing has a reasonable amount of text (not just one sentence).
 *
 * Drag-and-drop this file in the Reader (/) and test every voice.
 */

// Critical tokens that stress TTS pronunciation.
const CRITICAL =
  "La Circular 31/2025, de 12 de diciembre, establece en su artículo 57.1.b) un " +
  "plazo de 25 días para presentar la documentación requerida, con un importe de " +
  "EUR 1.250.000 e ISIN ES0123456789, con un rendimiento del 12,75 %.";

// A couple of extra sentences to exercise Listen processing.
const FILLER =
  "El órgano rector ha acordado prorrogar el plazo de presentación hasta la " +
  "fecha 31-12-2025. La documentación se enviará al registro general del " +
  "ministerio correspondiente, referencia 45820371-A.";

const pdfPath = "../docs/voice-test.pdf";
const pages = [
  {
    lines: [
      { text: "Voz de Prueba — DocuVox", bold: true, size: 13, gap: 16 },
      { text: "TTS voice comparison · Español · 1× · Listen mode", size: 9, gap: 20 },
      { text: CRITICAL, size: 10, gap: 8 },
      { text: "FRAGMENTO CRÍTICO:", bold: true, size: 9, gap: 4 },
      { text: CRITICAL, size: 9, gap: 20 },
      { text: FILLER, size: 9, gap: 20 },
      { text: "FILLER:", bold: true, size: 9, gap: 4 },
      { text: FILLER, size: 9 },
    ],
  },
];
writeFileSync(pdfPath, buildPdf(pages));
console.log(`✓ Created ${pdfPath} (${pages.length} página)`);