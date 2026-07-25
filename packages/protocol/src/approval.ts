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

export const GrantScopeSchema = z.enum(["once", "session", "workspace"]);
export type GrantScope = z.infer<typeof GrantScopeSchema>;

export const GrantStatusSchema = z.enum(["active", "consumed", "revoked", "expired"]);
export type GrantStatus = z.infer<typeof GrantStatusSchema>;

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

export const ApprovalGrantSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  workspaceId: z.string().optional(),
  scope: GrantScopeSchema,
  actionClass: ActionClassSchema.optional(),
  target: z.string().optional(),
  expiresAt: z.string(),
  revokedAt: z.string().optional(),
  consumedAt: z.string().optional(),
  createdAt: z.string(),
  createdBy: z.string(),
  originatingDigest: z.string().optional(),
  precedence: z.number(),
  grantStatus: GrantStatusSchema.optional(),
});
export type ApprovalGrant = z.infer<typeof ApprovalGrantSchema>;

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

export const CreateApprovalGrantSchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string().optional(),
  scope: GrantScopeSchema,
  actionClass: ActionClassSchema.optional(),
  target: z.string().optional(),
  ttlMs: z.number().positive(),
  createdBy: z.string(),
  precedence: z.number().int(),
  originatingDigest: z.string().optional(),
});
export type CreateApprovalGrant = z.infer<typeof CreateApprovalGrantSchema>;
