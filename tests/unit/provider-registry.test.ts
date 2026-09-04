/**
 * Provider extension point — unit tests.
 */
import { describe, expect, it } from "vitest";
import { validateProviderConfig } from "@/lib/provider-registry";

describe("validateProviderConfig", () => {
  it("returns no issues when provider is disabled", () => {
    expect(validateProviderConfig(false, { KEY: "value" })).toEqual([]);
  });

  it("returns no issues when all required keys are present", () => {
    expect(
      validateProviderConfig(true, {
        KEY_A: "val",
        KEY_B: "val",
      }),
    ).toEqual([]);
  });

  it("reports missing required keys", () => {
    const issues = validateProviderConfig(true, {
      KEY_A: "",
      KEY_B: undefined,
      KEY_C: "val",
    });
    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain("KEY_A");
    expect(issues[1]).toContain("KEY_B");
  });
});
