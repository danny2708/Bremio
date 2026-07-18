import type {
  AgentCapacitySnapshot,
  CapacityConfidence,
  QuotaProvider,
  QuotaWindow,
} from "./capacity";
import { AgentCapacitySnapshotSchema } from "./capacity";
import {
  readAqtQuota,
  type AqtQuotaSnapshot,
  type ProviderQuota,
  type ReadAqtQuotaOptions,
} from "./aqt-reader";

export const AQT_AGENT_IDS = ["claude", "codex", "antigravity"] as const;
export type AqtAgentId = (typeof AQT_AGENT_IDS)[number];

export interface AqtQuotaProviderOptions extends ReadAqtQuotaOptions {
  agentId: AqtAgentId;
}

/** One agent-facing view over AI-Quota-Tray's shared read-only snapshot store. */
export class AqtQuotaProvider implements QuotaProvider {
  readonly id: string;
  readonly #options: AqtQuotaProviderOptions;

  constructor(options: AqtQuotaProviderOptions) {
    this.id = `aqt:${options.agentId}`;
    this.#options = options;
  }

  async readSnapshot(): Promise<AgentCapacitySnapshot> {
    const source = readAqtQuota(this.#options);
    return toAgentCapacitySnapshot(source, this.#options.agentId);
  }
}

/** Map one AQT database read to cards without re-reading the database per agent. */
export function toAqtCapacitySnapshots(
  source: AqtQuotaSnapshot,
  agentIds: readonly AqtAgentId[] = AQT_AGENT_IDS,
): AgentCapacitySnapshot[] {
  return agentIds.map((agentId) => toAgentCapacitySnapshot(source, agentId));
}

export function toAgentCapacitySnapshot(
  source: AqtQuotaSnapshot,
  agentId: AqtAgentId,
): AgentCapacitySnapshot {
  const provider = source.providers.find((candidate) => candidate.agentId === agentId);
  if (!provider) return unavailableSnapshot(source, agentId);

  const windows = provider.buckets.map((bucket): QuotaWindow => ({
    id: bucket.bucketId,
    label: bucket.bucketName,
    scope: agentId === "antigravity" ? "model" : "account",
    ...(bucket.usedPercent !== undefined ? { usedPercent: bucket.usedPercent } : {}),
    ...(bucket.remainingPercent !== undefined
      ? { remainingPercent: bucket.remainingPercent }
      : {}),
    ...(bucket.resetsAt !== undefined ? { resetsAt: bucket.resetsAt } : {}),
    ...(bucket.windowMinutes !== undefined ? { windowMinutes: bucket.windowMinutes } : {}),
    capturedAt: bucket.fetchedAt,
    confidence: normalizeConfidence(bucket.confidence),
  }));

  return AgentCapacitySnapshotSchema.parse({
    agentId,
    // AQT observes provider quota, not whether an execution agent is busy or idle.
    availability: "unknown",
    status: provider.status,
    confidence: normalizeConfidence(provider.confidence),
    source: {
      name: provider.sourceName,
      confidenceLabel: provider.confidence,
    },
    capturedAt: oldestCapture(provider, source.readAt),
    windows,
  });
}

function unavailableSnapshot(
  source: AqtQuotaSnapshot,
  agentId: AqtAgentId,
): AgentCapacitySnapshot {
  return AgentCapacitySnapshotSchema.parse({
    agentId,
    availability: "unknown",
    status: "unknown",
    confidence: "low",
    source: { name: "AI-Quota-Tray", confidenceLabel: "unavailable" },
    capturedAt: source.readAt,
    windows: [],
  });
}

function oldestCapture(provider: ProviderQuota, fallback: number): number {
  if (provider.buckets.length === 0) return provider.updatedAt ?? fallback;
  return Math.min(...provider.buckets.map((bucket) => bucket.fetchedAt));
}

function normalizeConfidence(confidence: string): CapacityConfidence {
  switch (confidence) {
    case "official":
    case "local_official":
      return "high";
    case "manual":
      return "medium";
    default:
      return "low";
  }
}
