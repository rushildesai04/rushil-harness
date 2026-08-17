import { resolve } from "node:path";
import {
  assertDisjointUnits,
  designPrompt,
  orderUnits,
  type Plan,
  PlanSchema,
  runStructured,
  type UnresolvedFinding,
  type WorkUnit,
} from "@harness/agents";
import { type LoadedConfig, RunStore } from "@harness/core";
import { checkModelAvailability, missingModelIds } from "@harness/pi-adapter";
import {
  addWorktree,
  assertCleanRepo,
  excludeHarnessOutput,
  hasRemote,
  pushBranch,
  removeWorktree,
  resolveCommit,
} from "./git.ts";
import { type IntegrationResult, integrate } from "./integrate.ts";
import { mapWithConcurrency } from "./pool.ts";
import { buildPrBody, ghAvailable, openPullRequest } from "./pr.ts";
import { runUnit, type UnitResult } from "./unit.ts";
import { Worker } from "./worker.ts";

export interface PipelineOptions {
  loaded: LoadedConfig;
  task: string;
  baseRef?: string;
  /** Push the integration branch and open a pull request. */
  openPr: boolean;
  onPhase?: (phase: string, detail?: string) => void;
  onText?: (delta: string) => void;
  /** Test-only override of the pi entry point, threaded to every role. */
  cliPath?: string;
}

export interface PipelineResult {
  runId: string;
  runDir: string;
  status: "passed" | "failed";
  plan: Plan | null;
  units: UnitResult[];
  integration: IntegrationResult | null;
  unresolved: UnresolvedFinding[];
  branch: string | null;
  prUrl: string | null;
  costUsd: number;
  reason?: string;
}

class BudgetExceeded extends Error {}

/**
 * Design, fan out, adversarially review, integrate, open a PR.
 *
 * Phases are separated by hard checkpoints — a wave that fails stops the
 * pipeline before the next one spends anything, and the cost ceiling is checked
 * between phases rather than mid-turn so a run always ends at a coherent
 * boundary with its artifacts intact.
 */
