import { resolve } from "node:path";
import {
  adversaryPrompt,
  implementPrompt,
  type Plan,
  type Response,
  ResponseSchema,
  type Review,
  ReviewSchema,
  recheckPrompt,
  repairPrompt,
  responsePrompt,
  runStructured,
  type UnresolvedFinding,
  type WorkUnit,
} from "@harness/agents";
import type { GateRunSummary, LoadedConfig, RunStore } from "@harness/core";
import { runGates } from "@harness/gates";
import {
  addWorktree,
  collectDiff,
  commitAll,
  diffRange,
  excludeHarnessOutput,
  removeWorktree,
} from "./git.ts";
import { Worker } from "./worker.ts";

export interface UnitContext {
  loaded: LoadedConfig;
  runStore: RunStore;
  baseCommit: string;
  plan: Plan;
  onPhase: (unitId: string, phase: string, detail?: string) => void;
  /** Test-only override of the pi entry point. */
  cliPath?: string;
}

export interface UnitResult {
  unitId: string;
  title: string;
  status: "passed" | "failed";
  /** Commit holding this unit's work, or null when it never reached a green state. */
  commit: string | null;
  gates: GateRunSummary | null;
  reviews: Review[];
  unresolved: UnresolvedFinding[];
  reason?: string;
  costUsd: number;
}

/**
 * Build one unit, then subject it to adversarial review until it survives or the
 * round budget runs out.
 *
 * The implementer session stays alive across the whole debate so it keeps the
 * context of its own change. Each review round gets a *fresh* adversary in a
 * *fresh* worktree cut from the unit's latest commit — a reviewer that carries
 * its previous conclusions forward stops looking, and one sharing the
 * implementer's tree could quietly perturb the thing it is judging.
 */
export async function runUnit(ctx: UnitContext, unit: WorkUnit): Promise<UnitResult> {
  const { loaded, runStore, baseCommit, plan } = ctx;
  const { repoRoot, harness } = loaded;
  const worktreeRoot = resolve(repoRoot, harness.paths.worktrees, runStore.runId);
  const implTree = resolve(worktreeRoot, unit.id, "impl");

  const result: UnitResult = {
    unitId: unit.id,
    title: unit.title,
    status: "failed",
    commit: null,
    gates: null,
    reviews: [],
    unresolved: [],
    costUsd: 0,
  };

  runStore.emit("unit:start", { unitId: unit.id, files: unit.files });
  await addWorktree(repoRoot, implTree, baseCommit);
  await excludeHarnessOutput(implTree);

  const implementer = new Worker({
    agentId: `impl-${unit.id}`,
    worktree: implTree,
    role: harness.roles.implementer,
    runStore,
    ...(ctx.cliPath ? { cliPath: ctx.cliPath } : {}),
  });

  try {
    await implementer.start();

    ctx.onPhase(unit.id, "implement");
    const build = await driveToGreen(ctx, unit, implementer, implTree, implementPrompt(unit, plan));
    result.gates = build.gates;
    if (!build.ok) {
      result.reason = build.reason;
      return result;
    }

    result.commit = await commitAll(implTree, `harness(${unit.id}): ${unit.title}`);
    if (!result.commit) {
      result.reason = "Implementer produced no changes.";
      return result;
    }

    for (let round = 1; round <= harness.pipeline.adversaryRounds; round++) {
      ctx.onPhase(unit.id, "review", `round ${round}`);
      const review = await runAdversary(ctx, unit, round, result.commit, result.reviews.at(-1));
      result.reviews.push(review);
      runStore.emit("unit:review", {
        unitId: unit.id,
        round,
        approved: review.approved,
        findings: review.findings.length,
      });

      if (review.approved || review.findings.length === 0) break;

      if (round === harness.pipeline.adversaryRounds) {
        result.unresolved = review.findings.map((finding) => ({ ...finding, unitId: unit.id, round }));
        break;
      }

      ctx.onPhase(unit.id, "respond", `round ${round}`);
      const response = await runStructured<Response>({
        worker: implementer,
        worktree: implTree,
        outputFile: `response-${round}.json`,
        schema: ResponseSchema,
        prompt: responsePrompt(review.findings, round),
        timeoutMs: harness.roles.implementer.timeoutMs,
        retries: harness.pipeline.structuredRetries,
      });
      runStore.emit("unit:response", {
        unitId: unit.id,
        round,
        fixed: response.rebuttals.filter((r) => r.action === "fixed").length,
        disputed: response.rebuttals.filter((r) => r.action === "disputed").length,
      });

      // Fixes are code changes like any other and must clear the gates again.
      const repair = await driveToGreen(ctx, unit, implementer, implTree, null);
      result.gates = repair.gates;
      if (!repair.ok) {
        result.reason = `Gates failed after review round ${round}: ${repair.reason}`;
        return result;
      }

      const updated = await commitAll(implTree, `harness(${unit.id}): address review round ${round}`);
      if (updated) result.commit = updated;
    }

    result.status = "passed";
    return result;
  } catch (error) {
    result.reason = error instanceof Error ? error.message : String(error);
    runStore.emit("unit:error", { unitId: unit.id, message: result.reason });
    return result;
  } finally {
    const stats = await implementer.stats();
    result.costUsd += stats.costUsd ?? 0;
    await implementer.stop();
    runStore.emit("unit:end", {
      unitId: unit.id,
      status: result.status,
      commit: result.commit,
      unresolved: result.unresolved.length,
    });
  }
}

