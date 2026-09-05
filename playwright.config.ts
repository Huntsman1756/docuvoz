import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end coverage of the critical Phase 0 workflow against the mock
 * provider: deterministic and network-free in CI.
 */
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
  // Browser specs that play real-time (mock) audio and WASM-encode exports are
  // sensitive to CPU contention when the whole suite runs in one process, and
  // the always-on live-TTS checkpoint saturates the machine. Retry tolerates
  // that transient infra timing without weakening any assertion.
  retries: 2,
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
    command: "npm run build && npm run start -- -p 3123 -H 127.0.0.1",
    url: "http://127.0.0.1:3123/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: {
      NODE_ENV: "production",
      SPEECH_PROVIDER: "mock",
      EDGE_TTS_ENABLED: "1",
      PORT: "3123",
    },
  },
});
