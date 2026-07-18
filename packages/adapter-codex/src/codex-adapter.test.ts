import { describe, expect, it } from "vitest";
import type { AgentRunRequest } from "@bremio/adapter-sdk";
import { buildCodexExecArgs, sanitizeRunIdForFile } from "./codex-adapter";

function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    runId: "run-1",
    role: "planner",
    prompt: "plan",
    cwd: "C:\\repo",
    permission: "read-only",
    ...overrides,
  };
}

describe("buildCodexExecArgs", () => {
  it("passes explicit model and normalized reasoning without shell interpolation", () => {
    const args = buildCodexExecArgs(
      request({ model: "gpt-test", reasoningLevel: "high" }),
      "result.txt",
      "schema.json",
    );

    expect(args).toContain("gpt-test");
    expect(args).toContain("model_reasoning_effort=\"high\"");
    expect(args).toContain("schema.json");
  });

  it("leaves provider defaults untouched when identity is not requested", () => {
    const args = buildCodexExecArgs(request(), "result.txt");

    expect(args).not.toContain("-m");
    expect(args).not.toContain("-c");
  });
});

describe("sanitizeRunIdForFile", () => {
  it("removes Windows-invalid separators from task run ids", () => {
    expect(sanitizeRunIdForFile("TASK-003::codex")).toBe("TASK-003--codex");
  });
});
