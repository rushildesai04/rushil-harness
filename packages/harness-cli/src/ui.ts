import type { GateResult, GateRunSummary } from "@harness/core";

const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const ESC = "\u001b";

const paint = (code: string, text: string): string => (useColor ? `${ESC}[${code}m${text}${ESC}[0m` : text);

export const dim = (text: string): string => paint("2", text);
export const bold = (text: string): string => paint("1", text);
export const red = (text: string): string => paint("31", text);
export const green = (text: string): string => paint("32", text);
export const yellow = (text: string): string => paint("33", text);

const STATUS_MARK: Record<GateResult["status"], string> = {
  passed: green("pass"),
  failed: red("FAIL"),
  "timed-out": red("TIME"),
  warned: yellow("warn"),
  skipped: dim("skip"),
};

export function formatGateLine(result: GateResult): string {
  const mark = STATUS_MARK[result.status];
  const duration = result.status === "skipped" ? "" : dim(` ${(result.durationMs / 1000).toFixed(1)}s`);
  const count = result.failures.length > 0 ? dim(` (${result.failures.length} issues)`) : "";
  return `  ${mark}  ${result.label}${duration}${count}`;
}

export function formatGateSummary(summary: GateRunSummary): string {
  const lines: string[] = [];
  for (const result of summary.blockingFailures) {
    lines.push("", bold(`${result.label} — ${result.gateId}`));
    for (const failure of result.failures.slice(0, 10)) {
      const where = failure.file
        ? `${failure.file}${failure.line ? `:${failure.line}` : ""}`
        : "(no location)";
      lines.push(`  ${where} ${failure.code ? dim(`[${failure.code}] `) : ""}${failure.message}`);
    }
    if (result.failures.length > 10) lines.push(dim(`  ... ${result.failures.length - 10} more`));
  }
  return lines.join("\n");
}
