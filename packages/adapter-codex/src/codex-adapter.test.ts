import { describe, expect, it } from "vitest";
import type { AgentRunRequest } from "@bremio/adapter-sdk";
import { buildCodexExecArgs, buildCodexResumeArgs, CodexAdapter, sanitizeRunIdForFile } from "./codex-adapter";

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
    expect(args).toContain('model_reasoning_effort="high"');
    expect(args).toContain("schema.json");
  });

  it("leaves provider defaults untouched when identity is not requested", () => {
    const args = buildCodexExecArgs(request(), "result.txt");

    expect(args).not.toContain("-m");
    expect(args).not.toContain("-c");
  });
});

describe("buildCodexResumeArgs", () => {
  it("builds argument vector containing exec resume and target thread ID", () => {
    const args = buildCodexResumeArgs(
      "019f8f24-5ef0-7f41-baa7-f4f0466ecf10",
      request(),
      "out.txt",
    );

    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("resume");
    expect(args[2]).toBe("019f8f24-5ef0-7f41-baa7-f4f0466ecf10");
  });
});

describe("CodexAdapter B4: Session Resume", () => {
  it("reports resumableSessions: true capability", async () => {
    const adapter = new CodexAdapter();
    const caps = await adapter.getCapabilities();
    expect(caps.resumableSessions).toBe(true);
  });
});

describe("sanitizeRunIdForFile", () => {
  it("removes Windows-invalid separators from task run ids", () => {
    expect(sanitizeRunIdForFile("TASK-003::codex")).toBe("TASK-003--codex");
  });
});
