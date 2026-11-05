import { z } from "zod";

/**
 * Normalized provider failure codes (P2-T1, docs/17).
 *
 * The classification itself lives in `@bremio/adapter-sdk` (`classifyAgentError`);
 * the vocabulary lives here so a `RunOutcome` can carry it across the
 * adapter → orchestrator → daemon boundary. Loop decisions (fix, re-plan,
 * retry) switch on these codes and never on provider message strings.
 */
export const AgentErrorCodeSchema = z.enum([
  "rate_limited",
  "authentication_failed",
  "quota_exhausted",
  "provider_unavailable",
  "timeout",
  "cancelled",
  "session_not_found",
  "execution_failed",
  "unknown",
]);
export type AgentErrorCode = z.infer<typeof AgentErrorCodeSchema>;

/**
 * Why a task did not complete. A superset of `AgentErrorCode`: the extra
 * codes are Bremio's own judgements about otherwise-successful provider runs
 * (a test command that exited non-zero, a review that could not be parsed, a
 * dependency that never succeeded).
 */
export const TaskFailureCodeSchema = z.enum([
  ...AgentErrorCodeSchema.options,
  "verification_failed",
  "verification_missing",
  "review_invalid",
  "blocked_by_dependency",
  "missing_artifact",
  "setup_failed",
  "no_adapter",
]);
export type TaskFailureCode = z.infer<typeof TaskFailureCodeSchema>;
