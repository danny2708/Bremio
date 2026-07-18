import { describe, expect, it } from "vitest";
import { PlanSchema, type Plan } from "@bremio/protocol";
import type { AgentCapacitySnapshot } from "@bremio/quota";
import { assignAgents, topologicalOrder } from "./router";

function plan(tasks: unknown[]): Plan {
  return PlanSchema.parse({ summary: "s", leadAgentId: "claude", tasks });
}

function capacity(
  agentId: string,
  remainingPercent: number,
  freshness: "fresh" | "stale" = "fresh",
): AgentCapacitySnapshot {
  return {
    agentId,
    availability: "unknown",
    status: remainingPercent === 0 ? "exhausted" : "healthy",
    confidence: freshness === "fresh" ? "high" : "low",
    source: { name: "test", confidenceLabel: "official" },
    capturedAt: 1_000,
    freshness,
    windows: [{
      id: "account",
      label: "Account",
      scope: "account",
      remainingPercent,
      capturedAt: 1_000,
      freshness,
      confidence: freshness === "fresh" ? "high" : "low",
    }],
  };
}

describe("assignAgents (lead ≠ worker)", () => {
  it("keeps analysis on the lead and delegates execution to the worker", () => {
    const p = plan([
      { id: "T1", title: "analyze", kind: "analysis", risk: "low" },
      { id: "T2", title: "impl", kind: "implementation", risk: "low", dependencies: ["T1"] },
    ]);
    const assign = assignAgents(p, "claude", "codex");
    expect(assign.get("T1")).toBe("claude");
    expect(assign.get("T2")).toBe("codex");
  });

  it("guarantees at least one task goes to a different agent", () => {
    // An analysis-only plan would otherwise stay entirely on the lead.
    const p = plan([{ id: "T1", title: "analyze", kind: "analysis", risk: "low" }]);
    const assign = assignAgents(p, "claude", "codex");
    expect([...assign.values()].some((a) => a !== "claude")).toBe(true);
  });

  it("assigns a review to an agent other than the implementation author", () => {
    const p = plan([
      { id: "T1", title: "implement", kind: "implementation", risk: "low" },
      { id: "T2", title: "review", kind: "review", risk: "low", dependencies: ["T1"] },
    ]);
    const assign = assignAgents(p, "claude", "codex");
    expect(assign.get("T1")).toBe("codex");
    expect(assign.get("T2")).toBe("claude");
  });

  it("falls back from a confirmed exhausted worker to a healthy lead", () => {
    const p = plan([{ id: "T1", title: "impl", kind: "implementation", risk: "low" }]);
    const assign = assignAgents(p, "claude", "codex", {
      capacityByAgent: new Map([
        ["claude", capacity("claude", 80)],
        ["codex", capacity("codex", 0)],
      ]),
    });

    expect(assign.get("T1")).toBe("claude");
  });

  it("treats stale exhaustion as a soft signal and preserves deterministic routing", () => {
    const p = plan([{ id: "T1", title: "impl", kind: "implementation", risk: "low" }]);
    const assign = assignAgents(p, "claude", "codex", {
      capacityByAgent: new Map([
        ["claude", capacity("claude", 80)],
        ["codex", capacity("codex", 0, "stale")],
      ]),
    });

    expect(assign.get("T1")).toBe("codex");
  });

  it("avoids a trusted critical worker when the lead has healthy spare capacity", () => {
    const p = plan([{ id: "T1", title: "impl", kind: "implementation", risk: "low" }]);
    const assign = assignAgents(p, "claude", "codex", {
      capacityByAgent: new Map([
        ["claude", capacity("claude", 80)],
        ["codex", capacity("codex", 10)],
      ]),
    });

    expect(assign.get("T1")).toBe("claude");
  });

  it("does not spend reserved lead capacity to replace an exhausted worker", () => {
    const p = plan([{ id: "T1", title: "impl", kind: "implementation", risk: "low" }]);

    expect(() => assignAgents(p, "claude", "codex", {
      capacityByAgent: new Map([
        ["claude", capacity("claude", 10)],
        ["codex", capacity("codex", 0)],
      ]),
    })).toThrow(/15% lead reserve/);
  });

  it("accepts configurable capacity thresholds", () => {
    const p = plan([{ id: "T1", title: "impl", kind: "implementation", risk: "low" }]);
    const assign = assignAgents(p, "claude", "codex", {
      capacityByAgent: new Map([
        ["claude", capacity("claude", 80)],
        ["codex", capacity("codex", 4)],
      ]),
      capacityPolicy: {
        limitedRemainingPercentMin: 4,
        criticalRemainingPercentMin: 1,
      },
    });

    expect(assign.get("T1")).toBe("codex");
  });
});

describe("topologicalOrder", () => {
  it("orders dependencies before dependents", () => {
    const p = plan([
      { id: "C", title: "c", kind: "implementation", risk: "low", dependencies: ["B"] },
      { id: "A", title: "a", kind: "analysis", risk: "low" },
      { id: "B", title: "b", kind: "implementation", risk: "low", dependencies: ["A"] },
    ]);
    const order = topologicalOrder(p).map((t) => t.id);
    expect(order.indexOf("A")).toBeLessThan(order.indexOf("B"));
    expect(order.indexOf("B")).toBeLessThan(order.indexOf("C"));
  });
});
