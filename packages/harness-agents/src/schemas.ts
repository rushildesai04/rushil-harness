import { z } from "zod";

/**
 * Schemas for every structured handoff between agents.
 *
 * pi has no forced-schema tool call, so agents write JSON to a file and the
 * harness validates it here. That is deliberate: prose handoffs between agents
 * are where multi-agent pipelines silently lose information, and a schema
 * violation is a retry rather than a corrupted downstream phase.
 */

export const WorkUnitSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "unit id must be kebab-case"),
  title: z.string().min(1).max(120),
  /** What to build, in enough detail that an implementer needs no other context. */
  brief: z.string().min(1),
  /**
   * Globs this unit owns. Two units claiming the same path is the single
   * biggest source of merge conflicts, so the planner is held to disjointness.
   */
  files: z.array(z.string().min(1)).min(1),
  /** Unit ids that must land before this one starts. */
  dependsOn: z.array(z.string().min(1)).default([]),
  /** How the implementer proves it works. Feeds the adversary's checklist. */
  acceptance: z.array(z.string().min(1)).min(1),
});

export type WorkUnit = z.infer<typeof WorkUnitSchema>;

export const PlanSchema = z.object({
  /** One paragraph: the approach and why it beats the alternatives considered. */
  summary: z.string().min(1),
  /** Decisions an implementer must not relitigate. */
  constraints: z.array(z.string().min(1)).default([]),
  /** Named risks the adversaries should probe hardest. */
  risks: z.array(z.string().min(1)).default([]),
  units: z.array(WorkUnitSchema).min(1),
});

export type Plan = z.infer<typeof PlanSchema>;

export const SeveritySchema = z.enum(["low", "medium", "high"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const FindingSchema = z.object({
  id: z.string().min(1),
  severity: SeveritySchema,
  file: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
  /** The defect, stated as a claim that can be proven wrong. */
  claim: z.string().min(1),
  /** Concrete inputs or state that trigger it. Vague findings are noise. */
  reproduction: z.string().min(1),
  /** Whether the adversary actually executed something to confirm it. */
  verifiedByExecution: z.boolean(),
});

export type Finding = z.infer<typeof FindingSchema>;

export const ReviewSchema = z.object({
  /** True only when the adversary found nothing it can defend. */
  approved: z.boolean(),
  /** What was checked, so an empty finding list is legible rather than suspicious. */
  coverage: z.array(z.string().min(1)).min(1),
  findings: z.array(FindingSchema).default([]),
});

export type Review = z.infer<typeof ReviewSchema>;

export const RebuttalSchema = z.object({
  findingId: z.string().min(1),
  action: z.enum(["fixed", "disputed"]),
  /** For `fixed`, what changed. For `disputed`, why the claim is wrong. */
  explanation: z.string().min(1),
});

export type Rebuttal = z.infer<typeof RebuttalSchema>;

export const ResponseSchema = z.object({
  rebuttals: z.array(RebuttalSchema).default([]),
});

export type Response = z.infer<typeof ResponseSchema>;

/** A finding that survived the debate, carried into the PR body. */
export interface UnresolvedFinding extends Finding {
  unitId: string;
  round: number;
  disputedReason?: string;
}
