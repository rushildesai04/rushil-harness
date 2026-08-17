import { describe, expect, it } from "vitest";
import { checkModelAvailability, type ModelAvailability, missingModelIds } from "../src/index.ts";

describe("checkModelAvailability", () => {
  it("reports a real answer from the installed pi binary", async () => {
    const availability = await checkModelAvailability();
    // Credentials differ per machine, so assert the shape and the invariant
    // that an unavailable result always carries an actionable message.
    expect(typeof availability.available).toBe("boolean");
    if (!availability.available) expect(availability.message).toBeTruthy();
  });
});

describe("missingModelIds", () => {
  const available: ModelAvailability = {
    available: true,
    raw: "anthropic  claude-opus-4-8\nanthropic  claude-fable-5",
  };

  it("finds ids absent from the reachable catalog", () => {
    expect(missingModelIds(available, ["claude-opus-4-8", "claude-ghost-9"])).toEqual(["claude-ghost-9"]);
  });

  it("returns nothing when every id is listed", () => {
    expect(missingModelIds(available, ["claude-opus-4-8", "claude-fable-5"])).toEqual([]);
  });

  it("ignores empty ids, which mean the provider default", () => {
    expect(missingModelIds(available, ["", ""])).toEqual([]);
  });

  it("stays silent when nothing is reachable, since the hard check already failed", () => {
    const none: ModelAvailability = { available: false, raw: "No models available.", message: "x" };
    expect(missingModelIds(none, ["claude-ghost-9"])).toEqual([]);
  });
});
