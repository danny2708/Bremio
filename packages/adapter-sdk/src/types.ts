import { z } from "zod";
import type { ReasoningLevel } from "@bremio/protocol";
import type { AgentRole, Permission } from "./capabilities";

/** Result of an adapter liveness probe. */
export const AgentHealthSchema = z.object({
  status: z.enum(["ok", "degraded", "unavailable"]),
  detail: z.string().optional(),
});
export type AgentHealth = z.infer<typeof AgentHealthSchema>;

/** A model an adapter can run. Model names are never hardcoded in core. */
export const ModelDescriptorSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().optional(),
  default: z.boolean().optional(),
});
export type ModelDescriptor = z.infer<typeof ModelDescriptorSchema>;

/**
 * AgentRunRequest — the normalized instruction the orchestrator passes to
 * `startRun`. Defined as a plain interface (not a Zod schema) because it
 * carries a live `AbortSignal` and an arbitrary JSON-Schema object.
 */
export interface AgentRunRequest {
  /** Orchestrator-assigned id; also the handle for `cancelRun(runId)`. */
  runId: string;
  role: AgentRole;
  /** The instruction for the agent (task prompt, or planning prompt). */
  prompt: string;
  /** Working directory the agent runs in (a worktree, or the repo root). */
  cwd: string;
  /** Read-only for reviewers, workspace-write for implementers. */
  permission: Permission;
  /** Provider model id; adapters fall back to their own default when omitted. */
  model?: string;
  /** Explicit reasoning request; omission keeps the provider/config default. */
  reasoningLevel?: ReasoningLevel;
  /** Extra system-prompt guidance layered on the provider default. */
  systemPrompt?: string;
  /**
   * JSON Schema constraining the agent's final structured output (used by the
   * lead to return plan JSON). Codex maps this to `--output-schema`; Claude
   * maps it to structured output / a prompt instruction.
   */
  outputSchema?: Record<string, unknown>;
  /** Cap on agentic tool-use round trips. */
  maxTurns?: number;
  /** Cooperative cancellation, composed with `cancelRun(runId)`. */
  signal?: AbortSignal;
  /** Free-form context for logging/tracing. */
  metadata?: Record<string, unknown>;
}
