/**
 * Desktop app-data state mirror — unit contract.
 *
 * The mirror is the persistence backend for desktop continuity state
 * (recents/positions/settings). Web behavior is unaffected: hydrate() and
 * flush() are no-ops when not running on the desktop bridge.
 *
 * The production module is a per-process singleton, so each test loads a
 * fresh module instance (vi.resetModules) while the bridge mock stays shared.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => {
  const stateSaved = new Map<string, unknown>();
  const isDesktop = vi.fn(() => true);
  const desktopInvoke = vi.fn(
    async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "desktop_state_load") return stateLoaded;
      if (cmd === "desktop_state_save") {
        stateSaved.set("state", args?.state);
        return null;
      }
      throw new Error(`unexpected command: ${cmd}`);
    },
  );
  let stateLoaded: unknown = null;
  return {
    stateSaved,
    isDesktop,
    desktopInvoke,
    setLoaded: (v: unknown) => {
      stateLoaded = v;
    },
  };
});

vi.mock("@/lib/desktop-bridge", () => ({
  isDesktop: bridge.isDesktop,
  desktopInvoke: bridge.desktopInvoke,
}));

async function loadModule() {
  vi.resetModules();
  return import("@/lib/desktop-app-state");
}

describe("desktop-app-state", () => {
  beforeEach(() => {
    bridge.stateSaved.clear();
    bridge.setLoaded(null);
    bridge.isDesktop.mockReturnValue(true);
    bridge.desktopInvoke.mockClear();
  });

  it("hydrates the mirror from app-data and returns stored values", async () => {
    bridge.setLoaded({
      recents: [{ fingerprint: "abc", filename: "a.pdf" }],
      positions: { abc: { fingerprint: "abc", docTime: 12, speed: 1 } },
      settings: { rate: 1.5 },
    });
    const mod = await loadModule();
    await mod.hydrateDesktopState();
    expect(mod.desktopStateGet("recents")).toHaveLength(1);
    expect(mod.desktopStateGet("positions")).toHaveProperty("abc");
    expect(mod.desktopStateGet("settings")).toEqual({ rate: 1.5 });
  });

  it("writes go to the mirror immediately and flush to app-data", async () => {
    const mod = await loadModule();
    await mod.hydrateDesktopState();
    mod.desktopStateSet("settings", { rate: 2 });
    expect(mod.desktopStateGet("settings")).toEqual({ rate: 2 });
    await mod.flushDesktopState();
    expect(bridge.stateSaved.get("state")).toEqual({ settings: { rate: 2 } });
  });

  it("merges hydrated values with new writes in a single flush", async () => {
    bridge.setLoaded({ positions: { abc: { docTime: 5 } } });
    const mod = await loadModule();
    await mod.hydrateDesktopState();
    mod.desktopStateSet("settings", { rate: 1.5 });
    await mod.flushDesktopState();
    expect(bridge.stateSaved.get("state")).toEqual({
      positions: { abc: { docTime: 5 } },
      settings: { rate: 1.5 },
    });
  });

  it("treats a failed load as an empty state (fresh install / corrupted file)", async () => {
    bridge.setLoaded(undefined);
    const mod = await loadModule();
    await mod.hydrateDesktopState();
    expect(mod.desktopStateGet("recents")).toBeUndefined();
  });

  it("flush never rejects even if the bridge fails", async () => {
    const mod = await loadModule();
    await mod.hydrateDesktopState();
    bridge.desktopInvoke.mockRejectedValueOnce(new Error("bridge gone"));
    await expect(mod.flushDesktopState()).resolves.toBeUndefined();
  });

  it("is a no-op on the web build (no bridge commands at all)", async () => {
    bridge.isDesktop.mockReturnValue(false);
    const mod = await loadModule();
    await mod.hydrateDesktopState();
    mod.desktopStateSet("settings", { rate: 0.75 });
    await mod.flushDesktopState();
    expect(bridge.desktopInvoke).not.toHaveBeenCalled();
    expect(bridge.stateSaved.size).toBe(0);
  });
});
