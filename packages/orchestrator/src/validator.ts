import type { AgentCapabilities } from "@bremio/adapter-sdk";
import type { Plan, RequiredCapability } from "@bremio/protocol";

export class PlanValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Plan failed validation:\n- ${errors.join("\n- ")}`);
    this.name = "PlanValidationError";
  }
}

/** Map a task capability token to the adapter capability boolean it needs. */
function capabilityHolds(token: RequiredCapability, cap: AgentCapabilities): boolean {
  switch (token) {
    case "repository.read":
      return cap.repositoryRead;
    case "repository.write":
      return cap.repositoryWrite;
    case "shell":
      return cap.shell;
    case "test":
      return cap.testing;
    case "review":
      return cap.repositoryRead; // reviewing requires reading the code
    case "browser":
      return cap.browser;
    case "vision":
      return cap.vision;
  }
}

/**
 * Validate a (already schema-parsed) plan: unique ids, dependencies that
 * reference existing tasks, no dependency cycles, and that every required
 * capability is provided by at least one registered agent.
 * Throws {@link PlanValidationError} on any problem.
 */
export function validatePlan(
  plan: Plan,
  capabilitiesByAgent: Map<string, AgentCapabilities>,
): void {
  const errors: string[] = [];
  const ids = plan.tasks.map((t) => t.id);
  const idSet = new Set(ids);

  // 1. Unique task ids.
  if (idSet.size !== ids.length) {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) errors.push(`duplicate task id: ${id}`);
      seen.add(id);
    }
  }

  // 2. Dependencies reference existing tasks (and not self).
  for (const t of plan.tasks) {
    for (const dep of t.dependencies) {
      if (dep === t.id) errors.push(`${t.id} depends on itself`);
      else if (!idSet.has(dep)) errors.push(`${t.id} depends on unknown task ${dep}`);
    }
  }

  // 3. No dependency cycles (DFS with color marking).
  const byId = new Map(plan.tasks.map((t) => [t.id, t] as const));
  const state = new Map<string, 0 | 1 | 2>(); // 0=unvisited,1=in-stack,2=done
  const cyclePath: string[] = [];
  let cycleFound = false;

  const visit = (id: string): void => {
    if (cycleFound) return;
    state.set(id, 1);
    cyclePath.push(id);
    for (const dep of byId.get(id)?.dependencies ?? []) {
      if (!idSet.has(dep)) continue; // already reported as unknown
      const s = state.get(dep) ?? 0;
      if (s === 1) {
        const from = cyclePath.indexOf(dep);
        errors.push(`dependency cycle: ${[...cyclePath.slice(from), dep].join(" -> ")}`);
        cycleFound = true;
        return;
      }
      if (s === 0) visit(dep);
      if (cycleFound) return;
    }
    cyclePath.pop();
    state.set(id, 2);
  };
  for (const t of plan.tasks) {
    if ((state.get(t.id) ?? 0) === 0) visit(t.id);
    if (cycleFound) break;
  }

  // 4. Capability availability across all registered agents.
  const allCaps = [...capabilitiesByAgent.values()];
  for (const t of plan.tasks) {
    if (
      (t.kind === "analysis" || t.kind === "test" || t.kind === "review") &&
      t.requiredCapabilities.includes("repository.write")
    ) {
      errors.push(
        `${t.id} is a read-only ${t.kind} task and cannot require capability "repository.write"`,
      );
    }
    for (const token of t.requiredCapabilities) {
      if (!allCaps.some((cap) => capabilityHolds(token, cap))) {
        errors.push(`${t.id} requires capability "${token}" that no registered agent provides`);
      }
    }
  }

  if (errors.length > 0) throw new PlanValidationError(errors);
}
