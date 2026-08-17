import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HarnessConfigSchema, loadConfig } from "../src/config.ts";

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "harness-config-"));
  mkdirSync(join(root, "config"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, "config", name), content, "utf8");
  }
  return root;
}

const MINIMAL_GATES = `
gates:
  - id: lint
    tier: 1
    command: pnpm exec biome ci .
`;

describe("HarnessConfigSchema", () => {
  it("fills every section when the file is empty", () => {
    const config = HarnessConfigSchema.parse({});
    expect(config.model.provider).toBe("anthropic");
    expect(config.builder.maxRepairAttempts).toBe(3);
    expect(config.paths.runs).toBe(".harness/runs");
    expect(config.scope.protectedPaths.length).toBeGreaterThan(0);
  });

  it("keeps explicit values over defaults", () => {
    const config = HarnessConfigSchema.parse({ builder: { maxRepairAttempts: 0 } });
    expect(config.builder.maxRepairAttempts).toBe(0);
    // Sibling defaults inside a partially specified section still apply.
    expect(config.builder.concurrency).toBe(3);
  });
});

describe("loadConfig", () => {
  it("loads gates without a harness.yaml", () => {
    const root = fixture({ "gates.yaml": MINIMAL_GATES });
    const loaded = loadConfig(root);
    expect(loaded.gates.gates).toHaveLength(1);
    expect(loaded.gates.gates[0]?.kind).toBe("command");
    expect(loaded.harness.model.provider).toBe("anthropic");
  });

  it("refuses to run without gates.yaml", () => {
    const root = fixture({});
    expect(() => loadConfig(root)).toThrow(/Gate 0 is mandatory/);
  });

  it("rejects duplicate gate ids", () => {
    const root = fixture({
      "gates.yaml": `${MINIMAL_GATES}\n  - id: lint\n    tier: 2\n    command: echo x\n`,
    });
    expect(() => loadConfig(root)).toThrow(/Duplicate gate id/);
  });

  it("rejects a command gate with no command", () => {
    const root = fixture({ "gates.yaml": "gates:\n  - id: broken\n    tier: 1\n" });
    expect(() => loadConfig(root)).toThrow(/no command/);
  });

  it("reports the offending path on a schema violation", () => {
    const root = fixture({ "gates.yaml": "gates:\n  - id: Bad_Id\n    tier: 1\n    command: echo x\n" });
    expect(() => loadConfig(root)).toThrow(/kebab-case/);
  });
});
