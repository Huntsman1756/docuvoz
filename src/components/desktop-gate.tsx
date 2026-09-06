"use client";

import { useEffect, useState, type ReactNode } from "react";
import { hydrateDesktopState } from "@/lib/desktop-app-state";
import { isDesktop } from "@/lib/desktop-bridge";

/**
 * Desktop-only bootstrap gate: continuity state (recents, positions,
 * settings) must be hydrated from app-data BEFORE the shared UI renders,
 * because those modules expose a synchronous read API. The web build never
 * renders this gate (it lives only in the desktop/ Next app layout).
 */
export function DesktopGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    const boot = isDesktop() ? hydrateDesktopState() : Promise.resolve();
    void boot.finally(() => {
      if (live) setReady(true);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!ready) return null;
  return <>{children}</>;
}
