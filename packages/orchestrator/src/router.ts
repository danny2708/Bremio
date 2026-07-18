import type { AgentCapabilities, AgentRole, Permission } from "@bremio/adapter-sdk";
import type { Plan, Task, TaskKind } from "@bremio/protocol";
import {
  assessCapacity,
  resolveCapacityRoutingPolicy,
  type AgentCapacitySnapshot,
  type CapacityAssessment,
  type CapacityRoutingPolicy,
  type CapacityRoutingPolicyInput,
} from "@bremio/quota";
import { capabilityHolds } from "./validator";

export interface AssignAgentsOptions {
  capabilitiesByAgent?: ReadonlyMap<string, AgentCapabilities>;
  capacityByAgent?: ReadonlyMap<string, AgentCapacitySnapshot>;
  capacityPolicy?: CapacityRoutingPolicyInput;
  /** Provider-confirmed model id selected for each candidate agent. */
  modelByAgent?: ReadonlyMap<string, string>;
}

export class CapacityRoutingError extends Error {
  constructor(
    readonly taskId: string,
    detail: string,
  ) {
    super(`no eligible agent for ${taskId}: ${detail}`);
    this.name = "CapacityRoutingError";
  }
}

const TASK_ROLE_PREFERENCE_STEP = 25;

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
  options: AssignAgentsOptions = {},
): Map<string, string> {
  const policy = resolveCapacityRoutingPolicy(options.capacityPolicy);
  const assign = new Map<string, string>();
  for (const t of plan.tasks) {
    if (t.kind === "analysis") {
      assign.set(t.id, chooseAgent(t, [leadId, workerId], leadId, options, policy));
      continue;
    }
    if (t.kind === "review") {
      const dependencyAuthors = new Set(
        t.dependencies.map((dependency) => assign.get(dependency)).filter(Boolean),
      );
      const independent = [leadId, workerId].filter((id) => !dependencyAuthors.has(id));
      assign.set(
        t.id,
        chooseAgent(
          t,
          independent.length > 0 ? independent : [workerId],
          leadId,
          options,
          policy,
        ),
      );
      continue;
    }
    assign.set(t.id, chooseAgent(t, [workerId, leadId], leadId, options, policy));
  }

  // Delegation guarantee: if nothing landed on the worker, move the last task.
  const someDelegated = [...assign.values()].some((a) => a !== leadId);
  if (!someDelegated && workerId !== leadId) {
    const last = plan.tasks[plan.tasks.length - 1];
    const workerAssessment = assessmentFor(workerId, options, policy);
    const trustedCapacityAvoidance = workerAssessment?.trusted === true &&
      workerAssessment.scoreAdjustment < 0;
    if (
      last &&
      !trustedCapacityAvoidance &&
      isCapacityEligible(workerId, last, leadId, options, policy)
    ) {
      assign.set(last.id, workerId);
    }
  }
  return assign;
}

function chooseAgent(
  task: Task,
  orderedCandidates: readonly string[],
  leadId: string,
  options: AssignAgentsOptions,
  policy: CapacityRoutingPolicy,
): string {
  const candidates = [...new Set(orderedCandidates)].map((agentId, index) => {
    const assessment = assessmentFor(agentId, options, policy);
    const reserveBlocked = isLeadReserveBlocked(agentId, task, leadId, assessment, policy);
    return {
      agentId,
      assessment,
      reserveBlocked,
      // Unknown/stale data cannot erase the established role preference, while
      // a trusted critical penalty can move work to a healthy fallback.
      score: (orderedCandidates.length - index) * TASK_ROLE_PREFERENCE_STEP +
        (assessment?.scoreAdjustment ?? 0),
    };
  });
  const eligible = candidates
    .filter((candidate) =>
      supportsTask(candidate.agentId, task, options) &&
      !candidate.assessment?.hardExcluded &&
      !candidate.reserveBlocked
    )
    .sort((a, b) => b.score - a.score);
  if (eligible[0]) return eligible[0].agentId;

  const detail = candidates.map((candidate) => {
    if (candidate.reserveBlocked) {
      return `${candidate.agentId} is held for the ${policy.reserveLeadCapacityPercent}% lead reserve`;
    }
    if (!supportsTask(candidate.agentId, task, options)) {
      return `${candidate.agentId} lacks a required capability`;
    }
    return `${candidate.agentId}: ${candidate.assessment?.reason ?? "unavailable"}`;
  }).join("; ");
  throw new CapacityRoutingError(task.id, detail);
}

function isCapacityEligible(
  agentId: string,
  task: Task,
  leadId: string,
  options: AssignAgentsOptions,
  policy: CapacityRoutingPolicy,
): boolean {
  const assessment = assessmentFor(agentId, options, policy);
  return supportsTask(agentId, task, options) && !assessment?.hardExcluded &&
    !isLeadReserveBlocked(agentId, task, leadId, assessment, policy);
}

function supportsTask(
  agentId: string,
  task: Task,
  options: AssignAgentsOptions,
): boolean {
  const capabilities = options.capabilitiesByAgent?.get(agentId);
  if (!capabilities) return true;
  const roleSupported = task.kind === "analysis"
    ? capabilities.planning && capabilities.repositoryRead
    : task.kind === "test"
      ? capabilities.testing && capabilities.shell
      : task.kind === "review"
        ? capabilities.repositoryRead
        : capabilities.repositoryWrite;
  return roleSupported && task.requiredCapabilities.every((token) =>
    capabilityHolds(token, capabilities)
  );
}

function assessmentFor(
  agentId: string,
  options: AssignAgentsOptions,
  policy: CapacityRoutingPolicy,
): CapacityAssessment | undefined {
  if (!options.capacityByAgent) return undefined;
  return assessCapacity(options.capacityByAgent.get(agentId), {
    policy,
    ...(options.modelByAgent?.get(agentId)
      ? { modelId: options.modelByAgent.get(agentId) }
      : {}),
  });
}

function isLeadReserveBlocked(
  agentId: string,
  task: Task,
  leadId: string,
  assessment: CapacityAssessment | undefined,
  policy: CapacityRoutingPolicy,
): boolean {
  return agentId === leadId &&
    task.kind !== "analysis" &&
    assessment?.trusted === true &&
    assessment.effectiveRemainingPercent !== undefined &&
    assessment.effectiveRemainingPercent <= policy.reserveLeadCapacityPercent;
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
  return kind === "review" || kind === "analysis" || kind === "test"
    ? "read-only"
    : "workspace-write";
}
