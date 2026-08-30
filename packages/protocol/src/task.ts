import { z } from "zod";

/**
 * A task id. Must be usable inside a git branch name
 * (`bremio/<taskId>-<agent>`), so we constrain to a safe slug.
 * The docs use `TASK-001`; this pattern accepts that and similar.
 */
export const TaskIdSchema = z
  .string()
  .min(1)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "taskId must be a branch-safe slug (letters, digits, '.', '_', '-')",
  );
export type TaskId = z.infer<typeof TaskIdSchema>;

/**
 * What kind of work a task represents. Drives which role/agent fits it.
 * Superset of the docs' examples (analysis, implementation, review).
 */
export const TaskKindSchema = z.enum([
  "analysis",
  "implementation",
  "review",
  "test",
  "documentation",
  "other",
]);
export type TaskKind = z.infer<typeof TaskKindSchema>;

/**
 * Capability *needs* a task declares, expressed as canonical tokens.
 * These map to an adapter's boolean `AgentCapabilities` during validation
 * (see @bremio/orchestrator validator). Kept in sync with docs/02 examples.
 */
export const RequiredCapabilitySchema = z.enum([
  "repository.read",
  "repository.write",
  "shell",
  "test",
  "review",
  "browser",
  "vision",
]);
export type RequiredCapability = z.infer<typeof RequiredCapabilitySchema>;

/** Coarse risk level for the change a task introduces. */
export const RiskSchema = z.enum(["low", "medium", "high"]);
export type Risk = z.infer<typeof RiskSchema>;

/**
 * TaskSchema — the unit of work the orchestrator hands off to an agent.
 * Every lead must emit tasks in exactly this shape; that is what makes
 * lead-swapping possible.
 */
export const TaskSchema = z.object({
  id: TaskIdSchema,
  title: z.string().min(1),
  kind: TaskKindSchema,
  requiredCapabilities: z.array(RequiredCapabilitySchema).default([]),
  /** Provider hints (e.g. "claude", "codex"). The router may override these. */
  preferredAgents: z.array(z.string().min(1)).default([]),
  risk: RiskSchema,
  /** Ids of tasks that must finish before this one. */
  dependencies: z.array(TaskIdSchema).default([]),
  /** Artifacts that this task needs to consume from its dependencies. */
  expectedArtifacts: z.array(z.string().min(1)).default([]),
  acceptanceCriteria: z.array(z.string().min(1)).default([]),
  /**
   * Optional richer context for the worker's prompt. Not required by the
   * contract (both leads may omit it), so the shape still matches the docs.
   */
  description: z.string().optional(),
});
export type Task = z.infer<typeof TaskSchema>;

export const MicrotaskProposalSchema = z.object({
  id: TaskIdSchema,
  title: z.string().min(1),
  description: z.string().optional(),
  kind: TaskKindSchema.optional().default("implementation"),
  requiredCapabilities: z.array(RequiredCapabilitySchema).default([]),
  dependencies: z.array(TaskIdSchema).default([]),
  expectedArtifacts: z.array(z.string().min(1)).default([]),
  acceptanceCriteria: z.array(z.string().min(1)).default([]),
});
export type MicrotaskProposal = z.infer<typeof MicrotaskProposalSchema>;

