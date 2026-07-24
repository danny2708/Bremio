export type ControlMode = "plan" | "approve" | "autopilot";

export type ActionClass =
  | "read"
  | "write"
  | "create"
  | "delete"
  | "command"
  | "network"
  | "mcp-tool"
  | "git-destructive"
  | "outside-workspace"
  | "user-config";

export type ApprovalRequirement = "none" | "per-action" | "before-apply";

export interface PolicyEvaluation {
  allowed: boolean;
  approvalRequired: ApprovalRequirement;
  reason: string;
}

type Rule = PolicyEvaluation;

const PLAN_RULES: Record<ActionClass, Rule> = {
  read:             { allowed: true,  approvalRequired: "none",        reason: "read is always allowed in plan mode" },
  write:            { allowed: false, approvalRequired: "none",        reason: "plan mode prohibits writes" },
  create:           { allowed: false, approvalRequired: "none",        reason: "plan mode prohibits file creation" },
  delete:           { allowed: false, approvalRequired: "none",        reason: "plan mode prohibits deletion" },
  command:          { allowed: false, approvalRequired: "none",        reason: "plan mode prohibits commands" },
  network:          { allowed: false, approvalRequired: "none",        reason: "plan mode prohibits network access" },
  "mcp-tool":       { allowed: false, approvalRequired: "none",        reason: "plan mode prohibits MCP tool use" },
  "git-destructive":{ allowed: false, approvalRequired: "none",        reason: "plan mode prohibits destructive git operations" },
  "outside-workspace": { allowed: false, approvalRequired: "none",     reason: "plan mode prohibits writes outside workspace" },
  "user-config":    { allowed: false, approvalRequired: "none",        reason: "plan mode prohibits user config changes" },
};

const APPROVE_RULES: Record<ActionClass, Rule> = {
  read:             { allowed: true,  approvalRequired: "none",        reason: "read never requires approval" },
  write:            { allowed: true,  approvalRequired: "before-apply", reason: "write requires approval before apply" },
  create:           { allowed: true,  approvalRequired: "before-apply", reason: "create requires approval before apply" },
  delete:           { allowed: true,  approvalRequired: "per-action",  reason: "delete requires per-action approval" },
  command:          { allowed: true,  approvalRequired: "per-action",  reason: "command requires per-action approval" },
  network:          { allowed: true,  approvalRequired: "before-apply", reason: "network requires approval before apply" },
  "mcp-tool":       { allowed: true,  approvalRequired: "per-action",  reason: "MCP tool use requires per-action approval" },
  "git-destructive":{ allowed: true,  approvalRequired: "per-action",  reason: "destructive git requires per-action approval" },
  "outside-workspace": { allowed: true,  approvalRequired: "per-action", reason: "outside-workspace access requires per-action approval" },
  "user-config":    { allowed: true,  approvalRequired: "per-action",  reason: "user config changes require per-action approval" },
};

const AUTOPILOT_RULES: Record<ActionClass, Rule> = {
  read:             { allowed: true,  approvalRequired: "none",        reason: "autopilot allows all actions" },
  write:            { allowed: true,  approvalRequired: "none",        reason: "autopilot allows all actions" },
  create:           { allowed: true,  approvalRequired: "none",        reason: "autopilot allows all actions" },
  delete:           { allowed: true,  approvalRequired: "none",        reason: "autopilot allows all actions" },
  command:          { allowed: true,  approvalRequired: "none",        reason: "autopilot allows all actions" },
  network:          { allowed: true,  approvalRequired: "none",        reason: "autopilot allows all actions" },
  "mcp-tool":       { allowed: true,  approvalRequired: "none",        reason: "autopilot allows all actions" },
  "git-destructive":{ allowed: true,  approvalRequired: "none",        reason: "autopilot allows all actions" },
  "outside-workspace": { allowed: true,  approvalRequired: "none",     reason: "autopilot allows all actions" },
  "user-config":    { allowed: true,  approvalRequired: "none",        reason: "autopilot allows all actions" },
};

const MODE_MATRIX: Record<ControlMode, Record<ActionClass, Rule>> = {
  plan: PLAN_RULES,
  approve: APPROVE_RULES,
  autopilot: AUTOPILOT_RULES,
};

export function evaluate(controlMode: ControlMode, action: ActionClass): PolicyEvaluation {
  return MODE_MATRIX[controlMode][action];
}