export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const { loaded, task } = options;
  const { repoRoot, harness } = loaded;
  const baseRef = options.baseRef ?? "HEAD";
  const onPhase = options.onPhase ?? (() => undefined);

  await assertCleanRepo(repoRoot);
  await preflight(loaded, onPhase);
  const baseCommit = await resolveCommit(repoRoot, baseRef);

  const runId = RunStore.newRunId();
  const runStore = RunStore.create(resolve(repoRoot, harness.paths.runs), runId, {
    task,
    baseRef,
    baseCommit,
    worktree: resolve(repoRoot, harness.paths.worktrees, runId),
    status: "running",
    attempts: 0,
    startedAt: Date.now(),
  });

  const result: PipelineResult = {
    runId,
    runDir: runStore.dir,
    status: "failed",
    plan: null,
    units: [],
    integration: null,
    unresolved: [],
    branch: null,
    prUrl: null,
    costUsd: 0,
  };

  const checkBudget = (phase: string): void => {
    const ceiling = harness.pipeline.maxCostUsd;
    if (ceiling > 0 && result.costUsd > ceiling) {
      throw new BudgetExceeded(
        `Cost ceiling of $${ceiling.toFixed(2)} exceeded before ${phase} ($${result.costUsd.toFixed(2)} spent).`,
      );
    }
  };

  runStore.emit("pipeline:start", {
    task,
    baseCommit,
    roles: {
      designer: harness.roles.designer.model.id,
      implementer: harness.roles.implementer.model.id,
      adversary: harness.roles.adversary.model.id,
      combiner: harness.roles.combiner.model.id,
    },
  });

  try {
    onPhase("design");
    const design = await runDesign(options, runStore, baseCommit);
    result.plan = design.plan;
    result.costUsd += design.costUsd;
    runStore.writeArtifact("plan.json", `${JSON.stringify(design.plan, null, 2)}\n`);
    runStore.emit("pipeline:plan", {
      units: design.plan.units.map((u) => ({ id: u.id, files: u.files, dependsOn: u.dependsOn })),
    });

    if (design.plan.units.length > harness.pipeline.maxUnits) {
      result.reason = `Designer produced ${design.plan.units.length} units, ceiling is ${harness.pipeline.maxUnits}.`;
      return finish(runStore, result);
    }
    assertDisjointUnits(design.plan.units);
    const waves = orderUnits(design.plan.units);

    const merges: Array<{ unit: WorkUnit; commit: string }> = [];
    for (const [index, wave] of waves.entries()) {
      checkBudget(`wave ${index + 1}`);
      onPhase("build", `wave ${index + 1} of ${waves.length} (${wave.length} units)`);

      const waveResults = await mapWithConcurrency(wave, harness.pipeline.concurrency, (unit) =>
        runUnit(
          {
            loaded,
            runStore,
            baseCommit,
            plan: design.plan,
            ...(options.cliPath ? { cliPath: options.cliPath } : {}),
            onPhase: (unitId, phase, detail) => onPhase(`${unitId}:${phase}`, detail),
          },
          unit,
        ),
      );

      result.units.push(...waveResults);
      for (const unitResult of waveResults) {
        result.costUsd += unitResult.costUsd;
        result.unresolved.push(...unitResult.unresolved);
        if (unitResult.status === "passed" && unitResult.commit) {
          const unit = wave.find((candidate) => candidate.id === unitResult.unitId);
          if (unit) merges.push({ unit, commit: unitResult.commit });
        }
      }

      const failed = waveResults.filter((unitResult) => unitResult.status === "failed");
      if (failed.length > 0) {
        result.reason = `${failed.length} unit(s) failed: ${failed
          .map((unitResult) => `${unitResult.unitId} (${unitResult.reason ?? "unknown"})`)
          .join("; ")}`;
        return finish(runStore, result);
      }
    }

    const blocking = result.unresolved.filter(
      (finding) => severityRank(finding.severity) >= severityRank(harness.pipeline.blockingSeverity),
    );
    if (blocking.length > 0) {
      result.reason = `${blocking.length} unresolved finding(s) at or above ${harness.pipeline.blockingSeverity} severity.`;
      return finish(runStore, result);
    }

    checkBudget("integration");
    onPhase("integrate");
    const integration = await integrate({
      loaded,
      runStore,
      baseCommit,
      merges,
      ...(options.cliPath ? { cliPath: options.cliPath } : {}),
      onPhase: (phase, detail) => onPhase(`integrate:${phase}`, detail),
    });
    result.integration = integration;
    result.costUsd += integration.costUsd;

    if (integration.status !== "passed" || !integration.commit) {
      result.reason = integration.reason ?? "Integration failed.";
      return finish(runStore, result);
    }

    result.status = "passed";

    if (options.openPr) {
      const pr = await publish(options, runStore, result, integration);
      result.branch = pr.branch;
      result.prUrl = pr.url;
      if (pr.reason) result.reason = pr.reason;
    }

    return finish(runStore, result);
  } catch (error) {
    result.reason = error instanceof Error ? error.message : String(error);
    runStore.emit("pipeline:error", { message: result.reason });
    return finish(runStore, result);
  }
}

/**
 * Fail before creating a worktree if the credentials cannot reach a model.
 *
 * The alternative is discovering it when the first agent never answers, which
 * costs a full turn timeout per role and leaves half-built state behind.
 */
async function preflight(
  loaded: LoadedConfig,
  onPhase: (phase: string, detail?: string) => void,
): Promise<void> {
  onPhase("preflight");
  const availability = await checkModelAvailability();
  if (!availability.available) {
    throw new Error(availability.message ?? "No models available to the configured credentials.");
  }

  const { roles } = loaded.harness;
  const missing = missingModelIds(availability, [
    roles.designer.model.id ?? "",
    roles.implementer.model.id ?? "",
    roles.adversary.model.id ?? "",
    roles.combiner.model.id ?? "",
  ]);
  if (missing.length > 0) {
    onPhase("preflight", `warning: not listed by pi — ${missing.join(", ")}`);
  }
}

