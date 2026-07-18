import { describe, expect, it } from "vitest";
import { PlanSchema, type Plan } from "@bremio/protocol";
import { assignAgents, topologicalOrder } from "./router";

function plan(tasks: unknown[]): Plan {
  return PlanSchema.parse({ summary: "s", leadAgentId: "claude", tasks });
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
