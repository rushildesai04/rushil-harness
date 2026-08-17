import type { GateRunSummary } from "@harness/core";
import { formatFailuresForRepair } from "@harness/gates";

/**
 * Prompts state the verification contract explicitly.
 *
 * The agent is told that the harness re-runs every gate itself. That removes any
 * payoff from claiming success, and it is why the rules below are phrased as
 * facts about the pipeline rather than as requests.
 */

const CONTRACT = `## Verification contract

The harness runs the quality gates itself after you stop. Your report of the
outcome does not advance anything — only the real exit codes do.

Rules enforced deterministically after your turn:
- Do not add \`.skip\`, \`.only\`, \`.todo\`, \`xit\`, or \`xdescribe\` to tests.
- Do not add \`@ts-ignore\`, \`@ts-expect-error\`, \`biome-ignore\`, or \`eslint-disable\`.
- Do not delete or weaken a test to make it pass. Fix the code under test.
- Do not commit credentials of any kind.
- Keep the change scoped to the task; unrelated refactors fail the diff-scope gate.

Run the gate commands yourself while you work — finding failures early is
cheaper than a repair round.`;

export function buildTaskPrompt(task: string): string {
  return `# Task

${task}

${CONTRACT}

Work in the current directory, which is an isolated git worktree. Do not run
git commit, git push, or any command that changes branch state.`;
}

export function buildRepairPrompt(summary: GateRunSummary, attempt: number, maxAttempts: number): string {
  return `# Quality gates failed (repair ${attempt} of ${maxAttempts})

These are the real exit codes and diagnostics from the harness, not a summary.

${formatFailuresForRepair(summary)}

Fix the root cause of each failure. The same gates will run again immediately
after you stop, and the rules in the verification contract still apply — a
suppression or a skipped test fails a different gate, it does not pass this one.`;
}

export function buildNoDiffPrompt(): string {
  return `You stopped without changing any files. The harness detected an empty diff.

If the task is already satisfied by the existing code, say so explicitly and
explain which code satisfies it. Otherwise, make the change now.`;
}
