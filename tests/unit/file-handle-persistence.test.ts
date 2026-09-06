import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  supportsFileSystemAccess,
  storeFileHandle,
  getFileHandle,
  removeFileHandle,
  ensureReadPermission,
} from "@/lib/file-handle-persistence";

// Mock IndexedDB (same pattern as position-persistence).
const mockStore = {
  put: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
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
    }),
  ),
}));

function fakeHandle(
  overrides: Partial<Record<string, unknown>> = {},
): FileSystemFileHandle {
  return {
    name: "doc.pdf",
    kind: "file",
    ...overrides,
  } as unknown as FileSystemFileHandle;
}

describe("file-handle-persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("supportsFileSystemAccess is false in a non-browser (node) env", () => {
    expect(supportsFileSystemAccess()).toBe(false);
  });

  it("storeFileHandle persists a handle keyed by fingerprint", async () => {
    const handle = fakeHandle();
    await storeFileHandle("fp-1", handle);
    expect(mockStore.put).toHaveBeenCalledWith("handles", {
      fingerprint: "fp-1",
      handle,
    });
  });

  it("storeFileHandle never throws on IndexedDB errors", async () => {
    mockStore.put.mockRejectedValueOnce(new Error("IDB error"));
    await expect(storeFileHandle("fp-1", fakeHandle())).resolves.not.toThrow();
  });

  it("getFileHandle returns the stored handle", async () => {
    const handle = fakeHandle();
    mockStore.get.mockResolvedValueOnce({ fingerprint: "fp-1", handle });
    expect(await getFileHandle("fp-1")).toBe(handle);
  });

  it("getFileHandle returns null when absent", async () => {
    mockStore.get.mockResolvedValueOnce(undefined);
    expect(await getFileHandle("fp-1")).toBeNull();
  });

  it("getFileHandle returns null on error", async () => {
    mockStore.get.mockRejectedValueOnce(new Error("IDB error"));
    expect(await getFileHandle("fp-1")).toBeNull();
  });

  it("removeFileHandle deletes the handle and never throws", async () => {
    mockStore.delete.mockRejectedValueOnce(new Error("IDB error"));
    await expect(removeFileHandle("fp-1")).resolves.not.toThrow();
    expect(mockStore.delete).toHaveBeenCalled();
  });

  describe("ensureReadPermission", () => {
    it("returns true when already granted", async () => {
      const handle = fakeHandle({
        queryPermission: vi.fn().mockResolvedValue("granted"),
        requestPermission: vi.fn(),
      });
      expect(await ensureReadPermission(handle)).toBe(true);
      expect(handle.requestPermission).not.toHaveBeenCalled();
    });

    it("requests permission when prompt and returns the result", async () => {
      const handle = fakeHandle({
        queryPermission: vi.fn().mockResolvedValue("prompt"),
        requestPermission: vi.fn().mockResolvedValue("granted"),
      });
      expect(await ensureReadPermission(handle)).toBe(true);
      expect(handle.requestPermission).toHaveBeenCalledWith({ mode: "read" });
    });

    it("returns false when denied", async () => {
      const handle = fakeHandle({
        queryPermission: vi.fn().mockResolvedValue("denied"),
        requestPermission: vi.fn().mockResolvedValue("denied"),
      });
      expect(await ensureReadPermission(handle)).toBe(false);
    });

    it("returns false when permission throws", async () => {
      const handle = fakeHandle({
        queryPermission: vi.fn().mockRejectedValue(new Error("nope")),
      });
      expect(await ensureReadPermission(handle)).toBe(false);
    });
  });
});
