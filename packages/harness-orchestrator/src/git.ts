import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DiffStat } from "@harness/core";

const execFileAsync = promisify(execFile);

const MAX_PATCH_BYTES = 1024 * 1024;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    encoding: "utf8",
  });
  return stdout;
}

export async function resolveCommit(repoRoot: string, ref: string): Promise<string> {
  const out = await git(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`]);
  return out.trim();
}

export async function currentBranch(repoRoot: string): Promise<string> {
  const out = await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return out.trim();
}

export async function assertCleanRepo(repoRoot: string): Promise<void> {
  const out = await git(repoRoot, ["status", "--porcelain"]);
  if (out.trim().length > 0) {
    throw new Error(
      "Working tree is dirty. Commit or stash before running — the worktree base must be a real commit.",
    );
  }
}

/**
 * Create a detached worktree at `commit`.
 *
 * Detached is deliberate: the agent must not be able to move a branch pointer,
 * and multiple concurrent workers off the same base would otherwise collide on
 * branch names.
 */
export async function addWorktree(repoRoot: string, path: string, commit: string): Promise<void> {
  await git(repoRoot, ["worktree", "add", "--detach", path, commit]);
}

export async function removeWorktree(repoRoot: string, path: string): Promise<void> {
  try {
    await git(repoRoot, ["worktree", "remove", "--force", path]);
  } catch {
    // Leave the directory for forensics; prune keeps git's metadata consistent.
    await git(repoRoot, ["worktree", "prune"]).catch(() => undefined);
  }
}

/**
 * Snapshot everything the agent changed, including untracked files.
 *
 * Staging with `add -A` then diffing `--cached` is what makes new files visible;
 * a plain `git diff` would silently miss every file the agent created.
 */
export async function collectDiff(worktree: string): Promise<DiffStat> {
  await git(worktree, ["add", "-A"]);

  const nameOnly = await git(worktree, ["diff", "--cached", "--name-only"]);
  const changedFiles = nameOnly
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let addedLines = 0;
  let removedLines = 0;
  const numstat = await git(worktree, ["diff", "--cached", "--numstat"]);
  for (const line of numstat.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    // Binary files report "-" for both counts.
    addedLines += Number(parts[0]) || 0;
    removedLines += Number(parts[1]) || 0;
  }

  let patch = await git(worktree, ["diff", "--cached", "--no-color", "-U3"]);
  if (Buffer.byteLength(patch, "utf8") > MAX_PATCH_BYTES) {
    patch = `${patch.slice(0, MAX_PATCH_BYTES)}\n... patch truncated at ${MAX_PATCH_BYTES} bytes ...\n`;
  }

  return { changedFiles, addedLines, removedLines, patch };
}

/** Undo staging so the worktree is inspectable as the agent left it. */
export async function unstage(worktree: string): Promise<void> {
  await git(worktree, ["reset"]).catch(() => undefined);
}
