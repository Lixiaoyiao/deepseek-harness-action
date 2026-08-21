import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The suite starts real Git and DSH fixture processes. Windows endpoint
    // scanning can push otherwise-fast integration tests beyond Vitest's 5s
    // default while their controller-owned process deadlines remain bounded.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: {
        lines: 80,
        functions: 84,
        statements: 77,
        branches: 67,
      },
    },
  },
});
