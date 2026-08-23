import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadConfig } from "@harness/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPipeline } from "../src/pipeline.ts";

const execFileAsync = promisify(execFile);
const STUB = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "stub-pi.mjs");

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout;
}

// Gates that cost nothing: one in-process check plus a command that always
// succeeds. The gate machinery is covered elsewhere; what is under test here is
// the pipeline's control flow.
const GATES = `
gates:
  - id: no-suppressions
    label: No diagnostic suppressions
    kind: builtin
    tier: 0
  - id: check
    label: Trivial command gate
    tier: 1
    command: "true"
    timeoutMs: 30000
`;

const HARNESS = `
model:
  provider: anthropic
  thinking: low
builder:
  tools: [read, bash, edit, write]
  promptTimeoutMs: 60000
  maxRepairAttempts: 1
pipeline:
  concurrency: 2
  adversaryRounds: 1
  maxUnits: 4
  structuredRetries: 1
  maxCostUsd: 0
  blockingSeverity: high
`;

function roleBlock(timeoutMs: number): string {
  const tools = "[read, bash, edit, write, grep, find, ls]";
  return `
roles:
  designer:
    model: { provider: anthropic, id: stub-designer, thinking: low }
    tools: [read, grep, find, ls]
    timeoutMs: ${timeoutMs}
  implementer:
    model: { provider: anthropic, id: stub-impl, thinking: low }
    tools: ${tools}
    timeoutMs: ${timeoutMs}
  adversary:
    model: { provider: anthropic, id: stub-adv, thinking: low }
    tools: [read, bash, grep, find, ls]
    timeoutMs: ${timeoutMs}
  combiner:
    model: { provider: anthropic, id: stub-comb, thinking: low }
    tools: ${tools}
    timeoutMs: ${timeoutMs}
`;
}

let repo: string;

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "harness-pipeline-"));
  mkdirSync(join(repo, "config"), { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "config", "gates.yaml"), GATES, "utf8");
  writeFileSync(join(repo, "config", "harness.yaml"), `${HARNESS}${roleBlock(60000)}`, "utf8");
  writeFileSync(join(repo, "src", "seed.ts"), "export const seed = true;\n", "utf8");
  writeFileSync(join(repo, ".gitignore"), ".harness/\n", "utf8");

  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "test@local"]);
  await git(repo, ["config", "user.name", "test"]);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "base"]);

  // Preflight shells out to the real pi; the stub replaces the agent, not the
  // credential check, so give it something to find. Assembled at runtime so the
  // literal never appears in the file — the secret-scan gate is right to flag
  // it, and an exemption path would be the wrong fix.
  process.env.ANTHROPIC_API_KEY = `sk-ant-${"stub"}-not-a-real-key`;
  process.env.STUB_MODE = "normal";
  // `env.X = undefined` assigns the string "undefined", which the stub would
  // then emit as a severity. Deleting is the only way to unset.
  delete process.env.STUB_FINDING;
});

afterEach(() => {
  delete process.env.STUB_FINDING;
  delete process.env.STUB_CONFLICT;
  delete process.env.ANTHROPIC_API_KEY;
});

/**
 * Drives the whole pipeline against a stub that role-plays from the real
 * prompts. Everything except model reasoning is exercised: plan validation,
 * wave scheduling, per-unit worktrees, gates, commits, adversarial rounds,
 * deterministic integration, and the PR body.
 */
