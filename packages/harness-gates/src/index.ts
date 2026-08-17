import type {
  DiffStat,
  GateFailure,
  GateResult,
  GateRunSummary,
  GateSpec,
  GatesConfig,
  HarnessConfig,
} from "@harness/core";
import { globMatcher } from "@harness/core";
import { BUILTIN_CHECKS } from "./builtins.ts";
import { execCommand } from "./exec.ts";
import { parseGateOutput } from "./parsers.ts";

export type { BuiltinCheck, BuiltinContext, BuiltinOutcome } from "./builtins.ts";
export { BUILTIN_CHECKS } from "./builtins.ts";
export { type ExecOptions, type ExecResult, execCommand } from "./exec.ts";
export { type ParserId, parseGateOutput } from "./parsers.ts";

export interface RunGatesOptions {
  worktree: string;
  diff: DiffStat;
  config: HarnessConfig;
  gates: GatesConfig;
  /** Called as each gate finishes, for progress output and the run event log. */
  onResult?: (result: GateResult) => void;
  env?: Record<string, string>;
  /** Include gates marked `agentOnly`. False when a human runs the gates. */
  includeAgentOnly?: boolean;
}

function shouldRun(gate: GateSpec, options: RunGatesOptions): boolean {
  if (gate.agentOnly && options.includeAgentOnly === false) return false;
  if (!gate.when || gate.when.length === 0) return true;
  const matches = globMatcher(gate.when);
  return options.diff.changedFiles.some((file) => matches(file));
}

async function runBuiltin(gate: GateSpec, options: RunGatesOptions): Promise<GateResult> {
  const startedAt = Date.now();
  const check = BUILTIN_CHECKS[gate.id];
  const label = gate.label ?? gate.id;

  if (!check) {
    return {
      gateId: gate.id,
      label,
      tier: gate.tier,
      status: "failed",
      exitCode: null,
      durationMs: 0,
      failures: [{ code: "gate/unknown-builtin", message: `No builtin check named "${gate.id}".` }],
      output: "",
      truncated: false,
    };
  }

  const outcome = check({ diff: options.diff, config: options.config, worktree: options.worktree });
  const failed = outcome.failures.length > 0;
  const warned = !failed && outcome.warnings.length > 0;

  return {
    gateId: gate.id,
    label,
    tier: gate.tier,
    status: failed ? (gate.blocking ? "failed" : "warned") : warned ? "warned" : "passed",
    exitCode: failed ? 1 : 0,
    durationMs: Date.now() - startedAt,
    failures: failed ? outcome.failures : outcome.warnings,
    output: outcome.output,
    truncated: false,
  };
}

async function runCommandGate(gate: GateSpec, options: RunGatesOptions): Promise<GateResult> {
  const label = gate.label ?? gate.id;
  const cwd = gate.cwd === "." ? options.worktree : `${options.worktree}/${gate.cwd}`;
  const timeoutMs = gate.timeoutMs ?? options.gates.defaults.timeoutMs ?? 600_000;

  const result = await execCommand(gate.command as string, {
    cwd,
    timeoutMs,
    ...(options.env ? { env: options.env } : {}),
  });

  const ok = result.exitCode === 0;
  const failures: GateFailure[] = ok ? [] : parseGateOutput(gate.id, gate.parser, result.output);

  // A gate that failed without a parseable diagnostic still has to say something
  // actionable, or the repair agent gets an empty failure list.
  if (!ok && failures.length === 0) {
    failures.push({
      code: result.timedOut ? "gate/timeout" : "gate/exit",
      message: result.timedOut
        ? `\`${gate.command}\` exceeded ${timeoutMs}ms and was killed.`
        : `\`${gate.command}\` exited ${result.exitCode}. See gate log for full output.`,
    });
  }

  return {
    gateId: gate.id,
    label,
    tier: gate.tier,
    status: ok ? "passed" : result.timedOut ? "timed-out" : gate.blocking ? "failed" : "warned",
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    failures,
    output: result.output,
    truncated: result.truncated,
  };
}

function runGate(gate: GateSpec, options: RunGatesOptions): Promise<GateResult> {
  return gate.kind === "builtin" ? runBuiltin(gate, options) : runCommandGate(gate, options);
}

/**
 * Execute gates tier by tier, cheapest first, stopping at the first tier with a
 * blocking failure.
 *
 * Short-circuiting is the point: there is no value in running an eight-minute
 * integration suite against code that does not typecheck, and every skipped tier
 * is latency and tokens the repair loop gets back.
 */
export async function runGates(options: RunGatesOptions): Promise<GateRunSummary> {
  const applicable = options.gates.gates.filter((gate) => shouldRun(gate, options));
  const skipped = options.gates.gates.filter((gate) => !applicable.includes(gate));

  const tiers = [...new Set(applicable.map((gate) => gate.tier))].sort((a, b) => a - b);
  const results: GateResult[] = [];

  for (const tier of tiers) {
    const inTier = applicable.filter((gate) => gate.tier === tier);
    const sequential = inTier.some((gate) => gate.mutates);

    let tierResults: GateResult[];
    if (sequential) {
      tierResults = [];
      for (const gate of inTier) {
        const result = await runGate(gate, options);
        options.onResult?.(result);
        tierResults.push(result);
        if (result.status === "failed" || result.status === "timed-out") break;
      }
    } else {
      tierResults = await Promise.all(inTier.map((gate) => runGate(gate, options)));
      for (const result of tierResults) options.onResult?.(result);
    }

    results.push(...tierResults);
    if (tierResults.some((r) => r.status === "failed" || r.status === "timed-out")) break;
  }

  const ran = new Set(results.map((r) => r.gateId));
  for (const gate of [...skipped, ...applicable.filter((g) => !ran.has(g.id))]) {
    results.push({
      gateId: gate.id,
      label: gate.label ?? gate.id,
      tier: gate.tier,
      status: "skipped",
      exitCode: null,
      durationMs: 0,
      failures: [],
      output: "",
      truncated: false,
    });
  }

  const blockingFailures = results.filter((r) => r.status === "failed" || r.status === "timed-out");
  return { passed: blockingFailures.length === 0, results, blockingFailures };
}

/** Render blocking failures as a compact, actionable repair brief. */
export function formatFailuresForRepair(summary: GateRunSummary, maxPerGate = 20): string {
  const sections: string[] = [];

  for (const result of summary.blockingFailures) {
    const lines: string[] = [`## ${result.label} (${result.gateId}) — exit ${result.exitCode ?? "killed"}`];

    if (result.failures.length === 0) {
      lines.push("No structured diagnostics were parsed. Raw tail:");
      lines.push("```");
      lines.push(result.output.split("\n").slice(-40).join("\n").trim());
      lines.push("```");
    } else {
      for (const failure of result.failures.slice(0, maxPerGate)) {
        const where = failure.file
          ? `${failure.file}${failure.line ? `:${failure.line}` : ""}${failure.column ? `:${failure.column}` : ""}`
          : "(no location)";
        const code = failure.code ? ` [${failure.code}]` : "";
        lines.push(`- ${where}${code} ${failure.message}`);
      }
      if (result.failures.length > maxPerGate) {
        lines.push(`- ... and ${result.failures.length - maxPerGate} more`);
      }
    }
    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n");
}
