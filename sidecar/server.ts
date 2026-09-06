/**
 * DocuVoz speech sidecar — entrypoint.
 *
 * Contract with the Rust host:
 *   - expects the per-process bearer token in DOCUVOZ_SIDECAR_TOKEN
 *     (never a CLI argument, never printed);
 *   - binds 127.0.0.1:0 (ephemeral loopback port);
 *   - prints exactly one machine-readable readiness line on stdout:
 *       READY {"port":12345}
 *   - keeps running until SIGTERM/SIGINT (then aborts in-flight work and exits).
 *
 * All structured logs go to stderr so stdout stays reserved for the handshake.
 */
process.env.LOG_TO_STDERR = "1";

import { getServerRuntime } from "@/server/config";
import { FileAudioCache } from "@/infrastructure/cache/file-audio-cache";
import { SlidingWindowRateLimiter } from "@/server/rate-limit";
import { createLogger } from "@/infrastructure/logging/logger";
import { createSidecarApp } from "./app";

const TOKEN = process.env.DOCUVOZ_SIDECAR_TOKEN;
if (!TOKEN) {
  process.stderr.write("DOCUVOZ_SIDECAR_TOKEN is required\n");
  process.exit(2);
}

const runtime = getServerRuntime();
const cache = new FileAudioCache(runtime.config.SPEECH_CACHE_DIR);
const limiter = new SlidingWindowRateLimiter(runtime.config.API_RATE_LIMIT_PER_MINUTE);
const logger = createLogger({ component: "sidecar" });
const app = createSidecarApp({
  token: TOKEN,
  deps: {
    config: runtime.config,
    provider: runtime.provider,
    engines: runtime.engines,
    cache,
    limiter,
    logger,
  },
});

function shutdown(): void {
  void app.shutdown().then(
    () => process.exit(0),
    () => process.exit(0),
  );
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

app.listen(0).then(
  (port) => {
    process.stdout.write(`READY ${JSON.stringify({ port })}\n`);
    logger.info({ event: "sidecar_ready", port }, "sidecar ready");
  },
  (error) => {
    logger.error(
      {
        event: "sidecar_start_failed",
        message: error instanceof Error ? error.message : "unknown",
      },
      "sidecar failed to start",
    );
    process.exit(3);
  },
);
