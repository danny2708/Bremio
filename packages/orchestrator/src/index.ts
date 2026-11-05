/**
 * @bremio/orchestrator — provider-agnostic core: lead-manager, validator,
 * router, sequential scheduler, and result-aggregator. Knows nothing about any
 * specific provider; it talks only to the AgentAdapter contract.
 */
export { runBremio, createRunId, type RunBremioOptions, type RunBremioHooks } from "./run";
export {
  runSingleAgent,
  type RunSingleAgentOptions,
  type SingleAgentResult,
  type SingleRunHooks,
  type SingleRunReport,
  type SingleRunFallback,
  type SingleRunVerification,
  shouldEscalate,
  resolveEscalationApproval,
  type EscalationApproval,
} from "./single-run";
export { createRegistry, type AgentRegistry } from "./registry";

export {
  createPlan,
  parsePlan,
  extractJsonObject,
  LeadPlanError,
  type CreatePlanOptions,
  type CreatePlanResult,
} from "./lead-manager";

export { validatePlan, capabilityHolds, PlanValidationError } from "./validator";

export {
  assignAgents,
  CapacityRoutingError,
  topologicalOrder,
  roleForKind,
  permissionForKind,
  routingInputFromConfig,
  scoringFromConfig,
  type AssignAgentsOptions,
  type ScoringConfig,
} from "./router";

export {
  loadRoutingConfig,
  getDefaultRoutingConfig,
  type RoutingConfig,
} from "./routing-config";

export {
  DEFAULT_MAX_CONCURRENCY,
  runPlan,
  type RunPlanOptions,
  type SchedulerHooks,
} from "./scheduler";

export {
  buildReport,
  type BremioRunReport,
  type RunReport,
  type RunReportTask,
  type BuildReportInput,
} from "./aggregator";

export {
  planJsonSchema,
  buildPlanningPrompt,
  buildTaskPrompt,
  buildRepairPrompt,
  LEAD_SYSTEM_PROMPT,
} from "./plan-schema";

export { collectRun, withErrorCode, type CollectedRun } from "./stream";

export {
  DEFAULT_MAX_FIX_ITERATIONS,
  evaluateGateWithFixes,
  fixLoopPolicyBlock,
  fixLoopStopReason,
  planFixIteration,
  runTeamFixLoop,
  type FixIterationRecord,
  type FixLoopReport,
  type FixLoopStatus,
} from "./fix-loop";

export {
  evaluateDefinitionOfDone,
  evaluateSingleDefinitionOfDone,
  type DefinitionOfDone,
  type DoneCriterion,
  type DoneVerification,
} from "./definition-of-done";

export {
  applyPlanCheckpoint,
  planDigest,
  PlanCheckpointError,
  type OnPlanReady,
  type PlanCheckpointDecision,
  type PlanCheckpointRecord,
} from "./plan-checkpoint";

export {
  runSingleVerifyLoop,
  runVerification,
  verificationPolicyBlock,
  type SingleFixAttempt,
  type SingleFixLoopReport,
  type VerificationRun,
} from "./single-fix-loop";

export {
  evaluateQualityGate,
  parseReviewOutput,
  reviewOutputJsonSchema,
  type QualityGateResult,
  type QualityGateTask,
  type ReviewParseResult,
} from "./quality-gate";

export {
  appendLedgerEntry,
  readLedger,
  readLedgerSync,
  computeStats,
  ledgerPathFor,
  LedgerEntrySchema,
  type LedgerEntry,
  type LedgerStats,
  type ProviderStats,
  type ReadLedgerOptions,
} from "./ledger";

export {
  resolveAutoMode,
  type AutoModePolicy,
  type AutoModeResult,
  DEFAULT_AUTO_MODE_POLICY,
} from "./auto-mode";
export {
  computeNetGain,
  findBestSingleAgentBaseline,
  summarizeNetGain,
  aggregateNetGain,
  formatNetGain,
  type KnownNetGain,
  type UnknownNetGain,
  type NetGainResult,
  type KnownSingleBaseline,
  type UnknownSingleBaseline,
  type SingleBaselineResult,
  type KnownNetGainAggregate,
  type UnknownNetGainAggregate,
  type NetGainAggregate,
  type ComparisonNetGain,
  type NetGainSummary,
} from "./net-gain";

export {
  DEFAULT_CALIBRATION_POLICY,
  evaluateCalibrationReadiness,
  resolveCalibrationPolicy,
  type CalibrationPolicy,
  type CalibrationPolicyInput,
  type CalibrationReadiness,
} from "./calibration";

export {
  listReports,
  loadReportByRunId,
  findTaskAcrossReports,
  type StoredReport,
  type StoredTeamReport,
} from "./reports";

export {
  RuntimeGuardEvaluator,
  type GuardConfig,
} from "./runtime-guard";
