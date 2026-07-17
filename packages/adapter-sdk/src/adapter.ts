import type { AgentEvent } from "@bremio/protocol";
import type { AgentCapabilities, AgentRole } from "./capabilities";
import type {
  AgentHealth,
  AgentRunRequest,
  ModelDescriptor,
  QuotaSnapshot,
} from "./types";

/**
 * AgentAdapter — the provider-agnostic contract every provider implements
 * (docs/04). The orchestrator talks only to this interface; swapping or adding
 * a provider never touches core.
 *
 * Phase 1 fully implements `startRun`, `getCapabilities`, and `cancelRun`.
 * `getQuota` returns `{ status: "unknown" }` (quota is out of scope).
 * `healthCheck` / `listModels` / `resumeRun` are present for contract fidelity
 * and may be thin.
 */
export interface AgentAdapter {
  /** Stable adapter id, e.g. "claude" or "codex". */
  readonly id: string;
  /** Provider family, e.g. "anthropic" or "openai". */
  readonly provider: string;

  healthCheck(): Promise<AgentHealth>;
  getCapabilities(): Promise<AgentCapabilities>;
  listModels(): Promise<ModelDescriptor[]>;
  getQuota(): Promise<QuotaSnapshot>;

  /** Start a run and stream normalized events until a terminal `completed`. */
  startRun(request: AgentRunRequest): AsyncIterable<AgentEvent>;

  /** Resume a prior session (Phase 2+); may reject if unsupported. */
  resumeRun(
    sessionId: string,
    request: AgentRunRequest,
  ): AsyncIterable<AgentEvent>;

  /** Cancel an in-flight run by its `runId`. Idempotent. */
  cancelRun(runId: string): Promise<void>;
}

/**
 * AgentPluginManifest — adding a provider = adding one package that exposes
 * this manifest (docs/04).
 */
export interface AgentPluginManifest {
  id: string;
  displayName: string;
  version: string;
  adapterFactory: () => AgentAdapter;
  supportedRoles: AgentRole[];
  configurationSchema: Record<string, unknown>;
}
