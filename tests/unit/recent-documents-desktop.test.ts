/**
 * Recent documents — desktop path reference contract.
 *
 * Desktop recents carry a safe local `path` for native reopen:
 *   - added with the document (origin.path)
 *   - carried over on position updates
 *   - cleared when the file goes missing (keeping position metadata)
 *   - replaced after a verified "Locate file" action
 * The web build keeps localStorage-only behavior (no paths).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => {
  const isDesktop = vi.fn(() => true);
  const store = new Map<string, unknown>();
  return { isDesktop, store };
});

vi.mock("@/lib/desktop-bridge", () => ({ isDesktop: bridge.isDesktop }));

vi.mock("@/lib/desktop-app-state", () => ({
  desktopStateGet: (key: string) => bridge.store.get(key),
  desktopStateSet: (key: string, value: unknown) => {
    bridge.store.set(key, value);
  },
}));

import {
  getRecentDocuments,
  addRecentDocument,
  updateRecentPosition,
  clearRecentPath,
  setRecentPath,
  type RecentDocument,
} from "@/lib/recent-documents";
import type { StructuredDocument } from "@/domain/documents/types";

function fakeDoc(name: string): StructuredDocument {
  return {
    id: `doc-${name}`,
    source: { name, author: undefined },
    parser: "pdf-adapter",
    blocks: [],
    toc: [],
  } as unknown as StructuredDocument;
}

describe("recent documents (desktop backend)", () => {
  beforeEach(() => {
    bridge.store.clear();
    bridge.isDesktop.mockReturnValue(true);
  });

  it("persists a desktop path reference with the entry", () => {
    addRecentDocument(
      fakeDoc("informe.pdf"),
      "fp-1",
      {},
      { path: "C:\\docs\\informe.pdf" },
    );
    const recents = getRecentDocuments();
    expect(recents).toHaveLength(1);
    expect(recents[0].path).toBe("C:\\docs\\informe.pdf");
    expect(bridge.store.get("recents")).toBeTruthy();
  });

  it("carries the path over on position updates", () => {
    addRecentDocument(fakeDoc("a.pdf"), "fp-1", {}, { path: "C:\\a.pdf" });
    updateRecentPosition("fp-1", { lastDocTime: 42 });
    expect(getRecentDocuments()[0]).toMatchObject({
      path: "C:\\a.pdf",
      lastDocTime: 42,
    });
  });

  it("clears a stale path while keeping position metadata", () => {
    addRecentDocument(
      fakeDoc("a.pdf"),
      "fp-1",
      {
        lastDocTime: 30,
        lastSection: "Cap. 1",
      },
      { path: "C:\\a.pdf" },
    );
    clearRecentPath("fp-1");
    const entry = getRecentDocuments()[0];
    expect(entry.path).toBeUndefined();
    expect(entry.lastDocTime).toBe(30);
    expect(entry.lastSection).toBe("Cap. 1");
  });

  it("setRecentPath records a verified relocation", () => {
    addRecentDocument(fakeDoc("a.pdf"), "fp-1", {}, { path: "C:\\old\\a.pdf" });
    clearRecentPath("fp-1");
    setRecentPath("fp-1", "D:\\nuevo\\a.pdf");
    expect(getRecentDocuments()[0].path).toBe("D:\\nuevo\\a.pdf");
  });

  it("web build: no path is stored and localStorage backend is used", () => {
    bridge.isDesktop.mockReturnValue(false);
    let backing: string | null = null;
    const setItem = vi.fn((key: string, value: string) => {
      void key;
      backing = value;
    });
    const getItem = vi.fn(() => backing);
    vi.stubGlobal("localStorage", { setItem, getItem });
    addRecentDocument(fakeDoc("b.pdf"), "fp-2", {}, { path: "C:\\b.pdf" });
    expect(getRecentDocuments()).toHaveLength(1);
    expect(getRecentDocuments()[0].path).toBeUndefined();
    expect(setItem).toHaveBeenCalled();
    expect(backing).not.toBeNull();
    vi.unstubAllGlobals();
  });
});
