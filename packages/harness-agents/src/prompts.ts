import type { GateRunSummary } from "@harness/core";
import { formatFailuresForRepair } from "@harness/gates";
import type { Finding, Plan, Review, WorkUnit } from "./schemas.ts";

/**
 * Every prompt states the verification contract, because the deterministic
 * gates are what make agent claims irrelevant. An agent that knows its report
 * is not read has no incentive to shade it.
 */
const CONTRACT = `## Verification contract

The harness re-runs every quality gate itself after you stop, in your working
directory. Your account of the outcome changes nothing — only real exit codes do.

Enforced deterministically on the diff after your turn:
- No \`.skip\`, \`.only\`, \`.todo\`, \`xit\`, or \`xdescribe\` added to tests.
- No \`@ts-ignore\`, \`@ts-expect-error\`, \`biome-ignore\`, or \`eslint-disable\` added.
- No test deleted or weakened to make it pass. Fix the code under test.
- No credentials committed.
- No edits outside the files this unit owns.

Do not run \`git commit\`, \`git push\`, or anything that moves branch state. The
harness commits on your behalf.`;

export function designPrompt(task: string, maxUnits: number): string {
  return `# Design

${task}

You are designing, not implementing. Your tools are read-only; use them to
understand the codebase before committing to an approach.

Produce a plan that decomposes the work into at most ${maxUnits} units that can be
implemented independently and in parallel by separate agents that will not see
each other's work.

What makes this plan good or bad:
- **Disjoint file ownership.** Two units claiming the same path is the single
  largest source of merge conflicts downstream. If two pieces of work genuinely
  need the same file, they are one unit, or one depends on the other.
- **Self-contained briefs.** Each implementer sees its brief and the repository.
  It does not see this task description, the other units, or your reasoning. A
  brief that assumes shared context produces a unit that does not integrate.
- **Falsifiable acceptance criteria.** "Works correctly" is unusable. "Returns
  null when the lockfile is absent, covered by a test" is checkable, and an
  adversarial reviewer will hold the implementer to exactly what you write.
- **Honest dependencies.** Use \`dependsOn\` when a unit truly cannot start until
  another lands. Every dependency serialises the pipeline, so do not add one to
  express a preference about ordering.

State the constraints an implementer must not relitigate, and name the risks
where this design is most likely to be wrong — the adversarial reviewers are
pointed at those first.`;
}

export function implementPrompt(unit: WorkUnit, plan: Plan): string {
  return `# Implement: ${unit.title}

${unit.brief}

## Files this unit owns

${unit.files.map((f) => `- \`${f}\``).join("\n")}

Changes outside these paths fail the scope gate. If the work genuinely cannot be
done within them, stop and say so rather than expanding the diff.

## Acceptance criteria

${unit.acceptance.map((a) => `- ${a}`).join("\n")}

An adversarial reviewer will check each of these against the code you write, and
will run it. Criteria met by a test that does not actually exercise the behaviour
will be found.

## Design constraints

${plan.constraints.length > 0 ? plan.constraints.map((c) => `- ${c}`).join("\n") : "- None specified."}

## Context

${plan.summary}

You are one of several agents working in parallel on separate parts of this
change, each in its own worktree. You cannot see their work and they cannot see
yours. Do not stub, mock, or reimplement what another unit owns — code against
the interfaces described in your brief.

${CONTRACT}`;
}

export function repairPrompt(summary: GateRunSummary, attempt: number, maxAttempts: number): string {
  return `# Quality gates failed (repair ${attempt} of ${maxAttempts})

Real exit codes and parsed diagnostics from the harness:

${formatFailuresForRepair(summary)}

Fix the root cause of each. The same gates run again immediately after you stop,
and the contract still applies — a suppression or a skipped test fails a
different gate rather than passing this one.`;
}

export function adversaryPrompt(unit: WorkUnit, plan: Plan, patch: string, round: number): string {
  return `# Adversarial review (round ${round}): ${unit.title}

Your job is to find what is wrong with this change. You are not a second opinion
and you are not here to approve it. Assume the implementation is subtly broken
and go find where.

