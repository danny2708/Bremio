import { describe, expect, it } from "vitest";
import { PlanSchema, type Plan } from "@bremio/protocol";
import type { AgentCapacitySnapshot } from "@bremio/quota";
import { assignAgents, topologicalOrder, type ScoringConfig } from "./router";

const DEFAULT_SCORING: ScoringConfig = {
  capabilityWeight: 30,
  quotaWeight: 25,
  taskFitWeight: 20,
  qualityWeight: 15,
  speedWeight: 5,
  preferenceWeight: 5,
};

const LEAD_CAPS = {
  planning: true,
  structuredOutput: true,
  repositoryRead: true,
  repositoryWrite: true,
  shell: true,
  testing: true,
  browser: false,
  vision: false,
  resumableSessions: true,
  readOnlyEnforcement: "provider-native" as const,
};

const ANTIGRAVITY_CAPS = {
  ...LEAD_CAPS,
  planning: false,
  testing: false,
  resumableSessions: false,
};

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
    lastContactAt: 1_000,
    contactFreshness: freshness,
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

  it("uses Antigravity for implementation but falls back for test gates", () => {
    const p = plan([
      { id: "T1", title: "impl", kind: "implementation", risk: "low" },
      {
        id: "T2",
        title: "test",
        kind: "test",
        risk: "low",
        dependencies: ["T1"],
        requiredCapabilities: ["shell", "test"],
      },
    ]);
    const assign = assignAgents(p, "claude", "antigravity", {
      capabilitiesByAgent: new Map([
        ["claude", LEAD_CAPS],
        ["antigravity", ANTIGRAVITY_CAPS],
      ]),
    });

    expect(assign.get("T1")).toBe("antigravity");
    expect(assign.get("T2")).toBe("claude");
  });

  it("distributes implementation tasks across multiple workers (S10-T7)", () => {
    const p = plan([
      { id: "T1", title: "analyze", kind: "analysis", risk: "low" },
      { id: "T2", title: "impl 1", kind: "implementation", risk: "low", dependencies: ["T1"] },
      { id: "T3", title: "impl 2", kind: "implementation", risk: "low", dependencies: ["T1"] },
      { id: "T4", title: "review", kind: "review", risk: "low", dependencies: ["T2"] },
    ]);

    const assign = assignAgents(p, "claude", ["codex", "antigravity"]);
    expect(assign.get("T1")).toBe("claude");
    expect(assign.get("T2")).toBe("codex");
    expect(assign.get("T3")).toBe("antigravity");
    // T4 reviews T2 (authored by codex), so independent choices are claude or antigravity
    expect(assign.get("T4")).not.toBe("codex");
  });
});

describe("assignAgents with weighted scoring", () => {
  it("scores by capability, quota, task-fit, and preference — analysis stays on the lead", () => {
    const p = plan([
      { id: "T1", title: "analyze", kind: "analysis", risk: "low" },
      { id: "T2", title: "impl", kind: "implementation", risk: "low", dependencies: ["T1"] },
    ]);
    const assign = assignAgents(p, "claude", "codex", { scoring: DEFAULT_SCORING });
    expect(assign.get("T1")).toBe("claude");
    expect(assign.get("T2")).toBe("codex");
  });

  it("applies -100 self-review penalty when candidate authored the dependency", () => {
    const p = plan([
      { id: "T1", title: "impl", kind: "implementation", risk: "low" },
      { id: "T2", title: "review", kind: "review", risk: "low", dependencies: ["T1"] },
    ]);
    const assign = assignAgents(p, "claude", "codex", {
      scoring: DEFAULT_SCORING,
      capacityByAgent: new Map([
        ["claude", capacity("claude", 100)],
        ["codex", capacity("codex", 100)],
      ]),
    });
    expect(assign.get("T1")).toBe("codex");
    expect(assign.get("T2")).not.toBe("codex");
    expect(assign.get("T2")).toBe("claude");
  });

  it("applies -40 critical quota penalty and favours the healthy agent", () => {
    const p = plan([{ id: "T1", title: "impl", kind: "implementation", risk: "low" }]);
    const assign = assignAgents(p, "claude", "codex", {
      scoring: DEFAULT_SCORING,
      capacityByAgent: new Map([
        ["claude", capacity("claude", 100)],
        ["codex", capacity("codex", 6, "fresh")], // critical band
      ]),
    });
    expect(assign.get("T1")).toBe("claude");
  });

  it("excludes an agent that lacks repositoryWrite from write tasks", () => {
    const noWriteCaps = { ...LEAD_CAPS, repositoryWrite: false };
    const p = plan([{ id: "T1", title: "impl", kind: "implementation", risk: "low" }]);
    const assign = assignAgents(p, "claude", "codex", {
      scoring: DEFAULT_SCORING,
      capabilitiesByAgent: new Map([
        ["claude", noWriteCaps],
        ["codex", LEAD_CAPS],
      ]),
    });
    expect(assign.get("T1")).toBe("codex");
  });

  it("never hard-excludes on stale exhaustion — only a soft penalty applies", () => {
    const p = plan([{ id: "T1", title: "impl", kind: "implementation", risk: "low" }]);
    const assign = assignAgents(p, "claude", "codex", {
      scoring: DEFAULT_SCORING,
      capacityByAgent: new Map([
        ["claude", capacity("claude", 100)],
        ["codex", capacity("codex", 0, "stale")],
      ]),
    });
    expect(assign.get("T1")).toBe("codex");
  });

  it("respects the lead capacity reserve — worker wins over reserve-blocked lead", () => {
    const p = plan([{ id: "T1", title: "impl", kind: "implementation", risk: "low" }]);
    const assign = assignAgents(p, "claude", "codex", {
      scoring: DEFAULT_SCORING,
      capacityByAgent: new Map([
        ["claude", capacity("claude", 10)],
        ["codex", capacity("codex", 100)],
      ]),
    });
    expect(assign.get("T1")).toBe("codex");
  });

  it("guarantees delegation — at least one task reaches a different agent", () => {
    const p = plan([{ id: "T1", title: "analyze", kind: "analysis", risk: "low" }]);
    const assign = assignAgents(p, "claude", "codex", { scoring: DEFAULT_SCORING });
    expect([...assign.values()].some((a) => a !== "claude")).toBe(true);
  });

  it("is byte-identical to the deterministic path when scoring is absent", () => {
    const p = plan([
      { id: "T1", title: "analyze", kind: "analysis", risk: "low" },
      { id: "T2", title: "impl", kind: "implementation", risk: "low", dependencies: ["T1"] },
    ]);
    const without = assignAgents(p, "claude", "codex");
    const explicitlyAbsent = assignAgents(p, "claude", "codex", {});
    expect([...without.entries()]).toEqual([...explicitlyAbsent.entries()]);
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
