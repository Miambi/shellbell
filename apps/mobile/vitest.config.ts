import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
    // Task 1 ships no test/*.test.ts yet (Task 4 adds connection.test.ts, etc.); without this,
    // vitest exits 1 on an empty suite and blocks the repo-root `pnpm test` gate.
    passWithNoTests: true,
  },
});
