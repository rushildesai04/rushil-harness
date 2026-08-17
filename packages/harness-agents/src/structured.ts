import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";

export const HARNESS_OUT_DIR = ".harness-out";

/** Minimal surface the structured runner needs from an agent worker. */
export interface PromptCapable {
  send(message: string, timeoutMs: number): Promise<{ timedOut: boolean; lastAssistantText: string | null }>;
}

export interface StructuredOptions<T> {
  worker: PromptCapable;
  worktree: string;
  /** File name under `.harness-out/`, e.g. "plan.json". */
  outputFile: string;
  schema: z.ZodType<T>;
  prompt: string;
  timeoutMs: number;
  retries: number;
  onAttempt?: (attempt: number, problem?: string) => void;
}

export class StructuredOutputError extends Error {
  readonly attempts: number;
  constructor(message: string, attempts: number) {
    super(message);
    this.name = "StructuredOutputError";
    this.attempts = attempts;
  }
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 12)
    .map((issue) => `  ${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("\n");
}

/**
 * Run an agent turn that must end with a valid JSON artifact on disk.
 *
 * The file lives inside the worktree because pi tools are cwd-relative, and
 * `.harness-out/` is added to the worktree's git exclude so the artifact never
 * shows up in the diff the gates inspect.
 *
 * Retries feed the exact validation errors back. An agent told "your JSON was
 * invalid" guesses; an agent told "units.0.files: expected array" fixes it.
 */
export async function runStructured<T>(options: StructuredOptions<T>): Promise<T> {
  const relative = join(HARNESS_OUT_DIR, options.outputFile);
  const absolute = join(options.worktree, relative);

  // A stale artifact from an earlier round would be read as this round's answer.
  rmSync(absolute, { force: true });

  let prompt = `${options.prompt}\n\n${contract(relative)}`;

  for (let attempt = 1; attempt <= options.retries + 1; attempt++) {
    options.onAttempt?.(attempt);
    const outcome = await options.worker.send(prompt, options.timeoutMs);

    if (outcome.timedOut) {
      throw new StructuredOutputError(`Agent timed out after ${options.timeoutMs}ms.`, attempt);
    }

    const problem = validate(absolute, relative, options.schema);
    if (problem.ok) return problem.value;

    options.onAttempt?.(attempt, problem.reason);
    if (attempt > options.retries) {
      throw new StructuredOutputError(problem.reason, attempt);
    }
    prompt = `${problem.reason}\n\nRewrite ${relative} so it is valid. Change nothing else.`;
  }

  throw new StructuredOutputError("unreachable", options.retries + 1);
}

type ValidationResult<T> = { ok: true; value: T } | { ok: false; reason: string };

function validate<T>(absolute: string, relative: string, schema: z.ZodType<T>): ValidationResult<T> {
  if (!existsSync(absolute)) return { ok: false, reason: `The file ${relative} does not exist.` };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `${relative} is not valid JSON: ${detail}` };
  }

  const result = schema.safeParse(parsed);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    reason: `${relative} did not match the required shape:\n${describeIssues(result.error)}`,
  };
}

function contract(relative: string): string {
  return `## Output contract

Write your answer as JSON to \`${relative}\` (relative to the current directory)
using the write tool. Create the directory if it does not exist.

The file must contain only the JSON object — no markdown fences, no commentary.
Your chat response is not read by anything; the file is the deliverable.`;
}
