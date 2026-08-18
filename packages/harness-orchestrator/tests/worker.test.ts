import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type RoleConfig, RunStore } from "@harness/core";
import { afterEach, describe, expect, it } from "vitest";
import { Worker } from "../src/worker.ts";

const STUB = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "stub-pi.mjs");

const role: RoleConfig = {
  model: { provider: "anthropic", id: "stub-model", thinking: "medium" },
  tools: ["read", "bash"],
  timeoutMs: 60_000,
};

function newStore(): RunStore {
  const runs = mkdtempSync(join(tmpdir(), "harness-worker-runs-"));
  return RunStore.create(runs, "test-run", {
    task: "t",
    baseRef: "HEAD",
    baseCommit: "0".repeat(40),
    worktree: runs,
    status: "running",
    attempts: 0,
    startedAt: Date.now(),
  });
}

function events(store: RunStore): Array<Record<string, unknown>> {
  const raw = readFileSync(join(store.dir, "events.ndjson"), "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const workers: Worker[] = [];

function makeWorker(store: RunStore, stubMode: string): Worker {
  process.env.STUB_MODE = stubMode;
  const worker = new Worker({
    agentId: "test",
    worktree: store.dir,
    role,
    runStore: store,
    cliPath: STUB,
  });
  workers.push(worker);
  return worker;
}

afterEach(async () => {
  while (workers.length > 0) await workers.pop()?.stop();
  process.env.STUB_MODE = undefined;
});

/**
 * Exercises the Worker against a stub that speaks pi's RPC protocol.
 *
 * Everything here is an assumption the harness makes about pi that would
 * otherwise only be tested by spending money: that waitForIdle resolves on
 * `agent_settled`, that session stats carry cost at the top level and tokens
 * nested, and that a non-settling agent surfaces as a timeout rather than a
 * hang. The earlier twenty-minute hang was exactly this class of bug.
 */
describe("Worker over the RPC protocol", () => {
  it("completes a turn and returns the assistant's reply", async () => {
    const store = newStore();
    const worker = makeWorker(store, "normal");
    await worker.start();

    const outcome = await worker.send("do the thing", 20_000);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.lastAssistantText).toBe("reply 1");
  });

  it("streams assistant text to the progress callback", async () => {
    const store = newStore();
    process.env.STUB_MODE = "normal";
    const deltas: string[] = [];
    const worker = new Worker({
      agentId: "test",
      worktree: store.dir,
      role,
      runStore: store,
      cliPath: STUB,
      onText: (delta) => deltas.push(delta),
    });
    workers.push(worker);

    await worker.start();
    await worker.send("hello", 20_000);
    expect(deltas.join("")).toBe("working");
  });

  it("records tool lifecycle events but not token-level deltas", async () => {
    const store = newStore();
    const worker = makeWorker(store, "normal");
    await worker.start();
    await worker.send("hello", 20_000);

    const types = events(store).map((event) => event.type);
    expect(types).toContain("agent:tool_execution_start");
    expect(types).toContain("agent:tool_execution_end");
    expect(types).toContain("agent:agent_settled");
    // message_update arrives per token; persisting it would swamp the log.
    expect(types).not.toContain("agent:message_update");
  });

  it("reads cost and token counts from the fields pi populates", async () => {
    const store = newStore();
    const worker = makeWorker(store, "normal");
    await worker.start();
    await worker.send("hello", 20_000);

    const stats = await worker.stats();
    expect(stats.costUsd).toBe(0.4242);
    expect(stats.inputTokens).toBe(100);
    expect(stats.outputTokens).toBe(25);
  });

  it("reports a timeout instead of hanging when the agent never settles", async () => {
    const store = newStore();
    const worker = makeWorker(store, "silent");
    await worker.start();

    const outcome = await worker.send("this never finishes", 1_000);
    expect(outcome.timedOut).toBe(true);
    expect(outcome.lastAssistantText).toBeNull();

    const timeout = events(store).find((event) => event.type === "worker:prompt-timeout");
    expect(timeout?.timeoutMs).toBe(1_000);
  });

  it("fails fast when the process dies on startup", async () => {
    const store = newStore();
    const worker = makeWorker(store, "crash");
    await expect(worker.start()).rejects.toThrow();
  });

  it("refuses to be used before start", async () => {
    const store = newStore();
    const worker = makeWorker(store, "normal");
    await expect(worker.send("x", 1_000)).rejects.toThrow(/before start/);
  });
});
