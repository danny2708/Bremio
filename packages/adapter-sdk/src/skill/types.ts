export type SkillState = "registered" | "enabled" | "disabled" | "error";

export interface SkillContext {
  signal?: AbortSignal;
  runId?: string;
}

export interface SkillResult {
  success: boolean;
  data?: unknown;
  error?: string;
  duration: number;
}

export interface Skill<TOptions = unknown, TContext extends SkillContext = SkillContext> {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: Record<string, unknown>;
  execute(args: TOptions, context?: TContext): Promise<SkillResult>;
}

export interface SkillRegistration {
  skill: Skill;
  state: SkillState;
  error?: string;
}
