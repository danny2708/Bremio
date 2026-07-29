import type { Skill, SkillContext, SkillRegistration, SkillResult, SkillState } from "./types";
import type { HookManager } from "../hooks/manager";
import type { HookEvaluationResult } from "../hooks/types";

type HooksLike = Pick<HookManager, "evaluate">;

export class SkillManager {
  private readonly skills = new Map<string, SkillRegistration>();
  private readonly hooks?: HooksLike;

  constructor(hooks?: HooksLike) {
    this.hooks = hooks;
  }

  register(skill: Skill): this {
    if (this.skills.has(skill.id)) {
      throw new Error(`Skill already registered: ${skill.id}`);
    }
    this.skills.set(skill.id, { skill, state: "registered" });
    return this;
  }

  enable(id: string): void {
    const entry = this.skills.get(id);
    if (!entry) throw new Error(`Skill not registered: ${id}`);
    if (entry.state === "enabled") return;
    if (entry.state !== "registered" && entry.state !== "disabled" && entry.state !== "error") {
      throw new Error(`Cannot enable skill ${id} from state "${entry.state}"`);
    }
    entry.state = "enabled";
    entry.error = undefined;
  }

  disable(id: string): void {
    const entry = this.skills.get(id);
    if (!entry) throw new Error(`Skill not registered: ${id}`);
    if (entry.state === "disabled") return;
    if (entry.state !== "enabled" && entry.state !== "error") {
      throw new Error(`Cannot disable skill ${id} from state "${entry.state}"`);
    }
    entry.state = "disabled";
    entry.error = undefined;
  }

  async execute(id: string, args: unknown, context?: SkillContext): Promise<SkillResult> {
    const entry = this.skills.get(id);
    if (!entry) throw new Error(`Skill not registered: ${id}`);
    if (entry.state !== "enabled") {
      throw new Error(
        `Cannot execute skill ${id}: current state is "${entry.state}" (must be "enabled")`,
      );
    }

    if (this.hooks) {
      const evalResult = await this.hooks.evaluate("skill:before-execute", {
        skillId: id,
        args,
        runId: context?.runId,
      });
      if (!evalResult.allowed) {
        throw new Error(`Hook vetoed execution of skill "${id}": ${evalResult.reason}`);
      }
    }

    const started = Date.now();
    try {
      const result = await entry.skill.execute(args, context);
      return result;
    } catch (err) {
      entry.state = "error";
      const msg = err instanceof Error ? err.message : String(err);
      entry.error = msg;
      return {
        success: false,
        error: msg,
        duration: Date.now() - started,
      };
    }
  }

  get(id: string): Skill | undefined {
    return this.skills.get(id)?.skill;
  }

  list(): SkillRegistration[] {
    return [...this.skills.values()].map((e) => ({
      skill: e.skill,
      state: e.state,
      error: e.error,
    }));
  }

  getRegistry(): Map<string, Skill> {
    const registry = new Map<string, Skill>();
    for (const [id, entry] of this.skills) {
      if (entry.state === "enabled") {
        registry.set(id, entry.skill);
      }
    }
    return registry;
  }

  getState(id: string): SkillState | undefined {
    return this.skills.get(id)?.state;
  }
}
