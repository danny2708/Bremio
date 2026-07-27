import type { AgentEvent } from "@bremio/protocol";
import type { AgentCapabilities, AgentRole, AdapterRuntimeCapabilities } from "./capabilities";
import type {
  AgentHealth,
  AgentRunRequest,
  ModelDescriptor,
} from "./types";

/**
 * Tool names the adapter uses for read, write, and shell operations.
 * Returned by `getToolVocabulary()` when an adapter wants to override the
 * default heuristic sets. An adapter that never emits `tool_use` events (e.g.
 * antigravity) returns empty arrays so no event-based attribution is claimed.
 */
export interface AgentToolVocabulary {
  read: readonly string[];
  write: readonly string[];
  shell: readonly string[];
}

/**
 * AgentAdapter — the provider-agnostic contract every provider implements
 * (docs/04). The orchestrator talks only to this interface; swapping or adding
 * a provider never touches core.
 *
 * `healthCheck` / `listModels` / `resumeRun` may be thin. Quota is deliberately
 * separate because one adapter-level window cannot represent provider account
 * windows and model-scoped capacity; see `@bremio/quota`.
 */
export interface AgentAdapter {
  /** Stable adapter id, e.g. "claude" or "codex". */
  readonly id: string;
  /** Provider family, e.g. "anthropic" or "openai". */
  readonly provider: string;

  healthCheck(): Promise<AgentHealth>;
  getCapabilities(): Promise<AgentCapabilities>;
  getRuntimeCapabilities(): Promise<AdapterRuntimeCapabilities>;
  listModels(): Promise<ModelDescriptor[]>;

  /**
   * Declare the tool names this adapter uses for read, write, and shell
   * operations. When omitted, the caller falls back to a default superset that
   * matches all known adapter tool names.
   *
   * This is how attribution becomes capability-shaped (docs/15 §1.3): the
   * adapter reports what it actually sends, and the orchestrator uses that
   * vocabulary instead of a hardcoded provider-specific list.
   */
  getToolVocabulary?(): AgentToolVocabulary;

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
