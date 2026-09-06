import type { NextConfig } from "next";

/**
 * Desktop (Tauri) Next config — STATIC ONLY.
 *
 * This app directory (desktop/app) intentionally contains no route handlers,
 * so `output: "export"` is a complete, honest static build. All speech goes
 * through the SpeechTransport seam (Tauri invoke on desktop); the server
 * runtime lives in the bundled Node sidecar, not in the WebView.
 *
 * The web app at the repository root keeps its own config and API routes.
 */
const nextConfig: NextConfig = {
  output: "export",
  // Emit /lab as /lab/index.html so Tauri's static asset resolver serves it.
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
