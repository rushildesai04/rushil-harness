import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
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

/**
 * Keep harness scratch output invisible to `git add -A`.
 *
 * Agents write structured output (plans, findings) into `.harness-out/` inside
 * their worktree. Without this it lands in the diff, and every scope and size
 * check then flags files the agent was explicitly told to produce.
 *
 * A self-ignoring `.gitignore` inside the directory is used rather than
 * `info/exclude`: git reads excludes from the *common* git dir, so the
 * exclude-file approach would write into the user's real repository and leak
 * across every worktree.
 */
export async function excludeHarnessOutput(worktree: string): Promise<void> {
  const dir = join(worktree, HARNESS_OUT_DIR);
  await mkdir(dir, { recursive: true });
  // `*` matches this file too, so the directory disappears from git entirely.
  writeFileSync(join(dir, ".gitignore"), "*\n", "utf8");
}

export const HARNESS_OUT_DIR = ".harness-out";

/** Identity used for harness-authored commits, independent of global git config. */
const IDENTITY = ["-c", "user.name=harness", "-c", "user.email=harness@local"];

/**
 * Commit everything in a detached worktree and return the new commit sha.
 *
 * Detached HEAD is what makes this safe: the commit exists as an object that
 * later phases can merge, and no branch pointer moves in the user's repo.
 */
export async function commitAll(worktree: string, message: string): Promise<string | null> {
  await git(worktree, ["add", "-A"]);
  const staged = (await git(worktree, ["diff", "--cached", "--name-only"])).trim();
  if (staged.length === 0) return null;
  await git(worktree, [...IDENTITY, "commit", "--no-verify", "-m", message]);
  return (await git(worktree, ["rev-parse", "HEAD"])).trim();
}

export interface MergeOutcome {
  ok: boolean;
  conflicts: string[];
}

/**
 * Merge a unit commit into an integration worktree without committing.
 *
 * Units all branch from the same base, so this is a real three-way merge and
 * conflicts are genuine overlaps rather than artefacts of ordering.
 */
export async function mergeCommit(worktree: string, commit: string): Promise<MergeOutcome> {
  try {
    await git(worktree, [...IDENTITY, "merge", "--no-ff", "--no-commit", commit]);
    return { ok: true, conflicts: [] };
  } catch {
    const out = await git(worktree, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "");
    const conflicts = out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return { ok: false, conflicts };
  }
}

export async function abortMerge(worktree: string): Promise<void> {
  await git(worktree, ["merge", "--abort"]).catch(() => undefined);
}

/** Paths git currently reports as unmerged. Valid only mid-merge, before staging. */
export async function conflictedFiles(worktree: string): Promise<string[]> {
  const out = await git(worktree, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "");
  return lines(out);
}

/**
 * Stage the resolution and report anything still broken.
 *
 * Two distinct failures are checked. Unmerged index entries mean the resolver
 * never touched a conflicted path. Surviving conflict markers mean it staged one
 * that still contains `<<<<<<<`, which git accepts silently and which no
 * compiler or test necessarily catches — inside a comment or a template string
 * it is perfectly valid code.
 */
export async function verifyResolved(worktree: string): Promise<string[]> {
  await git(worktree, ["add", "-A"]).catch(() => undefined);

  const unmerged = lines(
    await git(worktree, ["diff", "--cached", "--name-only", "--diff-filter=U"]).catch(() => ""),
  );
  // `git grep` exits non-zero when nothing matches, which is the common case.
  const marked = lines(
    await git(worktree, ["grep", "--cached", "-l", "-E", "^(<<<<<<<|>>>>>>>) "]).catch(() => ""),
  );

  return [...new Set([...unmerged, ...marked])];
}

function lines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Create a branch at the worktree's current HEAD and push it to origin. */
export async function pushBranch(worktree: string, branch: string): Promise<void> {
  await git(worktree, ["branch", "-f", branch, "HEAD"]);
  await git(worktree, ["push", "--set-upstream", "origin", `${branch}:${branch}`]);
}

export async function hasRemote(repoRoot: string, name = "origin"): Promise<boolean> {
  const out = await git(repoRoot, ["remote"]).catch(() => "");
  return out.split("\n").some((line) => line.trim() === name);
}

/** Unified patch between two commits, truncated to keep prompts bounded. */
export async function diffRange(repoRoot: string, from: string, to: string): Promise<string> {
  const patch = await git(repoRoot, ["diff", "--no-color", "-U3", `${from}..${to}`]);
  if (Buffer.byteLength(patch, "utf8") <= MAX_PATCH_BYTES) return patch;
  return `${patch.slice(0, MAX_PATCH_BYTES)}\n... patch truncated at ${MAX_PATCH_BYTES} bytes ...\n`;
}

/**
 * Remove harness worktrees left behind by a killed run.
 *
 * A run that is SIGKILLed never reaches its own cleanup, so git keeps
 * administrative entries pointing at directories that may no longer exist.
 * Recovery has to be a separate command rather than a finally block.
 */
export async function listWorktrees(repoRoot: string): Promise<string[]> {
  const out = await git(repoRoot, ["worktree", "list", "--porcelain"]).catch(() => "");
  return out
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter(Boolean);
}

export async function pruneWorktrees(repoRoot: string, under: string): Promise<string[]> {
  const removed: string[] = [];
  for (const worktree of await listWorktrees(repoRoot)) {
    if (!worktree.startsWith(under)) continue;
    await removeWorktree(repoRoot, worktree);
    removed.push(worktree);
  }
  await git(repoRoot, ["worktree", "prune"]).catch(() => undefined);
  return removed;
}
