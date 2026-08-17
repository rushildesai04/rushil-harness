import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";
import { addWorktree, commitAll, hasRemote, mergeCommit, pushBranch, resolveCommit } from "../src/git.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout;
}

let origin: string;
let repo: string;
let base: string;

/**
 * The publish step pushes from an *integration worktree*, not from the main
 * checkout, and a linked worktree's remote configuration is inherited rather
 * than its own. That inheritance is the part worth proving, so these run
 * against a real bare remote on disk.
 */
beforeEach(async () => {
  origin = mkdtempSync(join(tmpdir(), "harness-origin-"));
  await execFileAsync("git", ["init", "--bare", "-b", "main", origin]);

  repo = mkdtempSync(join(tmpdir(), "harness-repo-"));
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "test@local"]);
  await git(repo, ["config", "user.name", "test"]);
  await git(repo, ["remote", "add", "origin", origin]);
  writeFileSync(join(repo, "seed.txt"), "seed\n", "utf8");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "base"]);
  await git(repo, ["push", "-u", "origin", "main"]);
  base = await resolveCommit(repo, "HEAD");
});

describe("hasRemote", () => {
  it("detects a configured origin", async () => {
    expect(await hasRemote(repo)).toBe(true);
  });

  it("reports absence rather than throwing", async () => {
    const bare = mkdtempSync(join(tmpdir(), "harness-noremote-"));
    await git(bare, ["init", "-b", "main"]);
    expect(await hasRemote(bare)).toBe(false);
  });
});

describe("pushBranch", () => {
  it("publishes integrated work from a worktree to origin", async () => {
    const unit = join(repo, "wt", "unit");
    await addWorktree(repo, unit, base);
    writeFileSync(join(unit, "feature.ts"), "export const feature = true;\n", "utf8");
    const unitCommit = (await commitAll(unit, "unit work")) as string;

    const integration = join(repo, "wt", "integration");
    await addWorktree(repo, integration, base);
    expect((await mergeCommit(integration, unitCommit)).ok).toBe(true);
    const merged = (await commitAll(integration, "integrate unit")) as string;

    await pushBranch(integration, "harness/test-run");

    // The branch and its content must exist on the remote, not just locally.
    const remoteRefs = await git(origin, ["for-each-ref", "--format=%(refname:short) %(objectname)"]);
    expect(remoteRefs).toContain("harness/test-run");
    expect(remoteRefs).toContain(merged);

    const files = await git(origin, ["ls-tree", "-r", "--name-only", "harness/test-run"]);
    expect(files).toContain("feature.ts");

    // main is untouched — the PR is what proposes the change, not the push.
    expect((await git(origin, ["rev-parse", "main"])).trim()).toBe(base);
  });

  it("is idempotent when a run is retried under the same branch name", async () => {
    const integration = join(repo, "wt", "again");
    await addWorktree(repo, integration, base);
    writeFileSync(join(integration, "a.txt"), "one\n", "utf8");
    await commitAll(integration, "first");
    await pushBranch(integration, "harness/retry");

    writeFileSync(join(integration, "a.txt"), "two\n", "utf8");
    const second = (await commitAll(integration, "second")) as string;
    await pushBranch(integration, "harness/retry");

    expect((await git(origin, ["rev-parse", "harness/retry"])).trim()).toBe(second);
  });
});
