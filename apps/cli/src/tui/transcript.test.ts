import { describe, expect, it } from "vitest";
import { assembleTranscript, type SessionDetail } from "./transcript";

describe("A3-T2: Transcript Assembly", () => {
  it("1. a session with N turns assembles N turn blocks in order", () => {
    const session: SessionDetail = {
      id: "ses-100",
      repositoryPath: "/tmp/repo",
      title: "multi-turn session",
      turns: [
        {
          turnIndex: 0,
          runId: "run-turn-0",
          prompt: "first prompt",
          status: "completed",
          model: "claude-3-7-sonnet",
        },
        {
          turnIndex: 1,
          runId: "run-turn-1",
          prompt: "second prompt",
          status: "completed",
          model: "codex",
        },
      ],
    };

    const eventsMap = new Map<string, any[]>([
      [
        "run-turn-0",
        [
          { seq: 1, kind: "message", data: { type: "message", text: "step 1 finished" } },
        ],
      ],
      [
        "run-turn-1",
        [
          { seq: 1, kind: "message", data: { type: "message", text: "step 2 finished" } },
        ],
      ],
    ]);

    const viewModel = assembleTranscript(session, eventsMap);

    expect(viewModel.sessionId).toBe("ses-100");
    expect(viewModel.turns).toHaveLength(2);
    expect(viewModel.turns[0]!.turnIndex).toBe(0);
    expect(viewModel.turns[0]!.prompt).toBe("first prompt");
    expect(viewModel.turns[0]!.events[0]!.summary).toBe("step 1 finished");

    expect(viewModel.turns[1]!.turnIndex).toBe(1);
    expect(viewModel.turns[1]!.prompt).toBe("second prompt");
    expect(viewModel.turns[1]!.events[0]!.summary).toBe("step 2 finished");
  });

  it("2. collapsed detail is present but marked, not lost", () => {
    const session: SessionDetail = {
      id: "ses-200",
      repositoryPath: "/tmp/repo",
      title: "reasoning and tool calls session",
      turns: [
        {
          turnIndex: 0,
          runId: "run-detail",
          prompt: "deep reasoning task",
          status: "completed",
        },
      ],
    };

    const eventsMap = new Map<string, any[]>([
      [
        "run-detail",
        [
          {
            seq: 1,
            kind: "thinking",
            data: { type: "thinking", text: "analyzing complex data structure..." },
          },
          {
            seq: 2,
            kind: "tool_use",
            data: { type: "tool_use", name: "exec", input: { command: "npm test" } },
          },
          {
            seq: 3,
            kind: "message",
            data: { type: "message", text: "final result ready" },
          },
        ],
      ],
    ]);

    const viewModel = assembleTranscript(session, eventsMap);

    const events = viewModel.turns[0]!.events;
    expect(events).toHaveLength(3);

    // Thinking event check
    expect(events[0]!.kind).toBe("thinking");
    expect(events[0]!.isCollapsible).toBe(true);
    expect(events[0]!.defaultCollapsed).toBe(true);
    expect(events[0]!.detail).toBe("analyzing complex data structure...");

    // Tool call event check
    expect(events[1]!.kind).toBe("tool_use");
    expect(events[1]!.isCollapsible).toBe(true);
    expect(events[1]!.defaultCollapsed).toBe(true);
    expect(events[1]!.detail).toContain("npm test");

    // Regular message event check
    expect(events[2]!.kind).toBe("message");
    expect(events[2]!.isCollapsible).toBe(false);
    expect(events[2]!.defaultCollapsed).toBe(false);
  });

  it("3. selecting an unknown/empty session shows an explicit empty state", () => {
    const emptySessionModel = assembleTranscript(null, new Map());
    expect(emptySessionModel.sessionId).toBe("");
    expect(emptySessionModel.turns).toHaveLength(0);

    const noTurnsSession: SessionDetail = {
      id: "ses-empty",
      repositoryPath: "/tmp/repo",
      title: "empty session",
      turns: [],
    };
    const noTurnsModel = assembleTranscript(noTurnsSession, new Map());
    expect(noTurnsModel.sessionId).toBe("ses-empty");
    expect(noTurnsModel.turns).toHaveLength(0);
  });
});
