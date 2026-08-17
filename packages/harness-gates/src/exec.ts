import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 256 * 1024;

export interface ExecResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  truncated: boolean;
  durationMs: number;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
}

/**
 * Run a shell command and capture combined output.
 *
 * Gate commands are user-authored shell strings, so we run them through a shell
 * in a detached process group. Killing the group matters: `pnpm -r test` spawns
 * children that outlive a plain SIGTERM to the parent and would leak past the
 * gate timeout.
 */
export function execCommand(command: string, options: ExecOptions): Promise<ExecResult> {
  const startedAt = Date.now();

  return new Promise<ExecResult>((resolvePromise) => {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // Deterministic, parseable tool output.
        CI: "1",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        ...options.env,
      },
    });

    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const collect = (chunk: Buffer): void => {
      if (bytes >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      const room = MAX_OUTPUT_BYTES - bytes;
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
      chunks.push(slice);
      bytes += slice.length;
      if (slice.length < chunk.length) truncated = true;
    };

    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        // Process group already gone.
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      // Escalate if the group ignores SIGTERM.
      setTimeout(() => killGroup("SIGKILL"), 5_000).unref();
    }, options.timeoutMs);

    const settle = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        exitCode,
        signal,
        output: Buffer.concat(chunks).toString("utf8"),
        truncated,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    };

    child.on("error", (error) => {
      chunks.push(Buffer.from(`\nharness: failed to spawn command: ${error.message}\n`));
      settle(null, null);
    });
    child.on("close", (code, signal) => settle(code, signal));
  });
}
