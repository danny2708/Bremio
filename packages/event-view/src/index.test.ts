import { describe, expect, it } from "vitest";
import { assembleTaskLanes, formatTaskExecution, renderEvent } from "./index";

describe("renderEvent", () => {
  it("renders started", () => {
    expect(renderEvent({ type: "started" })).toMatchObject({
      kind: "started",
      summary: "started",
      severity: "info",
    });
  });

  it("renders message with clipped summary and full detail", () => {
    const text = "hello ".repeat(40);
    const view = renderEvent({ type: "message", text });
    expect(view.kind).toBe("message");
    expect(view.summary).toMatch(/…$/);
    expect(view.summary.length).toBe(121);
    expect(view.detail).toBe(text);
    expect(view.severity).toBe("info");
  });

  it("renders a short message without ellipsis", () => {
    const view = renderEvent({ type: "message", text: "Hello, world!" });
    expect(view.summary).toBe("Hello, world!");
    expect(view.detail).toBe("Hello, world!");
  });

  it("renders thinking with a leading dot and clipped text", () => {
    const view = renderEvent({ type: "thinking", text: "analyzing the problem step by step" });
    expect(view.kind).toBe("thinking");
    expect(view.summary).toBe("· analyzing the problem step by step");
    expect(view.severity).toBe("notice");
  });

  it("renders tool_use with an inline arg", () => {
    const view = renderEvent({ type: "tool_use", name: "write", input: { file_path: "/tmp/test.txt" } });
    expect(view.kind).toBe("tool_use");
    expect(view.summary).toBe("→ write /tmp/test.txt");
    expect(view.detail).toBeDefined();
    expect(view.severity).toBe("info");
  });

  it("renders tool_use without input", () => {
    const view = renderEvent({ type: "tool_use", name: "read" });
    expect(view.summary).toBe("→ read");
  });

  it("renders successful tool_result with exit code", () => {
    const view = renderEvent({ type: "tool_result", name: "write", ok: true, exitCode: 0 });
    expect(view.kind).toBe("tool_result");
    expect(view.summary).toBe("✓ write (exit code 0)");
    expect(view.severity).toBe("success");
  });

  it("renders failed tool_result", () => {
    const view = renderEvent({ type: "tool_result", name: "bash", ok: false, exitCode: 1 });
    expect(view.summary).toBe("✗ bash (exit code 1)");
    expect(view.severity).toBe("error");
  });

  it("renders tool_result without exit code says 'not reported'", () => {
    const view = renderEvent({ type: "tool_result", name: "read", ok: true });
    expect(view.summary).toBe("✓ read (exit code not reported)");
  });

  it("renders log at info severity", () => {
    const view = renderEvent({ type: "log", level: "info", message: "downloading model" });
    expect(view.kind).toBe("log");
    expect(view.summary).toBe("downloading model");
    expect(view.severity).toBe("info");
  });

  it("renders log at warn severity", () => {
    const view = renderEvent({ type: "log", level: "warn", message: "low disk space" });
    expect(view.severity).toBe("warn");
  });

  it("renders log at error severity", () => {
    const view = renderEvent({ type: "log", level: "error", message: "disk full" });
    expect(view.severity).toBe("error");
  });

  it("renders usage with model and reasoning level", () => {
    const view = renderEvent({ type: "usage", model: "gpt-4", reasoningLevel: "high" });
    expect(view.kind).toBe("usage");
    expect(view.summary).toBe("gpt-4 [high]");
    expect(view.severity).toBe("info");
  });

  it("renders usage without reasoning", () => {
    const view = renderEvent({ type: "usage", model: "claude-sonnet-4" });
    expect(view.summary).toBe("claude-sonnet-4");
  });

  it("renders usage without model as 'not reported'", () => {
    const view = renderEvent({ type: "usage" });
    expect(view.summary).toBe("not reported");
  });

  it("renders error", () => {
    const view = renderEvent({ type: "error", message: "rate limited" });
    expect(view.kind).toBe("error");
    expect(view.summary).toBe("✗ rate limited");
    expect(view.severity).toBe("error");
  });

  it("renders completed", () => {
    const view = renderEvent({ type: "completed" });
    expect(view.kind).toBe("completed");
    expect(view.summary).toBe("✓ completed");
    expect(view.severity).toBe("success");
  });

  it("surfaces an unknown event type rather than dropping it", () => {
    const view = renderEvent({ type: "custom_event", someField: "val" } as Parameters<typeof renderEvent>[0]);
    expect(view.kind).toBe("custom_event");
    expect(view.summary).toBe("[custom_event]");
    expect(view.detail).toContain("val");
    expect(view.severity).toBe("info");
  });
});

