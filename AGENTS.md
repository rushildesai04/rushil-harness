# Repository conventions

pi loads this file into every agent session started in this repo. Keep it short
and factual — it is context, not documentation.

## Stack

TypeScript on Node 22 (see `.nvmrc`), pnpm workspaces, ESM only. Biome for
format and lint. Vitest for tests. `tsc -b` builds project references.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm exec tsc -b --pretty false      # typecheck + build
pnpm exec biome ci .                 # format + lint, no writes
pnpm exec vitest run                 # tests
```

## Layout

| Package | Role |
|---|---|
| `pi-adapter` | The only place `@earendil-works/*` may be imported. Pins the pi version. |
| `harness-core` | Config schemas, run store, shared types. No I/O beyond files. |
| `harness-gates` | Gate execution, output parsers, in-process checks. |
| `harness-agents` | Role prompts, structured-output schemas, plan validation. |
| `harness-orchestrator` | Worktrees, pi workers, repair loop, pipeline, integration, PR. |
| `harness-cli` | `mx` entry point. |

## Rules

- Import pi only through `@harness/pi-adapter`. A direct `@earendil-works/*`
  import anywhere else is a bug regardless of whether it compiles.
- Validate external input (config files, tool output, subprocess results) at the
  boundary with zod; downstream code assumes valid data.
- Keep files under 500 lines.
- Never write to `.harness/` from application code — the run store owns it.
- Explicit `.ts` extensions on relative imports (nodenext resolution).
