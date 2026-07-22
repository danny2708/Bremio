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
import type { RoutingConfig } from "./routing-config";

export interface ScoringConfig {
  capabilityWeight: number;
  quotaWeight: number;
  taskFitWeight: number;
  qualityWeight: number;
  speedWeight: number;
  preferenceWeight: number;
}

export interface AssignAgentsOptions {
  capabilitiesByAgent?: ReadonlyMap<string, AgentCapabilities>;
  capacityByAgent?: ReadonlyMap<string, AgentCapacitySnapshot>;
  capacityPolicy?: CapacityRoutingPolicyInput;
  /** Provider-confirmed model id selected for each candidate agent. */
  modelByAgent?: ReadonlyMap<string, string>;
  /** When present, enables weighted scoring instead of the deterministic path. */
  scoring?: ScoringConfig;
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
 * DIFFERENT agent" criterion holds for any plan shape.
 *
 * When `options.scoring` is set, the weighted scoring path is used instead.
 */
export function assignAgents(
  plan: Plan,
  leadId: string,
  workerId: string,
  options: AssignAgentsOptions = {},
): Map<string, string> {
  const policy = resolveCapacityRoutingPolicy(options.capacityPolicy);

  if (options.scoring) {
    return assignScored(plan, leadId, workerId, options, policy);
  }

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

function assignScored(
  plan: Plan,
  leadId: string,
  workerId: string,
  options: AssignAgentsOptions,
  policy: CapacityRoutingPolicy,
): Map<string, string> {
  const scoring = options.scoring!;
  const agentIds = [leadId, workerId];
  const assign = new Map<string, string>();

  for (const task of plan.tasks) {
    const best = pickBest(task, assign, agentIds, leadId, options, policy, scoring);
    assign.set(task.id, best.agentId);
  }

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

interface AgentScore {
  agentId: string;
  score: number;
  hardExcluded: boolean;
  reserveBlocked: boolean;
  reason: string;
}

function pickBest(
  task: Task,
  assign: ReadonlyMap<string, string>,
  agentIds: readonly string[],
  leadId: string,
  options: AssignAgentsOptions,
  policy: CapacityRoutingPolicy,
  scoring: ScoringConfig,
): AgentScore {
  const totalWeight =
    scoring.capabilityWeight +
    scoring.quotaWeight +
    scoring.taskFitWeight +
    scoring.qualityWeight +
    scoring.speedWeight +
    scoring.preferenceWeight;

  const candidates = agentIds.map((agentId) => {
    const assessment = assessmentFor(agentId, options, policy);
    const caps = options.capabilitiesByAgent?.get(agentId);
    const reserveBlocked = isLeadReserveBlocked(agentId, task, leadId, assessment, policy);

    if (caps && !supportsTask(agentId, task, options)) {
      return { agentId, score: Number.NEGATIVE_INFINITY, hardExcluded: true, reserveBlocked, reason: "lacks required capability" };
    }
    if (assessment?.hardExcluded) {
      return { agentId, score: Number.NEGATIVE_INFINITY, hardExcluded: true, reserveBlocked, reason: assessment.reason };
    }

    // Quota enters scoring as a coarse status band, not the graduated
    // `assessment.scoreAdjustment` the deterministic path uses. That means the
    // `unknownQuotaPenalty` / `criticalQuotaPenalty` knobs in config/routing.yaml
    // are NOT yet consumed here — the two literals below (self-review -100,
    // critical -40) are the hard rules from docs/08 §S2-T3. Wiring the graduated
    // penalty through belongs to the sprint that first turns scoring on; until
    // then a stale exhausted agent scores 0 rather than a soft penalty, which is
    // harsher than the deterministic path but still never a hard exclusion.
    const quotaScore = scoreQuota(assessment);
    const capabilityScore = 100;
    const taskFitScore = scoreTaskFit(agentId, task, leadId);
    const qualityScore = 50;
    const speedScore = 50;
    const preferenceScore = scorePreference(agentId, task);

    let score =
      (capabilityScore * scoring.capabilityWeight +
        quotaScore * scoring.quotaWeight +
        taskFitScore * scoring.taskFitWeight +
        qualityScore * scoring.qualityWeight +
        speedScore * scoring.speedWeight +
        preferenceScore * scoring.preferenceWeight) /
      totalWeight;

    if (task.kind === "review") {
      for (const dep of task.dependencies) {
        if (assign.get(dep) === agentId) {
          score -= 100;
          break;
        }
      }
    }

    if (assessment?.status === "critical") {
      score -= 40;
    }

    return { agentId, score, hardExcluded: false, reserveBlocked, reason: assessment?.reason ?? "unknown" };
  });

  const eligible = candidates
    .filter((c) => !c.hardExcluded && !c.reserveBlocked)
    .sort((a, b) => b.score - a.score);

  if (eligible.length > 0) return eligible[0]!;

  const detail = candidates
    .map((c) => {
      if (c.reserveBlocked) return `${c.agentId} is held for the ${policy.reserveLeadCapacityPercent}% lead reserve`;
      if (c.hardExcluded) return `${c.agentId}: ${c.reason}`;
      return `${c.agentId}: ${c.reason}`;
    })
    .join("; ");
  throw new CapacityRoutingError(task.id, detail);
}

function scoreQuota(assessment: CapacityAssessment | undefined): number {
  if (!assessment) return 50;
  switch (assessment.status) {
    case "healthy": return 100;
    case "limited": return 60;
    case "critical": return 40;
    case "exhausted": return 0;
    case "unknown": return 50;
  }
}

function scoreTaskFit(agentId: string, task: Task, leadId: string): number {
  const isLead = agentId === leadId;
  switch (task.kind) {
    case "analysis": return isLead ? 100 : 30;
    case "implementation": return isLead ? 50 : 100;
    case "test": return isLead ? 60 : 80;
    case "documentation": return isLead ? 40 : 80;
    case "other": return isLead ? 40 : 80;
    case "review": return 70;
  }
}

function scorePreference(agentId: string, task: Task): number {
  if (task.preferredAgents.length === 0) return 50;
  return task.preferredAgents.includes(agentId) ? 100 : 0;
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

export function routingInputFromConfig(config: RoutingConfig): CapacityRoutingPolicyInput {
  return { ...config.capacityPolicy };
}

export function scoringFromConfig(config: RoutingConfig): ScoringConfig {
  return { ...config.scoring };
}

export function permissionForKind(kind: TaskKind): Permission {
  return kind === "review" || kind === "analysis" || kind === "test"
    ? "read-only"
    : "workspace-write";
}
