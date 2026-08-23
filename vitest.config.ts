import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/tests/**/*.test.ts"],
    // Much of this suite spawns real processes and manipulates real git
    // worktrees. Running files concurrently makes those compete for CPU and
    // disk, which showed up on CI as agent turns exceeding their budget rather
    // than as any real defect. Determinism is worth more here than wall-clock.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
