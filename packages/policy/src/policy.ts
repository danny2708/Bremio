import type { ReadOnlyEnforcement } from "@bremio/adapter-sdk";

export type CollaborationMode = "solo" | "colab";

export type ControlMode = "plan" | "approve" | "autopilot";

export type WorkspaceStrategy = "direct-workspace" | "isolated-worktree";

/**
 * The approval seam an adapter provides.
 * - `"per-action"`: each action can be approved/denied individually.
 * - `"before-apply"`: actions can only be approved as a batch before apply.
 * - `"none"`: no approval seam — all-or-nothing per run.
 */
export type ApprovalSeam = "per-action" | "before-apply" | "none";

export interface CombinationValidation {
  valid: boolean;
  reason?: string;
  granularity?: "per-action" | "before-apply" | "none";
}

function hasPerActionSeam(approvalSeam?: ApprovalSeam): boolean {
  return approvalSeam === "per-action";
}

export function validateCombination(
  collaboration: CollaborationMode,
  control: ControlMode,
  workspace: WorkspaceStrategy,
  approvalSeam?: ApprovalSeam,
): CombinationValidation {
  if (collaboration === "colab" && workspace === "direct-workspace") {
    return {
      valid: false,
      reason: "Co-lab mode requires isolated-worktree strategy to isolate workers",
    };
  }

  if (control === "approve" && workspace === "direct-workspace" && !hasPerActionSeam(approvalSeam)) {
    return {
      valid: false,
      reason: "Approve control mode requires isolated-worktree strategy unless transport provides a per-action seam",
    };
  }

  let granularity: CombinationValidation["granularity"] = "none";
  if (control === "approve") {
    granularity = hasPerActionSeam(approvalSeam) && workspace === "direct-workspace" ? "per-action" : "before-apply";
  }

  return {
    valid: true,
    granularity,
  };
}

/**
 * Whether an adapter's read-only enforcement is strong enough to back a
 * control mode, per docs/15 §2.2:
 *
 *   "`advisory` is never an acceptable backing for `plan` or `approve`. A mode
 *   whose only enforcement is a sentence in a prompt must not be offered."
 *
 * That rule previously existed only as a doc comment on `ReadOnlyEnforcement`,
 * which is the comment-only enforcement the rule itself forbids — nothing could
 * fail when it was violated. It is executable here so a caller cannot offer a
 * guarantee the transport does not provide.
 *
 * `plan` promises the agent does not modify anything, so it needs real
 * transport-level enforcement; a worktree would contain the write but the write
 * would still have happened. `approve` only promises nothing reaches the user's
 * workspace unreviewed, so an isolated worktree is a sufficient backing on its
 * own. `autopilot` makes no read-only promise and constrains nothing here.
 */
export function canBackControlMode(
  control: ControlMode,
  enforcement: ReadOnlyEnforcement,
  workspace: WorkspaceStrategy,
): { ok: true } | { ok: false; reason: string } {
  if (control === "autopilot") return { ok: true };

  const enforced = enforcement !== "advisory" && enforcement !== "unsupported";
  if (enforced) return { ok: true };

  if (control === "approve" && workspace === "isolated-worktree") {
    // The worktree, not the adapter, is what contains the change.
    return { ok: true };
  }

  return {
    ok: false,
    reason:
      `${control} mode requires transport-level read-only enforcement, but this adapter ` +
      `reports "${enforcement}"` +
      (control === "approve" ? "; run it in an isolated worktree instead" : ""),
  };
}

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
  /** When true, a denial can be overridden by an active ApprovalGrant. */
  overrideableByGrant?: true;
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
  read:             { allowed: true,  approvalRequired: "none",        reason: "autopilot allows reads" },
  write:            { allowed: true,  approvalRequired: "none",        reason: "autopilot allows writes" },
  create:           { allowed: true,  approvalRequired: "none",        reason: "autopilot allows file creation" },
  delete:           { allowed: true,  approvalRequired: "none",        reason: "autopilot allows deletion" },
  command:          { allowed: true,  approvalRequired: "none",        reason: "autopilot allows commands" },
  network:          { allowed: true,  approvalRequired: "none",        reason: "autopilot allows network access" },
  "mcp-tool":       { allowed: true,  approvalRequired: "none",        reason: "autopilot allows MCP tool use" },
  "git-destructive":{ allowed: false, approvalRequired: "none", overrideableByGrant: true, reason: "destructive git requires a grant in autopilot" },
  "outside-workspace": { allowed: false, approvalRequired: "none", overrideableByGrant: true, reason: "outside-workspace access requires a grant in autopilot" },
  "user-config":    { allowed: false, approvalRequired: "none", overrideableByGrant: true, reason: "user config changes require a grant in autopilot" },
};

const MODE_MATRIX: Record<ControlMode, Record<ActionClass, Rule>> = {
  plan: PLAN_RULES,
  approve: APPROVE_RULES,
  autopilot: AUTOPILOT_RULES,
};

export function evaluate(controlMode: ControlMode, action: ActionClass): PolicyEvaluation {
  return MODE_MATRIX[controlMode][action];
}
