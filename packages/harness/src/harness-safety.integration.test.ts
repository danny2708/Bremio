import { describe, expect, it } from "vitest";
import type { AgentAdapter, AgentCapabilities, AgentRunRequest } from "@bremio/adapter-sdk";
import type { AgentEvent } from "@bremio/protocol";
import {
  assembleTurnContext,
  enforceContextBudget,
  estimateTokens,
  prepareTurnExecution,
} from "./index";

function createMockAdapter(opts: {
  id?: string;
  resumableSessions?: boolean;
  resumeError?: string;
}): AgentAdapter {
  const resumableSessions = opts.resumableSessions ?? false;
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
  };

  let resumeCalled = false;
  let startCalled = false;

  return {
    id: opts.id ?? (resumableSessions ? "claude" : "opencode"),
    provider: resumableSessions ? "anthropic" : "opencode",
    healthCheck: async () => ({ status: "ok" }),
    getCapabilities: async () => caps,
    listModels: async () => [],
    async *startRun(req: AgentRunRequest): AsyncIterable<AgentEvent> {
      startCalled = true;
      const now = Date.now();
      yield { type: "started", runId: req.runId, ts: now };
      yield {
        type: "completed",
        runId: req.runId,
        ts: now,
        outcome: { status: "completed", finalText: `Reinjected:\n${req.prompt}` },
      };
    },
    async *resumeRun(sessionId: string, req: AgentRunRequest): AsyncIterable<AgentEvent> {
      resumeCalled = true;
      if (!resumableSessions) {
        throw new Error("resumeRun is not supported (resumableSessions: false)");
      }
      if (opts.resumeError) {
        const now = Date.now();
        yield { type: "started", runId: req.runId, ts: now };
        yield {
          type: "completed",
          runId: req.runId,
          ts: now,
          outcome: { status: "failed", error: opts.resumeError, sessionId },
        };
        return;
      }
      const now = Date.now();
      yield { type: "started", runId: req.runId, ts: now };
      yield {
        type: "completed",
        runId: req.runId,
        ts: now,
        outcome: { status: "completed", finalText: `Resumed:${req.prompt}`, sessionId },
      };
    },
    cancelRun: async () => {},
    // Expose tracking flags for assertions
    get _resumeCalled() {
      return resumeCalled;
    },
    get _startCalled() {
      return startCalled;
    },
  } as AgentAdapter & { _resumeCalled: boolean; _startCalled: boolean };
}

function request(): Omit<AgentRunRequest, "prompt"> {
  return {
    runId: "run-safety-1",
    role: "implementer",
    cwd: "/repo",
    permission: "workspace-write",
  };
}