function severityRank(severity: "low" | "medium" | "high"): number {
  return severity === "high" ? 3 : severity === "medium" ? 2 : 1;
}

function finish(runStore: RunStore, result: PipelineResult): PipelineResult {
  runStore.update({
    status: result.status,
    attempts: result.units.length,
    endedAt: Date.now(),
    costUsd: result.costUsd,
  });
  runStore.emit("pipeline:end", {
    status: result.status,
    reason: result.reason,
    units: result.units.length,
    unresolved: result.unresolved.length,
    prUrl: result.prUrl,
  });
  runStore.writeArtifact("result.json", `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

/**
 * The designer works in a throwaway worktree with read-only tools.
 *
 * Read-only is structural, not advisory: a planner that can edit starts
 * implementing, and the units it then writes describe work it has already
 * half-done in a tree nothing downstream will ever see.
 */
async function runDesign(
  options: PipelineOptions,
  runStore: RunStore,
  baseCommit: string,
): Promise<{ plan: Plan; costUsd: number }> {
  const { loaded } = options;
  const { repoRoot, harness } = loaded;
  const tree = resolve(repoRoot, harness.paths.worktrees, runStore.runId, "design");

  await addWorktree(repoRoot, tree, baseCommit);
  await excludeHarnessOutput(tree);

  // The designer needs `write` for its plan artifact and nothing else; the role
  // tool list stays read-only, so grant exactly that one addition here.
  const designer = new Worker({
    agentId: "designer",
    worktree: tree,
    role: { ...harness.roles.designer, tools: [...harness.roles.designer.tools, "write"] },
    runStore,
    ...(options.cliPath ? { cliPath: options.cliPath } : {}),
    ...(options.onText ? { onText: options.onText } : {}),
  });

  try {
    await designer.start();
    const plan = await runStructured<Plan>({
      worker: designer,
      worktree: tree,
      outputFile: "plan.json",
      schema: PlanSchema,
      prompt: designPrompt(options.task, harness.pipeline.maxUnits),
      timeoutMs: harness.roles.designer.timeoutMs,
      retries: harness.pipeline.structuredRetries,
      onAttempt: (attempt, problem) => {
        if (problem) runStore.emit("design:retry", { attempt, problem });
      },
    });
    const costUsd = (await designer.stats()).costUsd ?? 0;
    return { plan, costUsd };
  } finally {
    await designer.stop();
    await removeWorktree(repoRoot, tree);
  }
}

async function publish(
  options: PipelineOptions,
  runStore: RunStore,
  result: PipelineResult,
  integration: IntegrationResult,
): Promise<{ branch: string | null; url: string | null; reason?: string }> {
  const { harness, repoRoot } = options.loaded;
  const branch = `${harness.pullRequest.branchPrefix}${result.runId}`;

  if (!(await hasRemote(repoRoot))) {
    return { branch: null, url: null, reason: "No `origin` remote; skipped publishing." };
  }
  if (!(await ghAvailable())) {
    return { branch: null, url: null, reason: "`gh` is not authenticated; skipped opening the PR." };
  }

  options.onPhase?.("publish", branch);
  await pushBranch(integration.worktree, branch);
  runStore.emit("pipeline:pushed", { branch });

  const title = `${result.plan?.units.length ?? 0} unit(s): ${truncate(options.task, 60)}`;
  const body = buildPrBody({
    task: options.task,
    runId: result.runId,
    plan: result.plan as Plan,
    units: result.units,
    integrationGates: integration.gates,
    unresolved: result.unresolved,
    conflictedUnits: integration.conflictedUnits,
    costUsd: result.costUsd,
  });
  runStore.writeArtifact("pr-body.md", body);

  const url = await openPullRequest({
    worktree: integration.worktree,
    branch,
    baseBranch: harness.pullRequest.baseBranch,
    draft: harness.pullRequest.draft,
    title,
    body,
  });
  runStore.emit("pipeline:pr", { url });
  return { branch, url };
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}
