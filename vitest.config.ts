import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    // Full CI runs hundreds of isolated files on a small shared runner.
    // Reserve CPU for deterministic, wall-clock-bounded optimizer tests
    // instead of competing with excessive test workers.
    maxWorkers: 2,
    minWorkers: 1,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
      "server-only": path.resolve(import.meta.dirname, "lib/testing/serverOnlyStub.ts"),
    },
  },
});
