import { describe, expect, it } from "vitest";
import { PlanSchema, TaskResultSchema, type Plan, type TaskResult } from "@bremio/protocol";
import { evaluateQualityGate, parseReviewOutput, type QualityGateTask } from "./quality-gate";

function plan(): Plan {
  return PlanSchema.parse({
    summary: "implement safely",
    leadAgentId: "claude",
    tasks: [
      { id: "T1", title: "implement", kind: "implementation", risk: "low" },
      { id: "T2", title: "test", kind: "test", risk: "low", dependencies: ["T1"] },
      { id: "T3", title: "review", kind: "review", risk: "low", dependencies: ["T2"] },
    ],
  });
}

function result(overrides: Partial<TaskResult> & Pick<TaskResult, "taskId" | "agentId">): TaskResult {
  return TaskResultSchema.parse({
    status: "completed",
    summary: "done",
    filesChanged: [],
    commandsExecuted: [],
    tests: [],
    findings: [],
    ...overrides,
  });
}

function entries(overrides: Partial<Record<string, TaskResult>> = {}): QualityGateTask[] {
  const p = plan();
  const defaults: Record<string, TaskResult> = {
    T1: result({ taskId: "T1", agentId: "codex", filesChanged: ["greet.js"] }),
    T2: result({
      taskId: "T2",
      agentId: "codex",
      tests: [{ command: "node test.js", passed: 1, failed: 0, exitCode: 0 }],
    }),
    T3: result({ taskId: "T3", agentId: "claude" }),
  };
  return p.tasks.map((task) => ({
    task,
    agentId: (overrides[task.id] ?? defaults[task.id])?.agentId ?? "",
    result: overrides[task.id] ?? (defaults[task.id] as TaskResult),
  }));
}

describe("evaluateQualityGate", () => {
  it("passes with exit-zero test evidence and an independent review", () => {
    expect(evaluateQualityGate(plan(), entries())).toMatchObject({ status: "passed", reasons: [] });
  });

  it("fails closed on a self-review and an open blocker", () => {
    const review = result({
      taskId: "T3",
      agentId: "codex",
      findings: [{ severity: "blocker", message: "unsafe", status: "open" }],
    });
    const gate = evaluateQualityGate(plan(), entries({ T3: review }));
    expect(gate.status).toBe("failed");
    expect(gate.reasons.join(" ")).toMatch(/self-review/);
    expect(gate.reasons.join(" ")).toMatch(/open blocker/);
  });

  it("fails when the test task has no shell evidence", () => {
    const test = result({ taskId: "T2", agentId: "codex", tests: [] });
    expect(evaluateQualityGate(plan(), entries({ T2: test })).reasons.join(" ")).toMatch(
      /no shell test evidence/,
    );
  });
});

describe("parseReviewOutput", () => {
  it("reads native structured review findings", () => {
    const parsed = parseReviewOutput({
      outcome: {
        status: "completed",
        structured: {
          summary: "reviewed",
          findings: [{ severity: "warning", message: "add edge case", status: "open" }],
        },
      },
      assistantText: "",
      commands: [],
      tests: [],
      filesRead: [],
      filesWritten: [],
    });
    expect(parsed).toMatchObject({ ok: true, summary: "reviewed" });
  });
});
