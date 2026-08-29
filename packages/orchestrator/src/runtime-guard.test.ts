import { describe, it, expect, beforeEach } from "vitest";
import { RuntimeGuardEvaluator } from "./runtime-guard";
import type { AdapterRuntimeCapabilities } from "@bremio/adapter-sdk";

describe("RuntimeGuardEvaluator", () => {
  let capabilities: AdapterRuntimeCapabilities;

  beforeEach(() => {
    capabilities = {
      adapterId: "test",
      transport: "sdk",
      approval: "none",
      structuredToolEvents: true,
      contextMetrics: "reported",
      manualCompact: false,
      mcp: false,
      webSearch: false,
      cancellation: true,
    };
  });

  const createEvaluator = (configOverrides = {}) => {
    return new RuntimeGuardEvaluator("run1", "agent1", capabilities, {
      maxConsecutiveErrors: 3,
      maxConsecutiveSameTool: 3,
      maxTokensPerMinute: 1000,
      noProgressTimeoutMs: 10000,
      ...configOverrides,
    });
  };

  it("should advance one level at a time for error storms", () => {
    const evaluator = createEvaluator();
    let decision = null;

    // First two errors should be inert
    expect(evaluator.evaluate({ type: "error", message: "err", fatal: false, ts: 10, runId: "run1" })).toBeNull();
    expect(evaluator.evaluate({ type: "error", message: "err", fatal: false, ts: 20, runId: "run1" })).toBeNull();
    
    // Third error triggers warning
    decision = evaluator.evaluate({ type: "error", message: "err", fatal: false, ts: 30, runId: "run1" });
    expect(decision).toBeDefined();
    expect(decision?.level).toBe("warning");
    expect(decision?.action).toBe("warn");
    expect(decision?.reasonCode).toBe("error-storm");

    // Fourth error triggers constrained
    decision = evaluator.evaluate({ type: "error", message: "err", fatal: false, ts: 40, runId: "run1" });
    expect(decision?.level).toBe("constrained");
    expect(decision?.action).toBe("suppress-future-work");

    // Fifth error triggers stop-requested (and action = cancel because supported)
    decision = evaluator.evaluate({ type: "error", message: "err", fatal: false, ts: 50, runId: "run1" });
    expect(decision?.level).toBe("stop-requested");
    expect(decision?.action).toBe("cancel");
  });

  it("should recover one level at a time on healthy observations", () => {
    const evaluator = createEvaluator();
    // Force to constrained
    evaluator.evaluate({ type: "error", message: "err", fatal: false, ts: 10, runId: "run1" });
    evaluator.evaluate({ type: "error", message: "err", fatal: false, ts: 20, runId: "run1" });
    evaluator.evaluate({ type: "error", message: "err", fatal: false, ts: 30, runId: "run1" }); // warning
    evaluator.evaluate({ type: "error", message: "err", fatal: false, ts: 40, runId: "run1" }); // constrained

    // Healthy observation (message) recovers to warning
    let decision = evaluator.evaluate({ type: "message", role: "assistant", text: "hi", ts: 50, runId: "run1" });
    expect(decision?.level).toBe("warning");
    expect(decision?.reasonCode).toBe("partial-recovery");

    // Another healthy observation recovers to healthy
    decision = evaluator.evaluate({ type: "message", role: "assistant", text: "hi", ts: 60, runId: "run1" });
    expect(decision?.level).toBe("healthy");
    expect(decision?.reasonCode).toBe("recovered");
  });

  it("should ignore repeated tools if structuredToolEvents is false", () => {
    capabilities.structuredToolEvents = false;
    const evaluator = createEvaluator();

    for (let i = 0; i < 5; i++) {
      const decision = evaluator.evaluate({ type: "tool_use", name: "test", input: { a: 1 }, ts: i * 10, runId: "run1" });
      expect(decision).toBeNull();
    }
  });

  it("should trigger repeated tools when structuredToolEvents is true", () => {
    const evaluator = createEvaluator();
    
    evaluator.evaluate({ type: "tool_use", name: "test", input: { a: 1 }, ts: 10, runId: "run1" });
    evaluator.evaluate({ type: "tool_use", name: "test", input: { a: 1 }, ts: 20, runId: "run1" });
    const decision = evaluator.evaluate({ type: "tool_use", name: "test", input: { a: 1 }, ts: 30, runId: "run1" });
    expect(decision?.level).toBe("warning");
    expect(decision?.reasonCode).toBe("repeated-tool");
  });

  it("message event should break repeated tool sequence", () => {
    const evaluator = createEvaluator();
    
    evaluator.evaluate({ type: "tool_use", name: "test", input: { a: 1 }, ts: 10, runId: "run1" });
    evaluator.evaluate({ type: "tool_use", name: "test", input: { a: 1 }, ts: 20, runId: "run1" });
    evaluator.evaluate({ type: "message", role: "assistant", text: "hmm", ts: 25, runId: "run1" });
    const decision = evaluator.evaluate({ type: "tool_use", name: "test", input: { a: 1 }, ts: 30, runId: "run1" });
    
    // Counter reset, should not trigger warning
    expect(decision).toBeNull();
  });

  it("should ignore token velocity if contextMetrics is not reported", () => {
    capabilities.contextMetrics = "estimated";
    const evaluator = createEvaluator();
    
    const decision = evaluator.evaluate({ type: "usage", inputTokens: 2000, outputTokens: 0, ts: 10, runId: "run1" });
    expect(decision).toBeNull();
  });

  it("should trigger token velocity if contextMetrics is reported", () => {
    const evaluator = createEvaluator();
    const decision = evaluator.evaluate({ type: "usage", inputTokens: 2000, outputTokens: 0, ts: 10, runId: "run1" });
    expect(decision?.level).toBe("warning");
    expect(decision?.reasonCode).toBe("token-velocity");
  });

  it("should gracefully handle cancellation unsupported", () => {
    capabilities.cancellation = false;
    const evaluator = createEvaluator();
    
    evaluator.evaluate({ type: "error", message: "err", fatal: false, ts: 10, runId: "run1" });
    evaluator.evaluate({ type: "error", message: "err", fatal: false, ts: 20, runId: "run1" });
    evaluator.evaluate({ type: "error", message: "err", fatal: false, ts: 30, runId: "run1" }); // warning
    evaluator.evaluate({ type: "error", message: "err", fatal: false, ts: 40, runId: "run1" }); // constrained
    const decision = evaluator.evaluate({ type: "error", message: "err", fatal: false, ts: 50, runId: "run1" }); // stop-requested
    
    expect(decision?.level).toBe("stop-requested");
    // Action should be downgraded to suppress-future-work because cancel is false
    expect(decision?.action).toBe("suppress-future-work");
  });

  it("should trigger no-progress after timeout without healthy observations", () => {
    const evaluator = createEvaluator();
    
    evaluator.evaluate({ type: "started", ts: 0, runId: "run1" });
    // time jumps 15 seconds without message/tool_use/tool_result
    const decision = evaluator.evaluate({ type: "thinking", text: "hmm", ts: 15000, runId: "run1" });
    expect(decision?.level).toBe("warning");
    expect(decision?.reasonCode).toBe("no-progress");
  });

  it("should not trigger no-progress if a healthy observation occurred recently", () => {
    const evaluator = createEvaluator();
    
    evaluator.evaluate({ type: "started", ts: 0, runId: "run1" });
    evaluator.evaluate({ type: "tool_use", name: "test", ts: 5000, runId: "run1" });
    
    // time is 12000, which is > 10000 from start but < 10000 from tool_use
    const decision = evaluator.evaluate({ type: "thinking", text: "hmm", ts: 12000, runId: "run1" });
    expect(decision).toBeNull();
  });
});
