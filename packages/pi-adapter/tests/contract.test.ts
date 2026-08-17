import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkNodeVersion,
  installedPiVersion,
  PI_VERSION,
  RpcClient,
  resolvePiCliPath,
} from "../src/index.ts";

/**
 * These tests exist to make a pi upgrade fail here rather than in a run.
 * Each assertion maps to something the harness actually calls.
 */
describe("pi runtime contract", () => {
  it("resolves the pinned version", () => {
    expect(installedPiVersion()).toBe(PI_VERSION);
  });

  it("resolves a real CLI entry point", () => {
    const cliPath = resolvePiCliPath();
    expect(cliPath.endsWith("cli.js")).toBe(true);
    expect(existsSync(cliPath)).toBe(true);
  });

  it("runs on a Node version pi supports", () => {
    const check = checkNodeVersion();
    expect(check.ok, check.message).toBe(true);
  });

  it("exposes the RpcClient methods the orchestrator depends on", () => {
    const required = [
      "start",
      "stop",
      "onEvent",
      "prompt",
      "promptAndWait",
      "waitForIdle",
      "abort",
      "getState",
      "getSessionStats",
      "getMessages",
      "getLastAssistantText",
      "setModel",
      "setThinkingLevel",
      "setAutoRetry",
      "compact",
      "getStderr",
    ];
    const proto = RpcClient.prototype as unknown as Record<string, unknown>;
    const missing = required.filter((name) => typeof proto[name] !== "function");
    expect(missing).toEqual([]);
  });
});
