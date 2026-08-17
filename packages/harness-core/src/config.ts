import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Config is validated at the boundary and never re-validated downstream.
 * A malformed gates.yaml must fail before a single token is spent.
 */

const ThinkingLevel = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const ModelConfig = z.object({
  provider: z.string().min(1).default("anthropic"),
  id: z.string().min(1).optional(),
  thinking: ThinkingLevel.default("medium"),
});

const BuilderConfig = z.object({
  tools: z.array(z.string().min(1)).default(["read", "bash", "edit", "write", "grep", "find", "ls"]),
  promptTimeoutMs: z.number().int().positive().default(900_000),
  maxRepairAttempts: z.number().int().min(0).max(10).default(3),
  concurrency: z.number().int().min(1).max(16).default(3),
});

const PathsConfig = z.object({
  worktrees: z.string().default(".harness/worktrees"),
  runs: z.string().default(".harness/runs"),
});

const ScopeConfig = z.object({
  /** Globs an agent may never modify. Enforced deterministically after the diff. */
  protectedPaths: z
    .array(z.string().min(1))
    .default([".harness/**", ".github/workflows/**", "config/policy.yaml"]),
  /** Globs that produce a warning, not a failure, when touched. */
  sensitivePaths: z.array(z.string().min(1)).default(["pnpm-lock.yaml", "package.json"]),
  /** Hard ceiling on diff size; a runaway agent fails fast instead of at review. */
  maxChangedFiles: z.number().int().positive().default(60),
  maxChangedLines: z.number().int().positive().default(4000),
});

const RoleConfig = z.object({
  model: ModelConfig.prefault({}),
  tools: z.array(z.string().min(1)).min(1),
  /** Wall-clock ceiling for a single turn by this role. */
  timeoutMs: z.number().int().positive(),
});

export type RoleConfig = z.infer<typeof RoleConfig>;

/**
 * Model assignment per role.
 *
 * Roles are separated because their failure modes differ. The designer is
 * reasoning over an unfamiliar codebase and must not be able to edit it. The
 * adversary needs `bash` — a reviewer that cannot run the code produces
 * plausible-but-wrong findings — but never `edit` or `write`, and it works in a
 * throwaway worktree so a shell-based write cannot reach the real change.
 */
const RolesConfig = z.object({
  designer: RoleConfig.prefault({
    model: { provider: "anthropic", id: "claude-fable-5", thinking: "high" },
    tools: ["read", "grep", "find", "ls"],
    timeoutMs: 1_200_000,
  }),
  implementer: RoleConfig.prefault({
    model: { provider: "anthropic", id: "claude-opus-4-8", thinking: "medium" },
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    timeoutMs: 1_800_000,
  }),
  adversary: RoleConfig.prefault({
    model: { provider: "anthropic", id: "claude-opus-4-8", thinking: "high" },
    tools: ["read", "bash", "grep", "find", "ls"],
    timeoutMs: 1_200_000,
  }),
  combiner: RoleConfig.prefault({
    model: { provider: "anthropic", id: "claude-opus-4-8", thinking: "high" },
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    timeoutMs: 1_800_000,
  }),
});

const PipelineConfig = z.object({
  /** Implementer+adversary pairs running at once. */
  concurrency: z.number().int().min(1).max(16).default(3),
  /** Adversarial rounds per unit after the first implementation passes gates. */
  adversaryRounds: z.number().int().min(0).max(5).default(2),
  /** Work units the designer may emit. A larger plan is a planning failure. */
  maxUnits: z.number().int().min(1).max(20).default(6),
  /** Retries when a structured-output agent writes malformed JSON. */
  structuredRetries: z.number().int().min(0).max(5).default(2),
  /**
   * Abort the pipeline between phases once spend crosses this. Zero disables
   * the ceiling, which is not recommended: this topology fans out by design.
   */
  maxCostUsd: z.number().min(0).default(25),
  /** Unresolved findings at or above this severity block the PR. */
  blockingSeverity: z.enum(["low", "medium", "high"]).default("high"),
});

const PullRequestConfig = z.object({
  baseBranch: z.string().min(1).default("main"),
  branchPrefix: z.string().min(1).default("harness/"),
  /** Open the PR as a draft. Recommended while the pipeline earns trust. */
  draft: z.boolean().default(true),
});

