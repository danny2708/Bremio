import type {
  HookContext,
  HookEvaluationResult,
  HookHandler,
  HookPoint,
  HookRegistration,
} from "./types";

export class HookManager {
  private readonly hooks = new Map<string, HookRegistration>();

  register(registration: HookRegistration): this {
    if (this.hooks.has(registration.id)) {
      throw new Error(`Hook already registered: ${registration.id}`);
    }
    this.hooks.set(registration.id, { ...registration });
    return this;
  }

  unregister(id: string): void {
    if (!this.hooks.has(id)) {
      throw new Error(`Hook not registered: ${id}`);
    }
    this.hooks.delete(id);
  }

  async evaluate(
    hookPoint: HookPoint,
    context: HookContext,
  ): Promise<HookEvaluationResult> {
    const candidates = this.getHandlers(hookPoint);
    if (candidates.length === 0) {
      return { allowed: true };
    }

    for (const reg of candidates) {
      try {
        const result = await reg.handler(context);
        if (!result.allow) {
          return {
            allowed: false,
            reason: result.reason ?? `Denied by hook: ${reg.id}`,
            deniedBy: reg.id,
          };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          allowed: false,
          reason: `Hook "${reg.id}" threw: ${msg}`,
          deniedBy: reg.id,
        };
      }
    }

    return { allowed: true };
  }

  list(): HookRegistration[] {
    return [...this.hooks.values()];
  }

  listForPoint(hookPoint: HookPoint): HookRegistration[] {
    return this.getHandlers(hookPoint);
  }

  private getHandlers(hookPoint: HookPoint): HookRegistration[] {
    return [...this.hooks.values()]
      .filter((h) => h.hookPoint === hookPoint)
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  }
}