The code is checked out in your working directory. You have \`bash\`. Use it —
run the tests, run the code, feed it inputs the implementer did not consider. A
finding you have not executed is a guess, and you must mark it as such.

## What the unit was supposed to do

${unit.brief}

## Acceptance criteria it claims to meet

${unit.acceptance.map((a) => `- ${a}`).join("\n")}

Check each one against the code, not against the tests alone. A test that
asserts the implementation's current behaviour proves nothing.

## Design risks flagged up front

${plan.risks.length > 0 ? plan.risks.map((r) => `- ${r}`).join("\n") : "- None flagged."}

## The change

\`\`\`diff
${patch}
\`\`\`

## What counts as a finding

Report a defect only when you can state the inputs or state that trigger it and
what goes wrong as a result. Specifically look for:
- Behaviour that diverges from the brief or an acceptance criterion.
- Error paths, empty inputs, boundary values, and concurrency the code ignores.
- Tests that pass without exercising the behaviour they name.
- Resource leaks, unhandled rejections, and swallowed errors.
- Security-relevant handling of input, paths, credentials, and subprocesses.

Do not report style preferences, naming, formatting, or speculative refactors.
The linter and formatter already ran and passed. Severity \`high\` means the
change is wrong or unsafe, not that you would have written it differently.

Set \`approved\` to true only if you found nothing you are prepared to defend.
List what you actually checked in \`coverage\` either way — an empty finding list
is only credible alongside evidence of the attempt.`;
}

export function responsePrompt(findings: Finding[], round: number): string {
  return `# Adversarial review found ${findings.length} issue(s) (round ${round})

An independent reviewer examined your change. For each finding: either fix it,
or dispute it with a concrete reason it is wrong. Disputing is a legitimate
answer — the reviewer is adversarial by design and will sometimes be incorrect.
An unjustified fix that changes working code is worse than a defended dispute.

${findings
  .map(
    (f) =>
      `## ${f.id} — ${f.severity}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}\n` +
      `${f.verifiedByExecution ? "Reviewer executed this." : "Reviewer did NOT execute this; it may be wrong."}\n\n` +
      `**Claim:** ${f.claim}\n\n**Reproduction:** ${f.reproduction}`,
  )
  .join("\n\n")}

Fix what is real, then record one entry per finding id. The gates run again
after you stop, so a fix that breaks something else will come straight back.`;
}

// No patch parameter: a re-review is about the code as it now stands in the
// worktree, and handing back the original diff invites re-litigating it.
export function recheckPrompt(review: Review, round: number): string {
  const disputed = review.findings.filter((f) => f.severity !== "low");
  return `# Re-review (round ${round})

The implementer responded to your findings. Some were fixed, some disputed.
Check the current state of the code, which is in your working directory.

Previously raised:
${disputed.map((f) => `- ${f.id} (${f.severity}): ${f.claim}`).join("\n")}

For each: is it actually resolved in the code as it now stands? A dispute you
find convincing should not be re-reported. A "fix" that only suppresses the
symptom should be reported again, at the same or higher severity.

Then look once more for defects introduced by the fixes themselves — repair
rounds are where regressions get in.`;
}

export function combinePrompt(conflicts: string[], units: WorkUnit[]): string {
  return `# Resolve merge conflicts

Independently developed units are being merged into one branch and ${conflicts.length}
file(s) conflict. Your working directory is mid-merge with conflict markers in place.

Conflicted files:
${conflicts.map((f) => `- \`${f}\``).join("\n")}

Units in this integration:
${units.map((u) => `- **${u.title}** owns ${u.files.map((f) => `\`${f}\``).join(", ")}`).join("\n")}

Resolve each conflict so both units' intent survives. Do not pick a side to make
the markers go away — a resolution that silently drops one unit's behaviour is
the failure mode here, and it will not be obvious in review.

Remove every conflict marker. Do not run \`git commit\`, \`git merge --continue\`,
or \`git add\`; the harness completes the merge once the full gate suite passes on
the integrated tree.`;
}
