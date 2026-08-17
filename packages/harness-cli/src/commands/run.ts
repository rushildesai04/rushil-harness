import { loadConfig } from "@harness/core";
import { runBuildTask } from "@harness/orchestrator";
import { bold, dim, formatGateLine, formatGateSummary, green, red } from "../ui.ts";

export interface RunArgs {
  task: string;
  base?: string;
  keep: boolean;
  quiet: boolean;
  repoRoot: string;
}

export async function runCommand(args: RunArgs): Promise<number> {
  const loaded = loadConfig(args.repoRoot);

  process.stderr.write(`${bold("task")}  ${args.task}\n`);
  process.stderr.write(dim(`base  ${args.base ?? "HEAD"}\n`));

  const result = await runBuildTask({
    loaded,
    task: args.task,
    ...(args.base ? { baseRef: args.base } : {}),
    cleanup: args.keep ? "never" : "on-success",
    ...(args.quiet ? {} : { onText: (delta) => process.stderr.write(dim(delta)) }),
    onGate: (gate) => process.stderr.write(`${formatGateLine(gate)}\n`),
    onPhase: (phase, detail) =>
      process.stderr.write(`\n${bold(`[${phase}]`)}${detail ? ` ${detail}` : ""}\n`),
  });

  process.stderr.write("\n");

  if (result.record.status === "passed") {
    const diff = result.diff;
    process.stderr.write(
      `${green("PASSED")} ${result.attempts} attempt(s), ` +
        `${diff?.changedFiles.length ?? 0} files, ` +
        `+${diff?.addedLines ?? 0}/-${diff?.removedLines ?? 0}\n`,
    );
  } else {
    process.stderr.write(`${red("FAILED")} ${result.reason ?? "gates did not pass"}\n`);
    if (result.gates) process.stderr.write(`${formatGateSummary(result.gates)}\n`);
    process.stderr.write(dim(`\nworktree kept at ${result.worktree}\n`));
  }

  process.stderr.write(dim(`run    ${result.runDir}\n`));
  if (result.record.costUsd !== undefined) {
    process.stderr.write(dim(`cost   $${result.record.costUsd.toFixed(4)}\n`));
  }

  // stdout carries the patch so the command composes with `git apply`.
  if (result.diff && result.diff.patch.length > 0) process.stdout.write(result.diff.patch);

  return result.record.status === "passed" ? 0 : 1;
}
