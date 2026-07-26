/**
 * @bremio/protocol — the source of truth for Bremio's data shapes.
 * Zod schemas + inferred types only, no logic. Every other package imports
 * from here; a change here is a breaking change.
 *
 * The three backbone schemas: PlanSchema (what a lead returns),
 * TaskSchema (a unit of work handed off), TaskResult (what an agent returns),
 * plus AgentEvent (the normalized adapter stream).
 */
export {
  TaskSchema,
  TaskIdSchema,
  TaskKindSchema,
  RequiredCapabilitySchema,
  RiskSchema,
  type Task,
  type TaskId,
  type TaskKind,
  type RequiredCapability,
  type Risk,
} from "./task";

export { PlanSchema, type Plan } from "./plan";

export { ExecutionModeSchema, type ExecutionMode } from "./run";

export {
  TaskResultSchema,
  TaskStatusSchema,
  ReasoningLevelSchema,
  FindingSchema,
  TestRunSchema,
  UsageSummarySchema,
  ChangeTypeSchema,
  ChangeSourceSchema,
  TurnFileChangeSchema,
  type TaskResult,
  type TaskStatus,
  type ReasoningLevel,
  type Finding,
  type TestRun,
  type UsageSummary,
  type ChangeType,
  type ChangeSource,
  type TurnFileChange,
} from "./result";

export {
  AgentEventSchema,
  RunOutcomeSchema,
  RunStartedEventSchema,
  MessageEventSchema,
  ThinkingEventSchema,
  ToolUseEventSchema,
  ToolResultEventSchema,
  LogEventSchema,
  UsageEventSchema,
  ErrorEventSchema,
  RunCompletedEventSchema,
  type AgentEvent,
  type AgentEventType,
  type RunOutcome,
} from "./event";

export {
  SessionContextSchema,
  type SessionContext,
} from "./session-context";

export {
  MINIMUM_CLIENT_PROTOCOL,
  PROTOCOL_VERSION,
  checkProtocolCompatibility,
  type ProtocolCompatibility,
} from "./version";

export {
  ActionClassSchema,
  ApprovalRequestStateSchema,
  RiskLevelSchema,
  GrantScopeSchema,
  GrantStatusSchema,
  ActionDigestSchema,
  ApprovalRequestSchema,
  ApprovalDecisionSchema,
  ApprovalGrantSchema,
  CreateApprovalRequestSchema,
  DecideApprovalRequestSchema,
  CreateApprovalGrantSchema,
  type ActionClass,
  type ApprovalRequestState,
  type RiskLevel,
  type GrantScope,
  type GrantStatus,
  type ActionDigest,
  type ApprovalRequest,
  type ApprovalDecision,
  type ApprovalGrant,
  type CreateApprovalRequest,
  type DecideApprovalRequest,
  type CreateApprovalGrant,
} from "./approval";

