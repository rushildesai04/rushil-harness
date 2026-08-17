import type { GateFailure } from "@harness/core";

/**
 * Output parsers turn tool noise into structured failures.
 *
 * These exist so the repair prompt carries `file:line: code: message` instead of
 * ten thousand characters of log. A repair agent given precise failures fixes
 * them; one given a wall of text guesses.
 */

export type ParserId = "auto" | "tsc" | "biome" | "vitest" | "pnpm-install" | "none";

const MAX_FAILURES = 40;

/** tsc: `src/a.ts(12,5): error TS2345: Argument of type ...` */
function parseTsc(output: string): GateFailure[] {
  const failures: GateFailure[] = [];
  const re = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/gm;
  let match: RegExpExecArray | null = re.exec(output);
  while (match !== null && failures.length < MAX_FAILURES) {
    failures.push({
      file: match[1],
      line: Number(match[2]),
      column: Number(match[3]),
      code: match[4],
      message: (match[5] ?? "").trim(),
    });
    match = re.exec(output);
  }
  return failures;
}

/** biome: `src/a.ts:12:5 lint/suspicious/noExplicitAny  ━━━ ...` then a message line. */
function parseBiome(output: string): GateFailure[] {
  const failures: GateFailure[] = [];
  const lines = output.split("\n");
  const header = /^(\S+?):(\d+):(\d+)\s+(\S+)/;

  for (let i = 0; i < lines.length && failures.length < MAX_FAILURES; i++) {
    const match = header.exec(lines[i] ?? "");
    if (!match) continue;
    // Biome prints the human-readable message on the next non-empty line
    // after the rule header banner.
    let message = "";
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      const candidate = (lines[j] ?? "").replace(/^[\s×✖>│┌└─]+/, "").trim();
      if (candidate.length > 0) {
        message = candidate;
        break;
      }
    }
    failures.push({
      file: match[1],
      line: Number(match[2]),
      column: Number(match[3]),
      code: match[4],
      message: message || (match[4] ?? "biome diagnostic"),
    });
  }
  return failures;
}

/** vitest text reporter: `FAIL  packages/x/tests/a.test.ts > suite > case`. */
function parseVitest(output: string): GateFailure[] {
  const failures: GateFailure[] = [];
  const lines = output.split("\n");

  for (let i = 0; i < lines.length && failures.length < MAX_FAILURES; i++) {
    const line = lines[i] ?? "";
    const match = /^\s*(?:FAIL|×)\s+(.+?)(?:\s+>\s+(.*))?$/.exec(line);
    if (!match) continue;
    const file = (match[1] ?? "").trim();
    if (!/\.(test|spec)\.[cm]?[jt]sx?/.test(file)) continue;

    // The assertion message usually follows within a few lines.
    let message = match[2]?.trim() ?? "";
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const candidate = (lines[j] ?? "").trim();
      if (/^(AssertionError|Error|TypeError|ReferenceError)/.test(candidate)) {
        message = message ? `${message} — ${candidate}` : candidate;
        break;
      }
    }
    failures.push({ file, message: message || "test failed" });
  }
  return failures;
}

/** pnpm install --frozen-lockfile has one failure that matters. */
function parsePnpmInstall(output: string): GateFailure[] {
  if (output.includes("ERR_PNPM_OUTDATED_LOCKFILE")) {
    return [
      {
        file: "pnpm-lock.yaml",
        code: "ERR_PNPM_OUTDATED_LOCKFILE",
        message:
          "package.json was changed without updating pnpm-lock.yaml. Run `pnpm install` and commit the lockfile.",
      },
    ];
  }
  const missing = /ERR_PNPM_[A-Z_]+/.exec(output);
  return missing ? [{ code: missing[0], message: `pnpm install failed: ${missing[0]}` }] : [];
}

function pickAuto(gateId: string): ParserId {
  if (gateId.includes("typecheck") || gateId.includes("tsc")) return "tsc";
  if (gateId.includes("lint") || gateId.includes("format") || gateId.includes("biome")) return "biome";
  if (gateId.includes("test")) return "vitest";
  if (gateId.includes("install") || gateId.includes("lockfile")) return "pnpm-install";
  return "none";
}

export function parseGateOutput(gateId: string, parser: ParserId, output: string): GateFailure[] {
  const resolved = parser === "auto" ? pickAuto(gateId) : parser;
  switch (resolved) {
    case "tsc":
      return parseTsc(output);
    case "biome":
      return parseBiome(output);
    case "vitest":
      return parseVitest(output);
    case "pnpm-install":
      return parsePnpmInstall(output);
    default:
      return [];
  }
}