// `prefault` (not `default`) runs the missing value back through the schema, so
// an omitted section still picks up each field's own default.
export const HarnessConfigSchema = z.object({
  model: ModelConfig.prefault({}),
  builder: BuilderConfig.prefault({}),
  paths: PathsConfig.prefault({}),
  scope: ScopeConfig.prefault({}),
  roles: RolesConfig.prefault({}),
  pipeline: PipelineConfig.prefault({}),
  pullRequest: PullRequestConfig.prefault({}),
});

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

const GateSpecSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9:-]*$/, "gate id must be kebab-case"),
  /** Human label used in output. */
  label: z.string().min(1).optional(),
  /**
   * Tier orders execution. All gates in a tier run before the next tier starts,
   * and a failing tier short-circuits the rest — cheap checks gate expensive ones.
   */
  tier: z.number().int().min(0).max(9),
  /** `command` shells out; `builtin` runs an in-process check by id. */
  kind: z.enum(["command", "builtin"]).default("command"),
  command: z.string().min(1).optional(),
  /** Directory to run in, relative to the worktree root. */
  cwd: z.string().default("."),
  timeoutMs: z.number().int().positive().default(600_000),
  /** `false` downgrades a failure to a warning that does not block the pipeline. */
  blocking: z.boolean().default(true),
  /**
   * Whether the gate writes to the worktree. Read-only gates in the same tier
   * run concurrently; a mutating gate forces its whole tier to run sequentially.
   */
  mutates: z.boolean().default(false),
  /** Only run when the diff touches a file matching one of these globs. */
  when: z.array(z.string().min(1)).optional(),
  /**
   * Gate enforces agent policy rather than code quality. Skipped by `mx gates`,
   * which runs against a human's working tree where "an agent changed a
   * protected path" is not a meaningful question.
   */
  agentOnly: z.boolean().default(false),
  /** Parser for structured failures. `auto` picks by gate id. */
  parser: z.enum(["auto", "tsc", "biome", "vitest", "pnpm-install", "none"]).default("auto"),
});

export const GatesConfigSchema = z.object({
  /** Applied to every gate unless overridden. */
  defaults: z
    .object({
      timeoutMs: z.number().int().positive().optional(),
    })
    .prefault({}),
  gates: z.array(GateSpecSchema).min(1),
});

export type GateSpec = z.infer<typeof GateSpecSchema>;
export type GatesConfig = z.infer<typeof GatesConfigSchema>;

function readYaml(path: string): unknown {
  const raw = readFileSync(path, "utf8");
  const parsed = parseYaml(raw) as unknown;
  return parsed ?? {};
}

function formatIssues(path: string, error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const at = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `  ${at}: ${issue.message}`;
  });
  return `Invalid config at ${path}:\n${lines.join("\n")}`;
}

export interface LoadedConfig {
  repoRoot: string;
  harness: HarnessConfig;
  gates: GatesConfig;
  /** Absolute paths of the files that produced this config, for audit records. */
  sources: string[];
}

export function loadConfig(repoRoot: string, configDir = "config"): LoadedConfig {
  const root = resolve(repoRoot);
  const harnessPath = join(root, configDir, "harness.yaml");
  const gatesPath = join(root, configDir, "gates.yaml");

  if (!existsSync(gatesPath)) {
    throw new Error(`Missing ${gatesPath}. Gate 0 is mandatory — the harness will not run without it.`);
  }

  const harnessRaw = existsSync(harnessPath) ? readYaml(harnessPath) : {};
  const harnessParsed = HarnessConfigSchema.safeParse(harnessRaw);
  if (!harnessParsed.success) throw new Error(formatIssues(harnessPath, harnessParsed.error));

  const gatesParsed = GatesConfigSchema.safeParse(readYaml(gatesPath));
  if (!gatesParsed.success) throw new Error(formatIssues(gatesPath, gatesParsed.error));

  const gates = gatesParsed.data;
  const ids = new Set<string>();
  for (const gate of gates.gates) {
    if (ids.has(gate.id)) throw new Error(`Duplicate gate id "${gate.id}" in ${gatesPath}`);
    ids.add(gate.id);
    if (gate.kind === "command" && !gate.command) {
      throw new Error(`Gate "${gate.id}" is kind=command but has no command`);
    }
  }

  return {
    repoRoot: root,
    harness: harnessParsed.data,
    gates,
    sources: existsSync(harnessPath) ? [harnessPath, gatesPath] : [gatesPath],
  };
}
