import { describe, expect, test } from "vitest";

describe("pi-sisyphus public package surface", () => {
  test("does not expose receipt construction or attestor capabilities", async () => {
    const packageApi = await import("pi-sisyphus");

    expect(Object.keys(packageApi).sort()).toEqual([
      "canaryActionDescriptors",
      "createPiSisyphusExtension",
      "createToolPolicyHandler",
      "evaluateTrust",
      "resolveSisyphusBinary",
      "resolveSisyphusConfig",
      "vetMcp",
    ]);
    for (const forbidden of [
      "CanaryAttestationError",
      "createCanaryAttestor",
    ]) {
      expect(packageApi).not.toHaveProperty(forbidden);
    }
  });

  test("does not export the internal attestor subpath", async () => {
    const internalSubpath = "pi-sisyphus/canary-attestor";

    await expect(import(internalSubpath)).rejects.toThrow(/canary-attestor/u);
  });
});
