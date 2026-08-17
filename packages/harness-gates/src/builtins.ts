import { type DiffStat, type GateFailure, globMatcher, type HarnessConfig } from "@harness/core";

/**
 * In-process checks that no shell tool performs.
 *
 * The last two — `no-skipped-tests` and `no-suppressions` — are the ones that
 * matter most for autonomous agents. An agent that cannot fix a failing test can
 * always delete it, mark it `.skip`, or silence the typechecker with
 * `@ts-expect-error`, and every downstream gate will then report green. These
 * checks close that loop.
 */

export interface BuiltinContext {
  diff: DiffStat;
  config: HarnessConfig;
  worktree: string;
}

export interface BuiltinOutcome {
  failures: GateFailure[];
  warnings: GateFailure[];
  output: string;
}

export type BuiltinCheck = (ctx: BuiltinContext) => BuiltinOutcome;

interface AddedLine {
  file: string;
  line: number;
  text: string;
}

/** Walk a unified diff and yield added lines with their post-image line numbers. */
function addedLines(patch: string): AddedLine[] {
  const out: AddedLine[] = [];
  let file = "";
  let lineNo = 0;

  for (const raw of patch.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const path = raw.slice(4).trim();
      file = path === "/dev/null" ? "" : path.replace(/^b\//, "");
      continue;
    }
    if (raw.startsWith("@@")) {
      const match = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      lineNo = match ? Number(match[1]) : 0;
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      if (file) out.push({ file, line: lineNo, text: raw.slice(1) });
      lineNo++;
      continue;
    }
    if (raw.startsWith("-")) continue;
    if (raw.startsWith(" ")) lineNo++;
  }
  return out;
}

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const SOURCE_FILE = /^(packages|src|apps|libs)\/.*\.[cm]?[jt]sx?$/;

export const diffScope: BuiltinCheck = ({ diff, config }) => {
  const failures: GateFailure[] = [];
  const warnings: GateFailure[] = [];
  const isProtected = globMatcher(config.scope.protectedPaths);
  const isSensitive = globMatcher(config.scope.sensitivePaths);

  for (const file of diff.changedFiles) {
    if (isProtected(file)) {
      failures.push({ file, code: "scope/protected", message: `Agents may not modify ${file}.` });
    } else if (isSensitive(file)) {
      warnings.push({ file, code: "scope/sensitive", message: `Sensitive path modified: ${file}.` });
    }
  }

  const totalLines = diff.addedLines + diff.removedLines;
  if (diff.changedFiles.length > config.scope.maxChangedFiles) {
    failures.push({
      code: "scope/too-many-files",
      message: `Diff touches ${diff.changedFiles.length} files, ceiling is ${config.scope.maxChangedFiles}.`,
    });
  }
  if (totalLines > config.scope.maxChangedLines) {
    failures.push({
      code: "scope/too-many-lines",
      message: `Diff changes ${totalLines} lines, ceiling is ${config.scope.maxChangedLines}.`,
    });
  }

  return {
    failures,
    warnings,
    output: `${diff.changedFiles.length} files, +${diff.addedLines}/-${diff.removedLines} lines`,
  };
};

const SECRET_PATTERNS: Array<{ code: string; re: RegExp }> = [
  { code: "secret/anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{16,}/ },
  { code: "secret/openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/ },
  { code: "secret/aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { code: "secret/github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { code: "secret/slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { code: "secret/private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  {
    code: "secret/generic-credential",
    re: /\b(?:api[_-]?key|secret|password|passwd|access[_-]?token)\b\s*[:=]\s*["'][^"'\s]{16,}["']/i,
  },
];

export const secretScan: BuiltinCheck = ({ diff }) => {
  const failures: GateFailure[] = [];
  for (const added of addedLines(diff.patch)) {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.re.test(added.text)) {
        failures.push({
          file: added.file,
          line: added.line,
          code: pattern.code,
          message: `Possible credential added on this line. Move it to an environment variable.`,
        });
        break;
      }
    }
  }
  return { failures, warnings: [], output: `scanned ${diff.changedFiles.length} files` };
};

export const noSkippedTests: BuiltinCheck = ({ diff }) => {
  const failures: GateFailure[] = [];
  const skip = /\b(?:it|test|describe|bench)\s*\.\s*(skip|todo|only)\b|\bxit\s*\(|\bxdescribe\s*\(/;

  for (const added of addedLines(diff.patch)) {
    if (!TEST_FILE.test(added.file)) continue;
    const match = skip.exec(added.text);
    if (!match) continue;
    failures.push({
      file: added.file,
      line: added.line,
      code: `test/${match[1] ?? "skip"}`,
      message: "Test disabled in this change. Fix the test instead of skipping it.",
    });
  }
  return { failures, warnings: [], output: `${failures.length} disabled tests introduced` };
};

export const noSuppressions: BuiltinCheck = ({ diff }) => {
  const failures: GateFailure[] = [];
  // Anchored to a comment opener on purpose. A bare substring match also fires
  // on the pattern inside this file, on doc comments that name the directive,
  // and on prompt text that forbids it — all false positives.
  const suppression = /(?:\/\/|\/\*)\s*(?:@ts-(?:ignore|expect-error|nocheck)|biome-ignore|eslint-disable)/;

  for (const added of addedLines(diff.patch)) {
    if (!suppression.test(added.text)) continue;
    failures.push({
      file: added.file,
      line: added.line,
      code: "suppression/added",
      message: "Diagnostic suppression added. Resolve the underlying error instead.",
    });
  }
  return { failures, warnings: [], output: `${failures.length} suppressions introduced` };
};

export const changeCoverage: BuiltinCheck = ({ diff }) => {
  const touchedSource = diff.changedFiles.filter((f) => SOURCE_FILE.test(f) && !TEST_FILE.test(f));
  const touchedTests = diff.changedFiles.filter((f) => TEST_FILE.test(f));
  if (touchedSource.length === 0 || touchedTests.length > 0) {
    return { failures: [], warnings: [], output: "ok" };
  }
  return {
    failures: [],
    warnings: [
      {
        code: "coverage/no-test-change",
        message: `${touchedSource.length} source files changed with no accompanying test change.`,
      },
    ],
    output: "no test files touched",
  };
};

export const BUILTIN_CHECKS: Record<string, BuiltinCheck> = {
  "diff-scope": diffScope,
  "secret-scan": secretScan,
  "no-skipped-tests": noSkippedTests,
  "no-suppressions": noSuppressions,
  "change-coverage": changeCoverage,
};
