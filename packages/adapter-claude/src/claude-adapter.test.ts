import { describe, expect, it, vi } from "vitest";
import { ClaudeAdapter } from "./claude-adapter";
import type { AgentRunRequest } from "@bremio/adapter-sdk";

// Mock @anthropic-ai/claude-agent-sdk query
vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  return {
    query: vi.fn().mockImplementation(async function* ({ options }: { options: { resume?: string } }) {
      if (options.resume === "invalid-session-id-12345") {
        throw new Error(
          'Claude Code returned an error result: Error: --resume requires a valid session ID or session title when used with --print. Provided value "invalid-session-id-12345" is not a UUID',
        );
      }
      yield {
        type: "result",
        subtype: "success",
        result: "ALPHA-999",
        session_id: options.resume ?? "4bf89d8e-328f-42b1-872a-d2d9e73ed5db",
      };
    }),
  };
});

function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    runId: "run-claude-resume-1",
    role: "planner",
    prompt: "What was the secret code I told you earlier?",
    cwd: "/tmp/repo",
    permission: "read-only",
    ...overrides,
  };
}

describe("ClaudeAdapter B4: Session Resume", () => {
  it("reports resumableSessions: true capability", async () => {
    const adapter = new ClaudeAdapter();
    const caps = await adapter.getCapabilities();
    expect(caps.resumableSessions).toBe(true);
  });

  it("resumes session via query option and emits outcome.sessionId", async () => {
    const adapter = new ClaudeAdapter();
    const events = [];
    for await (const ev of adapter.resumeRun("4bf89d8e-328f-42b1-872a-d2d9e73ed5db", request())) {
      events.push(ev);
    }

    const completed = events.find((e) => e.type === "completed");
    expect(completed).toBeDefined();
    expect(completed?.outcome?.status).toBe("completed");
    expect(completed?.outcome?.sessionId).toBe("4bf89d8e-328f-42b1-872a-d2d9e73ed5db");
    expect(completed?.outcome?.finalText).toBe("ALPHA-999");
  });

  it("classifies unknown/expired session ID as non-fatal failure with sessionId preserved", async () => {
    const adapter = new ClaudeAdapter();
    const events = [];
    for await (const ev of adapter.resumeRun("invalid-session-id-12345", request())) {
      events.push(ev);
    }

    const completed = events.find((e) => e.type === "completed");
    expect(completed).toBeDefined();
    expect(completed?.outcome?.status).toBe("failed");
    expect(completed?.outcome?.sessionId).toBe("invalid-session-id-12345");
    expect(completed?.outcome?.error).toContain("Provided value \"invalid-session-id-12345\" is not a UUID");
  });
});
