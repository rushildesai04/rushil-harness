import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/tests/**/*.test.ts"],
    // Contract tests spawn the pi binary; give them room without hanging CI.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
