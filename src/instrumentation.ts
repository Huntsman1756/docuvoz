/**
 * Next.js instrumentation hook: validate configuration at server startup so
 * misconfiguration fails fast with an actionable message instead of failing
 * per-request.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { loadConfig } = await import("@/server/config");
  try {
    const config = loadConfig();
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        component: "startup",
        event: "config_validated",
        provider: config.SPEECH_PROVIDER,
        logLevel: config.LOG_LEVEL,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown config error";
    console.error(`Startup configuration error: ${message}`);
    if (process.env.NODE_ENV === "production") {
      throw error;
    }
  }
}
