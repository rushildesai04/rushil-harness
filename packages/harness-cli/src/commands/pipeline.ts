import { loadConfig } from "@harness/core";
import { runPipeline } from "@harness/orchestrator";
import { bold, dim, formatGateSummary, green, red, yellow } from "../ui.ts";

export interface PipelineArgs {
  task: string;
  repoRoot: string;
  base?: string;
  openPr: boolean;
  quiet: boolean;
}

export async function pipelineCommand(args: PipelineArgs): Promise<number> {
  const loaded = loadConfig(args.repoRoot);
  const { roles, pipeline } = loaded.harness;

  process.stderr.write(`${bold("task")}       ${args.task}\n`);
  process.stderr.write(dim(`base       ${args.base ?? "HEAD"}\n`));
  process.stderr.write(
    dim(
      `roles      design=${roles.designer.model.id ?? "default"} ` +
        `impl=${roles.implementer.model.id ?? "default"} ` +
        `review=${roles.adversary.model.id ?? "default"} ` +
        `combine=${roles.combiner.model.id ?? "default"}\n`,
    ),
  );
  process.stderr.write(
    dim(
      `limits     ${pipeline.concurrency} concurrent · ${pipeline.adversaryRounds} review rounds · ` +
        `$${pipeline.maxCostUsd.toFixed(2)} ceiling\n`,
    ),
  );

  const result = await runPipeline({
    loaded,
    task: args.task,
    ...(args.base ? { baseRef: args.base } : {}),
    openPr: args.openPr,
    ...(args.quiet ? {} : { onText: (delta) => process.stderr.write(dim(delta)) }),
    onPhase: (phase, detail) =>
      process.stderr.write(`\n${bold(`[${phase}]`)}${detail ? ` ${detail}` : ""}\n`),
  });

  process.stderr.write("\n");

  for (const unit of result.units) {
    const mark = unit.status === "passed" ? green("pass") : red("FAIL");
    const raised = unit.reviews.reduce((sum, review) => sum + review.findings.length, 0);
    process.stderr.write(
      `  ${mark}  ${unit.title} ${dim(`(${unit.reviews.length} rounds, ${raised} findings, ${unit.unresolved.length} unresolved)`)}\n`,
    );
    if (unit.reason) process.stderr.write(dim(`        ${unit.reason}\n`));
  }

  if (result.unresolved.length > 0) {
    process.stderr.write(`\n${yellow(`${result.unresolved.length} unresolved finding(s)`)}\n`);
    for (const finding of result.unresolved) {
      const where = finding.file ? ` ${finding.file}${finding.line ? `:${finding.line}` : ""}` : "";
      process.stderr.write(`  ${finding.severity}${where} — ${finding.claim}\n`);
    }
  }

  if (result.integration?.gates && !result.integration.gates.passed) {
    process.stderr.write(`\n${formatGateSummary(result.integration.gates)}\n`);
  }

  process.stderr.write("\n");
  if (result.status === "passed") {
    process.stderr.write(`${green("PASSED")} ${result.units.length} unit(s) integrated\n`);
    if (result.prUrl) process.stderr.write(`${bold("pr")}     ${result.prUrl}\n`);
    else if (result.reason) process.stderr.write(yellow(`note   ${result.reason}\n`));
  } else {
    process.stderr.write(`${red("FAILED")} ${result.reason ?? "pipeline did not complete"}\n`);
  }

  process.stderr.write(dim(`run    ${result.runDir}\n`));
  process.stderr.write(dim(`cost   $${result.costUsd.toFixed(4)}\n`));

  if (result.prUrl) process.stdout.write(`${result.prUrl}\n`);
  return result.status === "passed" ? 0 : 1;
}
