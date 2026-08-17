import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunEvent, RunRecord } from "./types.ts";

/**
 * Append-only run store.
 *
 * Two artifacts per run: a mutable summary (run.json) and an immutable event
 * log (events.ndjson). The event log is the audit record — nothing rewrites it,
 * and it is written synchronously so a crashed run still leaves evidence.
 */
export class RunStore {
  readonly runId: string;
  readonly dir: string;
  private readonly eventsPath: string;
  private readonly recordPath: string;
  private record: RunRecord;

  private constructor(runId: string, dir: string, record: RunRecord) {
    this.runId = runId;
    this.dir = dir;
    this.eventsPath = join(dir, "events.ndjson");
    this.recordPath = join(dir, "run.json");
    this.record = record;
  }

  static create(runsRoot: string, runId: string, seed: Omit<RunRecord, "runId">): RunStore {
    const dir = resolve(runsRoot, runId);
    mkdirSync(join(dir, "sessions"), { recursive: true });
    mkdirSync(join(dir, "gates"), { recursive: true });
    const store = new RunStore(runId, dir, { runId, ...seed });
    store.flushRecord();
    return store;
  }

  /** Deterministic, sortable, collision-resistant enough for local + server use. */
  static newRunId(now: Date = new Date()): string {
    const stamp = now
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z");
    const suffix = Math.random().toString(36).slice(2, 8);
    return `${stamp}-${suffix}`;
  }

  emit(type: string, payload: Record<string, unknown> = {}): void {
    const event: RunEvent = { ts: Date.now(), runId: this.runId, type, ...payload };
    appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`, "utf8");
  }

  update(patch: Partial<RunRecord>): void {
    this.record = { ...this.record, ...patch };
    this.flushRecord();
  }

  getRecord(): RunRecord {
    return { ...this.record };
  }

  /** Path a worker should hand to pi for its session JSONL. */
  sessionPath(agentId: string): string {
    return join(this.dir, "sessions", `${agentId}.jsonl`);
  }

  /** Persist a gate's raw output next to the run for the evidence bundle. */
  writeGateOutput(gateId: string, output: string): string {
    const path = join(this.dir, "gates", `${gateId.replace(/[^a-z0-9-]/gi, "_")}.log`);
    writeFileSync(path, output, "utf8");
    return path;
  }

  writeArtifact(name: string, content: string): string {
    const path = join(this.dir, name);
    writeFileSync(path, content, "utf8");
    return path;
  }

  private flushRecord(): void {
    writeFileSync(this.recordPath, `${JSON.stringify(this.record, null, 2)}\n`, "utf8");
  }
}