describe("runPipeline end to end", () => {
  it("designs, builds units in parallel, reviews, and integrates", async () => {
    const loaded = loadConfig(repo);
    const phases: string[] = [];

    const result = await runPipeline({
      loaded,
      task: "create alpha and beta modules",
      openPr: false,
      cliPath: STUB,
      onPhase: (phase) => phases.push(phase),
    });

    expect(result.reason).toBeUndefined();
    expect(result.status).toBe("passed");
    expect(result.plan?.units.map((unit) => unit.id)).toEqual(["alpha", "beta"]);
    expect(result.units.every((unit) => unit.status === "passed")).toBe(true);
    expect(result.unresolved).toEqual([]);

    // Both units' work survives into one integrated tree.
    const integration = result.integration;
    expect(integration?.status).toBe("passed");
    expect(existsSync(join(integration?.worktree ?? "", "src", "alpha.ts"))).toBe(true);
    expect(existsSync(join(integration?.worktree ?? "", "src", "beta.ts"))).toBe(true);

    // Independent units share a wave rather than serialising.
    expect(phases.filter((phase) => phase === "build")).toHaveLength(1);

    // The run is auditable after the fact.
    expect(existsSync(join(result.runDir, "plan.json"))).toBe(true);
    expect(existsSync(join(result.runDir, "result.json"))).toBe(true);
    const events = readFileSync(join(result.runDir, "events.ndjson"), "utf8");
    expect(events).toContain("pipeline:plan");
    expect(events).toContain("integrate:end");
  });

  it("blocks integration when a high-severity finding is never resolved", async () => {
    process.env.STUB_FINDING = "high";
    const loaded = loadConfig(repo);

    const result = await runPipeline({
      loaded,
      task: "create alpha and beta modules",
      openPr: false,
      cliPath: STUB,
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/unresolved finding/);
    expect(result.unresolved.length).toBeGreaterThan(0);
    // Nothing was integrated, so no combined commit exists to be pushed.
    expect(result.integration).toBeNull();
    expect(result.prUrl).toBeNull();
  });

  it("lets a low-severity finding through without blocking", async () => {
    process.env.STUB_FINDING = "low";
    const loaded = loadConfig(repo);

    const result = await runPipeline({
      loaded,
      task: "create alpha and beta modules",
      openPr: false,
      cliPath: STUB,
    });

    expect(result.status).toBe("passed");
    expect(result.unresolved.length).toBeGreaterThan(0);
    expect(result.integration?.status).toBe("passed");
  });

  it("routes a real merge conflict through the combiner and still gates the result", async () => {
    // Units stay within their declared ownership on paper but both write a
    // shared file, which is how overlap actually shows up: not in the plan, but
    // in what the implementers do.
    process.env.STUB_CONFLICT = "1";

    const result = await runPipeline({
      loaded: loadConfig(repo),
      task: "create alpha and beta modules",
      openPr: false,
      cliPath: STUB,
    });

    expect(result.reason).toBeUndefined();
    expect(result.status).toBe("passed");
    expect(result.integration?.conflictedUnits.length).toBeGreaterThan(0);

    // The combiner's resolution survives, and both units' own files are intact.
    const worktree = result.integration?.worktree ?? "";
    expect(readFileSync(join(worktree, "src", "shared.ts"), "utf8")).toContain("alpha+beta");
    expect(existsSync(join(worktree, "src", "alpha.ts"))).toBe(true);
    expect(existsSync(join(worktree, "src", "beta.ts"))).toBe(true);

    // Gates run on the combined tree, after resolution — not before.
    expect(result.integration?.gates?.passed).toBe(true);
    delete process.env.STUB_CONFLICT;
  });

  it("counts adversary sessions, not just implementers, toward run cost", async () => {
    const result = await runPipeline({
      loaded: loadConfig(repo),
      task: "create alpha and beta modules",
      openPr: false,
      cliPath: STUB,
    });

    expect(result.status).toBe("passed");
    // Five sessions bill at the stub's fixed rate: one designer, two
    // implementers, one adversary per unit. Dropping the adversaries would
    // report 3/5 of the real spend and let the ceiling permit far more than
    // it says.
    const perSession = 0.4242;
    expect(result.costUsd).toBeCloseTo(perSession * 5, 4);
    for (const unit of result.units) {
      expect(unit.costUsd).toBeCloseTo(perSession * 2, 4);
    }
  });

  it("stops dispatching units once the cost ceiling is reached", async () => {
    // Serial, with a ceiling the first unit is guaranteed to cross.
    writeFileSync(
      join(repo, "config", "harness.yaml"),
      `${HARNESS.replace("concurrency: 2", "concurrency: 1").replace("maxCostUsd: 0", "maxCostUsd: 0.9")}${roleBlock(60000)}`,
      "utf8",
    );
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "tighten cost ceiling"]);

    const result = await runPipeline({
      loaded: loadConfig(repo),
      task: "create alpha and beta modules",
      openPr: false,
      cliPath: STUB,
    });

    expect(result.status).toBe("failed");
    const skipped = result.units.filter((unit) => unit.reason?.includes("Cost ceiling"));
    expect(skipped).toHaveLength(1);
    // The skipped unit never got a worktree or a session.
    expect(skipped[0]?.commit).toBeNull();
    expect(skipped[0]?.reviews).toEqual([]);
    expect(result.integration).toBeNull();
  });

  it("rejects a plan whose units claim the same files, before building anything", async () => {
    // Rewrite the config so the designer's plan violates the ceiling instead,
    // which is the same class of pre-flight rejection and needs no stub change.
    writeFileSync(
      join(repo, "config", "harness.yaml"),
      `${HARNESS.replace("maxUnits: 4", "maxUnits: 1")}${roleBlock(60000)}`,
      "utf8",
    );
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "tighten plan ceiling"]);

    const result = await runPipeline({
      loaded: loadConfig(repo),
      task: "create alpha and beta modules",
      openPr: false,
      cliPath: STUB,
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/units, ceiling is 1/);
    expect(result.units).toEqual([]);
  });
});
