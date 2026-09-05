import { createRequire } from "node:module";
import { expect, it } from "vitest";
import manifest from "../../package.json";
import lock from "../../package-lock.json";

// Use npm's commodity semver implementation already present in the lock.
const { satisfies, minVersion } = createRequire(import.meta.url)("semver") as {
  satisfies(version: string, range: string): boolean;
  minVersion(range: string): { version: string };
};

it("the declared minimum satisfies locked dependencies on supported 64-bit platforms", () => {
  const minimum = minVersion(manifest.engines.node).version;
  expect(minimum).toBe("24.15.0");
  expect(satisfies(process.versions.node, manifest.engines.node)).toBe(true);
  const incompatible = Object.entries(lock.packages).filter(([path, entry]) => {
    const pkg = entry as {
      engines?: { node?: string };
      cpu?: string[];
      optional?: boolean;
    };
    // Windows ia32 is explicitly unsupported (Sharp requires Node 20 there).
    if (pkg.optional && pkg.cpu?.every((cpu) => cpu === "ia32")) return false;
    return path && pkg.engines?.node && !satisfies(minimum, pkg.engines.node);
  });
  expect(incompatible).toEqual([]);
});

it("reproduces the previous Node 20.9 declaration's incompatibility", () => {
  for (const name of ["node_modules/pdfjs-dist", "node_modules/jsdom"] as const) {
    expect(satisfies("20.9.0", lock.packages[name].engines.node)).toBe(false);
  }
});
