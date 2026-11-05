import { describe, expect, it } from "vitest";
import type { Plan, Task, TaskResult } from "@bremio/protocol";
import { evaluateDefinitionOfDone, evaluateSingleDefinitionOfDone } from "./definition-of-done";

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id, title: id, kind: "implementation", risk: "low", requiredCapabilities: [],
    preferredAgents: [], dependencies: [], expectedArtifacts: [], acceptanceCriteria: [], ...over,
  };
}

function result(taskId: string, over: Partial<TaskResult> = {}): TaskResult {
  return {
    taskId, agentId: "a", status: "completed", summary: "", filesChanged: [], filesRead: [],
    changeLedger: [], commandsExecuted: [], tests: [], findings: [], messages: [], ...over,
  };
}

const plan = (tasks: Task[]): Plan => ({ summary: "s", leadAgentId: "a", tasks });

describe("P2-T6 definition of done", () => {
  const tasks = [
    task("IMPL", { acceptanceCriteria: ["endpoint returns 200", "has tests"] }),
    task("TEST", { kind: "test", dependencies: ["IMPL"] }),
    task("REVIEW", { kind: "review", dependencies: ["IMPL"] }),
  ];

  it("needs both a passing command and a clean independent review to call a criterion evidenced", () => {
    const dod = evaluateDefinitionOfDone({
      plan: plan(tasks),
      results: [
        result("IMPL"),
        result("TEST", { tests: [{ command: "pnpm test", passed: 1, failed: 0, exitCode: 0 }] }),
        result("REVIEW"),
      ],
    });
    expect(dod.status).toBe("met");
    expect(dod.criteria).toHaveLength(2);
    expect(dod.criteria[0]?.evidence).toEqual([
      "TEST: `pnpm test` exit 0",
      "REVIEW: independent review, no open blockers",
    ]);
    expect(dod.verifications).toEqual([{ taskId: "TEST", command: "pnpm test", exitCode: 0, ranBy: "agent" }]);
  });

  it("a completed implementation with no checks is unknown, never evidenced", () => {
    const dod = evaluateDefinitionOfDone({ plan: plan([tasks[0]!]), results: [result("IMPL")] });
    expect(dod.status).toBe("unknown");
    expect(dod.criteria.every((c) => c.status === "unknown")).toBe(true);
    expect(dod.criteria[0]?.evidence).toContain("no passing test command against this task");
  });

  it("a passing command without an independent review is still unknown", () => {
    const dod = evaluateDefinitionOfDone({
      plan: plan(tasks.slice(0, 2)),
      results: [
        result("IMPL"),
        result("TEST", { tests: [{ command: "pnpm test", passed: 1, failed: 0, exitCode: 0 }] }),
      ],
    });
    expect(dod.criteria.filter((c) => c.taskId === "IMPL").map((c) => c.status)).toEqual(["unknown", "unknown"]);
  });

  it("a failing check or an open blocker makes the criterion failed", () => {
    const dod = evaluateDefinitionOfDone({
      plan: plan(tasks),
      results: [
        result("IMPL"),
        result("TEST", { status: "failed", tests: [{ command: "pnpm test", passed: 0, failed: 1, exitCode: 1 }] }),
        result("REVIEW", { findings: [{ severity: "blocker", message: "no error handling", status: "open" }] }),
      ],
    });
    expect(dod.status).toBe("unmet");
    expect(dod.criteria[0]?.evidence).toEqual([
      "TEST failed (`pnpm test` exit 1)",
      "REVIEW open blocker: no error handling",
    ]);
  });

  it("a superseded failure no longer counts once a fix chain re-ran the check", () => {
    const dod = evaluateDefinitionOfDone({
      plan: plan([
        ...tasks,
        task("FIX-1", { dependencies: ["IMPL"] }),
        task("FIX-1-TEST", { kind: "test", dependencies: ["FIX-1"] }),
        task("FIX-1-REVIEW", { kind: "review", dependencies: ["FIX-1"] }),
      ]),
      results: [
        result("IMPL"),
        result("TEST", { status: "failed", tests: [{ command: "t", passed: 0, failed: 1, exitCode: 1 }] }),
        result("REVIEW"),
        result("FIX-1"),
        result("FIX-1-TEST", { tests: [{ command: "t", passed: 1, failed: 0, exitCode: 0 }] }),
        result("FIX-1-REVIEW"),
      ],
      superseded: new Set(["TEST"]),
    });
    expect(dod.status).toBe("met");
  });

  it("single: the declared verification is the only criterion", () => {
    expect(evaluateSingleDefinitionOfDone({ agentTests: [], runStatus: "completed" }).status).toBe("unknown");
    const passed = evaluateSingleDefinitionOfDone({
      verifyCommand: "pnpm test",
      bremioVerification: { command: "pnpm test", exitCode: 0 },
      agentTests: [{ command: "pnpm test", exitCode: 1 }, { command: "pnpm test", exitCode: 0 }],
      runStatus: "completed",
    });
    expect(passed.status).toBe("met");
    expect(passed.verifications.map((v) => v.ranBy)).toEqual(["agent", "bremio"]);
    expect(evaluateSingleDefinitionOfDone({
      verifyCommand: "pnpm test", agentTests: [], runStatus: "completed",
    }).criteria[0]?.status).toBe("unknown");
  });
});
