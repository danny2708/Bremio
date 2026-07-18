import { describe, expect, it } from "vitest";
import type { AgentCapacitySnapshot, QuotaWindow } from "./capacity";
import {
  assessCapacity,
  resolveCapacityRoutingPolicy,
} from "./routing-policy";

function window(
  id: string,
  remainingPercent: number,
  overrides: Partial<QuotaWindow> = {},
): QuotaWindow {
  return {
    id,
    label: id,
    scope: "account",
    remainingPercent,
    capturedAt: 1_000,
    freshness: "fresh",
    confidence: "high",
    ...overrides,
  };
}

function snapshot(windows: QuotaWindow[]): AgentCapacitySnapshot {
  return {
    agentId: "codex",
    availability: "unknown",
    status: "healthy",
    confidence: "high",
    source: { name: "test", confidenceLabel: "official" },
    capturedAt: 1_000,
    freshness: "fresh",
    windows,
  };
}

describe("assessCapacity", () => {
  it("uses the minimum across all account rate-limit windows", () => {
    const result = assessCapacity(snapshot([
      window("5-hour", 80),
      window("weekly", 18),
    ]));

    expect(result).toMatchObject({
      status: "critical",
      effectiveRemainingPercent: 18,
      trusted: true,
      hardExcluded: false,
      scoreAdjustment: -40,
    });
  });

  it("hard-excludes only fresh high-confidence exhaustion", () => {
    const fresh = assessCapacity(snapshot([window("weekly", 4)]));
    const stale = assessCapacity(snapshot([
      window("weekly", 4, { freshness: "stale", confidence: "low" }),
    ]));

    expect(fresh.hardExcluded).toBe(true);
    expect(fresh.scoreAdjustment).toBe(Number.NEGATIVE_INFINITY);
    expect(stale).toMatchObject({
      status: "exhausted",
      trusted: false,
      hardExcluded: false,
      scoreAdjustment: -10,
    });
  });

  it("requires an explicit matching model id for model-scoped capacity", () => {
    const modelSnapshot = snapshot([
      window("gemini-pro", 0, { scope: "model", modelId: "gemini-pro" }),
      window("gemini-flash", 90, { scope: "model", modelId: "gemini-flash" }),
    ]);

    expect(assessCapacity(modelSnapshot)).toMatchObject({
      status: "unknown",
      hardExcluded: false,
      scoreAdjustment: -10,
    });
    expect(assessCapacity(modelSnapshot, { modelId: "gemini-flash" })).toMatchObject({
      status: "healthy",
      effectiveRemainingPercent: 90,
      hardExcluded: false,
    });
    expect(assessCapacity(modelSnapshot, { modelId: "gemini-pro" }).hardExcluded).toBe(true);
  });

  it("does not route on display-only model buckets without verified model ids", () => {
    const result = assessCapacity(snapshot([
      window("Gemini Pro High", 0, { scope: "model" }),
    ]), { modelId: "gemini-pro" });

    expect(result).toMatchObject({ status: "unknown", hardExcluded: false });
  });
});

describe("resolveCapacityRoutingPolicy", () => {
  it("accepts threshold overrides and rejects overlapping bands", () => {
    expect(resolveCapacityRoutingPolicy({ healthyRemainingPercentMin: 60 }))
      .toMatchObject({ healthyRemainingPercentMin: 60 });
    expect(() => resolveCapacityRoutingPolicy({ limitedRemainingPercentMin: 50 }))
      .toThrow(/healthy > limited/);
  });
});
