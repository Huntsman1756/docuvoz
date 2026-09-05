/**
 * Vitest setup file: global mocks for browser-only modules.
 *
 * DOMPurify requires a browser DOM. In Node.js test environment,
 * we provide simplified mocks using jsdom where needed.
 */
import { vi } from "vitest";

vi.mock("dompurify", () => ({
  default: {
    sanitize(html: string): string {
      return html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
        .replace(/<object[\s\S]*?<\/object>/gi, "")
        .replace(/<embed[\s\S]*?>/gi, "")
        .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, "");
    },
  },
}));

// Provide DOMParser, NodeFilter, and document in Node.js via jsdom (synchronous)
if (typeof globalThis.DOMParser === "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { JSDOM } = require("jsdom") as typeof import("jsdom");
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  g.DOMParser = dom.window.DOMParser;
  g.NodeFilter = dom.window.NodeFilter;
  g.document = dom.window.document;
  g.Node = dom.window.Node;
}
