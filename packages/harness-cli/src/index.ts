#!/usr/bin/env node
import { parseArgs } from "node:util";
import { doctorCommand } from "./commands/doctor.ts";
import { gatesCommand } from "./commands/gates.ts";
import { pipelineCommand } from "./commands/pipeline.ts";
import { runCommand } from "./commands/run.ts";
import { bold, red } from "./ui.ts";

const USAGE = `${bold("mx")} — internal development harness

Usage:
  mx pipeline "<task>" [--base <ref>] [--no-pr] [--quiet]
  mx run "<task>" [--base <ref>] [--keep] [--quiet]
  mx gates [--worktree <path>]
  mx doctor

Commands:
  pipeline  Full multi-agent run: design, parallel implementation, adversarial
            review of every unit, deterministic integration, and a pull request.
  run       Build a task in an isolated worktree, then verify it against the
            quality gates, repairing up to the configured attempt limit.
            Prints the resulting patch to stdout.
  gates     Run the gates against a working tree with no agent involved.
            Use this to develop config/gates.yaml.
  doctor    Check the environment: Node version, pnpm, git, pi runtime,
            model credentials, and config validity.

Options:
  --base <ref>       Base commit or ref for the worktree (default: HEAD)
  --no-pr            Stop after integration; do not push or open a pull request
  --keep             Keep the worktree even when the run passes
  --quiet            Do not stream agent output
  --worktree <path>  Directory to run gates against (default: repo root)
  --repo <path>      Repo root (default: current directory)
`;

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stderr.write(USAGE);
    return command ? 0 : 1;
  }

  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      base: { type: "string" },
      keep: { type: "boolean", default: false },
      "no-pr": { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      worktree: { type: "string" },
      repo: { type: "string" },
    },
  });

  const repoRoot = values.repo ?? process.cwd();

  switch (command) {
    case "pipeline": {
      const task = positionals.join(" ").trim();
      if (!task) {
        process.stderr.write(`${red("mx pipeline requires a task description")}\n\n${USAGE}`);
        return 1;
      }
      return pipelineCommand({
        task,
        repoRoot,
        ...(values.base ? { base: values.base } : {}),
        openPr: values["no-pr"] !== true,
        quiet: values.quiet === true,
      });
    }
    case "run": {
      const task = positionals.join(" ").trim();
      if (!task) {
        process.stderr.write(`${red("mx run requires a task description")}\n\n${USAGE}`);
        return 1;
      }
      return runCommand({
        task,
        ...(values.base ? { base: values.base } : {}),
        keep: values.keep === true,
        quiet: values.quiet === true,
        repoRoot,
      });
    }
    case "gates":
      return gatesCommand({ repoRoot, ...(values.worktree ? { worktree: values.worktree } : {}) });
    case "doctor":
      return doctorCommand(repoRoot);
    default:
      process.stderr.write(`${red(`Unknown command: ${command}`)}\n\n${USAGE}`);
      return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `${red("harness error")} ${error instanceof Error ? error.message : String(error)}\n`,
    );
    if (error instanceof Error && error.stack && process.env.HARNESS_DEBUG) {
      process.stderr.write(`${error.stack}\n`);
    }
    process.exitCode = 1;
  });
