import type { AgentRole, Permission } from "@bremio/adapter-sdk";
import type { Plan, Task, TaskKind } from "@bremio/protocol";

/**
 * Phase-1 deterministic router (policy: lead ≠ worker).
 *
 * `analysis` tasks stay with the lead (it already has planning context);
 * every executable task (implementation/test/review/documentation/other) goes
 * to the other registered provider — the "worker". A delegation guarantee then
 * ensures at least one task runs on the worker, so the "hand off ≥1 task to a
 * DIFFERENT agent" criterion holds for any plan shape. Scoring/quota-aware
 * routing is Phase 4.
 */
export function assignAgents(
  plan: Plan,
  leadId: string,
  workerId: string,
): Map<string, string> {
  const assign = new Map<string, string>();
  for (const t of plan.tasks) {
    assign.set(t.id, t.kind === "analysis" ? leadId : workerId);
  }

  // Delegation guarantee: if nothing landed on the worker, move the last task.
  const someDelegated = [...assign.values()].some((a) => a !== leadId);
  if (!someDelegated) {
    const last = plan.tasks[plan.tasks.length - 1];
    if (last) assign.set(last.id, workerId);
  }
  return assign;
}

/** Order tasks so each task's dependencies come first (Kahn topological sort). */
export function topologicalOrder(plan: Plan): Task[] {
  const byId = new Map(plan.tasks.map((t) => [t.id, t] as const));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const t of plan.tasks) indegree.set(t.id, 0);
  for (const t of plan.tasks) {
    for (const dep of t.dependencies) {
      if (!byId.has(dep)) continue;
      indegree.set(t.id, (indegree.get(t.id) ?? 0) + 1);
      dependents.set(dep, [...(dependents.get(dep) ?? []), t.id]);
    }
  }

  // Preserve the plan's original order among ready tasks for stable output.
  const ready = plan.tasks.filter((t) => (indegree.get(t.id) ?? 0) === 0).map((t) => t.id);
  const ordered: Task[] = [];
  while (ready.length > 0) {
    const id = ready.shift() as string;
    const task = byId.get(id);
    if (task) ordered.push(task);
    for (const next of dependents.get(id) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) ready.push(next);
    }
  }

  // Any leftover (only possible under a cycle, which validation rejects first)
  // is appended so nothing is silently dropped.
  if (ordered.length !== plan.tasks.length) {
    const seen = new Set(ordered.map((t) => t.id));
    for (const t of plan.tasks) if (!seen.has(t.id)) ordered.push(t);
  }
  return ordered;
}

export function roleForKind(kind: TaskKind): AgentRole {
  switch (kind) {
    case "analysis":
      return "planner";
    case "implementation":
      return "implementer";
    case "review":
      return "reviewer";
    case "test":
      return "tester";
    case "documentation":
    case "other":
      return "implementer";
  }
}

export function permissionForKind(kind: TaskKind): Permission {
  return kind === "review" || kind === "analysis" ? "read-only" : "workspace-write";
}
