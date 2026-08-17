/** Domain types shared across harness packages. */

export type GateStatus = "passed" | "failed" | "skipped" | "timed-out" | "warned";

export interface GateFailure {
  /** Repo-relative path, when the parser could attribute one. */
  file?: string;
  line?: number;
  column?: number;
  /** Tool-specific code, e.g. TS2345 or lint/suspicious/noExplicitAny. */
  code?: string;
  message: string;
}

export interface GateResult {
  gateId: string;
  label: string;
  tier: number;
  status: GateStatus;
  exitCode: number | null;
  durationMs: number;
  /** Structured failures when a parser recognised the output. */
  failures: GateFailure[];
  /** Trimmed combined output, retained for the evidence bundle. */
  output: string;
  truncated: boolean;
}

export interface GateRunSummary {
  passed: boolean;
  results: GateResult[];
  /** Gates that failed and are blocking. */
  blockingFailures: GateResult[];
}

export interface DiffStat {
  changedFiles: string[];
  addedLines: number;
  removedLines: number;
  /** Unified patch of all changes, staged and untracked. */
  patch: string;
}

export type RunStatus = "running" | "passed" | "failed" | "aborted";

export interface RunRecord {
  runId: string;
  task: string;
  baseRef: string;
  baseCommit: string;
  worktree: string;
  status: RunStatus;
  attempts: number;
  startedAt: number;
  endedAt?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** One line in a run's events.ndjson. */
export interface RunEvent {
  ts: number;
  runId: string;
  type: string;
  [key: string]: unknown;
}
