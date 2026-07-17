/**
 * @bremio/orchestrator — provider-agnostic core: lead-manager, validator,
 * router, sequential scheduler, and result-aggregator. Knows nothing about any
 * specific provider; it talks only to the AgentAdapter contract.
 */
export { runBremio, createRunId, type RunBremioOptions, type RunBremioHooks } from "./run";
export { createRegistry, type AgentRegistry } from "./registry";

export {
  createPlan,
  parsePlan,
  extractJsonObject,
  LeadPlanError,
  type CreatePlanOptions,
  type CreatePlanResult,
} from "./lead-manager";

export { validatePlan, PlanValidationError } from "./validator";

export {
  assignAgents,
  topologicalOrder,
  roleForKind,
  permissionForKind,
} from "./router";

export { runPlan, type RunPlanOptions, type SchedulerHooks } from "./scheduler";

export {
  buildReport,
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

export { collectRun, type CollectedRun } from "./stream";