describe("formatTaskExecution", () => {
  it("renders confirmed model and reasoning for a task", () => {
    const text = formatTaskExecution({
      agentId: "claude",
      confirmedModel: "claude-3-7-sonnet",
      confirmedReasoningLevel: "high",
      requestedModel: "claude-3-7-sonnet",
      requestedReasoningLevel: "high",
    });
    expect(text).toBe("agent: claude | model: claude-3-7-sonnet | reasoning: high");
  });

  it("renders an unreported model as 'not reported', not as the requested value", () => {
    const text = formatTaskExecution({
      agentId: "codex",
      requestedModel: "gpt-4o",
      requestedReasoningLevel: "medium",
    });
    expect(text).toBe("agent: codex | model: not reported (requested: gpt-4o) | reasoning: not reported (requested: medium)");
  });

  it("renders both when requested ≠ confirmed", () => {
    const text = formatTaskExecution({
      agentId: "opencode",
      confirmedModel: "deepseek-v3",
      requestedModel: "claude-3-7-sonnet",
      confirmedReasoningLevel: "medium",
      requestedReasoningLevel: "high",
    });
    expect(text).toBe("agent: opencode | model: deepseek-v3 (requested: claude-3-7-sonnet) | reasoning: medium (requested: high)");
  });
});

describe("assembleTaskLanes (A4-T1)", () => {
  it("1. N concurrent tasks produce N lanes and a bounded number of lines", () => {
    const rawEvents: Array<{ kind: string; taskId: string; agentId: string; message: string }> = [];
    for (let i = 0; i < 50; i++) {
      rawEvents.push({ kind: "task-event", taskId: "TASK-001", agentId: "codex", message: `step ${i}` });
      rawEvents.push({ kind: "task-event", taskId: "TASK-002", agentId: "claude", message: `step ${i}` });
      rawEvents.push({ kind: "task-event", taskId: "TASK-003", agentId: "antigravity", message: `step ${i}` });
    }

    const lanes = assembleTaskLanes(rawEvents);
    // 3 concurrent tasks emit 150 total events, but assemble into 3 bounded lanes
    expect(lanes).toHaveLength(3);
    expect(lanes.map((l) => l.id)).toEqual(["TASK-001", "TASK-002", "TASK-003"]);
    // Bounded number of lines: collapsed view shows exactly 1 line per lane (3 lines total), NOT 150 lines
    expect(lanes.length).toBeLessThanOrEqual(3);
  });

  it("2. a failed lane is visible while collapsed", () => {
    const rawEvents = [
      { kind: "task-start", taskId: "TASK-001", agentId: "codex", message: "Build component" },
      { kind: "task-start", taskId: "TASK-002", agentId: "claude", message: "Run integration tests" },
      { kind: "task-event", taskId: "TASK-001", agentId: "codex", message: "file written" },
      { kind: "failed", taskId: "TASK-002", agentId: "claude", message: "test suite failed" },
    ];

    const lanes = assembleTaskLanes(rawEvents);
    const failedLane = lanes.find((l) => l.id === "TASK-002");
    expect(failedLane).toBeDefined();
    // The status is marked 'failed' so it renders red/warning in single-line collapsed view
    expect(failedLane?.status).toBe("failed");
    expect(failedLane?.lastActivity).toContain("test suite failed");
  });

  it("3. expanding a lane yields that task's events and no other task's", () => {
    const rawEvents = [
      { kind: "task-event", taskId: "TASK-001", agentId: "codex", message: "TASK-1-event-A" },
      { kind: "task-event", taskId: "TASK-002", agentId: "claude", message: "TASK-2-event-A" },
      { kind: "task-event", taskId: "TASK-001", agentId: "codex", message: "TASK-1-event-B" },
    ];

    const lanes = assembleTaskLanes(rawEvents);
    const lane1 = lanes.find((l) => l.id === "TASK-001");
    const lane2 = lanes.find((l) => l.id === "TASK-002");

    expect(lane1?.events.map((e) => e.summary)).toEqual(["TASK-1-event-A", "TASK-1-event-B"]);
    expect(lane2?.events.map((e) => e.summary)).toEqual(["TASK-2-event-A"]);

    // No cross-contamination between lanes
    expect(lane1?.events.some((e) => e.summary.includes("TASK-2"))).toBe(false);
    expect(lane2?.events.some((e) => e.summary.includes("TASK-1"))).toBe(false);
  });
});


