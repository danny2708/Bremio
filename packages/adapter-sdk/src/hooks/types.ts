export type HookPoint = "skill:before-execute";

export interface HookContext {
  skillId: string;
  args?: unknown;
  runId?: string;
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