describe("B6: Harness Fail-Closed Integration (Six Safety Properties)", () => {
  it("1. a context that cannot fit fails closed with a reason, never sending a truncated context", async () => {
    const adapter = createMockAdapter({ resumableSessions: false });
    const hugePrompt = "PROMPT_X".repeat(50); // 400 chars -> 100 tokens

    const execution = await prepareTurnExecution({
      adapter,
      sessionId: "sess-1",
      turnIndex: 0,
      priorTurns: [],
      newPrompt: hugePrompt,
      request: request(),
      budgetConfig: { defaultBudget: 20 }, // Budget 20 < 100 required
    });

    const events = [];
    for await (const ev of execution.run()) events.push(ev);

    const completed = events.find((e) => e.type === "completed");
    expect(completed?.outcome?.status).toBe("failed");
    expect(completed?.outcome?.error).toContain("Turn instruction and diff exceed provider context budget of 20 tokens");
    // Guarantee: adapter.startRun was NEVER called with a truncated prompt
    expect((adapter as any)._startCalled).toBe(false);
  });

  it("2. an expired provider session falls back to re-injection rather than starting a silent blank session", async () => {
    const adapter = createMockAdapter({
      resumableSessions: true,
      resumeError: "Error: thread/resume failed: no rollout found for thread id psess-expired",
    });

    const execution = await prepareTurnExecution({
      adapter,
      sessionId: "sess-2",
      turnIndex: 1,
      priorTurns: [
        {
          turnIndex: 0,
          prompt: "Turn 0 prompt",
          finalText: "Turn 0 answer",
          summary: "T0 summary",
        },
      ],
      providerSessionId: "psess-expired",
      newPrompt: "Turn 1 follow up",
      request: request(),
    });

    const events = [];
    for await (const ev of execution.run()) events.push(ev);

    const completed = events.find((e) => e.type === "completed");
    expect(completed?.outcome?.status).toBe("completed");
    // Guarantee: re-injection was triggered and carried full assembled context
    expect(completed?.outcome?.finalText).toContain("Reinjected:");
    expect(completed?.outcome?.finalText).toContain("Turn 0 prompt");
    expect((adapter as any)._startCalled).toBe(true);
  });

  it("3. a cancelled turn leaves the session resumable and uncorrupted", async () => {
    const adapter = createMockAdapter({ resumableSessions: true });
    const cancelAdapter: AgentAdapter = {
      ...adapter,
      async *resumeRun(sessionId: string, req: AgentRunRequest): AsyncIterable<AgentEvent> {
        const now = Date.now();
        yield { type: "started", runId: req.runId, ts: now };
        yield {
          type: "completed",
          runId: req.runId,
          ts: now,
          outcome: { status: "cancelled", error: "turn cancelled", sessionId },
        };
      },
    };

    const execution = await prepareTurnExecution({
      adapter: cancelAdapter,
      sessionId: "sess-3",
      turnIndex: 1,
      priorTurns: [{ turnIndex: 0, prompt: "Turn 0", finalText: "Done 0" }],
      providerSessionId: "psess-valid-3",
      newPrompt: "Turn 1 instruction",
      request: request(),
    });

    const events = [];
    for await (const ev of execution.run()) events.push(ev);

    const completed = events.find((e) => e.type === "completed");
    expect(completed?.outcome?.status).toBe("cancelled");
    expect(completed?.outcome?.sessionId).toBe("psess-valid-3");
  });

  it("4. a summary is never presented as verbatim history", () => {
    const assembled = assembleTurnContext({
      priorTurns: [
        {
          turnIndex: 0,
          prompt: "Full prompt 0",
          finalText: "Full result 0",
          summary: "Summary of Turn 0",
        },
        {
          turnIndex: 1,
          prompt: "Full prompt 1",
          finalText: "Full result 1",
          summary: "Summary of Turn 1",
        },
        {
          turnIndex: 2,
          prompt: "Full prompt 2",
          finalText: "Full result 2",
        },
      ],
      newPrompt: "Turn 3 instruction",
      maxVerbatimTurns: 1,
    });

    expect(assembled.assembledPrompt).toContain("### Turn 0 (Summary)");
    expect(assembled.assembledPrompt).toContain("Summary of Turn 0");
    expect(assembled.assembledPrompt).not.toContain("Prompt: Full prompt 0");
    expect(assembled.assembledPrompt).toContain("### Turn 2");
    expect(assembled.assembledPrompt).toContain("Prompt: Full prompt 2");
  });

  it("5. an estimated token count is never reported as measured", () => {
    const estimatedRes = enforceContextBudget({
      provider: "claude",
      config: { defaultBudget: 1000 },
      priorTurns: [
        { turnIndex: 0, prompt: "Unmeasured prompt text" },
      ],
      newPrompt: "New instruction text",
    });

    expect(estimatedRes.isEstimate).toBe(true);
    expect(estimatedRes.accountingMethod).toBe("estimated");

    const measuredRes = enforceContextBudget({
      provider: "claude",
      config: { defaultBudget: 1000 },
      priorTurns: [
        { turnIndex: 0, prompt: "prompt", measuredInputTokens: 120 },
      ],
      newPrompt: "", // empty prompt (0 tokens)
    });

    expect(measuredRes.isEstimate).toBe(false);
    expect(measuredRes.accountingMethod).toBe("measured");
    expect(measuredRes.totalTokens).toBe(120);
  });

  it("6. a non-resumable adapter never receives resumeRun", async () => {
    const adapter = createMockAdapter({ resumableSessions: false });

    const execution = await prepareTurnExecution({
      adapter,
      sessionId: "sess-6",
      turnIndex: 1,
      priorTurns: [{ turnIndex: 0, prompt: "Turn 0", finalText: "Done 0" }],
      providerSessionId: "psess-ignored",
      newPrompt: "Turn 1 instruction",
      request: request(),
    });

    expect(execution.decision.mechanism).toBe("re-inject");
    expect(execution.decision.reason).toContain("resumableSessions is false");

    const events = [];
    for await (const ev of execution.run()) events.push(ev);

    expect((adapter as any)._resumeCalled).toBe(false);
    expect((adapter as any)._startCalled).toBe(true);
  });
});
