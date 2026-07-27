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

/** Provider-neutral reasoning levels supported by both current lead adapters. */
export const ReasoningLevelSchema = z.enum(["low", "medium", "high", "xhigh"]);
export type ReasoningLevel = z.infer<typeof ReasoningLevelSchema>;

/** Provider-reported usage only; omitted fields were not reported and are never estimated. */
export const UsageSummarySchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});
export type UsageSummary = z.infer<typeof UsageSummarySchema>;

/** How a file was affected during a turn. */
export const ChangeTypeSchema = z.enum(["read", "write", "create", "delete"]);
export type ChangeType = z.infer<typeof ChangeTypeSchema>;

/** Where change evidence came from. */
export const ChangeSourceSchema = z.enum(["git", "event"]);
export type ChangeSource = z.infer<typeof ChangeSourceSchema>;

/** Who we attribute the change to. */
export const AttributionSchema = z.enum(["agent", "user"]);
export type Attribution = z.infer<typeof AttributionSchema>;

/** Git diff output — stat (summary) and patch (full diff). */
export const DiffResultSchema = z.object({
  stat: z.string(),
  patch: z.string(),
});
export type DiffResult = z.infer<typeof DiffResultSchema>;

/** A single file operation recorded during a turn, with provenance. */
export const TurnFileChangeSchema = z.object({
  filePath: z.string(),
  changeType: ChangeTypeSchema,
  source: ChangeSourceSchema,
  /** Whether the agent or the user caused this change. */
  attributedTo: AttributionSchema,
});
export type TurnFileChange = z.infer<typeof TurnFileChangeSchema>;

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
  /** Files the agent read during this task (from tool_use events). */
  filesRead: z.array(z.string()).default([]),
  /** Aggregated change ledger with provenance labels. */
  changeLedger: z.array(TurnFileChangeSchema).default([]),
  /** Git diff (stat + patch) for the changes this task made. */
  diff: DiffResultSchema.optional(),
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
  requestedModel: z.string().min(1).optional(),
  actualModel: z.string().min(1).optional(),
  requestedReasoningLevel: ReasoningLevelSchema.optional(),
  actualReasoningLevel: ReasoningLevelSchema.optional(),
  usage: UsageSummarySchema.optional(),
  error: z.string().optional(),
});
export type TaskResult = z.infer<typeof TaskResultSchema>;
