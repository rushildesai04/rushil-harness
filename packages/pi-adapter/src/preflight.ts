import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolvePiCliPath } from "./client.ts";

const execFileAsync = promisify(execFile);

export interface ModelAvailability {
  available: boolean;
  /** Raw `--list-models` output, shown verbatim on failure. */
  raw: string;
  message?: string;
}

/**
 * Ask pi what models the current credentials can actually reach.
 *
 * This is a capability probe, not a guess about files on disk. Without it a
 * credential-less run spawns an agent that never answers and the pipeline waits
 * out the full turn timeout — twenty minutes to discover something knowable in
 * two seconds.
 *
 * `--list-models` exits 0 either way, so the outcome is read from its output.
 */
export async function checkModelAvailability(timeoutMs = 60_000): Promise<ModelAvailability> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [resolvePiCliPath(), "--list-models"], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    const raw = `${stdout}${stderr}`.trim();

    if (/no models available/i.test(raw) || raw.length === 0) {
      return {
        available: false,
        raw,
        message: "pi reports no models available. Run `pi` and use /login, or export ANTHROPIC_API_KEY.",
      };
    }
    return { available: true, raw };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { available: false, raw: detail, message: `Could not query pi for models: ${detail}` };
  }
}

/**
 * Warn when a pinned model id is absent from the reachable catalog.
 *
 * Deliberately not a hard failure: `--list-models` output is a human-facing
 * listing whose format is not contractual, so treating a missed substring as
 * fatal would break runs over a formatting change upstream.
 */
export function missingModelIds(availability: ModelAvailability, ids: string[]): string[] {
  if (!availability.available) return [];
  return [...new Set(ids)].filter((id) => id.length > 0 && !availability.raw.includes(id));
}
