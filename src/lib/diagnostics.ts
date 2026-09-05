/**
 * Parser diagnostics: significant adapter warnings are collected here so the
 * laboratory (/lab) can surface them. They are deliberately NOT shown in the
 * Reader (users must not see internal technical noise) and never contain
 * document text beyond short parser messages.
 *
 * In the browser the last entries persist in sessionStorage so a navigation
 * to /lab can still display them; outside the browser they stay in memory.
 */

export interface ParserDiagnostic {
  /** Adapter or subsystem id, e.g. "mammoth-docx". */
  source: string;
  level: "info" | "warning" | "error";
  message: string;
  /** ISO timestamp. */
  at: string;
}

const MAX_ENTRIES = 100;
const STORAGE_KEY = "docuviz.parserDiagnostics";

let memory: ParserDiagnostic[] = [];

function persist(entries: ParserDiagnostic[]): void {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    }
  } catch {
    // Storage unavailable (private mode / SSR): memory-only is fine.
  }
}

export function recordParserDiagnostic(
  source: string,
  level: ParserDiagnostic["level"],
  message: string,
): void {
  memory.push({ source, level, message, at: new Date().toISOString() });
  if (memory.length > MAX_ENTRIES) memory = memory.slice(-MAX_ENTRIES);
  persist(memory);
}

export function getParserDiagnostics(): ParserDiagnostic[] {
  try {
    if (typeof sessionStorage !== "undefined") {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as ParserDiagnostic[];
        if (Array.isArray(parsed)) return parsed;
      }
    }
  } catch {
    // fall through to memory
  }
  return memory;
}

export function clearParserDiagnostics(): void {
  memory = [];
  try {
    if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
