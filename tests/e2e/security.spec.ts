/**
 * Part 5 (browser layer) — security inertness E2E.
 *
 * Parses adversarial documents that try to (a) reach the network and
 * (b) execute script. The real adapters sanitize before any DOM touch, and the
 * reader renders TEXT only, so: the legitimate content survives, no external
 * resource is ever requested, and no injected script runs.
 */
import { expect, test, type Page } from "@playwright/test";
import { maliciousEpub, MALICIOUS_HTML } from "./helpers/doc-fixtures";

/** Collect every request URL, then report any that is not same-origin. */
function trackRequests(page: Page): () => { all: string[]; external: string[] } {
  const all: string[] = [];
  page.on("request", (req) => all.push(req.url()));
  return () => {
    const external = all.filter((u) => {
      try {
        const url = new URL(u);
        if (!url.protocol.startsWith("http")) return false; // data:, blob:, about:
        return !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
      } catch {
        return false;
      }
    });
    return { all, external };
  };
}

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

test("malicious EPUB: legit text survives, zero external requests, no script runs", async ({
  page,
}) => {
  const reqs = trackRequests(page);
  const errors = trackPageErrors(page);
  const fixture = await maliciousEpub();

  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles({
    name: "malicious.epub",
    mimeType: "application/epub+zip",
    buffer: fixture.buffer,
  });

  // Legitimate content renders (proof the document actually parsed).
  const text = page.locator(".reader-text");
  await expect(text).toContainText("Contenido legítimo antes del ataque.", {
    timeout: 30_000,
  });
  await expect(text).toContainText("Esta sección sigue siendo legible.");

  // The sanitizer strips the injected payloads before any DOM interaction.
  const joined = (await text.locator(".reader-seg").allTextContents()).join("\n");
  expect(joined).not.toContain("evil.invalid");

  // No external resource was ever requested (no CSS/img/iframe/script fetch).
  const { external } = reqs();
  expect(external).toEqual([]);
  expect(reqs().all.some((u) => u.includes("evil.invalid"))).toBe(false);

  // No injected script executed.
  const pwned = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return {
      epub: w.__pwned_epub,
      link: w.__pwned_link,
      click: w.__pwned_click,
      error: w.__pwned_error,
    };
  });
  expect(pwned).toEqual({
    epub: undefined,
    link: undefined,
    click: undefined,
    error: undefined,
  });

  expect(errors).toEqual([]);
});

test("malicious HTML: text survives, no external requests, no inline script executes", async ({
  page,
}) => {
  const reqs = trackRequests(page);
  const errors = trackPageErrors(page);

  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles({
    name: "malicious.html",
    mimeType: "text/html",
    buffer: Buffer.from(MALICIOUS_HTML, "utf8"),
  });

  const text = page.locator(".reader-text");
  await expect(text).toContainText("Documento legítimo por fuera", { timeout: 30_000 });
  await expect(text).toContainText("Texto final que sí debe llegar al lector.");
  const joined = (await text.locator(".reader-seg").allTextContents()).join("\n");
  expect(joined).not.toContain("evil.invalid");

  const { external } = reqs();
  expect(external).toEqual([]);

  const pwned = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return {
      top: w.__pwned_top,
      link: w.__pwned_link,
      click: w.__pwned_click,
      error: w.__pwned_error,
    };
  });
  expect(pwned).toEqual({
    top: undefined,
    link: undefined,
    click: undefined,
    error: undefined,
  });

  expect(errors).toEqual([]);
});
