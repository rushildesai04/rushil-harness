import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addWorktree,
  collectDiff,
  commitAll,
  conflictedFiles,
  excludeHarnessOutput,
  HARNESS_OUT_DIR,
  mergeCommit,
  resolveCommit,
  verifyResolved,
} from "../src/git.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout;
}

let repo: string;
let base: string;

/**
 * These run against a real repository rather than a mock. The integration phase
 * is entirely git semantics — detached worktrees, three-way merges, conflict
 * detection — and a mock would only assert that the mock behaves as written.
 */
beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "harness-git-"));
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "test@local"]);
  await git(repo, ["config", "user.name", "test"]);
  writeFileSync(join(repo, "shared.txt"), "line one\nline two\nline three\n", "utf8");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n", "utf8");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "base"]);
  base = await resolveCommit(repo, "HEAD");
});

describe("worktree isolation", () => {
  it("gives each unit an independent checkout at the same base", async () => {
    const a = join(repo, "wt", "a");
    const b = join(repo, "wt", "b");
    await addWorktree(repo, a, base);
    await addWorktree(repo, b, base);

    writeFileSync(join(a, "a.txt"), "from a\n", "utf8");
    expect(readFileSync(join(b, "shared.txt"), "utf8")).toContain("line one");
    // Work in one worktree is invisible in the other.
    await expect(async () => readFileSync(join(b, "a.txt"), "utf8")).rejects.toThrow();
  });

  it("keeps .harness-out out of the diff the gates inspect", async () => {
    const tree = join(repo, "wt", "excluded");
    await addWorktree(repo, tree, base);
    await excludeHarnessOutput(tree);

    writeFileSync(join(tree, HARNESS_OUT_DIR, "plan.json"), "{}", "utf8");
    writeFileSync(join(tree, "real.ts"), "export const x = 1;\n", "utf8");

    const diff = await collectDiff(tree);
    expect(diff.changedFiles).toEqual(["real.ts"]);
  });
});

describe("commitAll", () => {
  it("returns null when the agent changed nothing", async () => {
    const tree = join(repo, "wt", "empty");
    await addWorktree(repo, tree, base);
    expect(await commitAll(tree, "nothing")).toBeNull();
  });

  it("commits without moving any branch pointer", async () => {
    const tree = join(repo, "wt", "detached");
    await addWorktree(repo, tree, base);
    writeFileSync(join(tree, "new.txt"), "hi\n", "utf8");

    const commit = await commitAll(tree, "unit work");
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    // main still points at base — the harness owns branch creation, not agents.
    expect(await resolveCommit(repo, "main")).toBe(base);
  });
});

describe("integration merges", () => {
  it("combines disjoint units cleanly", async () => {
    const a = join(repo, "wt", "ma");
    const b = join(repo, "wt", "mb");
    await addWorktree(repo, a, base);
    await addWorktree(repo, b, base);
    writeFileSync(join(a, "a.txt"), "from a\n", "utf8");
    writeFileSync(join(b, "b.txt"), "from b\n", "utf8");
    const commitA = (await commitAll(a, "unit a")) as string;
    const commitB = (await commitAll(b, "unit b")) as string;

    const integration = join(repo, "wt", "integration");
    await addWorktree(repo, integration, base);

    expect((await mergeCommit(integration, commitA)).ok).toBe(true);
    await commitAll(integration, "integrate a");
    expect((await mergeCommit(integration, commitB)).ok).toBe(true);
    await commitAll(integration, "integrate b");

    expect(readFileSync(join(integration, "a.txt"), "utf8")).toBe("from a\n");
    expect(readFileSync(join(integration, "b.txt"), "utf8")).toBe("from b\n");
  });

  it("reports the conflicted files when two units touch the same lines", async () => {
    const a = join(repo, "wt", "ca");
    const b = join(repo, "wt", "cb");
    await addWorktree(repo, a, base);
    await addWorktree(repo, b, base);
    writeFileSync(join(a, "shared.txt"), "line one\nCHANGED BY A\nline three\n", "utf8");
    writeFileSync(join(b, "shared.txt"), "line one\nCHANGED BY B\nline three\n", "utf8");
    const commitA = (await commitAll(a, "unit a")) as string;
    const commitB = (await commitAll(b, "unit b")) as string;

    const integration = join(repo, "wt", "cint");
    await addWorktree(repo, integration, base);
    expect((await mergeCommit(integration, commitA)).ok).toBe(true);
    await commitAll(integration, "integrate a");

    const outcome = await mergeCommit(integration, commitB);
    expect(outcome.ok).toBe(false);
    expect(outcome.conflicts).toEqual(["shared.txt"]);
    // The tree stays mid-merge so the combiner agent can resolve in place.
    expect(await conflictedFiles(integration)).toEqual(["shared.txt"]);
  });

  it("clears the conflict state once markers are resolved", async () => {
    const a = join(repo, "wt", "ra");
    const b = join(repo, "wt", "rb");
    await addWorktree(repo, a, base);
    await addWorktree(repo, b, base);
    writeFileSync(join(a, "shared.txt"), "line one\nA\nline three\n", "utf8");
    writeFileSync(join(b, "shared.txt"), "line one\nB\nline three\n", "utf8");
    const commitA = (await commitAll(a, "a")) as string;
    const commitB = (await commitAll(b, "b")) as string;

    const integration = join(repo, "wt", "rint");
    await addWorktree(repo, integration, base);
    await mergeCommit(integration, commitA);
    await commitAll(integration, "integrate a");
    await mergeCommit(integration, commitB);

    writeFileSync(join(integration, "shared.txt"), "line one\nA\nB\nline three\n", "utf8");
    expect(await verifyResolved(integration)).toEqual([]);

    const merged = await commitAll(integration, "integrate b");
    expect(merged).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(join(integration, "shared.txt"), "utf8")).toBe("line one\nA\nB\nline three\n");
  });

  it("rejects a resolution that staged surviving conflict markers", async () => {
    const a = join(repo, "wt", "ma2");
    const b = join(repo, "wt", "mb2");
    await addWorktree(repo, a, base);
    await addWorktree(repo, b, base);
    writeFileSync(join(a, "shared.txt"), "line one\nA\nline three\n", "utf8");
    writeFileSync(join(b, "shared.txt"), "line one\nB\nline three\n", "utf8");
    const commitA = (await commitAll(a, "a")) as string;
    const commitB = (await commitAll(b, "b")) as string;

    const integration = join(repo, "wt", "mint2");
    await addWorktree(repo, integration, base);
    await mergeCommit(integration, commitA);
    await commitAll(integration, "integrate a");
    await mergeCommit(integration, commitB);

    // git accepts this silently; nothing downstream necessarily catches it.
    writeFileSync(
      join(integration, "shared.txt"),
      "line one\n<<<<<<< HEAD\nA\n=======\nB\n>>>>>>> other\nline three\n",
      "utf8",
    );
    expect(await verifyResolved(integration)).toEqual(["shared.txt"]);
  });
});
