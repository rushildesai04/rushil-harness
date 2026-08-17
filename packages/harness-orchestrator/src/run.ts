import { resolve } from "node:path";
import type { DiffStat, GateResult, GateRunSummary, LoadedConfig, RunRecord } from "@harness/core";
import { RunStore } from "@harness/core";
import { runGates } from "@harness/gates";
import { addWorktree, assertCleanRepo, collectDiff, removeWorktree, resolveCommit } from "./git.ts";
import { buildNoDiffPrompt, buildRepairPrompt, buildTaskPrompt } from "./prompts.ts";
import { Worker } from "./worker.ts";

export interface BuildRunOptions {
  loaded: LoadedConfig;
  task: string;
  baseRef?: string;
  /** Keep the worktree after a passing run for manual inspection. */
  cleanup?: "on-success" | "never";
  onText?: (delta: string) => void;
  onGate?: (result: GateResult) => void;
  onPhase?: (phase: string, detail?: string) => void;
}

export interface BuildRunResult {
  record: RunRecord;
  runDir: string;
  worktree: string;
  diff: DiffStat | null;
  gates: GateRunSummary | null;
  attempts: number;
  reason?: string;
}

/**
 * Phase 1 + 2: one builder in an isolated worktree, wrapped in a bounded
 * verify-and-repair loop.
 *
 * The loop is deliberately bounded. Unbounded repair converges on nothing and
 * spends real money doing it; three attempts with precise diagnostics is where
 * the returns flatten in practice, and the ceiling is config, not code.
 */
export async function runBuildTask(options: BuildRunOptions): Promise<BuildRunResult> {
  const { loaded, task } = options;
  const { repoRoot, harness, gates } = loaded;
  const baseRef = options.baseRef ?? "HEAD";

  await assertCleanRepo(repoRoot);
  const baseCommit = await resolveCommit(repoRoot, baseRef);

  const runId = RunStore.newRunId();
  const worktree = resolve(repoRoot, harness.paths.worktrees, runId, "builder");
  const runsRoot = resolve(repoRoot, harness.paths.runs);

  const runStore = RunStore.create(runsRoot, runId, {
    task,
    baseRef,
    baseCommit,
    worktree,
    status: "running",
    attempts: 0,
    startedAt: Date.now(),
  });

  runStore.emit("run:start", {
    task,
    baseRef,
    baseCommit,
    configSources: loaded.sources,
    gateIds: gates.gates.map((g) => g.id),
  });

  options.onPhase?.("worktree", worktree);
  await addWorktree(repoRoot, worktree, baseCommit);

  const worker = new Worker({
    agentId: "builder",
    worktree,
    config: harness,
    runStore,
    ...(options.onText ? { onText: options.onText } : {}),
  });

  let diff: DiffStat | null = null;
  let summary: GateRunSummary | null = null;
  let attempts = 0;
  let reason: string | undefined;

  try {
    await worker.start();

    let prompt = buildTaskPrompt(task);
    const maxAttempts = harness.builder.maxRepairAttempts + 1;

    for (attempts = 1; attempts <= maxAttempts; attempts++) {
      options.onPhase?.("agent", attempts === 1 ? "building" : `repair ${attempts - 1}`);

      const outcome = await worker.send(prompt, harness.builder.promptTimeoutMs);
      if (outcome.timedOut) {
        reason = `Agent exceeded ${harness.builder.promptTimeoutMs}ms on attempt ${attempts}.`;
        break;
      }

      diff = await collectDiff(worktree);
      runStore.emit("diff:collected", {
        attempt: attempts,
        files: diff.changedFiles.length,
        added: diff.addedLines,
        removed: diff.removedLines,
      });

      if (diff.changedFiles.length === 0) {
        if (attempts >= maxAttempts) {
          reason = "Agent produced no changes.";
          break;
        }
        prompt = buildNoDiffPrompt();
        continue;
      }

      options.onPhase?.("gates");
      summary = await runGates({
        worktree,
        diff,
        config: harness,
        gates,
        onResult: (result) => {
          options.onGate?.(result);
          runStore.emit("gate:result", {
            attempt: attempts,
            gateId: result.gateId,
            status: result.status,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            failureCount: result.failures.length,
          });
          if (result.output) runStore.writeGateOutput(`${attempts}-${result.gateId}`, result.output);
        },
      });

      if (summary.passed) break;

      if (attempts >= maxAttempts) {
        reason = `Gates still failing after ${harness.builder.maxRepairAttempts} repair attempts: ${summary.blockingFailures
          .map((f) => f.gateId)
          .join(", ")}.`;
        break;
      }
      prompt = buildRepairPrompt(summary, attempts, harness.builder.maxRepairAttempts);
    }

    if (diff) runStore.writeArtifact("changes.patch", diff.patch);
    if (summary) runStore.writeArtifact("gates.json", `${JSON.stringify(summary.results, null, 2)}\n`);

    const stats = await worker.stats();
    const passed = summary?.passed === true && (diff?.changedFiles.length ?? 0) > 0;

    runStore.update({
      status: passed ? "passed" : "failed",
      attempts,
      endedAt: Date.now(),
      ...stats,
    });
    runStore.emit("run:end", { status: passed ? "passed" : "failed", attempts, reason });

    if (passed && options.cleanup !== "never") {
      await removeWorktree(repoRoot, worktree);
    }

    return {
      record: runStore.getRecord(),
      runDir: runStore.dir,
      worktree,
      diff,
      gates: summary,
      attempts,
      ...(reason ? { reason } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runStore.update({ status: "aborted", attempts, endedAt: Date.now() });
    runStore.emit("run:error", { message });
    throw error;
  } finally {
    await worker.stop();
  }
}
