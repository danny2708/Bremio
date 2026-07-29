/**
 * @bremio/adapter-sdk — the contract a provider adapter implements, plus the
 * value types it exchanges with the orchestrator. Core depends on this; it
 * never depends on a specific adapter package.
 */
export {
  AgentCapabilitiesSchema,
  AgentRoleSchema,
  PermissionSchema,
  ReadOnlyEnforcementSchema,
  AdapterRuntimeCapabilitiesSchema,
  AdapterTransportSchema,
  ApprovalSeamSchema,
  ContextMetricsQualitySchema,
  type AgentCapabilities,
  type AgentRole,
  type Permission,
  type ReadOnlyEnforcement,
  type AdapterRuntimeCapabilities,
  type AdapterTransport,
  type ApprovalSeam,
  type ContextMetricsQuality,
} from "./capabilities";

export {
  AgentHealthSchema,
  ModelDescriptorSchema,
  type AgentHealth,
  type ModelDescriptor,
  type AgentRunRequest,
} from "./types";

export type { AgentAdapter, AgentPluginManifest, AgentToolVocabulary } from "./adapter";

export {
  boundedRetryPolicy,
  classifyAgentError,
  isRetryableCode,
  type AgentError,
  type AgentErrorCode,
  type BoundedRetryOptions,
  type RetryPolicy,
} from "./errors";

export {
  ProcessSupervisor,
  collectTree,
  pidAlive,
  processSupervisor,
  type TerminateOptions,
  type TerminationOutcome,
} from "./process-supervisor";

export { CommandTool, type CommandToolOptions, type CommandResult } from "./command-tool";

export {
  WebSearchTool,
  type WebSearchResultItem,
  type WebSearchToolOptions,
  type WebSearchResult,
} from "./web-search-tool";
