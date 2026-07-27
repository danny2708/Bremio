import { z } from "zod";

export const ActionClassSchema = z.enum([
  "read",
  "write",
  "create",
  "delete",
  "command",
  "network",
  "mcp-tool",
  "git-destructive",
  "outside-workspace",
  "user-config",
]);
export type ActionClass = z.infer<typeof ActionClassSchema>;

export const ApprovalRequestStateSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "expired",
  "cancelled",
]);
export type ApprovalRequestState = z.infer<typeof ApprovalRequestStateSchema>;

export const RiskLevelSchema = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const ActionDigestSchema = z.object({
  actionClass: ActionClassSchema,
  target: z.string(),
  description: z.string(),
  digest: z.string(),
});
export type ActionDigest = z.infer<typeof ActionDigestSchema>;

export const ApprovalRequestSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  runId: z.string(),
  actionDigest: ActionDigestSchema,
  risk: RiskLevelSchema,
  state: ApprovalRequestStateSchema,
  requestedAt: z.string(),
  decidedAt: z.string().optional(),
  decidedBy: z.string().optional(),
  reason: z.string().optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalDecisionSchema = z.object({
  requestId: z.string(),
  decision: z.enum(["approved", "rejected"]),
  decidedBy: z.string(),
  decidedAt: z.string(),
  reason: z.string().optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const CreateApprovalRequestSchema = z.object({
  sessionId: z.string(),
  runId: z.string(),
  actionDigest: ActionDigestSchema,
  risk: RiskLevelSchema,
});
export type CreateApprovalRequest = z.infer<typeof CreateApprovalRequestSchema>;

export const DecideApprovalRequestSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  decidedBy: z.string(),
  reason: z.string().optional(),
});
export type DecideApprovalRequest = z.infer<typeof DecideApprovalRequestSchema>;
