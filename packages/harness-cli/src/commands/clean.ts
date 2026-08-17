import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "@harness/core";
import { pruneWorktrees } from "@harness/orchestrator";
import { dim, green } from "../ui.ts";

export interface CleanArgs {
  repoRoot: string;
}

/**
 * Recover from runs that were killed before they could clean up after
 * themselves. Run directories are left alone — they are the audit trail.
 */
export async function cleanCommand(args: CleanArgs): Promise<number> {
  const loaded = loadConfig(args.repoRoot);
  const root = resolve(args.repoRoot, loaded.harness.paths.worktrees);

  const removed = await pruneWorktrees(args.repoRoot, root);
  rmSync(root, { recursive: true, force: true });

  for (const worktree of removed) process.stderr.write(dim(`  removed ${worktree}\n`));
  process.stderr.write(`${green(`${removed.length} worktree(s) removed`)}\n`);
  process.stderr.write(dim(`run history under ${loaded.harness.paths.runs} was left intact\n`));
  return 0;
}
