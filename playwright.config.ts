import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end coverage of the critical Phase 0 workflow against the mock
 * provider: deterministic and network-free in CI.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
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
      PORT: "3123",
    },
  },
});
