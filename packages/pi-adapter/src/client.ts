import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RpcClientOptions } from "@earendil-works/pi-coding-agent";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { assertNodeVersion } from "./version.ts";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/**
 * Locate pi's installed package root by walking up from this module.
 *
 * Neither standard resolver works here. pi's exports map declares only an
 * `import` condition and does not expose `./package.json`, so
 * `createRequire().resolve()` throws; and `import.meta.resolve` is undefined
 * under Vitest's module transform, so the contract tests cannot use it. Walking
 * node_modules directly is resolver-independent and works in both.
 */
export function resolvePiPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));

  for (;;) {
    const candidate = join(dir, "node_modules", ...PI_PACKAGE.split("/"));
    if (existsSync(join(candidate, "package.json"))) return candidate;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not locate ${PI_PACKAGE} from ${fileURLToPath(import.meta.url)}. Run \`pnpm install\`.`,
  );
}

/**
 * Resolve pi's CLI entry point.
 *
 * RpcClient defaults `cliPath` to the relative string "dist/cli.js", which only
 * works when the process cwd happens to be pi's package root. Workers run with
 * cwd set to a git worktree, so we always resolve it explicitly.
 */
export function resolvePiCliPath(): string {
  return join(resolvePiPackageRoot(), "dist", "cli.js");
}

/** Version of the pi package actually installed, read from disk. */
export function installedPiVersion(): string {
  const manifest = readFileSync(join(resolvePiPackageRoot(), "package.json"), "utf8");
  return (JSON.parse(manifest) as { version: string }).version;
}

export interface PiSessionOptions {
  /** Working directory for the agent — normally an isolated git worktree. */
  cwd: string;
  /** Provider id, e.g. "anthropic". Omit to use pi's resolved default. */
  provider?: string;
  /** Model id, e.g. "claude-opus-5". Omit to use pi's resolved default. */
  model?: string;
  /** Thinking level passed through to pi. */
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Tool allowlist. Anything not listed is unavailable to the agent. */
  tools?: string[];
  /** Tools to remove from whatever set is otherwise active. */
  excludeTools?: string[];
  /** Disable pi's built-in tools entirely (read/bash/edit/write/...). */
  noBuiltinTools?: boolean;
  /** Where pi should write its session JSONL. Omit for an ephemeral session. */
  sessionPath?: string;
  /** Human-readable session name, surfaced in pi's session list. */
  sessionName?: string;
  /** Extra env for the child process. */
  env?: Record<string, string>;
  /**
   * Override the CLI entry point. Exists so tests can substitute a stub that
   * speaks the RPC protocol; production always resolves the installed pi.
   */
  cliPath?: string;
  /**
   * Skip loading project-local extensions/skills/prompt templates. Default true
   * for harness workers: a task repo must not be able to inject code into the
   * agent that is reviewing it.
   */
  isolateProjectResources?: boolean;
}

function buildArgs(options: PiSessionOptions): string[] {
  const args: string[] = [];

  if (options.thinking) args.push("--thinking", options.thinking);
  if (options.tools?.length) args.push("--tools", options.tools.join(","));
  if (options.excludeTools?.length) args.push("--exclude-tools", options.excludeTools.join(","));
  if (options.noBuiltinTools) args.push("--no-builtin-tools");

  if (options.sessionPath) {
    args.push("--session", options.sessionPath);
  } else {
    args.push("--no-session");
  }
  if (options.sessionName) args.push("--name", options.sessionName);

  if (options.isolateProjectResources !== false) {
    // Extensions and prompt templates are executable surface contributed by the
    // checked-out repo. Skills are left enabled: they are instructions only, and
    // AGENTS.md is loaded regardless. Revisit this split in the policy phase if
    // the harness ever runs against repos we do not control.
    args.push("--no-extensions", "--no-prompt-templates", "--no-themes");
  }

  // Headless workers have no one to answer a project-trust prompt. The worktree
  // is created by the harness from a commit we chose, so trust is already
  // decided by the time the process starts.
  args.push("--approve");

  return args;
}

/**
 * Create (but do not start) a pi RPC client bound to a working directory.
 *
 * We use pi's own RpcClient rather than reimplementing the wire protocol: it
 * already implements strict LF-only JSONL framing, which Node's readline gets
 * wrong by splitting on U+2028/U+2029.
 */
export function createPiSession(options: PiSessionOptions): RpcClient {
  assertNodeVersion();

  const clientOptions: RpcClientOptions = {
    cliPath: options.cliPath ?? resolvePiCliPath(),
    cwd: options.cwd,
    args: buildArgs(options),
  };
  if (options.provider) clientOptions.provider = options.provider;
  if (options.model) clientOptions.model = options.model;
  if (options.env) clientOptions.env = options.env;

  return new RpcClient(clientOptions);
}
