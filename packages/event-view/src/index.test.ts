import { describe, expect, it } from "vitest";
import { renderEvent } from "./index";

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

  it("renders usage without model as 'unknown model'", () => {
    const view = renderEvent({ type: "usage" });
    expect(view.summary).toBe("unknown model");
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
