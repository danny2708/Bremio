import { describe, expect, it } from "vitest";
import { mapCodexLine } from "./events";

// Lines captured from real `codex exec --json` (codex-cli 0.144.5).
describe("mapCodexLine (real codex --json shapes)", () => {
  it("maps thread.started to an info log", () => {
    const [ev] = mapCodexLine(
      '{"type":"thread.started","thread_id":"019f7077-7bf9"}',
      "r1",
    );
    expect(ev?.type).toBe("log");
    if (ev?.type === "log") expect(ev.level).toBe("info");
  });

  it("maps an item.completed agent_message to an assistant message", () => {
    const [ev] = mapCodexLine(
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"HELLO"}}',
      "r1",
    );
    expect(ev).toEqual({ type: "message", runId: "r1", ts: expect.any(Number), role: "assistant", text: "HELLO" });
  });

  it("maps item.completed reasoning to a thinking event", () => {
    const [ev] = mapCodexLine(
      '{"type":"item.completed","item":{"type":"reasoning","text":"thinking hard"}}',
      "r1",
    );
    expect(ev?.type).toBe("thinking");
  });

  it("maps a command execution start/end to tool_use then tool_result", () => {
    const [start] = mapCodexLine(
      '{"type":"item.started","item":{"type":"command_execution","command":"ls -a"}}',
      "r1",
    );
    expect(start).toMatchObject({ type: "tool_use", name: "shell", input: { command: "ls -a" } });

    const [end] = mapCodexLine(
      '{"type":"item.completed","item":{"type":"command_execution","command":"ls -a","exit_code":0}}',
      "r1",
    );
    expect(end).toMatchObject({ type: "tool_result", name: "shell", ok: true });
  });

  it("maps turn.completed usage to a usage event", () => {
    const [ev] = mapCodexLine(
      '{"type":"turn.completed","usage":{"input_tokens":17756,"output_tokens":6}}',
      "r1",
    );
    expect(ev).toMatchObject({ type: "usage", inputTokens: 17756, outputTokens: 6 });
  });

  it("keeps unknown JSON as a debug log (nothing dropped)", () => {
    const [ev] = mapCodexLine('{"type":"something.new","foo":1}', "r1");
    expect(ev?.type).toBe("log");
  });

  it("keeps a non-JSON line as a debug log", () => {
    const [ev] = mapCodexLine("not json at all", "r1");
    expect(ev).toMatchObject({ type: "log", level: "debug", message: "not json at all" });
  });
});
