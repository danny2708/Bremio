import { z } from "zod";

export const EvidenceQualitySchema = z.enum(["reported", "observed", "unknown"]);
export type EvidenceQuality = z.infer<typeof EvidenceQualitySchema>;

export const RuntimeGuardLevelSchema = z.enum([
  "healthy",
  "warning",
  "constrained",
  "stop-requested",
]);
export type RuntimeGuardLevel = z.infer<typeof RuntimeGuardLevelSchema>;

export const RuntimeGuardActionSchema = z.enum([
  "none",
  "observe_only",
  "warn",
  "suppress-future-work",
  "cancel",
]);
export type RuntimeGuardAction = z.infer<typeof RuntimeGuardActionSchema>;

export const RuntimeGuardDecisionSchema = z.object({
  runId: z.string(),
  agentId: z.string(),
  level: RuntimeGuardLevelSchema,
  action: RuntimeGuardActionSchema,
  reasonCode: z.string(),
  reason: z.string(),
  evidenceQuality: EvidenceQualitySchema,
  observedAt: z.string(),
});
export type RuntimeGuardDecision = z.infer<typeof RuntimeGuardDecisionSchema>;

export const RunContextEntryKindSchema = z.enum([
  "fact",
  "decision",
  "blocker",
  "open-question",
  "artifact",
]);
export type RunContextEntryKind = z.infer<typeof RunContextEntryKindSchema>;

export const RunContextEntrySchema = z.object({
  id: z.string(),
  runId: z.string(),
  taskId: z.string().optional(),
  kind: RunContextEntryKindSchema,
  author: z.object({
    kind: z.enum(["user", "orchestrator", "agent"]),
    id: z.string().optional(),
  }),
  payload: z.unknown(),
  provenance: z.string(),
  createdAt: z.string(),
});
export type RunContextEntry = z.infer<typeof RunContextEntrySchema>;

export const CoordinationMessageActSchema = z.enum([
  "request-artifact",
  "inform",
  "blocker",
  "done",
]);
export type CoordinationMessageAct = z.infer<typeof CoordinationMessageActSchema>;

export const CoordinationMessageSchema = z.object({
  id: z.string(),
  runId: z.string(),
  conversationId: z.string(),
  fromTaskId: z.string(),
  to: z.object({
    kind: z.enum(["task", "lead", "orchestrator"]),
    id: z.string().optional(),
  }),
  act: CoordinationMessageActSchema,
  replyTo: z.string().optional(),
  contextEntryIds: z.array(z.string()),
  requiresReply: z.boolean(),
  hopCount: z.number(),
  createdAt: z.string(),
  handledAt: z.string().optional(),
});
export type CoordinationMessage = z.infer<typeof CoordinationMessageSchema>;
