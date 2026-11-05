/**
 * Where a hook can run.
 *
 * - `skill:before-execute` — before an executable skill (Sprint 8).
 * - `run:*` — run lifecycle points (docs/17 P3-T2). `pre-*` hooks can veto
 *   the action; `run:post-task` can reject a task's result after the agent
 *   finished, turning a completed task into a failed one.
 */
export type HookPoint =
  | "skill:before-execute"
  | "run:pre-plan"
  | "run:pre-task"
  | "run:post-task"
  | "run:pre-apply"
  | "run:pre-merge";

export const RUN_HOOK_POINTS = [
  "run:pre-plan",
  "run:pre-task",
  "run:post-task",
  "run:pre-apply",
  "run:pre-merge",
] as const satisfies readonly HookPoint[];

export interface HookContext {
  /** Set for `skill:before-execute`. */
  skillId?: string;
  args?: unknown;
  runId?: string;
  /** The point being evaluated; included so one handler can serve several. */
  hookPoint?: HookPoint;
  repoPath?: string;
  /** Agent-call points: who is about to run, or just ran. */
  agentId?: string;
  role?: string;
  permission?: string;
  cwd?: string;
  /** Truncated prompt for pre-plan / pre-task. */
  prompt?: string;
  /** `run:post-task`: how the agent call ended. */
  outcome?: { status: string; error?: string };
  /** Apply / merge points: what is about to land. */
  taskId?: string;
  filePath?: string;
  branch?: string;
}

export interface HookHandlerResult {
  allow: boolean;
  reason?: string;
}

export type HookHandler = (context: HookContext) => Promise<HookHandlerResult>;

export interface HookRegistration {
  id: string;
  hookPoint: HookPoint;
  handler: HookHandler;
  priority?: number;
  description?: string;
}

export interface HookEvaluationResult {
  allowed: boolean;
  reason?: string;
  deniedBy?: string;
}
