import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "lcov"],
      include: ["src/**/*.ts"],
      // The extension adapter is exercised behaviorally; deterministic archive,
      // recall, path, and packet logic is covered as independent pure modules.
      exclude: ["src/**/*.test.ts", "src/index.ts"],
      // OS-level EEXIST/rollback races remain runtime-canary surfaces; deterministic
      // domain lines stay at 95% while branch/statement floors cover all ordinary paths.
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 85,
        statements: 93,
      },
    },
  },
});