interface DriveResult {
  ok: boolean;
  gates: GateRunSummary | null;
  reason?: string;
}

/**
 * Prompt (optionally), then loop gates-and-repair until green or out of attempts.
 *
 * Passing `null` for the prompt skips the initial turn: the agent has already
 * made changes in response to review and we only need to verify them.
 */
async function driveToGreen(
  ctx: UnitContext,
  unit: WorkUnit,
  worker: Worker,
  worktree: string,
  initialPrompt: string | null,
): Promise<DriveResult> {
  const { harness, gates } = ctx.loaded;
  const maxAttempts = harness.builder.maxRepairAttempts + 1;
  let prompt = initialPrompt;
  let summary: GateRunSummary | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (prompt !== null) {
      const outcome = await worker.send(prompt, harness.roles.implementer.timeoutMs);
      if (outcome.timedOut) {
        return { ok: false, gates: summary, reason: `Agent timed out on attempt ${attempt}.` };
      }
    }

    const diff = await collectDiff(worktree);
    if (diff.changedFiles.length === 0) {
      return { ok: false, gates: summary, reason: "No changes produced." };
    }

    summary = await runGates({
      worktree,
      diff,
      config: harness,
      gates,
      onResult: (gate) =>
        ctx.runStore.emit("gate:result", {
          unitId: unit.id,
          attempt,
          gateId: gate.gateId,
          status: gate.status,
          durationMs: gate.durationMs,
          failureCount: gate.failures.length,
        }),
    });

    if (summary.passed) return { ok: true, gates: summary };

    if (attempt >= maxAttempts) {
      const failed = summary.blockingFailures.map((f) => f.gateId).join(", ");
      return { ok: false, gates: summary, reason: `gates still failing: ${failed}` };
    }

    ctx.onPhase(unit.id, "repair", `attempt ${attempt}`);
    prompt = repairPrompt(summary, attempt, harness.builder.maxRepairAttempts);
  }

  return { ok: false, gates: summary, reason: "repair budget exhausted" };
}

/** Run one adversary in a disposable worktree cut from the unit's commit. */
async function runAdversary(
  ctx: UnitContext,
  unit: WorkUnit,
  round: number,
  commit: string,
  previous: Review | undefined,
): Promise<Review> {
  const { loaded, runStore, baseCommit, plan } = ctx;
  const { repoRoot, harness } = loaded;
  const tree = resolve(repoRoot, harness.paths.worktrees, runStore.runId, unit.id, `adversary-${round}`);

  await addWorktree(repoRoot, tree, commit);
  await excludeHarnessOutput(tree);

  const adversary = new Worker({
    agentId: `adv-${unit.id}-${round}`,
    worktree: tree,
    role: harness.roles.adversary,
    runStore,
    ...(ctx.cliPath ? { cliPath: ctx.cliPath } : {}),
  });

  try {
    await adversary.start();
    const patch = await diffRange(repoRoot, baseCommit, commit);
    const base = adversaryPrompt(unit, plan, patch, round);
    // A later round is a re-review: the adversary must judge whether its own
    // prior findings are genuinely resolved, not re-derive them from scratch.
    const prompt = previous ? `${base}\n\n${recheckPrompt(previous, round)}` : base;

    return await runStructured<Review>({
      worker: adversary,
      worktree: tree,
      outputFile: "review.json",
      schema: ReviewSchema,
      prompt,
      timeoutMs: harness.roles.adversary.timeoutMs,
      retries: harness.pipeline.structuredRetries,
    });
  } finally {
    await adversary.stop();
    // The adversary's tree is disposable by design; nothing it wrote survives.
    await removeWorktree(repoRoot, tree);
  }
}
