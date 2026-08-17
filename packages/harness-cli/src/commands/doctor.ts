import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "@harness/core";
import { checkModelAvailability, checkNodeVersion, PI_VERSION, resolvePiCliPath } from "@harness/pi-adapter";
import { bold, dim, green, red, yellow } from "../ui.ts";

const execFileAsync = promisify(execFile);

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

async function binaryVersion(bin: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(bin, args, { encoding: "utf8" });
    return stdout.trim().split("\n")[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Fail fast on environment problems that otherwise surface as confusing errors
 * deep inside a run — most commonly a Node version pi cannot parse.
 */
export async function doctorCommand(repoRoot: string): Promise<number> {
  const checks: Check[] = [];

  const node = checkNodeVersion();
  checks.push({
    name: "node",
    status: node.ok ? "ok" : "fail",
    detail: node.ok ? `v${node.current}` : (node.message ?? "unsupported"),
  });

  const pnpm = await binaryVersion("pnpm", ["--version"]);
  checks.push({
    name: "pnpm",
    status: pnpm ? "ok" : "fail",
    detail: pnpm ?? "not found on PATH",
  });

  const git = await binaryVersion("git", ["--version"]);
  checks.push({ name: "git", status: git ? "ok" : "fail", detail: git ?? "not found on PATH" });

  try {
    const cliPath = resolvePiCliPath();
    checks.push({
      name: "pi runtime",
      status: existsSync(cliPath) ? "ok" : "fail",
      detail: `${PI_VERSION} at ${cliPath}`,
    });
  } catch (error) {
    checks.push({
      name: "pi runtime",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  // Ask pi what it can actually reach rather than inferring from files on disk.
  const availability = await checkModelAvailability();
  const authPath = join(homedir(), ".pi", "agent", "auth.json");
  checks.push({
    name: "model auth",
    status: availability.available ? "ok" : "fail",
    detail: availability.available
      ? `models reachable${existsSync(authPath) ? ` (credentials at ${authPath})` : ""}`
      : (availability.message ?? "no models available"),
  });

  try {
    const loaded = loadConfig(repoRoot);
    const commandGates = loaded.gates.gates.filter((g) => g.kind === "command").length;
    const builtinGates = loaded.gates.gates.length - commandGates;
    checks.push({
      name: "config",
      status: "ok",
      detail: `${commandGates} command gates, ${builtinGates} builtin gates`,
    });
  } catch (error) {
    checks.push({
      name: "config",
      status: "fail",
      detail: error instanceof Error ? (error.message.split("\n")[0] ?? "invalid") : String(error),
    });
  }

  process.stderr.write(`${bold("harness doctor")}\n\n`);
  for (const check of checks) {
    const mark =
      check.status === "ok" ? green("ok  ") : check.status === "warn" ? yellow("warn") : red("fail");
    process.stderr.write(`  ${mark}  ${check.name.padEnd(12)} ${dim(check.detail)}\n`);
  }
  process.stderr.write("\n");

  return checks.some((c) => c.status === "fail") ? 1 : 0;
}
