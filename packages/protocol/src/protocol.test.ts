import { describe, expect, it } from "vitest";
import {
  AgentEventSchema,
  ExecutionModeSchema,
  PlanSchema,
  TaskResultSchema,
} from "./index";

describe("ExecutionModeSchema", () => {
  it("allows only explicit manual modes", () => {
    expect(ExecutionModeSchema.options).toEqual(["single", "team"]);
    expect(() => ExecutionModeSchema.parse("auto")).toThrow();
  });
});

describe("PlanSchema", () => {
  it("parses a minimal plan and applies task defaults", () => {
    const plan = PlanSchema.parse({
      summary: "Implement scheduled sync",
      leadAgentId: "claude",
      tasks: [{ id: "TASK-001", title: "Analyze", kind: "analysis", risk: "high" }],
    });
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]?.requiredCapabilities).toEqual([]);
    expect(plan.tasks[0]?.dependencies).toEqual([]);
  });

  it("rejects a plan with no tasks", () => {
    expect(() =>
      PlanSchema.parse({ summary: "x", leadAgentId: "codex", tasks: [] }),
    ).toThrow();
  });

  it("rejects a non-branch-safe task id", () => {
    expect(() =>
      PlanSchema.parse({
        summary: "x",
        leadAgentId: "codex",
        tasks: [{ id: "bad id/slash", title: "t", kind: "other", risk: "low" }],
      }),
    ).toThrow();
  });
});

describe("AgentEventSchema", () => {
  it("discriminates a completed event with an outcome", () => {
    const ev = AgentEventSchema.parse({
      type: "completed",
      runId: "run-1",
      ts: Date.now(),
      outcome: { status: "completed", finalText: "{}" },
    });
    expect(ev.type).toBe("completed");
  });

  it("rejects an unknown event type", () => {
    expect(() =>
      AgentEventSchema.parse({ type: "nope", runId: "r", ts: 0 }),
    ).toThrow();
  });
});

describe("TaskResultSchema", () => {
  it("fills array defaults", () => {
    const r = TaskResultSchema.parse({
      taskId: "TASK-001",
      agentId: "codex",
      status: "completed",
      summary: "done",
    });
    expect(r.filesChanged).toEqual([]);
    expect(r.tests).toEqual([]);
    expect(r.findings).toEqual([]);
  });

  it("keeps requested and provider-confirmed execution identity separate", () => {
    const result = TaskResultSchema.parse({
      taskId: "TASK-001",
      agentId: "claude",
      status: "completed",
      summary: "done",
      requestedModel: "claude-requested",
      actualModel: "claude-actual",
      requestedReasoningLevel: "high",
      actualReasoningLevel: "medium",
    });

    expect(result.requestedModel).toBe("claude-requested");
    expect(result.actualModel).toBe("claude-actual");
    expect(result.requestedReasoningLevel).toBe("high");
    expect(result.actualReasoningLevel).toBe("medium");
  });
});
