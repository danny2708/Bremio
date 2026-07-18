import { z } from "zod";
import { ReasoningLevelSchema, TaskStatusSchema } from "./result";

/**
 * AgentEvent — the normalized streaming protocol every adapter emits from
 * `startRun`. Provider-specific streams (Claude Agent SDK `SDKMessage`s,
 * `codex exec --json` JSONL) are mapped into this union so the orchestrator
 * and the log writer never depend on a provider's wire format.
 *
 * Every event carries the orchestrator-assigned `runId` and an epoch-ms `ts`.
 * A well-behaved stream ends with exactly one `completed` event.
 */

const base = {
  runId: z.string().min(1),
  ts: z.number().int().nonnegative(),
};

/** The run has begun on the adapter side. */
export const RunStartedEventSchema = z.object({
  type: z.literal("started"),
  ...base,
});

/** A chunk of assistant-visible output text. */
export const MessageEventSchema = z.object({
  type: z.literal("message"),
  ...base,
  role: z.literal("assistant"),
  text: z.string(),
});

/** A reasoning/thinking chunk (may be summarized or empty depending on model). */
export const ThinkingEventSchema = z.object({
  type: z.literal("thinking"),
  ...base,
  text: z.string(),
});

/** The agent invoked a tool (Read/Write/Edit/Bash/etc.). */
export const ToolUseEventSchema = z.object({
  type: z.literal("tool_use"),
  ...base,
  name: z.string(),
  input: z.unknown().optional(),
});

/** A tool finished. */
export const ToolResultEventSchema = z.object({
  type: z.literal("tool_result"),
  ...base,
  name: z.string(),
  ok: z.boolean(),
  /** Provider-reported process exit code when the tool was a shell command. */
  exitCode: z.number().int().optional(),
  detail: z.string().optional(),
});

/** A free-form adapter log line (also persisted to the task's log file). */
export const LogEventSchema = z.object({
  type: z.literal("log"),
  ...base,
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string(),
});

/**
 * Optional incremental token-usage signal. Multiple events in one run are
 * additive; adapters receiving cumulative provider counters must emit only the
 * final value or convert them to deltas.
 */
export const UsageEventSchema = z.object({
  type: z.literal("usage"),
  ...base,
  /** Provider-confirmed model id when the stream exposes it. */
  model: z.string().min(1).optional(),
  /** Provider-confirmed reasoning level, never inferred from the request. */
  reasoningLevel: ReasoningLevelSchema.optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});

/** A non-fatal or fatal error surfaced by the adapter. */
export const ErrorEventSchema = z.object({
  type: z.literal("error"),
  ...base,
  message: z.string(),
  fatal: z.boolean().default(false),
});

/** The final outcome of a run. */
export const RunOutcomeSchema = z.object({
  status: TaskStatusSchema,
  /** The agent's final message text (e.g. the lead's plan JSON, raw). */
  finalText: z.string().optional(),
  /** A pre-parsed structured payload, if the provider produced one natively. */
  structured: z.unknown().optional(),
  /** Provider session id, for resume (Phase 2+). */
  sessionId: z.string().optional(),
  error: z.string().optional(),
});
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

/** Terminal event; carries the run outcome. */
export const RunCompletedEventSchema = z.object({
  type: z.literal("completed"),
  ...base,
  outcome: RunOutcomeSchema,
});

export const AgentEventSchema = z.discriminatedUnion("type", [
  RunStartedEventSchema,
  MessageEventSchema,
  ThinkingEventSchema,
  ToolUseEventSchema,
  ToolResultEventSchema,
  LogEventSchema,
  UsageEventSchema,
  ErrorEventSchema,
  RunCompletedEventSchema,
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

/** Discriminated helper types for consumers that switch on `event.type`. */
export type AgentEventType = AgentEvent["type"];
