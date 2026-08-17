import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HARNESS_OUT_DIR, runStructured, StructuredOutputError } from "../src/structured.ts";

const Schema = z.object({ name: z.string().min(1), count: z.number().int() });

/** Stands in for an agent: each turn writes whatever the script says. */
function scriptedWorker(worktree: string, turns: Array<string | null>) {
  let turn = 0;
  const prompts: string[] = [];
  return {
    prompts,
    send: async (message: string) => {
      prompts.push(message);
      const content = turns[turn++];
      if (content !== null && content !== undefined) {
        mkdirSync(join(worktree, HARNESS_OUT_DIR), { recursive: true });
        writeFileSync(join(worktree, HARNESS_OUT_DIR, "out.json"), content, "utf8");
      }
      return { timedOut: false, lastAssistantText: null };
    },
  };
}

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "harness-structured-"));
}

const base = { outputFile: "out.json", schema: Schema, prompt: "do it", timeoutMs: 1000 };

describe("runStructured", () => {
  it("returns the parsed artifact on the first valid attempt", async () => {
    const worktree = workspace();
    const worker = scriptedWorker(worktree, ['{"name":"a","count":1}']);
    const value = await runStructured({ ...base, worker, worktree, retries: 2 });
    expect(value).toEqual({ name: "a", count: 1 });
    expect(worker.prompts).toHaveLength(1);
  });

  it("feeds the specific validation error back and accepts the correction", async () => {
    const worktree = workspace();
    const worker = scriptedWorker(worktree, ['{"name":"a"}', '{"name":"a","count":2}']);
    const value = await runStructured({ ...base, worker, worktree, retries: 2 });
    expect(value).toEqual({ name: "a", count: 2 });
    // The retry prompt must name the failing field, not just say "invalid".
    expect(worker.prompts[1]).toMatch(/count/);
  });

  it("reports malformed JSON distinctly from a schema mismatch", async () => {
    const worktree = workspace();
    const worker = scriptedWorker(worktree, ["not json at all", '{"name":"a","count":3}']);
    await runStructured({ ...base, worker, worktree, retries: 2 });
    expect(worker.prompts[1]).toMatch(/not valid JSON/);
  });

  it("tells the agent when it wrote nothing", async () => {
    const worktree = workspace();
    const worker = scriptedWorker(worktree, [null, '{"name":"a","count":4}']);
    await runStructured({ ...base, worker, worktree, retries: 2 });
    expect(worker.prompts[1]).toMatch(/does not exist/);
  });

  it("gives up after the retry budget", async () => {
    const worktree = workspace();
    const worker = scriptedWorker(worktree, ["{}", "{}", "{}"]);
    await expect(runStructured({ ...base, worker, worktree, retries: 1 })).rejects.toBeInstanceOf(
      StructuredOutputError,
    );
    expect(worker.prompts).toHaveLength(2);
  });

  it("does not accept a stale artifact from an earlier round", async () => {
    const worktree = workspace();
    mkdirSync(join(worktree, HARNESS_OUT_DIR), { recursive: true });
    writeFileSync(join(worktree, HARNESS_OUT_DIR, "out.json"), '{"name":"stale","count":9}', "utf8");

    const worker = scriptedWorker(worktree, [null]);
    await expect(runStructured({ ...base, worker, worktree, retries: 0 })).rejects.toThrow(/does not exist/);
  });

  it("surfaces a timeout rather than reading a partial file", async () => {
    const worktree = workspace();
    const worker = {
      send: async () => ({ timedOut: true, lastAssistantText: null }),
    };
    await expect(runStructured({ ...base, worker, worktree, retries: 2 })).rejects.toThrow(/timed out/);
  });
});
