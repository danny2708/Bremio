import { z } from "zod";

export const CapacityConfidenceSchema = z.enum(["high", "medium", "low"]);
export type CapacityConfidence = z.infer<typeof CapacityConfidenceSchema>;

export const CapacityFreshnessSchema = z.enum(["fresh", "aging", "stale", "unknown"]);
export type CapacityFreshness = z.infer<typeof CapacityFreshnessSchema>;

export const CapacityStatusSchema = z.enum([
  "healthy",
  "limited",
  "critical",
  "exhausted",
  "unknown",
]);
export type CapacityStatus = z.infer<typeof CapacityStatusSchema>;

export const AgentAvailabilitySchema = z.enum([
  "idle",
  "busy",
  "unavailable",
  "unknown",
]);
export type AgentAvailability = z.infer<typeof AgentAvailabilitySchema>;

export const QuotaWindowSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  scope: z.enum(["account", "model"]),
  /** Provider model id when the source exposes one; display labels are not ids. */
  modelId: z.string().min(1).optional(),
  usedPercent: z.number().min(0).max(100).optional(),
  remainingPercent: z.number().min(0).max(100).optional(),
  resetsAt: z.number().int().nonnegative().optional(),
  windowMinutes: z.number().int().positive().optional(),
  /** Unix seconds when this window was captured by the source. */
  capturedAt: z.number().int().nonnegative(),
  freshness: CapacityFreshnessSchema,
  confidence: CapacityConfidenceSchema,
});
export type QuotaWindow = z.infer<typeof QuotaWindowSchema>;

export const AgentCapacitySnapshotSchema = z.object({
  agentId: z.string().min(1),
  availability: AgentAvailabilitySchema,
  status: CapacityStatusSchema,
  confidence: CapacityConfidenceSchema,
  source: z.object({
    name: z.string().min(1),
    confidenceLabel: z.string().min(1),
  }),
  /**
   * Unix seconds when the source last successfully reached this provider —
   * NOT how old the numbers are. A source can be reachable while its values
   * are old, so each window carries its own `capturedAt`/`freshness`.
   */
  lastContactAt: z.number().int().nonnegative(),
  /**
   * Freshness of that contact. Deliberately never used for routing:
   * `assessCapacity` trusts per-window freshness only, because a reachable
   * source is not evidence that any particular window is current.
   */
  contactFreshness: CapacityFreshnessSchema,
  windows: z.array(QuotaWindowSchema),
});
export type AgentCapacitySnapshot = z.infer<typeof AgentCapacitySnapshotSchema>;

/** Canonical quota boundary. Provider-specific fetch logic stays outside Bremio. */
export interface QuotaProvider {
  readonly id: string;
  readSnapshot(): Promise<AgentCapacitySnapshot>;
  refresh?(): Promise<AgentCapacitySnapshot>;
  openNativeUsage?(): Promise<void>;
}
