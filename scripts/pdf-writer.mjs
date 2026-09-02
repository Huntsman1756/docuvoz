/**
 * Minimal, dependency-free PDF writer for synthetic corpus fixtures.
 *
 * Produces valid text PDFs (Helvetica, WinAnsiEncoding so Spanish accents
 * survive) with controllable page headers/footers, headings, list items and
 * body paragraphs, so the browser extractor, the spoken pipeline and the
 * tests can be driven end to end without shipping any real copyrighted
 * regulation.
 */
import { writeFileSync } from "node:fs";

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 56;
const LINE_HEIGHT = 13;

function escapeText(text) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/[^\x20-\x7E\u00A0-\u00FF]/g, (ch) => {
      const map = {
        "\u2014": "-",
        "\u2013": "-",
        "\u2018": "'",
        "\u2019": "'",
        "\u201c": '"',
        "\u201d": '"',
        "\u2026": "...",
        "\u20ac": "EUR",
      };
      return map[ch] ?? "?";
    });
}

function wrap(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const words = text.split(" ");
  const out = [];
  let line = "";
  for (const word of words) {
    if (`${line} ${word}`.trim().length > maxChars) {
      if (line) out.push(line);
      line = word;
    } else {
      line = `${line} ${word}`.trim();
    }
  }
  if (line) out.push(line);
  return out;
}

export function buildPdf(pages) {
  const objects = [];
  const fontRegularId = 3;
  const fontBoldId = 4;

  const contentStreams = pages.map((page) => {
    const parts = [];
    const draw = (text, size, bold, atY, atX) => {
      parts.push(
        `BT /${bold ? "F2" : "F1"} ${size} Tf 1 0 0 1 ${atX} ${atY} Tm (${escapeText(text)}) Tj ET`,
      );
    };
    if (page.header) draw(page.header, 8, false, PAGE_HEIGHT - 30, MARGIN);
    if (page.footer) draw(page.footer, 8, false, 30, MARGIN);
    if (page.pageNumber) draw(page.pageNumber, 8, false, 30, PAGE_WIDTH - MARGIN - 20);
    let y = PAGE_HEIGHT - MARGIN;
    for (const line of page.lines) {
      const size = line.size ?? 10;
      if (line.gap) y -= line.gap;
      const maxChars = Math.floor(((PAGE_WIDTH - 2 * MARGIN) / size) * 1.9);
      for (const wrapped of wrap(line.text, maxChars)) {
        draw(wrapped, size, line.bold ?? false, y, MARGIN);
        y -= size > 11 ? LINE_HEIGHT + 3 : LINE_HEIGHT;
      }
    }
    return parts.join("\n");
  });

  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(" ");
  objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${kids}] >>`;
  objects[2] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[3] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";

  pages.forEach((_, i) => {
    const pageObjNum = 5 + i * 2;
    const contentObjNum = pageObjNum + 1;
    objects[pageObjNum - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >> >> ` +
      `/Contents ${contentObjNum} 0 R >>`;
    const stream = contentStreams[i];
    objects[contentObjNum - 1] =
      `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  });

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, idx) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${idx + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const off of offsets) {
    pdf += `${off.toString().padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

export function writePdf(path, pages) {
  writeFileSync(path, buildPdf(pages));
}
