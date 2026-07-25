import { z } from "zod";

/**
 * AgentCapabilities — what an adapter can do. Capabilities decide an agent's
 * role, never the provider name (docs/01, core concept 3). The router maps
 * a task's `requiredCapabilities` tokens onto these booleans.
 *
 * An adapter with `planning === true` and `structuredOutput === true` is
 * eligible to be the lead.
 */
/**
 * How read-only enforcement is achieved at the transport level.
 * Only `"advisory"` and `"unsupported"` are not acceptable backings for
 * `plan` or `approve` control modes.
 */
export const ReadOnlyEnforcementSchema = z.enum([
  "hard-sandbox",
  "provider-native",
  "worktree-contained",
  "advisory",
  "unsupported",
]);
export type ReadOnlyEnforcement = z.infer<typeof ReadOnlyEnforcementSchema>;

export const AgentCapabilitiesSchema = z.object({
  planning: z.boolean(),
  structuredOutput: z.boolean(),
  repositoryRead: z.boolean(),
  repositoryWrite: z.boolean(),
  shell: z.boolean(),
  testing: z.boolean(),
  browser: z.boolean(),
  vision: z.boolean(),
  resumableSessions: z.boolean(),
  readOnlyEnforcement: ReadOnlyEnforcementSchema,
});
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;

/**
 * AdapterRuntimeCapabilities — runtime-level information about an adapter
 + transport combination that goes beyond static capability booleans
 * (docs/15 §3).
 */
export const AdapterTransportSchema = z.enum(["cli", "sdk", "app-server"]);
export type AdapterTransport = z.infer<typeof AdapterTransportSchema>;

/**
 * The approval seam an adapter provides.
 * - `"per-action"`: each action can be approved/denied individually (e.g.
 *   Claude SDK's `canUseTool`).
 * - `"before-apply"`: actions can only be approved as a batch before apply.
 * - `"none"`: no approval seam — all-or-nothing per run.
 */
export const ApprovalSeamSchema = z.enum(["per-action", "before-apply", "none"]);
export type ApprovalSeam = z.infer<typeof ApprovalSeamSchema>;

/**
 * Quality of context metrics the adapter reports.
 * - `"reported"`: the adapter reports actual measured token counts.
 * - `"estimated"`: token counts are estimated by the SDK.
 * - `"none"`: no context metrics available.
 */
export const ContextMetricsQualitySchema = z.enum(["reported", "estimated", "none"]);
export type ContextMetricsQuality = z.infer<typeof ContextMetricsQualitySchema>;

export const AdapterRuntimeCapabilitiesSchema = z.object({
  /** Stable adapter id, e.g. "claude" or "opencode". */
  adapterId: z.string(),
  /** How the adapter communicates with its provider. */
  transport: AdapterTransportSchema,
  /** Version of the transport, if known. */
  transportVersion: z.string().optional(),
  /** The approval seam the transport provides. */
  approval: ApprovalSeamSchema,
  /** Whether the provider reports structured tool events (tool name, args). */
  structuredToolEvents: z.boolean(),
  /** Quality of context metrics. */
  contextMetrics: ContextMetricsQualitySchema,
  /** Whether the adapter supports manual compact/context compression. */
  manualCompact: z.boolean(),
  /** Whether the adapter supports MCP tools. */
  mcp: z.boolean(),
  /** Whether the adapter supports web search. */
  webSearch: z.boolean(),
  /** Whether the adapter supports cancellation of in-flight runs. */
  cancellation: z.boolean(),
});
export type AdapterRuntimeCapabilities = z.infer<typeof AdapterRuntimeCapabilitiesSchema>;

/** Roles an agent profile can take on within a run. */
export const AgentRoleSchema = z.enum([
  "lead",
  "planner",
  "implementer",
  "reviewer",
  "tester",
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

/**
 * Permission granted to a task's run. A reviewer gets `read-only`; an
 * implementer gets `workspace-write` (docs/03). Enforcement strength is
 * per-provider (see docs/04).
 */
export const PermissionSchema = z.enum(["read-only", "workspace-write"]);
export type Permission = z.infer<typeof PermissionSchema>;
