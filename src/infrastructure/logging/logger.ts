/**
 * Structured JSON logging for server code.
 *
 * Document content is NEVER logged — only lengths and one-way hashes so that
 * incidents can be investigated without leaking user documents.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: string | number | boolean | null | undefined;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(fields: LogFields, message?: string): void;
  info(fields: LogFields, message?: string): void;
  warn(fields: LogFields, message?: string): void;
  error(fields: LogFields, message?: string): void;
  child(extra: LogFields): Logger;
}

function minLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL ?? "info";
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error"
    ? raw
    : "info";
}

function emit(level: LogLevel, fields: LogFields, message?: string): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel()]) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    ...(message !== undefined ? { msg: message } : {}),
    ...fields,
  });
  if (level === "error") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export function createLogger(extra: LogFields = {}): Logger {
  return {
    debug: (fields, message) => emit("debug", { ...extra, ...fields }, message),
    info: (fields, message) => emit("info", { ...extra, ...fields }, message),
    warn: (fields, message) => emit("warn", { ...extra, ...fields }, message),
    error: (fields, message) => emit("error", { ...extra, ...fields }, message),
    child: (childFields) => createLogger({ ...extra, ...childFields }),
  };
}

export const defaultLogger = createLogger({ component: "app" });

/** Safe content fingerprint: length + short hash prefix, never the content. */
export function contentFingerprint(text: string, hash: (s: string) => string): string {
  return `${text.length}:${hash(text).slice(0, 12)}`;
}
