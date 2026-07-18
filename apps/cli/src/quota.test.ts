import { describe, expect, it } from "vitest";
import type { AgentCapacitySnapshot, QuotaWindow } from "@bremio/quota";
import { shouldAlert } from "./quota";

function window(overrides: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    id: "weekly",
    label: "Weekly",
    scope: "account",
    remainingPercent: 18,
    capturedAt: 1_000,
    freshness: "fresh",
    confidence: "high",
    ...overrides,
  };
}

function capacity(
  overrides: Partial<AgentCapacitySnapshot> = {},
): AgentCapacitySnapshot {
  return {
    agentId: "codex",
    availability: "unknown",
    status: "limited",
    confidence: "high",
    source: { name: "Codex app-server", confidenceLabel: "official" },
    lastContactAt: 1_000,
    contactFreshness: "fresh",
    windows: [window()],
    ...overrides,
  };
}

describe("Capacity alerts", () => {
  it("alerts on low capacity backed by fresh high-confidence windows", () => {
    expect(shouldAlert(capacity())).toBe(true);
  });

  it("suppresses alerts when a window is stale or low-confidence", () => {
    expect(shouldAlert(capacity({ windows: [window({ freshness: "stale", confidence: "low" })] })))
      .toBe(false);
    expect(shouldAlert(capacity({ windows: [window({ freshness: "aging", confidence: "medium" })] })))
      .toBe(false);
  });

  it("suppresses alerts when a reachable source has only stale numbers", () => {
    // The contact/data split: reaching AQT says nothing about the values, so a
    // fresh contact must not resurrect an alert on six-day-old windows.
    const reachableButStale = capacity({
      contactFreshness: "fresh",
      confidence: "high",
      windows: [window({ freshness: "stale", confidence: "low" })],
    });
    expect(shouldAlert(reachableButStale)).toBe(false);
  });

  it("suppresses alerts with no windows or an unknown status", () => {
    expect(shouldAlert(capacity({ windows: [] }))).toBe(false);
    expect(shouldAlert(capacity({ status: "unknown" }))).toBe(false);
  });
});
