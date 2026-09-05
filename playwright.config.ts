import { defineConfig, devices } from "@playwright/test";

/**
 * Two disjoint gates:
 *
 *  - Deterministic (default): the mock server exposes ONLY the mock engine
 *    (EDGE_TTS_ENABLED=0), so "auto" can never resolve to a real provider. Any
 *    spec that would touch the network is tagged "@live" and excluded here.
 *    This gate is network-free and must pass repeatedly with retries=0.
 *
 *  - Live smoke (E2E_LIVE=1): the server additionally enables the real Edge
 *    provider, and ONLY "@live" specs run. External/variable by nature;
 *    reported separately, never counted as CI flakiness.
 *
 * Without this split the reader's "auto" engine resolves to the real Edge
 * provider inside the "mock" suite, and CI silently depends on Microsoft.
 */
const LIVE = !!process.env.E2E_LIVE;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  // Real document playback + MP3/M4A export legitimately wait up to ~60 s
  // (chunk buffering, WASM encode); give each test enough budget so those
  // per-action waits are actually usable rather than being cut off by the
  // 30 s default. Standalone these specs finish in a few seconds.
  timeout: 120_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  // Deterministic gate must stand on its own: transient timing is fixed at the
  // source, never hidden behind retries.
  retries: 0,
  grep: LIVE ? /@live/ : undefined,
  grepInvert: LIVE ? undefined : /@live/,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:3123",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          // Autoplay without gesture: the mock provider produces silent-ish
          // WAV blobs that headless Chrome would otherwise block.
          args: ["--autoplay-policy=no-user-gesture-required"],
        },
      },
    },
  ],
  webServer: {
    // A dedicated, cleaned cache for the deterministic gate so stale mock
    // audio from a previous provider version can never leak in. The mock
    // audio is content-addressed by text, so a changed provider (e.g. longer
    // speech blobs) would otherwise keep serving the old bytes from cache.
    command: LIVE
      ? "npm run build && npm run start -- -p 3123 -H 127.0.0.1"
      : "node -e \"require('node:fs').rmSync('.cache/audio-e2e',{recursive:true,force:true})\" && npm run build && npm run start -- -p 3123 -H 127.0.0.1",
    url: "http://127.0.0.1:3123/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: {
      NODE_ENV: "production",
      SPEECH_PROVIDER: "mock",
      // Mock engine only for the deterministic gate; the real Edge provider is
      // enabled exclusively for the opt-in live smoke (E2E_LIVE=1).
      EDGE_TTS_ENABLED: LIVE ? "1" : "0",
      // The deterministic gate is network-free: mock synthesis must never be
      // paced or rate-limited, otherwise a burst of parallel worker requests
      // (all sharing the "local" client key) returns 429 rate_limited and
      // surfaces as prepare_failed / export failure. Real provider limits are
      // kept only for the opt-in live smoke.
      API_RATE_LIMIT_PER_MINUTE: LIVE ? "60" : "1000",
      SPEECH_REQUESTS_PER_MINUTE: LIVE ? "15" : "100000",
      SPEECH_MAX_CONCURRENCY: LIVE ? "1" : "4",
      SPEECH_CACHE_DIR: LIVE ? ".cache/audio" : ".cache/audio-e2e",
      PORT: "3123",
    },
  },
});
