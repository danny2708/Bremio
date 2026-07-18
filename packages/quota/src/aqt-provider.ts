import type {
  AgentCapacitySnapshot,
  CapacityConfidence,
  CapacityFreshness,
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
  /** Unix seconds after which confidence degrades one level. Defaults to half the stale limit. */
  agingAfterSeconds?: number;
}

export interface CapacityFreshnessOptions {
  agingAfterSeconds?: number;
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
    const { agentId, agingAfterSeconds, ...readOptions } = this.#options;
    const source = readAqtQuota(readOptions);
    return toAgentCapacitySnapshot(source, agentId, { agingAfterSeconds });
  }
}

/** Map one AQT database read to cards without re-reading the database per agent. */
export function toAqtCapacitySnapshots(
  source: AqtQuotaSnapshot,
  options: CapacityFreshnessOptions = {},
  agentIds: readonly AqtAgentId[] = AQT_AGENT_IDS,
): AgentCapacitySnapshot[] {
  return agentIds.map((agentId) => toAgentCapacitySnapshot(source, agentId, options));
}

export function toAgentCapacitySnapshot(
  source: AqtQuotaSnapshot,
  agentId: AqtAgentId,
  options: CapacityFreshnessOptions = {},
): AgentCapacitySnapshot {
  const agingAfterSeconds = resolveAgingAfterSeconds(source, options);
  const provider = source.providers.find((candidate) => candidate.agentId === agentId);
  if (!provider) return unavailableSnapshot(source, agentId);

  const windows = provider.buckets.map((bucket): QuotaWindow => {
    const freshness = freshnessFor(
      bucket.fetchedAt,
      source.readAt,
      agingAfterSeconds,
      source.staleAfterSeconds,
    );
    return {
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
      freshness,
      confidence: confidenceFor(bucket.confidence, freshness),
    };
  });

  const capturedAt = oldestCapture(provider, source.readAt);
  const freshness = freshnessFor(
    capturedAt,
    source.readAt,
    agingAfterSeconds,
    source.staleAfterSeconds,
  );

  return AgentCapacitySnapshotSchema.parse({
    agentId,
    // AQT observes provider quota, not whether an execution agent is busy or idle.
    availability: "unknown",
    status: provider.status,
    confidence: confidenceFor(provider.confidence, freshness),
    source: {
      name: provider.sourceName,
      confidenceLabel: provider.confidence,
    },
    capturedAt,
    freshness,
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
    freshness: "unknown",
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

function resolveAgingAfterSeconds(
  source: AqtQuotaSnapshot,
  options: CapacityFreshnessOptions,
): number {
  const value = options.agingAfterSeconds ?? source.staleAfterSeconds / 2;
  if (!Number.isFinite(value) || value <= 0 || value >= source.staleAfterSeconds) {
    throw new Error("agingAfterSeconds must be positive and less than staleAfterSeconds");
  }
  return value;
}

function freshnessFor(
  capturedAt: number,
  readAt: number,
  agingAfterSeconds: number,
  staleAfterSeconds: number,
): CapacityFreshness {
  const ageSeconds = Math.max(0, readAt - capturedAt);
  if (ageSeconds > staleAfterSeconds) return "stale";
  if (ageSeconds > agingAfterSeconds) return "aging";
  return "fresh";
}

function confidenceFor(sourceConfidence: string, freshness: CapacityFreshness): CapacityConfidence {
  const confidence = normalizeConfidence(sourceConfidence);
  if (freshness === "stale" || freshness === "unknown") return "low";
  if (freshness === "aging") return confidence === "high" ? "medium" : "low";
  return confidence;
}
