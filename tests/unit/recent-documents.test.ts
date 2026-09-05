import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getRecentDocuments,
  addRecentDocument,
  updateRecentPosition,
  removeRecentDocument,
  canResume,
  getRecentByFingerprint,
} from "@/lib/recent-documents";
import type { StructuredDocument } from "@/domain/documents/types";

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    get length() {
      return Object.keys(store).length;
    },
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
  };
})();

Object.defineProperty(globalThis, "localStorage", { value: localStorageMock });

describe("recent-documents", () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  describe("addRecentDocument", () => {
    it("adds a new recent document with content-based fingerprint", () => {
      const doc = createMockDoc("test.pdf", "doc-1");
      const entry = addRecentDocument(doc, "abc123def456", {});

      expect(entry.filename).toBe("test.pdf");
      expect(entry.fingerprint).toBe("abc123def456");
      expect(entry.docType).toBe("pdf");
      expect(entry.resumeCount).toBe(1);
    });

    it("same content fingerprint, different filename → same identity", () => {
      const doc1 = createMockDoc("original.pdf", "doc-1");
      const doc2 = createMockDoc("renamed.pdf", "doc-2");
      const sameContentFp = "same-content-hash-123";

      addRecentDocument(doc1, sameContentFp, { lastDocTime: 100 });
      addRecentDocument(doc2, sameContentFp, {});

      const recents = getRecentDocuments();
      // Should be only 1 entry (same fingerprint merges)
      expect(recents).toHaveLength(1);
      expect(recents[0].filename).toBe("renamed.pdf");
      expect(recents[0].lastDocTime).toBe(100); // Position preserved
      expect(recents[0].resumeCount).toBe(2);
    });

    it("same name+size, different content → different identity", () => {
      const doc1 = createMockDoc("report.pdf", "doc-1");
      const doc2 = createMockDoc("report.pdf", "doc-2");

      addRecentDocument(doc1, "fingerprint-a", {});
      addRecentDocument(doc2, "fingerprint-b", {});

      const recents = getRecentDocuments();
      expect(recents).toHaveLength(2);
    });

    it("maintains maximum of 5 recent documents", () => {
      for (let i = 0; i < 10; i++) {
        const doc = createMockDoc(`doc${i}.pdf`, `doc-${i}`);
        addRecentDocument(doc, `fp-${i}`, {});
      }

      const recents = getRecentDocuments();
      expect(recents).toHaveLength(5);
      // Most recent should be last added
      expect(recents[0].filename).toBe("doc9.pdf");
    });
  });

  describe("getRecentDocuments", () => {
    it("returns empty array when no recents", () => {
      expect(getRecentDocuments()).toEqual([]);
    });

    it("returns sorted recents (most recent first)", () => {
      const doc1 = createMockDoc("doc1.pdf", "doc-1");
      const doc2 = createMockDoc("doc2.pdf", "doc-2");

      addRecentDocument(doc1, "fp-1", {});
      addRecentDocument(doc2, "fp-2", {});

      const recents = getRecentDocuments();
      expect(recents).toHaveLength(2);
      expect(recents[0].filename).toBe("doc2.pdf");
      expect(recents[1].filename).toBe("doc1.pdf");
    });
  });

  describe("updateRecentPosition", () => {
    it("updates position for existing document", () => {
      const doc = createMockDoc("test.pdf", "doc-1");
      const entry = addRecentDocument(doc, "fp-test", {});

      updateRecentPosition(entry.fingerprint, {
        lastSection: "Chapter 2",
        lastDocTime: 240,
        playbackSpeed: 1.25,
      });

      const recents = getRecentDocuments();
      expect(recents[0].lastSection).toBe("Chapter 2");
      expect(recents[0].lastDocTime).toBe(240);
      expect(recents[0].playbackSpeed).toBe(1.25);
    });
  });

  describe("removeRecentDocument", () => {
    it("removes a recent document", () => {
      const doc = createMockDoc("test.pdf", "doc-1");
      const entry = addRecentDocument(doc, "fp-test", {});

      expect(getRecentDocuments()).toHaveLength(1);
      removeRecentDocument(entry.fingerprint);
      expect(getRecentDocuments()).toHaveLength(0);
    });
  });

  describe("canResume", () => {
    it("returns true when document has saved position", () => {
      const doc = createMockDoc("test.pdf", "doc-1");
      const entry = addRecentDocument(doc, "fp-test", { lastDocTime: 120 });

      expect(canResume(entry.fingerprint)).toBe(true);
    });

    it("returns false when no saved position", () => {
      const doc = createMockDoc("test.pdf", "doc-1");
      const entry = addRecentDocument(doc, "fp-test", {});

      expect(canResume(entry.fingerprint)).toBe(false);
    });
  });

  describe("getRecentByFingerprint", () => {
    it("returns document by fingerprint", () => {
      const doc = createMockDoc("test.pdf", "doc-1");
      const entry = addRecentDocument(doc, "fp-test", {});

      const found = getRecentByFingerprint(entry.fingerprint);
      expect(found).toBeDefined();
      expect(found?.filename).toBe("test.pdf");
    });

    it("returns undefined for unknown fingerprint", () => {
      expect(getRecentByFingerprint("unknown")).toBeUndefined();
    });
  });

  describe("docType detection", () => {
    it("detects pdf", () => {
      const doc = createMockDoc("test.pdf", "doc-1");
      const entry = addRecentDocument(doc, "fp-1", {});
      expect(entry.docType).toBe("pdf");
    });

    it("detects epub", () => {
      const doc = createMockDoc("test.epub", "doc-1", "epub");
      const entry = addRecentDocument(doc, "fp-1", {});
      expect(entry.docType).toBe("epub");
    });

    it("detects docx", () => {
      const doc = createMockDoc("test.docx", "doc-1", "docx");
      const entry = addRecentDocument(doc, "fp-1", {});
      expect(entry.docType).toBe("docx");
    });
  });
});

function createMockDoc(filename: string, id: string, parser = "pdf"): StructuredDocument {
  return {
    id,
    source: {
      name: filename,
      language: "es",
      pageCount: 10,
    },
    blocks: [],
    parser: `parser-${parser}`,
    parserVersion: "1.0.0",
  };
}
