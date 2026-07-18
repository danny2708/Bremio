import { describe, expect, it } from "vitest";
import type { AgentCapacitySnapshot } from "@bremio/quota";
import { shouldAlert } from "./quota";

function capacity(
  overrides: Partial<AgentCapacitySnapshot> = {},
): AgentCapacitySnapshot {
  return {
    agentId: "codex",
    availability: "unknown",
    status: "limited",
    confidence: "high",
    source: { name: "Codex app-server", confidenceLabel: "official" },
    capturedAt: 1_000,
    freshness: "fresh",
    windows: [],
    ...overrides,
  };
}

describe("Capacity alerts", () => {
  it("alerts on fresh or aging low capacity with usable confidence", () => {
    expect(shouldAlert(capacity())).toBe(true);
    expect(shouldAlert(capacity({ freshness: "aging", confidence: "medium" }))).toBe(true);
  });

  it("suppresses stale, unknown, and low-confidence signals", () => {
    expect(shouldAlert(capacity({ freshness: "stale", confidence: "low" }))).toBe(false);
    expect(shouldAlert(capacity({ status: "unknown" }))).toBe(false);
    expect(shouldAlert(capacity({ confidence: "low" }))).toBe(false);
  });
});
