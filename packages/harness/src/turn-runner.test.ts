import { describe, expect, it, vi } from "vitest";
import type { AdapterRuntimeCapabilities, AgentAdapter, AgentCapabilities, AgentRunRequest } from "@bremio/adapter-sdk";
import type { AgentEvent } from "@bremio/protocol";
import { prepareTurnExecution } from "./turn-runner";

function mockAdapter(overrides: {
  resumableSessions?: boolean;
  resumeError?: Error | string;
} = {}): AgentAdapter {
  const resumableSessions = overrides.resumableSessions ?? false;
  const caps: AgentCapabilities = {
    planning: true,
    structuredOutput: true,
    repositoryRead: true,
    repositoryWrite: true,
    shell: true,
    testing: true,
    browser: false,
    vision: false,
    resumableSessions,
    readOnlyEnforcement: "provider-native",
  };

  return {
    id: resumableSessions ? "claude" : "opencode",
    provider: resumableSessions ? "anthropic" : "opencode",
    healthCheck: async () => ({ status: "ok" }),
    getCapabilities: async () => caps,
    listModels: async () => [],
    async *startRun(req: AgentRunRequest): AsyncIterable<AgentEvent> {
      const now = Date.now();
      yield { type: "started", runId: req.runId, ts: now };
      yield {
        type: "completed",
        runId: req.runId,
        ts: now,
        outcome: { status: "completed", finalText: `Reinjected: ${req.prompt}` },
      };
    },
    async *resumeRun(sessionId: string, req: AgentRunRequest): AsyncIterable<AgentEvent> {
      if (!resumableSessions) {
        throw new Error("resumeRun not supported");
      }
      if (overrides.resumeError) {
        if (typeof overrides.resumeError === "string") {
          const now = Date.now();
          yield { type: "started", runId: req.runId, ts: now };
          yield {
            type: "completed",
            runId: req.runId,
            ts: now,
            outcome: { status: "failed", error: overrides.resumeError, sessionId },
          };
          return;
        }
        throw overrides.resumeError;
      }
      const now = Date.now();
      yield { type: "started", runId: req.runId, ts: now };
      yield {
        type: "completed",
        runId: req.runId,
        ts: now,
        outcome: { status: "completed", finalText: `Resumed session ${sessionId}`, sessionId },
      };
    },
    cancelRun: async () => {},
    getRuntimeCapabilities: async () => ({
      adapterId: "mock",
      transport: "cli",
      approval: "none",
      structuredToolEvents: false,
      contextMetrics: "estimated",
      manualCompact: false,
      mcp: false,
      webSearch: false,
      cancellation: false,
    }),
  };
}

function request(): Omit<AgentRunRequest, "prompt"> {
  return {
    runId: "run-turn-1",
    role: "implementer",
    cwd: "/repo",
    permission: "workspace-write",
  };
}

describe("B5: Turn Runner Continuity", () => {
  it("1. selects resume when resumableSessions capability is true and providerSessionId exists", async () => {
    const adapter = mockAdapter({ resumableSessions: true });
    const execution = await prepareTurnExecution({
      adapter,
      sessionId: "sess-1",
      turnIndex: 1,
      priorTurns: [{ turnIndex: 0, prompt: "Turn 0", finalText: "Done 0" }],
      providerSessionId: "psess-claude-999",
      newPrompt: "Turn 1 follow up",
      request: request(),
    });

    expect(execution.decision.mechanism).toBe("resume");
    expect(execution.decision.reason).toContain("resumableSessions is true");

    const events = [];
    for await (const ev of execution.run()) events.push(ev);

    const completed = events.find((e) => e.type === "completed");
    expect(completed?.outcome?.status).toBe("completed");
    expect(completed?.outcome?.finalText).toBe("Resumed session psess-claude-999");
  });

  it("2. selects re-inject when resumableSessions capability is false (capability-driven, not provider-named)", async () => {
    const adapter = mockAdapter({ resumableSessions: false });
    const execution = await prepareTurnExecution({
      adapter,
      sessionId: "sess-2",
      turnIndex: 1,
      priorTurns: [{ turnIndex: 0, prompt: "Turn 0", finalText: "Done 0" }],
      newPrompt: "Turn 1 follow up",
      request: request(),
    });

    expect(execution.decision.mechanism).toBe("re-inject");
    expect(execution.decision.reason).toContain("resumableSessions is false");

    const events = [];
    for await (const ev of execution.run()) events.push(ev);

    const completed = events.find((e) => e.type === "completed");
    expect(completed?.outcome?.status).toBe("completed");
    expect(completed?.outcome?.finalText).toContain("Reinjected:");
  });

  it("3. falls back to re-injection when provider session is expired/invalid (classified session_not_found)", async () => {
    const adapter = mockAdapter({
      resumableSessions: true,
      resumeError: "Error: thread/resume failed: no rollout found for thread id psess-expired",
    });

    const execution = await prepareTurnExecution({
      adapter,
      sessionId: "sess-3",
      turnIndex: 1,
      priorTurns: [{ turnIndex: 0, prompt: "Turn 0", finalText: "Done 0" }],
      providerSessionId: "psess-expired",
      newPrompt: "Turn 1 follow up",
      request: request(),
    });

    expect(execution.decision.mechanism).toBe("resume");

    const events = [];
    for await (const ev of execution.run()) events.push(ev);

    const completed = events.find((e) => e.type === "completed");
    expect(completed?.outcome?.status).toBe("completed");
    // Verified fallback to re-injection
    expect(completed?.outcome?.finalText).toContain("Reinjected:");
  });

  it("4. cancelled turn leaves the session resumable and intact", async () => {
    const adapter = mockAdapter({ resumableSessions: true });
    const cancelAdapter: AgentAdapter = {
      ...adapter,
      async *resumeRun(sessionId: string, req: AgentRunRequest): AsyncIterable<AgentEvent> {
        const now = Date.now();
        yield { type: "started", runId: req.runId, ts: now };
        yield {
          type: "completed",
          runId: req.runId,
          ts: now,
          outcome: { status: "cancelled", error: "turn cancelled by user", sessionId },
        };
      },
    };

    const execution = await prepareTurnExecution({
      adapter: cancelAdapter,
      sessionId: "sess-4",
      turnIndex: 1,
      priorTurns: [{ turnIndex: 0, prompt: "Turn 0", finalText: "Done 0" }],
      providerSessionId: "psess-cancelled",
      newPrompt: "Turn 1 follow up",
      request: request(),
    });

    const events = [];
    for await (const ev of execution.run()) events.push(ev);

    const completed = events.find((e) => e.type === "completed");
    expect(completed?.outcome?.status).toBe("cancelled");
    expect(completed?.outcome?.sessionId).toBe("psess-cancelled");
  });
});
