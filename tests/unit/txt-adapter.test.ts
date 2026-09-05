/**
 * Tests for TXT document adapter.
 */
import { describe, it, expect } from "vitest";
import { txtAdapter } from "@/adapters/document-parsers/adapters/txt-adapter";

function makeFile(content: string, name = "test.txt", type = "text/plain"): File {
  return new File([content], name, { type });
}

describe("txtAdapter", () => {
  it("has correct id", () => {
    expect(txtAdapter.id).toBe("txt-native");
  });

  it("supports .txt extension", () => {
    expect(txtAdapter.extensions).toContain(".txt");
  });

  it("canOpen returns true for .txt files", () => {
    expect(txtAdapter.canOpen(makeFile("", "notes.txt"))).toBe(true);
  });

  it("canOpen returns false for .pdf files", () => {
    expect(txtAdapter.canOpen(makeFile("", "file.pdf"))).toBe(false);
  });

  it("extracts paragraphs from plain text", async () => {
    const content = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
    const doc = await txtAdapter.load(makeFile(content), {
      id: "test-1",
      name: "test.txt",
    });

    expect(doc.parser).toBe("txt-native");
    expect(doc.blocks.length).toBe(3);
    expect(doc.blocks[0].text).toBe("First paragraph.");
    expect(doc.blocks[1].text).toBe("Second paragraph.");
    expect(doc.blocks[2].text).toBe("Third paragraph.");
    expect(doc.blocks[0].type).toBe("paragraph");
  });

  it("handles BOM correctly", async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const text = new TextEncoder().encode("BOM content.");
    const file = new File([bom, text], "bom.txt", { type: "text/plain" });
    const doc = await txtAdapter.load(file, { id: "test-bom", name: "bom.txt" });

    expect(doc.blocks.length).toBe(1);
    expect(doc.blocks[0].text).toBe("BOM content.");
  });

  it("handles UTF-16LE BOM", async () => {
    const content = "Hello world";
    const encoder = new TextEncoder();
    const bytes = encoder.encode(content);
    // Create UTF-16LE with BOM
    const utf16 = new Uint8Array(bytes.length * 2 + 2);
    utf16[0] = 0xff;
    utf16[1] = 0xfe;
    for (let i = 0; i < bytes.length; i++) {
      utf16[i * 2 + 2] = bytes[i];
      utf16[i * 2 + 3] = 0;
    }
    const file = new File([utf16], "utf16.txt", { type: "text/plain" });
    const doc = await txtAdapter.load(file, { id: "test-utf16", name: "utf16.txt" });

    expect(doc.blocks.length).toBe(1);
    expect(doc.blocks[0].text).toBe("Hello world");
  });

  it("throws on empty document", async () => {
    const file = makeFile("   \n\n  ", "empty.txt");
    await expect(
      txtAdapter.load(file, { id: "test-empty", name: "empty.txt" }),
    ).rejects.toThrow("No se ha encontrado texto legible");
  });

  it("single paragraph without blank lines", async () => {
    const file = makeFile("Just one line of text.");
    const doc = await txtAdapter.load(file, { id: "test-single", name: "test.txt" });

    expect(doc.blocks.length).toBe(1);
    expect(doc.blocks[0].text).toBe("Just one line of text.");
  });

  it("sets correct reading order", async () => {
    const file = makeFile("A\n\nB\n\nC");
    const doc = await txtAdapter.load(file, { id: "test-order", name: "test.txt" });

    expect(doc.blocks[0].order).toBe(0);
    expect(doc.blocks[1].order).toBe(1);
    expect(doc.blocks[2].order).toBe(2);
  });
});
