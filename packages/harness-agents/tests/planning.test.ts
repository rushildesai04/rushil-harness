import { describe, expect, it } from "vitest";
import { assertDisjointUnits, orderUnits } from "../src/planning.ts";
import type { WorkUnit } from "../src/schemas.ts";

function unit(id: string, files: string[], dependsOn: string[] = []): WorkUnit {
  return { id, title: id, brief: "b", files, dependsOn, acceptance: ["a"] };
}

describe("assertDisjointUnits", () => {
  it("accepts units owning distinct paths", () => {
    expect(() =>
      assertDisjointUnits([unit("a", ["packages/a/**"]), unit("b", ["packages/b/**"])]),
    ).not.toThrow();
  });

  it("rejects identical claims", () => {
    expect(() => assertDisjointUnits([unit("a", ["src/x.ts"]), unit("b", ["src/x.ts"])])).toThrow(
      /overlapping file ownership/,
    );
  });

  it("rejects a glob that swallows another unit's file", () => {
    // Neither string contains the other, so a substring check would miss this.
    expect(() => assertDisjointUnits([unit("a", ["src/**"]), unit("b", ["src/deep/x.ts"])])).toThrow(
      /both claim/,
    );
  });
});

describe("orderUnits", () => {
  it("puts independent units in a single wave", () => {
    const waves = orderUnits([unit("a", ["a"]), unit("b", ["b"]), unit("c", ["c"])]);
    expect(waves).toHaveLength(1);
    expect(waves[0]).toHaveLength(3);
  });

  it("serialises dependents into later waves", () => {
    const waves = orderUnits([unit("c", ["c"], ["b"]), unit("a", ["a"]), unit("b", ["b"], ["a"])]);
    expect(waves.map((wave) => wave.map((u) => u.id))).toEqual([["a"], ["b"], ["c"]]);
  });

  it("keeps siblings of a dependency in the same wave", () => {
    const waves = orderUnits([unit("a", ["a"]), unit("b", ["b"]), unit("c", ["c"], ["a"])]);
    expect(waves[0]?.map((u) => u.id).sort()).toEqual(["a", "b"]);
    expect(waves[1]?.map((u) => u.id)).toEqual(["c"]);
  });

  it("rejects an unknown dependency", () => {
    expect(() => orderUnits([unit("a", ["a"], ["ghost"])])).toThrow(/unknown unit "ghost"/);
  });

  it("rejects a cycle instead of deadlocking", () => {
    expect(() => orderUnits([unit("a", ["a"], ["b"]), unit("b", ["b"], ["a"])])).toThrow(/Dependency cycle/);
  });
});
