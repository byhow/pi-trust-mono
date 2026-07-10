import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "lcov"],
      include: ["src/**/*.ts"],
      // Only the two thin pi-runtime adapters are excluded: recall.ts and
      // archive-session.ts. Each wires the pi command surface to pure logic
      // that IS covered atomically — recall-core.ts, archive-core.ts,
      // git-context.ts, packets.ts, paths.ts, and search/*. No real logic
      // lives in the adapters.
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
