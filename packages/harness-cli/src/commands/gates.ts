import { loadConfig } from "@harness/core";
import { runGates } from "@harness/gates";
import { collectDiff, unstage } from "@harness/orchestrator";
import { bold, dim, formatGateLine, formatGateSummary, green, red } from "../ui.ts";

export interface GatesArgs {
  repoRoot: string;
  worktree?: string;
}

/**
 * Run the gates against a working tree without involving an agent.
 *
 * This is how you develop and debug gates.yaml. If a gate misbehaves here it
 * will misbehave inside a run, and finding that out costs nothing.
 */
export async function gatesCommand(args: GatesArgs): Promise<number> {
  const loaded = loadConfig(args.repoRoot);
  const target = args.worktree ?? args.repoRoot;

  const diff = await collectDiff(target);
  await unstage(target);

  process.stderr.write(
    `${bold("gates")} ${target}\n` +
      dim(`${diff.changedFiles.length} changed files, +${diff.addedLines}/-${diff.removedLines}\n\n`),
  );

  const summary = await runGates({
    worktree: target,
    diff,
    config: loaded.harness,
    gates: loaded.gates,
    // A human editing their own tree is not an agent violating scope policy.
    includeAgentOnly: false,
    onResult: (result) => process.stderr.write(`${formatGateLine(result)}\n`),
  });

  if (summary.passed) {
    process.stderr.write(`\n${green("all gates passed")}\n`);
    return 0;
  }
  process.stderr.write(`\n${red("gates failed")}\n${formatGateSummary(summary)}\n`);
  return 1;
}
