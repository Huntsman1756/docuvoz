/**
 * Plain text document adapter.
 *
 * Uses browser-native TextDecoder for encoding detection.
 * Intentionally simple: paragraph detection by blank-line separation.
 */
import type { DocumentAdapter, LoadOptions } from "../document-adapter";
import type { StructuredDocument, DocumentBlock } from "@/domain/documents/types";

const ADAPTER_ID = "txt-native";
const ADAPTER_VERSION = "1.0.0";

/** Common text encodings to try if no BOM is present. */
const ENCODINGS = ["utf-8", "iso-8859-1", "windows-1252"];

export const txtAdapter: DocumentAdapter = {
  id: ADAPTER_ID,
  formats: ["txt"],
  mimeTypes: ["text/plain", "text/x-plain"],
  extensions: [".txt", ".text"],

  canOpen(file: File): boolean {
    const name = file.name.toLowerCase();
    return name.endsWith(".txt") || name.endsWith(".text");
  },

  async load(
    file: File,
    options: LoadOptions,
    signal?: AbortSignal,
  ): Promise<StructuredDocument> {
    const buffer = await file.arrayBuffer();
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");

    const bytes = new Uint8Array(buffer);
    const text = decodeText(bytes);

    if (text.trim().length === 0) {
      throw new Error("No se ha encontrado texto legible en este documento.");
    }

    const blocks = textToBlocks(text);

    return {
      id: options.id,
      source: {
        name: options.name ?? file.name,
        sha256: options.sha256,
        language: options.language ?? "es",
      },
      blocks,
      parser: ADAPTER_ID,
      parserVersion: ADAPTER_VERSION,
    };
  },
};

function decodeText(bytes: Uint8Array): string {
  // Check for BOM
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes);
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.slice(3));
  }

  // Try UTF-8 first, fall back to other encodings
  for (const encoding of ENCODINGS) {
    try {
      const decoded = new TextDecoder(encoding, { fatal: true }).decode(bytes);
      return decoded;
    } catch {
      // Try next encoding
    }
  }

  // Final fallback: lossy UTF-8
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Paragraphs by blank-line separation. `sourceRef` keeps the 1-based line
 * range (L<start>-L<end>) so every block maps back to the exact source lines.
 */
function textToBlocks(text: string): DocumentBlock[] {
  const lines = text.split(/\r\n|\r|\n/);
  const blocks: DocumentBlock[] = [];
  let i = 0;
  let order = 0;
  while (i < lines.length) {
    while (i < lines.length && lines[i].trim() === "") i++;
    if (i >= lines.length) break;
    const startLine = i;
    const parts: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") {
      const trimmed = lines[i].trim();
      if (trimmed.length > 0) parts.push(trimmed);
      i++;
    }
    const textJoin = parts.join(" ").trim();
    if (textJoin.length === 0) continue;
    blocks.push({
      id: `b${order}`,
      type: "paragraph",
      text: textJoin,
      page: 1,
      order,
      sourceRef: `L${startLine + 1}-L${i}`,
    });
    order++;
  }
  return blocks;
}
