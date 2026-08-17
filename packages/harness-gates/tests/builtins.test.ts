import { type DiffStat, HarnessConfigSchema } from "@harness/core";
import { describe, expect, it } from "vitest";
import { diffScope, noSkippedTests, noSuppressions, secretScan } from "../src/builtins.ts";

const config = HarnessConfigSchema.parse({});

function patch(file: string, addedLines: string[]): DiffStat {
  const body = addedLines.map((line) => `+${line}`).join("\n");
  return {
    changedFiles: [file],
    addedLines: addedLines.length,
    removedLines: 0,
    patch: [
      `diff --git a/${file} b/${file}`,
      "--- /dev/null",
      `+++ b/${file}`,
      `@@ -0,0 +1,${addedLines.length} @@`,
      body,
    ].join("\n"),
  };
}

/**
 * Positive fixtures are assembled at runtime so the literal never appears in
 * this file. Otherwise these tests trip the very checks they cover, and the fix
 * would be an exemption path — the exact escape hatch an agent under repair
 * pressure would reach for.
 */
const TS_SUPPRESS = `// @ts-${"expect-error"} legacy shim`;
const LINT_SUPPRESS = `/* eslint-${"disable"} no-console */`;
const BIOME_SUPPRESS = `// biome-${"ignore"} lint: x`;
const SKIPPED_TEST = `it.${"skip"}('does the thing', () => {});`;
const LEAKED_KEY = `const key = "sk-ant-${"api03"}-abcdefghijklmnop";`;

describe("noSuppressions", () => {
  it("flags a real suppression directive", () => {
    const diff = patch("packages/a/src/x.ts", [TS_SUPPRESS, "doThing();"]);
    const result = noSuppressions({ diff, config, worktree: "/tmp" });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.line).toBe(1);
  });

  it("flags block-comment and lint suppressions", () => {
    const diff = patch("packages/a/src/x.ts", [LINT_SUPPRESS, BIOME_SUPPRESS]);
    expect(noSuppressions({ diff, config, worktree: "/tmp" }).failures).toHaveLength(2);
  });

  it("does not flag prose or patterns that merely name a directive", () => {
    const diff = patch("packages/a/src/x.ts", [
      " * silence the typechecker with `@ts-expect-error`",
      "const re = /@ts-(?:ignore|expect-error)/;",
      'const rule = "Do not add @ts-ignore";',
    ]);
    expect(noSuppressions({ diff, config, worktree: "/tmp" }).failures).toEqual([]);
  });
});

describe("noSkippedTests", () => {
  it("flags a disabled test in a test file", () => {
    const diff = patch("packages/a/tests/x.test.ts", [SKIPPED_TEST]);
    expect(noSkippedTests({ diff, config, worktree: "/tmp" }).failures).toHaveLength(1);
  });

  it("ignores non-test files", () => {
    const diff = patch("packages/a/src/x.ts", ["queue.skip(item);"]);
    expect(noSkippedTests({ diff, config, worktree: "/tmp" }).failures).toEqual([]);
  });
});

describe("secretScan", () => {
  it("flags an added credential", () => {
    const diff = patch("packages/a/src/x.ts", [LEAKED_KEY]);
    expect(secretScan({ diff, config, worktree: "/tmp" }).failures).toHaveLength(1);
  });

  it("ignores environment lookups", () => {
    const diff = patch("packages/a/src/x.ts", ["const key = process.env.ANTHROPIC_API_KEY;"]);
    expect(secretScan({ diff, config, worktree: "/tmp" }).failures).toEqual([]);
  });
});

describe("diffScope", () => {
  it("fails on a protected path", () => {
    const diff = patch(".github/workflows/ci.yml", ["  run: echo hi"]);
    const result = diffScope({ diff, config, worktree: "/tmp" });
    expect(result.failures[0]?.code).toBe("scope/protected");
  });

  it("warns but does not fail on a sensitive path", () => {
    const diff = patch("pnpm-lock.yaml", ["  foo: 1"]);
    const result = diffScope({ diff, config, worktree: "/tmp" });
    expect(result.failures).toEqual([]);
    expect(result.warnings[0]?.code).toBe("scope/sensitive");
  });

  it("fails when the diff exceeds the line ceiling", () => {
    const diff = patch("packages/a/src/x.ts", ["x"]);
    diff.addedLines = config.scope.maxChangedLines + 1;
    const result = diffScope({ diff, config, worktree: "/tmp" });
    expect(result.failures.map((f) => f.code)).toContain("scope/too-many-lines");
  });
});
