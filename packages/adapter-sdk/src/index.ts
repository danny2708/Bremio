/**
 * @bremio/adapter-sdk — the contract a provider adapter implements, plus the
 * value types it exchanges with the orchestrator. Core depends on this; it
 * never depends on a specific adapter package.
 */
export {
  AgentCapabilitiesSchema,
  AgentRoleSchema,
  PermissionSchema,
  type AgentCapabilities,
  type AgentRole,
  type Permission,
} from "./capabilities";

export {
  AgentHealthSchema,
  ModelDescriptorSchema,
  type AgentHealth,
  type ModelDescriptor,
  type AgentRunRequest,
} from "./types";

export type { AgentAdapter, AgentPluginManifest } from "./adapter";

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
