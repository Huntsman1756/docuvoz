import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  savePosition,
  loadPosition,
  removePosition,
  listPositions,
  clearPositions,
  type SavedPosition,
} from "@/lib/position-persistence";

// Mock IndexedDB
const mockStore = {
  put: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
  getAll: vi.fn(),
  clear: vi.fn(),
};

vi.mock("idb", () => ({
  openDB: vi.fn(() =>
    Promise.resolve({
      transaction: vi.fn(() => ({
        objectStore: vi.fn(() => mockStore),
        done: Promise.resolve(),
      })),
      put: mockStore.put,
      get: mockStore.get,
      delete: mockStore.delete,
      getAll: mockStore.getAll,
      clear: mockStore.clear,
    }),
  ),
}));

describe("position-persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createMockPosition = (fingerprint: string): SavedPosition => ({
    fingerprint,
    sectionId: "chapter-2",
    sectionLabel: "Chapter 2",
    blockIndex: 15,
    docTime: 240,
    speed: 1.25,
    chunkIndex: 5,
    filename: "test.pdf",
    savedAt: Date.now(),
  });

  describe("savePosition", () => {
    it("saves position to IndexedDB", async () => {
      const position = createMockPosition("fp-123");
      await savePosition(position);
      expect(mockStore.put).toHaveBeenCalled();
    });

    it("handles IndexedDB errors gracefully", async () => {
      mockStore.put.mockRejectedValueOnce(new Error("IDB error"));
      const position = createMockPosition("fp-123");
      await expect(savePosition(position)).resolves.not.toThrow();
    });
  });

  describe("loadPosition", () => {
    it("loads position from IndexedDB", async () => {
      const position = createMockPosition("fp-123");
      mockStore.get.mockResolvedValueOnce(position);

      const result = await loadPosition("fp-123");
      expect(result).toEqual(position);
    });

    it("returns null for non-existent position", async () => {
      mockStore.get.mockResolvedValueOnce(undefined);

      const result = await loadPosition("fp-123");
      expect(result).toBeNull();
    });

    it("returns null for expired positions", async () => {
      const position = createMockPosition("fp-123");
      position.savedAt = Date.now() - 100 * 24 * 60 * 60 * 1000; // 100 days ago
      mockStore.get.mockResolvedValueOnce(position);

      const result = await loadPosition("fp-123");
      expect(result).toBeNull();
    });

    it("handles IndexedDB errors gracefully", async () => {
      mockStore.get.mockRejectedValueOnce(new Error("IDB error"));

      const result = await loadPosition("fp-123");
      expect(result).toBeNull();
    });
  });

  describe("removePosition", () => {
    it("removes position from IndexedDB", async () => {
      await removePosition("fp-123");
      // The actual call is transaction(STORE).objectStore(STORE).delete(key)
      // but our mock receives it as delete(storeName, key)
      expect(mockStore.delete).toHaveBeenCalled();
    });

    it("handles IndexedDB errors gracefully", async () => {
      mockStore.delete.mockRejectedValueOnce(new Error("IDB error"));
      await expect(removePosition("fp-123")).resolves.not.toThrow();
    });
  });

  describe("listPositions", () => {
    it("lists all positions sorted by most recent", async () => {
      const now = Date.now();
      const positions = [
        { ...createMockPosition("fp-1"), savedAt: now - 1000 },
        { ...createMockPosition("fp-2"), savedAt: now },
      ];
      mockStore.getAll.mockResolvedValueOnce(positions);

      const result = await listPositions();
      // The implementation filters expired positions and sorts by savedAt
      // Both positions are fresh (within 90 days), so they should both be returned
      expect(result).toHaveLength(2);
      expect(result[0].fingerprint).toBe("fp-2"); // Most recent first
    });

    it("filters expired positions", async () => {
      const positions = [
        {
          ...createMockPosition("fp-1"),
          savedAt: Date.now() - 100 * 24 * 60 * 60 * 1000,
        },
        { ...createMockPosition("fp-2"), savedAt: Date.now() },
      ];
      mockStore.getAll.mockResolvedValueOnce(positions);

      const result = await listPositions();
      expect(result).toHaveLength(1);
      expect(result[0].fingerprint).toBe("fp-2");
    });

    it("returns empty array on error", async () => {
      mockStore.getAll.mockRejectedValueOnce(new Error("IDB error"));

      const result = await listPositions();
      expect(result).toEqual([]);
    });
  });

  describe("clearPositions", () => {
    it("clears all positions", async () => {
      await clearPositions();
      expect(mockStore.clear).toHaveBeenCalled();
    });

    it("handles IndexedDB errors gracefully", async () => {
      mockStore.clear.mockRejectedValueOnce(new Error("IDB error"));
      await expect(clearPositions()).resolves.not.toThrow();
    });
  });
});
