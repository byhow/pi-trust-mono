import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "lcov"],
      include: ["src/**/*.ts"],
      // Only the two thin pi-runtime adapters are excluded: they just wire the
      // pi command surface to pure logic that IS covered (recall-core.ts) or is
      // a prompt-builder needing the live agent (archive-session.ts). Everything
      // with real logic — search core, packet mapping, path resolution, and the
      // recall pipeline — is tested atomically.
      exclude: [
        "src/**/*.test.ts",
        "src/commands/recall.ts",
        "src/commands/archive-session.ts",
      ],
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 90,
        statements: 95,
      },
    },
  },
});
