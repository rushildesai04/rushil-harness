import { globMatcher } from "@harness/core";
import type { WorkUnit } from "./schemas.ts";

export type UnitWave = WorkUnit[];

/**
 * Reject a plan whose units claim overlapping paths.
 *
 * Overlap is checked before a single implementer starts, because the cost of
 * discovering it at merge time is every unit's tokens. The check is glob-aware
 * in both directions: `src/a.ts` and `src/**` overlap even though neither string
 * contains the other.
 */
export function assertDisjointUnits(units: WorkUnit[]): void {
  const problems: string[] = [];

  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      const a = units[i];
      const b = units[j];
      if (!a || !b) continue;

      const aMatches = globMatcher(a.files);
      const bMatches = globMatcher(b.files);
      const overlap = [
        ...a.files.filter((file) => bMatches(file)),
        ...b.files.filter((file) => aMatches(file)),
      ];
      if (overlap.length > 0) {
        problems.push(`"${a.id}" and "${b.id}" both claim ${[...new Set(overlap)].join(", ")}`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`Plan has overlapping file ownership:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  }
}

/**
 * Group units into dependency-ordered waves.
 *
 * Everything in a wave runs concurrently; the next wave starts only once the
 * previous one is merged. A cycle is a planner error and fails loudly rather
 * than deadlocking the pool.
 */
export function orderUnits(units: WorkUnit[]): UnitWave[] {
  const byId = new Map(units.map((unit) => [unit.id, unit]));

  for (const unit of units) {
    for (const dependency of unit.dependsOn) {
      if (!byId.has(dependency)) {
        throw new Error(`Unit "${unit.id}" depends on unknown unit "${dependency}".`);
      }
    }
  }

  const waves: UnitWave[] = [];
  const settled = new Set<string>();
  let remaining = [...units];

  while (remaining.length > 0) {
    const ready = remaining.filter((unit) => unit.dependsOn.every((id) => settled.has(id)));
    if (ready.length === 0) {
      throw new Error(
        `Dependency cycle among units: ${remaining.map((u) => u.id).join(", ")}. Fix the plan.`,
      );
    }
    waves.push(ready);
    for (const unit of ready) settled.add(unit.id);
    remaining = remaining.filter((unit) => !settled.has(unit.id));
  }

  return waves;
}
