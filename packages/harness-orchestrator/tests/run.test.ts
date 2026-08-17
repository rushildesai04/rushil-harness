import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadConfig } from "@harness/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBuildTask } from "../src/run.ts";

const execFileAsync = promisify(execFile);
const STUB = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "stub-pi.mjs");

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout;
}

/**
 * A gate that fails until the agent creates `.fixed`.
 *
 * This is what makes the repair loop observable: the first gate run must fail,
 * the agent must act on the failure, and the second run must pass — with the
 * verdict coming from a real exit code rather than from anything the agent said.
 */
const GATES = `
gates:
  - id: check
    label: Requires the fix marker
    tier: 1
    command: "test -f .fixed"
    timeoutMs: 30000
`;

function harnessConfig(maxRepairAttempts: number): string {
  return `
builder:
  tools: [read, bash, edit, write]
  promptTimeoutMs: 15000
  maxRepairAttempts: ${maxRepairAttempts}
roles:
  implementer:
    model: { provider: anthropic, id: stub-impl, thinking: low }
    tools: [read, bash, edit, write]
    timeoutMs: 15000
`;
}

let repo: string;

async function makeRepo(maxRepairAttempts: number): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "harness-run-"));
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "gates.yaml"), GATES, "utf8");
  writeFileSync(join(root, "config", "harness.yaml"), harnessConfig(maxRepairAttempts), "utf8");
  writeFileSync(join(root, ".gitignore"), ".harness/\n", "utf8");
  writeFileSync(join(root, "README"), "seed\n", "utf8");

  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@local"]);
  await git(root, ["config", "user.name", "test"]);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "base"]);
  return root;
}

beforeEach(() => {
  // Preflight queries the real pi; the stub replaces the agent, not the
  // credential check. Assembled at runtime so the secret-scan gate stays honest.
  process.env.ANTHROPIC_API_KEY = `sk-ant-${"stub"}-not-a-real-key`;
  process.env.STUB_MODE = "normal";
  delete process.env.STUB_REPAIR;
});

afterEach(() => {
  delete process.env.STUB_REPAIR;
  delete process.env.ANTHROPIC_API_KEY;
});

describe("runBuildTask", () => {
  it("repairs a failing gate and reports the attempt it took", async () => {
    repo = await makeRepo(3);

    const result = await runBuildTask({
      loaded: loadConfig(repo),
      task: "build the thing",
      cliPath: STUB,
    });

    expect(result.record.status).toBe("passed");
    // One build attempt plus one repair; the loop stopped as soon as it was green.
    expect(result.attempts).toBe(2);
    expect(result.gates?.passed).toBe(true);
    expect(result.diff?.changedFiles).toContain("src/thing.ts");
  });

  it("gives up when the agent cannot satisfy the gate", async () => {
    repo = await makeRepo(1);
    process.env.STUB_REPAIR = "never";

    const result = await runBuildTask({
      loaded: loadConfig(repo),
      task: "build the thing",
      cliPath: STUB,
    });

    expect(result.record.status).toBe("failed");
    expect(result.reason).toMatch(/repair attempts/);
    // The worktree is kept on failure so the diff can be inspected.
    expect(existsSync(result.worktree)).toBe(true);
    expect(result.gates?.passed).toBe(false);
  });

  it("refuses to start against a dirty working tree", async () => {
    repo = await makeRepo(1);
    writeFileSync(join(repo, "uncommitted.txt"), "x\n", "utf8");

    await expect(runBuildTask({ loaded: loadConfig(repo), task: "x", cliPath: STUB })).rejects.toThrow(
      /dirty/,
    );
  });
});
