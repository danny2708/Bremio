import { describe, expect, it } from "vitest";
import type { AgentCapabilities } from "@bremio/adapter-sdk";
import { PlanSchema, type Plan } from "@bremio/protocol";
import { PlanValidationError, validatePlan } from "./validator";

const fullCaps: AgentCapabilities = {
  planning: true,
  structuredOutput: true,
  repositoryRead: true,
  repositoryWrite: true,
  shell: true,
  testing: true,
  browser: false,
  vision: false,
  resumableSessions: true,
};

const caps = new Map<string, AgentCapabilities>([
  ["claude", fullCaps],
  ["codex", fullCaps],
]);

function plan(tasks: unknown[]): Plan {
  return PlanSchema.parse({ summary: "s", leadAgentId: "claude", tasks });
}

describe("validatePlan", () => {
  it("accepts a valid linear plan", () => {
    const p = plan([
      { id: "TASK-001", title: "analyze", kind: "analysis", risk: "low" },
      {
        id: "TASK-002",
        title: "impl",
        kind: "implementation",
        risk: "medium",
        dependencies: ["TASK-001"],
        requiredCapabilities: ["repository.write", "shell"],
      },
    ]);
    expect(() => validatePlan(p, caps)).not.toThrow();
  });

  it("rejects a dependency cycle", () => {
    const p = plan([
      { id: "A", title: "a", kind: "implementation", risk: "low", dependencies: ["B"] },
      { id: "B", title: "b", kind: "implementation", risk: "low", dependencies: ["A"] },
    ]);
    expect(() => validatePlan(p, caps)).toThrow(PlanValidationError);
    try {
      validatePlan(p, caps);
    } catch (e) {
      expect((e as PlanValidationError).errors.join()).toMatch(/cycle/);
    }
  });

  it("rejects a dependency on an unknown task", () => {
    const p = plan([
      { id: "A", title: "a", kind: "implementation", risk: "low", dependencies: ["ghost"] },
    ]);
    expect(() => validatePlan(p, caps)).toThrow(/unknown task ghost/);
  });

  it("rejects a required capability no agent provides", () => {
    const p = plan([
      {
        id: "A",
        title: "look at screen",
        kind: "implementation",
        risk: "low",
        requiredCapabilities: ["vision"],
      },
    ]);
    expect(() => validatePlan(p, caps)).toThrow(/capability "vision"/);
  });
});
