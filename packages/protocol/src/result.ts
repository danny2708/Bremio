import { z } from "zod";
import { TaskIdSchema } from "./task";

/** A finding raised while running or reviewing a task. */
export const FindingSchema = z.object({
  severity: z.enum(["info", "warning", "blocker"]),
  message: z.string().min(1),
  file: z.string().optional(),
  line: z.number().int().nonnegative().optional(),
  /** Whether the finding was later resolved (Phase 2+ quality gate). */
  status: z.enum(["open", "fixed"]).default("open"),
});
export type Finding = z.infer<typeof FindingSchema>;

/** Outcome of a single test command a task ran. */
export const TestRunSchema = z.object({
  command: z.string().min(1),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  exitCode: z.number().int(),
});
export type TestRun = z.infer<typeof TestRunSchema>;

export const TaskStatusSchema = z.enum(["completed", "failed", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** Provider-reported usage only; omitted fields were not reported and are never estimated. */
export const UsageSummarySchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});
export type UsageSummary = z.infer<typeof UsageSummarySchema>;

/**
 * TaskResult — what an agent returns after running one task. Collected by the
 * result-aggregator into the final report. Operational fields (worktree path,
 * branch, logs, timing, error) are optional metadata beyond the abridged shape
 * in docs/03.
 */
export const TaskResultSchema = z.object({
  taskId: TaskIdSchema,
  /** The agent/provider that actually ran the task (may differ from preferred). */
  agentId: z.string().min(1),
  status: TaskStatusSchema,
  summary: z.string(),
  filesChanged: z.array(z.string()).default([]),
  commandsExecuted: z.array(z.string()).default([]),
  tests: z.array(TestRunSchema).default([]),
  findings: z.array(FindingSchema).default([]),
  commitHash: z.string().optional(),
  sessionId: z.string().optional(),
  // --- operational metadata (Bremio-specific, optional) ---
  branch: z.string().optional(),
  worktreePath: z.string().optional(),
  logsPath: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  model: z.string().optional(),
  usage: UsageSummarySchema.optional(),
  error: z.string().optional(),
});
export type TaskResult = z.infer<typeof TaskResultSchema>;
