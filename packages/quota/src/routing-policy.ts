import type {
  AgentCapacitySnapshot,
  CapacityStatus,
  QuotaWindow,
} from "./capacity";

export interface CapacityRoutingPolicy {
  healthyRemainingPercentMin: number;
  limitedRemainingPercentMin: number;
  criticalRemainingPercentMin: number;
  avoidCriticalAgents: boolean;
  prohibitExhaustedAgents: boolean;
  reserveLeadCapacityPercent: number;
  unknownQuotaPenalty: number;
  criticalQuotaPenalty: number;
}

export type CapacityRoutingPolicyInput = Partial<CapacityRoutingPolicy>;

export const DEFAULT_CAPACITY_ROUTING_POLICY: Readonly<CapacityRoutingPolicy> = {
  healthyRemainingPercentMin: 50,
  limitedRemainingPercentMin: 20,
  criticalRemainingPercentMin: 5,
  avoidCriticalAgents: true,
  prohibitExhaustedAgents: true,
  reserveLeadCapacityPercent: 15,
  unknownQuotaPenalty: 10,
  criticalQuotaPenalty: 40,
};

export interface CapacityAssessment {
  agentId: string;
  status: CapacityStatus;
  effectiveRemainingPercent?: number;
  /** True only when every applicable window is fresh, high-confidence, and quantified. */
  trusted: boolean;
  hardExcluded: boolean;
  scoreAdjustment: number;
  reason: string;
}

export interface AssessCapacityOptions {
  /** Required when the snapshot contains model-scoped windows. */
  modelId?: string;
  policy?: CapacityRoutingPolicyInput;
}

/**
 * Reduce a canonical snapshot to the conservative signal the router may use.
 * Account windows all constrain the candidate; model windows constrain only
 * the explicitly selected provider model.
 */
export function assessCapacity(
  snapshot: AgentCapacitySnapshot | undefined,
  options: AssessCapacityOptions = {},
): CapacityAssessment {
  const policy = resolveCapacityRoutingPolicy(options.policy);
  if (!snapshot) return unknownAssessment("unknown", policy, "no capacity snapshot");

  const accountWindows = snapshot.windows.filter((window) => window.scope === "account");
  const modelWindows = snapshot.windows.filter((window) => window.scope === "model");
  let applicable = accountWindows;

  if (modelWindows.length > 0) {
    if (!options.modelId) {
      return unknownAssessment(
        snapshot.agentId,
        policy,
        "candidate model is required for model-scoped capacity",
      );
    }
    const matching = modelWindows.filter((window) => window.modelId === options.modelId);
    if (matching.length === 0) {
      return unknownAssessment(
        snapshot.agentId,
        policy,
        `no capacity window matches model ${options.modelId}`,
      );
    }
    applicable = [...accountWindows, ...matching];
  }

  if (applicable.length === 0) {
    return unknownAssessment(snapshot.agentId, policy, "no applicable capacity windows");
  }

  const quantified = applicable.filter(
    (window): window is QuotaWindow & { remainingPercent: number } =>
      window.remainingPercent !== undefined,
  );
  if (quantified.length === 0) {
    return unknownAssessment(snapshot.agentId, policy, "remaining capacity is unavailable");
  }

  const effectiveRemainingPercent = Math.min(
    ...quantified.map((window) => window.remainingPercent),
  );
  const status = statusForRemaining(effectiveRemainingPercent, policy);
  const trusted = quantified.length === applicable.length && applicable.every(isTrustedWindow);
  const constrainingWindows = quantified.filter(
    (window) => window.remainingPercent === effectiveRemainingPercent,
  );
  const confirmedExhaustion = status === "exhausted" &&
    constrainingWindows.some(isTrustedWindow);
  const hardExcluded = policy.prohibitExhaustedAgents && confirmedExhaustion;

  if (hardExcluded) {
    return {
      agentId: snapshot.agentId,
      status,
      effectiveRemainingPercent,
      trusted,
      hardExcluded: true,
      scoreAdjustment: Number.NEGATIVE_INFINITY,
      reason: `confirmed exhausted at ${effectiveRemainingPercent}% remaining`,
    };
  }

  if (!trusted) {
    return {
      agentId: snapshot.agentId,
      status,
      effectiveRemainingPercent,
      trusted: false,
      hardExcluded: false,
      scoreAdjustment: -policy.unknownQuotaPenalty,
      reason: `last-known ${effectiveRemainingPercent}% is not fresh high-confidence data`,
    };
  }

  const criticalPenalty =
    policy.avoidCriticalAgents && (status === "critical" || status === "exhausted")
      ? -policy.criticalQuotaPenalty
      : 0;
  return {
    agentId: snapshot.agentId,
    status,
    effectiveRemainingPercent,
    trusted: true,
    hardExcluded: false,
    scoreAdjustment: criticalPenalty,
    reason: `${status} at ${effectiveRemainingPercent}% remaining`,
  };
}

export function resolveCapacityRoutingPolicy(
  input: CapacityRoutingPolicyInput = {},
): CapacityRoutingPolicy {
  const policy = { ...DEFAULT_CAPACITY_ROUTING_POLICY, ...input };
  const {
    healthyRemainingPercentMin: healthy,
    limitedRemainingPercentMin: limited,
    criticalRemainingPercentMin: critical,
  } = policy;
  if (
    ![healthy, limited, critical].every(Number.isFinite) ||
    healthy > 100 ||
    healthy <= limited ||
    limited <= critical ||
    critical < 0
  ) {
    throw new Error(
      "capacity thresholds must satisfy 100 >= healthy > limited > critical >= 0",
    );
  }
  if (
    !Number.isFinite(policy.reserveLeadCapacityPercent) ||
    policy.reserveLeadCapacityPercent < 0 ||
    policy.reserveLeadCapacityPercent > 100
  ) {
    throw new Error("reserveLeadCapacityPercent must be between 0 and 100");
  }
  for (const [name, value] of [
    ["unknownQuotaPenalty", policy.unknownQuotaPenalty],
    ["criticalQuotaPenalty", policy.criticalQuotaPenalty],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${name} must be a non-negative number`);
    }
  }
  return policy;
}

function statusForRemaining(
  remainingPercent: number,
  policy: CapacityRoutingPolicy,
): CapacityStatus {
  if (remainingPercent >= policy.healthyRemainingPercentMin) return "healthy";
  if (remainingPercent >= policy.limitedRemainingPercentMin) return "limited";
  if (remainingPercent >= policy.criticalRemainingPercentMin) return "critical";
  return "exhausted";
}

function isTrustedWindow(window: QuotaWindow): boolean {
  return window.freshness === "fresh" && window.confidence === "high";
}

function unknownAssessment(
  agentId: string,
  policy: CapacityRoutingPolicy,
  reason: string,
): CapacityAssessment {
  return {
    agentId,
    status: "unknown",
    trusted: false,
    hardExcluded: false,
    scoreAdjustment: -policy.unknownQuotaPenalty,
    reason,
  };
}
