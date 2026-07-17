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
  QuotaSnapshotSchema,
  type AgentHealth,
  type ModelDescriptor,
  type QuotaSnapshot,
  type AgentRunRequest,
} from "./types";

export type { AgentAdapter, AgentPluginManifest } from "./adapter";
