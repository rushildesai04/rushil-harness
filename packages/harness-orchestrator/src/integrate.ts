import { resolve } from "node:path";
import { combinePrompt, type WorkUnit } from "@harness/agents";
import type { GateRunSummary, LoadedConfig, RunStore } from "@harness/core";
import { runGates } from "@harness/gates";
import {
  abortMerge,
  addWorktree,
  collectDiff,
  commitAll,
  excludeHarnessOutput,
  mergeCommit,
  verifyResolved,
} from "./git.ts";
import { Worker } from "./worker.ts";

export interface IntegrationInput {
  loaded: LoadedConfig;
  runStore: RunStore;
  baseCommit: string;
  /** Units that reached a green commit, in the order they should be merged. */
  merges: Array<{ unit: WorkUnit; commit: string }>;
  onPhase: (phase: string, detail?: string) => void;
  /** Test-only override of the pi entry point. */
  cliPath?: string;
}

export interface IntegrationResult {
  worktree: string;
  status: "passed" | "failed";
  commit: string | null;
  gates: GateRunSummary | null;
  conflictedUnits: string[];
  costUsd: number;
  reason?: string;
}

/**
 * Merge every green unit into one tree, then gate the integrated result.
 *
 * Merging is deterministic git first and an agent only on conflict. That order
 * matters: an LLM asked to "combine these changes" rewrites code that already
 * merged cleanly, and the resulting diff is no longer reviewable against the
 * units that produced it.
 *
 * The final gate run is the point of the phase. Every unit passed its gates in
 * isolation; none of them proves the combination compiles.
 */
export async function integrate(input: IntegrationInput): Promise<IntegrationResult> {
  const { loaded, runStore, baseCommit, merges } = input;
  const { repoRoot, harness, gates } = loaded;
  const worktree = resolve(repoRoot, harness.paths.worktrees, runStore.runId, "integration");

  const result: IntegrationResult = {
    worktree,
    status: "failed",
    commit: null,
    gates: null,
    conflictedUnits: [],
    costUsd: 0,
  };

  await addWorktree(repoRoot, worktree, baseCommit);
  await excludeHarnessOutput(worktree);
  runStore.emit("integrate:start", { units: merges.map((m) => m.unit.id) });

  let combiner: Worker | null = null;

  try {
    for (const { unit, commit } of merges) {
      input.onPhase("merge", unit.id);
      const outcome = await mergeCommit(worktree, commit);

      if (!outcome.ok) {
        result.conflictedUnits.push(unit.id);
        runStore.emit("integrate:conflict", { unitId: unit.id, files: outcome.conflicts });

        if (outcome.conflicts.length === 0) {
          // Merge failed for a reason conflict markers cannot express.
          await abortMerge(worktree);
          result.reason = `Merging ${unit.id} failed without reporting conflicted files.`;
          return result;
        }

        input.onPhase("resolve", `${unit.id} (${outcome.conflicts.length} files)`);
        combiner ??= await startCombiner(input, worktree);
        const turn = await combiner.send(
          combinePrompt(
            outcome.conflicts,
            merges.map((m) => m.unit),
          ),
          harness.roles.combiner.timeoutMs,
        );
        if (turn.timedOut) {
          result.reason = `Combiner timed out resolving conflicts in ${unit.id}.`;
          return result;
        }

        const stillBroken = await verifyResolved(worktree);
        if (stillBroken.length > 0) {
          result.reason = `Conflicts remain after resolution in ${unit.id}: ${stillBroken.join(", ")}`;
          return result;
        }
      }

      const merged = await commitAll(worktree, `harness: integrate ${unit.id} (${unit.title})`);
      if (merged) result.commit = merged;
    }

    input.onPhase("gates", "integrated tree");
    const diff = await collectDiff(worktree);
    result.gates = await runGates({
      worktree,
      diff,
      config: harness,
      gates,
      onResult: (gate) =>
        runStore.emit("gate:result", {
          scope: "integration",
          gateId: gate.gateId,
          status: gate.status,
          durationMs: gate.durationMs,
          failureCount: gate.failures.length,
        }),
    });

    if (!result.gates.passed) {
      result.reason = `Integrated tree fails: ${result.gates.blockingFailures.map((f) => f.gateId).join(", ")}`;
      return result;
    }

    result.status = "passed";
    return result;
  } catch (error) {
    result.reason = error instanceof Error ? error.message : String(error);
    return result;
  } finally {
    if (combiner) {
      result.costUsd += (await combiner.stats()).costUsd ?? 0;
      await combiner.stop();
    }
    runStore.emit("integrate:end", {
      status: result.status,
      commit: result.commit,
      conflicted: result.conflictedUnits,
    });
  }
}

async function startCombiner(input: IntegrationInput, worktree: string): Promise<Worker> {
  const worker = new Worker({
    agentId: "combiner",
    worktree,
    role: input.loaded.harness.roles.combiner,
    runStore: input.runStore,
    ...(input.cliPath ? { cliPath: input.cliPath } : {}),
  });
  await worker.start();
  return worker;
}
